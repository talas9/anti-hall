//! `auto-handover` (UserPromptSubmit) and `auto-handover-pause-nag` (Stop): ports of `hooks/auto-handover.js` and
//! `hooks/auto-handover-pause-nag.js` with their libraries (`auto-handover-config.js`, `-state.js`, `-gate.js`, `-text.js`,
//! `handover-freshness.js`).
//!
//! The hooks share one per-session latch (`~/.anti-hall/auto-handover/<tag>.json`). It is written when the context first
//! crosses the threshold (the fire directive, on either hook), when it grows another step (a nag), when it drops back
//! below (a re-arm), when the feature is turned off with the latch set, and, once the session's handover file appears,
//! for the post-handover new-work gate. The engine reads and writes the very same file in the very same shape: an
//! insertion-ordered object (`Object.assign` keeps the old keys where they were and appends the new ones), written through
//! a temporary file and a rename as Node's `writeLatch` does. The inferred one-million-token window file of the context
//! reading is written where `getContextPct` writes it.
//!
//! Every write is collected while deciding and done at the end, so a case that must defer (below) defers before anything
//! is written. Still deferred, each for a stated reason:
//! - the post-handover gate on a prompt with text: Node consults the `postHandoverGate` Jev integration there, which logs a
//!   decision row (and, outside mode off, spawns a detached worker); the row names the Node process's own working directory,
//!   which the engine cannot know, and the engine never starts a background process;
//! - a latch, transcript line or state file only JavaScript's parser accepts, a relative path or working directory (Node
//!   resolves it against its own directory), a local date in a time zone the engine does not share, a repository root the
//!   port cannot settle, a tool call whose file path is relative (work detection), a date only V8's lenient parser reads;
//! - a value whose JavaScript string form is not reproduced (an object as a session id or task id, a non-number fired
//!   percent that `+` would concatenate), and a latch with a `__proto__` key (`Object.assign` would not copy it).
use super::pct::{Pct, Reading, context_pct, parse_line, write_inferred};
use super::setting::{Sv, get, js_parse_int};
use super::text;
use super::{hazard, is_objectish, judge_child, now_ms, settings_of, subagent_by_payload, ups_empty};
use crate::checks::Verdict;
use crate::checks::emit_dedupe::sha1_hex;
use crate::checks::git::util::Settings;
use crate::checks::guardkit::jsval::Js;
use crate::checks::guardkit::settings::is_skipped;
use crate::checks::guardkit::text::{is_js_space, js_trim};
use crate::checks::jsport::date::{self, Parsed, ZoneGuard};
use crate::checks::replykit::json::quote;
use crate::checks::taskkit::workdetect::{Ctx, is_counted_work, tmpdir};
use crate::checks::taskstate::parse::collect_tool_uses;
use crate::defaults;
use crate::reqenv::RequestEnv;
use serde_json::Value;

/// The effective auto-handover settings (`hooks/lib/auto-handover-config.js` `resolveEffective`).
struct Eff {
    enabled: bool,
    pct: f64,
    max_tokens: f64,
    nag: bool,
    nag_step: f64,
    nag_quiet: f64,
    gate_new_work: bool,
    gate_budget: f64,
    decisive: bool,
    markers: Vec<String>,
}

fn resolve(st: &Settings) -> Eff {
    let off = Eff {
        enabled: false,
        pct: 0.0,
        max_tokens: 0.0,
        nag: false,
        nag_step: 0.0,
        nag_quiet: 0.0,
        gate_new_work: false,
        gate_budget: 0.0,
        decisive: false,
        markers: Vec::new(),
    };
    // the one rule the settings schema cannot express: the percent variable set to 0 disables the feature outright
    if let Some(raw) = st.env.get(defaults::text("ctxbudget.env_pct_off"))
        && !js_trim(raw).is_empty()
        && js_parse_int(raw) == Some(0.0)
    {
        return off;
    }
    if !get(st, defaults::raw("ctxbudget.set_ah_enabled")).flag() {
        return off;
    }
    let markers = match get(st, defaults::raw("ctxbudget.set_ah_markers")) {
        Sv::Str(s) => s
            .split(|c: char| defaults::list("ctxbudget.ah_marker_seps").iter().any(|d| d.starts_with(c)))
            .map(js_trim)
            .filter(|m| !m.is_empty())
            .map(str::to_string)
            .collect(),
        _ => Vec::new(),
    };
    Eff {
        enabled: true,
        pct: get(st, defaults::raw("ctxbudget.set_ah_pct")).num(),
        max_tokens: get(st, defaults::raw("ctxbudget.set_ah_max_tokens")).num().floor(),
        nag: get(st, defaults::raw("ctxbudget.set_ah_nag")).flag(),
        nag_step: get(st, defaults::raw("ctxbudget.set_ah_nag_step")).num(),
        nag_quiet: get(st, defaults::raw("ctxbudget.set_ah_nag_quiet")).num(),
        gate_new_work: get(st, defaults::raw("ctxbudget.set_ah_gate")).flag(),
        gate_budget: get(st, defaults::raw("ctxbudget.set_ah_gate_budget")).num(),
        decisive: get(st, defaults::raw("ctxbudget.set_ah_decisive")).flag(),
        markers,
    }
}

/// What `overThreshold` found.
#[derive(Debug, PartialEq, Clone, Copy)]
enum Over {
    /// The percent is over the threshold against a known window.
    Pct,
    /// The absolute token count is over its ceiling.
    Tokens,
    /// The percent is over the threshold against a guessed window.
    PctUnknownWindow,
}

impl Over {
    /// The `firedVia` word of a mandatory fire.
    fn via(self) -> &'static str {
        defaults::text(if self == Over::Tokens { "ctxbudget.ah_via_tokens" } else { "ctxbudget.ah_via_pct" })
    }
}

/// `overThreshold(result, cfg)`.
fn over_threshold(r: &Reading, eff: &Eff) -> Option<Over> {
    if !eff.enabled {
        return None;
    }
    let by_pct = r.pct.is_finite() && r.pct >= eff.pct;
    let by_tokens = eff.max_tokens > 0.0 && r.used.is_some_and(|u| u.is_finite() && u >= eff.max_tokens);
    if by_pct && r.window_known {
        Some(Over::Pct)
    } else if by_tokens {
        Some(Over::Tokens)
    } else if by_pct {
        Some(Over::PctUnknownWindow)
    } else {
        None
    }
}

// ---- the latch ---------------------------------------------------------------------------------------------------

/// A JavaScript truthiness test.
fn truthy(v: Option<&Js>) -> bool {
    match v {
        None | Some(Js::Null) => false,
        Some(Js::Bool(b)) => *b,
        Some(Js::Num(n)) => *n != 0.0 && !n.is_nan(),
        Some(Js::Str(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// A finite number field (`Number.isFinite(latch.x)`).
fn fin(l: &Js, key: &str) -> Option<f64> {
    l.get(key).and_then(Js::as_f64).filter(|f| f.is_finite())
}

fn fired(l: &Js) -> bool {
    l.get("fired") == Some(&Js::Bool(true))
}

fn obj(fields: Vec<(&str, Js)>) -> Js {
    Js::Obj(fields.into_iter().map(|(k, v)| (k.to_string(), v)).collect())
}

fn remove(l: &mut Js, key: &str) {
    if let Js::Obj(v) = l {
        v.retain(|(k, _)| k != key);
    }
}

/// `sessionTag(payload)`: the sanitized session id, else the first 16 hex digits of the transcript path's SHA-1.
pub(crate) fn session_tag(p: &Value) -> Option<String> {
    if let Some(t) = super::pct::tag_of(p.get("session_id")) {
        return Some(t);
    }
    let tp = p.get("transcript_path").and_then(Value::as_str).filter(|s| !s.is_empty())?;
    Some(sha1_hex(tp.as_bytes())[..defaults::num("ctxbudget.ah_hash_tag_len") as usize].to_string())
}

fn latch_path(st: &Settings, tag: &str) -> String {
    format!("{}/{}/{}/{tag}.json", st.home, defaults::text("ctxbudget.state_root"), defaults::text("ctxbudget.latch_dir"))
}

/// `readLatch(home, tag)`: the JSON object of the session's file, else an empty one. `Err` when the text needs the Node
/// parser, or holds a top-level `__proto__` key (which `Object.assign` would not copy).
pub(crate) fn read_latch(st: &Settings, tag: &str) -> Result<Js, ()> {
    let Ok(bytes) = std::fs::read(latch_path(st, tag)) else { return Ok(Js::Obj(Vec::new())) };
    let text = String::from_utf8_lossy(&bytes);
    match Js::parse(&text) {
        Some(Js::Obj(v)) if v.iter().any(|(k, _)| k == defaults::text("ctxbudget.ah_proto_key")) => Err(()),
        Some(o @ Js::Obj(_)) => Ok(o),
        Some(_) => Ok(Js::Obj(Vec::new())),
        None if hazard(&text) => Err(()),
        None => Ok(Js::Obj(Vec::new())),
    }
}

/// What a decision leaves behind: the latch to write and whether the inferred window is recorded.
#[derive(Default)]
struct Writes {
    latch: Option<Js>,
    inferred: bool,
}

impl Writes {
    /// Write everything (best effort, as Node: a failed write never changes the answer).
    fn commit(self, st: &Settings, p: &Value, tag: &str) {
        if self.inferred {
            write_inferred(st, p.get("session_id"));
        }
        if let Some(l) = self.latch
            && crate::checks::guardkit::fsio::write_atomic(&latch_path(st, tag), &l.stringify()).is_err()
        {
            crate::discard::note("ctxbudget_latch_write", "");
        }
    }
}

// ---- shared gates ------------------------------------------------------------------------------------------------

/// The checks every case starts with: not a judge child, an object payload, not a subagent, not skipped.
enum Gate {
    /// Nothing to do: answer with the quiet verdict.
    Quiet,
    /// The Node hook decides.
    Defer,
    /// Go on, with the request's settings.
    Go(Settings),
}

fn gate(p: &Value, env: &RequestEnv, stop: bool) -> Gate {
    if judge_child(env) || !is_objectish(p) || subagent_by_payload(p) {
        return Gate::Quiet;
    }
    if stop && p.get("stop_hook_active") == Some(&Value::Bool(true)) {
        return Gate::Quiet;
    }
    let Some(st) = settings_of(env) else { return Gate::Defer };
    if is_skipped(&st, defaults::text("ctxbudget.skip_auto_handover")) { Gate::Quiet } else { Gate::Go(st) }
}

/// The transcript path of a payload (`typeof payload.transcript_path === 'string'`).
fn transcript_of(p: &Value) -> Option<&str> {
    p.get("transcript_path").and_then(Value::as_str)
}

fn ups_text(text: &str) -> Verdict {
    if text.is_empty() {
        return ups_empty();
    }
    Verdict::Exact(crate::checks::Exact {
        code: 0,
        out: crate::checks::guardkit::msg::render("ctxbudget.ups_line", &[("text", &quote(text))]),
        err: String::new(),
    })
}

fn stop_block(reason: &str) -> Verdict {
    Verdict::Exact(crate::checks::Exact {
        code: 0,
        out: crate::checks::guardkit::msg::render("ctxbudget.stop_block_line", &[("reason", &quote(reason))]),
        err: String::new(),
    })
}

// ---- the post-handover gate (hooks/lib/auto-handover-gate.js) ----------------------------------------------------

/// `noteHandover(latch, payload, pct, now)`: the latch with this session's newest handover recorded, when it is new.
fn note_handover(l: &Js, p: &Value, pct: f64, now: f64, st: &Settings, env: &RequestEnv) -> Result<Option<Js>, ()> {
    if !fired(l) || !pct.is_finite() {
        return Ok(None);
    }
    let Some((file, mtime)) = text::session_handover(p, st, env)? else { return Ok(None) };
    let since = fin(l, "firedAt").map_or(0.0, |f| f - defaults::num("ctxbudget.ah_mtime_slack_ms") as f64);
    if mtime < since || fin(l, "handoverMtime").is_some_and(|h| mtime <= h) {
        return Ok(None);
    }
    let mut next = l.clone();
    next.set("handoverMtime", Js::Num(mtime));
    next.set("handoverPath", Js::Str(file));
    next.set("handoverPct", Js::Num(pct));
    next.set("handoverSeenAt", Js::Num(now));
    remove(&mut next, "gateBackstopAt");
    remove(&mut next, "gateBackstopPct");
    Ok(Some(next))
}

/// `isArmed(cfg, latch)`.
fn is_armed(eff: &Eff, l: &Js) -> bool {
    eff.enabled && eff.gate_new_work && fired(l) && fin(l, "handoverPct").is_some()
}

/// `isHousekeepingPrompt(prompt, extraMarkers)`.
fn is_housekeeping(prompt: Option<&Value>, extra: &[String]) -> bool {
    let Some(p) = prompt.and_then(Value::as_str).filter(|p| !js_trim(p).is_empty()) else { return false };
    let lower = p.to_lowercase();
    let builtin = defaults::list("ctxbudget.ah_housekeeping");
    builtin.iter().map(|m| m.to_string()).chain(extra.iter().cloned()).any(|m| !js_trim(&m).is_empty() && lower.contains(&m.to_lowercase()))
}

// ---- auto-handover.js ----------------------------------------------------------------------------------------------

/// `auto-handover.js`.
pub fn decide_prompt(p: &Value, env: &RequestEnv) -> Verdict {
    if judge_child(env) {
        return Verdict::Allow;
    }
    let st = match gate(p, env, false) {
        Gate::Quiet => return ups_empty(),
        Gate::Defer => return Verdict::Defer,
        Gate::Go(st) => st,
    };
    let _zone = ZoneGuard::new(env);
    let eff = resolve(&st);
    let Some(tag) = session_tag(p) else { return ups_empty() };
    let Ok(latch) = read_latch(&st, &tag) else { return Verdict::Defer };
    let mut w = Writes::default();
    if !eff.enabled {
        if fired(&latch) {
            w.latch = Some(obj(vec![("fired", Js::Bool(false))]));
        }
        w.commit(&st, p, &tag);
        return ups_empty();
    }
    let r = match context_pct(&st, p.get("session_id"), transcript_of(p), None) {
        Pct::Defer => return Verdict::Defer,
        Pct::None => return ups_empty(),
        Pct::Reading(r) => r,
    };
    w.inferred = r.infer_write;
    let text = match prompt_text(p, &st, env, &eff, &latch, &r, &mut w) {
        Ok(t) => t,
        Err(()) => return Verdict::Defer,
    };
    w.commit(&st, p, &tag);
    ups_text(&text)
}

/// The context `auto-handover.js` injects for a reading, with the latch write it implies. `Err` = defer.
fn prompt_text(p: &Value, st: &Settings, env: &RequestEnv, eff: &Eff, latch: &Js, r: &Reading, w: &mut Writes) -> Result<String, ()> {
    if !r.pct.is_finite() {
        return Ok(String::new());
    }
    let now = now_ms();
    let Some(over) = over_threshold(r, eff) else {
        if fired(latch) || truthy(latch.get("softFired")) {
            w.latch = Some(obj(vec![("fired", Js::Bool(false)), ("softFired", Js::Bool(false))]));
        }
        return Ok(String::new());
    };
    if !fired(latch) {
        if over == Over::PctUnknownWindow {
            // unknown window: never the mandatory directive, one soft advisory per arm
            if latch.get("softFired") == Some(&Js::Bool(true)) {
                return Ok(String::new());
            }
            let mut next = latch.clone();
            next.set("softFired", Js::Bool(true));
            next.set("lastNagAt", Js::Num(now));
            w.latch = Some(next);
            return Ok(text::soft(r.pct));
        }
        let hp = text::expected_handover_path(p, st, env)?;
        w.latch = Some(obj(vec![
            ("fired", Js::Bool(true)),
            ("firedAt", Js::Num(now)),
            ("firedPct", Js::Num(r.pct)),
            ("firedVia", Js::Str(over.via().to_string())),
            ("lastNagPct", Js::Num(r.pct)),
            ("lastNagAt", Js::Num(now)),
            ("softFired", Js::Bool(false)),
        ]));
        return Ok(text::fire(r, over == Over::Tokens, p, eff.max_tokens, hp.as_deref()));
    }
    // already fired this arm: the post-handover new-work gate, then the milestone nag
    let mut cur = latch.clone();
    let mut dirty = false;
    let mut parts: Vec<String> = Vec::new();
    let mut backstop = false;
    if eff.gate_new_work && !is_housekeeping(p.get("prompt"), &eff.markers) {
        if let Some(noted) = note_handover(&cur, p, r.pct, now, st, env)? {
            cur = noted;
            dirty = true;
        }
        if is_armed(eff, &cur) {
            let hp = fin(&cur, "handoverPct").unwrap_or(0.0);
            if fin(&cur, "gateBackstopAt").is_none() && r.pct > hp + eff.gate_budget {
                parts.push(text::backstop(r.pct, hp, eff.gate_budget, p));
                cur.set("gateBackstopAt", Js::Num(now));
                cur.set("gateBackstopPct", Js::Num(r.pct));
                cur.set("lastNagPct", Js::Num(r.pct));
                cur.set("lastNagAt", Js::Num(now));
                dirty = true;
                backstop = true;
            }
            parts.push(text::gate(r, hp, eff.gate_budget, p));
            // consultJevShadow: a prompt with text gets a Jev decision row (see the module docs)
            if p.get("prompt").and_then(Value::as_str).is_some_and(|s| !js_trim(s).is_empty()) {
                return Err(());
            }
        }
    }
    if !backstop && eff.nag {
        let last = match fin(&cur, "lastNagPct") {
            Some(n) => n,
            // `cur.firedPct || settings.pct`: a truthy non-number would be concatenated by `+`
            None => match cur.get("firedPct") {
                Some(Js::Num(n)) if *n != 0.0 && !n.is_nan() => *n,
                v if !truthy(v) => eff.pct,
                _ => return Err(()),
            },
        };
        if r.pct >= last + eff.nag_step {
            parts.push(text::milestone(r.pct, p));
            cur.set("lastNagPct", Js::Num(r.pct));
            cur.set("lastNagAt", Js::Num(now));
            dirty = true;
        }
    }
    if dirty {
        w.latch = Some(cur);
    }
    Ok(parts.join(defaults::text("ctxbudget.ah_parts_sep")))
}

// ---- auto-handover-pause-nag.js -----------------------------------------------------------------------------------

/// `hasRecentSpawn(tag, now)`: a line `<ms> <tag>` of the spawn log within the activity window.
fn recent_spawn(st: &Settings, tag: &str, now: f64) -> bool {
    let Ok(bytes) = std::fs::read(format!("{}/{}", st.home, defaults::text("ctxbudget.ah_spawn_log"))) else { return false };
    let text = String::from_utf8_lossy(&bytes);
    let window = defaults::num("ctxbudget.ah_spawn_activity_ms") as f64;
    js_trim(&text).split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).any(|line| {
        let Some(sp) = line.find(' ') else { return false };
        js_parse_int(&line[..sp]).is_some_and(|ms| &line[sp + 1..] == tag && now - ms <= window)
    })
}

/// `String(v)` of a task id or key, where it is reproduced. `Err` for an object or array.
fn js_string(v: &Value) -> Result<String, ()> {
    match v {
        Value::String(s) => Ok(s.clone()),
        Value::Number(n) => Ok(crate::checks::jsport::num::to_js_string(n.as_f64().unwrap_or(0.0))),
        Value::Bool(b) => Ok(b.to_string()),
        Value::Null => Ok(defaults::text("ctxbudget.json_null").to_string()),
        _ => Err(()),
    }
}

fn vtruthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// A task status as the map holds it: only a string can equal an open status, so anything else is kept as "not open".
fn status_of(v: Option<&Value>) -> Option<String> {
    if vtruthy(v) { Some(v.and_then(Value::as_str).unwrap_or_default().to_string()) } else { None }
}

/// `hasOpenTasks(lines)`: true or false once a task tool appeared in the tail, else none.
fn has_open_tasks(lines: Option<&[String]>) -> Result<Option<bool>, ()> {
    let Some(lines) = lines else { return Ok(None) };
    let tools = defaults::list("ctxbudget.ah_task_tools");
    let (todo, create, update) = (tools[0], tools[1], tools[2]);
    let default_status = defaults::text("ctxbudget.ah_default_status");
    let mut saw = false;
    let mut map: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for line in lines {
        if line.is_empty() || !tools.iter().any(|t| line.contains(t)) {
            continue;
        }
        let Some(e) = parse_line(line)? else { continue };
        if e.get("type").and_then(Value::as_str) != Some("assistant") || e.get("isSidechain") == Some(&Value::Bool(true)) {
            continue;
        }
        let content = e.get("message").filter(|m| vtruthy(Some(m))).and_then(|m| m.get("content")).and_then(Value::as_array);
        for item in content.into_iter().flatten() {
            if !vtruthy(Some(item)) || item.get("type").and_then(Value::as_str) != Some("tool_use") {
                continue;
            }
            let name = item.get("name").and_then(Value::as_str);
            let input = item.get("input").filter(|i| vtruthy(Some(i)));
            if name == Some(todo) {
                saw = true;
                map.clear();
                let todos = input.and_then(|i| i.get("todos")).and_then(Value::as_array);
                let mut i = 0usize;
                for t in todos.into_iter().flatten() {
                    let named = if vtruthy(Some(t)) {
                        t.get("id").filter(|v| vtruthy(Some(v))).or_else(|| t.get("content").filter(|v| vtruthy(Some(v))))
                    } else {
                        None
                    };
                    let id = match named {
                        Some(v) => js_string(v)?,
                        None => {
                            i += 1;
                            (i - 1).to_string()
                        }
                    };
                    let status = if vtruthy(Some(t)) { status_of(t.get("status")) } else { None };
                    map.insert(format!("todo:{id}"), status.unwrap_or_else(|| default_status.to_string()));
                }
            } else if name == Some(create) {
                saw = true;
                if let Some(id) = item.get("id").filter(|v| vtruthy(Some(v))) {
                    let status = input.and_then(|i| status_of(i.get("status"))).unwrap_or_else(|| default_status.to_string());
                    map.insert(format!("task:{}", js_string(id)?), status);
                }
            } else if name == Some(update) {
                saw = true;
                let id = defaults::list("ctxbudget.ah_task_id_keys").iter().find_map(|k| input.and_then(|i| i.get(*k)).filter(|v| !v.is_null()));
                if let (Some(id), Some(status)) = (id, input.and_then(|i| status_of(i.get("status")))) {
                    map.insert(format!("task:{}", js_string(id)?), status);
                }
            }
        }
    }
    if !saw {
        return Ok(None);
    }
    let open = defaults::list("ctxbudget.ah_open_statuses");
    Ok(Some(map.values().any(|s| open.contains(&s.as_str()))))
}

/// `isFresh(lines, handoverMtimeMs)` (`hooks/lib/handover-freshness.js`): none without a recognized transcript entry, else
/// whether the last counted work is at most the grace past the handover's mtime.
fn is_fresh(lines: Option<&[String]>, mtime: f64, st: &Settings) -> Result<Option<bool>, ()> {
    if !mtime.is_finite() {
        return Ok(None);
    }
    let tmp = tmpdir(&|k| st.env.get(k).cloned());
    // a relative file path is judged against the hook's own directory, unknown here: `cwd: None` makes it a deferral
    let cx = Ctx { tmp: &tmp, cwd: None };
    let mut recognized = false;
    let mut last = 0.0f64;
    for line in lines.unwrap_or_default() {
        if line.is_empty() {
            continue;
        }
        let Some(e) = parse_line(line)? else { continue };
        if !is_objectish(&e) || !e.get("message").is_some_and(|m| m.is_object() || m.is_array()) {
            continue;
        }
        recognized = true;
        let ts = match e.get("timestamp").and_then(Value::as_str).map(date::parse) {
            Some(Parsed::Ms(ms)) => ms,
            Some(Parsed::Unknown) => return Err(()),
            Some(Parsed::Nan) | None => continue,
        };
        let mut tus = Vec::new();
        collect_tool_uses(&e, &mut tus);
        for tu in tus {
            if is_counted_work(tu, cx).map_err(|_| ())? && ts > last {
                last = ts;
            }
        }
    }
    Ok(recognized.then_some(last <= mtime + defaults::num("ctxbudget.ah_freshness_grace_ms") as f64))
}

/// The byte offsets where a JavaScript multiline `^` matches: the start and after each line terminator.
fn line_starts(s: &str) -> impl Iterator<Item = usize> + '_ {
    std::iter::once(0).chain(s.char_indices().filter(|(_, c)| is_lt(*c)).map(|(i, c)| i + c.len_utf8()))
}

fn is_lt(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// The end of a `\s*$` run starting at `a` under the multiline flag: the last line terminator inside the white space run,
/// or the end of the text when the run reaches it.
fn ws_to_line_end(s: &str, a: usize) -> Option<usize> {
    let run = s[a..].char_indices().take_while(|(_, c)| is_js_space(*c)).last().map_or(a, |(i, c)| a + i + c.len_utf8());
    if run == s.len() {
        return Some(run);
    }
    s[a..run].char_indices().rfind(|(_, c)| is_lt(*c)).map(|(i, _)| a + i)
}

/// `## ` (two hashes and white space) at `i`, returning where the white space ends.
fn hashes_ws(s: &str, i: usize) -> Option<usize> {
    let rest = s[i..].strip_prefix(defaults::text("ctxbudget.ah_heading_mark"))?;
    let n: usize = rest.chars().take_while(|c| is_js_space(*c)).map(char::len_utf8).sum();
    (n > 0).then_some(i + defaults::text("ctxbudget.ah_heading_mark").len() + n)
}

/// `extractSection(text, heading)`: `/^##\s+<heading>\s*$/im`, then the text up to the next `/^##\s+/m`, trimmed.
fn extract_section<'a>(text: &'a str, heading: &str) -> Option<&'a str> {
    for start in line_starts(text) {
        let Some(h) = hashes_ws(text, start) else { continue };
        let Some(cand) = text.get(h..h + heading.len()) else { continue };
        if !cand.eq_ignore_ascii_case(heading) {
            continue;
        }
        let Some(end) = ws_to_line_end(text, h + heading.len()) else { continue };
        let rest = &text[end..];
        let next = line_starts(rest).find(|&i| hashes_ws(rest, i).is_some());
        return Some(js_trim(next.map_or(rest, |n| &rest[..n])));
    }
    None
}

/// A whole text equal (any ASCII case) to one of `words`, an optional trailing dot allowed.
fn is_word(s: &str, words: &str) -> bool {
    let s = s.strip_suffix('.').map_or(s, |x| if defaults::list(words).iter().any(|w| x.eq_ignore_ascii_case(w)) { x } else { s });
    defaults::list(words).iter().any(|w| s.eq_ignore_ascii_case(w))
}

/// `isTaskCompleteFromFile(filePath)`.
fn task_complete(file: &str) -> bool {
    let Some(text) = crate::checks::jsport::fsx::read_utf8(file) else { return false };
    if text.is_empty() {
        return false;
    }
    extract_section(&text, defaults::text("ctxbudget.ah_heading_open")).is_some_and(|s| is_word(s, "ctxbudget.ah_open_empty_words"))
        || extract_section(&text, defaults::text("ctxbudget.ah_heading_next")).is_some_and(|s| is_word(s, "ctxbudget.ah_next_done_words"))
}

/// `decisiveSuffixFor(payload, settings, lines)`.
fn decisive_suffix_for(p: &Value, eff: &Eff, lines: Option<&[String]>, st: &Settings, env: &RequestEnv) -> Result<String, ()> {
    if !eff.decisive {
        return Ok(String::new());
    }
    let Some((file, mtime)) = text::session_handover(p, st, env)? else { return Ok(String::new()) };
    let fresh = is_fresh(lines, mtime, st)?;
    let complete = fresh == Some(true) && task_complete(&file);
    Ok(text::decisive_suffix(p, &text::relative_handover_path(p, &file), fresh, complete))
}

/// `auto-handover-pause-nag.js`.
pub fn decide_stop(p: &Value, env: &RequestEnv) -> Verdict {
    let st = match gate(p, env, true) {
        Gate::Quiet => return Verdict::Allow,
        Gate::Defer => return Verdict::Defer,
        Gate::Go(st) => st,
    };
    let _zone = ZoneGuard::new(env);
    let eff = resolve(&st);
    if !eff.enabled {
        return Verdict::Allow;
    }
    let Some(tag) = session_tag(p) else { return Verdict::Allow };
    let Ok(latch) = read_latch(&st, &tag) else { return Verdict::Defer };
    let transcript = transcript_of(p);
    let lines = match transcript.filter(|t| !t.is_empty()) {
        Some(t) if !t.starts_with('/') => return Verdict::Defer, // Node resolves it against its own directory
        Some(t) => crate::checks::compact_decl::read_tail(t, defaults::num("ctxbudget.tail_bytes")),
        None => None,
    };
    let mut w = Writes::default();
    let out = stop_reason(p, &st, env, &eff, &latch, &tag, transcript, lines.as_deref(), &mut w);
    match out {
        Err(()) => Verdict::Defer,
        Ok(reason) => {
            w.commit(&st, p, &tag);
            reason.map_or(Verdict::Allow, |r| stop_block(&r))
        }
    }
}

/// The block reason `auto-handover-pause-nag.js` gives (none: the stop proceeds), with the writes it implies.
#[allow(clippy::too_many_arguments)]
fn stop_reason(
    p: &Value,
    st: &Settings,
    env: &RequestEnv,
    eff: &Eff,
    latch: &Js,
    tag: &str,
    transcript: Option<&str>,
    lines: Option<&[String]>,
    w: &mut Writes,
) -> Result<Option<String>, ()> {
    if !fired(latch) {
        // the Stop-side fire, once per arm; never for a crossing against a guessed window
        let r = match context_pct(st, p.get("session_id"), transcript, lines) {
            Pct::Defer => return Err(()),
            Pct::None => return Ok(None),
            Pct::Reading(r) => r,
        };
        w.inferred = r.infer_write;
        let Some(over @ (Over::Pct | Over::Tokens)) = over_threshold(&r, eff) else { return Ok(None) };
        let now = now_ms();
        let hp = text::expected_handover_path(p, st, env)?;
        let suffix = decisive_suffix_for(p, eff, lines, st, env)?;
        w.latch = Some(obj(vec![
            ("fired", Js::Bool(true)),
            ("firedAt", Js::Num(now)),
            ("firedPct", Js::Num(r.pct)),
            ("firedVia", Js::Str(format!("{}{}", defaults::text("ctxbudget.ah_via_stop_prefix"), over.via()))),
            ("lastNagPct", Js::Num(r.pct)),
            ("lastNagAt", Js::Num(now)),
            ("softFired", Js::Bool(latch.get("softFired") == Some(&Js::Bool(true)))),
        ]));
        return Ok(Some(text::fire(&r, over == Over::Tokens, p, eff.max_tokens, hp.as_deref()) + &suffix));
    }
    if !eff.nag {
        return Ok(None);
    }
    let r = match context_pct(st, p.get("session_id"), transcript, lines) {
        Pct::Defer => return Err(()),
        Pct::None => return Ok(None),
        Pct::Reading(r) => r,
    };
    w.inferred = r.infer_write;
    if !r.pct.is_finite() {
        return Ok(None);
    }
    let now = now_ms();
    if over_threshold(&r, eff).is_none() {
        w.latch = Some(obj(vec![("fired", Js::Bool(false))])); // dropped back below: re-arm
        return Ok(None);
    }
    let last_nag_at = fin(latch, "lastNagAt").unwrap_or(0.0);
    let last_nag_pct = fin(latch, "lastNagPct").or_else(|| fin(latch, "firedPct")).unwrap_or(eff.pct);
    let shown = text::js_round(r.pct);
    let risen = r.pct >= last_nag_pct + eff.nag_step;
    let quiet_elapsed = now - last_nag_at >= eff.nag_quiet * 60.0 * 1000.0;
    if !risen && !quiet_elapsed {
        return Ok(None);
    }
    if !risen && latch.get("lastPauseNagPct") == Some(&Js::Num(shown)) {
        return Ok(None); // the same step, the identical text
    }
    if has_open_tasks(lines)? == Some(true) || recent_spawn(st, tag, now) {
        return Ok(None);
    }
    let suffix = decisive_suffix_for(p, eff, lines, st, env)?;
    let mut next = latch.clone();
    next.set("lastNagAt", Js::Num(now));
    next.set("lastPauseNagPct", Js::Num(shown));
    if risen {
        next.set("lastNagPct", Js::Num(r.pct));
    }
    w.latch = Some(next);
    Ok(Some(text::pause(r.pct, p) + &suffix))
}

super::check_impl!(AutoHandover, "auto-handover", "ctxbudget.summary_auto_handover", decide_prompt);
super::check_impl!(AutoHandoverPauseNag, "auto-handover-pause-nag", "ctxbudget.summary_pause_nag", decide_stop);
