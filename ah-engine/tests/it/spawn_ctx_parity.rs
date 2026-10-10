//! Node-vs-engine parity for the spawn/path context checks: `inbox-read-guard`, `phase-tracker`, `orch-on-spawn` and
//! `verify-first-orch` (port batch 3).
//!
//! Each case runs the real Node hook and `ah-engine check <name>` on the same payload, each with its own isolated home
//! seeded identically (never the real home), and compares the exit code, the stdout bytes, the stderr bytes and the state
//! files the run left behind. A case marked `defer` is one the engine must hand to Node (`AHFALLBACK`); for it the engine
//! must also have left the state exactly as it was seeded, so Node then sees what it would have seen alone.
//! Timestamps within a minute of the run are normalized, since the two runs are not simultaneous.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests
use crate::common::TempDir;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{
    Mutex,
    atomic::{AtomicUsize, Ordering},
};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

static SERIAL: Mutex<()> = Mutex::new(());
static HOME_ID: AtomicUsize = AtomicUsize::new(0);

const FALLBACK: &str = "AHFALLBACK\n";

#[derive(Clone, Copy)]
struct Hook {
    script: &'static str,
    check: &'static str,
    argv: &'static [&'static str],
}

const INBOX: Hook = Hook { script: "inbox-read-guard.js", check: "inbox-read-guard", argv: &[] };
const PHASE: Hook = Hook { script: "phase-tracker.js", check: "phase-tracker", argv: &[] };
const SPAWN: Hook = Hook { script: "orch-on-spawn.js", check: "orch-on-spawn", argv: &[] };
const ORCH: Hook = Hook { script: "verify-first-orch.js", check: "verify-first-orch", argv: &["--host=claude"] };
/// The Codex hook entry: the same script without the `--host=claude` flag.
const ORCH_CODEX: Hook = Hook { script: "verify-first-orch.js", check: "verify-first-orch-codex", argv: &[] };

#[derive(Clone)]
enum Seed {
    /// `~/.anti-hall/settings.json`.
    Settings(Value),
    /// `~/.anti-hall/skip.json`.
    Skip(Value),
    /// `~/.claude/settings.json`.
    Claude(Value),
    /// A file at a path relative to the home; `age_ms` back-dates its modification time.
    File(String, Vec<u8>, u64),
    /// A directory.
    Dir(String),
    /// A symbolic link (`rel` points at `target`).
    Link(String, String),
}

#[derive(Clone)]
enum Input {
    Json(Value),
    Raw(String),
}

#[derive(Clone)]
struct Case {
    name: String,
    input: Input,
    env: Vec<(String, String)>,
    seed: Vec<Seed>,
    defer: bool,
}

fn case(name: &str, input: Value) -> Case {
    Case { name: name.into(), input: Input::Json(input), env: Vec::new(), seed: Vec::new(), defer: false }
}

impl Case {
    fn raw(name: &str, input: &str) -> Case {
        Case { name: name.into(), input: Input::Raw(input.into()), env: Vec::new(), seed: Vec::new(), defer: false }
    }
    fn env(mut self, k: &str, v: &str) -> Case {
        self.env.push((k.into(), v.into()));
        self
    }
    fn seed(mut self, s: Seed) -> Case {
        self.seed.push(s);
        self
    }
    fn file(self, rel: &str, body: &str) -> Case {
        self.seed(Seed::File(rel.into(), body.as_bytes().to_vec(), 0))
    }
    fn aged(self, rel: &str, body: &str, age_ms: u64) -> Case {
        self.seed(Seed::File(rel.into(), body.as_bytes().to_vec(), age_ms))
    }
    fn defer(mut self) -> Case {
        self.defer = true;
        self
    }
}

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").canonicalize().unwrap()
}

fn plugin() -> PathBuf {
    repo().join("plugins/anti-hall")
}

fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis()
}

fn temp_home(tag: &str) -> TempDir {
    TempDir::at(std::env::temp_dir().join(format!("ah-spawnctx-{tag}-{}-{}", std::process::id(), HOME_ID.fetch_add(1, Ordering::Relaxed))))
}

/// `$HOME` and `{NOW-n}` / `{NOW+n}` in a seed or payload.
fn subst(s: &str, home: &Path, now: u128) -> String {
    let mut out = s.replace("$HOME", &home.to_string_lossy());
    while let Some(i) = out.find("{NOW") {
        let j = out[i..].find('}').unwrap() + i;
        let spec = &out[i + 4..j];
        let n: u128 = spec[1..].parse().unwrap();
        let v = if spec.starts_with('-') { now - n } else { now + n };
        out.replace_range(i..=j, &v.to_string());
    }
    out
}

fn seed_home(home: &Path, seeds: &[Seed], now: u128) {
    let w = |rel: &str, body: Vec<u8>, age: u64| {
        let p = home.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, body).unwrap();
        if age > 0 {
            let f = std::fs::OpenOptions::new().write(true).open(&p).unwrap();
            f.set_modified(SystemTime::now() - Duration::from_millis(age)).unwrap();
        }
    };
    for s in seeds {
        match s {
            Seed::Settings(v) => w(".anti-hall/settings.json", v.to_string().into_bytes(), 0),
            Seed::Skip(v) => w(".anti-hall/skip.json", subst(&v.to_string(), home, now).into_bytes(), 0),
            Seed::Claude(v) => w(".claude/settings.json", v.to_string().into_bytes(), 0),
            Seed::File(rel, body, age) => {
                let body = match std::str::from_utf8(body) {
                    Ok(t) => subst(t, home, now).into_bytes(),
                    Err(_) => body.clone(),
                };
                w(&subst(rel, home, now), body, *age)
            }
            Seed::Dir(rel) => std::fs::create_dir_all(home.join(rel)).unwrap(),
            Seed::Link(rel, target) => {
                let p = home.join(rel);
                std::fs::create_dir_all(p.parent().unwrap()).unwrap();
                std::os::unix::fs::symlink(subst(target, home, now), p).unwrap();
            }
        }
    }
}

/// Every file, directory and link under the home (but the engine's own state), as `path -> description`, with
/// timestamps near the run replaced.
fn snapshot(home: &Path, now: u128) -> BTreeMap<String, String> {
    fn walk(dir: &Path, root: &Path, out: &mut BTreeMap<String, String>, now: u128) {
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let p = e.path();
            let rel = p.strip_prefix(root).unwrap().to_string_lossy().to_string();
            if rel == "engine-state" {
                continue;
            }
            let ft = e.file_type().unwrap();
            if ft.is_symlink() {
                out.insert(rel, format!("-> {}", std::fs::read_link(&p).unwrap().to_string_lossy().replace(&root.to_string_lossy().to_string(), "$HOME")));
            } else if ft.is_dir() {
                out.insert(format!("{rel}/"), String::new());
                walk(&p, root, out, now);
            } else {
                let body = String::from_utf8_lossy(&std::fs::read(&p).unwrap()).to_string();
                out.insert(rel, mask_pid(&norm(&body.replace(&root.to_string_lossy().to_string(), "$HOME"), now)));
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(home, home, &mut out, now);
    out
}

/// The process id a claim file records (`"pid":123`) is the hook process's own: Node's and the engine's differ by nature.
fn mask_pid(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(i) = rest.find("\"pid\":") {
        let (head, tail) = rest.split_at(i + 6);
        out.push_str(head);
        let digits = tail.chars().take_while(char::is_ascii_digit).count();
        out.push_str(if digits > 0 { "<PID>" } else { "" });
        rest = &tail[digits..];
    }
    out.push_str(rest);
    out
}

/// Thirteen-digit numbers within a minute of `now` become `<NOW>`; the stale and the tmp-file names are left alone.
fn norm(s: &str, now: u128) -> String {
    let b = s.as_bytes();
    let mut out = String::new();
    let mut i = 0;
    while i < b.len() {
        if b[i].is_ascii_digit() {
            let j = (i..b.len()).find(|&k| !b[k].is_ascii_digit()).unwrap_or(b.len());
            let run = &s[i..j];
            if run.len() == 13 && run.parse::<u128>().is_ok_and(|n| n.abs_diff(now) < 60_000) {
                out.push_str("<NOW>");
            } else {
                out.push_str(run);
            }
            i = j;
        } else {
            let ch = s[i..].chars().next().unwrap();
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    // tmp marker files carry a pid and a random suffix: only their existence is compared
    let re_tmp = regex::Regex::new(r"\.\d+\.[0-9a-f]{8}\.tmp\.json").unwrap();
    re_tmp.replace_all(&out, ".<PID>.<RND>.tmp.json").to_string()
}

fn norm_path_keys(m: BTreeMap<String, String>) -> BTreeMap<String, String> {
    let re_tmp = regex::Regex::new(r"\.\d+\.[0-9a-f]{8}\.tmp\.json").unwrap();
    m.into_iter().map(|(k, v)| (re_tmp.replace_all(&k, ".<PID>.<RND>.tmp.json").to_string(), v)).collect()
}

type Out = (i32, Vec<u8>, Vec<u8>);

fn run(mut cmd: Command, input: &[u8]) -> Out {
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let data = input.to_vec();
    let writer = std::thread::spawn(move || {
        ah_engine::discard::harmless(stdin.write_all(&data));
    });
    let mut so = child.stdout.take().unwrap();
    let mut se = child.stderr.take().unwrap();
    let ro = std::thread::spawn(move || {
        let mut b = Vec::new();
        ah_engine::discard::harmless(so.read_to_end(&mut b));
        b
    });
    let re = std::thread::spawn(move || {
        let mut b = Vec::new();
        ah_engine::discard::harmless(se.read_to_end(&mut b));
        b
    });
    let deadline = Instant::now() + Duration::from_secs(30);
    let status = loop {
        if let Some(s) = child.try_wait().unwrap() {
            break s;
        }
        assert!(Instant::now() < deadline, "child exceeded 30 seconds: {cmd:?}");
        std::thread::sleep(Duration::from_millis(3));
    };
    ah_engine::discard::harmless(writer.join());
    (status.code().unwrap_or(-1), ro.join().unwrap(), re.join().unwrap())
}

fn base_env(c: &mut Command, home: &Path, extra: &[(String, String)], now: u128) {
    c.env_clear().env("PATH", std::env::var("PATH").unwrap_or_default()).env("HOME", home).env("USERPROFILE", home).env("ANTIHALL_TEST_ISOLATION", "1");
    for (k, v) in extra {
        c.env(k, subst(v, home, now));
    }
}

fn run_node(h: Hook, home: &Path, case: &Case, input: &[u8], now: u128) -> Out {
    let mut c = Command::new("node");
    c.arg(plugin().join("hooks").join(h.script)).args(h.argv).current_dir(std::env::temp_dir());
    base_env(&mut c, home, &case.env, now);
    run(c, input)
}

fn run_engine(h: Hook, home: &Path, case: &Case, input: &[u8], now: u128) -> Out {
    let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
    c.arg("check").arg(h.check).current_dir(std::env::temp_dir());
    base_env(&mut c, home, &case.env, now);
    c.env("AH_ENGINE_DIR", home.join("engine-state")).env("AH_ENGINE_PLUGIN_ROOT", plugin());
    run(c, input)
}

struct Tally {
    same: usize,
    deferred: usize,
    blocks: usize,
    stdout_nonempty: usize,
    state_changed: usize,
}

fn drive(name: &str, h: Hook, cases: Vec<Case>) -> Tally {
    let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let mut t = Tally { same: 0, deferred: 0, blocks: 0, stdout_nonempty: 0, state_changed: 0 };
    let mut names = std::collections::BTreeSet::new();
    for case in &cases {
        assert!(names.insert(case.name.clone()), "{name}: duplicate case {}", case.name);
        let now = now_ms();
        let (hn, he) = (temp_home(&format!("{name}-n")), temp_home(&format!("{name}-e")));
        seed_home(&hn, &case.seed, now);
        seed_home(&he, &case.seed, now);
        let seeded = norm_path_keys(snapshot(&he, now));
        let render = |home: &Path| -> Vec<u8> {
            match &case.input {
                Input::Json(v) => subst(&v.to_string(), home, now).into_bytes(),
                Input::Raw(s) => subst(s, home, now).into_bytes(),
            }
        };
        let node = run_node(h, &hn, case, &render(&hn), now);
        let eng = run_engine(h, &he, case, &render(&he), now);
        let after_n = norm_path_keys(snapshot(&hn, now));
        let after_e = norm_path_keys(snapshot(&he, now));
        let ctx = |what: &str| {
            format!(
                "{name}/{}: {what}\n node: {:?}\n  eng: {:?}",
                case.name,
                (node.0, String::from_utf8_lossy(&node.1), String::from_utf8_lossy(&node.2)),
                (eng.0, String::from_utf8_lossy(&eng.1), String::from_utf8_lossy(&eng.2))
            )
        };
        if case.defer {
            assert_eq!(
                (eng.0, String::from_utf8_lossy(&eng.1).to_string(), eng.2.clone()),
                (0, FALLBACK.to_string(), Vec::new()),
                "{}",
                ctx("the engine must defer")
            );
            assert_eq!(after_e, seeded, "{}", ctx("a deferral must leave the state as seeded"));
            t.deferred += 1;
        } else {
            assert_ne!(String::from_utf8_lossy(&eng.1), FALLBACK, "{}", ctx("the engine deferred but this case expects an answer"));
            assert_eq!(eng.0, node.0, "{}", ctx("exit code"));
            assert_eq!(eng.1, node.1, "{}", ctx("stdout bytes"));
            assert_eq!(eng.2, node.2, "{}", ctx("stderr bytes"));
            assert_eq!(after_e, after_n, "{}", ctx("state files"));
            t.same += 1;
            if node.0 == 2 {
                t.blocks += 1;
            }
            if !node.1.is_empty() {
                t.stdout_nonempty += 1;
            }
            if after_n != seeded {
                t.state_changed += 1;
            }
        }
    }
    eprintln!("{name}: same={} deferred={} blocks={} stdout_nonempty={} state_changed={}", t.same, t.deferred, t.blocks, t.stdout_nonempty, t.state_changed);
    t
}

// ------------------------------------------------------------------------------------------------------------------
// inbox-read-guard
// ------------------------------------------------------------------------------------------------------------------

const R: &str = "$HOME/.anti-hall/devswarm";

fn read(path: Value) -> Value {
    json!({"hook_event_name":"PreToolUse","tool_name":"Read","tool_input":{"file_path":path},"session_id":"s1","cwd":"$HOME/proj"})
}

fn ds(c: Case) -> Case {
    c.env("DEVSWARM_REPO_ID", "repo-1")
}

fn inbox_cases() -> Vec<Case> {
    let mut v: Vec<Case> = Vec::new();
    let long = format!("{R}/inbox/{}", "a".repeat(9000));
    for (name, p) in [
        ("inbox-file", format!("{R}/inbox/ws1.ndjson")),
        ("inbox-dir", format!("{R}/inbox")),
        ("inbox-dir-slash", format!("{R}/inbox/")),
        ("inbox-nested", format!("{R}/inbox/a/b/c.ndjson")),
        ("inbox-backslashes", format!("{R}/inbox\\x\\y")),
        ("inbox-unicode", format!("{R}/inbox/ü/日本.ndjson")),
        ("inbox-long", long),
        ("inbox-dotted-name", format!("{R}/inbox/.hidden")),
        ("inbox-spaces", format!("{R}/inbox/a b/c d")),
        ("inbox-many-slashes-tail", format!("{R}/inbox/x///")),
    ] {
        v.push(ds(case(name, read(json!(p)))));
    }
    for (name, p) in [
        ("allow-dot-segment", format!("{R}/./inbox/x")),
        ("allow-dotdot-segment", format!("{R}/x/../inbox/y")),
        ("allow-double-slash", format!("{R}//inbox/x")),
        ("allow-summary", format!("{R}/summary.json")),
        ("allow-cursors", format!("{R}/cursors/a.json")),
        ("allow-workspaces", format!("{R}/workspaces/x.json")),
        ("allow-liveness", format!("{R}/liveness/x.json")),
        ("allow-archive", format!("{R}/archive-1/inbox/x")),
        ("allow-root", R.to_string()),
        ("allow-root-slash", format!("{R}/")),
        ("allow-prefix-sibling", "$HOME/.anti-hall/devswarm-other/inbox/x".to_string()),
        ("allow-elsewhere", "$HOME/other/inbox/x".to_string()),
        ("allow-etc", "/etc/passwd".to_string()),
        ("allow-store-dir", format!("{R}/store")),
        ("allow-store-dir-slash", format!("{R}/store/")),
        ("allow-store-other-file", format!("{R}/store/repo-abc123/other.txt")),
        ("allow-store-nonhex-key", format!("{R}/store/abcdefgh/devswarm.db")),
        ("allow-store-uppercase-key", format!("{R}/store/UPPER-ABCDEF/devswarm.db")),
        ("allow-store-journal-txt", format!("{R}/store/journal/x.txt")),
        ("allow-store-journal-dir", format!("{R}/store/journal")),
        ("allow-store-db-suffix", format!("{R}/store/devswarm.db-extra")),
    ] {
        v.push(ds(case(name, read(json!(p)))));
    }
    for (name, p) in [
        ("store-flat-db", format!("{R}/store/devswarm.db")),
        ("store-flat-wal", format!("{R}/store/devswarm.db-wal")),
        ("store-flat-journal-file", format!("{R}/store/devswarm.db-journal")),
        ("store-flat-ndjson", format!("{R}/store/journal/x.ndjson")),
        ("store-mesh-db", format!("{R}/store/repo-abc123/devswarm.db")),
        ("store-mesh-shm", format!("{R}/store/anti-hall-0a1b2c/devswarm.db-shm")),
        ("store-mesh-ndjson", format!("{R}/store/repo-abc123/journal/2026.ndjson")),
        ("store-legacy-db", format!("{R}/store/12345678/devswarm.db")),
        ("store-legacy-ndjson", format!("{R}/store/ABCDEF12/journal/x.ndjson")),
    ] {
        v.push(ds(case(name, read(json!(p)))));
    }
    // relative paths and the working directory
    v.push(ds(case("rel-inbox-cwd-root", json!({"tool_name":"Read","tool_input":{"file_path":"inbox/x"},"cwd":R}))));
    v.push(ds(case("rel-from-home-no-cwd", json!({"tool_name":"Read","tool_input":{"file_path":".anti-hall/devswarm/inbox/x"}}))));
    v.push(ds(case("rel-dotdot-from-store", json!({"tool_name":"Read","tool_input":{"file_path":"../inbox/x"},"cwd":format!("{R}/store")}))));
    v.push(ds(case("rel-elsewhere", json!({"tool_name":"Read","tool_input":{"file_path":"x/y"},"cwd":"$HOME/proj"}))));
    v.push(ds(case("rel-relative-cwd", json!({"tool_name":"Read","tool_input":{"file_path":"inbox/x"},"cwd":"rel/dir"}))));
    v.push(ds(case("rel-numeric-cwd-uses-home", json!({"tool_name":"Read","tool_input":{"file_path":".anti-hall/devswarm/inbox/x"},"cwd":7}))));
    v.push(ds(case("rel-array-cwd-uses-home", json!({"tool_name":"Read","tool_input":{"file_path":".anti-hall/devswarm/inbox/x"},"cwd":["a"]}))));
    v.push(ds(case("rel-empty-cwd-uses-home", json!({"tool_name":"Read","tool_input":{"file_path":".anti-hall/devswarm/inbox/x"},"cwd":""}))));
    // payload shapes
    for (name, p) in [
        ("tool-write", json!({"tool_name":"Write","tool_input":{"file_path":format!("{R}/inbox/x")}})),
        ("tool-lowercase", json!({"tool_name":"read","tool_input":{"file_path":format!("{R}/inbox/x")}})),
        ("tool-missing", json!({"tool_input":{"file_path":format!("{R}/inbox/x")}})),
        ("tool-number", json!({"tool_name":5,"tool_input":{"file_path":format!("{R}/inbox/x")}})),
        ("input-missing", json!({"tool_name":"Read"})),
        ("input-null", json!({"tool_name":"Read","tool_input":null})),
        ("input-string", json!({"tool_name":"Read","tool_input":"inbox"})),
        ("input-number", json!({"tool_name":"Read","tool_input":7})),
        ("input-array", json!({"tool_name":"Read","tool_input":[format!("{R}/inbox/x")]})),
        ("path-number", json!({"tool_name":"Read","tool_input":{"file_path":5}})),
        ("path-null", json!({"tool_name":"Read","tool_input":{"file_path":null}})),
        ("path-array", json!({"tool_name":"Read","tool_input":{"file_path":[format!("{R}/inbox/x")]}})),
        ("path-object", json!({"tool_name":"Read","tool_input":{"file_path":{"a":1}}})),
        ("path-empty", json!({"tool_name":"Read","tool_input":{"file_path":""}})),
        ("path-other-key", json!({"tool_name":"Read","tool_input":{"path":format!("{R}/inbox/x")}})),
        ("payload-array", json!([1, 2])),
        ("payload-string", json!("Read")),
        ("payload-number", json!(42)),
        ("payload-null", Value::Null),
    ] {
        v.push(ds(case(name, p)));
    }
    v.push(ds(Case::raw("raw-garbage", "{not json")).defer());
    v.push(ds(Case::raw("raw-empty", "")).defer());
    // activation
    let blockable = || read(json!(format!("{R}/inbox/x")));
    v.push(case("inactive-no-repo-id", blockable()));
    v.push(case("inactive-blank-repo-id", blockable()).env("DEVSWARM_REPO_ID", "   "));
    v.push(case("active-kill-switch", blockable()).env("DEVSWARM_REPO_ID", "r").env("DISABLE_ANTIHALL_DEVSWARM", "1"));
    v.push(case("kill-switch-other-value", blockable()).env("DEVSWARM_REPO_ID", "r").env("DISABLE_ANTIHALL_DEVSWARM", "true"));
    v.push(case("supervisor-on-no-repo", blockable()).env("ANTIHALL_DEVSWARM_SUPERVISOR", "on"));
    v.push(case("supervisor-on-padded-upper", blockable()).env("ANTIHALL_DEVSWARM_SUPERVISOR", "  ON "));
    v.push(case("supervisor-off-with-repo", blockable()).env("DEVSWARM_REPO_ID", "r").env("ANTIHALL_DEVSWARM_SUPERVISOR", "off"));
    v.push(case("supervisor-padded-off", blockable()).env("DEVSWARM_REPO_ID", "r").env("ANTIHALL_DEVSWARM_SUPERVISOR", "  OFF  "));
    v.push(case("supervisor-junk-env-falls-through", blockable()).env("DEVSWARM_REPO_ID", "r").env("ANTIHALL_DEVSWARM_SUPERVISOR", "zzz"));
    v.push(case("supervisor-auto-env", blockable()).env("DEVSWARM_REPO_ID", "r").env("ANTIHALL_DEVSWARM_SUPERVISOR", "auto"));
    v.push(case("supervisor-file-off", blockable()).env("DEVSWARM_REPO_ID", "r").seed(Seed::Settings(json!({"devswarm":{"supervisorMode":"off"}}))));
    v.push(case("supervisor-file-on-padded", blockable()).seed(Seed::Settings(json!({"devswarm":{"supervisorMode":" On "}}))));
    v.push(
        case("supervisor-env-beats-file", blockable())
            .env("DEVSWARM_REPO_ID", "r")
            .env("ANTIHALL_DEVSWARM_SUPERVISOR", "on")
            .seed(Seed::Settings(json!({"devswarm":{"supervisorMode":"off"}}))),
    );
    v.push(case("supervisor-option-off", blockable()).env("DEVSWARM_REPO_ID", "r").env("CLAUDE_PLUGIN_OPTION_DEVSWARM_SUPERVISOR_MODE", "off"));
    v.push(case("supervisor-option-default-masked", blockable()).env("DEVSWARM_REPO_ID", "r").env("CLAUDE_PLUGIN_OPTION_DEVSWARM_SUPERVISOR_MODE", "auto"));
    v.push(
        case("supervisor-stored-option-off", blockable())
            .env("DEVSWARM_REPO_ID", "r")
            .seed(Seed::Claude(json!({"pluginConfigs":{"anti-hall":{"options":{"devswarm_supervisor_mode":"off"}}}}))),
    );
    v.push(
        case("supervisor-stored-flat-on", blockable()).seed(Seed::Claude(json!({"pluginConfigs":{"anti-hall@anti-hall":{"devswarm_supervisor_mode":"on"}}}))),
    );
    // the switch
    let on = |c: Case| c.env("DEVSWARM_REPO_ID", "r");
    v.push(on(case("switch-file-false", blockable())).seed(Seed::Settings(json!({"devswarm":{"inboxReadGuard":false}}))));
    v.push(on(case("switch-file-off-string", blockable())).seed(Seed::Settings(json!({"devswarm":{"inboxReadGuard":"off"}}))));
    v.push(on(case("switch-file-zero", blockable())).seed(Seed::Settings(json!({"devswarm":{"inboxReadGuard":0}}))));
    v.push(on(case("switch-file-garbage-ignored", blockable())).seed(Seed::Settings(json!({"devswarm":{"inboxReadGuard":"banana"}}))));
    v.push(on(case("switch-file-true", blockable())).seed(Seed::Settings(json!({"devswarm":{"inboxReadGuard":true}}))));
    v.push(on(case("switch-option-false", blockable())).env("CLAUDE_PLUGIN_OPTION_DEVSWARM_INBOX_READ_GUARD", "false"));
    v.push(on(case("switch-option-default-masked", blockable())).env("CLAUDE_PLUGIN_OPTION_DEVSWARM_INBOX_READ_GUARD", "true"));
    v.push(
        on(case("switch-stored-false", blockable())).seed(Seed::Claude(json!({"pluginConfigs":{"anti-hall":{"options":{"devswarm_inbox_read_guard":false}}}}))),
    );
    v.push(on(case("switch-settings-not-object", blockable())).file(".anti-hall/settings.json", "[1,2]"));
    v.push(on(case("switch-settings-corrupt", blockable())).file(".anti-hall/settings.json", "{oops"));
    v.push(on(case("switch-section-not-object", blockable())).seed(Seed::Settings(json!({"devswarm":"x"}))));
    // the skip file
    let far = 4_102_444_800_000u64;
    v.push(on(case("skip-named", blockable())).seed(Seed::Skip(json!({"devswarm-read-guard": far}))));
    v.push(on(case("skip-expired", blockable())).seed(Seed::Skip(json!({"devswarm-read-guard": 1000}))));
    v.push(on(case("skip-all-does-not-cover", blockable())).seed(Seed::Skip(json!({"all": far}))));
    v.push(on(case("skip-corrupt", blockable())).file(".anti-hall/skip.json", "{{"));
    v.push(on(case("skip-string-value", blockable())).seed(Seed::Skip(json!({"devswarm-read-guard": "9999999999999"}))));
    v.push(on(case("skip-other-guard", blockable())).seed(Seed::Skip(json!({"git-guard": far}))));
    v
}

#[test]
fn inbox_read_guard_matches_node() {
    let cases = inbox_cases();
    assert!(cases.len() >= 60, "the corpus must stay broad");
    let t = drive("inbox", INBOX, cases);
    assert!(t.blocks >= 15, "the corpus must exercise the block: {}", t.blocks);
    assert!(t.same >= 70 && t.deferred >= 2, "answered {} deferred {}", t.same, t.deferred);
}

// ------------------------------------------------------------------------------------------------------------------
// phase-tracker
// ------------------------------------------------------------------------------------------------------------------

fn spawn_payload(tool: &str, extra: Value) -> Value {
    let mut p = json!({"hook_event_name":"PreToolUse","tool_name":tool,"tool_input":{"description":"d","prompt":"p"}});
    for (k, v) in extra.as_object().unwrap() {
        p[k] = v.clone();
    }
    p
}

fn phase_cases() -> Vec<Case> {
    let mut v: Vec<Case> = Vec::new();
    // session tags
    for (name, sid) in [
        ("sid-plain", json!("abc123")),
        ("sid-padded", json!("  abc  ")),
        ("sid-symbols", json!("a/b\\c d.e")),
        ("sid-unicode", json!("ünï-çødé")),
        ("sid-only-symbols", json!("!!!")),
        ("sid-whitespace-only", json!("   ")),
        ("sid-empty", json!("")),
        ("sid-100-chars", json!("x".repeat(100))),
        ("sid-64-chars", json!("y".repeat(64))),
        ("sid-65-chars", json!("z".repeat(65))),
        ("sid-number", json!(12)),
        ("sid-null", Value::Null),
        ("sid-bool", json!(true)),
        ("sid-array", json!(["a"])),
        ("sid-nbsp-padded", json!("\u{a0}ab\u{a0}")),
        ("sid-newline", json!("a\nb")),
    ] {
        v.push(case(name, spawn_payload("Agent", json!({"session_id": sid}))));
    }
    // working-directory tags
    for (name, extra) in [
        ("cwd-string", json!({"cwd":"/some/dir"})),
        ("cwd-unicode", json!({"cwd":"/日本/ü dir"})),
        ("cwd-spaces-only", json!({"cwd":"   "})),
        ("cwd-empty-string", json!({"cwd":""})),
        ("cwd-zero", json!({"cwd":0})),
        ("cwd-false", json!({"cwd":false})),
        ("cwd-null", json!({"cwd":null})),
        ("cwd-empty-then-workspace", json!({"cwd":"","workspace":{"current_dir":"/w/dir"}})),
        ("workspace-only", json!({"workspace":{"current_dir":"/w/dir"}})),
        ("workspace-string", json!({"workspace":"x"})),
        ("workspace-no-dir", json!({"workspace":{}})),
        ("workspace-empty-dir", json!({"workspace":{"current_dir":""}})),
        ("cwd-wins-over-workspace", json!({"cwd":"/a","workspace":{"current_dir":"/b"}})),
        ("sid-blank-uses-cwd", json!({"session_id":"  ","cwd":"/a"})),
        ("sid-symbols-does-not-use-cwd", json!({"session_id":"@@","cwd":"/a"})),
        ("no-ids", json!({})),
    ] {
        v.push(case(name, spawn_payload("Agent", extra)));
    }
    for (name, extra) in [
        ("cwd-number-hashed", json!({"cwd":5})),
        ("cwd-true-hashed", json!({"cwd":true})),
        ("cwd-object-hashed", json!({"cwd":{"a":1}})),
        ("cwd-array-hashed", json!({"cwd":["a","b"]})),
        ("cwd-nested-array-hashed", json!({"cwd":[[1,2],[3]]})),
        ("cwd-float-hashed", json!({"cwd":1.5e21})),
        ("cwd-empty-array-hashed", json!({"cwd":[]})),
        ("workspace-dir-number-hashed", json!({"workspace":{"current_dir":9}})),
    ] {
        v.push(case(name, spawn_payload("Agent", extra)));
    }
    // payload shapes
    v.push(case("task-tool", spawn_payload("Task", json!({"session_id":"t1"}))));
    v.push(case("other-tool-still-records", json!({"tool_name":"Bash","session_id":"b1"})));
    v.push(case("payload-array", json!(["x"])));
    v.push(case("payload-string", json!("hello")));
    v.push(case("payload-number", json!(3)));
    v.push(case("payload-null", Value::Null));
    v.push(case("payload-huge", spawn_payload("Agent", json!({"session_id":"big","tool_input":{"prompt":"p".repeat(2_000_000)}}))));
    v.push(Case::raw("raw-garbage", "{nope").defer());
    v.push(Case::raw("raw-empty", "").defer());
    // the log and its retention
    let s = |sid: &str| spawn_payload("Agent", json!({"session_id": sid}));
    v.push(case("log-recent-and-old", s("n1")).file(".anti-hall/agent-spawns.log", "{NOW-100000} other\n{NOW-400000} stale\n{NOW-1000} mine\n"));
    v.push(case("log-legacy-no-tag", s("n2")).file(".anti-hall/agent-spawns.log", "{NOW-5000}\n{NOW-5000} t\n"));
    v.push(case("log-future-kept", s("n3")).file(".anti-hall/agent-spawns.log", "{NOW+1000000} future\n"));
    v.push(case("log-garbage-lines", s("n4")).file(".anti-hall/agent-spawns.log", "hello\n\n  \nabc 123\n{NOW-1000} ok\n"));
    v.push(case("log-crlf", s("n5")).file(".anti-hall/agent-spawns.log", "{NOW-1000} a\r\n{NOW-2000} b\r\n"));
    v.push(case("log-lone-cr-kept-in-line", s("n6")).file(".anti-hall/agent-spawns.log", "{NOW-1000} a\r{NOW-2000} b\n"));
    v.push(case("log-bom-first-line", s("n7")).file(".anti-hall/agent-spawns.log", "\u{feff}{NOW-1000} a\n{NOW-2000} b\n"));
    v.push(case("log-leading-spaces-line", s("n8")).file(".anti-hall/agent-spawns.log", "   {NOW-1000} a\n\t{NOW-2000} b\n"));
    v.push(case("log-nbsp-leading", s("n9")).file(".anti-hall/agent-spawns.log", "\u{a0}{NOW-1000} a\n"));
    v.push(case("log-digits-then-letters", s("n10")).file(".anti-hall/agent-spawns.log", "{NOW-1000}abc\n12abc\n"));
    v.push(case("log-negative-and-plus", s("n11")).file(".anti-hall/agent-spawns.log", "-5 x\n+{NOW-100} p\n-{NOW-100} q\n"));
    v.push(case("log-exponent-and-hex", s("n12")).file(".anti-hall/agent-spawns.log", "1e5 x\n0x10 y\n{NOW-10}.5 z\n"));
    v.push(case("log-huge-number-kept", s("n13")).file(".anti-hall/agent-spawns.log", "9999999999999999999999 x\n"));
    v.push(case("log-infinite-number-dropped", s("n14")).file(".anti-hall/agent-spawns.log", &format!("{} x\n", "9".repeat(400))));
    v.push(case("log-invalid-utf8", s("n15")).seed(Seed::File(".anti-hall/agent-spawns.log".into(), b"\xff\xfe junk\n".to_vec(), 0)));
    v.push(case("log-invalid-utf8-after-good", s("n16")).seed(Seed::File(".anti-hall/agent-spawns.log".into(), b"{NOW-1000} a\xc3\n".to_vec(), 0)));
    v.push(case("log-empty", s("n17")).file(".anti-hall/agent-spawns.log", ""));
    v.push(case("log-is-directory", s("n18")).seed(Seed::Dir(".anti-hall/agent-spawns.log".into())));
    v.push(
        case("log-is-symlink", s("n19"))
            .file("real.log", "{NOW-1000} a\n")
            .seed(Seed::Link(".anti-hall/agent-spawns.log".into(), "$HOME/real.log".into()))
            .defer(),
    ); // the script's scoped write refuses a link: Node writes through it
    v.push(case("state-root-is-file", s("n20")).file(".anti-hall", "x"));
    v.push(case("agents-dir-is-file", s("n21")).file(".anti-hall/agents", "x"));
    v.push(case("heartbeat-is-dir", s("n22")).seed(Seed::Dir(".anti-hall/agents/recent-spawn.json".into())));
    v.push(case("heartbeat-existing", s("n23")).file(".anti-hall/agents/recent-spawn.json", "{\"ts\":1}"));
    v.push(case("many-lines", s("n24")).file(".anti-hall/agent-spawns.log", &"{NOW-1000} s\n".repeat(500)));
    v
}

#[test]
fn phase_tracker_matches_node() {
    let cases = phase_cases();
    assert!(cases.len() >= 60, "the corpus must stay broad");
    let t = drive("phase", PHASE, cases);
    assert!(t.state_changed >= 40, "the corpus must exercise the writes: {}", t.state_changed);
    assert_eq!(t.blocks, 0);
    assert_eq!(t.stdout_nonempty, 0, "the tracker never prints");
    assert!(t.deferred >= 2, "deferred {}", t.deferred);
}

// ------------------------------------------------------------------------------------------------------------------
// orch-on-spawn
// ------------------------------------------------------------------------------------------------------------------

fn sanitized(sid: &str) -> String {
    let s: String = sid.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-').collect();
    if s.is_empty() { "unknown-session".into() } else { s }
}

fn marker_file(sid: &str) -> String {
    format!(".anti-hall/orch-full/orch-full-{}.json", sanitized(sid))
}

fn spawn_call(tool: &str, sid: Value) -> Value {
    json!({"hook_event_name":"PreToolUse","tool_name":tool,"session_id":sid,"transcript_path":"$HOME/t.jsonl","tool_input":{"prompt":"p"}})
}

const PENDING: &str = r#"{"epochId":"1700000000000","decision":"pending","sentAt":1700000000000}"#;
const SETTLED: &str = r#"{"epochId":"1700000000000","decision":"none","sentAt":1700000000000}"#;

fn spawn_cases() -> Vec<Case> {
    let mut v: Vec<Case> = Vec::new();
    let with = |sid: &str, body: &str| -> Case { case("x", spawn_call("Agent", json!(sid))).file(&marker_file(sid), body) };
    let named = |mut c: Case, n: &str| -> Case {
        c.name = n.into();
        c
    };
    // tools
    for tool in ["Agent", "Task", "Workflow", "spawn_agent", "collaborationspawn_agent"] {
        v.push(named(case("x", spawn_call(tool, json!("s1"))).file(&marker_file("s1"), PENDING), &format!("pending-{tool}")));
        v.push(named(case("x", spawn_call(tool, json!("s1"))).file(&marker_file("s1"), SETTLED), &format!("settled-{tool}")));
    }
    for tool in ["Bash", "Read", "agent", "Agent ", "collaborationwait_agent", "Spawn_Agent", ""] {
        v.push(named(case("x", spawn_call(tool, json!("s1"))).file(&marker_file("s1"), PENDING), &format!("not-a-spawn-{tool}")));
    }
    v.push(case("tool-missing-pending", json!({"session_id":"s1"})).file(&marker_file("s1"), PENDING));
    v.push(case("tool-number-pending", json!({"tool_name":5,"session_id":"s1"})).file(&marker_file("s1"), PENDING));
    v.push(case("tool-null-pending", json!({"tool_name":null,"session_id":"s1"})).file(&marker_file("s1"), PENDING));
    // sessions
    v.push(case("sid-missing", json!({"tool_name":"Agent"})).file(&marker_file("s1"), PENDING));
    v.push(case("sid-empty", json!({"tool_name":"Agent","session_id":""})).file(&marker_file(""), PENDING));
    v.push(case("sid-number", json!({"tool_name":"Agent","session_id":5})));
    v.push(case("sid-null", json!({"tool_name":"Agent","session_id":null})));
    v.push(named(with("a/b c", PENDING), "sid-sanitized-pending"));
    v.push(named(with("ünï", PENDING), "sid-unicode-sanitizes-to-unknown-pending"));
    v.push(named(with("!!!", PENDING), "sid-all-symbols-unknown-session"));
    v.push(named(with("a.b", SETTLED), "sid-dot-settled"));
    v.push(case("sid-only-in-other-marker", spawn_call("Agent", json!("s2"))).file(&marker_file("s1"), PENDING));
    // marker states
    v.push(case("marker-missing", spawn_call("Agent", json!("s1"))));
    v.push(case("marker-dir-missing", spawn_call("Agent", json!("s1"))).seed(Seed::Dir(".anti-hall".into())));
    for (name, body) in [
        ("marker-empty", ""),
        ("marker-garbage", "{oops"),
        ("marker-truncated", r#"{"epochId":"1700000000000","decision":"pend"#),
        ("marker-null", "null"),
        ("marker-array", "[]"),
        ("marker-epoch-number", r#"{"epochId":1700000000000,"decision":"pending","sentAt":1700000000000}"#),
        ("marker-epoch-empty", r#"{"epochId":"","decision":"pending","sentAt":1700000000000}"#),
        ("marker-decision-other", r#"{"epochId":"1","decision":"later","sentAt":1}"#),
        ("marker-decision-upper", r#"{"epochId":"1","decision":"PENDING","sentAt":1}"#),
        ("marker-sentat-string", r#"{"epochId":"1","decision":"pending","sentAt":"1"}"#),
        ("marker-sentat-missing", r#"{"epochId":"1","decision":"pending"}"#),
        ("marker-sentat-null", r#"{"epochId":"1","decision":"pending","sentAt":null}"#),
        ("marker-sentat-huge-exponent", r#"{"epochId":"1","decision":"pending","sentAt":1e999}"#),
        ("marker-extra-keys-pending-ok", r#"{"epochId":"1","decision":"pending","sentAt":1,"x":[1]}"#),
        ("marker-bom", "\u{feff}{\"epochId\":\"1\",\"decision\":\"pending\",\"sentAt\":1}"),
    ] {
        let c = case(name, spawn_call("Agent", json!("s1"))).file(&marker_file("s1"), body);
        v.push(if name == "marker-extra-keys-pending-ok" { c } else { c });
    }
    v.push(case("marker-is-directory", spawn_call("Agent", json!("s1"))).seed(Seed::Dir(marker_file("s1"))));
    v.push(
        case("marker-is-symlink-pending", spawn_call("Agent", json!("s1"))).file("m.json", PENDING).seed(Seed::Link(marker_file("s1"), "$HOME/m.json".into())),
    );
    v.push(case("marker-invalid-utf8", spawn_call("Agent", json!("s1"))).seed(Seed::File(marker_file("s1"), b"\xff\xfe".to_vec(), 0)));
    // subagent calls
    for (name, extra) in [
        ("subagent-id", json!({"agent_id":"a1"})),
        ("subagent-type", json!({"agent_type":"Explore"})),
        ("subagent-both", json!({"agent_id":"a1","agent_type":"x"})),
        ("subagent-empty-id", json!({"agent_id":""})),
        ("subagent-zero-id", json!({"agent_id":0})),
        ("subagent-false-type", json!({"agent_type":false})),
    ] {
        let mut p = spawn_call("Agent", json!("s1"));
        for (k, val) in extra.as_object().unwrap() {
            p[k] = val.clone();
        }
        v.push(case(name, p).file(&marker_file("s1"), PENDING));
    }
    for (name, extra) in [("subagent-null-id-is-main", json!({"agent_id":null})), ("subagent-null-both-is-main", json!({"agent_id":null,"agent_type":null}))] {
        let mut p = spawn_call("Agent", json!("s1"));
        for (k, val) in extra.as_object().unwrap() {
            p[k] = val.clone();
        }
        v.push(case(name, p).file(&marker_file("s1"), PENDING));
    }
    // switches
    let pend = |c: Case| c.file(&marker_file("s1"), PENDING);
    let call = || spawn_call("Agent", json!("s1"));
    v.push(pend(case("switch-off-file", call())).seed(Seed::Settings(json!({"context":{"verifyFirstOrchestration":false}}))));
    v.push(pend(case("switch-off-string", call())).seed(Seed::Settings(json!({"context":{"verifyFirstOrchestration":"no"}}))));
    v.push(pend(case("switch-on-file", call())).seed(Seed::Settings(json!({"context":{"verifyFirstOrchestration":true}}))));
    v.push(pend(case("switch-garbage-ignored", call())).seed(Seed::Settings(json!({"context":{"verifyFirstOrchestration":"maybe"}}))));
    v.push(pend(case("switch-option-false", call())).env("CLAUDE_PLUGIN_OPTION_CONTEXT_VERIFY_FIRST_ORCHESTRATION", "false"));
    v.push(pend(case("switch-option-default-masked", call())).env("CLAUDE_PLUGIN_OPTION_CONTEXT_VERIFY_FIRST_ORCHESTRATION", "true"));
    v.push(
        pend(case("switch-stored-false", call()))
            .seed(Seed::Claude(json!({"pluginConfigs":{"anti-hall":{"options":{"context_verify_first_orchestration":false}}}}))),
    );
    // the skip file
    let far = 4_102_444_800_000u64;
    v.push(pend(case("skip-named", call())).seed(Seed::Skip(json!({"orch-on-spawn": far}))));
    v.push(pend(case("skip-all", call())).seed(Seed::Skip(json!({"all": far}))));
    v.push(pend(case("skip-expired", call())).seed(Seed::Skip(json!({"orch-on-spawn": 5}))));
    v.push(pend(case("skip-other", call())).seed(Seed::Skip(json!({"git-guard": far}))));
    // the protocol level
    v.push(pend(case("level-full-env", call())).env("ANTIHALL_PROTOCOL_LEVEL", "full"));
    v.push(pend(case("level-full-env-padded", call())).env("ANTIHALL_PROTOCOL_LEVEL", " FULL "));
    v.push(pend(case("level-compact-env", call())).env("ANTIHALL_PROTOCOL_LEVEL", "compact"));
    v.push(pend(case("level-junk-env", call())).env("ANTIHALL_PROTOCOL_LEVEL", "huge"));
    v.push(pend(case("level-full-file", call())).seed(Seed::Settings(json!({"context":{"protocolLevel":"full"}}))));
    v.push(
        pend(case("level-env-beats-file", call())).env("ANTIHALL_PROTOCOL_LEVEL", "compact").seed(Seed::Settings(json!({"context":{"protocolLevel":"full"}}))),
    );
    // codex
    let mut cx = spawn_call("spawn_agent", json!("s1"));
    cx["turn_id"] = json!("t1");
    cx["model"] = json!("m");
    v.push(pend(case("codex-main-pending", cx.clone())));
    // the claim: the first spawn wins, a held claim keeps the others silent, the retry slot needs the transcript scan
    let claim = |n: u8| format!(".anti-hall/orch-full/orch-full-s1-1700000000000-claim{}.json", if n == 2 { "2" } else { "" });
    v.push(pend(case("claim-recent-silent", call())).file(&claim(1), "{\"at\":{NOW-1000},\"pid\":1}"));
    v.push(pend(case("claim-expired-defers", call())).file(&claim(1), "{\"at\":{NOW-300000},\"pid\":1}").defer());
    v.push(
        pend(case("claim-retry-slot-present-silent", call()))
            .file(&claim(1), "{\"at\":{NOW-300000},\"pid\":1}")
            .file(&claim(2), "{\"at\":{NOW-1000},\"pid\":1}"),
    );
    v.push(pend(case("claim-unreadable-recent-silent", call())).file(&claim(1), "zzz"));
    v.push(pend(case("claim-unreadable-old-defers", call())).aged(&claim(1), "zzz", 300_000).defer());
    v.push(pend(case("claim-at-string-recent-silent", call())).file(&claim(1), "{\"at\":\"x\"}"));
    v.push(pend(case("claim-is-directory-silent", call())).seed(Seed::Dir(claim(1))));
    v.push(pend(case("claim-future-silent", call())).file(&claim(1), "{\"at\":{NOW+1000000},\"pid\":1}"));
    v.push(pend(case("hook-event-echoed", {
        let mut p = call();
        p["hook_event_name"] = json!("PostToolUse");
        p
    })));
    v.push(pend(case("hook-event-number-not-echoed", {
        let mut p = call();
        p["hook_event_name"] = json!(5);
        p
    })));
    v.push(pend(case("hook-event-empty-not-echoed", {
        let mut p = call();
        p["hook_event_name"] = json!("");
        p
    })));
    v.push(case("epoch-with-odd-characters", call()).file(&marker_file("s1"), r#"{"epochId":"12/3 4-x_y","decision":"pending","sentAt":5}"#));
    v.push(case("epoch-all-symbols", call()).file(&marker_file("s1"), r#"{"epochId":"@@@","decision":"pending","sentAt":5}"#));
    v.push(
        case("codex-payload-by-rollout-path", {
            let mut p = call();
            p["transcript_path"] = json!("$HOME/.codex/sessions/rollout-1.jsonl");
            p
        })
        .file(&marker_file("s1"), PENDING),
    );
    let mut cs = cx.clone();
    cs["agent_id"] = json!("child");
    v.push(pend(case("codex-subagent", cs)));
    v.push(case("codex-no-marker", cx));
    v
}

#[test]
fn orch_on_spawn_matches_node() {
    let cases = spawn_cases();
    assert!(cases.len() >= 60, "the corpus must stay broad");
    let t = drive("spawn", SPAWN, cases);
    assert_eq!(t.blocks, 0);
    assert!(t.same >= 60, "answered {} deferred {}", t.same, t.deferred);
}

// ------------------------------------------------------------------------------------------------------------------
// verify-first-orch
// ------------------------------------------------------------------------------------------------------------------

fn start(extra: Value) -> Value {
    let mut p = json!({"hook_event_name":"SessionStart","source":"startup","session_id":"S1","transcript_path":"$HOME/.claude/projects/-p/S1.jsonl","cwd":"$HOME/proj","model":"m"});
    for (k, v) in extra.as_object().unwrap() {
        p[k] = v.clone();
    }
    p
}

fn projects() -> Seed {
    Seed::Dir(".claude/projects".into())
}

fn orch_cases() -> Vec<Case> {
    let mut v: Vec<Case> = Vec::new();
    let dflt = || start(json!({}));
    let ok = |c: Case| c.seed(projects());
    // platform and confidence under the default settings
    v.push(ok(case("claude-confident-default", dflt())));
    v.push(case("claude-confident-no-projects-dir", dflt()));
    v.push(ok(case("claude-transcript-exists", dflt())).file(".claude/projects/-p/S1.jsonl", "{}"));
    v.push(ok(case("claude-transcript-outside", start(json!({"transcript_path":"/tmp/elsewhere/S1.jsonl"})))));
    v.push(ok(case("claude-transcript-relative", start(json!({"transcript_path":"projects/S1.jsonl"})))));
    v.push(ok(case("claude-transcript-dotdot", start(json!({"transcript_path":"$HOME/.claude/projects/../x/S1.jsonl"})))));
    v.push(ok(case("claude-transcript-dot", start(json!({"transcript_path":"$HOME/.claude/projects/./x/S1.jsonl"})))));
    v.push(ok(case("claude-transcript-double-slash", start(json!({"transcript_path":"$HOME/.claude/projects//x/S1.jsonl"})))));
    v.push(ok(case("claude-transcript-trailing-slash", start(json!({"transcript_path":"$HOME/.claude/projects/x/"})))));
    v.push(ok(case("claude-transcript-is-projects-dir", start(json!({"transcript_path":"$HOME/.claude/projects"})))));
    v.push(ok(case("claude-transcript-root", start(json!({"transcript_path":"/"})))));
    v.push(ok(case("claude-transcript-missing", {
        let mut p = dflt();
        p.as_object_mut().unwrap().remove("transcript_path");
        p
    })));
    v.push(ok(case("claude-transcript-number", start(json!({"transcript_path":5})))));
    v.push(ok(case("claude-transcript-empty", start(json!({"transcript_path":""})))));
    v.push(ok(case("claude-session-missing", {
        let mut p = dflt();
        p.as_object_mut().unwrap().remove("session_id");
        p
    })));
    v.push(ok(case("claude-session-empty", start(json!({"session_id":""})))));
    v.push(ok(case("claude-session-number", start(json!({"session_id":7})))));
    v.push(ok(case("claude-session-weird-chars", start(json!({"session_id":"a/b ü!"})))));
    v.push(ok(case("claude-link-out-of-projects", dflt())).seed(Seed::Link(".claude/projects/-p".into(), "/tmp".into())));
    v.push(
        ok(case("claude-link-inside-projects", dflt()))
            .seed(Seed::Dir(".claude/projects/real".into()))
            .seed(Seed::Link(".claude/projects/-p".into(), "$HOME/.claude/projects/real".into())),
    );
    v.push(ok(case("claude-dangling-link", dflt())).seed(Seed::Link(".claude/projects/-p".into(), "$HOME/nowhere".into())));
    v.push(
        case("claude-projects-is-link", dflt())
            .seed(Seed::Dir("store/projects".into()))
            .seed(Seed::Link(".claude/projects".into(), "$HOME/store/projects".into()))
            .seed(Seed::Dir("x".into())),
    );
    v.push(
        case("claude-config-dir-env", start(json!({"transcript_path":"$HOME/cfg/projects/-p/S1.jsonl"})))
            .env("CLAUDE_CONFIG_DIR", "$HOME/cfg")
            .seed(Seed::Dir("cfg/projects".into())),
    );
    v.push(
        case("claude-config-dir-env-transcript-in-default", dflt())
            .env("CLAUDE_CONFIG_DIR", "$HOME/cfg")
            .seed(Seed::Dir("cfg/projects".into()))
            .seed(projects()),
    );
    v.push(case("claude-config-dir-relative-defers", dflt()).env("CLAUDE_CONFIG_DIR", "rel/cfg").seed(projects()).defer());
    v.push(ok(case("claude-config-dir-empty-uses-home", dflt())).env("CLAUDE_CONFIG_DIR", ""));
    // codex
    v.push(ok(case("codex-turn-id", start(json!({"turn_id":"t1"})))));
    v.push(ok(case("codex-turn-id-empty-is-claude", start(json!({"turn_id":""})))));
    v.push(ok(case("codex-turn-id-number-is-claude", start(json!({"turn_id":4})))));
    v.push(ok(case("codex-rollout-path", start(json!({"transcript_path":"$HOME/.codex/sessions/2026/rollout-abc.jsonl"})))));
    v.push(ok(case("codex-dot-codex-dir", start(json!({"transcript_path":"$HOME/.codex/x/y.jsonl"})))));
    v.push(ok(case("codex-rollout-backslash", start(json!({"transcript_path":"C:\\a\\rollout-1.jsonl"})))));
    v.push(ok(case("codex-rollout-prefix-only", start(json!({"transcript_path":"$HOME/rollout-1.txt"})))));
    v.push(ok(case("codex-turn-id-claude-path", start(json!({"turn_id":"t","transcript_path":"$HOME/.claude/projects/-p/S1.jsonl"})))));
    // payload shapes
    v.push(case("payload-empty-object", json!({})));
    v.push(case("payload-array", json!([])));
    v.push(case("payload-string", json!("x")));
    v.push(case("payload-number", json!(1)));
    v.push(case("payload-null", Value::Null));
    v.push(case("event-name-other", start(json!({"hook_event_name":"UserPromptSubmit"}))));
    v.push(Case::raw("raw-garbage-defers", "{nope").defer());
    v.push(Case::raw("raw-empty-defers", "").defer());
    // protocol level and delivery mode
    v.push(ok(case("level-full-env", dflt())).env("ANTIHALL_PROTOCOL_LEVEL", "full"));
    v.push(ok(case("level-full-codex", start(json!({"turn_id":"t"})))).env("ANTIHALL_PROTOCOL_LEVEL", "full"));
    v.push(ok(case("level-full-file", dflt())).seed(Seed::Settings(json!({"context":{"protocolLevel":"full"}}))));
    v.push(ok(case("level-junk", dflt())).env("ANTIHALL_PROTOCOL_LEVEL", "wide"));
    v.push(ok(case("mode-session", dflt())).env("ANTIHALL_ORCH_FULL_ON", "session"));
    v.push(ok(case("mode-auto", dflt())).env("ANTIHALL_ORCH_FULL_ON", "auto"));
    v.push(ok(case("mode-off", dflt())).env("ANTIHALL_ORCH_FULL_ON", "off"));
    v.push(ok(case("mode-off-codex", start(json!({"turn_id":"t"})))).env("ANTIHALL_ORCH_FULL_ON", "off"));
    v.push(ok(case("mode-spawn", dflt())).env("ANTIHALL_ORCH_FULL_ON", "spawn"));
    v.push(ok(case("mode-spawn-padded-upper", dflt())).env("ANTIHALL_ORCH_FULL_ON", " SPAWN "));
    v.push(case("mode-spawn-not-confident", dflt()).env("ANTIHALL_ORCH_FULL_ON", "spawn"));
    v.push(ok(case("mode-spawn-skipped", dflt())).env("ANTIHALL_ORCH_FULL_ON", "spawn").seed(Seed::Skip(json!({"orch-on-spawn": 4_102_444_800_000u64}))));
    v.push(ok(case("mode-spawn-skip-all", dflt())).env("ANTIHALL_ORCH_FULL_ON", "spawn").seed(Seed::Skip(json!({"all": 4_102_444_800_000u64}))));
    v.push(ok(case("mode-spawn-skip-expired", dflt())).env("ANTIHALL_ORCH_FULL_ON", "spawn").seed(Seed::Skip(json!({"orch-on-spawn": 5}))));
    v.push(ok(case("mode-spawn-file", dflt())).seed(Seed::Settings(json!({"context":{"orchFullOn":"spawn"}}))));
    v.push(ok(case("mode-spawn-level-full", dflt())).env("ANTIHALL_ORCH_FULL_ON", "spawn").env("ANTIHALL_PROTOCOL_LEVEL", "full"));
    v.push(ok(case("mode-spawn-marker-unwritable", dflt())).env("ANTIHALL_ORCH_FULL_ON", "spawn").file(".anti-hall/orch-full", "i am a file"));
    v.push(ok(case("codex-spawn-optin", start(json!({"turn_id":"t"})))).env("ANTIHALL_CODEX_ORCH_FULL_ON", "spawn"));
    v.push(ok(case("codex-spawn-optin-no-session", start(json!({"turn_id":"t","session_id":""})))).env("ANTIHALL_CODEX_ORCH_FULL_ON", "spawn"));
    v.push(
        ok(case("codex-spawn-optin-off-mode", start(json!({"turn_id":"t"})))).env("ANTIHALL_CODEX_ORCH_FULL_ON", "spawn").env("ANTIHALL_ORCH_FULL_ON", "off"),
    );
    v.push(
        ok(case("codex-spawn-optin-skipped", start(json!({"turn_id":"t"}))))
            .env("ANTIHALL_CODEX_ORCH_FULL_ON", "spawn")
            .seed(Seed::Skip(json!({"orch-on-spawn": 4_102_444_800_000u64}))),
    );
    v.push(
        ok(case("codex-rollout-spawn-optin", start(json!({"transcript_path":"$HOME/.codex/s/rollout-1.jsonl"})))).env("ANTIHALL_CODEX_ORCH_FULL_ON", "spawn"),
    );
    v.push(ok(case("claude-ignores-codex-optin", dflt())).env("ANTIHALL_CODEX_ORCH_FULL_ON", "spawn"));
    // the switch and the marker it keeps
    let setting_off = Seed::Settings(json!({"context":{"verifyFirstOrchestration":false}}));
    v.push(ok(case("switch-off-confident-writes-none", dflt())).seed(setting_off.clone()));
    v.push(case("switch-off-not-confident-no-marker", dflt()).seed(setting_off.clone()));
    v.push(case("switch-off-not-confident-pending-cleared", dflt()).seed(setting_off.clone()).file(&marker_file("S1"), PENDING));
    v.push(case("switch-off-not-confident-bad-marker-kept", dflt()).seed(setting_off.clone()).file(&marker_file("S1"), "{oops"));
    v.push(ok(case("switch-off-codex", start(json!({"turn_id":"t"})))).seed(setting_off));
    v.push(ok(case("switch-option-false", dflt())).env("CLAUDE_PLUGIN_OPTION_CONTEXT_VERIFY_FIRST_ORCHESTRATION", "false"));
    v.push(ok(case("pending-marker-overwritten", dflt())).file(&marker_file("S1"), PENDING));
    v.push(case("pending-marker-not-confident-overwritten", dflt()).file(&marker_file("S1"), PENDING));
    v.push(case("pending-marker-other-session-untouched", dflt()).file(&marker_file("other"), PENDING));
    v.push(ok(case("marker-for-sanitized-session", start(json!({"session_id":"a/b ü!"})))).env("ANTIHALL_ORCH_FULL_ON", "spawn"));
    v.push(ok(case("marker-unknown-session", start(json!({"session_id":"!!!"})))));
    // pruning
    let old = 10 * 24 * 3600 * 1000;
    let fresh = 3600 * 1000;
    v.push(ok(case("prune-removes-stale-claims", dflt())).aged(".anti-hall/orch-full/orch-full-old-1-claim.json", "{}", old).aged(
        ".anti-hall/orch-full/orch-full-new-1-claim.json",
        "{}",
        fresh,
    ));
    v.push(
        ok(case("prune-keeps-non-prefixed", dflt()))
            .aged(".anti-hall/orch-full/other.json", "{}", old)
            .aged(".anti-hall/orch-full/orch-full-x.txt", "{}", old)
            .aged(".anti-hall/orch-full/orch-full-y.json", "{}", old),
    );
    v.push(
        ok(case("prune-throttled-by-stamp", dflt()))
            .aged(".anti-hall/orch-full/orch-full-old.json", "{}", old)
            .file(".anti-hall/orch-full/.prune-stamp-orch-full.json", "{\"lastSweep\":{NOW-1000}}"),
    );
    v.push(
        ok(case("prune-stamp-old-sweeps", dflt()))
            .aged(".anti-hall/orch-full/orch-full-old.json", "{}", old)
            .file(".anti-hall/orch-full/.prune-stamp-orch-full.json", "{\"lastSweep\":1000}"),
    );
    v.push(
        ok(case("prune-stamp-future-sweeps", dflt()))
            .aged(".anti-hall/orch-full/orch-full-old.json", "{}", old)
            .file(".anti-hall/orch-full/.prune-stamp-orch-full.json", "{\"lastSweep\":{NOW+100000}}"),
    );
    v.push(
        ok(case("prune-stamp-corrupt-sweeps", dflt()))
            .aged(".anti-hall/orch-full/orch-full-old.json", "{}", old)
            .file(".anti-hall/orch-full/.prune-stamp-orch-full.json", "{oops"),
    );
    v.push(
        ok(case("prune-stamp-wrong-type-sweeps", dflt()))
            .aged(".anti-hall/orch-full/orch-full-old.json", "{}", old)
            .file(".anti-hall/orch-full/.prune-stamp-orch-full.json", "{\"lastSweep\":\"{NOW-5}\"}"),
    );
    v.push(
        ok(case("prune-stamp-empty-sweeps", dflt()))
            .aged(".anti-hall/orch-full/orch-full-old.json", "{}", old)
            .file(".anti-hall/orch-full/.prune-stamp-orch-full.json", "  \n"),
    );
    v.push(ok(case("prune-own-marker-kept-even-if-old", dflt())).aged(&marker_file("S1"), PENDING, old));
    v.push(ok(case("prune-subdir-ignored", dflt())).seed(Seed::Dir(".anti-hall/orch-full/orch-full-dir.json".into())).aged(
        ".anti-hall/orch-full/orch-full-old.json",
        "{}",
        old,
    ));
    // DevSwarm sessions defer to Node
    v.push(ok(case("devswarm-repo-id-defers", dflt())).env("DEVSWARM_REPO_ID", "r").defer());
    v.push(ok(case("devswarm-supervisor-on-defers", dflt())).env("ANTIHALL_DEVSWARM_SUPERVISOR", "on").defer());
    v.push(ok(case("devswarm-kill-switch-proceeds", dflt())).env("DEVSWARM_REPO_ID", "r").env("DISABLE_ANTIHALL_DEVSWARM", "1"));
    v.push(ok(case("devswarm-supervisor-off-proceeds", dflt())).env("DEVSWARM_REPO_ID", "r").env("ANTIHALL_DEVSWARM_SUPERVISOR", "off"));
    v.push(ok(case("devswarm-blank-repo-proceeds", dflt())).env("DEVSWARM_REPO_ID", " "));
    v.push(
        ok(case("devswarm-switch-off-no-defer", dflt()))
            .env("DEVSWARM_REPO_ID", "r")
            .seed(Seed::Settings(json!({"context":{"verifyFirstOrchestration":false}}))),
    );
    v.push(ok(case("devswarm-codex-defers", start(json!({"turn_id":"t"})))).env("DEVSWARM_REPO_ID", "r").defer());
    // the judge child
    v.push(ok(case("judge-child-silent", dflt())).env("ANTIHALL_JUDGE_CHILD", "1"));
    v.push(ok(case("judge-child-other-value", dflt())).env("ANTIHALL_JUDGE_CHILD", "yes"));
    v
}

#[test]
fn verify_first_orch_matches_node() {
    let cases = orch_cases();
    assert!(cases.len() >= 90, "the corpus must stay broad");
    let t = drive("orch", ORCH, cases);
    assert_eq!(t.blocks, 0);
    assert!(t.stdout_nonempty >= 70, "the corpus must exercise the emitted texts: {}", t.stdout_nonempty);
    assert!(t.state_changed >= 30, "the corpus must exercise the marker: {}", t.state_changed);
    assert!(t.deferred >= 6, "deferred {}", t.deferred);
}

/// The Codex entry runs the same corpus. Without the flag no session is Claude-confident, so the cases that defer on the
/// host's config directory now answer; a DevSwarm session and an unreadable payload still defer.
#[test]
fn verify_first_orch_codex_matches_node() {
    let always_defers = ["devswarm-repo-id-defers", "devswarm-supervisor-on-defers", "devswarm-codex-defers", "raw-garbage-defers", "raw-empty-defers"];
    let cases: Vec<Case> = orch_cases()
        .into_iter()
        .map(|mut c| {
            c.defer = always_defers.contains(&c.name.as_str());
            c
        })
        .collect();
    assert!(cases.len() >= 90, "the corpus must stay broad");
    let t = drive("orch-codex", ORCH_CODEX, cases);
    assert_eq!(t.blocks, 0);
    assert!(t.stdout_nonempty >= 70, "the corpus must exercise the emitted texts: {}", t.stdout_nonempty);
    assert!(t.state_changed >= 5, "the corpus must exercise the marker: {}", t.state_changed);
    assert_eq!(t.deferred, always_defers.len(), "deferred {}", t.deferred);
}

// ------------------------------------------------------------------------------------------------------------------
// the settings the checks read
// ------------------------------------------------------------------------------------------------------------------

/// The shipped switch tables must say what `settings-schema.js` says (section, key, env name, default, allowed words, the
/// plugin option), and the supervisor mode's manifest default must be the default the table uses.
#[test]
fn the_switch_tables_match_the_node_settings_schema() {
    let script = r#"
const s = require(process.argv[1] + '/hooks/lib/settings-schema.js');
const pj = require(process.argv[1] + '/.claude-plugin/plugin.json');
const rows = [['devswarm','inboxReadGuard'],['devswarm','supervisorMode'],['context','verifyFirstOrchestration'],['context','protocolLevel'],['context','orchFullOn'],['context','codexOrchFullOn']];
const out = rows.map(([a,b]) => { const e = s.findSetting(a,b); return { section: a, key: b, type: e.type, env: e.env || '', aliases: e.envAliases || [], option: e.pluginOption || '', default: e.default, values: e.values || null, legacy: !!e.legacy, homeOnly: !!e.homeOnly, headline: !!e.headline }; });
const sup = pj.userConfig.devswarm_supervisor_mode.default;
console.log(JSON.stringify({ rows: out, manifestSupervisorDefault: sup }));
"#;
    let o = Command::new("node").arg("-e").arg(script).arg(plugin()).output().unwrap();
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    let node: Value = serde_json::from_slice(&o.stdout).unwrap();
    let keys = [
        "inbox_read.setting",
        "spawn_ctx.supervisor_setting",
        "orch_state.setting",
        "orch_state.protocol_setting",
        "orch_state.orch_full_on_setting",
        "orch_state.codex_orch_full_on_setting",
    ];
    for (row, key) in node["rows"].as_array().unwrap().iter().zip(keys) {
        let ours = ah_engine::defaults::raw(key).to_json();
        for f in ["section", "key", "env", "option", "default"] {
            assert_eq!(ours[f], row[f], "{key}.{f}");
        }
        assert_eq!(ours["aliases"], row["aliases"], "{key}.aliases");
        if row["type"] == "enum" {
            assert_eq!(ours["values"], row["values"], "{key}.values");
        }
        assert_eq!(
            (row["legacy"].as_bool(), row["homeOnly"].as_bool()),
            (Some(false), Some(false)),
            "{key}: a legacy or home-only entry has a different chain"
        );
    }
    assert_eq!(
        node["manifestSupervisorDefault"],
        ah_engine::defaults::raw("spawn_ctx.supervisor_setting").to_json()["default"],
        "the manifest default of the headline option"
    );
}

/// The skip name the inbox guard honours is one a broad skip does not cover (`skip-guard.js` DESTRUCTIVE).
#[test]
fn the_inbox_skip_name_is_a_destructive_guard_in_node_too() {
    let o = Command::new("node")
        .arg("-e")
        .arg("console.log(JSON.stringify([...require(process.argv[1]+'/hooks/skip-guard.js').DESTRUCTIVE]))")
        .arg(plugin())
        .output()
        .unwrap();
    let node: Vec<String> = serde_json::from_slice(&o.stdout).unwrap();
    let g = "devswarm-read-guard";
    assert!(node.iter().any(|n| n == g) && ah_engine::defaults::list("guardkit.destructive_guards").contains(&g), "{g}");
}
