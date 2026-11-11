//! #709 (PR-A2): advisories that repeat on an unchanged state. Each test drives the shipped check through `ah-engine check` on a home of
//! its own and shows that the smarter rule is silent on an unchanged state and still fires on a state change (the true positive).
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

struct Home {
    dir: PathBuf,
}

impl Home {
    fn new(name: &str) -> Home {
        let dir = std::env::temp_dir().join(format!("aha-iw-{name}-{}", std::process::id()));
        ah_engine::discard::harmless(std::fs::remove_dir_all(&dir));
        std::fs::create_dir_all(dir.join("home/.anti-hall/ah-engine")).unwrap();
        Home { dir }
    }

    fn home(&self) -> PathBuf {
        self.dir.join("home")
    }

    fn run(&self, check: &str, payload: &serde_json::Value, extra: &[(&str, &str)]) -> std::process::Output {
        let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
        c.args(["check", check])
            .env_clear()
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .env("HOME", self.home())
            .env("AH_ENGINE_DIR", self.dir.join("state"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        c.envs(extra.iter().copied());
        let mut ch = c.spawn().unwrap();
        ch.stdin.take().unwrap().write_all(payload.to_string().as_bytes()).unwrap();
        ch.wait_with_output().unwrap()
    }

    fn check(&self, check: &str, payload: &serde_json::Value, extra: &[(&str, &str)]) -> String {
        let o = self.run(check, payload, extra);
        let out = String::from_utf8_lossy(&o.stdout).to_string();
        serde_json::from_str::<serde_json::Value>(out.trim_end())
            .ok()
            .and_then(|v| v["hookSpecificOutput"]["additionalContext"].as_str().map(str::to_string))
            .unwrap_or(out)
    }
}

impl Drop for Home {
    fn drop(&mut self) {
        ah_engine::discard::harmless(std::fs::remove_dir_all(&self.dir));
    }
}

fn now_s() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs()
}

fn disk_report(h: &Home, free: &str, level: &str) {
    let report = serde_json::json!({"ts_s": now_s(), "orphans": {"count": 0, "listed": []}, "kills": [], "resource": [],
        "disk": {"volumes": [{"path": "/vol", "dev": 7, "free": free, "pct": "2", "level": level}], "growth": []}});
    std::fs::write(h.home().join(".anti-hall/ah-engine/procwatch-report.json"), report.to_string()).unwrap();
}

/// Moves the last warning of the volume `secs` into the past (the check keeps real time).
fn age_disk_state(h: &Home, secs: u64) {
    let p = h.home().join(".anti-hall/ah-engine/procwatch-state.json");
    let mut st: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
    let at = st["disk"]["s1:/vol"]["at"].as_u64().expect("a per-volume record");
    st["disk"]["s1:/vol"]["at"] = (at - secs).into();
    std::fs::write(&p, st.to_string()).unwrap();
}

fn ups() -> serde_json::Value {
    serde_json::json!({"hook_event_name": "UserPromptSubmit", "session_id": "s1", "cwd": "/tmp"})
}

/// The disk warning re-fired once per cooldown at an unchanged level (19 of 59 idle ticks in a measured session). Now: once; again on a
/// level change, a fall of `diskWatch.repeatDropGb`, or the reminder floor; a recovered volume is forgotten, so a relapse warns at once.
#[test]
fn the_low_disk_warning_fires_on_a_state_change_not_on_every_cooldown() {
    let h = Home::new("disk");
    let cd = ("ANTIHALL_DISK_WATCH_COOLDOWN", "60");
    disk_report(&h, "40.0 GB", "warn");
    assert!(h.check("procwatch-advisory", &ups(), &[cd]).contains("/vol"), "the first warning");
    // same level, same space, the cooldown (60 s) long past: quiet
    age_disk_state(&h, 600);
    assert_eq!(h.check("procwatch-advisory", &ups(), &[cd]), "", "unchanged state: no repeat");
    // a fall of less than the drop (5 GB): quiet; a fall of more: warns
    disk_report(&h, "37.0 GB", "warn");
    assert_eq!(h.check("procwatch-advisory", &ups(), &[cd]), "", "3 GB lost is under the drop");
    disk_report(&h, "34.0 GB", "warn");
    assert!(h.check("procwatch-advisory", &ups(), &[cd]).contains("34.0 GB"), "6 GB lost since the last warning");
    // a worse level warns at once, even inside the cooldown
    disk_report(&h, "4.0 GB", "critical");
    assert!(h.check("procwatch-advisory", &ups(), &[("ANTIHALL_DISK_WATCH_COOLDOWN", "99999")]).contains("critical"), "a level change is never held back");
    // the reminder floor (6 h) re-sends an unchanged one
    assert_eq!(h.check("procwatch-advisory", &ups(), &[cd]), "");
    age_disk_state(&h, 7 * 3600);
    assert!(h.check("procwatch-advisory", &ups(), &[cd]).contains("critical"), "the reminder floor");
    // the volume recovers, then runs low again: that is a change
    let ok = serde_json::json!({"ts_s": now_s(), "orphans": {"count": 0, "listed": []}, "kills": [], "resource": [], "disk": {"volumes": [], "growth": []}});
    std::fs::write(h.home().join(".anti-hall/ah-engine/procwatch-report.json"), ok.to_string()).unwrap();
    assert_eq!(h.check("procwatch-advisory", &ups(), &[cd]), "");
    disk_report(&h, "40.0 GB", "warn");
    assert!(h.check("procwatch-advisory", &ups(), &[cd]).contains("/vol"), "a relapse warns at once");
    // the switch off restores one warning per cooldown at an unchanged level
    let h2 = Home::new("disk-off");
    let off = [cd, ("ANTIHALL_DISK_WATCH_REPEAT_ON_CHANGE_ONLY", "0")];
    disk_report(&h2, "40.0 GB", "warn");
    assert!(h2.check("procwatch-advisory", &ups(), &off).contains("/vol"));
    let p = h2.home().join(".anti-hall/ah-engine/procwatch-state.json");
    let mut st: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
    for (_, v) in st["last"].as_object_mut().unwrap().iter_mut() {
        *v = (v.as_u64().unwrap() - 600).into();
    }
    std::fs::write(&p, st.to_string()).unwrap();
    assert!(h2.check("procwatch-advisory", &ups(), &off).contains("/vol"), "switch off: the old cooldown rule");
}

fn state_path(h: &Home) -> PathBuf {
    h.home().join(".anti-hall/ah-engine/procwatch-state.json")
}

/// Moves the saved record of `session`'s volume by `delta` seconds (negative: into the past; positive: into the future).
fn shift_disk_state(h: &Home, session: &str, delta: i64) {
    let p = state_path(h);
    let mut st: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
    let k = format!("{session}:/vol");
    let at = st["disk"][&k]["at"].as_i64().expect("a per-volume record");
    st["disk"][&k]["at"] = (at + delta).into();
    std::fs::write(&p, st.to_string()).unwrap();
}

fn disk_recovered(h: &Home) {
    let ok = serde_json::json!({"ts_s": now_s(), "orphans": {"count": 0, "listed": []}, "kills": [], "resource": [], "disk": {"volumes": [], "growth": []}});
    std::fs::write(h.home().join(".anti-hall/ah-engine/procwatch-report.json"), ok.to_string()).unwrap();
}

const CD: (&str, &str) = ("ANTIHALL_DISK_WATCH_COOLDOWN", "60");

fn ups_of(session: &str) -> serde_json::Value {
    serde_json::json!({"hook_event_name": "UserPromptSubmit", "session_id": session, "cwd": "/tmp"})
}

/// The state-change logic must also run on a report with no low volume: it is how a recovery is recorded. Replay of the review finding:
/// WARN, recovered, the same WARN again. Before the fix the second WARN was silent (the stale record of the first one was never cleared).
#[test]
fn a_relapse_at_the_same_level_after_a_recovery_warns_again() {
    let h = Home::new("relapse");
    disk_report(&h, "40.0 GB", "warn");
    assert!(h.check("procwatch-advisory", &ups(), &[CD]).contains("/vol"), "the first warning");
    assert_eq!(h.check("procwatch-advisory", &ups(), &[CD]), "", "unchanged: quiet");
    disk_recovered(&h);
    assert_eq!(h.check("procwatch-advisory", &ups(), &[CD]), "", "recovered: nothing to say");
    let st: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(state_path(&h)).unwrap()).unwrap();
    assert!(st["disk"].as_object().unwrap().is_empty(), "the recovery cleared the record: {st}");
    disk_report(&h, "40.0 GB", "warn");
    assert!(h.check("procwatch-advisory", &ups(), &[CD]).contains("/vol"), "the same warning after a recovery is a relapse and fires");
}

/// A warning of one session says nothing about another: each session has its own record, and a recovery clears only its own.
#[test]
fn the_disk_warning_state_is_per_session() {
    let h = Home::new("sessions");
    disk_report(&h, "40.0 GB", "warn");
    assert!(h.check("procwatch-advisory", &ups_of("s1"), &[CD]).contains("/vol"));
    assert!(h.check("procwatch-advisory", &ups_of("s2"), &[CD]).contains("/vol"), "another session is warned on its own");
    assert_eq!(h.check("procwatch-advisory", &ups_of("s1"), &[CD]), "");
    assert_eq!(h.check("procwatch-advisory", &ups_of("s2"), &[CD]), "");
    // s1 sees the recovery; s2's record is untouched by it only in that s2 has its own: both clear on their own next report
    disk_recovered(&h);
    assert_eq!(h.check("procwatch-advisory", &ups_of("s1"), &[CD]), "");
    disk_report(&h, "40.0 GB", "warn");
    assert!(h.check("procwatch-advisory", &ups_of("s1"), &[CD]).contains("/vol"), "s1 relapses and is warned");
    assert_eq!(h.check("procwatch-advisory", &ups_of("s2"), &[CD]), "", "s2 saw no recovery: its unchanged state stays quiet");
}

/// The thresholds are inclusive: a fall of exactly `repeatDropGb` (5 GB) warns, a hair under does not; the reminder floor (6 h) warns at
/// exactly 6 h and not a minute short of it.
#[test]
fn the_drop_and_the_floor_boundaries_are_exact() {
    let h = Home::new("boundary-drop");
    disk_report(&h, "40.0 GB", "warn");
    assert!(h.check("procwatch-advisory", &ups(), &[CD]).contains("/vol"));
    shift_disk_state(&h, "s1", -600);
    disk_report(&h, "35.1 GB", "warn");
    assert_eq!(h.check("procwatch-advisory", &ups(), &[CD]), "", "4.9 GB lost: under the drop");
    disk_report(&h, "35.0 GB", "warn");
    assert!(h.check("procwatch-advisory", &ups(), &[CD]).contains("35.0 GB"), "exactly 5 GB lost: warns");

    let h = Home::new("boundary-floor");
    disk_report(&h, "40.0 GB", "warn");
    assert!(h.check("procwatch-advisory", &ups(), &[CD]).contains("/vol"));
    shift_disk_state(&h, "s1", -(6 * 3600 - 60));
    assert_eq!(h.check("procwatch-advisory", &ups(), &[CD]), "", "a minute short of 6 h: quiet");
    shift_disk_state(&h, "s1", -60);
    assert!(h.check("procwatch-advisory", &ups(), &[CD]).contains("/vol"), "6 h: the reminder");
}

/// A saved record that lies in the future (the clock was set back) holds nothing back: the warning fires.
#[test]
fn a_clock_set_back_does_not_silence_the_disk_warning() {
    let h = Home::new("rollback");
    disk_report(&h, "40.0 GB", "warn");
    assert!(h.check("procwatch-advisory", &ups(), &[CD]).contains("/vol"));
    assert_eq!(h.check("procwatch-advisory", &ups(), &[CD]), "");
    shift_disk_state(&h, "s1", 3 * 3600);
    assert!(h.check("procwatch-advisory", &ups(), &[CD]).contains("/vol"), "a record from the future is not trusted");
}

/// A missing or damaged state file fails open: to firing, never to silence.
#[test]
fn a_missing_or_corrupt_state_file_fires() {
    let h = Home::new("state-lost");
    disk_report(&h, "40.0 GB", "warn");
    assert!(h.check("procwatch-advisory", &ups(), &[CD]).contains("/vol"));
    assert_eq!(h.check("procwatch-advisory", &ups(), &[CD]), "");
    std::fs::remove_file(state_path(&h)).unwrap();
    assert!(h.check("procwatch-advisory", &ups(), &[CD]).contains("/vol"), "missing state: fires");
    assert_eq!(h.check("procwatch-advisory", &ups(), &[CD]), "");
    std::fs::write(state_path(&h), "{not json").unwrap();
    assert!(h.check("procwatch-advisory", &ups(), &[CD]).contains("/vol"), "corrupt state: fires");
    std::fs::write(state_path(&h), r#"{"last": 5, "disk": {"s1:/vol": "x"}}"#).unwrap();
    assert!(h.check("procwatch-advisory", &ups(), &[CD]).contains("/vol"), "wrongly shaped state: fires");
}

fn stop_payload(h: &Home, reply: &str) -> serde_json::Value {
    let t = h.dir.join("t.jsonl");
    let lines = [
        serde_json::json!({"type":"user","timestamp":"2026-09-01T10:00:00.000Z","message":{"role":"user","content":"status?"}}),
        serde_json::json!({"type":"assistant","timestamp":"2026-09-01T10:00:05.000Z","message":{"role":"assistant","content":[{"type":"text","text":reply}]}}),
    ];
    std::fs::write(&t, lines.iter().map(|l| format!("{l}\n")).collect::<String>()).unwrap();
    serde_json::json!({"hook_event_name":"Stop","session_id":"s1","cwd":"/tmp","transcript_path":t,"last_assistant_message":reply})
}

/// A markdown table whose header names a column "Verified" or "Merged" is a label, not a claim (GH #709, claim-evidence guard). The body
/// rows are still scanned, so a real claim in a cell still needs its evidence.
#[test]
fn a_table_header_cell_is_not_a_claim_but_a_body_cell_still_is() {
    let blocked = |h: &Home, reply: &str, extra: &[(&str, &str)]| h.check("claim-evidence-guard", &stop_payload(h, reply), extra).contains("block");
    let header_only = "Status of the lanes:\n\n| Lane | Verified? | Merged? |\n| --- | --- | --- |\n| a | pending | pending |\n| b | pending | pending |\n";
    let h = Home::new("claim-hdr");
    assert!(!blocked(&h, header_only, &[]), "a header cell is a label");
    // the switch off scans the header like any other line (the claim words in it are then judged)
    let h = Home::new("claim-hdr-off");
    assert!(
        blocked(&h, header_only, &[("ANTIHALL_CLAIM_EVIDENCE_MASK_TABLE_HEADER", "0")]),
        "switch off: the header is scanned (shows the test can see a block)"
    );
    // the true positive survives: a body cell that asserts a check ran
    let h = Home::new("claim-body");
    let body = "Status of the lanes:\n\n| Lane | Result |\n|---|---|\n| a | All tests pass and the PR is merged. |\n";
    assert!(blocked(&h, body, &[]), "a claim in a body cell still needs evidence");
}

/// Only a genuine table header is masked (GH #709 review): a pipe row that is a body row, a header whose cell asserts something, a lone
/// pipe row and a rule line under a table are all still scanned, so a real claim in them still needs its evidence.
#[test]
fn only_a_genuine_table_header_is_masked_not_a_row_that_asserts() {
    let blocked = |name: &str, reply: &str| {
        let h = Home::new(name);
        h.check("claim-evidence-guard", &stop_payload(&h, reply), &[]).contains("block")
    };
    let claim = "All tests pass and the PR is merged.";
    assert!(blocked("ce-rule", &format!("Status:\n\n| a | {claim} |\n---\n")), "a pipe row followed by a rule line is not a header");
    assert!(blocked("ce-hdr-assert", &format!("Status:\n\n| Lane | {claim} |\n| --- | --- |\n")), "a header cell that asserts is still scanned");
    assert!(blocked("ce-one-line", &format!("Status:\n\n| a | {claim} |\n")), "a lone pipe row is scanned");
    assert!(
        blocked("ce-body-then-rule", &format!("Status:\n\n| Lane | Result |\n|---|---|\n| a | {claim} |\n---\n")),
        "a body row before a rule line is scanned"
    );
    assert!(
        blocked("ce-body-then-sep", &format!("Status:\n\n| Lane | Result |\n|---|---|\n| a | {claim} |\n|---|---|\n")),
        "a second separator does not turn the body row into a header"
    );
    let label = "Status of the lanes:\n\n| Lane | Verified? | Merged? |\n| --- | --- | --- |\n| a | pending | pending |\n";
    assert!(!blocked("ce-label", label), "an ordinary label header is still masked");
}

/// The status line reads the window size from `context_window_size` (the field Claude Code documents) first and falls back to the older
/// keys (`statusline.max_keys`, first match wins; a non-number is skipped).
#[test]
fn the_statusline_window_size_prefers_the_documented_key_and_falls_back_to_the_old_ones() {
    let h = Home::new("statusline-keys");
    let line = |cw: serde_json::Value| -> String {
        let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
        c.arg("statusline")
            .env_clear()
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .env("HOME", h.home())
            .env("AH_ENGINE_DIR", h.dir.join("state"))
            .current_dir(&h.dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut ch = c.spawn().unwrap();
        ch.stdin.take().unwrap().write_all(serde_json::json!({"context_window": cw}).to_string().as_bytes()).unwrap();
        String::from_utf8_lossy(&ch.wait_with_output().unwrap().stdout).to_string()
    };
    let both = line(serde_json::json!({"used_percentage": 50, "used_tokens": 100000, "context_window_size": 1000000, "max_tokens": 200000}));
    assert!(both.contains("100k/1000k tokens"), "the documented key wins when both are present: {both}");
    let old = line(serde_json::json!({"used_percentage": 50, "used_tokens": 100000, "max_tokens": 200000}));
    assert!(old.contains("100k/200k tokens"), "the older key is the fallback: {old}");
    let junk = line(serde_json::json!({"used_percentage": 50, "used_tokens": 100000, "context_window_size": "big", "total_tokens": 400000}));
    assert!(junk.contains("100k/400k tokens"), "a non-numeric documented key is skipped: {junk}");
}

#[test]
fn pretool_disk_advisory_is_state_based_and_critical_blocks_repeat() {
    let h = Home::new("pretool-disk");
    let p = serde_json::json!({"hook_event_name":"PreToolUse","session_id":"s1","tool_name":"Bash","tool_input":{"command":"cargo build"}});
    let env = [("ANTIHALL_DISK_WATCH_COOLDOWN", "0")];
    disk_report(&h, "30.0 GB", "warn");
    assert_eq!(h.check("procwatch-advisory", &p, &env), "");
    disk_report(&h, "4.0 GB", "critical");
    let mut light = p.clone();
    light["tool_input"]["command"] = "pwd".into();
    assert_eq!(h.check("procwatch-advisory", &light, &env), "");
    for i in 0..10 {
        assert_eq!(h.check("procwatch-advisory", &p, &env).contains("4.0 GB"), i == 0, "call {i}");
    }
    disk_report(&h, "30.0 GB", "ok");
    assert_eq!(h.check("procwatch-advisory", &p, &env), "");
    disk_report(&h, "4.0 GB", "critical");
    assert!(h.check("procwatch-advisory", &p, &env).contains("critical"), "level changed after recovery");
    for _ in 0..3 {
        let out = h.run("procwatch-advisory", &p, &[("ANTIHALL_DISK_WATCH_BLOCK", "1")]);
        assert_eq!(out.status.code(), Some(2));
        assert!(String::from_utf8_lossy(&out.stderr).contains("critical"));
    }
}

#[test]
fn repeated_subagent_start_is_once_per_child_but_new_children_receive_protocol() {
    let h = Home::new("subagent-dedupe");
    let mut p = serde_json::json!({"hook_event_name":"SubagentStart","session_id":"s1","agent_id":"child-one"});
    let env = [("ANTIHALL_PROTOCOL_LEVEL", "full")];
    for i in 0..10 {
        let out = h.check("verify-first-subagent", &p, &env);
        assert_eq!(!out.is_empty(), i == 0, "call {i}: {out}");
    }
    p["agent_id"] = "child-two".into();
    assert!(!h.check("verify-first-subagent", &p, &env).is_empty(), "a new child needs its own protocol");
}

#[test]
fn orchestration_full_spawn_block_is_once_per_session_across_epochs() {
    let h = Home::new("orch-dedupe");
    let dir = h.home().join(".anti-hall/orch-full");
    std::fs::create_dir_all(&dir).unwrap();
    let p = serde_json::json!({"hook_event_name":"PreToolUse","session_id":"s1","tool_name":"Agent"});
    for epoch in ["first", "second"] {
        std::fs::write(dir.join("orch-full-s1.json"), serde_json::json!({"decision":"pending","epochId":epoch,"sentAt":now_s()*1000}).to_string()).unwrap();
        let out = h.check("orch-on-spawn", &p, &[]);
        assert_eq!(out.contains("ORCHESTRATION DISCIPLINE"), epoch == "first", "epoch {epoch}: {out}");
    }
}
