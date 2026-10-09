//! The local Claude CLI judge: one isolated `claude -p` call under one timeout, and the parse of its answer.
//!
//! Mirrors `hooks/lib/judge-core.js` `cliArgs`, `runCliJudge` and `parseDecision`:
//! * the argv comes from `judge.cli_args` (no tools, no MCP servers, no settings files, every hook disabled, JSON output),
//!   with the model alias and the system prompt put in their placeholders;
//! * the child gets the hook's own environment plus the judge-child marker (so no anti-hall hook runs inside it), a private
//!   empty working directory that is removed afterwards, the input on stdin, and stderr discarded;
//! * past the timeout the child is killed; a spawn failure, a timeout, a non-zero or signal exit, output that is not the
//!   CLI's JSON, and `is_error` are all "no answer" (the caller fails open).
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - text that does not parse is the absent value (Node JSON.parse catch parity)
// A failure that must be seen goes through `crate::discard` instead.

use crate::checks::guardkit::jsre;
use crate::checks::guardkit::text::js_trim;
use crate::defaults;
use serde_json::Value;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// Why a call produced no answer text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CliError {
    /// The working directory or the child could not be created.
    Spawn,
    /// The child ran past the timeout (or its output stayed open past it) and was killed.
    Timeout,
    /// The child exited non-zero or was killed by a signal.
    Exit,
    /// Stdout was not the CLI's JSON, carried `is_error`, or had no answer text.
    Output,
}

impl CliError {
    /// The word a telemetry row records.
    pub fn word(self) -> &'static str {
        defaults::text(match self {
            CliError::Spawn => "judge.err_spawn",
            CliError::Timeout => "judge.err_timeout",
            CliError::Exit => "judge.err_exit",
            CliError::Output => "judge.err_output",
        })
    }
}

/// One judge call.
#[derive(Debug, Clone)]
pub struct CliCall<'a> {
    /// The system prompt.
    pub system: &'a str,
    /// The model alias.
    pub model: &'a str,
    /// The user turn, written to stdin.
    pub input: &'a str,
    /// The hook's environment; the judge-child marker is added to it.
    pub env: &'a HashMap<String, String>,
    /// The whole call's deadline.
    pub timeout: Duration,
}

/// What a call produced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliOutcome {
    /// The model's answer text (the CLI's `result` field), or why there is none.
    pub result: Result<String, CliError>,
    /// Elapsed milliseconds.
    pub ms: u64,
}

/// The environment a judge child starts from: this process's whole environment, as Node's `spawn` passes `process.env`
/// (the CLI needs its own login and PATH, which the request allowlist does not carry). Only a one-shot process makes a
/// judge call (see [`crate::judge::blocking_calls_allowed`]), and its environment is the hook's own.
pub fn process_env() -> HashMap<String, String> {
    std::env::vars().collect()
}

/// The argv after the program name (Node: `cliArgs(model)` with the system prompt of this call).
pub fn argv(model: &str, system: &str) -> Vec<String> {
    let (m, s) = (defaults::text("judge.arg_model"), defaults::text("judge.arg_system"));
    defaults::list("judge.cli_args")
        .into_iter()
        .map(|a| {
            if a == m {
                model.to_string()
            } else if a == s {
                system.to_string()
            } else {
                a.to_string()
            }
        })
        .collect()
}

/// `os.tmpdir()` of the hook's environment: the first non-empty of `judge.tmp_env`, a trailing slash removed, else
/// `judge.tmp_fallback`.
fn tmp_root(env: &HashMap<String, String>) -> PathBuf {
    for name in defaults::list("judge.tmp_env") {
        if let Some(v) = env.get(name).filter(|v| !v.is_empty()) {
            let t = if v.len() > 1 { v.strip_suffix('/').unwrap_or(v) } else { v.as_str() };
            return PathBuf::from(t);
        }
    }
    PathBuf::from(defaults::text("judge.tmp_fallback"))
}

/// `fs.mkdtempSync(root/prefix)`: a new private directory with a random alphanumeric suffix.
fn make_private_dir(root: &Path) -> Option<PathBuf> {
    use ring::rand::SecureRandom;
    let alphabet: Vec<char> = ('a'..='z').chain('A'..='Z').chain('0'..='9').collect();
    let n = defaults::num("judge.tmp_suffix_len") as usize;
    let rng = ring::rand::SystemRandom::new();
    for _ in 0..defaults::num("judge.tmp_attempts") {
        let mut bytes = vec![0u8; n];
        rng.fill(&mut bytes).ok()?;
        let suffix: String = bytes.iter().map(|b| alphabet[*b as usize % alphabet.len()]).collect();
        let dir = root.join(format!("{}{suffix}", defaults::text("judge.tmp_prefix")));
        match std::fs::create_dir(&dir) {
            Ok(()) => {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    crate::discard::harmless(std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))); // keep: mkdtemp's mode; the directory is private either way
                }
                return Some(dir);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return None,
        }
    }
    None
}

/// Run one judge call (Node: `runCliJudge`). Never panics and never waits past `call.timeout` plus one poll.
pub fn run(call: &CliCall<'_>) -> CliOutcome {
    let started = Instant::now();
    let done = |result: Result<String, CliError>| CliOutcome { result, ms: started.elapsed().as_millis() as u64 };
    let Some(dir) = make_private_dir(&tmp_root(call.env)) else { return done(Err(CliError::Spawn)) };
    let result = run_in(call, &dir, started);
    crate::discard::harmless(std::fs::remove_dir_all(&dir)); // keep: best-effort cleanup, as Node's rmSync in a try
    done(result)
}

fn run_in(call: &CliCall<'_>, dir: &Path, started: Instant) -> Result<String, CliError> {
    let deadline = started + call.timeout;
    let mut cmd = Command::new(defaults::text("judge.cli_bin"));
    cmd.args(argv(call.model, call.system))
        .env_clear()
        .envs(call.env.iter())
        .env(defaults::text("speculation_judge.child_env"), defaults::text("speculation_judge.child_value"))
        .current_dir(dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = cmd.spawn().map_err(|_| CliError::Spawn)?;
    // stdin is written on its own thread: a child that never reads would otherwise block this one past the deadline
    if let Some(mut stdin) = child.stdin.take() {
        let input = call.input.as_bytes().to_vec();
        std::thread::spawn(move || crate::discard::harmless(stdin.write_all(&input))); // keep: a child that exits early closes its stdin, as Node ignores EPIPE
    }
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    if let Some(mut stdout) = child.stdout.take() {
        std::thread::spawn(move || {
            let cap = defaults::num("judge.stdout_cap") as usize;
            let mut out = Vec::new();
            let mut buf = vec![0u8; defaults::num("judge.read_chunk") as usize];
            loop {
                match stdout.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    // Node: if (out.length < 1e6) out += d -- a chunk is kept whole while the total is under the cap
                    Ok(n) if out.len() < cap => out.extend_from_slice(&buf[..n]),
                    Ok(_) => {}
                }
            }
            crate::discard::harmless(tx.send(out)); // keep: the receiver is gone only after a timeout, when nobody reads this
        });
    }
    let poll = defaults::millis("judge.poll_ms");
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) if Instant::now() >= deadline => {
                crate::discard::harmless(child.kill()); // keep: already gone is the goal state
                crate::discard::harmless(child.wait()); // keep: reaps the killed child
                return Err(CliError::Timeout);
            }
            Ok(None) => std::thread::sleep(poll),
            Err(_) => return Err(CliError::Exit),
        }
    };
    // Node resolves on 'close': stdout must reach its end too, within the same deadline
    let out = rx.recv_timeout(deadline.saturating_duration_since(Instant::now())).map_err(|_| CliError::Timeout)?;
    if status.code() != Some(0) {
        return Err(CliError::Exit);
    }
    let text = String::from_utf8_lossy(&out);
    let j: Value = serde_json::from_str(&text).map_err(|_| CliError::Output)?;
    if j.get(defaults::text("judge.error_field")).is_some_and(crate::checks::replykit::io::truthy) {
        return Err(CliError::Output);
    }
    match j.get(defaults::text("judge.result_field")) {
        Some(Value::String(s)) => Ok(s.clone()),
        _ => Err(CliError::Output),
    }
}

/// `String(text).trim()` with a leading ```` ```json ```` fence and a trailing ```` ``` ```` removed, trimmed again.
pub fn strip_fences(text: &str) -> String {
    let open = jsre::compile(defaults::text("judge.fence_open_re"), true);
    let close = jsre::compile(defaults::text("judge.fence_close_re"), false);
    let t = open.replace(js_trim(text), "").into_owned();
    let t = close.replace(&t, "").into_owned();
    js_trim(&t).to_string()
}

/// `parseDecision(text)` of judge-core.js: the first `{` to the last `}` (or the whole text) parsed as JSON, kept only when
/// it is an object whose `decision` is `block` or `allow`.
pub fn parse_decision(text: &str) -> Option<Value> {
    let t = strip_fences(text);
    // t.match(/\{[\s\S]*\}/): greedy, so from the first '{' to the last '}' after it
    let slice = match (t.find('{'), t.rfind('}')) {
        (Some(a), Some(b)) if b > a => &t[a..=b],
        _ => t.as_str(),
    };
    let d: Value = serde_json::from_str(slice).ok()?;
    let decision = d.get("decision").and_then(Value::as_str)?;
    (d.is_object() && (decision == defaults::text("speculation_judge.decision_block") || decision == defaults::text("speculation_judge.decision_allow")))
        .then_some(d)
}

/// The fence-stripped text parsed whole as JSON (the triage worker's parse of the model's answer).
pub fn parse_loose(text: &str) -> Option<Value> {
    serde_json::from_str(&strip_fences(text)).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decisions_parse_like_judge_core() {
        assert_eq!(parse_decision(r#"{"decision":"allow"}"#), Some(serde_json::json!({"decision":"allow"})));
        assert_eq!(parse_decision("```json\n{\"decision\":\"block\",\"claim\":\"x\"}\n```").unwrap()["claim"], "x");
        assert_eq!(parse_decision("Sure: {\"decision\":\"block\"} done"), Some(serde_json::json!({"decision":"block"})));
        assert_eq!(parse_decision(r#"{"decision":"maybe"}"#), None);
        assert_eq!(parse_decision("no json"), None);
        assert_eq!(parse_decision(r#"[{"decision":"allow"}]"#), Some(serde_json::json!({"decision":"allow"})), "the first brace to the last");
        assert_eq!(parse_decision("} {"), None);
    }

    #[test]
    fn the_argv_puts_the_model_and_the_system_prompt_in_their_places() {
        let a = argv("haiku", "SYS");
        assert_eq!(a[..3], ["-p", "--model", "haiku"]);
        assert!(a.windows(2).any(|w| w[0] == "--system-prompt" && w[1] == "SYS"));
        assert!(a.iter().any(|x| x == "{\"disableAllHooks\":true}"));
    }

    #[test]
    fn the_temporary_root_follows_os_tmpdir() {
        let env = |pairs: &[(&str, &str)]| pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect::<HashMap<_, _>>();
        assert_eq!(tmp_root(&env(&[("TMPDIR", "/x/y/")])), PathBuf::from("/x/y"));
        assert_eq!(tmp_root(&env(&[("TMPDIR", ""), ("TMP", "/t")])), PathBuf::from("/t"));
        assert_eq!(tmp_root(&env(&[])), PathBuf::from("/tmp"));
        assert_eq!(tmp_root(&env(&[("TMPDIR", "/")])), PathBuf::from("/"));
    }
}
