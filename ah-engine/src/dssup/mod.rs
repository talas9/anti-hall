//! The DevSwarm supervisor duties (lane l7): everything the Node liveness supervisor (`companion/devswarm-supervisor.js`, a
//! launchd / systemd / cron job every 60-120 s) does besides auto-archive, taken over by the engine's scheduler so the Node job
//! can be switched off as a whole and poke / escalate can move to the engine without a second actor.
//!
//! * [`Owner`] is the switch (`devswarm_sup.mode`): `witness` (default) leaves every duty to Node and runs none; `engine` runs the
//!   duties of `devswarm_sup.duties` from the scheduler job `devswarm_supervisor` ([`tick`]) and makes the `auto` executor of
//!   poke / escalate mean the engine.
//! * The double-run guard ([`node_running`]): while the Node supervisor's log is fresh the engine's duties and its poke /
//!   escalate stand down. The shared sweep lock (`locks/sweep.lock`, Node's file and protocol) makes a Node sweep exit while a
//!   tick runs, and Node's own cool-down state files are read and left as Node writes them.
//! * Duties are native (log rotation) or run Node's own function for the duty in a bounded subprocess ([`tick`]): the engine
//!   owns schedule, gate, lock, bound and record; the function keeps writing the files it writes today, so every shared file
//!   is Node's byte for byte. [`verdict`] mirrors an engine poke / escalation into the liveness verdict and recovery log in
//!   Node's exact shape. [`recover`] is the on-demand kill-and-resume, gated by the engine and executed by Node's CLI.
//! * Reusable by the CLI verbs (each is a plain function over a home directory, no scheduler needed): the liveness model
//!   ([`liveness`]), the app database snapshot and its queries ([`appsync::snap::read`], `workspace_for`, `focused`,
//!   `brief_status`, [`appsync::snap::finish_signal`], [`appsync::snap::transcript_cwd_matches`]), the archived-marker planner
//!   and writer ([`appsync::plan::plan_marks`], [`appsync::plan::plan_retire`], [`appsync::plan::write_marker`]), the names
//!   cache and message-gap report ([`appsync::state::refresh_names`], [`appsync::state::message_gaps`]), the whole state document
//!   ([`appsync::state::build`]), retention's planner and writers ([`retention::plan`], [`retention::apply`],
//!   [`retention::fold`], [`retention::cap`]) and the agreement protocol they share: plan natively, ask Node's own function for
//!   the same plan in a dry run, act only on an exact match.
//! * What is removed, and when: the supervisor's own log's previous generation when it rotates; aged reaped-workspace logs and
//!   child-gate files (housekeeping); a raw legacy journal file only after its verified compressed copy exists and Node's own dry
//!   run named it; an archive month file only when the user set a size cap and Node's dry run named the same list. No message row,
//!   descriptor or marker is ever deleted (retention empties a body after archiving it; a marker is retired by moving it).
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this module is a deliberate keep, for these reasons:
// - an unreadable state file or log is the absent one (Node's try/catch parity): the duty is due, the log counts as not fresh
// - an unparsable worker output is kept as text
pub mod appsync;
pub mod cli;
pub mod deferred;
pub mod housekeep;
pub mod ingest;
pub mod kill;
pub mod liveness;
pub mod recon;
pub mod recover;
pub mod retention;
pub mod tick;
pub mod verdict;
pub mod witness;

use crate::checks::git::util::Settings;
use crate::defaults;
use serde_json::Value;
use std::path::{Path, PathBuf};

/// Who owns the supervisor duties.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Owner {
    /// The Node supervisor job; the engine runs none of the duties.
    Witness,
    /// The engine's scheduler.
    Engine,
}

impl Owner {
    /// Parse the `devswarm_sup.mode` word; anything but the engine word is witness, so a typo never starts a second actor.
    pub fn parse(word: &str) -> Owner {
        let words = defaults::list("devswarm_sup.mode_words");
        if words.get(1).is_some_and(|w| word.trim().eq_ignore_ascii_case(w)) { Owner::Engine } else { Owner::Witness }
    }
}

/// The configured owner (environment, settings.json, shipped default).
pub fn owner() -> Owner {
    Owner::parse(&crate::dswire::effective_text("devswarm_sup.mode"))
}

/// A settings entry of `devswarm_sup.toml` (`key` is its full name), resolved the way Node's settings reader does (environment,
/// settings.json, plugin option, default).
pub(crate) fn setting(st: &Settings, key: &str) -> Value {
    crate::dsact::settings::resolve(st, defaults::raw(key))
}

/// The DevSwarm state directory (`~/.anti-hall/devswarm`).
pub fn root(home: &Path) -> PathBuf {
    crate::meshw::idlock::devswarm_root(home)
}

fn mtime_ms(p: &Path) -> Option<i64> {
    let t = std::fs::metadata(p).ok()?.modified().ok()?;
    Some(t.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as i64)
}

/// The path of the Node supervisor's log and of its rotated copy.
pub fn node_logs(home: &Path) -> [PathBuf; 2] {
    let log = home.join(defaults::text("devswarm_sup.node_log"));
    let mut backup = log.clone().into_os_string();
    backup.push(defaults::text("devswarm_sup.log_backup_suffix"));
    [log, PathBuf::from(backup)]
}

/// Whether the Node supervisor is running: `Some(age_ms)` of its newest log write when that is within `devswarm_sup.guard_ms`.
/// Evidence is the log because Node writes one line per sweep whichever scheduler runs it (launchd, systemd or cron).
pub fn node_running(home: &Path, now_ms: i64) -> Option<i64> {
    let newest = node_logs(home).iter().filter_map(|p| mtime_ms(p)).max()?;
    let age = (now_ms - newest).max(0);
    (age <= defaults::num("devswarm_sup.guard_ms") as i64).then_some(age)
}

/// Node's `supervisorEnabled(env)`: the hard kill switch (`DISABLE_ANTIHALL_DEVSWARM=1`) and the supervisor switch
/// (`ANTIHALL_DEVSWARM_SUPERVISOR=off`) both read from the environment only.
pub fn supervisor_enabled(st: &Settings) -> bool {
    let var = |k: &str| st.env.get(defaults::text(k)).map(|v| v.trim().to_ascii_lowercase());
    if var("devswarm_sup.env_disable").as_deref() == Some(defaults::text("devswarm_sup.env_disable_on")) {
        return false;
    }
    var("devswarm_sup.env_supervisor").as_deref() != Some(defaults::text("devswarm_sup.env_supervisor_off"))
}
