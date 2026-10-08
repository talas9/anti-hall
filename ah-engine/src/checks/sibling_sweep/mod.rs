//! Built-in `check = "sibling-sweep"` (Stop and SubagentStop): when a reply states the cause of a bug and the turn shows no
//! search for other occurrences of the same pattern, remind the agent once to look for the siblings before calling the fix
//! done. Engine-only: there is no Node twin (the Node fallback entry is a no-op).
//!
//! What it does, in order, and what each step costs:
//! 1. Cheap exits: no home, the switch (`guards.siblingSweep`), the skip file, a judge or Jev child, another event, no
//!    session. The settings are read from disk (see [`tune`]; two `stat`s when nothing changed), so every phrase, text and
//!    limit is a file edit away, never a rebuild.
//! 2. The per-scope state file (small JSON) is read. When the reply (the payload's `last_assistant_message`) holds no cause
//!    statement and no reminder is pending, the check ends here: the transcript is not touched.
//! 3. Otherwise the last turn is read from the transcript end in one bounded pass ([`turn`]). A pending reminder is
//!    resolved first (follow-through: was a search among the next `sibling_sweep.follow_window` tool calls?).
//! 4. A cause statement in a fix context (fix words in the turn, or an edit tool call) with no search call after it and no
//!    explicit "no other occurrences" statement gets one reminder, at most once per cause per turn and
//!    `sibling_sweep.max_per_scope` per scope, never on a Stop that is already a continuation of a Stop block.
//!
//! The reminder is an advisory, never a block of the stop: a Stop event has no context channel, so it travels in the
//! one-shot continuation JSON the codex review nudge also uses; it is bounded as above and fails open on every error.
//! A state file that cannot be written means no reminder (an unrecorded reminder would repeat on every Stop).
//!
//! Telemetry (`logs/sibling-sweep.ndjson`, hashes and counts only): one row per detected cause statement with its result
//! (`reminded`, `swept`, `duplicate`, `capped`, `continuation`, `no_fix_context`) and one per resolved follow-through
//! (`followed`, `ignored`, `unknown`), so the reminder's effectiveness is a count of rows.
//!
//! Jev hook point (not wired, by design): the two judgement calls here, "is this a cause statement" and "did the search
//! cover the pattern", are the places a Jev mode would consult; the regex answer stands as the baseline.
pub mod matcher;
#[cfg(test)]
mod tests;
pub mod tune;
pub(crate) mod turn;

use crate::cfgstore::Paths;
use crate::checks::git::util::Settings;
use crate::checks::guardkit::msg::{self, Kind, Parts};
use crate::checks::guardkit::settings::{get_bool, is_skipped};
use crate::checks::replykit::io::{prune_stale, safe_session};
use crate::checks::{Check, Verdict};
use crate::defaults;
use crate::reqenv::RequestEnv;
use crate::rules::Subject;
use serde_json::{Value, json};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use tune::Tune;
use turn::{Ev, Kind as ToolKind, Turn};

/// The per-scope state: the reminders sent, the causes of the current turn and the reminder whose follow-through is open.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
struct State {
    fired: u64,
    turn: String,
    causes: Vec<String>,
    /// Cause hash and turn id of a reminder not yet resolved.
    pending: Option<(String, String)>,
}

impl State {
    fn from_json(v: &Value) -> State {
        let strs = |k: &str| v.get(k).and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default();
        let pending = v.get("pending").and_then(|p| Some((p.get("cause")?.as_str()?.to_string(), p.get("turn")?.as_str()?.to_string())));
        State {
            fired: v.get("fired").and_then(Value::as_u64).unwrap_or(0),
            turn: v.get("turn").and_then(Value::as_str).unwrap_or("").to_string(),
            causes: strs("causes"),
            pending,
        }
    }

    fn to_json(&self) -> Value {
        let pending = self.pending.as_ref().map(|(c, t)| json!({"cause": c, "turn": t}));
        json!({"fired": self.fired, "turn": self.turn, "causes": self.causes, "pending": pending})
    }
}

fn state_path(t: &Tune, st: &Settings, session: &str, agent: &str) -> PathBuf {
    let max = t.num("sibling_sweep.state_session_max") as usize;
    let mut name = format!("{}-{}", t.text("sibling_sweep.state_prefix"), safe_session(session, Some(max)));
    if !agent.is_empty() {
        name.push('-');
        name.push_str(&safe_session(agent, Some(max)));
    }
    name.push_str(defaults::text("replykit.json_ext"));
    Path::new(&st.home).join(defaults::text("replykit.state_dir")).join(name)
}

/// The state file; a missing one is an empty state, an unreadable or malformed one too (it is this check's own file, and
/// an empty state at worst repeats one reminder, which the per-scope cap then bounds).
fn load(path: &Path) -> State {
    std::fs::read_to_string(path).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).map(|v| State::from_json(&v)).unwrap_or_default()
}

/// Write the state atomically ([`crate::atomic::write`]: a uniquely named temporary file, flushed to disk, then a rename),
/// so a reader never sees half a file and two writers never share a temporary file.
fn save(path: &Path, s: &State) -> std::io::Result<()> {
    if let Some(d) = path.parent() {
        std::fs::create_dir_all(d)?;
    }
    crate::atomic::write(path, s.to_json().to_string())
}

/// Say once per process, in the daemon log, that something could not be written or read.
fn warn_once(t: &Tune, what: &str, e: &dyn std::fmt::Display) {
    static SAID: AtomicBool = AtomicBool::new(false);
    if !SAID.swap(true, Ordering::Relaxed) {
        eprintln!("{}", msg::render_with(&t.text("sibling_sweep.msg_log_failed"), &[("what", what), ("error", &e.to_string())]));
    }
}

/// Say once per process that the settings files hold something invalid and the shipped value is used instead.
fn warn_setting_once(t: &Tune, problem: &str) {
    static SAID: AtomicBool = AtomicBool::new(false);
    if !SAID.swap(true, Ordering::Relaxed) {
        eprintln!("{}", msg::render_with(&t.text("sibling_sweep.msg_bad_setting"), &[("setting", problem)]));
    }
}

/// Append one JSON row to the telemetry log, emptying the file first once it is over its cap. A failure is reported once
/// and never changes the decision.
fn log_row(t: &Tune, st: &Settings, row: &Value) {
    let path = Path::new(&st.home).join(defaults::text("paths.base_dir")).join(t.text("sibling_sweep.log"));
    let go = || -> std::io::Result<()> {
        if let Some(d) = path.parent() {
            std::fs::create_dir_all(d)?;
        }
        if std::fs::metadata(&path).is_ok_and(|m| m.len() > t.num("sibling_sweep.log_max_bytes")) {
            std::fs::write(&path, "")?;
        }
        let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&path)?;
        writeln!(f, "{row}")
    };
    if let Err(e) = go() {
        warn_once(t, &t.text("sibling_sweep.what_log"), &e);
    }
}

fn str_field<'a>(t: &Tune, p: &'a Value, key: &str) -> &'a str {
    p.get(t.text(key)).and_then(Value::as_str).unwrap_or("")
}

/// Follow-through of an open reminder: was a search among the first `follow_window` tool calls after the reminded reply?
/// `unknown` when the turn changed or the reply is not in the window.
fn resolve(t: &Tune, turn: &Turn, pending: &(String, String)) -> (&'static str, usize) {
    if turn.id != pending.1 {
        return ("unknown", 0);
    }
    let Some(at) = turn.events.iter().rposition(|e| matches!(e, Ev::Text { cause: Some(c), .. } if *c == pending.0)) else { return ("unknown", 0) };
    let window = t.num("sibling_sweep.follow_window") as usize;
    let calls: Vec<ToolKind> = turn.events[at + 1..].iter().filter_map(|e| if let Ev::Tool(k) = e { Some(*k) } else { None }).take(window).collect();
    (if calls.contains(&ToolKind::Search) { "followed" } else { "ignored" }, calls.len())
}

/// The reminder as the Stop continuation JSON.
fn reminder(t: &Tune, pattern: &str) -> String {
    let named = if pattern.is_empty() { String::new() } else { msg::render_with(&t.text("sibling_sweep.msg_pattern"), &[("pattern", pattern)]) };
    let what = msg::render_with(&t.text("sibling_sweep.msg_what"), &[("pattern", &named)]);
    let (why, instead, allowed, override_) =
        (t.text("sibling_sweep.msg_why"), t.text("sibling_sweep.msg_instead"), t.text("sibling_sweep.msg_allowed"), t.text("sibling_sweep.msg_override"));
    let text = msg::message(
        Kind::Tip,
        &t.text("sibling_sweep.guard_name"),
        &Parts { what: &what, why: &why, instead: &instead, allowed: &allowed, override_: &override_, ..Parts::default() },
    );
    json!({"decision": "block", "reason": text}).to_string()
}

/// The decision for one payload. `now_ms` stamps the telemetry rows; `user_cfg` is the engine's own config file (the second
/// settings layer), `None` for the default place under `home`.
pub fn decide(p: &Value, st: &Settings, now_ms: u64, user_cfg: Option<PathBuf>) -> Verdict {
    if st.home.is_empty() {
        return Verdict::Allow;
    }
    let base = Path::new(&st.home).join(defaults::text("paths.base_dir"));
    let t = tune::load(&Paths {
        user: user_cfg.unwrap_or_else(|| base.join(defaults::text("config.user_file"))),
        settings: Some(base.join(defaults::text("config.settings_file"))),
    });
    if let Some(problem) = t.problems.first() {
        warn_setting_once(&t, problem);
    }
    let event = str_field(&t, p, "sibling_sweep.f_event");
    if !t.list("sibling_sweep.events").iter().any(|e| e == event)
        || !get_bool(st, defaults::raw("sibling_sweep.setting"))
        || is_skipped(st, &t.text("sibling_sweep.guard_name"))
        || st.env.get(&t.text("sibling_sweep.child_env")).map(String::as_str) == Some(t.text("sibling_sweep.child_value").as_str())
    {
        return Verdict::Allow;
    }
    let session = str_field(&t, p, "sibling_sweep.f_session");
    let agent = str_field(&t, p, "sibling_sweep.f_agent");
    let transcript =
        [str_field(&t, p, "sibling_sweep.f_agent_transcript"), str_field(&t, p, "sibling_sweep.f_transcript")].into_iter().find(|x| x.starts_with('/'));
    if session.is_empty() {
        return Verdict::Allow;
    }
    let path = state_path(&t, st, session, agent);
    let mut state = load(&path);
    let scope = if event == t.text("sibling_sweep.subagent_event") { "subagent" } else { "session" };
    let reply = p.get(t.text("sibling_sweep.f_reply")).and_then(Value::as_str).filter(|s| !s.trim().is_empty());
    let reply_cause = reply.and_then(|r| matcher::find_cause(&t, r));
    // a reply with no cause statement and no open follow-through needs nothing from the transcript
    if reply.is_some() && reply_cause.is_none() && state.pending.is_none() {
        return Verdict::Allow;
    }
    let Some(transcript) = transcript else { return Verdict::Allow };
    let turn = match turn::read(&t, transcript) {
        Ok(x) => x,
        Err(e) => {
            warn_once(&t, &t.text("sibling_sweep.what_transcript"), &e);
            return Verdict::Allow;
        }
    };
    let mut dirty = false;
    if let Some(pending) = state.pending.take() {
        let (outcome, calls) = resolve(&t, &turn, &pending);
        log_row(
            &t,
            st,
            &json!({"ts": now_ms, "event": "followthrough", "scope": scope, "outcome": outcome, "tool_calls": calls, "cause": matcher::short(&t, &pending.0)}),
        );
        dirty = true;
    }
    let finish = |state: &State, dirty: bool, v: Verdict| {
        if dirty && let Err(e) = save(&path, state) {
            warn_once(&t, &t.text("sibling_sweep.what_state"), &e);
        }
        v
    };
    let latest = reply.or(turn.last_text.as_deref());
    let cause = match (reply_cause, reply) {
        (Some(c), _) => Some(c),
        (None, Some(_)) => None,
        (None, None) => latest.and_then(|l| matcher::find_cause(&t, l)),
    };
    let (Some(latest), Some(cause)) = (latest, cause) else { return finish(&state, dirty, Verdict::Allow) };
    let row = |result: &str| json!({"ts": now_ms, "event": "cause", "scope": scope, "result": result, "cause": matcher::short(&t, &cause.hash), "skipped_lines": turn.skipped});
    let fix = matcher::has_fix_words(&t, latest) || turn.events.iter().any(|e| matches!(e, Ev::Text { fix: true, .. } | Ev::Tool(ToolKind::Edit)));
    if !fix {
        log_row(&t, st, &row("no_fix_context"));
        return finish(&state, dirty, Verdict::Allow);
    }
    // evidence: a search call, or an explicit statement, after the first cause statement of the turn (the cause was stated
    // at the end when the transcript does not hold the reply yet)
    let first = turn.events.iter().position(|e| matches!(e, Ev::Text { cause: Some(_), .. })).unwrap_or(turn.events.len());
    let after = &turn.events[first.min(turn.events.len())..];
    let swept = matcher::states_sweep(&t, latest) || after.iter().any(|e| matches!(e, Ev::Tool(ToolKind::Search) | Ev::Text { sweep: true, .. }));
    if swept {
        log_row(&t, st, &row("swept"));
        return finish(&state, dirty, Verdict::Allow);
    }
    if p.get(t.text("sibling_sweep.f_active")).and_then(Value::as_bool) == Some(true) {
        log_row(&t, st, &row("continuation"));
        return finish(&state, dirty, Verdict::Allow);
    }
    if state.turn != turn.id {
        state.turn = turn.id.clone();
        state.causes.clear();
        dirty = true;
    }
    if state.causes.contains(&cause.hash) {
        log_row(&t, st, &row("duplicate"));
        return finish(&state, dirty, Verdict::Allow);
    }
    if state.fired >= t.num("sibling_sweep.max_per_scope") {
        log_row(&t, st, &row("capped"));
        return finish(&state, dirty, Verdict::Allow);
    }
    state.fired += 1;
    state.causes.push(cause.hash.clone());
    if state.causes.len() > t.num("sibling_sweep.max_causes") as usize {
        state.causes.remove(0);
    }
    state.pending = Some((cause.hash.clone(), turn.id.clone()));
    if let Err(e) = save(&path, &state) {
        // an unrecorded reminder would repeat on every Stop
        warn_once(&t, &t.text("sibling_sweep.what_state"), &e);
        return Verdict::Allow;
    }
    if let Some(dir) = path.parent() {
        prune_stale(dir, &t.text("sibling_sweep.state_prefix"), path.file_name().and_then(|n| n.to_str()));
    }
    log_row(&t, st, &row("reminded"));
    Verdict::Advisory(reminder(&t, &cause.pattern))
}

/// The registered `sibling-sweep` check.
pub struct SiblingSweep;

impl Check for SiblingSweep {
    fn name(&self) -> &'static str {
        "sibling-sweep"
    }

    fn summary(&self) -> &'static str {
        defaults::text("sibling_sweep.summary")
    }

    fn run(&self, _s: &Subject<'_>, _opts: &Value) -> Option<Verdict> {
        Some(Verdict::Allow)
    }

    fn run_env(&self, _s: &Subject<'_>, payload: &Value, _opts: &Value, env: &RequestEnv) -> Option<Verdict> {
        let now = crate::checks::replykit::io::now_ms() as u64;
        Some(decide(payload, &Settings::from_env(env), now, Some(Paths::from_env().user)))
    }
}
