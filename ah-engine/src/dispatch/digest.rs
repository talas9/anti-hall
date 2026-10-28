//! The prompt digest (#338 item 2): several advisories that speak on one prompt are replaced by one digest of at most N lines.
//!
//! Only the entries listed in `inject_gate.digest_hooks`, on the events in `inject_gate.digest_events`, with exit 0 and a
//! context, take part; a block, a decision or any other entry is never touched. Each takes one headline (its first line,
//! shortened); the full text of all of them goes to a private file named on the last line, so nothing is lost. Everything
//! (the switch, the line count, the threshold, the lists and the texts) is read from the plugin's TOML.
use super::combine::{self, HookResult};
use crate::checks::git::util::Settings;
use crate::checks::guardkit::settings::{get_bool, get_number};
use crate::reqenv::RequestEnv;
use crate::{defaults, health};
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;

/// The first non-empty line of `ctx`, cut to `max` characters.
fn headline(ctx: &str, max: usize) -> String {
    let first = ctx.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    if first.chars().count() <= max { first.to_string() } else { first.chars().take(max.saturating_sub(1)).collect::<String>() + "…" }
}

/// The digest text for `parts` (id order = importance, each `(headline, shortened)`), `max_lines` lines at most; the pointer
/// goes on the last line when any text was shortened.
fn lines_of(parts: &[(String, bool)], max_lines: usize, pointer: &str) -> String {
    let sep = defaults::text("inject_gate.digest_line_sep");
    let mut lines: Vec<String> = Vec::new();
    for (i, (h, _)) in parts.iter().enumerate() {
        if i + 1 < max_lines || i == 0 && max_lines == 1 {
            lines.push(h.clone());
        } else if let Some(last) = lines.get_mut(max_lines - 1) {
            last.push_str(sep);
            last.push_str(h);
        } else {
            lines.push(h.clone());
        }
    }
    if let Some(last) = lines.last_mut() {
        last.push_str(pointer);
    }
    lines.join("\n")
}

/// Replace the digestible contexts of `results` by one digest, in place. Nothing changes when the switch is off, fewer than the
/// threshold speak, the digest would not be shorter, or the full-text file cannot be written.
pub fn apply(event: &str, env: &RequestEnv, results: &mut [HookResult]) {
    if !defaults::list("inject_gate.digest_events").contains(&event) {
        return;
    }
    let st = Settings::from_env(env);
    if !get_bool(&st, defaults::raw("inject_gate.sw_digest")) {
        return;
    }
    let max_lines = get_number(&st, defaults::raw("inject_gate.num_digest_lines")).max(2.0) as usize;
    let min = get_number(&st, defaults::raw("inject_gate.num_digest_min")).max(2.0) as usize;
    let order = defaults::list("inject_gate.digest_hooks");
    let mut picked: Vec<(usize, usize, String)> = Vec::new(); // (importance, result index, context)
    for (i, r) in results.iter().enumerate() {
        let Some(rank) = order.iter().position(|id| *id == r.id) else { continue };
        if r.code != Some(0) || combine::blocks(r) {
            continue;
        }
        if let Some(c) = combine::context_of(&r.out).filter(|c| !c.is_empty()) {
            picked.push((rank, i, c));
        }
    }
    if picked.len() < min {
        return;
    }
    picked.sort_by_key(|p| p.0);
    let max_chars = defaults::num("inject_gate.digest_line_chars") as usize;
    let parts: Vec<(String, bool)> = picked
        .iter()
        .map(|(_, _, c)| {
            let h = headline(c, max_chars);
            let cut = c.trim() != h;
            (h, cut)
        })
        .collect();
    let cut_any = parts.iter().any(|p| p.1) || parts.len() > max_lines;
    let full: String = picked.iter().map(|p| p.2.as_str()).collect::<Vec<_>>().join(defaults::text("dispatch.context_joiner"));
    let mut pointer = String::new();
    let mut path = None;
    if cut_any {
        let dir = crate::paths::dir().join(defaults::text("dispatch.spill_dir"));
        if crate::limits::ensure_private_dir(&dir).is_err() {
            return;
        }
        let file = dir.join(defaults::render("inject_gate.digest_file", &[("ts", &health::now_ms()), ("pid", &std::process::id())]));
        let wrote = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&file)
            .and_then(|mut f| f.write_all(full.as_bytes()).and_then(|()| f.sync_all()));
        if wrote.is_err() {
            return;
        }
        pointer = defaults::render("inject_gate.digest_pointer", &[("path", &file.display())]);
        path = Some(file);
    }
    let digest = lines_of(&parts, max_lines, &pointer);
    if digest.chars().count() >= full.chars().count() {
        if let Some(p) = path {
            crate::discard::harmless(std::fs::remove_file(p)); // keep: our own file, the digest would not be shorter
        }
        return;
    }
    for (n, (_, i, _)) in picked.iter().enumerate() {
        let text = if n == 0 { digest.as_str() } else { "" };
        if let Some(out) = combine::with_context(&results[*i].out, text) {
            results[*i].out = combine::tidy(&out);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_headline_is_the_first_line_cut_to_the_limit() {
        assert_eq!(headline("\n  one line\nsecond", 50), "one line");
        assert_eq!(headline("abcdefghij", 5), "abcd…");
    }

    #[test]
    fn the_digest_never_has_more_lines_than_allowed_and_names_the_file() {
        let parts: Vec<(String, bool)> = (1..=5).map(|n| (format!("h{n}"), true)).collect();
        let d = lines_of(&parts, 3, " (full: /p)");
        assert_eq!(d.lines().count(), 3);
        assert!(d.ends_with("h3 | h4 | h5 (full: /p)"), "{d}");
    }
}
