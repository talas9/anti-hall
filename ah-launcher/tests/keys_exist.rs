//! Prevention: every settings key the maintenance verbs (`integrity`, `install`, `update`) read exists in the shipped defaults, so a
//! typo in the source (or a key deleted from the TOML) fails here and not in a user's session as a silent no-op. The reverse
//! direction (a shipped key nobody reads) is covered for the engine by `defaults_keys.rs` and for the launcher by `no_hardcoded.rs`.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

fn shipped() -> BTreeSet<String> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall/engine/defaults");
    let mut keys = BTreeSet::new();
    for f in ["engine.toml", "messages.toml", "dispatch.toml", "doctor.toml"] {
        let doc: toml::Table = fs::read_to_string(dir.join(f)).unwrap().parse().unwrap();
        fn walk(prefix: &str, t: &toml::Table, out: &mut BTreeSet<String>) {
            for (k, v) in t {
                let name = if prefix.is_empty() { k.clone() } else { format!("{prefix}.{k}") };
                if let Some(sub) = v.as_table() {
                    if sub.contains_key("value") {
                        out.insert(name.clone());
                    }
                    walk(&name, sub, out);
                }
            }
        }
        walk("", &doc, &mut keys);
    }
    keys
}

/// The keys one source file names: full literals (`"updater.repo"`) and the short helper forms (`t("repo")`, `n("..")`, `l("..")`)
/// that read `<section>.<name>`.
fn referenced(src: &str, section: &str) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    let body = src.split("#[cfg(test)]").next().unwrap();
    let bytes = body.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'"' {
            let start = i + 1;
            let mut j = start;
            while j < bytes.len() && bytes[j] != b'"' {
                if bytes[j] == b'\\' {
                    j += 1;
                }
                j += 1;
            }
            let lit = &body[start..j.min(body.len())];
            let prefixes = ["updater.", "install.", "rollback.", "msg.updater_", "msg.install_", "msg.launcher_update", "msg.launcher_integrity", "doctor_l.", "doctor_msg.", "hooks_form."];
            if !lit.contains(char::is_whitespace) && !lit.contains('{') && prefixes.iter().any(|p| lit.starts_with(p)) && lit.chars().all(|c| c.is_ascii_lowercase() || c == '.' || c == '_' || c.is_ascii_digit()) {
                out.insert(lit.to_string());
            }
            // the short helper forms: t("name") / n("name") / l("name") directly before this literal
            let before = &body[..start - 1];
            if (before.ends_with("t(") || before.ends_with("n(") || before.ends_with("l(")) && lit.chars().all(|c| c.is_ascii_lowercase() || c == '_') {
                let prev = before.trim_end_matches(['t', 'n', 'l', '(']);
                if prev.ends_with(|c: char| !c.is_alphanumeric() && c != '_') || prev.is_empty() {
                    out.insert(format!("{section}.{lit}"));
                }
            }
            i = j + 1;
        } else {
            i += 1;
        }
    }
    out
}

#[test]
fn every_key_the_maintenance_verbs_read_is_shipped() {
    let have = shipped();
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    for (file, section) in [("update.rs", "updater"), ("install.rs", "install"), ("integrity.rs", "rollback"), ("doctor.rs", "doctor_l")] {
        let text = fs::read_to_string(src.join(file)).unwrap();
        let want = referenced(&text, section);
        assert!(want.len() >= 8, "{file}: the scan found only {} keys (the scan is broken)", want.len());
        let missing: Vec<&String> = want.iter().filter(|k| !have.contains(*k)).collect();
        assert!(missing.is_empty(), "{file} reads keys the shipped defaults lack: {missing:?}");
    }
}
