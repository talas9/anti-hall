//! D76: the daemon never answers a request from its own environment. This scan fails when a non-test source file reads
//! the process environment (`env::var`, `env::var_os`, `env::vars`, `env::vars_os`) and is not on the list below, which says for each file
//! whose environment it is and why that is right. A new read has to be justified here in review.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use std::fs;
use std::path::{Path, PathBuf};

/// (file suffix, why the process environment is the right one there).
const ALLOW: &[(&str, &str)] = &[
    ("src/client.rs", "the hook client process: its environment IS the host's; reads the Node path and the fallback command"),
    ("src/reqenv.rs", "`RequestEnv::capture`, run by the client (or an in-process check) to forward the host's environment"),
    ("src/dispatch/table.rs", "the dispatcher is the hook client process: the plugin-root variable the host exported to this hook"),
    (
        "src/bootstrap.rs",
        "locates the plugin root and the state directory before any defaults can be read: the root and state-dir variables are the one environment the bootstrap needs",
    ),
    ("src/defaults.rs", "`AH_ENGINE_*` tunable overrides and names: settings of the engine process itself"),
    ("src/migrate/cli.rs", "the migrate and doctor command-line process: its own environment IS the caller's (the daemon is not involved, D76)"),
    ("src/cfgstore.rs", "integer `AH_ENGINE_*` engine tunables only (test `only_engine_tunables_read_the_process_environment`)"),
    (
        "src/checks/jsport/date.rs",
        "this process's own time zone variable, read only to prove the request's `TZ` is the zone the process converts local time in (a mismatch defers the check to Node); no request is answered from it",
    ),
    (
        "src/jev/settings.rs",
        "`Env::process`, the Jev lane's snapshot constructor, called by `ah-engine jev ask|status|scrub` (the CLI process: its own environment is right). Wiring Jev into the dispatcher (D58) must snapshot the REQUEST's environment (`Env::from_pairs`) instead",
    ),
];

fn sources(dir: &Path, out: &mut Vec<PathBuf>) {
    for e in fs::read_dir(dir).unwrap().flatten() {
        let p = e.path();
        if p.is_dir() {
            sources(&p, out);
        } else if p.extension().is_some_and(|x| x == "rs") {
            out.push(p);
        }
    }
}

#[test]
fn only_justified_files_read_the_process_environment() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut files = Vec::new();
    sources(&root.join("src"), &mut files);
    let mut bad = Vec::new();
    for f in files {
        let text = fs::read_to_string(&f).unwrap();
        let code = text.split("#[cfg(test)]").next().unwrap_or("");
        let reads = code
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .any(|l| l.contains("env::var(") || l.contains("env::var_os(") || l.contains("env::vars(") || l.contains("env::vars_os("));
        let rel = f.strip_prefix(root).unwrap().to_string_lossy().to_string();
        if reads && !ALLOW.iter().any(|(s, _)| rel.ends_with(s)) {
            bad.push(rel);
        }
    }
    assert!(bad.is_empty(), "these files read the process environment without a justification in {}: {bad:?}", file!());
}
