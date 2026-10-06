//! The per-event dispatcher (D58): one `ah-engine hook --event <Event> [--tool <Tool>] [--host <host>]
//! [--fallback-map <file>]` call stands in for every hook `hooks.json` registers for that event.
//!
//! Steps:
//!  1. Pick the entries of the event's table (`defaults/dispatch.toml`, generated from `hooks.json`) whose matcher
//!     selects this payload, in `hooks.json` order. None: say nothing (an event no hook cares about never wakes the
//!     engine).
//!  2. Start every entry without a built-in check as its Node hook, all at once, as the host would.
//!  3. Ask the daemon for the built-in checks (`D` request; or run them here when `dispatch.in_process` is 1). An
//!     entry whose check defers, and every check when the daemon cannot answer, runs as its Node hook too (D11).
//!  4. Combine the results in table order the way the host combines separate hooks ([`combine`]).
//!
//! A guard event (`dispatch.guard_events`) whose Node hook cannot run (no runnable command, an unreadable
//! `--fallback-map`, a usage error, a panic) fails CLOSED: exit 2 with `dispatch.msg_fail_closed`, never a silent allow
//! (D74). Any other event runs the hooks it can and logs the ones it cannot. Results one output cannot express are
//! delivered one after another ([`combine::sequential`]); a join over the host's context cap is handed back to the
//! wrapper with `dispatch.defer_exit` so the hooks run separately, as the host runs them.
pub mod combine;
pub mod native;
pub mod node;
pub mod stoploop;
pub mod table;

use crate::client::Outcome;
use crate::error::DispatchError;
use crate::{defaults, health};
use native::{Answer, Meta};
use serde_json::Value;
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

/// The dispatcher's arguments.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Args {
    /// The host whose table applies.
    pub host: String,
    /// The hook event.
    pub event: String,
    /// The tool the host matched on, when the wiring passes it.
    pub tool: Option<String>,
    /// The `--fallback-map` file.
    pub map: Option<PathBuf>,
}

/// True when the `hook` command line asks for the dispatcher (it names an `--event`).
pub fn requested(args: &[String]) -> bool {
    args.iter().any(|a| a == "--event")
}

fn flag(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

/// Parse the dispatcher's flags.
pub fn parse_args(args: &[String]) -> Result<Args, DispatchError> {
    let host = flag(args, "--host").unwrap_or_else(|| defaults::text("dispatch.default_host").to_string());
    if !table::hosts().contains(&host.as_str()) {
        return Err(DispatchError::Host(host));
    }
    Ok(Args { host, event: flag(args, "--event").unwrap_or_default(), tool: flag(args, "--tool"), map: flag(args, "--fallback-map").map(PathBuf::from) })
}

/// Ask the daemon for the built-in checks; `None` when it cannot answer (the checks then run as Node hooks).
fn ask_daemon(meta: &Meta, raw: &str) -> Option<Vec<(String, Answer)>> {
    let cfg = crate::config::ClientConfig::from_env();
    let meta = serde_json::to_string(meta).ok()?;
    let req = format!("D {}\n{meta}\n{raw}", crate::version());
    if req.len() as u64 > defaults::num("daemon.max_request") {
        return None; // the daemon would refuse it; Node answers instead
    }
    native::decode(&crate::client::attempt(req.as_bytes(), &cfg, true)?)
}

/// True for an event whose hooks can block: a deferral there fails closed.
fn guarded(event: &str) -> bool {
    defaults::list("dispatch.guard_events").contains(&event)
}

struct PayloadInput {
    raw: Vec<u8>,
    file: Option<File>,
}

impl PayloadInput {
    fn read_stdin(max: u64) -> std::io::Result<PayloadInput> {
        let keep = max as usize;
        let mut raw = Vec::with_capacity(keep.min(64 * 1024));
        let mut file: Option<File> = None;
        let mut stdin = std::io::stdin().lock();
        let mut chunk = [0u8; 64 * 1024];
        loop {
            match stdin.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => {
                    if let Some(f) = file.as_mut() {
                        f.write_all(&chunk[..n])?;
                    } else if raw.len() + n <= keep {
                        raw.extend_from_slice(&chunk[..n]);
                    } else {
                        let take = keep - raw.len();
                        raw.extend_from_slice(&chunk[..take]);
                        let mut f = create_anonymous_payload()?;
                        f.write_all(&raw)?;
                        f.write_all(&chunk[take..n])?;
                        file = Some(f);
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                Err(e) => return Err(e),
            }
        }
        if let Some(f) = file.as_mut() {
            let _ = f.sync_all();
        }
        Ok(PayloadInput { raw, file })
    }

    fn over_cap(&self) -> bool {
        self.file.is_some()
    }

    fn bytes_for_engine(&self, max: u64) -> &[u8] {
        let end = self.raw.len().min(max as usize);
        &self.raw[..end]
    }

    fn structural_tool_name(&self) -> Option<String> {
        match &self.file {
            Some(file) => {
                let mut f = file.try_clone().ok()?;
                f.seek(SeekFrom::Start(0)).ok()?;
                scan_tool_name(&mut f).ok().flatten()
            }
            None => scan_tool_name(&mut self.raw.as_slice()).ok().flatten(),
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum StringRole {
    Key,
    ToolValue,
    Other,
}

fn decode_json_string(bytes: &[u8]) -> Result<String, ()> {
    let mut s = Vec::with_capacity(bytes.len() + 2);
    s.push(b'"');
    s.extend_from_slice(bytes);
    s.push(b'"');
    serde_json::from_slice::<String>(&s).map_err(|_| ())
}

fn scan_tool_name(input: &mut impl Read) -> Result<Option<String>, ()> {
    let mut buf = [0u8; 64 * 1024];
    let mut depth = 0usize;
    let mut started = false;
    let mut done = false;
    let mut in_string = false;
    let mut escaped = false;
    let mut role = StringRole::Other;
    let mut collected = Vec::new();
    let mut expect_key = false;
    let mut expect_colon = false;
    let mut expect_value = false;
    let mut key: Option<String> = None;
    let mut found: Option<String> = None;
    loop {
        let n = input.read(&mut buf).map_err(|_| ())?;
        if n == 0 {
            break;
        }
        for &b in &buf[..n] {
            if in_string {
                if escaped {
                    if role != StringRole::Other {
                        collected.push(b);
                    }
                    escaped = false;
                    continue;
                }
                if b == b'\\' {
                    if role != StringRole::Other {
                        collected.push(b);
                    }
                    escaped = true;
                    continue;
                }
                if b == b'"' {
                    in_string = false;
                    match role {
                        StringRole::Key => {
                            key = Some(decode_json_string(&collected)?);
                            expect_key = false;
                            expect_colon = true;
                        }
                        StringRole::ToolValue => {
                            let value = decode_json_string(&collected)?;
                            if found.as_ref().is_some_and(|old| old != &value) {
                                return Err(());
                            }
                            found = Some(value);
                            key = None;
                            expect_value = false;
                        }
                        StringRole::Other => {
                            expect_value = false;
                        }
                    }
                    collected.clear();
                    role = StringRole::Other;
                    continue;
                }
                if role != StringRole::Other {
                    collected.push(b);
                }
                continue;
            }
            if done {
                if !b.is_ascii_whitespace() {
                    return Err(());
                }
                continue;
            }
            if !started {
                if b.is_ascii_whitespace() {
                    continue;
                }
                if b != b'{' {
                    return Err(());
                }
                started = true;
                depth = 1;
                expect_key = true;
                continue;
            }
            match b {
                b if b.is_ascii_whitespace() => {}
                b'"' => {
                    in_string = true;
                    role = if depth == 1 && expect_key {
                        StringRole::Key
                    } else if depth == 1 && expect_value && key.as_deref() == Some("tool_name") {
                        StringRole::ToolValue
                    } else {
                        StringRole::Other
                    };
                    if role != StringRole::Other {
                        collected.clear();
                    }
                }
                b':' if depth == 1 && expect_colon => {
                    expect_colon = false;
                    expect_value = true;
                }
                b',' if depth == 1 => {
                    key = None;
                    expect_key = true;
                    expect_colon = false;
                    expect_value = false;
                }
                b'{' | b'[' => {
                    if depth == 1 && expect_value && key.as_deref() == Some("tool_name") {
                        return Err(());
                    }
                    depth += 1;
                }
                b'}' | b']' => {
                    if depth == 1 && expect_value && key.as_deref() == Some("tool_name") {
                        return Err(());
                    }
                    depth = depth.checked_sub(1).ok_or(())?;
                    if depth == 0 {
                        done = true;
                    }
                }
                _ if depth == 1 && expect_value && key.as_deref() == Some("tool_name") => return Err(()),
                _ => {}
            }
        }
    }
    if in_string || depth != 0 || !started {
        return Err(());
    }
    Ok(found)
}

fn create_anonymous_payload() -> std::io::Result<File> {
    let dir = crate::paths::dir();
    crate::limits::ensure_private_dir(&dir).map_err(|e| std::io::Error::other(e.to_string()))?;
    static NEXT: AtomicU64 = AtomicU64::new(0);
    for _ in 0..100 {
        let name = format!("dispatch-stdin-{}-{}-{}.tmp", crate::health::now_ms(), std::process::id(), NEXT.fetch_add(1, Ordering::SeqCst));
        let path = dir.join(name);
        let mut opts = OpenOptions::new();
        opts.read(true).write(true).create_new(true).mode(0o600);
        opts.custom_flags(libc::O_NOFOLLOW);
        match opts.open(&path) {
            Ok(file) => {
                std::fs::remove_file(&path)?;
                return Ok(file);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e),
        }
    }
    Err(std::io::Error::new(std::io::ErrorKind::AlreadyExists, "could not create unique dispatch stdin file"))
}

fn is_dispatch_spool_name(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("dispatch-stdin-") else { return false };
    let Some(mid) = rest.strip_suffix(".tmp") else { return false };
    !mid.is_empty() && mid.bytes().all(|b| b.is_ascii_digit() || b == b'-')
}

/// Remove named raw-payload spool files left by older builds or by an unlink failure. Anonymous in-flight payloads never
/// appear in the directory.
pub fn sweep_stale_spool() {
    let dir = crate::paths::dir();
    let Ok(rd) = std::fs::read_dir(&dir) else { return };
    let stale = std::time::Duration::from_secs(defaults::num("dispatch.spool_stale_s"));
    let uid = crate::paths::uid();
    let mut removed = 0u64;
    for e in rd.flatten() {
        let name = e.file_name();
        let Some(_) = name.to_str().filter(|n| is_dispatch_spool_name(n)) else { continue };
        let Ok(m) = std::fs::symlink_metadata(e.path()) else { continue };
        if !m.file_type().is_file() || m.uid() != uid {
            continue;
        }
        let old = m.modified().ok().and_then(|t| t.elapsed().ok()).is_some_and(|age| age > stale);
        if old && std::fs::remove_file(e.path()).is_ok() {
            removed += 1;
        }
    }
    if removed > 0 {
        health::log_event("dispatch_spool_sweep", "-", &defaults::render("dispatch.msg_spool_sweep", &[("n", &removed)]));
    }
}

fn log_defer(event: &str, why: &str) {
    // the state dir may not exist yet (no daemon ever ran here); the deferral must still be on record
    let _ = crate::limits::ensure_private_dir(&crate::paths::dir());
    health::log_event("dispatch_defer", event, &defaults::render("dispatch.msg_defer", &[("why", &why)]));
}

/// The answer for a guard event whose Node hooks cannot run: block (exit 2), never a silent allow. See [`closed`] for the
/// Stop events, which must not block forever.
pub fn fail_closed(event: &str, why: &str) -> Outcome {
    closed(event, None, why)
}

/// [`fail_closed`] with the payload at hand. On Stop and SubagentStop the block is bounded ([`stoploop`]): `stop_hook_active`
/// true, or too many consecutive blocks in the session, fails OPEN with a log and a note, because a block there that can
/// never clear keeps the agent from finishing.
pub fn closed(event: &str, payload: Option<&Value>, why: &str) -> Outcome {
    log_defer(event, why);
    if stoploop::is_stop_event(event)
        && let stoploop::Verdict::Open(note) = stoploop::judge(event, payload, why)
    {
        health::log_event("dispatch_stop_open", event, &note);
        return Outcome { out: String::new(), code: 0, err: format!("{note}\n") };
    }
    let key = if stoploop::is_stop_event(event) { "dispatch.msg_fail_closed_stop" } else { "dispatch.msg_fail_closed" };
    Outcome { out: String::new(), code: 2, err: format!("{}\n", defaults::render(key, &[("event", &event), ("why", &why)])) }
}

/// The first genuine block among the results that did run (exit 2, or a JSON block), as the answer to hand back verbatim.
fn genuine_block(done: Vec<Option<combine::HookResult>>) -> Option<Outcome> {
    let done: Vec<combine::HookResult> = done.into_iter().flatten().collect();
    let blocker = done.iter().find(|r| r.code == Some(2)).or_else(|| done.iter().find(|r| r.code.is_some() && combine::json_blocks(&r.out)))?;
    match combine::combine(std::slice::from_ref(blocker)) {
        combine::Combined::Answer(o) => Some(o),
        _ => None,
    }
}

/// The joined `additionalContext` length and the host's cap, when several hooks contributed context and the join is over
/// the cap: the host spills one over-cap value to a file where separate hooks would each have been inline.
fn over_cap(args: &Args, results: &[combine::HookResult], joined: &str) -> Option<(usize, usize)> {
    let cap = defaults::raw("dispatch.context_cap").get(&args.host).and_then(|v| v.as_integer()).unwrap_or(0) as usize;
    let len = combine::context_of(joined)?.chars().count();
    let contexts = results.iter().filter(|r| combine::context_of(&r.out).is_some()).count();
    (cap > 0 && contexts > 1 && len > cap).then_some((len, cap))
}

/// Dispatch one event; the result is what to print and exit with. A guard event whose Node hooks cannot run answers exit 2
/// ([`fail_closed`]); any other event runs the hooks it can and logs the rest. Output the host would have seen as separate
/// hooks and one process cannot join is delivered one after another, or (over the host's context cap) handed back to the
/// wrapper with `dispatch.defer_exit`.
pub fn run(raw: &str, args: &Args) -> Outcome {
    run_inner(raw, args, None, true)
}

fn start_node(e: &table::Entry, raw: &[u8], payload: Option<&File>) -> node::Running {
    payload.map_or_else(|| node::start(e, raw), |p| node::start_file(e, p))
}

fn run_inner(raw: &str, args: &Args, payload: Option<&File>, complete: bool) -> Outcome {
    let guard = guarded(&args.event);
    let parsed = complete.then(|| serde_json::from_str::<Value>(raw).ok()).flatten();
    let p = parsed.clone().unwrap_or(Value::Null);
    let mut pre_err = String::new();
    let mut entries = if guard {
        table::select_guarded(&args.host, &args.event, &p, args.tool.as_deref())
    } else if !complete && parsed.is_none() && args.tool.is_none() {
        table::entries(&args.host, &args.event)
    } else {
        table::select(&args.host, &args.event, &p, args.tool.as_deref())
    };
    if entries.is_empty() {
        // no guard ran for this payload (another agent's SubagentStop, say), so it proves nothing about a block run
        return Outcome { out: String::new(), code: 0, err: String::new() };
    }
    if let Some(path) = &args.map {
        match table::FallbackMap::load(path) {
            Ok(m) => m.apply(&args.event, &mut entries),
            Err(e) if guard => return closed(&args.event, parsed.as_ref(), &e.to_string()),
            Err(e) => log_defer(&args.event, &e.to_string()),
        }
    }
    let no_command = |id: &str| defaults::render("dispatch.msg_no_fallback", &[("id", &id)]);
    if guard {
        if let Some(e) = entries.iter().find(|e| e.check.is_none() && !table::runnable(&e.command)) {
            return closed(&args.event, parsed.as_ref(), &no_command(&e.id));
        }
    } else {
        entries.retain(|e| {
            let ok = e.check.is_some() || table::runnable(&e.command);
            if !ok {
                let note = defaults::render("dispatch.msg_skipped_entry", &[("id", &e.id)]);
                let stderr = defaults::render("dispatch.msg_skipped_entry_stderr", &[("event", &args.event), ("id", &e.id)]);
                let _ = crate::limits::ensure_private_dir(&crate::paths::dir());
                health::log_event("dispatch_defer", &args.event, &note);
                pre_err.push_str(&stderr);
                pre_err.push('\n');
            }
            ok
        });
        if entries.is_empty() {
            return Outcome { out: String::new(), code: 0, err: pre_err };
        }
    }
    // the Node hooks start first, so they run while the built-in checks are answered
    let mut started: Vec<(usize, node::Running)> =
        entries.iter().enumerate().filter(|(_, e)| e.check.is_none()).map(|(i, e)| (i, start_node(e, raw.as_bytes(), payload))).collect();
    let meta = Meta {
        host: args.host.clone(),
        event: args.event.clone(),
        tool: args.tool.clone(),
        root: table::plugin_root(&args.host),
        env: crate::reqenv::RequestEnv::capture(),
    };
    let answers = match (&parsed, complete) {
        // a payload serde_json cannot read (JS may): every check defers, Node decides
        (_, false) | (None, _) => Vec::new(),
        (Some(_), _) if entries.iter().all(|e| e.check.is_none()) => Vec::new(),
        (Some(p), _) if defaults::num("dispatch.in_process") == 1 => native::evaluate(&meta, p, &|_, _, _| {}),
        (Some(_), _) => ask_daemon(&meta, raw).unwrap_or_default(),
    };
    let mut results: Vec<Option<combine::HookResult>> = vec![None; entries.len()];
    for (i, e) in entries.iter().enumerate().filter(|(_, e)| e.check.is_some()) {
        match answers.iter().find(|(id, _)| *id == e.id) {
            Some((_, Answer::Decided(r))) => results[i] = Some(r.clone()),
            _ if !table::runnable(&e.command) => {
                if guard {
                    // the hooks already started are finished first: one that ran and blocked still decides, as below
                    let (slots, running): (Vec<usize>, Vec<node::Running>) = started.into_iter().unzip();
                    let mut done = results.clone();
                    for (i, f) in slots.iter().zip(node::finish(running)) {
                        if f.fate == node::Fate::Ran {
                            done[*i] = Some(f.result);
                        }
                    }
                    if let Some(o) = genuine_block(done) {
                        return o;
                    }
                    return closed(&args.event, parsed.as_ref(), &no_command(&e.id));
                }
                let note = defaults::render("dispatch.msg_skipped_entry", &[("id", &e.id)]);
                let stderr = defaults::render("dispatch.msg_skipped_entry_stderr", &[("event", &args.event), ("id", &e.id)]);
                health::log_event("dispatch_defer", &args.event, &note);
                pre_err.push_str(&stderr);
                pre_err.push('\n');
            }
            _ => started.push((i, start_node(e, raw.as_bytes(), payload))),
        }
    }
    let (slots, running): (Vec<usize>, Vec<node::Running>) = started.into_iter().unzip();
    let finished = node::finish(running);
    if guard {
        // a hook that could not run says nothing, and on a guard event nothing must not read as an allow (a timeout is
        // the host's own discard, so it stays one; it is logged by `node`). A hook that DID finish and block still
        // decides: its block is handed back verbatim, and the fail-closed counter is not touched.
        if let Some(bad) = finished.iter().find(|f| {
            matches!(f.fate, node::Fate::Spawn | node::Fate::Died | node::Fate::Incomplete)
                || (f.fate == node::Fate::Ran && node::module_resolution_error(&f.result))
        }) {
            let mut done: Vec<Option<combine::HookResult>> = results.clone();
            for (i, f) in slots.iter().zip(&finished) {
                if f.fate == node::Fate::Ran {
                    done[*i] = Some(f.result.clone());
                }
            }
            if let Some(o) = genuine_block(done) {
                return o;
            }
            if node::module_resolution_error(&bad.result) {
                return closed(&args.event, parsed.as_ref(), &no_command(&bad.result.id));
            }
            let key = match bad.fate {
                node::Fate::Spawn => "dispatch.msg_why_spawn",
                node::Fate::Died => "dispatch.msg_why_died",
                _ => "dispatch.msg_why_incomplete",
            };
            return closed(&args.event, parsed.as_ref(), &defaults::render(key, &[("id", &bad.result.id)]));
        }
    }
    for (i, f) in slots.into_iter().zip(finished) {
        results[i] = Some(f.result);
    }
    let results: Vec<combine::HookResult> = results.into_iter().flatten().collect();
    stoploop::reset(&args.event, parsed.as_ref()); // every hook ran: a run of fail-closed blocks is over
    match combine::combine(&results) {
        combine::Combined::Answer(mut o) => {
            o.err = format!("{}{}", pre_err, o.err);
            // Only a plain answer can be handed back: an exit code, a block or a decision cannot be re-run by a wrapper
            // that does not exist yet, and exit 75 would lose it. A guard event therefore never gets 75 (its decisions
            // are delivered, the host spills the over-cap context itself).
            let plain = o.code == 0 && !results.iter().any(|r| r.code.is_some() && combine::json_blocks(&r.out));
            let Some((len, cap)) = over_cap(args, &results, &o.out).filter(|_| plain) else { return o };
            let _ = crate::limits::ensure_private_dir(&crate::paths::dir());
            health::log_event("dispatch_context_over_cap", &args.event, &defaults::render("dispatch.msg_context_over_cap", &[("len", &len), ("cap", &cap)]));
            if guard {
                return combine::sequential(&results, &args.event);
            }
            let err = format!("{}{}", pre_err, defaults::render("dispatch.msg_defer_separately", &[("event", &args.event), ("len", &len), ("cap", &cap)]));
            Outcome { out: String::new(), code: defaults::num("dispatch.defer_exit") as i32, err: format!("{err}\n") }
        }
        combine::Combined::Conflict(ids) => {
            let _ = crate::limits::ensure_private_dir(&crate::paths::dir());
            health::log_event("dispatch_conflict", &args.event, &defaults::render("dispatch.msg_conflict", &[("ids", &ids.join(","))]));
            let mut o = combine::sequential(&results, &args.event);
            o.err = format!("{}{}", pre_err, o.err);
            o
        }
    }
}

/// `ah-engine hook --event ...`: read stdin, dispatch, print, exit with the combined code. Never panics out, and never
/// turns a failure into an allow for a guard event: a usage error or a panic there answers exit 2 like [`fail_closed`].
pub fn hook_main(args: &[String]) -> i32 {
    let event = flag(args, "--event").unwrap_or_default();
    let guard = guarded(&event);
    let res = std::panic::catch_unwind(|| {
        sweep_stale_spool();
        let mut a = match parse_args(args) {
            Ok(a) => a,
            Err(e) if guard => {
                let o = fail_closed(&event, &e.to_string());
                let _ = std::io::stderr().write_all(o.err.as_bytes());
                return o.code;
            }
            Err(e) => {
                let _ = writeln!(std::io::stderr(), "{e}");
                return 64; // a usage error: the host reports it as a non-blocking hook error
            }
        };
        let max = defaults::num("client.max_stdin");
        let payload = match PayloadInput::read_stdin(max) {
            Ok(p) => p,
            Err(e) if guard => {
                let why = defaults::render("msg.dispatch_stdin_spool", &[("err", &e)]);
                let o = fail_closed(&event, &why);
                let _ = std::io::stderr().write_all(o.err.as_bytes());
                return o.code;
            }
            Err(e) => {
                let note = defaults::render("msg.dispatch_stdin_spool_note", &[("event", &event), ("err", &e)]);
                health::log_event_or_stderr("dispatch_spool_unavailable", &event, &note);
                let _ = writeln!(std::io::stderr(), "{note}");
                return 0;
            }
        };
        let over_cap = payload.over_cap();
        let raw_bytes = payload.bytes_for_engine(max);
        let utf8 = std::str::from_utf8(raw_bytes);
        if guard && !over_cap && utf8.is_err() {
            let lossy_stop = stoploop::is_stop_event(&a.event).then(|| serde_json::from_str::<Value>(&String::from_utf8_lossy(raw_bytes)).ok()).flatten();
            let o = closed(&a.event, lossy_stop.as_ref(), defaults::text("msg.dispatch_stdin_utf8"));
            let _ = std::io::stderr().write_all(o.err.as_bytes());
            return o.code;
        }
        if over_cap {
            health::log_event("dispatch_stdin_spooled", &a.event, &defaults::render("dispatch.msg_stdin_over_cap", &[("max", &max)]));
        }
        if over_cap
            && a.tool.is_none()
            && guarded(&a.event)
            && defaults::raw("dispatch.matcher_field").get(&a.event).and_then(|v| v.as_str()) == Some("tool_name")
            && let Some(tool) = payload.structural_tool_name()
        {
            a.tool = Some(tool);
        }
        // Non-guard events cannot block; keep matching Node's replacement-character decode there.
        let raw = String::from_utf8_lossy(raw_bytes).to_string();
        let o = run_inner(&raw, &a, payload.file.as_ref(), !over_cap && utf8.is_ok());
        let _ = std::io::stderr().write_all(o.err.as_bytes());
        let mut so = std::io::stdout();
        let _ = so.write_all(o.out.as_bytes());
        let _ = so.flush();
        o.code
    });
    res.unwrap_or_else(|_| {
        if !guard {
            return 0;
        }
        let o = fail_closed(&event, defaults::text("dispatch.msg_panic"));
        let _ = std::io::stderr().write_all(o.err.as_bytes());
        o.code
    })
}
