//! D76: the daemon never answers a request from its own environment. This scan fails when a non-test source file reads
//! the process environment (`env::var`, `env::var_os`, `env::vars`, `env::vars_os`) and is not on the list below, which says for each file
//! whose environment it is and why that is right. A new read has to be justified here in review.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use std::fs;
use std::path::{Path, PathBuf};

/// (file suffix, why the process environment is the right one there).
const ALLOW: &[(&str, &str)] = &[
    ("src/client.rs", "the hook client process: its environment IS the host's; reads the Node path and the fallback command"),
    (
        "src/checks/mcp_reaper/sys.rs",
        "compares the daemon's own TZ with the request's, so a process start time is read in local time only when both would read the same zone",
    ),
    ("src/reqenv.rs", "`RequestEnv::capture`, run by the client (or an in-process check) to forward the host's environment"),
    ("src/dispatch/table.rs", "the dispatcher is the hook client process: the plugin-root variable the host exported to this hook"),
    (
        "src/bootstrap.rs",
        "locates the plugin root and the state directory before any defaults can be read: the root and state-dir variables are the one environment the bootstrap needs",
    ),
    ("src/defaults.rs", "`AH_ENGINE_*` tunable overrides and names: settings of the engine process itself"),
    ("src/migrate/cli.rs", "the migrate and doctor command-line process: its own environment IS the caller's (the daemon is not involved, D76)"),
    (
        "src/meshw/mod.rs",
        "the `ah-engine mesh` command-line process (D45 stage 2): it stands in for `node devswarm.js`, whose context is its own process environment, home and cwd; the daemon is not involved",
    ),
    (
        "src/meshw/verify.rs",
        "the detached background checker (`ah-engine mesh --verify`, its own process): its environment is the home it was launched with, handed to the Node check it compares against (D45)",
    ),
    ("src/cfgstore.rs", "integer `AH_ENGINE_*` engine tunables only (test `only_engine_tunables_read_the_process_environment`)"),
    (
        "src/checks/jsport/date.rs",
        "this process's own time zone variable, read only to prove the request's `TZ` is the zone the process converts local time in (a mismatch defers the check to Node); no request is answered from it",
    ),
    (
        "src/jev/settings.rs",
        "`Env::process`, the Jev lane's snapshot constructor, called by `ah-engine jev ask|status|scrub` (the CLI process: its own environment is right). Wiring Jev into the dispatcher (D58) must snapshot the REQUEST's environment (`Env::from_pairs`) instead",
    ),
    (
        "src/judge/cli.rs",
        "`process_env`, the environment a `claude -p` judge child is spawned with (Node: spawn with process.env). Only a one-shot process (`ah-engine check`, `ah-engine jev triage`) makes a judge call, never the daemon (`judge::blocking_calls_allowed`), so this process's environment is the hook's own",
    ),
    (
        "src/ops/mod.rs",
        "the operator command-line tools (`settings`, `defect`, `statusline`): one-shot processes whose own environment IS the caller's, snapshotted once at the command line (the daemon is not involved, D76)",
    ),
    (
        "src/ops/shadow.rs",
        "the Node shadow of those tools: the detached child inherits the command's environment on purpose, so the Node script sees what the real run saw; its only switch is its own recursion guard",
    ),
    (
        "src/meshw/simple.rs",
        "the detached `ah-engine mesh --verify` checker (same process as meshw/verify.rs): the real home it hands to the Node check it compares against",
    ),
    (
        "src/script/host_proc.rs",
        "the process's own time-zone variable, compared with the request's so a process age is converted in local time only when both read the same zone (a mismatch is unsure and defers); no request is answered from it",
    ),
    (
        "src/script/mod.rs",
        "`call_fn`, engine code that is not a hook (the GitHub poller, a statusline segment) reading a rule from a plugin script: there is no request, so the engine process's own settings environment selects the plugin home",
    ),
    (
        "src/dsact/runner.rs",
        "names the daemon's inherited variables to REMOVE from a spawned hivecontrol child (scrub prefixes from config); no value is read or used",
    ),
    (
        "src/dswire/mod.rs",
        "`Wire::start`, the DevSwarm layer's own startup in the daemon: detection of the host DevSwarm and its home are properties of the engine process, not of any request",
    ),
    (
        "src/dswire/cli.rs",
        "the `ah-engine devswarm` command-line process (and its one-shot state read): its own environment IS the caller's (the daemon is not involved, D76)",
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
