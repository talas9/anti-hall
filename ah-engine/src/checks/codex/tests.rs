//! Unit tests of the Codex checks. The full Node-vs-engine comparison is `tests/node_parity` (the Rust Node-parity test); these pin the behavior a
//! regression would break. Every test works in its own temporary home and never touches the real one.
use super::quota::{self, Unsure};
use super::{availability, detect, nudge};
use crate::checks::Verdict;
use crate::checks::jsport::date;
use crate::checks::jsport::testkit::{Sandbox, git};
use serde_json::{Value, json};
use std::path::PathBuf;

fn advisory(v: Option<Verdict>) -> Value {
    match v {
        Some(Verdict::Advisory(j)) => serde_json::from_str(&j).unwrap(),
        other => panic!("expected an advisory, got {other:?}"),
    }
}

fn context(v: &Value) -> &str {
    v["hookSpecificOutput"]["additionalContext"].as_str().unwrap()
}

// ---- the quota record ------------------------------------------------------------------------------------------

#[test]
fn a_try_again_time_in_the_message_becomes_the_outage_end() {
    let hit = quota::detect("You've hit your usage limit. Try again at 2030-10-08T12:00:00Z.").unwrap().unwrap();
    assert_eq!(hit.until, Some(1917691200000.0));
    assert_eq!(hit.reason, "hit your usage limit. Try again at 2030-10-08T12:00:00Z.");
}

#[test]
fn an_until_clause_is_the_fallback_and_a_message_without_a_time_has_none() {
    assert_eq!(quota::detect("out of quota until 2030-10-08T12:00:00Z; sorry").unwrap().unwrap().until, Some(1917691200000.0));
    assert_eq!(quota::detect("You are out of quota.").unwrap().unwrap().until, None);
}

#[test]
fn text_that_names_no_quota_word_is_never_a_message() {
    assert_eq!(quota::detect("everything ran out of memory until the end").unwrap(), None);
    assert_eq!(quota::detect("").unwrap(), None);
    assert!(quota::cannot_match("hello"));
    assert!(!quota::cannot_match("a RATE LIMIT here"));
}

#[test]
fn a_message_with_astral_characters_is_left_to_node() {
    assert_eq!(quota::detect("out of \u{1F600} quota"), Err(Unsure));
}

#[test]
fn recording_merges_into_the_file_and_keeps_its_key_order() {
    let sb = Sandbox::new("record");
    sb.write("home/.anti-hall/codex-availability.json", r#"{"available":true,"checkedAt":5,"source":"path-probe","extra":[1]}"#);
    assert_eq!(quota::record_quota(&sb.home(), Some(2e12), "  usage limit  ", 1e12), Ok(true));
    let text = std::fs::read_to_string(sb.root.join("home/.anti-hall/codex-availability.json")).unwrap();
    assert_eq!(
        text,
        r#"{"available":true,"checkedAt":5,"source":"path-probe","extra":[1],"quota":{"available":false,"until":2000000000000,"reason":"usage limit","recordedAt":1000000000000}}"#
    );
}

#[test]
fn an_outage_without_a_usable_end_lasts_the_default_cooldown() {
    let sb = Sandbox::new("cooldown");
    for until in [None, Some(5.0), Some(f64::NAN)] {
        assert_eq!(quota::record_quota(&sb.home(), until, "", 1e12), Ok(true));
        let q = &sb.state()["quota"];
        assert_eq!(q["until"].as_f64(), Some(1e12 + 21_600_000.0));
        assert_eq!(q["reason"], json!("quota exhausted"));
    }
}

#[test]
fn an_expired_or_malformed_record_reads_as_no_outage() {
    let sb = Sandbox::new("read");
    let now = 1e12;
    for (text, live) in [
        (r#"{"quota":{"until":2e12,"reason":"x"}}"#, true),
        (r#"{"quota":{"until":5e11,"reason":"x"}}"#, false),
        (r#"{"quota":{"until":"2e12"}}"#, false),
        (r#"{"quota":null}"#, false),
        (r#"{"quota":[1]}"#, false),
        ("[1]", false),
        ("{not json", false),
    ] {
        sb.write("home/.anti-hall/codex-availability.json", text);
        assert_eq!(quota::read_quota(&sb.home(), now).unwrap().is_some(), live, "{text}");
    }
    sb.write("home/.anti-hall/codex-availability.json", r#"{"quota":{"until":2e12}}"#);
    assert_eq!(quota::read_quota(&sb.home(), now).unwrap().unwrap().reason, "quota exhausted");
}

#[test]
fn a_state_file_the_port_cannot_merge_exactly_is_left_to_node() {
    let sb = Sandbox::new("proto");
    sb.write("home/.anti-hall/codex-availability.json", r#"{"__proto__":{"x":1}}"#);
    assert_eq!(quota::record_quota(&sb.home(), None, "x", 1e12), Err(Unsure));
    sb.write("home/.anti-hall/codex-availability.json", r#"{"a":"\ud83d"}"#);
    assert_eq!(quota::read_quota(&sb.home(), 1e12), Err(Unsure));
}

#[test]
fn a_job_log_error_is_folded_into_the_record_once() {
    let sb = Sandbox::new("joblog");
    let log = "home/.claude/plugins/data/codex-openai-codex/state/repoA/jobs/a.log";
    sb.write(log, "ERROR: You've hit your usage limit. try again at 2030-10-08T12:00:00Z.\n");
    sb.age(log, 60);
    quota::scan_job_logs(&sb.home(), date::now_ms()).unwrap();
    assert_eq!(sb.state()["quota"]["until"].as_f64(), Some(1917691200000.0));
    // a later recorded outage is kept
    sb.write("home/.anti-hall/codex-availability.json", r#"{"quota":{"until":2000000000000,"reason":"later"}}"#);
    quota::scan_job_logs(&sb.home(), date::now_ms()).unwrap();
    assert_eq!(sb.state()["quota"]["reason"], json!("later"));
}

#[test]
fn a_stale_job_log_and_a_past_end_time_are_ignored() {
    let sb = Sandbox::new("stale");
    let log = "home/.claude/plugins/data/codex-openai-codex/state/repoA/jobs/a.log";
    sb.write(log, "out of quota. try again at 2020-01-01T00:00:00Z.\n");
    quota::scan_job_logs(&sb.home(), date::now_ms()).unwrap();
    assert!(!sb.root.join("home/.anti-hall/codex-availability.json").exists());
    sb.write(log, "out of quota.\n");
    sb.age(log, 30 * 3600);
    quota::scan_job_logs(&sb.home(), date::now_ms()).unwrap();
    assert!(!sb.root.join("home/.anti-hall/codex-availability.json").exists());
}

// ---- codex-quota-detect ----------------------------------------------------------------------------------------

fn agent(resp: Value) -> Value {
    json!({"hook_event_name": "PostToolUse", "tool_name": "Agent", "tool_input": {"subagent_type": "codex:codex-rescue"}, "tool_response": resp})
}

#[test]
fn a_quota_message_from_the_codex_seat_is_recorded_and_announced() {
    let sb = Sandbox::new("detect");
    let v = detect::decide(&agent(json!("out of quota until 2030-10-08T12:00:00Z.")), &sb.env(&[])).unwrap();
    let a = advisory(v);
    assert!(context(&a).contains("codex:codex-rescue reported quota exhaustion"), "{a}");
    assert!(context(&a).contains("until 2030-10-08T12:00:00.000Z;"), "{a}");
    assert_eq!(sb.state()["quota"]["until"].as_f64(), Some(1917691200000.0));
}

#[test]
fn only_the_codex_rescue_seat_and_the_agent_tool_count() {
    let sb = Sandbox::new("seat");
    let msg = json!("out of quota");
    let mut other = agent(msg.clone());
    other["tool_input"]["subagent_type"] = json!("general-purpose");
    assert!(detect::decide(&other, &sb.env(&[])).unwrap().is_none());
    let mut bash = agent(msg.clone());
    bash["tool_name"] = json!("Bash");
    assert!(detect::decide(&bash, &sb.env(&[])).unwrap().is_none());
    for t in ["codex-rescue", "Codex:Codex-Rescue", " codex/rescue ", "codexrescue", "codex-codex-rescue"] {
        let mut p = agent(msg.clone());
        p["tool_input"]["subagent_type"] = json!(t);
        assert!(detect::decide(&p, &sb.env(&[])).unwrap().is_some(), "{t}");
    }
    let mut no = agent(msg);
    no["tool_input"]["subagent_type"] = json!("codex:codex-rescue2");
    assert!(detect::decide(&no, &sb.env(&[])).unwrap().is_none());
}

#[test]
fn an_object_result_is_decided_only_when_its_key_order_cannot_matter() {
    let sb = Sandbox::new("objects");
    // several keys, no quota word anywhere: nothing can match whatever the order
    assert!(detect::decide(&agent(json!({"type": "text", "text": "all done"})), &sb.env(&[])).unwrap().is_none());
    // several keys and a quota word: Node scans them in insertion order, which this payload does not keep
    assert_eq!(detect::decide(&agent(json!({"type": "text", "text": "out of quota"})), &sb.env(&[])), Err(Unsure));
    // one key: exact
    assert!(detect::decide(&agent(json!({"result": "out of quota"})), &sb.env(&[])).unwrap().is_some());
}

#[test]
fn the_detection_switch_turns_it_off() {
    let sb = Sandbox::new("switch");
    let p = agent(json!("out of quota"));
    assert!(detect::decide(&p, &sb.env(&[("ANTIHALL_CODEX_QUOTA_DETECT", "0")])).unwrap().is_none());
    assert!(!sb.root.join("home/.anti-hall/codex-availability.json").exists());
    sb.write("home/.anti-hall/settings.json", r#"{"guards":{"codexQuotaDetect":false}}"#);
    assert!(detect::decide(&p, &sb.env(&[])).unwrap().is_none());
    assert!(detect::decide(&p, &sb.env(&[("ANTIHALL_CODEX_QUOTA_DETECT", "1")])).unwrap().is_some());
}

// ---- codex-availability ----------------------------------------------------------------------------------------

fn make_exec(sb: &Sandbox, rel: &str, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    let p = sb.write(rel, "#!/bin/sh\n");
    std::fs::set_permissions(p, std::fs::Permissions::from_mode(mode)).unwrap();
}

fn session_start() -> Value {
    json!({"hook_event_name": "SessionStart", "session_id": "s", "transcript_path": "/h/.claude/projects/x/s.jsonl"})
}

#[test]
fn the_probe_wants_a_real_executable_file_on_path() {
    let sb = Sandbox::new("probe");
    make_exec(&sb, "b1/codex", 0o755);
    make_exec(&sb, "b2/codex", 0o644);
    std::fs::create_dir_all(sb.root.join("b3/codex")).unwrap();
    let r = |dirs: &[&str]| {
        let path = dirs.iter().map(|d| sb.root.join(d).to_string_lossy().into_owned()).collect::<Vec<_>>().join(":");
        availability::decide(&session_start(), &sb.env(&[("PATH", &path)])).unwrap()
    };
    assert!(r(&["b1"]).is_some());
    assert!(r(&["", "b3", "b1"]).is_some());
    assert!(r(&["b2"]).is_none(), "not executable");
    assert!(r(&["b3"]).is_none(), "a directory named codex");
    assert!(r(&["nowhere"]).is_none());
    assert_eq!(sb.state()["available"], json!(false));
}

#[test]
fn the_probe_result_is_merged_beside_a_recorded_outage() {
    let sb = Sandbox::new("merge");
    make_exec(&sb, "b1/codex", 0o755);
    let until = date::now_ms() + 3_600_000.0;
    sb.write("home/.anti-hall/codex-availability.json", &format!(r#"{{"quota":{{"until":{until},"reason":"usage limit"}},"keep":1}}"#));
    let path = sb.root.join("b1").to_string_lossy().into_owned();
    let a = advisory(availability::decide(&session_start(), &sb.env(&[("PATH", &path)])).unwrap());
    assert!(context(&a).starts_with("\u{26a0}\u{fe0f} anti-hall \u{b7} codex-availability: Codex unavailable until "), "{a}");
    assert!(context(&a).contains("(usage limit).\nDo instead: route correctness review to Sonnet until then.\n"), "{a}");
    let s = sb.state();
    assert_eq!(s["available"], json!(true));
    assert_eq!(s["source"], json!("path-probe"));
    assert_eq!(s["keep"], json!(1));
    assert_eq!(s["quota"]["reason"], json!("usage limit"));
}

#[test]
fn an_outage_alone_is_worth_a_line_and_a_codex_session_is_told_to_use_a_lower_tier() {
    let sb = Sandbox::new("outage");
    let until = date::now_ms() + 3_600_000.0;
    sb.write("home/.anti-hall/codex-availability.json", &format!(r#"{{"quota":{{"until":{until},"reason":"r"}}}}"#));
    let mut p = session_start();
    p["turn_id"] = json!("t1");
    let a = advisory(availability::decide(&p, &sb.env(&[("PATH", "/nonexistent")])).unwrap());
    assert!(context(&a).contains("route correctness review to a lower gpt tier until then."), "{a}");
    assert!(context(&a).ends_with("instead of re-probing."), "{a}");
}

#[test]
fn a_codex_payload_is_a_turn_id_or_a_rollout_or_a_codex_directory() {
    for (p, want) in [
        (json!({"turn_id": "t"}), true),
        (json!({"turn_id": ""}), false),
        (json!({"turn_id": 5}), false),
        (json!({"transcript_path": "/x/rollout-1.jsonl"}), true),
        (json!({"transcript_path": "C:\\x\\rollout-1.jsonl"}), true),
        (json!({"transcript_path": "rollout-.jsonl"}), true),
        (json!({"transcript_path": "/x/rollout.jsonl"}), false),
        (json!({"transcript_path": "/x/rollout-1.jsonl/y"}), false),
        (json!({"transcript_path": "/h/.codex/s/a"}), true),
        (json!({"transcript_path": "/h/.codexx/s"}), false),
        (json!({"transcript_path": "/h/.codex"}), false),
        (json!([1]), false),
        (json!(null), false),
    ] {
        assert_eq!(availability::is_codex_payload(&p), want, "{p}");
    }
}

#[test]
fn the_judge_child_does_nothing() {
    let sb = Sandbox::new("judge");
    make_exec(&sb, "b1/codex", 0o755);
    let path = sb.root.join("b1").to_string_lossy().into_owned();
    assert!(availability::decide(&session_start(), &sb.env(&[("PATH", &path), ("ANTIHALL_JUDGE_CHILD", "1")])).unwrap().is_none());
    assert!(!sb.root.join("home/.anti-hall/codex-availability.json").exists());
}

// ---- codex-nudge -----------------------------------------------------------------------------------------------

const SID: &str = "sess-1";

struct Nudge {
    sb: Sandbox,
    repo: PathBuf,
    transcript: PathBuf,
}

fn nudge_box(tag: &str) -> Nudge {
    let sb = Sandbox::new(tag);
    let repo = sb.root.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    std::fs::write(repo.join("a.js"), "x").unwrap();
    git(&repo, &["add", "-A"]);
    git(&repo, &["commit", "-q", "-m", "init"]);
    let repo = std::fs::canonicalize(repo).unwrap();
    let enc: String = repo.to_string_lossy().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    let transcript = sb.root.join(format!("home/.claude/projects/{enc}/{SID}.jsonl"));
    Nudge { sb, repo, transcript }
}

impl Nudge {
    fn transcript(&self, tools: &[Value]) {
        let lines: Vec<String> = tools.iter().map(|t| json!({"type": "assistant", "message": {"content": [t]}}).to_string()).collect();
        std::fs::create_dir_all(self.transcript.parent().unwrap()).unwrap();
        std::fs::write(&self.transcript, lines.join("\n") + "\n").unwrap();
    }

    fn edit(&self, rel: &str) -> Value {
        json!({"type": "tool_use", "name": "Edit", "input": {"file_path": self.repo.join(rel).to_string_lossy()}})
    }

    fn payload(&self) -> Value {
        json!({"hook_event_name": "Stop", "session_id": SID, "cwd": self.repo.to_string_lossy(), "transcript_path": self.transcript.to_string_lossy()})
    }

    fn run(&self, extra: &[(&str, &str)]) -> Result<Option<Verdict>, Unsure> {
        nudge::decide(&self.payload(), &self.sb.env(extra))
    }

    fn edits(&self, n: usize) -> Vec<Value> {
        (0..n).map(|i| self.edit(&format!("f{i}.js"))).collect()
    }
}

fn reason(v: Option<Verdict>) -> String {
    match v {
        Some(Verdict::Advisory(j)) => {
            let v: Value = serde_json::from_str(&j).unwrap();
            assert_eq!(v["decision"], json!("block"));
            v["reason"].as_str().unwrap().to_string()
        }
        other => panic!("expected a nudge, got {other:?}"),
    }
}

#[test]
fn the_nudge_fires_at_the_threshold_and_names_the_files() {
    let n = nudge_box("nudge-threshold");
    n.transcript(&n.edits(2));
    assert!(n.run(&[]).unwrap().is_none());
    n.transcript(&n.edits(3));
    let r = reason(n.run(&[]).unwrap());
    assert!(r.contains("this session made 3 substantial code edit(s) across 3 file(s) (f0.js, f1.js, f2.js) with no Codex second opinion (advisory)."), "{r}");
    n.transcript(&n.edits(5));
    // the same session was nudged once for another set of files: a changed file set nudges again
    let r = reason(n.run(&[]).unwrap());
    assert!(r.contains("5 substantial code edit(s) across 5 file(s) (f0.js, f1.js, f2.js, …)"), "{r}");
}

#[test]
fn the_threshold_can_be_set_by_environment_and_settings() {
    let n = nudge_box("nudge-min");
    n.transcript(&n.edits(2));
    assert!(reason(n.run(&[("ANTIHALL_CODEX_NUDGE_MIN", "2")]).unwrap()).contains("2 substantial"));
    n.sb.write("home/.anti-hall/settings.json", r#"{"codexNudge":{"min":5}}"#);
    n.transcript(&n.edits(4));
    assert!(n.run(&[]).unwrap().is_none());
    // a junk environment value falls through to settings.json; a value below 1 is raised to 1
    assert!(n.run(&[("ANTIHALL_CODEX_NUDGE_MIN", "junk")]).unwrap().is_none());
    assert!(n.run(&[("ANTIHALL_CODEX_NUDGE_MIN", "0")]).unwrap().is_some());
}

#[test]
fn only_code_files_and_edit_tools_count() {
    let n = nudge_box("nudge-kinds");
    let mut t = vec![n.edit("a.md"), n.edit("b.json"), n.edit("Makefile")];
    t.push(json!({"type": "tool_use", "name": "Read", "input": {"file_path": n.repo.join("c.js").to_string_lossy()}}));
    t.push(json!({"type": "tool_use", "name": "Write", "input": {"file_path": n.repo.join("d.JS").to_string_lossy()}}));
    n.transcript(&t);
    assert!(n.run(&[("ANTIHALL_CODEX_NUDGE_MIN", "1")]).unwrap().is_some());
    assert!(n.run(&[("ANTIHALL_CODEX_NUDGE_MIN", "2")]).unwrap().is_none());
}

#[test]
fn a_codex_review_in_the_session_silences_it() {
    for (tool, input) in [
        ("Agent", json!({"subagent_type": "codex:codex-rescue"})),
        ("Task", json!({"agentType": "codex"})),
        ("Skill", json!({"skill": "codex:setup"})),
        ("Skill", json!({"command": "/CODEX"})),
    ] {
        let n = nudge_box("nudge-review");
        let mut t = n.edits(4);
        t.push(json!({"type": "tool_use", "name": tool, "input": input}));
        n.transcript(&t);
        assert!(n.run(&[]).unwrap().is_none(), "{tool}");
    }
    let n = nudge_box("nudge-not-review");
    let mut t = n.edits(4);
    t.push(json!({"type": "tool_use", "name": "Agent", "input": {"subagent_type": "codexy"}}));
    n.transcript(&t);
    assert!(n.run(&[]).unwrap().is_some());
}

#[test]
fn edits_in_the_session_scratchpad_and_outside_the_worktree_do_not_count() {
    let n = nudge_box("nudge-exclude");
    let enc: String = n.repo.to_string_lossy().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    let scratch = n.sb.root.join(format!("tmp/claude-{}/{enc}/{SID}/scratchpad", crate::checks::jsport::home::uid()));
    let mut t = n.edits(2);
    t.push(json!({"type": "tool_use", "name": "Edit", "input": {"file_path": scratch.join("x.py").to_string_lossy()}}));
    t.push(json!({"type": "tool_use", "name": "Edit", "input": {"file_path": "/elsewhere/y.js"}}));
    n.transcript(&t);
    assert!(n.run(&[]).unwrap().is_none(), "two counted edits are below the threshold");
    t.push(n.edit("g.js"));
    n.transcript(&t);
    assert!(reason(n.run(&[]).unwrap()).contains("3 substantial code edit(s)"));
}

#[test]
fn a_relative_path_without_a_known_directory_is_left_to_node() {
    let n = nudge_box("nudge-relative");
    n.transcript(&[json!({"type": "tool_use", "name": "Edit", "input": {"file_path": "sub/a.js"}})]);
    let mut p = n.payload();
    p.as_object_mut().unwrap().remove("cwd");
    assert_eq!(nudge::decide(&p, &n.sb.env(&[])), Err(Unsure));
}

#[test]
fn it_nudges_once_per_file_set_and_at_most_twice_per_session() {
    let n = nudge_box("nudge-bounded");
    n.transcript(&n.edits(3));
    assert!(n.run(&[]).unwrap().is_some());
    assert!(n.run(&[]).unwrap().is_none(), "same file set");
    n.transcript(&n.edits(4));
    assert!(n.run(&[]).unwrap().is_some());
    n.transcript(&n.edits(5));
    assert!(n.run(&[]).unwrap().is_none(), "the per-session cap");
    let state: Value =
        serde_json::from_str(&std::fs::read_to_string(n.sb.root.join(format!("home/.anti-hall/codex-nudge-state-{SID}.json"))).unwrap()).unwrap();
    assert_eq!(state["nudges"], json!(2));
}

#[test]
fn a_recorded_outage_or_a_switch_stops_the_nudge() {
    let n = nudge_box("nudge-gates");
    n.transcript(&n.edits(4));
    assert!(n.run(&[("ANTIHALL_CODEX_NUDGE", "off")]).unwrap().is_none());
    assert!(n.run(&[("ANTIHALL_JUDGE_CHILD", "1")]).unwrap().is_none());
    n.sb.write("home/.anti-hall/skip.json", r#"{"codex-nudge":4102444800000}"#);
    assert!(n.run(&[]).unwrap().is_none());
    n.sb.write("home/.anti-hall/skip.json", "{}");
    let until = date::now_ms() + 3_600_000.0;
    n.sb.write("home/.anti-hall/codex-availability.json", &format!(r#"{{"quota":{{"until":{until},"reason":"r"}}}}"#));
    assert!(n.run(&[]).unwrap().is_none(), "Codex cannot run a review");
}

const JEV_ON: [(&str, &str); 2] = [("ANTIHALL_JEV", "1"), ("CLAUDE_PLUGIN_OPTION_JEV_VERCEL_API_KEY", "vk")];

fn trivial(p: f64) -> String {
    format!(r#"{{"answers":{{"decision":{{"noul":{p}}}}}}}"#)
}

#[test]
fn the_codex_nudge_consults_jev_natively_in_every_mode() {
    use crate::jev::testkit::{install_scripted, log_rows, ok};
    // off (Jev disabled): the nudge stands and the off row is written
    let n = nudge_box("nudge-jev-off");
    n.transcript(&n.edits(4));
    let home = n.sb.root.join("home");
    let (jev, fake) = install_scripted(&home, &[], vec![]);
    assert!(n.run(&[]).unwrap().is_some());
    assert!(jev.drain(std::time::Duration::from_secs(5)));
    let rows = log_rows(&home);
    assert_eq!((rows.len(), rows[0]["id"].clone(), rows[0]["mode"].clone()), (1, json!("codexNudgeSubstantial"), json!("off")));
    assert!(fake.seen.lock().unwrap().is_empty());
    // shadow: asked, logged, the nudge stands even for a confident "trivial"
    let n = nudge_box("nudge-jev-shadow");
    n.transcript(&n.edits(4));
    let home = n.sb.root.join("home");
    let (jev, fake) = install_scripted(&home, &JEV_ON, vec![ok(200, &trivial(0.03))]);
    assert!(n.run(&JEV_ON).unwrap().is_some());
    assert!(jev.drain(std::time::Duration::from_secs(5)));
    let rows = log_rows(&home);
    assert_eq!((rows.len(), rows[0]["mode"].clone(), rows[0]["jev"].clone(), rows[0]["final"].clone()), (1, json!("shadow"), json!(false), json!(true)));
    let seen = fake.seen.lock().unwrap();
    assert_eq!(seen.len(), 1);
    let body = seen[0].2.as_deref().unwrap();
    assert!(body.contains("files: f0.js, f1.js, f2.js, f3.js") && body.contains("edits: 4"), "{body}");
    drop(seen);
    // on: a confident "trivial" skips the nudge (and spends no state)
    let n = nudge_box("nudge-jev-on");
    n.transcript(&n.edits(4));
    let home = n.sb.root.join("home");
    n.sb.write("home/.anti-hall/settings.json", r#"{"jevIntegrations":{"codexNudgeSubstantial":"on"}}"#);
    let (_jev, _fake) = install_scripted(&home, &JEV_ON, vec![ok(200, &trivial(0.03))]);
    assert!(n.run(&JEV_ON).unwrap().is_none(), "a confident trivial verdict skips the nudge");
    let rows = log_rows(&home);
    assert_eq!((rows.len(), rows[0]["mode"].clone(), rows[0]["final"].clone(), rows[0]["changed"].clone()), (1, json!("on"), json!(false), json!("relaxed")));
    assert!(!home.join(format!(".anti-hall/codex-nudge-state-{SID}.json")).exists());
    // on, and the call fails: today's verdict (nudge)
    let n = nudge_box("nudge-jev-on-fail");
    n.transcript(&n.edits(4));
    let home = n.sb.root.join("home");
    n.sb.write("home/.anti-hall/settings.json", r#"{"jevIntegrations":{"codexNudgeSubstantial":"on"}}"#);
    let (_jev, _fake) = install_scripted(&home, &JEV_ON, vec![]);
    assert!(n.run(&JEV_ON).unwrap().is_some(), "fail-open to nudging");
}

#[test]
fn old_state_of_other_sessions_is_pruned_once_per_window_and_never_the_live_one() {
    let n = nudge_box("nudge-prune");
    n.transcript(&n.edits(4));
    for (name, age_days) in [("old", 10u64), ("fresh", 1), (SID, 30)] {
        let rel = format!("home/.anti-hall/codex-nudge-state-{name}.json");
        n.sb.write(&rel, "{}");
        n.sb.age(&rel, age_days * 86400);
    }
    n.sb.write("home/.anti-hall/other-file.json", "{}");
    n.sb.age("home/.anti-hall/other-file.json", 30 * 86400);
    assert!(n.run(&[]).unwrap().is_some());
    let has = |rel: &str| n.sb.root.join(rel).exists();
    assert!(!has("home/.anti-hall/codex-nudge-state-old.json"));
    assert!(has("home/.anti-hall/codex-nudge-state-fresh.json"));
    assert!(has("home/.anti-hall/other-file.json"));
    assert!(has("home/.anti-hall/.prune-stamp-codex-nudge-state.json"));
    // a recent stamp throttles the next sweep
    n.sb.write("home/.anti-hall/codex-nudge-state-old2.json", "{}");
    n.sb.age("home/.anti-hall/codex-nudge-state-old2.json", 10 * 86400);
    n.transcript(&n.edits(5));
    assert!(n.run(&[]).unwrap().is_some());
    assert!(has("home/.anti-hall/codex-nudge-state-old2.json"));
}

#[test]
fn a_transcript_line_javascript_would_accept_but_serde_would_not_is_left_to_node() {
    let n = nudge_box("nudge-lone");
    let line = r#"{"type":"tool_use","name":"Edit","input":{"file_path":"/x/\ud83d.js"}}"#;
    std::fs::create_dir_all(n.transcript.parent().unwrap()).unwrap();
    std::fs::write(&n.transcript, format!("{line}\n")).unwrap();
    assert_eq!(n.run(&[]), Err(Unsure));
}

#[test]
fn a_scratchpad_inside_the_worktree_is_still_excluded() {
    let n = nudge_box("nudge-scratch-inside");
    let tmp = n.repo.join("tmpx");
    let enc: String = n.repo.to_string_lossy().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    let scratch = tmp.join(format!("claude-{}/{enc}/{SID}/scratchpad", crate::checks::jsport::home::uid()));
    let mut t = n.edits(2);
    for i in 0..3 {
        t.push(json!({"type": "tool_use", "name": "Edit", "input": {"file_path": scratch.join(format!("s{i}.py")).to_string_lossy()}}));
    }
    n.transcript(&t);
    let env = [("TMPDIR", tmp.to_str().unwrap())];
    assert!(n.run(&env).unwrap().is_none(), "the scratchpad edits do not count even inside the worktree");
    assert!(n.run(&[]).unwrap().is_some(), "without that TMPDIR they are ordinary edits");
}
