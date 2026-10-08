//! Node-vs-engine parity for `ah-engine doctor` (D81).
//!
//! The real Node doctor (`hooks/doctor.js --dry-run`, which also runs the live self-tests and previews the repairs) and the
//! engine doctor run on identically seeded, isolated homes (`HOME` and `USERPROFILE` at the fixture, no inherited environment,
//! `ANTIHALL_INGEST_DRY_RUN=1`, never the real home). For every check both make, the finding lines must be the same text:
//! the whole "Guard behavior" section, the Workflow templates section, the statusline configuration finding and each repair row
//! the engine reports. What only one of them checks (Node: the statusline render, the context footprint, the DevSwarm supervisor,
//! OMC and Codex detection, hook syntax; engine: the engine daemon) is outside the comparison, so a check the engine does not make
//! yet cannot pass as parity: the engine's report is asserted to contain every section it claims.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};

static N: AtomicUsize = AtomicUsize::new(0);

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf()
}

fn plugin() -> PathBuf {
    repo().join("plugins/anti-hall")
}

struct Fx {
    root: PathBuf,
    home: PathBuf,
    cwd: PathBuf,
}

impl Drop for Fx {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).ok();
    }
}

fn fixture(seed: &dyn Fn(&Path, &Path)) -> Fx {
    let root = std::env::temp_dir().join(format!("ah-doctor-parity-{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
    let (home, cwd) = (root.join("home"), root.join("cwd"));
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&cwd).unwrap();
    assert!(home.starts_with(std::env::temp_dir()), "a fixture home is always under the temp dir, never the real home");
    seed(&home, &cwd);
    Fx { root, home, cwd }
}

fn put(base: &Path, rel: &str, content: &str) {
    let p = base.join(rel);
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, content).unwrap();
}

fn env(cmd: &mut Command, fx: &Fx) {
    cmd.env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("HOME", &fx.home)
        .env("USERPROFILE", &fx.home)
        .env("ANTIHALL_INGEST_DRY_RUN", "1")
        .current_dir(&fx.cwd);
}

fn run_node(fx: &Fx, args: &[&str]) -> (i32, String) {
    let mut cmd = Command::new("node");
    cmd.arg(plugin().join("hooks/doctor.js")).args(args);
    env(&mut cmd, fx);
    let o = cmd.output().expect("node");
    (o.status.code().unwrap_or(-1), String::from_utf8_lossy(&o.stdout).into_owned())
}

fn run_rust(fx: &Fx, args: &[&str]) -> (i32, String) {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
    cmd.arg("doctor").arg("--plugin-root").arg(plugin()).args(args);
    env(&mut cmd, fx);
    let o = cmd.output().expect("ah-engine");
    (o.status.code().unwrap_or(-1), String::from_utf8_lossy(&o.stdout).into_owned())
}

/// The report split into sections: a blank line, then a heading, then indented findings.
fn sections(report: &str) -> Vec<(String, Vec<String>)> {
    let mut out: Vec<(String, Vec<String>)> = Vec::new();
    let mut prev_blank = false;
    for line in report.lines() {
        if line.is_empty() {
            prev_blank = true;
            continue;
        }
        if prev_blank && !line.starts_with("  ") {
            out.push((line.to_string(), Vec::new()));
        } else if let Some(s) = out.last_mut() {
            s.1.push(line.to_string());
        }
        prev_blank = false;
    }
    out
}

fn section<'a>(secs: &'a [(String, Vec<String>)], title: &str) -> Option<&'a Vec<String>> {
    secs.iter().find(|(t, _)| t == title).map(|(_, l)| l)
}

/// The report with the fixture's own directory (which differs between the two runs) written as `{ROOT}`.
fn norm(text: &str, fx: &Fx) -> String {
    let canon = fs::canonicalize(&fx.root).unwrap();
    text.replace(canon.to_string_lossy().as_ref(), "{ROOT}").replace(fx.root.to_string_lossy().as_ref(), "{ROOT}")
}

/// Compare the sections the two doctors share, finding for finding.
fn compare(name: &str, node: &str, rust: &str, fx: (&Fx, &Fx)) {
    let (node, rust) = (norm(node, fx.0), norm(rust, fx.1));
    let (node, rust) = (node.as_str(), rust.as_str());
    let (ns, rs) = (sections(node), sections(rust));
    for title in ["Guard behavior (live self-tests)", "Workflow templates (deadly-loop / ship-it)"] {
        let (n, r) = (section(&ns, title), section(&rs, title));
        assert!(n.is_some() && r.is_some(), "{name}: both reports have {title:?}\nnode: {node}\nrust: {rust}");
        // Node also checks that omc-detect.js is present and parses (a JavaScript syntax check the engine cannot make)
        let n: Vec<&String> = n.unwrap().iter().filter(|l| !l.contains("omc-detect.js")).collect();
        let r: Vec<&String> = r.unwrap().iter().collect();
        assert_eq!(n, r, "{name}: {title}");
    }
    // the statusline configuration finding is the first line of Node's section (the render checks follow it)
    let (n, r) = (section(&ns, "Statusline").unwrap(), section(&rs, "Statusline").unwrap());
    assert_eq!(n.first(), r.first(), "{name}: statusline configuration finding");
    // every repair row of the engine that Node also has is a row of Node's, with the same status and text
    let heading = |s: &[(String, Vec<String>)]| s.iter().find(|(t, _)| t.starts_with("Repair")).cloned();
    let (nr, rr) = (heading(&ns).expect("node repair section"), heading(&rs).expect("rust repair section"));
    assert_eq!(nr.0, rr.0, "{name}: repair heading");
    assert!(!rr.1.is_empty());
    // except the install-health repairs only the engine doctor has (the Node doctor has no such check): they are covered in doctor_scenarios.rs
    let engine_only = ["state-dir-create", "state-dir-private", "engine-binary-exec", "engine-binary-quarantine", "config-heal"];
    for line in rr.1.iter().filter(|l| !engine_only.iter().any(|id| l.contains(&format!(" {id}:")))) {
        assert!(nr.1.contains(line), "{name}: the engine's repair row is not a Node row: {line}\nnode rows: {:#?}", nr.1);
    }
    // the engine's report is complete for what it claims
    for title in ["Environment", "Engine", "Hooks (present)", "Guard behavior (live self-tests)", "Statusline", "Workflow templates (deadly-loop / ship-it)"] {
        assert!(section(&rs, title).is_some(), "{name}: engine report lacks {title}");
    }
    // the platform and version findings are the Node doctor's text
    let env_rust = section(&rs, "Environment").unwrap();
    let env_node = section(&ns, "Environment").unwrap();
    for line in env_rust {
        assert!(env_node.contains(line), "{name}: environment finding {line:?} not in node's: {env_node:?}");
    }
}

#[test]
fn the_shared_findings_match_on_a_clean_home() {
    let a = fixture(&|_, _| {});
    let b = fixture(&|_, _| {});
    let (nc, node) = run_node(&a, &["--dry-run"]);
    let (rc, rust) = run_rust(&b, &["--dry-run"]);
    assert_eq!(rc, nc, "exit code\nnode: {node}\nrust: {rust}");
    compare("clean", &node, &rust, (&a, &b));
    // the verdict line has the same shape
    assert!(rust.trim_end().lines().last().unwrap().starts_with("\u{2705} anti-hall \u{b7} doctor: active, "));
}

#[test]
fn workflow_templates_and_the_statusline_are_read_the_same_way() {
    let seed = |home: &Path, cwd: &Path| {
        put(home, ".claude/workflows/deadly-loop.js", "x");
        put(home, ".claude/workflows/Deadly-Loop-v2.JS", "x");
        put(home, ".claude/workflows/other.js", "x");
        put(cwd, ".claude/workflows/ship-it-x.js", "x");
        put(cwd, ".claude/workflows/ship-it.txt", "x");
        // a custom statusline longer than the 48 shown units, with an astral character at the cut
        put(
            home,
            ".claude/settings.json",
            &format!("{{\"statusLine\":{{\"type\":\"command\",\"command\":\"{}\\ud83d\\ude00 and more text after it\"}}}}", "a".repeat(47)),
        );
    };
    let a = fixture(&seed);
    let b = fixture(&seed);
    let (nc, node) = run_node(&a, &["--dry-run"]);
    let (rc, rust) = run_rust(&b, &["--dry-run"]);
    assert_eq!(rc, nc);
    compare("seeded", &node, &rust, (&a, &b));
    let ws = section(&sections(&rust), "Workflow templates (deadly-loop / ship-it)").unwrap().clone();
    assert!(ws[0].contains("saved workflow template(s) found:") && ws[0].contains("ship-it-x.js"), "{ws:?}");

    let seed2 = |home: &Path, cwd: &Path| {
        put(cwd, ".claude/settings.local.json", "{\"statusLine\":{\"command\":\"node /x/statusline/statusline.js\"}}");
        put(home, ".claude/settings.json", "{\"statusLine\":{\"command\":\"echo custom\"}}");
    };
    let (a, b) = (fixture(&seed2), fixture(&seed2));
    let (_, node) = run_node(&a, &["--dry-run"]);
    let (_, rust) = run_rust(&b, &["--dry-run"]);
    compare("statusline-local", &node, &rust, (&a, &b));
    assert!(section(&sections(&rust), "Statusline").unwrap()[0].contains("statusline installed (project-local)"));
}

#[test]
fn the_migrations_only_report_is_nodes_json_line() {
    let seed = |home: &Path, cwd: &Path| {
        put(cwd, ".anti-hall-progress.md", "progress\n");
        put(home, ".anti-hall/devswarm/parent-gate/s.json", "{\"a\":1}");
    };
    let (a, b) = (fixture(&seed), fixture(&seed));
    let (nc, node) = run_node(&a, &["--repair", "--migrations-only"]);
    let (rc, rust) = run_rust(&b, &["--repair", "--migrations-only"]);
    assert_eq!((nc, &node), (rc, &rust));
    assert!(node.contains("\"action\":\"migrations-only\""));
}

#[test]
fn a_read_only_run_changes_nothing_and_says_so() {
    let fx = fixture(&|home, cwd| {
        put(cwd, ".anti-hall-progress.md", "progress\n");
        put(home, ".anti-hall/devswarm/parent-gate/s.json", "{\"a\":1}");
    });
    let before = fs::read_to_string(fx.home.join(".anti-hall/devswarm/parent-gate/s.json")).unwrap();
    let (code, out) = run_rust(&fx, &["--quiet"]);
    assert_eq!(code, 0, "{out}");
    assert_eq!(fs::read_to_string(fx.home.join(".anti-hall/devswarm/parent-gate/s.json")).unwrap(), before);
    assert!(!fx.cwd.join(".anti-hall/history").exists());
    let (_, full) = run_rust(&fx, &[]);
    assert!(full.contains("read-only run \u{2014} nothing was changed"), "{full}");
}

#[test]
fn json_output_is_one_object_with_the_counts() {
    let fx = fixture(&|_, _| {});
    let (code, out) = run_rust(&fx, &["--check", "--json"]);
    let j: serde_json::Value = serde_json::from_str(out.trim()).unwrap();
    assert_eq!(code, 0, "{out}");
    assert_eq!(j["ok"], true);
    assert!(j["pass"].as_u64().unwrap() > 20);
    assert!(j["sections"].as_array().unwrap().iter().any(|s| s["title"] == "Guard behavior (live self-tests)"));
}

#[test]
fn flags_the_engine_doctor_does_not_handle_are_reported_not_ignored() {
    let fx = fixture(&|_, _| {});
    let (_, out) = run_rust(&fx, &["--check", "--prune-cache"]);
    assert!(out.contains("--prune-cache is not handled by the engine doctor yet"), "{out}");
}
