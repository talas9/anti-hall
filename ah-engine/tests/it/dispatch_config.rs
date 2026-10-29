//! D87 end to end: the per-event and per-entry hook configuration (`[events.*]`, `[entries.*]` in the engine's user file or a
//! project file) as the real binary applies it to `ah-engine hook --event ...`, with the built-in checks answered in the client.
//! No hook command is launched any more, so what the configuration did is read from the plan event the dispatcher logs
//! (`dispatch_plan`: `ran=[..]` in run order, `skipped_*`, `shadowed`, `off`). Each test has its own HOME and state directory.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

struct Env {
    dir: PathBuf,
}

const POST_BASH: [&str; 8] = [
    "merge-side-pick:post",
    "git-guard:audit",
    "output-verify-guard",
    "devswarm-parent-reply-tracker",
    "devswarm-child-drain",
    "coordinator-work-guard:post",
    "agent-reminders",
    "advisor-guard:pass",
];

impl Env {
    fn new(name: &str) -> Env {
        let dir = std::env::temp_dir().join(format!("ahd-cfg-{name}-{}", std::process::id()));
        ah_engine::discard::harmless(std::fs::remove_dir_all(&dir));
        std::fs::create_dir_all(dir.join("home")).unwrap();
        std::fs::create_dir_all(dir.join(".git")).unwrap();
        std::fs::create_dir_all(dir.join("state")).unwrap();
        Env { dir }
    }

    fn state(&self) -> PathBuf {
        self.dir.join("state")
    }

    fn config(&self, text: &str) {
        std::fs::write(self.state().join("config.toml"), text).unwrap();
    }

    /// The plan events the dispatcher logged, oldest first: each field (`ran`, `skipped_max_rules`, ...) to its ids.
    fn plans(&self) -> Vec<HashMap<String, Vec<String>>> {
        self.log()
            .lines()
            .filter(|l| l.contains("dispatch_plan"))
            .map(|l| {
                l.split_whitespace()
                    .filter_map(|w| {
                        let (k, v) = w.split_once("=[")?;
                        Some((k.to_string(), v.trim_end_matches(']').split(',').filter(|i| !i.is_empty()).map(str::to_string).collect()))
                    })
                    .collect()
            })
            .collect()
    }

    /// One field of the latest plan event (empty when there is none).
    fn plan(&self, field: &str) -> Vec<String> {
        self.plans().last().and_then(|p| p.get(field).cloned()).unwrap_or_default()
    }

    /// The built-in checks answered in the client (`in_process`), as the shipped hooks run them.
    fn run(&self, event: &str, payload: &str, extra: &[(&str, &str)]) -> (i32, String, String) {
        let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
        c.args(["hook", "--event", event])
            .env_clear()
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .env("HOME", self.dir.join("home"))
            .env("AH_ENGINE_DIR", self.state())
            .env("AH_ENGINE_VERSION", "dispatch-config")
            // The plan (which entries run, in which order, under which configuration) is what is tested here.
            .env("AH_ENGINE_DISPATCH_IN_PROCESS", "1")
            .env("AH_ENGINE_NOSPAWN", "1")
            .env("CLAUDE_PLUGIN_ROOT", &self.dir)
            .env("AH_ENGINE_PLUGIN_ROOT", Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall"))
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
        ah_engine::defaults::init().unwrap();
        std::fs::read_to_string(self.state().join(ah_engine::health::log_name())).unwrap_or_default()
    }
}

fn post(cmd: &str, cwd: &Path) -> String {
    serde_json::json!({"session_id": "cfg", "cwd": cwd, "hook_event_name": "PostToolUse", "tool_name": "Bash", "tool_input": {"command": cmd}, "tool_response": {}}).to_string()
}

impl Drop for Env {
    fn drop(&mut self) {
        ah_engine::discard::harmless(std::fs::remove_dir_all(&self.dir));
    }
}

fn pre(cmd: &str, cwd: &Path) -> String {
    serde_json::json!({"session_id": "cfg", "cwd": cwd, "hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": cmd}}).to_string()
}

#[test]
fn without_any_config_every_matching_entry_runs_and_the_order_is_the_tables() {
    let e = Env::new("default");
    let (code, _, err) = e.run("PostToolUse", &post("ls", &e.dir), &[]);
    assert_eq!(code, 0, "{err}");
    assert!(!e.log().contains("dispatch_plan"), "a default dispatch writes no plan event: {}", e.log());
    // a configuration that changes nothing (a budget that is never reached) makes the plan observable
    e.config("[events.PostToolUse]\nbudget_ms = 600000\n");
    let (code, _, err) = e.run("PostToolUse", &post("ls", &e.dir), &[]);
    assert_eq!(code, 0, "{err}");
    assert_eq!(e.plan("ran"), POST_BASH, "every matching entry runs, in the table's order");
    assert!(e.plan("skipped_max_rules").is_empty() && e.plan("skipped_budget").is_empty() && e.plan("off").is_empty());
}

#[test]
fn order_and_max_rules_decide_which_entries_run() {
    let e = Env::new("order");
    e.config("[events.PostToolUse]\norder = [\"coordinator-work-guard:post\", \"output-verify-guard\"]\nmax_rules = 3\n");
    let (code, _, err) = e.run("PostToolUse", &post("ls", &e.dir), &[]);
    assert_eq!(code, 0, "{err}");
    assert_eq!(
        e.plan("ran"),
        ["coordinator-work-guard:post", "output-verify-guard", "merge-side-pick:post"],
        "listed ids first, then the table's order, cut at 3"
    );
    assert_eq!(e.plan("skipped_max_rules"), ["git-guard:audit", "devswarm-parent-reply-tracker", "devswarm-child-drain", "agent-reminders", "advisor-guard:pass"], "{}", e.log());
}

#[test]
fn an_off_event_answers_neutral_and_starts_nothing() {
    let e = Env::new("off");
    e.config("[events.PostToolUse]\nenabled = false\n");
    assert_eq!(e.run("PostToolUse", &post("ls", &e.dir), &[]), (0, String::new(), String::new()));
    assert!(e.plan("ran").is_empty());
    assert!(e.log().contains("off=[merge-side-pick:post"), "{}", e.log());
}

#[test]
fn a_shadowed_entry_is_measured_and_an_off_entry_is_dropped() {
    let e = Env::new("shadow");
    e.config("[entries.\"output-verify-guard\"]\nmode = \"shadow\"\n[entries.\"git-guard:audit\"]\nmode = \"off\"\n");
    let (code, _, err) = e.run("PostToolUse", &post("ls", &e.dir), &[]);
    assert_eq!(code, 0, "{err}");
    let want: Vec<&str> = POST_BASH.iter().copied().filter(|i| !["output-verify-guard", "git-guard:audit"].contains(i)).collect();
    assert_eq!(e.plan("ran"), want, "neither the shadowed nor the off entry counts");
    assert_eq!(e.plan("shadowed"), ["output-verify-guard"], "shadow still measures it");
    assert_eq!(e.plan("off"), ["git-guard:audit"], "off does not run it");
}

#[test]
fn a_when_override_skips_the_entry_for_payloads_that_do_not_match() {
    let e = Env::new("when");
    e.config("[entries.\"git-guard:audit\"]\nwhen = { field = \"/tool_input/command\", regex = \"^git\" }\n");
    e.run("PostToolUse", &post("ls -la", &e.dir), &[]);
    assert!(!e.plan("ran").contains(&"git-guard:audit".to_string()), "{}", e.log());
    assert_eq!(e.plan("skipped_predicate"), ["git-guard:audit"]);
    e.run("PostToolUse", &post("git status", &e.dir), &[]);
    assert!(e.plan("ran").contains(&"git-guard:audit".to_string()), "{}", e.log());
}

#[test]
fn a_project_file_applies_below_the_user_file_and_cannot_touch_guards() {
    let e = Env::new("project");
    std::fs::create_dir_all(e.dir.join(".anti-hall")).unwrap();
    std::fs::write(e.dir.join(".anti-hall/engine.toml"), "[events.PostToolUse]\nmax_rules = 1\n").unwrap();
    e.run("PostToolUse", &post("ls", &e.dir), &[]);
    assert_eq!(e.plan("ran"), ["merge-side-pick:post"], "the project file caps the event");
    e.config("[events.PostToolUse]\nmax_rules = 2\n");
    e.run("PostToolUse", &post("ls", &e.dir), &[]);
    assert_eq!(e.plan("ran").len(), 2, "the user file outranks the project file");
    // a project file that names a guard event is rejected whole: the event runs unconfigured
    std::fs::remove_file(e.state().join("config.toml")).unwrap();
    std::fs::write(e.dir.join(".anti-hall/engine.toml"), "[events.PreToolUse]\nbudget_ms = 5\n[events.PostToolUse]\nmax_rules = 1\n").unwrap();
    let before = e.plans().len();
    let (code, _, err) = e.run("PostToolUse", &post("ls", &e.dir), &[]);
    assert_eq!(code, 0, "{err}");
    assert_eq!(e.plans().len(), before, "an invalid project file is ignored, not half applied: the defaults write no plan event");
    assert!(e.log().contains("layer_notice") && e.log().contains("ignored (project)"), "{}", e.log());
}

#[test]
fn an_invalid_user_file_runs_the_defaults_and_says_so() {
    let e = Env::new("invalid");
    e.config("[events.PostToolUse]\nmode = \"loud\"\n");
    let (code, _, err) = e.run("PostToolUse", &post("ls", &e.dir), &[]);
    assert_eq!(code, 0, "{err}");
    assert!(e.log().contains("config_invalid"), "{}", e.log());
    assert!(!e.log().contains("dispatch_plan"), "the defaults ran, so no plan event: {}", e.log());
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
            .env("AH_ENGINE_PLUGIN_ROOT", Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall"))
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
fn a_guard_check_in_shadow_still_decides_and_off_drops_it() {
    let e = Env::new("guard-shadow");
    let payload = pre("git push --force origin main", &e.dir);
    let (code, _, err) = e.run("PreToolUse", &payload, &[]);
    assert_eq!(code, 2, "without the config the engine's git check blocks a force push: {err}");
    // no Node hook runs beside a guard check, so shadow cannot turn it into a measurement: it still decides (never weaker)
    e.config("[entries.\"PreToolUse/git-guard\"]\nmode = \"shadow\"\n");
    let (code, _, err) = e.run("PreToolUse", &payload, &[]);
    assert_eq!(code, 2, "shadow: the check still blocks a force push: {err}");
    assert!(err.contains("git safety"), "{err}");
    // off is the owner's explicit choice: the entry is dropped and no hook takes its place
    e.config("[entries.\"PreToolUse/git-guard\"]\nmode = \"off\"\n");
    let (_, _, err) = e.run("PreToolUse", &payload, &[]);
    assert!(!err.contains("git safety: a force push"), "off: the git check does not run: {err}");
    // The bounded log can clip the final off field; the leading ran list still records its absence.
    assert!(!e.plan("ran").contains(&"git-guard".to_string()), "{}", e.log());
}

#[test]
fn a_guard_events_spent_budget_follows_the_budget_failure_mode() {
    // review finding 17: a spent budget (a slow machine) is no verdict. There is no Node hook to decide, so the configured
    // `budget` failure mode (closed) answers: the call is blocked with the reason, never let through unguarded.
    let e = Env::new("guard-budget");
    e.config("[events.PreToolUse]\nbudget_ms = 1\n");
    let payload = pre("ls", &e.dir);
    // a healthy daemon that refuses the request with ERR: the checks give no answer, and the 1 ms budget has passed by then
    let sock = ah_engine::paths::socket_in(&e.state());
    std::fs::create_dir_all(sock.parent().unwrap()).unwrap();
    let listener = std::os::unix::net::UnixListener::bind(&sock).unwrap();
    listener.set_nonblocking(true).unwrap();
    let alive = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
    let flag = std::sync::Arc::clone(&alive);
    let server = std::thread::spawn(move || {
        use std::io::Read;
        while flag.load(std::sync::atomic::Ordering::Acquire) {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let mut body = Vec::new();
                    ah_engine::discard::harmless(stream.read_to_end(&mut body));
                    // the 1 ms budget must have passed before the refusal arrives: an instant ERR on a fast machine leaves it unspent
                    std::thread::sleep(std::time::Duration::from_millis(20));
                    ah_engine::discard::harmless(stream.write_all(&ah_engine::frame::encode(ah_engine::frame::Kind::Err, "no answer")));
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(std::time::Duration::from_millis(10)),
                Err(_) => break,
            }
        }
    });
    let (code, _, err) = e.run("PreToolUse", &payload, &[("AH_ENGINE_DISPATCH_IN_PROCESS", "0")]);
    alive.store(false, std::sync::atomic::Ordering::Release);
    ah_engine::discard::harmless(server.join());
    assert_eq!(code, 2, "{err}");
    assert!(err.contains("budget") && err.contains("could not run the guards"), "the budget reason is given: {err}");
    // a budget that is not reached changes nothing (the checks answer in the client)
    e.config("[events.PreToolUse]\nbudget_ms = 600000\n");
    assert_eq!(e.run("PreToolUse", &payload, &[]).0, 0);
}

#[test]
fn a_non_guard_events_budget_accounts_for_every_entry_exactly_once() {
    let e = Env::new("budget");
    e.config("[events.PostToolUse]\nbudget_ms = 1\n");
    let (code, _, _) = e.run("PostToolUse", &post("ls", &e.dir), &[]);
    assert_eq!(code, 0);
    let (ran, skipped) = (e.plan("ran"), e.plan("skipped_budget"));
    assert_eq!(ran.len() + skipped.len(), POST_BASH.len(), "ran {ran:?} + skipped_budget {skipped:?}: {}", e.log());
    e.config("[events.PostToolUse]\nbudget_ms = 600000\n");
    e.run("PostToolUse", &post("ls", &e.dir), &[]);
    assert_eq!(e.plan("ran").len(), POST_BASH.len(), "a budget that is not reached skips nothing");
    assert!(e.plan("skipped_budget").is_empty());
}

/// A daemon that answers every PreToolUse request with an OK reply holding `body`, until the returned flag is cleared: the late-reply
/// case where the daemon answered some checks and dropped the rest.
fn serve_replies(sock: &Path, body: String) -> (std::sync::Arc<std::sync::atomic::AtomicBool>, std::thread::JoinHandle<()>) {
    std::fs::create_dir_all(sock.parent().unwrap()).unwrap();
    let listener = std::os::unix::net::UnixListener::bind(sock).unwrap();
    listener.set_nonblocking(true).unwrap();
    let alive = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
    let flag = std::sync::Arc::clone(&alive);
    let server = std::thread::spawn(move || {
        use std::io::Read;
        while flag.load(std::sync::atomic::Ordering::Acquire) {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let mut req = Vec::new();
                    ah_engine::discard::harmless(stream.read_to_end(&mut req));
                    ah_engine::discard::harmless(stream.write_all(&ah_engine::frame::encode(ah_engine::frame::Kind::Ok, &body)));
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(std::time::Duration::from_millis(10)),
                Err(_) => break,
            }
        }
    });
    (alive, server)
}

/// Measurement (a), issue #336 item 1: a Write whose daemon reply is missing only non-safety checks (burn-breaker and the like) and has
/// no runnable Node command. Before (`guards.failOpenNonSafety` off) the Write is BLOCKED; after (the default) it is allowed with one notice
/// per session, and the pass is counted per check. A safety guard that goes unanswered still blocks in both.
#[test]
fn a_write_with_a_late_daemon_answer_is_blocked_before_and_allowed_with_one_notice_after() {
    let e = Env::new("fail-open-write");
    let payload = serde_json::json!({"session_id": "fo1", "cwd": e.dir, "hook_event_name": "PreToolUse", "tool_name": "Write",
        "tool_input": {"file_path": e.dir.join("a.txt"), "content": "x"}});
    let entries = ah_engine::dispatch::table::select_guarded("claude", "PreToolUse", &payload, Some("Write"));
    let closed = |check: &str| ah_engine::script::failure_mode(check) == "closed";
    let (safety, other): (Vec<_>, Vec<_>) = entries.iter().partition(|en| en.check.as_deref().is_some_and(closed));
    assert!(!other.is_empty() && !safety.is_empty(), "a Write has both kinds of guard: safety {} other {}", safety.len(), other.len());
    // the daemon answers the safety guards (an allow each) and drops the rest
    let body = serde_json::Value::Array(safety.iter().map(|en| serde_json::json!([en.id, 0, "", ""])).collect()).to_string();
    let sock = ah_engine::paths::socket_in(&e.state());
    let (alive, server) = serve_replies(&sock, body);
    let payload = payload.to_string();
    let off = [("AH_ENGINE_DISPATCH_IN_PROCESS", "0"), ("ANTIHALL_FAIL_OPEN_NON_SAFETY", "0")];
    let on = [("AH_ENGINE_DISPATCH_IN_PROCESS", "0")];
    let before = e.run("PreToolUse", &payload, &off);
    let after = e.run("PreToolUse", &payload, &on);
    let again = e.run("PreToolUse", &payload, &on);
    alive.store(false, std::sync::atomic::Ordering::Release);
    ah_engine::discard::harmless(server.join());
    eprintln!("MEASURE a: before exit={} stderr={:?}", before.0, before.2.trim());
    eprintln!("MEASURE a: after  exit={} stdout={:?}", after.0, after.1.trim());
    eprintln!("MEASURE a: retry  exit={} stdout={:?}", again.0, again.1.trim());
    assert_eq!(before.0, 2, "before: blocked rather than allowed unguarded: {before:?}");
    assert!(before.2.contains("could not run the guards"), "{before:?}");
    assert_eq!(after.0, 0, "after: allowed: {after:?}");
    assert!(after.1.contains("systemMessage") && after.1.contains("could not run"), "after: one notice line: {after:?}");
    assert_eq!(again.0, 0, "{again:?}");
    assert!(!again.1.contains("systemMessage"), "the notice is told once per session: {again:?}");
    let log = e.log();
    assert!(log.contains("dispatch_fail_open") && log.contains("burn-breaker"), "the pass is on record per check: {log}");
    let journal = std::fs::read_to_string(e.state().join(ah_engine::defaults::text("diagnostics.counters_file"))).unwrap_or_default();
    assert!(journal.lines().any(|l| l.contains("fail_open") && l.contains("burn-breaker")), "counted per check: {journal}");
}

/// A safety guard (git) that goes unanswered keeps failing closed with the setting on.
#[test]
fn an_unanswered_safety_guard_still_blocks_with_fail_open_on() {
    let e = Env::new("fail-open-safety");
    let payload = serde_json::json!({"session_id": "fo2", "cwd": e.dir, "hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": "ls"}});
    let sock = ah_engine::paths::socket_in(&e.state());
    let (alive, server) = serve_replies(&sock, "[]".to_string());
    let r = e.run("PreToolUse", &payload.to_string(), &[("AH_ENGINE_DISPATCH_IN_PROCESS", "0")]);
    alive.store(false, std::sync::atomic::Ordering::Release);
    ah_engine::discard::harmless(server.join());
    assert_eq!(r.0, 2, "no answer from the git/command guards: blocked: {r:?}");
}
