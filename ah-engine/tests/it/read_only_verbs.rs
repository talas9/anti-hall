//! Every read-only command (and read-only form of a command) runs in an empty scratch HOME and leaves nothing behind: no
//! `~/.anti-hall`, no file anywhere under the home. The registry (`commands.toml`: `read_only`, `read_only_args`) is what marks them,
//! and the CLI applies the read-only mode centrally, so a read verb added later is caught by the coverage check at the end.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests
use std::path::{Path, PathBuf};
use std::process::Command;

const BIN: &str = env!("CARGO_BIN_EXE_ah-engine");

fn plugin() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("plugins/anti-hall")
}

fn tree(p: &Path, out: &mut Vec<String>) {
    for e in std::fs::read_dir(p).unwrap().flatten() {
        out.push(e.path().display().to_string());
        if e.path().is_dir() {
            tree(&e.path(), out);
        }
    }
}

/// (command word, arguments): one run per read-only form.
fn runs(scratch: &Path) -> Vec<(&'static str, Vec<String>)> {
    let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
    let plug = plugin().display().to_string();
    let cfg = scratch.join("c.toml");
    std::fs::write(&cfg, "[daemon]\n").unwrap();
    let transcript = scratch.join("t.jsonl");
    std::fs::write(&transcript, "").unwrap();
    let findings = scratch.join("findings.json");
    std::fs::write(&findings, "[]").unwrap();
    vec![
        ("status", s(&[])),
        ("status", s(&["--memory"])),
        ("metrics", s(&[])),
        ("impact", s(&[])),
        ("docs", s(&["--format", "md"])),
        ("gen-hooks", s(&["--host", "claude"])),
        ("check", s(&["git-guard"])),
        ("version", s(&[])),
        ("capability-scan", vec!["--root".into(), plug.clone()]),
        ("harvest", vec!["--dir".into(), scratch.display().to_string()]),
        ("briefing", vec!["--root".into(), plug]),
        ("mesh", vec!["roster".into(), "--db".into(), scratch.join("none.db").display().to_string()]),
        ("telemetry", s(&[])),
        ("telemetry", s(&["summary"])),
        ("schedule", s(&["list"])),
        ("schedule", s(&["history"])),
        ("config", s(&[])),
        ("config", vec!["validate".into(), cfg.display().to_string()]),
        ("doctor", s(&["--check"])),
        ("agents", s(&["status"])),
        ("gh", s(&["status"])),
        ("devswarm", s(&["status"])),
        ("devswarm", s(&["line"])),
        ("gh", s(&["segment"])),
        ("jev-report", s(&[])),
        ("jev-report", s(&["--weekly", "--json"])),
        ("codex-limit-status", s(&[])),
        ("units", s(&["status"])),
        ("units", s(&["status", "--json"])),
        ("units", s(&["heal", "--dry-run"])),
        ("coordinator-work-baseline", vec![transcript.display().to_string(), "--json".into()]),
        ("dispatch-report", s(&["--json"])),
        ("finding-dedup", vec!["--file".into(), findings.display().to_string()]),
    ]
}

#[test]
fn read_only_verbs_create_nothing_in_an_empty_home() {
    let root = std::env::temp_dir().join(format!("ah-readonly-{}", std::process::id()));
    std::fs::remove_dir_all(&root).ok();
    let home = root.join("home");
    let scratch = root.join("scratch");
    std::fs::create_dir_all(&home).unwrap();
    std::fs::create_dir_all(&scratch).unwrap();
    let mut wrote = Vec::new();
    for (cmd, args) in runs(&scratch) {
        let out = Command::new(BIN)
            .arg(cmd)
            .args(&args)
            .env_clear()
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .env("HOME", &home)
            .env("AH_ENGINE_PLUGIN_ROOT", plugin())
            .env("AH_ENGINE_NOSPAWN", "1")
            .current_dir(&scratch)
            .output()
            .unwrap();
        let mut now = Vec::new();
        tree(&home, &mut now);
        if !now.is_empty() {
            wrote.push(format!("{cmd} {args:?} (exit {:?}) created {now:?}", out.status.code()));
            std::fs::remove_dir_all(&home).unwrap();
            std::fs::create_dir_all(&home).unwrap();
        }
    }
    std::fs::remove_dir_all(&root).ok();
    assert!(wrote.is_empty(), "read-only commands wrote to the home:\n{}", wrote.join("\n"));
}

#[test]
fn every_read_only_command_in_the_registry_is_exercised_above() {
    ah_engine::defaults::init().unwrap();
    let covered: Vec<&str> = runs(&std::env::temp_dir()).iter().map(|r| r.0).collect();
    for c in ah_engine::cli::commands().iter().filter(|c| c.read_only || !c.read_only_args.is_empty() || !c.read_only_flags.is_empty()) {
        assert!(covered.contains(&c.name.as_str()), "{} is marked read-only in commands.toml but read_only_verbs.rs does not run it", c.name);
    }
}
