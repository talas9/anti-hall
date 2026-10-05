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
use std::io::{Read, Write};
use std::path::PathBuf;

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
    Outcome { out: String::new(), code: 2, err: format!("{}\n", defaults::render("dispatch.msg_fail_closed", &[("event", &event), ("why", &why)])) }
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
    let guard = guarded(&args.event);
    let parsed = serde_json::from_str::<Value>(raw).ok();
    let p = parsed.clone().unwrap_or(Value::Null);
    let mut entries = if guard {
        table::select_guarded(&args.host, &args.event, &p, args.tool.as_deref())
    } else {
        table::select(&args.host, &args.event, &p, args.tool.as_deref())
    };
    if entries.is_empty() {
        stoploop::reset(&args.event, parsed.as_ref());
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
                health::log_event("dispatch_defer", &args.event, &defaults::render("dispatch.msg_skipped_entry", &[("id", &e.id)]));
            }
            ok
        });
    }
    // the Node hooks start first, so they run while the built-in checks are answered
    let mut started: Vec<(usize, node::Running)> =
        entries.iter().enumerate().filter(|(_, e)| e.check.is_none()).map(|(i, e)| (i, node::start(e, raw.as_bytes()))).collect();
    let meta = Meta {
        host: args.host.clone(),
        event: args.event.clone(),
        tool: args.tool.clone(),
        root: table::plugin_root(&args.host),
        env: crate::reqenv::RequestEnv::capture(),
    };
    let answers = match &parsed {
        // a payload serde_json cannot read (JS may): every check defers, Node decides
        None => Vec::new(),
        Some(_) if entries.iter().all(|e| e.check.is_none()) => Vec::new(),
        Some(p) if defaults::num("dispatch.in_process") == 1 => native::evaluate(&meta, p, &|_, _, _| {}),
        Some(_) => ask_daemon(&meta, raw).unwrap_or_default(),
    };
    let mut results: Vec<Option<combine::HookResult>> = vec![None; entries.len()];
    for (i, e) in entries.iter().enumerate().filter(|(_, e)| e.check.is_some()) {
        match answers.iter().find(|(id, _)| *id == e.id) {
            Some((_, Answer::Decided(r))) => results[i] = Some(r.clone()),
            _ if !table::runnable(&e.command) => {
                if guard {
                    let _ = node::finish(started.into_iter().map(|(_, r)| r).collect());
                    return closed(&args.event, parsed.as_ref(), &no_command(&e.id));
                }
                health::log_event("dispatch_defer", &args.event, &defaults::render("dispatch.msg_skipped_entry", &[("id", &e.id)]));
            }
            _ => started.push((i, node::start(e, raw.as_bytes()))),
        }
    }
    let (slots, running): (Vec<usize>, Vec<node::Running>) = started.into_iter().unzip();
    let finished = node::finish(running);
    if guard {
        // a hook that could not run says nothing, and on a guard event nothing must not read as an allow (a timeout is
        // the host's own discard, so it stays one; it is logged by `node`). A hook that DID finish and block still
        // decides: its block is handed back verbatim, and the fail-closed counter is not touched.
        if let Some(bad) = finished.iter().find(|f| matches!(f.fate, node::Fate::Spawn | node::Fate::Died | node::Fate::Incomplete)) {
            let mut done: Vec<Option<combine::HookResult>> = results.clone();
            for (i, f) in slots.iter().zip(&finished) {
                if f.fate == node::Fate::Ran {
                    done[*i] = Some(f.result.clone());
                }
            }
            let done: Vec<combine::HookResult> = done.into_iter().flatten().collect();
            if let Some(b) = done.iter().find(|r| r.code == Some(2)).or_else(|| done.iter().find(|r| r.code.is_some() && combine::json_blocks(&r.out))) {
                if let combine::Combined::Answer(o) = combine::combine(std::slice::from_ref(b)) {
                    return o;
                }
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
        combine::Combined::Answer(o) => {
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
            let err = defaults::render("dispatch.msg_defer_separately", &[("event", &args.event), ("len", &len), ("cap", &cap)]);
            Outcome { out: String::new(), code: defaults::num("dispatch.defer_exit") as i32, err: format!("{err}\n") }
        }
        combine::Combined::Conflict(ids) => {
            let _ = crate::limits::ensure_private_dir(&crate::paths::dir());
            health::log_event("dispatch_conflict", &args.event, &defaults::render("dispatch.msg_conflict", &[("ids", &ids.join(","))]));
            combine::sequential(&results, &args.event)
        }
    }
}

/// `ah-engine hook --event ...`: read stdin, dispatch, print, exit with the combined code. Never panics out, and never
/// turns a failure into an allow for a guard event: a usage error or a panic there answers exit 2 like [`fail_closed`].
pub fn hook_main(args: &[String]) -> i32 {
    let event = flag(args, "--event").unwrap_or_default();
    let guard = guarded(&event);
    let res = std::panic::catch_unwind(|| {
        let a = match parse_args(args) {
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
        // one byte more than the cap tells a payload that fits from one that was cut off
        let max = defaults::num("client.max_stdin");
        let mut bytes = Vec::new();
        let read = std::io::stdin().take(max + 1).read_to_end(&mut bytes);
        let cut = bytes.len() as u64 > max;
        if guard {
            // a payload the dispatcher does not hold whole cannot be routed or checked: block, never allow unguarded
            let failure = match &read {
                Err(e) => Some(defaults::render("dispatch.msg_stdin_read", &[("err", &e)])),
                Ok(_) if cut => Some(defaults::render("dispatch.msg_stdin_truncated", &[("max", &max)])),
                Ok(_) => None,
            };
            if let Some(why) = failure {
                let o = fail_closed(&a.event, &why);
                let _ = std::io::stderr().write_all(o.err.as_bytes());
                return o.code;
            }
        }
        bytes.truncate(max as usize);
        // JS decodes invalid UTF-8 with U+FFFD, as this does, so a Node hook and the checks read the same text
        let raw = String::from_utf8_lossy(&bytes).to_string();
        let o = run(&raw, &a);
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
