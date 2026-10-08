//! Tests of the sibling-sweep check: the matcher against the corpus (precision and recall), the turn reader, the decision
//! (fires, once per cause per turn, search or statement after the cause, continuation, cap, switch, child), and the follow-through
//! counting. Every test uses its own temporary home; none touches the real one.
use super::*;
use std::collections::HashMap;
use std::sync::Arc;

fn home(tag: &str) -> String {
    let d = std::env::temp_dir().join(format!("ah-sibsweep-{tag}-{}", std::process::id()));
    crate::discard::harmless(std::fs::remove_dir_all(&d)); // keep: a leftover from an earlier run may or may not exist
    std::fs::create_dir_all(d.join(".anti-hall")).unwrap();
    d.to_string_lossy().to_string()
}

/// The shipped settings, with no file layer (a home with no settings file).
fn tn() -> Arc<Tune> {
    let d = std::env::temp_dir().join(format!("ah-sibsweep-none-{}", std::process::id()));
    tune::load(&Paths { user: d.join("config.toml"), settings: Some(d.join("settings.json")) })
}

fn settings(home: &str) -> Settings {
    Settings { home: home.to_string(), env: HashMap::new() }
}

fn user(text: &str) -> String {
    json!({"type": "user", "message": {"role": "user", "content": text}}).to_string()
}

fn assistant(blocks: Value) -> String {
    json!({"type": "assistant", "message": {"role": "assistant", "content": blocks}}).to_string()
}

fn say(text: &str) -> String {
    assistant(json!([{"type": "text", "text": text}]))
}

fn tool(name: &str, input: Value) -> String {
    assistant(json!([{"type": "tool_use", "id": "t1", "name": name, "input": input}]))
}

fn result() -> String {
    json!({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": "ok"}]}}).to_string()
}

fn write(home: &str, name: &str, lines: &[String]) -> String {
    let p = format!("{home}/{name}");
    std::fs::write(&p, lines.join("\n") + "\n").unwrap();
    p
}

fn append(path: &str, lines: &[String]) {
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new().append(true).open(path).unwrap();
    writeln!(f, "{}", lines.join("\n")).unwrap();
}

const CAUSE: &str = "Root cause: `read_window` holds the file twice, so memory doubles. Fixed by streaming the lines.";

fn stop(home: &str, transcript: &str, reply: &str) -> Value {
    json!({"hook_event_name": "Stop", "session_id": "s1", "transcript_path": transcript, "last_assistant_message": reply, "cwd": home})
}

fn rows(home: &str) -> Vec<Value> {
    let p = format!("{home}/.anti-hall/{}", defaults::text("sibling_sweep.log"));
    std::fs::read_to_string(p).unwrap_or_default().lines().map(|l| serde_json::from_str(l).unwrap()).collect()
}

fn results(home: &str, event: &str, key: &str) -> Vec<String> {
    rows(home).iter().filter(|r| r["event"] == event).map(|r| r[key].as_str().unwrap().to_string()).collect()
}

fn text_of(v: &Verdict) -> String {
    match v {
        Verdict::Advisory(j) => serde_json::from_str::<Value>(j).unwrap()["reason"].as_str().unwrap().to_string(),
        other => panic!("not an advisory: {other:?}"),
    }
}

// ---- matcher ----------------------------------------------------------------------------------------------

/// The corpus: one JSON object per line, the message and whether it states a bug cause (`corpus.ndjson`, data not code).
fn corpus() -> Vec<(String, bool)> {
    // read at test time, never embedded (tests/no_compiled_config.rs)
    std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/checks/sibling_sweep/corpus.ndjson"))
        .expect("the corpus file is readable")
        .lines()
        .map(|l| {
            let v: Value = serde_json::from_str(l).expect("a corpus line is JSON");
            (v["msg"].as_str().expect("msg").to_string(), v["cause"].as_bool().expect("cause"))
        })
        .collect()
}

#[test]
fn corpus_precision_and_recall() {
    let corpus = corpus();
    let (mut tp, mut fp, mut fneg, mut tneg) = (0u32, 0u32, 0u32, 0u32);
    let (mut missed, mut false_alarms) = (Vec::new(), Vec::new());
    for (text, expect) in &corpus {
        let got = matcher::find_cause(&tn(), text).is_some();
        match (*expect, got) {
            (true, true) => tp += 1,
            (true, false) => {
                fneg += 1;
                missed.push(text.as_str());
            }
            (false, true) => {
                fp += 1;
                false_alarms.push(text.as_str());
            }
            (false, false) => tneg += 1,
        }
    }
    let precision = f64::from(tp) / f64::from(tp + fp);
    let recall = f64::from(tp) / f64::from(tp + fneg);
    eprintln!("sibling-sweep corpus: n={} tp={tp} fp={fp} fn={fneg} tn={tneg} precision={precision:.3} recall={recall:.3}", corpus.len());
    assert!(corpus.len() >= 60, "the corpus must hold at least 60 messages");
    assert!(false_alarms.is_empty(), "false alarms: {false_alarms:#?}");
    assert!(missed.is_empty(), "missed: {missed:#?}");
}

#[test]
fn the_pattern_is_named_from_the_message() {
    let c = matcher::find_cause(&tn(), CAUSE).unwrap();
    assert_eq!(c.pattern, "read_window");
    let plain = matcher::find_cause(&tn(), "The bug was that normalize lowercased the path before the check. Fixed.").unwrap();
    assert!(plain.pattern.starts_with("The bug was that normalize lowercased"), "{}", plain.pattern);
}

#[test]
fn a_cause_hash_is_stable_across_spacing_and_case() {
    let a = matcher::find_cause(&tn(), "Root cause: the cache key omits the tenant. Fixed.").unwrap();
    let b = matcher::find_cause(&tn(), "root cause:   the cache  key omits the TENANT. Fixed.").unwrap();
    assert_eq!(a.hash, b.hash);
}

#[test]
fn sweep_statements_are_recognised() {
    for t in [
        "Searched for other occurrences of the pattern: none.",
        "No other occurrences found with rg.",
        "I grepped for similar call sites and fixed all of them.",
        "All other call sites were updated.",
        "Sibling sweep: 3 hits, all fixed.",
    ] {
        assert!(matcher::states_sweep(&tn(), t), "{t}");
    }
    for t in ["Fixed it.", "Tests pass.", "The cause is the cache."] {
        assert!(!matcher::states_sweep(&tn(), t), "{t}");
    }
}

#[test]
fn tool_kinds() {
    let k = |n: &str, i: Value| turn::tool_kind(&tn(), &json!({"type": "tool_use", "name": n, "input": i}));
    assert_eq!(k("Grep", json!({"pattern": "x"})), ToolKind::Search);
    assert_eq!(k("Glob", json!({})), ToolKind::Search);
    assert_eq!(k("mcp__plugin_oh-my-claudecode_t__ast_grep_search", json!({})), ToolKind::Search);
    assert_eq!(k("Bash", json!({"command": "rg -n read_window src"})), ToolKind::Search);
    assert_eq!(k("Bash", json!({"command": "cd x && git grep -n foo"})), ToolKind::Search);
    assert_eq!(k("Bash", json!({"command": "cat f | grep x"})), ToolKind::Search);
    assert_eq!(k("Bash", json!({"command": "cargo test"})), ToolKind::Other);
    assert_eq!(k("Bash", json!({"command": "echo programming"})), ToolKind::Other);
    assert_eq!(k("Agent", json!({"subagent_type": "Explore"})), ToolKind::Search);
    assert_eq!(k("Agent", json!({"subagent_type": "general-purpose"})), ToolKind::Other);
    assert_eq!(k("Edit", json!({})), ToolKind::Edit);
    assert_eq!(k("Read", json!({})), ToolKind::Other);
}

// ---- turn reader ------------------------------------------------------------------------------------------

#[test]
fn the_turn_starts_at_the_last_human_prompt_and_skips_injected_and_meta_entries() {
    let h = home("turn");
    let meta = json!({"type": "user", "isMeta": true, "message": {"role": "user", "content": "Stop hook feedback: x"}}).to_string();
    let inj = user("<system-reminder>hello</system-reminder>");
    let p = write(&h, "t.jsonl", &[user("first"), say("old"), user("second"), say("a"), tool("Edit", json!({})), result(), meta, inj, say("b")]);
    let t = turn::read(&tn(), &p).unwrap();
    assert_eq!(t.events.len(), 3, "{:?}", t.events);
    assert_eq!(t.last_text.as_deref(), Some("b"));
    assert_ne!(t.id, "0");
}

#[test]
fn only_the_window_is_read_and_a_huge_line_is_skipped() {
    let h = home("window");
    let filler = "x".repeat(defaults::num("sibling_sweep.line_max_bytes") as usize + 10);
    let mut lines = vec![user("old prompt")];
    lines.extend(std::iter::repeat_n(json!({"type": "system", "content": "y".repeat(1000)}).to_string(), 1500));
    lines.push(json!({"type": "assistant", "message": {"content": [{"type": "text", "text": filler}]}}).to_string());
    lines.push(user("real prompt"));
    lines.push(say(CAUSE));
    let p = write(&h, "t.jsonl", &lines);
    let size = std::fs::metadata(&p).unwrap().len();
    assert!(size > defaults::num("sibling_sweep.window_bytes"), "the fixture must exceed the window");
    let t = turn::read(&tn(), &p).unwrap();
    assert_eq!(t.events.len(), 1);
    assert_eq!(t.last_text.as_deref(), Some(CAUSE));
}

// ---- decision ---------------------------------------------------------------------------------------------

#[test]
fn a_cause_in_a_fix_context_with_no_search_gets_one_reminder_naming_the_pattern() {
    let h = home("fire");
    let p = write(&h, "t.jsonl", &[user("fix the memory bug"), tool("Edit", json!({})), result(), say(CAUSE)]);
    let v = decide(&stop(&h, &p, CAUSE), &settings(&h), 1, None);
    let text = text_of(&v);
    assert!(text.contains("read_window"), "{text}");
    assert!(text.contains("search the codebase"), "{text}");
    assert!(
        serde_json::from_str::<Value>(match &v {
            Verdict::Advisory(j) => j,
            _ => unreachable!(),
        })
        .unwrap()["decision"]
            == "block"
    );
    assert_eq!(results(&h, "cause", "result"), ["reminded"]);
}

#[test]
fn once_per_cause_per_turn_then_again_in_a_new_turn() {
    let h = home("once");
    let p = write(&h, "t.jsonl", &[user("fix it"), tool("Edit", json!({})), result(), say(CAUSE)]);
    assert!(matches!(decide(&stop(&h, &p, CAUSE), &settings(&h), 1, None), Verdict::Advisory(_)));
    assert_eq!(decide(&stop(&h, &p, CAUSE), &settings(&h), 2, None), Verdict::Allow);
    assert_eq!(results(&h, "cause", "result"), ["reminded", "duplicate"]);
    append(&p, &[user("now fix the other one"), tool("Edit", json!({})), result(), say(CAUSE)]);
    assert!(matches!(decide(&stop(&h, &p, CAUSE), &settings(&h), 3, None), Verdict::Advisory(_)), "a new turn re-arms the cause");
}

#[test]
fn a_search_after_the_cause_statement_means_no_reminder_a_search_before_it_does_not() {
    let h = home("search");
    let after = write(
        &h,
        "a.jsonl",
        &[user("fix"), tool("Edit", json!({})), result(), say(CAUSE), tool("Grep", json!({"pattern": "read_window"})), result(), say("Fixed.")],
    );
    assert_eq!(decide(&stop(&h, &after, CAUSE), &settings(&h), 1, None), Verdict::Allow);
    assert_eq!(results(&h, "cause", "result"), ["swept"]);
    let before = write(&h, "b.jsonl", &[user("fix"), tool("Grep", json!({"pattern": "read_window"})), result(), tool("Edit", json!({})), result(), say(CAUSE)]);
    let mut p = stop(&h, &before, CAUSE);
    p["session_id"] = json!("s2");
    assert!(matches!(decide(&p, &settings(&h), 2, None), Verdict::Advisory(_)), "the investigation grep came before the statement");
}

#[test]
fn an_explicit_statement_of_the_search_means_no_reminder() {
    let h = home("stated");
    let msg = format!("{CAUSE} Searched for other occurrences with rg: none.");
    let p = write(&h, "t.jsonl", &[user("fix"), tool("Edit", json!({})), result(), say(&msg)]);
    assert_eq!(decide(&stop(&h, &p, &msg), &settings(&h), 1, None), Verdict::Allow);
    assert_eq!(results(&h, "cause", "result"), ["swept"]);
}

#[test]
fn no_fix_context_no_reminder() {
    let h = home("nofix");
    let msg = "The cause is the cache key, which omits the tenant.";
    let p = write(&h, "t.jsonl", &[user("why is it slow"), say(msg)]);
    assert_eq!(decide(&stop(&h, &p, msg), &settings(&h), 1, None), Verdict::Allow);
    assert_eq!(results(&h, "cause", "result"), ["no_fix_context"]);
}

#[test]
fn a_reply_without_a_cause_never_reads_the_transcript() {
    let h = home("quiet");
    let gone = format!("{h}/missing.jsonl");
    assert_eq!(decide(&stop(&h, &gone, "Done, tests pass."), &settings(&h), 1, None), Verdict::Allow);
    assert!(rows(&h).is_empty());
}

#[test]
fn a_stop_that_continues_a_stop_block_never_reminds() {
    let h = home("cont");
    let p = write(&h, "t.jsonl", &[user("fix"), tool("Edit", json!({})), result(), say(CAUSE)]);
    let mut payload = stop(&h, &p, CAUSE);
    payload["stop_hook_active"] = json!(true);
    assert_eq!(decide(&payload, &settings(&h), 1, None), Verdict::Allow);
    assert_eq!(results(&h, "cause", "result"), ["continuation"]);
}

#[test]
fn the_per_scope_cap_bounds_reminders() {
    let h = home("cap");
    let cap = defaults::num("sibling_sweep.max_per_scope");
    let mut fired = 0;
    for i in 0..cap + 3 {
        let msg = format!("Root cause: `site_{i}` drops the guard, so it fails. Fixed.");
        let p = write(&h, "t.jsonl", &[user(&format!("fix {i}")), tool("Edit", json!({})), result(), say(&msg)]);
        if matches!(decide(&stop(&h, &p, &msg), &settings(&h), i, None), Verdict::Advisory(_)) {
            fired += 1;
        }
    }
    assert_eq!(fired, cap);
    assert_eq!(results(&h, "cause", "result").iter().filter(|r| *r == "capped").count(), 3);
}

#[test]
fn the_switch_the_skip_file_and_a_judge_child_silence_it() {
    let h = home("off");
    let p = write(&h, "t.jsonl", &[user("fix"), tool("Edit", json!({})), result(), say(CAUSE)]);
    let payload = stop(&h, &p, CAUSE);
    std::fs::write(format!("{h}/.anti-hall/settings.json"), r#"{"guards":{"siblingSweep":false}}"#).unwrap();
    assert_eq!(decide(&payload, &settings(&h), 1, None), Verdict::Allow);
    std::fs::write(format!("{h}/.anti-hall/settings.json"), r#"{"guards":{"siblingSweep":true}}"#).unwrap();
    assert!(matches!(decide(&payload, &settings(&h), 2, None), Verdict::Advisory(_)), "on is the default and an explicit on");
    let h2 = home("off2");
    let mut st = settings(&h2);
    st.env.insert("ANTIHALL_JUDGE_CHILD".into(), "1".into());
    let p2 = write(&h2, "t.jsonl", &[user("fix"), tool("Edit", json!({})), result(), say(CAUSE)]);
    assert_eq!(decide(&stop(&h2, &p2, CAUSE), &st, 3, None), Verdict::Allow);
    let h3 = home("off3");
    let p3 = write(&h3, "t.jsonl", &[user("fix"), tool("Edit", json!({})), result(), say(CAUSE)]);
    let far = (std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() + 600_000) as u64;
    std::fs::write(format!("{h3}/.anti-hall/skip.json"), format!("{{\"sibling-sweep\":{far}}}")).unwrap();
    assert_eq!(decide(&stop(&h3, &p3, CAUSE), &settings(&h3), 4, None), Verdict::Allow);
}

#[test]
fn other_events_and_missing_inputs_allow() {
    let h = home("misc");
    let p = write(&h, "t.jsonl", &[user("fix"), tool("Edit", json!({})), result(), say(CAUSE)]);
    let mut other = stop(&h, &p, CAUSE);
    other["hook_event_name"] = json!("PostToolUse");
    assert_eq!(decide(&other, &settings(&h), 1, None), Verdict::Allow);
    let mut nosession = stop(&h, &p, CAUSE);
    nosession["session_id"] = json!("");
    assert_eq!(decide(&nosession, &settings(&h), 1, None), Verdict::Allow);
    let mut notranscript = stop(&h, &p, CAUSE);
    notranscript["transcript_path"] = json!("");
    assert_eq!(decide(&notranscript, &settings(&h), 1, None), Verdict::Allow);
    assert_eq!(decide(&stop("", &p, CAUSE), &settings(""), 1, None), Verdict::Allow);
}

#[test]
fn a_subagent_stop_reads_its_own_transcript_and_has_its_own_scope() {
    let h = home("sub");
    let own = write(&h, "agent.jsonl", &[user("task"), tool("Edit", json!({})), result(), say(CAUSE)]);
    let parent = write(&h, "parent.jsonl", &[user("p"), say("working")]);
    let payload = json!({"hook_event_name": "SubagentStop", "session_id": "s1", "agent_id": "a9", "transcript_path": parent, "agent_transcript_path": own, "last_assistant_message": CAUSE});
    assert!(matches!(decide(&payload, &settings(&h), 1, None), Verdict::Advisory(_)));
    assert_eq!(rows(&h)[0]["scope"], "subagent");
    assert!(std::path::Path::new(&format!("{h}/.anti-hall/sibling-sweep-s1-a9.json")).exists());
}

// ---- follow-through ---------------------------------------------------------------------------------------

fn fire(h: &str, tag: &str) -> String {
    let p = write(h, &format!("{tag}.jsonl"), &[user("fix"), tool("Edit", json!({})), result(), say(CAUSE)]);
    assert!(matches!(decide(&stop(h, &p, CAUSE), &settings(h), 1, None), Verdict::Advisory(_)));
    p
}

fn continuation(h: &str, p: &str, reply: &str) -> Value {
    let mut v = stop(h, p, reply);
    v["stop_hook_active"] = json!(true);
    v
}

#[test]
fn follow_through_followed_when_a_search_comes_within_the_window() {
    let h = home("ft1");
    let p = fire(&h, "t");
    append(&p, &[tool("Read", json!({})), result(), tool("Grep", json!({"pattern": "read_window"})), result(), say("Searched: no other occurrences. Done.")]);
    decide(&continuation(&h, &p, "Searched: no other occurrences. Done."), &settings(&h), 2, None);
    assert_eq!(results(&h, "followthrough", "outcome"), ["followed"]);
    let r = rows(&h);
    assert_eq!(r.iter().find(|x| x["event"] == "followthrough").unwrap()["tool_calls"], 2);
}

#[test]
fn follow_through_ignored_when_no_search_comes() {
    let h = home("ft2");
    let p = fire(&h, "t");
    append(&p, &[tool("Bash", json!({"command": "cargo test"})), result(), say("All green.")]);
    decide(&continuation(&h, &p, "All green."), &settings(&h), 2, None);
    assert_eq!(results(&h, "followthrough", "outcome"), ["ignored"]);
}

#[test]
fn a_search_beyond_the_window_does_not_count() {
    let h = home("ft3");
    let p = fire(&h, "t");
    let mut more: Vec<String> = Vec::new();
    for _ in 0..defaults::num("sibling_sweep.follow_window") {
        more.push(tool("Read", json!({})));
        more.push(result());
    }
    more.push(tool("Grep", json!({"pattern": "x"})));
    more.push(result());
    append(&p, &more);
    decide(&continuation(&h, &p, "ok"), &settings(&h), 2, None);
    assert_eq!(results(&h, "followthrough", "outcome"), ["ignored"]);
}

#[test]
fn follow_through_unknown_when_the_turn_changed_and_it_resolves_once() {
    let h = home("ft4");
    let p = fire(&h, "t");
    append(&p, &[user("something else"), say("sure")]);
    decide(&stop(&h, &p, "sure"), &settings(&h), 2, None);
    assert_eq!(results(&h, "followthrough", "outcome"), ["unknown"]);
    decide(&stop(&h, &p, "sure"), &settings(&h), 3, None);
    assert_eq!(results(&h, "followthrough", "outcome").len(), 1, "a resolved reminder is not resolved twice");
}

// ---- bounds -----------------------------------------------------------------------------------------------

#[test]
fn the_telemetry_log_is_bounded() {
    let h = home("log");
    let path = format!("{h}/.anti-hall/{}", defaults::text("sibling_sweep.log"));
    std::fs::create_dir_all(std::path::Path::new(&path).parent().unwrap()).unwrap();
    std::fs::write(&path, "x".repeat(defaults::num("sibling_sweep.log_max_bytes") as usize + 1)).unwrap();
    log_row(&tn(), &settings(&h), &json!({"event": "cause"}));
    assert!(std::fs::metadata(&path).unwrap().len() < 100, "the log is emptied once over its cap");
}

#[test]
fn state_round_trips_and_a_bad_state_file_reads_as_empty() {
    let h = home("state");
    let path = state_path(&tn(), &settings(&h), "s/1", "");
    let s = State { fired: 2, turn: "9".into(), causes: vec!["a".into()], pending: Some(("c".into(), "9".into())) };
    save(&path, &s).unwrap();
    assert_eq!(load(&path), s);
    std::fs::write(&path, "{not json").unwrap();
    assert_eq!(load(&path), State::default());
    assert!(!path.to_string_lossy().contains("s/1"), "the session id is sanitised");
}

// ---- runtime settings: a file edit, not a rebuild -----------------------------------------------------------

/// Write `<home>/.anti-hall/settings.json` with the given `sibling_sweep` section.
fn configure(h: &str, section: Value) {
    std::fs::write(format!("{h}/.anti-hall/settings.json"), json!({"sibling_sweep": section}).to_string()).unwrap();
}

#[test]
fn trigger_phrases_are_a_settings_file_edit() {
    let h = home("cfg-cues");
    let msg = "Zorp located: `site_a` loses the lock. Fixed.";
    let p = write(&h, "t.jsonl", &[user("fix"), tool("Edit", json!({})), result(), say(msg)]);
    assert_eq!(decide(&stop(&h, &p, msg), &settings(&h), 1, None), Verdict::Allow, "not a cause statement by the shipped phrases");
    configure(&h, json!({"cause_cues": ["\\bzorp located\\b"]}));
    let v = decide(&stop(&h, &p, msg), &settings(&h), 2, None);
    assert!(matches!(v, Verdict::Advisory(_)), "the edited phrase list is read on the next call");
    let old = "Root cause: `site_b` loses the lock, so it fails. Fixed.";
    let p2 = write(&h, "u.jsonl", &[user("fix again"), tool("Edit", json!({})), result(), say(old)]);
    assert_eq!(decide(&stop(&h, &p2, old), &settings(&h), 3, None), Verdict::Allow, "the shipped phrases are replaced by the file's list");
}

#[test]
fn reminder_text_limits_and_window_are_settings() {
    let h = home("cfg-text");
    configure(&h, json!({"msg_instead": "grep the tree for the twin of this bug and report the hit count", "max_per_scope": 1, "follow_window": 1}));
    let p = write(&h, "t.jsonl", &[user("fix"), tool("Edit", json!({})), result(), say(CAUSE)]);
    let v = decide(&stop(&h, &p, CAUSE), &settings(&h), 1, None);
    assert!(text_of(&v).contains("grep the tree for the twin of this bug"), "{}", text_of(&v));
    // window of one call: a search as the second call after the reminded reply is not follow-through
    append(&p, &[tool("Read", json!({})), result(), tool("Grep", json!({"pattern": "x"})), result(), say("done")]);
    decide(&continuation(&h, &p, "done"), &settings(&h), 2, None);
    assert_eq!(results(&h, "followthrough", "outcome"), ["ignored"]);
    // one reminder per scope: the next cause is capped
    let other = "Root cause: `site_z` drops the guard, so it fails. Fixed.";
    let p2 = write(&h, "u.jsonl", &[user("again"), tool("Edit", json!({})), result(), say(other)]);
    assert_eq!(decide(&stop(&h, &p2, other), &settings(&h), 3, None), Verdict::Allow);
    assert_eq!(results(&h, "cause", "result").last().map(String::as_str), Some("capped"));
}

#[test]
fn an_invalid_pattern_in_the_file_falls_back_to_the_shipped_one() {
    let h = home("cfg-bad");
    configure(&h, json!({"hedge_any_re": "(unclosed", "cause_cues": ["(also unclosed"]}));
    let p = write(&h, "t.jsonl", &[user("fix"), tool("Edit", json!({})), result(), say(CAUSE)]);
    let t = tune::load(&Paths { user: format!("{h}/none.toml").into(), settings: Some(format!("{h}/.anti-hall/settings.json").into()) });
    assert!(t.problems.iter().any(|x| x.contains("hedge_any_re")), "{:?}", t.problems);
    assert!(matches!(decide(&stop(&h, &p, CAUSE), &settings(&h), 1, None), Verdict::Advisory(_)), "the shipped patterns keep the check working");
}

#[test]
fn the_state_write_does_not_depend_on_a_fixed_temporary_name() {
    // review P2 #8: the state went through `<state>.tmp-<pid>` without a flush; two writers of one process (the daemon's
    // workers) shared the name, and anything already at it broke the write
    let h = home("tmpname");
    let path = std::path::Path::new(&h).join("state.json");
    std::fs::create_dir_all(path.with_extension(format!("tmp-{}", std::process::id()))).unwrap();
    save(&path, &State::default()).unwrap();
    assert!(path.is_file());
}

#[test]
fn the_reminder_is_a_stop_block_and_the_module_doc_says_so() {
    // review P2 #11: the module doc said "never a block" while the reminder is the Stop continuation block
    let v: Value = serde_json::from_str(&reminder(&tn(), "x")).unwrap();
    assert_eq!(v["decision"], "block");
    let doc = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/checks/sibling_sweep/mod.rs")).unwrap();
    assert!(!doc.contains("never a block"), "the module doc must not deny the block it emits");
    assert!(doc.contains("The reminder IS a Stop block"));
}
