//! The settings keys the engine's source reads, with the type each read expects. Shared by `build.rs` (which compiles the
//! list into the engine, so a plugin whose defaults lack a key or give it the wrong type is rejected at load) and
//! `tests/defaults_keys.rs` (which checks the list against the shipped defaults). It is a schema derived from the source,
//! never configuration: no value is read here.
//!
//! A key is collected from these call shapes (test modules excluded):
//! * a typed reader with a literal key, `defaults::num("a.b")` and the like, including every literal inside its argument
//!   (`defaults::text(if x { "a.b" } else { "a.c" })`), and the same reader called as a method on a settings view
//!   (`t.num("a.b")`, `eff.text("a.b")`);
//! * a prefixing helper ([`HELPERS`]): `defaults::env_var("x")` reads `env.x`, `cap("x")` in the store reads `store.x`;
//! * any other literal `"section.name"` whose section is one the source reads directly (a key handed to a helper that
//!   forwards it), as a key that must exist, of any type.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// The value type a read expects.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Kind {
    /// Any type (the key must exist).
    Any,
    /// An integer (`num`, `millis`, `secs`).
    Int,
    /// A string (`text`, `render`, `words`, `env_name`).
    Str,
    /// A list of strings (`list`).
    List,
}

impl Kind {
    /// The name of the variant, as the generated code spells it.
    pub fn name(self) -> &'static str {
        match self {
            Kind::Any => "Any",
            Kind::Int => "Int",
            Kind::Str => "Str",
            Kind::List => "List",
        }
    }
}

/// The typed readers of `crate::defaults` and what they expect.
const READERS: [(&str, Kind); 9] = [
    ("num", Kind::Int),
    ("millis", Kind::Int),
    ("secs", Kind::Int),
    ("text", Kind::Str),
    ("render", Kind::Str),
    ("words", Kind::Str),
    ("list", Kind::List),
    ("raw", Kind::Any),
    ("env_of", Kind::Any),
];

/// Helpers that build a key from a prefix and a short name: (path fragment of the files they live in, `""` = any file;
/// helper name; key prefix; type).
pub const HELPERS: &[(&str, &str, &str, Kind)] = &[
    ("", "env_var", "env.", Kind::Str),
    ("", "env_name", "env.", Kind::Str),
    ("health.rs", "state_file", "files.", Kind::Str),
    ("health.rs", "halted", "files.", Kind::Str),
    ("health.rs", "halt", "files.", Kind::Str),
    ("health.rs", "read_json", "files.", Kind::Str),
    ("db.rs", "cap", "store.", Kind::Int),
    ("store.rs", "cap", "store.", Kind::Int),
    ("checks/git/", "words", "git.", Kind::List),
    ("checks/git/", "strings", "git.", Kind::List),
    ("checks/git/", "argv_template", "git.", Kind::List),
    ("checks/git/", "text", "git.", Kind::Str),
    ("checks/git/", "plain", "git.", Kind::Str),
    ("checks/git/", "note", "git.", Kind::Str),
    ("checks/git/", "num", "git.", Kind::Int),
    ("checks/git/", "block", "git.", Kind::Any),
    ("checks/git/", "switch", "git.", Kind::Any),
];

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            rust_files(&p, out);
        } else if p.extension().is_some_and(|x| x == "rs") && p.file_name().is_some_and(|n| n != "tests.rs") {
            out.push(p);
        }
    }
}

fn is_key(k: &str) -> bool {
    let Some((section, name)) = k.split_once('.') else { return false };
    let ok = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_');
    ok(section) && ok(name) && section.starts_with(|c: char| c.is_ascii_lowercase()) && !name.ends_with('_')
}

fn is_short(k: &str) -> bool {
    !k.is_empty() && k.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

/// The string literals (without escapes) in `text`.
fn literals(text: &str) -> Vec<(usize, &str)> {
    let b = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'"' && (i == 0 || b[i - 1] != b'\'' && b[i - 1] != b'\\') {
            let start = i + 1;
            let mut j = start;
            while j < b.len() && b[j] != b'"' {
                j += if b[j] == b'\\' { 2 } else { 1 };
            }
            if j <= b.len() {
                out.push((i, &text[start..j.min(b.len())]));
            }
            i = j + 1;
        } else {
            i += 1;
        }
    }
    out
}

/// The span of a call's argument list starting just after `(` at `open`, up to its matching `)`.
fn args_span(text: &str, open: usize) -> &str {
    let mut depth = 1usize;
    let mut in_str = false;
    let b = text.as_bytes();
    let mut i = open;
    while i < b.len() {
        match b[i] {
            b'\\' if in_str => i += 1,
            b'"' => in_str = !in_str,
            b'(' if !in_str => depth += 1,
            b')' if !in_str => {
                depth -= 1;
                if depth == 0 {
                    return &text[open..i];
                }
            }
            _ => {}
        }
        i += 1;
    }
    &text[open..]
}

/// The first argument of an argument list (up to the first comma outside brackets and strings).
fn first_arg(args: &str) -> &str {
    let mut depth = 0i32;
    let mut in_str = false;
    let b = args.as_bytes();
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'\\' if in_str => i += 1,
            b'"' => in_str = !in_str,
            b'(' | b'[' | b'{' if !in_str => depth += 1,
            b')' | b']' | b'}' if !in_str => depth -= 1,
            b',' if !in_str && depth == 0 => return &args[..i],
            _ => {}
        }
        i += 1;
    }
    args
}

/// Every call of `name(` in `text`: the char before it (`None` at the start) and the offset just after the `(`.
fn calls<'a>(text: &'a str, name: &'a str) -> impl Iterator<Item = (Option<char>, Option<&'a str>, usize)> + 'a {
    let needle = format!("{name}(");
    let mut from = 0;
    std::iter::from_fn(move || {
        while let Some(p) = text[from..].find(&needle) {
            let at = from + p;
            from = at + needle.len();
            let before = &text[..at];
            let prev = before.chars().last();
            if prev.is_some_and(|c| c.is_alphanumeric() || c == '_') {
                continue;
            }
            // the path segment before `name`, when it is `seg::name(`
            let seg = before.strip_suffix("::").map(|b| b.rsplit(|c: char| !(c.is_alphanumeric() || c == '_')).next().unwrap_or(""));
            return Some((prev, seg, from));
        }
        None
    })
}

fn add(keys: &mut BTreeMap<String, Kind>, k: String, kind: Kind) {
    keys.entry(k)
        .and_modify(|have| {
            // two reads that disagree on the type: the key need only exist (a build that reads it both ways is checked by tests)
            if *have != kind {
                *have = if *have == Kind::Any {
                    kind
                } else if kind == Kind::Any {
                    *have
                } else {
                    Kind::Any
                };
            }
        })
        .or_insert(kind);
}

/// The keys the source under `src` reads, with the type each read expects.
pub fn scan(src: &Path) -> BTreeMap<String, Kind> {
    let mut files = Vec::new();
    rust_files(src, &mut files);
    files.sort();
    let texts: Vec<(String, String)> = files
        .iter()
        .map(|f| {
            let text = std::fs::read_to_string(f).unwrap_or_else(|e| panic!("{}: {e}", f.display()));
            // test modules may name keys on purpose, including in negative tests
            let text = text.split("#[cfg(test)]\nmod tests {").next().unwrap_or("").to_string();
            (f.to_string_lossy().replace('\\', "/"), text)
        })
        .collect();
    let mut keys: BTreeMap<String, Kind> = BTreeMap::new();
    for (_, text) in &texts {
        for (reader, kind) in READERS {
            for (prev, seg, open) in calls(text, reader) {
                // `defaults::num(...)` or a method on a settings view (`t.num(...)`); a bare `num(` is someone else's
                let direct = seg == Some("defaults");
                let method = prev == Some('.');
                if !direct && !method {
                    continue;
                }
                let span = first_arg(args_span(text, open));
                let lits = literals(span);
                if method {
                    // a method's first argument only, and only when it is a literal key
                    if let Some((0, k)) = lits.first().copied().filter(|(_, k)| is_key(k)) {
                        add(&mut keys, k.to_string(), kind);
                    }
                    continue;
                }
                for (_, k) in lits {
                    if is_key(k) {
                        add(&mut keys, k.to_string(), kind);
                    }
                }
            }
        }
    }
    for (path, text) in &texts {
        for (frag, helper, prefix, kind) in HELPERS {
            if !path.contains(frag) {
                continue;
            }
            for (prev, seg, open) in calls(text, helper) {
                if prev == Some('.') || seg.is_some_and(|s| s != "defaults") {
                    continue;
                }
                if let Some((0, k)) = literals(args_span(text, open)).first().copied().filter(|(_, k)| is_short(k)) {
                    add(&mut keys, format!("{prefix}{k}"), *kind);
                }
            }
        }
    }
    let sections: std::collections::BTreeSet<String> = keys.keys().filter_map(|k| k.split_once('.').map(|(s, _)| s.to_string())).collect();
    for (_, text) in &texts {
        for (_, k) in literals(text) {
            if is_key(k) && k.split_once('.').is_some_and(|(s, _)| sections.contains(s)) {
                add(&mut keys, k.to_string(), Kind::Any);
            }
        }
    }
    keys
}
