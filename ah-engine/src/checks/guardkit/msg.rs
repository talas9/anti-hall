//! The one message layout every guard block or advisory uses (`hooks/lib/block-message.js` `message`), and the JSON
//! envelope an advisory travels in.
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
}

impl Kind {
    fn key(self) -> &'static str {
        match self {
            Kind::Block => "block",
            Kind::Warn => "warn",
            Kind::Tip => "tip",
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
}

/// `clean()` of block-message.js: collapse white space runs and trim.
fn clean(s: &str) -> String {
    js_trim(&collapse_ws(s)).to_string()
}

/// Build the message text.
///
/// Mirrors `hooks/lib/block-message.js` `message` (the `extra` lines are not used by these guards).
pub fn message(kind: Kind, guard: &str, p: &Parts<'_>) -> String {
    let icon = defaults::raw("guardkit.icons").str_field(kind.key());
    let labels = defaults::raw("guardkit.msg_labels");
    let mut lines = vec![format!("{icon}{}{}: {}", defaults::text("guardkit.msg_head"), clean(guard), clean(p.what))];
    for (label, text) in [("why", p.why), ("instead", p.instead), ("allowed", p.allowed), ("override", p.override_)] {
        if !text.is_empty() {
            lines.push(format!("{}{}", labels.str_field(label), clean(text)));
        }
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
