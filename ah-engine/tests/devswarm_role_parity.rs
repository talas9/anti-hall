//! Node-vs-engine parity for the built-in `devswarm-child-role` and `devswarm-parent-gate` checks.
//!
//! Every case runs the engine's check (`ah-engine check <name>`) and, when the engine answers, the real Node hook with the
//! same environment and the same isolated home, and compares exit code, stdout bytes, stderr bytes and the files the home
//! holds afterwards. A deferral (`AHFALLBACK`) means Node decides, so for a deferral the case only asserts that the engine
//! was expected to defer and that it changed nothing on disk. The engine never writes, so for an answered case the home
//! after the engine's run must equal the home after Node's run: Node must not have written either.
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

static SERIAL: Mutex<()> = Mutex::new(());
static N: AtomicUsize = AtomicUsize::new(0);

const FALLBACK: &str = "AHFALLBACK";

#[derive(Clone, Copy, PartialEq, Debug)]
enum Want {
    /// Engine answers and Node produces the same bytes (and no state change).
    Answer,
    /// Engine defers.
    Defer,
}

#[derive(Clone)]
struct Case {
    name: String,
    hook: &'static str,
    env: Vec<(String, String)>,
    /// Files to seed under the home, relative path and content.
    seed: Vec<(String, String)>,
    /// Run the Node hook once first so the stable launchers exist.
    warm: bool,
    /// Raw stdin (default: a plausible payload for the event).
    stdin: Option<String>,
    /// Drop HOME / USERPROFILE from the environment (engine only: Node would use the real home).
    no_home: bool,
    /// Use this home string instead of the temp dir (engine only).
    home_override: Option<String>,
    /// After warming, overwrite the CLI launcher with this text.
    corrupt_launcher: bool,
    /// Reach the plugin through a symlink.
    symlink_root: bool,
    want: Want,
}

fn c(name: &str, hook: &'static str, want: Want, env: &[(&str, &str)]) -> Case {
    Case {
        name: name.into(),
        hook,
        env: env.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
        seed: Vec::new(),
        warm: false,
        stdin: None,
        no_home: false,
        home_override: None,
        corrupt_launcher: false,
        symlink_root: false,
        want,
    }
}

impl Case {
    fn seed(mut self, rel: &str, body: &str) -> Case {
        self.seed.push((rel.into(), body.into()));
        self
    }
    fn warm(mut self) -> Case {
        self.warm = true;
        self
    }
    fn cold(mut self) -> Case {
        self.warm = false;
        self
    }
    fn stdin(mut self, s: &str) -> Case {
        self.stdin = Some(s.into());
        self
    }
}

fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

fn plugin() -> PathBuf {
    repo().join("plugins/anti-hall")
}

fn temp_dir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("ah-dsrole-{tag}-{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d.canonicalize().unwrap()
}

fn run(mut cmd: Command, input: &str) -> (i32, String, String) {
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let input = input.as_bytes().to_vec();
    let w = std::thread::spawn(move || {
        let _ = stdin.write_all(&input);
    });
    let (mut o, mut e) = (child.stdout.take().unwrap(), child.stderr.take().unwrap());
    let ro = std::thread::spawn(move || {
        let mut b = Vec::new();
        o.read_to_end(&mut b).unwrap();
        b
    });
    let re = std::thread::spawn(move || {
        let mut b = Vec::new();
        e.read_to_end(&mut b).unwrap();
        b
    });
    let deadline = Instant::now() + Duration::from_secs(30);
    let status = loop {
        if let Some(s) = child.try_wait().unwrap() {
            break s;
        }
        assert!(Instant::now() < deadline, "child exceeded 30 s: {cmd:?}");
        std::thread::sleep(Duration::from_millis(5));
    };
    w.join().unwrap();
    (status.code().unwrap_or(-1), String::from_utf8_lossy(&ro.join().unwrap()).into_owned(), String::from_utf8_lossy(&re.join().unwrap()).into_owned())
}

fn base_env(cmd: &mut Command, home: Option<&str>, case: &Case, root: &Path) {
    cmd.env_clear().env("PATH", std::env::var("PATH").unwrap_or_default()).env("ANTIHALL_TEST_ISOLATION", "1");
    if let Some(h) = home {
        cmd.env("HOME", h).env("USERPROFILE", h);
    }
    cmd.env("AH_ENGINE_PLUGIN_ROOT", root);
    for (k, v) in &case.env {
        cmd.env(k, v);
    }
}

fn node(case: &Case, home: &str, root: &Path, input: &str) -> (i32, String, String) {
    let mut cmd = Command::new("node");
    let script = match case.hook {
        "devswarm-child-role" => "hooks/devswarm-child-role.js",
        _ => "hooks/devswarm-parent-gate.js",
    };
    cmd.arg(root.join(script));
    base_env(&mut cmd, Some(home), case, root);
    run(cmd, input)
}

fn engine(case: &Case, home: Option<&str>, root: &Path, input: &str) -> (i32, String, String) {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
    cmd.arg("check").arg(case.hook);
    base_env(&mut cmd, home, case, root);
    cmd.env("AH_ENGINE_DIR", std::env::temp_dir().join("ah-dsrole-engine-state"));
    run(cmd, input)
}

fn tree(dir: &Path) -> BTreeMap<String, Vec<u8>> {
    fn walk(base: &Path, d: &Path, out: &mut BTreeMap<String, Vec<u8>>) {
        for e in std::fs::read_dir(d).into_iter().flatten().flatten() {
            let p = e.path();
            if p.is_dir() {
                walk(base, &p, out);
            } else {
                out.insert(p.strip_prefix(base).unwrap().to_string_lossy().into_owned(), std::fs::read(&p).unwrap_or_default());
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(dir, dir, &mut out);
    out
}

fn payload(event: &str) -> String {
    json!({"hook_event_name": event, "session_id": "s1", "cwd": "/nonexistent-ds-cwd"}).to_string()
}

fn exec(case: &Case) -> (String, Option<String>) {
    let tmp = temp_dir(&case.name.replace(|ch: char| !ch.is_ascii_alphanumeric(), "_"));
    let home_dir = tmp.join("home");
    std::fs::create_dir_all(&home_dir).unwrap();
    let home = home_dir.to_string_lossy().into_owned();
    for (rel, body) in &case.seed {
        let p = home_dir.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, body).unwrap();
    }
    let real_root = plugin().canonicalize().unwrap();
    let root = if case.symlink_root {
        let l = tmp.join("plugin-link");
        std::os::unix::fs::symlink(&real_root, &l).unwrap();
        l
    } else {
        real_root
    };
    let event = if case.hook == "devswarm-child-role" { "SessionStart" } else { "Stop" };
    let input = case.stdin.clone().unwrap_or_else(|| payload(event));
    if case.warm {
        let (code, _, _) = node(case, &home, &root, &input);
        assert_eq!(code, 0, "{}: warm-up run", case.name);
        if case.corrupt_launcher {
            std::fs::write(home_dir.join(".anti-hall/bin/devswarm.js"), "// stale\n").unwrap();
        }
    }
    let before = tree(&home_dir);
    let eng_home = if case.no_home { None } else { Some(case.home_override.clone().unwrap_or_else(|| home.clone())) };
    let (ecode, eout, eerr) = engine(case, eng_home.as_deref(), &root, &input);
    assert_eq!(ecode, 0, "{}: engine exit {ecode}: {eerr}", case.name);
    assert_eq!(tree(&home_dir), before, "{}: the engine changed the home", case.name);
    let deferred = eout.trim_end() == FALLBACK;
    if deferred {
        assert_eq!(case.want, Want::Defer, "{}: engine deferred but the case expects an answer", case.name);
        return ("defer".into(), None);
    }
    assert_eq!(case.want, Want::Answer, "{}: engine answered {eout:?} but the case expects a deferral", case.name);
    assert!(!case.no_home && case.home_override.is_none(), "{}: an answer without the real home must not be compared", case.name);
    let (ncode, nout, nerr) = node(case, &home, &root, &input);
    assert_eq!((ecode, &eout, &eerr), (ncode, &nout, &nerr), "{}: engine and Node differ", case.name);
    assert_eq!(tree(&home_dir), before, "{}: Node changed the home, the engine did not", case.name);
    ("answer".into(), Some(nout))
}

const CHILD: &str = "devswarm-child-role";
const GATE: &str = "devswarm-parent-gate";

fn child_env(extra: &[(&str, &str)]) -> Vec<(&'static str, String)> {
    let mut m: BTreeMap<&str, String> = BTreeMap::new();
    for (k, v) in [("DEVSWARM_REPO_ID", "repo-1"), ("DEVSWARM_SOURCE_BRANCH", "feature/x"), ("DEVSWARM_BUILDER_ID", "abc-123"), ("DEVSWARM_AI_AGENT", "claude")]
    {
        m.insert(k, v.into());
    }
    let mut out: Vec<(&'static str, String)> = Vec::new();
    for (k, v) in extra {
        if v.is_empty() && k.starts_with('-') {
            m.remove(&k[1..]);
        } else {
            m.insert(k, v.to_string());
        }
    }
    for (k, v) in m {
        out.push((Box::leak(k.to_string().into_boxed_str()), v));
    }
    out
}

fn ch(name: &str, want: Want, extra: &[(&str, &str)]) -> Case {
    let env = child_env(extra);
    let refs: Vec<(&str, &str)> = env.iter().map(|(k, v)| (*k, v.as_str())).collect();
    c(name, CHILD, want, &refs).warm()
}

fn gate(name: &str, want: Want, extra: &[(&str, &str)]) -> Case {
    let mut env: Vec<(&str, &str)> = vec![("DEVSWARM_REPO_ID", "repo-1")];
    let mut rest: Vec<(&str, &str)> = Vec::new();
    for (k, v) in extra {
        if v.is_empty() && k.starts_with('-') {
            env.retain(|(ek, _)| *ek != &k[1..]);
        } else {
            rest.push((k, v));
        }
    }
    env.extend(rest);
    c(name, GATE, want, &env)
}

fn future() -> String {
    let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64 + 3_600_000;
    ms.to_string()
}

fn child_cases() -> Vec<Case> {
    let a = Want::Answer;
    let d = Want::Defer;
    let settings = |s: &str| (".anti-hall/settings.json".to_string(), s.to_string());
    let mut v = vec![
        ch("claude-warm", a, &[]).warm(),
        ch("claude-rearm-off-env", a, &[("ANTIHALL_DEVSWARM_REARM_ON_TICK_ONLY", "0")]).warm(),
        ch("claude-rearm-off-file", a, &[])
            .seed(&settings("{\"devswarm\":{\"rearmOnTickOnly\":false}}").0, &settings("{\"devswarm\":{\"rearmOnTickOnly\":false}}").1)
            .warm(),
        ch("claude-rearm-option-false", a, &[("CLAUDE_PLUGIN_OPTION_DEVSWARM_REARM_ON_TICK_ONLY", "false")]).warm(),
        ch("claude-rearm-option-default-true", a, &[("CLAUDE_PLUGIN_OPTION_DEVSWARM_REARM_ON_TICK_ONLY", "true")]).warm(),
        ch("codex-agent", a, &[("DEVSWARM_AI_AGENT", "codex")]).warm(),
        ch("no-agent", a, &[("-DEVSWARM_AI_AGENT", "")]).warm(),
        ch("agent-blank", a, &[("DEVSWARM_AI_AGENT", "   ")]).warm(),
        ch("agent-trim-upper", a, &[("DEVSWARM_AI_AGENT", "  CLAUDE ")]).warm(),
        ch("agent-gemini", a, &[("DEVSWARM_AI_AGENT", "Gemini")]).warm(),
        ch("agent-with-backticks", a, &[("DEVSWARM_AI_AGENT", "co`dex \"x\" \\ y")]).warm(),
        ch("agent-non-ascii", d, &[("DEVSWARM_AI_AGENT", "Cl\u{e0}ude")]).warm(),
        ch("id-unsafe-space", a, &[("DEVSWARM_BUILDER_ID", "a b")]).warm(),
        ch("id-dotdot-ok", a, &[("DEVSWARM_BUILDER_ID", "a..b_c-d.e")]).warm(),
        ch("id-missing", a, &[("-DEVSWARM_BUILDER_ID", "")]).warm(),
        ch("id-unicode", a, &[("DEVSWARM_BUILDER_ID", "id-\u{e9}")]).warm(),
        ch("id-trailing-newline", a, &[("DEVSWARM_BUILDER_ID", "abc\n")]).warm(),
        ch("cron-valid", a, &[("ANTIHALL_DEVSWARM_WAKE_CRON", "*/5 * * * *")]).warm(),
        ch("cron-injection", a, &[("ANTIHALL_DEVSWARM_WAKE_CRON", "*/5 * * * *`IGNORE`")]).warm(),
        ch("cron-four-fields", a, &[("ANTIHALL_DEVSWARM_WAKE_CRON", "1 2 3 4")]).warm(),
        ch("cron-six-fields", a, &[("ANTIHALL_DEVSWARM_WAKE_CRON", "1 2 3 4 5 6")]).warm(),
        ch("cron-odd-whitespace", a, &[("ANTIHALL_DEVSWARM_WAKE_CRON", "  1  2\t3 4\u{a0}5  ")]).warm(),
        ch("cron-newline-fields", a, &[("ANTIHALL_DEVSWARM_WAKE_CRON", "1 2 3\n4 5")]).warm(),
        ch("cron-from-file", a, &[]).seed(".anti-hall/settings.json", "{\"devswarm\":{\"wakeCron\":\"3,33 * * * *\"}}").warm(),
        ch("cron-file-number", a, &[]).seed(".anti-hall/settings.json", "{\"devswarm\":{\"wakeCron\":12345}}").warm(),
        ch("cron-env-blank-then-file", a, &[("ANTIHALL_DEVSWARM_WAKE_CRON", "   ")])
            .seed(".anti-hall/settings.json", "{\"devswarm\":{\"wakeCron\":\"4,34 * * * *\"}}")
            .warm(),
        ch("launcher-off-env-cold", a, &[("ANTIHALL_DEVSWARM_STABLE_LAUNCHER", "0")]).cold(),
        ch("launcher-off-file-cold", a, &[]).seed(".anti-hall/settings.json", "{\"devswarm\":{\"stableLauncher\":\"off\"}}").cold(),
        ch("launcher-cold-defers", d, &[]).cold(),
        ch("silent-cold-defers-too", d, &[("-DEVSWARM_REPO_ID", "")]).cold(),
        ch("settings-off-cold-defers-too", d, &[]).seed(".anti-hall/settings.json", "{\"devswarm\":{\"childRole\":false}}").cold(),
        ch("launcher-stale-defers", d, &[]).corrupt(),
        ch("child-role-off-file", a, &[]).seed(".anti-hall/settings.json", "{\"devswarm\":{\"childRole\":false}}"),
        ch("child-role-off-option", a, &[("CLAUDE_PLUGIN_OPTION_DEVSWARM_CHILD_ROLE", "false")]),
        ch("child-role-option-default", a, &[("CLAUDE_PLUGIN_OPTION_DEVSWARM_CHILD_ROLE", "true")]).warm(),
        ch("child-role-off-stored-option", a, &[])
            .seed(".claude/settings.json", "{\"pluginConfigs\":{\"anti-hall@anti-hall\":{\"devswarm_child_role\":\"false\"}}}"),
        ch("kill-switch", a, &[("DISABLE_ANTIHALL_DEVSWARM", "1")]),
        ch("kill-switch-not-one", a, &[("DISABLE_ANTIHALL_DEVSWARM", "true")]).warm(),
        ch("supervisor-off-env", a, &[("ANTIHALL_DEVSWARM_SUPERVISOR", " OFF ")]),
        ch("supervisor-off-file", a, &[]).seed(".anti-hall/settings.json", "{\"devswarm\":{\"supervisorMode\":\"off\"}}"),
        ch("supervisor-off-option", a, &[("CLAUDE_PLUGIN_OPTION_DEVSWARM_SUPERVISOR_MODE", "off")]),
        ch("supervisor-option-auto-default", a, &[("CLAUDE_PLUGIN_OPTION_DEVSWARM_SUPERVISOR_MODE", "auto")]).warm(),
        ch("supervisor-off-stored-option", a, &[])
            .seed(".claude/settings.json", "{\"pluginConfigs\":{\"anti-hall\":{\"options\":{\"devswarm_supervisor_mode\":\"off\"}}}}"),
        ch("supervisor-on-without-repo", a, &[("-DEVSWARM_REPO_ID", ""), ("ANTIHALL_DEVSWARM_SUPERVISOR", "on")]).warm(),
        ch("supervisor-garbage-env-falls-to-file", a, &[("ANTIHALL_DEVSWARM_SUPERVISOR", "maybe")])
            .seed(".anti-hall/settings.json", "{\"devswarm\":{\"supervisorMode\":\"OFF\"}}"),
        ch("no-repo-id-auto", a, &[("-DEVSWARM_REPO_ID", "")]),
        ch("repo-id-blank", a, &[("DEVSWARM_REPO_ID", "  ")]),
        ch("primary-no-branch-defers", d, &[("-DEVSWARM_SOURCE_BRANCH", "")]),
        ch("primary-blank-branch-defers", d, &[("DEVSWARM_SOURCE_BRANCH", " \t ")]),
        ch("judge-child", a, &[("ANTIHALL_JUDGE_CHILD", "1")]).cold(),
        ch("judge-child-not-one", a, &[("ANTIHALL_JUDGE_CHILD", "yes")]).warm(),
        ch("settings-malformed", a, &[]).seed(".anti-hall/settings.json", "{not json").warm(),
        ch("settings-array-root", a, &[]).seed(".anti-hall/settings.json", "[1,2]").warm(),
        ch("settings-section-array", a, &[]).seed(".anti-hall/settings.json", "{\"devswarm\":[1]}").warm(),
        ch("payload-malformed-defers", d, &[]).stdin("{not json"),
        ch("payload-empty-defers", d, &[]).stdin(""),
        ch("payload-unicode", a, &[]).stdin("{\"hook_event_name\":\"SessionStart\",\"session_id\":\"s\u{e9}\u{1f600}\"}"),
        ch("payload-huge", a, &[]).stdin(&format!("{{\"hook_event_name\":\"SessionStart\",\"session_id\":\"{}\"}}", "x".repeat(2_000_000))),
        ch("payload-null-has-no-event-defers", d, &[]).stdin("null"),
        ch("payload-wrong-event-defers", d, &[]).stdin("{\"hook_event_name\":\"Stop\"}"),
    ];
    let mut sl = ch("symlinked-plugin-root", a, &[]).warm();
    sl.symlink_root = true;
    v.push(sl);
    let mut nh = ch("no-home-defers", d, &[]);
    nh.no_home = true;
    v.push(nh);
    let mut rel = ch("relative-home-defers", d, &[]);
    rel.home_override = Some("relative/home".into());
    v.push(rel);
    let mut dots = ch("dotdot-home-defers", d, &[]);
    dots.home_override = Some("/tmp/x/../y".into());
    v.push(dots);
    v
}

impl Case {
    fn corrupt(mut self) -> Case {
        self.corrupt_launcher = true;
        self
    }
}

fn gate_cases() -> Vec<Case> {
    let a = Want::Answer;
    let d = Want::Defer;
    let skip = |body: String| (".anti-hall/skip.json".to_string(), body);
    let mut v = vec![
        gate("primary-active-defers", d, &[]),
        gate("child-silent", a, &[("DEVSWARM_SOURCE_BRANCH", "feature/x")]),
        gate("child-blank-branch-defers", d, &[("DEVSWARM_SOURCE_BRANCH", "   ")]),
        gate("inactive-no-repo", a, &[("-DEVSWARM_REPO_ID", "")]),
        gate("inactive-blank-repo", a, &[("DEVSWARM_REPO_ID", " ")]),
        gate("kill-switch", a, &[("DISABLE_ANTIHALL_DEVSWARM", "1")]),
        gate("kill-switch-not-one-defers", d, &[("DISABLE_ANTIHALL_DEVSWARM", "true")]),
        gate("kill-switch-beats-on", a, &[("DISABLE_ANTIHALL_DEVSWARM", "1"), ("ANTIHALL_DEVSWARM_SUPERVISOR", "on")]),
        gate("supervisor-off-env", a, &[("ANTIHALL_DEVSWARM_SUPERVISOR", "off")]),
        gate("supervisor-off-padded-upper", a, &[("ANTIHALL_DEVSWARM_SUPERVISOR", "  OFF\n")]),
        gate("supervisor-on-no-repo-defers", d, &[("-DEVSWARM_REPO_ID", ""), ("ANTIHALL_DEVSWARM_SUPERVISOR", "on")]),
        gate("supervisor-on-child-silent", a, &[("ANTIHALL_DEVSWARM_SUPERVISOR", "on"), ("DEVSWARM_SOURCE_BRANCH", "b")]),
        gate("supervisor-off-file", a, &[]).seed(".anti-hall/settings.json", "{\"devswarm\":{\"supervisorMode\":\"off\"}}"),
        gate("supervisor-on-file-no-repo-defers", d, &[("-DEVSWARM_REPO_ID", "")])
            .seed(".anti-hall/settings.json", "{\"devswarm\":{\"supervisorMode\":\"on\"}}"),
        gate("supervisor-off-option", a, &[("CLAUDE_PLUGIN_OPTION_DEVSWARM_SUPERVISOR_MODE", "off")]),
        gate("supervisor-option-auto-defers", d, &[("CLAUDE_PLUGIN_OPTION_DEVSWARM_SUPERVISOR_MODE", "auto")]),
        gate("supervisor-off-stored-option", a, &[])
            .seed(".claude/settings.json", "{\"pluginConfigs\":{\"anti-hall\":{\"devswarm_supervisor_mode\":\"off\"}}}"),
        gate("supervisor-env-garbage-defers", d, &[("ANTIHALL_DEVSWARM_SUPERVISOR", "nope")]),
        gate("parent-gate-off-file", a, &[]).seed(".anti-hall/settings.json", "{\"devswarm\":{\"parentGate\":false}}"),
        gate("parent-gate-off-file-string", a, &[]).seed(".anti-hall/settings.json", "{\"devswarm\":{\"parentGate\":\"off\"}}"),
        gate("parent-gate-off-file-zero", a, &[]).seed(".anti-hall/settings.json", "{\"devswarm\":{\"parentGate\":0}}"),
        gate("parent-gate-on-file-defers", d, &[]).seed(".anti-hall/settings.json", "{\"devswarm\":{\"parentGate\":true}}"),
        gate("parent-gate-off-option", a, &[("CLAUDE_PLUGIN_OPTION_DEVSWARM_PARENT_GATE", "false")]),
        gate("parent-gate-option-default-defers", d, &[("CLAUDE_PLUGIN_OPTION_DEVSWARM_PARENT_GATE", "true")]),
        gate("parent-gate-off-stored-option", a, &[])
            .seed(".claude/settings.json", "{\"pluginConfigs\":{\"anti-hall@anti-hall\":{\"options\":{\"devswarm_parent_gate\":false}}}}"),
        gate("parent-gate-file-garbage-defers", d, &[]).seed(".anti-hall/settings.json", "{\"devswarm\":{\"parentGate\":\"perhaps\"}}"),
        gate("settings-malformed-defers", d, &[]).seed(".anti-hall/settings.json", "{oops"),
        gate("skip-named", a, &[])
            .seed(&skip(format!("{{\"devswarm-parent-gate\":{}}}", future())).0, &skip(format!("{{\"devswarm-parent-gate\":{}}}", future())).1),
        gate("skip-all", a, &[]).seed(&skip(format!("{{\"all\":{}}}", future())).0, &skip(format!("{{\"all\":{}}}", future())).1),
        gate("skip-expired-defers", d, &[]).seed(".anti-hall/skip.json", "{\"devswarm-parent-gate\":1000,\"all\":2000}"),
        gate("skip-other-guard-defers", d, &[]).seed(&skip(format!("{{\"git-guard\":{}}}", future())).0, &skip(format!("{{\"git-guard\":{}}}", future())).1),
        gate("skip-malformed-defers", d, &[]).seed(".anti-hall/skip.json", "{{{"),
        gate("skip-string-expiry-defers", d, &[]).seed(".anti-hall/skip.json", "{\"devswarm-parent-gate\":\"9999999999999\"}"),
        gate("judge-child", a, &[("ANTIHALL_JUDGE_CHILD", "1")]),
        gate("judge-child-not-one-defers", d, &[("ANTIHALL_JUDGE_CHILD", "true")]),
        gate("stop-hook-active-defers", d, &[]).stdin("{\"hook_event_name\":\"Stop\",\"stop_hook_active\":true}"),
        gate("payload-malformed-primary", d, &[]).stdin("{not json"),
        gate("payload-malformed-child-defers", d, &[("DEVSWARM_SOURCE_BRANCH", "b")]).stdin("{not json"),
        gate("payload-empty-child-defers", d, &[("DEVSWARM_SOURCE_BRANCH", "b")]).stdin(""),
        gate("payload-unicode-child", a, &[("DEVSWARM_SOURCE_BRANCH", "b")])
            .stdin("{\"hook_event_name\":\"Stop\",\"session_id\":\"\u{e9}\u{1f600}\",\"cwd\":\"/\u{4e2d}\"}"),
        gate("payload-huge-child", a, &[("DEVSWARM_SOURCE_BRANCH", "b")])
            .stdin(&format!("{{\"hook_event_name\":\"Stop\",\"x\":\"{}\"}}", "y".repeat(2_000_000))),
        gate("payload-null-inactive-defers", d, &[("-DEVSWARM_REPO_ID", "")]).stdin("null"),
    ];
    let mut nh = gate("no-home-defers", d, &[("DEVSWARM_SOURCE_BRANCH", "b")]);
    nh.no_home = true;
    v.push(nh);
    let mut rel = gate("relative-home-defers", d, &[("DEVSWARM_SOURCE_BRANCH", "b")]);
    rel.home_override = Some("rel".into());
    v.push(rel);
    let mut dots = gate("dotdot-home-defers", d, &[("DEVSWARM_SOURCE_BRANCH", "b")]);
    dots.home_override = Some("/tmp/a/../b".into());
    v.push(dots);
    v
}

fn run_all(cases: Vec<Case>, min: usize) {
    let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    assert!(cases.len() >= min, "the corpus needs at least {min} cases, has {}", cases.len());
    let (mut answers, mut defers) = (0, 0);
    for case in &cases {
        match exec(case).0.as_str() {
            "answer" => answers += 1,
            _ => defers += 1,
        }
    }
    eprintln!("devswarm-role parity: {} cases, {answers} answered identically to Node, {defers} deferred", cases.len());
}

#[test]
fn devswarm_child_role_matches_node() {
    run_all(child_cases(), 30);
}

#[test]
fn devswarm_parent_gate_never_answers_where_node_would_act() {
    run_all(gate_cases(), 30);
}

#[test]
fn a_native_child_answer_carries_the_directive() {
    let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let (kind, out) = exec(&ch("directive", Want::Answer, &[]).warm());
    assert_eq!(kind, "answer");
    let out = out.unwrap();
    let v: Value = serde_json::from_str(&out).unwrap();
    let text = v["hookSpecificOutput"]["additionalContext"].as_str().unwrap();
    assert!(text.contains("devswarm-comms") && text.contains("MAILBOX WAKE") && text.contains("inbox tick abc-123 --child --quiet"), "{text}");
    assert!(text.contains(".anti-hall/bin/devswarm.js"), "the stable launcher is named: {text}");
}
