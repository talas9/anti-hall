//! The injection gate (token cuts): what the hooks that re-send the same context every turn printed, passed on only when the
//! model does not already hold it.
//!
//! The Node hooks run unchanged and keep their own state. After they have finished, the dispatcher reads their output here and,
//! per session (and per agent: a subagent has its own context), asks the gate (`crate::gate`, in the daemon) one question per
//! block: first time, changed, or its keepalive turn has come means pass it on, anything else means drop it. A `SessionStart`
//! dispatch clears the session, because the context may be gone (start, resume, clear, compaction), so the first block after
//! it is whole again.
//!
//! Four cuts, each behind its own setting (`context.injectGate*`, see the plugin's `engine/defaults/inject_gate.toml`):
//!
//! 1. `limit`: `limit-conserve-inject` reprinted its directive every turn because the reset time it quotes jitters by
//!    milliseconds between readings, which defeated Node's own dedupe. The hash sees that time rounded to the minute, so the
//!    directive is passed on when the usage band (which buckets trip) or the reset window changes, else as a short keepalive.
//! 2. `task`: `task-tracker`'s short reminder is passed on every N turns (its long form always, which restarts the count), its
//!    freshness note when it changed.
//! 3. `comms`: the static DevSwarm comms-override line and the workspace-title instruction, once per session and as keepalive.
//! 4. `swarm`: `swarm-guard`'s shared-tree advisory, when new or changed, again only after N turns.
//!
//! With a cut off, the hook's bytes go through untouched. The gate fails open everywhere: no daemon, a busy daemon, an output
//! that is not the expected JSON, a session without an id, all pass the Node output on as it is.
use super::combine::{HookResult, Ordered, parse_object};
use crate::checks::git::util::Settings;
use crate::checks::guardkit::settings::{get_bool, get_number};
use crate::defaults;
use crate::gate::{Decision, Query};
use crate::reqenv::RequestEnv;
use serde_json::Value;

/// One piece of an `additionalContext`: the separator that precedes it, its text, and the question to ask about it (none: it
/// passes as it is).
struct Part {
    sep: String,
    text: String,
    gate: Option<(Query, Option<String>)>,
}

fn fingerprint(s: &str) -> String {
    let h = crate::checks::emit_dedupe::sha1_hex(s.as_bytes());
    h.chars().take(defaults::num("inject_gate.hash_chars") as usize).collect()
}

/// `s` with every ISO timestamp replaced by its minute number, so a reset time whose milliseconds jitter hashes the same.
fn round_times(s: &str) -> String {
    // a pattern that does not compile leaves the text as it is: the gate then only treats a literally repeated block as
    // unchanged. Compiled once per defaults snapshot, so an edit of the setting applies on reload.
    static RE: defaults::Cache<Option<regex::Regex>> = defaults::Cache::new();
    let Some(re) = RE.get_or_init(|| regex::Regex::new(defaults::text("inject_gate.iso_re")).ok()) else { return s.to_string() };
    re.replace_all(s, |c: &regex::Captures| match crate::checks::ctxbudget::limit::iso_ms(&c[0]) {
        Some(ms) => format!("@{}", (ms / 60_000.0).round() as i64),
        None => c[0].to_string(),
    })
    .into_owned()
}

fn query(slot: &str, cut: &str, text: &str, normalized: &str, every: u64, keep: Option<&str>, force: bool) -> (Query, Option<String>) {
    let q = Query {
        slot: slot.to_string(),
        cut: cut.to_string(),
        hash: fingerprint(normalized),
        len: text.len(),
        keep_len: keep.map_or(text.len(), str::len),
        every,
        force,
    };
    (q, keep.map(str::to_string))
}

/// The settings of the four cuts, resolved once per dispatch.
struct Cuts {
    limit: Option<u64>,
    task: Option<u64>,
    comms: Option<u64>,
    swarm: Option<u64>,
}

impl Cuts {
    fn read(st: &Settings) -> Option<Cuts> {
        if !get_bool(st, defaults::raw("inject_gate.sw_master")) {
            return None;
        }
        let cut = |sw: &str, every: &str| get_bool(st, defaults::raw(sw)).then(|| get_number(st, defaults::raw(every)).max(1.0) as u64);
        let c = Cuts {
            limit: cut("inject_gate.sw_limit", "inject_gate.num_limit_every"),
            task: cut("inject_gate.sw_task", "inject_gate.num_task_every"),
            comms: cut("inject_gate.sw_comms", "inject_gate.num_comms_every"),
            swarm: cut("inject_gate.sw_swarm", "inject_gate.num_swarm_every"),
        };
        (c.limit.is_some() || c.task.is_some() || c.comms.is_some() || c.swarm.is_some()).then_some(c)
    }
}

/// How the parts of `ctx` (the additionalContext of the hook entry `id`) are gated; empty when none is.
fn parts_of(id: &str, ctx: &str, cuts: &Cuts) -> Vec<Part> {
    let sep = defaults::text("inject_gate.segment_sep");
    let whole = |text: &str, gate: Option<(Query, Option<String>)>| vec![Part { sep: String::new(), text: text.to_string(), gate }];
    if id == defaults::text("inject_gate.limit_hook") {
        let Some(every) = cuts.limit else { return Vec::new() };
        let keep = defaults::text("inject_gate.limit_keepalive");
        return whole(ctx, Some(query("limit", defaults::text("inject_gate.cut_limit"), ctx, &round_times(ctx), every, Some(keep), false)));
    }
    if defaults::list("inject_gate.swarm_hooks").contains(&id) {
        let Some(every) = cuts.swarm else { return Vec::new() };
        if !ctx.contains(defaults::text("inject_gate.swarm_marker")) {
            return Vec::new();
        }
        return whole(ctx, Some(query("shared-tree", defaults::text("inject_gate.cut_swarm"), ctx, &round_times(ctx), every, None, false)));
    }
    if defaults::list("inject_gate.comms_hooks").contains(&id) {
        let Some(every) = cuts.comms else { return Vec::new() };
        let markers = defaults::list("inject_gate.comms_markers");
        let mut parts: Vec<Part> = Vec::new();
        let mut any = false;
        for (i, seg) in ctx.split(sep).enumerate() {
            let gate = markers
                .iter()
                .position(|m| seg.starts_with(m))
                .map(|k| query(&format!("comms-{k}"), defaults::text("inject_gate.cut_comms"), seg, seg, every, None, false));
            any |= gate.is_some();
            parts.push(Part { sep: if i == 0 { String::new() } else { sep.to_string() }, text: seg.to_string(), gate });
        }
        return if any { parts } else { Vec::new() };
    }
    if id == defaults::text("inject_gate.task_hook") {
        let Some(every) = cuts.task else { return Vec::new() };
        let cut = defaults::text("inject_gate.cut_task");
        // the hook joins the reminder and the DevSwarm Primary block with a blank line; only the reminder is gated
        let (first, tail) = ctx.split_once(sep).map_or((ctx, None), |(a, b)| (a, Some(b)));
        let mut parts: Vec<Part> = Vec::new();
        let short = defaults::text("inject_gate.task_short");
        if first.starts_with(defaults::text("inject_gate.task_long_prefix")) {
            // the long form always passes and restarts the short reminder's count
            parts.push(Part { sep: String::new(), text: first.to_string(), gate: Some(query("task-head", cut, first, "head", every, None, true)) });
        } else if let Some(rest) = first.strip_prefix(short) {
            parts.push(Part { sep: String::new(), text: short.to_string(), gate: Some(query("task-head", cut, short, "head", every, None, false)) });
            let note_sep = defaults::text("inject_gate.note_sep");
            let note = rest.strip_prefix(note_sep).unwrap_or(rest);
            if !note.is_empty() {
                parts.push(Part {
                    sep: note_sep.to_string(),
                    text: note.to_string(),
                    gate: Some(query("task-note", cut, note, &round_times(note), every, None, false)),
                });
            }
        } else {
            return Vec::new();
        }
        if let Some(t) = tail {
            parts.push(Part { sep: sep.to_string(), text: t.to_string(), gate: None });
        }
        return parts;
    }
    Vec::new()
}

/// The answers of the gate for one session's batch of questions, in order. A gate that cannot answer lets everything through.
fn ask(sid: &str, agent: &str, reset: bool, qs: &[Query]) -> Vec<Decision> {
    let all_emit = || vec![Decision::Emit; qs.len()];
    if defaults::num("dispatch.in_process") == 1 {
        let g = crate::gate::global();
        if reset {
            g.reset(sid);
        }
        return qs.iter().map(|q| g.decide(sid, agent, q)).collect();
    }
    let body = serde_json::json!({ "s": sid, "a": agent, "r": reset, "q": qs.iter().map(wire_query).collect::<Vec<_>>() });
    let req = format!("G {}\n{body}", crate::version());
    let cfg = crate::config::ClientConfig::from_env();
    let Some(reply) = crate::client::attempt(req.as_bytes(), &cfg, true) else { return all_emit() };
    match parse_reply(&reply) {
        Some(d) if d.len() == qs.len() => d,
        _ => all_emit(),
    }
}

/// A question as it goes to the daemon.
pub(crate) fn wire_query(q: &Query) -> Value {
    serde_json::json!({ "k": q.slot, "c": q.cut, "h": q.hash, "n": q.len, "kn": q.keep_len, "e": q.every, "f": q.force })
}

/// A question read back from the wire; `None` when it is malformed.
pub(crate) fn read_query(v: &Value) -> Option<Query> {
    Some(Query {
        slot: v.get("k")?.as_str()?.to_string(),
        cut: v.get("c")?.as_str()?.to_string(),
        hash: v.get("h")?.as_str()?.to_string(),
        len: v.get("n")?.as_u64()? as usize,
        keep_len: v.get("kn")?.as_u64()? as usize,
        every: v.get("e")?.as_u64()?,
        force: v.get("f")?.as_bool()?,
    })
}

/// The reply words of the daemon for a batch.
pub(crate) fn encode_reply(d: &[Decision]) -> String {
    let word = |d: &Decision| match d {
        Decision::Emit => defaults::text("inject_gate.reply_emit"),
        Decision::Suppress => defaults::text("inject_gate.reply_suppress"),
        Decision::Keepalive => defaults::text("inject_gate.reply_keepalive"),
    };
    Value::Array(d.iter().map(|d| Value::String(word(d).to_string())).collect()).to_string()
}

fn parse_reply(body: &str) -> Option<Vec<Decision>> {
    let words: Vec<String> = serde_json::from_str(body).ok()?;
    words
        .iter()
        .map(|w| match w.as_str() {
            x if x == defaults::text("inject_gate.reply_emit") => Some(Decision::Emit),
            x if x == defaults::text("inject_gate.reply_suppress") => Some(Decision::Suppress),
            x if x == defaults::text("inject_gate.reply_keepalive") => Some(Decision::Keepalive),
            _ => None,
        })
        .collect()
}

/// `out` with its `hookSpecificOutput.additionalContext` replaced, keys kept in the order the hook printed them. A context
/// cut to nothing is left out, not printed empty ([`super::combine::tidy`]).
fn with_context(out: &str, new: &str) -> Option<String> {
    let Ordered::Obj(mut top) = parse_object(out)? else { return None };
    let (_, hso) = top.iter_mut().find(|(k, _)| k == defaults::text("inject_gate.field_hso"))?;
    let Ordered::Obj(inner) = hso else { return None };
    let (_, c) = inner.iter_mut().find(|(k, _)| k == defaults::text("inject_gate.field_ctx"))?;
    *c = Ordered::Str(new.to_string());
    Some(super::combine::tidy(&format!("{}\n", Ordered::Obj(top).to_json())))
}

/// Gate the results of one dispatch in place.
pub fn apply(event: &str, p: &Value, env: &RequestEnv, results: &mut [HookResult]) {
    apply_with(event, p, env, results, &ask);
}

/// The gate as the dispatcher asks it: session, agent, whether to clear the session first, the questions.
type Decide<'a> = dyn Fn(&str, &str, bool, &[Query]) -> Vec<Decision> + 'a;

/// [`apply`] with the gate behind `decide` (session, agent, reset, questions): the daemon or this process in production.
fn apply_with(event: &str, p: &Value, env: &RequestEnv, results: &mut [HookResult], decide: &Decide) {
    let Some(sid) = p.get("session_id").and_then(Value::as_str).filter(|s| !s.is_empty()) else { return };
    let st = Settings::from_env(env);
    let Some(cuts) = Cuts::read(&st) else { return };
    let agent = p.get("agent_id").and_then(Value::as_str).unwrap_or("");
    let reset = event == defaults::text("inject_gate.start_event");
    // what each result would pass on, and the questions about it
    let mut plans: Vec<(usize, Vec<Part>)> = Vec::new();
    for (i, r) in results.iter().enumerate() {
        if r.code != Some(0) || r.out.is_empty() {
            continue;
        }
        let Some(ctx) = crate::dispatch::combine::context_of(&r.out).filter(|c| !c.is_empty()) else { continue };
        let parts = parts_of(&r.id, &ctx, &cuts);
        if !parts.is_empty() {
            plans.push((i, parts));
        }
    }
    let qs: Vec<Query> = plans.iter().flat_map(|(_, ps)| ps.iter().filter_map(|p| p.gate.as_ref().map(|(q, _)| q.clone()))).collect();
    if qs.is_empty() && !reset {
        return;
    }
    let decisions = decide(sid, agent, reset, &qs);
    let mut next = decisions.into_iter();
    for (i, parts) in plans {
        let mut ctx = String::new();
        for part in parts {
            let text = match &part.gate {
                None => Some(part.text),
                Some((_, keep)) => match next.next().unwrap_or(Decision::Emit) {
                    Decision::Emit => Some(part.text),
                    Decision::Suppress => None,
                    Decision::Keepalive => Some(keep.clone().unwrap_or(part.text)),
                },
            };
            if let Some(t) = text {
                if !ctx.is_empty() {
                    ctx.push_str(&part.sep);
                }
                ctx.push_str(&t);
            }
        }
        if let Some(out) = with_context(&results[i].out, &ctx) {
            // an unchanged context keeps the hook's own bytes
            if crate::dispatch::combine::context_of(&results[i].out).as_deref() != Some(ctx.as_str()) {
                results[i].out = out;
            }
        }
    }
}

#[cfg(test)]
mod tests;
