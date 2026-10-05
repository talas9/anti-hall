//! D74: the fail-closed invariant matrix. A guard event (`dispatch.guard_events`) crossed with every injected failure.
//!
//! The invariant, for every combination: the call EITHER exits 2 with a non-empty message on stderr (the engine could
//! not run the guards, or a hook really blocked), OR ends the way Node's separate hooks would (a real block stays a
//! block with its exit code and message, a real decision stays a decision). It is never exit 0 with empty stdout and
//! stderr unless a hook that actually ran allowed: every injected hook touches a marker file first, so "a hook ran" is
//! proved, not assumed.
//!
//! Table-driven: a new failure mode is one `Row` line in [`rows`]. The input-side rows (a bad payload, a missing tool)
//! are crossed with an allowing and a blocking hook; the hook-side rows carry their own hook command and expectation.
//! Every row runs for every host and guard event the dispatch table has entries for.
//!
//! Not injectable end to end, and covered by unit tests instead: a spawn failure from the shell itself (EAGAIN; a NUL in
//! the command stands in for it here), a hook timeout (it needs the table's real timeout; `dispatch::node` tests it with
//! a short one and the dispatcher logs it), and a panicking check (the panic is caught per check and defers to Node).

mod common;

use ah_engine::dispatch::table;
use serde_json::Value;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

/// What the dispatcher reads from stdin.
#[derive(Clone, Copy)]
enum Stdin {
    /// A valid payload for the event.
    Valid,
    /// A payload cut off by `client.max_stdin`: valid JSON up to a point, then more bytes than the client reads.
    Truncated,
    /// Text that is not JSON.
    NotJson,
    /// Bytes that are not UTF-8.
    NotUtf8,
    /// Valid JSON without a `tool_name`.
    NoToolName,
    /// A stdin whose read fails (a directory).
    ReadError,
    /// A valid payload with `stop_hook_active` true (the host says a Stop hook already blocked this turn).
    StopActive,
}

/// Whether the wiring passes `--tool`.
#[derive(Clone, Copy)]
enum Tool {
    /// The tool the payload names (`Bash`).
    Given,
    /// No `--tool` argument.
    Omitted,
    /// A tool no entry knows.
    Unknown,
}

/// The injected Node hook.
#[derive(Clone, Copy)]
enum Hook {
    /// An input-side failure: run once with an allowing hook and once with a blocking one.
    Crossed,
    /// This command replaces the first Node hook of the event; `second` replaces the next one.
    Cmd { first: &'static str, second: &'static str },
}

/// What the call must do.
#[derive(Clone, Copy)]
enum Want {
    /// Exit 2 with the engine's "could not run the guards" message.
    Closed,
    /// Exit 2 and stderr contains this (a real block stays a block).
    Blocks(&'static str),
    /// Exit 2 with the hook's own block (this marker on stderr) or with the engine's fail-closed message; never an allow.
    BlocksOrClosed(&'static str),
    /// Exit 0 and stdout is ONE JSON object containing this.
    OneJson(&'static str),
    /// The engine had nothing to run, or no entry applies: exit 0 is right.
    Quiet,
    /// Exit 2 (closed) or a real allow from a hook that ran.
    ClosedOrAllow,
    /// Exit 0 with the engine's "could not run the guards" note on stderr: a Stop that must not loop (D74).
    Open,
    /// Exit 0 and every hook ran: the host's own reading of a hook that said nothing, timed out or only printed text.
    Allow,
}

/// How the built-in checks are answered.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Daemon {
    /// Inside the client (`dispatch.in_process` 1): no daemon.
    InProcess,
    /// Through the daemon path with no daemon and none to start: every check runs as its Node hook.
    Down,
    /// A daemon that answers with a frame whose body is not a reply.
    Garbage,
    /// A daemon that answers every check with a block, `DAEMONBLOCK` on stderr.
    Blocks,
}

#[derive(Clone, Copy)]
struct Row {
    name: &'static str,
    stdin: Stdin,
    tool: Tool,
    hook: Hook,
    want: Want,
    /// `false`: no plugin root in the environment and no fallback map, so the table's own commands cannot run.
    runnable: bool,
    host_arg: Option<&'static str>,
    event_arg: Option<&'static str>,
    daemon: Daemon,
    /// Only these events (empty: every guard event).
    events: &'static [&'static str],
}

const STOPS: &[&str] = &["Stop", "SubagentStop"];

const BASE: Row = Row {
    name: "",
    stdin: Stdin::Valid,
    tool: Tool::Given,
    hook: Hook::Crossed,
    want: Want::ClosedOrAllow,
    runnable: true,
    host_arg: None,
    event_arg: None,
    daemon: Daemon::InProcess,
    events: &[],
};

const MARK: &str = r#"touch "$AH_TEST_MARK""#;
const MARK2: &str = r#"touch "$AH_TEST_MARK2""#;
const BLOCK: &str = r#"touch "$AH_TEST_MARK"; echo BLOCKME >&2; exit 2"#;
const PRE: &[&str] = &["PreToolUse"];

// Two contexts of 6000 characters each: inline for the host one by one, over its 10000 cap when joined.
const CTX_ASK: &str = r#"touch "$AH_TEST_MARK"; printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"r","additionalContext":"%s"}}\n' "$(head -c 6000 /dev/zero | tr '\0' a)""#;
const CTX_DEFER: &str = r#"touch "$AH_TEST_MARK"; printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"defer","additionalContext":"%s"}}\n' "$(head -c 6000 /dev/zero | tr '\0' a)""#;
const CTX_DENY: &str = r#"touch "$AH_TEST_MARK"; printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"DENYME","additionalContext":"%s"}}\n' "$(head -c 6000 /dev/zero | tr '\0' a)""#;
const CTX_BLOCK_EXIT2: &str = r#"touch "$AH_TEST_MARK"; printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"%s"}}\n' "$(head -c 6000 /dev/zero | tr '\0' a)"; echo BLOCKME >&2; exit 2"#;
const CTX_PLAIN: &str = r#"touch "$AH_TEST_MARK"; printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"%s"}}\n' "$(head -c 6000 /dev/zero | tr '\0' a)""#;
const CTX_OTHER: &str = r#"touch "$AH_TEST_MARK2"; printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"%s"}}\n' "$(head -c 6000 /dev/zero | tr '\0' b)""#;
const JSON_X1: &str = r#"touch "$AH_TEST_MARK"; printf '{"systemMessage":"one","x":1}\n'"#;
const JSON_X2_ASK: &str = r#"touch "$AH_TEST_MARK2"; printf '{"x":2,"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"r"}}\n'"#;

/// One line per failure mode.
fn rows() -> Vec<Row> {
    vec![
        // ---- input side: crossed with an allowing and a blocking hook ----
        Row { name: "truncated payload, tool given", stdin: Stdin::Truncated, ..BASE },
        Row { name: "truncated payload, no --tool", stdin: Stdin::Truncated, tool: Tool::Omitted, ..BASE },
        Row { name: "invalid JSON, tool given", stdin: Stdin::NotJson, ..BASE },
        Row { name: "invalid JSON, no --tool", stdin: Stdin::NotJson, tool: Tool::Omitted, ..BASE },
        Row { name: "non-UTF-8 stdin, tool given", stdin: Stdin::NotUtf8, ..BASE },
        Row { name: "non-UTF-8 stdin, no --tool", stdin: Stdin::NotUtf8, tool: Tool::Omitted, ..BASE },
        Row { name: "stdin read error, tool given", stdin: Stdin::ReadError, ..BASE },
        Row { name: "stdin read error, no --tool", stdin: Stdin::ReadError, tool: Tool::Omitted, ..BASE },
        Row { name: "no --tool, valid payload", tool: Tool::Omitted, ..BASE },
        Row { name: "no --tool, payload without tool_name", stdin: Stdin::NoToolName, tool: Tool::Omitted, ..BASE },
        // ---- unknown tool / event: nothing applies, so a quiet exit 0 is right ----
        Row { name: "unknown tool", tool: Tool::Unknown, hook: Hook::Cmd { first: MARK, second: MARK2 }, want: Want::Quiet, events: PRE, ..BASE },
        Row { name: "unknown event", event_arg: Some("NoSuchEvent"), hook: Hook::Cmd { first: MARK, second: MARK2 }, want: Want::Quiet, ..BASE },
        // ---- wiring ----
        Row { name: "bad host", host_arg: Some("nope"), want: Want::Closed, ..BASE },
        Row { name: "unset plugin root", runnable: false, want: Want::Closed, ..BASE },
        // a Stop that exits 2 keeps the agent running, so on a state it cannot repair the flag fails it open
        Row {
            name: "unset plugin root, stop_hook_active",
            stdin: Stdin::StopActive,
            runnable: false,
            hook: Hook::Cmd { first: MARK, second: MARK2 },
            want: Want::Open,
            events: STOPS,
            ..BASE
        },
        Row {
            name: "hook cannot spawn, stop_hook_active",
            stdin: Stdin::StopActive,
            hook: Hook::Cmd { first: "a\0b", second: "true" },
            want: Want::Open,
            events: STOPS,
            ..BASE
        },
        Row {
            name: "stop_hook_active with a blocking hook is still the hook's block",
            stdin: Stdin::StopActive,
            hook: Hook::Cmd { first: BLOCK, second: MARK2 },
            want: Want::Blocks("BLOCKME"),
            events: STOPS,
            ..BASE
        },
        // ---- hook side ----
        Row { name: "hook cannot spawn", hook: Hook::Cmd { first: "a\0b", second: "true" }, want: Want::Closed, ..BASE },
        Row { name: "hook killed by a signal", hook: Hook::Cmd { first: "touch \"$AH_TEST_MARK\"; kill -9 $$", second: "true" }, want: Want::Closed, ..BASE },
        Row {
            name: "exit 2 while a grandchild holds stdout and stderr",
            hook: Hook::Cmd { first: r#"touch "$AH_TEST_MARK"; echo BLOCKME >&2; (exec sleep 3) & exit 2"#, second: "true" },
            want: Want::Blocks("BLOCKME"),
            ..BASE
        },
        Row {
            name: "exit 0 with a JSON deny while a grandchild holds the pipes",
            hook: Hook::Cmd {
                first: r#"touch "$AH_TEST_MARK"; printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"DENYME"}}\n'; (exec sleep 3) & exit 0"#,
                second: "true",
            },
            want: Want::OneJson("DENYME"),
            events: PRE,
            ..BASE
        },
        Row {
            name: "exit 0 with partial output while a grandchild holds the pipes",
            hook: Hook::Cmd { first: r#"touch "$AH_TEST_MARK"; echo partial; (exec sleep 3) & exit 0"#, second: "true" },
            want: Want::Closed,
            ..BASE
        },
        Row {
            name: "two hooks print JSON that cannot be merged field by field",
            hook: Hook::Cmd { first: JSON_X1, second: JSON_X2_ASK },
            want: Want::OneJson("\"ask\""),
            events: PRE,
            ..BASE
        },
        // ---- odd hook behavior: what the host does with each is what the dispatcher must do ----
        Row {
            // the host discards a hook past its timeout (the matrix lowers every timeout to 1 s); the other hooks still count
            name: "hook that never exits",
            hook: Hook::Cmd { first: r#"touch "$AH_TEST_MARK"; exec sleep 60"#, second: MARK2 },
            want: Want::Allow,
            ..BASE
        },
        Row {
            // the payload write meets a closed pipe (EPIPE): no crash, no hang, no fail-closed
            name: "hook that closes stdin at once",
            hook: Hook::Cmd { first: r#"exec <&-; touch "$AH_TEST_MARK""#, second: MARK2 },
            want: Want::Allow,
            ..BASE
        },
        Row {
            name: "hook with huge stdout",
            hook: Hook::Cmd { first: r#"touch "$AH_TEST_MARK"; head -c 5000000 /dev/zero | tr '\0' a"#, second: MARK2 },
            want: Want::Allow,
            ..BASE
        },
        Row {
            name: "hook that prints only whitespace and exits 0",
            hook: Hook::Cmd { first: r#"touch "$AH_TEST_MARK"; printf '  \n'"#, second: MARK2 },
            want: Want::Allow,
            ..BASE
        },
        Row {
            name: "exit 0 with a JSON block that has an empty reason",
            hook: Hook::Cmd { first: r#"touch "$AH_TEST_MARK"; printf '{"decision":"block","reason":""}\n'"#, second: MARK2 },
            want: Want::OneJson("\"block\""),
            ..BASE
        },
        // ---- the daemon path (the rows above run the checks in the client) ----
        Row { name: "daemon down", daemon: Daemon::Down, ..BASE },
        Row { name: "daemon answers garbage", daemon: Daemon::Garbage, ..BASE },
        Row {
            name: "daemon decides a block",
            daemon: Daemon::Blocks,
            hook: Hook::Cmd { first: MARK, second: MARK2 },
            want: Want::Blocks("DAEMONBLOCK"),
            events: PRE,
            ..BASE
        },
        // ---- joined context over the host's cap, with every kind of decision ----
        Row {
            name: "over-cap context with an ask",
            hook: Hook::Cmd { first: CTX_ASK, second: CTX_OTHER },
            want: Want::OneJson("\"ask\""),
            events: PRE,
            ..BASE
        },
        Row {
            name: "over-cap context with a defer",
            hook: Hook::Cmd { first: CTX_DEFER, second: CTX_OTHER },
            want: Want::OneJson("\"defer\""),
            events: PRE,
            ..BASE
        },
        Row {
            name: "over-cap context with a JSON deny",
            hook: Hook::Cmd { first: CTX_DENY, second: CTX_OTHER },
            want: Want::OneJson("DENYME"),
            events: PRE,
            ..BASE
        },
        Row {
            name: "over-cap context with an exit-2 block",
            hook: Hook::Cmd { first: CTX_BLOCK_EXIT2, second: CTX_OTHER },
            want: Want::Blocks("BLOCKME"),
            events: PRE,
            ..BASE
        },
        Row {
            name: "over-cap context with an allow",
            hook: Hook::Cmd { first: CTX_PLAIN, second: CTX_OTHER },
            want: Want::OneJson("additionalContext"),
            events: PRE,
            ..BASE
        },
    ]
}

struct Run {
    code: i32,
    out: String,
    err: String,
    /// The first injected hook ran.
    marked: bool,
    /// The second injected hook ran.
    marked2: bool,
    /// A second injected hook that touches its own marker was wired in, so it must have run unless the call fail-closed.
    second_expected: bool,
}

struct Case {
    host: &'static str,
    event: String,
    dir: PathBuf,
}

impl Drop for Case {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn payload(event: &str, dir: &std::path::Path) -> Value {
    if event == "PreToolUse" {
        serde_json::json!({"session_id": "fc", "cwd": dir, "hook_event_name": event, "tool_name": "Bash", "tool_input": {"command": "ls"}})
    } else {
        serde_json::json!({"session_id": "fc", "cwd": dir, "hook_event_name": event})
    }
}

fn stdin_bytes(s: Stdin, event: &str, dir: &std::path::Path) -> Vec<u8> {
    match s {
        Stdin::Valid => payload(event, dir).to_string().into_bytes(),
        Stdin::Truncated => {
            let mut b = br#"{"tool_name":"Bash","tool_input":{"command":"git push --force "#.to_vec();
            b.resize(ah_engine::defaults::num("client.max_stdin") as usize + 4096, b'x');
            b
        }
        Stdin::NotJson => br#"{"tool_name":"Bash","tool_input":{"command":"git push --force"#.to_vec(),
        Stdin::NotUtf8 => {
            let mut b = br#"{"tool_name":"Bash","tool_input":{"command":"ls "#.to_vec();
            b.extend_from_slice(&[0xff, 0xfe, 0xfd]);
            b.extend_from_slice(br#""}}"#);
            b
        }
        Stdin::NoToolName => br#"{"session_id":"fc"}"#.to_vec(),
        Stdin::ReadError => Vec::new(),
        Stdin::StopActive => {
            let mut v = payload(event, dir);
            v["stop_hook_active"] = true.into();
            v.to_string().into_bytes()
        }
    }
}

/// Run the real binary for one row with one hook pair; the fallback map replaces every Node hook of the event.
fn run(case: &Case, row: &Row, first: &str, second: &str) -> Run {
    let _ = std::fs::remove_dir_all(&case.dir);
    run_kept(case, row, first, second)
}

/// [`run`] without wiping the case directory first: the state dir (the Stop block counters) carries over.
fn run_kept(case: &Case, row: &Row, first: &str, second: &str) -> Run {
    std::fs::create_dir_all(case.dir.join("home")).unwrap();
    let mark = case.dir.join("mark");
    let mark2 = case.dir.join("mark2");
    let valid = payload(&case.event, &case.dir);
    let selected = table::select(case.host, &case.event, &valid, Some("Bash"));
    let mut node_only = selected.iter().filter(|e| e.check.is_none()).map(|e| e.id.clone());
    let (id1, id2) = (node_only.next(), node_only.next());
    let second_expected = id2.is_some() && second.contains("AH_TEST_MARK2");
    let events: serde_json::Map<String, Value> = table::entries(case.host, &case.event)
        .into_iter()
        .map(|e| {
            let cmd = if Some(&e.id) == id1.as_ref() {
                first
            } else if Some(&e.id) == id2.as_ref() {
                second
            } else {
                "true"
            };
            (e.id, cmd.into())
        })
        .collect();
    let map = case.dir.join("map.json");
    std::fs::write(&map, serde_json::json!({ case.event.as_str(): events }).to_string()).unwrap();

    let event_arg = row.event_arg.unwrap_or(&case.event).to_string();
    let mut args: Vec<String> = vec!["hook".into(), "--event".into(), event_arg, "--host".into(), row.host_arg.unwrap_or(case.host).into()];
    match row.tool {
        Tool::Given if case.event == "PreToolUse" => args.extend(["--tool".into(), "Bash".into()]),
        Tool::Unknown => args.extend(["--tool".into(), "NoSuchTool".into()]),
        _ => {}
    }
    if row.runnable {
        args.extend(["--fallback-map".into(), map.to_string_lossy().to_string()]);
    }
    let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
    c.args(&args)
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("HOME", case.dir.join("home"))
        .env("AH_ENGINE_DIR", case.dir.join("state"))
        .env("AH_ENGINE_VERSION", "fail-closed-matrix")
        .env("AH_ENGINE_DISPATCH_IN_PROCESS", if row.daemon == Daemon::InProcess { "1" } else { "0" })
        .env("AH_ENGINE_NOSPAWN", "1")
        .env("AH_ENGINE_DISPATCH_MAX_TIMEOUT_S", "1")
        .env("AH_TEST_MARK", &mark)
        .env("AH_TEST_MARK2", &mark2)
        .current_dir(&case.dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if row.runnable {
        let root_var = ah_engine::defaults::raw("dispatch.root_vars").get(case.host).map(|v| v.strings()[0].to_string()).unwrap();
        c.env(root_var, &case.dir);
    }
    let writer = match row.stdin {
        Stdin::ReadError => {
            c.stdin(std::fs::File::open("/").unwrap());
            None
        }
        s => {
            c.stdin(Stdio::piped());
            Some(stdin_bytes(s, &case.event, &case.dir))
        }
    };
    let fake = fake_daemon(case, row.daemon);
    let mut ch = c.spawn().unwrap();
    let feeder = writer.map(|bytes| {
        let mut si = ch.stdin.take().unwrap();
        std::thread::spawn(move || {
            let _ = si.write_all(&bytes); // the client may stop reading at its cap
        })
    });
    let o = ch.wait_with_output().unwrap();
    if let Some(f) = feeder {
        let _ = f.join();
    }
    if let Some(f) = fake {
        f.stop();
    }
    Run {
        marked2: mark2.exists(),
        second_expected,
        code: o.status.code().unwrap_or(-1),
        out: String::from_utf8_lossy(&o.stdout).to_string(),
        err: String::from_utf8_lossy(&o.stderr).to_string(),
        marked: mark.exists(),
    }
}

/// A daemon stand-in on the engine socket, answering every connection as `mode` says.
struct FakeDaemon {
    sock: PathBuf,
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
    thread: std::thread::JoinHandle<()>,
}

impl FakeDaemon {
    /// Stop the listener thread (a connection wakes its accept) and remove the socket file.
    fn stop(self) {
        self.stop.store(true, std::sync::atomic::Ordering::SeqCst);
        let _ = std::os::unix::net::UnixStream::connect(&self.sock);
        let _ = self.thread.join();
        let _ = std::fs::remove_file(&self.sock);
    }
}

fn fake_daemon(case: &Case, mode: Daemon) -> Option<FakeDaemon> {
    use ah_engine::dispatch::native::{Answer, encode};
    use ah_engine::frame::{Kind, encode as frame};
    use std::io::Read;
    let body = match mode {
        Daemon::InProcess | Daemon::Down => return None,
        Daemon::Garbage => "this is not a dispatch reply".to_string(),
        Daemon::Blocks => {
            let valid = payload(&case.event, &case.dir);
            let answers: Vec<(String, Answer)> = table::select(case.host, &case.event, &valid, Some("Bash"))
                .into_iter()
                .filter(|e| e.check.is_some())
                .map(|e| {
                    let r = ah_engine::dispatch::combine::HookResult { id: e.id.clone(), code: Some(2), out: String::new(), err: "DAEMONBLOCK\n".into() };
                    (e.id, Answer::Decided(r))
                })
                .collect();
            encode(&answers)
        }
    };
    let sock = ah_engine::paths::socket_in(&case.dir.join("state"));
    std::fs::create_dir_all(sock.parent().unwrap()).unwrap();
    let _ = std::fs::remove_file(&sock);
    let listener = std::os::unix::net::UnixListener::bind(&sock).unwrap();
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let flag = stop.clone();
    let reply = frame(Kind::Ok, &body);
    let thread = std::thread::spawn(move || {
        for mut s in listener.incoming().flatten() {
            if flag.load(std::sync::atomic::Ordering::SeqCst) {
                return;
            }
            let mut b = Vec::new();
            let _ = s.read_to_end(&mut b);
            let _ = s.write_all(&reply);
        }
    });
    Some(FakeDaemon { sock, stop, thread })
}

fn check(what: &str, row: &Row, want: Want, r: &Run) {
    let ctx = format!("{what}: code {} out {:?} err {:?} marked {}", r.code, r.out.chars().take(300).collect::<String>(), r.err, r.marked);
    // the universal invariant: a silent exit 0 needs a hook that ran
    if r.code == 0 && r.out.is_empty() && r.err.is_empty() && !r.marked && !matches!(want, Want::Quiet) {
        panic!("SILENT ALLOW with no hook having run: {ctx}");
    }
    if r.code == 2 {
        assert!(!r.err.is_empty(), "exit 2 without a message: {ctx}");
    }
    let closed = r.code == 2 && r.err.contains("could not run the guards");
    // every hook the dispatcher starts runs, whatever another one says: a skipped second guard is not an allow
    if !closed && !matches!(want, Want::Quiet | Want::Open | Want::Closed) && r.second_expected {
        assert!(r.marked2, "the second hook never ran: {ctx}");
    }
    match want {
        Want::Closed => assert!(closed, "expected fail-closed: {ctx}"),
        Want::Blocks(s) => assert!(r.code == 2 && r.err.contains(s), "expected the hook's block {s:?}: {ctx}"),
        Want::BlocksOrClosed(s) => assert!(r.code == 2 && (closed || r.err.contains(s)), "expected the hook's block {s:?} or fail-closed: {ctx}"),
        Want::OneJson(s) => {
            let v: Result<Value, _> = serde_json::from_str(r.out.trim());
            assert!(r.code == 0 && v.as_ref().is_ok_and(Value::is_object) && r.out.contains(s), "expected one JSON object with {s:?}: {ctx}");
        }
        Want::Quiet => assert_eq!(r.code, 0, "{ctx}"),
        Want::ClosedOrAllow => assert!(closed || (r.code == 0 && r.marked), "expected closed or a real allow: {ctx}"),
        Want::Allow => assert!(r.code == 0 && r.marked && !closed, "expected an allow from hooks that ran: {ctx}"),
        Want::Open => assert!(r.code == 0 && r.out.is_empty() && r.err.contains("could not run the guards"), "expected a fail-open note: {ctx}"),
    }
    let _ = row;
}

#[test]
fn every_guard_event_fails_closed_or_keeps_the_hooks_decision() {
    let mut cases = Vec::new();
    for host in table::hosts() {
        for event in ah_engine::defaults::list("dispatch.guard_events") {
            if !table::entries(host, event).is_empty() {
                let host: &'static str = Box::leak(host.to_string().into_boxed_str());
                cases.push(Case { host, event: event.to_string(), dir: std::env::temp_dir().join(format!("ahd-fc-{host}-{event}-{}", std::process::id())) });
            }
        }
    }
    // Every guard event is either asserted here or known to have no hook registered on it; a table that grows an entry on
    // one of the latter fails until the matrix covers it. PermissionRequest stays a guard event although Claude ignores
    // its exit 2 (docs/KB-claude-code-hooks.md): a fail-closed block there is harmless, and a hook added later is guarded.
    const ASSERTED: &[&str] = &["PreToolUse", "Stop"];
    const UNREGISTERED: &[&str] = &["PermissionRequest", "SubagentStop"];
    for event in ah_engine::defaults::list("dispatch.guard_events") {
        assert!(ASSERTED.contains(&event) || UNREGISTERED.contains(&event), "guard event {event} is neither asserted nor listed as unregistered");
    }
    for event in ASSERTED {
        assert!(cases.iter().any(|c| c.event == *event), "the matrix has no case for {event}");
    }
    for event in UNREGISTERED {
        for host in table::hosts() {
            assert!(table::entries(host, event).is_empty(), "{host} registers {event} now: move it to ASSERTED and cover it");
        }
    }
    let mut failures = Vec::new();
    for case in &cases {
        for row in rows() {
            if !row.events.is_empty() && !row.events.contains(&case.event.as_str()) {
                continue;
            }
            let label = |v: &str| format!("[{}/{}] {} ({v})", case.host, case.event, row.name);
            let attempts: Vec<(String, Run, Want)> = match row.hook {
                Hook::Crossed if matches!(row.want, Want::Closed) => vec![
                    (label("allowing hook"), run(case, &row, MARK, MARK2), Want::Closed),
                    (label("blocking hook"), run(case, &row, BLOCK, MARK2), Want::Closed),
                ],
                // a valid payload: every hook runs, so the outcome is exact (the hook's own allow or block, never the engine's)
                Hook::Crossed if matches!(row.stdin, Stdin::Valid) => vec![
                    (label("allowing hook"), run(case, &row, MARK, MARK2), Want::Allow),
                    (label("blocking hook"), run(case, &row, BLOCK, MARK2), Want::Blocks("BLOCKME")),
                ],
                Hook::Crossed => vec![
                    (label("allowing hook"), run(case, &row, MARK, MARK2), Want::ClosedOrAllow),
                    (label("blocking hook"), run(case, &row, BLOCK, MARK2), Want::BlocksOrClosed("BLOCKME")),
                ],
                Hook::Cmd { first, second } => vec![(label("injected"), run(case, &row, first, second), row.want)],
            };
            for (what, r, want) in attempts {
                if let Err(p) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| check(&what, &row, want, &r))) {
                    failures.push(p.downcast_ref::<String>().cloned().or_else(|| p.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or(what));
                }
            }
        }
    }
    assert!(failures.is_empty(), "{} fail-closed violations:\n{}", failures.len(), failures.join("\n"));
}

/// A Stop whose hooks can never run (plugin root unset) must not block forever: the flag-free payload is blocked up to
/// `dispatch.stop_block_cap` times in a row, then the next Stop is let through (D74). A Stop that follows a healthy run
/// starts the count again.
#[test]
fn consecutive_stops_with_a_broken_install_end_in_an_exit_0_within_the_cap() {
    let cap = ah_engine::defaults::num("dispatch.stop_block_cap") as usize;
    for host in table::hosts() {
        for event in ah_engine::defaults::list("dispatch.stop_events") {
            if table::entries(host, event).is_empty() {
                continue;
            }
            let host: &'static str = Box::leak(host.to_string().into_boxed_str());
            let case = Case { host, event: event.to_string(), dir: std::env::temp_dir().join(format!("ahd-fl-{host}-{event}-{}", std::process::id())) };
            let broken = Row { name: "broken install", runnable: false, ..BASE };
            let _ = std::fs::remove_dir_all(&case.dir);
            let codes: Vec<i32> = (0..cap + 2).map(|_| run_kept(&case, &broken, MARK, MARK).code).collect();
            let expect: Vec<i32> = (0..cap + 2).map(|i| if i < cap { 2 } else { 0 }).collect();
            assert_eq!(codes, expect, "[{host}/{event}] consecutive Stops, broken install");
            // a healthy run in between resets the count
            let healthy = Row { name: "healthy", ..BASE };
            assert_eq!(run_kept(&case, &healthy, MARK, MARK).code, 0, "[{host}/{event}] healthy Stop");
            assert_eq!(run_kept(&case, &broken, MARK, MARK).code, 2, "[{host}/{event}] the count restarted after a healthy Stop");
        }
    }
}

/// A healthy hook's genuine block must reach the host even when a sibling hook cannot run and the Stop block counter is at
/// its cap or the payload says `stop_hook_active` (D74): the cap bounds the engine's own fail-closed blocks, never a hook's.
#[test]
fn a_stop_hooks_genuine_block_survives_a_failed_sibling_at_the_cap() {
    let cap = ah_engine::defaults::num("dispatch.stop_block_cap").to_string();
    let dir_name = ah_engine::defaults::text("dispatch.stop_state_dir");
    for host in table::hosts() {
        for event in ah_engine::defaults::list("dispatch.stop_events") {
            if table::entries(host, event).is_empty() {
                continue;
            }
            let host: &'static str = Box::leak(host.to_string().into_boxed_str());
            let case = Case { host, event: event.to_string(), dir: std::env::temp_dir().join(format!("ahd-gb-{host}-{event}-{}", std::process::id())) };
            let siblings: [(&str, &str); 3] = [("killed sibling", "kill -9 $$"), ("unspawnable sibling", "a\0b"), ("orphan holding the pipes", "(exec sleep 3) & echo partial")];
            for (what, second) in siblings {
                for (state, active, filled) in [("fresh", Stdin::Valid, false), ("counter at the cap", Stdin::Valid, true), ("stop_hook_active", Stdin::StopActive, false), ("both", Stdin::StopActive, true)] {
                    let _ = std::fs::remove_dir_all(&case.dir);
                    if filled {
                        let counters = case.dir.join("state").join(dir_name);
                        std::fs::create_dir_all(&counters).unwrap();
                        std::fs::write(counters.join(format!("{event}-fc")), &cap).unwrap();
                    }
                    let row = Row { name: "genuine block", stdin: active, ..BASE };
                    let r = run_kept(&case, &row, BLOCK, second);
                    let ctx = format!("[{host}/{event}] {what}, {state}: code {} err {:?}", r.code, r.err);
                    assert!(r.code == 2 && r.err.contains("BLOCKME") && !r.err.contains("could not run the guards"), "the hook's block must be returned verbatim: {ctx}");
                }
            }
        }
    }
}

/// A payload-less fail-closed Stop counts under the shared "unknown" key; a healthy run of any session clears it, so a
/// later payload-less failure blocks again instead of failing open for good. The block message names the agent, not a call,
/// and counter files older than `dispatch.stop_state_max_age_days` are pruned.
#[test]
fn the_unknown_session_counter_resets_wording_and_pruning() {
    let cap = ah_engine::defaults::num("dispatch.stop_block_cap") as usize;
    let dir_name = ah_engine::defaults::text("dispatch.stop_state_dir");
    for host in table::hosts() {
        for event in ah_engine::defaults::list("dispatch.stop_events") {
            if table::entries(host, event).is_empty() {
                continue;
            }
            let host: &'static str = Box::leak(host.to_string().into_boxed_str());
            let case = Case { host, event: event.to_string(), dir: std::env::temp_dir().join(format!("ahd-un-{host}-{event}-{}", std::process::id())) };
            let _ = std::fs::remove_dir_all(&case.dir);
            let counters = case.dir.join("state").join(dir_name);
            std::fs::create_dir_all(&counters).unwrap();
            let old = counters.join("old-session");
            std::fs::write(&old, "1").unwrap();
            let age = std::time::Duration::from_secs((ah_engine::defaults::num("dispatch.stop_state_max_age_days") + 1) * 86_400);
            std::fs::File::options().write(true).open(&old).unwrap().set_modified(std::time::SystemTime::now() - age).unwrap();
            let lost = Row { name: "payload-less failure", stdin: Stdin::NotJson, runnable: false, ..BASE };
            let ctx = format!("[{host}/{event}]");
            for i in 0..cap {
                let r = run_kept(&case, &lost, MARK, MARK);
                assert_eq!(r.code, 2, "{ctx} block {i}: {}", r.err);
                assert!(!r.err.contains("The call is blocked"), "{ctx} a Stop must not say a call is blocked: {}", r.err);
            }
            assert!(!old.exists(), "{ctx} the stale counter file was not pruned");
            assert_eq!(run_kept(&case, &lost, MARK, MARK).code, 0, "{ctx} at the cap");
            let healthy = Row { name: "healthy", ..BASE };
            assert_eq!(run_kept(&case, &healthy, MARK, MARK).code, 0, "{ctx} healthy");
            assert_eq!(run_kept(&case, &lost, MARK, MARK).code, 2, "{ctx} the unknown counter must reset after a healthy run");
        }
    }
}
