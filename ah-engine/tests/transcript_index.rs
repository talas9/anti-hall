//! X1: the transcript index reads only appended bytes, survives truncation and rotation, and answers with the facts
//! the Node readers compute (`tests/transcript_parity.rs` checks the same facts against the Node code itself).

mod transcript_support;
use ah_engine::transcript::record::{js_trim, parse_ts_ms};
use ah_engine::transcript::{Index, Indexes, Limits, Rebuild, Refresh, Shape, TaskEvent};
use serde_json::json;
use transcript_support::*;

fn kinds(ix: &Index) -> Vec<(String, u64)> {
    ix.kind_counts().into_iter().collect()
}

#[test]
fn a_session_yields_every_fact() {
    let t = Tmp::new("tx");
    let f = t.path("s.jsonl");
    write(&f, &jsonl(&session()));
    let mut ix = Index::new(&f);
    assert_eq!(ix.refresh().unwrap(), Refresh::Appended { bytes: std::fs::metadata(&f).unwrap().len(), records: 11 });
    assert_eq!(ix.offset(), std::fs::metadata(&f).unwrap().len());
    assert_eq!(ix.records(), 11);
    assert_eq!(
        kinds(&ix),
        vec![
            ("assistant".to_string(), 3),
            ("attachment".to_string(), 1),
            ("queue-operation".to_string(), 1),
            ("summary".to_string(), 1),
            ("user".to_string(), 5)
        ]
    );
    let a = ix.last_assistant().unwrap();
    assert_eq!(a.text, "All done, tests pass.");
    // the legacy extraction repeats the text it reads from message.content (speculation-guard.js)
    assert_eq!(ix.last_assistant_legacy().unwrap().text, "All done, tests pass. All done, tests pass.");
    assert_eq!(a.seq, 10);
    assert_eq!(a.ts_ms, Some(1_791_108_000_000));
    assert_eq!(ix.last_prompt().unwrap().text, "please build the thing", "notifications and tool results are not prompts");
    let uses: Vec<(Option<&str>, &str)> = ix.recent_tool_uses(10).iter().map(|u| (u.id.as_deref(), u.name.as_str())).collect();
    assert_eq!(uses, vec![(Some("toolu_a"), "TaskCreate"), (Some("toolu_b"), "Bash"), (Some("toolu_c"), "Agent"), (Some("toolu_d"), "TaskUpdate")]);
    assert_eq!(ix.recent_tool_uses(2).len(), 2);
    assert_eq!(ix.recent_tool_uses(2)[1].name, "TaskUpdate");
    assert_eq!(ix.recent_tool_uses(1)[0].msg_id.as_deref(), Some("msg_3"));
    // only the task tools are kept as task events, with the results of their calls
    let ev = ix.task_events();
    assert_eq!(ev.len(), 4);
    assert!(matches!(ev[0], TaskEvent::Use(u) if u.name == "TaskCreate"));
    assert!(matches!(ev[1], TaskEvent::Result { tool_use_id, text, .. } if tool_use_id == "toolu_a" && text == "Task #1 created successfully: build"));
    assert!(matches!(ev[3], TaskEvent::Result { tool_use_id, .. } if tool_use_id == "toolu_d"));
    // three shapes, in order; terminal (agent-scan) and final (devswarm-idle) differ for `killed`
    let n = ix.notifications();
    assert_eq!(n.iter().map(|x| x.shape).collect::<Vec<_>>(), vec![Shape::User, Shape::Attachment, Shape::QueueOperation]);
    assert_eq!(ix.terminal_agents(), vec!["a111111111111111", "a222222222222222", "a333333333333333"]);
    assert_eq!(ix.finished_task_keys(), vec!["a111111111111111", "toolu_01ABCDEF", "a333333333333333", "toolu_01ABCDEF"]);
}

#[test]
fn only_appended_bytes_are_read_and_nothing_is_counted_twice() {
    let t = Tmp::new("tx");
    let f = t.path("s.jsonl");
    write(&f, &jsonl(&session()[..4]));
    let mut ix = Index::new(&f);
    ix.refresh().unwrap();
    assert_eq!(ix.refresh().unwrap(), Refresh::Unchanged);
    let more = jsonl(&session()[4..]);
    append(&f, &more);
    assert_eq!(ix.refresh().unwrap(), Refresh::Appended { bytes: more.len() as u64, records: 7 });
    assert_eq!(ix.records(), 11);
    assert_eq!(ix.generation(), 1);
    let mut again = Index::new(&f);
    again.refresh().unwrap();
    assert_eq!(kinds(&ix), kinds(&again), "incremental equals a fresh read");
    assert_eq!(ix.last_assistant(), again.last_assistant());
}

#[test]
fn an_unterminated_last_line_is_visible_once_and_counted_once() {
    let t = Tmp::new("tx");
    let f = t.path("s.jsonl");
    // no trailing newline, the way test fixtures and a writer mid-flush leave it
    let text = jsonl(&session()[..3]);
    write(&f, text.trim_end());
    let mut ix = Index::new(&f);
    ix.refresh().unwrap();
    assert_eq!(ix.records(), 3);
    assert_eq!(ix.last_assistant().unwrap().text, "On it. Creating tasks.");
    let two_lines: usize = text.lines().take(2).map(|l| l.len() + 1).sum();
    assert_eq!(ix.offset(), two_lines as u64, "the offset stops before the unterminated line");
    append(&f, "\n");
    ix.refresh().unwrap();
    assert_eq!(ix.records(), 3, "the completed line replaces its overlay");
    append(&f, &jsonl(&[user_text("next")]));
    ix.refresh().unwrap();
    assert_eq!(ix.records(), 4);
    assert_eq!(ix.last_prompt().unwrap().text, "next");
}

#[test]
fn a_half_written_line_is_ignored_until_it_is_complete() {
    let t = Tmp::new("tx");
    let f = t.path("s.jsonl");
    let full = jsonl(&[user_text("one"), assistant("m", &["two"], &[])]);
    let cut = full.len() - 20;
    write(&f, &full[..cut]);
    let mut ix = Index::new(&f);
    ix.refresh().unwrap();
    assert_eq!(ix.records(), 1, "the partial line does not parse and is not a record");
    assert!(ix.last_assistant().is_none());
    append(&f, &full[cut..]);
    ix.refresh().unwrap();
    assert_eq!(ix.records(), 2);
    assert_eq!(ix.last_assistant().unwrap().text, "two");
}

#[test]
fn truncation_rotation_and_rewrites_rebuild_from_the_file() {
    let t = Tmp::new("tx");
    let f = t.path("s.jsonl");
    write(&f, &jsonl(&session()));
    let mut ix = Index::new(&f);
    ix.refresh().unwrap();
    // truncated: the file got smaller than where the index had read to
    write(&f, &jsonl(&session()[..2]));
    assert_eq!(ix.refresh().unwrap(), Refresh::Rebuilt(Rebuild::Truncated));
    assert_eq!(ix.records(), 2);
    assert!(ix.last_assistant().is_none(), "facts of the old content are gone");
    assert_eq!(ix.generation(), 2);
    // rotated: a different file at the same path (the old one moved away)
    std::fs::rename(&f, t.path("old.jsonl")).unwrap();
    write(&f, &jsonl(&[user_text("fresh"), assistant("m9", &["new file"], &[])]));
    assert_eq!(ix.refresh().unwrap(), Refresh::Rebuilt(Rebuild::Rotated));
    assert_eq!(ix.last_assistant().unwrap().text, "new file");
    assert_eq!(ix.records(), 2);
    // rewritten in place, same length, same inode: the bytes before the offset changed
    let before = std::fs::read(&f).unwrap();
    let mut changed = before.clone();
    let n = changed.len();
    changed[n - 10..n - 2].copy_from_slice(b"XXXXXXXX");
    use std::io::{Seek, SeekFrom, Write};
    let mut h = std::fs::OpenOptions::new().write(true).open(&f).unwrap();
    h.seek(SeekFrom::Start(0)).unwrap();
    h.write_all(&changed).unwrap();
    drop(h);
    append(&f, &jsonl(&[user_text("after")]));
    assert_eq!(ix.refresh().unwrap(), Refresh::Rebuilt(Rebuild::Rewritten));
    assert_eq!(ix.last_prompt().unwrap().text, "after");
    // gone, then back
    std::fs::remove_file(&f).unwrap();
    assert_eq!(ix.refresh().unwrap(), Refresh::Missing);
    assert_eq!(ix.records(), 0);
    write(&f, &jsonl(&session()[..2]));
    ix.refresh().unwrap();
    assert_eq!(ix.records(), 2);
}

#[test]
fn an_empty_or_missing_file_is_missing_not_an_error() {
    let t = Tmp::new("tx");
    let mut ix = Index::new(t.path("nope.jsonl"));
    assert_eq!(ix.refresh().unwrap(), Refresh::Missing);
    write(&t.path("e.jsonl"), "");
    let mut ix = Index::new(t.path("e.jsonl"));
    assert_eq!(ix.refresh().unwrap(), Refresh::Missing);
}

#[test]
fn the_first_read_is_a_tail_window_that_drops_the_partial_first_line() {
    let t = Tmp::new("tx");
    let f = t.path("s.jsonl");
    let lines: Vec<_> = (0..50).map(|i| user_text(&format!("prompt number {i:03}"))).collect();
    let text = jsonl(&lines);
    write(&f, &text);
    let one = text.lines().next().unwrap().len() as u64 + 1;
    let mut lim = Limits::from_defaults();
    lim.initial_window = one * 10 + one / 2; // ten whole lines and half of the one before them
    let mut ix = Index::with_limits(&f, lim);
    ix.refresh().unwrap();
    assert_eq!(ix.records(), 10, "readTail: the partial first line of the window is dropped");
    assert_eq!(ix.last_prompt().unwrap().text, "prompt number 049");
    // appended bytes are then read incrementally, not as a new window
    append(&f, &jsonl(&[user_text("prompt number 050")]));
    assert_eq!(ix.refresh().unwrap(), Refresh::Appended { bytes: one, records: 1 });
    assert_eq!(ix.records(), 11);
}

#[test]
fn more_than_the_update_cap_appended_skips_ahead_and_counts_a_gap() {
    let t = Tmp::new("tx");
    let f = t.path("s.jsonl");
    write(&f, &jsonl(&[user_text("first")]));
    let mut lim = Limits::from_defaults();
    lim.max_update = 400;
    let mut ix = Index::with_limits(&f, lim);
    ix.refresh().unwrap();
    let lines: Vec<_> = (0..30).map(|i| user_text(&format!("burst {i:02}"))).collect();
    append(&f, &jsonl(&lines));
    ix.refresh().unwrap();
    assert_eq!(ix.gaps(), 1);
    assert!(ix.gap_bytes() > 0);
    assert_eq!(ix.last_prompt().unwrap().text, "burst 29", "the newest bytes are what matter");
    assert!(ix.records() < 31);
}

#[test]
fn flags_boundaries_and_prompts_follow_the_node_readers() {
    let t = Tmp::new("tx");
    let f = t.path("s.jsonl");
    write(
        &f,
        &jsonl(&[
            user_text("real prompt"),
            json!({"type": "user", "isMeta": true, "message": {"role": "user", "content": "caveat text"}}),
            user_text("<system-reminder>injected</system-reminder>"),
            user_text("<command-name>/compact</command-name>"),
            user_text("   "),
            json!({"type": "assistant", "isSidechain": true, "message": {"role": "assistant", "content": [{"type": "text", "text": "sub"}]}}),
            compact_boundary(),
            compact_summary(),
            json!({"type": "event_msg", "payload": {"type": "user_message", "message": "codex typed"}}),
        ]),
    );
    let mut ix = Index::new(&f);
    ix.refresh().unwrap();
    assert_eq!(ix.meta_rows(), 1);
    assert_eq!(ix.sidechain_rows(), 1);
    assert_eq!(ix.compact_boundaries(), 1);
    assert_eq!(ix.last_compact_boundary(), Some(7));
    assert_eq!(ix.compact_summary_rows(), 1);
    assert!(ix.last_assistant().unwrap().sidechain);
    // the compact summary is a user entry with real text: lastUserPrompt keeps it (it only skips isMeta and injected wrappers)
    assert_eq!(ix.last_prompt().unwrap().text, "codex typed");
    std::fs::write(
        t.path("c.jsonl"),
        jsonl(&[
            user_text("real prompt"),
            json!({"type": "user", "isMeta": true, "message": {"role": "user", "content": "caveat"}}),
            user_text("<system-reminder>x</system-reminder>"),
        ]),
    )
    .unwrap();
    let mut only_claude = Index::new(t.path("c.jsonl"));
    only_claude.refresh().unwrap();
    assert_eq!(only_claude.last_prompt().unwrap().text, "real prompt");
}

#[test]
fn notification_shapes_and_quoting_follow_devswarm_idle() {
    let t = Tmp::new("tx");
    let f = t.path("s.jsonl");
    let quoted = format!("I saw this earlier: {}", notification_text("quoted0000000000", "completed"));
    let wrapped = format!("<system-reminder>\n{}\n</system-reminder>", notification_text("wrapped000000000", "stopped"));
    let two = format!("{}\n{}", notification_text("one1111111111111", "completed"), notification_text("two2222222222222", " completed "));
    write(
        &f,
        &jsonl(&[
            user_text(&quoted),
            user_text(&wrapped),
            user_blocks(&["plain words", &notification_text("blocktext00000000", "failed")]),
            user_text(&two),
            notif_attachment("cancel0000000000", "canceled"),
            json!({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": notification_text("assistantquote000", "completed")}]}}),
        ]),
    );
    let mut ix = Index::new(&f);
    ix.refresh().unwrap();
    let ids: Vec<&str> = ix.notifications().iter().filter_map(|n| n.task_id.as_deref()).collect();
    assert_eq!(ids, vec!["wrapped000000000", "blocktext00000000", "one1111111111111", "two2222222222222", "cancel0000000000"]);
    // `" completed "` (padded) is final for devswarm-idle (it trims) but not terminal for agent-scan (exact match)
    assert_eq!(ix.terminal_agents(), vec!["wrapped000000000", "blocktext00000000", "one1111111111111", "cancel0000000000"]);
    let fin: Vec<&str> = ix.finished_task_keys();
    assert!(fin.contains(&"two2222222222222") && !fin.contains(&"cancel0000000000"));
}

#[test]
fn task_status_attachments_and_malformed_lines_and_kind_overflow() {
    let t = Tmp::new("tx");
    let f = t.path("s.jsonl");
    let mut text = jsonl(&[task_status_attachment("agent0000000001", "running"), task_status_attachment("agent0000000002", "completed")]);
    text.push_str("not json at all\n[1,2,3]\n\n   \n");
    for i in 0..6 {
        text.push_str(&format!("{{\"type\":\"kind{i}\"}}\n"));
    }
    text.push_str("{\"no_type\":1}\n");
    write(&f, &text);
    let mut lim = Limits::from_defaults();
    lim.max_kinds = 5;
    let mut ix = Index::with_limits(&f, lim);
    ix.refresh().unwrap();
    let ts = ix.task_statuses();
    assert_eq!((ts[0].task_id.as_str(), ts[0].status.as_str(), ts[0].output_file.as_str()), ("agent0000000001", "running", "/tmp/x/o"));
    assert_eq!(ts[1].status, "completed");
    let k = ix.kind_counts();
    assert_eq!(k["malformed"], 2, "a non-JSON line and a JSON array");
    assert_eq!(ix.records(), 2 + 2 + 6 + 1, "blank lines are not records");
    assert!(k.len() <= 5 + 1, "kinds beyond the limit share the overflow kind: {k:?}");
    assert!(k["other"] >= 1);
}

#[test]
fn caps_bound_every_kept_collection() {
    let t = Tmp::new("tx");
    let f = t.path("s.jsonl");
    let mut entries = Vec::new();
    for i in 0..40 {
        entries.push(assistant(&format!("m{i}"), &["x"], &[tool_use(&format!("t{i}"), "Bash", json!({"command": "y".repeat(100)}))]));
        entries.push(notif_user(&format!("agent{i:011}"), "completed"));
    }
    entries.push(assistant("big", &[&"z".repeat(500)], &[tool_use("tbig", "TaskCreate", json!({"subject": "s".repeat(300)}))]));
    entries.push(tool_result("tbig", &"r".repeat(300)));
    write(&f, &jsonl(&entries));
    let mut lim = Limits::from_defaults();
    lim.recent_tool_uses = 5;
    lim.notifications = 7;
    lim.tool_input_max = 50;
    lim.task_input_max = 100;
    lim.task_result_max = 40;
    lim.assistant_text_max = 64;
    lim.task_events = 3;
    let mut ix = Index::with_limits(&f, lim);
    ix.refresh().unwrap();
    assert_eq!(ix.recent_tool_uses(100).len(), 5);
    assert_eq!(ix.notifications().len(), 7);
    let uses = ix.recent_tool_uses(5);
    assert!(uses[0].input_truncated && uses[0].input.is_null(), "a Bash input over the cap is dropped and flagged");
    assert!(uses[4].input_truncated, "task inputs have their own cap");
    let a = ix.last_assistant().unwrap();
    assert!(a.truncated && a.text.len() == 64);
    match ix.task_events().last().unwrap() {
        TaskEvent::Result { text, truncated, .. } => assert!(*truncated && text.len() == 40),
        other => panic!("{other:?}"),
    }
}

#[test]
fn utf8_is_cut_on_a_character_boundary() {
    let t = Tmp::new("tx");
    let f = t.path("s.jsonl");
    write(&f, &jsonl(&[assistant("m", &["ééééé"], &[])]));
    let mut lim = Limits::from_defaults();
    lim.assistant_text_max = 5;
    let mut ix = Index::with_limits(&f, lim);
    ix.refresh().unwrap();
    assert_eq!(ix.last_assistant().unwrap().text, "éé");
}

#[test]
fn rfc3339_timestamps_parse_like_date_parse() {
    assert_eq!(parse_ts_ms("2000-03-01T00:00:00+00:00"), Some(951_868_800_000));
    assert_eq!(parse_ts_ms("2026-10-04T10:00:00.250Z"), Some(1_791_108_000_250));
    assert_eq!(parse_ts_ms("2026-10-04T10:00:00+02:00"), Some(1_791_100_800_000));
    assert_eq!(parse_ts_ms("1999-12-31T23:59:59.999-05:30"), Some(946_704_599_999));
    assert_eq!(parse_ts_ms("2024-02-29T12:00:00Z"), Some(1_709_208_000_000));
    assert_eq!(parse_ts_ms("2026-10-04T10:00:00.5Z"), Some(1_791_108_000_500));
    for bad in ["", "yesterday", "2026-10-04", "2026-13-04T10:00:00Z", "2026-10-04T10:00:00", "2026-10-04T10:00:00.Z"] {
        assert_eq!(parse_ts_ms(bad), None, "{bad:?}");
    }
}

#[test]
fn js_trim_uses_javascript_whitespace() {
    assert_eq!(js_trim("\u{feff} a \u{a0}"), "a");
    assert_eq!(js_trim("\u{85}a"), "\u{85}a", "U+0085 is not JS whitespace");
}

#[test]
fn the_registry_bounds_count_and_idle_time_and_rebuilds_on_demand() {
    let t = Tmp::new("tx");
    let (a, b, c) = (t.path("a.jsonl"), t.path("b.jsonl"), t.path("c.jsonl"));
    for p in [&a, &b, &c] {
        write(p, &jsonl(&[user_text("hi")]));
    }
    let reg = Indexes::with(Limits::from_defaults(), 2, 1000);
    assert_eq!(reg.with_index(&a, 0, |i| i.records()).unwrap(), 1);
    assert_eq!(reg.with_index(&b, 10, |i| i.records()).unwrap(), 1);
    reg.with_index(&c, 20, |_| ()).unwrap();
    assert_eq!(reg.len(), 2, "the least recently used index was dropped");
    append(&b, &jsonl(&[user_text("more")]));
    assert_eq!(reg.with_index(&b, 30, |i| i.records()).unwrap(), 2, "refresh reads only the appended bytes");
    assert_eq!(reg.sweep(5000), 0, "idle indexes expire");
    assert_eq!(reg.with_index(&b, 6000, |i| i.records()).unwrap(), 2, "an expired index is rebuilt from the file, nothing lost");
    reg.drop_index(&b);
    assert!(reg.is_empty());
}
