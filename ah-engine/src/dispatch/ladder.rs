//! The nudge escalation ladder (GH #516): an advisory that keeps firing while nothing changes is re-emitted as a Stop block.
//!
//! Each nudge kind (`nudges.kinds`, the severity class table) lists the hooks whose advisories it counts. Per session and kind the
//! ladder counts at most one fire per turn (Stop to Stop); the kind's hooks running quiet `quiet_reset` times in a row is the
//! condition cleared, which resets the count (acted on). A due kind is held as pending and the next main-session Stop answers one
//! block naming the required next action: a `block` (P0) kind at its first fire, an `escalate` kind after `after` fires and every
//! `every` fires after that. A Stop with `stop_hook_active` never adds a ladder block, so an escalation cannot loop; nor does a Stop
//! that a counted-block guard (task-guard) ran at and let pass after it had blocked (`at_stop`): the guard's cap is absolute.
//!
//! The ladder is a state machine. Per kind a [`Track`] is in one [`Phase`]; `count` moves it on what a call showed (fired, quiet,
//! absent) and `at_stop` on a Stop (the turn boundary, a block, the guard's decision, the facts of [`Live`]). The transition table
//! is the test `the_transition_table_holds_for_every_phase_and_event`; the two invariants (the guard's pass is never overridden;
//! a kind whose fact is gone never blocks and its entry is cleared) are checked over every event sequence by
//! `no_event_sequence_breaks_the_guard_pass_or_the_resolved_fact_invariant`.
//!
//! The ladder observes the hook results BEFORE the token cuts (`inject`, `digest`, `shrink`) blank repeated advisories, and its
//! block is appended after them. It fails open: no session, an unreadable or corrupt state file, a state write that fails, a fact
//! that cannot be read (the tracker state, the task list) or a panic adds nothing. Every class, threshold, list, path and text is in
//! `engine/defaults/nudges.toml`.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - unreadable or corrupt ladder state is a fresh state (fail open); a value that does not parse is the absent value
// A failure that must be seen goes through `crate::discard` or `health::log_event` instead.

use super::combine::{self, HookResult};
use crate::checks::git::util::Settings;
use crate::checks::guardkit::settings::{get_bool, read_object};
use crate::defaults::{self, V};
use crate::reqenv::RequestEnv;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// A kind's severity class.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Class {
    /// Counted only.
    Advisory,
    /// Blocks after `after` fires, then every `every`.
    Escalate,
    /// P0: blocks at the first fire, then every `every`.
    Block,
    /// Not watched.
    Off,
}

fn class_of(word: &str) -> Option<Class> {
    let w = defaults::raw("nudges.class_words");
    [(Class::Advisory, "advisory"), (Class::Escalate, "escalate"), (Class::Block, "block"), (Class::Off, "off")]
        .into_iter()
        .find(|(_, k)| w.str_field(k) == word)
        .map(|(c, _)| c)
}

/// One row of the severity class table.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Kind {
    /// The kind name.
    pub name: String,
    /// Its class (after the owner's override).
    pub class: Class,
    /// Dispatch table ids whose advisories it counts.
    pub hooks: Vec<String>,
    /// Substrings of which one must be in the advisory (empty: any).
    pub matches: Vec<String>,
    /// Fires before the first block of an escalate kind.
    pub after: u64,
    /// Further fires between two blocks.
    pub every: u64,
    /// Consecutive quiet runs that reset the count (0: never).
    pub quiet_reset: u64,
    /// The required next action.
    pub action: String,
    /// Its hooks' blocks count as fires too (a guard whose condition is a deny or a Stop block, not an advisory).
    pub count_blocks: bool,
    /// Tracker signal names whose being up on the session's agents is the kind's fact (empty: none declared).
    pub live_flags: Vec<String>,
    /// The session having an open task is the kind's fact.
    pub live_tasks: bool,
}

fn strings(v: Option<&V>) -> Vec<String> {
    v.map(V::strings).unwrap_or_default().into_iter().map(str::to_string).collect()
}

fn int(v: Option<&V>, dflt: u64) -> u64 {
    v.and_then(V::as_integer).map_or(dflt, |n| n.max(0) as u64)
}

/// The severity table from the TOML, with `overrides` (kind name to class word, from settings.json) applied.
pub fn kinds(overrides: &serde_json::Map<String, Value>) -> Vec<Kind> {
    let (after, every, quiet) = (defaults::num("nudges.after"), defaults::num("nudges.every"), defaults::num("nudges.quiet_reset"));
    let Some(rows) = defaults::raw("nudges.kinds").as_table() else { return Vec::new() };
    rows.iter()
        .filter_map(|(name, row)| {
            let word = overrides.get(*name).and_then(Value::as_str).unwrap_or_else(|| row.str_field("class"));
            let class = class_of(word).or_else(|| class_of(row.str_field("class")))?;
            Some(Kind {
                name: (*name).to_string(),
                class,
                hooks: strings(row.get("hooks")),
                matches: strings(row.get("match")),
                after: int(row.get("after"), after).max(1),
                every: int(row.get("every"), every).max(1),
                quiet_reset: int(row.get("quiet_reset"), quiet),
                action: row.str_field("action").to_string(),
                count_blocks: row.get("count_blocks").and_then(V::as_bool).unwrap_or(false),
                live_flags: strings(row.get("live_flags")),
                live_tasks: row.get("live_tasks").and_then(V::as_bool).unwrap_or(false),
            })
        })
        .collect()
}

/// What one call showed of a kind.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Seen {
    /// One of its hooks gave a matching advisory: its first line.
    Fired(String),
    /// Its hooks ran and gave none.
    Quiet,
    /// None of its hooks ran.
    Absent,
}

fn advisory_text(r: &HookResult) -> Option<String> {
    if r.code != Some(0) || r.out.trim().is_empty() || combine::blocks(r) {
        return None;
    }
    let v: Value = serde_json::from_str(&r.out).unwrap_or(Value::String(r.out.clone())); // keep: plain-text stdout is the advisory itself
    let mut parts: Vec<String> = Vec::new();
    if let Some(c) = combine::context_of(&r.out) {
        parts.push(c);
    }
    if let Some(m) = v.get(defaults::text("nudges.system_message_field")).and_then(Value::as_str) {
        parts.push(m.to_string());
    }
    if let Value::String(s) = v {
        parts.push(s);
    }
    let text = parts.join("\n");
    (!text.trim().is_empty()).then_some(text)
}

/// The reason text of a block result: the JSON reason (or the deny reason), else stderr, else stdout.
fn block_text(r: &HookResult) -> Option<String> {
    if !combine::blocks(r) {
        return None;
    }
    let v: Value = serde_json::from_str(r.out.trim()).unwrap_or(Value::Null); // keep: a non-JSON block carries its reason on stderr
    let f = defaults::raw("nudges.block_reason_fields");
    let json = [f.str_field("reason"), f.str_field("deny")]
        .into_iter()
        .find_map(|k| v.get(k).or_else(|| v.get(f.str_field("specific")).and_then(|h| h.get(k))).and_then(Value::as_str));
    let t = json.map(str::to_string).unwrap_or_else(|| if r.err.trim().is_empty() { r.out.clone() } else { r.err.clone() });
    (!t.trim().is_empty()).then_some(t)
}

/// What `results` showed of `k`.
pub fn observe(k: &Kind, results: &[HookResult]) -> Seen {
    let mine: Vec<&HookResult> = results.iter().filter(|r| k.hooks.contains(&r.id)).collect();
    if mine.is_empty() {
        return Seen::Absent;
    }
    for r in mine {
        let text = advisory_text(r).or_else(|| if k.count_blocks { block_text(r) } else { None });
        if let Some(t) = text.filter(|t| k.matches.is_empty() || k.matches.iter().any(|m| t.contains(m.as_str()))) {
            let max = defaults::num("nudges.headline_chars") as usize;
            let first = t.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
            let ascii: String = first.chars().filter(char::is_ascii).collect::<String>().trim().chars().take(max).collect();
            return Seen::Fired(ascii);
        }
    }
    Seen::Quiet
}

/// One kind's ladder state in one session.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Track {
    /// Fires (one per turn at most) since the last reset.
    pub count: u64,
    /// Consecutive quiet runs.
    pub quiet: u64,
    /// A block is due at the next Stop.
    pub pending: bool,
    /// It already fired this turn.
    pub this_turn: bool,
    /// Blocks shown since the last reset.
    pub shown: u64,
    /// The newest advisory's first line.
    pub headline: String,
}

/// Where a kind's [`Track`] stands (derived from it, so it adds no persisted state).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    /// No entry: nothing counted since the last reset.
    Idle,
    /// Fires counted, no block due.
    Counting,
    /// A block is due and waits for a Stop that may carry it.
    Pending,
    /// A block was shown; fires since then are `ignored`.
    Shown,
}

/// The phase of a kind's entry (`None`: no entry).
pub fn phase(t: Option<&Track>) -> Phase {
    match t {
        None => Phase::Idle,
        Some(t) if t.pending => Phase::Pending,
        Some(t) if t.shown > 0 => Phase::Shown,
        Some(t) if t.count > 0 => Phase::Counting,
        Some(_) => Phase::Idle,
    }
}

/// Whether a counted-block guard's entry shows that it blocked in this session since its last reset: such a guard that later runs
/// at a Stop and lets it pass has decided (its cap, its dedupe, or its condition cleared) that the Stop may end.
fn guard_mark(t: &Track) -> bool {
    t.count > 0 || t.pending || t.shown > 0
}

/// What the ladder can check about a kind's fact at a Stop, read fresh at that Stop.
#[derive(Debug, Clone, Default)]
pub struct Live {
    /// The tracker signals up now on the session's agents (`None`: the tracker state cannot be read).
    pub flags: Option<std::collections::BTreeSet<String>>,
    /// Whether the session has an open task (`None`: the task list cannot be read).
    pub open_tasks: Option<bool>,
}

/// A kind's fact at a Stop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fact {
    /// The kind declares no fact: nothing to check.
    Undeclared,
    /// The fact holds now.
    Holds,
    /// The fact is gone (the stall ended, the tasks are done): the entry is stale.
    Gone,
    /// The fact cannot be read: the kind blocks nothing until it can.
    Unknown,
}

impl Live {
    /// Everything holds (the tests that drive kinds by their hooks' messages alone).
    #[cfg(test)]
    pub fn all_hold(kinds: &[Kind]) -> Live {
        Live { flags: Some(kinds.iter().flat_map(|k| k.live_flags.iter().cloned()).collect()), open_tasks: Some(true) }
    }

    /// `k`'s fact now.
    pub fn fact(&self, k: &Kind) -> Fact {
        if k.live_flags.is_empty() && !k.live_tasks {
            return Fact::Undeclared;
        }
        let mut unknown = false;
        for f in &k.live_flags {
            match &self.flags {
                Some(up) if up.contains(f) => return Fact::Holds,
                Some(_) => {}
                None => unknown = true,
            }
        }
        if k.live_tasks {
            match self.open_tasks {
                Some(true) => return Fact::Holds,
                Some(false) => {}
                None => unknown = true,
            }
        }
        if unknown { Fact::Unknown } else { Fact::Gone }
    }
}

/// One session's ladder state.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct State {
    /// Per kind name.
    pub kinds: BTreeMap<String, Track>,
}

/// A telemetry step: (kind, step word key, blocked).
pub type Step = (String, &'static str, bool);

fn due(k: &Kind, n: u64) -> bool {
    match k.class {
        Class::Block => n >= 1 && (n - 1).is_multiple_of(k.every),
        Class::Escalate => n >= k.after && (n - k.after).is_multiple_of(k.every),
        Class::Advisory | Class::Off => false,
    }
}

/// Count what one call showed. Returns the telemetry steps.
pub fn count(st: &mut State, kinds: &[Kind], seen: &[(String, Seen)]) -> Vec<Step> {
    let mut steps = Vec::new();
    for (name, s) in seen {
        let Some(k) = kinds.iter().find(|k| k.name == *name && k.class != Class::Off) else { continue };
        let t = st.kinds.entry(name.clone()).or_default();
        match s {
            Seen::Fired(h) => {
                t.quiet = 0;
                t.headline.clone_from(h);
                if !t.this_turn {
                    t.this_turn = true;
                    t.count += 1;
                    steps.push((name.clone(), if t.count == 1 { "fired" } else { "repeated" }, false));
                    if t.shown > 0 {
                        steps.push((name.clone(), "ignored", false));
                    }
                    if due(k, t.count) {
                        t.pending = true;
                    }
                }
            }
            Seen::Quiet if k.quiet_reset > 0 => {
                t.quiet += 1;
                if t.quiet >= k.quiet_reset {
                    if t.count > 0 {
                        steps.push((name.clone(), "acted", false));
                    }
                    *t = Track::default();
                }
            }
            Seen::Quiet | Seen::Absent => {}
        }
    }
    st.kinds.retain(|_, t| *t != Track::default());
    steps
}

/// What a Stop is: whether the ladder may add a block, which counted-block guards decided it, and the facts at that moment.
pub struct StopCtx<'a> {
    /// No `stop_hook_active`, no block of another hook on this Stop.
    pub may_block: bool,
    /// Counted-block kinds whose hooks ran at this very Stop, let it pass, and had blocked before (see [`guard_mark`]).
    pub passed: &'a [String],
    /// The kinds' facts now.
    pub live: &'a Live,
}

/// The outcome of one Stop.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct StopOut {
    /// The block reason, when the ladder blocks this Stop.
    pub reason: Option<String>,
    /// The telemetry steps.
    pub steps: Vec<Step>,
    /// Kinds that were due but whose fact could not be read, so they blocked nothing.
    pub unverified: u64,
}

/// At a Stop: the block reason of the pending kinds that fit `nudges.max_chars`, and the turn boundary.
///
/// 1. A kind whose fact is gone (its stall ended, its tasks are done) is stale: its entry is cleared (`acted` when it had counted)
///    and it never blocks. This runs on every Stop, also on one that may not carry a block.
/// 2. A counted-block guard that ran at this Stop, let it pass and had blocked before (`passed`, minus the guards cleared in 1)
///    decided the Stop may end. Its cap is absolute: the ladder adds no block of any kind, and keeps every mark. Nothing but the
///    guard's own fact ending (1) or its next block lifts the hold; no count of passes does.
/// 3. A kind whose fact cannot be read blocks nothing (it stays pending) and is counted in `unverified`.
/// 4. Otherwise each pending `block`/`escalate` kind is answered in table order while the texts fit whole in `nudges.max_chars`; a
///    text that does not fit stays pending for the next Stop.
pub fn at_stop(st: &mut State, kinds: &[Kind], cx: &StopCtx) -> StopOut {
    let mut out = StopOut::default();
    let mut gone: Vec<&str> = Vec::new();
    for k in kinds {
        if cx.live.fact(k) == Fact::Gone {
            if let Some(t) = st.kinds.remove(&k.name)
                && t.count > 0
            {
                out.steps.push((k.name.clone(), "acted", false));
            }
            gone.push(&k.name);
        }
    }
    let held = cx.may_block && cx.passed.iter().any(|g| !gone.contains(&g.as_str()));
    let max = defaults::num("nudges.max_chars") as usize;
    let joiner = defaults::text("dispatch.reason_joiner");
    let mut reason = String::new();
    for k in kinds {
        let Some(t) = st.kinds.get_mut(&k.name) else { continue };
        if cx.may_block && !held && t.pending && matches!(k.class, Class::Block | Class::Escalate) {
            if cx.live.fact(k) == Fact::Unknown {
                out.unverified += 1;
                t.this_turn = false;
                continue;
            }
            let key = if k.class == Class::Block { "nudges.msg_first_fire" } else { "nudges.msg_escalated" };
            let render = |detail: &str| defaults::render(key, &[("action", &k.action), ("detail", &detail), ("n", &t.count)]);
            let detail = if t.headline.is_empty() { String::new() } else { defaults::render("nudges.msg_detail", &[("text", &t.headline)]) };
            let mut text = render(&detail);
            if reason.is_empty() && text.chars().count() > max {
                text = render(""); // the action and the consequence are the part to keep: the quoted line goes first
                text = text.chars().take(max).collect();
            }
            let joined = if reason.is_empty() { 0 } else { joiner.chars().count() };
            if reason.chars().count() + joined + text.chars().count() > max {
                continue; // it does not fit whole: still owed, shown at the next Stop
            }
            if !reason.is_empty() {
                reason.push_str(joiner);
            }
            reason.push_str(&text);
            t.pending = false;
            t.shown += 1;
            out.steps.push((k.name.clone(), if k.class == Class::Block { "blocked" } else { "escalated" }, true));
        }
        t.this_turn = false;
    }
    out.reason = (!reason.is_empty()).then_some(reason);
    out
}

fn session_key(p: &Value) -> Option<String> {
    let max = defaults::num("dispatch.stop_id_max_chars") as usize;
    let s: String = p.get("session_id")?.as_str()?.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').take(max).collect();
    (!s.is_empty()).then_some(s)
}

fn state_file(dir: &Path, key: &str) -> PathBuf {
    dir.join(format!("{key}{}", defaults::text("nudges.state_ext")))
}

/// The session's state: an absent file is a fresh state; a file that cannot be read is `read`, one that is not valid state or is
/// larger than `nudges.state_max_bytes` is `parse` (`nudges.state_error_ops`).
pub fn load(dir: &Path, key: &str) -> Result<State, &'static str> {
    let max = defaults::num("nudges.state_max_bytes");
    let file = match std::fs::File::open(state_file(dir, key)) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(State::default()),
        Err(_) => return Err("read"),
    };
    let mut text = String::new();
    std::io::Read::read_to_string(&mut std::io::Read::take(file, max.saturating_add(1)), &mut text).map_err(|_| "read")?;
    if text.len() as u64 > max {
        return Err("parse");
    }
    serde_json::from_str(&text).map_err(|_| "parse")
}

/// Count one ladder state failure (`nudge_ladder_state_error`, label `op`); the call then takes no ladder action.
fn state_error(op: &str) {
    let ops = defaults::raw("nudges.state_error_ops");
    crate::metrics::bump("nudge_ladder_state_error", &[("op", ops.str_field(op))]);
}

fn save(dir: &Path, key: &str, st: &State) -> bool {
    if crate::limits::ensure_private_dir(dir).is_err() {
        return false;
    }
    serde_json::to_string(st).is_ok_and(|t| crate::atomic::write(state_file(dir, key), t).is_ok())
}

fn prune(dir: &Path) {
    let max = std::time::Duration::from_secs(defaults::num("nudges.state_max_age_days") * 86_400);
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let old = e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|age| age > max);
        if old && e.file_type().is_ok_and(|t| t.is_file()) {
            crate::discard::harmless(std::fs::remove_file(e.path())); // keep: cleanup that raced; an absent file is the goal state
        }
    }
}

fn emit(steps: &[Step]) {
    let words = defaults::raw("nudges.step_words");
    for (kind, step, blocked) in steps {
        crate::telemetry::emit::event(crate::telemetry::emit::nudge_step(kind, words.str_field(step), *blocked));
    }
}

/// What one call of the ladder decided.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Pass {
    /// The block reason, when the ladder blocks this Stop.
    pub reason: Option<String>,
    /// The telemetry steps.
    pub steps: Vec<Step>,
    /// Due kinds whose fact could not be read (they blocked nothing).
    pub unverified: u64,
}

/// One ladder pass over `results` on the in-memory state: count what the call showed, then, at a block event, answer the Stop.
pub fn pass(st: &mut State, event: &str, p: &Value, kinds: &[Kind], results: &[HookResult], live: &Live) -> Pass {
    // the counted-block guards that had blocked before this call: read before `count`, which may reset their entry on a quiet run
    let marked: Vec<String> = kinds.iter().filter(|k| k.count_blocks && st.kinds.get(&k.name).is_some_and(guard_mark)).map(|k| k.name.clone()).collect();
    let seen: Vec<(String, Seen)> = kinds.iter().map(|k| (k.name.clone(), observe(k, results))).collect();
    let mut out = Pass { steps: count(st, kinds, &seen), ..Pass::default() };
    if defaults::list("nudges.block_events").contains(&event) {
        let active = p.get("stop_hook_active").and_then(Value::as_bool) == Some(true);
        // a Stop another hook already blocks carries that block; the ladder's waits for the next Stop (no stacked blocks)
        let blocked = results.iter().any(combine::blocks);
        // a counted-block guard that ran at this Stop and let it pass (its own cap, or the condition cleared) is not contradicted
        let passed: Vec<String> = seen.iter().filter(|(n, s)| *s == Seen::Quiet && marked.contains(n)).map(|(n, _)| n.clone()).collect();
        let stop = at_stop(st, kinds, &StopCtx { may_block: !active && !blocked, passed: &passed, live });
        out.reason = stop.reason;
        out.unverified = stop.unverified;
        out.steps.extend(stop.steps);
    }
    out
}

/// One whole ladder pass over `results` with the state under `dir` and the facts `live`: the block to add, if any.
pub fn run_with(dir: &Path, event: &str, p: &Value, kinds: &[Kind], results: &[HookResult], live: &Live) -> Option<HookResult> {
    let key = session_key(p)?;
    let mut st = match load(dir, &key) {
        Ok(st) => st,
        Err(op) => {
            // no ladder action on this call; a file that is not valid state is replaced by an empty one so the next call recovers
            state_error(op);
            if op == "parse" && !save(dir, &key, &State::default()) {
                state_error("write");
            }
            return None;
        }
    };
    st.kinds.retain(|n, _| kinds.iter().any(|k| k.name == *n)); // a key that is no kind of the table (a hand-edited or stale file) is dropped
    let out = pass(&mut st, event, p, kinds, results, live);
    for _ in 0..out.unverified {
        state_error("facts");
    }
    if !save(dir, &key, &st) {
        state_error("write");
        return None; // a block whose shown mark cannot be kept would repeat: fail open
    }
    emit(&out.steps);
    let body = serde_json::json!({ "decision": "block", "reason": out.reason? }).to_string();
    Some(HookResult { id: defaults::text("nudges.hook_id").to_string(), code: Some(0), out: body, err: String::new() })
}

/// [`run_with`] with every fact holding (the tests that drive the kinds by their hooks' messages).
#[cfg(test)]
pub fn run_in(dir: &Path, event: &str, p: &Value, kinds: &[Kind], results: &[HookResult]) -> Option<HookResult> {
    run_with(dir, event, p, kinds, results, &Live::all_hold(kinds))
}

/// Whether the ladder is on (`nudges.enabled`, default off).
pub fn enabled(env: &RequestEnv) -> bool {
    get_bool(&Settings::from_env(env), defaults::raw("nudges.sw_enabled"))
}

/// Whether the session has an open task, read from the transcript the way the task guards do (`None`: no readable transcript, or a
/// scan that is not sure).
fn open_tasks(p: &Value) -> Option<bool> {
    let path = p.get("transcript_path").and_then(Value::as_str).filter(|t| !t.is_empty())?;
    std::fs::metadata(path).ok()?;
    let (window, wide) = (defaults::num("tasklist_guard.window_bytes"), defaults::num("tasklist_guard.wide_window_bytes"));
    let scan = crate::checks::taskstate::scanview::scan_tasks(path, window, wide).ok().flatten().filter(|s| !s.unsure)?;
    Some(!scan.open_task_ids.is_empty())
}

/// The facts of this Stop, read only when some kind declares one and has an entry to check.
fn live_facts(st: &Settings, p: &Value, kinds: &[Kind]) -> Live {
    let Some(session) = p.get("session_id").and_then(Value::as_str) else { return Live::default() };
    let transcript = p.get("transcript_path").and_then(Value::as_str).unwrap_or("");
    let any = |f: &dyn Fn(&Kind) -> bool| kinds.iter().any(f);
    Live {
        flags: if any(&|k| !k.live_flags.is_empty()) { crate::agents::live_flags(Path::new(&st.home), session, transcript) } else { None },
        open_tasks: if any(&|k| k.live_tasks) { open_tasks(p) } else { None },
    }
}

/// The ladder for one dispatched call: observes `results` (before the token cuts) and returns the block to append, if any.
/// Never panics out and never blocks on an internal failure (fail open).
pub fn apply(event: &str, p: &Value, env: &RequestEnv, results: &[HookResult]) -> Option<HookResult> {
    if !defaults::list("nudges.events").contains(&event) {
        return None;
    }
    if !enabled(env) {
        return None;
    }
    let st = Settings::from_env(env);
    let overrides = read_object(&st, defaults::text("guardkit.settings_file"))
        .and_then(|o| o.get(defaults::text("nudges.section")).and_then(|s| s.get(defaults::text("nudges.override_key"))).and_then(Value::as_object).cloned())
        .unwrap_or_default();
    let dir = crate::paths::dir().join(defaults::text("nudges.state_dir"));
    let run = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        prune(&dir);
        let kinds = kinds(&overrides);
        // the facts are read at a Stop only (the one event that can carry a block)
        let live = if defaults::list("nudges.block_events").contains(&event) { live_facts(&st, p, &kinds) } else { Live::default() };
        run_with(&dir, event, p, &kinds, results, &live)
    }));
    run.unwrap_or_else(|_| {
        crate::health::log_event("nudge_ladder", event, &defaults::render("nudges.msg_fail_open", &[("why", &"panic")]));
        None
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn kind(class: Class, quiet_reset: u64) -> Kind {
        Kind {
            name: "k".into(),
            class,
            hooks: vec!["h".into()],
            matches: vec![],
            after: 3,
            every: 2,
            quiet_reset,
            action: "do the thing".into(),
            count_blocks: false,
            live_flags: vec![],
            live_tasks: false,
        }
    }
    fn adv(text: &str) -> Vec<HookResult> {
        vec![HookResult { id: "h".into(), code: Some(0), out: json!({"systemMessage": text}).to_string(), err: String::new() }]
    }
    fn quiet() -> Vec<HookResult> {
        vec![HookResult::quiet("h")]
    }
    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ah-ladder-{tag}-{}", std::process::id()));
        crate::discard::harmless(std::fs::remove_dir_all(&d));
        d
    }
    fn stop(dir: &Path, k: &Kind, r: &[HookResult]) -> Option<HookResult> {
        run_in(dir, "Stop", &json!({"session_id": "s1"}), std::slice::from_ref(k), r)
    }

    #[test]
    fn an_escalate_kind_blocks_after_n_turns_then_every_m() {
        let d = tmp("esc");
        let k = kind(Class::Escalate, 2);
        let blocks: Vec<bool> = (0..7).map(|_| stop(&d, &k, &adv("⚠️ stop agents a, b")).is_some()).collect();
        assert_eq!(blocks, vec![false, false, true, false, true, false, true], "after 3, then every 2");
        let b = stop(&d, &k, &adv("x")).or_else(|| stop(&d, &k, &adv("x"))).unwrap();
        let reason = serde_json::from_str::<Value>(&b.out).unwrap()["reason"].as_str().unwrap().to_string();
        assert!(reason.contains("do the thing"), "{reason}");
    }

    #[test]
    fn several_fires_in_one_turn_count_once() {
        let d = tmp("turn");
        let k = kind(Class::Escalate, 2);
        for _ in 0..5 {
            assert!(run_in(&d, "PostToolUse", &json!({"session_id": "s1"}), std::slice::from_ref(&k), &adv("a")).is_none());
        }
        assert_eq!(load(&d, "s1").unwrap().kinds["k"].count, 1);
    }

    #[test]
    fn the_condition_clearing_resets_the_count() {
        let d = tmp("reset");
        let k = kind(Class::Escalate, 2);
        stop(&d, &k, &adv("a"));
        stop(&d, &k, &adv("a"));
        let mut st = load(&d, "s1").unwrap();
        let steps = count(&mut st, std::slice::from_ref(&k), &[("k".into(), Seen::Quiet)]);
        assert!(steps.is_empty(), "one quiet run is not enough");
        let steps = count(&mut st, std::slice::from_ref(&k), &[("k".into(), Seen::Quiet)]);
        assert_eq!(steps, vec![("k".to_string(), "acted", false)]);
        assert!(!st.kinds.contains_key("k"), "count reset");
        let absent = count(&mut st, std::slice::from_ref(&k), &[("k".into(), Seen::Absent)]);
        assert!(absent.is_empty(), "a hook that did not run proves nothing");
    }

    #[test]
    fn a_p0_kind_blocks_at_first_fire_with_two_lines_and_one_emoji() {
        let d = tmp("p0");
        let k = kind(Class::Block, 2);
        let b = stop(&d, &k, &adv("🛑 model routing note")).expect("blocked at first fire");
        let reason = serde_json::from_str::<Value>(&b.out).unwrap()["reason"].as_str().unwrap().to_string();
        assert!(reason.lines().count() <= 2, "{reason}");
        assert_eq!(reason.chars().filter(|c| !c.is_ascii()).count(), 1, "one emoji: {reason}");
        assert!(stop(&d, &k, &quiet()).is_none());
    }

    #[test]
    fn a_stop_that_was_already_blocked_never_adds_a_ladder_block() {
        let d = tmp("active");
        let k = kind(Class::Block, 2);
        let p = json!({"session_id": "s1", "stop_hook_active": true});
        assert!(run_in(&d, "Stop", &p, std::slice::from_ref(&k), &adv("a")).is_none());
        assert!(load(&d, "s1").unwrap().kinds["k"].pending, "held for the next Stop");
    }

    #[test]
    fn corrupt_state_or_an_unwritable_dir_fails_open() {
        let d = tmp("corrupt");
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(state_file(&d, "s1"), "{not json").unwrap();
        let k = kind(Class::Escalate, 2);
        let bumped = |op: &str| crate::metrics::bumped_on_this_thread("nudge_ladder_state_error", &[("op", op)]);
        assert!(stop(&d, &k, &adv("a")).is_none(), "a corrupt file adds no ladder action");
        assert_eq!(bumped("parse"), 1, "and is counted");
        assert!(load(&d, "s1").is_ok_and(|st| st.kinds.is_empty()), "the corrupt file is replaced by an empty state so the next call recovers");
        let p0 = kind(Class::Block, 2);
        assert!(stop(&d, &p0, &adv("a")).is_some(), "a P0 kind blocks once the state is readable again");
        let file = tmp("file");
        std::fs::write(&file, "x").unwrap();
        assert!(stop(&file.join("sub"), &p0, &adv("a")).is_none(), "state under a path that is no directory adds nothing");
        assert_eq!(bumped("read"), 1, "and is counted");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let ro = tmp("readonly");
            std::fs::create_dir_all(&ro).unwrap();
            std::fs::set_permissions(&ro, std::fs::Permissions::from_mode(0o500)).unwrap();
            let blocked = stop(&ro, &p0, &adv("a"));
            let writable = std::fs::write(ro.join("probe"), "x").is_ok(); // a root user ignores the mode: nothing to prove then
            std::fs::set_permissions(&ro, std::fs::Permissions::from_mode(0o700)).unwrap();
            if !writable {
                assert!(blocked.is_none(), "state that cannot be written adds nothing");
                assert_eq!(bumped("write"), 1, "and is counted");
            }
        }
        assert!(run_in(&d, "Stop", &json!({}), std::slice::from_ref(&p0), &adv("a")).is_none(), "no session, no ladder");
    }

    #[test]
    fn the_shipped_table_parses_and_an_override_changes_a_class() {
        let all = kinds(&serde_json::Map::new());
        assert!(all.iter().any(|k| k.class == Class::Block) && all.iter().any(|k| k.class == Class::Escalate));
        let first = all.first().unwrap().name.clone();
        let mut o = serde_json::Map::new();
        o.insert(first.clone(), json!(defaults::raw("nudges.class_words").str_field("off")));
        assert_eq!(kinds(&o).iter().find(|k| k.name == first).unwrap().class, Class::Off);
        for key in ["nudges.msg_escalated", "nudges.msg_first_fire"] {
            let t = defaults::text(key);
            assert!(t.lines().count() <= 2 && t.chars().filter(|c| !c.is_ascii()).count() == 1, "{key}: {t}");
        }
    }

    #[test]
    fn a_block_or_a_non_matching_advisory_is_not_a_fire() {
        let mut k = kind(Class::Escalate, 2);
        let blocked = vec![HookResult { id: "h".into(), code: Some(0), out: json!({"decision": "block", "reason": "r"}).to_string(), err: String::new() }];
        assert_eq!(observe(&k, &blocked), Seen::Quiet);
        k.matches = vec!["needle".into()];
        assert_eq!(observe(&k, &adv("hay")), Seen::Quiet);
        assert_eq!(observe(&k, &adv("a needle")), Seen::Fired("a needle".into()));
        k.count_blocks = true;
        let deny = vec![HookResult { id: "h".into(), code: Some(2), out: String::new(), err: "a needle denied\n".into() }];
        assert_eq!(observe(&k, &deny), Seen::Fired("a needle denied".into()), "a counted block is a fire");
    }

    #[test]
    fn a_stop_another_hook_blocks_holds_the_ladder_block_for_the_next_stop() {
        let d = tmp("held");
        let mut k = kind(Class::Block, 2);
        k.count_blocks = true;
        let b = vec![HookResult { id: "h".into(), code: Some(0), out: json!({"decision": "block", "reason": "r"}).to_string(), err: String::new() }];
        assert!(stop(&d, &k, &b).is_none(), "no second block on a Stop that is already blocked");
        assert!(load(&d, "s1").unwrap().kinds["k"].pending, "held");
        assert!(stop(&d, &k, &[]).is_some(), "shown at the next Stop");
    }

    #[test]
    fn a_counted_block_guard_that_let_the_stop_pass_gets_no_ladder_block() {
        let d = tmp("capped");
        let mut k = kind(Class::Block, 0);
        k.count_blocks = true;
        let b = vec![HookResult { id: "h".into(), code: Some(0), out: json!({"decision": "block", "reason": "r"}).to_string(), err: String::new() }];
        assert!(stop(&d, &k, &b).is_none(), "the guard's own block carries the Stop");
        assert!(load(&d, "s1").unwrap().kinds["k"].pending, "held");
        // the guard ran at the next Stop and let it pass (its cap): the ladder does not contradict it
        assert!(stop(&d, &k, &quiet()).is_none(), "a capped guard's pass is not blocked by the ladder");
        // the guard did not run at all (kind absent): the held block is shown
        assert!(stop(&d, &k, &[]).is_some(), "no guard decision to contradict");
    }

    fn guard_block() -> HookResult {
        HookResult { id: "g".into(), code: Some(0), out: json!({"decision": "block", "reason": "r"}).to_string(), err: String::new() }
    }
    fn guard_kind() -> Kind {
        let mut g = kind(Class::Block, 0);
        g.name = "g".into();
        g.hooks = vec!["g".into()];
        g.count_blocks = true;
        g
    }
    fn watcher_kind() -> Kind {
        let mut s = kind(Class::Escalate, 0);
        s.name = "s".into();
        s.hooks = vec!["s".into()];
        s.after = 1;
        s
    }
    fn watcher_adv() -> HookResult {
        HookResult { id: "s".into(), code: Some(0), out: json!({"systemMessage": "stalled agent w1"}).to_string(), err: String::new() }
    }
    fn stop_all(dir: &Path, ks: &[Kind], r: &[HookResult]) -> Option<HookResult> {
        run_in(dir, "Stop", &json!({"session_id": "s1"}), ks, r)
    }

    #[test]
    fn a_held_counted_block_makes_every_other_kind_wait_while_its_guard_lets_the_stop_pass() {
        let d = tmp("held-all");
        let ks = [guard_kind(), watcher_kind()];
        let quiet_guard = HookResult::quiet("g");
        assert!(stop_all(&d, &ks, &[guard_block(), watcher_adv()]).is_none(), "the guard's own block carries the first Stop");
        let st = load(&d, "s1").unwrap();
        assert!(st.kinds["g"].pending && st.kinds["s"].pending, "both blocks are held: {st:?}");
        // the guard ran at this Stop and let it pass (its cap): no ladder block of ANY kind may turn that into a block
        assert!(stop_all(&d, &ks, &[quiet_guard.clone(), watcher_adv()]).is_none(), "the other kind waits too");
        assert!(load(&d, "s1").unwrap().kinds["s"].pending, "its mark is kept");
        // the guard did not run at all: nothing to contradict, the held block of the other kind is shown
        assert!(stop_all(&d, &ks, &[watcher_adv()]).is_some(), "shown once the guard no longer decides this Stop");
    }

    #[test]
    fn a_kind_with_no_held_counted_block_is_not_muted_by_a_quiet_guard() {
        let d = tmp("held-none");
        let ks = [guard_kind(), watcher_kind()];
        assert!(stop_all(&d, &ks, &[HookResult::quiet("g"), watcher_adv()]).is_some(), "a guard that never blocked holds nothing: the escalation is shown");
    }

    // ---- the ladder as a state machine (class fix): the guard's pass is absolute; a resolved fact clears its entry ----

    const WATCH: &str = "watch action";

    fn watcher_live() -> Kind {
        let mut s = watcher_kind();
        s.live_flags = vec!["stalled".into()];
        s.action = WATCH.into();
        s
    }
    fn tasks_guard() -> Kind {
        let mut g = guard_kind();
        g.live_tasks = true;
        g.action = "guard action".into();
        g
    }
    fn up(flags: &[&str], tasks: Option<bool>) -> Live {
        Live { flags: Some(flags.iter().map(|f| f.to_string()).collect()), open_tasks: tasks }
    }
    fn track(count: u64, pending: bool, shown: u64, quiet: u64) -> Track {
        Track { count, quiet, pending, this_turn: false, shown, headline: "stalled agent w1".into() }
    }
    fn p_stop(active: bool) -> Value {
        json!({"session_id": "s1", "stop_hook_active": active})
    }
    fn words(out: &Pass) -> Vec<&'static str> {
        out.steps.iter().map(|(_, w, _)| *w).collect()
    }

    #[test]
    fn the_transition_table_holds_for_every_phase_and_event() {
        #[derive(Clone, Copy, Debug)]
        enum Ev {
            Fire,
            FireSameTurn,
            Quiet,
            Absent,
            StopFree,
            StopActive,
            StopOtherBlock,
            StopGone,
            StopUnknown,
        }
        let mut k = kind(Class::Escalate, 2); // after 3 is the helper's; use after 2, every 2
        k.after = 2;
        k.live_flags = vec!["stalled".into()];
        let ks = [k];
        let other_block = HookResult { id: "other".into(), code: Some(0), out: json!({"decision": "block", "reason": "r"}).to_string(), err: String::new() };
        // (start, event, phase after, steps, blocked, unverified)
        #[rustfmt::skip]
        #[allow(clippy::type_complexity)]
        let rows: Vec<(Option<Track>, Ev, Phase, Vec<&str>, bool, u64)> = vec![
            (None,                         Ev::Fire,           Phase::Counting, vec!["fired"],                false, 0),
            (Some(track(1, false, 0, 0)),  Ev::Fire,           Phase::Pending,  vec!["repeated"],             false, 0),
            (Some(track(1, false, 0, 0)),  Ev::FireSameTurn,   Phase::Counting, vec![],                       false, 0),
            (Some(track(2, true, 0, 0)),   Ev::Fire,           Phase::Pending,  vec!["repeated"],             false, 0),
            (Some(track(2, false, 1, 0)),  Ev::Fire,           Phase::Shown,    vec!["repeated", "ignored"],  false, 0),
            (Some(track(3, false, 1, 0)),  Ev::Fire,           Phase::Pending,  vec!["repeated", "ignored"],  false, 0),
            (Some(track(1, false, 0, 0)),  Ev::Quiet,          Phase::Counting, vec![],                       false, 0),
            (Some(track(1, false, 0, 1)),  Ev::Quiet,          Phase::Idle,     vec!["acted"],                false, 0),
            (Some(track(2, true, 0, 1)),   Ev::Quiet,          Phase::Idle,     vec!["acted"],                false, 0),
            (Some(track(2, false, 1, 1)),  Ev::Quiet,          Phase::Idle,     vec!["acted"],                false, 0),
            (Some(track(1, false, 0, 0)),  Ev::Absent,         Phase::Counting, vec![],                       false, 0),
            (Some(track(2, true, 0, 0)),   Ev::Absent,         Phase::Pending,  vec![],                       false, 0),
            (None,                         Ev::Absent,         Phase::Idle,     vec![],                       false, 0),
            (Some(track(2, true, 0, 0)),   Ev::StopFree,       Phase::Shown,    vec!["escalated"],            true,  0),
            (Some(track(1, false, 0, 0)),  Ev::StopFree,       Phase::Counting, vec![],                       false, 0),
            (Some(track(2, false, 1, 0)),  Ev::StopFree,       Phase::Shown,    vec![],                       false, 0),
            (Some(track(2, true, 0, 0)),   Ev::StopActive,     Phase::Pending,  vec![],                       false, 0),
            (Some(track(2, true, 0, 0)),   Ev::StopOtherBlock, Phase::Pending,  vec![],                       false, 0),
            (Some(track(2, true, 0, 0)),   Ev::StopGone,       Phase::Idle,     vec!["acted"],                false, 0),
            (Some(track(1, false, 0, 0)),  Ev::StopGone,       Phase::Idle,     vec!["acted"],                false, 0),
            (Some(track(2, false, 1, 0)),  Ev::StopGone,       Phase::Idle,     vec!["acted"],                false, 0),
            (None,                         Ev::StopGone,       Phase::Idle,     vec![],                       false, 0),
            (Some(track(2, true, 0, 0)),   Ev::StopUnknown,    Phase::Pending,  vec![],                       false, 1),
            (Some(track(1, false, 0, 0)),  Ev::StopUnknown,    Phase::Counting, vec![],                       false, 0),
        ];
        for (i, (start, ev, want_phase, want_steps, want_block, want_unverified)) in rows.into_iter().enumerate() {
            let mut st = State::default();
            if let Some(t) = start {
                let mut t = t;
                t.this_turn = matches!(ev, Ev::FireSameTurn);
                st.kinds.insert("k".into(), t);
            }
            let (event, results, active, live): (&str, Vec<HookResult>, bool, Live) = match ev {
                Ev::Fire | Ev::FireSameTurn => ("PostToolUse", adv("stalled agent w1"), false, up(&["stalled"], None)),
                Ev::Quiet => ("PostToolUse", quiet(), false, up(&["stalled"], None)),
                Ev::Absent => ("PostToolUse", vec![], false, up(&["stalled"], None)),
                Ev::StopFree => ("Stop", vec![], false, up(&["stalled"], None)),
                Ev::StopActive => ("Stop", vec![], true, up(&["stalled"], None)),
                Ev::StopOtherBlock => ("Stop", vec![other_block.clone()], false, up(&["stalled"], None)),
                Ev::StopGone => ("Stop", vec![], false, up(&[], None)),
                Ev::StopUnknown => ("Stop", vec![], false, Live::default()),
            };
            let out = pass(&mut st, event, &p_stop(active), &ks, &results, &live);
            let ctx = format!("row {i}: {ev:?}");
            assert_eq!(phase(st.kinds.get("k")), want_phase, "{ctx}: phase");
            assert_eq!(words(&out), want_steps, "{ctx}: steps");
            assert_eq!(out.reason.is_some(), want_block, "{ctx}: blocked");
            assert_eq!(out.unverified, want_unverified, "{ctx}: unverified");
        }
    }

    #[test]
    fn the_guard_transitions_decide_who_may_block_a_stop() {
        // g: the counted-block guard (Block, tasks fact), s: the stall kind with a due block
        let ks = [tasks_guard(), watcher_live()];
        let s_due = ("s", track(1, true, 0, 0));
        let quiet_g = vec![HookResult::quiet("g")];
        // (name, g's entry, g's results, tasks, who may block: watch / guard)
        #[allow(clippy::type_complexity)]
        let rows: Vec<(&str, Option<Track>, Vec<HookResult>, Option<bool>, bool, bool)> = vec![
            ("a guard that never blocked holds nothing", None, quiet_g.clone(), Some(true), true, false),
            ("a pending guard mark holds", Some(track(1, true, 0, 0)), quiet_g.clone(), Some(true), false, false),
            ("a shown guard block holds", Some(track(1, false, 1, 0)), quiet_g.clone(), Some(true), false, false),
            ("a counted guard fire holds", Some(track(1, false, 0, 0)), quiet_g.clone(), Some(true), false, false),
            ("tasks done lift the hold and clear the guard", Some(track(1, true, 0, 0)), quiet_g.clone(), Some(false), true, false),
            ("unreadable tasks keep the hold", Some(track(1, true, 0, 0)), quiet_g.clone(), None, false, false),
            ("a guard that did not run decides nothing", Some(track(1, true, 0, 0)), vec![], Some(true), true, true),
            ("a guard that blocks carries the Stop itself", Some(track(1, true, 0, 0)), vec![guard_block()], Some(true), false, false),
        ];
        for (name, g, results, tasks, watch, guard) in rows {
            let mut st = State::default();
            st.kinds.insert(s_due.0.into(), s_due.1.clone());
            if let Some(g) = g {
                st.kinds.insert("g".into(), g);
            }
            let out = pass(&mut st, "Stop", &p_stop(false), &ks, &results, &up(&["stalled"], tasks));
            let r = out.reason.clone().unwrap_or_default();
            assert_eq!(r.contains(WATCH), watch, "{name}: the stall block ({r:?})");
            assert_eq!(r.contains("guard action"), guard, "{name}: the guard's own block ({r:?})");
            if tasks == Some(false) {
                assert!(!st.kinds.contains_key("g"), "{name}: the guard's entry is cleared");
            }
        }
    }

    #[test]
    fn a_guards_pass_is_never_overridden_by_a_count_of_permitted_stops() {
        let d = tmp("no-expiry");
        let ks = [guard_kind(), watcher_kind()];
        assert!(stop_all(&d, &ks, &[guard_block(), watcher_adv()]).is_none());
        for n in 1..=60 {
            assert!(stop_all(&d, &ks, &[HookResult::quiet("g"), watcher_adv()]).is_none(), "permitted Stop {n} (far past any old pass limit)");
        }
        assert!(load(&d, "s1").unwrap().kinds["s"].pending, "the stall escalation is still owed");
        assert!(stop_all(&d, &ks, &[watcher_adv()]).is_some(), "positive control: it is shown once the guard no longer decides the Stop");
    }

    #[test]
    fn a_guard_that_resets_on_a_quiet_run_still_decides_the_stop_it_passed() {
        let d = tmp("reset-guard");
        let mut g = guard_kind();
        g.quiet_reset = 1; // one quiet run resets its entry in `count`, before the Stop is answered
        let ks = [g, watcher_kind()];
        assert!(stop_all(&d, &ks, &[guard_block(), watcher_adv()]).is_none());
        assert!(stop_all(&d, &ks, &[HookResult::quiet("g"), watcher_adv()]).is_none(), "the guard had blocked: its pass decides this Stop");
        assert!(!load(&d, "s1").unwrap().kinds.contains_key("g"), "and its own configured reset still applies");
        assert!(stop_all(&d, &ks, &[HookResult::quiet("g"), watcher_adv()]).is_some(), "the next Stop has no guard mark to respect");
    }

    #[test]
    fn a_resolved_fact_clears_the_entry_and_never_blocks() {
        let d = tmp("resolved");
        let ks = [watcher_live()];
        let active = json!({"session_id": "s1", "stop_hook_active": true});
        assert!(run_with(&d, "Stop", &active, &ks, &[watcher_adv()], &up(&["stalled"], None)).is_none());
        assert!(load(&d, "s1").unwrap().kinds["s"].pending, "due and owed");
        assert!(stop_all_live(&d, &ks, &[], &up(&[], None)).is_none(), "the stall ended: nothing to block");
        assert!(load(&d, "s1").unwrap().kinds.is_empty(), "and the entry is gone");
        // the same Stop that may not carry a block clears it too
        assert!(run_with(&d, "Stop", &active, &ks, &[watcher_adv()], &up(&["stalled"], None)).is_none());
        assert!(run_with(&d, "Stop", &active, &ks, &[], &up(&[], None)).is_none());
        assert!(load(&d, "s1").unwrap().kinds.is_empty(), "cleared on a Stop that carries no block");
        // a stall that fires again starts counting from one
        assert!(run_with(&d, "Stop", &active, &ks, &[watcher_adv()], &up(&["stalled"], None)).is_none());
        assert_eq!(load(&d, "s1").unwrap().kinds["s"].count, 1);
    }

    fn stop_all_live(dir: &Path, ks: &[Kind], r: &[HookResult], live: &Live) -> Option<HookResult> {
        run_with(dir, "Stop", &json!({"session_id": "s1"}), ks, r, live)
    }

    #[test]
    fn a_fact_that_cannot_be_read_blocks_nothing_is_counted_and_stays_owed() {
        let d = tmp("unknown");
        let ks = [watcher_live()];
        let active = json!({"session_id": "s1", "stop_hook_active": true});
        assert!(run_with(&d, "Stop", &active, &ks, &[watcher_adv()], &up(&["stalled"], None)).is_none());
        let bumped = || crate::metrics::bumped_on_this_thread("nudge_ladder_state_error", &[("op", "facts")]);
        assert!(stop_all_live(&d, &ks, &[], &Live::default()).is_none(), "an unverifiable stall is no block");
        assert_eq!(bumped(), 1, "and is counted");
        assert!(load(&d, "s1").unwrap().kinds["s"].pending, "still owed");
        assert!(stop_all_live(&d, &ks, &[], &up(&["stalled"], None)).is_some(), "shown once the fact can be read and holds");
    }

    #[test]
    fn the_guards_own_fact_ending_lifts_its_hold_and_an_unreadable_fact_keeps_it() {
        let d = tmp("tasks-fact");
        let ks = [tasks_guard(), watcher_live()];
        let f = |tasks| up(&["stalled"], tasks);
        assert!(stop_all_live(&d, &ks, &[guard_block(), watcher_adv()], &f(Some(true))).is_none());
        assert!(stop_all_live(&d, &ks, &[HookResult::quiet("g"), watcher_adv()], &f(Some(true))).is_none(), "tasks open: held");
        assert!(stop_all_live(&d, &ks, &[HookResult::quiet("g"), watcher_adv()], &f(None)).is_none(), "tasks unreadable: held");
        let b = stop_all_live(&d, &ks, &[HookResult::quiet("g"), watcher_adv()], &f(Some(false))).expect("tasks done: the hold ends");
        assert!(b.out.contains(WATCH) && !b.out.contains("guard action"), "{}", b.out);
        assert!(!load(&d, "s1").unwrap().kinds.contains_key("g"), "the guard's stale entry is gone");
    }

    #[test]
    fn both_facts_gone_clear_both_entries_and_block_nothing() {
        let d = tmp("both-gone");
        let ks = [tasks_guard(), watcher_live()];
        assert!(stop_all_live(&d, &ks, &[guard_block(), watcher_adv()], &up(&["stalled"], Some(true))).is_none());
        assert!(stop_all_live(&d, &ks, &[HookResult::quiet("g")], &up(&[], Some(false))).is_none());
        assert!(load(&d, "s1").unwrap().kinds.is_empty());
    }

    #[test]
    fn a_kinds_fact_is_undeclared_holds_gone_or_unknown() {
        let plain = kind(Class::Escalate, 0);
        let mut flags = kind(Class::Escalate, 0);
        flags.live_flags = vec!["a".into(), "b".into()];
        let mut both = flags.clone();
        both.live_tasks = true;
        let mut tasks = kind(Class::Escalate, 0);
        tasks.live_tasks = true;
        let none = Live::default();
        assert_eq!(none.fact(&plain), Fact::Undeclared);
        assert_eq!(up(&["a"], None).fact(&flags), Fact::Holds, "any listed signal up");
        assert_eq!(up(&["b"], None).fact(&flags), Fact::Holds);
        assert_eq!(up(&["c"], None).fact(&flags), Fact::Gone);
        assert_eq!(none.fact(&flags), Fact::Unknown);
        assert_eq!(up(&[], Some(true)).fact(&tasks), Fact::Holds);
        assert_eq!(up(&[], Some(false)).fact(&tasks), Fact::Gone);
        assert_eq!(up(&[], None).fact(&tasks), Fact::Unknown);
        assert_eq!(up(&["c"], Some(true)).fact(&both), Fact::Holds, "either source holding is enough");
        assert_eq!(up(&["c"], Some(false)).fact(&both), Fact::Gone);
        assert_eq!(up(&["c"], None).fact(&both), Fact::Unknown, "gone on one source and unreadable on the other cannot be called gone");
        assert_eq!(up(&["a"], None).fact(&both), Fact::Holds, "holding on one source settles it");
    }

    #[test]
    fn a_state_file_from_before_the_hold_counter_was_removed_still_loads() {
        let d = tmp("legacy");
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(state_file(&d, "s1"), r#"{"kinds":{"s":{"count":2,"pending":true,"held":5,"headline":"x"}}}"#).unwrap();
        let st = load(&d, "s1").expect("an older state file is valid state");
        assert!(st.kinds["s"].pending && st.kinds["s"].count == 2);
    }

    #[derive(Clone, Copy, Debug)]
    enum G {
        Block,
        Pass,
        Absent,
    }
    #[derive(Clone, Copy, Debug)]
    enum Flags {
        Stalled,
        Resolved,
        Unreadable,
    }
    #[derive(Clone, Copy, Debug)]
    struct Sym {
        name: &'static str,
        guard: G,
        reminder: bool,
        flags: Flags,
        tasks: Option<bool>,
        active: bool,
    }

    #[test]
    fn no_event_sequence_breaks_the_guard_pass_or_the_resolved_fact_invariant() {
        let ks = vec![tasks_guard(), watcher_live()];
        let alphabet = [
            Sym { name: "guard-blocks", guard: G::Block, reminder: true, flags: Flags::Stalled, tasks: Some(true), active: false },
            Sym { name: "guard-passes-tasks-open", guard: G::Pass, reminder: true, flags: Flags::Stalled, tasks: Some(true), active: false },
            Sym { name: "guard-passes-tasks-done", guard: G::Pass, reminder: true, flags: Flags::Stalled, tasks: Some(false), active: false },
            Sym { name: "no-guard", guard: G::Absent, reminder: true, flags: Flags::Stalled, tasks: Some(true), active: false },
            Sym { name: "stall-resolved", guard: G::Absent, reminder: false, flags: Flags::Resolved, tasks: Some(true), active: false },
            Sym { name: "resolved-but-reminded", guard: G::Absent, reminder: true, flags: Flags::Resolved, tasks: Some(true), active: false },
            Sym { name: "stop-hook-active", guard: G::Absent, reminder: true, flags: Flags::Stalled, tasks: Some(true), active: true },
            Sym { name: "facts-unreadable", guard: G::Absent, reminder: true, flags: Flags::Unreadable, tasks: None, active: false },
            Sym { name: "guard-passes-tasks-unreadable", guard: G::Pass, reminder: true, flags: Flags::Stalled, tasks: None, active: false },
            Sym { name: "guard-passes-stall-resolved", guard: G::Pass, reminder: false, flags: Flags::Resolved, tasks: Some(true), active: false },
        ];
        #[derive(Default)]
        struct Tally {
            sequences: u64,
            watch_blocks: u64,
            guard_blocks: u64,
            held: u64,
            cleared: u64,
        }
        fn walk(st: &State, depth: usize, trail: &mut Vec<&'static str>, ks: &[Kind], alphabet: &[Sym], t: &mut Tally) {
            if depth == 0 {
                return;
            }
            for sym in alphabet {
                trail.push(sym.name);
                let mut results: Vec<HookResult> = match sym.guard {
                    G::Block => vec![guard_block()],
                    G::Pass => vec![HookResult::quiet("g")],
                    G::Absent => vec![],
                };
                if sym.reminder {
                    results.push(watcher_adv());
                }
                let live = Live {
                    flags: match sym.flags {
                        Flags::Stalled => Some(["stalled".to_string()].into()),
                        Flags::Resolved => Some(Default::default()),
                        Flags::Unreadable => None,
                    },
                    open_tasks: sym.tasks,
                };
                let before = st.clone();
                let mut after = st.clone();
                let out = pass(&mut after, "Stop", &p_stop(sym.active), ks, &results, &live);
                let at = || format!("{trail:?}");
                let reason = out.reason.clone().unwrap_or_default();
                let (guard_marked, tasks) = (before.kinds.get("g").is_some_and(guard_mark), sym.tasks);
                let may_block = !sym.active && !matches!(sym.guard, G::Block);
                let guard_decides = matches!(sym.guard, G::Pass) && guard_marked && tasks != Some(false);
                // I1: a Stop a marked guard ran at and passed is never blocked by the ladder, whatever came before
                if guard_decides {
                    assert!(reason.is_empty(), "{}: the guard's pass was overridden: {reason}", at());
                    t.held += 1;
                }
                // I3: no block on a Stop another hook blocks or one that has stop_hook_active
                if !may_block {
                    assert!(reason.is_empty(), "{}: a block on a Stop that may not carry one: {reason}", at());
                }
                // I2: a kind whose fact is gone has no entry after the Stop and its action is never shown
                if matches!(sym.flags, Flags::Resolved) {
                    assert!(!after.kinds.contains_key("s") && !reason.contains(WATCH), "{}: a resolved stall kept its entry or blocked: {reason}", at());
                    t.cleared += 1;
                }
                if tasks == Some(false) {
                    assert!(!after.kinds.contains_key("g") && !reason.contains("guard action"), "{}: the guard's stale entry stayed", at());
                }
                // I4: the block is exactly the due, verified, undecided case (so the invariants cannot pass by never blocking)
                let seen: Vec<(String, Seen)> = ks.iter().map(|k| (k.name.clone(), observe(k, &results))).collect();
                let mut counted = before.clone();
                count(&mut counted, ks, &seen);
                let due = |n: &str| counted.kinds.get(n).is_some_and(|x| x.pending);
                let watch_ok = may_block && !guard_decides && due("s") && matches!(sym.flags, Flags::Stalled);
                let guard_ok = may_block && !guard_decides && due("g") && tasks == Some(true);
                assert_eq!(reason.contains(WATCH), watch_ok, "{}: the stall block should be {watch_ok}: {reason:?}", at());
                assert_eq!(reason.contains("guard action"), guard_ok, "{}: the guard's own block should be {guard_ok}: {reason:?}", at());
                // bounded, and the turn boundary is applied
                assert!(after.kinds.len() <= 2 && after.kinds.values().all(|x| !x.this_turn), "{}: {after:?}", at());
                t.watch_blocks += u64::from(watch_ok);
                t.guard_blocks += u64::from(guard_ok);
                t.sequences += 1;
                walk(&after, depth - 1, trail, ks, alphabet, t);
                trail.pop();
            }
        }
        let mut t = Tally::default();
        walk(&State::default(), 5, &mut Vec::new(), &ks, &alphabet, &mut t);
        assert!(t.sequences > 100_000, "{} steps walked", t.sequences);
        assert!(t.watch_blocks > 1000 && t.guard_blocks > 100, "positive controls: the ladder does block ({} / {})", t.watch_blocks, t.guard_blocks);
        assert!(t.held > 1000 && t.cleared > 1000, "and both invariants were exercised ({} held, {} cleared)", t.held, t.cleared);
    }

    #[test]
    fn a_reason_over_the_limit_keeps_whole_texts_and_leaves_the_rest_pending() {
        let d = tmp("fit");
        let long = "x".repeat(defaults::num("nudges.max_chars") as usize / 2);
        let mut a = kind(Class::Block, 0);
        a.name = "a".into();
        a.hooks = vec!["a".into()];
        a.action = format!("first {long}");
        let mut b = a.clone();
        b.name = "b".into();
        b.hooks = vec!["b".into()];
        b.action = format!("second {long}");
        let ks = [a, b];
        let adv = |id: &str| HookResult { id: id.into(), code: Some(0), out: json!({"systemMessage": "m"}).to_string(), err: String::new() };
        let first = stop_all(&d, &ks, &[adv("a"), adv("b")]).expect("blocked");
        let reason = serde_json::from_str::<Value>(&first.out).unwrap()["reason"].as_str().unwrap().to_string();
        assert!(reason.chars().count() <= defaults::num("nudges.max_chars") as usize, "within the limit");
        assert!(
            reason.contains("first") && reason.contains("Required next") && reason.contains("Stop stays blocked"),
            "the whole first text, clearing step and consequence: {reason}"
        );
        assert!(!reason.contains("second"), "{reason}");
        let st = load(&d, "s1").unwrap();
        assert!(!st.kinds["a"].pending && st.kinds["b"].pending, "the text that did not fit is still owed: {st:?}");
        let next = stop_all(&d, &ks, &[]).expect("the owed block is shown at the next Stop");
        assert!(next.out.contains("second"), "{}", next.out);
    }

    #[test]
    fn an_oversize_or_foreign_keyed_state_is_bounded() {
        let d = tmp("bound");
        std::fs::create_dir_all(&d).unwrap();
        let k = watcher_kind();
        let bumped = |op: &str| crate::metrics::bumped_on_this_thread("nudge_ladder_state_error", &[("op", op)]);
        let big = format!("{{\"kinds\":{{\"pad\":{{\"headline\":\"{}\"}}}}}}", "y".repeat(defaults::num("nudges.state_max_bytes") as usize));
        std::fs::write(state_file(&d, "s1"), big).unwrap();
        assert!(stop_all(&d, std::slice::from_ref(&k), &[watcher_adv()]).is_none(), "an oversize state adds no ladder action");
        assert_eq!(bumped("parse"), 1, "and is counted");
        assert!(std::fs::metadata(state_file(&d, "s1")).unwrap().len() < defaults::num("nudges.state_max_bytes"), "and is replaced by an empty state");
        let foreign: String = (0..50).map(|i| format!("\"zz{i}\":{{\"count\":1}}")).collect::<Vec<_>>().join(",");
        std::fs::write(state_file(&d, "s1"), format!("{{\"kinds\":{{{foreign},\"s\":{{\"count\":1}}}}}}")).unwrap();
        stop_all(&d, std::slice::from_ref(&k), &[watcher_adv()]);
        let st = load(&d, "s1").unwrap();
        assert!(st.kinds.keys().all(|n| n == "s"), "keys that are no kind of the table do not survive: {:?}", st.kinds.keys().collect::<Vec<_>>());
    }
}
