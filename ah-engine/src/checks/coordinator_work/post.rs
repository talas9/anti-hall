//! The PostToolUse pass of the Node coordinator-work-guard (`--post`): record the call in the session's work window, say one
//! COORDINATOR DRIFT note per crossing of the nudge threshold, then fold stale window files into the metrics.
//!
//! The window is the file `~/.anti-hall/coordinator-work-session-<id>.json` (with its `.lock`), the metrics are
//! `coordinator-work-metrics.json`, the log of nudges is `coordinator-work-trips.log`: the files the Node guard keeps, in the
//! bytes it writes, so the engine and a Node hook that answers for the same session in turn see one record.
//!
//! What decides whether a call counts as work is the command classifier of command-guard (`classifyBashWork`), which the
//! engine does not have. The pass is answered here only when that is already known without it: the Node PreToolUse pass stored
//! its verdict under the call's `tool_use_id` (the Post pass reuses it), or the command is provably not work. Anything else is
//! a deferral to the Node hook, as is a window lock another process holds.
//!
//! Mirrors `hooks/coordinator-work-guard.js` `main` (the `--post` branch) and `hooks/lib/coordinator-work.js`.
use crate::checks::git::util::Settings;
use crate::checks::guardkit::filelock;
use crate::checks::guardkit::fsio::{state_dir, write_atomic};
use crate::checks::guardkit::jsre;
use crate::checks::guardkit::msg::{self, Kind, Parts};
use crate::checks::guardkit::ojson::{OVal, js_number_text};
use crate::checks::guardkit::settings::{get_bool, get_num, is_skipped};
use crate::checks::guardkit::text::js_trim;
use crate::checks::{Verdict, coordinator_work};
use crate::defaults;
use crate::reqenv::RequestEnv;
use regex::Regex;
use serde_json::Value;
use std::collections::HashSet;
use std::sync::OnceLock;

/// The counters a window file and the metrics share.
const COUNTERS: [&str; 4] = ["calls", "work", "blocks", "skippedWouldBlock"];

/// The window configuration (`lib.config`).
pub struct Cfg {
    t_ms: f64,
    nudge_at: i64,
    block_at: i64,
    cap: usize,
}

/// `int(v, dflt, min)`: the floor of a finite number at least `min`, else the default.
fn int(v: f64, dflt: i64, min: i64) -> i64 {
    if v.is_finite() && v >= min as f64 { v.floor() as i64 } else { dflt }
}

/// Mirrors `coordinator-work.js` `config`.
pub fn config(st: &Settings) -> Cfg {
    let g = |k: &str| get_num(st, defaults::raw(k));
    Cfg {
        t_ms: int(g("coordinator_work.window_setting"), 10, 0) as f64 * 60_000.0,
        nudge_at: int(g("coordinator_work.nudge_setting"), 4, 0),
        block_at: int(g("coordinator_work.block_setting"), 7, 0),
        cap: int(g("coordinator_work.cap_setting"), 50, 1) as usize,
    }
}

#[derive(Clone, Debug, PartialEq)]
struct Pre {
    id: String,
    work: bool,
    blockable: bool,
}

/// One session's window.
#[derive(Clone, Debug, PartialEq)]
pub struct State {
    version: String,
    first_ts: f64,
    ts: Vec<f64>,
    armed: bool,
    calls: f64,
    work: f64,
    blocks: f64,
    last_block_at: f64,
    skipped: f64,
    pre: Vec<Pre>,
}

impl State {
    /// `emptyState(version)`.
    fn empty(version: &str) -> State {
        State { version: version.to_string(), first_ts: 0.0, ts: Vec::new(), armed: true, calls: 0.0, work: 0.0, blocks: 0.0, last_block_at: 0.0, skipped: 0.0, pre: Vec::new() }
    }

    fn counter(&self, k: &str) -> f64 {
        match k {
            "calls" => self.calls,
            "work" => self.work,
            "blocks" => self.blocks,
            _ => self.skipped,
        }
    }

    /// `normalize(raw)`: a well-formed state, or `None` when `raw` is not an object.
    fn normalize(raw: &Value) -> Option<State> {
        let o = raw.as_object()?;
        let ver = o.get("version").and_then(Value::as_str).filter(|v| !v.is_empty()).unwrap_or(defaults::text("coordinator_work.unknown_version"));
        let mut s = State::empty(ver);
        let num = |v: Option<&Value>| v.and_then(Value::as_f64);
        if let Some(t) = num(o.get("firstTs")).filter(|t| *t > 0.0) {
            s.first_ts = t;
        }
        if let Some(Value::Array(a)) = o.get("ts") {
            s.ts = a.iter().filter_map(Value::as_f64).collect();
        }
        s.armed = o.get("armed") != Some(&Value::Bool(false));
        if let Some(Value::Array(a)) = o.get("pre") {
            let pre: Vec<Pre> = a
                .iter()
                .filter_map(|e| {
                    let id = e.get("id")?.as_str().filter(|i| !i.is_empty())?;
                    Some(Pre { id: id.to_string(), work: e.get("work")?.as_bool()?, blockable: e.get("blockable")?.as_bool()? })
                })
                .collect();
            let cap = defaults::num("coordinator_work.pre_cap") as usize;
            s.pre = pre[pre.len().saturating_sub(cap)..].to_vec();
        }
        for k in COUNTERS.iter().chain(&["lastBlockAt"]) {
            if let Some(n) = num(o.get(*k)).filter(|n| *n >= 0.0) {
                match *k {
                    "calls" => s.calls = n,
                    "work" => s.work = n,
                    "blocks" => s.blocks = n,
                    "skippedWouldBlock" => s.skipped = n,
                    _ => s.last_block_at = n,
                }
            }
        }
        Some(s)
    }

    /// `JSON.stringify(state)`.
    fn dump(&self) -> String {
        let n = js_number_text;
        let ts = self.ts.iter().map(|t| n(*t)).collect::<Vec<_>>().join(",");
        let pre = self
            .pre
            .iter()
            .map(|p| format!("{{\"id\":{},\"work\":{},\"blockable\":{}}}", serde_json::to_string(&p.id).unwrap_or_default(), p.work, p.blockable))
            .collect::<Vec<_>>()
            .join(",");
        format!(
            "{{\"v\":1,\"version\":{},\"firstTs\":{},\"ts\":[{ts}],\"armed\":{},\"calls\":{},\"work\":{},\"blocks\":{},\"lastBlockAt\":{},\"skippedWouldBlock\":{},\"pre\":[{pre}]}}",
            serde_json::to_string(&self.version).unwrap_or_default(),
            n(self.first_ts),
            self.armed,
            n(self.calls),
            n(self.work),
            n(self.blocks),
            n(self.last_block_at),
            n(self.skipped)
        )
    }

    /// `takePre(state, id)`: remove and return the stored pre-call verdict `(work, blockable)`.
    fn take_pre(&mut self, id: &str) -> Option<(bool, bool)> {
        let k = self.pre.iter().position(|e| e.id == id)?;
        let e = self.pre.remove(k);
        Some((e.work, e.blockable))
    }

    /// `stepPost(state, {now, work}, cfg)`: record one call; the window count when a nudge threshold was just crossed.
    fn step_post(&mut self, now: f64, work: bool, cfg: &Cfg) -> Option<usize> {
        if self.first_ts == 0.0 {
            self.first_ts = now;
        }
        self.ts.retain(|t| now - t < cfg.t_ms);
        if self.ts.len() > cfg.cap {
            self.ts.drain(..self.ts.len() - cfg.cap);
        }
        if (self.ts.len() as i64) < cfg.nudge_at {
            self.armed = true;
        }
        self.calls += 1.0;
        if work {
            self.work += 1.0;
            self.ts.push(now);
            if self.ts.len() > cfg.cap {
                self.ts.drain(..self.ts.len() - cfg.cap);
            }
        }
        if cfg.nudge_at > 0 && self.ts.len() as i64 >= cfg.nudge_at && self.armed {
            self.armed = false;
            return Some(self.ts.len());
        }
        None
    }
}

fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

/// `safeId(sid)`: the session id as a file-name part.
fn safe_id(sid: &str) -> String {
    let max = defaults::num("coordinator_work.session_id_max") as usize;
    sid.encode_utf16().take(max).map(|u| char::from_u32(u32::from(u)).unwrap_or('_')).map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') { c } else { '_' }).collect()
}

fn session_path(home: &str, sid: &str) -> String {
    format!("{}/{}{}{}", state_dir(home), defaults::text("coordinator_work.session_file_prefix"), safe_id(sid), defaults::text("guardkit.state_ext"))
}

fn named(home: &str, key: &str) -> String {
    format!("{}/{}", state_dir(home), defaults::text(key))
}

fn read_json(p: &str) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(p).ok()?).ok()
}

fn lock_wait(env: &RequestEnv) -> u64 {
    if env.get(defaults::text("coordinator_work.lock_isolation_env")).is_some_and(|v| !v.is_empty())
        && let Some(n) = env.get(defaults::text("coordinator_work.lock_wait_env")).map(crate::checks::guardkit::text::js_number_of_str)
        && n.is_finite()
        && n >= 0.0
    {
        return n as u64;
    }
    defaults::num("coordinator_work.lock_wait_ms")
}

/// The version that stamps a new window file: the plugin manifest's `version`.
fn plugin_version(root: &str) -> String {
    let unknown = defaults::text("coordinator_work.unknown_version").to_string();
    read_json(&format!("{root}/{}", defaults::text("coordinator_work.plugin_json"))).and_then(|v| v.get("version").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string)).unwrap_or(unknown)
}

/// The metrics file's contents, in the order Node keeps them.
struct Metrics {
    nudges: f64,
    blocks: f64,
    max_session_blocks: Option<f64>,
    by_version: Vec<(String, [f64; 5])>,
}

const VERSION_KEYS: [&str; 5] = ["sessions", "calls", "work", "blocks", "skippedWouldBlock"];

impl Metrics {
    /// `normalizeMetrics(raw)` (the raw value parsed with its key order).
    fn normalize(raw: Option<&OVal>) -> Metrics {
        let mut m = Metrics { nudges: 0.0, blocks: 0.0, max_session_blocks: None, by_version: Vec::new() };
        let Some(raw @ OVal::Obj(_)) = raw else { return m };
        let nn = |v: Option<&OVal>| match v {
            Some(OVal::Num(n)) if *n >= 0.0 => Some(*n),
            _ => None,
        };
        if let Some(n) = nn(raw.get("nudges")) {
            m.nudges = n;
        }
        if let Some(n) = nn(raw.get("blocks")) {
            m.blocks = n;
        }
        m.max_session_blocks = nn(raw.get("maxSessionBlocks"));
        let entries: Vec<(String, &OVal)> = match raw.get("byVersion") {
            Some(OVal::Obj(o)) => o.iter().map(|(k, v)| (k.clone(), v)).collect(),
            Some(OVal::Arr(a)) => a.iter().enumerate().map(|(i, v)| (i.to_string(), v)).collect(),
            _ => Vec::new(),
        };
        for (v, e) in entries {
            if !matches!(e, OVal::Obj(_) | OVal::Arr(_)) {
                continue;
            }
            let mut o = [0.0; 5];
            for (i, k) in VERSION_KEYS.iter().enumerate() {
                if let Some(n) = nn(e.get(k)) {
                    o[i] = n;
                }
            }
            match m.by_version.iter_mut().find(|(k, _)| *k == v) {
                Some(slot) => slot.1 = o,
                None => m.by_version.push((v, o)),
            }
        }
        m
    }

    fn dump(&self) -> String {
        let by = OVal::Obj(
            self.by_version
                .iter()
                .map(|(v, o)| (v.clone(), OVal::Obj(VERSION_KEYS.iter().zip(o).map(|(k, n)| (k.to_string(), OVal::Num(*n))).collect())))
                .collect(),
        );
        let mut s = format!("{{\"v\":1,\"nudges\":{},\"blocks\":{},\"byVersion\":{}", js_number_text(self.nudges), js_number_text(self.blocks), by.stringify());
        if let Some(n) = self.max_session_blocks {
            s.push_str(&format!(",\"maxSessionBlocks\":{}", js_number_text(n)));
        }
        s.push('}');
        s
    }
}

/// The metrics read-modify-write, with the metrics lock already held by the caller. False when `f` declines or the write fails.
fn bump_locked(home: &str, f: &mut dyn FnMut(&mut Metrics) -> bool) -> bool {
    let p = named(home, "coordinator_work.metrics_file");
    let raw = std::fs::read_to_string(&p).ok().and_then(|t| OVal::parse(&t));
    let mut m = Metrics::normalize(raw.as_ref());
    f(&mut m) && write_atomic(&p, &m.dump()).is_ok()
}

fn metrics_lock_path(home: &str) -> String {
    format!("{}{}", named(home, "coordinator_work.metrics_file"), defaults::text("coordinator_work.lock_suffix"))
}

/// `bumpMetrics(home, fn)`: read-modify-write the metrics file under its lock; false when the lock was not taken or the write failed.
fn bump_metrics(home: &str, env: &RequestEnv, f: &mut dyn FnMut(&mut Metrics) -> bool) -> bool {
    let Some(lock) = filelock::acquire(&metrics_lock_path(home), lock_wait(env)) else { return false };
    let ok = bump_locked(home, f);
    filelock::release(lock);
    ok
}

/// `new Date(ms).toISOString()`.
fn iso(ms: f64) -> String {
    let total = ms.floor() as i64;
    let (days, rem) = (total.div_euclid(86_400_000), total.rem_euclid(86_400_000));
    // civil-from-days (proleptic Gregorian)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z", rem / 3_600_000, rem / 60_000 % 60, rem / 1000 % 60, rem % 1000)
}

/// `logTrip(home, obj)`: one JSON line in the trips log, the log rotated at its size cap. Telemetry only; errors are ignored.
fn log_trip(home: &str, event: &str, count: usize) {
    let p = named(home, "coordinator_work.trips_file");
    let _ = std::fs::create_dir_all(state_dir(home));
    if std::fs::metadata(&p).is_ok_and(|m| m.len() >= defaults::num("coordinator_work.trips_max_bytes")) {
        let _ = std::fs::rename(&p, format!("{p}.1"));
    }
    let line = format!("{{\"ts\":\"{}\",\"event\":{},\"count\":{count}}}\n", iso(now_ms()), serde_json::to_string(event).unwrap_or_default());
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().append(true).create(true).open(&p) {
        let _ = f.write_all(line.as_bytes());
    }
}

fn session_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        let pre = regex::escape(defaults::text("coordinator_work.session_file_prefix"));
        let ext = regex::escape(defaults::text("guardkit.state_ext"));
        jsre::compile(&format!("^{pre}.+{ext}$"), false)
    })
}

/// `foldStale(home, now)`: at most once per throttle window, fold window files older than the pruning TTL into the metrics and
/// remove them. Returns how many were folded. Best effort; every error is swallowed.
fn fold_stale(home: &str, now: f64, env: &RequestEnv) -> usize {
    let stamp = named(home, "coordinator_work.fold_stamp_file");
    let throttle = defaults::num("coordinator_work.fold_throttle_ms") as f64;
    if let Some(ts) = read_json(&stamp).and_then(|v| v.get("ts").and_then(Value::as_f64))
        && now - ts < throttle
    {
        return 0;
    }
    let ttl = defaults::num("guardkit.prune_ttl_ms") as f64;
    let dir = state_dir(home);
    let mut names: Vec<String> = std::fs::read_dir(&dir).map(|rd| rd.flatten().map(|e| e.file_name().to_string_lossy().to_string()).filter(|n| session_re().is_match(n)).collect()).unwrap_or_default();
    // `readdirSync` lists the names sorted (libuv sorts a scandir by `strcmp`), and that is the order Node folds them in
    names.sort();
    let mut folded = 0usize;
    let mtime = |p: &str| std::fs::metadata(p).ok().and_then(|m| m.modified().ok()).map(|t| t.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0));
    for name in names.drain(..) {
        let p = format!("{dir}/{name}");
        let Some(mt) = mtime(&p) else { continue };
        if now - mt <= ttl {
            continue;
        }
        let Some(lock) = filelock::acquire(&format!("{p}{}", defaults::text("coordinator_work.lock_suffix")), lock_wait(env)) else { continue };
        if mtime(&p).is_some_and(|mt| now - mt > ttl) {
            let unknown = defaults::text("coordinator_work.unknown_version");
            bump_metrics(home, env, &mut |m| {
                let s = read_json(&p).and_then(|v| State::normalize(&v)).unwrap_or_else(|| State::empty(unknown));
                let v = if s.version.is_empty() { unknown.to_string() } else { s.version.clone() };
                let mut e = m.by_version.iter().find(|(k, _)| *k == v).map_or([0.0; 5], |(_, e)| *e);
                e[0] += 1.0;
                for (i, k) in COUNTERS.iter().enumerate() {
                    e[i + 1] += s.counter(k);
                }
                match m.by_version.iter_mut().find(|(k, _)| *k == v) {
                    Some(slot) => slot.1 = e,
                    None => m.by_version.push((v, e)),
                }
                m.max_session_blocks = Some(m.max_session_blocks.unwrap_or(0.0).max(s.blocks));
                if std::fs::remove_file(&p).is_err() {
                    return false;
                }
                folded += 1;
                true
            });
        }
        filelock::release(lock);
    }
    let _ = write_atomic(&stamp, &format!("{{\"ts\":{}}}", js_number_text(now)));
    folded
}

// ---- classification that needs no classifier ---------------------------------------------------------------------

struct Safe {
    cmd: Regex,
    arg: Regex,
    verb: Regex,
    split: Regex,
    git_flag: Regex,
    ro_verbs: HashSet<&'static str>,
    ro_git: HashSet<&'static str>,
}

fn safe() -> &'static Safe {
    static S: OnceLock<Safe> = OnceLock::new();
    S.get_or_init(|| {
        let c = |k: &str| jsre::compile(defaults::text(k), false);
        Safe {
            cmd: c("coordinator_work.safe_command"),
            arg: c("coordinator_work.safe_arg"),
            verb: c("coordinator_work.safe_verb"),
            split: c("coordinator_work.segment_split"),
            git_flag: c("coordinator_work.git_output_flag"),
            ro_verbs: defaults::list("coordinator_work.readonly_verbs").into_iter().collect(),
            ro_git: defaults::list("coordinator_work.readonly_git_subs").into_iter().collect(),
        }
    })
}

/// True ONLY for a command built from a closed vocabulary: every segment starts with a read-only verb (or `git <read-only
/// sub>`) and the whole string has no quote, substitution, redirect, glob, brace, backslash or assignment.
///
/// Mirrors `coordinator-work.js` `provablyNotWork`.
pub fn provably_not_work(command: &str) -> bool {
    let s = safe();
    if js_trim(command).is_empty() || command.encode_utf16().count() > defaults::num("coordinator_work.safe_max_len") as usize || !s.cmd.is_match(command) {
        return false;
    }
    for seg in s.split.split(command) {
        if seg.contains('&') {
            return false;
        }
        let t: Vec<&str> = js_trim(seg).split(crate::checks::guardkit::text::is_js_space).filter(|x| !x.is_empty()).collect();
        if t.is_empty() {
            continue;
        }
        if !t.iter().enumerate().all(|(i, x)| if i == 0 { s.verb.is_match(x) } else { s.arg.is_match(x) }) {
            return false;
        }
        if s.ro_verbs.contains(t[0]) {
            continue;
        }
        if t[0] == defaults::text("coordinator_work.git_verb") && t.len() >= 2 && s.ro_git.contains(t[1]) && !t[2..].iter().any(|a| s.git_flag.is_match(a)) {
            continue;
        }
        return false;
    }
    true
}

// ---- who is the main thread ------------------------------------------------------------------------------------------

/// `isCoordinator(payload, env)`: not a subagent and running under an interactive entry point.
///
/// Mirrors `hooks/coordinator-detect.js` `isCoordinator`.
fn is_coordinator(p: &Value, env: &RequestEnv) -> bool {
    let entry = env.get(defaults::text("coordinator_work.entrypoint_env")).unwrap_or("");
    if coordinator_work::payload_is_codex(p) {
        return !coordinator_work::subagent_by_payload(p) && entry.is_empty();
    }
    if coordinator_work::subagent_by_payload(p) || entry == defaults::text("coordinator_work.subagent_entrypoint") {
        return false;
    }
    defaults::list("coordinator_work.coordinator_entrypoints").contains(&entry) || (!entry.is_empty() && entry.starts_with(defaults::text("coordinator_work.coordinator_entrypoint_prefix")))
}

/// Settings (the switch of command-guard that gates the window) and skip files, as the Node guard reads them.
fn enabled(st: &Settings) -> bool {
    !is_skipped(st, defaults::text("coordinator_work.command_guard_name")) && get_bool(st, defaults::raw("coordinator_work.command_guard_setting"))
}

/// The PostToolUse decision. `None`: nothing to say and nothing recorded (the guard is off or this is not the main thread);
/// `Some(Allow)`: handled, nothing to show; `Some(Advisory)`: handled with a nudge; `Some(Defer)`: the Node hook must decide.
///
/// Mirrors `hooks/coordinator-work-guard.js` `main` (the `--post` branch).
pub fn decide_post(p: &Value, st: &Settings, env: &RequestEnv, plugin_root: &str) -> Option<Verdict> {
    if !p.is_object() || p.get("tool_name").and_then(Value::as_str) != Some("Bash") {
        return None;
    }
    let sid = p.get("session_id").and_then(Value::as_str).map(js_trim).filter(|s| !s.is_empty())?;
    if !is_coordinator(p, env) || !enabled(st) {
        return None;
    }
    let cfg = config(st);
    if cfg.t_ms == 0.0 {
        return None;
    }
    if st.home.is_empty() || plugin_root.is_empty() {
        return Some(Verdict::Defer);
    }
    let command = p.get("tool_input").and_then(|t| t.get("command")).and_then(Value::as_str).unwrap_or("");
    let home = st.home.as_str();
    let now = now_ms();
    let id = p.get("tool_use_id").and_then(Value::as_str).filter(|i| !i.is_empty() && !js_trim(command).is_empty()).unwrap_or("");
    let mut seen = read_json(&session_path(home, sid)).and_then(|v| State::normalize(&v));
    let stored = if id.is_empty() { None } else { seen.as_mut().and_then(|s| s.take_pre(id)) };
    let work = match stored {
        Some((work, _)) => work,
        None if provably_not_work(command) => false,
        // the classification needs command-guard's `classifyBashWork`: the Node hook decides
        None => return Some(Verdict::Defer),
    };
    // update(): the window file under its lock; a lock another process holds is the Node hook's to wait for or to take over.
    // Everything is decided in memory first and the metrics lock (taken after the window lock, the order Node keeps) is
    // acquired before anything is written, so a lock that cannot be had hands the whole call to Node with nothing recorded.
    let path = session_path(home, sid);
    let Some(lock) = filelock::acquire(&format!("{path}{}", defaults::text("coordinator_work.lock_suffix")), lock_wait(env)) else { return Some(Verdict::Defer) };
    let mut s = read_json(&path).and_then(|v| State::normalize(&v)).unwrap_or_else(|| State::empty(&plugin_version(plugin_root)));
    if !id.is_empty() {
        s.take_pre(id);
    }
    let crossing = s.step_post(now, work, &cfg);
    let nudge_count = crossing.filter(|_| cfg.nudge_at > 0 && !is_skipped(st, defaults::text("coordinator_work.guard_name")));
    let metrics_lock = if nudge_count.is_some() {
        match filelock::acquire(&metrics_lock_path(home), lock_wait(env)) {
            Some(l) => Some(l),
            None => {
                filelock::release(lock);
                return Some(Verdict::Defer);
            }
        }
    } else {
        None
    };
    let _ = write_atomic(&path, &s.dump());
    filelock::release(lock);

    let mut out = Verdict::Allow;
    if let Some(count) = nudge_count {
        bump_locked(home, &mut |m| {
            m.nudges += 1.0;
            true
        });
        if let Some(l) = metrics_lock {
            filelock::release(l);
        }
        log_trip(home, defaults::text("coordinator_work.trip_nudge"), count);
        out = Verdict::Advisory(msg::advisory_json(defaults::text("coordinator_work.post_event"), &nudge(count, &cfg)));
    }
    fold_stale(home, now, env);
    Some(out)
}

/// `NUDGE(count, cfg)`.
fn nudge(count: usize, cfg: &Cfg) -> String {
    let minutes = (cfg.t_ms / 60_000.0).round() as i64;
    let what = msg::render("coordinator_work.nudge_what", &[("count", &count.to_string()), ("minutes", &minutes.to_string())]);
    let instead = if cfg.block_at > 0 { msg::render("coordinator_work.nudge_instead_block", &[("block_at", &cfg.block_at.to_string())]) } else { defaults::text("coordinator_work.nudge_instead").to_string() };
    msg::message(Kind::Warn, defaults::text("coordinator_work.guard_name"), &Parts { what: &what, instead: &instead, ..Parts::default() })
}
