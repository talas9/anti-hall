//! `compact-advice-guard` (Stop): a port of `hooks/compact-advice-guard.js` with `hooks/lib/compact-advice.js`.
//!
//! The guard blocks, once per declaration, a final reply that recommends compacting while the context is low or a compact
//! just happened. Almost no reply recommends compacting, so the engine settles that first: it reads the final text the
//! way Node does (`last_assistant_message`, else the current turn's final assistant text from the transcript tail) and
//! allows when that text cannot hold any of the recommendation wordings (they all need a few fixed words, see
//! `ctxbudget.advice_*`). Otherwise the phrase analysis ([`super::phrase`]: quotes, negation, questions, retraction), the
//! context rules, the latch exception and the once-per-declaration record (`~/.anti-hall/compact-advice/<tag>.json`, a
//! plain write as in Node) run here too.
//!
//! Still deferred: a text holding `\r`, U+2028 or U+2029 (JavaScript's multiline anchors stop there, Rust's do not), a
//! transcript or state line only JavaScript's parser accepts, a date only V8's lenient parser reads, a relative transcript
//! path (Node resolves it against its own directory), a latch with a `__proto__` key.
use super::pct::{Pct, context_pct, write_inferred};
use super::phrase::{find_advice, has_foreign_line_end, last_retraction, read_turn};
use super::{hazard, is_objectish, judge_child, now_ms, settings_of, subagent_by_payload};
use crate::checks::Verdict;
use crate::checks::compact_decl::{contains_ci, read_tail, turn_texts};
use crate::checks::emit_dedupe::sha1_hex;
use crate::checks::guardkit::jsval::{Js, number_to_string};
use crate::checks::guardkit::msg::{self, Kind, Parts};
use crate::checks::guardkit::settings::is_skipped;
use crate::checks::guardkit::text::js_trim;
use crate::checks::jsport::date::ZoneGuard;
use crate::checks::replykit::json::quote;
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
        if !may_advise(last) {
            return Verdict::Allow;
        }
    } else {
        // Without the last message the text is the turn's final part: a cheap exact test first (no wording word anywhere in
        // the tail, and no escape that could spell one), then the whole turn's text (a superset of the final part).
        let words = defaults::list("ctxbudget.advice_prefilter");
        if !lines.iter().any(|l| l.contains("\\u") || words.iter().any(|w| contains_ci(l.as_bytes(), w.as_bytes()))) {
            return Verdict::Allow;
        }
        if turn_texts(&lines).is_some_and(|parts| !may_advise(&parts.join("\n"))) {
            return Verdict::Allow;
        }
    }
    let _zone = ZoneGuard::new(env);
    match judge(p, &st, path, &lines, last) {
        Ok(v) => v,
        Err(()) => Verdict::Defer,
    }
}

/// `main()` from the turn reading on. `Err` = defer, always before any write.
fn judge(p: &Value, st: &crate::checks::git::util::Settings, path: &str, lines: &[String], last: &str) -> Result<Verdict, ()> {
    let turn = read_turn(lines)?;
    let final_text = if js_trim(last).is_empty() { turn.final_text.as_str() } else { last };
    if !may_advise(final_text) {
        return Ok(Verdict::Allow);
    }
    if has_foreign_line_end(final_text) {
        return Err(());
    }
    let found = find_advice(final_text);
    let Some((index, phrase)) = found.last() else { return Ok(Verdict::Allow) };
    if last_retraction(final_text).is_some_and(|r| r > *index) {
        return Ok(Verdict::Allow);
    }
    let r = match context_pct(st, p.get("session_id"), Some(path), Some(lines)) {
        Pct::Defer => return Err(()),
        Pct::None => None,
        Pct::Reading(r) => Some(r),
    };
    // getContextPct records the inferred window whatever the guard then decides
    let inferred = r.as_ref().is_some_and(|r| r.infer_write);
    let pct = r.map(|r| r.pct).filter(|x| x.is_finite());
    let threshold = super::setting::get(st, defaults::raw("ctxbudget.set_ah_pct")).num();
    let margin = super::setting::get(st, defaults::raw("ctxbudget.set_ca_margin")).num();
    let window = super::setting::get(st, defaults::raw("ctxbudget.set_ca_recent")).num();
    let low = pct.is_some_and(|x| x < threshold - margin);
    let recent = window > 0.0 && turn.turns_since_compact.is_some_and(|n| n <= window);
    let done = |v: Verdict| {
        if inferred {
            write_inferred(st, p.get("session_id"));
        }
        Ok(v)
    };
    if !low && !recent {
        return done(Verdict::Allow);
    }
    // the threshold-fired handover may declare SAFE
    let Some(tag) = super::handover::session_tag(p) else { return done(Verdict::Allow) };
    let latch = super::handover::read_latch(st, &tag)?;
    let fired = latch.get("fired") == Some(&Js::Bool(true));
    let fired_at = latch.get("firedAt").and_then(Js::as_f64).filter(|f| f.is_finite());
    let compact_after_fire = turn.turns_since_compact.is_some() && (turn.compact_at.is_none() || fired_at.is_none_or(|f| turn.compact_at.is_some_and(|c| c >= f)));
    let tokens_fired = fired && latch.get("firedVia").and_then(Js::as_str).is_some_and(|v| defaults::list("ctxbudget.ca_tokens_vias").contains(&v));
    if fired && (!low || tokens_fired) && !compact_after_fire {
        return done(Verdict::Allow);
    }
    let hash = sha1_hex(final_text.as_bytes());
    let sp = format!("{}/{}/{}/{tag}.json", st.home, defaults::text("ctxbudget.state_root"), defaults::text("ctxbudget.ca_state_dir"));
    if let Ok(bytes) = std::fs::read(&sp) {
        let text = String::from_utf8_lossy(&bytes);
        match serde_json::from_str::<Value>(&text) {
            Ok(prev) if prev.get("hash").and_then(Value::as_str) == Some(hash.as_str()) => return done(Verdict::Allow),
            Ok(_) => {}
            Err(_) if hazard(&text) => return Err(()),
            Err(_) => {}
        }
    }
    if inferred {
        write_inferred(st, p.get("session_id"));
    }
    let body = msg::render("ctxbudget.ca_state_json", &[("hash", &quote(&hash)), ("at", &number_to_string(now_ms()))]);
    let wrote = std::path::Path::new(&sp).parent().is_none_or(|d| std::fs::create_dir_all(d).is_ok()) && std::fs::write(&sp, body).is_ok();
    if !wrote {
        return Ok(Verdict::Allow); // cannot record the block: never block (no loop)
    }
    let mut why = vec![match pct {
        Some(x) => msg::render("ctxbudget.ca_why_pct", &[("pct", &super::text::round_str(x)), ("threshold", &number_to_string(threshold))]),
        None => defaults::text("ctxbudget.ca_why_unknown").to_string(),
    }];
    if recent && let Some(n) = turn.turns_since_compact {
        let key = if n == 0.0 {
            "ctxbudget.ca_recent_now"
        } else if n == 1.0 {
            "ctxbudget.ca_recent_one"
        } else {
            "ctxbudget.ca_recent_n"
        };
        why.push(msg::render(key, &[("n", &number_to_string(n))]));
    }
    let what = msg::render("ctxbudget.ca_what", &[("phrase", phrase), ("why", &why.join(defaults::text("ctxbudget.ca_why_join")))]);
    let ctx = match pct {
        Some(x) => msg::render("ctxbudget.ca_ctx_pct", &[("pct", &super::text::round_str(x))]),
        None => defaults::text("ctxbudget.ca_ctx_low").to_string(),
    };
    let instead = msg::render("ctxbudget.ca_instead", &[("ctx", &ctx)]);
    let reason = msg::message(Kind::Block, defaults::text("ctxbudget.ca_guard"), &Parts { what: &what, why: defaults::text("ctxbudget.ca_why"), instead: &instead, ..Parts::default() });
    Ok(Verdict::Exact(crate::checks::Exact { code: 0, out: msg::render("ctxbudget.stop_block_line", &[("reason", &quote(&reason))]), err: String::new() }))
}

super::check_impl!(CompactAdviceGuard, "compact-advice-guard", "ctxbudget.summary_compact_advice", decide);
