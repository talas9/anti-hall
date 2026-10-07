//! Built-in `check = "speculation-judge"`: the off path of the Node speculation-judge (Stop; opt-in semantic judge).
//!
//! The Node hook asks a Claude model (the Anthropic Messages API or the local `claude -p` CLI) whether the reply states
//! something as fact that nothing in the session supports, and blocks once when the model says so. It is off unless
//! `jev.semanticJudge` is on (`ANTIHALL_SEMANTIC_JUDGE`), and then it does nothing at all: no read, no call, no cost.
//!
//! What is answered here and what is not:
//! - Answered here: the off switch, the judge-child guard (`ANTIHALL_JUDGE_CHILD=1`, the recursion stop) and the skip file.
//!   Both are an exit 0 with no output in Node, and they are the answer on every install that has not opted in.
//! - Deferred to Node: every opted-in call. The judge is a model call with its own backends (`api`, `cli`, `auto`), key
//!   resolution, prompt and 20 to 25 second budget, not the Jev client; porting it would change what a Stop costs and how
//!   it fails. The block stays exactly as strong as Node's because Node still makes it.
//!
//! Mirrors `hooks/speculation-judge.js` and `hooks/lib/judge-child-exit.js`.
use crate::checks::git::util::Settings;
use crate::checks::guardkit::settings::{get_bool, is_skipped};
use crate::checks::replykit::io::home_of;
use crate::checks::{Check, Verdict};
use crate::defaults;
use crate::reqenv::RequestEnv;
use crate::rules::Subject;
use serde_json::Value;

/// The registered `speculation-judge` check.
pub struct SpeculationJudge;

fn decide(env: &RequestEnv) -> Verdict {
    if env.get(defaults::text("speculation_judge.child_env")) == Some(defaults::text("speculation_judge.child_value")) {
        return Verdict::Allow;
    }
    let Some(home) = home_of(env) else { return Verdict::Defer };
    let st = Settings { home, env: env.to_map() };
    if !get_bool(&st, defaults::raw("speculation_judge.setting")) {
        return Verdict::Allow;
    }
    if is_skipped(&st, defaults::text("speculation_judge.guard_name")) {
        return Verdict::Allow;
    }
    Verdict::Defer
}

impl Check for SpeculationJudge {
    fn name(&self) -> &'static str {
        "speculation-judge"
    }

    fn summary(&self) -> &'static str {
        defaults::text("speculation_judge.summary")
    }

    fn run(&self, s: &Subject<'_>, _opts: &Value) -> Option<Verdict> {
        (s.event == defaults::text("speculation_judge.event")).then_some(Verdict::Defer)
    }

    fn run_env(&self, s: &Subject<'_>, _payload: &Value, _opts: &Value, env: &RequestEnv) -> Option<Verdict> {
        (s.event == defaults::text("speculation_judge.event")).then(|| decide(env))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> RequestEnv {
        let mut all = vec![("HOME", "/nonexistent-ah-home")];
        all.extend_from_slice(pairs);
        RequestEnv::from_pairs(all)
    }

    #[test]
    fn off_by_default_and_for_the_judge_child() {
        assert_eq!(decide(&env(&[])), Verdict::Allow);
        assert_eq!(decide(&env(&[("ANTIHALL_SEMANTIC_JUDGE", "0")])), Verdict::Allow);
        assert_eq!(decide(&env(&[("ANTIHALL_JUDGE_CHILD", "1"), ("ANTIHALL_SEMANTIC_JUDGE", "1")])), Verdict::Allow);
    }

    #[test]
    fn opted_in_defers_to_the_node_hook() {
        assert_eq!(decide(&env(&[("ANTIHALL_SEMANTIC_JUDGE", "1")])), Verdict::Defer);
        assert_eq!(decide(&env(&[("ANTIHALL_JUDGE_CHILD", "0"), ("ANTIHALL_SEMANTIC_JUDGE", "true")])), Verdict::Defer);
    }

    #[test]
    fn a_request_without_a_home_defers() {
        assert_eq!(decide(&RequestEnv::from_pairs([("ANTIHALL_SEMANTIC_JUDGE", "0")])), Verdict::Defer);
    }
}
