//! The over-cap spill (v1.0 L15): a joined `additionalContext` over the host's inline cap is delivered without Node.
//!
//! The host delivers one hook's context inline up to `dispatch.context_cap` characters and spills anything over it to a file
//! with a short preview. Run as separate hooks, every context of a SessionStart is under the cap and arrives whole; joined by
//! this one process they are not. Instead of handing the event to the Node hooks, the contexts that fit stay inline, whole and
//! in hook order, and the rest is written to a private file in the state directory with a pointer line naming it
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

/// Spill the part of `joined_out`'s context that does not fit `cap` characters. `None`: nothing was changed.
pub fn apply(event: &str, results: &[HookResult], joined_out: &str, cap: usize) -> Option<Spilled> {
    let joiner = defaults::text("dispatch.context_joiner");
    let ctxs: Vec<String> = results.iter().filter_map(|r| combine::context_of(&r.out)).filter(|c| !c.is_empty()).collect();
    if combine::context_of(joined_out)? != ctxs.join(joiner) {
        return None; // the join is not exactly the hooks' contexts: never guess where one ends
    }
    let dir = dir();
    crate::limits::ensure_private_dir(&dir).ok()?;
    let name = defaults::render("dispatch.spill_file", &[("event", &label(event)), ("ts", &health::now_ms()), ("pid", &std::process::id())]);
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
    crate::telemetry::emit::queue(crate::telemetry::emit::spill("dispatcher", event, rest.len() as u64));
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
            combine::Combined::Conflict(_) => String::new(),
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
}
