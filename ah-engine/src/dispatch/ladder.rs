//! The nudge escalation ladder (GH #516): an advisory that keeps firing while nothing changes is re-emitted as a Stop block.
//!
//! Each nudge kind (`nudges.kinds`, the severity class table) lists the hooks whose advisories it counts. Per session and kind the
//! ladder counts at most one fire per turn (Stop to Stop); the kind's hooks running quiet `quiet_reset` times in a row is the
//! condition cleared, which resets the count (acted on). A due kind is held as pending and the next main-session Stop answers one
//! block naming the required next action: a `block` (P0) kind at its first fire, an `escalate` kind after `after` fires and every
//! `every` fires after that. A Stop with `stop_hook_active` never adds a ladder block, so an escalation cannot loop.
//!
//! The ladder is a state machine over ENTRIES. An entry is a kind (a session-wide fact: the open tasks) or, for a kind whose fact is a
//! signal on an agent (`live_flags`), a kind and the SUBJECT the reminder named (the agent id of the tracker's reminder row, read from
//! the queue lines the `agent-reminders` check took): a stall is counted for the agent that was reminded and cleared when that agent's
//! signal is gone, whatever any other agent does. An entry is in one [`Phase`]; `count` moves it on what a call showed (fired, quiet,
//! absent) and `at_stop` on a Stop (the turn boundary, a block, the guards' decisions, the facts of [`Live`]). The transition table is
//! the test `the_transition_table_holds_for_every_phase_and_event`; the invariants (a guard's pass is never overridden; an entry whose
//! fact is gone never blocks and is cleared; a fire is counted for the subject it named only) are checked over every event sequence
//! by `no_event_sequence_breaks_the_guard_pass_or_the_resolved_fact_invariant`.
//!
//! A guard's pass is absolute and is read from the GUARD'S OWN record, not from the ladder's history of it: a kind that declares a
//! `guard` (its hook, its switch, its state files) holds every ladder block at a Stop the guard's hook let pass when the guard's state
//! says it has blocked in this session. That holds with the guard's kind switched off, with the ladder enabled after the guard's cap was
//! reached, and with the ladder's own state lost; it lifts only when the guard's fact ends (its tasks are done) or the guard blocks
//! again. A guard record that cannot be read blocks nothing and is counted.
//! "Its tasks are done" is read from the list the guard reads (the task store first, else the transcript tail as the guard rebuilds it:
//! [`crate::checks::taskstate::store::session_has_open`]); a second reader of the open tasks could call them done while the guard still
//! sees them open, and lift the hold over the guard's cap.
//!
//! The ladder observes the hook results BEFORE the token cuts (`inject`, `digest`, `shrink`) blank repeated advisories, and its
//! block is appended after them. It fails open: no session, an unreadable or corrupt state file, a state write that fails, a fact
//! that cannot be read (the tracker state, the task list, a guard's record), a reminder it cannot attribute to an agent or a panic adds
//! nothing. Every class, threshold, list, path and text is in `engine/defaults/nudges.toml`.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - unreadable or corrupt ladder state is a fresh state (fail open); a value that does not parse is the absent value
// A failure that must be seen goes through `crate::discard` or `health::log_event` instead.

use super::combine::{self, HookResult};
use crate::agents::Delivered;
use crate::checks::git::util::Settings;
use crate::checks::guardkit::settings::{get_bool, read_object};
use crate::defaults::{self, V};
use crate::reqenv::RequestEnv;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
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

/// How a counted-block guard's own decision is read (`guard` of a kind row).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GuardSpec {
    /// The dispatch table id of the guard's hook: it ran at a Stop and did not block it.
    pub hook: String,
    /// The defaults key of the guard's own switch (a guard that is off permits nothing it did not block), "" for none.
    pub setting: String,
    /// The defaults keys naming the prefixes of the guard's per-session state files (`<prefix><session>` under the state dir).
    pub state: Vec<String>,
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
    /// The guard whose own record of its blocks decides whether a Stop it let pass may be blocked by any kind.
    pub guard: Option<GuardSpec>,
}

impl Kind {
    /// The kind's fact is a signal on an agent: its entries are kept per agent (the subject the reminder named).
    pub fn per_subject(&self) -> bool {
        !self.live_flags.is_empty()
    }
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
                guard: row
                    .get("guard")
                    .map(|g| GuardSpec { hook: g.str_field("hook").to_string(), setting: g.str_field("setting").to_string(), state: strings(g.get("state")) })
                    .filter(|g| !g.hook.is_empty()),
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
            // the line that carries the fact (the one holding a match phrase: which worker, how it stalled), else the first line (a digest header)
            let lines = || t.lines().map(str::trim).filter(|l| !l.is_empty());
            let first = lines().find(|l| k.matches.iter().any(|m| l.contains(m.as_str()))).or_else(|| lines().next()).unwrap_or("");
            let end = defaults::text("nudges.headline_end");
            let first = first.split_once(&*end).map_or(first, |(head, _)| head);
            let ascii: String = first.chars().filter(char::is_ascii).collect::<String>().trim().chars().take(max).collect();
            return Seen::Fired(ascii);
        }
    }
    Seen::Quiet
}

/// The settings of the per-subject entries (`nudges.subjects`).
fn subject_limit(key: &str) -> u64 {
    defaults::raw("nudges.subjects").get(key).and_then(V::as_integer).map_or(0, |n| n.max(0) as u64)
}

/// The key of a kind's entry in the state: the kind name, then `nudges.subjects.sep` and the subject when the kind is kept per agent.
fn entry_key(kind: &str, subject: &str) -> String {
    if subject.is_empty() { kind.to_string() } else { format!("{kind}{}{subject}", defaults::raw("nudges.subjects").str_field("sep")) }
}

/// The kind and the subject (empty: the kind's one session-wide entry) of an entry key.
fn split_key(key: &str) -> (&str, &str) {
    key.split_once(defaults::raw("nudges.subjects").str_field("sep")).unwrap_or((key, ""))
}

/// A subject as it is kept in an entry key: the agent id cut to `nudges.subjects.chars_max` characters, with the characters a file name
/// would not keep (and the key separator) replaced.
fn clean_subject(s: &str) -> String {
    s.chars().take(subject_limit("chars_max") as usize).map(|c| if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') { c } else { '_' }).collect()
}

/// The keys of the entries of `kind` in the state (its session-wide entry and its per-subject ones), in key order.
fn entry_keys(st: &State, kind: &str) -> Vec<String> {
    st.kinds.keys().filter(|key| split_key(key).0 == kind).cloned().collect()
}

/// One kind's ladder state for one entry (a kind, or a kind and the agent a reminder named) in one session.
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

/// Where an entry's [`Track`] stands (derived from it, so it adds no persisted state).
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

/// The phase of an entry (`None`: no entry).
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
/// at a Stop and lets it pass has decided (its cap, its dedupe, or its condition cleared) that the Stop may end. This is the
/// ladder's own history of a guard that declares no record of its own; a guard that declares one ([`Mark`]) is decided by it alone,
/// since the history is absent when the kind is off or the ladder was enabled late, and stale when the guard has been switched off.
fn guard_mark(t: &Track) -> bool {
    t.count > 0 || t.pending || t.shown > 0
}

/// What a guard's own state files say of its blocks in this session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mark {
    /// The guard never blocked here (no state, or its switch is off): its passing a Stop decides nothing.
    Never,
    /// The guard blocked in this session: its passing a Stop is its decision (its cap, its dedupe, its condition cleared).
    Blocked,
    /// A state file of the guard cannot be read: the ladder blocks nothing at a Stop the guard passed, and counts it.
    Unreadable,
}

/// What the ladder can check about a kind's fact at a Stop, read fresh at that Stop.
#[derive(Debug, Clone, Default)]
pub struct Live {
    /// The tracker signals up now, per agent id, on the session's agents (`None`: the tracker state cannot be read).
    pub flags: Option<BTreeMap<String, BTreeSet<String>>>,
    /// Whether the session has an open task (`None`: the task list cannot be read).
    pub open_tasks: Option<bool>,
    /// What the own state of each guard kind (by kind name) says of its blocks; a kind with no guard is not listed.
    pub guards: BTreeMap<String, Mark>,
}

/// An entry's fact at a Stop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fact {
    /// The kind declares no fact: nothing to check.
    Undeclared,
    /// The fact holds now.
    Holds,
    /// The fact is gone (the stall ended, the tasks are done): the entry is stale.
    Gone,
    /// The fact cannot be read: the entry blocks nothing until it can.
    Unknown,
}

impl Live {
    /// Everything holds (the tests that drive kinds by their hooks' messages alone): every flag up on the agent `w1`, a task open.
    #[cfg(test)]
    pub fn all_hold(kinds: &[Kind]) -> Live {
        Live {
            flags: Some(BTreeMap::from([("w1".to_string(), kinds.iter().flat_map(|k| k.live_flags.iter().cloned()).collect())])),
            open_tasks: Some(true),
            guards: BTreeMap::new(),
        }
    }

    /// The fact of the entry of `k` for `subject`. A per-agent entry (`subject` not empty) is held by that agent's own signals, never by
    /// any other agent's: an agent that is gone, finished, dead or no longer flagged ends it. The kind's session-wide entry is held by
    /// any of its signals on any agent, or by an open task.
    pub fn fact(&self, k: &Kind, subject: &str) -> Fact {
        if k.live_flags.is_empty() && !k.live_tasks {
            return Fact::Undeclared;
        }
        let raised = |signals: &BTreeSet<String>| k.live_flags.iter().any(|f| signals.contains(f));
        if !subject.is_empty() && k.per_subject() {
            return match &self.flags {
                None => Fact::Unknown,
                Some(by_agent) if by_agent.get(subject).is_some_and(raised) => Fact::Holds,
                Some(_) => Fact::Gone,
            };
        }
        let mut unknown = false;
        if k.per_subject() {
            match &self.flags {
                Some(by_agent) if by_agent.values().any(raised) => return Fact::Holds,
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
    /// Per entry (see [`entry_key`]).
    pub kinds: BTreeMap<String, Track>,
    /// Per reminder queue (the agent or session id that owns it): the line its cursor stood at when the ladder last attributed a
    /// delivery, so the next delivery's rows are exactly the lines after it. At most `nudges.subjects.queues_max` queues.
    pub queues: BTreeMap<String, u64>,
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

/// What one call showed of one entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Obs {
    /// The kind.
    pub kind: String,
    /// The agent a per-agent kind's reminder named (empty: the kind's session-wide entry).
    pub subject: String,
    /// What was seen.
    pub seen: Seen,
}

impl Obs {
    /// An observation of a kind's session-wide entry.
    pub fn of(kind: &str, seen: Seen) -> Obs {
        Obs { kind: kind.to_string(), subject: String::new(), seen }
    }
}

/// Count what one call showed. Returns the telemetry steps.
pub fn count(st: &mut State, kinds: &[Kind], seen: &[Obs]) -> Vec<Step> {
    let mut steps = Vec::new();
    for o in seen {
        let Some(k) = kinds.iter().find(|k| k.name == o.kind && k.class != Class::Off) else { continue };
        let name = &o.kind;
        let t = st.kinds.entry(entry_key(name, &o.subject)).or_default();
        match &o.seen {
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

/// What a Stop is: whether the ladder may add a block, which guards decided it, and the facts at that moment.
pub struct StopCtx<'a> {
    /// No `stop_hook_active`, no block of another hook on this Stop.
    pub may_block: bool,
    /// Guard kinds whose hooks ran at this very Stop, let it pass, and had blocked before (by the guard's own record, or the ladder's
    /// history of a guard that declares none).
    pub passed: &'a [String],
    /// Guard kinds whose hooks ran at this very Stop and let it pass, but whose own record cannot be read.
    pub unreadable: &'a [String],
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
    /// Entries that were due but whose fact (or whose guard's record) could not be read, so they blocked nothing.
    pub unverified: u64,
}

/// At a Stop: the block reason of the pending kinds that fit `nudges.max_chars`, and the turn boundary.
///
/// 1. An entry whose fact is gone (its agent's stall ended, its tasks are done) is stale: it is cleared (`acted` when it had counted)
///    and never blocks. This runs on every Stop, also on one that may not carry a block.
/// 2. A guard that ran at this Stop, let it pass and had blocked before (`passed`, minus the guards cleared in 1) decided the Stop
///    may end. Its cap is absolute: the ladder adds no block of any kind, and keeps every mark. Nothing but the guard's own fact
///    ending (1) or its next block lifts the hold; no count of passes does.
/// 3. An entry whose fact cannot be read, or whose guard's record cannot be read (`unreadable`), blocks nothing (it stays pending) and
///    is counted in `unverified`.
/// 4. Otherwise each kind with a pending `block`/`escalate` entry is answered in table order while the texts fit whole in
///    `nudges.max_chars` (one text per kind, however many agents it is pending for); a text that does not fit stays pending for the
///    next Stop.
pub fn at_stop(st: &mut State, kinds: &[Kind], cx: &StopCtx) -> StopOut {
    let mut out = StopOut::default();
    let mut gone: Vec<&str> = Vec::new();
    for k in kinds {
        let stale: Vec<String> = if k.per_subject() {
            entry_keys(st, &k.name).into_iter().filter(|key| cx.live.fact(k, split_key(key).1) == Fact::Gone).collect()
        } else if cx.live.fact(k, "") == Fact::Gone {
            gone.push(&k.name);
            vec![k.name.clone()]
        } else {
            Vec::new()
        };
        for key in stale {
            if let Some(t) = st.kinds.remove(&key)
                && t.count > 0
            {
                out.steps.push((k.name.clone(), "acted", false));
            }
        }
    }
    let live_guard = |g: &String| !gone.contains(&g.as_str());
    let held = cx.may_block && cx.passed.iter().any(live_guard);
    let held_unreadable = cx.may_block && !held && cx.unreadable.iter().any(live_guard);
    let max = defaults::num("nudges.max_chars") as usize;
    let joiner = defaults::text("dispatch.reason_joiner");
    let mut reason = String::new();
    for k in kinds {
        let mut ready: Vec<String> = Vec::new();
        for key in entry_keys(st, &k.name) {
            let Some(t) = st.kinds.get_mut(&key) else { continue };
            if cx.may_block && !held && t.pending && matches!(k.class, Class::Block | Class::Escalate) {
                if held_unreadable || cx.live.fact(k, split_key(&key).1) == Fact::Unknown {
                    out.unverified += 1;
                } else {
                    ready.push(key.clone());
                }
            }
            t.this_turn = false;
        }
        let count = ready.iter().filter_map(|key| st.kinds.get(key)).map(|t| t.count).max().unwrap_or(0);
        let headline = ready.first().and_then(|key| st.kinds.get(key)).map(|t| t.headline.clone()).unwrap_or_default();
        if ready.is_empty() {
            continue;
        }
        let key = if k.class == Class::Block { "nudges.msg_first_fire" } else { "nudges.msg_escalated" };
        let render = |detail: &str| defaults::render(key, &[("action", &k.action), ("detail", &detail), ("n", &count)]);
        let detail = if headline.is_empty() { String::new() } else { defaults::render("nudges.msg_detail", &[("text", &headline)]) };
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
        for key in ready {
            if let Some(t) = st.kinds.get_mut(&key) {
                t.pending = false;
                t.shown += 1;
            }
            out.steps.push((k.name.clone(), if k.class == Class::Block { "blocked" } else { "escalated" }, true));
        }
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
    /// Due entries whose fact (or whose guard's record) could not be read (they blocked nothing).
    pub unverified: u64,
    /// Fires of a per-agent kind that could not be attributed to an agent (the reminder queue cannot be read, or it names no agent
    /// of the kind) or that exceeded `nudges.subjects.per_kind_max` agents: they were not counted.
    pub unattributed: u64,
}

/// The reminders the `agent-reminders` check took from the queue of `key` since line `prev` (or the last few, with no `prev`) and the
/// line its cursor stands at: `(cursor, rows)`. `None`: it cannot be read.
pub type Tail<'a> = &'a dyn Fn(&str, Option<u64>) -> Option<(u64, Vec<Delivered>)>;

/// The queue the call's reminders came through: the agent's own (`agent_id`) or the session's (`agent-reminders` keys it so).
fn queue_key(p: &Value) -> Option<String> {
    let f = defaults::raw("agent_reminders.fields");
    [f.str_field("agent"), f.str_field("session")].into_iter().find_map(|k| p.get(k).and_then(Value::as_str).filter(|s| !s.is_empty())).map(str::to_string)
}

/// The agents each per-agent kind that fired in this call was fired about: the `agent` of the queue rows the check took since the
/// ladder last looked, whose signal is one of the kind's and whose text is one the kind matches (the filter `observe` applies). Moves
/// the queue's mark forward. A kind that fired about no agent it can name is counted in `unattributed`, never counted as a fire.
fn attribute(st: &mut State, p: &Value, seen: &[(&Kind, Seen)], tail: Tail, out: &mut Pass) -> BTreeMap<String, Vec<String>> {
    let fired: Vec<&Kind> = seen.iter().filter(|(k, s)| k.per_subject() && matches!(s, Seen::Fired(_))).map(|(k, _)| *k).collect();
    let mut who: BTreeMap<String, Vec<String>> = BTreeMap::new();
    if fired.is_empty() {
        return who;
    }
    let Some(key) = queue_key(p) else {
        out.unattributed += fired.len() as u64;
        return who;
    };
    let Some((cursor, rows)) = tail(&key, st.queues.get(&key).copied()) else {
        out.unattributed += fired.len() as u64;
        return who;
    };
    if !st.queues.contains_key(&key) && st.queues.len() as u64 >= subject_limit("queues_max") {
        st.queues.pop_first();
    }
    st.queues.insert(key, cursor);
    for k in fired {
        let mut agents: Vec<String> = Vec::new();
        for r in rows.iter().filter(|r| k.live_flags.contains(&r.signal) && (k.matches.is_empty() || k.matches.iter().any(|m| r.text.contains(m.as_str())))) {
            let subject = clean_subject(&r.agent);
            if !subject.is_empty() && !agents.contains(&subject) {
                agents.push(subject);
            }
        }
        if agents.is_empty() {
            out.unattributed += 1;
        }
        let known = entry_keys(st, &k.name).len() as u64;
        let room = subject_limit("per_kind_max").saturating_sub(known);
        let (mut fresh, mut kept) = (0u64, Vec::new());
        for a in agents {
            if st.kinds.contains_key(&entry_key(&k.name, &a)) {
                kept.push(a);
            } else if fresh < room {
                fresh += 1;
                kept.push(a);
            } else {
                out.unattributed += 1;
            }
        }
        who.insert(k.name.clone(), kept);
    }
    who
}

/// One ladder pass over `results` on the in-memory state: count what the call showed, then, at a block event, answer the Stop.
pub fn pass(st: &mut State, event: &str, p: &Value, kinds: &[Kind], results: &[HookResult], live: &Live, tail: Tail) -> Pass {
    // the counted-block guards WITHOUT a declared record that had blocked before this call (the ladder's own history of them): read
    // before `count`, which may reset their entry on a quiet run. A guard that declares its record is decided by that record alone.
    let marked: Vec<String> =
        kinds.iter().filter(|k| k.count_blocks && k.guard.is_none() && st.kinds.get(&k.name).is_some_and(guard_mark)).map(|k| k.name.clone()).collect();
    let seen: Vec<(&Kind, Seen)> = kinds.iter().map(|k| (k, observe(k, results))).collect();
    let mut out = Pass::default();
    let who = attribute(st, p, &seen, tail, &mut out);
    let mut obs: Vec<Obs> = Vec::new();
    for (k, s) in &seen {
        if !k.per_subject() {
            obs.push(Obs::of(&k.name, s.clone()));
            continue;
        }
        match s {
            Seen::Fired(_) => obs.extend(who.get(&k.name).into_iter().flatten().map(|a| Obs { kind: k.name.clone(), subject: a.clone(), seen: s.clone() })),
            Seen::Quiet => {
                obs.extend(entry_keys(st, &k.name).iter().map(|key| Obs { kind: k.name.clone(), subject: split_key(key).1.to_string(), seen: Seen::Quiet }))
            }
            Seen::Absent => {}
        }
    }
    out.steps = count(st, kinds, &obs);
    if defaults::list("nudges.block_events").contains(&event) {
        let active = p.get("stop_hook_active").and_then(Value::as_bool) == Some(true);
        // a Stop another hook already blocks carries that block; the ladder's waits for the next Stop (no stacked blocks)
        let blocked = results.iter().any(combine::blocks);
        // a guard that ran at this Stop and let it pass (its own cap, its dedupe, or the condition cleared) is not contradicted: it
        // had blocked before by its own record (a guard that declares one), or by the ladder's history of it (one that does not)
        let ran_and_passed = |k: &Kind| k.guard.as_ref().is_some_and(|g| results.iter().any(|r| r.id == g.hook && r.code == Some(0) && !combine::blocks(r)));
        let mut passed: Vec<String> = seen.iter().filter(|(k, s)| *s == Seen::Quiet && marked.contains(&k.name)).map(|(k, _)| k.name.clone()).collect();
        let mut unreadable: Vec<String> = Vec::new();
        for k in kinds.iter().filter(|k| ran_and_passed(k)) {
            match live.guards.get(&k.name) {
                Some(Mark::Blocked) if !passed.contains(&k.name) => passed.push(k.name.clone()),
                Some(Mark::Unreadable) => unreadable.push(k.name.clone()),
                _ => {}
            }
        }
        let stop = at_stop(st, kinds, &StopCtx { may_block: !active && !blocked, passed: &passed, unreadable: &unreadable, live });
        out.reason = stop.reason;
        out.unverified = stop.unverified;
        out.steps.extend(stop.steps);
    }
    out
}

/// One whole ladder pass over `results` with the state under `dir`, the facts `live` and the reminder queues read by `tail`: the block
/// to add, if any.
pub fn run_with(dir: &Path, event: &str, p: &Value, kinds: &[Kind], results: &[HookResult], live: &Live, tail: Tail) -> Option<HookResult> {
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
    // a key that is no entry of the table (a hand-edited or stale file) is dropped, and so is the session-wide entry of a kind that is
    // now kept per agent (the state of before: it names no agent, so its fact cannot be checked)
    st.kinds.retain(|key, _| {
        let (name, subject) = split_key(key);
        kinds.iter().any(|k| k.name == name && k.per_subject() != subject.is_empty())
    });
    let out = pass(&mut st, event, p, kinds, results, live, tail);
    for _ in 0..out.unverified {
        state_error("facts");
    }
    for _ in 0..out.unattributed {
        state_error("subject");
    }
    if !save(dir, &key, &st) {
        state_error("write");
        return None; // a block whose shown mark cannot be kept would repeat: fail open
    }
    emit(&out.steps);
    let body = serde_json::json!({ "decision": "block", "reason": out.reason? }).to_string();
    Some(HookResult { id: defaults::text("nudges.hook_id").to_string(), code: Some(0), out: body, err: String::new() })
}

/// [`run_with`] with every fact holding and every delivery naming the agent `w1`, in the words each kind matches (the tests that drive
/// the kinds by their hooks' messages; the attribution from real queue lines is tested through the real hook).
#[cfg(test)]
pub fn run_in(dir: &Path, event: &str, p: &Value, kinds: &[Kind], results: &[HookResult]) -> Option<HookResult> {
    let rows = |_: &str, _: Option<u64>| {
        let text = |k: &Kind| k.matches.first().cloned().unwrap_or_default();
        Some((0, kinds.iter().flat_map(|k| k.live_flags.iter().map(move |f| Delivered { agent: "w1".into(), signal: f.clone(), text: text(k) })).collect()))
    };
    run_with(dir, event, p, kinds, results, &Live::all_hold(kinds), &rows)
}

/// Whether the ladder is on (`nudges.enabled`, default off).
pub fn enabled(env: &RequestEnv) -> bool {
    get_bool(&Settings::from_env(env), defaults::raw("nudges.sw_enabled"))
}

/// Whether the session has an open task, in the list the task guards read ([`crate::checks::taskstate::store::session_has_open`]: the
/// task store first, then the transcript tail as task-guard reconstructs it). A fact read from another list than the guard's would
/// call open tasks done (or the reverse) and lift, or keep, a hold the guard's own cap decided.
fn open_tasks(st: &Settings, p: &Value) -> Option<bool> {
    let field = |k: &str| p.get(k).and_then(Value::as_str);
    crate::checks::taskstate::store::session_has_open(&st.home, field("session_id"), field("transcript_path"))
}

/// Whether `v` holds the counter `field` above zero, in itself or in a nested object up to `depth` levels down.
fn has_blocks(v: &Value, field: &str, depth: u64) -> bool {
    v.as_object().is_some_and(|m| m.iter().any(|(k, x)| (k == field && x.as_f64().is_some_and(|n| n > 0.0)) || (depth > 0 && has_blocks(x, field, depth - 1))))
}

/// What the guard's own state files say of its blocks in `session`: [`Mark::Blocked`] when any of them counts a block,
/// [`Mark::Unreadable`] when one cannot be read (over `nudges.guard_state.max_bytes`, not JSON) and none counts one, else
/// [`Mark::Never`]. A guard whose switch is off, and a file that is absent or blank, say it never blocked. Read only: the guard's own
/// files are never written.
fn guard_mark_of(st: &Settings, session: &str, g: &GuardSpec) -> Mark {
    if !g.setting.is_empty() && !get_bool(st, defaults::raw(&g.setting)) {
        return Mark::Never;
    }
    let cfg = defaults::raw("nudges.guard_state");
    let (max, depth, field) = (
        cfg.get("max_bytes").and_then(V::as_integer).map_or(0, |n| n.max(0) as u64),
        cfg.get("depth").and_then(V::as_integer).map_or(0, |n| n.max(0) as u64),
        cfg.str_field("blocks_field"),
    );
    let mut unreadable = false;
    for prefix in &g.state {
        let name = format!("{}{}", defaults::text(prefix), crate::checks::taskstate::unknown::safe_key(session));
        let path = Path::new(&st.home).join(defaults::text("paths.base_dir")).join(name);
        let text = match std::fs::metadata(&path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Ok(m) if m.len() <= max => std::fs::read_to_string(&path).ok(),
            _ => None,
        };
        match text.as_deref().map(str::trim) {
            None => unreadable = true,
            Some("") => {}
            Some(t) => match serde_json::from_str::<Value>(t) {
                Ok(v) if has_blocks(&v, field, depth) => return Mark::Blocked,
                Ok(_) => {}
                Err(_) => unreadable = true,
            },
        }
    }
    if unreadable { Mark::Unreadable } else { Mark::Never }
}

/// The facts of this Stop, read only when some kind declares one.
fn live_facts(st: &Settings, p: &Value, kinds: &[Kind]) -> Live {
    let Some(session) = p.get("session_id").and_then(Value::as_str) else { return Live::default() };
    let transcript = p.get("transcript_path").and_then(Value::as_str).unwrap_or("");
    let any = |f: &dyn Fn(&Kind) -> bool| kinds.iter().any(f);
    Live {
        flags: if any(&|k| k.per_subject()) { crate::agents::live_flags(Path::new(&st.home), session, transcript) } else { None },
        open_tasks: if any(&|k| k.live_tasks) { open_tasks(st, p) } else { None },
        guards: kinds.iter().filter_map(|k| k.guard.as_ref().map(|g| (k.name.clone(), guard_mark_of(st, session, g)))).collect(),
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
        let (first, most, bytes) = (subject_limit("first_rows"), subject_limit("rows_max"), subject_limit("queue_max_bytes"));
        let tail = |key: &str, prev: Option<u64>| crate::agents::delivered_since(Path::new(&st.home), key, prev, first, most, bytes);
        run_with(&dir, event, p, &kinds, results, &live, &tail)
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
            guard: None,
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
        let steps = count(&mut st, std::slice::from_ref(&k), &[Obs::of("k", Seen::Quiet)]);
        assert!(steps.is_empty(), "one quiet run is not enough");
        let steps = count(&mut st, std::slice::from_ref(&k), &[Obs::of("k", Seen::Quiet)]);
        assert_eq!(steps, vec![("k".to_string(), "acted", false)]);
        assert!(!st.kinds.contains_key("k"), "count reset");
        let absent = count(&mut st, std::slice::from_ref(&k), &[Obs::of("k", Seen::Absent)]);
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

    // ---- the ladder as a state machine over entries (class fix): a guard's pass is absolute; a resolved fact clears its entry ----

    const WATCH: &str = "watch action";

    /// The stall kind: kept per agent (its fact is the `stalled` signal on the agent a reminder named), due at its first fire.
    fn watcher_live() -> Kind {
        let mut s = watcher_kind();
        s.live_flags = vec!["stalled".into()];
        s.action = WATCH.into();
        s
    }
    /// A guard kind whose own record says whether it blocked (hook `g`), with the open tasks as its fact.
    fn tasks_guard() -> Kind {
        let mut g = guard_kind();
        g.live_tasks = true;
        g.action = "guard action".into();
        g.guard = Some(GuardSpec { hook: "g".into(), setting: String::new(), state: vec![] });
        g
    }
    /// The facts: the signals `flags` up on the agent `w1` only, `tasks` open or not, and what the guard's own record says.
    fn up(flags: &[&str], tasks: Option<bool>) -> Live {
        up_by(&[("w1", flags)], tasks)
    }
    fn up_by(by_agent: &[(&str, &[&str])], tasks: Option<bool>) -> Live {
        let m = by_agent.iter().filter(|(_, f)| !f.is_empty()).map(|(a, f)| (a.to_string(), f.iter().map(|x| x.to_string()).collect())).collect();
        Live { flags: Some(m), open_tasks: tasks, guards: BTreeMap::new() }
    }
    fn marked(mut live: Live, kind: &str, m: Mark) -> Live {
        live.guards.insert(kind.to_string(), m);
        live
    }
    /// What `agent-reminders` took from the queue: these (agent, signal) rows, whatever the previous look.
    fn rows_of(rows: &[(&str, &str)]) -> impl Fn(&str, Option<u64>) -> Option<(u64, Vec<Delivered>)> + use<> {
        let rows: Vec<Delivered> = rows.iter().map(|(a, s)| Delivered { agent: a.to_string(), signal: s.to_string(), text: String::new() }).collect();
        move |_, _| Some((rows.len() as u64, rows.clone()))
    }
    fn no_queue(_: &str, _: Option<u64>) -> Option<(u64, Vec<Delivered>)> {
        None
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
    fn stop_all_live(dir: &Path, ks: &[Kind], r: &[HookResult], live: &Live) -> Option<HookResult> {
        run_with(dir, "Stop", &json!({"session_id": "s1"}), ks, r, live, &rows_of(&[("w1", "stalled")]))
    }

    #[test]
    fn the_transition_table_holds_for_every_phase_and_event() {
        #[derive(Clone, Copy, Debug)]
        enum Ev {
            Fire,
            FireSameTurn,
            FireNamesNoAgent,
            FireNoQueue,
            Quiet,
            Absent,
            StopFree,
            StopActive,
            StopOtherBlock,
            StopGone,
            StopUnknown,
        }
        let mut k = kind(Class::Escalate, 2);
        k.after = 2;
        k.live_flags = vec!["stalled".into()];
        let ks = [k];
        let other_block = HookResult { id: "other".into(), code: Some(0), out: json!({"decision": "block", "reason": "r"}).to_string(), err: String::new() };
        // (start entry k|w1, event, phase after, steps, blocked, unverified, unattributed)
        #[rustfmt::skip]
        #[allow(clippy::type_complexity)]
        let rows: Vec<(Option<Track>, Ev, Phase, Vec<&str>, bool, u64, u64)> = vec![
            (None,                         Ev::Fire,             Phase::Counting, vec!["fired"],                false, 0, 0),
            (Some(track(1, false, 0, 0)),  Ev::Fire,             Phase::Pending,  vec!["repeated"],             false, 0, 0),
            (Some(track(1, false, 0, 0)),  Ev::FireSameTurn,     Phase::Counting, vec![],                       false, 0, 0),
            (Some(track(2, true, 0, 0)),   Ev::Fire,             Phase::Pending,  vec!["repeated"],             false, 0, 0),
            (Some(track(2, false, 1, 0)),  Ev::Fire,             Phase::Shown,    vec!["repeated", "ignored"],  false, 0, 0),
            (Some(track(3, false, 1, 0)),  Ev::Fire,             Phase::Pending,  vec!["repeated", "ignored"],  false, 0, 0),
            (None,                         Ev::FireNamesNoAgent, Phase::Idle,     vec![],                       false, 0, 1),
            (Some(track(1, false, 0, 0)),  Ev::FireNamesNoAgent, Phase::Counting, vec![],                       false, 0, 1),
            (None,                         Ev::FireNoQueue,      Phase::Idle,     vec![],                       false, 0, 1),
            (Some(track(2, true, 0, 0)),   Ev::FireNoQueue,      Phase::Pending,  vec![],                       false, 0, 1),
            (Some(track(1, false, 0, 0)),  Ev::Quiet,            Phase::Counting, vec![],                       false, 0, 0),
            (Some(track(1, false, 0, 1)),  Ev::Quiet,            Phase::Idle,     vec!["acted"],                false, 0, 0),
            (Some(track(2, true, 0, 1)),   Ev::Quiet,            Phase::Idle,     vec!["acted"],                false, 0, 0),
            (Some(track(2, false, 1, 1)),  Ev::Quiet,            Phase::Idle,     vec!["acted"],                false, 0, 0),
            (Some(track(1, false, 0, 0)),  Ev::Absent,           Phase::Counting, vec![],                       false, 0, 0),
            (Some(track(2, true, 0, 0)),   Ev::Absent,           Phase::Pending,  vec![],                       false, 0, 0),
            (None,                         Ev::Absent,           Phase::Idle,     vec![],                       false, 0, 0),
            (Some(track(2, true, 0, 0)),   Ev::StopFree,         Phase::Shown,    vec!["escalated"],            true,  0, 0),
            (Some(track(1, false, 0, 0)),  Ev::StopFree,         Phase::Counting, vec![],                       false, 0, 0),
            (Some(track(2, false, 1, 0)),  Ev::StopFree,         Phase::Shown,    vec![],                       false, 0, 0),
            (Some(track(2, true, 0, 0)),   Ev::StopActive,       Phase::Pending,  vec![],                       false, 0, 0),
            (Some(track(2, true, 0, 0)),   Ev::StopOtherBlock,   Phase::Pending,  vec![],                       false, 0, 0),
            (Some(track(2, true, 0, 0)),   Ev::StopGone,         Phase::Idle,     vec!["acted"],                false, 0, 0),
            (Some(track(1, false, 0, 0)),  Ev::StopGone,         Phase::Idle,     vec!["acted"],                false, 0, 0),
            (Some(track(2, false, 1, 0)),  Ev::StopGone,         Phase::Idle,     vec!["acted"],                false, 0, 0),
            (None,                         Ev::StopGone,         Phase::Idle,     vec![],                       false, 0, 0),
            (Some(track(2, true, 0, 0)),   Ev::StopUnknown,      Phase::Pending,  vec![],                       false, 1, 0),
            (Some(track(1, false, 0, 0)),  Ev::StopUnknown,      Phase::Counting, vec![],                       false, 0, 0),
        ];
        for (i, (start, ev, want_phase, want_steps, want_block, want_unverified, want_unattributed)) in rows.into_iter().enumerate() {
            let mut st = State::default();
            if let Some(t) = start {
                let mut t = t;
                t.this_turn = matches!(ev, Ev::FireSameTurn);
                st.kinds.insert("k|w1".into(), t);
            }
            let stalled = rows_of(&[("w1", "stalled")]);
            let nameless = rows_of(&[("", "stalled")]);
            let (event, results, active, live, tail): (&str, Vec<HookResult>, bool, Live, Tail) = match ev {
                Ev::Fire | Ev::FireSameTurn => ("PostToolUse", adv("stalled agent w1"), false, up(&["stalled"], None), &stalled),
                Ev::FireNamesNoAgent => ("PostToolUse", adv("stalled agent w1"), false, up(&["stalled"], None), &nameless),
                Ev::FireNoQueue => ("PostToolUse", adv("stalled agent w1"), false, up(&["stalled"], None), &no_queue),
                Ev::Quiet => ("PostToolUse", quiet(), false, up(&["stalled"], None), &stalled),
                Ev::Absent => ("PostToolUse", vec![], false, up(&["stalled"], None), &stalled),
                Ev::StopFree => ("Stop", vec![], false, up(&["stalled"], None), &stalled),
                Ev::StopActive => ("Stop", vec![], true, up(&["stalled"], None), &stalled),
                Ev::StopOtherBlock => ("Stop", vec![other_block.clone()], false, up(&["stalled"], None), &stalled),
                Ev::StopGone => ("Stop", vec![], false, up(&[], None), &stalled),
                Ev::StopUnknown => ("Stop", vec![], false, Live::default(), &stalled),
            };
            let out = pass(&mut st, event, &p_stop(active), &ks, &results, &live, tail);
            let ctx = format!("row {i}: {ev:?}");
            assert_eq!(phase(st.kinds.get("k|w1")), want_phase, "{ctx}: phase");
            assert_eq!(words(&out), want_steps, "{ctx}: steps");
            assert_eq!(out.reason.is_some(), want_block, "{ctx}: blocked");
            assert_eq!(out.unverified, want_unverified, "{ctx}: unverified");
            assert_eq!(out.unattributed, want_unattributed, "{ctx}: unattributed");
            assert!(st.kinds.keys().all(|key| key == "k|w1"), "{ctx}: no entry but the agent's own: {:?}", st.kinds.keys().collect::<Vec<_>>());
        }
    }

    #[test]
    fn the_guard_transitions_decide_who_may_block_a_stop() {
        // g: the guard (Block, tasks fact, its hook `g`), s: the stall kind with a due block for the agent w1
        let quiet_g = vec![HookResult::quiet("g")];
        let crashed = vec![HookResult { id: "g".into(), code: Some(1), out: String::new(), err: "boom".into() }];
        let s_due = track(1, true, 0, 0);
        struct Row {
            name: &'static str,
            history: Option<Track>,
            class: Class,
            results: Vec<HookResult>,
            mark: Mark,
            tasks: Option<bool>,
            watch: bool,
            guard: bool,
            unverified: u64,
        }
        let row = |name, history, class, results: &Vec<HookResult>, mark, tasks, watch, guard, unverified| Row {
            name,
            history,
            class,
            results: results.clone(),
            mark,
            tasks,
            watch,
            guard,
            unverified,
        };
        #[rustfmt::skip]
        let rows: Vec<Row> = vec![
            row("a guard that never blocked holds nothing", None, Class::Block, &quiet_g, Mark::Never, Some(true), true, false, 0),
            row("its own record of a block holds, with no ladder history at all (the ladder was enabled late)", None, Class::Block, &quiet_g, Mark::Blocked, Some(true), false, false, 0),
            row("its own record holds with the guard's kind switched off", None, Class::Off, &quiet_g, Mark::Blocked, Some(true), false, false, 0),
            row("its own record holds when the ladder's history was lost", Some(Track::default()), Class::Block, &quiet_g, Mark::Blocked, Some(true), false, false, 0),
            row("the ladder's history does not outvote a declared record that says it never blocked", Some(track(1, true, 0, 0)), Class::Block, &quiet_g, Mark::Never, Some(true), true, true, 0),
            row("tasks done lift the hold and clear the guard", Some(track(1, true, 0, 0)), Class::Block, &quiet_g, Mark::Blocked, Some(false), true, false, 0),
            row("tasks done lift the hold of the guard's own record alone", None, Class::Off, &quiet_g, Mark::Blocked, Some(false), true, false, 0),
            row("unreadable tasks keep the hold", Some(track(1, true, 0, 0)), Class::Block, &quiet_g, Mark::Blocked, None, false, false, 0),
            row("a guard that did not run decides nothing", Some(track(1, true, 0, 0)), Class::Block, &vec![], Mark::Blocked, Some(true), true, true, 0),
            row("a guard that blocks carries the Stop itself", Some(track(1, true, 0, 0)), Class::Block, &vec![guard_block()], Mark::Blocked, Some(true), false, false, 0),
            row("a guard that crashed decided nothing", None, Class::Block, &crashed, Mark::Blocked, Some(true), true, false, 0),
            row("a record that cannot be read holds, counted", None, Class::Block, &quiet_g, Mark::Unreadable, Some(true), false, false, 1),
            row("an unreadable record of a guard that did not run decides nothing", None, Class::Block, &vec![], Mark::Unreadable, Some(true), true, false, 0),
            row("an unreadable record with the tasks done decides nothing", None, Class::Off, &quiet_g, Mark::Unreadable, Some(false), true, false, 0),
        ];
        for r in rows {
            let mut g = tasks_guard();
            g.class = r.class;
            let ks = [g, watcher_live()];
            let mut st = State::default();
            st.kinds.insert("s|w1".into(), s_due.clone());
            if let Some(h) = r.history.clone() {
                st.kinds.insert("g".into(), h);
            }
            let live = marked(up(&["stalled"], r.tasks), "g", r.mark);
            let tail = rows_of(&[]);
            let out = pass(&mut st, "Stop", &p_stop(false), &ks, &r.results, &live, &tail);
            let reason = out.reason.clone().unwrap_or_default();
            assert_eq!(reason.contains(WATCH), r.watch, "{}: the stall block ({reason:?})", r.name);
            assert_eq!(reason.contains("guard action"), r.guard, "{}: the guard's own block ({reason:?})", r.name);
            assert_eq!(out.unverified, r.unverified, "{}: unverified", r.name);
            if r.tasks == Some(false) {
                assert!(!st.kinds.contains_key("g"), "{}: the guard's entry is cleared", r.name);
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
    fn a_guards_own_record_holds_for_any_number_of_stops_without_any_ladder_history() {
        let d = tmp("own-record");
        let mut off = tasks_guard();
        off.class = Class::Off; // the guard's kind is switched off: the ladder keeps no history of it
        let ks = [off, watcher_live()];
        let live = marked(up(&["stalled"], Some(true)), "g", Mark::Blocked);
        let rows = rows_of(&[("w1", "stalled")]);
        let stop = |results: &[HookResult], live: &Live| run_with(&d, "Stop", &json!({"session_id": "s1"}), &ks, results, live, &rows);
        for n in 1..=40 {
            assert!(stop(&[HookResult::quiet("g"), watcher_adv()], &live).is_none(), "permitted Stop {n}");
        }
        let st = load(&d, "s1").unwrap();
        assert!(!st.kinds.contains_key("g") && st.kinds["s|w1"].pending, "no history of the guard, the stall is owed: {st:?}");
        let done = marked(up(&["stalled"], Some(false)), "g", Mark::Blocked);
        assert!(stop(&[HookResult::quiet("g"), watcher_adv()], &done).is_some(), "positive control: the tasks are done, the hold ends");
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
        let rows = rows_of(&[("w1", "stalled")]);
        let run = |p: &Value, r: &[HookResult], live: &Live| run_with(&d, "Stop", p, &ks, r, live, &rows);
        assert!(run(&active, &[watcher_adv()], &up(&["stalled"], None)).is_none());
        assert!(load(&d, "s1").unwrap().kinds["s|w1"].pending, "due and owed");
        assert!(stop_all_live(&d, &ks, &[], &up(&[], None)).is_none(), "the stall ended: nothing to block");
        assert!(load(&d, "s1").unwrap().kinds.is_empty(), "and the entry is gone");
        // the same Stop that may not carry a block clears it too
        assert!(run(&active, &[watcher_adv()], &up(&["stalled"], None)).is_none());
        assert!(run(&active, &[], &up(&[], None)).is_none());
        assert!(load(&d, "s1").unwrap().kinds.is_empty(), "cleared on a Stop that carries no block");
        // a stall that fires again starts counting from one
        assert!(run(&active, &[watcher_adv()], &up(&["stalled"], None)).is_none());
        assert_eq!(load(&d, "s1").unwrap().kinds["s|w1"].count, 1);
    }

    #[test]
    fn a_fact_that_cannot_be_read_blocks_nothing_is_counted_and_stays_owed() {
        let d = tmp("unknown");
        let ks = [watcher_live()];
        let active = json!({"session_id": "s1", "stop_hook_active": true});
        assert!(run_with(&d, "Stop", &active, &ks, &[watcher_adv()], &up(&["stalled"], None), &rows_of(&[("w1", "stalled")])).is_none());
        let bumped = || crate::metrics::bumped_on_this_thread("nudge_ladder_state_error", &[("op", "facts")]);
        assert!(stop_all_live(&d, &ks, &[], &Live::default()).is_none(), "an unverifiable stall is no block");
        assert_eq!(bumped(), 1, "and is counted");
        assert!(load(&d, "s1").unwrap().kinds["s|w1"].pending, "still owed");
        assert!(stop_all_live(&d, &ks, &[], &up(&["stalled"], None)).is_some(), "shown once the fact can be read and holds");
    }

    #[test]
    fn the_guards_own_fact_ending_lifts_its_hold_and_an_unreadable_fact_keeps_it() {
        let d = tmp("tasks-fact");
        let ks = [tasks_guard(), watcher_live()];
        let f = |tasks| marked(up(&["stalled"], tasks), "g", Mark::Blocked);
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
        assert_eq!(none.fact(&plain, ""), Fact::Undeclared);
        assert_eq!(up(&["a"], None).fact(&flags, ""), Fact::Holds, "any listed signal up");
        assert_eq!(up(&["b"], None).fact(&flags, ""), Fact::Holds);
        assert_eq!(up(&["c"], None).fact(&flags, ""), Fact::Gone);
        assert_eq!(none.fact(&flags, ""), Fact::Unknown);
        assert_eq!(up(&[], Some(true)).fact(&tasks, ""), Fact::Holds);
        assert_eq!(up(&[], Some(false)).fact(&tasks, ""), Fact::Gone);
        assert_eq!(up(&[], None).fact(&tasks, ""), Fact::Unknown);
        assert_eq!(up(&["c"], Some(true)).fact(&both, ""), Fact::Holds, "either source holding is enough");
        assert_eq!(up(&["c"], Some(false)).fact(&both, ""), Fact::Gone);
        assert_eq!(up(&["c"], None).fact(&both, ""), Fact::Unknown, "gone on one source and unreadable on the other cannot be called gone");
        assert_eq!(up(&["a"], None).fact(&both, ""), Fact::Holds, "holding on one source settles it");
    }

    #[test]
    fn a_per_agent_fact_is_that_agents_own_signal_and_no_other_agents() {
        let mut k = kind(Class::Escalate, 0);
        k.live_flags = vec!["stalled".into(), "hung".into()];
        let live = up_by(&[("w1", &["underparallel"]), ("w2", &["stalled"]), ("w3", &["hung", "x"])], None);
        assert_eq!(live.fact(&k, "w1"), Fact::Gone, "w1 raises none of the kind's signals, however many others do");
        assert_eq!(live.fact(&k, "w2"), Fact::Holds);
        assert_eq!(live.fact(&k, "w3"), Fact::Holds, "any of the kind's signals on that agent");
        assert_eq!(live.fact(&k, "w4"), Fact::Gone, "an agent that is gone, finished or dead is not listed at all");
        assert_eq!(Live::default().fact(&k, "w2"), Fact::Unknown, "tracker state that cannot be read says nothing");
        let mut with_tasks = k.clone();
        with_tasks.live_tasks = true;
        assert_eq!(up_by(&[("w2", &["stalled"])], Some(true)).fact(&with_tasks, "w1"), Fact::Gone, "an agent's entry never borrows the open tasks' fact");
    }

    #[test]
    fn a_state_file_from_before_the_hold_counter_was_removed_still_loads() {
        let d = tmp("legacy");
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(state_file(&d, "s1"), r#"{"kinds":{"s":{"count":2,"pending":true,"held":5,"headline":"x"}}}"#).unwrap();
        let st = load(&d, "s1").expect("an older state file is valid state");
        assert!(st.kinds["s"].pending && st.kinds["s"].count == 2);
        assert!(st.queues.is_empty(), "and has no queue marks yet");
    }

    #[test]
    fn a_session_wide_entry_of_a_kind_now_kept_per_agent_is_dropped_not_blocked() {
        let d = tmp("legacy-subject");
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(state_file(&d, "s1"), r#"{"kinds":{"s":{"count":2,"pending":true,"headline":"x"},"g":{"count":1}}}"#).unwrap();
        let ks = [tasks_guard(), watcher_live()];
        assert!(stop_all_live(&d, &ks, &[], &up(&["stalled"], Some(true))).is_none(), "the old entry names no agent: nothing to verify, nothing to block");
        let st = load(&d, "s1").unwrap();
        assert!(!st.kinds.contains_key("s") && st.kinds.contains_key("g"), "{st:?}");
    }

    // ---- per-agent entries: a fire counts for the agent it named, an entry lives while that agent's signal does ----

    fn kind_s2() -> Kind {
        let mut s = watcher_live();
        s.after = 2;
        s.every = 2;
        s
    }
    fn fire(st: &mut State, ks: &[Kind], rows: &[(&str, &str)], live: &Live) -> Pass {
        pass(st, "PostToolUse", &p_stop(false), ks, &[watcher_adv()], live, &rows_of(rows))
    }
    fn at(st: &mut State, ks: &[Kind], live: &Live) -> Pass {
        pass(st, "Stop", &p_stop(false), ks, &[], live, &rows_of(&[]))
    }
    fn entries(st: &State) -> Vec<(String, u64, bool)> {
        st.kinds.iter().map(|(k, t)| (k.clone(), t.count, t.pending)).collect()
    }

    #[test]
    fn a_resolved_agents_escalation_does_not_survive_through_another_agent() {
        // finding 2: w1 was reminded twice, w1's stall ends, w2 starts stalling and has had no reminder
        let ks = [kind_s2()];
        let mut st = State::default();
        let both = up_by(&[("w1", &["stalled"])], None);
        fire(&mut st, &ks, &[("w1", "stalled")], &both);
        at(&mut st, &ks, &both);
        fire(&mut st, &ks, &[("w1", "stalled")], &both);
        assert_eq!(entries(&st), vec![("s|w1".to_string(), 2, true)], "w1 owes an escalation");
        let moved = up_by(&[("w2", &["stalled"])], None);
        let out = at(&mut st, &ks, &moved);
        assert!(out.reason.is_none(), "w2 has had no reminder: {:?}", out.reason);
        assert!(st.kinds.is_empty(), "and w1's resolved entry is gone: {st:?}");
    }

    #[test]
    fn two_agents_reminded_once_each_do_not_escalate() {
        let ks = [kind_s2()];
        let mut st = State::default();
        let live = up_by(&[("w1", &["stalled"]), ("w2", &["stalled"])], None);
        fire(&mut st, &ks, &[("w1", "stalled")], &live);
        fire(&mut st, &ks, &[("w2", "stalled")], &live);
        assert_eq!(entries(&st), vec![("s|w1".to_string(), 1, false), ("s|w2".to_string(), 1, false)], "one fire each, in one turn");
        assert!(at(&mut st, &ks, &live).reason.is_none(), "neither agent was reminded twice");
    }

    #[test]
    fn one_agent_reminded_twice_escalates_even_while_another_was_never_reminded() {
        let ks = [kind_s2()];
        let mut st = State::default();
        let live = up_by(&[("w1", &["stalled"]), ("w2", &["stalled"])], None);
        fire(&mut st, &ks, &[("w1", "stalled")], &live);
        at(&mut st, &ks, &live);
        fire(&mut st, &ks, &[("w1", "stalled")], &live);
        assert_eq!(entries(&st), vec![("s|w1".to_string(), 2, true)], "w2 has no entry: it was never named");
        let out = at(&mut st, &ks, &live);
        assert!(out.reason.as_deref().is_some_and(|r| r.contains(WATCH) && r.contains("2x")), "{:?}", out.reason);
    }

    #[test]
    fn an_agent_that_resolves_and_stalls_again_starts_counting_from_one() {
        let ks = [kind_s2()];
        let mut st = State::default();
        let up1 = up_by(&[("w1", &["stalled"])], None);
        fire(&mut st, &ks, &[("w1", "stalled")], &up1);
        at(&mut st, &ks, &up1);
        fire(&mut st, &ks, &[("w1", "stalled")], &up1);
        at(&mut st, &ks, &Live { flags: Some(BTreeMap::new()), ..Live::default() });
        assert!(st.kinds.is_empty(), "resolved: cleared");
        fire(&mut st, &ks, &[("w1", "stalled")], &up1);
        assert_eq!(entries(&st), vec![("s|w1".to_string(), 1, false)], "a new stall is a new count");
    }

    #[test]
    fn a_stall_still_up_blocks_while_another_agents_resolved_entry_is_cleared() {
        let ks = [kind_s2()];
        let mut st = State::default();
        let both = up_by(&[("w1", &["stalled"]), ("w2", &["stalled"])], None);
        for _ in 0..2 {
            fire(&mut st, &ks, &[("w1", "stalled"), ("w2", "stalled")], &both);
            if st.kinds.values().all(|t| !t.pending) {
                at(&mut st, &ks, &both);
            }
        }
        assert!(st.kinds.values().all(|t| t.pending), "both owe an escalation: {st:?}");
        let out = at(&mut st, &ks, &up_by(&[("w1", &["stalled"])], None));
        assert!(out.reason.as_deref().is_some_and(|r| r.contains(WATCH)), "w1 is still stalled: {:?}", out.reason);
        assert_eq!(out.steps.iter().filter(|s| s.1 == "acted").count(), 1, "w2's entry is cleared as acted: {:?}", out.steps);
        assert_eq!(entries(&st).into_iter().map(|e| e.0).collect::<Vec<_>>(), vec!["s|w1".to_string()]);
    }

    #[test]
    fn several_agents_pending_for_one_kind_get_one_block_text() {
        let ks = [kind_s2()];
        let mut st = State::default();
        let both = up_by(&[("w1", &["stalled"]), ("w2", &["stalled"])], None);
        fire(&mut st, &ks, &[("w1", "stalled"), ("w2", "stalled")], &both);
        at(&mut st, &ks, &both);
        fire(&mut st, &ks, &[("w1", "stalled"), ("w2", "stalled")], &both);
        let out = at(&mut st, &ks, &both);
        let r = out.reason.clone().expect("blocked");
        assert_eq!(r.matches(WATCH).count(), 1, "one text for the kind: {r}");
        assert!(st.kinds.values().all(|t| !t.pending && t.shown == 1), "and both agents' blocks are shown: {st:?}");
        assert_eq!(words(&out), vec!["escalated", "escalated"]);
    }

    #[test]
    fn an_agent_id_is_cleaned_and_the_agents_per_kind_are_bounded() {
        let ks = [kind_s2()];
        let mut st = State::default();
        let live = up_by(&[], None);
        fire(&mut st, &ks, &[("a/b|c d", "stalled")], &live);
        assert_eq!(entries(&st), vec![("s|a_b_c_d".to_string(), 1, false)], "the separator and path characters never reach a key");
        let max = subject_limit("per_kind_max") as usize;
        let many: Vec<String> = (0..max + 4).map(|i| format!("w{i}")).collect();
        let rows: Vec<(&str, &str)> = many.iter().map(|a| (a.as_str(), "stalled")).collect();
        let out = fire(&mut st, &ks, &rows, &live);
        assert_eq!(st.kinds.len(), max, "no more entries than the bound");
        assert_eq!(out.unattributed, 5, "the agents past it are counted, not kept");
        let (mut fresh, long) = (State::default(), "x".repeat(500));
        fire(&mut fresh, &ks, &[(long.as_str(), "stalled")], &live);
        assert!(!fresh.kinds.is_empty() && fresh.kinds.keys().all(|k| k.len() <= 2 + subject_limit("chars_max") as usize), "an agent id is cut: {fresh:?}");
    }

    #[test]
    fn only_a_row_of_the_kinds_own_signal_and_text_is_a_fire_about_its_agent() {
        let mut k = kind_s2();
        k.matches = vec!["is STALLED:".into()];
        let delivered = |agent: &str, signal: &str, text: &str| Delivered { agent: agent.into(), signal: signal.into(), text: text.into() };
        let all = vec![
            delivered("w1", "stalled", "subagent w1 is STALLED: x"),
            delivered("w2", "hung", "subagent w2 has produced no output for 9m"),
            delivered("w3", "stalled", "something else"),
        ];
        let tail = move |_: &str, _: Option<u64>| Some((3, all.clone()));
        let mut st = State::default();
        let out =
            pass(&mut st, "PostToolUse", &p_stop(false), std::slice::from_ref(&k), &adv_text("subagent w1 is STALLED: x"), &up(&["stalled"], None), &tail);
        assert_eq!(entries(&st), vec![("s|w1".to_string(), 1, false)], "{out:?}");
    }

    fn adv_text(text: &str) -> Vec<HookResult> {
        vec![HookResult { id: "s".into(), code: Some(0), out: json!({"systemMessage": text}).to_string(), err: String::new() }]
    }

    #[test]
    fn the_queue_mark_moves_forward_and_is_bounded() {
        let ks = [kind_s2()];
        let seen = std::cell::RefCell::new(Vec::new());
        let tail = |key: &str, prev: Option<u64>| {
            seen.borrow_mut().push((key.to_string(), prev));
            Some((seen.borrow().len() as u64 * 3, vec![Delivered { agent: "w1".into(), signal: "stalled".into(), text: String::new() }]))
        };
        let mut st = State::default();
        let live = up_by(&[("w1", &["stalled"])], None);
        let call = |st: &mut State, p: &Value| pass(st, "PostToolUse", p, &ks, &[watcher_adv()], &live, &tail);
        call(&mut st, &json!({"session_id": "s1"}));
        call(&mut st, &json!({"session_id": "s1"}));
        call(&mut st, &json!({"session_id": "s1", "agent_id": "a9"}));
        assert_eq!(
            seen.borrow().clone(),
            vec![("s1".to_string(), None), ("s1".to_string(), Some(3)), ("a9".to_string(), None)],
            "the session's queue is read from where the ladder last stood; a subagent's own queue is another one"
        );
        for i in 0..subject_limit("queues_max") + 3 {
            call(&mut st, &json!({"session_id": "s1", "agent_id": format!("a{i}")}));
        }
        assert_eq!(st.queues.len() as u64, subject_limit("queues_max"), "the marks are bounded: {:?}", st.queues);
    }

    // ---- every event sequence over the guard's record, the agents' signals and the reminders ----

    #[derive(Clone, Copy, Debug, PartialEq)]
    enum G {
        Block,
        Pass,
        Absent,
    }
    #[derive(Clone, Copy, Debug, PartialEq)]
    enum Who {
        None,
        W1,
        W2,
        Both,
    }
    #[derive(Clone, Copy, Debug)]
    enum Flags {
        Up(Who),
        Unreadable,
    }
    #[derive(Clone, Copy, Debug)]
    struct Sym {
        name: &'static str,
        guard: G,
        mark: Mark,
        reminded: Who,
        flags: Flags,
        tasks: Option<bool>,
        active: bool,
    }

    #[test]
    fn no_event_sequence_breaks_the_guard_pass_or_the_resolved_fact_invariant() {
        let ks = vec![tasks_guard(), kind_s2()];
        use Flags::Up;
        let t = Some(true);
        let sym = |name, guard, mark, reminded, flags, tasks, active| Sym { name, guard, mark, reminded, flags, tasks, active };
        #[rustfmt::skip]
        let alphabet = [
            sym("guard-blocks",               G::Block,  Mark::Never,      Who::W1,   Up(Who::W1),   t,          false),
            sym("pass-record-says-blocked",   G::Pass,   Mark::Blocked,    Who::W1,   Up(Who::W1),   t,          false),
            sym("pass-blocked-tasks-done",    G::Pass,   Mark::Blocked,    Who::W1,   Up(Who::W1),   Some(false), false),
            sym("pass-never-blocked",         G::Pass,   Mark::Never,      Who::W1,   Up(Who::W1),   t,          false),
            sym("pass-record-unreadable",     G::Pass,   Mark::Unreadable, Who::W1,   Up(Who::W1),   t,          false),
            sym("pass-blocked-tasks-unread",  G::Pass,   Mark::Blocked,    Who::W1,   Up(Who::W1),   None,       false),
            sym("no-guard-w1",                G::Absent, Mark::Never,      Who::W1,   Up(Who::W1),   t,          false),
            sym("no-guard-w2-both-up",        G::Absent, Mark::Never,      Who::W2,   Up(Who::Both), t,          false),
            sym("w1-resolved-w2-up-unreminded", G::Absent, Mark::Never,    Who::None, Up(Who::W2),   t,          false),
            sym("all-resolved-reminded",      G::Absent, Mark::Never,      Who::W1,   Up(Who::None), t,          false),
            sym("both-reminded-both-up",      G::Absent, Mark::Never,      Who::Both, Up(Who::Both), t,          false),
            sym("stop-hook-active",           G::Absent, Mark::Never,      Who::W1,   Up(Who::W1),   t,          true),
            sym("facts-unreadable",           G::Absent, Mark::Never,      Who::W1,   Flags::Unreadable, None,   false),
        ];
        #[derive(Default)]
        struct Tally {
            sequences: u64,
            watch_blocks: u64,
            guard_blocks: u64,
            held: u64,
            cleared: u64,
            foreign: u64,
        }
        fn agents(w: Who) -> Vec<&'static str> {
            match w {
                Who::None => vec![],
                Who::W1 => vec!["w1"],
                Who::W2 => vec!["w2"],
                Who::Both => vec!["w1", "w2"],
            }
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
                if sym.reminded != Who::None {
                    results.push(watcher_adv());
                }
                let live = Live {
                    flags: match sym.flags {
                        Flags::Up(w) => Some(agents(w).into_iter().map(|a| (a.to_string(), ["stalled".to_string()].into())).collect()),
                        Flags::Unreadable => None,
                    },
                    open_tasks: sym.tasks,
                    guards: BTreeMap::from([("g".to_string(), sym.mark)]),
                };
                let rows: Vec<(&str, &str)> = agents(sym.reminded).into_iter().map(|a| (a, "stalled")).collect();
                let tail = rows_of(&rows);
                let before = st.clone();
                let mut after = st.clone();
                let out = pass(&mut after, "Stop", &p_stop(sym.active), ks, &results, &live, &tail);
                let at = || format!("{trail:?}");
                let reason = out.reason.clone().unwrap_or_default();
                let tasks = sym.tasks;
                let may_block = !sym.active && sym.guard != G::Block;
                let record = sym.guard == G::Pass && sym.mark == Mark::Blocked;
                let guard_decides = sym.guard == G::Pass && record && tasks != Some(false);
                let guard_unreadable = sym.guard == G::Pass && sym.mark == Mark::Unreadable && !guard_decides && tasks != Some(false);
                // I1: a Stop a guard ran at and passed, that it had blocked before, is never blocked by the ladder, whatever came before
                if guard_decides || guard_unreadable {
                    assert!(reason.is_empty(), "{}: the guard's pass was overridden: {reason}", at());
                    t.held += 1;
                }
                // I3: no block on a Stop another hook blocks or one that has stop_hook_active
                if !may_block {
                    assert!(reason.is_empty(), "{}: a block on a Stop that may not carry one: {reason}", at());
                }
                // I2: an agent whose signal is not up has no entry after the Stop, whoever else is stalled
                if let Flags::Up(w) = sym.flags {
                    for a in ["w1", "w2"] {
                        let up = agents(w).contains(&a);
                        assert!(up || !after.kinds.contains_key(&format!("s|{a}")), "{}: {a} is resolved but its entry stayed: {after:?}", at());
                    }
                    if w == Who::None {
                        assert!(!reason.contains(WATCH), "{}: a resolved stall blocked: {reason}", at());
                        t.cleared += 1;
                    }
                }
                if tasks == Some(false) {
                    assert!(!after.kinds.contains_key("g") && !reason.contains("guard action"), "{}: the guard's stale entry stayed", at());
                }
                // I5: an agent counts only for the reminders that named it
                for a in ["w1", "w2"] {
                    let key = format!("s|{a}");
                    let named = agents(sym.reminded).contains(&a) && !results.is_empty() && results.iter().any(|r| r.id == "s");
                    let (b, f) = (before.kinds.get(&key), after.kinds.get(&key));
                    if !named {
                        assert!(f.is_none_or(|x| b.is_some_and(|y| y.count == x.count)), "{}: {a} was not named but counted: {before:?} -> {after:?}", at());
                        t.foreign += u64::from(f.is_some());
                    }
                }
                // I4: the block is exactly the due, verified, undecided case (so the invariants cannot pass by never blocking)
                let mut counted = before.clone();
                let obs: Vec<Obs> = {
                    let mut o = vec![Obs::of("g", observe(&ks[0], &results))];
                    if results.iter().any(|r| r.id == "s") {
                        o.extend(agents(sym.reminded).into_iter().map(|a| Obs { kind: "s".into(), subject: a.into(), seen: observe(&ks[1], &results) }));
                    }
                    o
                };
                count(&mut counted, ks, &obs);
                let holds = |a: &str| matches!(sym.flags, Flags::Up(w) if agents(w).contains(&a));
                let due_watch = ["w1", "w2"].iter().any(|a| counted.kinds.get(&format!("s|{a}")).is_some_and(|x| x.pending) && holds(a));
                let due_guard = counted.kinds.get("g").is_some_and(|x| x.pending);
                let free = may_block && !guard_decides && !guard_unreadable;
                let watch_ok = free && due_watch;
                let guard_ok = free && due_guard && tasks == Some(true);
                assert_eq!(reason.contains(WATCH), watch_ok, "{}: the stall block should be {watch_ok}: {reason:?}", at());
                assert_eq!(reason.contains("guard action"), guard_ok, "{}: the guard's own block should be {guard_ok}: {reason:?}", at());
                // bounded, and the turn boundary is applied
                assert!(after.kinds.len() <= 3 && after.kinds.values().all(|x| !x.this_turn), "{}: {after:?}", at());
                t.watch_blocks += u64::from(watch_ok);
                t.guard_blocks += u64::from(guard_ok);
                t.sequences += 1;
                walk(&after, depth - 1, trail, ks, alphabet, t);
                trail.pop();
            }
        }
        let mut t = Tally::default();
        walk(&State::default(), 5, &mut Vec::new(), &ks, &alphabet, &mut t);
        assert!(t.sequences > 300_000, "{} steps walked", t.sequences);
        assert!(t.watch_blocks > 1000 && t.guard_blocks > 100, "positive controls: the ladder does block ({} / {})", t.watch_blocks, t.guard_blocks);
        assert!(
            t.held > 1000 && t.cleared > 1000 && t.foreign > 100,
            "and the invariants were exercised ({} held, {} cleared, {} unnamed agents kept)",
            t.held,
            t.cleared,
            t.foreign
        );
    }

    // ---- the guard's own record, read from its state files ----

    fn guard_home(tag: &str, files: &[(&str, &str)], settings: Option<&str>) -> Settings {
        let home = tmp(tag);
        let base = home.join(".anti-hall");
        std::fs::create_dir_all(&base).unwrap();
        for (name, body) in files {
            std::fs::write(base.join(name), body).unwrap();
        }
        if let Some(s) = settings {
            std::fs::write(base.join("settings.json"), s).unwrap();
        }
        Settings { home: home.to_string_lossy().into_owned(), env: std::collections::HashMap::new() }
    }
    fn shipped_guard() -> GuardSpec {
        kinds(&serde_json::Map::new()).into_iter().find_map(|k| k.guard).expect("the shipped table declares task-guard as a guard")
    }

    #[test]
    fn the_shipped_task_guard_is_read_from_its_own_state_files() {
        let g = shipped_guard();
        assert_eq!(g.hook, "task-guard");
        let (a, b) = ("last-stop-taskset-s1", "tasklist-enforce-s1");
        let mark = |files: &[(&str, &str)], settings: Option<&str>, tag: &str| guard_mark_of(&guard_home(tag, files, settings), "s1", &g);
        assert_eq!(mark(&[], None, "gm-none"), Mark::Never, "no state file: it never blocked");
        assert_eq!(mark(&[(a, r#"{"hash":"h","blocks":1,"capScope":"owner_turn"}"#)], None, "gm-a"), Mark::Blocked, "the open-task block's counter");
        assert_eq!(mark(&[(a, r#"{"hash":"h","blocks":5}"#)], None, "gm-a5"), Mark::Blocked, "and at its cap");
        assert_eq!(
            mark(&[(b, r#"{"prune":{"n":-1,"blocks":0},"prio":{"hash":"x","blocks":2}}"#)], None, "gm-b"),
            Mark::Blocked,
            "the priority-tag block's counter, nested"
        );
        assert_eq!(mark(&[(b, r#"{"prune":{"n":3,"blocks":1},"prio":{"hash":"","blocks":0}}"#)], None, "gm-prune"), Mark::Blocked, "the prune block's");
        assert_eq!(
            mark(&[(a, r#"{"hash":"h","blocks":0}"#), (b, r#"{"prune":{"n":-1,"blocks":0},"prio":{"hash":"","blocks":0}}"#)], None, "gm-zero"),
            Mark::Never,
            "counters at zero"
        );
        assert_eq!(mark(&[(a, "  \n")], None, "gm-blank"), Mark::Never, "a blank file is what the guard reads as no earlier block");
        assert_eq!(mark(&[(a, "{not json")], None, "gm-corrupt"), Mark::Unreadable, "a record that is not JSON cannot be read");
        assert_eq!(
            mark(
                &[(
                    a,
                    &format!("{{\"hash\":\"{}\"}}", "y".repeat(defaults::raw("nudges.guard_state").get("max_bytes").and_then(V::as_integer).unwrap() as usize))
                )],
                None,
                "gm-big"
            ),
            Mark::Unreadable,
            "one over the size cap"
        );
        assert_eq!(
            mark(&[(a, "{not json"), (b, r#"{"prio":{"blocks":1}}"#)], None, "gm-mixed"),
            Mark::Blocked,
            "a readable record that counts a block settles it"
        );
        assert_eq!(
            mark(&[(a, r#"{"blocks":3}"#)], Some(r#"{"guards":{"taskGuard":false}}"#), "gm-off"),
            Mark::Never,
            "a guard that is switched off permits nothing it did not block"
        );
        assert_eq!(mark(&[("last-stop-taskset-other", r#"{"blocks":3}"#)], None, "gm-other"), Mark::Never, "another session's record is not this one's");
    }

    // ---- the open-task fact is read from the list the task guards read: the task store first, the transcript only without one ----

    /// A transcript that creates one task (#1) and sets it to `status`.
    fn transcript_with(home: &Path, status: &str) -> String {
        let line = |v: Value| format!("{v}\n");
        let t = [
            line(json!({"type": "assistant", "message": {"id": "m1", "role": "assistant", "content": [{"type": "tool_use", "id": "c1", "name": "TaskCreate", "input": {"subject": "t"}}]}})),
            line(json!({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "c1", "content": "Task #1 created successfully: t"}]}})),
            line(json!({"type": "assistant", "message": {"id": "u1", "role": "assistant", "content": [{"type": "tool_use", "id": "t1", "name": "TaskUpdate", "input": {"taskId": "1", "status": status}}]}})),
        ]
        .concat();
        let path = home.join(format!("t-{status}.jsonl"));
        std::fs::write(&path, t).unwrap();
        path.to_string_lossy().into_owned()
    }
    fn store_task(home: &Path, dir: &str, file: &str, body: &str) {
        let d = home.join(".claude/tasks").join(dir);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join(file), body).unwrap();
    }
    fn store_rec(status: &str) -> String {
        format!(r#"{{"id":"1","subject":"t","status":"{status}"}}"#)
    }
    fn open_of(home: &Settings, session: &str, transcript: Option<&str>) -> Option<bool> {
        let mut p = json!({"session_id": session});
        if let Some(t) = transcript {
            p["transcript_path"] = t.into();
        }
        open_tasks(home, &p)
    }

    #[test]
    fn the_open_task_fact_is_the_stores_whatever_the_transcript_says() {
        let st = guard_home("ot-store", &[], None);
        let h = Path::new(&st.home);
        let (open_t, done_t) = (transcript_with(h, "pending"), transcript_with(h, "completed"));
        // no store: the transcript decides, as the guards do
        assert_eq!(open_of(&st, "s1", Some(&open_t)), Some(true));
        assert_eq!(open_of(&st, "s1", Some(&done_t)), Some(false));
        assert_eq!(open_of(&st, "s1", None), None, "no store and no transcript: unknown");
        assert_eq!(open_of(&st, "s1", Some("/nonexistent/t.jsonl")), None, "no store and no transcript file: unknown");
        // a store open: open, with the transcript done, empty, absent or gone (the review's A1 and A2)
        store_task(h, "session-s1", "1.json", &store_rec("pending"));
        for t in [Some(done_t.as_str()), Some(open_t.as_str()), None, Some("/nonexistent/t.jsonl"), Some("")] {
            assert_eq!(open_of(&st, "s1", t), Some(true), "store open, transcript {t:?}");
        }
        assert_eq!(open_of(&st, "s1", Some("/dev/null")), Some(true), "an empty transcript");
        // a store done: done, whatever an old transcript tail lists
        store_task(h, "session-s1", "1.json", &store_rec("completed"));
        for t in [Some(open_t.as_str()), Some(done_t.as_str()), None, Some("/nonexistent/t.jsonl")] {
            assert_eq!(open_of(&st, "s1", t), Some(false), "store done, transcript {t:?}");
        }
        // another session's store is not this session's
        assert_eq!(open_of(&st, "s2", Some(&open_t)), Some(true));
        assert_eq!(open_of(&st, "s2", None), None);
    }

    #[test]
    fn a_store_that_is_no_list_leaves_the_transcript_to_decide() {
        let st = guard_home("ot-fallback", &[], None);
        let h = Path::new(&st.home);
        let open_t = transcript_with(h, "in_progress");
        store_task(h, "session-s1", "1.json", "{not json");
        store_task(h, "session-s1", "2.json", r#"{"id":"2","status":false}"#);
        assert_eq!(open_of(&st, "s1", Some(&open_t)), Some(true), "only junk in the store");
        assert_eq!(open_of(&st, "s1", None), None);
        // a session id the guards do not look up in the store is read from the transcript
        store_task(h, "session-s.1", "1.json", &store_rec("completed"));
        store_task(h, "s.1", "1.json", &store_rec("completed"));
        assert_eq!(open_of(&st, "s.1", Some(&open_t)), Some(true));
        let none = json!({"transcript_path": open_t});
        assert_eq!(open_tasks(&st, &none), Some(true), "no session id: the transcript");
    }

    #[test]
    fn the_live_facts_of_a_guard_kind_use_the_task_stores_list() {
        let st = guard_home("ot-live", &[], None);
        let h = Path::new(&st.home);
        store_task(h, "session-s1", "1.json", &store_rec("pending"));
        let p = json!({"session_id": "s1", "transcript_path": transcript_with(h, "completed")});
        let ks = kinds(&serde_json::Map::new());
        let live = live_facts(&st, &p, &ks);
        assert_eq!(live.open_tasks, Some(true), "the transcript says done, the store says open");
        let idle = ks.iter().find(|k| k.live_tasks).expect("the shipped table has a kind whose fact is an open task");
        assert_eq!(live.fact(idle, ""), Fact::Holds);
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
