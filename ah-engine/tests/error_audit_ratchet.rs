//! Ratchets for the error-audit hardening rollout.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests
#![allow(clippy::panic, clippy::unreachable)] // integration tests: a panic is the failure report; production crates deny these in Cargo.toml

use std::path::Path;

fn src_files(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
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
    let mut skip = false;
    for line in text.lines() {
        if line.contains("#[cfg(test)]") {
            skip = true;
        }
        if !skip {
            out.push_str(line);
            out.push('\n');
        }
    }
    out
}

fn code_only(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut it = text.chars().peekable();
    let (mut line_comment, mut block_comment, mut string, mut char_lit, mut raw_hashes) = (false, 0_u32, false, false, None::<usize>);
    while let Some(c) = it.next() {
        if line_comment {
            if c == '\n' {
                line_comment = false;
                out.push('\n');
            } else {
                out.push(' ');
            }
            continue;
        }
        if block_comment > 0 {
            if c == '/' && it.peek() == Some(&'*') {
                it.next();
                block_comment += 1;
                out.push_str("  ");
            } else if c == '*' && it.peek() == Some(&'/') {
                it.next();
                block_comment -= 1;
                out.push_str("  ");
            } else {
                out.push(if c == '\n' { '\n' } else { ' ' });
            }
            continue;
        }
        if let Some(hashes) = raw_hashes {
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
            out.push(if c == '\n' { '\n' } else { ' ' });
            continue;
        }
        if string {
            if c == '\\' {
                out.push(' ');
                if let Some(n) = it.next() {
                    out.push(if n == '\n' { '\n' } else { ' ' });
                }
            } else {
                string = c != '"';
                out.push(if c == '\n' { '\n' } else { ' ' });
            }
            continue;
        }
        if char_lit {
            if c == '\\' {
                out.push(' ');
                if let Some(n) = it.next() {
                    out.push(if n == '\n' { '\n' } else { ' ' });
                }
            } else {
                char_lit = c != '\'';
                out.push(if c == '\n' { '\n' } else { ' ' });
            }
            continue;
        }
        if c == '/' && it.peek() == Some(&'/') {
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
            char_lit = true;
            out.push(' ');
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

#[test]
fn panic_and_unreachable_do_not_reenter_non_test_code() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    src_files(&root, &mut files);
    let mut offenders = Vec::new();
    for file in files {
        let text = code_only(&non_test_text(&file));
        if text.contains("panic!(") || text.contains("unreachable!(") {
            offenders.push(file.strip_prefix(&root).unwrap().display().to_string());
        }
    }
    assert!(offenders.is_empty(), "non-test panic!/unreachable! sites: {offenders:?}");
}

#[test]
fn indexing_slicing_count_only_goes_down() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    src_files(&root, &mut files);
    let mut count = 0_usize;
    for file in files {
        let text = code_only(&non_test_text(&file));
        count += indexing_sites(&text);
    }
    // Rebaseline the existing audit for the deliberate 0.2 engine additions.
    assert!(count <= 1719, "indexing/slicing ratchet is {count}, expected <= 1719");
}

fn indexing_sites(text: &str) -> usize {
    let bytes = text.as_bytes();
    let mut count = 0_usize;
    for (i, b) in bytes.iter().enumerate() {
        if *b != b'[' {
            continue;
        }
        let Some(prev) = bytes[..i].iter().rposition(|c| !c.is_ascii_whitespace()).map(|j| bytes[j]) else {
            continue;
        };
        if prev.is_ascii_alphanumeric() || matches!(prev, b'_' | b')' | b']') {
            count += 1;
        }
    }
    count
}
