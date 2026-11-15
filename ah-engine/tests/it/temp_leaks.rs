//! The leak check of the test scratch dirs: a `TempDir` (tests/common) is removed when it drops, on a panic too, so the parity
//! lanes that lay homes out in the temp dir (mcp_reaper, spawn_ctx) leave nothing there.

use crate::common::TempDir;

#[test]
fn a_scratch_dir_is_gone_once_its_guard_drops_even_after_a_panic() {
    let base = std::env::temp_dir();
    let calm = TempDir::at(base.join(format!("ah-leakcheck-calm-{}", std::process::id())));
    std::fs::write(calm.join("f"), b"x").unwrap();
    let p = calm.to_path_buf();
    drop(calm);
    assert!(!p.exists(), "{} outlived its guard", p.display());
    let q = base.join(format!("ah-leakcheck-panic-{}", std::process::id()));
    let qq = q.clone();
    let r = std::panic::catch_unwind(move || {
        let d = TempDir::at(qq);
        std::fs::create_dir_all(d.join("sub/dir")).unwrap();
        panic!("a failing test");
    });
    assert!(r.is_err());
    assert!(!q.exists(), "{} outlived a panicking test", q.display());
}

/// Every `.rs` file under `dir`, recursively.
fn rs_files(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
    for e in std::fs::read_dir(dir).unwrap().flatten() {
        let p = e.path();
        if p.is_dir() {
            rs_files(&p, out);
        } else if p.extension().is_some_and(|x| x == "rs") {
            out.push(p);
        }
    }
}

/// Count of scratch paths built from the bare temp dir in `text`: `temp_dir().join(..)`, and a `let x[: T] = ..temp_dir();` binding
/// (typed, multiline, or on the same line as its join) whose name is later joined (`x.join(..)`) before the next `fn `. A bare
/// `temp_dir()` that is only read or passed along is not a scratch dir and is fine.
fn bare_temp_dir_uses(text: &str) -> usize {
    let code: String = text.lines().filter(|l| !l.trim_start().starts_with("//")).collect::<Vec<_>>().join("\n");
    let squeezed: String = code.chars().filter(|c| !c.is_whitespace()).collect();
    let mut n = squeezed.matches("temp_dir().join(").count();
    // statements, not lines: a binding may span lines or share one with its join
    let mut at = 0;
    while let Some(end) = code[at..].find(';') {
        let stmt = &code[at..at + end];
        let after = &code[at + end + 1..];
        at += end + 1;
        let sq: String = stmt.chars().filter(|c| !c.is_whitespace()).collect();
        let Some(i) = sq.rfind("let") else { continue };
        let rest = &sq[i + 3..];
        let rest = rest.strip_prefix("mut").unwrap_or(rest);
        let name: String = rest.chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
        let Some((_, init)) = rest.split_once('=') else { continue };
        if name.is_empty() || !init.ends_with("temp_dir()") {
            continue;
        }
        let scope = after.split("fn ").next().unwrap_or("");
        let scope: String = scope.chars().filter(|c| !c.is_whitespace()).collect();
        if scope.contains(&format!("{name}.join(")) {
            n += 1;
        }
    }
    n
}

#[test]
fn the_guard_catches_a_temp_dir_bound_to_a_variable_then_joined() {
    assert_eq!(bare_temp_dir_uses("let base = std::env::temp_dir();\nlet d = base.join(\"x\");"), 1);
    assert_eq!(bare_temp_dir_uses("let base = std::env::temp_dir();\nrun(&base.to_string_lossy());"), 0);
    assert_eq!(bare_temp_dir_uses("let d = std::env::temp_dir().join(\"x\");"), 1);
    // the forms the first guard missed: a typed binding, a multiline initializer, a binding and its join on one line
    assert_eq!(bare_temp_dir_uses("let base: PathBuf = std::env::temp_dir();\nlet d = base.join(\"x\");"), 1);
    assert_eq!(bare_temp_dir_uses("let base: std::path::PathBuf =\n    std::env::temp_dir();\nlet d = base.join(\"x\");"), 1);
    assert_eq!(bare_temp_dir_uses("let mut base = std::env::\n    temp_dir();\nbase.join(\"x\");"), 1);
    assert_eq!(bare_temp_dir_uses("let base = std::env::temp_dir(); let d = base.join(\"x\");"), 1);
    assert_eq!(bare_temp_dir_uses("let base: PathBuf = std::env::temp_dir();\nfn other() { base.join(\"x\"); }"), 0);
    assert_eq!(bare_temp_dir_uses("// temp_dir() in a comment\nlet d = testtmp::path(\"x\");"), 0);
}

#[test]
fn a_shared_parent_is_never_registered_for_the_exit_sweep() {
    let parent = format!("ah-registry-test-{}", std::process::id());
    let leaf = crate::common::testtmp::child(&parent, format!("leaf-{}", std::process::id()));
    let shared = std::env::temp_dir().join(&parent);
    let reg = crate::common::testtmp::registered();
    assert!(reg.contains(&leaf), "the per-process leaf is registered");
    assert!(!reg.contains(&shared), "the shared parent {} must never be registered", shared.display());
}

#[test]
fn no_test_builds_a_scratch_path_from_the_bare_temp_dir() {
    // A test scratch dir built as `temp_dir().join(..)` is never removed (#757: 60 GB of `ah-<tag>-<pid>` dirs). Test code takes
    // its scratch paths from `testtmp::path(..)`, which removes them when the test process exits.
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut files = Vec::new();
    rs_files(&root.join("src"), &mut files);
    rs_files(&root.join("tests"), &mut files);
    let mut bad = Vec::new();
    for f in files {
        let rel = f.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
        if rel == "tests/common/testtmp.rs" || rel == "tests/it/temp_leaks.rs" {
            continue; // the helper itself, and this scan's own needle
        }
        let text = std::fs::read_to_string(&f).unwrap();
        let in_test_file = rel.starts_with("tests/") || rel.contains("tests") || rel.ends_with("testkit.rs");
        // In a production src file only the part from its first `#[cfg(test)]` on is test code.
        let scanned = if in_test_file { text.as_str() } else { text.find("#[cfg(test)]").map_or("", |i| &text[i..]) };
        let n = bare_temp_dir_uses(scanned);
        if n > 0 {
            bad.push(format!("{rel}: {n}"));
        }
    }
    assert!(bad.is_empty(), "scratch paths built from the bare temp dir (use testtmp::path): {bad:?}");
}
