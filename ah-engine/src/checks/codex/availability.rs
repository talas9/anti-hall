//! Built-in `check = "codex-availability"`: port of `hooks/codex-availability.js` (SessionStart).
//!
//! Probes PATH for a real `codex` executable, merges the result into `~/.anti-hall/codex-availability.json`, folds a
//! usage-limit error from a background Codex job log into the quota record, and tells the session when the binary is
//! reachable or an outage is recorded.
use super::quota::{self, Unsure};
use crate::checks::git::util::posix_normalize;
use crate::checks::guardkit::msg::{self, Kind, Parts};
use crate::checks::guardkit::settings::get_bool;
use crate::checks::jsport::json::J;
use crate::checks::jsport::{date, fsx, home, text as jstext};
use crate::checks::{Check, Verdict};
use crate::defaults;
use crate::reqenv::RequestEnv;
use crate::rules::Subject;
use serde_json::Value;

/// `detectPlatform(payload) === 'codex'` (`hooks/lib/auto-handover-text.js`): a turn id, or a Codex rollout transcript.
pub fn is_codex_payload(p: &Value) -> bool {
    if jstext::str_member(p, "turn_id").is_some_and(|s| !s.is_empty()) {
        return true;
    }
    let Some(tp) = jstext::str_member(p, "transcript_path") else { return false };
    let seps = |c: char| c == '/' || c == '\\';
    let last = tp.rsplit(seps).next().unwrap_or("");
    let (head, tail) = (defaults::text("codex_handover.rollout_prefix"), defaults::text("codex_handover.rollout_suffix"));
    if last.starts_with(head) && last.ends_with(tail) && last.len() >= head.len() + tail.len() {
        return true;
    }
    let dir = defaults::text("codex_handover.codex_dir_name");
    tp.match_indices(dir).any(|(i, _)| tp[..i].ends_with(seps) && tp[i + dir.len()..].starts_with(seps))
}

/// `isRealExecutable`: a regular file (never a directory) that this process may execute.
fn real_executable(p: &str) -> bool {
    fsx::is_file(p) && fsx::is_executable(p)
}

/// `probeCodexOnPath` on POSIX: every non-empty PATH entry, joined to the binary name the way `path.join` does.
fn probe(path_var: &str) -> bool {
    let name = defaults::text("codex_handover.codex_binary");
    path_var.split(defaults::text("codex_handover.path_separator")).filter(|d| !d.is_empty()).any(|d| real_executable(&posix_normalize(&format!("{d}/{name}"))))
}

fn context(codex: bool) -> String {
    if codex {
        return defaults::text("codex_handover.avail_context_codex").to_string();
    }
    msg::message(
        Kind::Tip,
        defaults::text("codex_handover.avail_guard"),
        &Parts {
            what: defaults::text("codex_handover.avail_what"),
            why: defaults::text("codex_handover.avail_why"),
            instead: defaults::text("codex_handover.avail_instead"),
            ..Parts::default()
        },
    )
}

/// `quotaNote`: a warning line while a recorded outage is live, else nothing.
fn quota_note(home: &str, codex: bool) -> Result<String, Unsure> {
    let Some(q) = quota::read_quota(home, date::now_ms())? else { return Ok(String::new()) };
    let Some(until) = date::to_iso(q.until) else { return Ok(String::new()) };
    let what = msg::render("codex_handover.avail_note_what", &[("until", &until), ("reason", &q.reason)]);
    let instead = msg::render(
        "codex_handover.avail_note_instead",
        &[("tier", defaults::text(if codex { "codex_handover.avail_tier_codex" } else { "codex_handover.avail_tier_claude" }))],
    );
    Ok(msg::message(Kind::Warn, defaults::text("codex_handover.avail_guard"), &Parts { what: &what, instead: &instead, ..Parts::default() }) + "\n")
}

/// The check's decision on one payload.
pub fn decide(p: &Value, env: &RequestEnv) -> Result<Option<Verdict>, Unsure> {
    let _zone = crate::checks::jsport::date::ZoneGuard::new(env);
    if super::judge_child(env) {
        return Ok(None);
    }
    let Some(home) = home::resolve(env) else { return Err(Unsure) };
    let codex = is_codex_payload(p);
    let available = probe(env.get("PATH").unwrap_or(""));
    // writeState: merge, never clobber the quota half of the file.
    let mut merged = quota::read_raw_for_write(&home)?;
    let path = quota::state_path(&home);
    if !fsx::mkdir_p(&crate::checks::git::util::posix_dirname(&path)) {
        return Ok(None);
    }
    merged.set("available", J::Bool(available));
    merged.set("checkedAt", J::Num(date::now_ms()));
    merged.set("source", J::Str(defaults::text("codex_handover.avail_source").to_string()));
    if crate::atomic::write(&path, crate::checks::jsport::json::stringify(&merged)).is_err() {
        return Ok(None);
    }
    let st = super::settings_of(env);
    if get_bool(&st, defaults::raw("codex_handover.setting_quota_detect")) {
        quota::scan_job_logs(&home, date::now_ms())?;
    }
    let prefix = quota_note(&home, codex)?;
    if !available && prefix.is_empty() {
        return Ok(None);
    }
    let text = format!("{prefix}{}", context(codex));
    Ok(Some(Verdict::Advisory(msg::advisory_json(defaults::text("codex_handover.avail_event"), &text))))
}

/// The registered `codex-availability` check.
pub struct CodexAvailability;

impl Check for CodexAvailability {
    fn name(&self) -> &'static str {
        "codex-availability"
    }

    fn summary(&self) -> &'static str {
        defaults::text("codex_handover.avail_summary")
    }

    fn run(&self, _s: &Subject<'_>, _opts: &Value) -> Option<Verdict> {
        Some(Verdict::Defer)
    }

    fn run_env(&self, _s: &Subject<'_>, payload: &Value, _opts: &Value, env: &RequestEnv) -> Option<Verdict> {
        match decide(payload, env) {
            Ok(v) => v.or(Some(Verdict::Allow)),
            Err(Unsure) => Some(Verdict::Defer),
        }
    }
}
