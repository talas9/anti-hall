//! The Stop channel (GH #540, plan v2 C1): advice a check says at Stop reaches the model only as Stop `additionalContext`.
//!
//! Lab result (plan v2 F5, F15): a Stop note sent as `systemMessage` is a warning for the user; the model never acts on it (0/10
//! followed, the same as silence), and the turn ends. The same note as Stop `additionalContext` makes the turn continue and is
//! followed 10/10 (a soft block). This module moves a check's Stop note from the one channel to the other, behind switches that
//! ship OFF (`stop_channel.sw_main`, per check `stop_channel.check_on` / `check_off`), and bounds what a soft block may do:
//!
//! - **continuation cap**: at most `stop_channel.num_cap` consecutive soft blocks per session. The count lives in a file per
//!   session; a new prompt (`UserPromptSubmit`) or a tool call in the transcript after the last soft block starts it again. A
//!   capped note stays on `systemMessage` (what it is today), so nothing is lost for the user.
//! - **pending-work guard**: no soft block while the session has running background agents or background shell tasks (the tracker's
//!   guard rows): a continuation would only make the turn poll. The note is kept and delivered once as the next prompt's
//!   `additionalContext`.
//!
//! A hard block in the same Stop answer, a host not listed in `stop_channel.hosts` (Codex: not confirmed) and a check in
//! `stop_channel.user_only` leave the answer as it is. Everything (switches, cap, lists, texts, markers) is read from the plugin's
//! `stop_channel.toml`; the counters are `telemetry::emit::stop_channel` events (metric `stop_channel`).
use super::combine::{self, HookResult};
use super::stoploop;
use crate::checks::git::util::Settings;
use crate::checks::guardkit::settings::{get_bool, get_number};
use crate::reqenv::RequestEnv;
use crate::telemetry::emit;
use crate::{defaults, health};
use serde_json::{Map, Value, json};
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;

use super::combine::{HSO_CTX as CTX, HSO_EVENT as EVENT, HSO_KEY as HSO, TOP_MSG as MSG};

/// The switches, resolved once per call.
struct Switches {
    global: bool,
    cap: u64,
    defer: bool,
}

impl Switches {
    fn read(st: &Settings) -> Switches {
        Switches {
            global: get_bool(st, defaults::raw("stop_channel.sw_main")),
            cap: get_number(st, defaults::raw("stop_channel.num_cap")).max(0.0) as u64,
            defer: get_bool(st, defaults::raw("stop_channel.sw_defer")),
        }
    }

    /// Does `check`'s Stop note go to `additionalContext`? A per-check row beats the global switch; `check_off` beats `check_on`.
    fn enabled(&self, check: &str) -> bool {
        decide(self.global, &defaults::list("stop_channel.check_on"), &defaults::list("stop_channel.check_off"), check)
    }

    fn any(&self) -> bool {
        self.global || !defaults::list("stop_channel.check_on").is_empty()
    }
}

/// The per-check rule: `off` beats `on`, a row beats the global switch.
fn decide(global: bool, on: &[&str], off: &[&str], check: &str) -> bool {
    !off.contains(&check) && (global || on.contains(&check))
}

fn base_id(id: &str) -> &str {
    id.split([':', '#']).next().unwrap_or(id)
}

fn dir() -> PathBuf {
    crate::paths::dir().join(defaults::text("stop_channel.state_dir"))
}

/// The per-session record of the consecutive soft blocks: how many, and the transcript length when the last one was sent.
#[derive(Default)]
struct Chain {
    n: u64,
    off: u64,
}

impl Chain {
    fn path(session: &str) -> PathBuf {
        dir().join(session)
    }
    fn read(session: &str) -> Chain {
        let v: Value = std::fs::read_to_string(Chain::path(session)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
        Chain { n: v.get("n").and_then(Value::as_u64).unwrap_or(0), off: v.get("off").and_then(Value::as_u64).unwrap_or(u64::MAX) }
    }
    fn write(&self, session: &str) {
        crate::discard::harmless(crate::limits::ensure_private_dir(&dir())); // keep: the write below reports a directory that is missing
        crate::discard::logged("stop_channel_state_write", crate::atomic::write(Chain::path(session), json!({"n": self.n, "off": self.off}).to_string()));
    }
}

/// Remove the files not touched for `stop_channel.state_max_age_days` (a session that ended mid-chain, or with a note held).
fn prune() {
    let max = std::time::Duration::from_secs(defaults::num("stop_channel.state_max_age_days") * 86_400);
    let Ok(rd) = std::fs::read_dir(dir()) else { return };
    for e in rd.flatten() {
        let old = e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|age| age > max);
        if old && e.file_type().is_ok_and(|t| t.is_file()) {
            crate::discard::harmless(std::fs::remove_file(e.path())); // keep: cleanup that raced; an absent file is the goal state
        }
    }
}

fn transcript_of(p: &Value) -> Option<&str> {
    p.get("transcript_path").and_then(Value::as_str).filter(|t| std::path::Path::new(t).is_absolute())
}

/// Did the transcript get a tool call after byte `off`? An unknown offset (`u64::MAX`) says no; a transcript shorter than the offset
/// was replaced, which is a change. At most `stop_channel.scan_max_bytes` of the end are read.
fn tool_since(p: &Value, off: u64) -> bool {
    if off == u64::MAX {
        return false;
    }
    let Some(path) = transcript_of(p) else { return false };
    let Ok(mut f) = std::fs::File::open(path) else { return false };
    let Ok(len) = f.metadata().map(|m| m.len()) else { return false };
    if len < off {
        return true;
    }
    let from = off.max(len.saturating_sub(defaults::num("stop_channel.scan_max_bytes")));
    let mut buf = Vec::new();
    if f.seek(SeekFrom::Start(from)).is_err() || f.take(len - from).read_to_end(&mut buf).is_err() {
        return false;
    }
    let text = String::from_utf8_lossy(&buf);
    defaults::list("stop_channel.tool_markers").iter().any(|m| text.contains(m))
}

/// Is a background agent or shell task of this session running that the turn may be waiting on?
fn pending_work(p: &Value, session: &str, st: &Settings) -> bool {
    if st.home.is_empty() {
        return false;
    }
    let env = crate::agents::Env {
        home: PathBuf::from(&st.home),
        now_ms: health::now_ms(),
        plugin_root: defaults::root(),
        use_cli: false,
        settings: st.clone(),
        act: false,
    };
    let kinds = defaults::list("stop_channel.pending_kinds");
    let running = defaults::raw("agent_tracker.states").str_field("running").to_string();
    let cwd = p.get("cwd").and_then(Value::as_str).unwrap_or("");
    crate::agents::guard_rows(&env, session, transcript_of(p).unwrap_or(""), cwd).iter().any(|row| {
        let text = |k: &str| row.get(k).and_then(Value::as_str).unwrap_or("");
        text("parent") == session
            && text("id") != session
            && text("state") == running
            && row.get("known").and_then(Value::as_bool) == Some(true)
            && kinds.contains(&text("kind"))
    })
}

/// The funnel labels (model family, project) of the session, for the counters.
fn labels(p: &Value) -> (String, String) {
    let session = p.get("session_id").and_then(Value::as_str).unwrap_or("");
    let phash = crate::telemetry::project_hash(&crate::store::project_key(p.get("cwd").and_then(Value::as_str).unwrap_or("/")));
    let c = crate::funnel::ctx(session, p, &phash);
    (c.model, c.project)
}

fn count(counter: &str, check: &str, who: &(String, String)) {
    emit::queue(emit::stop_channel(counter, check, &who.0, &who.1));
}

/// One check's note that may move: the result it is in, the check, the text, and whether the text came from the result's stderr
/// (`stop_channel.stderr_checks`) rather than its `systemMessage`.
struct Note {
    at: usize,
    check: String,
    text: String,
    from_stderr: bool,
}

/// The stdout of a result as a JSON object; empty stdout is the empty object, anything else that is not an object is `None`.
fn object_of(out: &str) -> Option<Value> {
    if out.trim().is_empty() {
        return Some(json!({}));
    }
    serde_json::from_str::<Value>(out).ok().filter(Value::is_object)
}

/// The notes that may move, and the checks whose note stays where it is by their `user_only` row.
fn notes_of(results: &[HookResult], sw: &Switches) -> (Vec<Note>, Vec<String>) {
    let user_only = defaults::list("stop_channel.user_only");
    let stderr_checks = defaults::list("stop_channel.stderr_checks");
    let (mut out, mut stays) = (Vec::new(), Vec::new());
    for (at, r) in results.iter().enumerate() {
        if r.code != Some(0) {
            continue;
        }
        let Some(v) = object_of(&r.out) else { continue };
        let check = base_id(&r.id);
        let message = v.get(MSG).and_then(Value::as_str).filter(|t| !t.trim().is_empty());
        let has_context = v.get(HSO).and_then(|h| h.get(CTX)).and_then(Value::as_str).is_some_and(|t| !t.is_empty());
        let (text, from_stderr) = match message {
            Some(t) => (t.to_string(), false),
            None if stderr_checks.contains(&check) && !has_context && !r.err.trim().is_empty() => (r.err.trim().to_string(), true),
            None => continue,
        };
        if user_only.contains(&check) {
            stays.push(check.to_string());
        } else if sw.enabled(check) {
            out.push(Note { at, check: check.to_string(), text, from_stderr });
        }
    }
    (out, stays)
}

/// `out` with its `systemMessage` removed; an object left with nothing is no output.
fn without_message(out: &str) -> String {
    let Some(mut v) = serde_json::from_str::<Value>(out).ok().filter(Value::is_object) else { return out.to_string() };
    if let Some(o) = v.as_object_mut() {
        o.remove(MSG);
        if o.is_empty() {
            return String::new();
        }
    }
    format!("{v}\n")
}

/// `out` with `text` added to `hookSpecificOutput.additionalContext` of `event`, and (`drop_message`) its `systemMessage` removed.
fn with_context(out: &str, event: &str, text: &str, drop_message: bool) -> String {
    let Some(mut v) = object_of(out) else { return out.to_string() };
    let Some(o) = v.as_object_mut() else { return out.to_string() };
    if drop_message {
        o.remove(MSG);
    }
    let hso = o.entry(HSO).or_insert_with(|| Value::Object(Map::new()));
    if let Some(h) = hso.as_object_mut() {
        h.entry(EVENT).or_insert_with(|| json!(event));
        let prev = h.get(CTX).and_then(Value::as_str).unwrap_or("").to_string();
        let joined = if prev.is_empty() { text.to_string() } else { format!("{prev}{}{text}", defaults::text("dispatch.context_joiner")) };
        h.insert(CTX.into(), json!(joined));
    }
    format!("{v}\n")
}

/// Apply the Stop channel to the results of one dispatch (`host`, `event`, payload `p`), before they are combined.
pub fn apply(host: &str, event: &str, p: &Value, env: &RequestEnv, results: &mut Vec<HookResult>) {
    let session = stoploop::safe(Some(p), "session_id");
    if session.is_empty() {
        return;
    }
    if defaults::list("stop_channel.prompt_events").contains(&event) {
        on_prompt(&session, event, p, results);
        return;
    }
    if !defaults::list("stop_channel.events").contains(&event) || !defaults::list("stop_channel.hosts").contains(&host) {
        return;
    }
    let st = Settings::from_env(env);
    let sw = Switches::read(&st);
    // a hard block decides the answer (and continues the turn by itself); the notes beside it stay where they are
    if !sw.any() || results.iter().any(combine::blocks) {
        return;
    }
    let (notes, stays) = notes_of(results, &sw);
    if notes.is_empty() && stays.is_empty() {
        return;
    }
    let who = labels(p);
    for c in &stays {
        count("system_message", c, &who);
    }
    if notes.is_empty() {
        return;
    }
    let mut chain = Chain::read(&session);
    let all = defaults::text("stop_channel.all_label");
    // the chain restarts when the transcript shows a tool call after the last soft block
    if chain.n > 0 && tool_since(p, chain.off) {
        chain = Chain { n: 0, off: u64::MAX };
    }
    if chain.n >= sw.cap {
        count("cap_hit", all, &who);
        for n in &notes {
            count("system_message", &n.check, &who);
        }
        return;
    }
    if sw.defer && pending_work(p, &session, &st) {
        hold(&session, &notes, results, &who);
        return;
    }
    for n in &notes {
        if let Some(r) = results.get_mut(n.at) {
            r.out = with_context(&r.out, event, &n.text, !n.from_stderr);
        }
        count("soft_block", &n.check, &who);
    }
    prune();
    chain.n += 1;
    chain.off = transcript_of(p).and_then(|t| std::fs::metadata(t).ok()).map_or(u64::MAX, |m| m.len());
    chain.write(&session);
}

/// Keep the notes for the next prompt and take them off this Stop's answer.
fn hold(session: &str, notes: &[Note], results: &mut super::spill::Results, who: &(String, String)) {
    let joiner = defaults::text("dispatch.context_joiner");
    let body = notes.iter().map(|n| n.text.as_str()).collect::<Vec<_>>().join(joiner);
    let text: String =
        format!("{}{body}", defaults::text("stop_channel.msg_held_prefix")).chars().take(defaults::num("stop_channel.note_max_chars") as usize).collect();
    crate::discard::harmless(crate::limits::ensure_private_dir(&dir())); // keep: the write below reports a directory that is missing
    if let Err(e) = crate::atomic::write(note_path(session), text) {
        crate::discard::note("stop_channel_note_write", &e.to_string());
        return; // a note that could not be kept stays where it was: the user still sees it
    }
    prune();
    for n in notes {
        if let (Some(r), false) = (results.get_mut(n.at), n.from_stderr) {
            r.out = without_message(&r.out); // a note from stderr leaves stderr as it is: the user still sees it there
        }
        count("deferred_pending_work", &n.check, who);
    }
}

fn note_path(session: &str) -> PathBuf {
    dir().join(format!("{session}{}", defaults::text("stop_channel.note_suffix")))
}

/// A prompt starts a new chain and delivers the note held at an earlier Stop, once, as its `additionalContext`.
fn on_prompt(session: &str, event: &str, p: &Value, results: &mut Vec<HookResult>) {
    if !dir().is_dir() {
        return; // the channel was never used on this machine: nothing to reset or deliver
    }
    crate::discard::harmless(std::fs::remove_file(Chain::path(session))); // keep: an absent chain is the goal state
    let path = note_path(session);
    let Ok(text) = std::fs::read_to_string(&path) else { return };
    crate::discard::harmless(std::fs::remove_file(&path)); // keep: the note is delivered once; a failed removal is retried by prune
    if text.trim().is_empty() {
        return;
    }
    let out = format!("{}\n", json!({HSO: {EVENT: event, CTX: text}}));
    results.push(HookResult { id: defaults::text("stop_channel.delivery_id").to_string(), code: Some(0), out, err: String::new() });
    count("deferred_delivered", defaults::text("stop_channel.all_label"), &labels(p));
}

/// Does the engine-health advisory go to the model at this event (the merge into a Stop answer)? Only when the Stop channel is on
/// for the `stop_channel.health_check` pseudo-check on a host that honours Stop `additionalContext`. The advisory is once per
/// session, so it needs no cap of its own.
pub fn health_to_context(host: &str, event: &str) -> bool {
    if !defaults::list("stop_channel.events").contains(&event) || !defaults::list("stop_channel.hosts").contains(&host) {
        return false;
    }
    let sw = Switches::read(&Settings::from_env(&RequestEnv::capture()));
    let check = defaults::text("stop_channel.health_check");
    let on = sw.enabled(check);
    if on {
        count("soft_block", check, &(defaults::text("delivery.model_unknown").to_string(), defaults::text("delivery.project_other").to_string()));
    }
    on
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_message_moves_into_the_event_context_and_joins_an_existing_one() {
        let o: Value = serde_json::from_str(&with_context(r#"{"systemMessage":"say it"}"#, "Stop", "say it", true)).unwrap();
        assert_eq!(o, json!({"hookSpecificOutput": {"hookEventName": "Stop", "additionalContext": "say it"}}));
        let both = r#"{"systemMessage":"b","hookSpecificOutput":{"hookEventName":"Stop","additionalContext":"a"}}"#;
        let o: Value = serde_json::from_str(&with_context(both, "Stop", "b", true)).unwrap();
        assert!(o.get(MSG).is_none() && o["hookSpecificOutput"]["additionalContext"].as_str().unwrap().starts_with('a'));
        // a stderr note keeps the stdout's own fields and has no message to drop
        let o: Value = serde_json::from_str(&with_context("", "Stop", "from stderr", false)).unwrap();
        assert_eq!(o, json!({"hookSpecificOutput": {"hookEventName": "Stop", "additionalContext": "from stderr"}}));
    }

    #[test]
    fn taking_the_message_off_leaves_other_fields_and_an_empty_object_is_no_output() {
        assert_eq!(without_message(r#"{"systemMessage":"m"}"#), "");
        assert_eq!(without_message(r#"{"systemMessage":"m","x":1}"#), "{\"x\":1}\n");
        assert_eq!(without_message("plain"), "plain");
    }

    #[test]
    fn a_check_row_beats_the_global_switch_and_off_beats_on() {
        assert!(!decide(false, &[], &[], "a"), "default off");
        assert!(decide(false, &["a"], &[], "a") && !decide(false, &["a"], &[], "b"), "a per-check switch-on");
        assert!(!decide(true, &[], &["a"], "a") && decide(true, &[], &["a"], "b"), "a per-check switch-off");
        assert!(!decide(true, &["a"], &["a"], "a"), "off beats on");
    }

    #[test]
    fn variant_ids_take_their_base_check() {
        assert_eq!(base_id("afk-mode:stop"), "afk-mode");
        assert_eq!(base_id("swarm-guard#2"), "swarm-guard");
    }
}
