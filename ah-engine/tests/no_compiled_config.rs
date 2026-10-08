//! D17 (amended): NO setting, tunable, table, message text, dispatch row or rule is compiled into the binary.
//!
//! Everything is read at run time from the plugin's `engine/` files. This test takes the text of the shipped defaults (every
//! `doc` and every string value long enough to be a sentinel, from every file the index names) and of `rules.json`, and fails
//! if any of it can be found in the built binary. It also fails if the source embeds a defaults or rules file.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests
use std::path::{Path, PathBuf};

const BIN: &str = env!("CARGO_BIN_EXE_ah-engine");

fn engine_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall/engine")
}

fn toml_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let mut items: Vec<PathBuf> = std::fs::read_dir(dir).unwrap().flatten().map(|e| e.path()).collect();
    items.sort();
    for p in items {
        if p.is_dir() {
            toml_files(&p, out);
        } else if p.extension().is_some_and(|x| x == "toml") {
            out.push(p);
        }
    }
}

fn strings(v: &toml::Value, out: &mut Vec<String>) {
    match v {
        toml::Value::String(s) => out.push(s.clone()),
        toml::Value::Array(a) => a.iter().for_each(|x| strings(x, out)),
        toml::Value::Table(t) => t.values().for_each(|x| strings(x, out)),
        _ => {}
    }
}

fn contains(hay: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty() && hay.windows(needle.len()).any(|w| w == needle)
}

#[test]
fn no_defaults_text_is_embedded_in_the_binary() {
    let bin = std::fs::read(BIN).unwrap();
    let mut files = Vec::new();
    toml_files(&engine_dir().join("defaults"), &mut files);
    assert!(files.len() >= 28, "the shipped defaults were not found: {}", files.len());
    let (mut checked, mut leaked) = (0usize, Vec::new());
    for f in &files {
        let table: toml::Table = std::fs::read_to_string(f).unwrap().parse().unwrap();
        let mut texts = Vec::new();
        strings(&toml::Value::Table(table), &mut texts);
        for t in texts {
            // a sentinel is a long run of text (a doc, a message, a pattern); short tokens are legitimately also in code
            if t.chars().count() < 32 || !t.contains(' ') && t.chars().count() < 48 {
                continue;
            }
            checked += 1;
            // the whole text: a shared prefix (the host's JSON envelope, a protocol keyword) is syntax, a whole message is not
            if contains(&bin, t.as_bytes()) {
                leaked.push(format!("{}: {:?}", f.file_name().unwrap().to_string_lossy(), t.chars().take(60).collect::<String>()));
            }
        }
    }
    assert!(checked > 500, "the scan is vacuous: only {checked} sentinels");
    assert!(leaked.is_empty(), "{} shipped strings are compiled into the binary (read them from the plugin files):\n{}", leaked.len(), leaked.join("\n"));
}

#[test]
fn no_rule_text_is_embedded_in_the_binary() {
    let bin = std::fs::read(BIN).unwrap();
    let rules: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(engine_dir().join("rules.json")).unwrap()).unwrap();
    let mut checked = 0;
    for r in rules["rules"].as_array().unwrap() {
        for k in ["pattern", "message"] {
            if let Some(t) = r[k].as_str().filter(|t| t.chars().count() >= 24) {
                checked += 1;
                let head: String = t.chars().take(24).collect();
                assert!(!contains(&bin, head.as_bytes()), "rule {k} {head:?} is compiled into the binary");
            }
        }
    }
    assert!(checked >= 4, "the scan is vacuous: {checked}");
}

#[test]
fn the_source_embeds_no_defaults_or_rules_file() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut stack = vec![src];
    while let Some(d) = stack.pop() {
        for e in std::fs::read_dir(d).unwrap().flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else if p.extension().is_some_and(|x| x == "rs") {
                let text = std::fs::read_to_string(&p).unwrap();
                let text = text.split("#[cfg(test)]\nmod tests {").next().unwrap_or("");
                for (i, l) in text.lines().enumerate() {
                    let embeds = l.contains("include_str!") || l.contains("include_bytes!") || (l.contains("include!(") && !l.contains("required_keys.rs"));
                    assert!(!embeds, "{}:{}: embeds a file into the binary: {}", p.display(), i + 1, l.trim());
                }
            }
        }
    }
}
