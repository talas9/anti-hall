//! Hook payload in -> hook output JSON out, for the events anti-hall uses.
//!
//! Claude Code and Codex send the same field names (`hook_event_name`, `session_id`, `cwd`,
//! `tool_name`, `tool_input`, `prompt`, `stop_hook_active`, ...), so one parser serves both; unknown
//! fields are ignored. Output shapes follow what `plugins/anti-hall/hooks/*.js` emit today:
//!
//! | event            | deny                                                    | warn / context                          |
//! |------------------|---------------------------------------------------------|-----------------------------------------|
//! | PreToolUse       | `hookSpecificOutput.permissionDecision:"deny"` + reason | `hookSpecificOutput.additionalContext`  |
//! | PostToolUse      | `{"decision":"block","reason"}`                         | `hookSpecificOutput.additionalContext`  |
//! | UserPromptSubmit | `{"decision":"block","reason"}`                         | `hookSpecificOutput.additionalContext`  |
//! | Stop             | `{"decision":"block","reason"}` (never if `stop_hook_active`) | `{"systemMessage"}`               |
//! | SessionStart / SubagentStart | n/a (treated as context)                    | `hookSpecificOutput.additionalContext`  |
use crate::checks::{self, Verdict};
use crate::defaults;
use crate::reqenv::RequestEnv;
use crate::rules::{Action, Budget, RuleSet, Subject};
use serde_json::{Value, json};

/// Reply-body prefix for a built-in check that blocks the way the Node guards do (exit 2, reason on stderr);
/// the rest of the body is the stderr text. JSON bodies start with `{`, so the two cannot be confused.
pub const EXIT2: &str = "AHEXIT 2\n";
/// Reply-body prefix for a built-in check whose answer is exact bytes ([`crate::checks::Exact`]); the rest of the body is
/// the JSON array `[exit code, stdout, stderr]`. JSON bodies start with `{`, so it cannot be confused with one.
pub const EXACT: &str = "AHEXACT ";
/// Reply body of a built-in check that must defer to the Node hook (the daemon turns it into an ERR frame).
pub const FALLBACK: &str = "AHFALLBACK";

/// Receives what happened while a payload was evaluated (checks run, rules matched). The daemon passes one that feeds
/// metrics and the impact ledger; everything else passes [`NoObserver`].
pub trait Observer {
    /// A built-in check ran: its name, the id of the rule that named it, what it decided and how long it took.
    fn check(&self, check: &str, rule_id: &str, verdict: &Verdict, micros: u64);
    /// A regex rule matched.
    fn rule(&self, rule_id: &str, action: Action);
}

/// An observer that ignores everything.
pub struct NoObserver;

impl Observer for NoObserver {
    fn check(&self, _: &str, _: &str, _: &Verdict, _: u64) {}
    fn rule(&self, _: &str, _: Action) {}
}

/// Event name from the payload (the first of `hook.event_keys` that is a string); `None` when absent.
pub fn event_of(p: &Value) -> Option<&str> {
    defaults::list("hook.event_keys").into_iter().find_map(|k| p.get(k).and_then(Value::as_str))
}

/// Evaluate `raw` (the stdin payload) against `rules`. Returns the JSON to print, or "" for "say nothing".
/// Never panics on malformed input: anything unparseable yields "".
pub fn respond(raw: &str, rules: &RuleSet) -> String {
    match serde_json::from_str::<Value>(raw) {
        Ok(p) => respond_value(&p, rules, &|| false).unwrap_or_default(),
        Err(_) => String::new(),
    }
}

/// `respond` on an already-parsed payload, abandoning the evaluation when `over()` turns true.
pub fn respond_value(p: &Value, rules: &RuleSet, over: &dyn Fn() -> bool) -> Result<String, Budget> {
    respond_observed(p, rules, over, &NoObserver, &RequestEnv::default())
}

/// `respond_value` that reports checks and rule matches to `obs`, and evaluates every check with `env`, the environment
/// the request carried (D76).
pub fn respond_observed(p: &Value, rules: &RuleSet, over: &dyn Fn() -> bool, obs: &dyn Observer, env: &RequestEnv) -> Result<String, Budget> {
    Ok(respond_inner(p, rules, over, obs, env)?.unwrap_or_default())
}

fn respond_inner(p: &Value, rules: &RuleSet, over: &dyn Fn() -> bool, obs: &dyn Observer, env: &RequestEnv) -> Result<Option<String>, Budget> {
    let r = |s: String| Ok(Some(s));
    let none = Ok(None);
    let Some(event) = event_of(p) else { return none };
    let null = Value::Null;
    let subject = Subject {
        event,
        tool: p.get("tool_name").and_then(Value::as_str),
        cwd: p.get("cwd").and_then(Value::as_str),
        tool_input: p.get("tool_input").unwrap_or(&null),
        prompt: p.get("prompt").and_then(Value::as_str),
    };
    let mut advisory: Option<String> = None;
    for rule in rules.rules.iter().filter(|x| x.check.is_some()) {
        if over() {
            return Err(Budget);
        }
        if !rule.in_scope(&subject) {
            continue;
        }
        let started = std::time::Instant::now();
        if let Some(o) = builtin(rule, &subject, p, env) {
            obs.check(rule.check.as_deref().unwrap_or(""), &rule.id, &o, started.elapsed().as_micros() as u64);
            match o {
                Verdict::Block(m) => return r(format!("{EXIT2}{m}\n")),
                Verdict::Advisory(j) => advisory = Some(j),
                Verdict::Exact(x) => return r(format!("{EXACT}{}", json!([x.code, x.out, x.err]))),
                Verdict::Defer => return r(FALLBACK.to_string()),
                Verdict::Allow => {}
            }
        }
    }
    let hits = rules.matching_budget(&subject, over)?;
    if hits.is_empty() {
        return Ok(advisory);
    }
    for h in &hits {
        obs.rule(&h.id, h.action);
    }
    let denies: Vec<&str> = hits.iter().filter(|r| r.action == Action::Deny).map(|r| r.message.as_str()).collect();
    let notes: Vec<String> = hits
        .iter()
        .filter(|r| r.action != Action::Deny)
        .map(|r| if r.action == Action::Warn { format!("{}{}", defaults::text("hook.warn_prefix"), r.message) } else { r.message.clone() })
        .collect();
    let deny_text = denies.join("\n");
    let note_text = notes.join("\n");
    let stop_active = p.get("stop_hook_active").and_then(Value::as_bool).unwrap_or(false);

    let out = match event {
        "PreToolUse" if !denies.is_empty() => {
            json!({"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":deny_text}})
        }
        "PostToolUse" | "UserPromptSubmit" if !denies.is_empty() => json!({"decision":"block","reason":deny_text}),
        "Stop" if !denies.is_empty() => {
            if stop_active {
                return none; // a continuing turn is never re-blocked (matches stop-policy.js)
            }
            json!({"decision":"block","reason":deny_text})
        }
        "PreToolUse" | "PostToolUse" | "UserPromptSubmit" | "SessionStart" | "SubagentStart" => {
            let text = if denies.is_empty() { note_text } else { format!("{deny_text}\n{note_text}") };
            if text.trim().is_empty() {
                return none;
            }
            json!({"hookSpecificOutput":{"hookEventName":event,"additionalContext":text}})
        }
        "Stop" if !note_text.is_empty() => json!({"systemMessage":note_text}),
        _ => return none,
    };
    r(out.to_string())
}

/// Run a built-in check by name; `None` when it is unknown or does not apply to this payload.
fn builtin(rule: &crate::rules::Rule, s: &Subject, payload: &Value, env: &RequestEnv) -> Option<Verdict> {
    checks::get(rule.check.as_deref()?)?.run_env(s, payload, &rule.options, env)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rs() -> RuleSet {
        RuleSet::parse(
            r#"{"version":1,"rules":[
              {"id":"d","events":["PreToolUse","PostToolUse","Stop","UserPromptSubmit"],"pattern":"BAD","action":"deny","message":"nope"},
              {"id":"c","pattern":"CTX","action":"context","message":"fyi"},
              {"id":"w","pattern":"WARN","action":"warn","message":"careful"}]}"#,
        )
        .unwrap()
    }
    fn v(s: String) -> Value {
        serde_json::from_str(&s).unwrap()
    }

    #[test]
    fn pre_tool_use_deny_shape() {
        let o = v(respond(r#"{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"x BAD"}}"#, &rs()));
        assert_eq!(o["hookSpecificOutput"]["hookEventName"], "PreToolUse");
        assert_eq!(o["hookSpecificOutput"]["permissionDecision"], "deny");
        assert_eq!(o["hookSpecificOutput"]["permissionDecisionReason"], "nope");
    }

    #[test]
    fn block_shapes_for_post_and_prompt() {
        for payload in [
            r#"{"hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":"BAD"}}"#,
            r#"{"hook_event_name":"UserPromptSubmit","prompt":"BAD"}"#,
        ] {
            let o = v(respond(payload, &rs()));
            assert_eq!(o["decision"], "block", "{payload}");
            assert_eq!(o["reason"], "nope");
        }
    }

    #[test]
    fn stop_blocks_once_and_respects_stop_hook_active() {
        let r = RuleSet::parse(r#"{"version":1,"rules":[{"events":["Stop"],"pattern":"","action":"deny","message":"finish"}]}"#).unwrap();
        let o = v(respond(r#"{"hook_event_name":"Stop"}"#, &r));
        assert_eq!(o["decision"], "block");
        assert_eq!(respond(r#"{"hook_event_name":"Stop","stop_hook_active":true}"#, &r), "");
    }

    #[test]
    fn context_events() {
        for e in ["SessionStart", "SubagentStart"] {
            let o = v(respond(
                &format!(r#"{{"hook_event_name":"{e}","tool_input":{{}}}}"#),
                &RuleSet::parse(r#"{"version":1,"rules":[{"pattern":"","action":"context","message":"hello"}]}"#).unwrap(),
            ));
            assert_eq!(o["hookSpecificOutput"]["hookEventName"], e);
            assert_eq!(o["hookSpecificOutput"]["additionalContext"], "hello");
        }
        let o = v(respond(r#"{"hook_event_name":"UserPromptSubmit","prompt":"CTX WARN"}"#, &rs()));
        assert_eq!(o["hookSpecificOutput"]["additionalContext"], "fyi\nanti-hall warning: careful");
    }

    #[test]
    fn stop_context_uses_system_message() {
        let r = RuleSet::parse(r#"{"version":1,"rules":[{"events":["Stop"],"pattern":"","action":"warn","message":"hm"}]}"#).unwrap();
        let o = v(respond(r#"{"hook_event_name":"Stop"}"#, &r));
        assert_eq!(o["systemMessage"], "anti-hall warning: hm");
    }

    #[test]
    fn codex_payload_shape_is_accepted() {
        // Codex adds turn_id/model and sends apply_patch with the patch text in tool_input.command
        let r = RuleSet::parse(r#"{"version":1,"rules":[{"tools":["apply_patch"],"pattern":"secret","action":"deny","message":"no secrets"}]}"#).unwrap();
        let o = v(respond(
            r#"{"session_id":"s","turn_id":"t","cwd":"/x","hook_event_name":"PreToolUse","model":"gpt-5","tool_name":"apply_patch","tool_input":{"command":"*** Begin Patch\n+secret=1"},"tool_use_id":"u"}"#,
            &r,
        ));
        assert_eq!(o["hookSpecificOutput"]["permissionDecision"], "deny");
    }

    #[test]
    fn malformed_or_unknown_yields_nothing() {
        for bad in ["", "not json", "[]", "{}", r#"{"hook_event_name":"PreCompact"}"#, r#"{"hook_event_name":"PreToolUse"}"#] {
            assert_eq!(respond(bad, &rs()), "", "{bad:?}");
        }
    }
}
