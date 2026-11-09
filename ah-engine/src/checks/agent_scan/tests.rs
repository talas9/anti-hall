//! Unit tests of the transcript agent scan. The line-level behavior is compared with `hooks/lib/agent-scan.js` by
//! `tests/agent_controls_parity.rs`; these pin the JavaScript semantics the scan re-implements by hand. The expected values
//! were computed with Node (`Date.parse`, `Date.prototype.toISOString`, `JSON.parse`).
use super::*;

#[test]
fn date_parse_matches_v8_for_the_forms_a_transcript_carries() {
    let table: &[(&str, f64)] = &[
        ("2026-10-06T12:00:00.000Z", 1791288000000.0),
        ("2026-10-06T12:00:00Z", 1791288000000.0),
        ("2026-10-06T12:00Z", 1791288000000.0),
        ("2026-10-06T12:00:00.1Z", 1791288000100.0),
        ("2026-10-06T12:00:00.12Z", 1791288000120.0),
        ("2026-10-06T12:00:00.12345Z", 1791288000123.0),
        ("2026-10-06T12:00:00.9999Z", 1791288000999.0),
        ("2026-10-06T12:00:00+02:00", 1791280800000.0),
        ("2026-10-06T12:00:00-05:30", 1791307800000.0),
        ("2026-10-06", 1791244800000.0),
        ("2026-02-30T00:00:00Z", 1772409600000.0),
        ("2026-02-31T10:00:00Z", 1772532000000.0),
        ("2026-04-31T00:00:00Z", 1777593600000.0),
        ("2024-02-29T23:59:59.999Z", 1709251199999.0),
        ("1970-01-01T00:00:00.000Z", 0.0),
        ("1969-12-31T23:59:59.999Z", -1.0),
        ("0000-01-01T00:00:00Z", -62167219200000.0),
        ("9999-12-31T23:59:59.999Z", 253402300799999.0),
        ("2000-03-01T00:00:00Z", 951868800000.0),
        ("1900-02-28T00:00:00Z", -2203977600000.0),
        ("2100-03-01T12:00:00.5Z", 4107585600500.0),
    ];
    for (s, want) in table {
        assert_eq!(date_parse(s), Ok(*want), "{s}");
    }
    for s in ["", "garbage", "May", "UTC"] {
        assert!(date_parse(s).unwrap().is_nan(), "{s:?} has no digit, so V8 reads none of it");
    }
}

#[test]
fn date_parse_defers_on_every_form_it_does_not_read_itself() {
    for s in [
        "2026-10-06T12:00:00",
        "Oct 6 2026 10:00:00",
        "1",
        "2026-10-06 12:00:00Z",
        "2026-13-01T00:00:00Z",
        "2026-10-06T24:00:00Z",
        "2026-10-06t12:00:00z",
        "+002026-10-06T00:00:00Z",
        "2026-10-06T12:00:00+0200",
    ] {
        assert_eq!(date_parse(s), Err(Unsupported), "{s}");
    }
}

#[test]
fn iso_utc_matches_to_iso_string() {
    for (ms, want) in [
        (0.0, "1970-01-01T00:00:00.000Z"),
        (1791288000123.0, "2026-10-06T12:00:00.123Z"),
        (-1.0, "1969-12-31T23:59:59.999Z"),
        (1709164799999.0, "2024-02-28T23:59:59.999Z"),
        (253402300799999.0, "9999-12-31T23:59:59.999Z"),
        (-62167219200000.0, "0000-01-01T00:00:00.000Z"),
    ] {
        assert_eq!(iso_utc(ms), want);
    }
    assert_eq!(hhmm(1791288000123.0), "12:00 UTC");
}

#[test]
fn json_that_only_javascript_reads_is_unsupported_and_real_garbage_is_not() {
    // JSON.parse accepts all of these; serde does not.
    for s in ["1e999", &format!("{}1{}", "[".repeat(300), "]".repeat(300))] {
        assert_eq!(parse_json(s), Err(Unsupported), "{s:.40}");
    }
    // a lone surrogate escape is read as JavaScript reads it, the surrogate held as U+FFFD (#248)
    for (s, want) in [
        (r#"{"a":"\ud800"}"#, serde_json::json!({"a": "\u{fffd}"})),
        (r#""\udc00""#, serde_json::json!("\u{fffd}")),
        (r#"{"a":"\ud800\u0041"}"#, serde_json::json!({"a": "\u{fffd}A"})),
    ] {
        assert_eq!(parse_json(s), Ok(Some(want)), "{s:.40}");
    }
    // JSON.parse throws on these too.
    for s in ["{", "{\"a\":}", "", "tru", "{'a':1}", "[1,]", "01"] {
        assert_eq!(parse_json(s), Ok(None), "{s:?}");
    }
    assert!(matches!(parse_json(r#"{"a":[1,"x",null]}"#), Ok(Some(_))));
}

#[test]
fn extract_texts_follows_every_content_shape() {
    let v = serde_json::json!(["a", {"text": "b", "content": [{"text": "c"}, "d", 5, null]}, {"content": {"content": "e"}}, {"type": "x"}]);
    let mut out = Vec::new();
    extract_texts(&v, &mut out);
    assert_eq!(out, ["a", "b", "c", "d", "e"]);
}

#[test]
fn notification_texts_accept_only_a_real_notice() {
    let n = "<task-notification>\n<task-id>x</task-id>\n</task-notification>";
    let user = |c: Value| serde_json::json!({"type": "user", "message": {"content": c}});
    assert_eq!(notification_texts(&user(Value::String(n.into()))).len(), 1);
    assert_eq!(notification_texts(&user(Value::String(format!("\u{feff}\n {n}")))).len(), 1, "leading JS white space is skipped");
    assert_eq!(notification_texts(&user(Value::String(format!("quoting {n}")))).len(), 0);
    assert_eq!(notification_texts(&user(Value::String(format!("<system-reminder>\n\u{a0}{n}</system-reminder>")))).len(), 1);
    assert_eq!(notification_texts(&user(serde_json::json!([{"type": "text", "text": n}, {"type": "image"}, {"type": "text", "text": 5}]))).len(), 1);
    assert_eq!(notification_texts(&serde_json::json!({"type": "attachment", "attachment": {"prompt": n}})).len(), 1);
    assert_eq!(notification_texts(&serde_json::json!({"type": "queue-operation", "content": n})).len(), 1);
    assert_eq!(notification_texts(&serde_json::json!({"type": "assistant", "message": {"content": n}})).len(), 0);
}

#[test]
fn the_resume_result_is_recognised_only_as_the_harness_writes_it() {
    let id = "a180b191000d7a82e";
    let full = serde_json::json!({"success": true, "message": "Resuming agent a180b19 in the background", "resumedAgentId": id}).to_string();
    assert_eq!(parse_resume(&full), Ok(Some((id.into(), true))));
    assert_eq!(parse_resume("Resuming agent a180b19 (x)"), Ok(Some(("a180b19".into(), false))));
    assert_eq!(parse_resume("  RESUMING   AGENT a180b19"), Ok(Some(("a180b19".into(), false))));
    assert_eq!(parse_resume("it said Resuming agent a180b19"), Ok(None));
    assert_eq!(parse_resume(&serde_json::json!({"success": false, "message": "Resuming agent a180b19"}).to_string()), Ok(None));
    assert_eq!(parse_resume(&serde_json::json!({"success": true, "message": "Message queued"}).to_string()), Ok(None));
    assert_eq!(parse_resume(&serde_json::json!({"success": true, "resumedAgentId": "zz"}).to_string()), Ok(None));
    // a lone surrogate id is read as JavaScript reads it: not a hex id, so no resume (Node: the same) (#248)
    assert_eq!(parse_resume("{\"success\":true,\"resumedAgentId\":\"\\ud800\"}"), Ok(None));
}

#[test]
fn names_agent_matches_a_full_id_or_a_unique_prefix() {
    let mut launched: OMap<Rec> = OMap::default();
    let rec = || Rec {
        adopted: false,
        output_file: String::new(),
        description: String::new(),
        launched_at_ms: 0.0,
        tool_use_id: None,
        resumed_at_ms: None,
        teammate: false,
        last_seen_ms: f64::NAN,
        pending_message: false,
        task_type: String::new(),
        shell_kind: String::new(),
        spawn_input: None,
    };
    launched.set("a1b2c3d4e5f60718", rec());
    launched.set("a1b2c3d4ffffffff", rec());
    launched.set("0123456789abcdef", rec());
    let i = |s: &str| serde_json::json!({"to": s});
    assert_eq!(names_agent(Some(&i("a1b2c3d4e5f60718")), "a1b2c3d4e5f60718", &launched), Ok(true));
    assert_eq!(names_agent(Some(&i("a1b2c3d4e")), "a1b2c3d4e5f60718", &launched), Ok(true), "unique prefix");
    assert_eq!(names_agent(Some(&i("a1b2c3d4")), "a1b2c3d4e5f60718", &launched), Ok(false), "ambiguous prefix");
    assert_eq!(names_agent(Some(&i("0123456")), "0123456789abcdef", &launched), Ok(true));
    assert_eq!(names_agent(Some(&i("012345")), "0123456789abcdef", &launched), Ok(false), "shorter than 7");
    assert_eq!(names_agent(None, "0123456789abcdef", &launched), Ok(false));
    assert_eq!(names_agent(Some(&Value::Null), "0123456789abcdef", &launched), Ok(false));
    assert_eq!(names_agent(Some(&serde_json::json!({"n": 1.5})), "0123456789abcdef", &launched), Err(Unsupported), "a float prints differently in JavaScript");
    assert_eq!(names_agent(Some(&serde_json::json!({"n": 9007199254740993u64})), "x", &launched), Err(Unsupported));
}

#[test]
fn the_home_is_home_and_nothing_else() {
    let e = crate::reqenv::RequestEnv::from_pairs([("HOME", "/h"), ("USERPROFILE", "/u")]);
    assert_eq!(home_dir(&e).as_deref(), Some("/h"));
    assert_eq!(home_dir(&crate::reqenv::RequestEnv::from_pairs([("USERPROFILE", "/u")])), None);
    assert_eq!(home_dir(&crate::reqenv::RequestEnv::from_pairs([("HOME", "")])), None);
}

#[test]
fn path_helpers_follow_node() {
    assert_eq!(dir_of("/a/b/c.jsonl"), "/a/b");
    assert_eq!(dir_of("c.jsonl"), ".");
    assert_eq!(dir_of("/c.jsonl"), "/");
    assert_eq!(base_without_jsonl("/a/b/c.jsonl"), "c");
    assert_eq!(base_without_jsonl("/a/b/.jsonl"), ".jsonl");
    assert_eq!(base_without_jsonl("/a/b/c.txt"), "c.txt");
    assert_eq!(utf16_len("a\u{1F600}é"), 4);
}

fn launch_lines(id: &str) -> String {
    format!(
        r#"{{"type":"assistant","message":{{"role":"assistant","content":[{{"type":"tool_use","id":"l{id}","name":"Agent","input":{{"description":"{id}","name":"{id}","run_in_background":true,"prompt":"w"}}}}]}}}}"#
    ) + "\n"
        + &format!(
            r#"{{"type":"user","message":{{"role":"user","content":[{{"type":"tool_result","tool_use_id":"l{id}","content":"Async agent launched successfully.\nagentId: {id}\noutput_file: /nonexistent/tasks/{id}.output"}}]}}}}"#
        )
        + "\n"
}

/// A fresh directory for one completeness test, and a transcript in it holding one background launch after `filler_bytes` of filler.
fn swap_fixture(tag: &str, filler_bytes: usize) -> (std::path::PathBuf, std::path::PathBuf) {
    use std::io::Write;
    let dir = std::env::temp_dir().join(format!("ah-scan-{tag}-{}", std::process::id()));
    std::fs::remove_dir_all(&dir).ok();
    std::fs::create_dir_all(&dir).unwrap();
    let dir = std::fs::canonicalize(&dir).unwrap();
    let tp = dir.join("t.jsonl");
    let filler = format!(r#"{{"type":"assistant","message":{{"role":"assistant","content":[{{"type":"text","text":"{}"}}]}}}}"#, "x".repeat(900));
    let mut f = std::fs::File::create(&tp).unwrap();
    for _ in 0..(filler_bytes / filler.len()) {
        writeln!(f, "{filler}").unwrap();
    }
    write!(f, "{}", launch_lines("00000000000000b2")).unwrap();
    drop(f);
    (dir, tp)
}

fn proof_with_seam(tp: &std::path::Path, seam: Box<dyn FnOnce()>) -> Proof {
    test_seam::set(seam);
    let opts = Opts { now_ms: now_ms(), ignore_unanswered_stops: false };
    agent_count_proof(tp.to_str().unwrap(), &opts).unwrap()
}

/// #480 review: completeness comes from the handle the scan read, not a pathname lookup after it. A compaction that swaps a
/// shorter file in while the scan runs must leave the old, truncated tail incomplete (an owner outside it stays unknown).
#[test]
fn a_file_replaced_during_the_scan_is_never_complete() {
    let (dir, tp) = swap_fixture("swap", 13 * 1024 * 1024);
    let small = dir.join("small.jsonl");
    std::fs::write(&small, launch_lines("00000000000000b2")).unwrap();
    let (s, t) = (small.clone(), tp.clone());
    let proof = proof_with_seam(&tp, Box::new(move || std::fs::rename(&s, &t).unwrap()));
    std::fs::remove_dir_all(&dir).ok();
    assert!(proof.rows.as_ref().is_some_and(|r| !r.is_empty()), "the old tail still shows the agent");
    assert!(!proof.complete, "a swapped-in shorter file must not mark the truncated scan complete");
}

/// The same file truncated in place while the scan runs (same inode, shorter length): what the scan read is unknown.
#[test]
fn a_file_truncated_during_the_scan_is_never_complete() {
    let (dir, tp) = swap_fixture("trunc", 13 * 1024 * 1024);
    let t = tp.clone();
    let proof = proof_with_seam(
        &tp,
        Box::new(move || {
            let f = std::fs::OpenOptions::new().write(true).open(&t).unwrap();
            f.set_len(64).unwrap();
        }),
    );
    std::fs::remove_dir_all(&dir).ok();
    assert!(proof.rows.as_ref().is_some_and(|r| !r.is_empty()), "the scanned tail still shows the agent");
    assert!(!proof.complete, "a file truncated in place must not mark the scan complete");
}

/// A small transcript that only grows while the scan runs (an append) stays complete, as before the handle check.
#[test]
fn a_small_file_appended_during_the_scan_stays_complete() {
    let (dir, tp) = swap_fixture("grow", 0);
    let t = tp.clone();
    let proof = proof_with_seam(
        &tp,
        Box::new(move || {
            use std::io::Write;
            let mut f = std::fs::OpenOptions::new().append(true).open(&t).unwrap();
            writeln!(f, r#"{{"type":"assistant","message":{{"role":"assistant","content":[{{"type":"text","text":"more"}}]}}}}"#).unwrap();
        }),
    );
    std::fs::remove_dir_all(&dir).ok();
    assert!(proof.rows.as_ref().is_some_and(|r| !r.is_empty()), "the agent is seen");
    assert!(proof.complete, "an append to a file inside the window keeps the whole-file answer complete");
}

/// A small transcript left alone during the scan is complete.
#[test]
fn an_unchanged_small_file_is_complete() {
    let (dir, tp) = swap_fixture("same", 0);
    let proof = proof_with_seam(&tp, Box::new(|| {}));
    std::fs::remove_dir_all(&dir).ok();
    assert!(proof.rows.as_ref().is_some_and(|r| !r.is_empty()), "the agent is seen");
    assert!(proof.complete, "an unchanged file that fits the window is complete");
}

/// #480 review (P2): when the widening handle cannot be duplicated (EMFILE) the wide scan falls back to the default tail; an empty
/// result over a file longer than that tail (but within the wide window) proves nothing about the bytes before it: unknown.
#[test]
fn a_failed_widening_handle_never_proves_an_empty_count_complete() {
    use std::io::Write;
    let (dir, tp) = swap_fixture("noclone", 0);
    let filler = format!(r#"{{"type":"assistant","message":{{"role":"assistant","content":[{{"type":"text","text":"{}"}}]}}}}"#, "x".repeat(900));
    let mut f = std::fs::OpenOptions::new().append(true).open(&tp).unwrap();
    for _ in 0..(3 * 1024 * 1024 / filler.len()) {
        writeln!(f, "{filler}").unwrap();
    }
    drop(f);
    let wide = defaults::num("agent_scan.wide_tail_bytes");
    test_seam::fail_clone_at(Some(wide));
    let proof = proof_with_seam(&tp, Box::new(|| {}));
    test_seam::fail_clone_at(None);
    std::fs::remove_dir_all(&dir).ok();
    assert!(proof.rows.is_none(), "an empty scan of a tail that missed the launch must be unknown, not complete: {:?}", proof.complete);
    assert!(!proof.complete);
}

#[test]
fn an_answered_call_gives_up_its_input_unless_a_launch_or_a_retained_result_names_it() {
    let mut w = Walk::new();
    let mut seq = 0u64;
    // a launch: its input is what `spawnInput` reports, so it stays
    for l in launch_lines("aaaa1111").lines() {
        feed(&mut w, &mut seq, l.as_bytes()).unwrap();
    }
    // an Agent call whose result is not a launch (a foreground agent's answer): nothing reads its input again
    let call = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"lfg","name":"Agent","input":{"description":"fg","prompt":"a long prompt"}}]}}"#;
    let result = r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"lfg","content":"all done"}]}}"#;
    feed(&mut w, &mut seq, call.as_bytes()).unwrap();
    assert!(w.tool_uses.get("lfg").unwrap().input.is_some(), "kept while the call is unanswered");
    feed(&mut w, &mut seq, result.as_bytes()).unwrap();
    assert!(w.tool_uses.get("lfg").unwrap().input.is_none(), "released once answered");
    assert!(w.tool_uses.get("laaaa1111").unwrap().input.is_some(), "a launch record names it");
    let scan = finish(&w, 0, "", &Opts { now_ms: 0.0, ignore_unanswered_stops: false }).unwrap();
    let row = scan.launched.get("aaaa1111").unwrap();
    assert_eq!(row.spawn_input.as_deref().and_then(|v| v.get("prompt")).and_then(Value::as_str), Some("w"));
}

/// A scan as text: every field the answer is made of, sets sorted (two scans that print alike answer alike).
fn scan_text(r: &Res<Option<Scan>>) -> String {
    match r {
        Err(_) => "unsupported".into(),
        Ok(None) => "null".into(),
        Ok(Some(s)) => {
            let mut terminal: Vec<&String> = s.terminal.iter().collect();
            terminal.sort();
            let mut stopped: Vec<&String> = s.stopped_agents.iter().collect();
            stopped.sort();
            let launched: Vec<String> = s.launched.iter().map(|(k, r)| format!("{k}={r:?}")).collect();
            format!("launched {launched:?}\nterminal {terminal:?}\nstopped {stopped:?}\npending {:?}", s.pending)
        }
    }
}

/// The store's answer (or `None`: it could not answer) and the fresh scan's, for one window and mode.
fn store_and_fresh(path: &str, tail: u64, ignore: bool) -> (Option<Res<Option<Scan>>>, Res<Option<Scan>>) {
    let opts = Opts { now_ms: 1_800_000_000_000.0, ignore_unanswered_stops: ignore };
    let f = std::fs::File::open(path).unwrap();
    (scan_store(path, &f, tail, &opts), scan_transcript_uncached(path, tail, &opts))
}

/// Lines that exercise every step of the walk: launches, a foreground agent, resumes, a stop (answered and not), a teammate spawn,
/// send and idle report, notifications in each shape, a task_status attachment, a delivery call quoting an agent, ordinary calls.
fn walk_corpus() -> String {
    let ts = |i: u32| format!("2026-10-06T12:{:02}:{:02}.000Z", i / 60 % 60, i % 60);
    let mut out = String::new();
    let mut i = 0u32;
    let mut push = |s: String| {
        out.push_str(&s);
        out.push('\n');
    };
    for round in 0..40u32 {
        let id = format!("{:016x}", 0xa000 + round);
        let t = ts(i);
        i += 7;
        push(format!(
            r#"{{"type":"assistant","timestamp":"{t}","message":{{"role":"assistant","content":[{{"type":"tool_use","id":"l{id}","name":"Agent","input":{{"description":"d{id}","run_in_background":true,"prompt":"{}"}}}}]}}}}"#,
            "p".repeat((round as usize % 5) * 300)
        ));
        push(format!(
            r#"{{"type":"user","timestamp":"{t}","message":{{"role":"user","content":[{{"type":"tool_result","tool_use_id":"l{id}","content":"Async agent launched successfully.\nagentId: {id}\noutput_file: /nonexistent/tasks/{id}.output"}}]}}}}"#
        ));
        // an ordinary call answered later, with filler between
        push(format!(
            r#"{{"type":"assistant","timestamp":"{t}","message":{{"role":"assistant","content":[{{"type":"tool_use","id":"b{round}","name":"Bash","input":{{"command":"ls"}}}}]}}}}"#
        ));
        push(format!(
            r#"{{"type":"assistant","timestamp":"{t}","message":{{"role":"assistant","content":[{{"type":"text","text":"{}"}}]}}}}"#,
            "x".repeat(2000)
        ));
        push(format!(
            r#"{{"type":"user","timestamp":"{t}","message":{{"role":"user","content":[{{"type":"tool_result","tool_use_id":"b{round}","content":"out {id} {}"}}]}}}}"#,
            "y".repeat(500)
        ));
        match round % 6 {
            0 => push(format!(
                r#"{{"type":"user","timestamp":"{t}","message":{{"role":"user","content":"<task-notification>\n<task-id>{id}</task-id>\n<status>completed</status>\n</task-notification>"}}}}"#
            )),
            1 => {
                push(format!(
                    r#"{{"type":"assistant","timestamp":"{t}","message":{{"role":"assistant","content":[{{"type":"tool_use","id":"o{round}","name":"TaskOutput","input":{{"task_id":"{id}"}}}}]}}}}"#
                ));
                push(format!(
                    r#"{{"type":"user","timestamp":"{t}","message":{{"role":"user","content":[{{"type":"tool_result","tool_use_id":"o{round}","content":"agent {id} finished: all done"}}]}}}}"#
                ));
            }
            2 => {
                push(format!(
                    r#"{{"type":"assistant","timestamp":"{t}","message":{{"role":"assistant","content":[{{"type":"tool_use","id":"s{round}","name":"TaskStop","input":{{"task_id":"{id}"}}}}]}}}}"#
                ));
                if round % 4 == 0 {
                    push(format!(
                        r#"{{"type":"user","timestamp":"{t}","message":{{"role":"user","content":[{{"type":"tool_result","tool_use_id":"s{round}","content":"stopped"}}]}}}}"#
                    ));
                }
            }
            3 => {
                let name = format!("mate{round}");
                push(format!(
                    r#"{{"type":"assistant","timestamp":"{t}","message":{{"role":"assistant","content":[{{"type":"tool_use","id":"m{round}","name":"Agent","input":{{"description":"team {name}","name":"{name}"}}}}]}}}}"#
                ));
                push(format!(
                    r#"{{"type":"user","timestamp":"{t}","toolUseResult":{{"status":"teammate_spawned","name":"{name}","agent_id":"{name}@team"}},"message":{{"role":"user","content":[{{"type":"tool_result","tool_use_id":"m{round}","content":"spawned"}}]}}}}"#
                ));
                push(format!(
                    r#"{{"type":"assistant","timestamp":"{t}","message":{{"role":"assistant","content":[{{"type":"tool_use","id":"q{round}","name":"SendMessage","input":{{"to":"{name}","message":"hi"}}}}]}}}}"#
                ));
                push(format!(
                    r#"{{"type":"user","timestamp":"{t}","message":{{"role":"user","content":[{{"type":"tool_result","tool_use_id":"q{round}","content":"{{\"success\":true,\"message\":\"Message sent to {name}'s inbox\"}}"}}]}}}}"#
                ));
            }
            4 => push(format!(
                r#"{{"type":"attachment","timestamp":"{t}","attachment":{{"type":"task_status","taskId":"bg{round}","status":"running","description":"bash {round}","outputFilePath":"/x/{round}","taskType":"local_bash","shell":{{"kind":"bash"}}}}}}"#
            )),
            _ => {
                push(format!(
                    r#"{{"type":"assistant","timestamp":"{t}","message":{{"role":"assistant","content":[{{"type":"tool_use","id":"r{round}","name":"SendMessage","input":{{"to":"{id}","message":"continue"}}}}]}}}}"#
                ));
                push(format!(
                    r#"{{"type":"user","timestamp":"{t}","message":{{"role":"user","content":[{{"type":"tool_result","tool_use_id":"r{round}","content":"{{\"success\":true,\"message\":\"Agent resumed\",\"resumedAgentId\":\"{id}\"}}"}}]}}}}"#
                ));
            }
        }
    }
    out
}

/// The store answers every window like a fresh scan while the transcript grows in pieces cut anywhere (mid-line included), so
/// calls answered across refreshes, the unterminated last line and windows that start between a call and its answer are covered.
#[test]
fn the_store_answers_like_a_fresh_scan_while_the_transcript_grows() {
    use std::io::Write;
    let corpus = walk_corpus();
    let dir = std::env::temp_dir().join(format!("ah-scan-store-{}", std::process::id()));
    std::fs::remove_dir_all(&dir).ok();
    std::fs::create_dir_all(&dir).unwrap();
    let dir = std::fs::canonicalize(&dir).unwrap();
    let tp = dir.join("t.jsonl");
    let path = tp.to_str().unwrap().to_string();
    std::fs::write(&tp, "").unwrap();
    let bytes = corpus.as_bytes();
    let (mut at, mut step, mut hits, mut checks) = (0usize, 0u64, 0u32, 0u32);
    let mut rng = 0x2545_f491_4f6c_dd1du64;
    while at < bytes.len() {
        rng ^= rng << 13;
        rng ^= rng >> 7;
        rng ^= rng << 17;
        let n = (rng % 3000 + 1) as usize;
        let end = (at + n).min(bytes.len());
        std::fs::OpenOptions::new().append(true).open(&tp).unwrap().write_all(&bytes[at..end]).unwrap();
        at = end;
        step += 1;
        for tail in [700u64, 4_000, 20_000, 1 << 30] {
            for ignore in [false, true] {
                let (store, fresh) = store_and_fresh(&path, tail, ignore);
                checks += 1;
                if let Some(s) = store {
                    hits += 1;
                    assert_eq!(scan_text(&s), scan_text(&fresh), "step {step} at {at} tail {tail} ignore {ignore}");
                }
            }
        }
    }
    crate::transcript::store::global().drop_session(&tp);
    std::fs::remove_dir_all(&dir).ok();
    assert!(hits * 10 >= checks * 9, "the store answered {hits} of {checks} windows");
}

/// Once the store answers a transcript, the walks kept for it are dropped: one structure per transcript, not two.
#[test]
fn a_store_hit_drops_the_walks_kept_for_that_transcript() {
    let dir = std::fs::canonicalize(std::env::temp_dir()).unwrap().join(format!("ah-scan-evict-{}", std::process::id()));
    std::fs::remove_dir_all(&dir).ok();
    std::fs::create_dir_all(&dir).unwrap();
    let tp = dir.join("t.jsonl");
    let path = tp.to_str().unwrap().to_string();
    std::fs::write(&tp, walk_corpus()).unwrap();
    let opts = Opts { now_ms: 1_800_000_000_000.0, ignore_unanswered_stops: false };
    let f = std::fs::File::open(&tp).unwrap();
    let m = f.metadata().unwrap();
    // a walk is kept for the transcript (the store was cold or could not answer when it was built)
    assert!(scan_kept(&path, 1 << 30, &f, &m, &opts).is_ok());
    assert_eq!(kept_usage().0, 1, "the kept walk is there before the store answers");
    // the store builds the session off the request path: ask until it answers
    let end = std::time::Instant::now() + std::time::Duration::from_secs(20);
    let mut hit = None;
    while hit.is_none() && std::time::Instant::now() < end {
        hit = scan_store(&path, &f, 1 << 30, &opts);
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    assert!(hit.is_some(), "the store never answered");
    assert_eq!(kept_usage().0, 0, "a store hit drops the walks kept for that transcript");
    crate::transcript::store::global().drop_session(&tp);
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
#[ignore = "diagnostic: AH_WALK_SRC=<a.jsonl:b.jsonl> compares the store's answers with fresh scans on real transcripts"]
fn zz_store_parity_real() {
    let Ok(list) = std::env::var("AH_WALK_SRC") else { return };
    for p in list.split(':') {
        for tail in [1_500_000u64, 1_572_864, 12_000_000, 12_582_912, 64_000_000, 700_000_000] {
            for ignore in [false, true] {
                let t0 = std::time::Instant::now();
                let (store, fresh) = store_and_fresh(p, tail, ignore);
                let (a, b) = (store.as_ref().map(scan_text), scan_text(&fresh));
                let verdict = match &a {
                    None => "FALLBACK",
                    Some(a) if *a == b => "SAME",
                    Some(_) => "DIFF",
                };
                eprintln!("PARITY {p} tail {tail} ignore {ignore}: {verdict} ({} bytes, {:?})", b.len(), t0.elapsed());
                if verdict == "DIFF" {
                    let dump = std::env::temp_dir().join("ah-parity-diff");
                    std::fs::create_dir_all(&dump).ok();
                    std::fs::write(dump.join("store.txt"), a.unwrap_or_default()).ok();
                    std::fs::write(dump.join("fresh.txt"), &b).ok();
                    panic!("store and fresh scan differ on {p} tail {tail} ignore {ignore}; dumps in {}", dump.display());
                }
            }
        }
    }
}

#[test]
#[ignore = "diagnostic: AH_WALK_SRC=<transcript> prints a digest of what the scan answers over several windows"]
fn zz_scan_digest() {
    use std::hash::{Hash, Hasher};
    let Ok(p) = std::env::var("AH_WALK_SRC") else { return };
    for tail in [1_500_000.0, 12_000_000.0, 64_000_000.0, 700_000_000.0] {
        let out = crate::script::host_d::agent_scan(&p, tail, false) + &crate::script::host_d::agent_scan(&p, tail, true);
        let mut h = std::collections::hash_map::DefaultHasher::new();
        out.hash(&mut h);
        eprintln!("DIGEST {p} tail {tail}: {} bytes {:016x}", out.len(), h.finish());
    }
}
