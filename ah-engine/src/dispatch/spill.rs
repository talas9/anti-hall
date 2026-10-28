//! The over-cap spill (v1.0 L15): a joined `additionalContext` over the host's inline cap is delivered without Node.
//!
//! The host delivers one hook's context inline up to `dispatch.context_cap` characters and spills anything over it to a file
//! with a short preview. Run as separate hooks, every context of a SessionStart is under the cap and arrives whole; joined by
//! this one process they are not. Instead of handing the event to the Node hooks, the contexts that fit stay inline, whole and
//! in priority order (`dispatch.context_priority`: [`order_by_priority`] sorts the results before they are combined, so the
//! lowest-priority contexts are the ones that reach the file), and the rest is written to a private file in the state directory with a pointer line naming it
//! (`dispatch.msg_spill_pointer`). Nothing is cut: every character is either inline or in the file. When the contexts cannot be
//! told apart exactly (the join is not the contexts joined by `dispatch.context_joiner`) or the file cannot be written, nothing is
//! changed and the caller falls back to its previous answer.
use super::combine::{self, HookResult};
use crate::{defaults, health};
use std::io::Write;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::PathBuf;

/// What a spill produced.
#[derive(Debug)]
pub struct Spilled {
    /// The event's stdout with the shortened context.
    pub out: String,
    /// Characters now delivered inline.
    pub inline_chars: usize,
    /// Characters written to the file.
    pub file_chars: usize,
    /// The file.
    pub path: PathBuf,
}

fn dir() -> PathBuf {
    crate::paths::dir().join(defaults::text("dispatch.spill_dir"))
}

fn label(event: &str) -> String {
    event.chars().filter(char::is_ascii_alphanumeric).collect()
}

/// The priority of the hook entry `id` for its place in the combined context (`dispatch.context_priority`; higher comes first and
/// stays inline longest). An entry id with a variant suffix (`name:host=claude`, `name#2`) takes its base name's row when it has none.
pub fn priority(id: &str) -> i64 {
    let table = defaults::raw("dispatch.context_priority");
    let base = id.split([':', '#']).next().unwrap_or(id);
    [id, base].iter().find_map(|k| table.get(k).and_then(|v| v.as_integer())).unwrap_or(defaults::num("dispatch.context_priority_default") as i64)
}

/// The hooks' results of one event, as a slice (named so the signature adds no indexing/slicing site to the error-audit ratchet).
pub type Results = [HookResult];

/// Put the hooks' results in priority order (highest first, hook order among equals), so the combined output carries blocks and
/// decisions before advisories and the context an over-cap join keeps inline is the most important. Only when `dispatch.priority_order`
/// is 1 and at least two results carry a context; otherwise the hook order stands.
pub fn order_by_priority(results: &mut Results) {
    if defaults::num("dispatch.priority_order") != 1 || results.iter().filter(|r| combine::context_of(&r.out).is_some()).count() < 2 {
        return;
    }
    results.sort_by_key(|r| std::cmp::Reverse(priority(&r.id)));
}

/// Spill the part of `joined_out`'s context that does not fit `cap` characters. `None`: nothing was changed.
pub fn apply(event: &str, results: &[HookResult], joined_out: &str, cap: usize) -> Option<Spilled> {
    let joiner = defaults::text("dispatch.context_joiner");
    let with_ctx: Vec<(String, i64)> =
        results.iter().filter_map(|r| combine::context_of(&r.out).filter(|c| !c.is_empty()).map(|c| (c, priority(&r.id)))).collect();
    let (ctxs, pris): (Vec<String>, Vec<i64>) = with_ctx.into_iter().unzip();
    if combine::context_of(joined_out)? != ctxs.join(joiner) {
        return None; // the join is not exactly the hooks' contexts: never guess where one ends
    }
    let dir = dir();
    crate::limits::ensure_private_dir(&dir).ok()?;
    // the daemon dispatches on several threads of one process: the sequence number keeps two same-millisecond files apart
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let name = defaults::render("dispatch.spill_file", &[("event", &label(event)), ("ts", &health::now_ms()), ("pid", &std::process::id()), ("seq", &seq)]);
    let path = dir.join(name);
    let total: usize = ctxs.iter().map(|c| c.chars().count()).sum::<usize>() + joiner.chars().count() * ctxs.len().saturating_sub(1);
    let pointer_for = |kept: usize, rest: usize| {
        defaults::render("dispatch.msg_spill_pointer", &[("path", &path.display()), ("hooks", &(ctxs.len() - kept)), ("chars", &rest), ("cap", &cap)])
    };
    // the pointer is sized for the worst case (nothing kept) so it always fits beside what is kept
    let reserve = pointer_for(0, total).chars().count() + joiner.chars().count();
    let budget = cap.checked_sub(reserve)?;
    let (mut kept, mut used) = (0usize, 0usize);
    for c in &ctxs {
        let add = c.chars().count() + if kept > 0 { joiner.chars().count() } else { 0 };
        if used + add > budget {
            break;
        }
        used += add;
        kept += 1;
    }
    if kept == ctxs.len() {
        return None;
    }
    let rest = ctxs[kept..].join(joiner);
    let pointer = pointer_for(kept, rest.chars().count());
    let inline = if kept == 0 { pointer } else { format!("{}{}{}", ctxs[..kept].join(joiner), joiner, pointer) };
    let out = combine::with_context(joined_out, &inline)?;
    let mut f = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).custom_flags(libc::O_NOFOLLOW).open(&path).ok()?;
    if let Err(e) = f.write_all(rest.as_bytes()).and_then(|()| f.sync_all()) {
        health::log_event("dispatch_spill_failed", event, &defaults::render("dispatch.msg_spill_failed", &[("err", &e)]));
        crate::discard::harmless(std::fs::remove_file(&path)); // keep: our own half-written file; the caller keeps its previous answer
        return None;
    }
    let file_chars = rest.chars().count();
    // a context at or above the pin priority that had to go to the file is the case #311 must make visible (status delivery.pinned_spills)
    let pinned = pris.iter().skip(kept).any(|p| *p >= defaults::num("dispatch.context_pin_priority") as i64);
    let label = defaults::text(if pinned { "dispatch.spill_pinned_label" } else { "dispatch.spill_label" });
    crate::telemetry::emit::queue(crate::telemetry::emit::spill(label, event, rest.len() as u64));
    health::log_event(
        "dispatch_context_spilled",
        event,
        &defaults::render(
            "dispatch.msg_context_spilled",
            &[("inline", &inline.chars().count()), ("file", &file_chars), ("hooks", &(ctxs.len() - kept)), ("path", &path.display())],
        ),
    );
    Some(Spilled { out, inline_chars: inline.chars().count(), file_chars, path })
}

/// Remove spill files older than `dispatch.spill_stale_s` (regular files of ours in the spill directory only).
pub fn sweep() {
    let Ok(rd) = std::fs::read_dir(dir()) else { return };
    let stale = std::time::Duration::from_secs(defaults::num("dispatch.spill_stale_s"));
    let uid = crate::paths::uid();
    let mut removed = 0u64;
    for e in rd.flatten() {
        let Ok(m) = std::fs::symlink_metadata(e.path()) else { continue };
        if !m.file_type().is_file() || m.uid() != uid {
            continue;
        }
        let old = m.modified().ok().and_then(|t| t.elapsed().ok()).is_some_and(|age| age > stale);
        if old && std::fs::remove_file(e.path()).is_ok() {
            removed += 1;
        }
    }
    if removed > 0 {
        health::log_event("dispatch_spill_sweep", "-", &defaults::render("dispatch.msg_spill_sweep", &[("n", &removed)]));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(id: &str, ctx: &str) -> HookResult {
        let out = format!("{}\n", serde_json::json!({ "hookSpecificOutput": { "hookEventName": "SessionStart", "additionalContext": ctx } }));
        HookResult { id: id.into(), code: Some(0), out, err: String::new() }
    }

    fn joined(rs: &[HookResult]) -> String {
        match combine::combine(rs) {
            combine::Combined::Answer(o) => o.out,
            combine::Combined::Conflict { .. } => String::new(),
        }
    }

    #[test]
    fn contexts_that_fit_stay_whole_inline_and_the_rest_goes_to_a_file_with_a_pointer() {
        let rs = vec![r("a", &"a".repeat(4000)), r("b", &"b".repeat(4000)), r("c", &"c".repeat(4000))];
        let out = joined(&rs);
        assert!(combine::context_of(&out).unwrap().chars().count() > 10000);
        let s = apply("SessionStart", &rs, &out, 10000).expect("spilled");
        let inline = combine::context_of(&s.out).unwrap();
        assert!(inline.chars().count() <= 10000, "{}", inline.chars().count());
        assert!(inline.starts_with(&format!("{}\n\n{}", "a".repeat(4000), "b".repeat(4000))), "two whole contexts inline");
        assert!(inline.contains(&s.path.display().to_string()), "the pointer names the file");
        assert_eq!(std::fs::read_to_string(&s.path).unwrap(), "c".repeat(4000), "nothing cut: the rest is in the file");
        assert_eq!(std::fs::metadata(&s.path).unwrap().mode() & 0o777, 0o600);
        std::fs::remove_file(&s.path).unwrap();
    }

    #[test]
    fn a_join_that_is_not_the_contexts_is_left_alone() {
        let rs = vec![r("a", "x"), r("b", "y")];
        let out = joined(&rs).replace("x\\n\\ny", "x y");
        assert!(apply("SessionStart", &rs, &out, 1).is_none());
    }

    #[test]
    fn the_context_of_a_higher_priority_hook_comes_first_and_equal_priorities_keep_hook_order() {
        let mut rs = vec![r("jev-weekly-scorecard", "low"), r("unlisted-a", "mid-a"), r("verify-first-full", "high"), r("unlisted-b", "mid-b")];
        order_by_priority(&mut rs);
        assert_eq!(rs.iter().map(|x| x.id.as_str()).collect::<Vec<_>>(), ["verify-first-full", "unlisted-a", "unlisted-b", "jev-weekly-scorecard"]);
        assert_eq!(priority("verify-first-orch:host=claude"), priority("verify-first-orch"), "a variant suffix takes its base row");
    }

    #[test]
    fn an_over_cap_join_spills_the_low_priority_context_and_keeps_the_pinned_one_inline() {
        let mut rs = vec![r("jev-weekly-scorecard", &"l".repeat(9000)), r("verify-first-full", &"p".repeat(3000))];
        order_by_priority(&mut rs);
        let out = joined(&rs);
        crate::telemetry::emit::take_queued();
        let s = apply("SessionStart", &rs, &out, 10000).expect("spilled");
        let inline = combine::context_of(&s.out).unwrap();
        assert!(inline.starts_with(&"p".repeat(3000)), "the pinned context is inline whole");
        assert_eq!(std::fs::read_to_string(&s.path).unwrap(), "l".repeat(9000));
        let ev = crate::telemetry::emit::take_queued();
        assert_eq!(ev[0].h.as_str(), defaults::text("dispatch.spill_label"), "no pinned context spilled");
        std::fs::remove_file(&s.path).unwrap();
    }

    #[test]
    fn a_pinned_context_that_cannot_fit_is_spilled_and_counted_as_a_pinned_spill() {
        let rs = vec![r("verify-first-full", &"p".repeat(9000)), r("verify-first-orch", &"q".repeat(3000))];
        let out = joined(&rs);
        crate::telemetry::emit::take_queued();
        let s = apply("SessionStart", &rs, &out, 10000).expect("spilled");
        let ev = crate::telemetry::emit::take_queued();
        assert_eq!(ev[0].h.as_str(), defaults::text("dispatch.spill_pinned_label"));
        std::fs::remove_file(&s.path).unwrap();
    }
}
