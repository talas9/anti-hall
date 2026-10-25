//! #104: the Jev review scan (`jev-setup review-due`, and the SessionStart `jev-review-reminder` through the same code) must not
//! grow with the decision log. It used to parse every retained row into memory at once: on the live 12 MB log that was about
//! 56 MB of heap per SessionStart, which with two overlapping session starts pushed the daemon over its RSS cap and restarted it.
//! The bound is the scan's memory hard limit, `mem.jev_review_scan_hard_bytes`, read from the shipped defaults.
use crate::common::TempDir;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const BIN: &str = env!("CARGO_BIN_EXE_ah-engine");

fn plugin_src() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("plugins").join("anti-hall")
}

/// `mem.jev_review_scan_hard_bytes` from the shipped defaults.
fn scan_hard_bytes() -> u64 {
    let text = fs::read_to_string(plugin_src().join("engine/defaults/mem.toml")).unwrap();
    let doc: toml::Table = toml::from_str(&text).unwrap();
    doc["mem"]["jev_review_scan_hard_bytes"]["value"].as_integer().unwrap() as u64
}

/// A home with Jev on, one integration in shadow and `rows` decision rows in the live log.
fn home_with_rows(dir: &Path, rows: usize) {
    let base = dir.join(".anti-hall");
    fs::create_dir_all(base.join("logs")).unwrap();
    fs::write(base.join("jev.json"), r#"{"enabled":true,"integrations":{"devswarmStepMap":"shadow"}}"#).unwrap();
    fs::write(base.join("settings.json"), r#"{"jev":{"enabled":true},"jevIntegrations":{"devswarmStepMap":"shadow"}}"#).unwrap();
    let mut log = std::io::BufWriter::new(fs::File::create(base.join("logs/jev-assist.ndjson")).unwrap());
    for i in 0..rows {
        // the shape of a live decision row (about 350 bytes)
        writeln!(
            log,
            r#"{{"ts":"2026-09-01T10:{:02}:{:02}.000Z","id":"devswarmStepMap","mode":"shadow","decision":"allow","confidence":0.87,"latency_ms":412,"model":"haiku","reason":"the step map matches the workspace plan and no step is skipped or reordered by the child","hash":"{i:016x}","session":"s-{i}"}}"#,
            (i / 60) % 60,
            i % 60
        )
        .unwrap();
    }
    log.flush().unwrap();
}

/// Peak resident bytes of one `jev-setup review-due` run in `home` (wait4 on that one child, so other tests' children do not
/// count), and its stdout.
fn review_due_peak(home: &Path) -> (u64, String) {
    let child = Command::new(BIN)
        .args(["jev-setup", "review-due"])
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap())
        .env("HOME", home)
        .env("AH_ENGINE_DIR", home.join("eng"))
        .env("CLAUDE_PLUGIN_ROOT", plugin_src())
        .env("ANTIHALL_INGEST_DRY_RUN", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut child = child;
    let mut out = child.stdout.take().unwrap();
    let mut text = String::new();
    std::io::Read::read_to_string(&mut out, &mut text).unwrap();
    let mut status = 0;
    // SAFETY: an all-zero `rusage` is a valid value; wait4 fills it for the child it reaps.
    let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
    // SAFETY: `child.id()` is a child of this process that nothing else waits for; both out-pointers are valid.
    let pid = unsafe { libc::wait4(child.id() as libc::pid_t, &mut status, 0, &mut usage) };
    assert_eq!(pid, child.id() as libc::pid_t, "wait4 failed");
    // ru_maxrss is bytes on macOS and kilobytes on Linux
    let peak = if cfg!(target_os = "macos") { usage.ru_maxrss as u64 } else { usage.ru_maxrss as u64 * 1024 };
    (peak, text)
}

#[test]
fn review_scan_memory_does_not_grow_with_the_decision_log() {
    let small = TempDir::at(std::env::temp_dir().join(format!("ah-jrs-small-{}", std::process::id())));
    let large = TempDir::at(std::env::temp_dir().join(format!("ah-jrs-large-{}", std::process::id())));
    home_with_rows(&small, 10);
    home_with_rows(&large, 80_000); // ~28 MB of log
    let (base, _) = review_due_peak(&small);
    let (big, big_out) = review_due_peak(&large);
    // the scan still counts every row (the line names the decisions)
    assert!(big_out.contains("80000 decisions"), "the large log was not counted: {big_out}");
    let growth = big.saturating_sub(base);
    // the scan may hold up to its hard limit; the same again covers allocator rounding between the two processes
    let bound = 2 * scan_hard_bytes();
    assert!(growth <= bound, "review-due peak RSS grew by {growth} bytes on a 28 MB log (small log {base}, large {big}); bound {bound}");
}
