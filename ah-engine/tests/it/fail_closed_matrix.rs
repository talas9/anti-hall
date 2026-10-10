//! D74: the fail-closed invariant matrix. A guard event (`dispatch.guard_events`) crossed with every injected failure.
//!
//! The invariant, for every combination: the call EITHER exits 2 with a non-empty message on stderr (the engine could
//! not run the guards, or a hook really blocked), OR ends the way Node's separate hooks would (a real block stays a
//! block with its exit code and message, a real decision stays a decision), OR hands the event to the wrapper's Node
//! fallback with `dispatch.defer_exit` (no table row for it, or an infrastructure fault: a hook the OS would not start,
//! stdin that cannot be read, a usage error, an unreadable fallback map, which must neither block nor allow). It is never exit 0 with empty stdout and
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
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use ah_engine::dispatch::table;
use serde_json::Value;
use std::io::Write;
use std::path::PathBuf;
use std::time::Duration;
use std::process::{Command, Stdio};

/// What the dispatcher reads from stdin.
#[derive(Clone, Copy)]
enum Stdin {
    /// A valid payload for the event.
    Valid,
    /// A payload cut off by `client.max_stdin`: valid JSON up to a point, then more bytes than the client reads.
    Truncated,
    /// Valid UTF-8 payload bytes over `client.max_stdin`.
    OverCapUtf8,
    /// Text that is not JSON.
    NotJson,
    /// Bytes that are not UTF-8.
    NotUtf8,
    /// A Stop payload whose re-entry flag is readable after replacement-decoding, but another JSON string is not UTF-8.
    StopActiveNotUtf8,
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
    /// The tool the payload names (`tool_of`).
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
    /// Exit `dispatch.defer_exit` with the engine's infrastructure-fault note: a fault that is no verdict (review findings 2,
    /// 3, 16) is handed to the wrapper's Node hooks, never a block (a lockout) and never an allow.
    InfraDefer,
    /// Exit 0, nothing printed, the first hook never got to its marker, and the event log records that it was killed at its
    /// timeout: the host discards a timed-out hook, so the dispatcher does too (`dispatch::node`, `dispatch.msg_hook_timeout`).
    Discarded,
    /// Exit `dispatch.defer_exit` and no hook ran: the engine has no table row for the event and the wrapper's fallback list
    /// does not mark it as a thin trigger, so the wrapper's Node fallback answers exactly as the separate hooks would.
    Defer,
}

/// How the built-in checks are answered.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Daemon {
    /// Inside the client (`dispatch.in_process` 1): no daemon.
    InProcess,
    /// Checks down: a daemon that answers with nothing usable, so every check runs as its Node hook.
    Down,
    /// Through the daemon path with no daemon at all and none to start: the client fails open at once (no hook runs).
    Absent,
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
    /// `--fallback-map` names a file that does not exist.
    map_unreadable: bool,
}

const STOPS: &[&str] = &["Stop", "SubagentStop"];
/// The guard events with more than one entry: a hook that cannot spawn there sits beside others that ran.
const SEVERAL: &[&str] = &["PreToolUse", "Stop"];
/// The guard event whose only entry is one Node hook: a spawn failure there means nothing ran at all.
const SINGLE: &[&str] = &["SubagentStop"];

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
    map_unreadable: false,
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
        Row { name: "over-cap UTF-8 stdin, tool given", stdin: Stdin::OverCapUtf8, events: PRE, ..BASE },
        Row { name: "over-cap UTF-8 stdin, no --tool", stdin: Stdin::OverCapUtf8, tool: Tool::Omitted, events: PRE, ..BASE },
        Row { name: "invalid JSON, tool given", stdin: Stdin::NotJson, ..BASE },
        Row { name: "invalid JSON, no --tool", stdin: Stdin::NotJson, tool: Tool::Omitted, ..BASE },
        Row { name: "non-UTF-8 stdin, tool given", stdin: Stdin::NotUtf8, want: Want::Closed, events: PRE, ..BASE },
        Row { name: "non-UTF-8 stdin, no --tool", stdin: Stdin::NotUtf8, tool: Tool::Omitted, want: Want::Closed, events: PRE, ..BASE },
        Row {
            name: "stop_hook_active with non-UTF-8 stdin",
            stdin: Stdin::StopActiveNotUtf8,
            hook: Hook::Cmd { first: MARK, second: MARK2 },
            want: Want::Open,
            events: STOPS,
            ..BASE
        },
        Row { name: "stdin read error, tool given", stdin: Stdin::ReadError, want: Want::InfraDefer, ..BASE },
        Row { name: "stdin read error, no --tool", stdin: Stdin::ReadError, tool: Tool::Omitted, want: Want::InfraDefer, ..BASE },
        Row { name: "no --tool, valid payload", tool: Tool::Omitted, ..BASE },
        Row { name: "no --tool, payload without tool_name", stdin: Stdin::NoToolName, tool: Tool::Omitted, ..BASE },
        // ---- unknown tool: nothing applies, so a quiet exit 0 is right; unknown event: the Node fallback answers ----
        Row { name: "unknown tool", tool: Tool::Unknown, hook: Hook::Cmd { first: MARK, second: MARK2 }, want: Want::Quiet, events: PRE, ..BASE },
        Row { name: "unknown event", event_arg: Some("NoSuchEvent"), hook: Hook::Cmd { first: MARK, second: MARK2 }, want: Want::Defer, ..BASE },
        // ---- wiring ----
        Row { name: "bad host", host_arg: Some("nope"), want: Want::InfraDefer, ..BASE },
        Row { name: "unreadable fallback map", map_unreadable: true, want: Want::InfraDefer, ..BASE },
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
            // another hook ran, so a Node rerun would repeat it (review P1-1): fail closed, which a held turn lets finish
            want: Want::Open,
            events: &["Stop"],
            ..BASE
        },
        Row {
            name: "the only hook cannot spawn, stop_hook_active",
            stdin: Stdin::StopActive,
            hook: Hook::Cmd { first: "a\0b", second: "true" },
            want: Want::InfraDefer,
            events: SINGLE,
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
        // review P1-1: exit 75 makes the wrapper rerun every Node hook, so a spawn failure defers only when no other hook ran;
        // beside a hook that did run it fails closed
        Row { name: "hook cannot spawn", hook: Hook::Cmd { first: "a\0b", second: "true" }, want: Want::Closed, events: SEVERAL, ..BASE },
        Row { name: "the only hook cannot spawn", hook: Hook::Cmd { first: "a\0b", second: "true" }, want: Want::InfraDefer, events: SINGLE, ..BASE },
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
            // the deterministic form of a hook a loaded machine does not start within its timeout: it never reaches its
            // marker, it is killed, and the call goes on as the host's own discard (no fail-closed, no defer)
            name: "hook that times out before doing anything",
            hook: Hook::Cmd { first: r#"sleep 5; touch "$AH_TEST_MARK""#, second: MARK2 },
            want: Want::Discarded,
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
    /// The event log records that the first / second injected hook was killed at its timeout (the matrix lowers every
    /// timeout to 1 s, which a loaded machine can spend before a hook's shell even reaches its marker).
    timed_out: bool,
    timed_out2: bool,
}

struct Case {
    host: &'static str,
    event: String,
    dir: PathBuf,
}

impl Drop for Case {
    fn drop(&mut self) {
        ah_engine::discard::harmless(std::fs::remove_dir_all(&self.dir));
    }
}

/// The tool the PreToolUse rows use. Claude: a spawn, the one tool that still has a Node-only hook (`swarm-guard`) next to
/// built-in checks. Codex: Bash, which has the most entries; every one of them has a built-in check since the shell and edit
/// guards were ported, so its rows run the checks as their Node hooks (see `effective_daemon`).
fn tool_of(host: &str) -> &'static str {
    if host == "codex" { "Bash" } else { "Agent" }
}

fn tool_input_of(host: &str) -> Value {
    if host == "codex" {
        serde_json::json!({"command": "ls"})
    } else {
        serde_json::json!({"description": "ls", "prompt": "ls", "subagent_type": "Explore", "model": "haiku"})
    }
}

fn payload(host: &str, event: &str, dir: &std::path::Path) -> Value {
    if event == "PreToolUse" {
        serde_json::json!({"session_id": "fc", "cwd": dir, "hook_event_name": event, "tool_name": tool_of(host), "tool_input": tool_input_of(host)})
    } else {
        serde_json::json!({"session_id": "fc", "cwd": dir, "hook_event_name": event})
    }
}

fn stdin_bytes(s: Stdin, host: &str, event: &str, dir: &std::path::Path) -> Vec<u8> {
    match s {
        Stdin::Valid => payload(host, event, dir).to_string().into_bytes(),
        Stdin::Truncated => {
            let mut b = format!(r#"{{"tool_name":"{}","tool_input":{{"command":"git push --force "#, tool_of(host)).into_bytes();
            b.resize(ah_engine::defaults::num("client.max_stdin") as usize + 4096, b'x');
            b
        }
        Stdin::OverCapUtf8 => {
            let mut b = format!(r#"{{"hook_event_name":"PreToolUse","tool_name":"{}","tool_input":{{"command":"npm test "#, tool_of(host)).into_bytes();
            while b.len() <= ah_engine::defaults::num("client.max_stdin") as usize + 4096 {
                b.extend_from_slice(b"\xc3\xa9");
            }
            b.extend_from_slice(br#""}}"#);
            b
        }
        Stdin::NotJson => format!(r#"{{"tool_name":"{}","tool_input":{{"command":"git push --force"#, tool_of(host)).into_bytes(),
        Stdin::NotUtf8 => {
            let mut b = format!(r#"{{"tool_name":"{}","tool_input":{{"command":"ls "#, tool_of(host)).into_bytes();
            b.extend_from_slice(&[0xff, 0xfe, 0xfd]);
            b.extend_from_slice(br#""}}"#);
            b
        }
        Stdin::StopActiveNotUtf8 => {
            let mut b = format!(
                r#"{{"session_id":"fc","cwd":{},"hook_event_name":"{event}","stop_hook_active":true,"note":"bad "#,
                serde_json::to_string(&dir).unwrap()
            )
            .into_bytes();
            b.push(0xff);
            b.extend_from_slice(br#""}"#);
            b
        }
        Stdin::NoToolName => br#"{"session_id":"fc"}"#.to_vec(),
        Stdin::ReadError => Vec::new(),
        Stdin::StopActive => {
            let mut v = payload(host, event, dir);
            v["stop_hook_active"] = true.into();
            v.to_string().into_bytes()
        }
    }
}

/// How many Node-only entries (no built-in check) the row's tool has on this host and event.
fn node_only_count(case: &Case) -> usize {
    let valid = payload(case.host, &case.event, &case.dir);
    table::select(case.host, &case.event, &valid, Some(tool_of(case.host))).iter().filter(|e| e.check.is_none()).count()
}

/// Whether the row's payload is one the checks can read and answer: a valid one, or (on a Stop event, where no tool selects the
/// entries) one without a tool name or with the re-entry flag.
fn readable(case: &Case, row: &Row) -> bool {
    matches!(row.stdin, Stdin::Valid) || (matches!(row.stdin, Stdin::NoToolName | Stdin::StopActive) && matches!(case.event.as_str(), "Stop" | "SubagentStop"))
}

/// The daemon mode a row really runs in: a row that needs its injected hook(s) to run (a valid payload answered in the client)
/// runs with the checks down when the case has too few Node-only entries to hold them.
fn effective_daemon(case: &Case, row: &Row) -> Daemon {
    let wants_run = |cmd: &str| cmd != "true";
    let needed = match row.hook {
        Hook::Crossed => usize::from(readable(case, row)) * 2,
        Hook::Cmd { first, second } => usize::from(wants_run(first)) + usize::from(wants_run(second)),
    };
    if row.daemon == Daemon::InProcess && readable(case, row) && node_only_count(case) < needed { Daemon::Down } else { row.daemon }
}

/// Run the real binary for one row with one hook pair; the fallback map replaces every Node hook of the event.
fn run(case: &Case, row: &Row, first: &str, second: &str) -> Run {
    ah_engine::discard::harmless(std::fs::remove_dir_all(&case.dir));
    run_kept(case, row, first, second)
}

/// [`run`] without wiping the case directory first: the state dir (the Stop block counters) carries over.
fn run_kept(case: &Case, row: &Row, first: &str, second: &str) -> Run {
    std::fs::create_dir_all(case.dir.join("home")).unwrap();
    let mark = case.dir.join("mark");
    let mark2 = case.dir.join("mark2");
    let valid = payload(case.host, &case.event, &case.dir);
    let selected = table::select(case.host, &case.event, &valid, Some(tool_of(case.host)));
    // The hook slots: the Node-only entries first, then the ones a built-in check answers (their Node hook runs whenever the
    // check defers, the engine is down or the payload cannot be read, and the fallback map replaces its command all the same).
    let mut slots = selected.iter().filter(|e| e.check.is_none()).chain(selected.iter().filter(|e| e.check.is_some())).map(|e| e.id.clone());
    let (id1, id2) = (slots.next(), slots.next());
    // the second hook must have run unless it is a checked entry the engine answered itself (a valid payload answered in the
    // client, or by the daemon)
    let id2_node_only = id2.as_ref().is_some_and(|id| selected.iter().any(|e| &e.id == id && e.check.is_none()));
    let checks_answer = readable(case, row) && matches!(row.daemon, Daemon::InProcess | Daemon::Blocks);
    let second_expected = id2.is_some() && second.contains("AH_TEST_MARK2") && (id2_node_only || !checks_answer);
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
        Tool::Given if case.event == "PreToolUse" => args.extend(["--tool".into(), tool_of(case.host).into()]),
        Tool::Unknown => args.extend(["--tool".into(), "NoSuchTool".into()]),
        _ => {}
    }
    if row.map_unreadable {
        args.extend(["--fallback-map".into(), case.dir.join("no-such-map.json").to_string_lossy().to_string()]);
    } else if row.runnable {
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
            Some(stdin_bytes(s, case.host, &case.event, &case.dir))
        }
    };
    let fake = fake_daemon(case, row.daemon);
    let mut ch = c.spawn().unwrap();
    let feeder = writer.map(|bytes| {
        let mut si = ch.stdin.take().unwrap();
        std::thread::spawn(move || {
            ah_engine::discard::harmless(si.write_all(&bytes)); // the client may stop reading at its cap
        })
    });
    let o = ch.wait_with_output().unwrap();
    if let Some(f) = feeder {
        ah_engine::discard::harmless(f.join());
    }
    if let Some(f) = fake {
        f.stop();
    }
    let log = std::fs::read_to_string(case.dir.join("state/ah-engine.log")).unwrap_or_default();
    let killed = |id: &Option<String>| id.as_ref().is_some_and(|id| log.contains(&format!("\tdispatch_hook_timeout\t{id}\t")));
    Run {
        timed_out: killed(&id1),
        timed_out2: killed(&id2),
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
        ah_engine::discard::harmless(std::os::unix::net::UnixStream::connect(&self.sock));
        ah_engine::discard::harmless(self.thread.join());
        ah_engine::discard::harmless(std::fs::remove_file(&self.sock));
    }
}

fn fake_daemon(case: &Case, mode: Daemon) -> Option<FakeDaemon> {
    use ah_engine::dispatch::native::{Answer, encode};
    use ah_engine::frame::{Kind, encode as frame};
    use std::io::Read;
    let body = match mode {
        Daemon::InProcess | Daemon::Absent => return None,
        // "checks down" for the matrix: the daemon answers, but with nothing the dispatcher can use, so every check runs as its Node
        // hook. A daemon that is truly absent, hung, marked down or answering busy fails open at once instead (see
        // `a_truly_absent_daemon_fails_open_without_running_hooks`), so it cannot stand in for "checks down".
        Daemon::Garbage | Daemon::Down => "this is not a dispatch reply".to_string(),
        Daemon::Blocks => {
            let valid = payload(case.host, &case.event, &case.dir);
            let answers: Vec<(String, Answer)> = table::select(case.host, &case.event, &valid, Some(tool_of(case.host)))
                .into_iter()
                .filter(|e| e.check.is_some())
                .map(|e| {
                    let r = ah_engine::dispatch::combine::HookResult { id: e.id.clone(), code: Some(2), out: String::new(), err: "DAEMONBLOCK\n".into() };
                    (e.id, Answer::Decided(r, Vec::new()))
                })
                .collect();
            encode(&answers)
        }
    };
    let sock = ah_engine::paths::socket_in(&case.dir.join("state"));
    std::fs::create_dir_all(sock.parent().unwrap()).unwrap();
    ah_engine::discard::harmless(std::fs::remove_file(&sock));
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
            ah_engine::discard::harmless(s.read_to_end(&mut b));
            ah_engine::discard::harmless(s.write_all(&reply));
        }
    });
    Some(FakeDaemon { sock, stop, thread })
}

fn check(what: &str, row: &Row, want: Want, r: &Run) {
    let ctx =
        format!("{what}: code {} out {:?} err {:?} marked {} timed out {}", r.code, r.out.chars().take(300).collect::<String>(), r.err, r.marked, r.timed_out);
    // the universal invariant: a silent exit 0 needs a hook that ran, or one the event log shows was killed at its timeout
    // (the host's own discard)
    if r.code == 0 && r.out.is_empty() && r.err.is_empty() && !r.marked && !r.timed_out && !matches!(want, Want::Quiet) {
        panic!("SILENT ALLOW with no hook having run: {ctx}");
    }
    if r.code == 2 {
        assert!(!r.err.is_empty(), "exit 2 without a message: {ctx}");
    }
    let closed = r.code == 2 && r.err.contains("could not run the guards");
    // every hook the dispatcher starts runs, whatever another one says: a skipped second guard is not an allow
    if !closed && !matches!(want, Want::Quiet | Want::Open | Want::Closed | Want::Defer | Want::InfraDefer) && r.second_expected {
        assert!(r.marked2 || r.timed_out2, "the second hook never ran: {ctx}");
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
        Want::Allow => assert!(r.code == 0 && (r.marked || r.timed_out) && !closed, "expected an allow from hooks that ran: {ctx}"),
        Want::Discarded => {
            assert!(r.code == 0 && r.out.is_empty() && !r.marked && r.timed_out, "expected the timed-out hook to be discarded: {ctx}")
        }
        Want::Open => assert!(r.code == 0 && r.out.is_empty() && r.err.contains("could not run the guards"), "expected a fail-open note: {ctx}"),
        Want::InfraDefer => assert!(
            r.code == ah_engine::defaults::num("dispatch.defer_exit") as i32 && r.out.is_empty() && r.err.contains("the Node hooks decide"),
            "expected an infrastructure deferral to the Node hooks: {ctx}"
        ),
        Want::Defer => assert!(r.code == 75 && !r.marked && r.out.is_empty(), "expected a deferral to the Node fallback: {ctx}"),
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
    const ASSERTED: &[&str] = &["PreToolUse", "Stop", "SubagentStop"];
    const UNREGISTERED: &[&str] = &["PermissionRequest"];
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
            // A row that needs injected hooks to RUN needs them to be Node-only: a hook a built-in check answers never runs while the
            // checks answer in the client. Since the ports, a PreToolUse tool has at most one Node-only hook (Codex none), so such a
            // row runs with the checks down: every check runs as its Node hook, which the fallback map replaces, and the
            // dispatcher's merge, cap and decision logic is exercised the same. Rows that prove the daemon's own answer keep
            // their daemon mode.
            let row = Row { daemon: effective_daemon(case, &row), ..row };
            let label = |v: &str| format!("[{}/{}] {} ({v})", case.host, case.event, row.name);
            let attempts: Vec<(String, Run, Want)> = match row.hook {
                Hook::Crossed if matches!(row.want, Want::Closed | Want::InfraDefer) => {
                    vec![(label("allowing hook"), run(case, &row, MARK, MARK2), row.want), (label("blocking hook"), run(case, &row, BLOCK, MARK2), row.want)]
                }
                // A complete in-cap payload, and an over-cap UTF-8 payload whose full bytes are available to Node,
                // run every hook. The outcome is exact: the hook's own allow or block, never the engine's prefix-based
                // fail-closed answer.
                Hook::Crossed if matches!(row.stdin, Stdin::Valid | Stdin::OverCapUtf8) => vec![
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

#[test]
fn a_truly_absent_daemon_fails_open_without_running_hooks() {
    for host in table::hosts() {
        for event in ["PreToolUse", "Stop"] {
            if table::entries(host, event).is_empty() {
                continue;
            }
            let host: &'static str = Box::leak(host.to_string().into_boxed_str());
            let case = Case { host, event: event.to_string(), dir: std::env::temp_dir().join(format!("ahd-absent-{host}-{event}-{}", std::process::id())) };
            let row = Row { name: "absent daemon", daemon: Daemon::Absent, ..BASE };
            ah_engine::discard::harmless(std::fs::remove_dir_all(&case.dir));
            // the first run builds the defaults cache (slow in a debug binary on a busy box); the wrapper's watchdog bounds that
            // cold start, so the timing is asserted on the warm run
            for (n, t0) in [(0, None), (1, Some(std::time::Instant::now()))] {
                let r = run_kept(&case, &row, MARK, MARK2);
                assert_eq!(r.code, 0, "[{host}/{event}] absent daemon must fail open: {:?}", r.err);
                assert!(r.out.is_empty() && !r.marked, "[{host}/{event}] run {n}: no hook, no output on an unavailable daemon: {:?}", r.out);
                if let Some(t0) = t0 {
                    assert!(t0.elapsed() < Duration::from_secs(1), "[{host}/{event}] warm absent daemon took {:?}", t0.elapsed());
                }
            }
        }
    }
}

#[test]
fn pretooluse_invalid_utf8_fails_closed_before_hooks_run() {
    for host in table::hosts() {
        let host: &'static str = Box::leak(host.to_string().into_boxed_str());
        let case = Case { host, event: "PreToolUse".to_string(), dir: std::env::temp_dir().join(format!("ahd-utf8-pre-{host}-{}", std::process::id())) };
        if table::entries(case.host, &case.event).is_empty() {
            continue;
        }
        let row = Row { name: "non-UTF-8 stdin", stdin: Stdin::NotUtf8, want: Want::Closed, events: PRE, ..BASE };
        let r = run(&case, &row, MARK, MARK2);
        check(&format!("[{host}/PreToolUse] direct non-UTF-8"), &row, Want::Closed, &r);
    }
}

#[test]
fn stop_active_invalid_utf8_fails_open_before_utf8_rejection() {
    for host in table::hosts() {
        for event in ah_engine::defaults::list("dispatch.stop_events") {
            if table::entries(host, event).is_empty() {
                continue;
            }
            let host: &'static str = Box::leak(host.to_string().into_boxed_str());
            let case = Case { host, event: event.to_string(), dir: std::env::temp_dir().join(format!("ahd-utf8-stop-{host}-{event}-{}", std::process::id())) };
            let row = Row {
                name: "stop_hook_active with non-UTF-8 stdin",
                stdin: Stdin::StopActiveNotUtf8,
                hook: Hook::Cmd { first: MARK, second: MARK2 },
                want: Want::Open,
                events: STOPS,
                ..BASE
            };
            let r = run(&case, &row, MARK, MARK2);
            check(&format!("[{host}/{event}] direct stop_hook_active non-UTF-8"), &row, Want::Open, &r);
        }
    }
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
            // checks down: every Stop entry has a built-in check by now, which would answer in the client without needing the install;
            // the count is about hooks that cannot run
            let broken = Row { name: "broken install", runnable: false, daemon: Daemon::Down, ..BASE };
            ah_engine::discard::harmless(std::fs::remove_dir_all(&case.dir));
            let codes: Vec<i32> = (0..cap + 2).map(|_| run_kept(&case, &broken, MARK, MARK).code).collect();
            let expect: Vec<i32> = (0..cap + 2).map(|i| if i < cap { 2 } else { 0 }).collect();
            assert_eq!(codes, expect, "[{host}/{event}] consecutive Stops, broken install");
            // a healthy run in between resets the count
            let healthy = Row { name: "healthy", daemon: Daemon::Down, ..BASE };
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
            let siblings: [(&str, &str); 3] =
                [("killed sibling", "kill -9 $$"), ("unspawnable sibling", "a\0b"), ("orphan holding the pipes", "(exec sleep 3) & echo partial")];
            for (what, second) in siblings {
                for (state, active, filled) in [
                    ("fresh", Stdin::Valid, false),
                    ("counter at the cap", Stdin::Valid, true),
                    ("stop_hook_active", Stdin::StopActive, false),
                    ("both", Stdin::StopActive, true),
                ] {
                    ah_engine::discard::harmless(std::fs::remove_dir_all(&case.dir));
                    if filled {
                        let counters = case.dir.join("state").join(dir_name);
                        std::fs::create_dir_all(&counters).unwrap();
                        std::fs::write(counters.join(format!("{event}-fc")), &cap).unwrap();
                    }
                    // checks down: the hooks under test are the Node commands, which a built-in check would otherwise answer first
                    let row = Row { name: "genuine block", stdin: active, daemon: Daemon::Down, ..BASE };
                    let r = run_kept(&case, &row, BLOCK, second);
                    let ctx = format!("[{host}/{event}] {what}, {state}: code {} err {:?}", r.code, r.err);
                    assert!(
                        r.code == 2 && r.err.contains("BLOCKME") && !r.err.contains("could not run the guards"),
                        "the hook's block must be returned verbatim: {ctx}"
                    );
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
            ah_engine::discard::harmless(std::fs::remove_dir_all(&case.dir));
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

/// A check's OWN failure never blocks: an engine-only advisory whose script throws (or is interrupted at its CPU-time limit)
/// on a guard event allows (exit 0, nothing on stdout), per `script.failure_mode_by_check` (2026-10-09: sibling-sweep blocked
/// a SubagentStop when its script hit the limit on a long transcript). Every shipped engine-only check is `open`.
#[test]
fn an_engine_only_advisory_whose_script_fails_on_a_guard_event_allows() {
    let dir = std::env::temp_dir().join(format!("ah-fcm-script-{}", std::process::id()));
    ah_engine::discard::harmless(std::fs::remove_dir_all(&dir));
    std::fs::create_dir_all(dir.join("home/.anti-hall/logic")).unwrap();
    let t = dir.join("t.jsonl");
    std::fs::write(&t, "{\"type\":\"user\",\"message\":{\"content\":\"fix it\"}}\n").unwrap();
    let cases: [(&str, &str, &str, Value); 4] = [
        ("sibling-sweep", "SubagentStop", "throw new Error('bad');", Value::Null),
        ("sibling-sweep", "Stop", "for(;;){}", Value::Null),
        ("engine-role-guard", "PreToolUse", "throw new Error('bad');", serde_json::json!({"command": "ah-engine status"})),
        ("procwatch-advisory", "PreToolUse", "for(;;){}", serde_json::json!({"command": "ls"})),
    ];
    for (check, event, body, input) in cases {
        std::fs::write(dir.join(format!("home/.anti-hall/logic/{check}.js")), format!("function decide(p){{ {body} }}")).unwrap();
        let payload = serde_json::json!({
            "hook_event_name": event, "session_id": "s1", "agent_id": "a1", "transcript_path": t, "cwd": dir,
            "last_assistant_message": "Root cause: `read_window` holds the file twice. Fixed by streaming.",
            "tool_name": "Bash", "tool_input": input,
        });
        let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"))
            .args(["check", check])
            .env_clear()
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .env("HOME", dir.join("home"))
            .env("AH_ENGINE_DIR", dir.join("state"))
            .env("AH_ENGINE_SCRIPT_TIME_MS", "50")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        c.stdin.take().unwrap().write_all(payload.to_string().as_bytes()).unwrap();
        let out = c.wait_with_output().unwrap();
        let stdout = String::from_utf8_lossy(&out.stdout);
        assert_eq!(out.status.code(), Some(0), "{check} on {event}: {stdout} {}", String::from_utf8_lossy(&out.stderr));
        assert!(!stdout.contains("block") && !stdout.contains("deny"), "{check} on {event}: {stdout}");
    }
    ah_engine::discard::harmless(std::fs::remove_dir_all(&dir));
}
