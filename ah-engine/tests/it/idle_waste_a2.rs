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

    fn check(&self, check: &str, payload: &serde_json::Value, extra: &[(&str, &str)]) -> String {
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
        let o = ch.wait_with_output().unwrap();
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
    assert!(blocked(&h, header_only, &[("ANTIHALL_CLAIM_EVIDENCE_MASK_TABLE_HEADER", "0")]), "switch off: the header is scanned (shows the test can see a block)");
    // the true positive survives: a body cell that asserts a check ran
    let h = Home::new("claim-body");
    let body = "Status of the lanes:\n\n| Lane | Result |\n|---|---|\n| a | All tests pass and the PR is merged. |\n";
    assert!(blocked(&h, body, &[]), "a claim in a body cell still needs evidence");
}
