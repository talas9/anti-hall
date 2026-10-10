//! Codex `apply_patch` end to end through the two edit-time guards (v1.0 lane L16): the real Node hook and the engine check
//! (`ah-engine check <guard>`) get the same Codex PreToolUse payload (`tool_name: apply_patch`, the raw patch in
//! `tool_input.command`) on identical scratch homes; the engine must print what Node prints (stdout, stderr, exit code) or hand
//! the call back (`AHFALLBACK`, nothing written), never answer weaker. The cases the engine owns are counted: they must not fall
//! back. The scratch home is the HOME of both sides; the real home and ~/.codex are never read or written.
use crate::common::TempDir;
use serde_json::{Value, json};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};

static N: AtomicUsize = AtomicUsize::new(0);

fn plugin() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("plugins").join("anti-hall").canonicalize().unwrap()
}

struct World {
    home: TempDir,
}

impl World {
    fn new() -> World {
        let n = N.fetch_add(1, Ordering::Relaxed);
        let home = TempDir::at(std::env::temp_dir().join(format!("ah-codex-patch-{}-{n}", std::process::id())));
        fs::create_dir_all(home.join("proj")).unwrap();
        fs::create_dir_all(home.join(".anti-hall/bin")).unwrap();
        World { home }
    }
    fn cwd(&self) -> PathBuf {
        self.home.join("proj")
    }
}

#[derive(PartialEq, Eq, Debug)]
struct Out {
    stdout: String,
    stderr: String,
    code: i32,
}

fn run(mut c: Command, w: &World, input: &str) -> Out {
    c.env_clear()
        .env("PATH", std::env::var("PATH").unwrap())
        .env("HOME", &*w.home)
        .env("PLUGIN_ROOT", plugin())
        .env("CLAUDE_PLUGIN_ROOT", plugin())
        .env("AH_ENGINE_PLUGIN_ROOT", plugin())
        .env("AH_ENGINE_DIR", w.home.join("state"))
        .env("ANTIHALL_INGEST_DRY_RUN", "1")
        .current_dir(w.cwd())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = c.spawn().unwrap();
    child.stdin.take().unwrap().write_all(input.as_bytes()).unwrap();
    let o = child.wait_with_output().unwrap();
    Out {
        stdout: String::from_utf8_lossy(&o.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&o.stderr).into_owned(),
        code: o.status.code().unwrap_or(-1),
    }
}

fn payload(w: &World, patch: &str, subagent: bool) -> String {
    let mut p = json!({"session_id": "s-1", "turn_id": "t-1", "model": "gpt-5", "hook_event_name": "PreToolUse", "cwd": w.cwd(),
        "transcript_path": null, "tool_name": "apply_patch", "tool_input": {"command": patch}, "tool_use_id": "call_1"});
    if subagent {
        p["agent_id"] = Value::from("agent-1");
        p["agent_type"] = Value::from("worker");
    }
    p.to_string()
}

/// `(node, engine)` for one guard; the engine side is `None` when it handed the call back. `@HOME@` in the patch is each side's own
/// scratch home.
fn both(guard: &str, patch: &str, subagent: bool, seed: &dyn Fn(&World)) -> (Out, Option<Out>) {
    let (a, b) = (World::new(), World::new());
    seed(&a);
    seed(&b);
    let with = |w: &World| patch.replace("@HOME@", &w.home.to_string_lossy());
    let mask = |s: &str, w: &World| s.replace(&*w.home.to_string_lossy(), "HOME");
    let node = {
        let mut c = Command::new("node");
        c.arg(plugin().join("hooks").join(format!("{guard}.js")));
        run(c, &a, &payload(&a, &with(&a), subagent))
    };
    let eng = {
        let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
        c.arg("check").arg(guard);
        run(c, &b, &payload(&b, &with(&b), subagent))
    };
    let node = Out { stdout: mask(&node.stdout, &a), stderr: mask(&node.stderr, &a), code: node.code };
    if eng.stdout.starts_with("AHFALLBACK") {
        return (node, None);
    }
    (node, Some(Out { stdout: mask(&eng.stdout, &b), stderr: mask(&eng.stderr, &b), code: eng.code }))
}

fn add(path: &str) -> String {
    format!("*** Begin Patch\n*** Add File: {path}\n+hello\n*** End Patch\n")
}

fn seed_cwd(w: &World) {
    fs::write(w.cwd().join("a.txt"), "a\n").unwrap();
}

struct Case {
    name: &'static str,
    patch: String,
    subagent: bool,
    /// the engine must answer without handing the call back
    engine_owns: bool,
    /// Node blocks
    blocks: bool,
}

fn case(name: &'static str, patch: String, subagent: bool, engine_owns: bool, blocks: bool) -> Case {
    Case { name, patch, subagent, engine_owns, blocks }
}

fn check(guard: &str, cases: Vec<Case>, seed: &dyn Fn(&World)) -> usize {
    let mut answered = 0;
    for c in cases {
        let (node, eng) = both(guard, &c.patch, c.subagent, seed);
        if c.blocks {
            assert_eq!(node.code, 2, "{} / {guard}: node blocks: {node:?}", c.name);
        }
        match eng {
            Some(e) => {
                assert_eq!(e, node, "{} / {guard}", c.name);
                answered += 1;
            }
            None => assert!(!c.engine_owns, "{} / {guard}: the engine must answer this itself (node: {node:?})", c.name),
        }
    }
    answered
}

#[test]
fn edit_guard_apply_patch_matches_node_or_defers() {
    let upd = |p: &str| format!("*** Begin Patch\n*** Update File: {p}\n@@\n-a\n+b\n*** End Patch\n");
    let cases = vec![
        case("subagent add into the launcher dir", add("@HOME@/.anti-hall/bin/x.sh"), true, true, true),
        case("main add into the launcher dir", add("@HOME@/.anti-hall/bin/x.sh"), false, true, true),
        case("relative path into the launcher dir", add("../.anti-hall/bin/x.sh"), true, true, true),
        case("update inside the launcher dir", upd("@HOME@/.anti-hall/bin/y"), true, true, true),
        case("delete inside the launcher dir", "*** Begin Patch\n*** Delete File: @HOME@/.anti-hall/bin/y\n*** End Patch\n".into(), false, true, true),
        case(
            "move into the launcher dir",
            "*** Begin Patch\n*** Update File: a.txt\n*** Move to: @HOME@/.anti-hall/bin/z\n@@\n-a\n+b\n*** End Patch\n".into(),
            true,
            true,
            true,
        ),
        case(
            "second of two files is in the launcher dir",
            "*** Begin Patch\n*** Add File: ok.txt\n+x\n*** Add File: @HOME@/.anti-hall/bin/q\n+y\n*** End Patch\n".into(),
            true,
            true,
            true,
        ),
        case("subagent ordinary add", add("src/new.txt"), true, true, false),
        case("subagent update", upd("a.txt"), true, true, false),
        case("subagent malformed patch", "not a patch".into(), true, true, false),
        case("subagent empty command", String::new(), true, true, false),
        case("main ordinary add (Node decides)", add("src/new.txt"), false, false, false),
        case("main malformed patch (Node decides)", "not a patch".into(), false, false, true),
    ];
    let answered = check("edit-guard", cases, &seed_cwd);
    assert!(answered >= 11, "the engine answers the launcher blocks and the subagent allows itself: {answered}");
}

#[test]
fn edit_guard_follows_a_symlink_into_the_launcher_dir() {
    let seed = |w: &World| {
        fs::write(w.home.join(".anti-hall/bin/evil.sh"), "a\n").unwrap();
        std::os::unix::fs::symlink(w.home.join(".anti-hall/bin"), w.cwd().join("link")).unwrap();
    };
    let upd = "*** Begin Patch\n*** Update File: link/evil.sh\n@@\n-a\n+b\n*** End Patch\n".to_string();
    let n = check("edit-guard", vec![case("update through a symlinked directory", upd, true, true, true)], &seed);
    assert_eq!(n, 1);
}

#[test]
fn api_guard_apply_patch_matches_node_or_defers() {
    let py = |body: &str| format!("*** Begin Patch\n*** Add File: tool.py\n{}*** End Patch\n", body.lines().map(|l| format!("+{l}\n")).collect::<String>());
    let cases = vec![
        case("clean python add", py("import os\nprint(os.getcwd())"), false, true, false),
        case("non-code add", add("notes.md"), false, true, false),
        case("delete only", "*** Begin Patch\n*** Delete File: a.txt\n*** End Patch\n".into(), false, true, false),
        case("malformed patch", "oops".into(), false, true, false),
        case("subagent clean python add", py("x = 1"), true, true, false),
    ];
    let answered = check("api-guard", cases, &seed_cwd);
    assert!(answered >= 5, "the engine answers the patches it can read: {answered}");
}
