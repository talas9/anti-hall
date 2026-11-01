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
//! - **continuation ceiling**: at most `stop_channel.num_ceiling` soft blocks per USER PROMPT, whatever tool calls come between. A
//!   tool call restarts only the consecutive count inside the ceiling, so a chain of "soft block, tool call, soft block" is bounded
//!   too (an unattended session cannot continue without end). Only a prompt restarts the ceiling. The host's `stop_hook_active` is
//!   not used as the signal: it is false again for the Stop that follows a background task's notification (lab B0), so it does not
//!   mark every Stop of a chain.
//! - **pending-work guard**: no soft block while the session has running background agents or background shell tasks (the tracker's
//!   guard rows): a continuation would only make the turn poll. The note is kept whole and delivered once as the next prompt's
//!   `additionalContext` (a note that does not fit the hold goes out now on its old channel, never cut). A tracker that cannot be
//!   read is UNKNOWN work: nothing is held and nothing is sent as `additionalContext`.
//!
//! A held note is consumed only when it is in the answer that was written: the prompt claims it, and [`settle`] removes the claim
//! after the answer was written, or puts the note back when the answer was blocked or did not carry it.
//!
//! A hard block in the same Stop answer, a host not listed in `stop_channel.hosts` (Codex: not confirmed) and a check in
//! `stop_channel.user_only` leave the answer as it is. Everything (switches, cap, lists, texts, markers) is read from the plugin's
//! `stop_channel.toml`; the counters are `telemetry::emit::stop_channel` events (metric `stop_channel`).
use super::combine::{self, HookResult};
use super::stoploop;
use super::stopstate::{self, Chain, Fail, Held1};
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
    ceiling: u64,
    defer: bool,
}

impl Switches {
    fn read(st: &Settings) -> Switches {
        Switches {
            global: get_bool(st, defaults::raw("stop_channel.sw_main")),
            cap: get_number(st, defaults::raw("stop_channel.num_cap")).max(0.0) as u64,
            ceiling: get_number(st, defaults::raw("stop_channel.num_ceiling")).max(0.0) as u64,
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
    stopstate::dir()
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

/// What the transcript proves about the chain.
enum Proof {
    /// A tool call came after the last soft block: the chain starts again.
    Restart,
    /// Nothing shows a restart (also an unknown offset: the chain cannot be restarted by a tool call, only by a prompt).
    Same,
}

/// Did the transcript get a tool call after byte `off`? Only a tool call that is read in the transcript restarts the chain. A
/// transcript that is absent, cannot be read, or is shorter than `off` (rewritten) proves nothing and is a [`Fail`]. At most
/// `stop_channel.scan_max_bytes` of the end are read.
fn tool_since(p: &Value, off: u64) -> Result<Proof, Fail> {
    if off == u64::MAX {
        return Ok(Proof::Same);
    }
    let path = transcript_of(p).ok_or(Fail::Transcript)?;
    let mut f = std::fs::File::open(path).map_err(|_| Fail::Transcript)?;
    let len = f.metadata().map_err(|_| Fail::Transcript)?.len();
    if len < off {
        return Err(Fail::Shrunk);
    }
    let from = off.max(len.saturating_sub(defaults::num("stop_channel.scan_max_bytes")));
    let mut buf = Vec::new();
    f.seek(SeekFrom::Start(from)).map_err(|_| Fail::Transcript)?;
    f.take(len - from).read_to_end(&mut buf).map_err(|_| Fail::Transcript)?;
    let text = String::from_utf8_lossy(&buf);
    Ok(if defaults::list("stop_channel.tool_markers").iter().any(|m| text.contains(m)) { Proof::Restart } else { Proof::Same })
}

/// Is a background agent or shell task of this session running that the turn may be waiting on? A tracker that cannot be read (or a
/// session without a home to look in) is not "no work": it is a [`Fail::Tracker`].
fn pending_work(p: &Value, session: &str, st: &Settings) -> Result<bool, Fail> {
    if st.home.is_empty() {
        return Err(Fail::Tracker);
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
    let rows = crate::agents::guard_rows_checked(&env, session, transcript_of(p).unwrap_or(""), cwd).map_err(|()| Fail::Tracker)?;
    Ok(rows.iter().any(|row| {
        let text = |k: &str| row.get(k).and_then(Value::as_str).unwrap_or("");
        text("parent") == session
            && text("id") != session
            && text("state") == running
            && row.get("known").and_then(Value::as_bool) == Some(true)
            && kinds.contains(&text("kind"))
    }))
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

/// Count a state that could not be proven and leave the notes where they were (the answer of the call is what it was before the Stop
/// channel): the reason, and each note that stayed on its old channel.
fn failed(f: Fail, notes: &[Note], who: &(String, String)) {
    count("state_failed", f.label(), who);
    for n in notes {
        count("system_message", &n.check, who);
    }
}

/// What the count says about one more soft block.
enum Step {
    /// Allowed: the chain after it.
    Go(Chain),
    /// `stop_channel.num_cap` consecutive soft blocks were sent.
    Cap,
    /// `stop_channel.num_ceiling` soft blocks were sent since the last prompt.
    Ceiling,
}

/// The chain after one more soft block, or the bound that holds it back. The ceiling (soft blocks since the last prompt) is read first
/// and nothing but a prompt ([`on_prompt`]) restarts it. The consecutive count restarts on a tool call read in the transcript after the
/// last soft block, inside the ceiling; a state that cannot be proven is a [`Fail`].
fn next_chain(guard: &stopstate::Guard, p: &Value, cap: u64, ceiling: u64) -> Result<Step, Fail> {
    let mut chain = guard.chain()?;
    if chain.t >= ceiling {
        return Ok(Step::Ceiling);
    }
    if chain.n > 0 && matches!(tool_since(p, chain.off)?, Proof::Restart) {
        chain = chain.restarted();
    }
    if chain.n >= cap {
        return Ok(Step::Cap);
    }
    let off = transcript_of(p).and_then(|t| std::fs::metadata(t).ok()).map_or(u64::MAX, |m| m.len());
    Ok(Step::Go(Chain { n: chain.n + 1, t: chain.t + 1, off }))
}

/// Count a soft block that a bound held back, and each note that stayed on its old channel.
fn bound_hit(step: &Step, notes: &[Note], who: &(String, String)) {
    let label = if matches!(step, Step::Ceiling) { defaults::text("stop_channel.ceiling_label") } else { defaults::text("stop_channel.all_label") };
    count("cap_hit", label, who);
    for n in notes {
        count("system_message", &n.check, who);
    }
}

/// Apply the Stop channel to the results of one dispatch (`host`, `event`, payload `p`), before they are combined.
pub fn apply(host: &str, event: &str, p: &Value, env: &RequestEnv, results: &mut Vec<HookResult>) {
    let session = stoploop::safe(Some(p), "session_id");
    if session.is_empty() {
        return;
    }
    if defaults::list("stop_channel.prompt_events").contains(&event) {
        on_prompt(host, &session, event, p, env, results);
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
    // whether background work runs is read before the lock; a tracker that cannot be read is unknown work: nothing is held or sent
    let pending = if sw.defer {
        match pending_work(p, &session, &st) {
            Ok(b) => b,
            Err(f) => return failed(f, &notes, &who),
        }
    } else {
        false
    };
    // count, decide and save under the session's lock: parallel Stops cannot pass the cap
    let guard = match stopstate::lock(&session) {
        Ok(g) => g,
        Err(f) => return failed(f, &notes, &who),
    };
    let next = match next_chain(&guard, p, sw.cap, sw.ceiling) {
        Ok(Step::Go(c)) => c,
        Ok(bound) => return bound_hit(&bound, &notes, &who),
        Err(f) => return failed(f, &notes, &who),
    };
    if pending {
        hold(&guard, &notes, results, &who);
        return;
    }
    // the soft block is reserved (saved) before it is emitted, and the lock is proven still ours before anything is emitted: a save
    // that fails, or a lock that was lost meanwhile, emits nothing
    if let Err(f) = guard.save(next).and_then(|()| guard.verify()) {
        return failed(f, &notes, &who);
    }
    for n in &notes {
        if let Some(r) = results.get_mut(n.at) {
            r.out = with_context(&r.out, event, &n.text, !n.from_stderr);
        }
        count("soft_block", &n.check, &who);
    }
    prune();
}

/// Keep the notes for the next prompt and take them off this Stop's answer. A note is kept whole or not at all: one that does not fit
/// the hold stays where it was (its old channel carries it now), and the same note held twice is held once.
fn hold(guard: &stopstate::Guard, notes: &[Note], results: &mut super::spill::Results, who: &(String, String)) {
    let items: Vec<(&str, &str)> = notes.iter().map(|n| (n.check.as_str(), n.text.as_str())).collect();
    // a note that could not be kept stays where it was: the user still sees it
    let outcomes = match guard.hold(&items, defaults::num("stop_channel.note_max_chars") as usize) {
        Ok(o) => o,
        Err(f) => return failed(f, notes, who),
    };
    prune();
    for (n, o) in notes.iter().zip(outcomes) {
        if o == Held1::TooLarge {
            count("state_failed", Fail::NoteTooLarge.label(), who);
            count("system_message", &n.check, who);
            continue;
        }
        if let (Some(r), false) = (results.get_mut(n.at), n.from_stderr) {
            r.out = without_message(&r.out); // a note from stderr leaves stderr as it is: the user still sees it there
        }
        count(if o == Held1::Duplicate { "deferred_duplicate" } else { "deferred_pending_work" }, &n.check, who);
    }
}

/// Notes a prompt claimed and put in its answer: they are removed only after the answer was written ([`settle`]).
struct Owed {
    session: String,
    claims: stopstate::Claims,
    /// The text added to the answer, as the answer must carry it.
    text: String,
    who: (String, String),
}

thread_local! {
    static OWED: std::cell::RefCell<Option<Owed>> = const { std::cell::RefCell::new(None) };
}

/// Forget a delivery owed by an earlier call of this thread (its claim stays and is delivered again after `stop_channel.claim_stale_s`).
pub fn forget_owed() {
    OWED.with(|o| o.borrow_mut().take());
}

/// Called after the answer of a call was written (and by a caller that has the final answer): the notes a prompt claimed for it are
/// removed when the answer carries them whole, and put back for the next prompt when it does not (it was blocked, or the text was cut
/// or spilled). Nothing is owed on any other call.
pub fn settle(out: &crate::client::Outcome) {
    let Some(owed) = OWED.with(|o| o.borrow_mut().take()) else { return };
    let in_answer = out.code == 0
        && !combine::json_blocks(&out.out)
        && object_of(&out.out).and_then(|v| v.get(HSO).and_then(|h| h.get(CTX)).and_then(Value::as_str).map(|c| c.contains(&owed.text))).unwrap_or(false);
    let Owed { session, claims, who, .. } = owed;
    if in_answer {
        count("deferred_delivered", defaults::text("stop_channel.all_label"), &who);
        if let Err(f) = claims.release() {
            count("state_failed", f.label(), &who); // delivered; a claim that stays is recovered (and delivered again) after the claim timeout
        }
        return;
    }
    count("state_failed", Fail::Undelivered.label(), &who);
    // put back under the lock; a failure leaves the claim, which a later prompt delivers after the claim timeout
    if let Err(f) = stopstate::lock(&session).and_then(|g| g.restore(claims)) {
        count("state_failed", f.label(), &who);
    }
}

/// A prompt starts a new chain (the count and the ceiling) and carries the notes held at an earlier Stop, once, as its `additionalContext`.
/// With the channel off, or on a host that is not listed, nothing is read, reset or consumed; a prompt whose answer is a block restarts
/// nothing and consumes nothing. The notes are claimed here but removed only by [`settle`], after the answer was written.
fn on_prompt(host: &str, session: &str, event: &str, p: &Value, env: &RequestEnv, results: &mut Vec<HookResult>) {
    let sw = Switches::read(&Settings::from_env(env));
    if !sw.any() || !defaults::list("stop_channel.hosts").contains(&host) || !stopstate::dir().is_dir() {
        return; // off, another host, or the channel never used on this machine: nothing to reset or deliver
    }
    claim_for_prompt(session, event, p, results);
}

/// The part of [`on_prompt`] that runs with the channel on: restart the chain, claim the held notes and add them to the answer.
fn claim_for_prompt(session: &str, event: &str, p: &Value, results: &mut Vec<HookResult>) {
    if results.iter().any(combine::blocks) {
        return; // the prompt is refused: no turn starts, so nothing restarts and no note is consumed
    }
    let who = labels(p);
    let bail = |f: Fail| count("state_failed", f.label(), &who);
    let guard = match stopstate::lock(session) {
        Ok(g) => g,
        Err(f) => return bail(f),
    };
    if let Err(f) = guard.clear() {
        return bail(f); // a chain that cannot be restarted delivers nothing either
    }
    let claims = match guard.claim() {
        Ok(c) => c,
        Err(f) => return bail(f),
    };
    drop(guard);
    if claims.notes.is_empty() {
        if let Err(f) = claims.release() {
            bail(f); // only empty claim files were there: a failure to remove one is counted
        }
        return;
    }
    let joiner = defaults::text("dispatch.context_joiner");
    let body = claims.notes.iter().map(|n| n.text.as_str()).collect::<Vec<_>>().join(joiner);
    let text = format!("{}{body}", defaults::text("stop_channel.msg_held_prefix"));
    let out = format!("{}\n", json!({HSO: {EVENT: event, CTX: text}}));
    results.push(HookResult { id: defaults::text("stop_channel.delivery_id").to_string(), code: Some(0), out, err: String::new() });
    OWED.with(|o| *o.borrow_mut() = Some(Owed { session: session.to_string(), claims, text, who: who.clone() }));
}

/// Does an answer already continue the turn at `event` (a hard block, or Stop `additionalContext`)? Text added to it costs no further
/// continuation.
fn continues(existing: &str, event: &str) -> bool {
    combine::json_blocks(existing)
        || object_of(existing)
            .and_then(|v| v.get(HSO).cloned())
            .is_some_and(|h| h.get(EVENT).and_then(Value::as_str) == Some(event) && h.get(CTX).and_then(Value::as_str).is_some_and(|t| !t.is_empty()))
}

/// Does the engine-health advisory go to the model at this event (the merge into a Stop answer)? Only when the Stop channel is on
/// for the `stop_channel.health_check` pseudo-check on a host that honours Stop `additionalContext`, and under the same cap and
/// pending-work guard as a check's note: `raw` is the payload of the call (its session), `existing` the answer so far. An answer that
/// already continues the turn takes the text without a further continuation.
pub fn health_to_context(host: &str, event: &str, raw: &str, existing: &str) -> bool {
    if !defaults::list("stop_channel.events").contains(&event) || !defaults::list("stop_channel.hosts").contains(&host) {
        return false;
    }
    let env = RequestEnv::capture();
    let st = Settings::from_env(&env);
    let sw = Switches::read(&st);
    let check = defaults::text("stop_channel.health_check");
    if !sw.enabled(check) {
        return false;
    }
    let p: Value = serde_json::from_str(raw).unwrap_or(Value::Null);
    let who = labels(&p);
    if continues(existing, event) {
        count("soft_block", check, &who);
        return true;
    }
    let session = stoploop::safe(Some(&p), "session_id");
    if session.is_empty() {
        return false; // no session to count a chain under
    }
    let note = [Note { at: 0, check: check.to_string(), text: String::new(), from_stderr: false }];
    let pending = if sw.defer {
        match pending_work(&p, &session, &st) {
            Ok(b) => b,
            Err(f) => return fail_false(f, &note, &who),
        }
    } else {
        false
    };
    let guard = match stopstate::lock(&session) {
        Ok(g) => g,
        Err(f) => return fail_false(f, &note, &who),
    };
    let next = match next_chain(&guard, &p, sw.cap, sw.ceiling) {
        Ok(Step::Go(c)) => c,
        Ok(bound) => {
            bound_hit(&bound, &note, &who);
            return false;
        }
        Err(f) => return fail_false(f, &note, &who),
    };
    if pending {
        count("system_message", check, &who); // the advisory is once per session: it stays where it was rather than waiting for a prompt
        return false;
    }
    if let Err(f) = guard.save(next).and_then(|()| guard.verify()) {
        return fail_false(f, &note, &who);
    }
    count("soft_block", check, &who);
    true
}

/// [`failed`] for a caller that answers "no soft block".
fn fail_false(f: Fail, notes: &[Note], who: &(String, String)) -> bool {
    failed(f, notes, who);
    false
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

    // ---- the held note is consumed only when the answer carries it (PR #561 second review, property 1) ----

    fn unique(tag: &str) -> String {
        static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        format!("ut-chan-{tag}-{}-{}", std::process::id(), N.fetch_add(1, std::sync::atomic::Ordering::Relaxed))
    }

    fn held(s: &str, text: &str) {
        stopstate::lock(s).unwrap().hold(&[("tasklist-guard", text)], 4000).unwrap();
    }

    fn pass() -> HookResult {
        HookResult { id: "other".into(), code: Some(0), out: String::new(), err: String::new() }
    }

    fn answer(ctx: &str) -> crate::client::Outcome {
        crate::client::Outcome { out: format!("{}\n", json!({HSO: {EVENT: "UserPromptSubmit", CTX: ctx}})), code: 0, err: String::new() }
    }

    fn payload(s: &str) -> Value {
        json!({"session_id": s, "cwd": "/", "hook_event_name": "UserPromptSubmit"})
    }

    fn note_file(s: &str) -> PathBuf {
        dir().join(format!("{s}{}", defaults::text("stop_channel.note_suffix")))
    }

    fn files_of(s: &str) -> Vec<String> {
        std::fs::read_dir(dir())
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.starts_with(s) && !n.ends_with(".lock"))
            .collect()
    }

    /// A prompt whose answer is a block starts no turn: it claims nothing, restarts nothing, and the note stays held.
    #[test]
    fn a_blocked_prompt_does_not_claim_the_held_note() {
        let s = unique("blocked");
        held(&s, "advice");
        stopstate::lock(&s).unwrap().save(Chain { n: 2, t: 2, off: 1 }).unwrap();
        let mut results = vec![HookResult { id: "guard".into(), code: Some(2), out: String::new(), err: "blocked".into() }];
        claim_for_prompt(&s, "UserPromptSubmit", &payload(&s), &mut results);
        assert_eq!(results.len(), 1, "nothing was added to a blocked answer");
        assert!(note_file(&s).is_file(), "the note is still held");
        assert_eq!(stopstate::lock(&s).unwrap().chain().unwrap(), Chain { n: 2, t: 2, off: 1 }, "and the chain was not restarted");
        let json_block = HookResult { id: "guard".into(), code: Some(0), out: "{\"decision\":\"block\",\"reason\":\"no\"}".into(), err: String::new() };
        claim_for_prompt(&s, "UserPromptSubmit", &payload(&s), &mut vec![json_block]);
        assert!(note_file(&s).is_file(), "a JSON block is a block too");
    }

    /// The claim is removed only when the written answer carries the note whole.
    #[test]
    fn the_claim_is_removed_after_an_answer_that_carries_the_note() {
        let s = unique("carried");
        held(&s, "advice A");
        let mut results = vec![pass()];
        claim_for_prompt(&s, "UserPromptSubmit", &payload(&s), &mut results);
        assert_eq!(results.len(), 2);
        assert!(!note_file(&s).exists(), "claimed");
        assert_eq!(files_of(&s).len(), 1, "and the claim file is kept until the answer is written: {:?}", files_of(&s));
        let ctx = results[1].out.clone();
        let text = serde_json::from_str::<Value>(&ctx).unwrap()[HSO][CTX].as_str().unwrap().to_string();
        assert!(text.ends_with("advice A") && text.starts_with(defaults::text("stop_channel.msg_held_prefix")));
        settle(&answer(&format!("other context\n{text}")));
        assert!(files_of(&s).is_empty(), "delivered: nothing left: {:?}", files_of(&s));
        settle(&answer("again")); // nothing is owed any more
    }

    /// An answer that was blocked, or that does not carry the note (cut, spilled), puts the note back: never lost, delivered at the next prompt.
    #[test]
    fn an_answer_that_does_not_carry_the_note_puts_it_back() {
        for outcome in [
            crate::client::Outcome { out: String::new(), code: 2, err: "blocked later".into() },
            crate::client::Outcome { out: "{\"decision\":\"block\",\"reason\":\"x\"}\n".into(), code: 0, err: String::new() },
            answer("a spill pointer, not the note"),
            crate::client::Outcome { out: "plain".into(), code: 0, err: String::new() },
        ] {
            let s = unique("back");
            held(&s, "advice B");
            claim_for_prompt(&s, "UserPromptSubmit", &payload(&s), &mut vec![pass()]);
            assert!(!note_file(&s).exists());
            settle(&outcome);
            assert!(note_file(&s).is_file(), "put back for the next prompt: {:?} {:?}", outcome.out, files_of(&s));
            assert_eq!(files_of(&s).len(), 1, "and no claim is left behind: {:?}", files_of(&s));
            let mut results = vec![pass()];
            claim_for_prompt(&s, "UserPromptSubmit", &payload(&s), &mut results);
            assert!(results[1].out.contains("advice B"), "delivered at the next prompt");
            settle(&answer(results[1].out.trim()));
            assert!(files_of(&s).is_empty(), "{:?}", files_of(&s));
        }
    }
}
