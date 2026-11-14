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
        let squeezed: String = scanned.chars().filter(|c| !c.is_whitespace()).collect();
        let n = squeezed.matches("temp_dir().join(").count();
        if n > 0 {
            bad.push(format!("{rel}: {n}"));
        }
    }
    assert!(bad.is_empty(), "scratch paths built from the bare temp dir (use testtmp::path): {bad:?}");
}
