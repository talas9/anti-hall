//! D58 end to end: the real binary as `ah-engine hook --event PreToolUse`, with the Node hooks replaced by small shell
//! commands through `--fallback-map`, so each property is checked without Node. Every test uses its own HOME and state
//! directory and reaps any daemon it starts.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use crate::common;

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
        ah_engine::discard::harmless(std::fs::remove_dir_all(&dir));
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

    fn spawn_map(&self) -> PathBuf {
        let m: serde_json::Map<String, serde_json::Value> =
            ["compact-declaration-guard", "swarm-guard", "phase-tracker", "swarm-guard#2", "phase-tracker#2", "orch-on-spawn"]
                .into_iter()
                .map(|id| (id.to_string(), "true".into()))
                .collect();
        let p = self.dir.join("spawn-map.json");
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
            // the codex-availability check probes PATH for a `codex` binary and answers with a context line when it finds one;
            // these tests drive the mapped Node commands only
            .env("PATH", path_without_codex())
            .env("HOME", self.dir.join("home"))
            .env("AH_ENGINE_DIR", self.state())
            .env("AH_ENGINE_VERSION", "dispatch-e2e")
            .env("ANTIHALL_JEV_RECOMMEND_NOTICE", "false") // the session gate answers the notice itself; these tests probe the Node fallback
            .env("AH_ENGINE_DISPATCH_IN_PROCESS", if in_process { "1" } else { "0" })
            // DevSwarm active makes the native verify-first-orch check defer to its mapped Node command, so the
            // SessionStart tests below keep driving Node hooks only (the check itself is covered by spawn_ctx_parity.rs)
            .env("DEVSWARM_REPO_ID", "e2e")
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
            // the codex-availability check probes PATH for a `codex` binary and answers with a context line when it finds one;
            // these tests drive the mapped Node commands only
            .env("PATH", path_without_codex())
            .env("HOME", self.dir.join("home"))
            .env("AH_ENGINE_DIR", self.state())
            .env("AH_ENGINE_VERSION", "dispatch-e2e")
            .env("AH_ENGINE_DISPATCH_IN_PROCESS", if in_process { "1" } else { "0" })
            // DevSwarm active makes the native verify-first-orch check defer to its mapped Node command, so the
            // SessionStart tests below keep driving Node hooks only (the check itself is covered by spawn_ctx_parity.rs)
            .env("DEVSWARM_REPO_ID", "e2e")
            .current_dir(&self.dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if root {
            c.env("CLAUDE_PLUGIN_ROOT", &self.dir);
        }
        c.envs(extra.iter().copied());
        // SAFETY: the closure runs between fork and exec and calls only `signal` and `setrlimit`, both async-signal-safe; it allocates nothing.
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
            ah_engine::discard::harmless(
                Command::new(env!("CARGO_BIN_EXE_ah-engine")).arg("stop").env("AH_ENGINE_DIR", &st).env("HOME", self.dir.join("home")).output(),
            );
        });
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        ah_engine::discard::harmless(std::fs::remove_dir_all(&self.dir));
    }
}

fn bash(cmd: &str, cwd: &Path) -> String {
    serde_json::json!({"session_id": "e2e", "cwd": cwd, "hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": cmd}}).to_string()
}

/// A Bash payload on which the built-in `merge-gate` and `api-guard` checks both defer to their Node hooks, which these
/// tests replace with shell stand-ins: an auto-merge command that names a code file, with the gate switched on in the
/// test home and a RELATIVE transcript path (Node resolves it against its own working directory, so the engine's merge-gate
/// always leaves it to the Node hook; the gate's other deferrals went native with the Jev port).
fn node_only_bash(e: &Env) -> String {
    let home = e.dir.join("home");
    std::fs::create_dir_all(home.join(".anti-hall")).unwrap();
    std::fs::write(home.join(".anti-hall/settings.json"), r#"{"guards":{"mergeGate":true}}"#).unwrap();
    let tp = "hedged.jsonl";
    serde_json::json!({"session_id": "e2e", "cwd": e.dir, "hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": "gh pr merge 1 # a.py"}, "transcript_path": tp})
        .to_string()
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

/// The test process's PATH minus every directory that holds a `codex` binary.
fn path_without_codex() -> String {
    let path = std::env::var("PATH").unwrap_or_default();
    path.split(':').filter(|d| !d.is_empty() && !std::path::Path::new(d).join("codex").exists()).collect::<Vec<_>>().join(":")
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
    // `first` goes to the first entry that always runs its Node hook: an entry a built-in check answers never runs one.
    let entries = ah_engine::dispatch::table::entries("claude", event);
    let first_node = entries.iter().position(|x| x.check.is_none()).unwrap_or(0);
    let ids: Vec<String> = entries.into_iter().map(|x| x.id).collect();
    let m: serde_json::Map<String, serde_json::Value> =
        ids.iter().enumerate().map(|(i, id)| (id.clone(), if i == first_node { first } else { rest }.into())).collect();
    let map = e.dir.join(format!("{event}-map.json"));
    let mut events = serde_json::Map::new();
    events.insert(event.to_string(), serde_json::Value::Object(m));
    std::fs::write(&map, serde_json::Value::Object(events).to_string()).unwrap();
    map
}

/// A map giving `command` to the entry `id` and `true` to every other entry.
fn event_map_for(e: &Env, event: &str, id: &str, command: &str) -> PathBuf {
    let ids: Vec<String> = ah_engine::dispatch::table::entries("claude", event).into_iter().map(|x| x.id).collect();
    let m: serde_json::Map<String, serde_json::Value> = ids.iter().map(|i| (i.clone(), if i == id { command } else { "true" }.into())).collect();
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
    let (code, out, err) = e.run(&args, true, &node_only_bash(&e), true);
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

/// The three agent controls are answered by the dispatcher itself: their Node commands (which would print `NODE-RAN`) are
/// never run, an ask-guard block carries Node's exact bytes (the JSON decision on stdout, exit 2, nothing on stderr), and the
/// answer is the same in process and through the daemon.
#[test]
fn the_agent_controls_are_answered_by_the_dispatcher() {
    let e = Env::new("agent-controls");
    let ran = r#"printf NODE-RAN >&2; exit 0"#;
    let map = pretool_map(&e, &[("ask-guard", ran), ("stale-agent-stop-note", ran)], "true");
    let args = ["hook", "--event", "PreToolUse", "--fallback-map", map.to_str().unwrap()];
    let ask = serde_json::json!({"session_id": "e2e", "cwd": e.dir, "hook_event_name": "PreToolUse", "tool_name": "AskUserQuestion", "tool_input": {"questions": [{"header": "h", "question": "q"}]}}).to_string();
    let env = [("ANTIHALL_NO_BLOCKING_QUESTIONS", "block")];
    let (code, out, err) = e.run_with(&args, true, &ask, true, &env);
    assert_eq!(code, 2, "in-process: {out:?} {err:?}");
    assert!(out.starts_with("{\"decision\":\"block\",\"reason\":\"") && out.ends_with("\"}\n") && !err.contains("NODE-RAN"), "{out:?} {err:?}");
    let mut last = (0, String::new(), String::new());
    for _ in 0..50 {
        last = e.run_with(&args, false, &ask, true, &env);
        if last.0 == 2 {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    assert_eq!((last.0, last.1.as_str()), (2, out.as_str()), "daemon: the same block, byte for byte: {last:?}");
    assert!(!last.2.contains("NODE-RAN"));
    // TaskStop with nothing in the transcript to say: answered quietly, Node not run
    let stop = serde_json::json!({"session_id": "e2e", "cwd": e.dir, "hook_event_name": "PreToolUse", "tool_name": "TaskStop", "tool_input": {"task_id": "x"}, "transcript_path": e.dir.join("none.jsonl")}).to_string();
    let (code, out, err) = e.run(&args, true, &stop, true);
    assert_eq!((code, out.as_str(), err.as_str()), (0, "", ""), "the stale-agent-stop-note entry is answered by the check");
    // Stop: a session with no transcript has nothing silent; silent-agent-nudge is answered by the check
    let ids: Vec<String> = ah_engine::dispatch::table::entries("claude", "Stop").into_iter().map(|x| x.id).collect();
    let m: serde_json::Map<String, serde_json::Value> =
        ids.iter().map(|id| (id.clone(), if id == "silent-agent-nudge" { ran } else { "true" }.into())).collect();
    let map = e.dir.join("stop-map.json");
    std::fs::write(&map, serde_json::json!({ "Stop": m }).to_string()).unwrap();
    let stop_args = ["hook", "--event", "Stop", "--fallback-map", map.to_str().unwrap()];
    let stop_payload = serde_json::json!({"session_id": "e2e", "cwd": e.dir, "hook_event_name": "Stop"}).to_string();
    let (code, out, err) = e.run(&stop_args, true, &stop_payload, true);
    assert_eq!((code, out.as_str(), err.as_str()), (0, "", ""), "silent-agent-nudge is answered by the check, not run as Node");
    // Stop with a background agent silent for 90 minutes: the check nudges itself (the dispatcher hands it the plugin root)
    let ts =
        ah_engine::checks::agent_scan::iso_utc((std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() - 5_400_000) as f64);
    let launch = serde_json::json!({"type": "user", "message": {"role": "user", "content": [{"tool_use_id": "tu_1", "type": "tool_result", "content": [{"type": "text", "text": "Async agent launched successfully.\nagentId: a1b2c3d4e5f601 (x)\noutput_file: /nonexistent/out.txt\n"}]}]}, "timestamp": ts});
    let transcript = e.dir.join("silent.jsonl");
    std::fs::write(&transcript, format!("{launch}\n")).unwrap();
    let silent = serde_json::json!({"session_id": "e2e", "cwd": e.dir, "hook_event_name": "Stop", "transcript_path": transcript}).to_string();
    let (code, out, err) = e.run(&stop_args, true, &silent, true);
    e.stop();
    assert_eq!(code, 0, "{out:?} {err:?}");
    assert!(
        out.starts_with("{\"decision\":\"block\",\"reason\":\"") && out.contains("silent-agent-nudge: 1 of your own") && !err.contains("NODE-RAN"),
        "{out:?} {err:?}"
    );
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
    // review finding 16: an unreadable map and a usage error are install faults, not verdicts: the Node hooks decide (75)
    let defer = ah_engine::defaults::num("dispatch.defer_exit") as i32;
    let (code, out, err) = e.run(&args, true, &bash("ls", &e.dir), true);
    assert_eq!((code, out.as_str()), (defer, ""), "{err}");
    assert!(err.contains("cannot read the fallback map") && err.contains("the Node hooks decide"), "{err}");
    // a usage error on a guard event does not exit 64 (a non-blocking error the host reads as an allow)
    let (code, _, err) = e.run(&["hook", "--event", "PreToolUse", "--host", "nope"], true, &bash("ls", &e.dir), true);
    assert_eq!(code, defer, "{err}");
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
    // SessionEnd: its only hook (the MCP reaper) has no built-in check, so a missing script is skipped and logged there
    let e = Env::new("missing-script-nonguard");
    let mark = e.dir.join("fake-node-ran");
    let body = format!(r#": > {}; echo MODULE_NOT_FOUND >&2; exit 1"#, mark.display());
    let bin = e.fake_node(&body);
    let empty_root = e.dir.join("empty-plugin");
    std::fs::create_dir_all(&empty_root).unwrap();
    let p = serde_json::json!({"session_id": "e2e", "cwd": e.dir, "hook_event_name": "SessionEnd", "reason": "other"}).to_string();
    let (code, out, err) = e.run_with(
        &["hook", "--event", "SessionEnd"],
        true,
        &p,
        false,
        &[("CLAUDE_PLUGIN_ROOT", empty_root.to_str().unwrap()), ("PATH", bin.to_str().unwrap())],
    );

    assert_eq!((code, out.as_str()), (0, ""), "{err}");
    assert!(err.contains("skipped SessionEnd Node hook") && err.contains("no runnable Node command"), "{err}");
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
    let (code, out, err) = e.run_with(&args, true, &bash("npm test", &e.dir), true, &[("PATH", bin.to_str().unwrap())]);
    assert_eq!((code, out.as_str()), (2, ""), "{err}");
    assert!(err.contains("could not run the guards for PreToolUse"), "{err}");

    let bin = e.fake_node("echo OWN_REASON >&2; exit 1");
    let (code, out, err) = e.run_with(&args, true, &bash("npm test", &e.dir), true, &[("PATH", bin.to_str().unwrap())]);
    assert_eq!((code, out.as_str()), (1, ""), "{err}");
    assert_eq!(err, "OWN_REASON\n");
}

#[test]
fn unparsable_spawn_payload_blocks_only_when_node_cannot_run_model_routing() {
    let e = Env::new("mr-malformed");
    let map = e.spawn_map();
    for tool in ["Agent", "Task"] {
        let args = ["hook", "--event", "PreToolUse", "--tool", tool, "--fallback-map", map.to_str().unwrap()];
        let (code, out, err) = e.run(&args, true, "{bad", false);
        assert_eq!((code, out.as_str()), (2, ""), "{tool}: {out:?} {err:?}");
        assert!(err.contains("model-routing") && err.contains("blocked rather than allowed unguarded"), "{tool}: {err}");
    }
}

/// A payload JS parses but serde_json rejects (a lone surrogate escape) is deferred to Node, never hard-blocked: the
/// engine must not be a worse guard than Node. Only a missing Node command blocks.
#[test]
fn a_payload_only_js_can_parse_is_deferred_to_node_not_blocked() {
    let e = Env::new("mr-surrogate");
    let mut m: serde_json::Map<String, serde_json::Value> =
        ah_engine::dispatch::table::entries("claude", "PreToolUse").into_iter().map(|x| (x.id, "true".into())).collect();
    let node_ok = e.dir.join("node-ok-map.json");
    std::fs::write(&node_ok, serde_json::json!({ "PreToolUse": m.clone() }).to_string()).unwrap();
    m.insert("model-routing-guard".into(), r#"printf '{"decision":"block","reason":"node decided"}\n'; exit 2"#.into());
    m.insert("model-routing-guard#2".into(), r#"printf '{"decision":"block","reason":"node decided"}\n'; exit 2"#.into());
    let node_blocks = e.dir.join("node-blocks-map.json");
    std::fs::write(&node_blocks, serde_json::json!({ "PreToolUse": m }).to_string()).unwrap();
    let agent = r#"{"hook_event_name":"PreToolUse","tool_name":"Agent","session_id":"s","cwd":"/tmp","tool_input":{"model":"sonnet","subagent_type":"general-purpose","prompt":"implement the parser \ud83d"}}"#;
    let bash_p = r#"{"hook_event_name":"PreToolUse","tool_name":"Bash","session_id":"s","cwd":"/tmp","tool_input":{"command":"echo hi \ud83d"}}"#;
    for (tool, payload) in [("Agent", agent), ("Bash", bash_p)] {
        let args = ["hook", "--event", "PreToolUse", "--tool", tool, "--fallback-map", node_ok.to_str().unwrap()];
        let (code, out, err) = e.run(&args, true, payload, true);
        assert_eq!(code, 0, "{tool}: Node allows this payload, so must the dispatcher: {out:?} {err:?}");
        assert!(!err.contains("could not parse"), "{tool}: {err}");
    }
    // and Node's own decision on such a payload is what the host gets
    let args = ["hook", "--event", "PreToolUse", "--tool", "Agent", "--fallback-map", node_blocks.to_str().unwrap()];
    let (code, out, _) = e.run(&args, true, agent, true);
    assert_eq!(code, 2, "{out}");
    assert!(out.contains("node decided"), "{out}");
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
    let (code, out, err) = e.run(&args, true, &node_only_bash(&e), true);
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
    // coordinator-work-guard defers a main-session Bash call to Node (merge-side-pick answers it natively), so its map entry runs
    let map = e.map(&[("coordinator-work-guard", a.as_str()), ("merge-gate", b.as_str()), ("api-guard", c.as_str())]);
    let args = ["hook", "--event", "PreToolUse", "--fallback-map", map.to_str().unwrap()];
    let (code, out, err) = e.run(&args, true, &node_only_bash(&e), true);
    assert_eq!((code, err.as_str()), (0, ""));
    let v: serde_json::Value = serde_json::from_str(out.trim()).expect("one JSON object");
    assert_eq!(v["hookSpecificOutput"]["permissionDecision"], "ask", "the decision survives the join");
    assert_eq!(v["hookSpecificOutput"]["additionalContext"].as_str().map(|c| c.chars().count()), Some(3 * 4000 + 2 * 2));
    let log = std::fs::read_to_string(e.state().join("ah-engine.log")).unwrap_or_default();
    assert_eq!(log.matches("dispatch_context_over_cap").count(), 1, "{log}");
    // two of them fit joined: delivered as one, nothing logged
    let map = e.map(&[("coordinator-work-guard", a.as_str()), ("merge-gate", b.as_str())]);
    let args = ["hook", "--event", "PreToolUse", "--fallback-map", map.to_str().unwrap()];
    assert_eq!(e.run(&args, true, &node_only_bash(&e), true).0, 0);
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

    // a hook the OS will not start is an infrastructure fault (review finding 2): every Stop hands over to the Node hooks
    // (dispatch.defer_exit), never a block, so there is no loop for the cap to bound
    let broken = event_map(&e, "Stop", "a\0b", "true");
    let args = ["hook", "--event", "Stop", "--fallback-map", broken.to_str().unwrap()];
    let cap = ah_engine::defaults::num("dispatch.stop_block_cap") as usize;
    let codes: Vec<i32> = (0..cap + 2).map(|_| e.run(&args, true, &payload, true).0).collect();
    assert_eq!(codes, vec![ah_engine::defaults::num("dispatch.defer_exit") as i32; cap + 2], "a Stop whose Node hook cannot start defers");
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
                // checks down (no daemon, none started): every Stop entry has a built-in check by now, so the mapped Node block
                // only runs when the checks cannot answer
                let (code, out, err) = e.run_with(&args, false, payload, true, &[("AH_ENGINE_NOSPAWN", "1")]);
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
    let payload = bash("npm test", &e.dir);
    let (code, out, err) =
        e.run_with(&args, true, &payload, true, &[("AH_ENGINE_DIR", state_file.to_str().unwrap()), ("AH_TEST_MARK", mark.to_str().unwrap())]);
    assert_eq!((code, out.as_str()), (0, ""));
    assert!(only_event_lines(&err), "{err:?}");
    assert_eq!(std::fs::read_to_string(&mark).unwrap().trim().parse::<usize>().unwrap(), payload.len());

    let mark = e.dir.join("session-ran");
    let map = session_map(&e, r#"wc -c > "$AH_TEST_MARK""#, "true");
    let args = ["hook", "--event", "SessionStart", "--fallback-map", map.to_str().unwrap()];
    let payload = serde_json::json!({"session_id": "e2e", "cwd": e.dir, "hook_event_name": "SessionStart", "source": "startup"}).to_string();
    let (code, out, err) =
        e.run_with(&args, true, &payload, true, &[("AH_ENGINE_DIR", state_file.to_str().unwrap()), ("AH_TEST_MARK", mark.to_str().unwrap())]);
    assert_eq!((code, out.as_str()), (0, ""));
    assert!(only_event_lines(&err), "{err:?}");
    assert_eq!(std::fs::read_to_string(&mark).unwrap().trim().parse::<usize>().unwrap(), payload.len());
}

/// Stderr holds nothing but event-log lines (`ts<TAB>kind<TAB>code<TAB>detail`): with the state dir unusable, the log
/// falls back to stderr (review finding 9) instead of losing the line.
fn only_event_lines(err: &str) -> bool {
    err.lines().all(|l| l.split('\t').count() == 4 && l.split('\t').next().is_some_and(|ts| ts.parse::<u64>().is_ok()))
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
    // review finding 3: a payload that cannot be spooled is an infrastructure fault: the wrapper, which holds the payload,
    // runs the Node hooks (dispatch.defer_exit) for guard and non-guard events alike, never a block and never a skip
    let defer = ah_engine::defaults::num("dispatch.defer_exit") as i32;
    let (code, out, err) = e.run_with(&args, true, &payload, true, &[("AH_ENGINE_DIR", state.to_str().unwrap()), ("AH_TEST_MARK", mark.to_str().unwrap())]);
    assert_eq!((code, out.as_str()), (defer, ""), "{ctx}: {err:?}");
    assert!(err.contains("the Node hooks decide") && err.contains("payload"), "{ctx}: {err:?}");
    assert!(!mark.exists(), "{ctx}: Node must not run without the full payload");

    let mark = e.dir.join("session-ran");
    let map = session_map(e, r#"touch "$AH_TEST_MARK""#, "true");
    let args = ["hook", "--event", "SessionStart", "--fallback-map", map.to_str().unwrap()];
    let payload = session_payload_len(ah_engine::defaults::num("client.max_stdin") as usize + 4097);
    let (code, out, err) = e.run_with(&args, true, &payload, true, &[("AH_ENGINE_DIR", state.to_str().unwrap()), ("AH_TEST_MARK", mark.to_str().unwrap())]);
    assert_eq!((code, out.as_str()), (defer, ""), "{ctx}: {err:?}");
    assert!(err.contains("the Node hooks decide") && err.contains("dispatch_spool_unavailable"), "{ctx}: {err:?}");
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

    assert_eq!((code, out.as_str()), (ah_engine::defaults::num("dispatch.defer_exit") as i32, ""), "{err:?}");
    assert!(err.contains("the Node hooks decide") && err.contains("spooled"), "{err:?}");
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

    assert_eq!((code, out.as_str()), (ah_engine::defaults::num("dispatch.defer_exit") as i32, ""), "{err:?}");
    assert!(err.contains("the Node hooks decide") && err.contains("spooled"), "{err:?}");
    let log = std::fs::read_to_string(e.state().join(ah_engine::health::log_name())).unwrap();
    assert!(log.contains("dispatch_spool_unavailable"), "{log}");
    assert!(!mark.exists(), "Node must not run after the anonymous payload spool write fails");
    assert!(e.dispatch_temp_files().is_empty(), "temp payload files left behind: {:?}", e.dispatch_temp_files());
}

/// Waits until the file holds a whole pid: the shell creates it (empty) a moment before `echo $$` fills it, so existence is
/// not enough (a read in between parsed an empty string under load).
fn wait_for_pid(path: &Path, within: Duration) {
    let start = Instant::now();
    while start.elapsed() < within {
        if std::fs::read_to_string(path).is_ok_and(|s| s.trim().parse::<i32>().is_ok()) {
            return;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("timed out waiting for a pid in {}", path.display());
}

fn kill_hook_group(pid_file: &Path) {
    if let Ok(pid) = std::fs::read_to_string(pid_file).map(|s| s.trim().parse::<i32>().unwrap()) {
        // SAFETY: `kill` and `killpg` take plain integers and have no memory-safety preconditions; a dead pid just fails with ESRCH.
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
    wait_for_pid(&hook_pid, Duration::from_secs(10));
    // SAFETY: `kill` and `killpg` take plain integers and have no memory-safety preconditions; a dead pid just fails with ESRCH.
    unsafe {
        libc::kill(child.id() as libc::pid_t, signal);
    }
    ah_engine::discard::harmless(child.wait());
    ah_engine::discard::harmless(writer.join());
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
    // On Stop, compact-advice-guard has no runnable Node command, and with no daemon (NOSPAWN) its built-in check defers;
    // task-guard is a Node-only hook that ran, finished and blocked: its block must be handed back, not replaced by the generic
    // fail-closed text. (Every PreToolUse entry has a built-in check now, so Stop is the event that still has Node-only hooks
    // next to a check.)
    let ids: Vec<String> = ah_engine::dispatch::table::entries("claude", "Stop").into_iter().map(|x| x.id).collect();
    assert!(ids.iter().any(|i| i == "task-guard") && ids.iter().any(|i| i == "compact-advice-guard"), "{ids:?}");
    let m: serde_json::Map<String, serde_json::Value> = ids
        .iter()
        .map(|id| {
            (
                id.to_string(),
                if id == "task-guard" {
                    "echo sibling-blocks >&2; exit 2"
                } else if id == "compact-advice-guard" {
                    ""
                } else {
                    "true"
                }
                .into(),
            )
        })
        .collect();
    let map = e.dir.join("stop-map.json");
    std::fs::write(&map, serde_json::json!({ "Stop": m }).to_string()).unwrap();
    let args = ["hook", "--event", "Stop", "--fallback-map", map.to_str().unwrap()];
    let stop = serde_json::json!({"session_id": "e2e", "cwd": e.dir, "hook_event_name": "Stop"}).to_string();
    let (code, out, err) = e.run_with(&args, false, &stop, true, &[("AH_ENGINE_NOSPAWN", "1")]);
    assert_eq!(code, 2, "{out:?} {err:?}");
    assert!(err.contains("sibling-blocks"), "the finished hook's own block text: {err:?}");
}

/// The wrapper (`ah-hook.sh`) in front of the real engine must treat a payload serde_json rejects exactly as the
/// Node-only path does: a payload JS parses (a lone surrogate escape) or cannot parse (`{bad`) is decided by the Node
/// hooks (allow stays allow, a block is returned verbatim), never hard-blocked by the engine. Invalid UTF-8 is the one
/// documented stricter case (D74): the engine fails closed on a guard event even where Node, which decodes it lossily,
/// would allow.
#[test]
fn wrapper_and_engine_agree_on_unparsable_guard_payloads() {
    let e = Env::new("wrapper-unparsable");
    let hooks = Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall/hooks");
    let wrapper = hooks.join("ah-hook.sh");
    let shipped: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(hooks.join("ah-fallback.map.json")).unwrap()).unwrap();
    let ids: Vec<String> = shipped["PreToolUse"].as_object().unwrap().keys().cloned().collect();
    let node = |name: &str, cmd: &str| -> (PathBuf, PathBuf) {
        let m: serde_json::Map<String, serde_json::Value> = ids.iter().map(|id| (id.clone(), cmd.into())).collect();
        let map = e.dir.join(format!("{name}.map.json"));
        std::fs::write(&map, serde_json::json!({ "PreToolUse": m }).to_string()).unwrap();
        let list = e.dir.join(format!("{name}.list"));
        std::fs::write(&list, format!("@PreToolUse\t10\n*\t10\t{cmd}\n")).unwrap();
        (map, list)
    };
    let allow = node("allow", "true");
    let block = node("block", "echo node-blocked >&2; exit 2");
    let surrogate = br#"{"hook_event_name":"PreToolUse","tool_name":"Bash","session_id":"s","cwd":"/tmp","tool_input":{"command":"echo hi \ud83d"}}"#.to_vec();
    let invalid_utf8 =
        b"{\"hook_event_name\":\"PreToolUse\",\"tool_name\":\"Bash\",\"session_id\":\"s\",\"cwd\":\"/tmp\",\"tool_input\":{\"command\":\"echo \xffhi\"}}"
            .to_vec();
    let run = |engine: &str, (map, list): &(PathBuf, PathBuf), payload: &[u8]| -> (i32, String) {
        let mut c = Command::new("sh");
        c.arg(&wrapper)
            .args(["PreToolUse", "--tool-from-payload"])
            .env_clear()
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .env("HOME", e.dir.join("home"))
            .env("AH_ENGINE_DIR", e.state())
            .env("AH_WRAPPER_TEST", "1")
            .env("AH_ENGINE_BIN", engine)
            .env("AH_FALLBACK_MAP", map)
            .env("AH_FALLBACK_LIST", list)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut ch = c.spawn().unwrap();
        ch.stdin.take().unwrap().write_all(payload).unwrap();
        let o = ch.wait_with_output().unwrap();
        (o.status.code().unwrap(), String::from_utf8_lossy(&o.stderr).to_string())
    };
    let engine = env!("CARGO_BIN_EXE_ah-engine");
    for (name, payload) in [("lone surrogate", surrogate), ("not JSON", b"{bad".to_vec())] {
        for (label, nodes, want) in [("allow", &allow, 0), ("block", &block, 2)] {
            let with_engine = run(engine, nodes, &payload);
            let node_only = run("/nonexistent/ah-engine", nodes, &payload);
            assert_eq!(with_engine.0, want, "{name}, Node {label}, engine in front: {}", with_engine.1);
            assert_eq!(node_only.0, want, "{name}, Node {label}, Node only: {}", node_only.1);
            if want == 2 {
                assert!(with_engine.1.contains("node-blocked"), "{name}: the Node block text is returned verbatim: {}", with_engine.1);
            }
        }
    }
    for (label, nodes) in [("allow", &allow), ("block", &block)] {
        let (code, err) = run(engine, nodes, &invalid_utf8);
        assert_eq!(code, 2, "invalid UTF-8, Node {label}: the engine fails closed (D74), stricter than Node: {err}");
        assert!(err.contains("not valid UTF-8"), "{err}");
    }
}

const NODE_SHIPIT: &str = "echo NODE-RAN >&2; exit 2";

fn shipit_edit(e: &Env) -> String {
    serde_json::json!({"session_id": "e2e", "cwd": e.dir, "hook_event_name": "PreToolUse", "tool_name": "Edit", "tool_input": {"file_path": "migrations/a.sql"}}).to_string()
}

/// Review P1: when the forwarded environment cannot stand for the client's (dropped over the cap, or no usable HOME),
/// the checks that read it must defer to Node, never evaluate with no home and default switches (a gate that is on
/// would read as off and the engine would allow what Node blocks).
fn assert_env_incomplete_defers(name: &str, in_process: bool) {
    let e = Env::new(name);
    let map = pretool_map(&e, &[("ship-it-guard", NODE_SHIPIT)], "true");
    let args = ["hook", "--event", "PreToolUse", "--fallback-map", map.to_str().unwrap()];
    let p = shipit_edit(&e);
    let gate = [("ANTIHALL_SHIPIT_GATE", "1")];
    let pad = "x".repeat(70_000);
    let broken = |env: &Env| env.run_with(&args, in_process, &p, true, &[("ANTIHALL_SHIPIT_GATE", "1"), ("ANTIHALL_PAD", pad.as_str())]);
    if in_process {
        let (code, _, err) = e.run_with(&args, true, &p, true, &gate);
        assert!(code == 2 && !err.contains("NODE-RAN"), "control: with a whole environment the engine answers itself: {code} {err:?}");
        let (code, _, err) = broken(&e);
        e.stop();
        assert_eq!((code, err.contains("NODE-RAN")), (2, true), "an incomplete environment defers to Node: {err:?}");
        return;
    }
    // warm the daemon: the first call goes through Node, later ones are answered by the daemon
    let mut native = false;
    for _ in 0..50 {
        let (code, _, err) = e.run_with(&args, false, &p, true, &gate);
        if code == 2 && !err.contains("NODE-RAN") {
            native = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    assert!(native, "control: the warm daemon answers the gated Edit natively");
    let (code, _, err) = broken(&e);
    e.stop();
    assert_eq!((code, err.contains("NODE-RAN")), (2, true), "daemon: an incomplete environment defers to Node: {err:?}");
}

#[test]
fn an_environment_dropped_over_the_cap_defers_the_env_reading_checks_in_process() {
    assert_env_incomplete_defers("capdrop-ip", true);
}

#[test]
fn an_environment_dropped_over_the_cap_defers_the_env_reading_checks_through_the_daemon() {
    assert_env_incomplete_defers("capdrop-d", false);
}

#[test]
fn an_empty_home_defers_the_env_reading_checks_in_process_and_through_the_daemon() {
    for in_process in [true, false] {
        let e = Env::new(if in_process { "emptyhome-ip" } else { "emptyhome-d" });
        let map = pretool_map(&e, &[("ship-it-guard", NODE_SHIPIT)], "true");
        let args = ["hook", "--event", "PreToolUse", "--fallback-map", map.to_str().unwrap()];
        let p = shipit_edit(&e);
        let extra = [("ANTIHALL_SHIPIT_GATE", "1"), ("HOME", "")];
        for _ in 0..if in_process { 1 } else { 12 } {
            let (code, _, err) = e.run_with(&args, in_process, &p, true, &extra);
            assert_eq!((code, err.contains("NODE-RAN")), (2, true), "an empty HOME defers to Node (in_process={in_process}): {err:?}");
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        e.stop();
    }
}

/// Review P1: a check that records a spawn and then answers "nothing to say" must answer `Allow`, never `None` (which the
/// dispatcher hands to the Node hook, and the Node hook records the same spawn a second time: the rate cap was effectively
/// halved). One Agent call through the real dispatcher, with the real Node hooks behind every entry that defers, writes exactly
/// one line to the swarm spawn log and one to the phase tracker's agent log.
#[test]
fn one_agent_call_records_exactly_one_spawn_per_log() {
    if Command::new("node").arg("--version").output().map(|o| !o.status.success()).unwrap_or(true) {
        eprintln!("skipped: no node on PATH (the real Node hooks are the oracle for a double record)");
        return;
    }
    let e = Env::new("spawn-once");
    let plugin = Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall");
    let home = e.dir.join("home");
    let payload = serde_json::json!({
        "session_id": "once", "cwd": e.dir, "hook_event_name": "PreToolUse", "tool_name": "Agent",
        "tool_input": {"description": "read a file", "prompt": "read README.md and report its first line", "subagent_type": "Explore", "model": "haiku"}
    })
    .to_string();
    for in_process in [true, false] {
        ah_engine::discard::harmless(std::fs::remove_dir_all(home.join(".anti-hall")));
        let calls = 3;
        for _ in 0..calls {
            let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
            c.args(["hook", "--event", "PreToolUse"])
                .env_clear()
                .env("PATH", std::env::var("PATH").unwrap_or_default())
                .env("HOME", &home)
                .env("AH_ENGINE_DIR", e.state())
                .env("AH_ENGINE_VERSION", "dispatch-e2e")
                .env("AH_ENGINE_DISPATCH_IN_PROCESS", if in_process { "1" } else { "0" })
                .env("AH_ENGINE_NOSPAWN", if in_process { "0" } else { "1" })
                .env("CLAUDE_PLUGIN_ROOT", &plugin)
                .env("ANTIHALL_INGEST_DRY_RUN", "1")
                .current_dir(&e.dir)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            let mut ch = c.spawn().unwrap();
            ch.stdin.take().unwrap().write_all(payload.as_bytes()).unwrap();
            let o = ch.wait_with_output().unwrap();
            assert_eq!(o.status.code(), Some(0), "{}", String::from_utf8_lossy(&o.stderr));
        }
        let lines = |rel: &str| std::fs::read_to_string(home.join(rel)).map(|t| t.lines().filter(|l| !l.trim().is_empty()).count()).unwrap_or(0);
        let mode = if in_process { "checks answer in the client" } else { "checks down (every entry runs its Node hook)" };
        assert_eq!(lines(".anti-hall/swarm-spawns.log"), calls, "swarm-spawns.log, {mode}");
        assert_eq!(lines(".anti-hall/agent-spawns.log"), calls, "agent-spawns.log, {mode}");
    }
}

// ---- token cuts: the injection gate, through the real daemon -------------------------------------------------------------

fn ups_payload(session: &str) -> String {
    serde_json::json!({"session_id": session, "cwd": "/tmp", "hook_event_name": "UserPromptSubmit", "prompt": "hi"}).to_string()
}

fn short_reminder() -> &'static str {
    ah_engine::defaults::text("inject_gate.task_short")
}

/// The additionalContext a UserPromptSubmit dispatch handed the host (empty when it said nothing).
fn context_of(out: &str) -> String {
    serde_json::from_str::<serde_json::Value>(out.trim())
        .ok()
        .and_then(|v| v["hookSpecificOutput"]["additionalContext"].as_str().map(str::to_string))
        .unwrap_or_default()
}

/// A daemon that answers (the first call only starts it and is answered by Node, D5): ping until it does.
fn warm(e: &Env, args: &[&str], extra: &[(&str, &str)]) {
    for _ in 0..100 {
        let metrics = e.run(&["metrics", "--json"], false, "", true).1;
        if metrics.contains("\"requests\"") {
            return;
        }
        let _ = e.run_with(args, false, &ups_payload("warm"), true, extra);
        std::thread::sleep(Duration::from_millis(50));
    }
    panic!("the daemon never came up");
}

#[test]
fn the_gate_cuts_a_repeated_reminder_through_the_daemon_and_off_it_is_the_node_output_byte_for_byte() {
    let e = Env::new("inject-gate");
    // task-tracker's Node command is replaced by a stand-in that prints the short reminder every turn
    let say = format!(r#"printf '{{"hookSpecificOutput":{{"hookEventName":"UserPromptSubmit","additionalContext":"{}"}}}}\n'"#, short_reminder());
    // the engine answers the real task-tracker natively; a session that could be a DevSwarm Primary is handed to Node, which is
    // what lets the stand-in take its place
    let ids: Vec<String> = ah_engine::dispatch::table::entries("claude", "UserPromptSubmit").into_iter().map(|x| x.id).collect();
    let m: serde_json::Map<String, serde_json::Value> =
        ids.iter().map(|id| (id.clone(), if id == "task-tracker" { say.as_str() } else { "true" }.into())).collect();
    let map = e.dir.join("UserPromptSubmit-map.json");
    std::fs::write(&map, serde_json::json!({ "UserPromptSubmit": m }).to_string()).unwrap();
    let args = ["hook", "--event", "UserPromptSubmit", "--fallback-map", map.to_str().unwrap()];
    let on = [("ANTIHALL_INJECT_GATE_TASK_EVERY", "3"), ("DEVSWARM_REPO_ID", "r")];
    warm(&e, &args, &on);
    let seen: Vec<String> = (0..5).map(|_| context_of(&e.run_with(&args, false, &ups_payload("sess-on"), true, &on).1)).collect();
    // turn 1 is the first injection of the session; 2 and 3 are suppressed; 4 is the keepalive; 5 suppressed again
    let short = short_reminder();
    assert!(seen[0].contains(short) && seen[3].contains(short), "{seen:?}");
    assert!(!seen[1].contains(short) && !seen[2].contains(short) && !seen[4].contains(short), "{seen:?}");
    // a new session starts whole again
    assert!(context_of(&e.run_with(&args, false, &ups_payload("sess-new"), true, &on).1).contains(short));
    // a SessionStart dispatch (compaction) clears the session: the next prompt is whole again
    let start = serde_json::json!({"session_id": "sess-on", "cwd": "/tmp", "hook_event_name": "SessionStart", "source": "compact"}).to_string();
    let start_map = session_map(&e, "true", "true");
    let _ = e.run_with(&["hook", "--event", "SessionStart", "--fallback-map", start_map.to_str().unwrap()], false, &start, true, &on);
    assert!(context_of(&e.run_with(&args, false, &ups_payload("sess-on"), true, &on).1).contains(short), "re-injected after compaction");
    // what it measured: the daemon counts the dropped bytes, and the memory is reported
    let metrics = e.run(&["metrics", "--json"], false, "", true).1;
    let status = e.run(&["status", "--json"], false, "", true).1;
    let report = e.run(&["ctl", "gate"], false, "", true).1;
    assert!(metrics.contains("inject_suppressed_bytes") && metrics.contains("inject_gate_bytes"), "{metrics}");
    assert!(status.contains("inject_gate"), "{status}");
    assert!(report.contains("sess-on") && report.contains("suppressed_bytes"), "{report}");
    // switched off, every turn is the hook's own output, byte for byte
    let off = [("ANTIHALL_INJECT_GATE", "0"), ("DEVSWARM_REPO_ID", "r")];
    let node_bytes = e.run_with(&args, true, &ups_payload("sess-off"), true, &off).1;
    for _ in 0..4 {
        assert_eq!(e.run_with(&args, false, &ups_payload("sess-off"), true, &off).1, node_bytes);
    }
    assert!(context_of(&node_bytes).contains(short));
    e.stop();
}

/// Copy `from` into `to`, recursively.
fn copy_tree(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for e in std::fs::read_dir(from).unwrap().flatten() {
        let (p, q) = (e.path(), to.join(e.file_name()));
        if p.is_dir() {
            copy_tree(&p, &q);
        } else {
            std::fs::copy(&p, &q).unwrap();
        }
    }
}

/// `text` without the TOML table `[name]` (up to the next table header).
fn drop_table(text: &str, name: &str) -> String {
    let head = format!("[{name}]\n");
    let at = text.find(&head).unwrap_or_else(|| panic!("{name} not in file"));
    let end = text[at + head.len()..].find("\n[").map_or(text.len(), |n| at + head.len() + n + 1);
    format!("{}{}", &text[..at], &text[end..])
}

/// Review P1 #1: an event whose table row is gone (and whose fallback list is not there for the load check to compare
/// against) is handed to the Node hooks with `dispatch.defer_exit` and no done mark, never answered with the neutral no-op
/// the wrapper would not give. A thin trigger the fallback list marks empty stays the neutral no-op.
#[test]
fn a_missing_table_row_defers_to_node_instead_of_allowing() {
    let e = Env::new("norow");
    let plugin = e.dir.join("plugin");
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall");
    copy_tree(&src.join("engine"), &plugin.join("engine"));
    let dispatch = plugin.join("engine/defaults/dispatch.toml");
    let text = std::fs::read_to_string(&dispatch).unwrap();
    std::fs::write(&dispatch, drop_table(&text, "dispatch.hooks_claude_Stop")).unwrap();
    // the pristine copy too: a row only the edited copy lost is otherwise taken from it
    std::fs::write(plugin.join("engine/defaults.pristine/dispatch.toml"), drop_table(&text, "dispatch.hooks_claude_Stop")).unwrap();
    let done = e.dir.join("done");
    let root = plugin.to_string_lossy().to_string();
    let env = [("AH_ENGINE_PLUGIN_ROOT", root.as_str()), ("AH_ENGINE_DONE_FILE", done.to_str().unwrap()), ("AH_ENGINE_NOSPAWN", "1")];
    let (code, out, err) = e.run_with(&["hook", "--event", "Stop", "--host", "claude"], true, "{}", false, &env);
    assert_eq!(code, 75, "a lost Stop row must defer to Node, not allow: out={out} err={err}");
    assert!(!done.exists(), "a deferral must not mark the dispatch done (the wrapper would skip its Node fallback)");
    // with the plugin's fallback lists present, an event they mark as a thin trigger is the neutral no-op, as in the wrapper
    copy_tree(&src.join("hooks"), &plugin.join("hooks"));
    std::fs::write(&dispatch, &text).unwrap();
    let (code, out, err) = e.run_with(&["hook", "--event", "Notification", "--host", "claude"], true, "{}", false, &env);
    assert_eq!((code, out.as_str()), (0, ""), "a thin trigger stays the neutral no-op: err={err}");
    assert!(done.exists(), "the neutral no-op is the answer, so the dispatch is marked done");
}

// ---- several blocks in one dispatch: every block reason reaches the host, in table order --------------------------------------

/// A map for `event` that gives the listed entries their commands and every other entry `true` (says nothing).
fn ids_map(e: &Env, event: &str, outs: &[(&str, &str)]) -> PathBuf {
    let ids: Vec<String> = ah_engine::dispatch::table::entries("claude", event).into_iter().map(|x| x.id).collect();
    for (id, _) in outs {
        assert!(ids.iter().any(|i| i == id), "{event} has no entry {id}: {ids:?}");
    }
    let m: serde_json::Map<String, serde_json::Value> =
        ids.iter().map(|id| (id.clone(), outs.iter().find(|(k, _)| k == id).map_or("true".to_string(), |(_, c)| c.to_string()).into())).collect();
    let map = e.dir.join(format!("{event}-ids-map.json"));
    let mut events = serde_json::Map::new();
    events.insert(event.to_string(), serde_json::Value::Object(m));
    std::fs::write(&map, serde_json::Value::Object(events).to_string()).unwrap();
    map
}

#[test]
fn a_built_in_block_and_a_deferred_node_block_both_reach_the_host() {
    let e = Env::new("two-blocks-pre");
    // git-guard's built-in check blocks the force push in process; merge-gate defers to its Node hook (node_only_bash), which
    // blocks too: the host, running both hooks, would show both reasons
    let map = e.map(&[("merge-gate", "printf 'node merge-gate says' ; echo MERGE-GATE-REASON >&2; exit 2")]);
    let args = ["hook", "--event", "PreToolUse", "--fallback-map", map.to_str().unwrap()];
    let mut p: serde_json::Value = serde_json::from_str(&node_only_bash(&e)).unwrap();
    p["tool_input"]["command"] = "git push --force origin main && gh pr merge 1 # a.py".into();
    let (code, out, err) = e.run(&args, true, &p.to_string(), true);
    assert_eq!(code, 2, "{out:?} {err:?}");
    let (git_at, node_at) = (err.find("force push"), err.find("MERGE-GATE-REASON"));
    assert!(git_at.is_some() && node_at.is_some() && git_at < node_at, "both reasons, in table order: {err:?}");
    assert_eq!(out, "node merge-gate says\n", "the plain stdout of an exit 2 stays on stdout, where the host leaves it");
}

#[test]
fn deferred_stop_blocks_keep_every_reason_and_message() {
    let e = Env::new("two-blocks-stop");
    // no daemon and not in process: every Stop check defers to its Node hook
    let map = ids_map(
        &e,
        "Stop",
        &[
            ("task-guard", r#"printf '{"decision":"block","reason":"TASK-REASON","systemMessage":"task msg"}\n'"#),
            ("speculation-guard", "printf 'spec plain out'; echo SPEC-REASON >&2; exit 2"),
            ("codex-nudge", "echo advisory plain text"),
        ],
    );
    let args = ["hook", "--event", "Stop", "--fallback-map", map.to_str().unwrap()];
    let stop = serde_json::json!({"session_id": "e2e", "cwd": e.dir, "hook_event_name": "Stop"}).to_string();
    let (code, out, err) = e.run_with(&args, false, &stop, true, &[("AH_ENGINE_NOSPAWN", "1")]);
    assert_eq!(code, 2, "{out:?} {err:?}");
    let v: serde_json::Value = serde_json::from_str(out.trim()).unwrap_or_else(|_| panic!("one JSON object: {out:?}"));
    let joiner = ah_engine::defaults::text("dispatch.reason_joiner");
    assert_eq!(v["decision"], "block");
    assert_eq!(v["reason"], format!("TASK-REASON{joiner}SPEC-REASON"), "{out:?}");
    // codex-nudge's plain note rides in the system message (user-facing); stdout stays one object
    assert_eq!(v["systemMessage"], "task msg\nadvisory plain text");
    // exit 2: stderr is the reason the model reads, so it carries every reason and no note
    assert_eq!(err, format!("TASK-REASON{joiner}SPEC-REASON\n"));
    assert_no_stop_counters(&e);
}

#[test]
fn two_exit_two_blocks_on_an_advisory_event_keep_both_stderr_texts() {
    let e = Env::new("two-blocks-post");
    let map = ids_map(&e, "PostToolUse", &[("merge-side-pick:post", "echo FIRST >&2; exit 2"), ("output-verify-guard", "echo SECOND >&2; exit 2")]);
    let args = ["hook", "--event", "PostToolUse", "--fallback-map", map.to_str().unwrap()];
    let p = serde_json::json!({"session_id": "e2e", "cwd": e.dir, "hook_event_name": "PostToolUse", "tool_name": "Bash", "tool_input": {"command": "ls"}, "tool_response": {"stdout": ""}}).to_string();
    let (code, out, err) = e.run_with(&args, false, &p, true, &[("AH_ENGINE_NOSPAWN", "1")]);
    let joiner = ah_engine::defaults::text("dispatch.reason_joiner");
    assert_eq!((code, out.as_str(), err), (2, "", format!("FIRST{joiner}SECOND\n")));
}

#[test]
fn a_reminder_the_gate_cuts_is_no_output_not_an_empty_context() {
    let e = Env::new("inject-gate-empty");
    let say = format!(r#"printf '{{"hookSpecificOutput":{{"hookEventName":"UserPromptSubmit","additionalContext":"{}"}}}}\n'"#, short_reminder());
    // the task-tracker is a native check that defers to its Node command here (DevSwarm is active), so map that command by id
    let map = event_map_for(&e, "UserPromptSubmit", "task-tracker", &say);
    let args = ["hook", "--event", "UserPromptSubmit", "--fallback-map", map.to_str().unwrap()];
    let on = [("ANTIHALL_INJECT_GATE_TASK_EVERY", "3")];
    warm(&e, &args, &on);
    let first = e.run_with(&args, false, &ups_payload("sess-empty"), true, &on);
    let second = e.run_with(&args, false, &ups_payload("sess-empty"), true, &on);
    e.stop();
    assert!(context_of(&first.1).contains(short_reminder()), "{first:?}");
    assert_eq!(second, (0, String::new(), String::new()), "a suppressed reminder prints nothing, not an empty additionalContext");
}
