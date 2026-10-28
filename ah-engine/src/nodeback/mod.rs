//! The Node backup (owner decision 2026-10-22): the original Node hooks stay in the plugin as a backup, in two stages.
//!
//! * **Stage 1, the shadow** ([`shadow`]): the engine decides every hook event as always. For a bounded share of the decision events
//!   a detached `ah-engine shadow-run` runs the same Node hooks on their own, in a scratch home, with their own timeout. It never
//!   changes the engine's verdict and never delays the hook (it starts after the answer is written). Engine and Node each write one
//!   row per check to the [`ledger`]; [`report`] (`ah-engine shadow-compare`) pairs them.
//! * **Stage 2, the fallback switch** ([`fallback`]): `ah-engine fallback node|off`, a marker file the shell launcher reads, which
//!   makes the launcher run the original Node hooks directly instead of the engine. It never flips by itself.
//!
//! Every switch, rate, timeout, path and text is a shipped setting (`engine/defaults/nodeback.toml`); nothing is compiled in.

pub mod fallback;
pub mod ledger;
pub mod report;
pub mod shadow;

use std::path::PathBuf;

/// A file of the state directory named by the `files.<key>` setting.
pub(crate) fn state_file(key: &str) -> PathBuf {
    crate::paths::dir().join(crate::defaults::text(key))
}

/// A directory under the state directory named by a `nodeback.*_dir` setting.
pub(crate) fn state_sub(key: &str) -> PathBuf {
    crate::paths::dir().join(crate::defaults::text(key))
}

/// The Node backup directory (`nodeback.node_dir`, relative to the plugin root) of a host's plugin root, when it exists. The backup is not part
/// of the published plugin, so on an install without it the shadow and the fallback switch are no-ops, never a block.
pub(crate) fn node_dir(host: &str) -> Option<PathBuf> {
    let root = crate::dispatch::table::plugin_root(host).or_else(|| crate::defaults::root().map(|p| p.to_string_lossy().into_owned()))?;
    let dir = PathBuf::from(root).join(crate::defaults::text("nodeback.node_dir"));
    dir.is_dir().then_some(dir)
}

/// Days since the epoch of a `YYYY-MM-DD` date, or `None` for anything else.
pub(crate) fn parse_day(date: &str) -> Option<i64> {
    let mut it = date.trim().splitn(3, '-');
    let (y, m, d) = (it.next()?.parse::<i64>().ok()?, it.next()?.parse::<i64>().ok()?, it.next()?.parse::<i64>().ok()?);
    ((1..=12).contains(&m) && (1..=31).contains(&d)).then(|| crate::checks::jsport::date::days_from_civil(y, m, d))
}

/// The `YYYY-MM-DD` text of a day count.
pub(crate) fn day_text(day: i64) -> String {
    let (y, m, d) = crate::checks::jsport::date::civil_from_days(day);
    format!("{y:04}-{m:02}-{d:02}")
}

/// The day (days since the epoch, UTC) of a time in milliseconds.
pub(crate) fn day_of(ms: u64) -> i64 {
    (ms / crate::defaults::num("nodeback.day_ms")) as i64
}

/// `shadow-run <job file>` (internal): the detached half of the shadow, started by the engine, not by people.
pub fn cmd_shadow_run(p: &crate::cli::Parsed) -> i32 {
    match p.raw.first() {
        Some(job) => shadow::run(std::path::Path::new(job)),
        None => {
            crate::ops::err(&format!("{}\n", crate::defaults::text("nodeback.msg_usage_run")));
            64
        }
    }
}
