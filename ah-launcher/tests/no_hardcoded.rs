//! Owner rule: no hardcoding. The launcher is the bootloader of every hook call, so it is held to the engine's own rule
//! (`ah-engine/tests/it/no_hardcoded_tunables.rs`): no timeout, limit, name, text or table compiled into its source. They live in
//! the plugin's `engine/defaults/*.toml`, read at start. The ONE justified constant set is `src/builtin.rs`, the built-in copy
//! used when those files are missing or invalid; a second test keeps that copy equal to the shipped files.
//!
//! The scan (same shapes as the engine's checks 1-9, simplified to need no regex crate; comments and `#[cfg(test)]` tails ignored):
//! timeout literals, environment-variable names, const/static literals, message-like strings, short messages, bounds written
//! as numbers, file names, string tables.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::fs;
use std::path::{Path, PathBuf};

#[path = "../src/builtin.rs"]
#[allow(dead_code)]
mod builtin;

/// (file suffix, substring of the offending line, reason it is structural).
const ALLOW: &[(&str, &str, &str)] = &[
    (
        "src/builtin.rs",
        "",
        "the one justified constant set: the built-in copy of the shipped defaults, used when the plugin's TOML is missing or invalid; kept equal to the shipped files by builtin_equals_shipped_defaults",
    ),
    (
        "src/compat.rs",
        "pub const ENGINE_MIN",
        "the lowest engine version this launcher works with: a protocol/format compatibility constant of the build, not a tunable",
    ),
    (
        "src/main.rs",
        "static ALLOC",
        "the global allocator item: a language construct, not a value",
    ),
    (
        "src/limits.rs",
        "const NCTR",
        "the length of the counter table: the number of variants of the Ctr enum",
    ),
    (
        "src/limits.rs",
        "const ALL",
        "the list of the counter enum's variants: the enum's own table",
    ),
    (
        "src/proc.rs",
        "const DONE",
        "the one byte the launcher sends its watcher when the child is finished: an internal protocol byte between two halves of the launcher",
    ),
    (
        "src/proc.rs",
        "1u64 << n.min(20)",
        "the doubling law of capped exponential backoff; the shift is bounded only to keep the arithmetic finite, the base and cap are settings",
    ),
    (
        "src/proc.rs",
        "jitter_pct.min(100)",
        "a percentage cannot exceed 100: the definition of percent, not a tunable",
    ),
    (
        "src/proc.rs",
        "<< 20) | 1",
        "mixing the process id into the jitter seed: a fixed algorithm step, not a tunable",
    ),
    (
        "src/blog.rs",
        "old.push(\".1\")",
        "the suffix of the one rotated log file: the log keeps exactly one previous file",
    ),
    (
        "src/nodeback.rs",
        "std::env::var_os(\"PATH\")",
        "PATH is the operating system's own search-path variable, not an anti-hall setting",
    ),
    (
        "src/nodeback.rs",
        "const HSO",
        "a field name of the host's hook JSON answer (hookSpecificOutput): the host's protocol, not a tunable; the engine's combiner names the same field",
    ),
    (
        "src/nodeback.rs",
        "const CTX",
        "a field name of the host's hook JSON answer (additionalContext): the host's protocol, not a tunable",
    ),
    (
        "src/nodeback.rs",
        "const MSG",
        "a field name of the host's hook JSON answer (systemMessage): the host's protocol, not a tunable",
    ),
    (
        "src/nodeback.rs",
        "const EVENT_NAME",
        "a field name of the host's hook JSON answer (hookEventName): the host's protocol, not a tunable",
    ),
    (
        "src/nodeback.rs",
        "old.push(\".1\")",
        "the suffix of the one rotated ledger file: the ledger keeps exactly one previous generation, as the engine's ledger does",
    ),
    (
        "src/launcher.rs",
        "event={}",
        "key=value diagnostic and log records for developers and the integrity tooling, not messages shown to a user or an agent",
    ),
    (
        "src/doctor.rs",
        "hex.len() <",
        "byte offsets in the executable file formats (ELF e_machine, Mach-O cputype, the fat architecture table): the formats' own layout, not tunables",
    ),
    (
        "src/install.rs",
        "std::env::var_os(\"PATH\")",
        "PATH is the operating system's own search-path variable, not an anti-hall setting",
    ),
    (
        "src/launcher.rs",
        "std::env::var_os(\"PATH\")",
        "PATH is the operating system's own search-path variable, not an anti-hall setting",
    ),
];

const SKIP: &[&str] = &["tests.rs"];

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for e in fs::read_dir(dir).unwrap().flatten() {
        let p = e.path();
        if p.is_dir() {
            rust_files(&p, out);
        } else if p.extension().is_some_and(|x| x == "rs") && !SKIP.iter().any(|s| p.ends_with(s)) {
            out.push(p);
        }
    }
}

/// Source lines worth checking: no comments, nothing from the first `#[cfg(test)]` module on.
fn code_lines(text: &str) -> Vec<(usize, String)> {
    let mut out = Vec::new();
    for (i, l) in text.lines().enumerate() {
        let t = l.trim_start();
        if t.starts_with("#[cfg(test)]") {
            break;
        }
        if t.starts_with("//") {
            continue;
        }
        out.push((i + 1, strip_trailing_comment(l)));
    }
    out
}

fn strip_trailing_comment(l: &str) -> String {
    let b = l.as_bytes();
    let (mut in_str, mut i) = (false, 0);
    while i < b.len() {
        match b[i] {
            b'\\' if in_str => i += 1,
            b'"' => in_str = !in_str,
            b'/' if !in_str && b.get(i + 1) == Some(&b'/') => return l[..i].to_string(),
            _ => {}
        }
        i += 1;
    }
    l.to_string()
}

fn string_literals(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let b: Vec<char> = line.chars().collect();
    let mut i = 0;
    while i < b.len() {
        if b[i] == '"' && !(i > 0 && b[i - 1] == '\'' && b.get(i + 1) == Some(&'\'')) {
            let mut j = i + 1;
            let mut s = String::new();
            while j < b.len() && b[j] != '"' {
                if b[j] == '\\' {
                    j += 1;
                }
                if j < b.len() {
                    s.push(b[j]);
                }
                j += 1;
            }
            out.push(s);
            i = j + 1;
        } else {
            i += 1;
        }
    }
    out
}

fn short_message(s: &str) -> bool {
    s.chars().count() >= 12
        && s.split_whitespace().count() >= 2
        && s.chars().filter(|c| c.is_alphabetic()).count() >= 6
        && !s.contains([
            '{', '}', '\\', '^', '$', '|', '[', ']', '(', ')', '+', '*', '?', '<', '>', '=', ';',
            ':',
        ])
}

fn file_name_literal(s: &str) -> bool {
    let Some((stem, ext)) = s.rsplit_once('.') else {
        return false;
    };
    !stem.is_empty()
        && stem
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '_' | '.' | '-'))
        && [
            "json", "toml", "md", "log", "lock", "db", "sock", "txt", "jsonl", "ndjson", "sh",
        ]
        .contains(&ext)
}

/// A number of 2+ digits (or 2-9 alone) after `needle(`.
fn number_after(line: &str, needle: &str, min: u64) -> bool {
    let mut rest = line;
    while let Some(i) = rest.find(needle) {
        rest = &rest[i + needle.len()..];
        let digits: String = rest
            .trim_start()
            .chars()
            .take_while(char::is_ascii_digit)
            .collect();
        if digits.parse::<u64>().is_ok_and(|n| n >= min) {
            return true;
        }
    }
    false
}

fn bound_literal(line: &str) -> bool {
    number_after(line, ".take(", 2)
        || number_after(line, ".truncate(", 2)
        || number_after(line, ".skip(", 2)
        || number_after(line, ".min(", 10)
        || number_after(line, ".max(", 10)
        || number_after(line, ".clamp(", 10)
        || (line.contains("with_capacity(")
            && line.chars().any(|c| c.is_ascii_digit())
            && !line.contains("with_capacity(0)"))
        || number_after(line, "[0u8;", 8)
        || line.contains("<< 2")
        || number_after(line, "len() >=", 7)
        || number_after(line, "len() >", 7)
        || number_after(line, "len() <", 7)
}

fn violations(file: &Path, text: &str) -> Vec<String> {
    let mut v = Vec::new();
    let name = file.to_string_lossy().replace('\\', "/");
    for (n, line) in code_lines(text) {
        let t = line.trim();
        let mut hit = |rule: &str| {
            if !ALLOW
                .iter()
                .any(|(f, sub, _)| name.ends_with(f) && line.contains(sub))
            {
                v.push(format!(
                    "{name}:{n}: [{rule}] {}",
                    t.chars().take(150).collect::<String>()
                ));
            }
        };
        for d in ["from_millis(", "from_secs(", "from_micros(", "from_nanos("] {
            if let Some(p) = line.find(&format!("Duration::{d}"))
                && line[p + "Duration::".len() + d.len()..]
                    .trim_start()
                    .starts_with(|c: char| c.is_ascii_digit())
            {
                hit("timeout literal");
            }
        }
        for f in ["env::var(\"", "env::var_os(\"", "env_nonempty(\""] {
            if line.contains(f) {
                hit("env var literal");
            }
        }
        let is_item = ["const ", "static "].iter().any(|k| {
            t.starts_with(k)
                || t.starts_with(&format!("pub {k}"))
                || t.starts_with(&format!("pub(crate) {k}"))
        });
        if is_item && !t.contains("Atomic") && !t.contains("Mutex") && !t.contains("OnceLock") {
            hit("const/static literal");
        }
        let lits = string_literals(&line);
        let dev_diag = ["panic!(", ".expect(", "unreachable!("]
            .iter()
            .any(|k| line.contains(k));
        if !is_item
            && !dev_diag
            && lits
                .iter()
                .any(|s| s.chars().count() >= 30 && s.split_whitespace().count() >= 4)
        {
            hit("message text");
        }
        if !is_item && !dev_diag && lits.iter().any(|s| short_message(s)) {
            hit("short message");
        }
        if let Some(p) = line.find("matches!(")
            && line[p..].matches("\" | \"").count() >= 2
        {
            hit("matches! table");
        }
        if !is_item && !line.contains("assert") && bound_literal(&line) {
            hit("bound literal");
        }
        if !is_item && lits.iter().any(|s| file_name_literal(s)) {
            hit("file name");
        }
        if !is_item && lits.len() >= 3 && !line.contains("format!") && line.contains("[\"") {
            hit("string array");
        }
        for (i, s) in lits.iter().enumerate() {
            if !is_item
                && i == 0
                && s.starts_with('.')
                && s.len() > 1
                && s.chars().skip(1).all(|c| c.is_alphanumeric() || c == '-')
            {
                hit("directory name");
            }
        }
    }
    v
}

fn src_files() -> Vec<PathBuf> {
    let mut files = Vec::new();
    rust_files(
        &Path::new(env!("CARGO_MANIFEST_DIR")).join("src"),
        &mut files,
    );
    files.sort();
    files
}

#[test]
fn no_hardcoded_tunables_in_the_launcher() {
    let mut all = Vec::new();
    for f in src_files() {
        all.extend(violations(&f, &fs::read_to_string(&f).unwrap()));
    }
    assert!(
        all.is_empty(),
        "{} hard-coded tunables in ah-launcher/src (move them to engine/defaults/*.toml, or justify them in ALLOW):\n{}",
        all.len(),
        all.join("\n")
    );
}

#[test]
fn the_scan_sees_a_seeded_violation() {
    let bad = "fn f() { std::thread::sleep(Duration::from_millis(250)); let n = std::env::var(\"AH_SOMETHING\"); let p = \"state.json\"; }";
    let v = violations(Path::new("src/seeded.rs"), bad);
    assert!(
        v.iter().any(|l| l.contains("timeout literal"))
            && v.iter().any(|l| l.contains("env var literal"))
            && v.iter().any(|l| l.contains("file name")),
        "{v:?}"
    );
}

#[test]
fn allowlist_entries_are_justified_and_still_needed() {
    let files = src_files();
    for (suffix, sub, reason) in ALLOW {
        assert!(
            reason.split_whitespace().count() >= 3,
            "allowlist entry for {suffix} {sub:?} needs a reason"
        );
        if reason == &"never present" {
            continue;
        }
        let used = files
            .iter()
            .filter(|f| f.to_string_lossy().ends_with(suffix))
            .any(|f| fs::read_to_string(f).unwrap().contains(sub));
        assert!(
            used,
            "stale allowlist entry: {suffix} no longer contains {sub:?}"
        );
    }
}

// ---------------------------------------------------------------------------------------------------------------------------
// The built-in copy equals the shipped defaults
// ---------------------------------------------------------------------------------------------------------------------------

fn shipped(file: &str) -> toml::Table {
    let p = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../plugins/anti-hall/engine/defaults")
        .join(file);
    fs::read_to_string(p).unwrap().parse().unwrap()
}

fn value<'a>(docs: &'a [(&str, toml::Table)], key: &str) -> Option<&'a toml::Value> {
    let first = key.split('.').next().unwrap();
    let file = match first {
        "dispatch" => "dispatch.toml",
        "msg" => "messages.toml",
        "nodeback" => "nodeback.toml",
        _ if key == "files.shadow_ledger" => "nodeback.toml",
        _ => "engine.toml",
    };
    let doc = &docs.iter().find(|(f, _)| *f == file)?.1;
    let mut t = doc;
    for seg in key.split('.') {
        t = t.get(seg)?.as_table()?;
    }
    t.get("value")
}

#[test]
fn builtin_equals_shipped_defaults() {
    let docs = [
        ("engine.toml", shipped("engine.toml")),
        ("dispatch.toml", shipped("dispatch.toml")),
        ("messages.toml", shipped("messages.toml")),
        ("nodeback.toml", shipped("nodeback.toml")),
    ];
    for (k, v) in builtin::NUMS {
        let got = value(&docs, k).and_then(toml::Value::as_integer);
        assert_eq!(
            got,
            Some(*v as i64),
            "{k}: built-in {v} differs from the shipped file"
        );
    }
    for (k, v) in builtin::STRS {
        assert_eq!(
            value(&docs, k).and_then(toml::Value::as_str),
            Some(*v),
            "{k}: built-in text differs from the shipped file"
        );
    }
    for (k, fields) in builtin::TABLES {
        let t = value(&docs, k)
            .and_then(toml::Value::as_table)
            .unwrap_or_else(|| panic!("{k}: no shipped table"));
        for (f, v) in *fields {
            assert_eq!(
                t.get(*f).and_then(toml::Value::as_integer),
                Some(*v as i64),
                "{k}.{f}: built-in {v} differs from the shipped file"
            );
        }
        assert_eq!(t.len(), fields.len(), "{k}: field sets differ");
    }
    for (k, v) in builtin::LISTS {
        let got: Vec<&str> = value(&docs, k)
            .and_then(toml::Value::as_array)
            .unwrap()
            .iter()
            .filter_map(toml::Value::as_str)
            .collect();
        assert_eq!(
            got,
            v.to_vec(),
            "{k}: built-in list differs from the shipped file"
        );
    }
}

#[test]
fn every_launcher_key_in_the_shipped_files_has_a_builtin() {
    let docs = [
        ("engine.toml", shipped("engine.toml")),
        ("messages.toml", shipped("messages.toml")),
    ];
    let known = |k: &str| {
        builtin::num(k).is_some()
            || builtin::text(k).is_some()
            || builtin::list(k).is_some()
            || builtin::TABLES.iter().any(|(t, _)| *t == k)
    };
    let mut missing = Vec::new();
    let engine = &docs[0].1;
    for (name, _) in engine["launcher"].as_table().unwrap() {
        if !known(&format!("launcher.{name}")) {
            missing.push(format!("launcher.{name}"));
        }
    }
    for (name, _) in engine["files"]
        .as_table()
        .unwrap()
        .iter()
        .filter(|(n, _)| n.starts_with("launcher_"))
    {
        if !known(&format!("files.{name}")) {
            missing.push(format!("files.{name}"));
        }
    }
    for (name, _) in docs[1].1["msg"]
        .as_table()
        .unwrap()
        .iter()
        .filter(|(n, _)| n.starts_with("launcher_"))
    {
        if !known(&format!("msg.{name}")) {
            missing.push(format!("msg.{name}"));
        }
    }
    assert!(
        missing.is_empty(),
        "shipped launcher settings without a built-in value: {missing:?}"
    );
}

#[test]
fn both_defaults_copies_are_byte_identical() {
    let base = Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall/engine");
    for f in ["engine.toml", "messages.toml", "dispatch.toml"] {
        assert_eq!(
            fs::read(base.join("defaults").join(f)).unwrap(),
            fs::read(base.join("defaults.pristine").join(f)).unwrap(),
            "{f}"
        );
    }
}
