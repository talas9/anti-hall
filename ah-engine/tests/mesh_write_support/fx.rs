//! Shared fixture and runners of the D45 stage 2 parity and concurrency tests (included with `#[path]`).
#![allow(dead_code)]
use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// The engine binary.
pub const BIN: &str = env!("CARGO_BIN_EXE_ah-engine");

/// Node 22.5+ with node:sqlite.
pub fn node_sqlite_available() -> bool {
    Command::new("node").args(["-e", "require('node:sqlite')"]).stderr(Stdio::null()).status().map(|s| s.success()).unwrap_or(false)
}

/// This checkout's plugin root.
pub fn plugin_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("plugins").join("anti-hall")
}

/// A file of the support directory.
pub fn support(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("mesh_write_support").join(name)
}

/// Its real path.
pub fn real(p: &Path) -> PathBuf {
    fs::canonicalize(p).unwrap()
}

/// Run git (identity pinned) in `cwd`.
pub fn git(args: &[&str], cwd: &Path) {
    let st = Command::new("git")
        .args(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false"])
        .args(args)
        .current_dir(cwd)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .unwrap();
    assert!(st.success(), "git {args:?} failed");
}

/// A seeded scratch fixture.
pub struct Fx {
    /// Scratch root.
    pub root: PathBuf,
    /// The main checkout (the Primary's).
    pub main: PathBuf,
    /// A linked child worktree.
    pub child: PathBuf,
    /// The seeded home every case copies.
    pub seed_home: PathBuf,
    /// The project's store key.
    pub repo_key: String,
    /// The Primary's registry id.
    pub primary_id: String,
    /// The child worktree's meshId.
    pub child_mesh: String,
}

impl Drop for Fx {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).ok();
    }
}

/// Outside any checkout (the cargo target dir is inside this repo, where every fixture would be a nested checkout).
pub fn fixture(tag: &str) -> Fx {
    let root = std::env::temp_dir().join(format!("ah-meshw-{tag}-{}", std::process::id()));
    fs::remove_dir_all(&root).ok();
    fs::create_dir_all(&root).unwrap();
    let root = real(&root);
    let main = root.join("repo");
    fs::create_dir_all(&main).unwrap();
    git(&["init", "-q"], &main);
    git(&["commit", "-q", "--allow-empty", "-m", "init"], &main);
    git(&["worktree", "add", "-q", "-b", "child", root.join("wt-child").to_str().unwrap()], &main);
    let child = real(&root.join("wt-child"));
    let seed_home = root.join("seed-home");
    fs::create_dir_all(&seed_home).unwrap();
    let o = Command::new("node")
        .arg(support("seed.js"))
        .arg(&seed_home)
        .arg(&main)
        .arg(&child)
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap())
        .env("HOME", &seed_home)
        .output()
        .unwrap();
    assert!(o.status.success(), "seed failed: {}", String::from_utf8_lossy(&o.stderr));
    let v: serde_json::Value = serde_json::from_slice(&o.stdout).unwrap();
    Fx {
        root,
        main,
        child,
        seed_home,
        repo_key: v["repoKey"].as_str().unwrap().into(),
        primary_id: v["primaryId"].as_str().unwrap().into(),
        child_mesh: v["childMeshId"].as_str().unwrap().into(),
    }
}

/// Copy a directory tree (files and directories only).
pub fn copy_tree(src: &Path, dst: &Path) {
    fs::create_dir_all(dst).unwrap();
    for e in fs::read_dir(src).unwrap().flatten() {
        let (s, d) = (e.path(), dst.join(e.file_name()));
        let ft = e.file_type().unwrap();
        if ft.is_dir() {
            copy_tree(&s, &d);
        } else if ft.is_file() {
            fs::copy(&s, &d).unwrap();
        }
    }
}

/// The cleared environment both sides run with, plus `extra`.
pub fn base_env(home: &Path, state: &Path, extra: &[(&str, &str)]) -> Vec<(String, String)> {
    let mut v = vec![
        ("HOME".to_string(), home.to_string_lossy().to_string()),
        ("PATH".to_string(), std::env::var("PATH").unwrap()),
        ("ANTIHALL_INGEST_DRY_RUN".into(), "1".into()),
        ("ANTIHALL_DEVSWARM_APP_DB".into(), "off".into()),
        ("AH_ENGINE_DIR".into(), state.to_string_lossy().to_string()),
        ("AH_ENGINE_PLUGIN_ROOT".into(), plugin_root().to_string_lossy().to_string()),
        ("AH_ENGINE_NOSPAWN".into(), "1".into()),
    ];
    for (k, x) in extra {
        v.push(((*k).into(), (*x).into()));
    }
    v
}

/// A verb's result.
pub struct Run {
    /// Exit code.
    pub code: i32,
    /// Stdout.
    pub stdout: String,
}

/// Run a command, feeding `stdin`.
pub fn run(cmd: &mut Command, stdin: Option<&str>) -> std::process::Output {
    cmd.stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() }).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut c = cmd.spawn().unwrap();
    if let Some(b) = stdin {
        c.stdin.take().unwrap().write_all(b.as_bytes()).unwrap();
    }
    c.wait_with_output().unwrap()
}

/// Run a verb through Node (`verb.js`).
pub fn node_verb(home: &Path, state: &Path, cwd: &Path, argv: &[&str], now: i64, stdin: Option<&str>, extra: &[(&str, &str)]) -> Run {
    let mut c = Command::new("node");
    c.arg(support("verb.js")).args(argv).current_dir(cwd).env_clear().envs(base_env(home, state, extra)).env("AH_ENGINE_MESH_NOW_MS", now.to_string());
    let o = run(&mut c, stdin);
    assert!(!o.stdout.is_empty(), "node verb printed nothing: {}", String::from_utf8_lossy(&o.stderr));
    let v: serde_json::Value = serde_json::from_slice(&o.stdout).unwrap_or_else(|e| panic!("{e}: {}", String::from_utf8_lossy(&o.stdout)));
    Run { code: v["code"].as_i64().unwrap() as i32, stdout: v["stdout"].as_str().unwrap().to_string() }
}

/// Run a verb through the engine binary.
pub fn engine_verb(home: &Path, state: &Path, cwd: &Path, argv: &[&str], now: i64, stdin: Option<&str>, extra: &[(&str, &str)]) -> Run {
    let mut c = Command::new(BIN);
    c.arg("mesh").args(argv).current_dir(cwd).env_clear().envs(base_env(home, state, extra)).env("AH_ENGINE_MESH_NOW_MS", now.to_string());
    let o = run(&mut c, stdin);
    Run { code: o.status.code().unwrap_or(-1), stdout: String::from_utf8_lossy(&o.stdout).into_owned() }
}

/// The last on/shadow record the engine logged.
pub fn last_log(state: &Path) -> serde_json::Value {
    let t = fs::read_to_string(state.join("mesh-shadow.jsonl")).unwrap_or_default();
    t.lines().last().map(|l| serde_json::from_str(l).unwrap()).unwrap_or(serde_json::Value::Null)
}

/// Every table of a store, every column, in rowid order (or primary-key order for a WITHOUT ROWID table), with
/// `sqlite_sequence`; `updated_at` of the cursor tables masked.
pub fn raw_dump(db: &Path) -> String {
    let c = rusqlite::Connection::open_with_flags(db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let mut tables: Vec<(String, String)> = c
        .prepare("SELECT name, sql FROM sqlite_master WHERE type IN ('table','index') ORDER BY name")
        .unwrap()
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?.unwrap_or_default())))
        .unwrap()
        .flatten()
        .collect();
    tables.sort();
    let mut out = String::new();
    for (name, sql) in &tables {
        out.push_str(&format!("## {name}: {sql}\n"));
        if sql.starts_with("CREATE INDEX") || name.starts_with("sqlite_autoindex") {
            continue;
        }
        let order = if sql.contains("WITHOUT ROWID") { "partition, ns, reader" } else { "rowid" };
        let mut st = c.prepare(&format!("SELECT * FROM \"{name}\" ORDER BY {order}")).unwrap();
        let cols: Vec<String> = st.column_names().iter().map(|s| s.to_string()).collect();
        let mut rows = st.query([]).unwrap();
        while let Some(r) = rows.next().unwrap() {
            let mut cells = Vec::new();
            for (i, col) in cols.iter().enumerate() {
                let masked = col == "updated_at" && (name == "broadcast_cursors" || name == "cursors");
                let v = match r.get_ref(i).unwrap() {
                    _ if masked => "<now>".to_string(),
                    rusqlite::types::ValueRef::Null => "NULL".into(),
                    rusqlite::types::ValueRef::Integer(x) => format!("i{x}"),
                    rusqlite::types::ValueRef::Real(x) => format!("r{x}"),
                    rusqlite::types::ValueRef::Text(t) => format!("t{:?}", String::from_utf8_lossy(t)),
                    rusqlite::types::ValueRef::Blob(b) => format!("b{b:?}"),
                };
                cells.push(format!("{col}={v}"));
            }
            out.push_str(&cells.join(" "));
            out.push('\n');
        }
    }
    out
}

/// Node's canonical dump of a store.
pub fn node_dump(home: &Path, key: &str) -> String {
    let d = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("it").join("mesh_support").join("dump.js");
    let o = Command::new("node").arg(d).arg(home).arg(key).env_clear().env("PATH", std::env::var("PATH").unwrap()).env("HOME", home).output().unwrap();
    assert!(o.status.success(), "dump.js failed: {}", String::from_utf8_lossy(&o.stderr));
    String::from_utf8_lossy(&o.stdout).into_owned()
}

/// Every file under `home` with its bytes, except the store files and the engine state dir (summaries ARE compared).
pub fn home_files(home: &Path) -> BTreeMap<String, Vec<u8>> {
    fn walk(base: &Path, d: &Path, out: &mut BTreeMap<String, Vec<u8>>) {
        // an injected permission fault leaves unreadable files and directories: they read as a marker, not a panic
        for e in fs::read_dir(d).into_iter().flatten().flatten() {
            let p = e.path();
            let rel = p.strip_prefix(base).unwrap().to_string_lossy().to_string();
            if rel.contains("/store/") || rel.starts_with("state") {
                continue;
            }
            if e.file_type().unwrap().is_dir() {
                out.insert(format!("{rel}/"), Vec::new());
                walk(base, &p, out);
            } else {
                out.insert(rel, fs::read(&p).unwrap_or_else(|_| b"<unreadable>".to_vec()));
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(home, home, &mut out);
    out
}

/// The first differing line of two dumps.
pub fn first_diff(a: &str, b: &str) -> String {
    for (i, (x, y)) in a.lines().zip(b.lines()).enumerate() {
        if x != y {
            return format!("line {}:\n  node:   {x}\n  engine: {y}", i + 1);
        }
    }
    format!("lengths differ: node {} lines, engine {} lines", a.lines().count(), b.lines().count())
}
