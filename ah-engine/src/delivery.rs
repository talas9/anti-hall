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
    static DECIDED: RefCell<Vec<(String, String, Ctx)>> = const { RefCell::new(Vec::new()) };
}

/// One armed check of a session.
struct Armed {
    check: String,
    ctx: Ctx,
    calls: u64,
    since_ms: u64,
}

/// A check's acted-on condition (`delivery.act`, else `delivery.react`).
struct Cond {
    tools: Vec<&'static str>,
    /// True: the reaction is NOT calling one of `tools` within the window.
    avoid: bool,
    window: u64,
    window_event: &'static str,
}

static PENDING: Mutex<Option<HashMap<String, Vec<Armed>>>> = Mutex::new(None);

/// Count one answer at a stage: in the unsplit `delivery_stage` series (label `which`) and in the funnel split (label `funnel_which`).
fn stage(t: &Telemetry, check: &str, which: &str, funnel_which: &str, ctx: &Ctx) {
    t.with_metrics(|m| m.inc("delivery_stage", &[("check", check), ("stage", defaults::text(which))]));
    funnel::stage(t, check, ctx, funnel_which);
}

/// A check answered with a message or a block while this thread served a request; `ctx` is whose session and project it was.
pub fn decided(t: &Telemetry, session: &str, check: &str, ctx: &Ctx) {
    stage(t, check, "delivery.stage_decided", "delivery.stage_decided", ctx);
    DECIDED.with(|d| d.borrow_mut().push((session.to_string(), check.to_string(), ctx.clone())));
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
    for (session, check, ctx) in answers {
        if !delivered {
            t.with_metrics(|m| m.inc("delivery_lost", &[("check", check.as_str()), ("reason", defaults::text("delivery.reason_undelivered"))]));
            funnel::stage(t, &check, &ctx, "delivery.stage_lost");
            continue;
        }
        stage(t, &check, "delivery.stage_delivered", "delivery.stage_delivered", &ctx);
        arm(&session, &check, ctx);
    }
}

fn react_tools(check: &str) -> Option<Vec<&'static str>> {
    defaults::raw("delivery.react").get(check).map(defaults::V::strings)
}

/// The acted-on condition of `check`: its `delivery.act` row, else its `delivery.react` row (tool calls, polarity do), else none.
fn cond(check: &str) -> Option<Cond> {
    let (calls, event) = (defaults::num("delivery.react_window_calls"), defaults::text("delivery.react_event"));
    if let Some(row) = defaults::raw("delivery.act").get(check) {
        return Some(Cond {
            tools: row.get("tools").map(defaults::V::strings).unwrap_or_default(),
            avoid: row.str_field("polarity") == defaults::text("delivery.polarity_avoid"),
            window: row.get("window").and_then(defaults::V::as_integer).map_or(calls, |n| n.max(1) as u64),
            window_event: row.get("window_event").and_then(defaults::V::as_str).unwrap_or(event),
        });
    }
    react_tools(check).map(|tools| Cond { tools, avoid: false, window: calls, window_event: event })
}

fn arm(session: &str, check: &str, ctx: Ctx) {
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
        list.push(Armed { check: check.to_string(), ctx, calls: 0, since_ms: crate::health::now_ms() });
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
    if session.is_empty() {
        return;
    }
    let mut g = PENDING.lock().unwrap_or_else(|e| e.into_inner());
    let Some(list) = g.as_mut().and_then(|m| m.get_mut(session)) else { return };
    let (max_age, react_event) = (defaults::num("delivery.react_window_ms"), defaults::text("delivery.react_event"));
    let now = crate::health::now_ms();
    let mut results: Vec<(String, Ctx, bool)> = Vec::new();
    list.retain_mut(|a| {
        let Some(c) = cond(&a.check) else { return false }; // its row left the defaults on a reload: nothing to measure
        if event == c.window_event {
            a.calls += 1;
        }
        let hit = event == react_event && c.tools.contains(&tool);
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
}

/// The ledger as `status` shows it: per check the counts of every stage (a stage never reached is 0; `complied` and `ignored` are
/// `null` for a check with no `delivery.react` row), and the spills per event.
pub fn status(t: &Telemetry) -> serde_json::Value {
    use serde_json::{Map, Value, json};
    let snap = t.with_metrics(|m| m.snapshot(""));
    let (decided, delivered, complied, ignored) = (
        defaults::text("delivery.stage_decided"),
        defaults::text("delivery.stage_delivered"),
        defaults::text("delivery.stage_complied"),
        defaults::text("delivery.stage_ignored"),
    );
    let shed = defaults::text("delivery.reason_shed");
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
                let shed_reason = label("reason") == shed;
                let row = checks.entry(label("check")).or_default();
                if shed_reason {
                    row.shed += n;
                } else {
                    row.lost += n;
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
    let never: Vec<&str> = defaults::raw("diagnostics.shed_never").as_table().map(|t| t.iter().map(|(k, _)| *k).collect()).unwrap_or_default();
    let mut essential_shed = 0u64;
    let rows: Map<String, Value> = checks
        .into_iter()
        .map(|(check, r)| {
            let measured = cond(&check).is_some();
            let (dec, del, com, ign, shd, lost) = (r.decided, r.delivered, r.complied, r.ignored, r.shed, r.lost);
            if never.contains(&check.as_str()) {
                essential_shed += shd;
            }
            let row = json!({
                "decided": dec, "delivered": del,
                "complied": if measured { json!(com) } else { Value::Null },
                "acted_on": if measured { json!(com) } else { Value::Null },
                "ignored": if measured { json!(ign) } else { Value::Null },
                "shed": shd, "lost": lost, "suppressed": r.suppressed,
            });
            (check, row)
        })
        .collect();
    let funnel = t.with_metrics(|m| m.export());
    let totals = funnel::report(&funnel, None, true, &[], None).get("funnel").and_then(|f| f.get("totals")).cloned().unwrap_or_default();
    json!({
        "per_check": rows, "essential_shed": essential_shed, "spills_by_event": spills, "pinned_spills": pinned_spills,
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

    /// R-claim: both claim checks are acted on by a lookup before the next Stop and ignored by a Stop with none.
    #[test]
    fn the_claim_and_hedge_checks_are_acted_on_by_a_lookup_before_the_next_stop_and_ignored_without_one() {
        for check in ["claim-evidence-guard", "speculation-guard"] {
            let t = Telemetry::new();
            let (acted, ignored) = ("delivery.stage_acted_on", "delivery.stage_ignored");
            deliver(&t, "s-ignored", check);
            observe(&t, "s-ignored", "Stop", "");
            assert_eq!((funnel_count(&t, check, &ctx(), acted), funnel_count(&t, check, &ctx(), ignored)), (0, 1), "{check}: a Stop with no lookup");
            for tool in ["Read", "Grep", "Bash"] {
                let s = format!("s-acted-{tool}");
                deliver(&t, &s, check);
                observe(&t, &s, defaults::text("delivery.react_event"), tool);
                observe(&t, &s, "Stop", "");
            }
            assert_eq!((funnel_count(&t, check, &ctx(), acted), funnel_count(&t, check, &ctx(), ignored)), (3, 1), "{check}: a lookup before the Stop");
        }
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

    #[test]
    fn the_essential_reminders_are_never_shed_and_their_grace_stays_under_the_cap() {
        for c in ["task-tracker", "tasklist-guard", "devswarm-parent-inbox", "devswarm-child-gate", "verify-first"] {
            assert!(defaults::raw("diagnostics.shed_never").get(c).is_some(), "{c} must be in diagnostics.shed_never");
            let grace = defaults::raw("diagnostics.deadline_grace_ms").get(c).and_then(|v| v.as_integer()).unwrap_or(0) as u64;
            assert!(grace > 0 && grace <= defaults::num("diagnostics.deadline_grace_cap_ms") + 100, "{c} has a deadline grace");
        }
    }
}
