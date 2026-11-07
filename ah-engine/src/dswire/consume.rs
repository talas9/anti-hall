//! The consumers of the realtime DevSwarm state (design B2): the per-session advisory, the statusline segment and the per-child
//! Jev dirty flags. All read the state through [`Rt`]; none of them writes a DevSwarm source.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this module is a deliberate keep, for these reasons:
// - a seen-generation or dirty-queue file that is missing or malformed is the empty one: at worst an advisory repeats once
use crate::checks::guardkit::msg::render_with;
use crate::defaults;
use crate::devswarm_rt::detect::Mode;
use crate::devswarm_rt::reconcile::Rt;
use crate::devswarm_rt::state::{Activity, Edge, EdgeKind, Lifecycle};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

fn list(k: &str) -> Vec<String> {
    defaults::list(k).into_iter().map(String::from).collect()
}

fn seen_path(state_dir: &Path, session: &str) -> Option<PathBuf> {
    let max = defaults::num("devswarm_wire.advisory_session_max") as usize;
    let ok = !session.is_empty() && session.chars().count() <= max && session.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'));
    ok.then(|| state_dir.join(defaults::text("devswarm_wire.advisory_dir")).join(format!("{session}{}", defaults::text("mesh_write.json_suffix"))))
}

fn read_seen(p: &Path) -> Option<u64> {
    serde_json::from_str::<Value>(&std::fs::read_to_string(p).ok()?).ok()?.get("gen")?.as_u64()
}

/// When each workspace's activity change was last put in front of this session (workspace -> the edge's `at_ms`), from its marker.
fn read_advised(p: &Path) -> BTreeMap<String, i64> {
    let v = std::fs::read_to_string(p).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).unwrap_or(Value::Null); // keep: a missing or bad marker is the empty map
    v.get(defaults::text("devswarm_wire.advisory_act_key"))
        .and_then(Value::as_object)
        .map(|m| m.iter().filter_map(|(k, t)| Some((k.clone(), t.as_i64()?))).collect())
        .unwrap_or_default()
}

/// Hysteresis for the activity edges (`devswarm_rt.activity_min_dwell_s`): per workspace the batch is folded to its net change (a flip
/// and its flip back leave nothing), and a net change within `dwell_ms` of the one this session was last told about is silent. Returns
/// the edges to advise, the activity edges dropped, and the updated told-at map (only workspaces whose change is advised move).
fn settle_activity(edges: Vec<Edge>, told: &BTreeMap<String, i64>, dwell_ms: i64) -> (Vec<Edge>, u64, BTreeMap<String, i64>) {
    let mut told = told.clone();
    let (mut out, mut dropped) = (Vec::with_capacity(edges.len()), 0u64);
    let is_act = |e: &Edge| e.kind == EdgeKind::Activity;
    let mut net: BTreeMap<String, (String, String, i64, usize)> = BTreeMap::new(); // ws -> (first from, last to, last at_ms, count)
    for e in edges.iter().filter(|e| is_act(e)) {
        let slot = net.entry(e.ws.clone()).or_insert_with(|| (e.from.clone(), e.to.clone(), e.at_ms, 0));
        slot.1 = e.to.clone();
        slot.2 = e.at_ms;
        slot.3 += 1;
    }
    let mut kept_ws: Vec<&String> = Vec::new();
    for (ws, (from, to, at, count)) in &net {
        let flipped_back = from == to;
        let within_dwell = told.get(ws).is_some_and(|t| at.saturating_sub(*t) < dwell_ms);
        if flipped_back || within_dwell {
            dropped += *count as u64;
        } else {
            dropped += (*count as u64).saturating_sub(1);
            kept_ws.push(ws);
            told.insert(ws.clone(), *at);
        }
    }
    let mut emitted: std::collections::BTreeSet<&String> = std::collections::BTreeSet::new();
    for e in &edges {
        if !is_act(e) {
            out.push(e.clone());
        } else if kept_ws.contains(&&e.ws) && !emitted.contains(&e.ws) {
            // the net change, at the place of the workspace's first activity edge
            let (from, to, at, _) = &net[&e.ws];
            out.push(Edge { from: from.clone(), to: to.clone(), at_ms: *at, ..e.clone() });
            emitted.insert(&e.ws);
        }
    }
    (out, dropped, told)
}

fn prune_old(dir: &Path, now: i64) {
    let age = defaults::num("devswarm_wire.advisory_prune_ms");
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let old = e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|d| d.as_millis() as u64 > age);
        if old && now > 0 {
            crate::discard::harmless(std::fs::remove_file(e.path())); // keep: a stale marker; the next advisory prunes again
        }
    }
}

fn label(rt: &Rt, ws: &str) -> String {
    rt.workspace(ws)
        .and_then(|w| w.label)
        .filter(|l| !l.is_empty())
        .unwrap_or_else(|| ws.chars().take(defaults::num("devswarm_wire.label_chars") as usize).collect())
}

/// The advisory text for `session`: the changes since the generation it was last told about, within the size caps. The engine reads
/// the state and the session's marker; whether to speak, the text and the generation to remember are decided by the plugin script
/// `devswarm-rt-advisory.js`. `None` when there is nothing new, the layer is off, the script fails, or the marker cannot be written
/// (an unrecorded advisory would repeat). Two sessions each see a change once; one session never twice.
pub fn advisory(rt: &Rt, state_dir: &Path, session: &str, now: i64) -> Option<String> {
    let path = seen_path(state_dir, session);
    let gen_now = rt.current().generation;
    let seen = path.as_deref().and_then(read_seen);
    let dwell_ms = defaults::num("devswarm_rt.activity_min_dwell_s") as i64 * 1000;
    let (edges, dropped, told) =
        settle_activity(seen.map(|s| rt.edges_since(s)).unwrap_or_default(), &path.as_deref().map(read_advised).unwrap_or_default(), dwell_ms);
    if dropped > 0 {
        crate::metrics::bump_by("devswarm_rt_activity_line", &[("result", defaults::text("devswarm_rt.activity_result_suppressed"))], dropped);
    }
    let kept = edges.iter().filter(|e| e.kind == EdgeKind::Activity).count() as u64;
    if kept > 0 {
        crate::metrics::bump_by("devswarm_rt_activity_line", &[("result", defaults::text("devswarm_rt.activity_result_emitted"))], kept);
    }
    let edges: Vec<Value> = edges.iter().map(|e| json!({"ws": e.ws, "label": label(rt, &e.ws), "kind": e.kind.as_str(), "from": e.from, "to": e.to})).collect();
    let payload = json!({
        "enabled": rt.mode() == Mode::On && defaults::raw("devswarm_wire.advisory_enabled").as_bool().unwrap_or(false),
        "sessionOk": path.is_some(), "seen": seen, "generation": gen_now, "edges": edges,
    });
    let env = crate::reqenv::RequestEnv::from_pairs([(defaults::env_name("home"), rt.detection().home.to_string_lossy().into_owned())]);
    let ans = match crate::script::run_forced(
        defaults::text("devswarm_wire.check_script"),
        &payload,
        &Value::Null,
        defaults::text("devswarm_wire.check_event"),
        &env,
    ) {
        Some(Some(crate::checks::Verdict::Exact(x))) => serde_json::from_str::<Value>(&x.out).ok()?,
        _ => return None,
    };
    if let Some(mark) = ans.get("mark").and_then(Value::as_u64) {
        write_seen(path.as_deref()?, mark, &told, now)?;
    }
    let nag = crate::dsact::nag::take_pending(state_dir);
    let advise = ans.get("advise").and_then(Value::as_str).map(str::to_string);
    match (advise, nag) {
        (Some(a), Some(n)) => Some(format!("{a}\n{n}")),
        (a, n) => a.or(n),
    }
}

fn write_seen(path: &Path, gen_now: u64, told: &BTreeMap<String, i64>, now: i64) -> Option<()> {
    let dir = path.parent()?;
    std::fs::create_dir_all(dir).ok()?;
    prune_old(dir, now);
    crate::atomic::write(path, json!({"gen": gen_now, defaults::text("devswarm_wire.advisory_act_key"): told}).to_string()).ok()
}

/// The statusline segment: workspaces in progress, stuck, unread mail.
pub fn line(rt: &Rt) -> String {
    let snap = rt.current();
    if !snap.app_readable {
        return defaults::text("devswarm_wire.msg_line_stale").to_string();
    }
    let live = snap.workspaces.values().filter(|w| w.lifecycle.value == Lifecycle::Active);
    let (mut active, mut stuck, mut unread) = (0, 0, 0usize);
    for w in live {
        active += 1;
        stuck += usize::from(w.activity.value == Activity::Stuck);
        unread += w.unread.value.unwrap_or(0);
    }
    render_with(
        defaults::text("devswarm_wire.msg_line"),
        &[("active", &active.to_string()), ("stuck", &stuck.to_string()), ("unread", &unread.to_string()), ("gen", &snap.generation.to_string())],
    )
}

// ---- Jev dirty flags --------------------------------------------------------------------------------------------------------

/// The per-child Jev dirty queue: held in memory, saved to `devswarm_wire.jev_dirty_file` only when it changed and a flush is due
/// (every `devswarm_wire.jev_dirty_flush_ms`, and when the thread stops), instead of a read and a rewrite per batch.
pub struct JevQueue {
    path: PathBuf,
    ids: std::sync::Mutex<Vec<String>>,
    unsaved: std::sync::atomic::AtomicBool,
}

impl JevQueue {
    /// The queue saved in `state_dir` by an earlier run (empty when there is none or it is malformed).
    pub fn load(state_dir: &Path) -> JevQueue {
        let path = state_dir.join(defaults::text("devswarm_wire.jev_dirty_file"));
        let ids = std::fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str::<Vec<String>>(&t).ok()).unwrap_or_default();
        JevQueue { path, ids: std::sync::Mutex::new(ids), unsaved: std::sync::atomic::AtomicBool::new(false) }
    }

    fn ids(&self) -> std::sync::MutexGuard<'_, Vec<String>> {
        self.ids.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Queue a per-child Jev sweep for each of `ids` (a workspace already queued stays once). Returns how many were newly queued.
    pub fn queue(&self, ids: &[String]) -> usize {
        let mut q = self.ids();
        let before = q.len();
        let mut pushed = false;
        for id in ids {
            if !q.contains(id) {
                q.push(id.clone());
                pushed = true;
            }
        }
        let cap = defaults::num("devswarm_wire.jev_dirty_cap") as usize;
        if q.len() > cap {
            let over = q.len() - cap;
            q.drain(..over);
        }
        let added = q.len().saturating_sub(before);
        if pushed {
            self.unsaved.store(true, std::sync::atomic::Ordering::Relaxed);
        }
        added
    }

    /// Take the queue's ids (the queue is empty afterwards).
    pub fn take_ids(&self) -> Vec<String> {
        let mut q = self.ids();
        if q.is_empty() {
            return Vec::new();
        }
        self.unsaved.store(true, std::sync::atomic::Ordering::Relaxed);
        std::mem::take(&mut *q)
    }

    /// Whether a change is waiting to be saved.
    pub fn unsaved(&self) -> bool {
        self.unsaved.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Save the queue when it changed since the last save.
    pub fn flush(&self) {
        if !self.unsaved.swap(false, std::sync::atomic::Ordering::Relaxed) {
            return;
        }
        let body = json!(*self.ids()).to_string();
        if let Err(e) = crate::atomic::write(&self.path, body) {
            self.unsaved.store(true, std::sync::atomic::Ordering::Relaxed); // try again at the next flush
            crate::discard::logged("dswire_jev_dirty", Err::<(), _>(e));
        }
    }
}

/// Queue a per-child Jev sweep for each workspace an edge of a dirty kind touched. Returns how many were newly queued.
pub fn mark_dirty(rt: &Rt, q: &JevQueue, edges: &[Edge]) -> usize {
    let kinds = list("devswarm_wire.jev_dirty_kinds");
    let ids: Vec<String> = edges
        .iter()
        .filter(|e| kinds.iter().any(|k| k == e.kind.as_str()) && rt.workspace(&e.ws).is_some_and(|w| w.lifecycle.value == Lifecycle::Active))
        .map(|e| e.ws.clone())
        .collect();
    q.queue(&ids)
}

/// Take the queue: the ids and, for matching the plan files, their worktrees.
pub fn take_dirty(rt: &Rt, q: &JevQueue) -> Vec<String> {
    q.take_ids().into_iter().flat_map(|id| [Some(id.clone()), rt.workspace(&id).and_then(|w| w.worktree)]).flatten().collect()
}

// ---- the hook check ---------------------------------------------------------------------------------------------------------

/// Built-in `check = "devswarm-rt-advisory"` (UserPromptSubmit): tells the main session about the DevSwarm workspace changes it
/// has not seen. Engine-only (the Node fallback entry is a no-op). It needs the live state, which exists only inside the daemon,
/// so a dispatch answered in the hook client allows silently. It reads, never decides an action: whether there is anything to
/// say is a comparison of the session's last seen generation with the state's.
pub struct RtAdvisory;

impl crate::checks::Check for RtAdvisory {
    fn name(&self) -> &'static str {
        "devswarm-rt-advisory"
    }

    fn summary(&self) -> &'static str {
        defaults::text("devswarm_wire.check_summary")
    }

    fn run(&self, _s: &crate::rules::Subject<'_>, _opts: &Value) -> Option<crate::checks::Verdict> {
        Some(crate::checks::Verdict::Allow)
    }

    fn scripted(&self) -> bool {
        true
    }

    fn script_is_helper(&self) -> bool {
        true
    }

    fn run_payload(&self, s: &crate::rules::Subject<'_>, payload: &Value, _opts: &Value) -> Option<crate::checks::Verdict> {
        use crate::checks::Verdict;
        let main_thread = payload.get("agent_id").and_then(Value::as_str).is_none_or(str::is_empty);
        let session = payload.get("session_id").and_then(Value::as_str).unwrap_or_default();
        let wire = super::global().filter(|_| s.event == defaults::text("devswarm_wire.check_event") && main_thread);
        let text = wire.and_then(|w| advisory(&w.rt, &w.state_dir, session, crate::health::now_ms() as i64));
        Some(match text {
            Some(t) => {
                wire.inspect(|w| w.count_advisory());
                Verdict::Advisory(crate::checks::guardkit::msg::advisory_json(s.event, &t))
            }
            None => Verdict::Allow,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn act(ws: &str, from: &str, to: &str, gen_: u64, at: i64) -> Edge {
        Edge { ws: ws.into(), kind: EdgeKind::Activity, from: from.into(), to: to.into(), generation: gen_, at_ms: at, while_down: false, hold_until_ms: 0 }
    }

    const DWELL: i64 = 300_000;

    #[test]
    fn a_flip_and_its_flip_back_in_one_batch_are_silent_and_counted() {
        let edges = vec![act("w1", "working", "stuck", 1, 1000), act("w1", "stuck", "working", 2, 2000)];
        let (out, dropped, told) = settle_activity(edges, &BTreeMap::new(), DWELL);
        assert!(out.is_empty());
        assert_eq!(dropped, 2);
        assert!(told.is_empty());
    }

    #[test]
    fn a_net_change_is_told_once_and_remembered() {
        let edges = vec![act("w1", "working", "stuck", 1, 1000), act("w1", "stuck", "working", 2, 2000), act("w1", "working", "stuck", 3, 3000)];
        let (out, dropped, told) = settle_activity(edges, &BTreeMap::new(), DWELL);
        assert_eq!(out.len(), 1);
        assert_eq!((out[0].from.as_str(), out[0].to.as_str(), out[0].at_ms), ("working", "stuck", 3000));
        assert_eq!(dropped, 2);
        assert_eq!(told.get("w1"), Some(&3000));
    }

    #[test]
    fn a_change_within_the_dwell_of_the_last_one_told_is_silent_and_one_after_it_is_told() {
        let told = BTreeMap::from([("w1".to_string(), 1000i64)]);
        let (out, dropped, kept) = settle_activity(vec![act("w1", "stuck", "working", 5, 1000 + DWELL - 1)], &told, DWELL);
        assert!(out.is_empty());
        assert_eq!(dropped, 1);
        assert_eq!(kept.get("w1"), Some(&1000), "a silent change does not move the told time");
        let (out, dropped, kept) = settle_activity(vec![act("w1", "stuck", "working", 6, 1000 + DWELL)], &told, DWELL);
        assert_eq!((out.len(), dropped), (1, 0));
        assert_eq!(kept.get("w1"), Some(&(1000 + DWELL)));
    }

    #[test]
    fn other_kinds_and_other_workspaces_are_untouched_and_a_zero_dwell_tells_every_net_change() {
        let mut life = act("w2", "active", "archived", 2, 10);
        life.kind = EdgeKind::Lifecycle;
        let told = BTreeMap::from([("w1".to_string(), 1000i64)]);
        let (out, dropped, _) = settle_activity(vec![act("w1", "working", "stuck", 1, 1001), life.clone(), act("w3", "working", "stuck", 3, 20)], &told, 0);
        assert_eq!(dropped, 0);
        assert_eq!(out.iter().map(|e| e.ws.as_str()).collect::<Vec<_>>(), ["w1", "w2", "w3"]);
    }
}
