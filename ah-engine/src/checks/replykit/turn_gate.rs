//! "Has this advisory already been shown THIS turn?" (`hooks/lib/turn-gate.js` `firstThisTurn`, `currentTurnId`).
//!
//! The turn is the span after the newest human prompt in the transcript tail (a `user` entry that is not a tool
//! result and not an injected block); its uuid (or timestamp) is the turn id. State lives in
//! `<home>/.anti-hall/turn-gate/tg-<session>.json` as `{ "<key>|<agent>": { turn, sigs: [..] } }`, written atomically,
//! key order kept (so another writer's slots survive byte for byte).
use super::Defer;
use super::io::{self, js_id_string, safe_session, truthy};
use super::json::{self, Oj, ParseError};
use super::transcript::{parse_text, prop};
use crate::checks::guardkit::jsre;
use crate::checks::guardkit::text::slice_utf16;
use crate::defaults;
use regex::Regex;
use serde_json::Value;
use std::path::Path;
use std::sync::OnceLock;

/// What the gate needs about one advisory.
pub struct GateInput<'a> {
    /// The home directory.
    pub home: &'a str,
    /// The payload's `session_id` as it came (falsy means "cannot tell": show).
    pub session: Option<&'a Value>,
    /// The payload's `agent_id` when it is a string, else empty.
    pub agent: &'a str,
    /// The payload's `transcript_path`.
    pub transcript: Option<&'a Value>,
    /// The advisory's key.
    pub key: &'a str,
    /// The advisory's signature; a different signature is a different advisory.
    pub sig: &'a str,
}

fn injected_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| jsre::compile(defaults::text("reply_turn_gate.injected_re"), false))
}

/// `humanText(msg)` of turn-gate.js: the text of a human prompt, `None` for a tool result or no text.
fn human_text(msg: &Value) -> Result<Option<String>, Defer> {
    if !truthy(msg) {
        return Ok(None);
    }
    match prop(msg, "content") {
        Some(Value::String(s)) => Ok(Some(s.clone())),
        Some(Value::Array(a)) => {
            let tool_result = defaults::text("reply_turn_gate.type_tool_result");
            if a.iter().any(|c| truthy(c) && prop(c, "type").and_then(Value::as_str) == Some(tool_result)) {
                return Ok(None);
            }
            let text_type = defaults::text("reply_turn_gate.type_text");
            let mut parts = Vec::new();
            for c in a.iter().filter(|c| truthy(c) && prop(c, "type").and_then(Value::as_str) == Some(text_type)) {
                match prop(c, "text") {
                    None => parts.push(String::new()),
                    Some(Value::String(s)) => parts.push(s.clone()),
                    Some(t) if !truthy(t) => parts.push(String::new()),
                    Some(_) => return Err(Defer),
                }
            }
            let t = parts.join("\n");
            Ok(if t.is_empty() { None } else { Some(t) })
        }
        _ => Ok(None),
    }
}

/// `currentTurnId(transcriptPath)`: the id of the newest human prompt in the last `reply_turn_gate.tail_bytes` of the
/// transcript, `None` when there is none or the file cannot be read.
pub fn current_turn_id(transcript: Option<&Value>) -> Result<Option<String>, Defer> {
    let Some(path) = transcript.and_then(Value::as_str).filter(|p| !p.is_empty()) else { return Ok(None) };
    if !path.starts_with('/') {
        return Err(Defer);
    }
    let want = defaults::num("reply_turn_gate.tail_bytes");
    let Ok(meta) = std::fs::metadata(path) else { return Ok(None) };
    if meta.len() == 0 {
        return Ok(None);
    }
    let Some(tail) = io::read_window(path, want) else { return Ok(None) };
    let mut lines: Vec<&str> = tail.data.split('\n').collect();
    if tail.truncated && !lines.is_empty() {
        lines.remove(0);
    }
    for line in lines.iter().rev() {
        if line.is_empty() || !line.contains(defaults::text("reply_turn_gate.user_marker")) {
            continue;
        }
        let Some(o) = parse_text(line)? else { continue };
        if prop(&o, "type").and_then(Value::as_str) != Some(defaults::text("reply_turn_gate.type_user")) {
            continue;
        }
        if prop(&o, "isMeta").is_some_and(truthy) || prop(&o, "isSidechain").is_some_and(truthy) {
            continue;
        }
        let Some(msg) = prop(&o, "message") else { continue };
        let Some(t) = human_text(msg)?.filter(|t| !t.is_empty()) else { continue };
        if injected_re().is_match(&t) {
            continue;
        }
        let id = [prop(&o, "uuid"), prop(&o, "timestamp")].into_iter().flatten().find(|v| truthy(v));
        return match id {
            None => Ok(None),
            Some(v) => Ok(js_id_string(v).ok_or(Defer)?).map(|s| Some(s).filter(|s| !s.is_empty())),
        };
    }
    Ok(None)
}

/// `firstThisTurn(opts)`: true to show the advisory (first time for this key and signature this turn, or the turn
/// cannot be determined), false when it was already shown.
pub fn first_this_turn(i: &GateInput<'_>) -> Result<bool, Defer> {
    let Some(session) = i.session.filter(|s| truthy(s)) else { return Ok(true) };
    if i.key.is_empty() {
        return Ok(true);
    }
    let session = js_id_string(session).ok_or(Defer)?;
    let turn = if i.agent.is_empty() {
        match current_turn_id(i.transcript)? {
            Some(t) => t,
            None => return Ok(true),
        }
    } else {
        format!("{}{}", defaults::text("reply_turn_gate.agent_prefix"), i.agent)
    };
    let slot = format!("{}|{}", i.key, if i.agent.is_empty() { defaults::text("reply_turn_gate.main_agent") } else { i.agent });
    let sig = slice_utf16(i.sig, defaults::num("reply_turn_gate.sig_max") as usize).ok_or(Defer)?;
    let dir = Path::new(i.home).join(defaults::text("replykit.state_dir")).join(defaults::text("reply_turn_gate.dir"));
    let file_name = format!(
        "{}{}{}",
        defaults::text("reply_turn_gate.prefix"),
        safe_session(&session, Some(defaults::num("reply_turn_gate.session_max") as usize)),
        defaults::text("replykit.json_ext")
    );
    let path = dir.join(&file_name);
    let mut state: Vec<(String, Oj)> = match std::fs::read_to_string(&path) {
        Err(_) => Vec::new(),
        Ok(text) => match json::parse(&text) {
            Err(ParseError::Invalid) => Vec::new(),
            Err(ParseError::Unsure) => return Err(Defer),
            Ok(Oj::Obj(m)) => m,
            Ok(v) if !v.truthy() => Vec::new(),
            Ok(_) => return Err(Defer),
        },
    };
    let prev = state.iter().find(|(k, _)| *k == slot).map(|(_, v)| v);
    let same_turn = prev.filter(|p| p.get("turn").and_then(Oj::as_str) == Some(turn.as_str()));
    if let Some(Oj::Arr(sigs)) = same_turn.and_then(|p| p.get("sigs"))
        && sigs.iter().any(|s| s.as_str() == Some(sig.as_str()))
    {
        return Ok(false);
    }
    let keep = defaults::num("reply_turn_gate.max_sigs") as usize - 1;
    let mut sigs: Vec<Oj> = match same_turn.and_then(|p| p.get("sigs")) {
        Some(Oj::Arr(a)) => a[a.len().saturating_sub(keep)..].to_vec(),
        _ => Vec::new(),
    };
    sigs.push(Oj::Str(sig));
    let entry = Oj::Obj(vec![("turn".to_string(), Oj::Str(turn)), ("sigs".to_string(), Oj::Arr(sigs))]);
    match state.iter_mut().find(|(k, _)| *k == slot) {
        Some(s) => s.1 = entry,
        None => state.push((slot, entry)),
    }
    let body = Oj::Obj(state).stringify();
    let persisted = std::fs::create_dir_all(&dir).is_ok() && {
        let tmp = dir.join(format!("{file_name}.{}.{}.tmp", std::process::id(), io::now_ms() as u64));
        std::fs::write(&tmp, &body).is_ok() && std::fs::rename(&tmp, &path).is_ok()
    };
    if !persisted {
        return Ok(true);
    }
    io::prune_stale(&dir, defaults::text("reply_turn_gate.prefix"), Some(&file_name));
    Ok(true)
}
