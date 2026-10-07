//! `compact-advice-guard` (Stop): ports the quiet case of `hooks/compact-advice-guard.js`.
//!
//! The Node guard blocks, once per declaration, a final reply that recommends compacting while the context is low or a
//! compact just happened. Almost no reply recommends compacting, so the engine settles that first: it reads the final
//! text the way Node does (`last_assistant_message`, else the current turn's assistant text from the transcript tail) and
//! allows when that text cannot hold any of the recommendation wordings. Those wordings all need a few fixed words (see
//! `ctxbudget.advice_*`), so a text without them has nothing for the phrase analysis to find. A text that might hold one
//! defers: the phrase analysis (quotes, negation, questions, retraction), the context rules, the sha1 once-per-declaration
//! state and the block all stay with the Node guard.
use super::{is_objectish, judge_child, settings_of, subagent_by_payload};
use crate::checks::Verdict;
use crate::checks::compact_decl::{contains_ci, read_tail, turn_texts};
use crate::checks::guardkit::settings::is_skipped;
use crate::checks::guardkit::text::js_trim;
use crate::defaults;
use crate::reqenv::RequestEnv;
use serde_json::Value;

/// Whether `text` holds the words of at least one recommendation wording (a necessary condition of `findAdvice`).
pub fn may_advise(text: &str) -> bool {
    let b = text.as_bytes();
    let has = |w: &str| contains_ci(b, w.as_bytes());
    let any = |key: &str| defaults::list(key).iter().any(|w| has(w));
    (has(defaults::text("ctxbudget.advice_safe_word")) && any("ctxbudget.advice_needs_safe"))
        || has(defaults::text("ctxbudget.advice_slash_compact"))
        || (has(defaults::text("ctxbudget.advice_good_word")) && any("ctxbudget.advice_needs_good"))
}

/// The check's decision on one payload.
pub fn decide(p: &Value, env: &RequestEnv) -> Verdict {
    if judge_child(env) {
        return Verdict::Allow;
    }
    let Some(st) = settings_of(env) else { return Verdict::Defer };
    if !super::setting::get(&st, defaults::raw("ctxbudget.set_compact_advice_guard")).flag() {
        return Verdict::Allow;
    }
    if !is_objectish(p) || subagent_by_payload(p) || p.get("stop_hook_active") == Some(&Value::Bool(true)) {
        return Verdict::Allow;
    }
    if is_skipped(&st, defaults::text("ctxbudget.skip_compact_advice")) {
        return Verdict::Allow;
    }
    let Some(path) = p.get("transcript_path").and_then(Value::as_str).filter(|s| !s.is_empty()) else { return Verdict::Allow };
    if !path.starts_with('/') {
        return Verdict::Defer; // Node resolves it against its own directory
    }
    let Some(lines) = read_tail(path, defaults::num("ctxbudget.tail_bytes")) else { return Verdict::Allow };
    let last = p.get("last_assistant_message").and_then(Value::as_str).unwrap_or("");
    if !js_trim(last).is_empty() {
        return if may_advise(last) { Verdict::Defer } else { Verdict::Allow };
    }
    // Without the last message the text is the turn's: a cheap exact test first (no wording word anywhere in the tail,
    // and no escape that could spell one), then the turn itself.
    let words = defaults::list("ctxbudget.advice_prefilter");
    if !lines.iter().any(|l| l.contains("\\u") || words.iter().any(|w| contains_ci(l.as_bytes(), w.as_bytes()))) {
        return Verdict::Allow;
    }
    match turn_texts(&lines) {
        Some(parts) if !may_advise(&parts.join("\n")) => Verdict::Allow,
        _ => Verdict::Defer,
    }
}

super::check_impl!(CompactAdviceGuard, "compact-advice-guard", "ctxbudget.summary_compact_advice", decide);
