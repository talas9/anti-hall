//! D58 end to end: the real binary as `ah-engine hook --event PreToolUse`, with the Node hooks replaced by small shell
//! commands through `--fallback-map`, so each property is checked without Node. Every test uses its own HOME and state
//! directory and reaps any daemon it starts.

mod common;

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

struct Env {
    dir: PathBuf,
}

impl Env {
    fn new(name: &str) -> Env {
        let dir = std::env::temp_dir().join(format!("ahd-e2e-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("home")).unwrap();
        Env { dir }
    }

    fn state(&self) -> PathBuf {
        self.dir.join("state")
    }

    /// A map that replaces every Bash PreToolUse Node hook: git-guard says nothing (so only the built-in check can
    /// block), the others print what `outs` gives them, or nothing.
    fn map(&self, outs: &[(&str, &str)]) -> PathBuf {
        let ids = [
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
        let m: serde_json::Map<String, serde_json::Value> =
            ids.iter().map(|id| (id.to_string(), outs.iter().find(|(k, _)| k == id).map_or("true".to_string(), |(_, c)| c.to_string()).into())).collect();
        let p = self.dir.join("map.json");
        std::fs::write(&p, serde_json::json!({ "PreToolUse": m }).to_string()).unwrap();
        p
    }

    fn run(&self, args: &[&str], in_process: bool, payload: &str, root: bool) -> (i32, String, String) {
        self.run_with(args, in_process, payload, root, &[])
    }

    /// `run` with extra environment variables for the client (and for a daemon it starts).
    fn run_with(&self, args: &[&str], in_process: bool, payload: &str, root: bool, extra: &[(&str, &str)]) -> (i32, String, String) {
        let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
        c.args(args)
            .env_clear()
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .env("HOME", self.dir.join("home"))
            .env("AH_ENGINE_DIR", self.state())
            .env("AH_ENGINE_VERSION", "dispatch-e2e")
            .env("AH_ENGINE_DISPATCH_IN_PROCESS", if in_process { "1" } else { "0" })
            .current_dir(&self.dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if root {
            c.env("CLAUDE_PLUGIN_ROOT", &self.dir);
        }
        c.envs(extra.iter().copied());
        let mut ch = c.spawn().unwrap();
        ch.stdin.take().unwrap().write_all(payload.as_bytes()).unwrap();
        let o = ch.wait_with_output().unwrap();
        (o.status.code().unwrap_or(-1), String::from_utf8_lossy(&o.stdout).to_string(), String::from_utf8_lossy(&o.stderr).to_string())
    }

    fn stop(&self) {
        let st = self.state();
        common::reap(&st, || {
            let _ = Command::new(env!("CARGO_BIN_EXE_ah-engine")).arg("stop").env("AH_ENGINE_DIR", &st).env("HOME", self.dir.join("home")).output();
        });
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn bash(cmd: &str, cwd: &Path) -> String {
    serde_json::json!({"session_id": "e2e", "cwd": cwd, "hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": cmd}}).to_string()
}

const CTX_A: &str = r#"printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"from command-guard"}}\n'"#;
const CTX_B: &str = r#"printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"from merge-side-pick"}}\n'"#;

#[test]
fn several_advisories_merge_in_hooks_json_order() {
    let e = Env::new("merge");
    let map = e.map(&[("merge-side-pick", CTX_B), ("command-guard", CTX_A)]);
    let args = ["hook", "--event", "PreToolUse", "--fallback-map", map.to_str().unwrap()];
    let (code, out, err) = e.run(&args, true, &bash("ls", &e.dir), true);
    assert_eq!((code, err.as_str()), (0, ""));
    assert_eq!(out, "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"additionalContext\":\"from command-guard\\n\\nfrom merge-side-pick\"}}\n");
}

#[test]
fn the_built_in_check_blocks_in_process_and_through_the_daemon() {
    let e = Env::new("block");
    let map = e.map(&[("command-guard", CTX_A)]);
    let args = ["hook", "--event", "PreToolUse", "--fallback-map", map.to_str().unwrap()];
    let p = bash("git push --force origin main", &e.dir);
    let (code, out, err) = e.run(&args, true, &p, true);
    assert_eq!(code, 2, "in-process: the git check blocks although git-guard's Node command says nothing");
    assert!(out.is_empty() && err.contains("force push"), "{out:?} {err:?}");
    // the first daemon call starts the daemon and answers through Node (D5); later calls are answered by the daemon
    let mut last = (0, String::new(), String::new());
    for _ in 0..50 {
        last = e.run(&args, false, &p, true);
        if last.0 == 2 {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    let metrics = e.run(&["metrics", "--json"], false, "", true).1;
    e.stop();
    assert_eq!((last.0, last.2.as_str()), (2, err.as_str()), "daemon: same block, byte for byte");
    assert!(metrics.contains("dispatch_checks") && metrics.contains("decided"), "the daemon counts what it answered: {metrics}");
}

#[test]
fn an_event_no_entry_matches_says_nothing_and_starts_no_daemon() {
    let e = Env::new("nomatch");
    let p = serde_json::json!({"session_id": "e2e", "cwd": e.dir, "hook_event_name": "PreToolUse", "tool_name": "Glob", "tool_input": {}}).to_string();
    assert_eq!(e.run(&["hook", "--event", "PreToolUse"], false, &p, true), (0, String::new(), String::new()));
    assert!(!e.state().exists(), "nothing matched, so the engine was not woken");
}

/// D74: a guard event whose Node hooks cannot run blocks (exit 2) with the fail-closed message; it is never a silent allow.
#[test]
fn a_guard_event_that_cannot_run_its_node_hooks_fails_closed() {
    let e = Env::new("closed");
    // no plugin root: the table's Node commands name ${CLAUDE_PLUGIN_ROOT}, so they cannot run
    let (code, out, err) = e.run(&["hook", "--event", "PreToolUse"], true, &bash("ls", &e.dir), false);
    assert_eq!((code, out.as_str()), (2, ""), "{err}");
    assert!(err.contains("could not run the guards for PreToolUse") && err.contains("no runnable Node command"), "{err}");
    // a broken fallback map, plugin root set
    let bad = e.dir.join("bad-map.json");
    std::fs::write(&bad, "not json").unwrap();
    let args = ["hook", "--event", "PreToolUse", "--fallback-map", bad.to_str().unwrap()];
    let (code, out, err) = e.run(&args, true, &bash("ls", &e.dir), true);
    assert_eq!((code, out.as_str()), (2, ""), "{err}");
    assert!(err.contains("cannot read the fallback map"), "{err}");
    // a usage error on a guard event does not exit 64 (a non-blocking error the host reads as an allow)
    let (code, _, err) = e.run(&["hook", "--event", "PreToolUse", "--host", "nope"], true, &bash("ls", &e.dir), true);
    assert_eq!(code, 2, "{err}");
    let log = std::fs::read_to_string(e.state().join("ah-engine.log")).unwrap_or_default();
    assert_eq!(log.matches("dispatch_defer").count(), 3, "{log}");
}

/// Any other event goes on with what it can run, and a usage error there stays the host's non-blocking 64.
#[test]
fn an_event_that_is_not_a_guard_runs_what_it_can() {
    let e = Env::new("open");
    let p = serde_json::json!({"session_id": "e2e", "cwd": e.dir, "hook_event_name": "SessionStart"}).to_string();
    let (code, _, err) = e.run(&["hook", "--event", "SessionStart"], true, &p, false);
    assert_eq!(code, 0, "no runnable hook, none blocks: {err}");
    let bad = e.dir.join("bad-map.json");
    std::fs::write(&bad, "not json").unwrap();
    let (code, _, _) = e.run(&["hook", "--event", "SessionStart", "--fallback-map", bad.to_str().unwrap()], true, &p, false);
    assert_ne!(code, 2, "a broken map does not block a non-guard event");
    assert_eq!(e.run(&["hook", "--event", "SessionStart", "--host", "nope"], true, &p, true).0, 64);
}

/// Outputs one hook output cannot join are delivered one after another, not dropped.
#[test]
fn a_conflict_delivers_every_output_in_order() {
    let e = Env::new("conflict");
    let map = e.map(&[("command-guard", CTX_A), ("merge-gate", "echo plain text; echo warn >&2")]);
    let args = ["hook", "--event", "PreToolUse", "--fallback-map", map.to_str().unwrap()];
    let (code, out, err) = e.run(&args, true, &bash("ls", &e.dir), true);
    assert_eq!(code, 0);
    // the JSON keeps stdout (the host reads stdout as one object or as text); the plain text goes to stderr after the warning
    assert_eq!(out, format!("{}\n", r#"{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"from command-guard"}}"#));
    assert_eq!(err, "warn\nplain text\n");
    let log = std::fs::read_to_string(e.state().join("ah-engine.log")).unwrap_or_default();
    assert_eq!(log.matches("dispatch_conflict").count(), 1, "{log}");
}

/// Three hooks of 4000 characters each fit the host's cap one by one but not joined. On a guard event the dispatcher still
/// delivers every decision (exit 75 would lose an `ask` or `defer`): the join goes out as one object and the over-cap join is
/// logged.
#[test]
fn a_join_over_the_host_cap_on_a_guard_event_keeps_the_decision() {
    let e = Env::new("overcap");
    let big = |n: &str, extra: &str| {
        format!(
            r#"printf '{{"hookSpecificOutput":{{"hookEventName":"PreToolUse"{extra},"additionalContext":"%s"}}}}\n' "$(head -c 4000 /dev/zero | tr '\0' {n})""#
        )
    };
    let (a, b, c) = (big("a", ""), big("b", ""), big("c", r#","permissionDecision":"ask","permissionDecisionReason":"sure?""#));
    let map = e.map(&[("command-guard", a.as_str()), ("merge-side-pick", b.as_str()), ("api-guard", c.as_str())]);
    let args = ["hook", "--event", "PreToolUse", "--fallback-map", map.to_str().unwrap()];
    let (code, out, err) = e.run(&args, true, &bash("ls", &e.dir), true);
    assert_eq!((code, err.as_str()), (0, ""));
    let v: serde_json::Value = serde_json::from_str(out.trim()).expect("one JSON object");
    assert_eq!(v["hookSpecificOutput"]["permissionDecision"], "ask", "the decision survives the join");
    assert_eq!(v["hookSpecificOutput"]["additionalContext"].as_str().map(|c| c.chars().count()), Some(3 * 4000 + 2 * 2));
    let log = std::fs::read_to_string(e.state().join("ah-engine.log")).unwrap_or_default();
    assert_eq!(log.matches("dispatch_context_over_cap").count(), 1, "{log}");
    // two of them fit joined: delivered as one, nothing logged
    let map = e.map(&[("command-guard", a.as_str()), ("merge-side-pick", b.as_str())]);
    let args = ["hook", "--event", "PreToolUse", "--fallback-map", map.to_str().unwrap()];
    assert_eq!(e.run(&args, true, &bash("ls", &e.dir), true).0, 0);
}

/// An event that cannot block still hands an over-cap join back to the wrapper with `dispatch.defer_exit`.
#[test]
fn a_join_over_the_host_cap_on_another_event_is_handed_back_to_run_separately() {
    let e = Env::new("overcap-open");
    let big = |n: &str| {
        format!(r#"printf '{{"hookSpecificOutput":{{"hookEventName":"SessionStart","additionalContext":"%s"}}}}\n' "$(head -c 4000 /dev/zero | tr '\0' {n})""#)
    };
    let ids: Vec<String> = ah_engine::dispatch::table::entries("claude", "SessionStart").into_iter().map(|x| x.id).collect();
    let m: serde_json::Map<String, serde_json::Value> =
        ids.iter().enumerate().map(|(i, id)| (id.clone(), if i < 3 { big(["a", "b", "c"][i]) } else { "true".to_string() }.into())).collect();
    let map = e.dir.join("map.json");
    std::fs::write(&map, serde_json::json!({ "SessionStart": m }).to_string()).unwrap();
    let p = serde_json::json!({"session_id": "e2e", "cwd": e.dir, "hook_event_name": "SessionStart", "source": "startup"}).to_string();
    let args = ["hook", "--event", "SessionStart", "--fallback-map", map.to_str().unwrap()];
    let (code, out, err) = e.run(&args, true, &p, true);
    assert_eq!((code, out.as_str()), (75, ""), "{err}");
    assert!(err.contains("over the 10000"), "{err}");
}

#[test]
fn a_bad_host_is_a_usage_error() {
    let e = Env::new("host");
    let p = serde_json::json!({"session_id": "e2e", "cwd": e.dir, "hook_event_name": "SessionStart"}).to_string();
    let (code, out, err) = e.run(&["hook", "--event", "SessionStart", "--host", "nope"], true, &p, true);
    assert_eq!((code, out.as_str()), (64, ""));
    assert!(err.contains("nope"));
}

/// D76: the daemon is started by a client whose environment turns the git guard off; a second client without that
/// variable must still be blocked by the same daemon, and a third with it must not be.
#[test]
fn two_clients_with_different_environments_get_answers_for_their_own() {
    let e = Env::new("env");
    let map = e.map(&[]);
    let args = ["hook", "--event", "PreToolUse", "--fallback-map", map.to_str().unwrap()];
    let p = bash(&["git push", "--force origin main"].join(" "), &e.dir);
    let off = [("ANTIHALL_GIT_GUARD", "0")];
    // the first call starts the daemon (with the switch off in ITS environment) and is answered through Node: allowed
    assert_eq!(e.run_with(&args, false, &p, true, &off).0, 0);
    // wait until the daemon answers (bounded polling; not an assertion about speed)
    let mut up = false;
    for _ in 0..200 {
        if e.run(&["ctl", "ping"], false, "", true).0 == 0 {
            up = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    assert!(up, "the daemon did not come up");
    let guarded = e.run(&args, false, &p, true);
    let unguarded = e.run_with(&args, false, &p, true, &off);
    let guarded_again = e.run(&args, false, &p, true);
    e.stop();
    assert_eq!(guarded.0, 2, "client without the switch: blocked although the daemon's own environment has it off: {guarded:?}");
    assert_eq!(unguarded, (0, String::new(), String::new()), "client with the switch: allowed");
    assert_eq!(guarded_again, guarded, "the switch of one client does not stick to the daemon");
}
