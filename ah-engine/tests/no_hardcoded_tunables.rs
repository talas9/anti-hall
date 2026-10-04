//! D17: every tunable, table, message text, path, env-var name, limit and timeout lives in `defaults/*.toml`.
//!
//! This test scans the non-test source for the shapes those things take in Rust and fails on any it finds that is
//! not on the allowlist below. The allowlist is for STRUCTURAL constants only (wire protocol, host protocol field
//! names, shell and regex grammar, security modes, status words); every entry says why it is structural. A new
//! tunable therefore cannot land in code without either moving to the defaults or being justified here in review.
//!
//! What it checks (comments and `#[cfg(test)]` modules are ignored):
//!  1. `Duration::from_*(<number>)`: a timeout or interval.
//!  2. `env::var*("<literal>")`: an environment variable name.
//!  3. `const`/`static` items holding a number, a string or a list of strings.
//!  4. message-like string literals: 30+ characters and 4+ words, not a raw regex pattern.
//!  5. `matches!(.., "a" | "b" | "c" ..)`: a table written as a pattern.
//!  6. array literals of three or more strings: a table.

use std::fs;
use std::path::{Path, PathBuf};

/// (file suffix, substring of the offending line, reason it is structural).
const ALLOW: &[(&str, &str, &str)] = &[
    // ---- wire and host protocols: part of the interface, versioned with it, not tunables --------------------
    ("src/frame.rs", "const MAGIC", "reply frame magic: the wire format identifier"),
    ("src/frame.rs", "const END", "reply frame trailer: the wire format identifier"),
    ("src/spool.rs", "const MAGIC", "spool record magic: the on-disk spool format identifier, versioned with the format"),
    ("src/hookio.rs", "pub const EXIT2", "reply-body marker for an exit-2 block: internal wire contract between daemon and client"),
    ("src/hookio.rs", "pub const FALLBACK", "reply-body marker for a deferral: internal wire contract between daemon and client"),
    ("src/docs.rs", "writeln!", "layout of the generated Markdown reference (headings, table headers): the generator's own format, not a tunable and not a message the engine shows at run time"),
    ("src/docs.rs", "\"| `{}` |", "row layout of the generated Markdown reference"),
    ("src/checks/git/tokenize.rs", "pub const CMDSUBST", "internal sentinel the tokenizer inserts for a command substitution; never shown to a user"),
    ("src/checks/mod.rs", "static ALL", "the check registry: the list of compiled-in checks is code, not configuration"),
    ("src/cli.rs", "for name in [\"kind\"", "the impact command's filter flag names: part of the command line itself"),
    ("src/cli.rs", "for name in [\"check\"", "the metrics command's flag names: part of the command line itself"),
    ("src/cli.rs", "for name in [\"job\"", "the schedule history command's flag names: part of the command line itself"),
    ("src/rules.rs", "for k in [\"command\"", "tool_input field names a rule can match by default: the host hook payload schema, an adapter concern (D30)"),
    ("src/health.rs", "for key in [\"breaker_until\"", "keys of the files.* settings the operator reset clears: names of settings, not values"),
    // ---- the database schema: code, versioned by its migrations; every tunable value is a bound parameter ---------
    ("src/sql.rs", "", "the SQL schema migrations and statements: the schema is code, versioned with the binary, and every tunable value is bound as a parameter at run time"),
];

/// Files that are not engine code paths (test helpers).
const SKIP_FILES: &[&str] = &["tests.rs"];

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for e in fs::read_dir(dir).unwrap().flatten() {
        let p = e.path();
        if p.is_dir() {
            rust_files(&p, out);
        } else if p.extension().is_some_and(|x| x == "rs") && !SKIP_FILES.iter().any(|s| p.ends_with(s)) {
            out.push(p);
        }
    }
}

/// Source lines worth checking: no comments, no inline `#[cfg(test)] mod tests { .. }` tail.
fn code_lines(text: &str) -> Vec<(usize, String)> {
    let mut out = Vec::new();
    let lines: Vec<&str> = text.lines().collect();
    for (i, l) in lines.iter().enumerate() {
        let t = l.trim_start();
        if t.starts_with("#[cfg(test)]") {
            if lines.get(i + 1).is_some_and(|n| n.trim_start().starts_with("mod tests {")) {
                break; // inline test module: everything after is test code
            }
            continue; // `#[cfg(test)] mod tests;` points at tests.rs
        }
        if t.starts_with("//") {
            continue;
        }
        out.push((i + 1, strip_trailing_comment(l)));
    }
    out
}

/// Drop a `// ...` tail that is not inside a string literal.
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
            let raw = i > 0 && (b[i - 1] == 'r' || b[i - 1] == '#');
            let mut j = i + 1;
            let mut s = String::new();
            while j < b.len() && b[j] != '"' {
                if b[j] == '\\' && !raw {
                    j += 1;
                }
                if j < b.len() {
                    s.push(b[j]);
                }
                j += 1;
            }
            if !raw {
                out.push(s);
            }
            i = j + 1;
        } else {
            i += 1;
        }
    }
    out
}

/// True when the line has `["..."` that starts an array literal (not an index such as `v["key"]`, and not a
/// `[` that is itself inside a string).
fn has_array_literal(line: &str) -> bool {
    let b: Vec<char> = line.chars().collect();
    let mut in_str = false;
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        if in_str {
            if c == '\\' {
                i += 1;
            } else if c == '"' {
                in_str = false;
            }
        } else if c == '"' && !(i > 0 && b[i - 1] == '\'' && b.get(i + 1) == Some(&'\'')) {
            in_str = true;
        } else if c == '[' && b.get(i + 1) == Some(&'"') {
            let prev = b[..i].iter().rev().find(|c| !c.is_whitespace());
            if !prev.is_some_and(|c| c.is_alphanumeric() || *c == '_' || *c == ']' || *c == ')') {
                return true;
            }
        }
        i += 1;
    }
    false
}

fn violations(file: &Path, text: &str) -> Vec<String> {
    let mut v = Vec::new();
    let name = file.to_string_lossy().replace('\\', "/");
    for (n, line) in code_lines(text) {
        let t = line.trim();
        let mut hit = |rule: &str| {
            if !ALLOW.iter().any(|(f, sub, _)| name.ends_with(f) && line.contains(sub)) {
                v.push(format!("{name}:{n}: [{rule}] {}", t.chars().take(150).collect::<String>()));
            }
        };
        let re_dur = ["from_millis(", "from_secs(", "from_micros(", "from_nanos("];
        for d in re_dur {
            if let Some(p) = line.find(&format!("Duration::{d}")) {
                let rest = &line[p + "Duration::".len() + d.len()..];
                if rest.trim_start().starts_with(|c: char| c.is_ascii_digit()) {
                    hit("timeout literal");
                }
            }
        }
        for f in ["env::var(\"", "env::var_os(\""] {
            if line.contains(f) {
                hit("env var literal");
            }
        }
        let is_item = ["const ", "static "].iter().any(|k| t.starts_with(k) || t.starts_with(&format!("pub {k}")) || t.starts_with(&format!("pub(crate) {k}")));
        if is_item && !t.contains("OnceLock") && !t.contains("Atomic") && !t.contains("Mutex") {
            hit("const/static literal");
        }
        let lits = string_literals(&line);
        // developer-facing diagnostics of a bug (never shown to a user or agent) are not message text
        let dev_diag = ["panic!(", ".expect(", "unreachable!("].iter().any(|k| line.contains(k));
        if !is_item && !dev_diag && lits.iter().any(|s| s.chars().count() >= 30 && s.split_whitespace().count() >= 4) {
            hit("message text");
        }
        if let Some(p) = line.find("matches!(") {
            let alts = line[p..].matches("\" | \"").count();
            if alts >= 2 {
                hit("matches! table");
            }
        }
        if !is_item && lits.len() >= 3 && !line.contains("format!") && !line.contains("assert") && has_array_literal(&line) {
            hit("string array");
        }
    }
    v
}

#[test]
fn no_hardcoded_tunables() {
    let mut files = Vec::new();
    rust_files(&Path::new(env!("CARGO_MANIFEST_DIR")).join("src"), &mut files);
    files.sort();
    let mut all = Vec::new();
    for f in &files {
        all.extend(violations(f, &fs::read_to_string(f).unwrap()));
    }
    assert!(all.is_empty(), "{} hard-coded tunables (move them to defaults/*.toml or justify them in the allowlist):\n{}", all.len(), all.join("\n"));
}

#[test]
fn allowlist_entries_are_justified_and_still_needed() {
    let mut files = Vec::new();
    rust_files(&Path::new(env!("CARGO_MANIFEST_DIR")).join("src"), &mut files);
    for (suffix, sub, reason) in ALLOW {
        assert!(reason.split_whitespace().count() >= 3, "allowlist entry for {suffix} {sub:?} needs a reason");
        let used = files.iter().filter(|f| f.to_string_lossy().ends_with(suffix)).any(|f| fs::read_to_string(f).unwrap().contains(sub));
        assert!(used, "stale allowlist entry: {suffix} no longer contains {sub:?}");
    }
}
