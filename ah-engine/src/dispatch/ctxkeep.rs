//! The per-event context budget (plan v3 L12 / C2, `context.injectGateNoSpill`): model-facing text is dropped by priority, never
//! moved into a file.
//!
//! Three writers move a hook's `additionalContext` out of the answer into a private file and leave a pointer line: the prompt digest
//! ([`super::digest`]), the SessionStart shrink ([`super::shrink`]) and the over-cap join spill ([`super::spill`]). A file the model
//! must Read is not delivery. With the switch on, an event in `ctx_keep.events` instead keeps its contexts within
//! `ctx_keep.chars_by_event`: while the joined contexts are over the budget, the one with the lowest `dispatch.context_priority` is
//! dropped (ties: the longest, then the latest). A context at or above `dispatch.context_pin_priority` is never dropped; when the
//! pinned ones alone are over the budget they stay whole, `ctx_keep_pinned_over` counts it and the host's own cap applies as today.
//! Blocks, decisions and every other field of an answer are untouched. No state: the result is a function of one call's results.
//! Every number, list and text is in `ctx_keep.toml`; the three writers above return early for a covered event.
use super::combine;
use crate::checks::git::util::Settings;
use crate::checks::guardkit::settings::get_bool;
use crate::reqenv::RequestEnv;
use crate::{defaults, health, metrics};

/// Whether the switch `context.injectGateNoSpill` is on for this request.
pub fn on(env: &RequestEnv) -> bool {
    get_bool(&Settings::from_env(env), defaults::raw("ctx_keep.sw_main"))
}

/// Whether the budget replaces the digest, the shrink and the spill for `event`: the switch is on and the event is listed.
pub fn covers(event: &str, env: &RequestEnv) -> bool {
    defaults::list("ctx_keep.events").contains(&event) && on(env)
}

/// The entry id without its variant suffix (`name:host=claude`, `name#2`).
fn base(id: &str) -> &str {
    id.split([':', '#']).next().unwrap_or(id)
}

struct Cand {
    idx: usize,
    chars: usize,
    pri: i64,
    live: bool,
}

/// Drop the lowest-priority contexts of `results` until the event's contexts fit `ctx_keep.chars_by_event`, in place.
pub fn apply(event: &str, env: &RequestEnv, results: &mut super::spill::Results) {
    if !covers(event, env) {
        return;
    }
    let Some(budget) = defaults::raw("ctx_keep.chars_by_event").get(event).and_then(|v| v.as_integer()) else { return };
    let budget = budget.max(0) as usize;
    let joiner = defaults::text("dispatch.context_joiner").chars().count();
    let pin = defaults::num("dispatch.context_pin_priority") as i64;
    let mut cands: Vec<Cand> = Vec::new();
    for (idx, r) in results.iter().enumerate() {
        if r.code != Some(0) || combine::blocks(r) {
            continue;
        }
        let Some(ctx) = combine::context_of(&r.out).filter(|c| !c.is_empty()) else { continue };
        cands.push(Cand { idx, chars: ctx.chars().count(), pri: super::spill::priority(&r.id), live: true });
    }
    let total_of = |cands: &[Cand]| {
        let live = cands.iter().filter(|c| c.live);
        live.clone().map(|c| c.chars).sum::<usize>() + joiner * live.count().saturating_sub(1)
    };
    let (mut n, mut dropped_chars) = (0usize, 0usize);
    let mut ids: Vec<String> = Vec::new();
    while total_of(&cands) > budget {
        // lowest priority first; among equals the longest, then the latest
        let pick = cands
            .iter()
            .enumerate()
            .filter(|(_, c)| c.live && c.pri < pin)
            .min_by_key(|(i, c)| (c.pri, std::cmp::Reverse(c.chars), std::cmp::Reverse(*i)))
            .map(|(i, _)| i);
        let Some(i) = pick else {
            metrics::bump_shared("ctx_keep_pinned_over", &[("event", event)]);
            break;
        };
        let Some(c) = cands.get_mut(i) else { break };
        let Some(r) = results.get_mut(c.idx) else { break };
        let Some(out) = combine::with_context(&r.out, "") else {
            c.live = false; // keep: a context that cannot be rewritten stays as it is and no longer counts as droppable
            continue;
        };
        c.live = false;
        let check = base(&r.id).to_string();
        r.out = combine::tidy(&out);
        metrics::bump_shared("ctx_keep_dropped", &[("event", event), ("check", &check)]);
        metrics::bump_by_shared("ctx_keep_dropped_chars", &[("event", event)], c.chars as u64);
        n += 1;
        dropped_chars += c.chars;
        ids.push(check);
    }
    if n > 0 {
        health::log_event(
            "dispatch_ctx_dropped",
            event,
            &defaults::render("ctx_keep.msg_dropped", &[("n", &n), ("chars", &dropped_chars), ("ids", &ids.join(","))]),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::combine::HookResult;
    use super::*;

    fn r(id: &str, ctx: &str) -> HookResult {
        let out = format!("{}\n", serde_json::json!({ "hookSpecificOutput": { "hookEventName": "UserPromptSubmit", "additionalContext": ctx } }));
        HookResult { id: id.into(), code: Some(0), out, err: String::new() }
    }

    fn ctx(r: &HookResult) -> Option<String> {
        combine::context_of(&r.out)
    }

    fn env_with(on: bool) -> RequestEnv {
        let home = std::env::temp_dir().join(format!("ahd-ctxkeep-{}-{}", std::process::id(), on));
        std::fs::create_dir_all(home.join(".anti-hall")).unwrap();
        std::fs::write(home.join(".anti-hall/settings.json"), format!(r#"{{"context":{{"injectGateNoSpill":{on}}}}}"#)).unwrap();
        RequestEnv::from_pairs([("HOME", home.to_string_lossy().to_string())])
    }

    fn big(id: &str, n: usize) -> HookResult {
        r(id, &"x".repeat(n))
    }

    #[test]
    fn ctx_keep_the_lowest_priority_goes_first_and_pinned_stay() {
        let env = env_with(true);
        // verify-first 95 (pinned), defect-nudge 40, jev-weekly-scorecard 10; the budget is 3000
        let mut v = vec![big("verify-first", 1500), big("defect-nudge", 1200), big("jev-weekly-scorecard", 1200)];
        apply("UserPromptSubmit", &env, &mut v);
        assert!(ctx(v.first().unwrap()).is_some(), "pinned stays");
        assert!(ctx(v.get(1).unwrap()).is_some(), "the middle one fits once the lowest is gone");
        assert_eq!(v.get(2).unwrap().out, "", "the lowest priority is dropped and tidy leaves nothing");
    }

    #[test]
    fn ctx_keep_a_tie_drops_the_longest_then_the_latest() {
        let env = env_with(true);
        let mut v = vec![big("gh-rt-advisory", 1000), big("procwatch-advisory", 2500)];
        apply("UserPromptSubmit", &env, &mut v);
        assert!(ctx(v.first().unwrap()).is_some() && v.get(1).unwrap().out.is_empty(), "same priority 30: the longest goes");
        let mut v = vec![big("gh-rt-advisory", 2000), big("procwatch-advisory", 2000)];
        apply("UserPromptSubmit", &env, &mut v);
        assert!(ctx(v.first().unwrap()).is_some() && v.get(1).unwrap().out.is_empty(), "same priority and length: the latest goes");
    }

    #[test]
    fn ctx_keep_pinned_contexts_are_never_dropped_even_over_the_budget() {
        let env = env_with(true);
        let mut v = vec![big("verify-first", 2500), big("rule-digest", 2500)];
        let before: Vec<String> = v.iter().map(|x| x.out.clone()).collect();
        apply("UserPromptSubmit", &env, &mut v);
        assert_eq!(v.iter().map(|x| x.out.clone()).collect::<Vec<_>>(), before);
        assert!(metrics::bumped_on_this_thread("ctx_keep_pinned_over", &[("event", "UserPromptSubmit")]) >= 1);
    }

    #[test]
    fn ctx_keep_blocks_and_other_events_and_the_switch_off_are_untouched() {
        let env = env_with(true);
        let mut blocked = r("defect-nudge", &"x".repeat(5000));
        blocked.out = format!(
            "{}\n",
            serde_json::json!({ "decision": "block", "reason": "no", "hookSpecificOutput": { "hookEventName": "UserPromptSubmit", "additionalContext": "x".repeat(5000) } })
        );
        let mut v = vec![blocked.clone(), big("jev-weekly-scorecard", 100)];
        apply("UserPromptSubmit", &env, &mut v);
        assert_eq!(v.first().unwrap().out, blocked.out, "a block is never touched");
        let mut v = vec![big("jev-weekly-scorecard", 9000)];
        let before = v.first().unwrap().out.clone();
        apply("PostToolUse", &env, &mut v);
        assert_eq!(v.first().unwrap().out, before, "an event outside ctx_keep.events");
        let off = env_with(false);
        let mut v = vec![big("jev-weekly-scorecard", 9000)];
        apply("UserPromptSubmit", &off, &mut v);
        let unchanged = big("jev-weekly-scorecard", 9000).out;
        assert_eq!(v.first().unwrap().out, unchanged, "the switch off is the identity");
    }

    #[test]
    fn ctx_keep_under_budget_is_the_identity_and_drops_are_counted() {
        let env = env_with(true);
        let mut v = vec![big("defect-nudge", 500), big("jev-weekly-scorecard", 500)];
        let before: Vec<String> = v.iter().map(|x| x.out.clone()).collect();
        apply("UserPromptSubmit", &env, &mut v);
        assert_eq!(v.iter().map(|x| x.out.clone()).collect::<Vec<_>>(), before);
        let mut v = vec![big("defect-nudge", 2000), big("jev-weekly-scorecard", 2000)];
        apply("UserPromptSubmit", &env, &mut v);
        assert_eq!(metrics::bumped_on_this_thread("ctx_keep_dropped", &[("event", "UserPromptSubmit"), ("check", "jev-weekly-scorecard")]), 1);
        assert_eq!(metrics::bumped_on_this_thread("ctx_keep_dropped_chars", &[("event", "UserPromptSubmit")]), 2000);
    }
}
