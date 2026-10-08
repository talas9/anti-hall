//! The main thread's context-window usage, from the same sources in the same order as `hooks/lib/context-pct.js`:
//! the statusline's own reading, a Codex rollout's `token_count`, then an estimate from the last assistant usage block.
//!
//! The Node function writes one file on a path of its own (the inferred one-million-token window latch, whenever the
//! observed usage is over the default window and no real window size is known). Here the reading only says so
//! ([`Reading::infer_write`]); the caller writes it with [`write_inferred`] once it has settled everything it might
//! still defer on, so a deferral never leaves a half-written state behind.
use super::{Jf, read_json};
use crate::checks::compact_decl::json_depth;
use crate::checks::git::util::Settings;
use crate::checks::guardkit::jsdiff::js_reads_differently_str;
use crate::checks::guardkit::text::js_trim;
use crate::defaults;
use serde_json::Value;

/// Where the window size of an estimate came from (`windowLabel`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Label {
    /// Not an estimate (`null`).
    None,
    /// The window size variable.
    Env,
    /// The window the statusline last stated.
    Sticky,
    /// Inferred one-million-token window.
    Inferred,
    /// The assumed default window.
    Default,
}

/// One reading.
#[derive(Debug, Clone, PartialEq)]
pub struct Reading {
    /// The percent of the window in use (a statusline reading is not clamped, the others are).
    pub pct: f64,
    /// The tokens in use, when the source states them.
    pub used: Option<f64>,
    /// The window size, when the source states one (`max`).
    pub max: Option<f64>,
    /// True for an estimate from the last usage block (`estimated`).
    pub estimated: bool,
    /// False only for an estimate against the assumed default window.
    pub window_known: bool,
    /// The source of an estimate's window size.
    pub label: Label,
    /// Node records the inferred window for this session while reading it: the caller must call [`write_inferred`].
    pub infer_write: bool,
}

/// What looking for the reading came to.
#[derive(Debug, PartialEq)]
pub enum Pct {
    /// A reading.
    Reading(Reading),
    /// No usable reading (Node returns null).
    None,
    /// The Node hook must decide: a line the engine cannot parse exactly, a relative path, or a state write.
    Defer,
}

fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

/// `tagFromSessionId` (`hooks/lib/context-pct-store.js`): the session id with every character outside letters, digits,
/// `_` and `-` removed, cut to the tag length; `None` for a missing, non-string or empty result.
pub fn tag_of(session_id: Option<&Value>) -> Option<String> {
    let s = session_id?.as_str()?;
    let max = defaults::num("ctxbudget.session_tag_max") as usize;
    let tag: String = s.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-')).take(max).collect();
    (!js_trim(s).is_empty() && !tag.is_empty()).then_some(tag)
}

/// The number a JSON value is, when it is one.
fn num(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64)
}

fn state_path(st: &Settings, dir: &str, file: &str) -> String {
    format!("{}/{}/{}/{file}", st.home, defaults::text("ctxbudget.state_root"), dir)
}

/// `store.read(home, tag, FRESH_MS)`: the fresh statusline reading of the session.
fn statusline(st: &Settings, tag: &str) -> Result<Option<Reading>, ()> {
    let path = state_path(st, defaults::text("ctxbudget.pct_dir"), &format!("{tag}.json"));
    let raw = match read_json(&path) {
        Jf::Ok(v) => v,
        Jf::Bad => return Ok(None),
        Jf::Hazard => return Err(()),
    };
    let Some(pct) = raw.is_object().then(|| num(raw.get("pct"))).flatten() else { return Ok(None) };
    let ts = num(raw.get("ts")).unwrap_or(0.0);
    if ts == 0.0 || now_ms() - ts > defaults::num("ctxbudget.pct_fresh_ms") as f64 {
        return Ok(None);
    }
    Ok(Some(Reading {
        pct,
        used: num(raw.get("usedTokens")),
        max: num(raw.get("maxTokens")),
        estimated: false,
        window_known: true,
        label: Label::None,
        infer_write: false,
    }))
}

/// `store.readSticky`: the window size the statusline last stated, whatever its age.
fn sticky_window(st: &Settings, tag: &str) -> Result<Option<f64>, ()> {
    match read_json(&state_path(st, defaults::text("ctxbudget.pct_dir"), &format!("{tag}.json"))) {
        Jf::Ok(raw) => Ok(raw.is_object().then(|| num(raw.get("maxTokens"))).flatten().filter(|m| *m > 0.0)),
        Jf::Bad => Ok(None),
        Jf::Hazard => Err(()),
    }
}

/// `store.readInferred1m`.
fn inferred(st: &Settings, tag: &str) -> Result<bool, ()> {
    let file = format!("{tag}{}", defaults::text("ctxbudget.inferred_suffix"));
    match read_json(&state_path(st, defaults::text("ctxbudget.pct_dir"), &file)) {
        Jf::Ok(v) => Ok(v.get("inferred") == Some(&Value::Bool(true))),
        Jf::Bad => Ok(false),
        Jf::Hazard => Err(()),
    }
}

/// Parse a transcript line Node parsed after its substring test. `Err` when the engine's parser rejects what Node's might
/// accept (a lone surrogate escape, nesting past the limit, an exponent out of range); `Ok(None)` for text both reject.
pub(crate) fn parse_line(line: &str) -> Result<Option<Value>, ()> {
    match serde_json::from_str::<Value>(line) {
        Ok(v) => Ok(Some(v)),
        Err(_) if line.contains("\\u") || json_depth(line) > defaults::num("ctxbudget.deep_json_depth") as usize || js_reads_differently_str(line) => Err(()),
        Err(_) => Ok(None),
    }
}

/// `findLastCodexTokenCount`: the newest rollout `token_count` as (used, window).
fn last_codex(lines: &[String]) -> Result<Option<(f64, f64)>, ()> {
    let marker = defaults::text("ctxbudget.token_count_marker");
    for line in lines.iter().rev() {
        if line.is_empty() || !line.contains(marker) {
            continue;
        }
        let Some(e) = parse_line(line)? else { continue };
        if e.get("type").and_then(Value::as_str) != Some("event_msg") {
            continue;
        }
        let Some(p) = e.get("payload").filter(|p| p.get("type").and_then(Value::as_str) == Some("token_count")) else { continue };
        let Some(info) = p.get("info").filter(|i| i.is_object() || i.is_array()) else { continue };
        let used = num(info.get("total_token_usage").and_then(|t| t.get("total_tokens")));
        let max = num(info.get("model_context_window"));
        if let (Some(u), Some(m)) = (used, max)
            && m > 0.0
        {
            return Ok(Some((u, m)));
        }
    }
    Ok(None)
}

/// `findLastAssistantUsage`: the newest main-thread assistant usage block as the tokens in use.
fn last_usage(lines: &[String]) -> Result<Option<f64>, ()> {
    let marker = defaults::text("ctxbudget.usage_marker");
    for line in lines.iter().rev() {
        if line.is_empty() || !line.contains(marker) {
            continue;
        }
        let Some(e) = parse_line(line)? else { continue };
        if e.get("type").and_then(Value::as_str) != Some("assistant") || e.get("isSidechain") == Some(&Value::Bool(true)) {
            continue;
        }
        let Some(u) = e.get("message").and_then(|m| m.get("usage")).filter(|u| u.is_object()) else { continue };
        let f = |k: &str| num(u.get(k)).unwrap_or(0.0);
        let (input, create, read) = (f("input_tokens"), f("cache_creation_input_tokens"), f("cache_read_input_tokens"));
        if input == 0.0 && create == 0.0 && read == 0.0 {
            continue;
        }
        return Ok(Some(input + create + read));
    }
    Ok(None)
}

/// `getContextPct(transcriptPath, env, { home, sessionId, lines })`.
///
/// `lines` is a tail the caller already read (`None`: read it here from `transcript`). An unreadable or relative
/// transcript path is `Pct::None` or `Pct::Defer` exactly where Node would read it.
pub fn context_pct(st: &Settings, session_id: Option<&Value>, transcript: Option<&str>, lines: Option<&[String]>) -> Pct {
    let tag = tag_of(session_id);
    if let Some(t) = &tag {
        match statusline(st, t) {
            Ok(Some(r)) => return Pct::Reading(r),
            Ok(None) => {}
            Err(()) => return Pct::Defer,
        }
    }
    let owned;
    let lines = match lines {
        Some(l) => l,
        None => {
            let Some(path) = transcript.filter(|p| !p.is_empty()) else { return Pct::None };
            if !path.starts_with('/') {
                return Pct::Defer; // Node resolves a relative path against its own working directory
            }
            match crate::checks::compact_decl::read_tail(path, defaults::num("ctxbudget.tail_bytes")) {
                Some(l) => {
                    owned = l;
                    &owned[..]
                }
                None => return Pct::None,
            }
        }
    };
    match last_codex(lines) {
        Ok(Some((used, max))) => {
            return Pct::Reading(Reading {
                pct: (used / max * 100.0).clamp(0.0, 100.0),
                used: Some(used),
                max: Some(max),
                estimated: false,
                window_known: true,
                label: Label::None,
                infer_write: false,
            });
        }
        Ok(None) => {}
        Err(()) => return Pct::Defer,
    }
    let used = match last_usage(lines) {
        Ok(Some(u)) => u,
        Ok(None) => return Pct::None,
        Err(()) => return Pct::Defer,
    };
    let env_max = st.env.get(defaults::text("ctxbudget.context_window_env")).and_then(|s| super::setting::js_parse_int(s)).filter(|m| *m > 0.0);
    let (max, known, label, infer_write) = if let Some(m) = env_max {
        (m, true, Label::Env, false)
    } else {
        let sticky = match tag.as_deref().map(|t| sticky_window(st, t)) {
            Some(Err(())) => return Pct::Defer,
            Some(Ok(s)) => s,
            None => None,
        };
        let already = match tag.as_deref().map(|t| inferred(st, t)) {
            Some(Err(())) => return Pct::Defer,
            Some(Ok(b)) => b,
            None => false,
        };
        let over = used > defaults::num("ctxbudget.default_window") as f64;
        if let Some(m) = sticky {
            (m, true, Label::Sticky, false)
        } else if over || already {
            (defaults::num("ctxbudget.inferred_window") as f64, true, Label::Inferred, over && tag.is_some())
        } else {
            (defaults::num("ctxbudget.default_window") as f64, false, Label::Default, false)
        }
    };
    Pct::Reading(Reading { pct: (used / max * 100.0).clamp(0.0, 100.0), used: Some(used), max: Some(max), estimated: true, window_known: known, label, infer_write })
}

/// `store.writeInferred1m(home, tag)`: `{"inferred":true,"ts":<now>}` through a temporary file and a rename. Best effort.
pub fn write_inferred(st: &Settings, session_id: Option<&Value>) {
    let Some(tag) = tag_of(session_id) else { return };
    let file = format!("{tag}{}", defaults::text("ctxbudget.inferred_suffix"));
    let body = crate::checks::guardkit::msg::render("ctxbudget.inferred_json", &[("ts", &crate::checks::replykit::json::js_number(now_ms()))]);
    if crate::checks::guardkit::fsio::write_atomic(&state_path(st, defaults::text("ctxbudget.pct_dir"), &file), &body).is_err() {
        crate::discard::note("ctxbudget_inferred_write", "");
    }
}
