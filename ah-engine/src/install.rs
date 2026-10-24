//! Which registered anti-hall install is the ENABLED one (#216). `installed_plugins.json` may register several
//! `anti-hall@<marketplace>` keys at once; only the key the user's settings mark `enabledPlugins[key] === true` is the install
//! the harness runs. Every reader of the registry asks here instead of pinning one key. Port of `hooks/lib/enabled-install.js`.
//! Pure over parsed JSON: the callers read the files.
use crate::checks::jsport::json::J;
use crate::defaults;

/// `enabledPlugins[key] === true` in the parsed user settings. A missing file or entry is "not enabled".
pub fn is_enabled(settings: Option<&J>, key: &str) -> bool {
    matches!(settings.and_then(|s| s.get(defaults::text("wake_watch.enabled_plugins_field"))).and_then(|e| e.get(key)), Some(J::Bool(true)))
}

/// The registered `anti-hall@*` keys the settings mark enabled, in registry order; when none is, just the fallback key.
/// The flag says which: `true` = the enabled install, `false` = the fallback.
pub fn select_keys(plugins: &J, settings: Option<&J>) -> (Vec<String>, bool) {
    let prefix = defaults::text("wake_watch.install_key_prefix");
    let J::Obj(entries) = plugins else { return (vec![defaults::text("wake_watch.install_fallback_key").to_string()], false) };
    let keys: Vec<String> = entries.iter().map(|(k, _)| k).filter(|k| k.starts_with(prefix) && is_enabled(settings, k)).cloned().collect();
    if keys.is_empty() { (vec![defaults::text("wake_watch.install_fallback_key").to_string()], false) } else { (keys, true) }
}

/// The registered install containing the running plugin, independent of other enabled installs.
#[derive(Clone, Debug)]
pub struct Owner {
    /// Harness plugin key, including its marketplace.
    pub key: String,
    /// Version directories belonging to this marketplace and plugin.
    pub cache: std::path::PathBuf,
    /// Harness registry containing this install.
    pub registry: std::path::PathBuf,
    /// Registered marketplace source location, when available.
    pub marketplace: Option<std::path::PathBuf>,
}

/// Resolve the install containing `root` from the harness cache layout or registered marketplace locations.
pub fn owning(home: &str, root: &str) -> Option<Owner> {
    use std::path::{Path, PathBuf};
    let canon = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let read = |p: &Path| crate::checks::jsport::json::parse(&std::fs::read_to_string(p).ok()?, defaults::num("update.json_max_depth") as usize).ok();
    if home.is_empty() || root.is_empty() { return None; }
    let root = canon(Path::new(root));
    let plugins = Path::new(home).join(defaults::text("wake_watch.plugins_rel"));
    let cache = canon(&plugins.join(defaults::text("wake_watch.cache_dir")));
    let manifest = read(&root.join(defaults::text("wake_watch.manifest_rel")))?;
    let name = match manifest.get(defaults::text("wake_watch.manifest_name_field"))? { J::Str(s) => s.as_str(), _ => return None };
    let known = read(&plugins.join(defaults::text("wake_watch.known_marketplaces_file")));
    let location = |key: &str| -> Option<PathBuf> {
        let J::Str(loc) = known.as_ref()?.get(key)?.get(defaults::text("wake_watch.install_location_field"))? else { return None };
        Some(canon(Path::new(loc)))
    };
    let market = if let Ok(rel) = root.strip_prefix(&cache) {
        rel.components().next()?.as_os_str().to_string_lossy().into_owned()
    } else {
        let J::Obj(entries) = known.as_ref()? else { return None };
        entries.iter().filter_map(|(k, _)| location(k).filter(|p| root.starts_with(p)).map(|p| (k, p)))
            .max_by_key(|(_, p)| p.components().count()).map(|(k, _)| k.clone())?
    };
    Some(Owner { key: format!("{name}{}{market}", defaults::text("wake_watch.key_sep")), cache: cache.join(&market).join(name),
        registry: plugins.join(defaults::text("wake_watch.installed_file")), marketplace: location(&market) })
}

/// Request root, otherwise the plugin supplying this engine's defaults (shared by Claude and Codex).
pub fn running_root(env: &std::collections::HashMap<String, String>) -> String {
    env.get(defaults::env_name("plugin_root")).filter(|r| !r.is_empty()).cloned()
        .or_else(|| defaults::root().map(|p| p.to_string_lossy().into_owned())).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::checks::jsport::json;

    fn j(s: &str) -> J {
        json::parse(s, 32).unwrap()
    }

    #[test]
    fn the_enabled_install_wins_and_the_pin_is_only_the_fallback() {
        let reg = j(r#"{"anti-hall@anti-hall":[{}],"anti-hall@anti-hall-engine-live":[{}],"other@x":[{}]}"#);
        let on = j(r#"{"enabledPlugins":{"anti-hall@anti-hall":false,"anti-hall@anti-hall-engine-live":true,"other@x":true}}"#);
        assert_eq!(select_keys(&reg, Some(&on)), (vec!["anti-hall@anti-hall-engine-live".to_string()], true));
        let none = j(r#"{"enabledPlugins":{"other@x":true}}"#);
        assert_eq!(select_keys(&reg, Some(&none)), (vec!["anti-hall@anti-hall".to_string()], false));
        assert_eq!(select_keys(&reg, None), (vec!["anti-hall@anti-hall".to_string()], false));
    }
}
