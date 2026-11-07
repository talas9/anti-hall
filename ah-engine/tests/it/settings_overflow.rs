//! #569: a settings number outside the f64 range (`1e400`, which JavaScript reads as Infinity) invalidates ITS key only. The rest of the
//! file still counts, so a guard switch in the same file keeps working; before the fix the whole file was "readable only by JavaScript"
//! and every check took its failure policy (a block here, an allow for a guard with a fallback).
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use serde_json::json;
use std::io::Write;
use std::process::{Command, Stdio};

fn engine(home: &std::path::Path, args: &[&str], stdin: Option<&str>) -> (i32, String) {
    let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"))
        .args(args)
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("HOME", home)
        .env("AH_ENGINE_DIR", home.join("state"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    c.stdin.take().unwrap().write_all(stdin.unwrap_or("").as_bytes()).unwrap();
    let out = c.wait_with_output().unwrap();
    (out.status.code().unwrap_or(-1), format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr)))
}

fn home(tag: &str) -> crate::common::TempDir {
    let d = crate::common::TempDir::at(std::env::temp_dir().join(format!("ah-settings-overflow-{tag}-{}", std::process::id())));
    std::fs::create_dir_all(d.join("home/.anti-hall")).unwrap();
    std::fs::create_dir_all(d.join("proj")).unwrap();
    d
}

#[test]
fn an_overflowing_number_leaves_the_guard_switch_in_the_same_file_working() {
    let huge_int = format!("1{}", "0".repeat(400));
    for (label, bad) in [("exponent", "1e400".to_string()), ("negative exponent", "-1e400".to_string()), ("309+ digit integer", huge_int)] {
        let d = home("guard");
        let proj = d.join("proj");
        std::fs::write(
            d.join("home/.anti-hall/settings.json"),
            format!(r#"{{"guards":{{"shipitGate":true}},"context":{{"stopContinuationLimit":{bad},"stopTotalContinuationLimit":5}}}}"#),
        )
        .unwrap();
        // a real PreToolUse payload: a write to a CI workflow with no PLAN.md, which the opt-in ship-it gate blocks
        let payload = json!({
            "hook_event_name": "PreToolUse", "session_id": "s569", "cwd": proj, "tool_name": "Write",
            "tool_input": {"file_path": proj.join(".github/workflows/ci.yml"), "content": "x"},
        })
        .to_string();
        let (_, out) = engine(&d.join("home"), &["check", "ship-it-guard"], Some(&payload));
        assert!(out.contains("create PLAN.md"), "{label}: the gate in the same file must still block: {out}");
        assert!(!out.contains("readable only by JavaScript"), "{label}: the file must not be rejected whole: {out}");
        // the unrelated number key in the same file is still read
        let (_, got) = engine(&d.join("home"), &["settings", "get", "context.stopTotalContinuationLimit"], None);
        assert!(got.contains("= 5 (source: file"), "{label}: {got}");
        // the overflowed key itself falls to its default
        let (_, got) = engine(&d.join("home"), &["settings", "get", "context.stopContinuationLimit"], None);
        assert!(got.contains("= 3 (source: default"), "{label}: {got}");
    }
}

#[test]
fn the_settings_cli_refuses_to_write_an_overflowing_number() {
    let d = home("cli");
    std::fs::write(d.join("home/.anti-hall/settings.json"), "{}").unwrap();
    for bad in ["1e400", "-1e400", "NaN"] {
        let (_, out) = engine(&d.join("home"), &["settings", "set", "context.stopContinuationLimit", bad], None);
        assert!(out.contains("expected a number"), "{bad}: {out}");
    }
    assert_eq!(std::fs::read_to_string(d.join("home/.anti-hall/settings.json")).unwrap(), "{}");
}

/// A real PreToolUse `Write` through `ah-engine hook --event PreToolUse --host claude` with `settings` as the home settings file.
fn edit_guard_hook(tag: &str, settings: &str) -> (i32, String) {
    let d = home(tag);
    let proj = d.join("proj");
    std::fs::write(d.join("home/.anti-hall/settings.json"), settings).unwrap();
    let payload = json!({
        "hook_event_name": "PreToolUse", "session_id": "s569-malformed", "cwd": proj, "tool_name": "Write",
        "tool_input": {"file_path": proj.join("src.txt"), "content": "x"},
    })
    .to_string();
    let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"))
        .args(["hook", "--event", "PreToolUse", "--host", "claude"])
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("HOME", d.join("home"))
        .env("AH_ENGINE_DIR", d.join("state"))
        .env("CLAUDE_CODE_ENTRYPOINT", "cli")
        .env("AH_ENGINE_DISPATCH_IN_PROCESS", "1")
        .env("AH_ENGINE_PLUGIN_ROOT", std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    c.stdin.take().unwrap().write_all(payload.as_bytes()).unwrap();
    let out = c.wait_with_output().unwrap();
    (out.status.code().unwrap_or(-1), format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr)))
}

#[test]
fn a_malformed_number_is_not_read_as_an_overflowing_one_and_the_file_stays_invalid() {
    // `01e400` is not a JSON number (a leading zero), so the file is invalid for JavaScript and for serde alike: the edit guard's
    // `false` in it must NOT take effect, exactly as before #569 (the baseline blocks the main agent's edit).
    let (rc_base, out_base) = edit_guard_hook("malformed-base", r#"{"safety":{"editGuard":true},"x":1}"#);
    assert_eq!(rc_base, 2, "baseline (guard on, readable file) blocks: {out_base}");
    for bad in ["01e400", "00", "-01e400", "1e", "1e+", "1.e400", ".5e400", "1e400-", "1e400e5", "+1e400"] {
        let (rc, out) = edit_guard_hook("malformed", &format!(r#"{{"safety":{{"editGuard":false}},"x":{bad}}}"#));
        assert_eq!(rc, 2, "{bad}: an invalid settings file must not switch the edit guard off: {out}");
        // either the edit guard's own block or, where serde meets a real overflow first (`1e400-`), the unreadable-file failure policy: a block both ways
        assert!(out.contains("file-edit check") || out.contains("settings file readable only by JavaScript"), "{bad}: {out}");
    }
}
