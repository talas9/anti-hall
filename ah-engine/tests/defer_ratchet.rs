//! Whole-engine ratchet on Node hand-off ("defer") sites.
//!
//! Root cause this guards: every `defer("<reason>")` / `Defer("<reason>")` site in `src/` once
//! handed the call to the Node implementation. Node is gone from the live path, so each site a
//! live call can reach is now an exit-69 failure. 435 such sites remained in `src/meshw` alone and
//! the migration was called done because nothing counted them. This test counts them per source
//! file, outside `#[cfg(test)]` code, comments and string contents.
//!
//! A site is a call to an identifier `defer`, `Defer` or `defer_*` (not its `fn` definition) whose
//! argument is a string literal or a `format!`. Pass-through calls such as `Defer(why)` are not
//! counted: they forward an existing reason rather than create one.
//!
//! The baseline is `tests/defer_baseline.txt` (read at run time, nothing hardcoded here):
//! - `[counts]` lines `<path relative to ah-engine/src> <count>`; a file's count may never rise
//!   and a file absent from the list may not have any defers.
//! - `[hot_path]` lines `<path>`; those files must have 0 defers. It starts empty.
//!
//! When a count drops, lower it in the baseline file (the test prints the new numbers).
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests
#![allow(clippy::panic, clippy::unreachable)] // integration tests: a panic is the failure report; production crates deny these in Cargo.toml

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

fn src_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.file_name().and_then(|n| n.to_str()).is_some_and(|n| n == "target") {
            continue;
        }
        if path.is_dir() {
            src_files(&path, out);
        } else if path.extension().and_then(|e| e.to_str()) == Some("rs") {
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if name == "tests.rs" || name.contains("golden") || name.contains("host_tests") {
                continue;
            }
            out.push(path);
        }
    }
}

fn non_test_text(path: &Path) -> String {
    let text = std::fs::read_to_string(path).unwrap();
    let mut out = String::new();
    for line in text.lines() {
        if line.contains("#[cfg(test)]") {
            break;
        }
        out.push_str(line);
        out.push('\n');
    }
    out
}

/// Blank comments and string/char literal contents, keeping line structure (same scanner idea as
/// `error_audit_ratchet.rs`). Quotes of a literal become spaces, so a literal argument reads as blank.
fn code_only(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut it = text.chars().peekable();
    let (mut line_comment, mut block_comment, mut string, mut char_lit, mut raw_hashes) = (false, 0_u32, false, false, None::<usize>);
    let blank = |c: char| if c == '\n' { '\n' } else { ' ' };
    while let Some(c) = it.next() {
        if line_comment {
            line_comment = c != '\n';
            out.push(blank(c));
        } else if block_comment > 0 {
            if c == '/' && it.peek() == Some(&'*') {
                it.next();
                block_comment += 1;
                out.push_str("  ");
            } else if c == '*' && it.peek() == Some(&'/') {
                it.next();
                block_comment -= 1;
                out.push_str("  ");
            } else {
                out.push(blank(c));
            }
        } else if let Some(hashes) = raw_hashes {
            if c == '"' {
                let mut n = 0_usize;
                while n < hashes && it.peek() == Some(&'#') {
                    it.next();
                    n += 1;
                }
                if n == hashes {
                    raw_hashes = None;
                }
            }
            out.push(blank(c));
        } else if string || char_lit {
            if c == '\\' {
                out.push(' ');
                if let Some(n) = it.next() {
                    out.push(blank(n));
                }
            } else {
                if string {
                    string = c != '"';
                } else {
                    char_lit = c != '\'';
                }
                out.push(blank(c));
            }
        } else if c == '/' && it.peek() == Some(&'/') {
            it.next();
            line_comment = true;
            out.push_str("  ");
        } else if c == '/' && it.peek() == Some(&'*') {
            it.next();
            block_comment = 1;
            out.push_str("  ");
        } else if c == '"' {
            string = true;
            out.push(' ');
        } else if c == '\'' {
            // a lifetime ('a) has no closing quote; treat `'x'`/escapes as char literals only
            let mut look = it.clone();
            let first = look.next();
            let is_char = first == Some('\\') || look.next() == Some('\'');
            if is_char {
                char_lit = true;
                out.push(' ');
            } else {
                out.push(c);
            }
        } else if c == 'r' {
            let mut clone = it.clone();
            let mut hashes = 0_usize;
            while clone.peek() == Some(&'#') {
                clone.next();
                hashes += 1;
            }
            if clone.peek() == Some(&'"') {
                for _ in 0..hashes {
                    it.next();
                }
                it.next();
                raw_hashes = Some(hashes);
                out.push_str(&" ".repeat(hashes + 2));
            } else {
                out.push(c);
            }
        } else {
            out.push(c);
        }
    }
    out
}

fn is_ident(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// Count creating defer calls in comment/string-blanked code.
fn defer_sites(code: &str) -> usize {
    let b = code.as_bytes();
    let mut count = 0_usize;
    let mut i = 0_usize;
    while i < b.len() {
        if !is_ident(b[i]) || (i > 0 && is_ident(b[i - 1])) {
            i += 1;
            continue;
        }
        let start = i;
        while i < b.len() && is_ident(b[i]) {
            i += 1;
        }
        let ident = &code[start..i];
        if !(ident == "defer" || ident == "Defer" || ident.starts_with("defer_")) {
            continue;
        }
        if code[..start].trim_end().ends_with("fn") {
            continue;
        }
        let rest = code[i..].trim_start();
        let Some(args) = rest.strip_prefix('(') else { continue };
        let args = args.trim_start();
        // blanked string literal => next significant char closes/continues the arg list
        if args.starts_with(')') || args.starts_with(',') || args.starts_with("format!") || args.starts_with("&format!") {
            count += 1;
        }
    }
    count
}

fn counts() -> BTreeMap<String, usize> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    src_files(&root, &mut files);
    let mut out = BTreeMap::new();
    for file in files {
        let n = defer_sites(&code_only(&non_test_text(&file)));
        if n > 0 {
            out.insert(file.strip_prefix(&root).unwrap().to_string_lossy().replace('\\', "/"), n);
        }
    }
    out
}

struct Baseline {
    counts: BTreeMap<String, usize>,
    hot_path: Vec<String>,
}

fn baseline() -> Baseline {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/defer_baseline.txt");
    let text = std::fs::read_to_string(&path).unwrap();
    let (mut counts, mut hot_path, mut section) = (BTreeMap::new(), Vec::new(), "");
    for line in text.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#')) {
        match line {
            "[counts]" => section = "counts",
            "[hot_path]" => section = "hot_path",
            _ if section == "counts" => {
                let (file, n) = line.rsplit_once(' ').unwrap_or_else(|| panic!("bad baseline line: {line}"));
                counts.insert(file.trim().to_string(), n.parse().unwrap_or_else(|_| panic!("bad count in: {line}")));
            }
            _ if section == "hot_path" => hot_path.push(line.to_string()),
            _ => panic!("baseline line outside a section: {line}"),
        }
    }
    Baseline { counts, hot_path }
}

#[test]
fn defer_count_per_file_only_goes_down() {
    let (now, base) = (counts(), baseline());
    let mut raised = Vec::new();
    let mut lowered = Vec::new();
    for (file, n) in &now {
        match base.counts.get(file) {
            Some(b) if n > b => raised.push(format!("{file}: {b} -> {n}")),
            Some(b) if n < b => lowered.push(format!("{file}: {b} -> {n}")),
            None => raised.push(format!("{file}: new file with {n} defer site(s)")),
            _ => {}
        }
    }
    for (file, b) in &base.counts {
        if !now.contains_key(file) {
            lowered.push(format!("{file}: {b} -> 0"));
        }
    }
    if !lowered.is_empty() {
        println!("defer sites dropped; lower tests/defer_baseline.txt:\n  {}", lowered.join("\n  "));
    }
    assert!(raised.is_empty(), "defer sites rose (each is a live exit-69 path now that Node is gone):\n  {}", raised.join("\n  "));
}

#[test]
fn hot_path_files_have_no_defers() {
    let (now, base) = (counts(), baseline());
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut bad = Vec::new();
    for file in &base.hot_path {
        assert!(root.join(file).exists(), "hot_path file {file} does not exist under src/");
        if let Some(n) = now.get(file) {
            bad.push(format!("{file}: {n}"));
        }
    }
    assert!(bad.is_empty(), "hot-path files must have 0 defer sites:\n  {}", bad.join("\n  "));
}

/// Prints a fresh baseline: `cargo test --test defer_ratchet print_baseline -- --ignored --nocapture`.
#[test]
#[ignore = "helper that prints the current counts"]
fn print_baseline() {
    println!("[counts]");
    for (file, n) in counts() {
        println!("{file} {n}");
    }
}
