//! The telemetry event schema (D78, D77): fixed short fields and typed extras, and no way to hold free text.
//!
//! A telemetry event describes WHAT happened (which hook or check, on which event, with which outcome, how long it
//! took, how many bytes it injected) and never the content it happened to: no prompt, transcript or file text. That
//! rule is enforced by the types, not by discipline: the only strings an [`Event`] can hold are [`Token`]s, which can be
//! built only from a short identifier (letters, digits and `._:/[]@+-`), so a sentence, a path with spaces or a prompt
//! cannot be stored. The JSON reader ([`Event::from_json`]) rejects unknown fields for the same reason.
//!
//! The short field names mirror the kinds of the Node `hooks/lib/telemetry.js` (`h`, `e`, `o`, `ms`, `ib`); there is no
//! Node writer (D80), the engine records everything.
use crate::defaults;
use serde_json::{Map, Value, json};
use std::fmt;

/// Why a telemetry value was refused. Display text comes from the shipped messages; match on [`TelemetryError::code`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TelemetryError {
    /// A string was not an identifier-shaped token (empty, too long, or holding other characters).
    BadToken,
    /// A line is not a JSON object.
    NotObject,
    /// A required field is missing or has the wrong type.
    Field(&'static str),
    /// A field the schema does not have (this is how free text is kept out).
    UnknownField,
    /// The kind or outcome name is not one the schema defines.
    UnknownName,
    /// The timestamp is neither a millisecond number nor an RFC 3339 UTC text.
    BadTime,
}

impl TelemetryError {
    /// A stable short code for reports.
    pub fn code(&self) -> &'static str {
        match self {
            TelemetryError::BadToken => "bad_token",
            TelemetryError::NotObject => "not_object",
            TelemetryError::Field(_) => "bad_field",
            TelemetryError::UnknownField => "unknown_field",
            TelemetryError::UnknownName => "unknown_name",
            TelemetryError::BadTime => "bad_time",
        }
    }
}

impl fmt::Display for TelemetryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let field = if let TelemetryError::Field(n) = self { *n } else { "" };
        f.write_str(&defaults::render("msg.tel_err", &[("code", &self.code()), ("field", &field)]))
    }
}

impl std::error::Error for TelemetryError {}

/// What kind of thing was recorded (`k`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// A whole hook request.
    Hook,
    /// One built-in check or regex rule inside a hook.
    Check,
    /// A model-routing decision at agent spawn (D77).
    Route,
    /// The result of a spawn, linked to its route event by `spawn_key` (D77).
    Spawn,
    /// A Jev call.
    Jev,
    /// Hook output that was too large to inject and was spilled to a file.
    Spill,
}

impl Kind {
    /// The short name written in events and used as the `k` counter label.
    pub fn name(self) -> &'static str {
        match self {
            Kind::Hook => "hook",
            Kind::Check => "check",
            Kind::Route => "route",
            Kind::Spawn => "spawn",
            Kind::Jev => "jev",
            Kind::Spill => "spill",
        }
    }

    /// The kind with this short name.
    pub fn parse(s: &str) -> Option<Kind> {
        Some(match s {
            "hook" => Kind::Hook,
            "check" => Kind::Check,
            "route" => Kind::Route,
            "spawn" => Kind::Spawn,
            "jev" => Kind::Jev,
            "spill" => Kind::Spill,
            _ => return None,
        })
    }
}

/// What a recorded invocation ended in (`o`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// Nothing to say; the call went ahead.
    Allow,
    /// The call was refused.
    Block,
    /// Text was added for the agent (an advisory, a warning, context).
    Advise,
    /// The engine did not decide; the Node hook ran instead.
    Defer,
    /// The invocation failed.
    Error,
    /// The invocation did not apply (disabled, wrong tool, rate limited).
    Skip,
}

impl Outcome {
    /// The short name written in events and used as the `o` counter label.
    pub fn name(self) -> &'static str {
        match self {
            Outcome::Allow => "allow",
            Outcome::Block => "block",
            Outcome::Advise => "advise",
            Outcome::Defer => "defer",
            Outcome::Error => "error",
            Outcome::Skip => "skip",
        }
    }

    /// The outcome with this short name.
    pub fn parse(s: &str) -> Option<Outcome> {
        Some(match s {
            "allow" => Outcome::Allow,
            "block" => Outcome::Block,
            "advise" => Outcome::Advise,
            "defer" => Outcome::Defer,
            "error" => Outcome::Error,
            "skip" => Outcome::Skip,
            _ => return None,
        })
    }
}

/// What the model-routing check did with a spawn (D77).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RouteOutcome {
    /// Steered to a cheaper model than the one asked for or inherited.
    Down,
    /// Steered to a stronger model.
    Up,
    /// Allowed as asked.
    Allow,
    /// Exempt from routing (for example an explicitly pinned model).
    Exempt,
}

impl RouteOutcome {
    /// The short name written in events.
    pub fn name(self) -> &'static str {
        match self {
            RouteOutcome::Down => "down",
            RouteOutcome::Up => "up",
            RouteOutcome::Allow => "allow",
            RouteOutcome::Exempt => "exempt",
        }
    }

    /// The route outcome with this short name.
    pub fn parse(s: &str) -> Option<RouteOutcome> {
        Some(match s {
            "down" => RouteOutcome::Down,
            "up" => RouteOutcome::Up,
            "allow" => RouteOutcome::Allow,
            "exempt" => RouteOutcome::Exempt,
            _ => return None,
        })
    }
}

/// A short identifier: the only kind of string a telemetry event can hold. Built with [`Token::new`] (strict: refuses
/// anything else) or [`Token::sanitize`] (lossy: for names that arrive from outside on the hot path).
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Token(String);

/// True for the characters a token may hold.
fn token_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == ':' || c == '/' || c == '[' || c == ']' || c == '@' || c == '+' || c == '-'
}

impl Token {
    /// A token from `s`, or an error when `s` is empty, longer than `telemetry.token_max_len`, or holds a character
    /// outside the identifier set (so a sentence, a path with spaces or any prose is refused).
    pub fn new(s: &str) -> Result<Token, TelemetryError> {
        if s.is_empty() || s.len() > defaults::num("telemetry.token_max_len") as usize || !s.chars().all(token_char) {
            return Err(TelemetryError::BadToken);
        }
        Ok(Token(s.to_string()))
    }

    /// A token from `s` with every other character replaced by `_` and the length capped: never fails, never keeps text.
    pub fn sanitize(s: &str) -> Token {
        Token(sanitize_name(s.as_bytes()).unwrap_or_else(|| defaults::text("telemetry.overflow_label").to_string()))
    }

    /// The token text.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for Token {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// `b` as a token-shaped string: capped to `telemetry.token_max_len` bytes, every byte outside the identifier set
/// replaced by `_`. `None` for empty input.
pub fn sanitize_name(b: &[u8]) -> Option<String> {
    let cap = defaults::num("telemetry.token_max_len") as usize;
    let b = &b[..b.len().min(cap)];
    if b.is_empty() {
        return None;
    }
    Some(b.iter().map(|&x| if x.is_ascii() && token_char(x as char) { x as char } else { '_' }).collect())
}

/// Token counts of one agent run, per class (D77).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Usage {
    /// Input tokens.
    pub input: u64,
    /// Output tokens.
    pub output: u64,
    /// Cache-read tokens.
    pub cache_read: u64,
    /// Cache-write tokens.
    pub cache_write: u64,
}

/// A model-routing decision (D77): what was asked for, what the table recommended, what the check did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Route {
    /// The model the agent asked for (or the parent's, when it inherited).
    pub requested_model: Token,
    /// The orchestrator's own model.
    pub parent_model: Token,
    /// The task class the check assigned.
    pub task_class: Token,
    /// The tier the routing table recommends.
    pub recommended_tier: Token,
    /// What the check did.
    pub outcome: RouteOutcome,
    /// Opaque key linking this decision to the spawn result.
    pub spawn_key: Token,
}

/// The result of a spawn: the model it actually ran on and what it used (D77).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Spawn {
    /// The key of the route event this spawn belongs to.
    pub spawn_key: Token,
    /// The model the agent ran on.
    pub actual_model: Token,
    /// What it used.
    pub usage: Usage,
}

/// A Jev call (the call's latency is the event's `ms`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Jev {
    /// Which integration asked.
    pub integration: Token,
    /// Its mode (on, shadow, off).
    pub mode: Token,
    /// The verdict returned.
    pub verdict: Token,
    /// What the call cost, in micro-dollars.
    pub cost_uc: u64,
}

/// Typed extras per kind. No variant holds free text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Extras {
    /// Nothing beyond the fixed fields.
    None,
    /// A routing decision.
    Route(Route),
    /// A spawn result.
    Spawn(Spawn),
    /// A Jev call.
    Jev(Jev),
    /// A spilled injection: its size in bytes.
    Spill(u64),
}

/// One telemetry event: the fixed short fields (`k`, `h`, `e`, `o`, `ms`, `ib`) plus typed extras.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Event {
    /// When it happened, milliseconds since the Unix epoch.
    pub ts_ms: u64,
    /// `k`: the kind.
    pub kind: Kind,
    /// `h`: the hook or check.
    pub h: Token,
    /// `e`: the hook event.
    pub e: Token,
    /// `o`: the outcome.
    pub o: Outcome,
    /// `ms`: latency in whole milliseconds, rounded up (the counters keep the microsecond histogram).
    pub ms: u32,
    /// `ib`: bytes injected into model context.
    pub ib: u64,
    /// Typed extras.
    pub extras: Extras,
}

/// The fixed fields every event line has.
const FIXED: &[&str] = &["ts", "k", "h", "e", "o", "ms", "ib"];

/// The extra fields a kind's events carry; every other field name is refused.
fn extra_fields(kind: Kind) -> &'static [&'static str] {
    match kind {
        Kind::Route => &["requested_model", "parent_model", "task_class", "recommended_tier", "outcome", "spawn_key"],
        Kind::Spawn => &["spawn_key", "actual_model", "in", "out", "cr", "cw"],
        Kind::Jev => &["integration", "mode", "verdict", "cost_uc"],
        Kind::Spill => &["bytes"],
        Kind::Hook | Kind::Check => &[],
    }
}

impl Event {
    /// The spawn key, when the event has one.
    pub fn spawn_key(&self) -> Option<&str> {
        match &self.extras {
            Extras::Route(r) => Some(r.spawn_key.as_str()),
            Extras::Spawn(s) => Some(s.spawn_key.as_str()),
            _ => None,
        }
    }

    /// The compact JSON form: short fields, extras flattened next to them.
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("ts".into(), json!(self.ts_ms));
        m.insert("k".into(), json!(self.kind.name()));
        m.insert("h".into(), json!(self.h.as_str()));
        m.insert("e".into(), json!(self.e.as_str()));
        m.insert("o".into(), json!(self.o.name()));
        m.insert("ms".into(), json!(self.ms));
        m.insert("ib".into(), json!(self.ib));
        match &self.extras {
            Extras::None => {}
            Extras::Route(r) => {
                m.insert("requested_model".into(), json!(r.requested_model.as_str()));
                m.insert("parent_model".into(), json!(r.parent_model.as_str()));
                m.insert("task_class".into(), json!(r.task_class.as_str()));
                m.insert("recommended_tier".into(), json!(r.recommended_tier.as_str()));
                m.insert("outcome".into(), json!(r.outcome.name()));
                m.insert("spawn_key".into(), json!(r.spawn_key.as_str()));
            }
            Extras::Spawn(s) => {
                m.insert("spawn_key".into(), json!(s.spawn_key.as_str()));
                m.insert("actual_model".into(), json!(s.actual_model.as_str()));
                m.insert("in".into(), json!(s.usage.input));
                m.insert("out".into(), json!(s.usage.output));
                m.insert("cr".into(), json!(s.usage.cache_read));
                m.insert("cw".into(), json!(s.usage.cache_write));
            }
            Extras::Jev(j) => {
                m.insert("integration".into(), json!(j.integration.as_str()));
                m.insert("mode".into(), json!(j.mode.as_str()));
                m.insert("verdict".into(), json!(j.verdict.as_str()));
                m.insert("cost_uc".into(), json!(j.cost_uc));
            }
            Extras::Spill(b) => {
                m.insert("bytes".into(), json!(b));
            }
        }
        Value::Object(m)
    }

    /// Read one event line. Strict: an unknown field, a value of the wrong type or a string that is not a [`Token`]
    /// refuses the whole line, so nothing but identifiers can enter the store.
    pub fn from_json(v: &Value) -> Result<Event, TelemetryError> {
        let m = v.as_object().ok_or(TelemetryError::NotObject)?;
        let tok = |name: &'static str| -> Result<Token, TelemetryError> { Token::new(m.get(name).and_then(Value::as_str).ok_or(TelemetryError::Field(name))?) };
        let num = |name: &'static str| -> Result<u64, TelemetryError> {
            match m.get(name) {
                None => Ok(0),
                Some(x) => x.as_u64().ok_or(TelemetryError::Field(name)),
            }
        };
        let name_of = |name: &'static str| -> Result<&str, TelemetryError> { m.get(name).and_then(Value::as_str).ok_or(TelemetryError::Field(name)) };
        let kind = Kind::parse(name_of("k")?).ok_or(TelemetryError::UnknownName)?;
        // a field the kind does not use is a schema violation: this is what keeps free text out of an event
        let extra = extra_fields(kind);
        if m.keys().any(|k| !FIXED.contains(&k.as_str()) && !extra.contains(&k.as_str())) {
            return Err(TelemetryError::UnknownField);
        }
        let ts_ms = match m.get("ts") {
            Some(Value::Number(n)) => n.as_u64().ok_or(TelemetryError::BadTime)?,
            Some(Value::String(s)) => parse_rfc3339_ms(s).ok_or(TelemetryError::BadTime)?,
            _ => return Err(TelemetryError::Field("ts")),
        };
        let o = Outcome::parse(name_of("o")?).ok_or(TelemetryError::UnknownName)?;
        let extras = match kind {
            Kind::Route => Extras::Route(Route {
                requested_model: tok("requested_model")?,
                parent_model: tok("parent_model")?,
                task_class: tok("task_class")?,
                recommended_tier: tok("recommended_tier")?,
                outcome: RouteOutcome::parse(name_of("outcome")?).ok_or(TelemetryError::UnknownName)?,
                spawn_key: tok("spawn_key")?,
            }),
            Kind::Spawn => Extras::Spawn(Spawn {
                spawn_key: tok("spawn_key")?,
                actual_model: tok("actual_model")?,
                usage: Usage { input: num("in")?, output: num("out")?, cache_read: num("cr")?, cache_write: num("cw")? },
            }),
            Kind::Jev => Extras::Jev(Jev { integration: tok("integration")?, mode: tok("mode")?, verdict: tok("verdict")?, cost_uc: num("cost_uc")? }),
            Kind::Spill => Extras::Spill(num("bytes")?),
            Kind::Hook | Kind::Check => Extras::None,
        };
        Ok(Event { ts_ms, kind, h: tok("h")?, e: tok("e")?, o, ms: num("ms")?.min(u32::MAX as u64) as u32, ib: num("ib")?, extras })
    }
}

/// Milliseconds in a UTC day.
pub const DAY_MS: u64 = 86_400_000;

/// Days since the Unix epoch of a millisecond timestamp (UTC).
pub fn day_of(ts_ms: u64) -> i64 {
    (ts_ms / DAY_MS) as i64
}

/// Milliseconds since the epoch of an RFC 3339 UTC timestamp (`YYYY-MM-DDTHH:MM:SS[.fff]Z`); `None` for any other shape.
pub fn parse_rfc3339_ms(s: &str) -> Option<u64> {
    let b = s.as_bytes();
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' || *b.last()? != b'Z' {
        return None;
    }
    let n = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
    let (y, mo, d, h, mi, se) = (n(0..4)?, n(5..7)?, n(8..10)?, n(11..13)?, n(14..16)?, n(17..19)?);
    let frac = match &s[19..s.len() - 1] {
        "" => 0,
        f if f.starts_with('.') && f.len() > 1 && f[1..].bytes().all(|c| c.is_ascii_digit()) => format!("{:0<3}", &f[1..])[..3].parse::<i64>().ok()?,
        _ => return None,
    };
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || se > 60 || y < 1970 {
        return None;
    }
    // days from civil (Howard Hinnant's algorithm)
    let y2 = if mo <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let doy = (153 * (if mo > 2 { mo - 3 } else { mo + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let secs = ((days * 24 + h) * 60 + mi) * 60 + se;
    u64::try_from(secs * 1000 + frac).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn route() -> Event {
        Event {
            ts_ms: 1_700_000_000_000,
            kind: Kind::Route,
            h: Token::new("model-routing").unwrap(),
            e: Token::new("PreToolUse").unwrap(),
            o: Outcome::Advise,
            ms: 2,
            ib: 310,
            extras: Extras::Route(Route {
                requested_model: Token::new("opus").unwrap(),
                parent_model: Token::new("opus").unwrap(),
                task_class: Token::new("mechanical").unwrap(),
                recommended_tier: Token::new("haiku").unwrap(),
                outcome: RouteOutcome::Down,
                spawn_key: Token::new("0123456789abcdef").unwrap(),
            }),
        }
    }

    #[test]
    fn an_event_round_trips_through_its_json_form() {
        let e = route();
        assert_eq!(Event::from_json(&e.to_json()).unwrap(), e);
        let usage = Usage { input: 1, output: 2, cache_read: 3, cache_write: 4 };
        for (kind, ex) in [
            (Kind::Spawn, Extras::Spawn(Spawn { spawn_key: Token::new("k1").unwrap(), actual_model: Token::new("haiku").unwrap(), usage })),
            (
                Kind::Jev,
                Extras::Jev(Jev {
                    integration: Token::new("speculation").unwrap(),
                    mode: Token::new("on").unwrap(),
                    verdict: Token::new("keep").unwrap(),
                    cost_uc: 12,
                }),
            ),
            (Kind::Spill, Extras::Spill(9000)),
            (Kind::Hook, Extras::None),
        ] {
            let e = Event { kind, extras: ex, ..route() };
            assert_eq!(Event::from_json(&e.to_json()).unwrap(), e);
        }
    }

    #[test]
    fn free_text_cannot_be_stored() {
        // a token is an identifier: prose, spaces, newlines, quotes and over-long strings are refused
        for bad in ["fix the login bug", "a b", "line\nbreak", "say \"hi\"", "", &"x".repeat(200), "päth", "rm -rf /;"] {
            assert_eq!(Token::new(bad), Err(TelemetryError::BadToken), "{bad:?}");
        }
        assert!(Token::new("claude-opus-4-5").is_ok() && Token::new("inherit:opus[1m]").is_ok());
        // sanitize never keeps prose either
        assert_eq!(Token::sanitize("fix the login bug").as_str(), "fix_the_login_bug");
        assert!(Token::sanitize(&"y".repeat(500)).as_str().len() <= defaults::num("telemetry.token_max_len") as usize);
        // a line with a text-bearing field, or a text value in an identifier field, is refused whole
        let mut v = route().to_json();
        v["prompt"] = json!("please fix the login bug");
        assert_eq!(Event::from_json(&v), Err(TelemetryError::UnknownField));
        let mut v = route().to_json();
        v["task_class"] = json!("please fix the login bug");
        assert_eq!(Event::from_json(&v), Err(TelemetryError::BadToken));
        // an extra of another kind is refused too
        let mut v = route().to_json();
        v["bytes"] = json!(1);
        assert_eq!(Event::from_json(&v), Err(TelemetryError::UnknownField));
    }

    #[test]
    fn timestamps_accept_milliseconds_and_rfc3339() {
        assert_eq!(parse_rfc3339_ms("1970-01-01T00:00:01Z"), Some(1000));
        assert_eq!(parse_rfc3339_ms("2023-11-14T22:13:20.123Z"), Some(1_700_000_000_123));
        assert_eq!(parse_rfc3339_ms("2023-11-14 22:13:20Z"), None);
        let mut v = route().to_json();
        v["ts"] = json!("2023-11-14T22:13:20Z");
        assert_eq!(Event::from_json(&v).unwrap().ts_ms, 1_700_000_000_000);
        v["ts"] = json!("yesterday");
        assert_eq!(Event::from_json(&v), Err(TelemetryError::BadTime));
        assert_eq!(day_of(1_700_000_000_000), 19_675);
    }
}
