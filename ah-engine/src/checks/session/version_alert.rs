//! The harness registry's version of the plugin, read the way the update skill reads it. The `version-alert` check that used
//! it is a plugin script now (`engine/logic/version-alert.js`); the stop-time stale-binary gate of the silent-agent nudge still
//! compares against this version, so the reader stays until that check moves.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an unreadable optional file is the same as an absent one (fail-open, as Node's try/catch)
// - an absent field is the empty value
// A failure that must be seen goes through `crate::discard` instead.

use super::jval::{J, Parsed, parse};
use super::{join, read_text};
use crate::checks::guardkit::paths::{is_absolute, resolve_abs};
use crate::checks::guardkit::text::js_trim;
use crate::defaults;
use crate::reqenv::RequestEnv;

/// `isSemver(v)` of `update.js`: `N.N.N` with an optional `-` or `+` suffix, after trimming and dropping one `v`.
pub(crate) fn is_semver(v: &str) -> bool {
    let t = js_trim(v);
    let t = t.strip_prefix(['v', 'V']).unwrap_or(t);
    let (core, suffix) = match t.find(['-', '+']) {
        Some(i) => (&t[..i], Some(&t[i + 1..])),
        None => (t, None),
    };
    let nums: Vec<&str> = core.split('.').collect();
    nums.len() == 3
        && nums.iter().all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
        && suffix.is_none_or(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-'))
}

/// `versionFromInstalledJson` of `update.js` over a parsed registry; `None` when no valid version is found.
fn version_from_registry(data: &J) -> Option<String> {
    if !matches!(data, J::Obj(_) | J::Arr(_)) {
        return None;
    }
    let reg = match data.get("plugins") {
        Some(p @ (J::Obj(_) | J::Arr(_))) => p,
        _ => data,
    };
    match reg.get(defaults::text("session.registry_key"))? {
        J::Arr(entries) => {
            let valid: Vec<&J> = entries.iter().filter(|e| matches!(e, J::Obj(_)) && e.get("version").and_then(J::as_str).is_some_and(is_semver)).collect();
            let scope = |s: &str| valid.iter().find(|e| e.get("scope").and_then(J::as_str) == Some(s)).copied();
            let pick = scope("user").or_else(|| scope("project")).or_else(|| valid.first().copied())?;
            pick.get("version").and_then(J::as_str).map(str::to_string)
        }
        J::Str(s) => is_semver(s).then(|| s.clone()),
        e @ J::Obj(_) => e.get("version").and_then(J::as_str).filter(|v| is_semver(v)).map(str::to_string),
        _ => None,
    }
}

/// The version the host's plugin registry (`installed_plugins.json`) names, found the way `update.js` finds it.
/// `Err(())` when the registry text may parse differently here and in JavaScript.
pub(crate) fn harness_version(env: &RequestEnv, home: &str) -> Result<Option<String>, ()> {
    let mut marketplace = join(home, defaults::text("session.marketplace_dir"));
    if let Some(o) = env.get(defaults::text("session.marketplace_env")).filter(|o| !o.is_empty())
        && is_absolute(o)
        && std::fs::metadata(o).is_ok_and(|m| m.is_dir())
    {
        marketplace = o.to_string();
    }
    let plugins_root = resolve_abs(&format!("{marketplace}/../.."));
    let file = join(&plugins_root, defaults::text("session.registry_file"));
    let Ok(meta) = std::fs::metadata(&file) else { return Ok(None) };
    if meta.len() > defaults::num("session.registry_max_bytes") {
        return Ok(None);
    }
    let Some(text) = read_text(&file) else { return Ok(None) };
    match parse(&text) {
        Parsed::Ok(v) => Ok(version_from_registry(&v)),
        Parsed::Bad => Ok(None),
        Parsed::Unsure => Err(()),
    }
}
