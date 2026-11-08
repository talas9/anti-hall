//! A scan turn bounds how many transcript windows are read at once and must never change an answer: with another thread holding the
//! only turn, every reader that waits for one (and ends its wait at the request deadline) reads anyway and gives the answer it gives
//! with no contention. These are the readers behind the callers that used to turn a timeout into a verdict (the task scan of the task
//! guards, the merge gate and speculation guard tail reads, the judge's evidence window, the agent scan).
use crate::checks::agent_scan::{Opts, scan_transcript_uncached};
use crate::checks::{compact_decl, guardkit, replykit, taskstate};
use crate::transcript::scan::while_turn_is_held;

fn fixture() -> String {
    let mut text = String::new();
    for i in 0..40 {
        text.push_str(&format!(
            "{{\"type\":\"assistant\",\"message\":{{\"role\":\"assistant\",\"content\":[{{\"type\":\"text\",\"text\":\"filler {i} evidence\"}}]}}}}\r\n"
        ));
    }
    text.push_str(
        "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"tu1\",\"name\":\"TaskCreate\",\"input\":{\"subject\":\"Open one\",\"description\":\"d\"}}]}}\n",
    );
    text.push_str(
        "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"tu1\",\"content\":\"Task #1 created successfully: Open one\"}]}}\n",
    );
    text.push_str("{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"last line\"}]}}");
    let p = std::env::temp_dir().join(format!("ah-scan-turn-{}.jsonl", std::process::id()));
    std::fs::write(&p, text).unwrap();
    p.to_string_lossy().into_owned()
}

/// Every reader, one string of what it answered.
fn answers(p: &str) -> Vec<String> {
    let w = 1 << 20;
    let opts = Opts { now_ms: 1.0, ignore_unanswered_stops: false };
    vec![
        format!("{:?}", taskstate::tail::read_tail(p, w)),
        format!("{:?}", taskstate::scanview::scan_tasks_uncached(p, w, w).ok()),
        format!("{:?}", replykit::io::read_window(p, w).map(|t| replykit::transcript::tail_lines(&t).len())),
        format!("{:?}", guardkit::tail::read_tail(p, w)),
        format!("{:?}", compact_decl::read_tail(p, w)),
        format!("{:?}", super::host_b3::read_tail(p, w)),
        format!("{:?}", super::host_b3::tail_lines_matching(p, w, true, &["evidence".to_string()])),
        format!("{:?}", super::host_b3::tail_lines_newest(p, w, true, &["evidence".to_string()], 3)),
        format!("{:?}", super::host::tail_lines(p, w as f64, 0.0)),
        format!("{:?}", scan_transcript_uncached(p, w, &opts).ok().map(|s| s.is_some())),
    ]
}

#[test]
fn a_held_turn_changes_no_answer() {
    let p = fixture();
    let calm = answers(&p);
    assert!(calm.iter().all(|a| a != "None" && a != "Ok(None)"), "the fixture reads in every reader: {calm:?}");
    assert_ne!(calm[1], format!("{:?}", Some(taskstate::scanview::ScanTasks::default())), "the task scan finds the open task");
    let busy = while_turn_is_held(|| answers(&p));
    assert_eq!(busy, calm);
}
