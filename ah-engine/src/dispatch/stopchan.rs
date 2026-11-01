//! The Stop channel (GH #540, plan v2 C1): advice a check says at Stop reaches the model only as Stop `additionalContext`.
//!
//! Lab result (plan v2 F5, F15): a Stop note sent as `systemMessage` is a warning for the user; the model never acts on it (0/10
//! followed, the same as silence), and the turn ends. The same note as Stop `additionalContext` makes the turn continue and is
//! followed 10/10 (a soft block). This module moves a check's Stop note from the one channel to the other, behind a switch that
//! ships OFF (`stop_channel.sw_main`, per check `stop_channel.check_on` / `check_off`).
//!
//! NO STATE. Nothing is written, held, queued or redelivered; every bound is read from the Stop payload and the transcript, so a
//! lost file, a new session id or two Stops at once cannot change what a call decides. A note moves only when ALL of these hold,
//! and every other case leaves the answer exactly as it is without the channel (plus one counter, metric `stop_channel`):
//!
//! - the answer is not a hard block (a blocker beside the notes still blocks, untouched): else `blocked_kept`;
//! - the payload carries the background-tasks array and it is empty (a continuation while background work runs would only make
//!   the turn poll; an absent field is unknown work): else `no_background_field` / `background_pending`;
//! - the combined Stop `additionalContext` stays within `stop_channel.context_max_chars` (the host keeps about 2000 characters
//!   inline): else `over_length`;
//! - the transcript shows fewer than `stop_channel.num_k` Stop continuations since the last human-typed prompt, or since the
//!   start of the transcript when it holds none (so an unattended run of notification turns is bounded too): else `over_k`; a
//!   transcript that cannot be read or understood: `transcript_unreadable`. The host's `stop_hook_active` flag is not used.
//!
//! Everything (switch, K, lists, texts, markers, sizes) is read from the plugin's `stop_channel.toml`.
use super::combine::{self, HookResult};
use crate::checks::git::util::Settings;
use crate::checks::guardkit::settings::{get_bool, get_number};
use crate::defaults;
use crate::reqenv::RequestEnv;
use crate::telemetry::emit;
use serde_json::{Map, Value, json};
use std::io::{Read, Seek, SeekFrom};

use super::combine::{HSO_CTX as CTX, HSO_EVENT as EVENT, HSO_KEY as HSO, TOP_MSG as MSG};

/// The switches, resolved once per call.
struct Switches {
    global: bool,
    k: u64,
}

impl Switches {
    fn read(st: &Settings) -> Switches {
        Switches { global: get_bool(st, defaults::raw("stop_channel.sw_main")), k: get_number(st, defaults::raw("stop_channel.num_k")).max(0.0) as u64 }
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

fn transcript_of(p: &Value) -> Option<&str> {
    p.get("transcript_path").and_then(Value::as_str).filter(|t| std::path::Path::new(t).is_absolute())
}

/// The funnel labels (model family, project) of the session, for the counters.
fn labels(p: &Value) -> (String, String) {
    let session = p.get("session_id").and_then(Value::as_str).unwrap_or("");
    let phash = crate::telemetry::project_hash(&crate::store::project_key(p.get("cwd").and_then(Value::as_str).unwrap_or("/")));
    let c = crate::funnel::ctx(session, p, &phash);
    (c.model, c.project)
}

fn count(outcome: &str, check: &str, who: &(String, String)) {
    emit::queue(emit::stop_channel(outcome, check, &who.0, &who.1));
}

// ---- the stateless chain bound ----

/// What one transcript line is, for the chain count.
enum Line {
    /// A prompt the human typed: the chain starts again after it.
    Human,
    /// A Stop continuation the host recorded (a Stop-hook feedback entry, or a Stop `additionalContext` attachment).
    Continuation,
    Other,
}

/// The text of a user line's message: a string content, or the first text block of a list.
fn message_text(v: &Value) -> &str {
    let content = v.get("message").and_then(|m| m.get("content"));
    match content {
        Some(Value::String(s)) => s,
        Some(Value::Array(blocks)) => blocks.first().and_then(|b| b.get("text")).and_then(Value::as_str).unwrap_or(""),
        _ => "",
    }
}

fn classify(v: &Value, event: &str) -> Line {
    let str_of = |x: Option<&Value>| x.and_then(Value::as_str).unwrap_or("").to_string();
    match v.get("type").and_then(Value::as_str) {
        Some("user") => {
            let kind = str_of(v.get("origin").and_then(|o| o.get("kind")));
            let source = str_of(v.get("promptSource"));
            if defaults::list("stop_channel.human_origin_kinds").iter().any(|k| *k == kind)
                || defaults::list("stop_channel.human_prompt_sources").iter().any(|s| *s == source)
            {
                Line::Human
            } else if message_text(v).trim_start().starts_with(defaults::text("stop_channel.feedback_prefix")) {
                Line::Continuation
            } else {
                Line::Other
            }
        }
        Some("attachment") => {
            let a = v.get("attachment");
            if str_of(a.and_then(|a| a.get("type"))) == defaults::text("stop_channel.attachment_type") && str_of(a.and_then(|a| a.get("hookEvent"))) == event {
                Line::Continuation
            } else {
                Line::Other
            }
        }
        _ => Line::Other,
    }
}

/// One transcript line as a JSON object with a string `type`; anything else is not a line of a known shape.
fn parse_line(seg: &[u8]) -> Option<Value> {
    let v: Value = serde_json::from_str(std::str::from_utf8(seg).ok()?).ok()?;
    (v.is_object() && v.get("type").and_then(Value::as_str).is_some()).then_some(v)
}

/// The continuations counted in a window of the transcript, newest line first, up to the last human prompt. `Ok(None)`: the window
/// starts inside the file and holds no human prompt, so it proves nothing (read a bigger one). A line that is not UTF-8 JSON of a
/// known shape is `Err` (the unfinished last line of a file being written is the one exception).
fn scan(buf: &[u8], partial_first: bool, event: &str) -> Result<Option<u64>, ()> {
    let segs: Vec<&[u8]> = buf.split(|b| *b == b'\n').collect();
    let ended = buf.last() == Some(&b'\n');
    let mut found = 0u64;
    for (i, seg) in segs.iter().enumerate().rev() {
        if i == 0 && partial_first {
            return Ok(None); // the first segment of a window that starts inside the file is cut
        }
        if seg.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let Some(v) = parse_line(seg) else {
            if i + 1 == segs.len() && !ended {
                continue; // the host is still writing this line
            }
            return Err(());
        };
        match classify(&v, event) {
            Line::Human => return Ok(Some(found)),
            Line::Continuation => found += 1,
            Line::Other => {}
        }
    }
    Ok(if partial_first { None } else { Some(found) })
}

/// The Stop continuations since the last human-typed prompt in the transcript at `path` (since its start when it has none). The end
/// of the file is read in a window that doubles up to `stop_channel.tail_max_bytes`; a file that is absent, empty, not a regular
/// file, unreadable, of an unknown shape or whose last human prompt is further back than the maximum is `Err`.
fn chain_len(path: &str, event: &str) -> Result<u64, ()> {
    let mut f = std::fs::File::open(path).map_err(|_| ())?;
    let meta = f.metadata().map_err(|_| ())?;
    let len = meta.len();
    if !meta.is_file() || len == 0 {
        return Err(());
    }
    let max = defaults::num("stop_channel.tail_max_bytes");
    let mut want = defaults::num("stop_channel.tail_start_bytes").min(max);
    loop {
        let win = want.min(len);
        let from = len.saturating_sub(win);
        f.seek(SeekFrom::Start(from)).map_err(|_| ())?;
        let mut buf = Vec::new();
        (&mut f).take(win).read_to_end(&mut buf).map_err(|_| ())?;
        if let Some(n) = scan(&buf, from > 0, event)? {
            return Ok(n);
        }
        if want >= max {
            return Err(());
        }
        want = want.saturating_mul(2).min(max);
    }
}

// ---- the gate ----

/// The verdict on one more soft block.
enum Gate {
    Go,
    /// The notes stay where they are; the outcome label to count.
    Stay(&'static str),
}

/// Is a continuation allowed? `ctx_chars` is the length the combined Stop `additionalContext` would have.
fn gate(p: &Value, event: &str, k: u64, ctx_chars: usize) -> Gate {
    match p.get(defaults::text("stop_channel.pending_field")) {
        Some(Value::Array(tasks)) if tasks.is_empty() => {}
        Some(Value::Array(_)) => return Gate::Stay("background_pending"),
        _ => return Gate::Stay("no_background_field"),
    }
    if ctx_chars as u64 > defaults::num("stop_channel.context_max_chars") {
        return Gate::Stay("over_length");
    }
    if k == 0 {
        return Gate::Stay("over_k");
    }
    let Some(path) = transcript_of(p) else { return Gate::Stay("transcript_unreadable") };
    match chain_len(path, event) {
        Ok(n) if n < k => Gate::Go,
        Ok(_) => Gate::Stay("over_k"),
        Err(()) => Gate::Stay("transcript_unreadable"),
    }
}

// ---- the transform ----

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

/// The notes that may move (a check in `stop_channel.user_only` keeps its banner where it is).
fn notes_of(results: &[HookResult], sw: &Switches) -> Vec<Note> {
    let user_only = defaults::list("stop_channel.user_only");
    let stderr_checks = defaults::list("stop_channel.stderr_checks");
    let mut out = Vec::new();
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
        if !user_only.contains(&check) && sw.enabled(check) {
            out.push(Note { at, check: check.to_string(), text, from_stderr });
        }
    }
    out
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

/// The characters the combined Stop `additionalContext` of an answer would have: every context already in `results`, then `extra`
/// (texts to add), with the joiner between pieces.
fn combined_chars(results: &[HookResult], extra: &[&str]) -> usize {
    let existing =
        results.iter().filter_map(|r| object_of(&r.out)).filter_map(|v| v.get(HSO).and_then(|h| h.get(CTX)).and_then(Value::as_str).map(|t| t.chars().count()));
    let pieces: Vec<usize> = existing.chain(extra.iter().map(|t| t.chars().count())).filter(|n| *n > 0).collect();
    let joiner = defaults::text("dispatch.context_joiner").chars().count();
    pieces.iter().sum::<usize>() + joiner * pieces.len().saturating_sub(1)
}

/// Apply the Stop channel to the results of one dispatch (`host`, `event`, payload `p`), before they are combined.
pub fn apply(host: &str, event: &str, p: &Value, env: &RequestEnv, results: &mut super::spill::Results) {
    if !defaults::list("stop_channel.events").contains(&event) || !defaults::list("stop_channel.hosts").contains(&host) {
        return;
    }
    let sw = Switches::read(&Settings::from_env(env));
    if !sw.any() {
        return;
    }
    let notes = notes_of(results, &sw);
    if notes.is_empty() {
        return;
    }
    let who = labels(p);
    let verdict = if results.iter().any(combine::blocks) {
        Gate::Stay("blocked_kept") // a hard block decides the answer (and continues the turn by itself); the notes beside it stay
    } else {
        let texts: Vec<&str> = notes.iter().map(|n| n.text.as_str()).collect();
        gate(p, event, sw.k, combined_chars(results, &texts))
    };
    if let Gate::Stay(outcome) = verdict {
        for n in &notes {
            count(outcome, &n.check, &who);
        }
        return;
    }
    for n in &notes {
        if let Some(r) = results.get_mut(n.at) {
            r.out = with_context(&r.out, event, &n.text, !n.from_stderr);
        }
        count("emitted", &n.check, &who);
    }
}

/// Does the engine-health advisory (`text`) go to the model at this event (the merge into a Stop answer)? Only when the Stop channel
/// is on for the `stop_channel.health_check` pseudo-check on a host that honours Stop `additionalContext`, and under the same gate as
/// a check's note: `raw` is the payload of the call, `existing` the answer so far (a hard block keeps the advisory on `systemMessage`).
pub fn health_to_context(host: &str, event: &str, raw: &str, existing: &str, text: &str) -> bool {
    if !defaults::list("stop_channel.events").contains(&event) || !defaults::list("stop_channel.hosts").contains(&host) {
        return false;
    }
    let sw = Switches::read(&Settings::from_env(&RequestEnv::capture()));
    let check = defaults::text("stop_channel.health_check");
    if !sw.enabled(check) {
        return false;
    }
    let p: Value = serde_json::from_str(raw).unwrap_or(Value::Null);
    let who = labels(&p);
    let verdict = if combine::json_blocks(existing) {
        Gate::Stay("blocked_kept")
    } else {
        let have = combined_chars(&[HookResult { id: String::new(), code: Some(0), out: existing.to_string(), err: String::new() }], &[text]);
        gate(&p, event, sw.k, have)
    };
    match verdict {
        Gate::Go => {
            count("emitted", check, &who);
            true
        }
        Gate::Stay(outcome) => {
            count(outcome, check, &who);
            false
        }
    }
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

    fn human() -> String {
        json!({"type": "user", "origin": {"kind": "human"}, "promptSource": "typed", "message": {"role": "user", "content": "go"}}).to_string()
    }
    fn typed_only() -> String {
        json!({"type": "user", "promptSource": "typed", "message": {"role": "user", "content": "go"}}).to_string()
    }
    fn notification() -> String {
        json!({"type": "user", "origin": {"kind": "task-notification"}, "promptSource": "system", "message": {"role": "user", "content": "<task-notification>x"}}).to_string()
    }
    fn feedback() -> String {
        json!({"type": "user", "isMeta": true, "message": {"role": "user", "content": "Stop hook feedback:\nsay it"}}).to_string()
    }
    fn attached() -> String {
        json!({"type": "attachment", "attachment": {"type": "hook_additional_context", "hookEvent": "Stop", "content": ["x"]}}).to_string()
    }
    fn lines(v: &[String]) -> Vec<u8> {
        format!("{}\n", v.join("\n")).into_bytes()
    }

    #[test]
    fn the_count_runs_from_the_end_to_the_last_human_prompt() {
        let t = [human(), feedback(), attached(), human(), notification(), feedback(), attached(), notification()];
        assert_eq!(scan(&lines(&t), false, "Stop"), Ok(Some(2)));
        let t = [feedback(), typed_only(), attached()];
        assert_eq!(scan(&lines(&t), false, "Stop"), Ok(Some(1)), "promptSource typed alone is a human prompt");
    }

    #[test]
    fn a_transcript_without_a_human_prompt_counts_from_its_start() {
        let t = [notification(), feedback(), notification(), attached(), notification()];
        assert_eq!(scan(&lines(&t), false, "Stop"), Ok(Some(2)));
        assert_eq!(scan(&lines(&t), true, "Stop"), Ok(None), "a window cut inside the file proves nothing without a human prompt");
    }

    #[test]
    fn a_continuation_of_another_event_or_a_tool_result_quoting_the_prefix_is_not_counted() {
        let other = json!({"type": "attachment", "attachment": {"type": "hook_additional_context", "hookEvent": "PostToolUse"}}).to_string();
        let quoted = json!({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "content": "Stop hook feedback: x"}]}}).to_string();
        assert_eq!(scan(&lines(&[other, quoted, human()]), false, "Stop"), Ok(Some(0)));
    }

    #[test]
    fn an_unknown_shape_or_a_bad_line_is_unreadable_but_a_line_still_being_written_is_not() {
        assert_eq!(scan(b"not json\n", false, "Stop"), Err(()));
        assert_eq!(scan(b"{\"no_type\":1}\n", false, "Stop"), Err(()));
        assert_eq!(scan(b"[1]\n", false, "Stop"), Err(()));
        assert_eq!(scan(&[0xff, 0xfe, b'\n'], false, "Stop"), Err(()), "not UTF-8");
        let mut half = lines(&[human(), feedback()]);
        half.extend_from_slice(b"{\"type\":\"assis");
        assert_eq!(scan(&half, false, "Stop"), Ok(Some(1)));
    }

    // ---- apply() on synthetic results ----

    /// A scratch HOME with the switch on and a transcript holding `lines`; the payload of a Stop whose gates all pass.
    fn rig(tag: &str, lines: &[String]) -> (std::path::PathBuf, RequestEnv, Value) {
        let dir = std::env::temp_dir().join(format!("ut-stopchan-{tag}-{}", std::process::id()));
        crate::discard::harmless(std::fs::remove_dir_all(&dir)); // keep: a leftover of an earlier run
        std::fs::create_dir_all(dir.join(".anti-hall")).unwrap();
        std::fs::write(dir.join(".anti-hall/settings.json"), r#"{"context":{"stopAdditionalContext":true}}"#).unwrap();
        let t = dir.join("t.jsonl");
        std::fs::write(&t, format!("{}\n", lines.join("\n"))).unwrap();
        let env = RequestEnv::from(std::collections::BTreeMap::from([(defaults::env_name("home").to_string(), dir.to_string_lossy().to_string())]));
        let p = json!({"session_id": "s", "cwd": "/", "hook_event_name": "Stop", "background_tasks": [], "transcript_path": t});
        (dir, env, p)
    }

    fn note(id: &str, text: &str) -> HookResult {
        HookResult { id: id.into(), code: Some(0), out: format!("{}\n", json!({"systemMessage": text})), err: String::new() }
    }

    /// A blocker beside notes: the block and every note are left exactly as they were, with the gates all open.
    #[test]
    fn a_note_beside_a_hard_block_stays_and_the_block_is_untouched() {
        let (dir, env, p) = rig("blocker", &[human()]);
        let block = |code, out: &str| HookResult { id: "task-guard".into(), code: Some(code), out: out.into(), err: "no".into() };
        for blocker in [block(2, ""), block(0, r#"{"decision":"block","reason":"open tasks"}"#)] {
            let mut results = vec![note("some-check", "advice"), blocker];
            apply("claude", "Stop", &p, &env, &mut results); // some-check is not listed; the global switch is on
            let mut control = vec![note("some-check", "advice")];
            apply("claude", "Stop", &p, &env, &mut control);
            assert!(control[0].out.contains("additionalContext"), "the control: with no blocker the gates are open: {:?}", control[0].out);
            assert_eq!(results[0].out, note("some-check", "advice").out, "the note beside a block stays on systemMessage");
            assert_eq!((results[1].code, results[1].err.as_str()), (Some(results[1].code.unwrap()), "no"));
        }
        crate::discard::harmless(std::fs::remove_dir_all(dir)); // keep: the scratch directory of this test
    }

    /// The combined context is bounded: a note that would push the answer past the cap stays where it was, and so does a note beside a
    /// context that is already long.
    #[test]
    fn a_combined_context_over_the_cap_moves_nothing() {
        let (dir, env, p) = rig("cap", &[human()]);
        let cap = defaults::num("stop_channel.context_max_chars") as usize;
        let mut long = vec![note("a", &"x".repeat(cap + 1))];
        apply("claude", "Stop", &p, &env, &mut long);
        assert_eq!(long[0].out, note("a", &"x".repeat(cap + 1)).out);
        // two notes that fit alone but not together (with the joiner)
        let half = "y".repeat(cap / 2);
        let mut two = vec![note("a", &half), note("b", &half)];
        apply("claude", "Stop", &p, &env, &mut two);
        assert!(two.iter().all(|r| !r.out.contains("additionalContext")), "{two:?}");
        // an existing context counts
        let existing =
            HookResult { id: "ctx".into(), code: Some(0), out: format!("{}\n", json!({HSO: {EVENT: "Stop", CTX: "c".repeat(cap)}})), err: String::new() };
        let mut beside = vec![existing, note("a", "short")];
        apply("claude", "Stop", &p, &env, &mut beside);
        assert!(!beside[1].out.contains("additionalContext"));
        let mut fits = vec![note("a", &"z".repeat(cap))];
        apply("claude", "Stop", &p, &env, &mut fits);
        assert!(fits[0].out.contains("additionalContext"), "exactly at the cap fits");
        crate::discard::harmless(std::fs::remove_dir_all(dir)); // keep: the scratch directory of this test
    }

    #[test]
    fn the_gate_names_the_reason_it_holds_a_note_back() {
        let (dir, _env, p) = rig("gate", &[human(), attached(), attached(), attached()]);
        assert!(matches!(gate(&p, "Stop", 4, 10), Gate::Go));
        assert!(matches!(gate(&p, "Stop", 3, 10), Gate::Stay("over_k")));
        assert!(matches!(gate(&p, "Stop", 0, 10), Gate::Stay("over_k")));
        assert!(matches!(gate(&p, "Stop", 4, 1_000_000), Gate::Stay("over_length")));
        let mut busy = p.clone();
        busy["background_tasks"] = json!([1]);
        assert!(matches!(gate(&busy, "Stop", 4, 10), Gate::Stay("background_pending")));
        busy.as_object_mut().unwrap().remove("background_tasks");
        assert!(matches!(gate(&busy, "Stop", 4, 10), Gate::Stay("no_background_field")));
        let mut lost = p.clone();
        lost["transcript_path"] = json!("/nonexistent/t.jsonl");
        assert!(matches!(gate(&lost, "Stop", 4, 10), Gate::Stay("transcript_unreadable")));
        crate::discard::harmless(std::fs::remove_dir_all(dir)); // keep: the scratch directory of this test
    }
}
