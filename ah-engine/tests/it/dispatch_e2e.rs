//! D58 end to end: the real binary as `ah-engine hook --event PreToolUse`, with the Node hooks replaced by small shell
//! commands through `--fallback-map`, so each property is checked without Node. Every test uses its own HOME and state
//! directory and reaps any daemon it starts.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use crate::common;

use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
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
            "procwatch-advisory",
            "engine-role-guard",
            "broad-kill-guard",
            "burn-breaker",
            "queued-wait-guard",
            "lane-test-guard",
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
            // External CARGO_TARGET_DIR builds cannot discover the checkout by walking up from the executable.
            .env("AH_ENGINE_PLUGIN_ROOT", std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall"))
            // the codex-availability check probes PATH for a `codex` binary and answers with a context line when it finds one;
            // these tests drive the mapped Node commands only
            .env("PATH", path_without_codex())
            .env("HOME", self.dir.join("home"))
            .env("AH_ENGINE_DIR", self.state())
            .env("AH_ENGINE_VERSION", "dispatch-e2e")
            .env("ANTIHALL_JEV_RECOMMEND_NOTICE", "false") // the session gate answers the notice itself; these tests probe the Node fallback
            .env("ANTIHALL_ROLE_NOTE", "0") // the role note is injected at every SessionStart; these tests probe the Node fallback and the exact bytes
            .env("AH_ENGINE_DISPATCH_IN_PROCESS", if in_process { "1" } else { "0" })
            // DevSwarm active, together with a SessionStart payload that names no working directory, makes the native
            // verify-first-orch check defer to its mapped Node command (whether a Primary may be told the workspace tier depends on
            // the repository's own documents), so the SessionStart tests below keep driving Node hooks only (the check itself is
            // covered by spawn_ctx_parity.rs)
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
            // External CARGO_TARGET_DIR builds cannot discover the checkout by walking up from the executable.
            .env("AH_ENGINE_PLUGIN_ROOT", std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall"))
            // the codex-availability check probes PATH for a `codex` binary and answers with a context line when it finds one;
            // these tests drive the mapped Node commands only
            .env("PATH", path_without_codex())
            .env("HOME", self.dir.join("home"))
            .env("AH_ENGINE_DIR", self.state())
            .env("AH_ENGINE_VERSION", "dispatch-e2e")
            .env("AH_ENGINE_DISPATCH_IN_PROCESS", if in_process { "1" } else { "0" })
            // DevSwarm active, together with a SessionStart payload that names no working directory, makes the native
            // verify-first-orch check defer to its mapped Node command (whether a Primary may be told the workspace tier depends on
            // the repository's own documents), so the SessionStart tests below keep driving Node hooks only (the check itself is
            // covered by spawn_ctx_parity.rs)
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

/// A Bash payload on which the `merge-gate` and `api-guard` entries run their Node hooks, which these tests replace with shell
/// stand-ins. The scripted checks answer almost every payload now (v1.0 lane L07), so the entries are switched to Node the way
/// an operator reverts one check: `mode = "off"` in the state directory's config.toml turns off only the engine's check of a
/// guard entry and leaves the Node hook as its decider.
fn node_only_bash(e: &Env) -> String {
    let home = e.dir.join("home");
    std::fs::create_dir_all(home.join(".anti-hall")).unwrap();
    std::fs::write(home.join(".anti-hall/settings.json"), r#"{"guards":{"mergeGate":true}}"#).unwrap();
    std::fs::create_dir_all(e.state()).unwrap();
    std::fs::write(e.state().join("config.toml"), "[entries.\"PreToolUse/merge-gate\"]\nmode = \"off\"\n[entries.\"PreToolUse/api-guard\"]\nmode = \"off\"\n")
        .unwrap();
    let tp = "hedged.jsonl";
    serde_json::json!({"session_id": "e2e", "cwd": e.dir, "hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": "gh pr merge 1 # a.py; echo 'import os' > a.py # \u{e9} $(true)"}, "transcript_path": tp})
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

/// What a guard that could not answer says, read from the configured text (script.msg_fail_closed with the reason at `why_key`),
/// for the first check every Bash/Edit/Agent PreToolUse row starts with.
fn closed_text(why_key: &str) -> String {
    let why = ah_engine::defaults::text(why_key);
    ah_engine::defaults::render("script.msg_fail_closed", &[("check", &"compact-declaration-guard"), ("why", &why)])
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

const CTX_MERGE_GATE: &str = r#"printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"from merge-gate"}}\n'"#;

fn wait_for_daemon_native_block(e: &Env, args: &[&str], payload: &str, extra: &[(&str, &str)]) {
    for _ in 0..50 {
        let (code, _, err) = e.run_with(args, false, payload, true, extra);
        if code == 2 && !err.contains(&closed_text("script.msg_unanswered")) {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    panic!("control: the warm daemon did not answer the guard natively");
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
    let shown = ah_engine::defaults::render("silent_nudge.msg_item", &[("label", &"a1b2c3d4e5f601"), ("mins", &90)]);
    let what = ah_engine::defaults::render(
        "silent_nudge.msg_what",
        &[
            ("count", &1),
            ("noun", &ah_engine::defaults::text("silent_nudge.noun_agent")),
            ("min", &ah_engine::defaults::num("silent_nudge.min_default")),
            ("shown", &shown),
            ("more", &""),
        ],
    );
    let reply: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(reply["decision"], "block", "{out:?} {err:?}");
    assert!(reply["reason"].as_str().unwrap().contains(&what) && !err.contains("NODE-RAN"), "{out:?} {err:?}");
}

#[test]
fn an_event_no_entry_matches_says_nothing_and_starts_no_daemon() {
    let e = Env::new("nomatch");
    let p = serde_json::json!({"session_id": "e2e", "cwd": e.dir, "hook_event_name": "Notification", "tool_name": "Glob", "tool_input": {}}).to_string();
    assert_eq!(e.run(&["hook", "--event", "Notification"], false, &p, true), (0, String::new(), String::new()));
    assert!(e.dispatch_temp_files().is_empty(), "temp payload files left behind: {:?}", e.dispatch_temp_files());
    assert!(!e.state().join("failure.json").exists(), "nothing matched, so the daemon was not woken");
}

/// D74: a guard event the dispatcher cannot decide blocks (exit 2) with the fail-closed message; it is never a silent allow.
/// There is no Node hook to run, so the faults left are the dispatcher's own: an unreadable fallback map and a usage error are
/// install faults, and the configured `infra` failure mode (closed) answers them.
#[test]
fn a_guard_event_the_dispatcher_cannot_decide_fails_closed() {
    let e = Env::new("closed");
    // a broken fallback map, plugin root set
    let bad = e.dir.join("bad-map.json");
    std::fs::write(&bad, "not json").unwrap();
    let args = ["hook", "--event", "PreToolUse", "--fallback-map", bad.to_str().unwrap()];
    let (code, out, err) = e.run(&args, true, &bash("ls", &e.dir), true);
    assert_eq!((code, out.as_str()), (2, ""), "{err}");
    assert!(err.contains("could not run the guards for PreToolUse") && err.contains("cannot read the fallback map"), "{err}");
    // a usage error on a guard event does not exit 64 (a non-blocking error the host reads as an allow)
    let (code, out, err) = e.run(&["hook", "--event", "PreToolUse", "--host", "nope"], true, &bash("ls", &e.dir), true);
    assert_eq!((code, out.as_str()), (2, ""), "{err}");
    assert!(err.contains("could not run the guards for PreToolUse") && err.contains("unknown host nope"), "{err}");
    let log = std::fs::read_to_string(e.state().join("ah-engine.log")).unwrap_or_default();
    assert_eq!(log.matches("dispatch_no_node_closed").count(), 2, "{log}");
    // no plugin root: the built-in checks do not need one, so a benign call is answered (and allowed) natively
    let (code, out, err) = e.run(&["hook", "--event", "PreToolUse"], true, &bash("ls", &e.dir), false);
    assert_eq!((code, out.as_str(), err.as_str()), (0, "", ""));
}

#[test]
fn unparsable_spawn_payload_blocks_only_when_node_cannot_run_model_routing() {
    let e = Env::new("mr-malformed");
    let map = e.spawn_map();
    for tool in ["Agent", "Task"] {
        let args = ["hook", "--event", "PreToolUse", "--tool", tool, "--fallback-map", map.to_str().unwrap()];
        let (code, out, err) = e.run(&args, true, "{bad", false);
        assert_eq!((code, out.as_str()), (2, ""), "{tool}: {out:?} {err:?}");
        assert!(err.contains(&closed_text("script.msg_unanswered")), "{tool}: {err}");
    }
}

/// A payload JS parses but serde_json rejects (a lone surrogate escape) used to be left to Node. With no Node hook to leave it
/// to, a guard event cannot be decided and follows its configured infra failure mode: closed (stricter than Node, which allowed
/// it). Recorded in the open notes for the owner.
#[test]
fn a_payload_only_js_can_parse_fails_closed_on_a_guard_event() {
    let e = Env::new("mr-surrogate");
    let agent = r#"{"hook_event_name":"PreToolUse","tool_name":"Agent","session_id":"s","cwd":"/tmp","tool_input":{"model":"sonnet","subagent_type":"general-purpose","prompt":"implement the parser \ud83d"}}"#;
    let bash_p = r#"{"hook_event_name":"PreToolUse","tool_name":"Bash","session_id":"s","cwd":"/tmp","tool_input":{"command":"echo hi \ud83d"}}"#;
    for (tool, payload) in [("Agent", agent), ("Bash", bash_p)] {
        let args = ["hook", "--event", "PreToolUse", "--tool", tool];
        let (code, out, err) = e.run(&args, true, payload, true);
        assert_eq!((code, out.as_str()), (2, ""), "{tool}: {err:?}");
        assert!(err.contains("could not run the guards for PreToolUse"), "{tool}: {err}");
    }
}

/// A payload serde_json cannot read on a guard event cannot be decided: it follows the infra failure mode (closed) and the
/// fallback is on record, one `dispatch_defer` health line (the fallback counter) per call.
#[test]
fn an_unreadable_payload_on_a_guard_event_fails_closed_and_is_logged() {
    let e = Env::new("unparsed-logged");
    let args = ["hook", "--event", "PreToolUse", "--tool", "Bash"];
    for (label, payload) in [("not JSON", "{bad"), ("empty", "")] {
        let (code, out, err) = e.run(&args, true, payload, true);
        assert_eq!((code, out.as_str()), (2, ""), "{label}: {err:?}");
        assert!(err.contains("could not run the guards for PreToolUse"), "{label}: {err}");
    }
    let log = std::fs::read_to_string(e.state().join(ah_engine::health::log_name())).unwrap_or_default();
    let lines: Vec<&str> = log.lines().filter(|l| l.contains("dispatch_defer") && l.contains("not readable as JSON")).collect();
    assert_eq!(lines.len(), 2, "one fallback line per unreadable payload: {log}");
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

/// A path that used to hand the event to Node answers by itself: a guard event follows its failure mode (an unreadable map:
/// `infra`, closed), never exit 75.
#[test]
fn an_infra_fault_follows_the_failure_mode_and_never_exits_75() {
    let e = Env::new("no-node-infra");
    let missing = e.dir.join("missing-map.json");
    let args = ["hook", "--event", "PreToolUse", "--fallback-map", missing.to_str().unwrap()];
    let (code, out, err) = e.run_with(&args, true, &node_only_bash(&e), true, &[]);
    assert_eq!((code, out.as_str()), (2, ""), "infra is closed: {err}");
    assert!(err.contains("blocked rather than allowed"), "{err}");
    let log = std::fs::read_to_string(e.state().join("ah-engine.log")).unwrap_or_default();
    assert!(log.contains("dispatch_no_node_closed"), "{log}");
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
fn over_cap_guard_with_unrunnable_node_hooks_fails_closed() {
    let e = Env::new("stdin-pretool-unrunnable");
    let payload = pretool_payload_len(ah_engine::defaults::num("client.max_stdin") as usize + 4097);
    let (code, out, err) = e.run(&["hook", "--event", "PreToolUse"], true, &payload, false);
    assert_eq!((code, out.as_str()), (2, ""));
    assert!(err.contains("could not run the guards") && err.contains("no runnable Node command"), "{err:?}");
    assert!(e.dispatch_temp_files().is_empty(), "temp payload files left behind: {:?}", e.dispatch_temp_files());
}

#[test]
fn over_cap_stop_active_fails_closed_up_to_the_cap_then_lets_the_agent_go() {
    let e = Env::new("stdin-stop-active");
    // a Stop payload over the stdin cap cannot be sent to the engine, so its hooks cannot run: the engine's own fail-closed block is
    // bounded by the stop-loop cap (the agent is held `dispatch.stop_block_cap` times, then let go), never an endless loop
    let payload = stop_payload_len(ah_engine::defaults::num("client.max_stdin") as usize + 4097);
    let cap = ah_engine::defaults::num("dispatch.stop_block_cap") as usize;
    let codes: Vec<i32> = (0..cap + 2).map(|_| e.run(&["hook", "--event", "Stop"], true, &payload, true).0).collect();
    let want: Vec<i32> = (0..cap + 2).map(|i| if i < cap { 2 } else { 0 }).collect();
    assert_eq!(codes, want, "an over-cap Stop is held up to the cap, then let go");
    assert!(e.dispatch_temp_files().is_empty(), "temp payload files left behind: {:?}", e.dispatch_temp_files());
}

#[test]
fn over_cap_guard_payload_is_closed_not_allowed_even_with_the_plugin_root_set() {
    let e = Env::new("stdin-pretool-closed");
    let payload = pretool_payload_len(ah_engine::defaults::num("client.max_stdin") as usize + 4097);
    let (code, out, err) = e.run(&["hook", "--event", "PreToolUse"], true, &payload, true);
    assert_eq!((code, out.as_str()), (2, ""), "{err:?}");
    assert!(err.contains("could not run the guards for PreToolUse"), "{err:?}");
    assert!(e.dispatch_temp_files().is_empty(), "temp payload files left behind: {:?}", e.dispatch_temp_files());
}

#[test]
fn small_payloads_do_not_need_a_usable_spool_dir() {
    let e = Env::new("stdin-small-state-file");
    let state_file = e.dir.join("not-a-state-dir");
    std::fs::write(&state_file, "not a dir").unwrap();
    // a payload under the cap never touches the spool: the unusable state dir only sends the event log to stderr
    let payload = bash("ls", &e.dir);
    let (code, out, err) = e.run_with(&["hook", "--event", "PreToolUse"], true, &payload, true, &[("AH_ENGINE_DIR", state_file.to_str().unwrap())]);
    assert_eq!((code, out.as_str()), (0, ""));
    assert!(only_event_lines(&err), "{err:?}");
    let payload = serde_json::json!({"session_id": "e2e", "hook_event_name": "SessionStart", "source": "startup"}).to_string();
    let (code, _, err) = e.run_with(&["hook", "--event", "SessionStart"], true, &payload, true, &[("AH_ENGINE_DIR", state_file.to_str().unwrap())]);
    assert_eq!(code, 0, "{err:?}");
    // the entries without a built-in check are skipped with a note (no hook command exists); nothing mentions a spool
    assert!(!err.contains("spool") && err.lines().all(|l| l.starts_with("anti-hall: skipped SessionStart") || l.split('\t').count() == 4), "{err:?}");
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
    // review finding 3: a payload that cannot be spooled is an infrastructure fault. Nothing can read it back, so the event follows
    // its configured infra failure mode: a guard event is closed (exit 2), any other event skips its hooks with a loud line.
    let payload = pretool_payload_len(ah_engine::defaults::num("client.max_stdin") as usize + 4097);
    let (code, out, err) = e.run_with(&["hook", "--event", "PreToolUse"], true, &payload, true, &[("AH_ENGINE_DIR", state.to_str().unwrap())]);
    assert_eq!((code, out.as_str()), (2, ""), "{ctx}: {err:?}");
    assert!(err.contains("could not run the guards for PreToolUse") && err.contains("payload"), "{ctx}: {err:?}");

    let payload = session_payload_len(ah_engine::defaults::num("client.max_stdin") as usize + 4097);
    let (code, out, err) = e.run_with(&["hook", "--event", "SessionStart"], true, &payload, true, &[("AH_ENGINE_DIR", state.to_str().unwrap())]);
    assert_eq!((code, out.as_str()), (0, ""), "{ctx}: {err:?}");
    assert!(err.contains("dispatch_spool_unavailable"), "{ctx}: {err:?}");
}

#[test]
fn over_cap_guard_payload_fails_closed_when_anonymous_spool_write_fails() {
    let e = Env::new("stdin-spool-write-guard");
    let payload = pretool_payload_len(ah_engine::defaults::num("client.max_stdin") as usize + 4097);
    let (code, out, err) = e.run_with_file_size_limit(&["hook", "--event", "PreToolUse"], true, &payload, true, &[], 1024 * 1024);

    assert_eq!((code, out.as_str()), (2, ""), "{err:?}");
    assert!(err.contains("could not run the guards for PreToolUse") && err.contains("spooled"), "{err:?}");
    assert!(e.dispatch_temp_files().is_empty(), "temp payload files left behind: {:?}", e.dispatch_temp_files());
}

#[test]
fn over_cap_non_guard_payload_reports_when_anonymous_spool_write_fails() {
    let e = Env::new("stdin-spool-write-session");
    let payload = session_payload_len(ah_engine::defaults::num("client.max_stdin") as usize + 4097);
    let (code, out, err) = e.run_with_file_size_limit(&["hook", "--event", "SessionStart"], true, &payload, true, &[], 1024 * 1024);

    // a SessionStart cannot block: its hooks are skipped with a loud line, never a block
    assert_eq!((code, out.as_str()), (0, ""), "{err:?}");
    assert!(err.contains("spooled"), "{err:?}");
    let log = std::fs::read_to_string(e.state().join(ah_engine::health::log_name())).unwrap();
    assert!(log.contains("dispatch_spool_unavailable"), "{log}");
    assert!(e.dispatch_temp_files().is_empty(), "temp payload files left behind: {:?}", e.dispatch_temp_files());
}

fn killed_dispatcher_leaves_no_spool_file(signal: i32, tag: &str) {
    let e = Env::new(tag);
    let payload = session_payload_len(ah_engine::defaults::num("client.max_stdin") as usize + 4097);
    let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
    c.args(["hook", "--event", "SessionStart"])
        .env_clear()
        // External CARGO_TARGET_DIR builds cannot discover the checkout by walking up from the executable.
        .env("AH_ENGINE_PLUGIN_ROOT", std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall"))
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
    // the dispatcher spools everything past the cap and keeps reading until stdin closes: send more than the cap, hold the pipe open
    // so the dispatcher sits in its read with the spool file open, then kill it there
    let writer = std::thread::spawn(move || {
        let sent = stdin.write_all(payload.as_bytes());
        std::thread::sleep(Duration::from_millis(1500)); // the pipe stays open while the signal arrives
        drop(stdin);
        sent
    });
    let spooled = Instant::now();
    while spooled.elapsed() < Duration::from_secs(10)
        && !std::fs::read_to_string(e.state().join(ah_engine::health::log_name())).is_ok_and(|l| l.contains("dispatch_stdin_spooled"))
    {
        // the spool exists once the dispatcher has read past the cap; the log line is written after the read ends, so the wait is bounded
        if writer.is_finished() {
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    // SAFETY: `kill` takes plain integers and has no memory-safety preconditions; a dead pid just fails with ESRCH.
    unsafe {
        libc::kill(child.id() as libc::pid_t, signal);
    }
    ah_engine::discard::harmless(child.wait());
    ah_engine::discard::harmless(writer.join());
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
fn dispatcher_stdin_cap_boundaries_are_exact() {
    let e = Env::new("stdin-boundaries");
    let max = ah_engine::defaults::num("client.max_stdin") as usize;
    let spooled =
        |e: &Env| std::fs::read_to_string(e.state().join(ah_engine::health::log_name())).unwrap_or_default().matches("dispatch_stdin_spooled").count();
    // a SessionStart cannot block: at the cap it is read whole in memory, one byte more goes to the spool and is said so
    let args = ["hook", "--event", "SessionStart"];
    let (code, _, err) = e.run(&args, true, &session_payload_len(max), true);
    assert_eq!(code, 0, "{err}");
    assert_eq!(spooled(&e), 0, "a payload of exactly the cap stays in memory");
    let (code, _, err) = e.run(&args, true, &session_payload_len(max + 1), true);
    assert_eq!(code, 0, "{err}");
    assert_eq!(spooled(&e), 1, "one byte more is over the cap");
    assert!(e.dispatch_temp_files().is_empty(), "temp payload files left behind: {:?}", e.dispatch_temp_files());
    // a guard event at the cap is read whole but is too big for the checks to decide (their request limit is far below the stdin
    // cap), and one byte more is spooled: both follow the infra failure mode (closed, stricter than Node, which ran its hooks)
    let args = ["hook", "--event", "PreToolUse"];
    for len in [max, max + 1] {
        let (code, out, err) = e.run(&args, true, &pretool_payload_len(len), true);
        assert_eq!((code, out.as_str()), (2, ""), "{len}: {err}");
        assert!(err.contains("could not run the guards for PreToolUse"), "{len}: {err}");
    }
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
    let stable_text = [("ANTIHALL_REPEAT_HINT", "0")];
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
    let guarded = e.run_with(&args, false, &p, true, &stable_text);
    let unguarded = e.run_with(&args, false, &p, true, &off);
    let guarded_again = e.run_with(&args, false, &p, true, &stable_text);
    e.stop();
    assert_eq!(guarded.0, 2, "client without the switch: blocked although the daemon's own environment has it off: {guarded:?}");
    assert_eq!(unguarded, (0, String::new(), String::new()), "client with the switch: allowed");
    assert_eq!(guarded_again, guarded, "the switch of one client does not stick to the daemon");
}

/// The real engine and a payload serde_json rejects (a lone surrogate escape, `{bad`, invalid UTF-8): the engine cannot decide a guard
/// event it cannot read, and no Node hook exists to leave it to, so it fails closed (stricter than Node, which allowed the first two).
/// (With the engine absent the thin client passes the call through: ah-launcher/tests/behaviour.rs.)
#[test]
fn the_engine_fails_closed_on_unparsable_guard_payloads() {
    let e = Env::new("engine-unparsable");
    let surrogate = br#"{"hook_event_name":"PreToolUse","tool_name":"Bash","session_id":"s","cwd":"/tmp","tool_input":{"command":"echo hi \ud83d"}}"#.to_vec();
    let invalid_utf8 =
        b"{\"hook_event_name\":\"PreToolUse\",\"tool_name\":\"Bash\",\"session_id\":\"s\",\"cwd\":\"/tmp\",\"tool_input\":{\"command\":\"echo \xffhi\"}}"
            .to_vec();
    let run = |payload: &[u8]| -> (i32, String) {
        let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
        c.args(["hook", "--event", "PreToolUse"])
            .env_clear()
            // External CARGO_TARGET_DIR builds cannot discover the checkout by walking up from the executable.
            .env("AH_ENGINE_PLUGIN_ROOT", std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall"))
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .env("HOME", e.dir.join("home"))
            .env("AH_ENGINE_DIR", e.state())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut ch = c.spawn().unwrap();
        ch.stdin.take().unwrap().write_all(payload).unwrap();
        let o = ch.wait_with_output().unwrap();
        (o.status.code().unwrap(), String::from_utf8_lossy(&o.stderr).to_string())
    };
    for (name, payload) in [("lone surrogate", surrogate), ("not JSON", b"{bad".to_vec())] {
        let r = run(&payload);
        assert_eq!(r.0, 2, "{name}: the engine cannot read the payload, so the guard event is closed: {}", r.1);
        assert!(r.1.contains("could not run the guards for PreToolUse"), "{name}: {}", r.1);
    }
    let (code, err) = run(&invalid_utf8);
    assert_eq!(code, 2, "invalid UTF-8: the engine fails closed (D74), stricter than Node: {err}");
    assert!(err.contains("not valid UTF-8"), "{err}");
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
        assert!(
            code == 2 && !err.contains(&closed_text("script.msg_env_incomplete")),
            "control: with a whole environment the engine answers itself: {code} {err:?}"
        );
        let (code, _, err) = broken(&e);
        e.stop();
        assert_eq!((code, err.contains(&closed_text("script.msg_env_incomplete"))), (2, true), "an incomplete environment cannot be checked: closed: {err:?}");
        return;
    }
    // warm the daemon: the first call goes through Node, later ones are answered by the daemon
    let mut native = false;
    for _ in 0..50 {
        let (code, _, err) = e.run_with(&args, false, &p, true, &gate);
        if code == 2 && !err.contains(&closed_text("script.msg_unanswered")) {
            native = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    assert!(native, "control: the warm daemon answers the gated Edit natively");
    let (code, _, err) = broken(&e);
    e.stop();
    assert_eq!(
        (code, err.contains(&closed_text("script.msg_env_incomplete"))),
        (2, true),
        "daemon: an incomplete environment cannot be checked: closed: {err:?}"
    );
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
        if in_process {
            let extra = [("ANTIHALL_SHIPIT_GATE", "1"), ("HOME", "")];
            let (code, _, err) = e.run_with(&args, true, &p, true, &extra);
            assert_eq!(
                (code, err.contains(&closed_text("script.msg_env_incomplete"))),
                (2, true),
                "an empty HOME cannot be checked in-process: closed: {err:?}"
            );
        } else {
            let gate = [("ANTIHALL_SHIPIT_GATE", "1")];
            wait_for_daemon_native_block(&e, &args, &p, &gate);
            let extra = [("ANTIHALL_SHIPIT_GATE", "1"), ("HOME", "")];
            let (code, _, err) = e.run_with(&args, false, &p, true, &extra);
            assert_eq!(
                (code, err.contains(&closed_text("script.msg_env_incomplete"))),
                (2, true),
                "an empty HOME with a healthy daemon cannot be checked: closed: {err:?}"
            );
        }
        e.stop();
    }
}

// ---- token cuts: the injection gate, through the real daemon -------------------------------------------------------------

fn ups_payload(session: &str) -> String {
    // no working directory: a DevSwarm Primary's tier gate cannot be settled without it, so the native checks hand the prompt to Node
    serde_json::json!({"session_id": session, "hook_event_name": "UserPromptSubmit", "prompt": "hi"}).to_string()
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

/// A UserPromptSubmit payload with a transcript the check can measure growth against.
fn ups_payload_tr(session: &str, transcript: &Path) -> String {
    serde_json::json!({"session_id": session, "hook_event_name": "UserPromptSubmit", "prompt": "hi", "cwd": "/tmp", "transcript_path": transcript}).to_string()
}

#[test]
fn a_repeated_task_reminder_is_cut_through_the_daemon_and_a_new_session_starts_whole() {
    let e = Env::new("inject-gate");
    // The task tracker is native and rations its own reminder (the Node text the gate used to cut no longer exists): the first turn
    // of a session carries the directive, the turns after it say nothing while nothing changed, and a new session starts whole again.
    let tr = e.dir.join("tr.jsonl");
    std::fs::write(&tr, format!("{}\n", serde_json::json!({"type": "user", "message": {"role": "user", "content": "hello"}}))).unwrap();
    let args = ["hook", "--event", "UserPromptSubmit"];
    let on = [("ANTIHALL_INJECT_GATE_TASK_EVERY", "3")];
    warm(&e, &args, &on);
    let marker = ah_engine::defaults::text("task_tracker.what_full");
    let seen: Vec<String> = (0..5).map(|_| context_of(&e.run_with(&args, false, &ups_payload_tr("sess-on", &tr), true, &on).1)).collect();
    e.stop();
    assert!(seen[0].contains(marker), "the first turn of the session carries the directive: {seen:?}");
    assert!(seen[1..].iter().all(|c| !c.contains(marker)), "the turns after it repeat nothing: {seen:?}");
    // a new session starts whole again
    let e = Env::new("inject-gate-new");
    let tr = e.dir.join("tr.jsonl");
    std::fs::write(&tr, format!("{}\n", serde_json::json!({"type": "user", "message": {"role": "user", "content": "hello"}}))).unwrap();
    warm(&e, &args, &on);
    let first = context_of(&e.run_with(&args, false, &ups_payload_tr("sess-a", &tr), true, &on).1);
    let other = context_of(&e.run_with(&args, false, &ups_payload_tr("sess-b", &tr), true, &on).1);
    e.stop();
    assert!(first.contains(marker) && other.contains(marker), "{first:?} {other:?}");
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
/// against) is never answered with the neutral no-op: with no Node to hand it to, the guard event follows its configured
/// failure mode (the Stop block is bounded by the stop-loop cap). A thin trigger the fallback list marks empty stays the neutral
/// no-op.
#[test]
fn a_missing_table_row_is_closed_instead_of_allowing() {
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
    assert_eq!(code, 2, "a lost Stop row must not allow: out={out} err={err}");
    assert!(err.contains("no well-formed row for claude Stop"), "{err}");
    // with the plugin's fallback lists present, an event they mark as a thin trigger is the neutral no-op, as in the wrapper
    copy_tree(&src.join("hooks"), &plugin.join("hooks"));
    std::fs::write(&dispatch, &text).unwrap();
    let (code, out, err) = e.run_with(&["hook", "--event", "Notification", "--host", "claude"], true, "{}", false, &env);
    assert_eq!((code, out.as_str()), (0, ""), "a thin trigger stays the neutral no-op: err={err}");
    assert!(done.exists(), "the neutral no-op is the answer, so the dispatch is marked done");
}

// ---- several blocks in one dispatch: every block reason reaches the host, in table order --------------------------------------

#[test]
fn two_built_in_blocks_both_reach_the_host_in_table_order() {
    let e = Env::new("two-blocks-pre");
    // git-guard's check and command-guard's check block a force push followed by heavy work in the main thread: the host, running both hooks,
    // would show both reasons, git-guard's first (table order)
    let p = bash(&["git push", "--force origin main && npm test"].join(" "), &e.dir);
    let (code, out, err) = e.run_with(&["hook", "--event", "PreToolUse"], true, &p, true, &[("CLAUDE_CODE_ENTRYPOINT", "cli")]);
    assert_eq!(code, 2, "{out:?} {err:?}");
    let (git_at, command_at) = (
        err.find(ah_engine::defaults::raw("git.msg_force_push").str_field("what")),
        err.find(ah_engine::defaults::raw("guardkit.brief_what").str_field("command-guard")),
    );
    assert!(git_at.is_some() && command_at.is_some() && git_at < command_at, "both reasons, in table order: {err:?}");
}

#[test]
fn a_reminder_that_is_cut_is_no_output_not_an_empty_context() {
    let e = Env::new("inject-gate-empty");
    let tr = e.dir.join("tr.jsonl");
    std::fs::write(&tr, format!("{}\n", serde_json::json!({"type": "user", "message": {"role": "user", "content": "hello"}}))).unwrap();
    let args = ["hook", "--event", "UserPromptSubmit"];
    let on = [("ANTIHALL_INJECT_GATE_TASK_EVERY", "3")];
    warm(&e, &args, &on);
    let first = e.run_with(&args, false, &ups_payload_tr("sess-empty", &tr), true, &on);
    let second = e.run_with(&args, false, &ups_payload_tr("sess-empty", &tr), true, &on);
    e.stop();
    assert!(context_of(&first.1).contains(ah_engine::defaults::text("task_tracker.what_full")), "{first:?}");
    assert_eq!(second, (0, String::new(), String::new()), "a suppressed reminder prints nothing, not an empty additionalContext");
}

/// L11 (#69): the speculation judge's model call. The daemon cannot wait seconds for a model, so it defers the check; the
/// dispatcher process, which can, runs it itself before any Node hook, in process and through the daemon alike. The Node hook
/// mapped here must never run, the fake `claude` must be called once, and the block is the check's own.
#[test]
fn the_dispatcher_makes_the_speculation_judge_call_itself_after_the_daemon_deferred_it() {
    let e = Env::new("judgecall");
    let home = e.dir.join("home");
    std::fs::create_dir_all(home.join(".anti-hall")).unwrap();
    std::fs::write(home.join(".anti-hall/settings.json"), r#"{"jev":{"semanticJudge":true,"judgeBackend":"cli"}}"#).unwrap();
    let bin = e.dir.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let claude = bin.join("claude");
    std::fs::write(&claude, "#!/bin/sh\nd=\"$FAKE_CLAUDE_LOG/call-$$\"\nmkdir -p \"$d\"\ncat > \"$d/stdin\"\ncat \"$FAKE_CLAUDE_REPLY\"\n").unwrap();
    std::fs::set_permissions(&claude, std::fs::Permissions::from_mode(0o755)).unwrap();
    let reply = e.dir.join("reply.txt");
    let answer = serde_json::json!({"is_error": false, "result": r#"{"decision":"block","claim":"the cache is stale"}"#}).to_string();
    std::fs::write(&reply, answer).unwrap();
    let transcript = e.dir.join("t.jsonl");
    std::fs::write(&transcript, format!("{}\n", serde_json::json!({"type": "user", "message": {"role": "user", "content": "why is it slow?"}}))).unwrap();
    let ids: Vec<String> = ah_engine::dispatch::table::entries("claude", "Stop").into_iter().map(|x| x.id).collect();
    let m: serde_json::Map<String, serde_json::Value> =
        ids.iter().map(|id| (id.clone(), if id == "speculation-judge" { "printf NODE-RAN >&2; exit 0" } else { "true" }.into())).collect();
    let map = e.dir.join("stop-map.json");
    std::fs::write(&map, serde_json::json!({ "Stop": m }).to_string()).unwrap();
    let args = ["hook", "--event", "Stop", "--fallback-map", map.to_str().unwrap()];
    let path = format!("{}:{}", bin.display(), path_without_codex());
    let log = e.dir.join("calls");
    let calls = || std::fs::read_dir(&log).map(|d| d.count()).unwrap_or(0);
    let env = [("PATH", path.as_str()), ("FAKE_CLAUDE_LOG", log.to_str().unwrap()), ("FAKE_CLAUDE_REPLY", reply.to_str().unwrap())];
    let payload = |session: &str| {
        serde_json::json!({"session_id": session, "cwd": e.dir, "hook_event_name": "Stop", "transcript_path": transcript, "last_assistant_message": "The cause is the stale cache."})
            .to_string()
    };
    // in process
    let (code, out, err) = e.run_with(&args, true, &payload("jc-1"), true, &env);
    assert_eq!(code, 0, "{out:?} {err:?}");
    assert!(out.contains("\"decision\":\"block\"") && out.contains(ah_engine::defaults::text("speculation_judge.msg_what")), "{out:?} {err:?}");
    assert!(!err.contains("NODE-RAN"), "the Node hook must not run: {err:?}");
    assert_eq!(calls(), 1);
    // through the daemon: the first call may fail open while the daemon starts; a later call is answered by the daemon,
    // which defers this slow check back to the dispatcher without running the Node hook.
    let mut last = (0, String::new(), String::new());
    for i in 0..50 {
        last = e.run_with(&args, false, &payload(&format!("jc-d{i}")), true, &env);
        if last.1.contains("\"decision\":\"block\"") && !last.2.contains("NODE-RAN") {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    e.stop();
    assert!(
        last.1.contains("\"decision\":\"block\"") && last.1.contains(ah_engine::defaults::text("speculation_judge.msg_what")) && !last.2.contains("NODE-RAN"),
        "{last:?}"
    );
    assert!(calls() >= 2, "the dispatcher made the call for the daemon-deferred check: {}", calls());
    let tel = std::fs::read_to_string(home.join(".anti-hall/logs/judge-calls.ndjson")).unwrap();
    assert!(tel.lines().all(|l| l.contains("\"integration\":\"speculation\"") && l.contains("\"decision\":\"block\"")) && tel.lines().count() >= 2, "{tel}");
}

/// The daemon's ACK(res) wait (`wire.res_wait_ms`) covers the hand-over of its answers, not the dispatcher's own work after them
/// (a model call it makes itself, Node hooks, combining). Live20: every Stop whose deferred speculation-judge call outlasted the
/// wait was logged as an `undelivered_verdict` fail-open (and flipped the engine to degraded) although the block reached stdout;
/// the late ACK(res) then hit the socket the daemon had already closed (`client_ack_res write_failed: Invalid argument`, macOS).
#[test]
fn a_dispatcher_that_works_on_after_the_reply_still_confirms_the_daemon_verdict() {
    let e = Env::new("resafter");
    let home = e.dir.join("home");
    std::fs::create_dir_all(home.join(".anti-hall")).unwrap();
    std::fs::write(home.join(".anti-hall/settings.json"), r#"{"jev":{"semanticJudge":true,"judgeBackend":"cli"}}"#).unwrap();
    let bin = e.dir.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let claude = bin.join("claude");
    // the model call outlasts the daemon's ACK(res) wait by a wide margin
    let slow = ah_engine::defaults::millis("wire.res_wait_ms") * 3;
    std::fs::write(&claude, format!("#!/bin/sh\ncat >/dev/null\nsleep {:.3}\ncat \"$FAKE_CLAUDE_REPLY\"\n", slow.as_secs_f64())).unwrap();
    std::fs::set_permissions(&claude, std::fs::Permissions::from_mode(0o755)).unwrap();
    let reply = e.dir.join("reply.txt");
    let answer = serde_json::json!({"is_error": false, "result": r#"{"decision":"block","claim":"the cache is stale"}"#}).to_string();
    std::fs::write(&reply, answer).unwrap();
    let transcript = e.dir.join("t.jsonl");
    std::fs::write(&transcript, format!("{}\n", serde_json::json!({"type": "user", "message": {"role": "user", "content": "why is it slow?"}}))).unwrap();
    let ids: Vec<String> = ah_engine::dispatch::table::entries("claude", "Stop").into_iter().map(|x| x.id).collect();
    let m: serde_json::Map<String, serde_json::Value> = ids.iter().map(|id| (id.clone(), "true".into())).collect();
    let map = e.dir.join("stop-map.json");
    std::fs::write(&map, serde_json::json!({ "Stop": m }).to_string()).unwrap();
    let args = ["hook", "--event", "Stop", "--fallback-map", map.to_str().unwrap()];
    let path = format!("{}:{}", bin.display(), path_without_codex());
    let env = [("PATH", path.as_str()), ("FAKE_CLAUDE_REPLY", reply.to_str().unwrap())];
    let payload = |session: &str| {
        serde_json::json!({"session_id": session, "cwd": e.dir, "hook_event_name": "Stop", "transcript_path": transcript, "last_assistant_message": "The cause is the stale cache."})
            .to_string()
    };
    let log = || std::fs::read_to_string(e.state().join("ah-engine.log")).unwrap_or_default();
    let caps = e.state().join(ah_engine::defaults::text("wire.caps_file"));
    // the first calls may fail open while the daemon starts; a call made once it announced the ack protocol is the one under test
    let mut last = (0, String::new(), String::new());
    for i in 0..50 {
        let ack_mode = caps.exists();
        last = e.run_with(&args, false, &payload(&format!("ra-{i}")), true, &env);
        if ack_mode && last.1.contains("\"decision\":\"block\"") {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    // the daemon decides about the ACK(res) within its wait; give it that and a margin before reading its log
    std::thread::sleep(ah_engine::defaults::millis("wire.res_wait_ms") * 2);
    let health = log();
    e.stop();
    assert!(last.1.contains("\"decision\":\"block\"") && last.1.contains(ah_engine::defaults::text("speculation_judge.msg_what")), "{last:?}");
    assert!(!health.contains("\tundelivered_verdict\t"), "a verdict that reached stdout is not undelivered:\n{health}");
    assert!(!health.contains("\tclient_ack_res\t"), "the ACK(res) reaches the daemon:\n{health}");
}

// ---- a slow daemon reply is late, not down (R0 P0: guards failed open for 3 s after one reply past the deadline) ---------

/// A stub daemon that answers connection `i` after `script[i].0` ms with `script[i].1` (the last step repeats); every
/// connection is handled on its own thread and counted when its request has been read.
struct ScriptedDaemon {
    alive: Arc<AtomicBool>,
    seen: Arc<std::sync::atomic::AtomicUsize>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl ScriptedDaemon {
    fn seen(&self) -> usize {
        self.seen.load(Ordering::Acquire)
    }
}

impl Drop for ScriptedDaemon {
    fn drop(&mut self) {
        self.alive.store(false, Ordering::Release);
        if let Some(t) = self.thread.take() {
            let _join_result = t.join();
        }
    }
}

fn scripted_daemon(e: &Env, script: Vec<(u64, ah_engine::frame::Kind, &'static str)>) -> ScriptedDaemon {
    scripted_daemon_gated(e, script, false)
}

fn scripted_daemon_gated(e: &Env, script: Vec<(u64, ah_engine::frame::Kind, &'static str)>, wait_for_late: bool) -> ScriptedDaemon {
    std::fs::create_dir_all(e.state()).unwrap();
    let log = e.state().join(ah_engine::health::log_name());
    let sock = ah_engine::paths::socket_in(&e.state());
    ah_engine::discard::harmless(std::fs::remove_file(&sock));
    let listener = std::os::unix::net::UnixListener::bind(&sock).unwrap();
    listener.set_nonblocking(true).unwrap();
    let alive = Arc::new(AtomicBool::new(true));
    let seen = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let (a, s) = (Arc::clone(&alive), Arc::clone(&seen));
    let thread = std::thread::spawn(move || {
        while a.load(Ordering::Acquire) {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let i = s.fetch_add(1, Ordering::AcqRel);
                    let (delay, kind, body) = script[i.min(script.len() - 1)];
                    let log = log.clone();
                    std::thread::spawn(move || {
                        stream.set_nonblocking(false).unwrap();
                        let mut req = Vec::new();
                        ah_engine::discard::harmless(stream.read_to_end(&mut req));
                        if wait_for_late {
                            let until = Instant::now() + common::scaled(Duration::from_secs(5));
                            while !std::fs::read_to_string(&log).is_ok_and(|s| s.contains("\tclient_late\t")) {
                                assert!(Instant::now() < until, "client never reached its late-reply wait");
                                std::thread::yield_now();
                            }
                        } else {
                            std::thread::sleep(Duration::from_millis(delay));
                        }
                        ah_engine::discard::harmless(stream.write_all(&ah_engine::frame::encode(kind, body)));
                    });
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(5)),
                Err(_) => break,
            }
        }
    });
    ScriptedDaemon { alive, seen, thread: Some(thread) }
}

const FAST_OK: (u64, ah_engine::frame::Kind, &str) = (0, ah_engine::frame::Kind::Ok, "[]");
/// A reply that comes after the whole wait window (`AH_ENGINE_SLOW_FALLBACK_MAX_MS` 700 less the 400 ms margin = 300 ms in these tests).
const NEVER: (u64, ah_engine::frame::Kind, &str) = (9000, ah_engine::frame::Kind::Ok, "[]");
const WINDOW: (&str, &str) = ("AH_ENGINE_SLOW_FALLBACK_MAX_MS", "700");

/// One blocking-guard dispatch against the stub with a 100 ms client deadline.
fn slow_call(e: &Env, map: &Path, extra: &[(&str, &str)]) -> (i32, String, String) {
    let args = ["hook", "--event", "PreToolUse", "--fallback-map", map.to_str().unwrap()];
    let mut env = vec![("AH_ENGINE_DEADLINE_MS", "100"), ("AH_ENGINE_NOSPAWN", "1")];
    env.extend_from_slice(extra);
    e.run_with(&args, false, &bash("ls", &e.dir), true, &env)
}

fn engine_log(e: &Env) -> String {
    std::fs::read_to_string(e.state().join("ah-engine.log")).unwrap_or_default()
}

#[test]
fn a_late_reply_is_waited_for_and_never_runs_the_node_hooks_twice() {
    let e = Env::new("slow-not-down");
    let marker = e.dir.join("node-ran");
    let map = event_map(&e, "PreToolUse", &format!("touch {}; echo NODEBLOCK >&2; exit 2", marker.display()), "true");
    // Reply only after the client has entered its late-reply wait, independent of scheduler timing.
    let d = scripted_daemon_gated(&e, vec![FAST_OK], true);
    let (code, _, _) = slow_call(&e, &map, &[("AH_ENGINE_SLOW_FALLBACK_MAX_MS", "1500")]); // window 1100 ms
    assert_eq!(d.seen(), 1, "the call reaches the daemon exactly once");
    assert!(engine_log(&e).contains("\tclient_late\t"), "{}", engine_log(&e));
    assert!(!engine_log(&e).contains("\tclient_slow\t"), "a reply inside the window is not a slow call: {}", engine_log(&e));
    assert!(!marker.exists(), "the late daemon reply must not run the Node hook");
    let _ = code; // the dispatch decision on a "[]" answer is not what this test pins
}

#[test]
fn a_reply_that_never_comes_fails_open_without_node_and_counts_in_the_slow_streak() {
    let e = Env::new("slow-never");
    let marker = e.dir.join("node-ran");
    let map = event_map(&e, "PreToolUse", &format!("touch {}; echo NODEBLOCK >&2; exit 2", marker.display()), "true");
    let d = scripted_daemon(&e, vec![NEVER, NEVER]);
    let t = Instant::now();
    let (code, out, err) = slow_call(&e, &map, &[WINDOW, ("AH_ENGINE_SLOW_DOWN_N", "2")]);
    assert_eq!((code, out.as_str()), (0, ""), "no reply in the window: fail open");
    assert!(err.contains("went through unchecked"), "the session is told once (#229): {err:?}");
    assert!(t.elapsed() < common::scaled(Duration::from_millis(7000)), "bounded by the window, not the daemon: {:?} {}", t.elapsed(), engine_log(&e));
    assert!(!marker.exists(), "the Node hook must not run for a call the daemon may have processed");
    assert!(engine_log(&e).contains("\tclient_slow\t"), "{}", engine_log(&e));
    assert!(!e.state().join("daemon.down.until").exists(), "one slow call must not mark the daemon down");
    let (code, _, err) = slow_call(&e, &map, &[WINDOW, ("AH_ENGINE_SLOW_DOWN_N", "2")]);
    assert_eq!((code, err.as_str()), (0, ""), "the same session is not told twice");
    assert!(!marker.exists());
    assert!(e.state().join("daemon.down.until").exists(), "two slow calls in a row mark the daemon down: {}", engine_log(&e));
    assert_eq!(d.seen(), 2);
}

#[test]
fn consecutive_slow_calls_mark_a_wedged_daemon_down_and_a_normal_reply_resets_the_count() {
    let e = Env::new("slow-streak");
    let map = event_map(&e, "PreToolUse", "echo NODEBLOCK >&2; exit 2", "true");
    let n = [WINDOW, ("AH_ENGINE_SLOW_DOWN_N", "2")];
    // slow, normal, slow: the normal reply in between resets the count, so nothing is marked
    let d = scripted_daemon(&e, vec![NEVER, FAST_OK, NEVER, NEVER]);
    for _ in 0..3 {
        slow_call(&e, &map, &n);
    }
    assert!(!e.state().join("daemon.down.until").exists(), "{}", engine_log(&e));
    // the second slow in a row trips it
    let (code, _, err) = slow_call(&e, &map, &n);
    assert_eq!((code, err.as_str()), (0, ""), "a slow call fails open");
    assert!(e.state().join("daemon.down.until").exists(), "two slow calls in a row mark the daemon down: {}", engine_log(&e));
    // marked down: the next call does not reach the daemon
    let before = d.seen();
    slow_call(&e, &map, &n);
    assert_eq!(d.seen(), before);
}
