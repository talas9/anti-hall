//! Resolving a vendor's API key, and keeping it from going anywhere else.
//!
//! Mirrors `hooks/lib/credentials.js` `resolveKey` (the `jev` kind). The rules, in order, for one vendor:
//!
//! 1. that vendor's own plugin option (`CLAUDE_PLUGIN_OPTION_JEV_<VENDOR>_API_KEY`);
//! 2. the vendor-less legacy option, but only when it is bound to this vendor (`jev.genericKeyVendor`, a home-only
//!    setting), because it carries no vendor name and so must not follow a transport flip to another vendor;
//! 3. only with the home-only opt-in `jev.allowLegacyKeyRead`: the vendor's legacy environment variable, then a key
//!    file.
//!
//! A key is read for exactly the vendor it was entered for. It is a [`Key`], whose `Debug` output is redacted and
//! which has no `Display`, so it cannot reach a log or an error message by accident.
use super::settings::{JevSettings, Vendor};
use crate::defaults;
use std::fmt;
use std::path::{Path, PathBuf};

/// An API key. Redacted in `Debug`, no `Display`; read it only with [`Key::expose`], at the one place it is sent.
#[derive(Clone, PartialEq, Eq)]
pub struct Key(String);

impl Key {
    /// The key text, for the Authorization header and nothing else.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Key {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Key(<redacted>)")
    }
}

/// Where a key came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeySource {
    /// A plugin option.
    PluginOption,
    /// A legacy environment variable (opt-in).
    LegacyEnv,
    /// A legacy key file (opt-in).
    LegacyFile,
}

/// The result of a key lookup. Never carries key material except in `key`.
#[derive(Debug, Default)]
pub struct KeyLookup {
    /// The key, when one resolved.
    pub key: Option<Key>,
    /// Where it came from.
    pub source: Option<KeySource>,
    /// Why a present key file was refused (a message, never file content).
    pub rejected: Option<String>,
    /// Why a present vendor-less key was not used (a message, never key material).
    pub diagnostic: Option<String>,
}

/// The default key file of a vendor under `home`.
pub fn default_key_file(vendor: Vendor, home: &Path) -> PathBuf {
    let rel = match vendor {
        Vendor::Vercel => defaults::text("jev.key_file_vercel"),
        Vendor::Typesafe => defaults::text("jev.key_file_typesafe"),
    };
    home.join(rel)
}

/// The vendor's own plugin-option variable.
fn own_option_var(vendor: Vendor) -> &'static str {
    match vendor {
        Vendor::Vercel => defaults::text("env.jev_key_vercel"),
        Vendor::Typesafe => defaults::text("env.jev_key_typesafe"),
    }
}

/// The vendor's legacy key variable.
fn legacy_var(vendor: Vendor) -> &'static str {
    match vendor {
        Vendor::Vercel => defaults::text("env.jev_legacy_key_vercel"),
        Vendor::Typesafe => defaults::text("env.jev_legacy_key_typesafe"),
    }
}

/// Resolve the key for `vendor` (Node: `resolveCredential`). Never logs or returns key material outside `key`.
pub fn resolve_key(settings: &JevSettings, vendor: Vendor) -> KeyLookup {
    let env = settings.env();
    let mut out = KeyLookup::default();
    if let Some(own) = env.get_nonempty(own_option_var(vendor)) {
        out.key = Some(Key(own));
        out.source = Some(KeySource::PluginOption);
        return out;
    }
    if let Some(generic) = env.get_nonempty(defaults::text("env.jev_key_generic")) {
        let bound = settings.generic_key_vendor;
        if bound == vendor {
            out.key = Some(Key(generic));
            out.source = Some(KeySource::PluginOption);
            return out;
        }
        let option = format!("jev_{}_api_key", vendor.as_str());
        out.diagnostic = Some(defaults::render("msg.jev_generic_key_bound", &[("bound", &bound.as_str()), ("option", &option), ("vendor", &vendor.as_str())]));
    }
    if !settings.allow_legacy_key_read {
        return out;
    }
    if let Some(v) = env.get_nonempty(legacy_var(vendor)) {
        out.key = Some(Key(v));
        out.source = Some(KeySource::LegacyEnv);
        return out;
    }
    // The configured key file is as ambiguous as the generic option, so it applies only to the vendor that option is
    // bound to; every other vendor reads its own default file.
    let file = match &settings.key_file {
        Some(f) if settings.generic_key_vendor == vendor => f.clone(),
        _ => default_key_file(vendor, settings.home()),
    };
    match read_key_file(&file, settings.home()) {
        Ok(Some(k)) => {
            out.key = Some(Key(k));
            out.source = Some(KeySource::LegacyFile);
        }
        Ok(None) => {}
        Err(why) => out.rejected = Some(why),
    }
    out
}

/// True when `real` is strictly inside `dir`.
fn inside(real: &Path, dir: &Path) -> bool {
    real.strip_prefix(dir).is_ok_and(|rel| !rel.as_os_str().is_empty())
}

/// Read a key file under the rules of Node's `readKeyFile`: the real path (symlinks resolved) must lie inside one of
/// the allowed directories under `home`, be a regular file no larger than the limit, and hold one line without
/// whitespace. `Ok(None)` is a plain "no key" (a missing or empty file); `Err` is a refusal, as a message without
/// file content.
pub fn read_key_file(path: &Path, home: &Path) -> Result<Option<String>, String> {
    let Ok(real) = std::fs::canonicalize(path) else { return Ok(None) };
    let roots: Vec<PathBuf> =
        defaults::list("jev.key_file_roots").iter().map(|d| std::fs::canonicalize(home.join(d)).unwrap_or_else(|_| home.join(d))).collect();
    if !roots.iter().any(|r| inside(&real, r)) {
        return Err(defaults::text("msg.jev_key_outside_roots").to_string());
    }
    let meta = std::fs::symlink_metadata(&real).map_err(|_| defaults::text("msg.jev_key_unreadable").to_string())?;
    if !meta.is_file() {
        return Err(defaults::text("msg.jev_key_not_file").to_string());
    }
    let max = defaults::num("jev.key_file_max_bytes");
    if meta.len() > max {
        return Err(defaults::render("msg.jev_key_too_large", &[("max", &max)]));
    }
    let text = std::fs::read_to_string(&real).map_err(|_| defaults::text("msg.jev_key_unreadable").to_string())?;
    let content = super::js_trim(&text);
    if content.is_empty() {
        return Ok(None);
    }
    if content.chars().any(super::is_js_whitespace) {
        return Err(defaults::text("msg.jev_key_multiline").to_string());
    }
    Ok(Some(content.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jev::settings::{Env, Sources};
    use serde_json::json;

    fn settings(env: &[(&str, &str)], jev: serde_json::Value, home: &Path) -> JevSettings {
        JevSettings::resolve(home, Sources { env: Env::from_pairs(env.iter().copied()), settings: json!({"jev": jev}), legacy: json!({}) })
    }

    fn home() -> PathBuf {
        let d = std::env::temp_dir().join(format!("ah-jev-cred-{}-{:?}", std::process::id(), std::thread::current().id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join(".config/vercel")).unwrap();
        std::fs::create_dir_all(d.join(".config/typesafe")).unwrap();
        d
    }

    #[test]
    fn a_key_is_redacted_in_debug_output() {
        let k = Key("super-secret".into());
        assert!(!format!("{k:?}").contains("super-secret"));
        assert_eq!(k.expose(), "super-secret");
    }

    #[test]
    fn each_vendors_option_is_used_only_for_that_vendor() {
        let h = Path::new("/nowhere");
        let s = settings(&[("CLAUDE_PLUGIN_OPTION_JEV_TYPESAFE_API_KEY", " ts-key ")], json!({}), h);
        assert_eq!(resolve_key(&s, Vendor::Typesafe).key.unwrap().expose(), "ts-key");
        assert!(resolve_key(&s, Vendor::Vercel).key.is_none());
    }

    #[test]
    fn the_generic_option_goes_only_to_the_vendor_it_is_bound_to() {
        let h = Path::new("/nowhere");
        let s = settings(&[("CLAUDE_PLUGIN_OPTION_JEV_API_KEY", "g")], json!({}), h);
        assert_eq!(resolve_key(&s, Vendor::Vercel).key.unwrap().expose(), "g", "bound to vercel by default");
        let other = resolve_key(&s, Vendor::Typesafe);
        assert!(other.key.is_none());
        assert!(other.diagnostic.unwrap().contains("bound to vercel"));
        let t = settings(&[("CLAUDE_PLUGIN_OPTION_JEV_API_KEY", "g")], json!({"genericKeyVendor": "typesafe"}), h);
        assert!(resolve_key(&t, Vendor::Vercel).key.is_none());
        assert!(resolve_key(&t, Vendor::Typesafe).key.is_some());
    }

    #[test]
    fn legacy_sources_need_the_home_only_opt_in() {
        let h = home();
        std::fs::write(h.join(".config/vercel/ai-gateway-key"), "file-key\n").unwrap();
        let off = settings(&[("AI_GATEWAY_API_KEY", "env-key")], json!({}), &h);
        assert!(resolve_key(&off, Vendor::Vercel).key.is_none());
        let on = settings(&[("AI_GATEWAY_API_KEY", "env-key")], json!({"allowLegacyKeyRead": true}), &h);
        let r = resolve_key(&on, Vendor::Vercel);
        assert_eq!((r.key.unwrap().expose(), r.source), ("env-key", Some(KeySource::LegacyEnv)));
        let file = settings(&[], json!({"allowLegacyKeyRead": true}), &h);
        assert_eq!(resolve_key(&file, Vendor::Vercel).key.unwrap().expose(), "file-key");
        assert!(resolve_key(&file, Vendor::Typesafe).key.is_none(), "another vendor reads its own file, which is absent");
    }

    #[test]
    fn a_key_file_must_be_a_small_single_line_regular_file_inside_the_allowed_directories() {
        let h = home();
        let f = h.join(".config/vercel/ai-gateway-key");
        std::fs::write(&f, "two words").unwrap();
        assert!(read_key_file(&f, &h).unwrap_err().contains("single line"));
        std::fs::write(&f, "x".repeat(5000)).unwrap();
        assert!(read_key_file(&f, &h).unwrap_err().contains("larger than 4096"));
        std::fs::write(&f, "  \n").unwrap();
        assert_eq!(read_key_file(&f, &h), Ok(None));
        let outside = std::env::temp_dir().join(format!("ah-jev-outside-{}", std::process::id()));
        std::fs::write(&outside, "k").unwrap();
        assert!(read_key_file(&outside, &h).unwrap_err().contains("outside"));
        let link = h.join(".config/vercel/link");
        let _ = std::os::unix::fs::symlink(&outside, &link);
        assert!(read_key_file(&link, &h).unwrap_err().contains("outside"), "a symlink out of the allowed directories is refused");
        assert_eq!(read_key_file(&h.join(".config/vercel/missing"), &h), Ok(None));
        let _ = std::fs::remove_file(&outside);
    }
}
