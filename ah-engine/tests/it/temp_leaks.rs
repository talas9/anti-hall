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
