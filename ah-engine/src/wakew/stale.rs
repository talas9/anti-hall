//! Is a newer build of the plugin installed than the one this watcher runs? Port of `checkStaleVersion`, `canHandoff` and the
//! three line formatters (`formatStaleVersionLine`, `formatUpdateAvailableLine`, `formatHandoffLine`) of
//! `companion/lib/devswarm-wake-watch.js`. A pure read of the harness registry, the version cache and the marketplace clone.
use super::read;
use super::who::Proc;
use crate::checks::jsport::json::J;
use crate::defaults;
use crate::operator::update::{compare_versions, semver_ok};
use std::path::{Path, PathBuf};

/// A newer build.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Stale {
    /// The newest version known.
    pub newest: String,
    /// Its plugin root when the build is complete on disk (its manifest exists): the handoff target. The engine itself runs
    /// again with this root, so no interpreter is involved.
    pub root: Option<PathBuf>,
    /// The harness registry itself names it.
    pub registered: bool,
    /// The version the registry names.
    pub registered_version: Option<String>,
}

fn word(role_or_id: &str) -> String {
    if role_or_id.is_empty() { defaults::text("wake_watch.word_unknown").to_string() } else { role_or_id.to_string() }
}

/// The install the running plugin root belongs to: `<plugin>@<marketplace>` and where that marketplace's cache lives.
struct Install {
    key: String,
    /// `<plugins dir>/cache/<marketplace>/<plugin>`: the directories of this install's versions.
    cache: PathBuf,
    /// The registry's `installed_plugins.json`.
    registry: PathBuf,
    /// The marketplace's own directory, from the harness's record of it.
    marketplace: Option<PathBuf>,
}

fn t(key: &str) -> &'static str {
    defaults::text(key)
}

fn canon(p: &Path) -> PathBuf {
    std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

fn json_at(path: &Path) -> Option<J> {
    read::parse_json(&read::read_text(path)?)
}

fn string_of(v: Option<&J>) -> Option<String> {
    match v {
        Some(J::Str(s)) => Some(s.clone()),
        _ => None,
    }
}

/// Which install owns `root`, from the harness's own records (read only): the root is inside that marketplace's cache, or inside
/// the directory a registered marketplace lives in. `None` when the root belongs to no registered install.
fn owning_install(p: &Proc) -> Option<Install> {
    let owner = crate::install::owning(&p.home.to_string_lossy(), &p.root)?;
    Some(Install { key: owner.key, cache: owner.cache, registry: owner.registry, marketplace: owner.marketplace })
}

/// `enabledPlugins[key] === true` in the user's settings. An unreadable file or a missing entry is "not enabled".
fn enabled(p: &Proc, key: &str) -> bool {
    crate::install::is_enabled(json_at(&p.home.join(t("wake_watch.user_settings_rel"))).as_ref(), key)
}

/// The version the registry records for `key`.
fn registered_version(i: &Install) -> Option<String> {
    let reg = json_at(&i.registry)?;
    let plugins = reg.get(t("wake_watch.registry_plugins_field")).unwrap_or(&reg);
    let entry = match plugins.get(&i.key)? {
        J::Arr(a) => a.first()?.clone(),
        e => e.clone(),
    };
    string_of(entry.get("version")).filter(|v| semver_ok(v))
}

/// `checkStaleVersion(ownVersion, env)`: only a newer version of the SAME enabled install counts. `None` (never flags) when this
/// build's version is unknown, the running root belongs to no registered install, that install is not enabled in the user's
/// settings (or the settings cannot be read), or nothing newer exists. Another marketplace's cache is never a candidate.
pub fn check(p: &Proc, own: Option<&str>) -> Option<Stale> {
    let own = own.filter(|v| semver_ok(v))?;
    let install = owning_install(p)?;
    if !enabled(p, &install.key) {
        return None;
    }
    let registry = registered_version(&install);
    let mut cache: Option<String> = None;
    for e in std::fs::read_dir(&install.cache).ok()?.flatten() {
        let n = e.file_name().to_string_lossy().into_owned();
        if e.file_type().is_ok_and(|t| t.is_dir()) && semver_ok(&n) && cache.as_deref().is_none_or(|c| compare_versions(&n, c) > 0) {
            cache = Some(n);
        }
    }
    // The marketplace clone counts only when it is the one `update` pulls from and installs out of: a directory-source marketplace
    // (a development deploy) can carry a newer build that `/anti-hall:update` will never install, and advertising it sends the user
    // to an update that cannot deliver it.
    let updater = canon(Path::new(
        &crate::operator::update::marketplace_dir(
            p.env.get(defaults::text("env.update_marketplace_dir")).map(String::as_str).filter(|o| !o.is_empty()),
            &p.home.to_string_lossy(),
        )
        .0,
    ));
    let marketplace = install.marketplace.as_ref().filter(|m| **m == updater).and_then(|m| {
        let j = json_at(&m.join(t("wake_watch.marketplace_plugin_rel")).join(t("wake_watch.manifest_rel")))?;
        string_of(j.get("version")).filter(|v| semver_ok(v))
    });
    let mut newest: Option<String> = None;
    for v in [&registry, &cache, &marketplace].into_iter().flatten() {
        if newest.as_deref().is_none_or(|n| compare_versions(v, n) > 0) {
            newest = Some(v.clone());
        }
    }
    let newest = newest.filter(|n| compare_versions(own, n) < 0)?;
    let registered = registry.as_deref().is_some_and(|j| compare_versions(j, &newest) >= 0);
    let build = install.cache.join(&newest);
    let root = build.join(t("wake_watch.manifest_rel")).is_file().then_some(build);
    Some(Stale { root, registered, registered_version: registry, newest })
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
pub fn stale_line(role: &str, id: &str, own: Option<&str>, newest: &str, home: &std::path::Path) -> String {
    // the re-arm command is the version-independent watcher shim, not the running build's script
    let script = crate::checks::devswarm_role::text::engine_watcher(&home.to_string_lossy());
    defaults::render(
        "wake_watch.line_stale",
        &[("role", &word(role)), ("id", &word(id)), ("own", &own.map_or_else(|| word(""), str::to_string)), ("newest", &newest), ("script", &script.as_str())],
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::checks::git::util::Settings;

    fn write(p: &Path, text: &str) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }

    fn manifest(dir: &Path, version: &str) {
        write(&dir.join(t("wake_watch.manifest_rel")), &format!(r#"{{"name":"anti-hall","version":"{version}"}}"#));
    }

    /// Two marketplaces as on a development machine: `anti-hall` (the clone `update` installs from, 0.300.2) and a directory-source
    /// deploy `engine-live` (0.301.0) whose build is the one running.
    fn world(tag: &str) -> Proc {
        let home = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target").join("test-wakew").join(format!("stale-{tag}-{}", std::process::id()));
        crate::discard::harmless(std::fs::remove_dir_all(&home)); // keep: cleanup that raced; an absent dir is the goal state
        let plugins = home.join(".claude/plugins");
        let (clone, live) = (plugins.join("marketplaces/anti-hall"), home.join("live-mk"));
        manifest(&clone.join(t("wake_watch.marketplace_plugin_rel")), "0.300.2");
        manifest(&live.join(t("wake_watch.marketplace_plugin_rel")), "0.301.0");
        let running = live.join(t("wake_watch.marketplace_plugin_rel"));
        write(
            &plugins.join(t("wake_watch.known_marketplaces_file")),
            &format!(r#"{{"anti-hall":{{"installLocation":"{}"}},"engine-live":{{"installLocation":"{}"}}}}"#, clone.display(), live.display()),
        );
        write(&plugins.join(t("wake_watch.installed_file")), r#"{"version":2,"plugins":{"anti-hall@engine-live":[{"version":"0.300.1"}]}}"#);
        manifest(&plugins.join("cache/engine-live/anti-hall/0.300.1"), "0.300.1");
        write(&home.join(t("wake_watch.user_settings_rel")), r#"{"enabledPlugins":{"anti-hall@engine-live":true}}"#);
        let st = Settings { home: home.to_string_lossy().into_owned(), env: Default::default() };
        Proc { home, cwd: "/".into(), env: Default::default(), st, root: running.to_string_lossy().into_owned() }
    }

    /// downstream 2026-10-22: the watcher advertised 0.301.0 from the development deploy's marketplace while `update` installs from the
    /// `anti-hall` clone (0.300.2), so the advertised update could never be installed.
    #[test]
    fn a_directory_marketplace_the_updater_does_not_use_advertises_nothing() {
        let p = world("devdeploy");
        assert_eq!(check(&p, Some("0.300.1")), None, "0.301.0 sits only in a marketplace `update` never installs from");
    }

    #[test]
    fn the_marketplace_the_updater_installs_from_is_compared() {
        let p = world("updater");
        // the install whose marketplace IS the updater's clone: a newer clone is advertised as unregistered
        let clone = p.home.join(".claude/plugins/marketplaces/anti-hall");
        write(&p.home.join(".claude/plugins/known_marketplaces.json"), &format!(r#"{{"anti-hall":{{"installLocation":"{}"}}}}"#, clone.display()));
        write(&p.home.join(".claude/plugins/installed_plugins.json"), r#"{"version":2,"plugins":{"anti-hall@anti-hall":[{"version":"0.300.1"}]}}"#);
        write(&p.home.join(".claude/settings.json"), r#"{"enabledPlugins":{"anti-hall@anti-hall":true}}"#);
        manifest(&p.home.join(".claude/plugins/cache/anti-hall/anti-hall/0.300.1"), "0.300.1");
        let running = clone.join(t("wake_watch.marketplace_plugin_rel"));
        let p = Proc { root: running.to_string_lossy().into_owned(), ..p };
        let s = check(&p, Some("0.300.1")).expect("the clone's 0.300.2 is newer");
        assert_eq!((s.newest.as_str(), s.registered), ("0.300.2", false));
    }
}
