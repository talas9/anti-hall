//! Notice turns (`context.injectGateNoticeTurns`): a UserPromptSubmit whose prompt is not the owner typing but a harness notice
//! (a task notification, the mesh inbox tick, a goal check-in, a message from another session or a teammate). The pure
//! per-prompt reminders (`notice_turn.skip_checks`) say nothing new on such a turn, so with the switch on the planner drops them
//! before they run, as a `when` predicate would (nothing is decided, nothing is lost).
//!
//! The kind of a prompt is counted whether or not the switch is on (`notice_turn_matched{kind}`), so the share of notice turns is
//! measured before the switch is turned on; only the drop and `notice_turn_skipped{kind,check}` need the switch. The plan is made in
//! the hook client, a process of its own, so the planner does not bump a counter there (it would die with the process): it notes what
//! it saw in [`Seen`], the request carries that to the daemon (`Meta::notice`), and the daemon counts it ([`count`]). Every pattern is
//! anchored at the start of the prompt, so a human sentence that merely mentions a notice never matches. The patterns, the events,
//! the prompt window and the skipped checks are all in `defaults/notice_turn.toml`. Fails open: an unreadable pattern matches nothing.
use crate::checks::git::util::Settings;
use crate::checks::guardkit::settings::get_bool;
use crate::defaults;
use crate::metrics::Metrics;
use crate::reqenv::RequestEnv;
use serde_json::Value;

/// What the planner saw of a notice turn: its kind and the dispatch entries it dropped (switch on). Rides the request to the daemon.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Seen {
    /// The kind name (a key of `notice_turn.kinds`).
    pub kind: String,
    /// The ids of the entries dropped from the plan (a variant suffix may be on them).
    #[serde(default)]
    pub skipped: Vec<String>,
}

/// The compiled kind table: (kind name, pattern), in the table's order.
fn kinds() -> std::sync::Arc<Vec<(&'static str, regex::Regex)>> {
    static RE: defaults::Cache<Vec<(&'static str, regex::Regex)>> = defaults::Cache::new();
    RE.get_or_init(|| {
        defaults::raw("notice_turn.kinds")
            .as_table()
            .unwrap_or(&[])
            .iter()
            .filter_map(|(name, v)| {
                let re = regex::RegexBuilder::new(v.as_str()?).case_insensitive(true).build().ok()?;
                Some((*name, re))
            })
            .collect()
    })
}

/// The entry id without its variant suffix (`name:host=claude`, `name#2`).
fn base(id: &str) -> &str {
    id.split([':', '#']).next().unwrap_or(id)
}

/// The kind of notice turn this occurrence is, when `event` is listed and the payload's prompt is a string; the first kind of the
/// table whose pattern matches the first `notice_turn.prompt_chars` characters wins (the caller records it in [`Seen`], whatever the
/// switch says). `None` for a human prompt, an unlisted event or a payload without a string prompt.
pub fn kind_of(event: &str, payload: &Value) -> Option<&'static str> {
    if !defaults::list("notice_turn.events").contains(&event) {
        return None;
    }
    let prompt = payload.get("prompt")?.as_str()?;
    let head: String = prompt.chars().take(defaults::num("notice_turn.prompt_chars") as usize).collect();
    kinds().iter().find(|(_, re)| re.is_match(&head)).map(|(name, _)| *name)
}

/// Whether `context.injectGateNoticeTurns` is on for this request.
pub fn enabled(env: &RequestEnv) -> bool {
    get_bool(&Settings::from_env(env), defaults::raw("notice_turn.sw_main"))
}

/// Whether the dispatch entry `id` (a variant suffix is ignored) is one of `notice_turn.skip_checks`.
pub fn skips(id: &str) -> bool {
    defaults::list("notice_turn.skip_checks").contains(&base(id))
}

/// The daemon's side: add one `notice_turn_matched{kind}` and one `notice_turn_skipped{kind,check}` per dropped check. Only a kind of
/// `notice_turn.kinds` and a check of `notice_turn.skip_checks` is counted, so a request cannot make up a series.
pub fn count(m: &mut Metrics, seen: &Seen) {
    let Some(kind) = kinds().iter().map(|(name, _)| *name).find(|name| *name == seen.kind) else {
        return;
    };
    m.inc("notice_turn_matched", &[("kind", kind)]);
    let listed = defaults::list("notice_turn.skip_checks");
    for id in &seen.skipped {
        if let Some(check) = listed.iter().find(|c| **c == base(id)) {
            m.inc("notice_turn_skipped", &[("kind", kind), ("check", check)]);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn matched(prompt: &str) -> Option<&'static str> {
        kind_of("UserPromptSubmit", &json!({"prompt": prompt}))
    }

    #[test]
    fn notice_turn_each_kind_matches_its_real_shape() {
        let tick = "/Users/someone/.anti-hall/ah-engine/bin/ah-engine mesh inbox tick primary-xxxx --quiet";
        let cases = [
            ("<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>", "notification"),
            ("  <system-reminder>\n<task-notification>\n<task-id>b1</task-id>", "notification"),
            (tick, "mesh_tick"),
            ("ah-engine mesh inbox tick primary-xxxx --quiet", "mesh_tick"),
            ("Goal check-in: is the goal still on track?", "goal_checkin"),
            ("<cross-session-message from=\"abc\">hello</cross-session-message>", "peer"),
            ("Another Claude session sent a message: hello", "peer"),
            ("<teammate-message teammate_id=\"w1\">done</teammate-message>", "teammate"),
        ];
        for (prompt, kind) in cases {
            assert_eq!(matched(prompt), Some(kind), "{prompt}");
        }
    }

    #[test]
    fn notice_turn_human_prompts_do_not_match() {
        for prompt in [
            "do the thing",
            "why does the mesh inbox tick fail",
            "please check Goal check-in: later",
            "what is a <task-notification> in the transcript?",
            "run /Users/someone/.anti-hall/ah-engine/bin/ah-engine mesh inbox tick primary-xxxx --quiet for me",
            "",
        ] {
            assert_eq!(matched(prompt), None, "{prompt}");
        }
    }

    #[test]
    fn notice_turn_needs_a_listed_event_and_a_string_prompt() {
        let p = json!({"prompt": "<task-notification>x"});
        assert_eq!(kind_of("Stop", &p), None);
        assert_eq!(kind_of("UserPromptSubmit", &json!({"prompt": 5})), None);
        assert_eq!(kind_of("UserPromptSubmit", &json!({})), None);
    }

    #[test]
    fn notice_turn_only_the_head_of_the_prompt_is_read() {
        let pad = " ".repeat(defaults::num("notice_turn.prompt_chars") as usize);
        assert_eq!(matched(&format!("{pad}<task-notification>x")), None);
    }

    #[test]
    fn notice_turn_skip_checks_are_dispatch_entries_and_ignore_a_variant_suffix() {
        let ids: Vec<String> = crate::dispatch::table::entries("claude", "UserPromptSubmit").into_iter().map(|e| e.id).collect();
        for want in defaults::list("notice_turn.skip_checks") {
            assert!(ids.iter().any(|i| base(i) == want), "{want} is not a UserPromptSubmit entry");
        }
        assert!(skips("verify-first") && skips("task-tracker#2") && skips("switch-notice:host=claude"));
        assert!(!skips("idle-agent-sweep") && !skips("agent-reminders") && !skips("devswarm-parent-inbox") && !skips("auto-handover"));
    }

    #[test]
    fn notice_turn_the_daemon_counts_only_listed_kinds_and_checks() {
        let seen = |kind: &str, skipped: &[&str]| Seen { kind: kind.into(), skipped: skipped.iter().map(|s| s.to_string()).collect() };
        let mut m = Metrics::default();
        count(&mut m, &seen("peer", &["verify-first", "task-tracker#2", "idle-agent-sweep", "made-up"]));
        count(&mut m, &seen("not-a-kind", &["verify-first"]));
        let v = |name: &str, l: &[(&str, &str)]| m.counter(name, l);
        assert_eq!(v("notice_turn_matched", &[("kind", "peer")]), 1);
        assert_eq!(v("notice_turn_skipped", &[("kind", "peer"), ("check", "verify-first")]), 1);
        assert_eq!(v("notice_turn_skipped", &[("kind", "peer"), ("check", "task-tracker")]), 1, "a variant suffix is ignored");
        assert_eq!(v("notice_turn_skipped", &[("kind", "peer"), ("check", "idle-agent-sweep")]), 0, "a check outside the list is not counted");
        assert_eq!(v("notice_turn_matched", &[("kind", "not-a-kind")]) + v("notice_turn_skipped", &[("kind", "not-a-kind"), ("check", "verify-first")]), 0);
    }

    #[test]
    fn notice_turn_every_pattern_compiles() {
        let n = defaults::raw("notice_turn.kinds").as_table().map_or(0, <[_]>::len);
        assert!(n >= 5 && kinds().len() == n);
    }

    #[test]
    fn notice_turn_the_switch_is_off_unless_set() {
        assert!(!enabled(&RequestEnv::default()));
        assert!(enabled(&RequestEnv::from_pairs([("ANTIHALL_NOTICE_TURNS", "1")])));
    }
}
