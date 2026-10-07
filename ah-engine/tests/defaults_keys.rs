//! Every key the source reads from the shipped defaults exists, and every shipped setting is read by the source
//! (D17). Together with `no_hardcoded_tunables` this keeps code and `defaults/*.toml` in lock step: a typo cannot
//! panic in production, and a setting nobody reads cannot linger and mislead.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for e in fs::read_dir(dir).unwrap().flatten() {
        let p = e.path();
        if p.is_dir() {
            rust_files(&p, out);
        } else if p.extension().is_some_and(|x| x == "rs") {
            out.push(p);
        }
    }
}

/// Quoted string literals that directly follow one of `callers` (`defaults::num("a.b")`, `note("x")`, ...).
fn keys_after(text: &str, callers: &[&str]) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for c in callers {
        let mut rest = text;
        let mut base = 0;
        while let Some(p) = rest.find(&format!("{c}(\"")) {
            let at = base + p;
            // a bare call, not a method (`.text("x")`) or a longer name (`fn_text("x")`)
            let prev = text[..at].chars().last();
            let after = &rest[p + c.len() + 2..];
            if !prev.is_some_and(|ch| ch == '.' || ch == ':' || ch.is_alphanumeric() || ch == '_')
                && let Some(end) = after.find('"')
            {
                out.insert(after[..end].to_string());
            }
            base += p + c.len() + 2;
            rest = &rest[p + c.len() + 2..];
        }
    }
    out
}

#[test]
fn every_key_the_source_reads_is_shipped_and_every_shipped_key_is_read() {
    let mut files = Vec::new();
    rust_files(&Path::new(env!("CARGO_MANIFEST_DIR")).join("src"), &mut files);
    let shipped: BTreeSet<String> = ah_engine::defaults::all().iter().map(|e| e.key.to_string()).collect();
    let mut used: BTreeSet<String> = BTreeSet::new();
    let dotted = [
        "defaults::num",
        "defaults::millis",
        "defaults::secs",
        "defaults::text",
        "defaults::list",
        "defaults::words",
        "defaults::render",
        "defaults::raw",
        "defaults::env_of",
    ];
    let git_short = ["note", "plain", "block", "argv_template", "words", "strings", "text", "num", "switch"];
    for f in &files {
        let text = fs::read_to_string(f).unwrap();
        // tests may reference keys on purpose, including in negative tests
        let text = text.split("#[cfg(test)]\nmod tests {").next().unwrap_or("").to_string();
        used.extend(keys_after(&text, &dotted));
        if f.to_string_lossy().contains("checks/git") {
            used.extend(keys_after(&text, &git_short).into_iter().map(|k| format!("git.{k}")));
        }
        // keys built from a prefix: files.<key>, env.<name>, store.<name>
        for (prefix, callers) in [("files.", vec!["state_file", "halted", "halt", "read_json"]), ("env.", vec!["env_var", "env_name"]), ("store.", vec!["cap"])]
        {
            used.extend(keys_after(&text, &callers).into_iter().map(|k| format!("{prefix}{k}")));
        }
    }
    let missing: Vec<&String> = used.iter().filter(|k| k.contains('.') && !shipped.contains(*k)).collect();
    assert!(missing.is_empty(), "keys read by the source but not shipped: {missing:?}");
    // A shipped key counts as read when its full name appears as a string literal in the source, or, for sections whose
    // keys are read through a prefixing helper (`git.*`, `env.*`, `files.*`, `store.*`), when its short name does.
    let mut literals: BTreeSet<String> = BTreeSet::new();
    // identifier-like literals only: a key or a short name, which is all this check needs
    let re = regex::Regex::new(r#""([a-z][a-z0-9_.]*)""#).unwrap();
    for f in &files {
        let text = fs::read_to_string(f).unwrap();
        let text = text.split("#[cfg(test)]\nmod tests {").next().unwrap_or("").to_string();
        literals.extend(re.captures_iter(&text).map(|c| c[1].to_string()));
    }
    // a scheduled job names the setting that holds its interval (`every_key`); the scheduler reads it through that name
    for e in ah_engine::defaults::all().iter().filter(|e| e.key.starts_with("job.")) {
        if let Some(k) = e.value.get("every_key").and_then(ah_engine::defaults::V::as_str) {
            assert!(shipped.contains(k), "{} names every_key {k}, which is not shipped", e.key);
            literals.insert(k.to_string());
        }
    }
    let indirect = |k: &str| {
        k.starts_with("cmd.") // handlers are checked against the registry by cli::tests; planned commands have no handler
            || k.starts_with("protocol.") // documents the wire format; the request words are parsed in daemon.rs
            || k.starts_with("job.") // scheduled jobs are read by prefix in schedule.rs
            || k.starts_with("msg.hint_") // named by the health.error_codes table, not by source
            || k.starts_with("git.msg_") // block messages are rendered by block(name); the name is a literal there
            || k.starts_with("dispatch.hooks_") // the dispatch table, read by host and event (dispatch::table::key)
    };
    let read = |k: &String| {
        let (section, name) = k.split_once('.').unwrap_or(("", k));
        literals.contains(k) || (["git", "env", "files", "store", "metric", "impact", "cmd"].contains(&section) && literals.contains(name))
    };
    let unread: Vec<&String> = shipped.iter().filter(|k| !read(k) && !indirect(k)).collect();
    assert!(unread.is_empty(), "shipped settings nothing reads (delete them or use them): {unread:?}");
}

#[test]
fn every_metric_and_impact_kind_the_source_records_is_registered() {
    let mut files = Vec::new();
    rust_files(&Path::new(env!("CARGO_MANIFEST_DIR")).join("src"), &mut files);
    let metric_calls = regex::Regex::new(r#"\b(?:inc|add|observe|set)\("([a-z_]+)""#).unwrap();
    let impact_calls = regex::Regex::new(r#"\.impact\("([a-z_]+)""#).unwrap();
    for f in &files {
        let text = fs::read_to_string(f).unwrap();
        let text = text.split("#[cfg(test)]\nmod tests {").next().unwrap_or("").to_string();
        for c in metric_calls.captures_iter(&text) {
            // `set("...")` is also used by unrelated code; only names that look like metrics matter
            let name = &c[1];
            if ah_engine::defaults::has(&format!("metric.{name}")) || !text.contains(&format!("(\"{name}\", &[")) && !text.contains(&format!("inc(\"{name}\""))
            {
                continue;
            }
            panic!("{}: metric {name:?} is recorded but not registered in defaults/telemetry.toml", f.display());
        }
        for c in impact_calls.captures_iter(&text) {
            assert!(ah_engine::impact::is_kind(&c[1]), "{}: impact kind {:?} is recorded but not registered", f.display(), &c[1]);
        }
    }
}
