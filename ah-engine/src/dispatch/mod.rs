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
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an absent field is the empty value
// - text that does not parse or decode is the absent value (Node Number()/JSON.parse catch parity)
// - an unreadable optional file is the same as an absent one (fail-open, as Node's try/catch)
// A failure that must be seen goes through `crate::discard` instead.

pub mod combine;
pub mod inject;
pub mod native;
pub mod node;
pub mod plan;
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
        let chunk_len = defaults::num("io.chunk_bytes") as usize;
        let mut raw = Vec::with_capacity(keep.min(chunk_len));
        let mut file: Option<File> = None;
        let mut stdin = std::io::stdin().lock();
        let mut chunk = vec![0u8; chunk_len];
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
            crate::discard::harmless(f.sync_all()); // keep: a spool file on its way out; durability is best effort
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
    let mut buf = vec![0u8; defaults::num("io.chunk_bytes") as usize];
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
    crate::discard::harmless(crate::limits::ensure_private_dir(&crate::paths::dir())); // keep: a failure surfaces at the next create in that directory
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

/// The genuine blocks among the results that did run (exit 2, or a JSON block) as one answer: one block verbatim, several as
/// one block that carries every reason ([`combine::combine`]).
fn genuine_block(done: Vec<Option<combine::HookResult>>) -> Option<Outcome> {
    let blockers: Vec<combine::HookResult> = done.into_iter().flatten().filter(combine::blocks).collect();
    if blockers.is_empty() {
        return None;
    }
    match combine::combine(&blockers) {
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

/// [`start_node`] for a hook that runs for `event`, so its telemetry event says which.
fn start_node_for(e: &table::Entry, event: &str, raw: &[u8], payload: Option<&File>) -> node::Running {
    start_node(e, raw, payload).for_event(event)
}

fn run_inner(raw: &str, args: &Args, payload: Option<&File>, complete: bool) -> Outcome {
    let mut tele = plan::Tele::default();
    let o = run_core(raw, args, payload, complete, &mut tele);
    crate::telemetry::emit::flush(); // the Node hooks' telemetry events of this call, in one append
    if tele.notable() {
        crate::discard::harmless(crate::limits::ensure_private_dir(&crate::paths::dir())); // keep: a failure surfaces at the next create in that directory
        health::log_event("dispatch_plan", &args.event, &tele.detail());
    }
    o
}

/// Retain the entries (and their shadow flags) `keep` accepts.
fn retain_both(entries: &mut Vec<table::Entry>, shadow: &mut Vec<bool>, mut keep: impl FnMut(&table::Entry, bool) -> bool) {
    let mask: Vec<bool> = entries.iter().zip(shadow.iter()).map(|(e, s)| keep(e, *s)).collect();
    let mut it = mask.iter();
    entries.retain(|_| *it.next().unwrap_or(&true));
    let mut it = mask.iter();
    shadow.retain(|_| *it.next().unwrap_or(&true));
}

/// The answer for an event without a usable table row: `None` when the row has entries; the neutral no-op when the
/// fallback list marks the event as a thin trigger (exactly what the wrapper would answer); otherwise `dispatch.defer_exit`,
/// so the Node hooks run. Never an allow the wrapper would not give.
fn unlisted(host: &str, event: &str) -> Option<Outcome> {
    match table::row(host, event) {
        table::Row::Entries(e) if !e.is_empty() => None,
        table::Row::Entries(_) | table::Row::Missing if table::trigger_only(host, event) => Some(Outcome { out: String::new(), code: 0, err: String::new() }),
        _ => {
            let why = defaults::render("dispatch.msg_no_row", &[("host", &host), ("event", &event)]);
            log_defer(event, &why);
            Some(Outcome { out: String::new(), code: defaults::num("dispatch.defer_exit") as i32, err: format!("{why}\n") })
        }
    }
}

fn run_core(raw: &str, args: &Args, payload: Option<&File>, complete: bool, tele: &mut plan::Tele) -> Outcome {
    if let Some(o) = unlisted(&args.host, &args.event) {
        return o;
    }
    let guard = guarded(&args.event);
    let parsed = complete.then(|| serde_json::from_str::<Value>(raw).ok()).flatten();
    let p = parsed.clone().unwrap_or(Value::Null);
    let mut pre_err = String::new();
    let entries = if guard {
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
    // D87: the hook configuration and the entries' predicates decide which of the matched entries run, and how
    let req_env = crate::reqenv::RequestEnv::capture();
    let facts = plan::LiveFacts::default();
    let cfg = plan::load_config(p.get("cwd").and_then(Value::as_str).unwrap_or(""));
    let occurrence = plan::Occurrence { payload: &p, tool: args.tool.as_deref(), env: &req_env, sessions: None, facts: &facts, payload_ok: parsed.is_some() };
    let dplan = plan::build(&args.event, entries, &cfg, &occurrence);
    tele.cfg_hash = dplan.cfg_hash.clone();
    tele.outcomes = dplan.outcomes();
    let budget = dplan.budget;
    if dplan.event_off || dplan.items.is_empty() {
        return Outcome { out: String::new(), code: 0, err: String::new() };
    }
    let (mut entries, mut shadow): (Vec<table::Entry>, Vec<bool>) = dplan.items.into_iter().map(|i| (i.entry, i.shadow)).unzip();
    if let Some(path) = &args.map {
        match table::FallbackMap::load(path) {
            Ok(m) => m.apply(&args.event, &mut entries),
            Err(e) if guard => return closed(&args.event, parsed.as_ref(), &e.to_string()),
            Err(e) => log_defer(&args.event, &e.to_string()),
        }
    }
    let no_command = |id: &str| defaults::render("dispatch.msg_no_fallback", &[("id", &id)]);
    if guard {
        if let Some(e) = entries.iter().zip(&shadow).find(|(e, sh)| !**sh && e.check.is_none() && !table::runnable(&e.command)).map(|(e, _)| e) {
            return closed(&args.event, parsed.as_ref(), &no_command(&e.id));
        }
    } else {
        retain_both(&mut entries, &mut shadow, |e, sh| {
            let ok = e.check.is_some() || table::runnable(&e.command);
            if !ok && sh {
                return false; // a shadowed entry that cannot run is only not measured
            }
            if !ok {
                let note = defaults::render("dispatch.msg_skipped_entry", &[("id", &e.id)]);
                let stderr = defaults::render("dispatch.msg_skipped_entry_stderr", &[("event", &args.event), ("id", &e.id)]);
                crate::discard::harmless(crate::limits::ensure_private_dir(&crate::paths::dir())); // keep: a failure surfaces at the next create in that directory
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
    // a guard entry's shadowed check runs beside the Node hook of the same id that decides: it is only measured
    let sibling: Vec<bool> =
        entries.iter().enumerate().map(|(i, e)| shadow[i] && entries.iter().enumerate().any(|(j, r)| j != i && !shadow[j] && r.id == e.id)).collect();
    // the Node hooks start first, so they run while the built-in checks are answered; once the event's budget has passed no
    // further entry starts (a guard event then fails closed after the ones already running have finished)
    let mut started: Vec<(usize, node::Running)> = Vec::new();
    for (i, e) in entries.iter().enumerate().filter(|(_, e)| e.check.is_none()) {
        if budget.exceeded() {
            if guard {
                let (slots, running): (Vec<usize>, Vec<node::Running>) = started.into_iter().unzip();
                let mut done: Vec<Option<combine::HookResult>> = vec![None; entries.len()];
                for (i, f) in slots.iter().zip(node::finish(running)) {
                    if f.fate == node::Fate::Ran && !shadow[*i] {
                        done[*i] = Some(f.result);
                    }
                }
                return genuine_block(done).unwrap_or_else(|| closed(&args.event, parsed.as_ref(), &defaults::render("hooks.msg_budget", &[("id", &e.id)])));
            }
            tele.mark(&e.id, plan::Outcome::SkippedBudget);
            continue;
        }
        started.push((i, start_node_for(e, &args.event, raw.as_bytes(), payload)));
    }
    let meta = Meta {
        host: args.host.clone(),
        event: args.event.clone(),
        tool: args.tool.clone(),
        root: table::plugin_root(&args.host),
        env: req_env.clone(),
        only: Some(entries.iter().filter(|e| e.check.is_some()).map(|e| e.id.clone()).collect()),
        plan: tele.outcomes.iter().map(|(id, o)| (id.clone(), o.word().to_string())).collect(),
        cfg: tele.cfg_hash.clone(),
        payload_sha1: {
            let wants = defaults::list("dispatch.payload_hash_checks");
            entries.iter().any(|e| e.check.as_deref().is_some_and(|c| wants.contains(&c))).then(|| crate::checks::emit_dedupe::sha1_hex(raw.as_bytes()))
        },
    };
    let answers = match (&parsed, complete) {
        // A payload serde_json cannot read falls back to Node (JS may still parse it, e.g. a lone surrogate escape): the
        // engine must not be a worse guard than Node (D74). Only a guard entry with no runnable Node command blocks.
        (_, false) | (None, _) => Vec::new(),
        (Some(_), _) if entries.iter().all(|e| e.check.is_none()) => Vec::new(),
        (Some(p), _) if defaults::num("dispatch.in_process") == 1 => native::evaluate(&meta, p, &|_, _, _| {}),
        (Some(_), _) => ask_daemon(&meta, raw).unwrap_or_default(),
    };
    let mut results: Vec<Option<combine::HookResult>> = vec![None; entries.len()];
    let mut shadow_results: Vec<Option<combine::HookResult>> = vec![None; entries.len()];
    for (i, e) in entries.iter().enumerate().filter(|(_, e)| e.check.is_some()) {
        match answers.iter().find(|(id, _)| *id == e.id) {
            Some((_, Answer::Decided(r, _))) if shadow[i] => shadow_results[i] = Some(r.clone()),
            Some((_, Answer::Decided(r, _))) => results[i] = Some(r.clone()),
            _ if sibling[i] => {} // the Node hook of the same id decides; the shadowed check just goes unmeasured
            _ if budget.exceeded() => {
                // the event's budget has passed: start nothing further (a guard event fails closed, as for a hook that cannot run)
                if guard {
                    let (slots, running): (Vec<usize>, Vec<node::Running>) = started.into_iter().unzip();
                    let mut done = results.clone();
                    for (i, f) in slots.iter().zip(node::finish(running)) {
                        if f.fate == node::Fate::Ran && !shadow[*i] {
                            done[*i] = Some(f.result);
                        }
                    }
                    if let Some(o) = genuine_block(done) {
                        return o;
                    }
                    return closed(&args.event, parsed.as_ref(), &defaults::render("hooks.msg_budget", &[("id", &e.id)]));
                }
                tele.mark(&e.id, plan::Outcome::SkippedBudget);
            }
            _ if !table::runnable(&e.command) => {
                if guard {
                    // the hooks already started are finished first: one that ran and blocked still decides, as below
                    let (slots, running): (Vec<usize>, Vec<node::Running>) = started.into_iter().unzip();
                    let mut done = results.clone();
                    for (i, f) in slots.iter().zip(node::finish(running)) {
                        if f.fate == node::Fate::Ran && !shadow[*i] {
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
            _ => started.push((i, start_node_for(e, &args.event, raw.as_bytes(), payload))),
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
                if f.fate == node::Fate::Ran && !shadow[*i] {
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
        if shadow[i] {
            shadow_results[i] = Some(f.result);
        } else {
            results[i] = Some(f.result);
        }
    }
    // a shadowed check is compared with the Node hook of the same id that decided; nothing shadowed is combined
    for (i, e) in entries.iter().enumerate().filter(|(i, _)| sibling[*i]) {
        let node_result = entries.iter().enumerate().find(|(j, r)| *j != i && !shadow[*j] && r.id == e.id).and_then(|(j, _)| results[j].as_ref());
        if let (Some(a), Some(b)) = (shadow_results[i].as_ref(), node_result) {
            let agree = a.code == b.code && a.out == b.out;
            let (engine, node) = (a.code.map_or(-1, i64::from), b.code.map_or(-1, i64::from));
            health::log_event(
                "dispatch_shadow",
                &args.event,
                &defaults::render("hooks.msg_shadow_event", &[("id", &e.id), ("agree", &agree), ("engine", &engine), ("node", &node)]),
            );
        }
    }
    let mut results: Vec<combine::HookResult> = results.into_iter().flatten().collect();
    if parsed.is_some() {
        inject::apply(&args.event, &p, &req_env, &mut results); // token cuts: pass on only what the model does not already hold
    }
    stoploop::reset(&args.event, parsed.as_ref()); // every hook ran: a run of fail-closed blocks is over
    let keep_advisories = defaults::list("dispatch.stop_events").iter().any(|e| *e == args.event);
    match combine::combine_for(&results, keep_advisories) {
        combine::Combined::Answer(mut o) => {
            o.err = format!("{}{}", pre_err, o.err);
            // Only a plain answer can be handed back: an exit code, a block or a decision cannot be re-run by a wrapper
            // that does not exist yet, and exit 75 would lose it. A guard event therefore never gets 75 (its decisions
            // are delivered, the host spills the over-cap context itself).
            let plain = o.code == 0 && !results.iter().any(|r| r.code.is_some() && combine::json_blocks(&r.out));
            let Some((len, cap)) = over_cap(args, &results, &o.out).filter(|_| plain) else { return o };
            crate::discard::harmless(crate::limits::ensure_private_dir(&crate::paths::dir())); // keep: a failure surfaces at the next create in that directory
            health::log_event("dispatch_context_over_cap", &args.event, &defaults::render("dispatch.msg_context_over_cap", &[("len", &len), ("cap", &cap)]));
            if guard {
                return combine::sequential(&results, &args.event);
            }
            let err = format!("{}{}", pre_err, defaults::render("dispatch.msg_defer_separately", &[("event", &args.event), ("len", &len), ("cap", &cap)]));
            Outcome { out: String::new(), code: defaults::num("dispatch.defer_exit") as i32, err: format!("{err}\n") }
        }
        combine::Combined::Conflict(ids) => {
            crate::discard::harmless(crate::limits::ensure_private_dir(&crate::paths::dir())); // keep: a failure surfaces at the next create in that directory
            health::log_event("dispatch_conflict", &args.event, &defaults::render("dispatch.msg_conflict", &[("ids", &ids.join(","))]));
            let mut o = combine::sequential(&results, &args.event);
            o.err = format!("{}{}", pre_err, o.err);
            o
        }
    }
}

/// Tell the wrapper (`AH_ENGINE_DONE_FILE`) that the event was dispatched and the exit code that follows is the answer, not an
/// engine failure: a hook's own non-zero exit (1, 3, ...) passes through, and must not be answered by running the hooks again.
fn mark_done() {
    if let Some(p) = defaults::env_var("done_file").filter(|p| !p.is_empty()) {
        crate::discard::logged("done_file_write", std::fs::write(p, b""));
    }
}

/// `ah-engine hook --event ...`: read stdin, dispatch, print, exit with the combined code. Never panics out, and never
/// turns a failure into an allow for a guard event: a usage error there answers exit 2 like [`fail_closed`], and a panic
/// hands the event to the Node hooks ([`on_panic`]).
pub fn hook_main(args: &[String]) -> i32 {
    let event = flag(args, "--event").unwrap_or_default();
    let guard = guarded(&event);
    let res = std::panic::catch_unwind(|| {
        sweep_stale_spool();
        let mut a = match parse_args(args) {
            Ok(a) => a,
            Err(e) if guard => {
                let o = fail_closed(&event, &e.to_string());
                crate::discard::harmless(std::io::stderr().write_all(o.err.as_bytes())); // keep: a closed pipe leaves nobody to tell
                return o.code;
            }
            Err(e) => {
                crate::discard::harmless(writeln!(std::io::stderr(), "{e}")); // keep: a closed pipe leaves nobody to tell
                return 64; // a usage error: the host reports it as a non-blocking hook error
            }
        };
        // D87: an event the table has no entry for (a thin trigger only) has nothing to run and nothing to guard, whatever its
        // payload looks like, even invalid UTF-8 or over the cap: answer the neutral no-op after letting the host finish writing
        // A missing or malformed row is a neutral no-op only when the wrapper's own list agrees; otherwise the Node hooks decide
        // (a lost row must never turn into an allow where the wrapper would run hooks).
        if let Some(o) = unlisted(&a.host, &a.event) {
            crate::discard::harmless(std::io::copy(&mut std::io::stdin().lock(), &mut std::io::sink())); // keep: a closed pipe leaves nobody to tell
            crate::discard::harmless(std::io::stderr().write_all(o.err.as_bytes())); // keep: a closed pipe leaves nobody to tell
            if o.code == 0 {
                mark_done();
            }
            return o.code;
        }
        let max = defaults::num("client.max_stdin");
        let payload = match PayloadInput::read_stdin(max) {
            Ok(p) => p,
            Err(e) if guard => {
                let why = defaults::render("msg.dispatch_stdin_spool", &[("err", &e)]);
                let o = fail_closed(&event, &why);
                crate::discard::harmless(std::io::stderr().write_all(o.err.as_bytes())); // keep: a closed pipe leaves nobody to tell
                return o.code;
            }
            Err(e) => {
                let note = defaults::render("msg.dispatch_stdin_spool_note", &[("event", &event), ("err", &e)]);
                health::log_event_or_stderr("dispatch_spool_unavailable", &event, &note);
                crate::discard::harmless(writeln!(std::io::stderr(), "{note}")); // keep: a closed pipe leaves nobody to tell
                return 0;
            }
        };
        let over_cap = payload.over_cap();
        let raw_bytes = payload.bytes_for_engine(max);
        let utf8 = std::str::from_utf8(raw_bytes);
        if guard && !over_cap && utf8.is_err() {
            let lossy_stop = stoploop::is_stop_event(&a.event).then(|| serde_json::from_str::<Value>(&String::from_utf8_lossy(raw_bytes)).ok()).flatten();
            let o = closed(&a.event, lossy_stop.as_ref(), defaults::text("msg.dispatch_stdin_utf8"));
            crate::discard::harmless(std::io::stderr().write_all(o.err.as_bytes())); // keep: a closed pipe leaves nobody to tell
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
        crate::discard::harmless(std::io::stderr().write_all(o.err.as_bytes())); // keep: a closed pipe leaves nobody to tell
        let mut so = std::io::stdout();
        crate::discard::harmless(so.write_all(o.out.as_bytes())); // keep: a closed pipe leaves nobody to tell
        crate::discard::harmless(so.flush()); // keep: a closed pipe leaves nobody to tell
        mark_done();
        o.code
    });
    res.unwrap_or_else(|_| {
        let o = on_panic(&event, guard);
        crate::discard::harmless(std::io::stderr().write_all(o.err.as_bytes())); // keep: a closed pipe leaves nobody to tell
        o.code
    })
}

/// The answer after a panic in [`hook_main`]: the engine cannot say what the hooks decide, so a guard event is handed to the
/// Node hooks (`dispatch.defer_exit`), never blocked (which locked the user out of tools) and never allowed. The defer code is
/// read under its own guard: when the panic came from the defaults themselves, the wrapper's fixed protocol code stands in.
fn on_panic(event: &str, guard: bool) -> Outcome {
    if !guard {
        return Outcome { out: String::new(), code: 0, err: String::new() };
    }
    let read = std::panic::catch_unwind(|| (defaults::num("dispatch.defer_exit") as i32, defaults::text("dispatch.msg_panic").to_string()));
    let (code, why) = read.unwrap_or_else(|_| (crate::bootstrap::UNAVAILABLE_EXIT, String::new()));
    if !why.is_empty() {
        crate::discard::harmless(std::panic::catch_unwind(|| log_defer(event, &why))); // keep: the deferral stands without its log line
    }
    Outcome { out: String::new(), code, err: if why.is_empty() { why } else { format!("{why}\n") } }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_panic_in_a_guard_event_defers_to_node_instead_of_blocking() {
        // review P1 #2: a panic went to fail_closed (exit 2), locking the user out of tools on a bug of the engine's own
        let o = on_panic("PreToolUse", true);
        assert_eq!(o.code, defaults::num("dispatch.defer_exit") as i32, "a guard-event panic must defer, not block: {o:?}");
        assert_ne!(o.code, 2);
        assert_eq!(on_panic("Notification", false).code, 0, "a non-guard event stays the neutral no-op");
    }
}
