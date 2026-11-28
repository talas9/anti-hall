//! #969 R1: the PreToolUse prefilter. A Bash command the shell-word reader can vouch for as a list of plain reads, every command word
//! of which is on a check's POSITIVE list (`prefilter.safe_cmds_by_check`), is answered allow for that check without running its
//! script: the git guard spends most of the PreToolUse CPU on commands that hold no git at all.
//!
//! It fails closed to the full check: a command the reader can not split, an engine-local verb, a redirection or substitution
//! (`prefilter.deny_chars`), a word the check's deny pattern names (`prefilter.deny_by_check`: `git`, `gh`, `push`, `eval` ...), an
//! unknown command name, a script run by path, a nested shell's code, a git or gh subcommand no list knows, or any command word off
//! the list runs the check as before.
//!
//! Shadow: one call in `prefilter.shadow_permille` runs the full check anyway and its answer is the one given. A full check that said
//! anything (a block or an advisory) where the prefilter would have answered allow is a disagreement: it is logged, counted and, with
//! `prefilter.auto_disable`, latches the prefilter off for good (a marker file `prefilter.latch_file` in the engine's state
//! directory, so a restart does not re-arm it; deleting the file re-arms it at the next start).
//!
//! Every list, pattern, rate and text is in `defaults/prefilter.toml`.
use crate::defaults;
use serde_json::Value;
use std::sync::atomic::{AtomicU8, AtomicU64, Ordering::SeqCst};

/// The latch state: 0 = not read yet, 1 = armed, 2 = latched off by a shadow disagreement.
static LATCH: AtomicU8 = AtomicU8::new(0);
/// Calls the prefilter passed, for the shadow sample.
static PASSED: AtomicU64 = AtomicU64::new(0);

/// What the prefilter makes of one entry's check on one call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pre {
    /// Not applicable or not provably read-only for this check: run the check.
    Run,
    /// Provably read-only for this check: answer allow without running it.
    Skip,
    /// Provably read-only, but sampled: run the check and compare (a disagreement latches the prefilter off).
    Shadow,
}

fn latch_path() -> std::path::PathBuf {
    crate::paths::dir().join(defaults::text("prefilter.latch_file"))
}

/// Whether the prefilter is latched off by an earlier shadow disagreement (read once per process).
fn latched() -> bool {
    match LATCH.load(SeqCst) {
        0 => {
            let off = latch_path().exists();
            LATCH.store(if off { 2 } else { 1 }, SeqCst);
            off
        }
        s => s == 2,
    }
}

/// The compiled patterns of the current defaults generation (rebuilt after a reload): pattern -> regex (`None` when it does not compile).
static RX: crate::defaults::Cache<std::sync::Mutex<std::collections::HashMap<String, Option<regex::Regex>>>> = crate::defaults::Cache::new();

/// The pattern `pat` (config `what`), compiled once per defaults generation; `None` when it does not compile (noted).
fn rx(what: &str, pat: &str) -> Option<regex::Regex> {
    let cache = RX.get_or_init(Default::default);
    let mut m = cache.lock().unwrap_or_else(|e| e.into_inner());
    m.entry(pat.to_string())
        .or_insert_with(|| regex::RegexBuilder::new(pat).case_insensitive(true).build().map_err(|e| crate::discard::note("prefilter_pattern", &format!("{what}: {e}"))).ok())
        .clone()
}

/// Whether the words of one pipeline element (`words`, its command word first) are a listed reader, or a command of
/// `prefilter.sub_cmds_by_check` whose subcommand (after its listed global options) is on that command's list.
fn element_ok(check: &str, words: &[&str], listed: &dyn Fn(&str) -> bool) -> bool {
    let Some(lead) = words.first() else { return false };
    if listed(lead) {
        return true;
    }
    let table = |key: &str| defaults::raw(key).get(check).and_then(|t| t.get(lead)).map(defaults::V::strings).unwrap_or_default();
    let subs = table("prefilter.sub_cmds_by_check");
    if subs.is_empty() {
        return false;
    }
    let (with_value, flags) = (table("prefilter.sub_value_opts_by_check"), table("prefilter.sub_flag_opts_by_check"));
    let mut i = 1;
    while let Some(w) = words.get(i) {
        if with_value.contains(w) {
            i += 2;
        } else if flags.contains(w) {
            i += 1;
        } else {
            // a subcommand may be several words (`pr view`): the words from here must start with all of one entry's
            return subs.iter().any(|sub| {
                let want: Vec<&str> = sub.split_whitespace().collect();
                !want.is_empty() && words.get(i..i + want.len()).is_some_and(|got| got == want.as_slice())
            });
        }
    }
    false
}

/// The words of a part as the reader kept them (a read, or an engine-local verb's pipe tail).
fn part_text_any(p: &super::shellwords::Part) -> Option<String> {
    match p {
        super::shellwords::Part::Read(t) => Some(t.clone()),
        super::shellwords::Part::Local(t, _) => Some(t.clone()),
    }
}

/// Whether `command` is, for `check`, a list of plain reads of listed commands ([`decide`] without the switch, the latch or the
/// sample): the pure classification the parity tests hold against the full check.
pub fn read_only_for(check: &str, command: &str) -> bool {
    why_not(check, command).is_none()
}

/// Why [`read_only_for`] runs the check on `command` (the first gate it failed), `None` when it passes.
pub fn why_not(check: &str, command: &str) -> Option<&'static str> {
    let safe = defaults::raw("prefilter.safe_cmds_by_check").get(check).map(defaults::V::strings).unwrap_or_default();
    if safe.is_empty() || command.trim().is_empty() {
        return Some("unlisted_check");
    }
    // an inert redirection (`2>&1`, `>/dev/null`) writes nothing: it is read as a space, the words around it kept
    let inert = defaults::text("prefilter.inert_redirs");
    let stripped;
    let command = if inert.is_empty() {
        command
    } else {
        let Some(re) = rx("prefilter.inert_redirs", inert) else { return Some("bad_pattern") };
        stripped = re.replace_all(command, "${1} ${2}").into_owned();
        stripped.as_str()
    };
    if command.chars().any(|c| defaults::text("prefilter.deny_chars").contains(c)) {
        return Some("deny_char");
    }
    let deny = defaults::raw("prefilter.deny_by_check").get(check).and_then(defaults::V::as_str).unwrap_or_default();
    if !deny.is_empty() {
        match rx("prefilter.deny_by_check", deny) {
            Some(re) if re.is_match(command) => return Some("deny_pattern"),
            Some(_) => {}
            None => return Some("bad_pattern"),
        }
    }
    let Some(ncfg) = super::capacity_norm_cfg(defaults::raw("dispatch.capacity_hold")) else { return Some("no_reader") };
    let home = Some(ncfg.ro_home.as_str()).filter(|h| !h.is_empty()).and_then(std::env::var_os);
    let Some(parts) = super::shellwords::read_only_parts(command, &ncfg, home.as_deref()).filter(|p| !p.is_empty()) else { return Some("unparsed") };
    let Some(n) = super::shellwords::normalise(command, &ncfg) else { return Some("unparsed") };
    if n.cmds.is_empty() || !n.unknown_cmds.is_empty() || !n.shell_code.is_empty() || n.git_unknown.is_some() || n.gh_unknown.is_some() || n.stripped {
        return Some("unknown");
    }
    // a reader spelled with a system directory (`/usr/bin/grep`) is the reader; any other program run by path is a script
    let bare = |c: &str| ncfg.ro_bin_dirs.iter().find_map(|d| c.strip_prefix(d.as_str())).unwrap_or(c).to_string();
    let listed = |c: &str| safe.iter().any(|s| *s == bare(c));
    let has_subs = |c: &str| defaults::raw("prefilter.sub_cmds_by_check").get(check).and_then(|t| t.get(&bare(c))).is_some();
    let in_bin_dir = |c: &str| ncfg.ro_bin_dirs.iter().any(|d| c.strip_prefix(d.as_str()).is_some_and(|b| !b.contains('/')));
    // the engine's own program (any verb, as a command word): no reader, but nothing a check with `prefilter.engine_ok_by_check` reads
    let engine_ok = defaults::raw("prefilter.engine_ok_by_check").get(check).and_then(defaults::V::as_integer) == Some(1);
    let engine = |c: &str| engine_ok && super::shellwords::is_engine_program(c, &ncfg, home.as_deref());
    let listed = |c: &str| listed(c) || engine(c);
    // a redirection the reader kept in a part's words (`> file`, `< file`): it may write, so the check runs
    let redirs = defaults::text("prefilter.redirect_chars");
    let part_text = |p: &super::shellwords::Part| match p {
        super::shellwords::Part::Read(t) => Some(t.clone()),
        super::shellwords::Part::Local(t, r) => r.is_empty().then(|| t.clone()),
    };
    let texts: Vec<Option<String>> = parts.iter().map(part_text).collect();
    if texts.iter().any(|t| t.as_ref().is_none_or(|t| t.chars().any(|c| redirs.contains(c)))) {
        return Some("redirect");
    }
    // every element of every pipeline starts with a listed word as written: a wrapper (`sudo`, `nice`, `xargs`, `find`) is no reader,
    // even when what it runs is (a quoted `|` splits an element wrongly and then fails this, which only runs the check)
    let leads = parts.iter().all(|p| match p {
        super::shellwords::Part::Read(t) => t.split('|').all(|el| element_ok(check, &el.split_whitespace().collect::<Vec<_>>(), &listed)),
        // an engine-local verb with its pipe tail: the tail's elements must pass like a read's
        super::shellwords::Part::Local(tail, _) => engine_ok && (tail.trim().is_empty() || tail.split('|').all(|el| element_ok(check, &el.split_whitespace().collect::<Vec<_>>(), &listed))),
    });
    if !leads {
        return Some("lead");
    }
    // a word the check acts on (`git`) stands in the raw text only where it leads an element: one inside a quoted string or an
    // argument can be read by the check's quote-blind backstop as a command of its own
    let lead_count = |w: &str| {
        parts.iter().filter_map(part_text_any).flat_map(|t| t.split('|').map(str::to_string).collect::<Vec<_>>()).filter(|el| el.split_whitespace().next() == Some(w)).count()
    };
    let word_chars = defaults::text("prefilter.word_chars");
    let raw_count = |w: &str| command.split(|c: char| !(c.is_ascii_alphanumeric() || word_chars.contains(c))).filter(|t| *t == w).count();
    let lead_only = defaults::raw("prefilter.lead_only_words_by_check").get(check).map(defaults::V::strings).unwrap_or_default();
    if lead_only.iter().any(|w| raw_count(w) > lead_count(w)) {
        return Some("lead_only");
    }
    if !n.scripts.iter().all(|s| engine(s) || in_bin_dir(s) && (listed(s) || has_subs(s))) {
        return Some("script");
    }
    (!n.cmds.iter().all(|c| listed(c) || has_subs(c))).then_some("cmd")
}

/// What to do with `check` on this call (`event`, the hook payload `p`).
pub fn decide(check: &str, event: &str, p: &Value) -> Pre {
    if defaults::num("prefilter.enabled") != 1 || !defaults::list("prefilter.events").contains(&event) {
        return Pre::Run;
    }
    let tool = p.get("tool_name").and_then(Value::as_str).unwrap_or_default();
    if !defaults::list("prefilter.tools").contains(&tool) {
        return Pre::Run;
    }
    let field = defaults::text("prefilter.field");
    let Some(command) = p.get("tool_input").and_then(|i| i.get(field)).and_then(Value::as_str) else { return Pre::Run };
    if latched() || !read_only_for(check, command) {
        return Pre::Run;
    }
    let permille = defaults::num("prefilter.shadow_permille");
    let n = PASSED.fetch_add(1, SeqCst);
    if permille > 0 && n % 1000 < permille {
        return Pre::Shadow;
    }
    Pre::Skip
}

/// Whether the prefilter is on for `check` on `event` (it has a positive list): the calls it leaves to the full check are counted.
pub fn applies(check: &str, event: &str) -> bool {
    defaults::num("prefilter.enabled") == 1 && defaults::list("prefilter.events").contains(&event) && defaults::raw("prefilter.safe_cmds_by_check").get(check).is_some()
}

/// Count one outcome (`prefilter.outcome_*`) for `check`.
pub fn count(check: &str, outcome_key: &str) {
    crate::metrics::bump("prefilter", &[("check", check), ("outcome", defaults::text(outcome_key))]);
}

/// The full check's answer on a shadowed call (`said` = it blocked or advised where the prefilter would have allowed): a disagreement
/// is logged and counted, and with `prefilter.auto_disable` latches the prefilter off for good.
pub fn shadow_result(check: &str, said: bool, command: &str) {
    if !said {
        count(check, "prefilter.outcome_agree");
        return;
    }
    count(check, "prefilter.outcome_disagree");
    let shown: String = command.chars().take(defaults::num("prefilter.log_command_chars") as usize).collect();
    crate::health::log_event(defaults::text("prefilter.log_kind"), check, &defaults::render("prefilter.msg_disagree", &[("check", &check), ("command", &shown)]));
    if defaults::num("prefilter.auto_disable") == 1 {
        LATCH.store(2, SeqCst);
        let path = latch_path();
        if let Some(dir) = path.parent() {
            crate::discard::harmless(std::fs::create_dir_all(dir)); // keep: the write below reports the failure that matters
        }
        if let Err(e) = crate::atomic::write(&path, check.as_bytes()) {
            crate::discard::note("prefilter_latch", &e.to_string());
        }
    }
}

/// Test only: re-read the latch from disk at the next call.
#[cfg(test)]
pub(crate) fn reset_latch_for_test() {
    LATCH.store(0, SeqCst);
}

#[cfg(test)]
mod tests;
