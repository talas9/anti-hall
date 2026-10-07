//! Unit tests of the handover checks. The full Node-vs-engine comparison is `parity/run-b78.js`.
use super::find::{self, Unsure};
use super::{precompact, resume, transcript};
use crate::checks::Verdict;
use crate::checks::jsport::testkit::{Sandbox, git};
use serde_json::{Value, json};
use std::path::PathBuf;

const SID: &str = "sess-1";

fn repo(sb: &Sandbox) -> PathBuf {
    let repo = sb.root.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    std::fs::write(repo.join("a.txt"), "a\n").unwrap();
    git(&repo, &["add", "-A"]);
    git(&repo, &["commit", "-q", "-m", "init"]);
    std::fs::canonicalize(repo).unwrap()
}

fn today() -> String {
    let tz: Vec<(String, String)> = std::env::var("TZ").map(|t| vec![("TZ".to_string(), t)]).unwrap_or_default();
    let _zone = crate::checks::jsport::date::ZoneGuard::new(&crate::reqenv::RequestEnv::from_pairs(tz));
    find::local_date().unwrap()
}

fn handover_dir(repo: &std::path::Path, sid: &str) -> String {
    format!("{}/.anti-hall/handovers/{}/{sid}", repo.to_string_lossy(), today())
}

fn put(repo: &std::path::Path, sid: &str, name: &str, text: &str, age: u64) -> PathBuf {
    let p = PathBuf::from(handover_dir(repo, sid)).join(name);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(&p, text).unwrap();
    let f = std::fs::OpenOptions::new().write(true).open(&p).unwrap();
    f.set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(age)).unwrap();
    p
}

fn user(t: &str) -> String {
    json!({"type": "user", "timestamp": "2026-10-07T10:00:00.000Z", "message": {"content": t}}).to_string()
}

fn lines(v: &[String]) -> Vec<&str> {
    v.iter().map(String::as_str).collect()
}

// ---- finding handovers -------------------------------------------------------------------------------------------

#[test]
fn the_newest_handover_wins_but_a_same_session_one_beats_a_newer_foreign_one() {
    let sb = Sandbox::new("h-find");
    let repo = repo(&sb);
    put(&repo, SID, "HANDOVER.md", "a", 3600);
    put(&repo, "other", "HANDOVER.md", "b", 10);
    let root = format!("{}/.anti-hall/handovers", repo.to_string_lossy());
    assert_eq!(find::newest_handover(&root, SID).unwrap().unwrap().session_id, SID);
    assert_eq!(find::newest_handover(&root, "").unwrap().unwrap().session_id, "other");
    assert_eq!(find::newest_handover(&root, "nobody").unwrap().unwrap().session_id, "other");
}

#[test]
fn file_names_carry_their_sequence_number_and_only_the_exact_patterns_match() {
    use find::Kind::{Handover, Precompact};
    assert_eq!(find::match_name("HANDOVER.md", Handover), Some(None));
    assert_eq!(find::match_name("HANDOVER-12.md", Handover), Some(Some("12")));
    for bad in ["HANDOVER-.md", "HANDOVER-x.md", "HANDOVER2.md", "HANDOVER.md.md", "handover.md", "HANDOVER-1.txt", "PRECOMPACT-1.md"] {
        assert_eq!(find::match_name(bad, Handover), None, "{bad}");
    }
    assert_eq!(find::match_name("PRECOMPACT-7.md", Precompact), Some(Some("7")));
    for bad in ["PRECOMPACT-.md", "PRECOMPACT.md", "PRECOMPACT-1a.md", "HANDOVER.md"] {
        assert_eq!(find::match_name(bad, Precompact), None, "{bad}");
    }
}

#[test]
fn the_newest_snapshot_is_this_sessions_and_ties_go_to_the_higher_number() {
    let sb = Sandbox::new("h-snap");
    let repo = repo(&sb);
    let root = format!("{}/.anti-hall/handovers", repo.to_string_lossy());
    let a = put(&repo, SID, "PRECOMPACT-2.md", "x", 100);
    let b = put(&repo, SID, "PRECOMPACT-12.md", "x", 100);
    put(&repo, "other", "PRECOMPACT-99.md", "x", 1);
    // same mtime to the nanosecond
    let t = std::fs::metadata(&a).unwrap().modified().unwrap();
    std::fs::OpenOptions::new().write(true).open(&b).unwrap().set_modified(t).unwrap();
    let got = find::newest_precompact(&root, SID).unwrap().unwrap();
    assert!(got.file_path.ends_with("PRECOMPACT-12.md"), "{got:?}");
    assert_eq!(find::newest_precompact(&root, ""), Ok(None));
}

#[test]
fn a_sequence_number_too_long_for_a_double_is_left_to_node() {
    let sb = Sandbox::new("h-seq");
    let repo = repo(&sb);
    put(&repo, SID, "HANDOVER-99999999999999999999.md", "x", 1);
    let root = format!("{}/.anti-hall/handovers", repo.to_string_lossy());
    assert_eq!(find::newest_handover(&root, SID), Err(Unsure));
}

// ---- reading the transcript --------------------------------------------------------------------------------------

#[test]
fn only_typed_user_messages_are_kept_and_only_the_last_ten() {
    let mut ls: Vec<String> = (0..12).map(|i| user(&format!("message {i}"))).collect();
    ls.push(user("<system-reminder>x"));
    ls.push(user("<task-notification>y"));
    ls.push(user("   "));
    ls.push(json!({"type": "user", "isMeta": true, "message": {"content": "meta"}}).to_string());
    ls.push(json!({"type": "user", "isSidechain": true, "message": {"content": "side"}}).to_string());
    ls.push(json!({"type": "user", "message": {"content": [{"type": "tool_result", "content": "r"}, {"type": "text", "text": "hidden"}]}}).to_string());
    ls.push(json!({"type": "user", "message": {"content": [{"type": "text", "text": "a"}, {"type": "image"}, {"type": "text", "text": "b"}]}}).to_string());
    ls.push(json!({"type": "event_msg", "timestamp": "t", "payload": {"type": "user_message", "message": " from codex "}}).to_string());
    let got = transcript::user_messages(&lines(&ls), 10).unwrap();
    let texts: Vec<&str> = got.iter().map(|m| m.text.as_str()).collect();
    assert_eq!(texts, ["message 4", "message 5", "message 6", "message 7", "message 8", "message 9", "message 10", "message 11", "a\nb", "from codex"]);
    assert_eq!(got[0].ts, "2026-10-07T10:00:00.000Z");
    assert_eq!(got[9].ts, "t");
}

#[test]
fn a_line_javascript_parses_but_serde_does_not_is_left_to_node() {
    let ls = vec![user("fine"), r#"{"type":"user","message":{"content":"bad \ud83d"}}"#.to_string()];
    assert_eq!(transcript::user_messages(&lines(&ls), 10), Err(Unsure));
    let ls = vec![user("fine"), "not json \"user\"".to_string(), "{\"type\":\"user\"".to_string()];
    assert_eq!(transcript::user_messages(&lines(&ls), 10).unwrap().len(), 1);
}

#[test]
fn the_task_list_is_read_back_from_the_tool_calls() {
    let assistant = |item: Value| json!({"type": "assistant", "message": {"content": [item]}}).to_string();
    let result = |id: &str, text: &str| json!({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": id, "content": text}]}}).to_string();
    let ls = vec![
        assistant(json!({"type": "tool_use", "name": "TaskCreate", "id": "a", "input": {"subject": "Do A"}})),
        result("a", "Task #1 created successfully: Do A"),
        assistant(json!({"type": "tool_use", "name": "TaskCreate", "id": "b", "input": {"subject": "Do B"}})),
        result("b", "Task #2 created successfully: Do B"),
        assistant(json!({"type": "tool_use", "name": "TaskUpdate", "input": {"taskId": "1", "status": "in_progress"}})),
        assistant(json!({"type": "tool_use", "name": "TaskUpdate", "input": {"taskId": 2, "status": "deleted"}})),
        assistant(json!({"type": "tool_use", "name": "TaskUpdate", "input": {"taskId": "9", "subject": "ghost"}})),
    ];
    let got = transcript::task_snapshot(&lines(&ls)).unwrap().unwrap();
    let rows: Vec<(&str, &str, &str)> = got.iter().map(|t| (t.id.as_str(), t.subject.as_str(), t.status.as_str())).collect();
    assert_eq!(rows, [("1", "Do A", "in_progress"), ("9", "ghost", "pending")]);
}

#[test]
fn a_todo_list_replaces_the_previous_one_and_comes_before_the_tasks() {
    let todo = |items: Value| json!({"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "TodoWrite", "input": {"todos": items}}]}}).to_string();
    let ls = vec![todo(json!([{"content": "old", "status": "pending"}])), todo(json!([{"content": "first", "status": "completed"}, {"subject": "second"}, null, {"content": 5}]))];
    let got = transcript::task_snapshot(&lines(&ls)).unwrap().unwrap();
    let rows: Vec<(&str, &str)> = got.iter().map(|t| (t.subject.as_str(), t.status.as_str())).collect();
    assert_eq!(rows, [("first", "completed"), ("second", "pending"), ("", "pending"), ("5", "pending")]);
    assert_eq!(transcript::task_snapshot(&lines(&[user("TodoWrite is only a word here")])).unwrap(), None);
    let empty = vec![todo(json!([]))];
    assert_eq!(transcript::task_snapshot(&lines(&empty)).unwrap(), Some(Vec::new()));
}

#[test]
fn table_cells_escape_pipes_collapse_space_and_cut_at_the_limit() {
    assert_eq!(transcript::cell("a | b\n\tc"), "a \\| b c");
    assert_eq!(transcript::cell(&"x".repeat(300)).len(), 200);
    // the cut falls inside an emoji: written to a file, the half becomes U+FFFD
    assert_eq!(transcript::cell(&format!("{}\u{1F600}", "a".repeat(199))), format!("{}\u{FFFD}", "a".repeat(199)));
}

// ---- precompact-snapshot -----------------------------------------------------------------------------------------

fn compact_payload(repo: &std::path::Path, tp: &std::path::Path) -> Value {
    json!({"hook_event_name": "PreCompact", "session_id": SID, "cwd": repo.to_string_lossy(), "transcript_path": tp.to_string_lossy(), "trigger": "auto"})
}

#[test]
fn a_snapshot_holds_git_state_tasks_messages_and_the_newest_handover_and_is_numbered() {
    let sb = Sandbox::new("h-pre");
    let repo = repo(&sb);
    std::fs::write(repo.join("new.txt"), "n").unwrap();
    put(&repo, SID, "HANDOVER.md", "# h", 600);
    let tp = sb.write("t.jsonl", &format!("{}\n{}\n", user("first rule: be brief"), json!({"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "TodoWrite", "input": {"todos": [{"content": "do | it", "status": "pending"}]}}]}})));
    let env = sb.env(&[]);
    let mut p = compact_payload(&repo, &tp);
    p["custom_instructions"] = json!("  keep the plan  ");
    assert!(matches!(precompact::decide(&p, &env), Ok(None)));
    let dir = handover_dir(&repo, SID);
    let text = std::fs::read_to_string(format!("{dir}/PRECOMPACT-1.md")).unwrap();
    assert!(text.starts_with(&format!("# PRECOMPACT snapshot — {SID} · #1 · ")), "{text}");
    assert!(text.contains("(trigger: auto). NOT a handover"), "{text}");
    assert!(text.contains(&format!("## Newest handover\n{dir}/HANDOVER.md (modified ")), "{text}");
    assert!(text.contains("## Repo state\npwd: ") && text.contains("\nbranch: main\nHEAD: ") && text.contains("dirty files: 2\n    ?? .anti-hall/\n    ?? new.txt\n"), "{text}");
    assert!(text.contains("## /compact instructions (verbatim)\nkeep the plan\n"), "{text}");
    assert!(text.contains("| id | subject | status |\n|---|---|---|\n| 1 | do \\| it | pending |\n"), "{text}");
    assert!(text.contains("## Last 1 user message(s), verbatim, oldest first\n\n### 1 · 2026-10-07T10:00:00.000Z\n````text\nfirst rule: be brief\n````\n"), "{text}");
    assert!(text.ends_with("````\n"));
    precompact::decide(&p, &env).unwrap();
    assert!(std::path::Path::new(&format!("{dir}/PRECOMPACT-2.md")).exists());
}

#[test]
fn a_subagent_a_skip_a_missing_cwd_or_the_switch_writes_nothing() {
    let sb = Sandbox::new("h-pre-no");
    let repo = repo(&sb);
    let tp = sb.write("t.jsonl", "");
    let base = compact_payload(&repo, &tp);
    let written = || std::path::Path::new(&handover_dir(&repo, SID)).exists();
    let mut sub = base.clone();
    sub["agent_id"] = json!("a1");
    precompact::decide(&sub, &sb.env(&[])).unwrap();
    let mut sub0 = base.clone();
    sub0["agent_type"] = json!(0);
    precompact::decide(&sub0, &sb.env(&[])).unwrap();
    let mut nocwd = base.clone();
    nocwd.as_object_mut().unwrap().remove("cwd");
    precompact::decide(&nocwd, &sb.env(&[])).unwrap();
    assert!(!written());
    sb.write("home/.anti-hall/skip.json", r#"{"precompact-snapshot":4102444800000}"#);
    precompact::decide(&base, &sb.env(&[])).unwrap();
    assert!(!written());
    sb.write("home/.anti-hall/skip.json", "{}");
    sb.write("home/.anti-hall/settings.json", r#"{"maintenance":{"precompactSnapshot":false}}"#);
    precompact::decide(&base, &sb.env(&[])).unwrap();
    assert!(!written());
    // a null agent id is no marker
    let mut null_id = base.clone();
    null_id["agent_id"] = json!(null);
    sb.write("home/.anti-hall/settings.json", "{}");
    precompact::decide(&null_id, &sb.env(&[])).unwrap();
    assert!(written());
}

#[test]
fn a_long_message_is_cut_at_4000_units_with_a_note_of_what_was_cut() {
    let sb = Sandbox::new("h-pre-long");
    let repo = repo(&sb);
    let tp = sb.write("t.jsonl", &format!("{}\n", user(&"y".repeat(4100))));
    precompact::decide(&compact_payload(&repo, &tp), &sb.env(&[])).unwrap();
    let text = std::fs::read_to_string(format!("{}/PRECOMPACT-1.md", handover_dir(&repo, SID))).unwrap();
    assert!(text.contains(&format!("````text\n{}\n[… truncated 100 chars]\n````", "y".repeat(4000))), "{}", &text[text.len().saturating_sub(300)..]);
}

#[test]
fn a_session_in_the_handovers_directory_does_not_double_the_path() {
    let sb = Sandbox::new("h-pre-double");
    let repo = repo(&sb);
    let inside = repo.join(".anti-hall/handovers");
    std::fs::create_dir_all(&inside).unwrap();
    let tp = sb.write("t.jsonl", "");
    let mut p = compact_payload(&repo, &tp);
    p["cwd"] = json!(inside.to_string_lossy());
    precompact::decide(&p, &sb.env(&[])).unwrap();
    assert!(std::path::Path::new(&format!("{}/PRECOMPACT-1.md", handover_dir(&repo, SID))).exists());
    assert!(!inside.join(".anti-hall").exists());
}

#[test]
fn a_directory_that_is_not_a_repository_is_snapshotted_without_git_state() {
    let sb = Sandbox::new("h-pre-nogit");
    let plain = sb.root.join("plain");
    std::fs::create_dir_all(&plain).unwrap();
    let tp = sb.write("t.jsonl", "");
    precompact::decide(&compact_payload(&plain, &tp), &sb.env(&[])).unwrap();
    let text = std::fs::read_to_string(format!("{}/PRECOMPACT-1.md", handover_dir(&plain, SID))).unwrap();
    assert!(text.contains("git: not a git repository (or git unavailable)"), "{text}");
    assert!(text.contains("none found under .anti-hall/handovers/ — no HANDOVER*.md exists for this repo"), "{text}");
    assert!(text.contains("not derivable — no TodoWrite/TaskCreate/TaskUpdate calls in the readable transcript tail"), "{text}");
    assert!(text.contains("none found in the readable transcript tail"), "{text}");
}

// ---- handover-resume ---------------------------------------------------------------------------------------------

fn start_payload(repo: &std::path::Path, source: &str) -> Value {
    json!({"hook_event_name": "SessionStart", "session_id": SID, "cwd": repo.to_string_lossy(), "source": source})
}

fn text_of(v: Option<Verdict>) -> String {
    match v {
        Some(Verdict::Advisory(j)) => serde_json::from_str::<Value>(&j).unwrap()["hookSpecificOutput"]["additionalContext"].as_str().unwrap().to_string(),
        other => panic!("expected an advisory, got {other:?}"),
    }
}

#[test]
fn the_pointer_names_the_handover_and_the_resume_steps_follow_what_it_has() {
    let sb = Sandbox::new("h-res");
    let repo = repo(&sb);
    let h = put(&repo, SID, "HANDOVER.md", "# H\n\n## Resume-verification checklist\n- x\n", 3600);
    put(&repo, SID, "state.md", "s", 3600);
    put(&repo, SID, "trials.md", "t", 3600);
    let t = text_of(resume::decide(&start_payload(&repo, "compact"), &sb.env(&[])).unwrap());
    let first = t.lines().next().unwrap();
    assert_eq!(first, format!("\u{1F4A1} anti-hall \u{b7} handover-resume: A session handover was found for this continuation: {} (HANDOVER.md | date {} | session {SID})", h.to_string_lossy(), today()));
    assert!(t.contains("\nFreshness (measured now): HEAD ") && t.contains(" commit(s) since this handover was written"), "{t}");
    assert!(t.contains("\nDo instead: follow this guided resume path.\n1. Read "), "{t}");
    assert!(t.contains("2. Run its Resume-verification checklist (git status, pwd, CLAUDE.md re-read, smoke command)"), "{t}");
    assert!(t.contains("3. Load detail files ONLY as needed via the pointer table (state.md / trials.md).\n4. Check trials.md do-not-repeat list"), "{t}");
    assert!(t.contains("\n5. READ-BACK:") && t.contains("\n6. Continue from the single Next Action.\n7. Recreate/reconcile your task list from state.md's"), "{t}");
    assert!(t.ends_with("the compact summary is lossy."), "{t}");
    // a Codex session re-reads AGENTS.md; a start (not a continuation) says so
    let mut p = start_payload(&repo, "startup");
    p["turn_id"] = json!("t");
    let t = text_of(resume::decide(&p, &sb.env(&[])).unwrap());
    assert!(t.contains("handover-resume: A previous session left a handover: ") && t.contains("pwd, AGENTS.md re-read"), "{t}");
}

#[test]
fn a_handover_without_a_checklist_gets_the_generic_check() {
    let sb = Sandbox::new("h-res-gen");
    let repo = repo(&sb);
    put(&repo, SID, "HANDOVER.md", "# no section", 3600);
    let t = text_of(resume::decide(&start_payload(&repo, "clear"), &sb.env(&[])).unwrap());
    assert!(t.contains("2. No Resume-verification checklist section was found in it -- fall back to a generic check"), "{t}");
    assert!(!t.contains("Load detail files"), "{t}");
}

#[test]
fn a_handover_older_than_a_week_is_silent_and_no_handover_is_reported_only_on_clear_or_compact() {
    let sb = Sandbox::new("h-res-old");
    let repo = repo(&sb);
    assert!(resume::decide(&start_payload(&repo, "startup"), &sb.env(&[])).unwrap().is_none(), "no handovers directory at all, on a start");
    assert!(text_of(resume::decide(&start_payload(&repo, "clear"), &sb.env(&[])).unwrap()).contains("No session handover found"), "and on a clear");
    std::fs::create_dir_all(repo.join(".anti-hall/handovers")).unwrap();
    for (src, report) in [("clear", true), ("compact", true), ("startup", false), ("resume", false), ("", false)] {
        let v = resume::decide(&start_payload(&repo, src), &sb.env(&[])).unwrap();
        assert_eq!(v.is_some(), report, "{src}");
        if let Some(v) = v {
            assert!(text_of(Some(v)).contains("No session handover found under .anti-hall/handovers/."));
        }
    }
    put(&repo, SID, "HANDOVER.md", "x", 8 * 86400);
    assert!(resume::decide(&start_payload(&repo, "clear"), &sb.env(&[])).unwrap().is_none(), "a stale handover stays silent");
    // the same session's stale handover is preferred over another session's fresh one, so it stays silent
    put(&repo, "fresh", "HANDOVER.md", "x", 6 * 86400);
    assert!(resume::decide(&start_payload(&repo, "clear"), &sb.env(&[])).unwrap().is_none());
    assert!(resume::decide(&json!({"hook_event_name": "SessionStart", "session_id": "someone-else", "cwd": repo.to_string_lossy(), "source": "clear"}), &sb.env(&[])).unwrap().is_some());
}

#[test]
fn a_snapshot_is_named_after_the_handover_and_stands_in_when_there_is_none() {
    let sb = Sandbox::new("h-res-snap");
    let repo = repo(&sb);
    put(&repo, SID, "PRECOMPACT-1.md", "s", 60);
    let t = text_of(resume::decide(&start_payload(&repo, "startup"), &sb.env(&[])).unwrap());
    assert!(t.contains("no HANDOVER*.md was written for this session, but a pre-compaction snapshot exists: "), "{t}");
    put(&repo, SID, "HANDOVER.md", "h", 3600);
    let t = text_of(resume::decide(&start_payload(&repo, "startup"), &sb.env(&[])).unwrap());
    assert!(t.contains("\n\nPre-compaction snapshot (newer than the handover): "), "{t}");
    put(&repo, SID, "HANDOVER-2.md", "h", 10);
    let t = text_of(resume::decide(&start_payload(&repo, "startup"), &sb.env(&[])).unwrap());
    assert!(t.contains("\n\nPre-compaction snapshot (older than the handover, which already covers it): "), "{t}");
}

#[test]
fn the_index_outcome_and_the_writer_note_and_the_state_file() {
    let sb = Sandbox::new("h-res-extra");
    let repo = repo(&sb);
    put(&repo, SID, "HANDOVER.md", "h", 4 * 3600);
    put(&repo, SID, "HANDOVER-2.md", "h", 3 * 3600);
    let row = |seq: u32, out: &str| format!("- {} \u{b7} {SID} \u{b7} seq {seq} \u{b7} {out} \u{b7} [s] \u{b7} [m](x)", today());
    sb.write("repo/.anti-hall/handovers/INDEX.md", &format!("{}\n{}\n", row(1, "first"), row(2, "second")));
    let enc: String = repo.to_string_lossy().chars().map(|c| if matches!(c, '/' | '\\' | ':' | '.') { '-' } else { c }).collect();
    let tr = format!("home/.claude/projects/{enc}/{SID}.jsonl");
    sb.write(&tr, "{}");
    let f = std::fs::OpenOptions::new().write(true).open(sb.root.join(&tr)).unwrap();
    f.set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(600)).unwrap();
    let t = text_of(resume::decide(&start_payload(&repo, "compact"), &sb.env(&[])).unwrap());
    assert!(t.lines().next().unwrap().contains("HANDOVER-2.md, predecessor HANDOVER.md | date"), "{t}");
    assert!(t.lines().next().unwrap().ends_with(") -- INDEX.md outcome: second"), "{t}");
    assert!(t.contains(&format!("\nWriter kept running: session {SID} kept running 170 min after this handover was written (its transcript last wrote at ")), "{t}");
    let state = std::fs::read_to_string(sb.root.join(format!("home/.anti-hall/handover-resume-state-{SID}.json"))).unwrap();
    let v: Value = serde_json::from_str(&state).unwrap();
    assert!(v["handoverFile"].as_str().unwrap().ends_with("HANDOVER-2.md"));
    assert!(state.starts_with("{\"handoverFile\":"), "{state}");
}

#[test]
fn the_switch_and_the_judge_child_silence_it() {
    let sb = Sandbox::new("h-res-off");
    let repo = repo(&sb);
    put(&repo, SID, "HANDOVER.md", "h", 3600);
    assert!(resume::decide(&start_payload(&repo, "startup"), &sb.env(&[("ANTIHALL_JUDGE_CHILD", "1")])).unwrap().is_none());
    sb.write("home/.anti-hall/settings.json", r#"{"context":{"handoverResume":false}}"#);
    assert!(resume::decide(&start_payload(&repo, "startup"), &sb.env(&[])).unwrap().is_none());
    assert!(!sb.root.join(format!("home/.anti-hall/handover-resume-state-{SID}.json")).exists());
}

#[test]
fn the_checklist_heading_is_matched_the_way_the_regex_matches() {
    for (text, want) in [
        ("## Resume-verification checklist", true),
        ("x\n##   resume-VERIFICATION Checklist: go", true),
        ("##\n\nResume-verification checklist", true),
        ("a\r## Resume-verification checklist", true),
        ("a\u{2028}## Resume-verification checklist", true),
        ("  ## Resume-verification checklist", false),
        ("### Resume-verification checklist", false),
        ("## Resume-verification checklists", false),
        ("## Resume-verification checklist_x", false),
        ("## Resume-verification checklist\u{e9}", true),
        ("## Resume-verification chec\u{212a}list", false),
        ("text ## Resume-verification checklist", false),
    ] {
        assert_eq!(resume::has_checklist(text), want, "{text:?}");
    }
}
