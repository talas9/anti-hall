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

thread_local! {
    /// Extra variables for the next runs on this thread (a test sets them with `with_env`).
    static EXTRA: std::cell::RefCell<Vec<(String, String)>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// Run `f` with extra environment variables on both doctors' runs.
fn with_env<T>(vars: &[(&str, &str)], f: impl FnOnce() -> T) -> T {
    EXTRA.with(|e| *e.borrow_mut() = vars.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect());
    let r = f();
    EXTRA.with(|e| e.borrow_mut().clear());
    r
}

fn env(cmd: &mut Command, fx: &Fx) {
    cmd.env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("HOME", &fx.home)
        .env("USERPROFILE", &fx.home)
        .env("ANTIHALL_INGEST_DRY_RUN", "1")
        .current_dir(&fx.cwd);
    EXTRA.with(|e| {
        for (k, v) in e.borrow().iter() {
            cmd.env(k, v);
        }
    });
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

// ---- the checks the engine doctor gained: statusline render, OMC, Codex, other plugins ---------------------------------------

/// The finding lines (trimmed of their mark and indent) of a report that contain any of the needles, in order.
fn pick(report: &str, needles: &[&str]) -> Vec<String> {
    report.lines().filter(|l| l.starts_with("  ") && needles.iter().any(|n| l.contains(n))).map(|l| l.trim().to_string()).collect()
}

/// Run both doctors on identically seeded homes and return the (node, rust) finding lines holding any of the needles.
fn both(seed: &dyn Fn(&Path, &Path), needles: &[&str]) -> (Vec<String>, Vec<String>) {
    let (a, b) = (fixture(seed), fixture(seed));
    let (_, node) = run_node(&a, &["--dry-run"]);
    let (_, rust) = run_rust(&b, &["--dry-run"]);
    (pick(&norm(&node, &a), needles), pick(&norm(&rust, &b), needles))
}

fn script(dir: &Path, name: &str, body: &str) -> String {
    put(dir, name, body);
    dir.join(name).to_string_lossy().into_owned()
}

#[test]
fn the_statusline_render_check_reads_the_two_lines_the_same_way() {
    let needles = ["statusline renders", "statusline rendered", "statusline.js", "statusline-rich.js", "dispatcher missing"];
    let (n, r) = both(&|_, _| {}, &needles);
    assert_eq!(n, r);
    assert!(r.iter().any(|l| l.contains("statusline renders 2 lines")), "{r:?}");
    assert!(r.iter().any(|l| l.contains("statusline-rich.js (line-1 renderer) present, syntax valid")), "{r:?}");
    // the stand-in script path of the test override: one line, a failure, a hang, a missing script
    let tmp = std::env::temp_dir().join(format!("ah-sl-standin-{}", std::process::id()));
    let one = script(&tmp, "one.js", "process.stdin.resume();process.stdin.on('end',()=>console.log('only'));");
    let fail = script(&tmp, "fail.js", "process.exit(3);");
    let hang = script(&tmp, "hang.js", "setInterval(()=>{},1000);");
    let two = script(&tmp, "two.js", "process.stdin.resume();process.stdin.on('end',()=>console.log('a\\nb'));");
    let cases = [
        ("one line", vec![("ANTIHALL_DOCTOR_SL_SCRIPT", one.as_str())], "rendered only 1 line"),
        ("failure", vec![("ANTIHALL_DOCTOR_SL_SCRIPT", fail.as_str())], "produced no output (exit 3)"),
        ("hang", vec![("ANTIHALL_DOCTOR_SL_SCRIPT", hang.as_str()), ("ANTIHALL_DOCTOR_SL_TIMEOUT_MS", "400")], "timed out under load"),
        ("two lines", vec![("ANTIHALL_DOCTOR_SL_SCRIPT", two.as_str())], "statusline renders 2 lines"),
        ("missing", vec![("ANTIHALL_DOCTOR_SL_SCRIPT", "/nonexistent/sl.js")], "dispatcher missing"),
    ];
    for (name, vars, want) in cases {
        let (n, r) = with_env(&vars, || both(&|_, _| {}, &needles));
        assert_eq!(n, r, "{name}");
        assert!(r.iter().any(|l| l.contains(want)), "{name}: {r:?}");
    }
    fs::remove_dir_all(&tmp).ok();
}

fn omc_seed(home: &Path, cwd: &Path, state: Option<&str>) {
    put(home, ".claude/settings.json", "{\"enabledPlugins\":{\"oh-my-claudecode@omc\":true}}");
    if let Some(s) = state {
        put(cwd, ".omc/state/ralph-state.json", s);
    }
}

#[test]
fn omc_detection_matches_nodes_gates() {
    let needles = ["OMC"];
    let now = || format!("{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis());
    let (n, r) = both(&|_, _| {}, &needles);
    assert_eq!(n, r);
    assert!(r.iter().any(|l| l.contains("OMC (oh-my-claudecode) not detected")), "{r:?}");
    let t = now();
    let fresh = format!("{{\"active\":true,\"updated_at\":{t}}}");
    let stale = "{\"active\":true,\"updated_at\":1000}".to_string();
    let pinned = format!("{{\"active\":true,\"updated_at\":{t},\"session_id\":\"other\"}}");
    let off = format!("{{\"active\":false,\"updated_at\":{t}}}");
    for (name, state, want) in [
        ("no state", None, "no active OMC autonomous loop"),
        ("fresh loop", Some(fresh.as_str()), "autonomous loop is ACTIVE"),
        ("stale loop", Some(stale.as_str()), "no active OMC autonomous loop"),
        ("pinned elsewhere", Some(pinned.as_str()), "no active OMC autonomous loop"),
        ("inactive", Some(off.as_str()), "no active OMC autonomous loop"),
    ] {
        let (n, r) = both(&|h, c| omc_seed(h, c, state), &needles);
        assert_eq!(n, r, "{name}");
        assert!(r.iter().any(|l| l.contains(want)), "{name}: {r:?}");
    }
    let (n, r) = with_env(&[("DISABLE_OMC", "1")], || both(&|h, c| omc_seed(h, c, Some(&fresh)), &needles));
    assert_eq!(n, r, "kill switch");
    assert!(r.iter().any(|l| l.contains("no active OMC autonomous loop")), "{r:?}");
    // a project-level enablement and an ISO timestamp
    let iso = "{\"active\":true,\"started_at\":\"2999-01-01T00:00:00.000Z\"}";
    let (n, r) = both(
        &|_, c| {
            put(c, ".claude/settings.local.json", "{\"enabledPlugins\":{\"oh-my-claudecode@omc\":true}}");
            put(c, ".omc/state/team-state.json", iso);
        },
        &needles,
    );
    assert_eq!(n, r, "project scope");
}

fn codex_hooks(wired: bool) -> String {
    if !wired {
        return "{\"hooks\":{\"Stop\":[]}}".to_string();
    }
    let thin = fs::read_to_string(plugin().join("codex/hooks/hooks.json")).unwrap();
    thin.replace("${PLUGIN_ROOT}", plugin().to_string_lossy().as_ref())
}

#[test]
fn codex_detection_matches_nodes_per_event_check() {
    let needles = ["Codex / OMX", "Codex config.toml", "Codex hooks.json ("];
    let (n, r) = both(&|_, _| {}, &needles);
    assert_eq!(n, r);
    assert!(r.iter().any(|l| l.contains("Codex / OMX not detected")), "{r:?}");
    let on = "[features]\nhooks = true\n";
    let off = "[features]\nother = 1\n";
    let cases = [
        ("project wired", Some(on), Some(true), None, None),
        ("project unwired, global missing", Some(on), Some(false), Some(off), None),
        ("project without hooks.json", Some(off), None, None, None),
        ("both", Some(on), Some(true), Some(on), Some(true)),
    ];
    for (name, pc, pw, gc, gw) in cases {
        let (n, r) = both(
            &|h, c| {
                if let Some(t) = pc {
                    put(c, ".codex/config.toml", t);
                    if let Some(w) = pw {
                        put(c, ".codex/hooks.json", &codex_hooks(w));
                    }
                }
                if let Some(t) = gc {
                    put(h, ".codex/config.toml", t);
                    if let Some(w) = gw {
                        put(h, ".codex/hooks.json", &codex_hooks(w));
                    }
                }
            },
            &needles,
        );
        assert_eq!(n, r, "{name}");
        assert!(!r.is_empty() && r.iter().all(|l| l.contains("Codex config.toml") || l.contains("Codex hooks.json")), "{name}: {r:?}");
    }
}

#[test]
fn the_foreign_plugin_scan_reports_the_same_conflicts() {
    let seed = |home: &Path, _: &Path| {
        let root = home.parent().unwrap();
        let foo = root.join("plugins/foo");
        let bar = root.join("plugins/bar");
        put(
            home,
            ".claude/settings.json",
            "{\"enabledPlugins\":{\"foo@m\":true,\"bar@m\":true,\"off@m\":false,\"anti-hall@anti-hall\":true,\"ghost@m\":true}}",
        );
        put(
            home,
            ".claude/plugins/installed_plugins.json",
            &format!(
                "{{\"plugins\":{{\"foo@m\":[{{\"installPath\":\"/old\"}},{{\"installPath\":{}}}],\"bar@m\":[{{\"installPath\":{}}}]}}}}",
                serde_json::to_string(&foo.to_string_lossy()).unwrap(),
                serde_json::to_string(&bar.to_string_lossy()).unwrap()
            ),
        );
        put(
            &foo,
            "hooks/hooks.json",
            "{\"hooks\":{\"PreToolUse\":[{\"matcher\":\"Bash\",\"hooks\":[{\"command\":\"node /u/secret/guard.js --x\"}]},{\"matcher\":\"Edit\",\"hooks\":[{\"command\":\"node e.js\"}]},{\"hooks\":[{\"command\":\"node g.cjs\"},{\"command\":\"node g.cjs\"}]}],\"Stop\":[{\"hooks\":[{\"command\":\"sh stop.sh\"}]}],\"SessionStart\":[{\"hooks\":[{\"command\":\"node s.mjs\"}]}],\"PostToolUse\":[{\"hooks\":[{\"command\":\"node p.js\"}]}]}}",
        );
        put(&foo, "skills/doctor/SKILL.md", "x");
        put(&foo, "skills/unique/SKILL.md", "x");
        put(&bar, "hooks/hooks.json", "{\"hooks\":{\"UserPromptSubmit\":[{\"hooks\":[{\"command\":\"node u.js\"}]}]}}");
    };
    let (a, b) = (fixture(&seed), fixture(&seed));
    let (_, node) = run_node(&a, &["--dry-run"]);
    let (_, rust) = run_rust(&b, &["--dry-run"]);
    let (ns, rs) = (sections(&norm(&node, &a)), sections(&norm(&rust, &b)));
    let title = "Foreign skill/hook conflict scan";
    let (n, r) = (section(&ns, title).unwrap(), section(&rs, title).unwrap());
    assert_eq!(n, r);
    assert!(r.len() >= 5 && r.iter().any(|l| l.contains("skill-name collision") && l.contains("\"doctor\"")), "{r:?}");
    assert!(r.iter().all(|l| !l.contains("secret")), "a command path never appears: {r:?}");
    let (n, r) = both(&|_, _| {}, &["foreign hook/skill conflicts"]);
    assert_eq!(n, r);
}

// ---- the explicit repair flags: ingest orphans, leaked test stores, resurrected rows ------------------------------------------------

/// A PATH directory with stub `launchctl` and `systemctl`: the listing comes from `loaded.txt` in it, an unload removes the entry
/// and is logged to `calls.log`. Nothing real is ever listed or unloaded.
fn scheduler_stubs(dir: &Path, labels: &[&str]) {
    let list_darwin: String = labels.iter().map(|l| format!("4242\t0\t{l}\n")).collect();
    let list_linux: String = labels
        .iter()
        .map(|l| format!("{}.service loaded active running demo\n", l.replace("com.anti-hall.devswarm-ingest", "anti-hall-devswarm-ingest")))
        .collect();
    put(dir, "loaded.darwin", &list_darwin);
    put(dir, "loaded.linux", &list_linux);
    let body = |kind: &str| {
        format!(
            "#!/bin/sh\nD=\"$(dirname \"$0\")\"\ncase \"$1\" in\n  list|--user) if [ \"$2\" = stop ]; then echo \"$@\" >> \"$D/calls.log\"; n=\"${{3%.service}}\"; grep -v \"^$n\" \"$D/loaded.{kind}\" > \"$D/loaded.tmp\"; mv \"$D/loaded.tmp\" \"$D/loaded.{kind}\"; exit 0; fi; if [ \"$1\" = list ]; then printf 'PID\\tStatus\\tLabel\\n'; fi; cat \"$D/loaded.{kind}\";;\n  bootout) echo \"$@\" >> \"$D/calls.log\"; n=\"${{2##*/}}\"; grep -v \"$n\" \"$D/loaded.{kind}\" > \"$D/loaded.tmp\"; mv \"$D/loaded.tmp\" \"$D/loaded.{kind}\"; exit 0;;\nesac\n"
        )
    };
    put(dir, "launchctl", &body("darwin"));
    put(dir, "systemctl", &body("linux"));
    for f in ["launchctl", "systemctl"] {
        let p = dir.join(f);
        let mut perm = fs::metadata(&p).unwrap().permissions();
        std::os::unix::fs::PermissionsExt::set_mode(&mut perm, 0o755);
        fs::set_permissions(&p, perm).unwrap();
    }
}

fn stub_path(dir: &Path) -> String {
    format!("{}:{}", dir.display(), std::env::var("PATH").unwrap_or_default())
}

const ORPHAN_A: &str = "com.anti-hall.devswarm-ingest.demo-a1b2c3";
const ORPHAN_LIVE: &str = "com.anti-hall.devswarm-ingest.demo-d4e5f6";
const ORPHAN_PLIST: &str = "com.anti-hall.devswarm-ingest.demo-0a0b0c";

fn seed_orphans(home: &Path, _cwd: &Path) {
    // a fresh heartbeat proves ORPHAN_LIVE's daemon is running
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis();
    put(home, ".anti-hall/devswarm/heartbeats/ingest-demo-d4e5f6.json", &format!("{{\"ts\":{now},\"pid\":1}}"));
    // a unit file whose directory is gone: report-only
    let plist = "<plist><dict><key>WorkingDirectory</key><string>/nonexistent/demo-wt</string><key>ProgramArguments</key><array><string>node</string><string>/nonexistent/ingest.js</string></array></dict></plist>";
    put(home, &format!("Library/LaunchAgents/{ORPHAN_PLIST}.plist"), plist);
    let svc = "[Service]\nWorkingDirectory=/nonexistent/demo-wt\nExecStart=\"node\" \"/nonexistent/ingest.js\"\n";
    put(home, ".config/systemd/user/anti-hall-devswarm-ingest-demo-0a0b0c.service", svc);
}

#[test]
fn the_orphan_report_and_its_dry_run_match_node_on_a_stubbed_scheduler() {
    let stubs = std::env::temp_dir().join(format!("ah-sched-stubs-{}", std::process::id()));
    scheduler_stubs(&stubs, &[ORPHAN_A, ORPHAN_LIVE, ORPHAN_PLIST, "com.anti-hall.devswarm-ingest.weird"]);
    let path = stub_path(&stubs);
    let (a, b) = (fixture(&seed_orphans), fixture(&seed_orphans));
    let args = ["--dry-run", "--repair-ingest-orphans"];
    let (nc, node, rc, rust) = with_env(&[("PATH", path.as_str())], || {
        let (nc, node) = run_node(&a, &args);
        let (rc, rust) = run_rust(&b, &args);
        (nc, node, rc, rust)
    });
    assert_eq!(nc, rc, "exit\nnode: {node}\nrust: {rust}");
    let (ns, rs) = (sections(&norm(&node, &a)), sections(&norm(&rust, &b)));
    for title in
        ["Orphaned launchd/systemd ingest registrations", "Repair ingest orphans (dry-run \u{2014} no changes written) [explicit --repair-ingest-orphans]"]
    {
        let (n, r) = (section(&ns, title), section(&rs, title));
        assert!(n.is_some() && r.is_some(), "{title}\nnode: {node}\nrust: {rust}");
        assert_eq!(n, r, "{title}");
    }
    let rows = section(&rs, "Repair ingest orphans (dry-run \u{2014} no changes written) [explicit --repair-ingest-orphans]").unwrap();
    // the loaded label with nothing on disk and no live daemon is the only one eligible
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert!(rows[0].contains("demo-a1b2c3") || rows[0].contains("demo-a1b2c3"), "{rows:?}");
    assert!(!stubs.join("calls.log").exists(), "a dry run unloads nothing");
    fs::remove_dir_all(&stubs).ok();
}

#[test]
fn applying_the_orphan_repair_unloads_once_and_a_second_run_finds_nothing() {
    let stubs = std::env::temp_dir().join(format!("ah-sched-apply-{}", std::process::id()));
    scheduler_stubs(&stubs, &[ORPHAN_A, ORPHAN_LIVE]);
    let fx = fixture(&seed_orphans);
    // TMPDIR names another directory, so the scratch home is not "under the temp directory" and the unload is not a no-op
    let other = stubs.join("not-the-home");
    fs::create_dir_all(&other).unwrap();
    let path = stub_path(&stubs);
    let vars = [("PATH", path.as_str()), ("TMPDIR", other.to_str().unwrap()), ("ANTIHALL_INGEST_DRY_RUN", "0")];
    let (code, out) = with_env(&vars, || run_rust(&fx, &["--repair-ingest-orphans", "--apply"]));
    assert_eq!(code, 0, "{out}");
    assert!(out.contains("UNLOADED [repair-ingest-orphan-") && out.contains("demo-a1b2c3"), "{out}");
    let calls = fs::read_to_string(stubs.join("calls.log")).unwrap_or_default();
    assert_eq!(calls.lines().count(), 1, "one unload, of the eligible label only: {calls}");
    assert!(calls.contains("demo-a1b2c3") && !calls.contains("demo-d4e5f6"), "{calls}");
    let (_, again) = with_env(&vars, || run_rust(&fx, &["--repair-ingest-orphans", "--apply"]));
    assert!(again.contains("none eligible") || again.contains("nothing to repair"), "{again}");
    assert_eq!(fs::read_to_string(stubs.join("calls.log")).unwrap().lines().count(), 1, "the second run unloads nothing");
    // the dry-run variable (a scratch home sets it) makes the apply a no-op, as in the Node installer
    scheduler_stubs(&stubs, &[ORPHAN_A]);
    fs::remove_file(stubs.join("calls.log")).ok();
    let (_, guarded) = with_env(&[("PATH", path.as_str()), ("ANTIHALL_INGEST_DRY_RUN", "1")], || run_rust(&fx, &["--repair-ingest-orphans", "--apply"]));
    assert!(guarded.contains("UNLOADED"), "{guarded}");
    assert!(!stubs.join("calls.log").exists(), "nothing was run under the dry-run variable");
    fs::remove_dir_all(&stubs).ok();
}

/// A SQLite store with the registry rows `rows` (worktree paths), at `<home>/.anti-hall/devswarm/store/<hash>/devswarm.db`.
fn seed_store(home: &Path, hash: &str, rows: &[&str]) {
    let dir = home.join(".anti-hall/devswarm/store").join(hash);
    fs::create_dir_all(&dir).unwrap();
    let c = rusqlite::Connection::open(dir.join("devswarm.db")).unwrap();
    c.execute_batch(
        "CREATE TABLE registry (id TEXT PRIMARY KEY, worktree_path TEXT, session_id TEXT, inbox_path TEXT, cursor_path TEXT, nudge_command TEXT, updated_at INTEGER, write_seq INTEGER);\
         CREATE TABLE messages (id INTEGER PRIMARY KEY, workspace_id TEXT, ts INTEGER, body TEXT);\
         CREATE TABLE cursors (workspace_id TEXT PRIMARY KEY, value INTEGER NOT NULL, updated_at INTEGER);",
    )
    .unwrap();
    for (i, wt) in rows.iter().enumerate() {
        c.execute("INSERT INTO registry (id, worktree_path) VALUES (?1, ?2)", rusqlite::params![format!("ws{i}"), wt]).unwrap();
    }
}

fn seed_stores(home: &Path, cwd: &Path) {
    seed_store(home, "ghost-a1b2c3", &["/tmp/ah-fixture-gone-wt"]);
    seed_store(home, "two-d4e5f6", &["/tmp/ah-fixture-gone-1", "/tmp/ah-fixture-gone-2"]);
    seed_store(home, "real-0a0b0c", &["/Users/someone/not-a-temp-dir-wt"]);
    seed_store(home, "alive-1a2b3c", &[cwd.to_str().unwrap()]);
    seed_store(home, "12345678", &["/private/var/folders/zz/ah-fixture-gone"]);
}

#[test]
fn leaked_test_stores_are_found_and_planned_as_node_does() {
    let (a, b) = (fixture(&seed_stores), fixture(&seed_stores));
    let args = ["--dry-run", "--repair-test-stores"];
    let (nc, node) = run_node(&a, &args);
    let (rc, rust) = run_rust(&b, &args);
    assert_eq!(nc, rc);
    let (ns, rs) = (sections(&norm(&node, &a)), sections(&norm(&rust, &b)));
    let detect = "leaked test-fixture stores";
    let (n, r) = (section(&ns, detect), section(&rs, detect));
    assert!(n.is_some() && r.is_some(), "node: {node}\nrust: {rust}");
    assert_eq!(n, r);
    assert!(r.unwrap()[0].contains("leaked test-fixture stores: 2"), "{r:?}");
    // the plan names the same stores; Node's rows say "remove", the engine's "move aside" (it never deletes)
    let title = "Repair test stores (dry-run \u{2014} no changes written) [explicit --repair-test-stores]";
    let ids = |rows: &Vec<String>| -> Vec<String> { rows.iter().map(|l| l.split(']').next().unwrap_or("").to_string()).collect() };
    assert_eq!(ids(section(&ns, title).unwrap()), ids(section(&rs, title).unwrap()));
}

#[test]
fn applying_the_test_store_repair_moves_the_store_aside_and_never_deletes() {
    let fx = fixture(&seed_stores);
    let store = fx.home.join(".anti-hall/devswarm/store");
    let (code, out) = run_rust(&fx, &["--repair-test-stores", "--apply"]);
    assert_eq!(code, 0, "{out}");
    assert!(out.contains("MOVED ASIDE [repair-test-store-ghost-a1b2c3]") && out.contains("MOVED ASIDE [repair-test-store-12345678]"), "{out}");
    assert!(!store.join("ghost-a1b2c3").exists());
    let aside = fx.home.join(".anti-hall/devswarm/stores-aside");
    let kept: Vec<String> = fs::read_dir(&aside).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    assert_eq!(kept.len(), 2, "{kept:?}");
    assert!(kept.iter().any(|n| n.starts_with("ghost-a1b2c3-")) && fs::read_dir(aside.join(&kept[0])).unwrap().next().is_some(), "the data is kept: {kept:?}");
    for survivor in ["two-d4e5f6", "real-0a0b0c", "alive-1a2b3c"] {
        assert!(store.join(survivor).join("devswarm.db").exists(), "{survivor} is not a leak and stays");
    }
    let (_, again) = run_rust(&fx, &["--repair-test-stores", "--apply"]);
    assert!(again.contains("no leaked test-fixture stores found"), "{again}");
    // a journal-backend store is not inspected: said so, not silently skipped
    let j = fx.home.join(".anti-hall/devswarm/store/jrnl-0f0f0f");
    fs::create_dir_all(&j).unwrap();
    fs::write(j.join("BACKEND"), "journal").unwrap();
    let (jc, jout) = run_rust(&fx, &["--repair-test-stores"]);
    assert_eq!(jc, 0, "{jout}");
    assert!(jout.contains("DEFERRED [repair-test-stores] 1 store(s) use the journal backend"), "{jout}");
}

#[test]
fn the_resurrected_rows_repair_matches_node_without_stores_and_defers_with_them() {
    let (a, b) = (fixture(&|_, _| {}), fixture(&|_, _| {}));
    let (nc, node) = run_node(&a, &["--repair-resurrected"]);
    let (rc, rust) = run_rust(&b, &["--repair-resurrected"]);
    assert_eq!(nc, rc);
    let title = "Repair resurrected registry rows (dry-run \u{2014} no changes written) [explicit --repair-resurrected]";
    assert_eq!(section(&sections(&node), title), section(&sections(&rust), title), "node: {node}\nrust: {rust}");
    let with = fixture(&|h, _| seed_store(h, "ghost-a1b2c3", &["/tmp/ah-fixture-gone-wt"]));
    let (code, out) = run_rust(&with, &["--repair-resurrected", "--apply"]);
    assert_eq!(code, 0, "a deferral is not a failure: {out}");
    assert!(out.contains("DEFERRED [repair-resurrected]") && with.home.join(".anti-hall/devswarm/store/ghost-a1b2c3/devswarm.db").exists(), "{out}");
}

// ---- the DevSwarm supervisor section -----------------------------------------------------------------------------------------------

#[test]
fn the_devswarm_section_is_silent_when_dormant_and_runs_the_four_hook_tests_when_it_is_not() {
    // dormant: no descriptor, no DevSwarm environment, nothing installed: neither doctor prints the section
    let (n, r) = both(&|_, _| {}, &["DevSwarm liveness"]);
    assert!(n.is_empty() && r.is_empty(), "{n:?} {r:?}");
    // a registered workspace makes it active; the hook tests and the measurement counters read the same in both
    let needles = [
        "writes a turn-authored heartbeat",
        "forces a child to self-report",
        "devswarm-parent-inbox self-test",
        "surfaces a workspace unread backlog",
        "blocks the Primary turn",
        "supervisor companion",
        "cron ticks that found mail",
        "CHILD NOT DRAINING",
        "wake-watch idle-skips",
        "wake-watch limit-skips",
        "mailbox-cron-missing",
    ];
    let seed = |home: &Path, _: &Path| {
        put(home, ".anti-hall/devswarm/workspaces/x1.json", "{\"id\":\"x1\",\"worktreePath\":\"/nonexistent/wt\",\"sessionId\":\"s1\"}");
        put(home, ".anti-hall/devswarm/cron-found-mail.jsonl", "{\"a\":1}\n\n{\"a\":2}\n");
        put(home, ".anti-hall/devswarm/rearm-cues.jsonl", "{\"trigger\":\"idle-skip\"}\n{\"trigger\":\"limit-skip\"}\n{\"trigger\":\"idle-skip\"}\nnot json\n");
        put(home, ".anti-hall/devswarm/cron-missing-warned.jsonl", "{}\n");
    };
    let (n, r) = both(&seed, &needles);
    assert_eq!(n, r);
    for want in [
        "devswarm-child-turn writes",
        "devswarm-child-gate forces",
        "devswarm-parent-gate blocks",
        "cron ticks that found mail while a watcher was armed: 2",
        "wake-watch idle-skips: 2",
        "wake-watch limit-skips: 1",
        "mailbox-cron-missing warnings shown: 1",
    ] {
        assert!(r.iter().any(|l| l.contains(want)), "{want}: {r:?}");
    }
    // a Primary session (DevSwarm environment, no descriptors) is active too
    let (n, r) = with_env(&[("DEVSWARM_REPO_ID", "repo-x")], || both(&|_, _| {}, &needles));
    assert_eq!(n, r);
    assert!(!r.is_empty());
}
