//! The registry reader the stop-time stale-binary gate of the silent-agent nudge shares with the (now scripted) `version-alert`
//! check, and the JSON reader (`jval`) that gate parses with. The session-maintenance checks themselves (`version-alert`,
//! `devswarm-version`, `claude-cli-version`, `repo-self-drift`, `defect-nudge`, `progress-prune`) are plugin scripts.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an unreadable optional file is the same as an absent one (fail-open, as Node's try/catch)
// A failure that must be seen goes through `crate::discard` instead.

pub mod jval;
pub mod version_alert;

/// `fs.readFileSync(path, 'utf8')`: `None` on any error (absent, a directory, unreadable).
pub(crate) fn read_text(path: &str) -> Option<String> {
    std::fs::read(path).ok().map(crate::checks::guardkit::text::lossy_owned)
}

/// `path.join(a, b)` for two path strings.
pub(crate) fn join(a: &str, b: &str) -> String {
    crate::checks::guardkit::paths::join(a, b)
}
