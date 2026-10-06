//! D58 end to end: the real binary as `ah-engine hook --event PreToolUse`, with the Node hooks replaced by small shell
//! commands through `--fallback-map`, so each property is checked without Node. Every test uses its own HOME and state
//! directory and reaps any daemon it starts.

mod common;

use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

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

    fn run_with_file_size_limit(
        &self,
        args: &[&str],
        in_process: bool,
        payload: &str,
        root: bool,
        extra: &[(&str, &str)],
        file_size: libc::rlim_t,
    ) -> (i32, String, String) {
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
        unsafe {
            c.pre_exec(move || {
                if libc::signal(libc::SIGXFSZ, libc::SIG_IGN) == libc::SIG_ERR {
                    return Err(std::io::Error::last_os_error());
                }
                let limit = libc::rlimit { rlim_cur: file_size, rlim_max: file_size };
                if libc::setrlimit(libc::RLIMIT_FSIZE, &limit) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut ch = c.spawn().unwrap();
        if let Some(mut stdin) = ch.stdin.take() {
            match stdin.write_all(payload.as_bytes()) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::BrokenPipe => {}
                Err(e) => panic!("failed to write hook payload to stdin: {e}"),
            }
        }
        let o = ch.wait_with_output().unwrap();
        (o.status.code().unwrap_or(-1), String::from_utf8_lossy(&o.stdout).to_string(), String::from_utf8_lossy(&o.stderr).to_string())
    }

    fn dispatch_temp_files(&self) -> Vec<PathBuf> {
        std::fs::read_dir(self.state())
            .into_iter()
            .flatten()
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.file_name().is_some_and(|n| n.to_string_lossy().starts_with("dispatch-stdin-")))
            .collect()
    }

    fn dispatch_temp_names(&self) -> Vec<String> {
        let mut names: Vec<String> = self.dispatch_temp_files().into_iter().filter_map(|p| p.file_name().map(|n| n.to_string_lossy().to_string())).collect();
        names.sort();
        names
    }

    fn fake_node(&self, body: &str) -> PathBuf {
        let bin = self.dir.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let node = bin.join("node");
        std::fs::write(&node, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&node, std::fs::Permissions::from_mode(0o700)).unwrap();
        bin
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

fn session_payload_len(len: usize) -> String {
    let prefix = r#"{"session_id":"e2e","cwd":".","hook_event_name":"SessionStart","source":""#;
    let suffix = r#""}"#;
    assert!(len >= prefix.len() + suffix.len());
    let mut p = String::with_capacity(len);
    p.push_str(prefix);
    p.extend(std::iter::repeat_n('x', len - prefix.len() - suffix.len()));
    p.push_str(suffix);
    p
}

fn pretool_payload_len(len: usize) -> String {
    let prefix = r#"{"session_id":"e2e","cwd":".","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":""#;
    let suffix = r#""}}"#;
    assert!(len >= prefix.len() + suffix.len());
    let mut p = String::with_capacity(len);
    p.push_str(prefix);
    p.extend(std::iter::repeat_n('x', len - prefix.len() - suffix.len()));
    p.push_str(suffix);
    p
}

fn pretool_payload_with_padding(len: usize, tool: &str, tool_input: serde_json::Value) -> String {
    let prefix = format!(r#"{{"session_id":"e2e","cwd":".","hook_event_name":"PreToolUse","tool_name":"{tool}","tool_input":{tool_input},"padding":""#);
    let suffix = r#""}"#;
    assert!(len >= prefix.len() + suffix.len());
    let mut p = String::with_capacity(len);
    p.push_str(&prefix);
    p.extend(std::iter::repeat_n('x', len - prefix.len() - suffix.len()));
    p.push_str(suffix);
    p
}

fn stop_payload_len(len: usize) -> String {
    let prefix = r#"{"session_id":"e2e","cwd":".","hook_event_name":"Stop","stop_hook_active":true,"transcript_path":""#;
    let suffix = r#""}"#;
    assert!(len >= prefix.len() + suffix.len());
    let mut p = String::with_capacity(len);
    p.push_str(prefix);
    p.extend(std::iter::repeat_n('x', len - prefix.len() - suffix.len()));
    p.push_str(suffix);
    p
}

fn stop_payload_with_padding(len: usize) -> String {
    let prefix = r#"{"session_id":"e2e","cwd":".","hook_event_name":"Stop","stop_hook_active":true,"padding":""#;
    let suffix = r#""}"#;
    assert!(len >= prefix.len() + suffix.len());
    let mut p = String::with_capacity(len);
    p.push_str(prefix);
    p.extend(std::iter::repeat_n('x', len - prefix.len() - suffix.len()));
    p.push_str(suffix);
    p
}

fn session_map(e: &Env, first: &str, rest: &str) -> PathBuf {
    let ids: Vec<String> = ah_engine::dispatch::table::entries("claude", "SessionStart").into_iter().map(|x| x.id).collect();
    let m: serde_json::Map<String, serde_json::Value> = ids.iter().enumerate().map(|(i, id)| (id.clone(), if i == 0 { first } else { rest }.into())).collect();
    let map = e.dir.join("session-map.json");
    std::fs::write(&map, serde_json::json!({ "SessionStart": m }).to_string()).unwrap();
    map
}

fn pretool_map(e: &Env, outs: &[(&str, &str)], rest: &str) -> PathBuf {
    let ids: Vec<String> = ah_engine::dispatch::table::entries("claude", "PreToolUse").into_iter().map(|x| x.id).collect();
    let m: serde_json::Map<String, serde_json::Value> =
        ids.iter().map(|id| (id.clone(), outs.iter().find(|(k, _)| k == id).map_or(rest.to_string(), |(_, c)| c.to_string()).into())).collect();
    let map = e.dir.join("pretool-map.json");
    std::fs::write(&map, serde_json::json!({ "PreToolUse": m }).to_string()).unwrap();
    map
}

fn event_map(e: &Env, event: &str, first: &str, rest: &str) -> PathBuf {
    let ids: Vec<String> = ah_engine::dispatch::table::entries("claude", event).into_iter().map(|x| x.id).collect();
    let m: serde_json::Map<String, serde_json::Value> = ids.iter().enumerate().map(|(i, id)| (id.clone(), if i == 0 { first } else { rest }.into())).collect();
    let map = e.dir.join(format!("{event}-map.json"));
    let mut events = serde_json::Map::new();
    events.insert(event.to_string(), serde_json::Value::Object(m));
    std::fs::write(&map, serde_json::Value::Object(events).to_string()).unwrap();
    map
}

fn assert_no_stop_counters(e: &Env) {
    let dir = e.state().join(ah_engine::defaults::text("dispatch.stop_state_dir"));
    let count = std::fs::read_dir(&dir).into_iter().flatten().flatten().count();
    assert_eq!(count, 0, "genuine Stop blocks must not write stop-counter files in {}", dir.display());
}

const CTX_MERGE_GATE: &str = r#"printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"from merge-gate"}}\n'"#;
const CTX_API_GUARD: &str = r#"printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"from api-guard"}}\n'"#;

#[test]
fn several_advisories_merge_in_hooks_json_order() {
    let e = Env::new("merge");
    let map = e.map(&[("api-guard", CTX_API_GUARD), ("merge-gate", CTX_MERGE_GATE)]);
    let args = ["hook", "--event", "PreToolUse", "--fallback-map", map.to_str().unwrap()];
    let (code, out, err) = e.run(&args, true, &bash("ls", &e.dir), true);
    assert_eq!((code, err.as_str()), (0, ""));
    assert_eq!(out, "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"additionalContext\":\"from merge-gate\\n\\nfrom api-guard\"}}\n");
}

#[test]
fn the_built_in_check_blocks_in_process_and_through_the_daemon() {
    let e = Env::new("block");
    let map = e.map(&[("merge-gate", CTX_MERGE_GATE)]);
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
    assert!(e.dispatch_temp_files().is_empty(), "temp payload files left behind: {:?}", e.dispatch_temp_files());
    assert!(!e.state().join("failure.json").exists(), "nothing matched, so the daemon was not woken");
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

#[test]
fn a_guard_event_with_a_missing_node_script_fails_closed_before_spawning_node() {
    let e = Env::new("missing-script-guard");
    let mark = e.dir.join("fake-node-ran");
    let body = format!(r#": > {}; echo MODULE_NOT_FOUND >&2; exit 1"#, mark.display());
    let bin = e.fake_node(&body);
    let empty_root = e.dir.join("empty-plugin");
    std::fs::create_dir_all(&empty_root).unwrap();
    let (code, out, err) = e.run_with(
        &["hook", "--event", "PreToolUse"],
        true,
        &bash("ls", &e.dir),
        false,
        &[("CLAUDE_PLUGIN_ROOT", empty_root.to_str().unwrap()), ("PATH", bin.to_str().unwrap())],
    );

    assert_eq!((code, out.as_str()), (2, ""), "{err}");
    assert!(err.contains("could not run the guards for PreToolUse") && err.contains("no runnable Node command"), "{err}");
    assert!(!mark.exists(), "missing script should be classified before spawning node");
}

#[test]
fn a_non_guard_event_with_missing_node_scripts_skips_and_logs_without_spawning_node() {
    let e = Env::new("missing-script-nonguard");
    let mark = e.dir.join("fake-node-ran");
    let body = format!(r#": > {}; echo MODULE_NOT_FOUND >&2; exit 1"#, mark.display());
    let bin = e.fake_node(&body);
    let empty_root = e.dir.join("empty-plugin");
    std::fs::create_dir_all(&empty_root).unwrap();
    let p = serde_json::json!({"session_id": "e2e", "cwd": e.dir, "hook_event_name": "SessionStart", "source": "startup"}).to_string();
    let (code, out, err) = e.run_with(
        &["hook", "--event", "SessionStart"],
        true,
        &p,
        false,
        &[("CLAUDE_PLUGIN_ROOT", empty_root.to_str().unwrap()), ("PATH", bin.to_str().unwrap())],
    );

    assert_eq!((code, out.as_str()), (0, ""), "{err}");
    assert!(err.contains("skipped SessionStart Node hook") && err.contains("no runnable Node command"), "{err}");
    assert!(!mark.exists(), "missing scripts should be skipped before spawning node");
    let log = std::fs::read_to_string(e.state().join(ah_engine::health::log_name())).unwrap();
    assert!(log.contains("dispatch_defer") && log.contains("skipped"), "{log}");
}

#[test]
fn a_guard_node_module_resolution_exit_one_is_unrunnable_but_own_exit_one_is_not() {
    let e = Env::new("module-resolution");
    let script = e.dir.join("hook.js");
    std::fs::write(&script, "// exists for preflight").unwrap();
    let bin = e.fake_node("echo MODULE_NOT_FOUND fake >&2; exit 1");
    let cmd = format!("node \"{}\"", script.display());
    let map = pretool_map(&e, &[("command-guard", &cmd)], "true");
    let args = ["hook", "--event", "PreToolUse", "--fallback-map", map.to_str().unwrap()];
    let (code, out, err) = e.run_with(&args, true, &bash("ls", &e.dir), true, &[("PATH", bin.to_str().unwrap())]);
    assert_eq!((code, out.as_str()), (2, ""), "{err}");
    assert!(err.contains("could not run the guards for PreToolUse"), "{err}");

    let bin = e.fake_node("echo OWN_REASON >&2; exit 1");
    let (code, out, err) = e.run_with(&args, true, &bash("ls", &e.dir), true, &[("PATH", bin.to_str().unwrap())]);
    assert_eq!((code, out.as_str()), (1, ""), "{err}");
    assert_eq!(err, "OWN_REASON\n");
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
    let map = e.map(&[("merge-gate", CTX_MERGE_GATE), ("api-guard", "echo plain text; echo warn >&2")]);
    let args = ["hook", "--event", "PreToolUse", "--fallback-map", map.to_str().unwrap()];
    let (code, out, err) = e.run(&args, true, &bash("ls", &e.dir), true);
    assert_eq!(code, 0);
    // the JSON keeps stdout (the host reads stdout as one object or as text); the plain text goes to stderr after the warning
    assert_eq!(out, format!("{}\n", r#"{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"from merge-gate"}}"#));
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
    let map = e.map(&[("merge-side-pick", a.as_str()), ("merge-gate", b.as_str()), ("api-guard", c.as_str())]);
    let args = ["hook", "--event", "PreToolUse", "--fallback-map", map.to_str().unwrap()];
    let (code, out, err) = e.run(&args, true, &bash("ls", &e.dir), true);
    assert_eq!((code, err.as_str()), (0, ""));
    let v: serde_json::Value = serde_json::from_str(out.trim()).expect("one JSON object");
    assert_eq!(v["hookSpecificOutput"]["permissionDecision"], "ask", "the decision survives the join");
    assert_eq!(v["hookSpecificOutput"]["additionalContext"].as_str().map(|c| c.chars().count()), Some(3 * 4000 + 2 * 2));
    let log = std::fs::read_to_string(e.state().join("ah-engine.log")).unwrap_or_default();
    assert_eq!(log.matches("dispatch_context_over_cap").count(), 1, "{log}");
    // two of them fit joined: delivered as one, nothing logged
    let map = e.map(&[("merge-side-pick", a.as_str()), ("merge-gate", b.as_str())]);
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
fn sessionstart_over_stdin_cap_reaches_node_hook_without_truncation() {
    let e = Env::new("stdin-full");
    let map = session_map(&e, "wc -c", "true");
    let args = ["hook", "--event", "SessionStart", "--fallback-map", map.to_str().unwrap()];
    let max = ah_engine::defaults::num("client.max_stdin") as usize;
    let payload = session_payload_len(max + 4097);
    let (code, out, err) = e.run(&args, true, &payload, true);
    assert_eq!(code, 0, "{err}");
    assert_eq!(out.trim().parse::<usize>().unwrap(), payload.len());
    assert_eq!(payload.len(), 8_392_705);
    assert!(e.dispatch_temp_files().is_empty(), "temp payload files left behind: {:?}", e.dispatch_temp_files());
}

#[test]
fn dispatcher_stdin_temp_file_is_removed_after_hook_timeout() {
    let e = Env::new("stdin-timeout");
    let map = session_map(&e, "sleep 30", "true");
    let args = ["hook", "--event", "SessionStart", "--fallback-map", map.to_str().unwrap()];
    let payload = session_payload_len(ah_engine::defaults::num("client.max_stdin") as usize + 1);
    let (code, _, err) = e.run_with(&args, true, &payload, true, &[("AH_ENGINE_DISPATCH_MAX_TIMEOUT_S", "1")]);
    assert_eq!(code, 0, "{err}");
    assert!(e.dispatch_temp_files().is_empty(), "temp payload files left behind: {:?}", e.dispatch_temp_files());
}

#[test]
fn over_cap_pretooluse_exit0_runs_node_with_the_full_stdin() {
    let e = Env::new("stdin-pretool-allow");
    let mark = e.dir.join("bytes");
    let map = event_map(&e, "PreToolUse", r#"wc -c > "$AH_TEST_MARK""#, "true");
    let args = ["hook", "--event", "PreToolUse", "--fallback-map", map.to_str().unwrap()];
    let payload = pretool_payload_len(ah_engine::defaults::num("client.max_stdin") as usize + 4097);
    let (code, out, err) = e.run_with(&args, true, &payload, true, &[("AH_TEST_MARK", mark.to_str().unwrap())]);
    assert_eq!((code, out.as_str(), err.as_str()), (0, "", ""));
    assert_eq!(std::fs::read_to_string(&mark).unwrap().trim().parse::<usize>().unwrap(), payload.len());
    assert!(e.dispatch_temp_files().is_empty(), "temp payload files left behind: {:?}", e.dispatch_temp_files());
}

#[test]
fn over_cap_pretooluse_exit2_preserves_node_output() {
    let e = Env::new("stdin-pretool-block");
    let mark = e.dir.join("ran");
    let map = event_map(&e, "PreToolUse", r#"touch "$AH_TEST_MARK"; echo NODEBLOCK >&2; exit 2"#, "true");
    let args = ["hook", "--event", "PreToolUse", "--fallback-map", map.to_str().unwrap()];
    let payload = pretool_payload_len(ah_engine::defaults::num("client.max_stdin") as usize + 4097);
    let (code, out, err) = e.run_with(&args, true, &payload, true, &[("AH_TEST_MARK", mark.to_str().unwrap())]);
    assert_eq!((code, out.as_str()), (2, ""));
    assert!(err.contains("NODEBLOCK"), "{err:?}");
    assert!(mark.exists(), "the Node hook did not run");
    assert!(e.dispatch_temp_files().is_empty(), "temp payload files left behind: {:?}", e.dispatch_temp_files());
}

#[test]
fn over_cap_guard_with_unrunnable_node_hooks_fails_closed() {
    let e = Env::new("stdin-pretool-unrunnable");
    let payload = pretool_payload_len(ah_engine::defaults::num("client.max_stdin") as usize + 4097);
    let (code, out, err) = e.run(&["hook", "--event", "PreToolUse"], true, &payload, false);
    assert_eq!((code, out.as_str()), (2, ""));
    assert!(err.contains("could not run the guards") && err.contains("no runnable Node command"), "{err:?}");
    assert!(e.dispatch_temp_files().is_empty(), "temp payload files left behind: {:?}", e.dispatch_temp_files());
}

#[test]
fn over_cap_stop_active_runs_node_and_unrunnable_failures_are_capped() {
    let e = Env::new("stdin-stop-active");
    let mark = e.dir.join("bytes");
    let map = event_map(&e, "Stop", r#"wc -c > "$AH_TEST_MARK""#, "true");
    let args = ["hook", "--event", "Stop", "--fallback-map", map.to_str().unwrap()];
    let payload = stop_payload_len(ah_engine::defaults::num("client.max_stdin") as usize + 4097);
    let (code, out, err) = e.run_with(&args, true, &payload, true, &[("AH_TEST_MARK", mark.to_str().unwrap())]);
    assert_eq!((code, out.as_str(), err.as_str()), (0, "", ""));
    assert_eq!(std::fs::read_to_string(&mark).unwrap().trim().parse::<usize>().unwrap(), payload.len());

    let broken = event_map(&e, "Stop", "a\0b", "true");
    let args = ["hook", "--event", "Stop", "--fallback-map", broken.to_str().unwrap()];
    let cap = ah_engine::defaults::num("dispatch.stop_block_cap") as usize;
    let codes: Vec<i32> = (0..cap + 2).map(|_| e.run(&args, true, &payload, true).0).collect();
    let expect: Vec<i32> = (0..cap + 2).map(|i| if i < cap { 2 } else { 0 }).collect();
    assert_eq!(codes, expect, "a Stop whose Node hooks cannot run must fail open only after the cap");
    assert!(e.dispatch_temp_files().is_empty(), "temp payload files left behind: {:?}", e.dispatch_temp_files());
}

#[test]
fn stop_active_genuine_node_blocks_have_in_cap_and_over_cap_parity_without_counters() {
    let e = Env::new("stdin-stop-genuine-parity");
    let map = event_map(&e, "Stop", "echo NODEBLOCK >&2; exit 2", "true");
    let args = ["hook", "--event", "Stop", "--fallback-map", map.to_str().unwrap()];
    let max = ah_engine::defaults::num("client.max_stdin") as usize;
    let in_cap = stop_payload_with_padding(max - 1024);
    let over_cap = stop_payload_with_padding(max + 4097);

    let run_results = |payload: &str| -> Vec<(i32, String)> {
        (0..4)
            .map(|_| {
                let (code, out, err) = e.run(&args, true, payload, true);
                assert_eq!(out, "");
                (code, err)
            })
            .collect()
    };
    let in_results = run_results(&in_cap);
    let over_results = run_results(&over_cap);
    let in_codes: Vec<i32> = in_results.iter().map(|(code, _)| *code).collect();
    let over_codes: Vec<i32> = over_results.iter().map(|(code, _)| *code).collect();

    assert_eq!(in_codes, [2, 2, 2, 2], "in-cap genuine Stop blocks pass through");
    assert_eq!(over_codes, in_codes, "same semantic Stop payload must behave the same across the stdin cap");
    for (code, err) in in_results.iter().chain(over_results.iter()) {
        assert_eq!(*code, 2);
        assert!(err.contains("NODEBLOCK"), "genuine Node block stderr must pass through: {err:?}");
    }
    assert_no_stop_counters(&e);
}

fn tool_last_pretool_payload(len: usize, tool: &str, decoy: &str) -> String {
    let prefix = format!(
        r#"{{"session_id":"e2e","cwd":".","hook_event_name":"PreToolUse","tool_input":{{"command":"true","nested":{{"tool_name":"{decoy}"}},"prompt":"\"tool_name\":\"{decoy}\""}},"padding":""#
    );
    let suffix = format!(r#"","tool_name":"{tool}"}}"#);
    assert!(len >= prefix.len() + suffix.len());
    let mut p = String::with_capacity(len);
    p.push_str(&prefix);
    p.extend(std::iter::repeat_n('x', len - prefix.len() - suffix.len()));
    p.push_str(&suffix);
    p
}

fn assert_over_cap_bash_payload_does_not_run_agent_only_guard(e: &Env, payload: &str, extra_args: &[&str], ctx: &str) {
    let map = pretool_map(e, &[("model-routing-guard", "echo AGENT BLOCK >&2; exit 2")], "true");
    let mut args = vec!["hook", "--event", "PreToolUse", "--fallback-map", map.to_str().unwrap()];
    args.extend_from_slice(extra_args);
    let (code, out, err) = e.run(&args, true, payload, true);
    assert_eq!((code, out.as_str(), err.as_str()), (0, "", ""), "{ctx}: Agent-only guard was selected");
}

fn assert_over_cap_scan_failure_selects_all(e: &Env, payload: &str, ctx: &str) {
    let map = pretool_map(e, &[("model-routing-guard", "echo AGENT BLOCK >&2; exit 2")], "true");
    let args = ["hook", "--event", "PreToolUse", "--fallback-map", map.to_str().unwrap()];
    let (code, out, err) = e.run(&args, true, payload, true);
    assert_eq!((code, out.as_str()), (2, ""), "{ctx}: scan failure must select all entries");
    assert!(err.contains("AGENT BLOCK"), "{ctx}: Agent-only guard did not run: {err}");
}

#[test]
fn over_cap_pretooluse_derives_top_level_tool_name_when_tool_flag_is_omitted() {
    let e = Env::new("stdin-tool-scan");
    let max = ah_engine::defaults::num("client.max_stdin") as usize;
    let nested_decoy = pretool_payload_with_padding(max + 4097, "Bash", serde_json::json!({"command": "true", "tool_name": "Agent"}));
    let prompt_decoy =
        pretool_payload_with_padding(max + 4097, "Bash", serde_json::json!({"command": "true", "prompt": "literal \"tool_name\":\"Agent\" text"}));
    let escaped_quote_decoy = pretool_payload_with_padding(max + 4097, "Bash", serde_json::json!({"command": "printf '\\\"tool_name\\\":\\\"Agent\\\"'"}));
    let tool_last = tool_last_pretool_payload(8 * 1024 * 1024 + 256, "Bash", "Agent");

    for (ctx, payload) in [
        ("nested tool_name decoy", nested_decoy),
        ("prompt text tool_name decoy", prompt_decoy),
        ("escaped quote decoy", escaped_quote_decoy),
        ("tool_name last after stdin cap", tool_last),
    ] {
        assert!(payload.len() > max, "{ctx} payload must exercise the over-cap path");
        assert_over_cap_bash_payload_does_not_run_agent_only_guard(&e, &payload, &[], ctx);
    }
}

#[test]
fn over_cap_pretooluse_scan_failure_selects_all_entries() {
    let e = Env::new("stdin-tool-scan-fallback");
    let max = ah_engine::defaults::num("client.max_stdin") as usize;
    let duplicate = format!(
        r#"{{"session_id":"e2e","cwd":".","hook_event_name":"PreToolUse","tool_name":"Bash","padding":"{}","tool_name":"Agent","tool_input":{{"command":"true"}}}}"#,
        "x".repeat(max + 1)
    );
    let non_string = format!(
        r#"{{"session_id":"e2e","cwd":".","hook_event_name":"PreToolUse","tool_name":123,"padding":"{}","tool_input":{{"command":"true"}}}}"#,
        "x".repeat(max + 1)
    );

    assert_over_cap_scan_failure_selects_all(&e, &duplicate, "duplicate differing top-level tool_name");
    assert_over_cap_scan_failure_selects_all(&e, &non_string, "non-string top-level tool_name");
}

#[test]
fn explicit_tool_flag_wins_over_over_cap_payload_tool_name() {
    let e = Env::new("stdin-tool-explicit");
    let payload = tool_last_pretool_payload(ah_engine::defaults::num("client.max_stdin") as usize + 4097, "Agent", "Bash");
    assert_over_cap_bash_payload_does_not_run_agent_only_guard(&e, &payload, &["--tool", "Bash"], "explicit --tool Bash");
}

#[test]
fn small_payloads_do_not_need_a_usable_spool_dir() {
    let e = Env::new("stdin-small-state-file");
    let state_file = e.dir.join("not-a-state-dir");
    std::fs::write(&state_file, "not a dir").unwrap();

    let mark = e.dir.join("pretool-ran");
    let map = e.map(&[("command-guard", r#"wc -c > "$AH_TEST_MARK""#)]);
    let args = ["hook", "--event", "PreToolUse", "--fallback-map", map.to_str().unwrap()];
    let payload = bash("ls", &e.dir);
    let (code, out, err) =
        e.run_with(&args, true, &payload, true, &[("AH_ENGINE_DIR", state_file.to_str().unwrap()), ("AH_TEST_MARK", mark.to_str().unwrap())]);
    assert_eq!((code, out.as_str(), err.as_str()), (0, "", ""));
    assert_eq!(std::fs::read_to_string(&mark).unwrap().trim().parse::<usize>().unwrap(), payload.len());

    let mark = e.dir.join("session-ran");
    let map = session_map(&e, r#"wc -c > "$AH_TEST_MARK""#, "true");
    let args = ["hook", "--event", "SessionStart", "--fallback-map", map.to_str().unwrap()];
    let payload = serde_json::json!({"session_id": "e2e", "cwd": e.dir, "hook_event_name": "SessionStart", "source": "startup"}).to_string();
    let (code, out, err) =
        e.run_with(&args, true, &payload, true, &[("AH_ENGINE_DIR", state_file.to_str().unwrap()), ("AH_TEST_MARK", mark.to_str().unwrap())]);
    assert_eq!((code, out.as_str(), err.as_str()), (0, "", ""));
    assert_eq!(std::fs::read_to_string(&mark).unwrap().trim().parse::<usize>().unwrap(), payload.len());
}

#[test]
fn over_cap_payload_with_regular_file_spool_dir_follows_event_fail_mode() {
    let e = Env::new("stdin-overcap-state-file");
    let state = e.dir.join("not-a-state-dir");
    std::fs::write(&state, "not a dir").unwrap();
    assert_over_cap_spool_failure_modes(&e, &state, "regular file");
}

#[test]
fn over_cap_payload_with_uncreatable_spool_dir_follows_event_fail_mode() {
    let e = Env::new("stdin-overcap-uncreatable-state");
    let parent = e.dir.join("no-write-parent");
    std::fs::create_dir_all(&parent).unwrap();
    std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o500)).unwrap();
    let state = parent.join("state");
    assert_over_cap_spool_failure_modes(&e, &state, "uncreatable dir");
    std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o700)).unwrap();
}

fn assert_over_cap_spool_failure_modes(e: &Env, state: &Path, ctx: &str) {
    let mark = e.dir.join("pretool-ran");
    let map = e.map(&[("command-guard", r#"touch "$AH_TEST_MARK""#)]);
    let args = ["hook", "--event", "PreToolUse", "--fallback-map", map.to_str().unwrap()];
    let payload = pretool_payload_len(ah_engine::defaults::num("client.max_stdin") as usize + 4097);
    let (code, out, err) = e.run_with(&args, true, &payload, true, &[("AH_ENGINE_DIR", state.to_str().unwrap()), ("AH_TEST_MARK", mark.to_str().unwrap())]);
    assert_eq!((code, out.as_str()), (2, ""), "{ctx}: {err:?}");
    assert!(err.contains("could not run the guards") && err.contains("payload"), "{ctx}: {err:?}");
    assert!(!mark.exists(), "{ctx}: Node must not run without the full payload");

    let mark = e.dir.join("session-ran");
    let map = session_map(e, r#"touch "$AH_TEST_MARK""#, "true");
    let args = ["hook", "--event", "SessionStart", "--fallback-map", map.to_str().unwrap()];
    let payload = session_payload_len(ah_engine::defaults::num("client.max_stdin") as usize + 4097);
    let (code, out, err) = e.run_with(&args, true, &payload, true, &[("AH_ENGINE_DIR", state.to_str().unwrap()), ("AH_TEST_MARK", mark.to_str().unwrap())]);
    assert_eq!((code, out.as_str()), (0, ""), "{ctx}: {err:?}");
    assert!(err.contains("skipped SessionStart Node hooks") && err.contains("dispatch_spool_unavailable"), "{ctx}: {err:?}");
    assert!(!mark.exists(), "{ctx}: Node must not run without the full payload");
}

#[test]
fn over_cap_guard_payload_fails_closed_when_anonymous_spool_write_fails() {
    let e = Env::new("stdin-spool-write-guard");
    let mark = e.dir.join("pretool-ran");
    let map = e.map(&[("command-guard", r#"touch "$AH_TEST_MARK""#)]);
    let args = ["hook", "--event", "PreToolUse", "--fallback-map", map.to_str().unwrap()];
    let payload = pretool_payload_len(ah_engine::defaults::num("client.max_stdin") as usize + 4097);
    let (code, out, err) = e.run_with_file_size_limit(&args, true, &payload, true, &[("AH_TEST_MARK", mark.to_str().unwrap())], 1024 * 1024);

    assert_eq!((code, out.as_str()), (2, ""), "{err:?}");
    assert!(err.contains("could not run the guards") && err.contains("could not be spooled"), "{err:?}");
    assert!(!mark.exists(), "Node must not run after the anonymous payload spool write fails");
    assert!(e.dispatch_temp_files().is_empty(), "temp payload files left behind: {:?}", e.dispatch_temp_files());
}

#[test]
fn over_cap_non_guard_payload_reports_when_anonymous_spool_write_fails() {
    let e = Env::new("stdin-spool-write-session");
    let mark = e.dir.join("session-ran");
    let map = session_map(&e, r#"touch "$AH_TEST_MARK""#, "true");
    let args = ["hook", "--event", "SessionStart", "--fallback-map", map.to_str().unwrap()];
    let payload = session_payload_len(ah_engine::defaults::num("client.max_stdin") as usize + 4097);
    let (code, out, err) = e.run_with_file_size_limit(&args, true, &payload, true, &[("AH_TEST_MARK", mark.to_str().unwrap())], 1024 * 1024);

    assert_eq!((code, out.as_str()), (0, ""), "{err:?}");
    assert!(err.contains("skipped SessionStart Node hooks") && err.contains("could not be spooled"), "{err:?}");
    let log = std::fs::read_to_string(e.state().join(ah_engine::health::log_name())).unwrap();
    assert!(log.contains("dispatch_spool_unavailable"), "{log}");
    assert!(!mark.exists(), "Node must not run after the anonymous payload spool write fails");
    assert!(e.dispatch_temp_files().is_empty(), "temp payload files left behind: {:?}", e.dispatch_temp_files());
}

fn wait_for(path: &Path, within: Duration) {
    let start = Instant::now();
    while start.elapsed() < within {
        if path.exists() {
            return;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("timed out waiting for {}", path.display());
}

fn kill_hook_group(pid_file: &Path) {
    if let Ok(pid) = std::fs::read_to_string(pid_file).map(|s| s.trim().parse::<i32>().unwrap()) {
        unsafe {
            libc::killpg(pid, libc::SIGKILL);
            libc::kill(pid, libc::SIGKILL);
        }
    }
}

fn killed_dispatcher_leaves_no_spool_file(signal: i32, tag: &str) {
    let e = Env::new(tag);
    let hook_pid = e.dir.join("hook.pid");
    let cmd = format!(r#"echo $$ > {}; exec sleep 30"#, hook_pid.display());
    let map = session_map(&e, &cmd, "true");
    let args = ["hook", "--event", "SessionStart", "--fallback-map", map.to_str().unwrap()];
    let payload = session_payload_len(ah_engine::defaults::num("client.max_stdin") as usize + 4097);
    let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
    c.args(args)
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("HOME", e.dir.join("home"))
        .env("AH_ENGINE_DIR", e.state())
        .env("AH_ENGINE_VERSION", "dispatch-e2e")
        .env("AH_ENGINE_DISPATCH_IN_PROCESS", "1")
        .env("CLAUDE_PLUGIN_ROOT", &e.dir)
        .current_dir(&e.dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = c.spawn().unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let writer = std::thread::spawn(move || stdin.write_all(payload.as_bytes()));
    wait_for(&hook_pid, Duration::from_secs(10));
    unsafe {
        libc::kill(child.id() as libc::pid_t, signal);
    }
    let _ = child.wait();
    let _ = writer.join();
    kill_hook_group(&hook_pid);
    assert!(e.dispatch_temp_files().is_empty(), "{tag}: temp payload files left behind: {:?}", e.dispatch_temp_names());
}

#[test]
fn anonymous_stdin_spool_disappears_after_sigterm() {
    killed_dispatcher_leaves_no_spool_file(libc::SIGTERM, "stdin-sigterm");
}

#[test]
fn anonymous_stdin_spool_disappears_after_sigkill() {
    killed_dispatcher_leaves_no_spool_file(libc::SIGKILL, "stdin-sigkill");
}

#[test]
fn startup_sweep_removes_only_stale_dispatch_stdin_files() {
    let e = Env::new("stdin-sweep");
    std::fs::create_dir_all(e.state()).unwrap();
    let stale = e.state().join("dispatch-stdin-1000-2000-0.tmp");
    let fresh = e.state().join("dispatch-stdin-1000-2000-1.tmp");
    let other = e.state().join("other.tmp");
    std::fs::write(&stale, "old").unwrap();
    std::fs::write(&fresh, "new").unwrap();
    std::fs::write(&other, "other").unwrap();
    let stale_age = Duration::from_secs(ah_engine::defaults::num("dispatch.spool_stale_s") + 1);
    std::fs::File::options().write(true).open(&stale).unwrap().set_modified(std::time::SystemTime::now() - stale_age).unwrap();
    #[cfg(unix)]
    {
        let link = e.state().join("dispatch-stdin-1000-2000-2.tmp");
        std::os::unix::fs::symlink(&stale, &link).unwrap();
    }

    let map = session_map(&e, "true", "true");
    let args = ["hook", "--event", "SessionStart", "--fallback-map", map.to_str().unwrap()];
    let payload = serde_json::json!({"session_id": "e2e", "cwd": e.dir, "hook_event_name": "SessionStart", "source": "startup"}).to_string();
    assert_eq!(e.run(&args, true, &payload, true).0, 0);
    assert!(!stale.exists(), "stale dispatch stdin file was not swept");
    assert!(fresh.exists(), "fresh dispatch stdin file should be kept");
    assert!(other.exists(), "non-matching file should be kept");
    #[cfg(unix)]
    assert!(std::fs::symlink_metadata(e.state().join("dispatch-stdin-1000-2000-2.tmp")).is_ok(), "symlink should be kept");
}

#[test]
fn over_cap_payload_feeder_handles_slow_reader() {
    let e = Env::new("stdin-slow-reader");
    let mark = e.dir.join("ran");
    let map = session_map(&e, r#"(dd bs=65536 count=1 2>/dev/null; sleep 1; cat) | wc -c > "$AH_TEST_MARK""#, "true");
    let args = ["hook", "--event", "SessionStart", "--fallback-map", map.to_str().unwrap()];
    let payload = session_payload_len(ah_engine::defaults::num("client.max_stdin") as usize + 4097);
    let (code, out, err) = e.run_with(&args, true, &payload, true, &[("AH_TEST_MARK", mark.to_str().unwrap())]);
    assert_eq!((code, out.as_str(), err.as_str()), (0, "", ""));
    assert_eq!(std::fs::read_to_string(&mark).unwrap().trim().parse::<usize>().unwrap(), payload.len());
    assert!(e.dispatch_temp_files().is_empty(), "temp payload files left behind: {:?}", e.dispatch_temp_files());
}

#[test]
fn dispatcher_stdin_cap_boundaries_are_exact() {
    let e = Env::new("stdin-boundaries");
    let map = session_map(&e, "wc -c", "true");
    let args = ["hook", "--event", "SessionStart", "--fallback-map", map.to_str().unwrap()];
    let max = ah_engine::defaults::num("client.max_stdin") as usize;
    for len in [max, max + 1] {
        let payload = session_payload_len(len);
        let (code, out, err) = e.run(&args, true, &payload, true);
        assert_eq!(code, 0, "{len}: {err}");
        assert_eq!(out.trim().parse::<usize>().unwrap(), len);
    }

    let map = e.map(&[]);
    let args = ["hook", "--event", "PreToolUse", "--fallback-map", map.to_str().unwrap()];
    assert_eq!(e.run(&args, true, &pretool_payload_len(max), true).0, 0);
    let map = event_map(&e, "PreToolUse", "true", "true");
    let args = ["hook", "--event", "PreToolUse", "--fallback-map", map.to_str().unwrap()];
    let (code, out, err) = e.run(&args, true, &pretool_payload_len(max + 1), true);
    assert_eq!((code, out.as_str(), err.as_str()), (0, "", ""));
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

#[test]
fn a_finished_hooks_genuine_block_survives_a_check_whose_node_command_cannot_run() {
    let e = Env::new("deferred-block");
    // compact-declaration-guard has no runnable Node command, and with no daemon (NOSPAWN) its built-in check defers; merge-gate is a Node
    // hook that ran, finished and blocked: its block must be handed back, not replaced by the generic fail-closed text
    let map = e.map(&[("compact-declaration-guard", ""), ("merge-gate", "echo sibling-blocks >&2; exit 2")]);
    let args = ["hook", "--event", "PreToolUse", "--fallback-map", map.to_str().unwrap()];
    let (code, out, err) = e.run_with(&args, false, &bash("ls", &e.dir), true, &[("AH_ENGINE_NOSPAWN", "1")]);
    assert_eq!(code, 2, "{out:?} {err:?}");
    assert!(err.contains("sibling-blocks"), "the finished hook's own block text: {err:?}");
}
