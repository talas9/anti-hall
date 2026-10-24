//! What the dispatcher teaches an agent that keeps hitting the same wall (owner 2026-10-24). Two steps, both run by
//! [`crate::dispatch::native::evaluate`] and both configured in `session_switches.toml`:
//!
//! * [`annotate`]: a guard that blocks the same session again inside the repeat window appends, once, the guard's own allowed-forms
//!   text and, every time, a line saying how often it was blocked and to change approach. The repeat count is recorded with the
//!   block (`guard_blocks.repeat`) and counted per guard for `status --json` (`repeat_blocks`).
//! * [`upfront_notice`]: the up-front line about the session-wide switches (spawn stop, limit conserve, guard skips) rides on the
//!   first quiet answer of the event; the check that decides it is `engine/logic/switch-notice.js`.
use crate::checks::git::util::Settings;
use crate::checks::guardkit::settings::get_bool;
use crate::defaults::{self, V};
use crate::dispatch::combine::{self, HookResult};
use crate::dispatch::native::{self, Answer, Meta};
use serde_json::Value;
use std::cell::Cell;
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::sync::{Mutex, OnceLock};

/// What the learner remembers: when each (session, guard) pair was last blocked, which pairs were already shown the allowed forms,
/// how many repeats each guard had, and when each session's up-front check last ran.
#[derive(Default)]
struct Learner {
    seen: HashMap<(String, String), VecDeque<u64>>,
    hinted: HashSet<(String, String)>,
    repeats: BTreeMap<String, u64>,
    last_notice: HashMap<String, u64>,
}

fn learner() -> &'static Mutex<Learner> {
    static L: OnceLock<Mutex<Learner>> = OnceLock::new();
    L.get_or_init(|| Mutex::new(Learner::default()))
}

fn lock() -> std::sync::MutexGuard<'static, Learner> {
    learner().lock().unwrap_or_else(|p| p.into_inner())
}

thread_local! {
    /// The repeat count of the block this thread just annotated (0: not a repeat); the telemetry row of that block takes it.
    static LAST_REPEAT: Cell<u64> = const { Cell::new(0) };
}

/// The repeat count of the block just annotated on this thread, and forget it.
pub fn take_repeat() -> u64 {
    LAST_REPEAT.with(|c| c.replace(0))
}

/// Repeated blocks by guard since this daemon started.
pub fn repeat_blocks() -> BTreeMap<String, u64> {
    lock().repeats.clone()
}

fn session_of(p: &Value) -> String {
    crate::telemetry::Who::of(p).session
}

fn is_block(r: &HookResult) -> bool {
    r.code == Some(2) || (r.code == Some(0) && combine::json_blocks(&r.out))
}

/// Add the learner's lines to a block that comes back. Anything that is not a block, or is the first block of its guard in the
/// window, is returned as it is.
pub fn annotate(meta: &Meta, p: &Value, check: &str, a: Answer) -> Answer {
    LAST_REPEAT.with(|c| c.set(0));
    let (mut r, routes) = match a {
        Answer::Decided(r, routes) => (r, routes),
        Answer::Defer => return Answer::Defer,
    };
    if !is_block(&r) {
        return Answer::Decided(r, routes);
    }
    let session = session_of(p);
    if session.is_empty() || !get_bool(&Settings::from_env(&meta.env), defaults::raw("repeat.setting")) {
        return Answer::Decided(r, routes);
    }
    let guard = defaults::raw("repeat.guard_names").get(check).and_then(V::as_str).unwrap_or(check);
    let overrides = defaults::raw("repeat.overrides").get(guard).or_else(|| defaults::raw("repeat.overrides").get(check));
    let per_guard = |key: &str, fallback: &str| {
        overrides.and_then(|v| v.get(key)).and_then(V::as_integer).filter(|n| *n > 0).map(|n| n as u64).unwrap_or_else(|| defaults::num(fallback))
    };
    let minutes = per_guard("window_min", "repeat.window_min").max(1);
    let (window_ms, min) = (
        minutes.saturating_mul(defaults::num("repeat.ms_per_minute")),
        per_guard("min_blocks", "repeat.min_blocks").max(defaults::num("repeat.min_blocks_floor")),
    );
    let now = crate::health::now_ms();
    let key = (session, check.to_string());
    let (n, first) = {
        let mut l = lock();
        let q = l.seen.entry(key.clone()).or_default();
        q.push_back(now);
        while q.front().is_some_and(|t| now.saturating_sub(*t) > window_ms) {
            q.pop_front();
        }
        let n = q.len() as u64;
        if l.seen.len() as u64 > defaults::num("repeat.max_keys") {
            let oldest = l.seen.iter().filter(|(k, _)| **k != key).min_by_key(|(_, q)| q.back().copied().unwrap_or(0)).map(|(k, _)| k.clone());
            if let Some(k) = oldest {
                l.seen.remove(&k);
                l.hinted.remove(&k);
            }
        }
        if n < min {
            return Answer::Decided(r, routes);
        }
        *l.repeats.entry(check.to_string()).or_insert(0) += 1;
        (n, l.hinted.insert(key))
    };
    LAST_REPEAT.with(|c| c.set(n));
    let mut add = Vec::new();
    if first
        && let Some(forms) = defaults::raw("repeat.allowed_keys").get(guard).or_else(|| defaults::raw("repeat.allowed_keys").get(check)).and_then(V::as_str)
    {
        add.push(defaults::render("repeat.msg_allowed", &[("forms", &defaults::text(forms))]));
    }
    add.push(defaults::render("repeat.msg_changed", &[("n", &n), ("minutes", &minutes)]));
    let add = add.join("\n");
    if r.code == Some(2) {
        r.err = format!("{}\n{add}\n", r.err.trim_end());
    } else if let Ok(Value::Object(mut o)) = serde_json::from_str::<Value>(r.out.trim())
        && let Some(Value::String(reason)) = o.get_mut("reason")
    {
        reason.push('\n');
        reason.push_str(&add);
        r.out = format!("{}\n", Value::Object(o));
    }
    Answer::Decided(r, routes)
}

/// Run the up-front switch check for this event and, when it has a line, put it on the first answer that says nothing. A block among
/// the answers hides stdout from the host, so the check does not run then (it would mark the line as told).
pub fn upfront_notice(meta: &Meta, p: &Value, out: &mut [(String, Answer)]) {
    if !defaults::list("upfront.events").contains(&meta.event.as_str()) {
        return;
    }
    let session = session_of(p);
    if session.is_empty() || out.iter().any(|(_, a)| matches!(a, Answer::Decided(r, _) if is_block(r))) {
        return;
    }
    let name = defaults::text("upfront.check");
    let Some(slot) =
        out.iter().position(|(id, a)| id == name && matches!(a, Answer::Decided(r, _) if r.code == Some(0) && r.out.is_empty() && r.err.is_empty()))
    else {
        return;
    };
    if !get_bool(&Settings::from_env(&meta.env), defaults::raw("upfront.setting")) {
        return;
    }
    let now = crate::health::now_ms();
    {
        let mut l = lock();
        let gap = defaults::num("upfront.min_interval_ms");
        if l.last_notice.get(&session).is_some_and(|t| now.saturating_sub(*t) < gap) {
            return;
        }
        if l.last_notice.len() as u64 > defaults::num("repeat.max_keys") {
            l.last_notice.clear();
        }
        l.last_notice.insert(session, now);
    }
    if let Answer::Decided(r, _) = native::run_check(name, name, meta, p)
        && r.code == Some(0)
        && !r.out.is_empty()
    {
        let routes = match &out[slot].1 {
            Answer::Decided(_, routes) => routes.clone(),
            Answer::Defer => Vec::new(),
        };
        out[slot].1 = Answer::Decided(HookResult { id: out[slot].0.clone(), ..r }, routes);
    }
}
