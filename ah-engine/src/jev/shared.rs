//! The process-wide Jev lanes the checks ask through, and the helpers every Jev caller shares.
//!
//! A check runs once per hook call, but the asynchronous queue, the answer cache, the settings snapshot and the
//! connection pool belong to one long-lived [`Jev`]. [`lane`] hands every check the same lane for a home directory, so a
//! detached ask started by one Stop hook is still running (and lands in the log) after that call returned.
//! The registry is bounded (`mem.jev_lanes_max_entries` homes; a single user has one).
//!
//! [`turn_ref_from_transcript`] is Node's `turnRefFromTranscript`.
use super::{Env, Jev};
use crate::defaults;
use crate::mem::{Admit, Budget, Owner, Spec};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};

static RESIDENT: AtomicBool = AtomicBool::new(false);

/// Mark this process as the resident engine (the daemon): detached asks then run on a thread of the shared lane. In any
/// other process (a one-shot hook) a detached ask is a detached child process, because the process ends with the check.
pub fn set_resident() {
    RESIDENT.store(true, Ordering::SeqCst);
}

/// True in the resident engine (the daemon).
pub fn is_resident() -> bool {
    RESIDENT.load(Ordering::SeqCst)
}

struct LaneSlot {
    home: PathBuf,
    jev: Weak<Jev>,
    resident: Option<Arc<Jev>>,
}

static LANES: Mutex<Vec<LaneSlot>> = Mutex::new(Vec::new());
static STARTING_WORKERS: AtomicUsize = AtomicUsize::new(0);
static QUEUE_ADMIT: Mutex<()> = Mutex::new(());
static QUEUE_RESERVED: AtomicUsize = AtomicUsize::new(0);

struct LaneOwner;

impl Owner for LaneOwner {
    fn bytes(&self) -> usize {
        let mut g = LANES.lock().unwrap_or_else(|e| e.into_inner());
        prune_dropped(&mut g);
        lane_bytes(&g)
    }

    fn shrink(&self, target: usize) {
        let mut g = LANES.lock().unwrap_or_else(|e| e.into_inner());
        prune_dropped(&mut g);
        while lane_bytes(&g) > target && evict_oldest_resident(&mut g) {}
    }

    fn recycle(&self) {
        let mut g = LANES.lock().unwrap_or_else(|e| e.into_inner());
        prune_dropped(&mut g);
        for slot in &mut *g {
            slot.resident = None;
        }
        prune_dropped(&mut g);
    }
}

struct QueueOwner;

impl Owner for QueueOwner {
    fn bytes(&self) -> usize {
        let mut g = LANES.lock().unwrap_or_else(|e| e.into_inner());
        prune_dropped(&mut g);
        QUEUE_RESERVED.load(Ordering::SeqCst)
    }

    fn shrink(&self, _: usize) {}

    fn recycle(&self) {}
}

fn prune_dropped(g: &mut Vec<LaneSlot>) {
    g.retain(|slot| slot.jev.strong_count() > 0);
}

fn lane_bytes(g: &[LaneSlot]) -> usize {
    g.iter().filter_map(|slot| slot.jev.upgrade().map(|jev| slot.home.to_string_lossy().len() + jev.retained_bytes())).sum()
}

fn live_count(g: &[LaneSlot]) -> usize {
    g.iter().filter(|slot| slot.jev.strong_count() > 0).count()
}

fn resident_count(g: &[LaneSlot]) -> usize {
    g.iter().filter(|slot| slot.resident.is_some() && slot.jev.strong_count() > 0).count()
}

fn live_worker_count(g: &[LaneSlot]) -> usize {
    g.iter().filter_map(|slot| slot.jev.upgrade()).filter(|jev| jev.worker_running_for_cap()).count()
}

fn evict_oldest_resident(g: &mut [LaneSlot]) -> bool {
    if let Some(slot) = g.iter_mut().find(|slot| slot.resident.is_some() && slot.jev.strong_count() > 0) {
        slot.resident = None;
        true
    } else {
        false
    }
}

fn make_live_room(g: &mut Vec<LaneSlot>) -> bool {
    let cap = lane_budget().max_entries();
    if cap == 0 || live_count(g) < cap {
        return true;
    }
    while live_count(g) >= cap {
        if !evict_oldest_resident(g) {
            return false;
        }
        prune_dropped(g);
        if g.iter().all(|slot| slot.resident.is_none()) && live_count(g) >= cap {
            return false;
        }
    }
    true
}

fn lane_budget() -> &'static Budget {
    static BUDGET: OnceLock<Budget> = OnceLock::new();
    static OWNER: OnceLock<Arc<LaneOwner>> = OnceLock::new();
    BUDGET.get_or_init(|| {
        let owner = OWNER.get_or_init(|| Arc::new(LaneOwner)).clone();
        let dyn_owner: Arc<dyn Owner> = owner;
        let weak: Weak<dyn Owner> = Arc::downgrade(&dyn_owner);
        crate::mem::global().register(
            Spec::new("jev_lanes", "mem.jev_lanes_soft_bytes", "mem.jev_lanes_hard_bytes", "mem.jev_lanes_low_water_pct")
                .with_entries("mem.jev_lanes_max_entries"),
            weak,
        )
    })
}

fn queue_budget() -> &'static Budget {
    static BUDGET: OnceLock<Budget> = OnceLock::new();
    static OWNER: OnceLock<Arc<QueueOwner>> = OnceLock::new();
    BUDGET.get_or_init(|| {
        let owner = OWNER.get_or_init(|| Arc::new(QueueOwner)).clone();
        let dyn_owner: Arc<dyn Owner> = owner;
        let weak: Weak<dyn Owner> = Arc::downgrade(&dyn_owner);
        crate::mem::global().register(Spec::new("jev_queue", "mem.jev_queue_soft_bytes", "mem.jev_queue_hard_bytes", "mem.jev_queue_low_water_pct"), weak)
    })
}

/// How many lanes are held (a memory report reads it).
pub fn lane_count() -> usize {
    lane_budget().observe();
    queue_budget().observe();
    let mut g = LANES.lock().unwrap_or_else(|e| e.into_inner());
    prune_dropped(&mut g);
    live_count(&g)
}

pub(crate) fn admit_queue(bytes: usize) -> Admit {
    let max = defaults::num("mem.jev_queue_max_bytes") as usize;
    if max > 0 && bytes > max {
        return Admit::Refused;
    }
    let _guard = QUEUE_ADMIT.lock().unwrap_or_else(|e| e.into_inner());
    if queue_budget().admit(bytes) == Admit::Refused {
        return Admit::Refused;
    }
    QUEUE_RESERVED.fetch_add(bytes, Ordering::SeqCst);
    Admit::Ok
}

pub(crate) fn release_queue(bytes: usize) {
    let mut n = QUEUE_RESERVED.load(Ordering::SeqCst);
    while n > 0 {
        let next = n.saturating_sub(bytes);
        match QUEUE_RESERVED.compare_exchange(n, next, Ordering::SeqCst, Ordering::SeqCst) {
            Ok(_) => break,
            Err(cur) => n = cur,
        }
    }
}

pub(crate) fn admit_worker_start() -> bool {
    let cap = lane_budget().max_entries();
    if cap == 0 {
        return true;
    }
    let mut g = LANES.lock().unwrap_or_else(|e| e.into_inner());
    prune_dropped(&mut g);
    let starting = STARTING_WORKERS.load(Ordering::SeqCst);
    if live_worker_count(&g).saturating_add(starting) >= cap {
        return false;
    }
    STARTING_WORKERS.fetch_add(1, Ordering::SeqCst);
    true
}

pub(crate) fn worker_start_finished() {
    let mut n = STARTING_WORKERS.load(Ordering::SeqCst);
    while n > 0 {
        match STARTING_WORKERS.compare_exchange(n, n - 1, Ordering::SeqCst, Ordering::SeqCst) {
            Ok(_) => break,
            Err(next) => n = next,
        }
    }
}

/// The shared lane for `home`, created on first use with the real transport and the Node files (log, breaker). `env` is
/// only the snapshot the lane's own default settings resolve against; every ask carries its calling session's
/// environment in `AskRequest::env`.
pub fn lane(home: &Path, env: &Env) -> Option<Arc<Jev>> {
    lane_budget().observe();
    queue_budget().observe();
    let mut g = LANES.lock().unwrap_or_else(|e| e.into_inner());
    prune_dropped(&mut g);
    if let Some(j) = g.iter().find(|slot| slot.resident.is_some() && slot.home == home).and_then(|slot| slot.jev.upgrade()) {
        return Some(j);
    }
    if !make_live_room(&mut g) {
        return None;
    }
    let jev = Jev::new(home, env.clone());
    g.push(LaneSlot { home: home.to_path_buf(), jev: Arc::downgrade(&jev), resident: Some(jev.clone()) });
    drop(g);
    lane_budget().observe();
    Some(jev)
}

/// The project label of a decision row for a session whose working directory is `cwd`: the directory's name when the engine
/// is resident (its own working directory is not the session's), else `None`, so the lane takes the process's own as Node's
/// `defaultProject` does.
pub fn project_for(cwd: Option<&str>) -> Option<String> {
    if is_resident() { dir_label(cwd) } else { None }
}

/// The name of the last component of `cwd`, when there is one.
fn dir_label(cwd: Option<&str>) -> Option<String> {
    Path::new(cwd.filter(|c| !c.is_empty())?).file_name().map(|n| n.to_string_lossy().into_owned()).filter(|n| !n.is_empty())
}

/// Start a detached ask on the shared lane for `home`, as Node's `askDetached` does: it returns at once, the answer lands in
/// the log (and the lane's cache) and never reaches the caller. `req.env` is set to the calling session's environment.
pub fn ask_detached(home: &Path, env: &Env, mut req: super::AskRequest) {
    req.env = Some(env.clone());
    let Some(jev) = lane(home, env) else { return };
    if RESIDENT.load(Ordering::SeqCst) || cfg!(test) {
        jev.ask_async(req);
    } else {
        jev.ask_detached_process(req);
    }
}

/// The mode of integration `id` for the session whose environment is `env` (Node: `getMode(id, readJevJson(home), home,
/// {env})`).
pub fn mode_of(home: &Path, env: &Env, id: &str) -> super::Mode {
    super::JevSettings::resolve(home, super::settings::Sources::load(home, env.clone())).mode(id, false)
}

/// Node's `consultRelax`, for a relax-block consult inside a hook that is about to nudge or block: when the integration is
/// `on` the question is asked here, within `jev.relax_sync_cap_ms`, and its decision returned (a timeout or failure comes
/// back as the baseline); in `shadow` and `off` it goes out as a detached ask (the decision row lands, nobody waits) and
/// the result is `None`.
pub fn consult_relax(home: &Path, env: &Env, mut req: super::AskRequest) -> Option<super::Decision> {
    if mode_of(home, env, &req.id) != super::Mode::On {
        ask_detached(home, env, req);
        return None;
    }
    let cap = defaults::num("jev.relax_sync_cap_ms");
    req.budget_ms = Some(req.budget_ms.map_or(cap, |b| b.min(cap)));
    req.env = Some(env.clone());
    Some(lane(home, env)?.ask(&req))
}

/// Put a prepared lane in place of the shared one for `home` (tests only: a lane over a scripted transport).
#[cfg(test)]
pub(crate) fn install(home: &Path, jev: Arc<Jev>) {
    let mut g = LANES.lock().unwrap_or_else(|e| e.into_inner());
    prune_dropped(&mut g);
    g.retain(|slot| slot.home != home);
    if make_live_room(&mut g) {
        g.push(LaneSlot { home: home.to_path_buf(), jev: Arc::downgrade(&jev), resident: Some(jev) });
    }
}

/// A short pointer to the turn a decision was about: the `timestamp` of the last transcript line that has one, read from
/// the last 64 KiB; `L<n>` (the window's line count) when none does; `None` for a missing path, an unreadable file or an
/// empty window. Node: `turnRefFromTranscript`.
pub fn turn_ref_from_transcript(path: &str) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    if path.is_empty() {
        return None;
    }
    let window = defaults::num("jev.turn_ref_window_bytes");
    let mut f = std::fs::File::open(path).ok()?;
    let size = f.metadata().ok()?.len();
    let mut buf = Vec::new();
    if size <= window {
        f.read_to_end(&mut buf).ok()?;
    } else {
        f.seek(SeekFrom::Start(size - window)).ok()?;
        f.take(window).read_to_end(&mut buf).ok()?;
    }
    let data = String::from_utf8_lossy(&buf);
    let lines: Vec<&str> = data.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).filter(|l| !super::js_trim(l).is_empty()).collect();
    if lines.is_empty() {
        return None;
    }
    for l in lines.iter().rev() {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(l)
            && let Some(ts) = v.get("timestamp").and_then(serde_json::Value::as_str).filter(|t| !t.is_empty())
        {
            return Some(ts.to_string());
        }
    }
    Some(format!("L{}", lines.len()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jev::breaker::ManualClock;
    use crate::jev::testkit::{Fake, ok};
    use crate::jev::{AskRequest, Question, Trust};
    use serde_json::{Value, json};
    use std::sync::Barrier;
    use std::sync::atomic::AtomicUsize as TestAtomicUsize;

    static TEST_ID: TestAtomicUsize = TestAtomicUsize::new(1);
    static TEST_LOCK: Mutex<()> = Mutex::new(());

    const ON: [(&str, &str); 2] = [("ANTIHALL_JEV", "1"), ("CLAUDE_PLUGIN_OPTION_JEV_VERCEL_API_KEY", "vk")];

    fn unique_home(tag: &str) -> PathBuf {
        let id = TEST_ID.fetch_add(1, Ordering::SeqCst);
        let d = std::env::temp_dir().join(format!("ah-jev-shared-{tag}-{}-{id}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn reset_lanes() {
        LANES.lock().unwrap_or_else(|e| e.into_inner()).clear();
        STARTING_WORKERS.store(0, Ordering::SeqCst);
        QUEUE_RESERVED.store(0, Ordering::SeqCst);
    }

    fn holder_bytes(name: &str) -> usize {
        crate::mem::global()
            .snapshot()
            .get("holders")
            .and_then(Value::as_array)
            .and_then(|holders| holders.iter().find(|h| h.get("name").and_then(Value::as_str) == Some(name)))
            .and_then(|h| h.get("bytes"))
            .and_then(Value::as_u64)
            .unwrap_or(0) as usize
    }

    fn answer(p: f64) -> String {
        format!(r#"{{"answers":{{"decision":{{"noul":{p}}}}}}}"#)
    }

    fn ask() -> AskRequest {
        AskRequest::new("speculation", Question::noul("Is it?", "yes", "no"), "some text", Trust::AddBlock, json!(false))
    }

    fn fake_lane(home: &Path) -> Arc<Jev> {
        let fake = Arc::new(Fake::new(vec![ok(200, &answer(0.99))]));
        Jev::with_parts(home, Env::from_pairs(ON), fake, Arc::new(ManualClock::default()), None, None)
    }

    fn tmp(tag: &str, body: &str) -> String {
        let d = std::env::temp_dir().join(format!("ah-turnref-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let p = d.join("t.jsonl");
        std::fs::write(&p, body).unwrap();
        p.to_string_lossy().into_owned()
    }

    #[test]
    fn queue_byte_admission_is_reserved_atomically_across_threads() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        reset_lanes();
        let hard = defaults::num("mem.jev_queue_hard_bytes") as usize;
        assert!(hard > 2, "queue hard limit must come from mem.jev_queue_hard_bytes");
        let bytes = hard / 2 + 1;
        let barrier = Arc::new(Barrier::new(2));
        let mut joins = Vec::new();
        for _ in 0..2 {
            let barrier = barrier.clone();
            joins.push(std::thread::spawn(move || {
                barrier.wait();
                admit_queue(bytes)
            }));
        }
        let admitted = joins.into_iter().map(|j| j.join().unwrap()).filter(|a| *a == Admit::Ok).count();
        assert_eq!(admitted, 1, "only one concurrent reservation can fit under the hard byte cap");
        release_queue(bytes);
        reset_lanes();
    }

    #[test]
    fn evicted_lanes_with_external_arcs_stay_registered_until_drop() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        reset_lanes();
        let env = Env::from_pairs(std::iter::empty::<(&str, &str)>());
        let cap = lane_budget().max_entries();
        assert!(cap > 0, "jev lane count cap must come from mem.jev_lanes_max_entries");

        let held = lane(&unique_home("held"), &env).unwrap();
        let held_bytes = held.retained_bytes();
        let mut residents = Vec::new();
        for i in 0..cap {
            residents.push(lane(&unique_home(&format!("evict-{i}")), &env).unwrap());
        }

        assert_eq!(lane_count(), cap, "all live lanes stay capped");
        assert!(holder_bytes("jev_lanes") >= held_bytes, "evicted but externally held lane remains counted");
        assert!(lane(&unique_home("overflow"), &env).is_none(), "a full live registry refuses a new lane instead of returning it unregistered");
        drop(held);
        assert_eq!(lane_count(), cap - 1, "dropping the external Arc lets the weak evicted slot prune away");
        drop(residents);
        reset_lanes();
    }

    #[test]
    fn live_workers_are_capped_even_when_evicted_lanes_are_still_held() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        reset_lanes();
        let cap = lane_budget().max_entries();
        assert!(cap > 0, "jev lane count cap must come from mem.jev_lanes_max_entries");

        let mut held = Vec::new();
        for i in 0..=cap {
            let home = unique_home(&format!("worker-{i}"));
            let jev = fake_lane(&home);
            install(&home, jev.clone());
            jev.ask_async(ask());
            held.push(jev);
        }

        let running = held.iter().filter(|jev| jev.worker_running_for_cap()).count();
        assert!(running <= cap, "running workers {running} exceeded cap {cap}");
        assert!(!held.last().unwrap().worker_running_for_cap(), "new evicting lane is refused once live workers are capped");
        reset_lanes();
    }

    #[test]
    fn the_last_timestamp_wins_and_a_window_without_one_gives_a_line_count() {
        let p = tmp("ts", "{\"timestamp\":\"2026-01-01T00:00:00.000Z\"}\n{\"x\":1}\n\n{\"timestamp\":\"\"}\n");
        assert_eq!(turn_ref_from_transcript(&p).as_deref(), Some("2026-01-01T00:00:00.000Z"));
        let p = tmp("nots", "{\"a\":1}\nnot json\r\n{\"b\":2}\n");
        assert_eq!(turn_ref_from_transcript(&p).as_deref(), Some("L3"));
        assert_eq!(turn_ref_from_transcript(&tmp("empty", " \n\n")), None);
        assert_eq!(turn_ref_from_transcript("/nonexistent/ah/t.jsonl"), None);
        assert_eq!(turn_ref_from_transcript(""), None);
    }

    #[test]
    fn a_project_label_is_the_last_directory_name_and_a_one_shot_process_has_none() {
        assert_eq!(dir_label(Some("/work/proj/")).as_deref(), Some("proj"));
        assert_eq!(dir_label(Some("/")), None);
        assert_eq!(dir_label(Some("")), None);
        assert_eq!(dir_label(None), None);
        assert_eq!(project_for(Some("/work/proj")), None, "a test process is not the resident engine");
    }

    #[test]
    fn only_the_last_window_is_read_and_a_cut_first_line_is_skipped() {
        let big = format!("{{\"timestamp\":\"old\",\"pad\":\"{}\"}}\n{{\"timestamp\":\"new\"}}\n", "x".repeat(70_000));
        assert_eq!(turn_ref_from_transcript(&tmp("big", &big)).as_deref(), Some("new"));
    }
}
