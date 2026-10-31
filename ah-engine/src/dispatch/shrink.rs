//! Per-hook inline caps (the token cut for events that re-send context, SessionStart above all).
//!
//! A hook's `additionalContext` over its inline cap is not sent whole: the model gets a one-line summary and the path of a file
//! that holds the full text (nothing is cut, every character is either inline or in the file; the owner rule is spill, never
//! truncate). The file is read on demand, so a context the model rarely needs costs a line, not thousands of characters, at every
//! start, resume and compaction. After the per-hook step, an event whose contexts still total more than the event cap has its
//! largest shrinkable contexts replaced the same way until it fits. Hooks listed in `context_size.never` keep their text whole (a
//! behavioural block such as the verify-first protocol manages its own size). Every number, list and text is in `context_size.toml`.
//!
//! Independent of the join-time spill ([`super::spill`]), which handles what is still over the host's cap after this step. Fails open
//! everywhere: a file that cannot be written leaves every context as the hooks printed it.
use super::combine::{self, HookResult};
use crate::checks::git::util::Settings;
use crate::checks::guardkit::settings::{get_bool, get_number};
use crate::reqenv::RequestEnv;
use crate::{defaults, health};
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;

/// The entry id without its variant suffix (`name:host=claude`, `name#2`).
fn base(id: &str) -> &str {
    id.split([':', '#']).next().unwrap_or(id)
}

/// Whether the hook entry `id` is pinned: its `dispatch.context_priority` is at or above `dispatch.context_pin_priority`.
fn pinned(id: &str) -> bool {
    super::spill::priority(id) >= defaults::num("dispatch.context_pin_priority") as i64
}

/// The inline cap of the hook entry `id`: `None` = never shrunk, `Some(0)` = no per-hook cap (only the event total applies). With
/// `keep_pinned` (`context_size.sw_keep_pinned`) a pinned entry without its own `context_size.hook_caps` row is never shrunk (#519).
fn cap_of(id: &str, default_cap: usize, keep_pinned: bool) -> Option<usize> {
    if defaults::list("context_size.never").iter().any(|n| *n == id || *n == base(id)) {
        return None;
    }
    let table = defaults::raw("context_size.hook_caps");
    if let Some(c) = [id, base(id)].iter().find_map(|k| table.get(k).and_then(|v| v.as_integer())) {
        return Some(c.max(0) as usize);
    }
    if keep_pinned && pinned(id) {
        return None;
    }
    Some(default_cap)
}

/// The first line of `ctx`, at most `max` characters, cut at a word end with the ellipsis when it was longer.
pub(crate) fn summary(ctx: &str, max: usize) -> String {
    let first = ctx.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim();
    if first.chars().count() <= max {
        return first.to_string();
    }
    let cut: String = first.chars().take(max).collect();
    let at = cut.rfind(char::is_whitespace).filter(|i| *i > max / 2).unwrap_or(cut.len());
    format!("{}{}", cut[..at].trim_end(), defaults::text("context_size.ellipsis"))
}

struct Cand {
    idx: usize,
    ctx: String,
    chars: usize,
    cap: Option<usize>,
    pri: i64,
}

/// Replace the over-cap contexts of `results` (an event in `context_size.events`) with summary plus file pointer, in place.
pub fn apply(event: &str, env: &RequestEnv, results: &mut [HookResult]) {
    if !defaults::list("context_size.events").contains(&event) {
        return;
    }
    let st = Settings::from_env(env);
    if !get_bool(&st, defaults::raw("context_size.sw_enabled")) {
        return;
    }
    let default_cap = get_number(&st, defaults::raw("context_size.num_hook_cap")).max(0.0) as usize;
    let total_cap = get_number(&st, defaults::raw("context_size.num_event_cap")).max(0.0) as usize;
    let sum_max = defaults::num("context_size.summary_chars") as usize;
    let keep_pinned = get_bool(&st, defaults::raw("context_size.sw_keep_pinned"));
    let mut cands: Vec<Cand> = Vec::new();
    for (idx, r) in results.iter().enumerate() {
        if r.code != Some(0) {
            continue;
        }
        let Some(ctx) = combine::context_of(&r.out).filter(|c| !c.is_empty()) else { continue };
        cands.push(Cand { idx, chars: ctx.chars().count(), cap: cap_of(&r.id, default_cap, keep_pinned), pri: super::spill::priority(&r.id), ctx });
    }
    // per-hook step, then the event total (lowest priority first, the largest first among equals; size only with keep_pinned off)
    let mut shrink: Vec<bool> = cands.iter().map(|c| matches!(c.cap, Some(cap) if cap > 0 && c.chars > cap)).collect();
    let pointer_chars = defaults::text("context_size.msg_ref").chars().count() + defaults::num("context_size.path_reserve") as usize;
    let size_after = |c: &Cand, s: bool| if s { sum_max.min(c.chars) + pointer_chars } else { c.chars };
    if total_cap > 0 {
        let mut total: usize = cands.iter().zip(&shrink).map(|(c, s)| size_after(c, *s)).sum();
        let mut order: Vec<usize> = (0..cands.len()).filter(|i| !shrink[*i] && cands[*i].cap.is_some()).collect();
        if keep_pinned {
            order.sort_by_key(|i| (cands[*i].pri, std::cmp::Reverse(cands[*i].chars)));
        } else {
            order.sort_by_key(|i| std::cmp::Reverse(cands[*i].chars));
        }
        for i in order {
            if total <= total_cap {
                break;
            }
            let saved = cands[i].chars.saturating_sub(size_after(&cands[i], true));
            if saved == 0 {
                continue;
            }
            shrink[i] = true;
            total -= saved;
        }
    }
    if !shrink.iter().any(|s| *s) {
        return;
    }
    // one file for the event: a section per shrunk hook
    let dir = crate::paths::dir().join(defaults::text("dispatch.spill_dir"));
    if crate::limits::ensure_private_dir(&dir).is_err() {
        return;
    }
    let label: String = event.chars().filter(char::is_ascii_alphanumeric).collect();
    // the daemon dispatches on several threads of one process: the sequence number keeps two same-millisecond files apart
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let path = dir.join(defaults::render("context_size.file", &[("event", &label), ("ts", &health::now_ms()), ("pid", &std::process::id()), ("seq", &seq)]));
    let mut body = String::new();
    let mut before = 0usize;
    for (c, s) in cands.iter().zip(&shrink) {
        if *s {
            body.push_str(&defaults::render("context_size.section_head", &[("id", &results[c.idx].id)]));
            body.push_str(&c.ctx);
            body.push_str("\n\n");
            before += c.chars;
        }
    }
    let written = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&path)
        .and_then(|mut f| f.write_all(body.as_bytes()).and_then(|()| f.sync_all()));
    if let Err(e) = written {
        health::log_event("dispatch_spill_failed", event, &defaults::render("dispatch.msg_spill_failed", &[("err", &e)]));
        crate::discard::harmless(std::fs::remove_file(&path)); // keep: our own half-written file; every context stays as printed
        return;
    }
    let (mut hooks, mut after) = (0usize, 0usize);
    for (c, s) in cands.iter().zip(&shrink) {
        if !*s {
            continue;
        }
        let inline = defaults::render("context_size.msg_ref", &[("summary", &summary(&c.ctx, sum_max)), ("chars", &c.chars), ("path", &path.display())]);
        if let Some(out) = combine::with_context(&results[c.idx].out, &inline) {
            after += inline.chars().count();
            hooks += 1;
            let pin = c.pri >= defaults::num("dispatch.context_pin_priority") as i64;
            crate::metrics::bump("context_shrunk", &[("class", defaults::text(if pin { "context_size.label_pinned" } else { "context_size.label_low" }))]);
            results[c.idx].out = out;
        }
    }
    health::log_event(
        "dispatch_context_shrunk",
        event,
        &defaults::render("context_size.msg_shrunk", &[("hooks", &hooks), ("before", &before), ("after", &after), ("path", &path.display())]),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(id: &str, ctx: &str) -> HookResult {
        let out = format!("{}\n", serde_json::json!({ "hookSpecificOutput": { "hookEventName": "SessionStart", "additionalContext": ctx } }));
        HookResult { id: id.into(), code: Some(0), out, err: String::new() }
    }

    fn ctx(r: &HookResult) -> String {
        combine::context_of(&r.out).unwrap()
    }

    #[test]
    fn the_summary_is_the_first_line_cut_at_a_word() {
        assert_eq!(summary("one short line\nsecond", 80), "one short line");
        let long = "word ".repeat(100);
        let s = summary(&long, 50);
        assert!(s.chars().count() <= 50 + defaults::text("context_size.ellipsis").chars().count());
        assert!(s.ends_with(defaults::text("context_size.ellipsis")) && !s.contains("wor…"), "{s}");
    }

    #[test]
    fn a_hook_cap_resolves_by_entry_id_then_base_name_and_never_wins() {
        assert_eq!(cap_of("verify-first-orch:host=claude", 1500, true), None);
        assert_eq!(cap_of("handover-resume", 1500, true), None);
        assert_eq!(cap_of("jev-weekly-scorecard", 1500, true), Some(1500));
        assert_eq!(cap_of("devswarm-child-role", 1500, true), Some(1200), "the per-hook table overrides the default and the pin");
        assert_eq!(cap_of("rule-digest", 1500, true), None, "a pinned entry without its own row is never shrunk");
        assert_eq!(cap_of("rule-digest", 1500, false), Some(1500), "the switch off: the default cap again");
    }

    fn env_with(settings: &str) -> RequestEnv {
        let home = std::env::temp_dir().join(format!("ahd-shrink-{}-{}", std::process::id(), settings.len()));
        std::fs::create_dir_all(home.join(".anti-hall")).unwrap();
        std::fs::write(home.join(".anti-hall/settings.json"), settings).unwrap();
        RequestEnv::from_pairs([("HOME", home.to_string_lossy().to_string())])
    }

    #[test]
    fn an_over_cap_context_becomes_a_summary_and_a_file_and_a_never_hook_stays_whole() {
        let env = env_with("{}");
        let big = format!("Reference notice: how the mesh works.\n{}", "detail ".repeat(600));
        let mut rs = vec![r("verify-first-full", &"p".repeat(3000)), r("devswarm-child-role", &big), r("fable-availability", "short")];
        apply("SessionStart", &env, &mut rs);
        assert_eq!(ctx(&rs[0]), "p".repeat(3000), "a never hook keeps its text whole");
        assert_eq!(ctx(&rs[2]), "short", "a context under its cap is untouched");
        let shrunk = ctx(&rs[1]);
        assert!(shrunk.starts_with("Reference notice: how the mesh works."), "{shrunk}");
        assert!(shrunk.chars().count() < 400, "{}", shrunk.chars().count());
        let path = shrunk.split("in ").last().unwrap().split(" - Read").next().unwrap().to_string();
        let file = std::fs::read_to_string(&path).expect("the full text is in the file");
        assert!(file.contains(&big) && file.starts_with("== devswarm-child-role =="), "nothing is cut");
        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn the_event_total_shrinks_the_largest_shrinkable_contexts_and_the_switch_turns_it_all_off() {
        let on = env_with(r#"{"context":{"inlineHookChars":0,"inlineEventChars":3000}}"#);
        let mut rs = vec![r("a-hook", &format!("A\n{}", "a".repeat(2000))), r("b-hook", &format!("B\n{}", "b".repeat(1500))), r("c-hook", "tiny")];
        apply("SessionStart", &on, &mut rs);
        let sizes: Vec<usize> = rs.iter().map(|x| ctx(x).chars().count()).collect();
        assert!(sizes[0] < 400 && sizes[1] == 1502, "the largest goes first, then it fits: {sizes:?}");
        let off = env_with(r#"{"context":{"shrinkInline":false,"inlineHookChars":10}}"#);
        let mut rs2 = vec![r("a-hook", &"a".repeat(2000))];
        apply("SessionStart", &off, &mut rs2);
        assert_eq!(ctx(&rs2[0]).chars().count(), 2000);
        let mut other = vec![r("a-hook", &"a".repeat(2000))];
        apply("UserPromptSubmit", &on, &mut other);
        assert_eq!(ctx(&other[0]).chars().count(), 2000, "only the configured events");
    }

    /// #519: the SessionStart of a DevSwarm session after a compaction (the shipped defaults: event total 6000, per-hook cap 1500). The
    /// size-only event step shrank the 1,259-character rule digest (pinned, priority 93) to a file pointer once the DevSwarm comms notice
    /// had been shrunk; the rules must stay inline whole and only a low-priority notice may go to the file.
    #[test]
    fn the_pinned_rule_digest_stays_inline_and_the_switch_off_restores_the_size_order() {
        let rules = format!("anti-hall rules (same config the engine enforces):\n{}", "- a rule line of the digest\n".repeat(44));
        let comms = format!("devswarm-comms: the mesh is the only channel.\n{}", "mesh detail ".repeat(370));
        let low = format!("Version notice: a newer build exists.\n{}", "v".repeat(900));
        let set = || {
            vec![
                r("verify-first-full", &"p".repeat(3000)),
                r("verify-first-orch", &"o".repeat(1500)),
                r("rule-digest", &rules),
                r("devswarm-child-role", &comms),
                r("version-alert", &low),
            ]
        };
        let on = env_with("{}");
        let mut rs = set();
        apply("SessionStart", &on, &mut rs);
        assert_eq!(ctx(&rs[2]), rules, "the pinned rule digest is inline whole");
        assert!(ctx(&rs[3]).chars().count() < 600, "its explicit hook cap still shrinks the comms notice");
        assert!(ctx(&rs[4]).chars().count() < 600, "the low-priority notice goes to the file first");
        let off = env_with(r#"{"context":{"inlinePinned":false}}"#);
        let mut rs2 = set();
        apply("SessionStart", &off, &mut rs2);
        assert!(ctx(&rs2[2]).chars().count() < 600, "switch off: the size-only order shrinks the rule digest again");
    }
}
