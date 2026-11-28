//! `defect report` is usable from its own output: a rejected class lists the valid ones, the class defaults, `--title` and
//! `--body` are accepted, and `--help` lists the classes and severities (field reports from a live install).
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests
use std::path::{Path, PathBuf};
use std::process::Command;

const BIN: &str = env!("CARGO_BIN_EXE_ah-engine");

fn plugin_src() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("plugins").join("anti-hall").canonicalize().unwrap()
}

fn run(tag: &str, args: &[&str]) -> (String, String, i32) {
    let home = crate::common::testtmp::path(format!("ah-defect-ux-{}-{tag}", std::process::id()));
    std::fs::create_dir_all(&home).unwrap();
    let o = Command::new(BIN)
        .arg("defect")
        .args(args)
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap())
        .env("HOME", &home)
        .env("CLAUDE_PLUGIN_ROOT", plugin_src())
        .env("AH_ENGINE_PLUGIN_ROOT", plugin_src())
        .env("AH_ENGINE_DIR", home.join("state"))
        .current_dir(&home)
        .output()
        .unwrap();
    (String::from_utf8_lossy(&o.stdout).into_owned(), String::from_utf8_lossy(&o.stderr).into_owned(), o.status.code().unwrap_or(-1))
}

#[test]
fn invalid_class_lists_the_valid_classes() {
    let (out, _, code) = run("badclass", &["report", "--class", "wrong-claim", "--sev", "p2", "--sym", "x", "--json"]);
    assert_eq!(code, 1, "{out}");
    assert!(out.contains("invalid-class"), "{out}");
    for c in ["guard-false-positive", "guard-miss", "hook-crash", "other"] {
        assert!(out.contains(c), "valid class {c} listed: {out}");
    }
}

#[test]
fn omitted_class_defaults_to_other() {
    let (out, err, code) = run("noclass", &["report", "--sev", "p2", "--sym", "no class given", "--json"]);
    assert_eq!(code, 0, "{out}{err}");
    assert!(out.contains("recorded"), "{out}");
    assert!(out.contains("\"class\"") || out.contains("fp"), "{out}");
}

#[test]
fn title_and_body_are_accepted() {
    let (out, err, code) = run("aliases", &["report", "--sev", "p2", "--title", "short summary", "--body", "long repro text", "--json"]);
    assert_eq!(code, 0, "{out}{err}");
    assert!(out.contains("recorded"), "{out}");
    let (out, err, code) = run("bodyonly", &["report", "--sev", "p2", "--body", "only a body", "--json"]);
    assert_eq!(code, 0, "body alone is enough: {out}{err}");
}

#[test]
fn help_lists_classes_and_severities() {
    let (out, err, code) = run("help", &["report", "--help"]);
    assert_eq!(code, 0, "{err}");
    for w in ["guard-false-positive", "hook-crash", "p0", "p1", "p2", "--title", "--body"] {
        assert!(out.contains(w), "help names {w}: {out}");
    }
}
