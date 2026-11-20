//! The delivery ledger (#312): what each check DECIDED, what reached the agent (DELIVERED) and what the agent did about it
//! (COMPLIED), counted per check.
//!
//! * decided: the check answered with a message or a block (a quiet allow is not counted). Counted when the answer is made.
//! * delivered: the daemon wrote the reply that carries the answer, in time, to the hook client (an answer lost to shedding, a
//!   deadline, a CPU cut or a client that left is counted instead as `delivery_lost` with its reason).
//! * complied: the agent's reaction. A check with a row in `delivery.react` is armed when its answer is delivered; the next
//!   `delivery.react_window_calls` tool calls of the session are watched, and a call to one of the row's tools within them is
//!   `complied`, none within them (or within `delivery.react_window_ms`) is `ignored`. A check without a row has no compliance
//!   figure: its reaction is not measurable from tool calls.
//!
//! * acted_on (`complied` in the unsplit `delivery_stage` series, kept under that label so restored counters stay valid): the same
//!   figure for every check that has a `delivery.act` row, whose condition may be absent-polarity ("no spawn within the window"),
//!   advance by another event than a tool call (a turn end) and name its own tools. B1 (plan v2): the funnel split by model and
//!   project of every stage is in [`crate::funnel`].
//!
//! State is in memory, bounded (`delivery.pending_sessions_max`, `delivery.pending_per_session_max`), and costs one hash lookup per
//! tool call of a session that has something armed. Nothing here is a decision: the ledger never changes an answer.
use crate::defaults;
use crate::funnel::{self, Ctx};
use crate::telemetry::Telemetry;
use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Mutex;

thread_local! {
    /// (session, check) of every answer with a message or a block that this thread's request produced.
    static DECIDED: RefCell<Vec<(String, String, Ctx, String)>> = const { RefCell::new(Vec::new()) };
}

/// One armed check of a session.
struct Armed {
    check: String,
    ctx: Ctx,
    calls: u64,
    since_ms: u64,
    /// The delivered answer's text: it picks the row's `variants` entry (which block reason this was).
    text: String,
}

/// A check's acted-on condition (`delivery.act`, else `delivery.react`).
struct Cond {
    tools: Vec<&'static str>,
    /// True: the reaction is NOT calling one of `tools` within the window.
    avoid: bool,
    window: u64,
    window_event: &'static str,
    /// The row's `command_re`: a call of `delivery.command_tool` whose command text matches counts like a listed tool (compliance run
    /// through the shell the message prescribes, e.g. `ah-engine mesh send`).
    command_re: Option<regex::Regex>,
    /// The row's `reply_re`: the reply of the turn that ends the window (`last_assistant_message` of a Stop that is the row's
    /// `window_event`) restating the claim as unverified counts as the reaction, which no tool call shows.
    reply_re: Option<regex::Regex>,
}

/// The compiled `command_re` of a row (one compile per distinct pattern; an invalid pattern matches nothing and is logged once, since it
/// would otherwise quietly zero the row's acted_on).
fn command_regex(pattern: &str) -> Option<regex::Regex> {
    static CACHE: Mutex<Option<HashMap<String, Option<regex::Regex>>>> = Mutex::new(None);
    if pattern.is_empty() {
        return None;
    }
    let mut g = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    g.get_or_insert_with(HashMap::new)
        .entry(pattern.to_string())
        .or_insert_with(|| match regex::Regex::new(pattern) {
            Ok(re) => Some(re),
            Err(e) => {
                log_bad_regex(pattern, &e.to_string());
                None
            }
        })
        .clone()
}

#[cfg(not(test))]
fn log_bad_regex(pattern: &str, why: &str) {
    let detail = defaults::render("delivery.msg_bad_command_re", &[("pattern", &pattern), ("why", &why)]);
    crate::health::log_event(defaults::text("delivery.log_kind"), defaults::text("delivery.code_bad_command_re"), &detail);
}

#[cfg(test)]
static BAD_REGEX_LOGS: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());

#[cfg(test)]
fn log_bad_regex(pattern: &str, why: &str) {
    let detail = defaults::render("delivery.msg_bad_command_re", &[("pattern", &pattern), ("why", &why)]);
    BAD_REGEX_LOGS.lock().unwrap_or_else(|e| e.into_inner()).push((defaults::text("delivery.code_bad_command_re").to_string(), detail));
}

/// What a hook payload gives the compliance ledger: the call's tool and, for the shell tool, its command text
/// (`tool_input.command`); both empty when absent.
pub fn call_fields(p: &serde_json::Value) -> (&str, &str) {
    let tool = p.get("tool_name").and_then(|v| v.as_str()).unwrap_or("");
    let command = p.pointer("/tool_input/command").and_then(|v| v.as_str()).unwrap_or("");
    (tool, command)
}

static PENDING: Mutex<Option<HashMap<String, Vec<Armed>>>> = Mutex::new(None);

/// Count one answer at a stage: in the unsplit `delivery_stage` series (label `which`) and in the funnel split (label `funnel_which`).
fn stage(t: &Telemetry, check: &str, which: &str, funnel_which: &str, ctx: &Ctx) {
    t.with_metrics(|m| m.inc("delivery_stage", &[("check", check), ("stage", defaults::text(which))]));
    funnel::stage(t, check, ctx, funnel_which);
}

/// A check answered with a message or a block while this thread served a request; `ctx` is whose session and project it was.
pub fn decided(t: &Telemetry, session: &str, check: &str, ctx: &Ctx) {
    decided_with(t, session, check, ctx, "");
}

/// [`decided`] with the answer's text, so a row with `variants` is judged by the reason the answer gave.
pub fn decided_with(t: &Telemetry, session: &str, check: &str, ctx: &Ctx, text: &str) {
    stage(t, check, "delivery.stage_decided", "delivery.stage_decided", ctx);
    DECIDED.with(|d| d.borrow_mut().push((session.to_string(), check.to_string(), ctx.clone(), text.to_string())));
}

/// A check answered with a message or a block that the client's hook configuration never emits (a shadowed entry: it ran, its
/// answer is dropped). It counts as decided and as suppressed, never as delivered, in a channel or armed for a reaction.
pub fn suppressed(t: &Telemetry, check: &str, ctx: &Ctx) {
    stage(t, check, "delivery.stage_decided", "delivery.stage_decided", ctx);
    stage(t, check, "delivery.stage_suppressed", "delivery.stage_suppressed", ctx);
}

/// The request ended: the answers it produced are delivered when `delivered` (the reply was written and the client still
/// waited), else lost for the reason `delivery.reason_undelivered`. Delivered answers of checks with a `delivery.react` row are armed.
pub fn settle(t: &Telemetry, delivered: bool) {
    let answers = DECIDED.with(|d| std::mem::take(&mut *d.borrow_mut()));
    for (session, check, ctx, text) in answers {
        if !delivered {
            t.with_metrics(|m| m.inc("delivery_lost", &[("check", check.as_str()), ("reason", defaults::text("delivery.reason_undelivered"))]));
            funnel::stage(t, &check, &ctx, "delivery.stage_lost");
            continue;
        }
        stage(t, &check, "delivery.stage_delivered", "delivery.stage_delivered", &ctx);
        arm(&session, &check, ctx, text);
    }
}

fn react_tools(check: &str) -> Option<Vec<&'static str>> {
    defaults::raw("delivery.react").get(check).map(defaults::V::strings)
}

/// The acted-on condition of `check`: its `delivery.act` row, else its `delivery.react` row (tool calls, polarity do), else none.
fn cond(check: &str) -> Option<Cond> {
    cond_for(check, "")
}

/// [`cond`] for an answer with `text`: the first of the row's `variants` whose `when_re` matches the text replaces the row's `tools`,
/// `command_re`, `polarity`, `window` and `window_event` (each only where the variant sets it) - one check, one condition per reason.
fn cond_for(check: &str, text: &str) -> Option<Cond> {
    let (calls, event) = (defaults::num("delivery.react_window_calls"), defaults::text("delivery.react_event"));
    if let Some(base) = defaults::raw("delivery.act").get(check) {
        let variant = (!text.is_empty())
            .then(|| base.get("variants").and_then(defaults::V::as_array))
            .flatten()
            .and_then(|vs| vs.iter().find(|v| v.get("when_re").and_then(defaults::V::as_str).and_then(command_regex).is_some_and(|re| re.is_match(text))));
        let pick = |k: &str| variant.and_then(|v| v.get(k)).or_else(|| base.get(k));
        return Some(Cond {
            tools: pick("tools").map(defaults::V::strings).unwrap_or_default(),
            avoid: pick("polarity").and_then(defaults::V::as_str).unwrap_or("") == defaults::text("delivery.polarity_avoid"),
            window: pick("window").and_then(defaults::V::as_integer).map_or(calls, |n| n.max(1) as u64),
            window_event: pick("window_event").and_then(defaults::V::as_str).unwrap_or(event),
            command_re: pick("command_re").and_then(defaults::V::as_str).and_then(command_regex),
            reply_re: pick("reply_re").and_then(defaults::V::as_str).and_then(command_regex),
        });
    }
    react_tools(check).map(|tools| Cond { tools, avoid: false, window: calls, window_event: event, command_re: None, reply_re: None })
}

fn arm(session: &str, check: &str, ctx: Ctx, text: String) {
    if session.is_empty() || defaults::num("delivery.react_window_calls") == 0 || cond(check).is_none() {
        return;
    }
    let mut g = PENDING.lock().unwrap_or_else(|e| e.into_inner());
    let map = g.get_or_insert_with(HashMap::new);
    if !map.contains_key(session) && map.len() >= defaults::num("delivery.pending_sessions_max") as usize {
        // bounded: the session whose oldest armed check is the oldest makes room (its unobserved checks are not counted either way)
        let oldest = map.iter().min_by_key(|(_, v)| v.iter().map(|a| a.since_ms).min().unwrap_or(0)).map(|(k, _)| k.clone());
        if let Some(k) = oldest {
            map.remove(&k);
        }
    }
    let list = map.entry(session.to_string()).or_default();
    if list.iter().any(|a| a.check == check) {
        return; // one open question per check: its window is already running
    }
    if list.len() < defaults::num("delivery.pending_per_session_max") as usize {
        list.push(Armed { check: check.to_string(), ctx, calls: 0, since_ms: crate::health::now_ms(), text });
    }
}

/// A tool call of `session` is about to be judged (the `delivery.react_event` call of `tool`): see [`observe`].
pub fn observe_tool(t: &Telemetry, session: &str, tool: &str) {
    observe(t, session, defaults::text("delivery.react_event"), tool);
}

/// A hook event of `session` is about to be judged (`tool` is the call's tool for `delivery.react_event`, else empty): every armed
/// check of the session either sees its reaction (`delivery.act` / `delivery.react`: the tool is one of its tools), runs out of
/// window (`event` advances the check's window when it is its `window_event`), or waits for the next event. For an `avoid` check
/// the outcome is the other way round: the window running out is the reaction, a listed tool is not.
pub fn observe(t: &Telemetry, session: &str, event: &str, tool: &str) {
    observe_call(t, session, event, tool, "");
}

/// [`observe`] with the call's shell command text (`tool_input.command` of a `delivery.command_tool` call): a row with a `command_re`
/// also counts a call of that tool whose command matches it as the reaction.
pub fn observe_call(t: &Telemetry, session: &str, event: &str, tool: &str, command: &str) {
    observe_full(t, session, event, tool, command, "");
}

/// [`observe_call`] with the reply the agent just ended its turn with (`last_assistant_message` of a Stop): a row with a `reply_re`
/// counts a reply that matches it, at the row's own `window_event`, as the reaction.
pub fn observe_full(t: &Telemetry, session: &str, event: &str, tool: &str, command: &str, reply: &str) {
    if session.is_empty() {
        return;
    }
    let mut g = PENDING.lock().unwrap_or_else(|e| e.into_inner());
    let Some(list) = g.as_mut().and_then(|m| m.get_mut(session)) else { return };
    let (max_age, react_event) = (defaults::num("delivery.react_window_ms"), defaults::text("delivery.react_event"));
    let now = crate::health::now_ms();
    let mut results: Vec<(String, Ctx, bool)> = Vec::new();
    list.retain_mut(|a| {
        let Some(c) = cond_for(&a.check, &a.text) else { return false }; // its row left the defaults on a reload: nothing to measure
        if event == c.window_event {
            a.calls += 1;
        }
        let by_command = !command.is_empty() && tool == defaults::text("delivery.command_tool") && c.command_re.as_ref().is_some_and(|re| re.is_match(command));
        let by_reply = !reply.is_empty() && event == c.window_event && event != react_event && c.reply_re.as_ref().is_some_and(|re| re.is_match(reply));
        let hit = (event == react_event && (c.tools.contains(&tool) || by_command)) || by_reply;
        let spent = a.calls >= c.window || now.saturating_sub(a.since_ms) > max_age;
        if hit || spent {
            results.push((a.check.clone(), a.ctx.clone(), if hit { !c.avoid } else { c.avoid }));
        }
        !(hit || spent)
    });
    let empty = list.is_empty();
    if empty && let Some(m) = g.as_mut() {
        m.remove(session);
    }
    drop(g);
    for (check, ctx, acted) in results {
        if acted {
            stage(t, &check, "delivery.stage_complied", "delivery.stage_acted_on", &ctx);
        } else {
            stage(t, &check, "delivery.stage_ignored", "delivery.stage_ignored", &ctx);
        }
    }
}

/// One check's counts of every stage.
#[derive(Default)]
struct Row {
    decided: u64,
    delivered: u64,
    complied: u64,
    ignored: u64,
    shed: u64,
    lost: u64,
    suppressed: u64,
    /// The part of `lost` that a check said and the reply never carried (reason `delivery.reason_undelivered`).
    undelivered: u64,
}

/// `n` of `d` as a percentage rounded to `delivery.pct_decimals`, `null` when `d` is 0.
fn pct(n: u64, d: u64) -> serde_json::Value {
    if d == 0 {
        return serde_json::Value::Null;
    }
    let scale = 10f64.powi(defaults::num("delivery.pct_decimals") as i32);
    serde_json::json!((n as f64 * 100.0 / d as f64 * scale).round() / scale)
}

/// The funnel's per-check rows (`delivery_funnel` summed over model and project): exact per check and stage, since that metric keeps
/// both labels past its series cap (`telemetry.overflow_keep_by_metric`). The unsplit `delivery_stage` series folded the stage of the
/// checks that came after its cap into the overflow label, which is what left `complied` and `ignored` at 0 for most checks.
fn funnel_rows(report: &serde_json::Value) -> std::collections::BTreeMap<String, Row> {
    use serde_json::Value;
    let mut out = std::collections::BTreeMap::new();
    for r in report.pointer("/funnel/rows").and_then(Value::as_array).cloned().unwrap_or_default() {
        let n = |k: &str| r.get(k).and_then(Value::as_u64).unwrap_or(0);
        let check = r.get("check").and_then(Value::as_str).unwrap_or_default().to_string();
        let row = Row {
            decided: n("decided"),
            delivered: n("delivered"),
            complied: n("acted_on"),
            ignored: n("ignored"),
            shed: n("shed"),
            lost: n("lost"),
            suppressed: n("suppressed"),
            undelivered: 0,
        };
        out.insert(check, row);
    }
    out
}

/// The ledger as `status` shows it: per check the counts of every stage (a stage never reached is 0; `complied` and `ignored` are
/// `null` for a check with no `delivery.act` / `delivery.react` row), its dropped and ignored shares, and the spills per event.
/// A check the funnel counted takes its stages from the funnel ([`funnel_rows`]); the others from the unsplit series.
/// * `undelivered`: answers the check made that the reply never carried (certain drops);
/// * `not_run`: runs dropped before the check answered (shed, client_gone, hard_deadline, cpu_budget, check_deferred): most of them
///   would have been a quiet allow, so they are not answers; `lost` = undelivered + not_run less shed;
/// * `dropped_pct` = undelivered of decided; `dropped_max_pct` = (undelivered + not_run) of (decided + not_run), the bound if every
///   dropped run would have answered; `ignored_pct` = ignored of (acted_on + ignored).
pub fn status(t: &Telemetry) -> serde_json::Value {
    use serde_json::{Map, Value, json};
    let snap = t.with_metrics(|m| m.snapshot(""));
    let (decided, delivered, complied, ignored) = (
        defaults::text("delivery.stage_decided"),
        defaults::text("delivery.stage_delivered"),
        defaults::text("delivery.stage_complied"),
        defaults::text("delivery.stage_ignored"),
    );
    let (shed, undelivered) = (defaults::text("delivery.reason_shed"), defaults::text("delivery.reason_undelivered"));
    let suppressed = defaults::text("delivery.stage_suppressed");
    let mut checks: std::collections::BTreeMap<String, Row> = std::collections::BTreeMap::new();
    let mut spills = Map::new();
    let mut pinned_spills = 0u64;
    let counters = snap.get("counters").and_then(Value::as_array).cloned().unwrap_or_default();
    for c in &counters {
        let label = |k: &str| c.get("labels").and_then(|l| l.get(k)).and_then(Value::as_str).unwrap_or_default().to_string();
        let n = c.get("value").and_then(Value::as_u64).unwrap_or(0);
        match c.get("name").and_then(Value::as_str).unwrap_or_default() {
            "delivery_stage" => {
                let s = label("stage");
                let slot = [decided, delivered, complied, ignored].iter().position(|w| *w == s);
                let row = checks.entry(label("check")).or_default();
                match slot {
                    Some(0) => row.decided += n,
                    Some(1) => row.delivered += n,
                    Some(2) => row.complied += n,
                    Some(3) => row.ignored += n,
                    _ if s == suppressed => row.suppressed += n,
                    _ => {}
                }
            }
            "delivery_lost" => {
                let reason = label("reason");
                let row = checks.entry(label("check")).or_default();
                if reason == shed {
                    row.shed += n;
                } else {
                    row.lost += n;
                }
                if reason == undelivered {
                    row.undelivered += n;
                }
            }
            "context_spills" => {
                let e = spills.entry(label("event")).or_insert_with(|| json!(0));
                *e = json!(e.as_u64().unwrap_or(0) + n);
            }
            "context_spill_pinned" => pinned_spills += n,
            _ => {}
        }
    }
    let report = funnel::report(&t.with_metrics(|m| m.export()), None, true, &[], None);
    // the funnel's exact stages replace the unsplit ones of every check it counted; the undelivered part stays the unsplit reason's
    for (check, f) in funnel_rows(&report) {
        let row = checks.entry(check).or_default();
        let kept = row.undelivered;
        *row = Row { undelivered: kept.min(f.lost), ..f };
    }
    let never: Vec<&str> = defaults::raw("diagnostics.shed_never").as_table().map(|t| t.iter().map(|(k, _)| *k).collect()).unwrap_or_default();
    let mut essential_shed = 0u64;
    // (decided, undelivered, not_run) and (acted_on, ignored) of the measured checks, over every check
    let (mut total, mut measured_total) = ((0u64, 0u64, 0u64), (0u64, 0u64));
    let rows: Map<String, Value> = checks
        .into_iter()
        .map(|(check, r)| {
            let measured = cond(&check).is_some();
            let (dec, del, com, ign, shd, lost) = (r.decided, r.delivered, r.complied, r.ignored, r.shed, r.lost);
            if never.contains(&check.as_str()) {
                essential_shed += shd;
            }
            let not_run = (lost + shd).saturating_sub(r.undelivered);
            total = (total.0 + dec, total.1 + r.undelivered, total.2 + not_run);
            if measured {
                measured_total.0 += com;
                measured_total.1 += ign;
            }
            let row = json!({
                "decided": dec, "delivered": del,
                "complied": if measured { json!(com) } else { Value::Null },
                "acted_on": if measured { json!(com) } else { Value::Null },
                "ignored": if measured { json!(ign) } else { Value::Null },
                "shed": shd, "lost": lost, "suppressed": r.suppressed,
                "undelivered": r.undelivered, "not_run": not_run,
                "dropped_pct": pct(r.undelivered, dec),
                "dropped_max_pct": pct(r.undelivered + not_run, dec + not_run),
                "ignored_pct": if measured { pct(ign, com + ign) } else { Value::Null },
            });
            (check, row)
        })
        .collect();
    let totals = report.get("funnel").and_then(|f| f.get("totals")).cloned().unwrap_or_default();
    let ((dec, undel, not_run), (com, ign)) = (total, measured_total);
    json!({
        "per_check": rows, "essential_shed": essential_shed, "spills_by_event": spills, "pinned_spills": pinned_spills,
        "summary": {
            "decided": dec, "undelivered": undel, "not_run": not_run,
            "dropped_pct": pct(undel, dec),
            "dropped_max_pct": pct(undel + not_run, dec + not_run),
            "acted_on": com, "ignored": ign, "ignored_pct": pct(ign, com + ign),
        },
        "funnel": { "enabled": funnel::enabled(), "totals": totals },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx() -> Ctx {
        Ctx { model: "opus".into(), project: "pa".into() }
    }

    fn count(t: &Telemetry, check: &str, which: &str) -> u64 {
        t.with_metrics(|m| m.counter("delivery_stage", &[("check", check), ("stage", defaults::text(which))]))
    }

    #[test]
    fn a_delivered_answer_is_armed_and_the_reaction_within_the_window_is_complied() {
        let t = Telemetry::new();
        decided(&t, "s-react", "task-tracker", &ctx());
        settle(&t, true);
        assert_eq!((count(&t, "task-tracker", "delivery.stage_decided"), count(&t, "task-tracker", "delivery.stage_delivered")), (1, 1));
        observe_tool(&t, "s-react", "Bash");
        assert_eq!(count(&t, "task-tracker", "delivery.stage_complied"), 0, "an unrelated tool is not a reaction");
        observe_tool(&t, "s-react", "TaskUpdate");
        assert_eq!(count(&t, "task-tracker", "delivery.stage_complied"), 1);
        observe_tool(&t, "s-react", "TaskUpdate");
        assert_eq!(count(&t, "task-tracker", "delivery.stage_complied"), 1, "counted once per delivery");
    }

    #[test]
    fn no_reaction_inside_the_window_is_ignored_and_an_undelivered_answer_is_lost_not_delivered() {
        let t = Telemetry::new();
        decided(&t, "s-ign", "task-tracker", &ctx());
        settle(&t, true);
        for _ in 0..defaults::num("delivery.react_window_calls") {
            observe_tool(&t, "s-ign", "Bash");
        }
        assert_eq!((count(&t, "task-tracker", "delivery.stage_ignored"), count(&t, "task-tracker", "delivery.stage_complied")), (1, 0));
        decided(&t, "s-lost", "task-tracker", &ctx());
        settle(&t, false);
        assert_eq!(count(&t, "task-tracker", "delivery.stage_delivered"), 1, "only the first delivery counts");
        let lost = t.with_metrics(|m| m.counter("delivery_lost", &[("check", "task-tracker"), ("reason", defaults::text("delivery.reason_undelivered"))]));
        assert_eq!(lost, 1);
    }

    #[test]
    fn a_suppressed_answer_is_decided_and_suppressed_never_delivered_or_armed() {
        let t = Telemetry::new();
        suppressed(&t, "task-tracker", &ctx());
        settle(&t, true);
        assert_eq!(
            (
                count(&t, "task-tracker", "delivery.stage_decided"),
                count(&t, "task-tracker", "delivery.stage_suppressed"),
                count(&t, "task-tracker", "delivery.stage_delivered")
            ),
            (1, 1, 0)
        );
        observe_tool(&t, "s-sup", "TaskUpdate");
        assert_eq!(count(&t, "task-tracker", "delivery.stage_complied") + count(&t, "task-tracker", "delivery.stage_ignored"), 0, "nothing was armed");
        let s = status(&t);
        assert_eq!((s["per_check"]["task-tracker"]["decided"].as_u64(), s["per_check"]["task-tracker"]["suppressed"].as_u64()), (Some(1), Some(1)));
    }

    #[test]
    fn status_reads_each_checks_stages_from_the_funnel_past_the_series_cap_and_shows_its_dropped_and_ignored_shares() {
        let t = Telemetry::new();
        // more checks than the global series cap: each keeps its own stages (the unsplit series folded them into the overflow label)
        let n = defaults::num("telemetry.max_series") as usize + 72;
        for i in 0..n {
            deliver(&t, &format!("s-cap-{i}"), &format!("cap-check-{i}"));
        }
        let s = status(&t);
        for i in 0..n {
            let r = &s["per_check"][format!("cap-check-{i}")];
            assert_eq!((r["decided"].as_u64(), r["delivered"].as_u64(), r["dropped_pct"].as_f64()), (Some(1), Some(1), Some(0.0)), "cap-check-{i}: {r}");
        }
        let check = "task-tracker";
        let window =
            defaults::raw("delivery.act").get(check).and_then(|r| r.get("window")).and_then(defaults::V::as_integer).expect("task-tracker has an act row");
        deliver(&t, "s-share-1", check);
        observe_tool(&t, "s-share-1", "TaskUpdate");
        deliver(&t, "s-share-2", check);
        for _ in 0..window {
            observe_tool(&t, "s-share-2", "Bash");
        }
        decided(&t, "s-share-3", check, &ctx());
        settle(&t, false);
        let s = status(&t);
        let r = &s["per_check"][check];
        assert_eq!(
            (r["decided"].as_u64(), r["delivered"].as_u64(), r["acted_on"].as_u64(), r["ignored"].as_u64(), r["undelivered"].as_u64(), r["not_run"].as_u64()),
            (Some(3), Some(2), Some(1), Some(1), Some(1), Some(0)),
            "{r}"
        );
        assert_eq!((r["dropped_pct"].as_f64(), r["dropped_max_pct"].as_f64(), r["ignored_pct"].as_f64()), (Some(33.3), Some(33.3), Some(50.0)), "{r}");
        assert!(s["per_check"]["cap-check-0"]["ignored_pct"].is_null(), "a check without an acted-on row has no ignored share");
        let sum = &s["summary"];
        assert_eq!(
            (sum["decided"].as_u64(), sum["undelivered"].as_u64(), sum["acted_on"].as_u64(), sum["ignored"].as_u64()),
            (Some(n as u64 + 3), Some(1), Some(1), Some(1)),
            "{sum}"
        );
        assert_eq!(sum["ignored_pct"].as_f64(), Some(50.0));
    }

    #[test]
    fn status_shows_the_stages_per_check_and_null_compliance_for_a_check_without_a_reaction_row() {
        let t = Telemetry::new();
        decided(&t, "s-st", "version-alert", &ctx());
        settle(&t, true);
        let s = status(&t);
        assert_eq!(s["per_check"]["version-alert"]["decided"], 1);
        assert_eq!(s["per_check"]["version-alert"]["delivered"], 1);
        assert!(s["per_check"]["version-alert"]["complied"].is_null());
    }

    fn funnel_count(t: &Telemetry, check: &str, c: &Ctx, which: &str) -> u64 {
        t.with_metrics(|m| m.counter("delivery_funnel", &[("check", check), ("model", &c.model), ("project", &c.project), ("stage", defaults::text(which))]))
    }

    /// Deliver one answer of `check` in `session` (it arms the check's acted-on window).
    fn deliver(t: &Telemetry, session: &str, check: &str) {
        decided(t, session, check, &ctx());
        settle(t, true);
    }

    #[test]
    fn every_act_row_is_met_by_its_reaction_waits_on_a_wrong_tool_and_ends_when_its_window_runs_out() {
        let rows = defaults::raw("delivery.act").as_table().expect("delivery.act is a table");
        assert!(rows.len() >= 6, "the shipped conditions are in the defaults");
        for (check, _) in rows {
            let c = cond(check).unwrap_or_else(|| panic!("{check} has a condition"));
            let (acted, ignored) = ("delivery.stage_acted_on", "delivery.stage_ignored");
            let (react, other) = (c.tools[0], "NoSuchToolForTheFunnel");
            assert!(!c.tools.contains(&other));
            let t = Telemetry::new();
            // 1. a call that is not one of its tools does not end the window while it has room
            deliver(&t, "s-wrong", check);
            observe(&t, "s-wrong", defaults::text("delivery.react_event"), other);
            assert_eq!((funnel_count(&t, check, &ctx(), acted), funnel_count(&t, check, &ctx(), ignored)), (0, 0), "{check}: still open after a wrong tool");
            // 2. one of its tools ends it at once: the reaction for polarity do, the failure for avoid
            deliver(&t, "s-hit", check);
            observe(&t, "s-hit", defaults::text("delivery.react_event"), react);
            let (a, i) = (funnel_count(&t, check, &ctx(), acted), funnel_count(&t, check, &ctx(), ignored));
            assert_eq!((a, i), if c.avoid { (0, 1) } else { (1, 0) }, "{check}: its own tool");
            // 3. the window running out ends it the other way round
            deliver(&t, "s-spent", check);
            for _ in 0..c.window {
                observe(&t, "s-spent", c.window_event, if c.window_event == defaults::text("delivery.react_event") { other } else { "" });
            }
            let (a2, i2) = (funnel_count(&t, check, &ctx(), acted), funnel_count(&t, check, &ctx(), ignored));
            assert_eq!((a2 - a, i2 - i), if c.avoid { (1, 0) } else { (0, 1) }, "{check}: the window ran out");
            // the unsplit series moved with the funnel: complied is the old name of acted_on
            let legacy = t.with_metrics(|m| m.counter("delivery_stage", &[("check", check), ("stage", defaults::text("delivery.stage_complied"))]));
            assert_eq!(legacy, a2, "{check}: delivery_stage complied == funnel acted_on");
        }
    }

    /// A row's `command_re` makes a Bash call whose command matches a reaction; a Bash call that does not match is not (both ways).
    #[test]
    fn a_shell_command_matching_the_rows_command_re_is_the_reaction_and_a_foreign_one_is_not() {
        let bash = defaults::text("delivery.command_tool");
        for (check, good, bad) in [
            ("devswarm-parent-inbox", "~/.anti-hall/ah-engine/bin/ah-engine mesh inbox read-primary 3f2", "ls -la && git status"),
            ("devswarm-child-gate", "/Users/x/.anti-hall/ah-engine/bin/ah-engine mesh heartbeat 03db --summary \"holding\"", "cargo test -p ah-engine"),
            ("silent-agent-nudge", "\"$HOME/.anti-hall/ah-engine/bin/ah-engine\" agents nudge abc other \"why\"", "ah-engine status --json"),
        ] {
            let t = Telemetry::new();
            deliver(&t, "s-bad", check);
            observe_call(&t, "s-bad", defaults::text("delivery.react_event"), bash, bad);
            assert_eq!(
                (funnel_count(&t, check, &ctx(), "delivery.stage_acted_on"), funnel_count(&t, check, &ctx(), "delivery.stage_ignored")),
                (0, 0),
                "{check}: a foreign command leaves the window open"
            );
            deliver(&t, "s-good", check);
            observe_call(&t, "s-good", defaults::text("delivery.react_event"), bash, good);
            assert_eq!(funnel_count(&t, check, &ctx(), "delivery.stage_acted_on"), 1, "{check}: its prescribed command is the reaction");
            // the command only counts for the shell tool, never for another tool carrying the same text
            deliver(&t, "s-other-tool", check);
            observe_call(&t, "s-other-tool", defaults::text("delivery.react_event"), "Edit", good);
            assert_eq!(funnel_count(&t, check, &ctx(), "delivery.stage_acted_on"), 1, "{check}: a command on another tool is no reaction");
        }
    }

    /// Ignored-rules 3/6: the `command` check is judged per block reason: a stash block by a WIP commit, a native-send block by a mesh send,
    /// a heavy-command block by an agent spawn - and not by each other's reaction.
    #[test]
    fn the_command_check_is_judged_by_the_reaction_its_block_reason_asks_for() {
        let (check, bash, ev) = ("command", defaults::text("delivery.command_tool"), defaults::text("delivery.react_event"));
        let acted = |t: &Telemetry| funnel_count(t, check, &ctx(), "delivery.stage_acted_on");
        let n = std::cell::Cell::new(0);
        let run = |text: &str, tool: &str, cmd: &str| {
            n.set(n.get() + 1);
            let session = format!("s-variant-{}", n.get()); // the pending map is process-wide: one open window per session and check
            let t = Telemetry::new();
            decided_with(&t, &session, check, &ctx(), text);
            settle(&t, true);
            observe_call(&t, &session, ev, tool, cmd);
            acted(&t)
        };
        let (stash, send, heavy) =
            ("`git stash push` is blocked for a subagent.", "`hivecontrol workspace send` is blocked.", "a heavy command (cargo) was stopped");
        assert_eq!(run(stash, bash, "git commit -m wip"), 1, "stash block: a WIP commit");
        assert_eq!(run(stash, "Agent", ""), 0, "stash block: a spawn is not its reaction");
        assert_eq!(run(send, bash, "~/.anti-hall/ah-engine/bin/ah-engine mesh send --to-primary --message-file m"), 1, "native send: a mesh send");
        assert_eq!(run(send, bash, "git commit -m wip"), 0, "native send: a commit is not its reaction");
        assert_eq!(run(heavy, "Agent", ""), 1, "heavy: a spawn");
        assert_eq!(run(heavy, bash, "git commit -m wip"), 0, "heavy: a commit is not its reaction");
    }

    /// Ignored-rules 4/6: a reply that restates the claim as unverified is the reaction to a claim-evidence block (configurable
    /// `reply_re`); an ordinary reply, or the same words on another check's row, is not.
    #[test]
    fn a_reply_restating_the_claim_as_unverified_is_the_claim_evidence_reaction() {
        let check = "claim-evidence-guard";
        let acted = |t: &Telemetry| funnel_count(t, check, &ctx(), "delivery.stage_acted_on");
        let (t, ev) = (Telemetry::new(), defaults::text("delivery.react_event"));
        deliver(&t, "s-reply-1", check);
        observe_full(&t, "s-reply-1", "Stop", "", "", "Done. All tests pass and the deploy is live.");
        assert_eq!((acted(&t), funnel_count(&t, check, &ctx(), "delivery.stage_ignored")), (0, 1), "a plain reply is not the reaction");
        deliver(&t, "s-reply-2", check);
        observe_full(&t, "s-reply-2", "Stop", "", "", "Correction: I haven't verified the tests pass; that is unverified.");
        assert_eq!(acted(&t), 1, "an unverified restatement is");
        deliver(&t, "s-reply-3", check);
        observe_full(&t, "s-reply-3", ev, "NoSuchToolForTheFunnel", "", "not verified");
        observe_full(&t, "s-reply-3", "Stop", "", "", "");
        assert_eq!(acted(&t), 1, "a tool call event never carries a reply");
    }

    /// An invalid `command_re` matches nothing (it would zero the row's acted_on), so it is logged once per pattern, never silently.
    #[test]
    fn an_invalid_command_re_matches_nothing_and_is_logged_once() {
        let bad = "(unclosed-ignored-rules-test";
        assert!(command_regex(bad).is_none());
        assert!(command_regex(bad).is_none());
        let logs: Vec<_> = BAD_REGEX_LOGS.lock().unwrap_or_else(|e| e.into_inner()).iter().filter(|(_, d)| d.contains(bad)).cloned().collect();
        assert_eq!(logs.len(), 1, "one log per pattern: {logs:?}");
        assert_eq!(logs[0].0, defaults::text("delivery.code_bad_command_re"));
        assert!(command_regex(r"\bok\b").is_some());
    }

    /// The daemon feeds the ledger from the hook payload: the shell tool's command comes from `tool_input.command`, and a payload without
    /// either gives empty fields; a Bash call carrying a prescribed command then completes the window.
    #[test]
    fn the_payload_fields_the_daemon_passes_complete_a_command_re_window() {
        let p = serde_json::json!({"tool_name": "Bash", "tool_input": {"command": "'/h/.anti-hall/ah-engine/bin/ah-engine' mesh heartbeat 03db --summary x"}});
        assert_eq!(call_fields(&p), ("Bash", "'/h/.anti-hall/ah-engine/bin/ah-engine' mesh heartbeat 03db --summary x"));
        assert_eq!(call_fields(&serde_json::json!({"hook_event_name": "Stop"})), ("", ""));
        let (t, check) = (Telemetry::new(), "devswarm-child-gate");
        deliver(&t, "s-payload", check);
        let (tool, command) = call_fields(&p);
        observe_call(&t, "s-payload", defaults::text("delivery.react_event"), tool, command);
        assert_eq!(funnel_count(&t, check, &ctx(), "delivery.stage_acted_on"), 1);
    }

    #[test]
    fn a_turn_end_window_counts_stops_and_not_tool_calls() {
        let t = Telemetry::new();
        let check = "claim-evidence-guard";
        deliver(&t, "s-turn", check);
        for _ in 0..20 {
            observe(&t, "s-turn", defaults::text("delivery.react_event"), "NoSuchToolForTheFunnel");
        }
        assert_eq!(funnel_count(&t, check, &ctx(), "delivery.stage_ignored"), 0, "tool calls do not advance a Stop window");
        observe(&t, "s-turn", "Stop", "");
        assert_eq!(funnel_count(&t, check, &ctx(), "delivery.stage_ignored"), 1, "the next Stop ends it");
        // the evidence call before that Stop is the reaction
        deliver(&t, "s-turn2", check);
        observe(&t, "s-turn2", defaults::text("delivery.react_event"), "Read");
        observe(&t, "s-turn2", "Stop", "");
        assert_eq!((funnel_count(&t, check, &ctx(), "delivery.stage_acted_on"), funnel_count(&t, check, &ctx(), "delivery.stage_ignored")), (1, 1));
    }

    #[test]
    fn the_funnel_splits_every_stage_by_the_model_and_project_of_the_answer_and_a_lost_answer_is_lost_not_delivered() {
        let t = Telemetry::new();
        let (opus, sonnet) = (ctx(), Ctx { model: "sonnet".into(), project: "pb".into() });
        decided(&t, "s-a", "task-tracker", &opus);
        settle(&t, true);
        decided(&t, "s-b", "task-tracker", &sonnet);
        settle(&t, false);
        assert_eq!(
            (funnel_count(&t, "task-tracker", &opus, "delivery.stage_decided"), funnel_count(&t, "task-tracker", &opus, "delivery.stage_delivered")),
            (1, 1)
        );
        assert_eq!(
            (
                funnel_count(&t, "task-tracker", &sonnet, "delivery.stage_decided"),
                funnel_count(&t, "task-tracker", &sonnet, "delivery.stage_delivered"),
                funnel_count(&t, "task-tracker", &sonnet, "delivery.stage_lost")
            ),
            (1, 0, 1)
        );
        assert_eq!(funnel_count(&t, "task-tracker", &opus, "delivery.stage_lost"), 0, "the other model's loss is not this one's");
    }

    /// R-inline (plan v3 L04): the funnel counts a check under the name its dispatch entry gives it (`Entry::check`), which for the
    /// command-guard hook is `command`, not `command-guard`. The `delivery.act` rows of the three main-thread guards must be keyed by
    /// those names, or their blocks reach `decided` but never `acted_on` or `ignored`.
    #[test]
    fn the_act_rows_of_the_main_thread_guards_are_keyed_by_their_dispatch_check_and_a_block_reaches_decided_then_acted_on() {
        for (hook, tool, event) in
            [("command-guard", "Bash", "PreToolUse"), ("coordinator-work-guard", "Bash", "PreToolUse"), ("edit-guard", "Write", "PreToolUse")]
        {
            let payload = serde_json::json!({"hook_event_name": event, "tool_name": tool});
            let entry = crate::dispatch::table::select("claude", event, &payload, Some(tool))
                .into_iter()
                .find(|e| e.id == hook)
                .unwrap_or_else(|| panic!("the claude {event} table has a {hook} entry for {tool}"));
            let check = entry.check.as_deref().unwrap_or_else(|| panic!("{hook} is answered by a built-in check"));
            assert!(defaults::raw("delivery.act").get(check).is_some(), "{hook}: delivery.act has a row for its check `{check}`");
            let t = Telemetry::new();
            let session = format!("s-{hook}");
            deliver(&t, &session, check);
            assert_eq!(funnel_count(&t, check, &ctx(), "delivery.stage_decided"), 1, "{hook}: a block is decided under `{check}`");
            observe_tool(&t, &session, "Agent");
            assert_eq!(funnel_count(&t, check, &ctx(), "delivery.stage_acted_on"), 1, "{hook}: a spawn after the block is acted on");
        }
    }

    /// R-pair (plan v3 L11): the funnel counts `task-pair-guard` under its dispatch check name, and a task change or an agent spawn after its
    /// block is acted on (the owner it asks for, or the named respawn).
    #[test]
    fn funnel_row_counts_task_pair_guard() {
        let check = "task-pair-guard";
        for (event, tool) in [("PreToolUse", "Agent"), ("PostToolUse", "Agent"), ("Stop", "")] {
            let payload = serde_json::json!({"hook_event_name": event, "tool_name": tool});
            let found = crate::dispatch::table::select("claude", event, &payload, if tool.is_empty() { None } else { Some(tool) })
                .into_iter()
                .any(|e| e.check.as_deref() == Some(check));
            assert!(found, "the claude {event} table has a {check} entry");
        }
        assert!(defaults::raw("delivery.act").get(check).is_some(), "delivery.act has a row for `{check}`");
        let t = Telemetry::new();
        deliver(&t, "s-pair", check);
        assert_eq!(funnel_count(&t, check, &ctx(), "delivery.stage_decided"), 1);
        observe_tool(&t, "s-pair", "TaskUpdate");
        assert_eq!(funnel_count(&t, check, &ctx(), "delivery.stage_acted_on"), 1, "a TaskUpdate after the block is acted on");
        deliver(&t, "s-pair2", check);
        for _ in 0..3 {
            observe(&t, "s-pair2", defaults::text("delivery.react_event"), "Read");
        }
        assert_eq!(funnel_count(&t, check, &ctx(), "delivery.stage_ignored"), 1, "three other tool calls end the window unmet");
    }

    #[test]
    fn the_essential_reminders_are_never_shed_and_their_grace_stays_under_the_cap() {
        for c in ["task-tracker", "tasklist-guard", "devswarm-parent-inbox", "devswarm-child-gate", "verify-first"] {
            assert!(defaults::raw("diagnostics.shed_never").get(c).is_some(), "{c} must be in diagnostics.shed_never");
            let grace = defaults::raw("diagnostics.deadline_grace_ms").get(c).and_then(|v| v.as_integer()).unwrap_or(0) as u64;
            assert!(grace > 0 && grace <= defaults::num("diagnostics.deadline_grace_cap_ms") + 100, "{c} has a deadline grace");
        }
    }
}
