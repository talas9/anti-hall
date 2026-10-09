//! Is a newer build of the plugin installed than the one this watcher runs? Port of `checkStaleVersion`, `canHandoff` and the
//! three line formatters (`formatStaleVersionLine`, `formatUpdateAvailableLine`, `formatHandoffLine`) of
//! `companion/lib/devswarm-wake-watch.js`. A pure read of the harness registry, the version cache and the marketplace clone.
use super::who::Proc;
use crate::defaults;
use crate::jev::settings::Env as JevEnv;
use crate::operator::update::{compare_versions, known_versions, semver_ok};
use std::path::PathBuf;

/// A newer build.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Stale {
    /// The newest version known.
    pub newest: String,
    /// Its watcher script when it exists on disk (a handoff target).
    pub script: Option<PathBuf>,
    /// The harness registry itself names it.
    pub registered: bool,
    /// The version the registry names.
    pub registered_version: Option<String>,
}

fn word(role_or_id: &str) -> String {
    if role_or_id.is_empty() { defaults::text("wake_watch.word_unknown").to_string() } else { role_or_id.to_string() }
}

/// `checkStaleVersion(ownVersion, env)`: `None` (never flags) when this build's version is unknown or nothing newer exists.
pub fn check(p: &Proc, own: Option<&str>) -> Option<Stale> {
    let own = own.filter(|v| semver_ok(v))?;
    let env = JevEnv::from_pairs(p.env.clone());
    let k = known_versions(&env, &p.st.home)?;
    let mut newest: Option<String> = None;
    for v in [&k.registry, &k.cache, &k.marketplace].into_iter().flatten() {
        if semver_ok(v) && newest.as_deref().is_none_or(|n| compare_versions(v, n) > 0) {
            newest = Some(v.clone());
        }
    }
    let newest = newest.filter(|n| compare_versions(own, n) < 0)?;
    let registered = k.registry.as_deref().is_some_and(|j| semver_ok(j) && compare_versions(j, &newest) >= 0);
    let script = PathBuf::from(&k.cache_root).join(&newest).join(defaults::text("wake_watch.stale_script_rel"));
    Some(Stale { script: script.is_file().then_some(script), registered, registered_version: k.registry.filter(|j| semver_ok(j)), newest })
}

/// `canHandoff(ownVersion, newestVersion, env)`: strictly newer than this build, and strictly newer than the previous handoff's
/// target (so a chain of handoffs is monotonic and bounded). Fail-closed.
pub fn can_handoff(own: &str, newest: &str, stamp: Option<&str>) -> bool {
    if !semver_ok(own) || !semver_ok(newest) || compare_versions(newest, own) <= 0 {
        return false;
    }
    match stamp.filter(|s| !s.is_empty()) {
        Some(s) => semver_ok(s) && compare_versions(newest, s) > 0,
        None => true,
    }
}

/// `formatStaleVersionLine`
pub fn stale_line(role: &str, id: &str, own: Option<&str>, newest: &str, script: &str) -> String {
    defaults::render(
        "wake_watch.line_stale",
        &[("role", &word(role)), ("id", &word(id)), ("own", &own.map_or_else(|| word(""), str::to_string)), ("newest", &newest), ("script", &script)],
    )
}

/// `formatUpdateAvailableLine`
pub fn update_line(role: &str, id: &str, own: Option<&str>, newest: &str, registered: bool) -> String {
    let key = if registered { "wake_watch.line_update_registered" } else { "wake_watch.line_update_unregistered" };
    defaults::render(key, &[("role", &word(role)), ("id", &word(id)), ("own", &own.map_or_else(|| word(""), str::to_string)), ("newest", &newest)])
}

/// `formatHandoffLine`
pub fn handoff_line(newest: &str, registered: bool, registered_version: Option<&str>) -> String {
    let base = defaults::render("wake_watch.line_handoff", &[("newest", &newest)]);
    if registered {
        return base;
    }
    let still = match registered_version.filter(|v| !v.is_empty()) {
        Some(v) => defaults::render("wake_watch.handoff_still_registers", &[("version", &v)]),
        None => defaults::text("wake_watch.handoff_not_registered").to_string(),
    };
    format!("{base}{}", defaults::render("wake_watch.handoff_cached_only", &[("still", &still)]))
}
