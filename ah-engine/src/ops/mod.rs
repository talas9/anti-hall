//! The operator command-line tools that were Node-only (L9a), as `ah-engine` commands.
//!
//! | Command | Node source | What it does |
//! |---|---|---|
//! | `settings` | `scripts/settings.js` | show, get, set and reset any anti-hall setting; the opt-in judge switch; the project allowlist trust records |
//! | `defect` | `scripts/defect.js` | file, list, show, rule and archive defect reports; the bug-history import and queries |
//! | `statusline` | `statusline/statusline*.js` | the status line the host renders after each turn |
//! | `phase` | `statusline/phase.js` | the coordinator's phase state the status line's phase bar shows (set, advance, step, agents, update, clear) |
//! | `install-statusline`, `uninstall-statusline` | `statusline/install-statusline.js`, `uninstall-statusline.js` | put the anti-hall status line into the host's `statusLine` setting, and take it out again |
//!
//! Each command reproduces the script's text and `--json` output byte for byte and leaves the same files behind. The
//! parity tests (`tests/it/operator_parity.rs`) run the real Node script and the command on the same seeded scratch home and
//! compare both. The schema, the message texts and every limit are the plugin's own files (`engine/defaults/`), read at run
//! time; the settings schema is generated from `hooks/lib/settings-schema.js` (`parity/gen-settings-cli.js`).
//!
//! Where the Node tool's behaviour cannot be reproduced exactly (a lock held by a live writer, a repository layout the
//! resolver cannot classify) the command writes nothing, says so on stderr and exits with the deferral code, so the Node
//! command can be run instead.
pub(crate) mod ahconfig;
pub(crate) mod allow;
pub(crate) mod cwbaseline;
pub(crate) mod defect;
pub(crate) mod dispatch_report;
pub(crate) mod finding_dedup;
pub(crate) mod js;
pub(crate) mod jsio;
pub(crate) mod phase;
pub(crate) mod settings;
pub(crate) mod shadow;
pub(crate) mod slcfg;
pub(crate) mod statusline;

use crate::cli::Parsed;
use crate::defaults;
use std::collections::BTreeMap;
use std::io::Write;

static OUT_CAPTURE: std::sync::Mutex<Option<Vec<u8>>> = std::sync::Mutex::new(None);
static ERR_CAPTURE: std::sync::Mutex<Option<Vec<u8>>> = std::sync::Mutex::new(None);

/// From now on keep a copy of everything written through [`out`] and [`err`] (for the Node shadow comparison).
pub(crate) fn start_capture() {
    *OUT_CAPTURE.lock().unwrap_or_else(|e| e.into_inner()) = Some(Vec::new());
    *ERR_CAPTURE.lock().unwrap_or_else(|e| e.into_inner()) = Some(Vec::new());
}

/// The captured stdout, emptied.
pub(crate) fn out_capture_take() -> Vec<u8> {
    OUT_CAPTURE.lock().unwrap_or_else(|e| e.into_inner()).take().unwrap_or_default()
}

/// The captured stderr, emptied.
pub(crate) fn err_capture_take() -> Vec<u8> {
    ERR_CAPTURE.lock().unwrap_or_else(|e| e.into_inner()).take().unwrap_or_default()
}

fn tee(cap: &std::sync::Mutex<Option<Vec<u8>>>, text: &str) {
    if let Some(buf) = cap.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
        buf.extend_from_slice(text.as_bytes());
    }
}

/// Text on stdout. A closed pipe has nobody left to tell, so the failure is dropped.
pub(crate) fn out(text: &str) {
    tee(&OUT_CAPTURE, text);
    crate::discard::harmless(std::io::stdout().lock().write_all(text.as_bytes())); // keep: stdout closed, nowhere to report it
}

/// Text on stderr (same rule as [`out`]).
pub(crate) fn err(text: &str) {
    tee(&ERR_CAPTURE, text);
    crate::discard::harmless(std::io::stderr().lock().write_all(text.as_bytes())); // keep: stderr closed, nowhere to report it
}

/// This process's environment, read once at the command line (a command-line process reads its own environment, D76).
pub(crate) fn env_snapshot() -> BTreeMap<String, String> {
    std::env::vars().collect()
}

/// The home directory: `HOME`, else the account's (Node's `os.homedir()`).
pub(crate) fn home(env: &BTreeMap<String, String>) -> String {
    env.get(defaults::env_name("home")).filter(|h| !h.is_empty()).cloned().or_else(crate::checks::jsport::home::real_home).unwrap_or_default()
}

/// The plugin root: the host's variable, else the root the engine's defaults were read from.
pub(crate) fn plugin_root(env: &BTreeMap<String, String>) -> Option<String> {
    env.get(defaults::env_name("plugin_root")).filter(|r| !r.is_empty()).cloned().or_else(|| defaults::root().map(|p| p.to_string_lossy().into_owned()))
}

/// The exit code a command returns when it leaves the work to the Node tool (nothing written).
pub(crate) fn defer_code() -> i32 {
    defaults::num("ops.defer_exit") as i32
}

/// `settings <verb> ...`
pub fn cmd_settings(p: &Parsed) -> i32 {
    settings::run(p)
}

/// `defect <verb> ...`
pub fn cmd_defect(p: &Parsed) -> i32 {
    defect::run(p)
}

/// `statusline`
pub fn cmd_statusline(p: &Parsed) -> i32 {
    statusline::run(p)
}

/// `phase <set|advance|step|agents|update|clear> ...`
pub fn cmd_phase(p: &Parsed) -> i32 {
    phase::run(p)
}

/// `install-statusline [--user|--project] [--consolidate]`
pub fn cmd_install_statusline(p: &Parsed) -> i32 {
    slcfg::run_install(p)
}

/// `uninstall-statusline [--user|--project] [--purge-base]`
pub fn cmd_uninstall_statusline(p: &Parsed) -> i32 {
    slcfg::run_uninstall(p)
}

/// `shadow-compare <dir>` (internal): the detached half of a Node shadow.
pub fn cmd_shadow_compare(p: &Parsed) -> i32 {
    p.raw.first().map_or(1, |d| shadow::compare(std::path::Path::new(d)))
}

// ---- the rules-script verbs of lane L03 (auto-handover-config, dispatch-report, finding-dedup, coordinator-work-baseline) -------

/// Every `opcli.*` setting as JSON, keyed without the prefix: the thresholds and texts the rules scripts read.
pub(crate) fn opcli_cfg() -> serde_json::Value {
    let map: serde_json::Map<String, serde_json::Value> =
        defaults::with_prefix("opcli.").into_iter().filter_map(|e| e.key.strip_prefix("opcli.").map(|k| (k.to_string(), e.value.to_json()))).collect();
    serde_json::Value::Object(map)
}

/// Ask the plugin script `script` for `func` (JSON in, JSON out); a run that could not answer says so on stderr.
pub(crate) fn opcli_call(verb: &str, script: &str, func: &str, input: &serde_json::Value) -> Option<serde_json::Value> {
    let r = crate::script::call_fn(script, func, input);
    if r.is_none() {
        err(&(defaults::render("opcli.rules_failed", &[("verb", &verb)]) + "\n"));
    }
    r
}

/// The text of a file, `None` when it cannot be read (decoded as Node's `utf8` does).
pub(crate) fn read_lossy(path: &std::path::Path) -> Option<String> {
    std::fs::read(path).ok().map(|b| String::from_utf8_lossy(&b).into_owned())
}

/// `auto-handover-config <verb>`
pub fn cmd_auto_handover_config(p: &Parsed) -> i32 {
    ahconfig::run(p)
}

/// `dispatch-report [--json]`
pub fn cmd_dispatch_report(p: &Parsed) -> i32 {
    dispatch_report::run(p)
}

/// `finding-dedup [--file <findings.json>]`
pub fn cmd_finding_dedup(p: &Parsed) -> i32 {
    finding_dedup::run(p)
}

/// `coordinator-work-baseline <transcript.jsonl> [--from-line N] [--cwd DIR] [--json]`
pub fn cmd_coordinator_work_baseline(p: &Parsed) -> i32 {
    cwbaseline::run(p)
}
