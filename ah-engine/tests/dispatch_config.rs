//! D87 end to end: the per-event and per-entry hook configuration (`[events.*]`, `[entries.*]` in the engine's user file or a
//! project file) as the real binary applies it to `ah-engine hook --event ...`, with the Node hooks replaced by small shell
//! commands through `--fallback-map`. Each test has its own HOME and state directory; no daemon is started (every check runs as its Node
//! hook: `AH_ENGINE_DISPATCH_IN_PROCESS=0` with `AH_ENGINE_NOSPAWN=1`).
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

struct Env {
    dir: PathBuf,
}

const POST_BASH: [&str; 6] =
    ["merge-side-pick:post", "git-guard:audit", "output-verify-guard", "devswarm-parent-reply-tracker", "devswarm-child-drain", "coordinator-work-guard:post"];
/// Entries the engine answers itself in these tests' environment, so no Node command runs for them. None: the tests run with
/// the checks down (`AH_ENGINE_NOSPAWN=1`), so every entry runs as its Node command.
const POST_NATIVE: [&str; 0] = [];
const PRE_BASH: [&str; 9] = [
    "compact-declaration-guard",
    "git-guard",
    "command-guard",
    "coordinator-work-guard",
    "merge-side-pick",
    "merge-gate",
    "scan-throttle",
    "api-guard",
    "ship-it-guard",
];

impl Env {
    fn new(name: &str) -> Env {
        let dir = std::env::temp_dir().join(format!("ahd-cfg-{name}-{}", std::process::id()));
        ah_engine::discard::harmless(std::fs::remove_dir_all(&dir));
        std::fs::create_dir_all(dir.join("home")).unwrap();
        std::fs::create_dir_all(dir.join("state")).unwrap();
        Env { dir }
    }

    fn state(&self) -> PathBuf {
        self.dir.join("state")
    }

    fn config(&self, text: &str) {
        std::fs::write(self.state().join("config.toml"), text).unwrap();
    }

    /// A map giving every listed id of `event` the command `f(id)`.
    fn map(&self, event: &str, ids: &[&str], f: impl Fn(&str) -> String) -> PathBuf {
        let m: serde_json::Map<String, serde_json::Value> = ids.iter().map(|id| (id.to_string(), f(id).into())).collect();
        let p = self.dir.join(format!("{event}.map.json"));
        std::fs::write(&p, serde_json::json!({ event: m }).to_string()).unwrap();
        p
    }

    /// Every hook prints its id as additionalContext and appends it to `ran.log`.
    fn ctx_map(&self, event: &str, ids: &[&str]) -> PathBuf {
        let log = self.dir.join("ran.log");
        self.map(event, ids, |id| {
            format!("echo {id} >> {}; printf '{{\"hookSpecificOutput\":{{\"hookEventName\":\"{event}\",\"additionalContext\":\"CTX-{id}\"}}}}'", log.display())
        })
    }

    fn ran(&self) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_to_string(self.dir.join("ran.log")).unwrap_or_default().lines().map(str::to_string).collect();
        v.sort();
        v
    }

    fn run(&self, event: &str, map: &Path, payload: &str, extra: &[(&str, &str)]) -> (i32, String, String) {
        self.run_as(false, event, map, payload, extra)
    }

    /// [`Env::run`] with the built-in checks answered in the client (`in_process`), as the shipped hooks run them.
    fn run_native(&self, event: &str, map: &Path, payload: &str, extra: &[(&str, &str)]) -> (i32, String, String) {
        self.run_as(true, event, map, payload, extra)
    }

    fn run_as(&self, in_process: bool, event: &str, map: &Path, payload: &str, extra: &[(&str, &str)]) -> (i32, String, String) {
        let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
        c.args(["hook", "--event", event, "--fallback-map", map.to_str().unwrap()])
            .env_clear()
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .env("HOME", self.dir.join("home"))
            .env("AH_ENGINE_DIR", self.state())
            .env("AH_ENGINE_VERSION", "dispatch-config")
            // the plan (which entries run, in which order, under which configuration) is what is tested here, with every hook a
            // fake: the checks run as their Node hooks (no daemon and none to start), because a check the engine answers itself
            // would not run its fake and the ported entries would drop out of the plan's output
            .env("AH_ENGINE_DISPATCH_IN_PROCESS", if in_process { "1" } else { "0" })
            .env("AH_ENGINE_NOSPAWN", if in_process { "0" } else { "1" })
            .env("CLAUDE_PLUGIN_ROOT", &self.dir)
            .current_dir(&self.dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        c.envs(extra.iter().copied());
        let mut ch = c.spawn().unwrap();
        ch.stdin.take().unwrap().write_all(payload.as_bytes()).unwrap();
        let o = ch.wait_with_output().unwrap();
        (o.status.code().unwrap_or(-1), String::from_utf8_lossy(&o.stdout).to_string(), String::from_utf8_lossy(&o.stderr).to_string())
    }

    /// Everything the engine logged in its state dir.
    fn log(&self) -> String {
        std::fs::read_dir(self.state())
            .map(|rd| rd.flatten().filter_map(|e| std::fs::read_to_string(e.path()).ok()).collect::<Vec<_>>().join("\n"))
            .unwrap_or_default()
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        ah_engine::discard::harmless(std::fs::remove_dir_all(&self.dir));
    }
}

fn post(cmd: &str, cwd: &Path) -> String {
    serde_json::json!({"session_id": "cfg", "cwd": cwd, "hook_event_name": "PostToolUse", "tool_name": "Bash", "tool_input": {"command": cmd}, "tool_response": {}}).to_string()
}

fn pre(cmd: &str, cwd: &Path) -> String {
    serde_json::json!({"session_id": "cfg", "cwd": cwd, "hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": cmd}}).to_string()
}

fn contexts(out: &str) -> Vec<String> {
    let v: serde_json::Value = serde_json::from_str(out.trim()).unwrap_or(serde_json::Value::Null);
    v["hookSpecificOutput"]["additionalContext"].as_str().unwrap_or("").split("\n\n").filter(|s| !s.is_empty()).map(str::to_string).collect()
}

#[test]
fn without_any_config_every_matching_entry_runs_and_the_answer_is_the_tables_order() {
    let e = Env::new("default");
    let map = e.ctx_map("PostToolUse", &POST_BASH);
    let (code, out, err) = e.run("PostToolUse", &map, &post("ls", &e.dir), &[]);
    assert_eq!(code, 0, "{err}");
    assert_eq!(contexts(&out), POST_BASH.iter().filter(|i| !POST_NATIVE.contains(i)).map(|id| format!("CTX-{id}")).collect::<Vec<_>>());
    assert!(!e.log().contains("dispatch_plan"), "a default dispatch writes no plan event: {}", e.log());
}

#[test]
fn order_and_max_rules_decide_which_entries_run_and_how_their_answers_combine() {
    let e = Env::new("order");
    e.config("[events.PostToolUse]\norder = [\"coordinator-work-guard:post\", \"output-verify-guard\"]\nmax_rules = 3\n");
    let map = e.ctx_map("PostToolUse", &POST_BASH);
    let (code, out, err) = e.run("PostToolUse", &map, &post("ls", &e.dir), &[]);
    assert_eq!(code, 0, "{err}");
    assert_eq!(
        contexts(&out),
        ["CTX-coordinator-work-guard:post", "CTX-output-verify-guard", "CTX-merge-side-pick:post"],
        "listed ids first, then the table's order, cut at 3"
    );
    assert_eq!(e.ran(), ["coordinator-work-guard:post", "merge-side-pick:post", "output-verify-guard"], "the cut entries never started");
    let log = e.log();
    assert!(log.contains("dispatch_plan") && log.contains("skipped_max_rules=[git-guard:audit,devswarm-parent-reply-tracker,devswarm-child-drain]"), "{log}");
}

#[test]
fn an_off_event_answers_neutral_and_starts_nothing() {
    let e = Env::new("off");
    e.config("[events.PostToolUse]\nenabled = false\n");
    let map = e.ctx_map("PostToolUse", &POST_BASH);
    assert_eq!(e.run("PostToolUse", &map, &post("ls", &e.dir), &[]), (0, String::new(), String::new()));
    assert!(e.ran().is_empty());
    assert!(e.log().contains("off=[merge-side-pick:post"), "{}", e.log());
}

#[test]
fn a_shadowed_entry_runs_but_its_answer_is_never_delivered() {
    let e = Env::new("shadow");
    e.config("[entries.\"output-verify-guard\"]\nmode = \"shadow\"\n[entries.\"git-guard:audit\"]\nmode = \"off\"\n");
    let map = e.ctx_map("PostToolUse", &POST_BASH);
    let (code, out, _) = e.run("PostToolUse", &map, &post("ls", &e.dir), &[]);
    assert_eq!(code, 0);
    let want: Vec<String> = POST_BASH
        .iter()
        .filter(|i| !["output-verify-guard", "git-guard:audit"].contains(i) && !POST_NATIVE.contains(i))
        .map(|id| format!("CTX-{id}"))
        .collect();
    assert_eq!(contexts(&out), want);
    assert!(e.ran().contains(&"output-verify-guard".to_string()), "shadow still runs it");
    assert!(!e.ran().contains(&"git-guard:audit".to_string()), "off does not");
    assert!(e.log().contains("shadowed=[output-verify-guard]"));
}

#[test]
fn a_when_override_skips_the_entry_for_payloads_that_do_not_match() {
    let e = Env::new("when");
    e.config("[entries.\"git-guard:audit\"]\nwhen = { field = \"/tool_input/command\", regex = \"^git\" }\n");
    let map = e.ctx_map("PostToolUse", &POST_BASH);
    let (_, out, _) = e.run("PostToolUse", &map, &post("ls -la", &e.dir), &[]);
    assert!(!contexts(&out).contains(&"CTX-git-guard:audit".to_string()), "{out}");
    assert!(e.log().contains("skipped_predicate=[git-guard:audit]"));
    let (_, out, _) = e.run("PostToolUse", &map, &post("git status", &e.dir), &[]);
    assert!(contexts(&out).contains(&"CTX-git-guard:audit".to_string()), "{out}");
}

#[test]
fn a_project_file_applies_below_the_user_file_and_cannot_touch_guards() {
    let e = Env::new("project");
    std::fs::create_dir_all(e.dir.join(".anti-hall")).unwrap();
    std::fs::write(e.dir.join(".anti-hall/engine.toml"), "[events.PostToolUse]\nmax_rules = 1\n").unwrap();
    let map = e.ctx_map("PostToolUse", &POST_BASH);
    let (_, out, _) = e.run("PostToolUse", &map, &post("ls", &e.dir), &[]);
    assert_eq!(contexts(&out), ["CTX-merge-side-pick:post"], "the project file caps the event");
    e.config("[events.PostToolUse]\nmax_rules = 2\n");
    let (_, out, _) = e.run("PostToolUse", &map, &post("ls", &e.dir), &[]);
    assert_eq!(contexts(&out).len(), 2, "the user file outranks the project file");
    // a project file that names a guard event is rejected whole: the event runs unconfigured
    std::fs::remove_file(e.state().join("config.toml")).unwrap();
    std::fs::write(e.dir.join(".anti-hall/engine.toml"), "[events.PreToolUse]\nbudget_ms = 5\n[events.PostToolUse]\nmax_rules = 1\n").unwrap();
    let (_, out, _) = e.run("PostToolUse", &map, &post("ls", &e.dir), &[]);
    assert_eq!(contexts(&out).len(), POST_BASH.len() - POST_NATIVE.len(), "an invalid project file is ignored, not half applied");
    assert!(e.log().contains("config_invalid") && e.log().contains("project file"), "{}", e.log());
}

#[test]
fn an_invalid_user_file_runs_the_defaults_and_says_so() {
    let e = Env::new("invalid");
    e.config("[events.PostToolUse]\nmode = \"loud\"\n");
    let map = e.ctx_map("PostToolUse", &POST_BASH);
    let (code, out, _) = e.run("PostToolUse", &map, &post("ls", &e.dir), &[]);
    assert_eq!((code, contexts(&out).len()), (0, POST_BASH.len() - POST_NATIVE.len()));
    assert!(e.log().contains("config_invalid"), "{}", e.log());
}

#[test]
fn config_validate_enforces_the_guard_rule_on_the_real_command() {
    let e = Env::new("validate");
    let validate = |text: &str| {
        let f = e.dir.join("v.toml");
        std::fs::write(&f, text).unwrap();
        let o = Command::new(env!("CARGO_BIN_EXE_ah-engine"))
            .args(["config", "validate", f.to_str().unwrap(), "--json"])
            .env_clear()
            .env("HOME", e.dir.join("home"))
            .env("AH_ENGINE_DIR", e.state())
            .output()
            .unwrap();
        (o.status.code().unwrap(), String::from_utf8_lossy(&o.stdout).to_string())
    };
    // (the rule for a guard entry with no built-in check is unit-tested in src/hookcfg: every guard entry of the table has a check now)
    for bad in [
        "[events.PreToolUse]\nmode = \"off\"\n",
        "[events.Stop]\nenabled = false\n",
        "[events.SubagentStop]\nmode = \"shadow\"\n",
        "[events.PermissionRequest]\nmax_rules = 1\n",
    ] {
        let (code, out) = validate(bad);
        assert_eq!(code, 1, "{bad}: {out}");
        assert!(out.contains("\"code\":\"hooks\""), "{out}");
    }
    for good in ["[events.PreToolUse]\nbudget_ms = 100\n", "[entries.\"PreToolUse/git-guard\"]\nmode = \"shadow\"\n", "[events.PostToolUse]\nmode = \"off\"\n"]
    {
        assert_eq!(validate(good).0, 0, "{good}");
    }
}

#[test]
fn shadowing_a_guard_check_never_changes_the_outcome_and_logs_the_disagreement() {
    let e = Env::new("guard-shadow");
    let map = e.map("PreToolUse", &PRE_BASH, |_| "true".into());
    let payload = pre("git push --force origin main", &e.dir);
    let (code, _, err) = e.run_native("PreToolUse", &map, &payload, &[]);
    assert_eq!(code, 2, "without the config the engine's git check blocks a force push: {err}");
    e.config("[entries.\"PreToolUse/git-guard\"]\nmode = \"shadow\"\n");
    let (code, out, err) = e.run_native("PreToolUse", &map, &payload, &[]);
    assert_eq!((code, out.as_str(), err.as_str()), (0, "", ""), "shadow: the Node hook (which allows) decides, the engine's block changes nothing");
    let log = e.log();
    assert!(log.contains("dispatch_shadow") && log.contains("git-guard agree=false engine_exit=2 node_exit=0"), "{log}");
    e.config("[entries.\"PreToolUse/git-guard\"]\nmode = \"off\"\n");
    assert_eq!(e.run_native("PreToolUse", &map, &payload, &[]).0, 0, "off: the check does not run, the Node hook decides");
    // the Node hook that decides still blocks when it blocks
    let blocking = e.map("PreToolUse", &PRE_BASH, |id| if id == "git-guard" { "echo node-says-no >&2; exit 2".into() } else { "true".into() });
    let (code, _, err) = e.run_native("PreToolUse", &blocking, &payload, &[]);
    assert_eq!(code, 2, "{err}");
    assert!(err.contains("node-says-no"), "{err}");
}

#[test]
fn a_guard_events_budget_fails_closed_when_the_hooks_cannot_start_in_time() {
    let e = Env::new("guard-budget");
    e.config("[events.PreToolUse]\nbudget_ms = 1\n");
    let map = e.map("PreToolUse", &PRE_BASH, |_| "sleep 0.3".into());
    let payload = pre("ls", &e.dir);
    let (code, _, err) = e.run_native("PreToolUse", &map, &payload, &[("AH_ENGINE_DISPATCH_IN_PROCESS", "0"), ("AH_ENGINE_NOSPAWN", "1")]);
    assert_eq!(code, 2, "{err}");
    assert!(err.contains("budget"), "fails closed with the budget reason: {err}");
    // a budget that is not reached changes nothing
    e.config("[events.PreToolUse]\nbudget_ms = 600000\n");
    assert_eq!(e.run_native("PreToolUse", &map, &payload, &[("AH_ENGINE_DISPATCH_IN_PROCESS", "0"), ("AH_ENGINE_NOSPAWN", "1")]).0, 0);
}

#[test]
fn a_non_guard_events_budget_accounts_for_every_entry_exactly_once() {
    let e = Env::new("budget");
    e.config("[events.PostToolUse]\nbudget_ms = 1\n");
    let map = e.ctx_map("PostToolUse", &POST_BASH);
    let (code, _, _) = e.run("PostToolUse", &map, &post("ls", &e.dir), &[]);
    assert_eq!(code, 0);
    let ran = e.ran().len();
    let log = e.log();
    let skipped = log
        .lines()
        .filter(|l| l.contains("dispatch_plan"))
        .flat_map(|l| l.split("skipped_budget=[").nth(1).and_then(|r| r.split(']').next()).into_iter())
        .flat_map(|r| r.split(',').filter(|s| !s.is_empty()).map(str::to_string).collect::<Vec<_>>())
        .count();
    assert_eq!(ran + skipped + POST_NATIVE.len(), POST_BASH.len(), "ran {ran} + skipped_budget {skipped}: {log}");
    e.config("[events.PostToolUse]\nbudget_ms = 600000\n");
    let (_, out, _) = e.run("PostToolUse", &map, &post("ls", &e.dir), &[]);
    assert_eq!(contexts(&out).len(), POST_BASH.len() - POST_NATIVE.len(), "a budget that is not reached skips nothing");
}
