//! X1 parity: the facts the index derives equal the facts the Node readers derive from the same file
//! (`parity/transcript-facts.js` runs `speculation-guard.js` text extraction, `inference-check.js lastUserPrompt`,
//! `agent-scan.js scanTranscript`, `devswarm-idle.js notificationTexts/finishedTaskKeys` and `task-state.js collectTU`).
//! Set `AH_ENGINE_NODE_HOOKS` to another checkout's `plugins/anti-hall/hooks` to compare against it; the default is
//! this checkout's. A checkout that predates `inference-check.js` has no `lastUserPrompt` to compare, and that one
//! fact is then left out of the comparison (the others are still compared).

mod transcript_support;
use ah_engine::transcript::{Index, Limits};
use serde_json::{Value, json};
use std::process::Command;
use transcript_support::*;

fn node_facts(file: &std::path::Path) -> Value {
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let hooks = std::env::var("AH_ENGINE_NODE_HOOKS")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| manifest.join("..").join("plugins").join("anti-hall").join("hooks"));
    let out = Command::new("node")
        .arg(manifest.join("parity").join("transcript-facts.js"))
        .arg(file)
        .arg("--hooks")
        .arg(&hooks)
        .output()
        .unwrap_or_else(|e| panic!("node is required for the parity test: {e}"));
    assert!(out.status.success(), "transcript-facts.js failed: {}", String::from_utf8_lossy(&out.stderr));
    serde_json::from_slice(&out.stdout).unwrap()
}

fn engine_facts(file: &std::path::Path) -> Value {
    let mut lim = Limits::from_defaults();
    lim.initial_window = u64::MAX / 2;
    lim.max_update = u64::MAX / 2;
    lim.recent_tool_uses = usize::MAX / 2;
    lim.notifications = usize::MAX / 2;
    lim.assistant_text_max = usize::MAX / 2;
    lim.prompt_max = usize::MAX / 2;
    let mut ix = Index::with_limits(file, lim);
    ix.refresh().unwrap();
    ix.facts_json()
}

fn assert_parity(name: &str, text: &str) {
    let t = Tmp::new("txp");
    let f = t.path("s.jsonl");
    write(&f, text);
    let node = node_facts(&f);
    let mut engine = engine_facts(&f);
    if node.get("last_prompt").is_none() {
        engine.as_object_mut().unwrap().remove("last_prompt");
    }
    assert_eq!(engine, node, "{name}: the index disagrees with the Node readers");
}

#[test]
fn a_realistic_session_matches_node() {
    assert_parity("session", &jsonl(&session()));
}

#[test]
fn text_extraction_quirks_match_node() {
    let entries = [
        // top-level content AND message.content: the legacy extraction collects both, dedup collects both too
        json!({"type": "assistant", "content": [{"type": "text", "text": "top"}], "message": {"role": "assistant", "content": [{"type": "text", "text": "inner"}]}}),
        // empty-string content falls back to message.content (JS ||)
        json!({"type": "assistant", "role": "assistant", "content": "", "message": {"content": "from message"}}),
        // a direct text field and a block without type
        json!({"role": "assistant", "text": "direct", "content": [{"text": "untyped"}, {"type": "image"}, 5, null]}),
        // role only on the entry, content a plain string
        json!({"role": "assistant", "content": "plain string"}),
        // no text anywhere: keeps the previous reply
        json!({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "tool_use", "id": "t9", "name": "Read", "input": {}}]}}),
        // nested message-in-message
        json!({"type": "assistant", "message": {"role": "assistant", "message": {"content": "deep"}}}),
    ];
    for upto in 1..=entries.len() {
        assert_parity(&format!("quirks[..{upto}]"), &jsonl(&entries[..upto]));
    }
}

#[test]
fn notification_shapes_and_quoting_match_node() {
    let quoted = format!("quoting: {}", notification_text("quoted0000000000", "completed"));
    let wrapped = format!("<system-reminder>\n{}\n</system-reminder>", notification_text("wrapped000000000", "stopped"));
    let two = format!("{}\n{}", notification_text("one1111111111111", "completed"), notification_text("two2222222222222", " completed "));
    let entries = vec![
        user_text(&quoted),
        user_text(&wrapped),
        user_blocks(&["words", &notification_text("blocktext00000000", "failed")]),
        user_text(&two),
        notif_attachment("cancel0000000000", "canceled"),
        notif_attachment("killed00000000000", "KILLED"),
        notif_queue_op("queue000000000000", "completed"),
        notif_queue_op("running0000000000", "running"),
        json!({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": notification_text("assistantquote000", "completed")}]}}),
        json!({"type": "attachment", "attachment": {"type": "prompt", "prompt": "no notification here"}}),
        task_status_attachment("agent0000000001", "running"),
    ];
    assert_parity("notifications", &jsonl(&entries));
}

#[test]
fn prompts_flags_and_malformed_lines_match_node() {
    let mut text = jsonl(&[
        user_text("real prompt"),
        json!({"type": "user", "isMeta": true, "message": {"role": "user", "content": "caveat"}}),
        user_text("<command-name>/x</command-name>"),
        user_text("<local-command-stdout>y</local-command-stdout>"),
        user_blocks(&["part one", "part two"]),
        tool_result("toolu_x", "result text"),
        json!({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t", "content": "r"}, {"type": "text", "text": "mixed"}]}}),
        json!({"type": "event_msg", "payload": {"type": "user_message", "message": "codex typed"}}),
        json!({"type": "system", "subtype": "compact_boundary"}),
    ]);
    text.push_str("garbage line\n[1]\n\n{\"type\":5}\n");
    assert_parity("prompts", &text);
    // an unterminated last line is part of the Node tail too
    let mut u = text.clone();
    u.push_str(&assistant("last", &["no newline at end"], &[]).to_string());
    assert_parity("unterminated", &u);
}
