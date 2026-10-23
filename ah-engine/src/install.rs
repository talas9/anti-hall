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
