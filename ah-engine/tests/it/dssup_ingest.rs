//! The native ingest drain (lane l7b) against the Node ingest daemon's own code: the batch parser, the dedupe hash and the rows of
//! a batch for a corpus of monitor outputs; the delivery WAL in both directions; the breaker ladders; the single-consumer lock in
//! both directions; and the drain end to end against a stub `hivecontrol` on a scratch home with a git repository and a store
//! Node created. Real `node` runs only in a scratch HOME. Nothing reads or writes the real home.
use ah_engine::db::TempDir;
use ah_engine::dssup::ingest::drain::Project;
use ah_engine::dssup::ingest::wal;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::process::Command;

fn git(args: &[&str], cwd: &Path) {
    let st = Command::new("git")
        .args(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false"])
        .args(args)
        .current_dir(cwd)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .output()
        .unwrap();
    assert!(st.status.success(), "git {args:?}");
}

fn now() -> i64 {
    ah_engine::health::now_ms() as i64
}

#[test]
fn a_wal_that_cannot_be_written_spills_and_blocks_instead_of_dropping_the_batch() {
    let t = TempDir::new("wal-spill");
    let root = std::fs::canonicalize(&t.0).unwrap();
    let devroot = root.join(".anti-hall/devswarm");
    std::fs::create_dir_all(devroot.join("wal")).unwrap();
    // the WAL path is a DIRECTORY: it can never be appended to
    let file = wal::wal_path(&devroot, "monitor", "k");
    std::fs::create_dir_all(&file).unwrap();
    assert!(wal::preflight(&file).unwrap().starts_with("WAL "));
    match wal::capture_raw(&file, "precious bytes", 1, Some("/wt")) {
        wal::Capture::Spilled(p, why) => {
            assert!(!why.is_empty());
            assert!(std::fs::read_to_string(p).unwrap().contains("precious bytes"));
        }
        other => panic!("expected a spill, got {other:?}"),
    }
    assert_eq!(wal::spilled(&file), 1);
    // absorbing needs a writable WAL: it fails, the spill stays
    assert!(wal::absorb_spill(&file, 2).is_err());
    assert_eq!(wal::spilled(&file), 1, "nothing was dropped");
}

#[test]
fn the_ownership_marker_names_the_owner_and_how_long_it_holds() {
    use ah_engine::dssup::ingest::{Owner, write_owner};
    ah_engine::defaults::init().unwrap();
    let t = TempDir::new("ingest-owner");
    let home = std::fs::canonicalize(&t.0).unwrap();
    let path = home.join(".anti-hall/devswarm/ingest-owner.json");
    write_owner(&home, Owner::Engine, 1234);
    let m: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(m["owner"], "engine");
    assert_eq!(m["ts"], 1234);
    assert_eq!(m["pid"], std::process::id());
    assert_eq!(m["validForMs"], ah_engine::defaults::num("devswarm_ingest.owner_valid_ms"));
    write_owner(&home, Owner::Witness, 5678);
    let m: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(m["owner"], "witness", "switching to witness hands installs back to Node at once");
}

// ---- a repository nested in another repository (no Node needed) -------------------------------------------------------------

/// `outer/` and `outer/inner/`, each an independent repository with one commit (the `~/Projects/tesla` / `tesla-docker` shape).
fn nested(tag: &str) -> (TempDir, PathBuf, PathBuf, PathBuf) {
    ah_engine::defaults::init().unwrap();
    let t = TempDir::new(tag);
    let root = std::fs::canonicalize(&t.0).unwrap();
    let (home, outer, inner) = (root.join("home"), root.join("outer"), root.join("outer").join("inner"));
    for d in [&home, &inner] {
        std::fs::create_dir_all(d).unwrap();
    }
    for d in [&outer, &inner] {
        git(&["init", "-q"], d);
        git(&["commit", "-q", "--allow-empty", "-m", "init"], d);
    }
    (t, home, outer, inner)
}

fn descriptor(home: &Path, id: &str, repo_key: &str, worktree: &Path) {
    let dir = home.join(".anti-hall/devswarm/workspaces");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(format!("{id}.json")), json!({"id": id, "repoKey": repo_key, "worktreePath": worktree, "sessionId": "s"}).to_string()).unwrap();
}

fn ingest_log(home: &Path) -> String {
    std::fs::read_to_string(home.join(ah_engine::defaults::text("devswarm_ingest.log_file"))).unwrap_or_default()
}

#[test]
fn an_independent_repository_nested_in_another_is_its_own_project() {
    // live 2026-10-16: tesla-docker (its own .git directory) inside ~/Projects/tesla (also a repository) was never drained: the
    // identity resolver deferred "git-superproject" and the drain dropped the project without a word.
    let (_t, home, outer, inner) = nested("ingest-nested");
    let p = Project::resolve(inner.to_str().unwrap()).expect("a nested independent repository resolves");
    assert_eq!(p.worktree, inner.to_string_lossy(), "rooted at the inner checkout, not the outer one");
    let o = Project::resolve(outer.to_str().unwrap()).unwrap();
    assert_ne!(o.repo_key, p.repo_key);
    // registered, it is found with no heartbeat and no explicit setting
    descriptor(&home, &p.workspace_id, &p.repo_key, &inner);
    let t2 = TempDir::new("ingest-nested-state");
    let found = ah_engine::dssup::ingest::discover(&home, &t2.0, "", now());
    assert_eq!(found.iter().map(|f| f.repo_key.as_str()).collect::<Vec<_>>(), [p.repo_key.as_str()], "{found:?}");
}

#[test]
fn a_dropped_path_is_logged_once_with_its_reason() {
    ah_engine::defaults::init().unwrap();
    let t = TempDir::new("ingest-drops");
    let home = std::fs::canonicalize(&t.0).unwrap();
    let plain = home.join("plain");
    std::fs::create_dir_all(&plain).unwrap();
    let state = home.join("state");
    let explicit = plain.to_str().unwrap();
    for _ in 0..3 {
        assert!(ah_engine::dssup::ingest::discover(&home, &state, explicit, now()).is_empty());
    }
    let log = ingest_log(&home);
    let lines: Vec<&str> = log.lines().filter(|l| l.contains(explicit)).collect();
    assert_eq!(lines.len(), 1, "one line per (path, reason), not one per pass: {log}");
    assert!(lines[0].contains(ah_engine::defaults::text("devswarm_ingest.drop_reason_non_git")), "{}", lines[0]);
}

#[test]
fn an_unregistered_project_skipped_by_require_registered_is_logged() {
    let (_t, home, _outer, inner) = nested("ingest-unregistered");
    let hb = home.join(".anti-hall/devswarm/heartbeats");
    std::fs::create_dir_all(&hb).unwrap();
    std::fs::write(hb.join("ingest-x.json"), json!({"ts": now() - 1000, "workingDir": inner}).to_string()).unwrap();
    let state = home.join("state");
    assert!(ah_engine::dssup::ingest::discover(&home, &state, "", now()).is_empty());
    let log = ingest_log(&home);
    let want = ah_engine::defaults::text("devswarm_ingest.drop_reason_unregistered");
    assert!(log.lines().any(|l| l.contains(inner.to_str().unwrap()) && l.contains(want)), "{log}");
}
