//! The one message layout every guard block or advisory uses (`hooks/lib/block-message.js` `message`), and the JSON
//! envelope an advisory travels in.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - serializing a string cannot fail
// A failure that must be seen goes through `crate::discard` instead.

use crate::checks::guardkit::text::{collapse_ws, js_trim};
use crate::defaults;

/// What kind of message this is; picks the leading icon.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// Blocked.
    Block,
    /// Warning or advisory.
    Warn,
    /// Tip or nudge.
    Tip,
    /// An update is available.
    Update,
    /// Confirmation (the check passed and says so).
    Ok,
}

impl Kind {
    fn key(self) -> &'static str {
        match self {
            Kind::Block => "block",
            Kind::Warn => "warn",
            Kind::Tip => "tip",
            Kind::Update => "update",
            Kind::Ok => "ok",
        }
    }
}

/// The lines of a message; empty strings are left out.
#[derive(Debug, Default, Clone)]
pub struct Parts<'a> {
    /// What happened.
    pub what: &'a str,
    /// Why it matters.
    pub why: &'a str,
    /// What to do instead.
    pub instead: &'a str,
    /// What stays allowed.
    pub allowed: &'a str,
    /// The exact override, if any.
    pub override_: &'a str,
    /// Extra plain lines appended last (`extra` of `block-message.js`); an empty one is left out.
    pub extra: &'a [&'a str],
}

/// `clean()` of block-message.js: collapse white space runs and trim.
fn clean(s: &str) -> String {
    js_trim(&collapse_ws(s)).to_string()
}

/// Build the message text.
///
/// Mirrors `hooks/lib/block-message.js` `message`.
pub fn message(kind: Kind, guard: &str, p: &Parts<'_>) -> String {
    let icon = defaults::raw("guardkit.icons").str_field(kind.key());
    let labels = defaults::raw("guardkit.msg_labels");
    let mut lines = vec![format!("{icon}{}{}: {}", defaults::text("guardkit.msg_head"), clean(guard), clean(p.what))];
    for (label, text) in [("why", p.why), ("instead", p.instead), ("allowed", p.allowed), ("override", p.override_)] {
        if !text.is_empty() {
            lines.push(format!("{}{}", labels.str_field(label), clean(text)));
        }
    }
    for l in p.extra.iter().filter(|l| !l.is_empty()) {
        lines.push(clean(l));
    }
    lines.join("\n")
}

/// The stdout line a PreToolUse or PostToolUse advisory prints: `hookSpecificOutput` with the event name and the text,
/// in the key order the Node guards write (a `serde_json::json!` object would sort them).
pub fn advisory_json(event: &str, text: &str) -> String {
    let ev = serde_json::to_string(event).unwrap_or_default();
    let t = serde_json::to_string(text).unwrap_or_default();
    format!("{{\"hookSpecificOutput\":{{\"hookEventName\":{ev},\"additionalContext\":{t}}}}}")
}

/// The message `key` with each `{name}` replaced by its value in one pass, so a value that itself contains `{other}`
/// is never expanded again (`defaults::render` replaces name by name and would).
pub fn render(key: &str, args: &[(&str, &str)]) -> String {
    let t = defaults::text(key);
    let mut out = String::with_capacity(t.len() + 32);
    let mut rest = t;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let tail = &rest[open..];
        match args.iter().find(|(n, _)| tail[1..].starts_with(n) && tail[1 + n.len()..].starts_with('}')) {
            Some((n, v)) => {
                out.push_str(v);
                rest = &tail[n.len() + 2..];
            }
            None => {
                out.push('{');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}
