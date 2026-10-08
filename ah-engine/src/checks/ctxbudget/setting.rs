//! Typed settings of the context-budget guards, resolved the way `hooks/lib/settings.js` `get` does for an entry with no
//! legacy file: the entry's environment variable (then its aliases), the `settings.json` section, the plugin option
//! (`CLAUDE_PLUGIN_OPTION_<NAME>`, else the host settings file's `pluginConfigs`), then the default.
//!
//! The boolean switches of the small guards (`guardkit::settings`) cover booleans only; these guards also read numbers
//! (a percent, a token count, minutes) and one enum, so the value types and the JavaScript number and string coercions
//! (`Number()`, `parseInt`, trimming, lower-casing) are written here once, tested against Node, and every entry is a
//! table in `defaults/ctxbudget.toml`.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - text that does not parse or decode is the absent value (Node Number()/JSON.parse catch parity)
// - an absent field is the empty value
// A failure that must be seen goes through `crate::discard` instead.

use crate::checks::git::util::Settings;
use crate::checks::guardkit::settings::{coerce_json, read_object, stored_options, token};
use crate::checks::guardkit::text::{is_js_space, js_string_of, js_trim};
use crate::defaults::{self, V};
use serde_json::Value;

/// A resolved setting value.
#[derive(Debug, Clone, PartialEq)]
pub enum Sv {
    /// An on/off switch.
    Bool(bool),
    /// A number.
    Num(f64),
    /// An enum word (lower case), or a text (`csv`, `string`: trimmed).
    Str(String),
}

impl Sv {
    /// The boolean, `false` when the entry is not a boolean.
    pub fn flag(&self) -> bool {
        matches!(self, Sv::Bool(true))
    }

    /// The number, `0` when the entry is not a number.
    pub fn num(&self) -> f64 {
        match self {
            Sv::Num(n) => *n,
            _ => 0.0,
        }
    }
}

/// `Number(s)` for a non-blank string (white space around it is ignored), `None` when the result is NaN or infinite (a setting that is not a
/// finite number falls through to the next source).
pub fn js_number(s: &str) -> Option<f64> {
    let s = js_trim(s);
    if s.is_empty() {
        return None;
    }
    let b = s.as_bytes();
    if b.len() > 2 && b[0] == b'0' {
        let radix = match b[1] {
            b'x' | b'X' => 16,
            b'o' | b'O' => 8,
            b'b' | b'B' => 2,
            _ => 0,
        };
        if radix != 0 {
            let mut v = 0f64;
            for &c in &b[2..] {
                v = v * f64::from(radix) + f64::from((c as char).to_digit(radix)?);
            }
            return v.is_finite().then_some(v);
        }
    }
    let t = s.strip_prefix(['+', '-']).unwrap_or(s);
    let (mant, exp) = match t.find(['e', 'E']) {
        Some(i) => (&t[..i], Some(&t[i + 1..])),
        None => (t, None),
    };
    let (int, frac) = mant.split_once('.').map_or((mant, None), |(i, f)| (i, Some(f)));
    let digits = |x: &str| x.bytes().all(|c| c.is_ascii_digit());
    let mant_ok = digits(int) && frac.is_none_or(digits) && (!int.is_empty() || frac.is_some_and(|f| !f.is_empty()));
    let exp_ok = exp.is_none_or(|e| {
        let d = e.strip_prefix(['+', '-']).unwrap_or(e);
        !d.is_empty() && digits(d)
    });
    if !mant_ok || !exp_ok {
        return None;
    }
    s.parse::<f64>().ok().filter(|v| v.is_finite())
}

/// `parseInt(s, 10)`: leading white space, an optional sign, then the digits; `None` for NaN or an infinite result.
pub fn js_parse_int(s: &str) -> Option<f64> {
    let t = s.trim_start_matches(is_js_space);
    let (neg, rest) = match t.as_bytes().first() {
        Some(b'-') => (true, &t[1..]),
        Some(b'+') => (false, &t[1..]),
        _ => (false, t),
    };
    let end = rest.bytes().take_while(u8::is_ascii_digit).count();
    if end == 0 {
        return None;
    }
    let v: f64 = rest[..end].parse().ok().filter(|v: &f64| v.is_finite())?;
    Some(if neg { -v } else { v })
}

/// The number a raw number-typed value clamps to (`coerceValue`, case `number`): a finite `n`, raised to `min` and cut to
/// `max`.
fn clamp(e: &V, n: f64) -> f64 {
    let mut n = n;
    if let Some(min) = e.get("min").and_then(V::as_integer) {
        n = n.max(min as f64);
    }
    if let Some(max) = e.get("max").and_then(V::as_integer) {
        n = n.min(max as f64);
    }
    n
}

/// `coerceValue(entry, raw)` for a string.
fn coerce_str(e: &V, raw: &str) -> Option<Sv> {
    let t = js_trim(raw);
    if t.is_empty() {
        return None;
    }
    match e.str_field("kind") {
        "bool" => token(t).map(Sv::Bool),
        "num" => js_number(t).map(|n| Sv::Num(clamp(e, n))),
        "enum" => {
            let w = t.to_lowercase();
            e.get("values").map(V::strings).unwrap_or_default().contains(&w.as_str()).then_some(Sv::Str(w))
        }
        "str" => Some(Sv::Str(t.to_string())),
        _ => None,
    }
}

/// `coerceValue(entry, raw)` for a JSON value from a file.
fn coerce_value(e: &V, v: &Value) -> Option<Sv> {
    match v {
        Value::String(s) => coerce_str(e, s),
        Value::Bool(b) => match e.str_field("kind") {
            "bool" => Some(Sv::Bool(*b)),
            "str" => Some(Sv::Str(b.to_string())),
            _ => None,
        },
        Value::Number(n) => match e.str_field("kind") {
            "bool" => coerce_json(v).map(Sv::Bool),
            "num" => n.as_f64().filter(|f| f.is_finite()).map(|f| Sv::Num(clamp(e, f))),
            // `String(n)`
            "str" => n.as_f64().map(|f| Sv::Str(crate::checks::replykit::json::js_number(f))),
            _ => None,
        },
        _ => None,
    }
}

/// The default of an entry.
fn default_of(e: &V) -> Sv {
    match (e.str_field("kind"), e.get("default")) {
        ("bool", Some(V::Bool(b))) => Sv::Bool(*b),
        ("num", Some(V::Int(n))) => Sv::Num(*n as f64),
        (_, Some(V::Str(s))) => Sv::Str((*s).to_string()),
        _ => Sv::Bool(false),
    }
}

/// The effective value of the setting `e` (a `ctxbudget.set_*` table).
///
/// Mirrors `hooks/lib/settings.js` `get` for an entry without a legacy file.
pub fn get(st: &Settings, e: &V) -> Sv {
    let env_name = e.str_field("env");
    if !env_name.is_empty() {
        let aliases = e.get("aliases").map(V::strings).unwrap_or_default();
        for n in std::iter::once(env_name).chain(aliases) {
            if let Some(v) = st.env.get(n).and_then(|raw| coerce_str(e, raw)) {
                return v;
            }
        }
    }
    let from_file = read_object(st, defaults::text("guardkit.settings_file"))
        .and_then(|o| o.get(e.str_field("section")).and_then(Value::as_object).and_then(|s| s.get(e.str_field("key"))).and_then(|v| coerce_value(e, v)));
    if let Some(v) = from_file {
        return v;
    }
    let option = e.str_field("option");
    if !option.is_empty() {
        let manifest = e.str_field("manifest_default");
        let env_key = format!("{}{}", defaults::text("guardkit.plugin_option_prefix"), option.to_ascii_uppercase());
        if let Some(raw) = st.env.get(&env_key) {
            // A value equal to the manifest default is the host exporting an untouched option, never a choice.
            if raw != manifest
                && let Some(v) = coerce_str(e, raw)
            {
                return v;
            }
        } else if let Some(v) = stored_options(st).and_then(|o| o.get(option).cloned()) {
            let untouched = js_string_of(&v).is_some_and(|s| s == manifest);
            if !untouched && let Some(v) = coerce_value(e, &v) {
                return v;
            }
        }
    }
    default_of(e)
}
