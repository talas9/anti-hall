//! D87 gate: flipping `hooks.json` to one thin trigger per event is a no-op for behaviour.
//!
//! For each host (Claude, Codex), event and payload this test simulates the HOST twice:
//!
//! * OLD: the per-hook registry (`hooks.registry.json`, the shape the old `hooks.json` had): the entries whose matcher selects
//!   the payload are chosen by the host's own rules, all run at once as `sh -c <command>` with the payload on stdin, and their
//!   outputs are merged by a reference model of the host (a port of `parity/dispatch-lib.js`, written from the hosts' docs and
//!   independent of `src/dispatch/combine.rs`);
//! * NEW: the shipped thin `hooks.json` entry of the event, run exactly as the host runs it (`sh -c <command>`), which is the
//!   wrapper `ah-hook.sh`, the engine, and the Node (or fake) hooks behind them.
//!
//! The exit code, the stdout (compared as JSON when it is a JSON object, as bytes otherwise) and the stderr of the two must be
//! identical; a row that differs fails the gate (every row must pass). Three corpora:
//!
//! 1. the committed recorded-command corpora (`parity/corpus.jsonl`, `corpus-whitespace.jsonl`) as Bash `PreToolUse` and
//!    `PostToolUse` payloads, with the REAL Node hooks on both sides (a stride sample by default, all rows with `AH_FLIP_FULL=1`);
//! 2. a seeded combination fuzz (the shapes `parity/fuzz-dispatch.js` uses) over every event whose entries have no built-in check,
//!    with fake shell hooks that print what a per-row spec says, so merging, conflicts and exit codes are exercised;
//! 3. payload classes per event: well-formed, `{bad`, a lone-surrogate escape (valid JSON to Node), invalid UTF-8 and over the
//!    stdin cap, on every event of the thin file (the ones the table has no entry for must answer the neutral no-op).
//!
//! One documented, owner-ratified divergence is expected and counted apart: invalid UTF-8 on a guard event that has table
//! entries fails closed in the engine (D74) where Node, which decodes lossily, would let it through.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use ah_engine::dispatch::table;
use ah_engine::{defaults, hooksgen};
use regex::Regex;
use serde_json::{Map, Value, json};
use std::io::{Read, Write};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Clone, Debug, PartialEq)]
struct Res {
    /// `None` = killed at its timeout (the host discards it).
    code: Option<i32>,
    out: String,
    err: String,
}

// ---- the reference model of the host (a port of parity/dispatch-lib.js) --------------------------------------------------

fn matches(host: &str, matcher: &str, subjects: &[String]) -> bool {
    if matcher.is_empty() || matcher == "*" {
        return true;
    }
    if host == "claude" && Regex::new(r"^[A-Za-z0-9_\- ,|]*$").unwrap().is_match(matcher) {
        let names: Vec<&str> = matcher.split(['|', ',']).map(str::trim).filter(|s| !s.is_empty()).collect();
        return subjects.iter().any(|s| names.contains(&s.as_str()));
    }
    match Regex::new(matcher) {
        Ok(re) => subjects.iter().any(|s| re.is_match(s)),
        Err(_) => false,
    }
}

fn matcher_field(event: &str) -> Option<&'static str> {
    match event {
        "PreToolUse" | "PostToolUse" | "PostToolUseFailure" | "PermissionRequest" => Some("tool_name"),
        "SessionStart" => Some("source"),
        "SubagentStart" | "SubagentStop" => Some("agent_type"),
        "PreCompact" | "PostCompact" => Some("trigger"),
        _ => None,
    }
}

fn id_of(command: &str, seen: &mut std::collections::HashMap<String, usize>) -> String {
    let re = Regex::new(r#"/hooks/([^"\s]+)"?\s*(.*)$"#).unwrap();
    let (script, args) = match re.captures(command) {
        Some(c) => (c[1].to_string(), c[2].trim().to_string()),
        None => (command.to_string(), String::new()),
    };
    let mut id = script.strip_suffix(".js").unwrap_or(&script).to_string();
    if !args.is_empty() {
        let a = Regex::new(r"^-+").unwrap().replace(&args, "").to_string();
        id.push(':');
        id.push_str(&Regex::new(r"\s+-*").unwrap().replace_all(&a, ":"));
    }
    let n = seen.entry(id.clone()).and_modify(|n| *n += 1).or_insert(1);
    if *n > 1 {
        id = format!("{id}#{n}");
    }
    id
}

#[derive(Clone, Debug)]
struct Sel {
    id: String,
    command: String,
    timeout: u64,
}

/// The registry entries of `event` the payload selects, in registry order. `payload` `None` = the host could not read a tool
/// name (every entry is selected, the way the engine and the wrapper treat an unreadable payload).
fn select(registry: &Value, host: &str, event: &str, payload: Option<&Value>) -> Vec<Sel> {
    let groups = registry["hooks"][event].as_array().cloned().unwrap_or_default();
    let subjects: Option<Vec<String>> = match (matcher_field(event), payload) {
        (Some(field), Some(p)) => {
            let v = p.get(field).and_then(Value::as_str).unwrap_or("").to_string();
            let mut s = vec![v.clone()];
            if host == "codex" && v == "apply_patch" {
                s.extend(["Edit".to_string(), "Write".to_string()]);
            }
            Some(s)
        }
        _ => None,
    };
    let mut seen = std::collections::HashMap::new();
    let mut out = Vec::new();
    for g in groups {
        let matcher = g.get("matcher").and_then(Value::as_str).unwrap_or("");
        let hit = subjects.as_ref().is_none_or(|s| matches(host, matcher, s));
        for h in g["hooks"].as_array().unwrap() {
            let command = h["command"].as_str().unwrap().to_string();
            let id = id_of(&command, &mut seen);
            if hit {
                out.push(Sel { id, command, timeout: h.get("timeout").and_then(Value::as_u64).unwrap_or(0) });
            }
        }
    }
    out
}

fn run_shell(command: &str, input: &[u8], env: &[(String, String)], cwd: &Path, timeout_s: u64) -> Res {
    let mut c = Command::new("/bin/sh");
    c.args(["-c", command]).env_clear().envs(env.iter().map(|(k, v)| (k, v))).current_dir(cwd).process_group(0);
    c.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut ch = c.spawn().unwrap();
    let pid = ch.id() as i32;
    let mut stdin = ch.stdin.take().unwrap();
    let data = input.to_vec();
    let w = std::thread::spawn(move || {
        ah_engine::discard::harmless(stdin.write_all(&data));
    });
    let (mut so, mut se) = (ch.stdout.take().unwrap(), ch.stderr.take().unwrap());
    let ro = std::thread::spawn(move || {
        let mut b = Vec::new();
        ah_engine::discard::harmless(so.read_to_end(&mut b));
        b
    });
    let re = std::thread::spawn(move || {
        let mut b = Vec::new();
        ah_engine::discard::harmless(se.read_to_end(&mut b));
        b
    });
    let deadline = Instant::now() + Duration::from_secs(timeout_s.max(1));
    let status = loop {
        match ch.try_wait().unwrap() {
            Some(s) => break Some(s),
            None if Instant::now() > deadline => {
                // SAFETY: `kill` takes plain integers and has no memory-safety preconditions; a dead pid just fails with ESRCH.
                unsafe { libc::kill(-pid, libc::SIGKILL) };
                ah_engine::discard::harmless(ch.wait());
                break None;
            }
            None => std::thread::sleep(Duration::from_millis(2)),
        }
    };
    ah_engine::discard::harmless(w.join());
    let (o, e) = (ro.join().unwrap(), re.join().unwrap());
    match status {
        Some(s) => Res { code: s.code().or(Some(-1)), out: String::from_utf8_lossy(&o).to_string(), err: String::from_utf8_lossy(&e).to_string() },
        None => Res { code: None, out: String::new(), err: String::new() },
    }
}

fn parse_object(out: &str) -> Option<Map<String, Value>> {
    let t = out.trim();
    if !(t.starts_with('{') && t.ends_with('}')) {
        return None;
    }
    serde_json::from_str::<Value>(t).ok()?.as_object().cloned()
}

fn json_blocks(out: &str) -> bool {
    parse_object(out).is_some_and(|v| {
        v.get("decision").and_then(Value::as_str) == Some("block")
            || v.get("hookSpecificOutput").and_then(|h| h.get("permissionDecision")).and_then(Value::as_str) == Some("deny")
    })
}

type Fields = Vec<(String, Value)>;

enum Merged {
    Answer(Res),
    Conflict,
}

const PRECEDENCE: [&str; 4] = ["deny", "defer", "ask", "allow"];

/// `mergeObjects` of the model; `lenient` keeps the first value of a field two answers set differently.
fn merge_objects(active: &[&Res], lenient: bool) -> Merged {
    let (mut top, mut hso): (Fields, Fields) = (vec![], vec![]);
    let (mut contexts, mut messages): (Vec<String>, Vec<String>) = (vec![], vec![]);
    let mut decision: Option<(usize, String, Option<Value>)> = None;
    let mut err = String::new();
    fn put(o: &mut Vec<(String, Value)>, k: &str, v: Value, lenient: bool) -> bool {
        match o.iter().find(|(n, _)| n == k) {
            None => {
                o.push((k.to_string(), v));
                true
            }
            Some((_, old)) => lenient || *old == v,
        }
    }
    for r in active {
        if r.code != Some(0) {
            return Merged::Conflict;
        }
        err.push_str(&r.err);
        if r.out.trim().is_empty() {
            continue;
        }
        let Some(v) = parse_object(&r.out) else { return Merged::Conflict };
        for (k, x) in &v {
            let mut ok;
            if k == "hookSpecificOutput" && x.is_object() {
                ok = put(&mut top, k, json!({}), lenient);
                for (k2, x2) in x.as_object().unwrap() {
                    if k2 == "additionalContext" && x2.is_string() {
                        contexts.push(x2.as_str().unwrap().to_string());
                        ok = put(&mut hso, k2, json!(""), lenient) && ok;
                    } else if k2 == "permissionDecision" && x2.is_string() {
                        let val = x2.as_str().unwrap();
                        let rank = PRECEDENCE.iter().position(|p| *p == val).unwrap_or(PRECEDENCE.len());
                        if decision.as_ref().is_none_or(|d| rank < d.0) {
                            decision = Some((rank, val.to_string(), x.get("permissionDecisionReason").cloned()));
                        }
                        ok = put(&mut hso, k2, json!(""), lenient) && ok;
                    } else if k2 == "permissionDecisionReason" {
                        ok = put(&mut hso, k2, json!(""), lenient) && ok;
                    } else {
                        ok = put(&mut hso, k2, x2.clone(), lenient) && ok;
                    }
                }
            } else if k == "systemMessage" && x.is_string() {
                messages.push(x.as_str().unwrap().to_string());
                ok = put(&mut top, k, json!(""), lenient);
            } else {
                ok = put(&mut top, k, x.clone(), lenient);
            }
            if !ok {
                return Merged::Conflict;
            }
        }
    }
    let mut out_h = Map::new();
    for (k, v) in &hso {
        match k.as_str() {
            "additionalContext" => {
                // deliberate difference from the old registry (DECISIONS 1.78): an empty context adds no joiner, or a quiet hook
                // among talkative ones would deliver "\n\n" of nothing
                out_h.insert(k.clone(), json!(contexts.iter().filter(|c| !c.is_empty()).cloned().collect::<Vec<_>>().join("\n\n")));
            }
            "permissionDecision" => {
                if let Some(d) = &decision {
                    out_h.insert(k.clone(), json!(d.1));
                }
            }
            "permissionDecisionReason" => {
                if let Some((_, _, Some(r))) = &decision {
                    out_h.insert(k.clone(), r.clone());
                }
            }
            _ => {
                out_h.insert(k.clone(), v.clone());
            }
        }
    }
    let mut out_top = Map::new();
    for (k, v) in &top {
        match k.as_str() {
            "hookSpecificOutput" => {
                out_top.insert(k.clone(), Value::Object(out_h.clone()));
            }
            "systemMessage" => {
                out_top.insert(k.clone(), json!(messages.join("\n")));
            }
            _ => {
                out_top.insert(k.clone(), v.clone());
            }
        }
    }
    Merged::Answer(Res { code: Some(0), out: Value::Object(out_top).to_string() + "\n", err })
}

/// The host skips an empty additionalContext: an answer leaves it out, then a hookSpecificOutput left with only its
/// hookEventName, and an object left empty is no output.
fn tidy(out: &str) -> String {
    let Some(mut top) = parse_object(out) else { return out.to_string() };
    let Some(Value::Object(hso)) = top.get_mut("hookSpecificOutput") else { return out.to_string() };
    if hso.get("additionalContext") != Some(&json!("")) {
        return out.to_string();
    }
    hso.remove("additionalContext");
    if hso.keys().all(|k| k == "hookEventName") {
        top.remove("hookSpecificOutput");
    }
    if top.is_empty() { String::new() } else { Value::Object(top).to_string() + "\n" }
}

/// The reason the host gives the model for one block: a JSON block's reason (taken over stderr even on exit 2), else stderr.
fn block_reason(r: &Res) -> String {
    let text = match parse_object(&r.out).filter(|_| json_blocks(&r.out)) {
        Some(v) if v.get("decision").and_then(Value::as_str) == Some("block") => v.get("reason").and_then(Value::as_str).unwrap_or("").to_string(),
        Some(v) => v.get("hookSpecificOutput").and_then(|h| h.get("permissionDecisionReason")).and_then(Value::as_str).unwrap_or("").to_string(),
        None => r.err.clone(),
    };
    text.trim_end_matches('\n').to_string()
}

/// Several blocks: the host shows the model every reason, so the one answer carries them all, in order.
/// `notes`: the plain stdout of the hooks that exited 0 without blocking, kept off the model channel.
fn blocked(blockers: &[&Res], advisories: &[&Res], notes: &str) -> Res {
    if let ([one], [], "") = (blockers, advisories, notes) {
        return (*one).clone();
    }
    let joined = blockers.iter().map(|r| block_reason(r)).filter(|s| !s.is_empty()).collect::<Vec<_>>().join("\n\n");
    let line = |s: &str| if s.ends_with('\n') { s.to_string() } else { format!("{s}\n") };
    let reasons_err = if joined.is_empty() { String::new() } else { line(&joined) };
    let exit2 = blockers.iter().any(|r| r.code == Some(2));
    let Some(mut top) = blockers.iter().find(|r| json_blocks(&r.out)).and_then(|r| parse_object(&r.out)) else {
        let plain: String = blockers.iter().filter(|r| !r.out.is_empty() && parse_object(&r.out).is_none()).map(|r| line(&r.out)).collect();
        return Res { code: Some(2), out: plain + notes, err: reasons_err };
    };
    if top.get("decision").and_then(Value::as_str) == Some("block") {
        top.insert("reason".into(), json!(joined));
    } else if let Some(Value::Object(h)) = top.get_mut("hookSpecificOutput") {
        h.insert("permissionDecisionReason".into(), json!(joined));
    }
    // Stop-style events: the advisories of the hooks that did not block ride along (message and context); on exit 2 a plain
    // note joins the system message instead of the reason channel (stderr).
    let say = |r: &&Res, key: &str| parse_object(&r.out).and_then(|o| o.get(key).and_then(Value::as_str).map(str::to_string));
    let mut messages: Vec<String> = blockers.iter().filter_map(|r| say(r, "systemMessage")).filter(|m| !m.is_empty()).collect();
    messages.extend(advisories.iter().filter_map(|r| say(r, "systemMessage")).filter(|m| !m.is_empty()));
    if exit2 && !notes.trim().is_empty() {
        messages.push(notes.trim_end_matches('\n').to_string());
    }
    if !messages.is_empty() {
        top.insert("systemMessage".into(), json!(messages.join(defaults::text("dispatch.message_joiner"))));
    }
    let extra: Vec<(String, String)> = advisories
        .iter()
        .filter_map(|r| {
            let h = parse_object(&r.out)?.get("hookSpecificOutput")?.as_object()?.clone();
            let ev = h.get("hookEventName").and_then(Value::as_str).unwrap_or("").to_string();
            Some((ev, h.get("additionalContext").and_then(Value::as_str).unwrap_or("").to_string()))
        })
        .filter(|(_, c)| !c.is_empty())
        .collect();
    if !extra.is_empty() {
        let join = defaults::text("dispatch.context_joiner");
        let adv = extra.iter().map(|(_, c)| c.as_str()).collect::<Vec<_>>().join(join);
        if let Some(Value::Object(h)) = top.get_mut("hookSpecificOutput") {
            let have = h.get("additionalContext").and_then(Value::as_str).unwrap_or("").to_string();
            h.insert("additionalContext".into(), json!(if have.is_empty() { adv } else { format!("{have}{join}{adv}") }));
        } else {
            top.insert("hookSpecificOutput".into(), json!({"hookEventName": extra[0].0, "additionalContext": adv}));
        }
    }
    let mut err = if exit2 { reasons_err } else { blockers.iter().map(|r| r.err.as_str()).collect::<String>() };
    if !exit2 {
        err.push_str(notes);
    }
    Res { code: Some(if exit2 { 2 } else { 0 }), out: Value::Object(top).to_string() + "\n", err }
}

fn combine(results: &[Res], keep_advisories: bool) -> Merged {
    let is_block = |r: &Res| r.code == Some(2) || (r.code.is_some() && json_blocks(&r.out));
    let blockers: Vec<&Res> = results.iter().filter(|r| is_block(r)).collect();
    if !blockers.is_empty() {
        let notes: String = results
            .iter()
            .filter(|r| r.code == Some(0) && !is_block(r) && !r.out.trim().is_empty() && parse_object(&r.out).is_none())
            .map(|r| if r.out.ends_with('\n') { r.out.clone() } else { format!("{}\n", r.out) })
            .collect();
        let advisories: Vec<&Res> = results.iter().filter(|r| keep_advisories && r.code == Some(0) && !is_block(r) && parse_object(&r.out).is_some()).collect();
        return Merged::Answer(blocked(&blockers, &advisories, &notes));
    }
    let active: Vec<&Res> = results.iter().filter(|r| r.code.is_some() && (r.code != Some(0) || !r.out.is_empty() || !r.err.is_empty())).collect();
    let answer = match active.len() {
        0 => return Merged::Answer(Res { code: Some(0), out: String::new(), err: String::new() }),
        1 => Merged::Answer(active[0].clone()),
        _ => merge_objects(&active, false),
    };
    match answer {
        Merged::Answer(mut a) if a.code == Some(0) => {
            a.out = tidy(&a.out);
            Merged::Answer(a)
        }
        other => other,
    }
}

/// `sequential` of the model: what is delivered when the results cannot be one exact answer.
fn sequential(results: &[Res], event: &str) -> Res {
    let live: Vec<&Res> = results.iter().filter(|r| r.code.is_some()).collect();
    let mut err: String = live.iter().map(|r| r.err.as_str()).collect();
    let mut said: Vec<Res> = live.iter().filter(|r| r.code == Some(0) && !r.out.is_empty()).map(|r| (*r).clone()).collect();
    let plain_events = defaults::list("dispatch.plain_context_events");
    if plain_events.contains(&event) && said.iter().any(|r| parse_object(&r.out).is_some()) && said.iter().any(|r| parse_object(&r.out).is_none()) {
        for r in said.iter_mut().filter(|r| parse_object(&r.out).is_none()) {
            r.out = json!({"hookSpecificOutput": {"hookEventName": event, "additionalContext": r.out.trim_end_matches('\n')}}).to_string() + "\n";
        }
    }
    let (json_rs, plain): (Vec<&Res>, Vec<&Res>) = said.iter().partition(|r| parse_object(&r.out).is_some());
    let lines = |rs: &[&Res]| -> String { rs.iter().map(|r| if r.out.ends_with('\n') { r.out.clone() } else { format!("{}\n", r.out) }).collect() };
    if json_rs.is_empty() {
        return Res { code: Some(0), out: lines(&plain), err };
    }
    let out = if json_rs.len() == 1 {
        lines(&json_rs)
    } else {
        match merge_objects(&json_rs, true) {
            Merged::Answer(a) => a.out,
            Merged::Conflict => String::new(),
        }
    };
    err.push_str(&lines(&plain));
    Res { code: Some(0), out: tidy(&out), err }
}

/// Two stdouts are the same to a host when they are the same bytes, or both JSON objects with the same content.
fn same_stdout(a: &str, b: &str) -> bool {
    a == b || matches!((parse_object(a), parse_object(b)), (Some(x), Some(y)) if x == y && a.ends_with('\n') == b.ends_with('\n'))
}

// ---- the rows --------------------------------------------------------------------------------------------------------------

/// What a fake hook prints for one row.
#[derive(Clone, Debug, Default)]
struct Spec {
    out: String,
    err: String,
    code: i32,
}

#[derive(Clone)]
struct Row {
    host: &'static str,
    event: String,
    class: &'static str,
    bytes: Vec<u8>,
    /// The payload as the host sees it (for matching); `None` = unreadable, every entry is selected.
    logical: Option<Value>,
    /// Fake hooks (per entry id) instead of the shipped commands.
    fakes: Option<Vec<(String, Spec)>>,
    /// The documented stricter case: expect the engine's fail-closed answer, not Node's.
    stricter: bool,
}

struct Rig {
    repo: PathBuf,
    plugin: PathBuf,
    root: PathBuf,
    specs: PathBuf,
    fake: PathBuf,
    registry: [Value; 2],
    thin: [Value; 2],
}

fn hosts() -> [&'static str; 2] {
    ["claude", "codex"]
}

fn host_index(h: &str) -> usize {
    usize::from(h == "codex")
}

impl Rig {
    fn new(tag: &str) -> Rig {
        let root = std::env::temp_dir().join(format!("ahd-flip-{tag}-{}", std::process::id()));
        ah_engine::discard::harmless(std::fs::remove_dir_all(&root));
        for d in ["repo", "specs", "h-old", "h-new", "state"] {
            std::fs::create_dir_all(root.join(d)).unwrap();
        }
        let git = |args: &[&str]| {
            Command::new("git")
                .args(args)
                .current_dir(root.join("repo"))
                .env("HOME", root.join("h-old"))
                .env("GIT_AUTHOR_NAME", "p")
                .env("GIT_AUTHOR_EMAIL", "p@p")
                .env("GIT_COMMITTER_NAME", "p")
                .env("GIT_COMMITTER_EMAIL", "p@p")
                .output()
                .unwrap()
        };
        git(&["init", "-q", "-b", "main"]);
        git(&["commit", "-q", "--allow-empty", "-m", "init"]);
        let fake = root.join("fake-hook.sh");
        std::fs::write(
            &fake,
            "#!/bin/sh\nid=$1\nhead -c 4096 > \"$TMPDIR_FLIP/in.$$\"\ncat > /dev/null\nrow=$(sed -n 's/.*\"session_id\" *: *\"flip-\\([0-9][0-9]*\\)\".*/\\1/p' \"$TMPDIR_FLIP/in.$$\" | head -n 1)\nrm -f \"$TMPDIR_FLIP/in.$$\"\n[ -n \"$row\" ] || exit 0\nd=\"$SPECS_FLIP/$row\"\n[ -f \"$d/$id.out\" ] && cat \"$d/$id.out\"\n[ -f \"$d/$id.err\" ] && cat \"$d/$id.err\" >&2\ncode=0\n[ -f \"$d/$id.code\" ] && code=$(cat \"$d/$id.code\")\nexit \"$code\"\n",
        )
        .unwrap();
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let plugin = manifest.join("../plugins/anti-hall").canonicalize().unwrap();
        let rd = |rel: &str| -> Value { serde_json::from_str(&std::fs::read_to_string(plugin.join(rel)).unwrap()).unwrap() };
        let rig = Rig {
            specs: root.join("specs"),
            repo: root.join("repo"),
            registry: [rd("hooks/hooks.registry.json"), rd("codex/hooks/hooks.registry.json")],
            thin: [rd("hooks/hooks.json"), rd("codex/hooks/hooks.json")],
            fake,
            plugin,
            root,
        };
        for h in hosts() {
            rig.fake_files(h); // built once, before any worker thread runs
        }
        rig
    }

    fn env(&self, side: &str, extra: &[(&str, String)]) -> Vec<(String, String)> {
        let mut e: Vec<(String, String)> = vec![
            ("PATH".into(), std::env::var("PATH").unwrap_or_default()),
            ("HOME".into(), self.root.join(format!("h-{side}")).display().to_string()),
            ("ANTIHALL_TEST_ISOLATION".into(), "1".into()),
            ("CLAUDE_PLUGIN_ROOT".into(), self.plugin.display().to_string()),
            ("PLUGIN_ROOT".into(), self.plugin.display().to_string()),
            ("TMPDIR_FLIP".into(), self.root.display().to_string()),
            ("SPECS_FLIP".into(), self.specs.display().to_string()),
            ("TMPDIR".into(), self.root.display().to_string()),
        ];
        e.extend(extra.iter().map(|(k, v)| (k.to_string(), v.clone())));
        e
    }

    fn write_specs(&self, n: usize, fakes: &[(String, Spec)]) {
        let d = self.specs.join(n.to_string());
        ah_engine::discard::harmless(std::fs::remove_dir_all(&d));
        std::fs::create_dir_all(&d).unwrap();
        for (id, s) in fakes {
            std::fs::write(d.join(format!("{id}.out")), &s.out).unwrap();
            std::fs::write(d.join(format!("{id}.err")), &s.err).unwrap();
            std::fs::write(d.join(format!("{id}.code")), s.code.to_string()).unwrap();
        }
    }

    /// The shipped command of an entry, or the fake that replaces it.
    fn command_of(&self, sel: &Sel, row: &Row) -> String {
        match &row.fakes {
            Some(_) => format!("sh {} {}", self.fake.display(), sel.id),
            None => sel.command.clone(),
        }
    }

    fn old(&self, row: &Row, n: usize) -> Res {
        let sels = select(&self.registry[host_index(row.host)], row.host, &row.event, row.logical.as_ref());
        if let Some(f) = &row.fakes {
            self.write_specs(n, f);
        }
        let env = self.env("old", &[]);
        let results: Vec<Res> = std::thread::scope(|sc| {
            let hs: Vec<_> = sels
                .iter()
                .map(|s| {
                    let (cmd, env, repo, bytes) = (self.command_of(s, row), &env, &self.repo, &row.bytes);
                    let t = if s.timeout == 0 { 600 } else { s.timeout };
                    sc.spawn(move || run_shell(&cmd, bytes, env, repo, t))
                })
                .collect();
            hs.into_iter().map(|h| h.join().unwrap()).collect()
        });
        match combine(&results, defaults::list("dispatch.stop_events").contains(&row.event.as_str())) {
            Merged::Answer(a) => a,
            Merged::Conflict => sequential(&results, &row.event),
        }
    }

    /// The thin entry of the event, run as the host runs a command hook.
    fn new_path(&self, row: &Row) -> Res {
        let thin = &self.thin[host_index(row.host)];
        let h = &thin["hooks"][row.event.as_str()][0]["hooks"][0];
        let command = h["command"].as_str().unwrap().to_string();
        let timeout = h["timeout"].as_u64().unwrap();
        let mut extra = vec![
            ("AH_WRAPPER_TEST", "1".to_string()),
            ("AH_ENGINE_BIN", env!("CARGO_BIN_EXE_ah-engine").to_string()),
            ("AH_ENGINE_DIR", self.root.join("state").display().to_string()),
            ("AH_ENGINE_VERSION", "flip-parity".to_string()),
            ("AH_ENGINE_DISPATCH_IN_PROCESS", "1".to_string()),
        ];
        if row.class == "fuzz" {
            // checks down: no built-in check answers (the daemon is never started), every entry runs as its fake Node hook, so
            // the merge, cap and decision logic is fuzzed on every (event, tool), whichever entries have a check by now
            extra.retain(|(k, _)| *k != "AH_ENGINE_DISPATCH_IN_PROCESS");
            extra.push(("AH_ENGINE_DISPATCH_IN_PROCESS", "0".to_string()));
            extra.push(("AH_ENGINE_NOSPAWN", "1".to_string()));
        }
        if row.fakes.is_some() {
            let (list, map) = self.fake_files(row.host);
            extra.push(("AH_FALLBACK_LIST", list.display().to_string()));
            extra.push(("AH_FALLBACK_MAP", map.display().to_string()));
        }
        run_shell(&command, &row.bytes, &self.env("new", &extra), &self.repo, timeout + 30)
    }

    /// A fallback list and map with the fake hook behind every table entry (the same fakes the OLD side runs).
    fn fake_files(&self, host: &str) -> (PathBuf, PathBuf) {
        let (list, map) = (self.root.join(format!("fake-{host}.list")), self.root.join(format!("fake-{host}.map.json")));
        if !list.exists() {
            let mut l = String::from("# fake\n");
            let mut m = Map::new();
            for ev in hooksgen::events(host) {
                let entries = table::entries(host, ev);
                let t = hooksgen::event_timeout(host, ev);
                if entries.is_empty() {
                    l.push_str(&format!("@{ev}\t{t}\tempty\n"));
                    continue;
                }
                l.push_str(&format!("@{ev}\t{t}\n"));
                let mut ids = Map::new();
                for e in entries {
                    let cmd = format!("sh {} {}", self.fake.display(), e.id);
                    l.push_str(&format!(
                        "{}\t{}\t{cmd}\n",
                        if e.matcher.is_empty() { "*" } else { e.matcher.as_str() },
                        if e.timeout_s == 0 { t } else { e.timeout_s }
                    ));
                    ids.insert(e.id, json!(cmd));
                }
                m.insert(ev.to_string(), Value::Object(ids));
            }
            std::fs::write(&list, l).unwrap();
            std::fs::write(&map, Value::Object(m).to_string()).unwrap();
        }
        (list, map)
    }
}

impl Drop for Rig {
    fn drop(&mut self) {
        ah_engine::discard::harmless(std::fs::remove_dir_all(&self.root));
    }
}

/// Built-in checks that inject text (never silent) on a well-formed payload.
const CONTEXT_CHECKS: [&str; 4] = ["verify-first-subagent", "verify-first-full", "fable-availability", "verify-first"];

fn has_context_check(host: &str, event: &str) -> bool {
    table::entries(host, event).iter().any(|e| e.check.as_deref().is_some_and(|c| CONTEXT_CHECKS.contains(&c)))
}

/// One row: the two answers must be identical (or the documented stricter one, for the one documented class).
fn check(rig: &Rig, row: &Row, n: usize) -> Result<(), String> {
    let want = rig.old(row, n);
    let got = rig.new_path(row);
    let ok = if row.stricter {
        got.code == Some(2) && got.err.contains(defaults::text("msg.dispatch_stdin_utf8"))
    } else if row.class == "well-formed" && has_context_check(row.host, &row.event) {
        // A context check answers a well-formed payload with real text natively, which the silent fake hooks of the oracle cannot
        // produce; the exact text is compared with Node by the check's own parity harness. Here: a clean exit 0 whose stdout is a
        // JSON object carrying the injected context and nothing on stderr, or, when the joined context of the event is over the
        // host's cap, the engine's request for the separate (here silent fake) hooks, which is the designed answer then.
        let separately = format!("anti-hall: engine fallback for {}: engine requested fallback\n", row.event);
        got.code == Some(0)
            && ((got.err.is_empty()
                && serde_json::from_str::<Value>(got.out.trim())
                    .ok()
                    .is_some_and(|v| v["hookSpecificOutput"]["additionalContext"].as_str().is_some_and(|s| !s.is_empty())))
                || (got.err == separately && got.out.is_empty()))
    } else {
        got.code == want.code && same_stdout(&got.out, &want.out) && got.err == want.err
    };
    if ok {
        Ok(())
    } else {
        let cut = |s: &str| s.chars().take(300).collect::<String>();
        Err(format!(
            "{} {} [{}] row {n}: want code={:?} out={:?} err={:?}; got code={:?} out={:?} err={:?}",
            row.host,
            row.event,
            row.class,
            want.code,
            cut(&want.out),
            cut(&want.err),
            got.code,
            cut(&got.out),
            cut(&got.err)
        ))
    }
}

fn run_rows(rig: &Rig, rows: Vec<Row>, conc: usize) -> (usize, Vec<String>, usize) {
    let rows = Arc::new(rows);
    let next = Arc::new(AtomicUsize::new(0));
    let fails = Arc::new(Mutex::new(Vec::new()));
    let stricter = Arc::new(AtomicUsize::new(0));
    std::thread::scope(|sc| {
        for _ in 0..conc {
            let (rows, next, fails, stricter) = (rows.clone(), next.clone(), fails.clone(), stricter.clone());
            sc.spawn(move || {
                loop {
                    let i = next.fetch_add(1, Ordering::SeqCst);
                    let Some(row) = rows.get(i) else { break };
                    if let Err(e) = check(rig, row, i) {
                        fails.lock().unwrap().push(e);
                    }
                    if row.stricter {
                        stricter.fetch_add(1, Ordering::SeqCst);
                    }
                }
            });
        }
    });
    let f = fails.lock().unwrap().clone();
    (rows.len(), f, stricter.load(Ordering::SeqCst))
}

fn report(name: &str, total: usize, fails: &[String], stricter: usize) {
    println!("flip parity {name}: {}/{} rows identical ({} documented stricter fail-closed rows)", total - fails.len(), total, stricter);
    assert!(
        fails.is_empty(),
        "{} of {total} rows differ between the old registry and the thin trigger:\n{}",
        fails.len(),
        fails.iter().take(12).cloned().collect::<Vec<_>>().join("\n")
    );
}

fn conc() -> usize {
    std::env::var("AH_FLIP_CONC").ok().and_then(|v| v.parse().ok()).unwrap_or(4)
}

// ---- corpus 1: recorded commands, real Node hooks -------------------------------------------------------------------------

fn recorded_commands() -> Vec<String> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("parity");
    let mut v = Vec::new();
    for f in ["corpus.jsonl", "corpus-whitespace.jsonl"] {
        for l in std::fs::read_to_string(dir.join(f)).unwrap().lines() {
            if let Some(c) = serde_json::from_str::<Value>(l).ok().and_then(|j| j["command"].as_str().map(str::to_string)) {
                v.push(c);
            }
        }
    }
    v
}

fn tool_payload(event: &str, n: usize, repo: &Path, command: &str) -> Value {
    let mut p = json!({"session_id": format!("flip-{n}"), "cwd": repo, "hook_event_name": event, "tool_name": "Bash", "tool_input": {"command": command}});
    if event != "PreToolUse" {
        p["tool_response"] = json!({"stdout": "", "stderr": "", "interrupted": false});
    }
    p
}

#[test]
fn recorded_commands_behave_identically_through_the_thin_trigger_with_the_real_node_hooks() {
    let rig = Rig::new("recorded");
    let all = recorded_commands();
    let full = std::env::var("AH_FLIP_FULL").is_ok();
    let stride = if full { 1 } else { (all.len() / 24).max(1) };
    let mut rows = Vec::new();
    for host in hosts() {
        for (i, cmd) in all.iter().enumerate().filter(|(i, _)| i % stride == 0) {
            for event in ["PreToolUse", "PostToolUse"] {
                if event == "PostToolUse" && i % (stride * 4) != 0 {
                    continue;
                }
                let p = tool_payload(event, rows.len(), &rig.repo, cmd);
                rows.push(Row {
                    host,
                    event: event.into(),
                    class: "recorded",
                    bytes: p.to_string().into_bytes(),
                    logical: Some(p),
                    fakes: None,
                    stricter: false,
                });
            }
        }
    }
    let (total, fails, stricter) = run_rows(&rig, rows, conc());
    report("recorded commands (real Node hooks)", total, &fails, stricter);
}

// ---- corpus 2: combination fuzz with fake hooks ---------------------------------------------------------------------------

struct Lcg(u64);

impl Lcg {
    fn next(&mut self) -> f64 {
        self.0 = (self.0.wrapping_mul(1103515245).wrapping_add(12345)) % 2147483648;
        self.0 as f64 / 2147483648.0
    }
    fn pick<'a, T>(&mut self, a: &'a [T]) -> &'a T {
        &a[(self.next() * a.len() as f64) as usize % a.len()]
    }
}

fn fuzz_spec(r: &mut Lcg, event: &str) -> Spec {
    let texts =
        ["plain words", "quote \" and \\ backslash", "line1\nline2", "tab\there", "unicode \u{e9} \u{2713}", "", "ctl \u{1} char", "{\"looks\":\"json\"}"];
    let hso = |o: Value| -> String {
        let mut m = Map::new();
        m.insert("hookEventName".into(), json!(event));
        m.extend(o.as_object().unwrap().clone());
        json!({"hookSpecificOutput": m}).to_string() + "\n"
    };
    let t = |r: &mut Lcg| r.pick(&texts).to_string();
    match (r.next() * 17.0) as usize {
        0 | 1 => Spec::default(),
        2 | 3 => Spec { out: hso(json!({"additionalContext": t(r)})), ..Spec::default() },
        4 => Spec { out: json!({"systemMessage": t(r)}).to_string() + "\n", ..Spec::default() },
        5 => Spec {
            out: json!({"systemMessage": t(r), "hookSpecificOutput": {"hookEventName": event, "additionalContext": t(r)}}).to_string() + "\n",
            ..Spec::default()
        },
        6 => Spec { code: 2, err: t(r) + "\n", ..Spec::default() },
        7 => {
            let x = t(r);
            Spec { code: 2, out: json!({"decision": "block", "reason": x}).to_string() + "\n", err: x + "\n" }
        }
        8 => Spec { out: json!({"decision": "block", "reason": t(r)}).to_string() + "\n", ..Spec::default() },
        9 => Spec { out: hso(json!({"permissionDecision": *r.pick(&["allow", "ask", "defer", "deny"]), "permissionDecisionReason": t(r)})), ..Spec::default() },
        10 => Spec { out: hso(json!({"permissionDecision": *r.pick(&["allow", "ask"])})), ..Spec::default() },
        11 => Spec { out: t(r), ..Spec::default() },
        12 => Spec { code: 1, err: "boom\n".into(), ..Spec::default() },
        13 => Spec { out: json!({"continue": r.next() < 0.5}).to_string() + "\n", ..Spec::default() },
        14 => Spec { out: hso(json!({"additionalContext": "x"})), ..Spec::default() },
        15 => {
            Spec { out: hso(json!({"updatedInput": {"command": t(r), "b": 1, "a": [1, {"z": 2, "y": 3}]}, "permissionDecision": "allow"})), ..Spec::default() }
        }
        _ => Spec { err: "stderr only at exit 0\n".into(), ..Spec::default() },
    }
}

/// Every (event, tool or payload fields) combination the table has entries for; each entry runs as a fake (checks down).
fn fake_targets(host: &str) -> Vec<(String, Value)> {
    let mut v = Vec::new();
    for ev in table::events(host) {
        let entries = table::entries(host, ev);
        if matcher_field(ev) == Some("tool_name") {
            let mut tools: Vec<String> = Vec::new();
            for e in &entries {
                for cand in [
                    "Read",
                    "SendMessage",
                    "AskUserQuestion",
                    "TaskStop",
                    "Workflow",
                    "Agent",
                    "TaskCreate",
                    "Bash",
                    "Edit",
                    "apply_patch",
                    "spawn_agent",
                    "Write",
                ] {
                    if matches(host, &e.matcher, &[cand.to_string()]) && !tools.contains(&cand.to_string()) {
                        tools.push(cand.to_string());
                    }
                }
            }
            for tool in tools {
                let sel = table::entries(host, ev).into_iter().filter(|e| matches(host, &e.matcher, std::slice::from_ref(&tool))).collect::<Vec<_>>();
                if sel.is_empty() {
                    continue;
                }
                v.push((ev.to_string(), json!({"tool_name": tool})));
            }
        } else if !entries.is_empty() {
            let extra = match ev {
                "SessionStart" => json!({"source": "startup"}),
                "SubagentStart" | "SubagentStop" => json!({"agent_type": "general-purpose"}),
                "PreCompact" | "PostCompact" => json!({"trigger": "auto"}),
                _ => json!({}),
            };
            v.push((ev.to_string(), extra));
        }
    }
    v
}

#[test]
fn a_seeded_combination_fuzz_merges_identically_through_the_thin_trigger() {
    let rig = Rig::new("fuzz");
    let n_per = std::env::var("AH_FLIP_FUZZ_N").ok().and_then(|v| v.parse().ok()).unwrap_or(40usize);
    let mut rng = Lcg(11);
    let mut rows = Vec::new();
    for host in hosts() {
        for (ev, fields) in fake_targets(host) {
            let entries: Vec<String> = table::entries(host, &ev).into_iter().map(|e| e.id).collect();
            for _ in 0..n_per {
                let n = rows.len();
                let mut p = json!({"session_id": format!("flip-{n}"), "cwd": rig.repo, "hook_event_name": ev});
                p.as_object_mut().unwrap().extend(fields.as_object().unwrap().clone());
                let k = 1 + (rng.next() * 4.0) as usize;
                let mut fakes: Vec<(String, Spec)> = Vec::new();
                for _ in 0..k {
                    let id = rng.pick(&entries).clone();
                    let spec = fuzz_spec(&mut rng, &ev);
                    fakes.retain(|(i, _)| *i != id);
                    fakes.push((id, spec));
                }
                rows.push(Row {
                    host,
                    event: ev.clone(),
                    class: "fuzz",
                    bytes: p.to_string().into_bytes(),
                    logical: Some(p),
                    fakes: Some(fakes),
                    stricter: false,
                });
            }
        }
    }
    let (total, fails, stricter) = run_rows(&rig, rows, conc());
    assert!(total >= 100, "the fuzz covers many (host, event, tool) targets: {total}");
    report("combination fuzz (fake hooks)", total, &fails, stricter);
}

// ---- corpus 3: payload classes on every event of the thin file --------------------------------------------------------------

fn class_rows(rig: &Rig) -> Vec<Row> {
    let mut rows = Vec::new();
    let cap = defaults::num("client.max_stdin") as usize;
    for host in hosts() {
        let thin = &rig.thin[host_index(host)];
        for ev in thin["hooks"].as_object().unwrap().keys() {
            let has_entries = !table::entries(host, ev).is_empty();
            let guard = defaults::list("dispatch.guard_events").contains(&ev.as_str());
            let field = matcher_field(ev);
            let n0 = rows.len();
            let mut base = json!({"session_id": format!("flip-{n0}"), "cwd": rig.repo, "hook_event_name": ev});
            if field == Some("tool_name") {
                base["tool_name"] = json!("Read");
                base["tool_input"] = json!({"file_path": "/nonexistent/x"});
            }
            let mk = |class: &'static str, bytes: Vec<u8>, logical: Option<Value>, stricter: bool, n: usize| -> Row {
                let fakes = has_entries.then(|| table::entries(host, ev).into_iter().map(|e| (e.id, Spec::default())).collect::<Vec<_>>());
                // fake hooks find their row by the session id in the first bytes, so every class keeps it there
                let _ = n;
                Row { host, event: ev.clone(), class, bytes, logical, fakes, stricter }
            };
            let sid = |n: usize| format!("flip-{n}");
            let add = |rows: &mut Vec<Row>, class: &'static str, build: &dyn Fn(usize) -> (Vec<u8>, Option<Value>, bool)| {
                let n = rows.len();
                let (bytes, logical, stricter) = build(n);
                rows.push(mk(class, bytes, logical, stricter, n));
            };
            add(&mut rows, "well-formed", &|n| {
                let mut p = base.clone();
                p["session_id"] = json!(sid(n));
                (p.to_string().into_bytes(), Some(p), false)
            });
            add(&mut rows, "not-json", &|n| (format!("{{\"session_id\":\"{}\",bad", sid(n)).into_bytes(), None, false));
            add(&mut rows, "lone-surrogate", &|n| {
                let mut p = base.clone();
                p["session_id"] = json!(sid(n));
                let raw = p.to_string().replacen("\"hook_event_name\"", "\"note\":\"\\ud83d\",\"hook_event_name\"", 1);
                (raw.into_bytes(), Some(p), false)
            });
            add(&mut rows, "invalid-utf8", &|n| {
                let mut p = base.clone();
                p["session_id"] = json!(sid(n));
                let mut raw = p.to_string().into_bytes();
                let at = raw.len() - 1;
                raw.splice(at..at, *b",\"note\":\"\xff\xfe\"");
                (raw, Some(p), guard && has_entries)
            });
            // over the stdin cap: the filler sits after the fields the hooks read
            add(&mut rows, "over-cap", &|n| {
                let mut p = base.clone();
                p["session_id"] = json!(sid(n));
                let mut raw = p.to_string();
                raw.pop();
                raw.push_str(",\"pad\":\"");
                raw.push_str(&"x".repeat(cap + 4096));
                raw.push_str("\"}");
                (raw.into_bytes(), Some(p), false)
            });
        }
    }
    rows
}

#[test]
fn every_event_of_the_thin_file_answers_like_the_old_registry_for_every_payload_class() {
    let rig = Rig::new("classes");
    let rows = class_rows(&rig);
    assert!(rows.iter().any(|r| r.class == "over-cap") && rows.iter().any(|r| r.class == "invalid-utf8"));
    let (total, fails, stricter) = run_rows(&rig, rows, conc());
    assert!(stricter > 0, "the documented stricter rows are present");
    report("payload classes on every thin event", total, &fails, stricter);
}

#[test]
fn the_documented_stricter_class_is_only_the_guard_events_that_have_table_entries() {
    let rig = Rig::new("stricter");
    for r in class_rows(&rig).iter().filter(|r| r.stricter) {
        assert!(defaults::list("dispatch.guard_events").contains(&r.event.as_str()) && !table::entries(r.host, &r.event).is_empty(), "{} {}", r.host, r.event);
    }
}
