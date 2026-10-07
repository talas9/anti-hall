//! Built-in check `fable-availability` (SessionStart): record whether a Fable model is available, from the host's own
//! model cache in `~/.claude.json`, and tell the session when it is.
//!
//! The check writes `~/.anti-hall/fable-availability.json` (`available`, `checkedAt`, `source`, in that key order) on every
//! run, exactly as the Node hook does, and prints the availability message only when `available` is true. A config file
//! the JSON reader here rejects is not guessed at: the check defers, and the Node hook (whose reader differs at the
//! edges) decides and writes the state itself (D74).
//!
//! Mirrors `hooks/fable-availability.js`.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an absent field is the empty value
// - text that does not parse or decode is the absent value (Node Number()/JSON.parse catch parity)
// A failure that must be seen goes through `crate::discard` instead.

use crate::checks::git::util::Settings;
use crate::checks::guardkit::msg::{self, Kind, Parts, advisory_json};
use crate::checks::{Check, Verdict};
use crate::defaults;
use crate::reqenv::RequestEnv;
use crate::rules::Subject;
use serde_json::Value;

#[cfg(test)]
mod tests;

/// What the model cache says: `available` is `None` when it says nothing about Fable.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub struct Found {
    /// Whether a Fable model is available.
    pub available: Option<bool>,
    /// Which cache said so (`unknown` when none did).
    pub source: &'static str,
}

/// `hasFable(value)`: a string whose lower-case form contains the needle.
fn has_fable(v: Option<&Value>) -> bool {
    v.and_then(Value::as_str).is_some_and(|s| s.to_lowercase().contains(defaults::text("fable_availability.needle")))
}

/// `detectAvailability(config)`. A config that is not an object says nothing (Node reads a property of it, which is
/// undefined for every non-object but `null`, where the read throws and the caller treats it the same way).
pub fn detect(config: &Value) -> Found {
    let unknown = Found { available: None, source: defaults::text("fable_availability.unknown_source") };
    let Some(cfg) = config.as_object() else { return unknown };
    let access = defaults::raw("fable_availability.access_list");
    if let Some(list) = cfg.get(access.str_field("key")).and_then(Value::as_array) {
        for e in list.iter().filter_map(Value::as_object) {
            if has_fable(e.get(access.str_field("name_field"))) {
                return Found { available: Some(e.get(access.str_field("entitled_field")) == Some(&Value::Bool(true))), source: access.str_field("source") };
            }
        }
    }
    let opts = defaults::raw("fable_availability.options_list");
    if let Some(list) = cfg.get(opts.str_field("key")).and_then(Value::as_array) {
        let fields = opts.get("name_fields").map(defaults::V::strings).unwrap_or_default();
        for e in list.iter().filter_map(Value::as_object) {
            if fields.iter().any(|f| has_fable(e.get(*f))) {
                return Found { available: Some(e.get(opts.str_field("disabled_field")) != Some(&Value::Bool(true))), source: opts.str_field("source") };
            }
        }
    }
    unknown
}

/// Replace every unpaired surrogate escape (`\uD800` to `\uDFFF` with no partner) with U+FFFD, so a reader that rejects
/// them (JSON.parse accepts them) can still read the file. Only the escape's own text changes; a name that contained one
/// still contains the rest of its letters.
fn fix_lone_surrogates(src: &str) -> String {
    let b = src.as_bytes();
    let hex4 =
        |at: usize| -> Option<u32> { src.get(at..at + 4).filter(|h| h.bytes().all(|c| c.is_ascii_hexdigit())).and_then(|h| u32::from_str_radix(h, 16).ok()) };
    let mut out = String::with_capacity(src.len());
    let (mut i, mut last) = (0usize, 0usize);
    while i < b.len() {
        if b[i] != b'\\' {
            i += 1;
            continue;
        }
        let unit = if b.get(i + 1) == Some(&b'u') { hex4(i + 2) } else { None };
        match unit {
            Some(0xD800..=0xDBFF)
                if b.get(i + 6) == Some(&b'\\') && b.get(i + 7) == Some(&b'u') && hex4(i + 8).is_some_and(|l| (0xDC00..=0xDFFF).contains(&l)) =>
            {
                i += 12
            }
            Some(0xD800..=0xDFFF) => {
                out.push_str(&src[last..i]);
                out.push_str("\\uFFFD");
                i += 6;
                last = i;
            }
            Some(_) => i += 6,
            None => i += 2,
        }
    }
    out.push_str(&src[last..]);
    out
}

/// Read and parse the config: `Ok(None)` when the file cannot be read (Node: nothing known), `Err(())` when it can be read
/// but not parsed here.
fn read_config(home: &str) -> Result<Option<Value>, ()> {
    let Ok(bytes) = std::fs::read(format!("{home}/{}", defaults::text("fable_availability.config_file"))) else { return Ok(None) };
    let text = String::from_utf8_lossy(&bytes);
    match serde_json::from_str::<Value>(&text) {
        Ok(v) => Ok(Some(v)),
        Err(_) => serde_json::from_str::<Value>(&fix_lone_surrogates(&text)).map(Some).map_err(|_| ()),
    }
}

/// The state file's text, with keys in the order Node writes them.
fn state_json(f: Found, now_ms: u128) -> String {
    let available = match f.available {
        Some(true) => "true",
        Some(false) => "false",
        None => "null",
    };
    format!("{{\"available\":{available},\"checkedAt\":{now_ms},\"source\":\"{}\"}}", f.source)
}

/// The check's decision. `None`: nothing to say.
///
/// Mirrors `hooks/fable-availability.js` `main`.
pub fn decide(st: &Settings) -> Option<Verdict> {
    let e = defaults::raw("verify_first.judge_child_env");
    if st.env.get(e.str_field("name")).is_some_and(|v| v == e.str_field("on")) {
        return Some(Verdict::Allow);
    }
    if st.home.is_empty() {
        return Some(Verdict::Defer);
    }
    let found = match read_config(&st.home) {
        Ok(Some(cfg)) => detect(&cfg),
        Ok(None) => Found { available: None, source: defaults::text("fable_availability.unknown_source") },
        Err(()) => return Some(Verdict::Defer),
    };
    let state = format!("{}/{}", st.home, defaults::text("fable_availability.state_file"));
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let wrote =
        std::path::Path::new(&state).parent().is_some_and(|d| std::fs::create_dir_all(d).is_ok()) && std::fs::write(&state, state_json(found, now)).is_ok();
    if !wrote || found.available != Some(true) {
        return Some(Verdict::Allow);
    }
    let text = msg::message(
        Kind::Tip,
        defaults::text("fable_availability.guard_name"),
        &Parts {
            what: defaults::text("fable_availability.msg_what"),
            why: defaults::text("fable_availability.msg_why"),
            instead: defaults::text("fable_availability.msg_instead"),
            ..Parts::default()
        },
    );
    Some(Verdict::Advisory(advisory_json("SessionStart", &text)))
}

/// The registered `fable-availability` check.
pub struct FableAvailability;

impl Check for FableAvailability {
    fn name(&self) -> &'static str {
        "fable-availability"
    }

    fn summary(&self) -> &'static str {
        defaults::text("fable_availability.summary")
    }

    fn run(&self, _s: &Subject<'_>, _opts: &Value) -> Option<Verdict> {
        Some(Verdict::Defer)
    }

    fn run_env(&self, _s: &Subject<'_>, _payload: &Value, _opts: &Value, env: &RequestEnv) -> Option<Verdict> {
        decide(&Settings::from_env(env))
    }
}
