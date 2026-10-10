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

#[test]
fn a_parity_scratch_dir_is_gone_after_its_drop_and_a_dead_runs_dirs_are_swept() {
    use crate::node_parity::support as sup;
    let s = sup::Scratch::new("leakcheck");
    std::fs::create_dir_all(s.path().join("e1/state")).unwrap();
    let p = s.path().to_path_buf();
    drop(s);
    assert!(!p.exists(), "{} outlived its Scratch", p.display());
    assert_eq!(sup::scratch_pid("ah-par-coordinator-work-guard-post-recording-pass-two-76468-1"), Some(76468));
    assert_eq!(sup::scratch_pid("ah-par-x-1"), None);
    // a dir of a process that is gone (no pid is that high) is swept by the next process's first scratch
    let dead = std::path::Path::new("/tmp").join("ah-par-leakcheck-2147483646-0");
    std::fs::create_dir_all(dead.join("e1")).unwrap();
    sup::sweep_dead_now(std::path::Path::new("/tmp"));
    assert!(!dead.exists(), "a dead run's scratch dir was not swept");
}
