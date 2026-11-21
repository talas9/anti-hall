//! #910 guard: no test process resolves the plugin root, the defaults or its state through the real HOME. A test that spawns the
//! engine passes its own HOME AND its own plugin root explicitly (`crate::common::plugin_root()`, or `--plugin-root`): an `env_clear()`ed child loses the
//! `AH_ENGINE_PLUGIN_ROOT` that `.cargo/config.toml` pins for cargo-run tests, and would then fall to the snapshot cache, the install
//! record or a checkout walk (steps 3-5 of `bootstrap::locate_root`), which on a developer machine name the installed plugin.
//! The scan is source-level on purpose: it fails the build of a new test that forgets, before any run could read the real home.
use std::path::{Path, PathBuf};

fn rs_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for ent in std::fs::read_dir(dir).unwrap() {
        let p = ent.unwrap().path();
        if p.is_dir() {
            if p.file_name().is_some_and(|n| n != "fixtures" && n != "golden" && n != "goldens") {
                rs_files(&p, out);
            }
        } else if p.extension().is_some_and(|e| e == "rs") {
            out.push(p);
        }
    }
}

fn tests() -> Vec<(PathBuf, Vec<String>)> {
    let mut files = Vec::new();
    rs_files(&Path::new(env!("CARGO_MANIFEST_DIR")).join("tests"), &mut files);
    files.sort();
    files
        .into_iter()
        .filter(|p| p.file_name().is_some_and(|n| n != "home_isolation.rs"))
        .map(|p| {
            let text = std::fs::read_to_string(&p).unwrap();
            (p, text.lines().map(str::to_owned).collect())
        })
        .collect()
}

/// The names that pass a root the engine always takes: its own variable, `common::plugin_root()` (or a variable of that name) and the
/// flag. Not `CLAUDE_PLUGIN_ROOT` / `PLUGIN_ROOT`: the engine takes those only when they hold a defaults index, and tests point them at
/// scratch dirs, so a child that names only them still falls through to the lookup this guard exists to rule out.
/// The one exception, `CLAUDE_PLUGIN_ROOT` set to the no-node harness's `self.plugin`: a copy of this checkout's plugin (with its index),
/// set the way the host sets it because that harness is the no-Node install contract.
const NAMES_ROOT: [&str; 4] = ["AH_ENGINE_PLUGIN_ROOT", "plugin_root", "plugin-root", "\"CLAUDE_PLUGIN_ROOT\", &self.plugin)"];

/// The spawn statement that holds line `at`: its lines from a few above (the `let mut c = Command::new` line) down to the first line
/// that runs it. A rooted child names its plugin root anywhere in that span.
fn spawn_span(lines: &[String], at: usize) -> &[String] {
    let from = at.saturating_sub(6);
    let to = (at..lines.len().min(at + 60))
        .find(|i| ["spawn()", ".output()", ".status()", "run(c", "run(cmd"].iter().any(|m| lines[*i].contains(m)))
        .map_or(lines.len().min(at + 60), |i| i + 1);
    &lines[from..to]
}

/// An `env_clear()`ed child has no inherited plugin root (cargo's pinned `AH_ENGINE_PLUGIN_ROOT` is cleared with the rest), so its own
/// statement must name one. A helper that builds the base environment for a later `Command` (`base_env`) counts when the file as a
/// whole passes the root on every call path, which this scan cannot see: such a file names it next to its `env_clear()` in the helper.
#[test]
fn every_cleared_environment_names_its_plugin_root() {
    let mut bad = Vec::new();
    for (path, lines) in tests() {
        for (i, line) in lines.iter().enumerate() {
            if line.contains(".env_clear()") || line.trim_start().starts_with("c.env_clear") {
                let span = spawn_span(&lines, i);
                let to = (i + 40).min(lines.len());
                if !span.iter().chain(lines[i..to].iter()).any(|l| NAMES_ROOT.iter().any(|n| l.contains(n))) {
                    bad.push(format!("{}:{}", path.strip_prefix(env!("CARGO_MANIFEST_DIR")).unwrap().display(), i + 1));
                }
            }
        }
    }
    assert!(bad.is_empty(), "env_clear() with no plugin root (pass crate::common::plugin_root() as AH_ENGINE_PLUGIN_ROOT): {bad:#?}");
}

/// Reading `$HOME` in a test to build a path is reading the real home. The files below are the known, justified cases; a new one
/// must pass its own scratch home instead (or be added here with its reason).
const REAL_HOME_READS: [(&str, &str); 6] = [
    ("dssup_recon.rs", "scratch dir under the real home for the recon fixtures; nothing is read from it"),
    ("dssup_recon_s7.rs", "scratch dir under the real home for the recon fixtures; nothing is read from it"),
    ("dssup_recon_s8.rs", "scratch dir under the real home for the recon fixtures; nothing is read from it"),
    ("guards_dogfood_a.rs", "records the real HOME once to assert the test never touched it"),
    ("mem_gate.rs", "the memory gate measures a real transcript corpus; it is an opt-in measurement, not a defaults read"),
    ("task_stop_cost.rs", "compares against the real home to prove the test's own home is different"),
];

#[test]
fn no_test_reads_the_real_home_outside_the_justified_list() {
    let mut bad = Vec::new();
    for (path, lines) in tests() {
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        if REAL_HOME_READS.iter().any(|(f, _)| *f == name) {
            continue;
        }
        for (i, line) in lines.iter().enumerate() {
            let code = line.split("//").next().unwrap_or("");
            if code.contains("var(\"HOME\")") || code.contains("var_os(\"HOME\")") || code.contains("home_dir(") {
                bad.push(format!("{}:{}", path.strip_prefix(env!("CARGO_MANIFEST_DIR")).unwrap().display(), i + 1));
            }
        }
    }
    assert!(bad.is_empty(), "a test reads the real HOME (pass a scratch home explicitly): {bad:#?}");
    for (f, why) in REAL_HOME_READS {
        assert!(!why.is_empty() && tests().iter().any(|(p, _)| p.file_name().is_some_and(|n| n == f)), "stale allowlist entry {f}");
    }
}

/// `common::plugin_root()` is this checkout's plugin and holds the defaults index, so a test that passes it loads the files under
/// review, never an installed copy.
#[test]
fn the_shared_plugin_root_is_this_checkouts_plugin() {
    let root = crate::common::plugin_root();
    assert!(ah_engine::bootstrap::has_index(&root), "{} holds no defaults index", root.display());
    assert!(root.starts_with(Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap()));
}
