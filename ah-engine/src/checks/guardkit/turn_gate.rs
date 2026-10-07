//! "Has this advisory already been shown this turn?": a port of `hooks/lib/turn-gate.js`.
//!
//! A turn is the span after the newest human prompt in the session transcript (a subagent's turn is its whole run). The
//! state is `<home>/.anti-hall/turn-gate/tg-<session>.json`, the file the Node hooks keep, so a Node hook and the engine
//! suppress each other's repeats.
//!
//! Mirrors `turn-gate.js` `firstThisTurn` and `currentTurnId`, including what it does with a state file of an unexpected
//! shape, and its never-pruning prune (the Node code passes the prefix `tg-` where the sweep expects `tg`, so it looks for
//! `tg--*.json`; that is kept so the files on disk stay the same).
use crate::checks::guardkit::fsio::{prune_stale, write_atomic};
use crate::checks::guardkit::jsre;
use crate::checks::guardkit::ojson::OVal;
use crate::checks::guardkit::text::{js_string_coerce, js_truthy};
use crate::defaults;
use serde_json::Value;
use std::io::{Read, Seek, SeekFrom};
use std::sync::{Mutex, OnceLock};

/// What `firstThisTurn` is asked about.
pub struct Ask<'a> {
    /// The home directory the state lives under.
    pub home: &'a str,
    /// `payload.session_id` (any JSON value; a falsy one means "show it").
    pub session_id: Option<&'a Value>,
    /// The subagent id, empty for the main thread.
    pub agent_id: &'a str,
    /// `payload.transcript_path`.
    pub transcript_path: Option<&'a Value>,
    /// The advisory's key.
    pub key: &'a str,
}

fn injected_re() -> &'static regex::Regex {
    static R: OnceLock<regex::Regex> = OnceLock::new();
    R.get_or_init(|| jsre::compile(defaults::text("turn_gate.injected_re"), false))
}

/// `humanText(msg)`: the text of a human message, or `None` for a tool result or anything else.
fn human_text(msg: Option<&Value>) -> Option<String> {
    let msg = msg.filter(|m| js_truthy(Some(m)))?;
    match msg.get("content") {
        Some(Value::String(s)) => Some(s.clone()),
        Some(Value::Array(items)) => {
            let truthy = |c: &&Value| js_truthy(Some(c));
            if items.iter().filter(truthy).any(|c| c.get("type").and_then(Value::as_str) == Some("tool_result")) {
                return None;
            }
            let t = items
                .iter()
                .filter(truthy)
                .filter(|c| c.get("type").and_then(Value::as_str) == Some("text"))
                .map(|c| c.get("text").filter(|v| js_truthy(Some(v))).map(js_string_coerce).unwrap_or_default())
                .collect::<Vec<_>>()
                .join("\n");
            if t.is_empty() { None } else { Some(t) }
        }
        _ => None,
    }
}

/// `readTail(path, bytes)`: the last lines of a file, a possibly partial first line dropped; `None` when unreadable or empty.
fn read_tail(path: &str, max: u64) -> Option<Vec<String>> {
    let mut f = std::fs::File::open(path).ok()?;
    let size = f.metadata().ok()?.len();
    if size == 0 {
        return None;
    }
    let n = size.min(max);
    f.seek(SeekFrom::Start(size - n)).ok()?;
    let mut buf = Vec::with_capacity(n as usize);
    f.take(n).read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf).to_string();
    let mut lines: Vec<String> = text.split('\n').map(str::to_string).collect();
    if size > n {
        lines.remove(0);
    }
    Some(lines)
}

/// `currentTurnId(transcriptPath)`: the id of the newest human prompt in the transcript tail, `None` when it cannot be told.
pub fn current_turn_id(transcript_path: Option<&Value>) -> Option<String> {
    let path = transcript_path.and_then(Value::as_str).filter(|p| !p.is_empty())?;
    let lines = read_tail(path, defaults::num("turn_gate.tail_bytes"))?;
    for line in lines.iter().rev() {
        if line.is_empty() || !line.contains("\"user\"") {
            continue;
        }
        let Ok(o) = serde_json::from_str::<Value>(line) else { continue };
        if !js_truthy(Some(&o)) || o.get("type").and_then(Value::as_str) != Some("user") || js_truthy(o.get("isMeta")) || js_truthy(o.get("isSidechain")) {
            continue;
        }
        let Some(t) = human_text(o.get("message")).filter(|t| !t.is_empty()) else { continue };
        if injected_re().is_match(&t) {
            continue;
        }
        let id = [o.get("uuid"), o.get("timestamp")].into_iter().flatten().find(|v| js_truthy(Some(v))).map(js_string_coerce).unwrap_or_default();
        return if id.is_empty() { None } else { Some(id) };
    }
    None
}

fn state_path(home: &str, session: &str) -> String {
    let safe: String = session
        .encode_utf16()
        .take(defaults::num("turn_gate.session_max") as usize)
        .map(|u| char::from_u32(u32::from(u)).unwrap_or('_'))
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') { c } else { '_' })
        .collect();
    format!(
        "{home}/{}/{}/{}{safe}{}",
        defaults::text("guardkit.state_dir_name"),
        defaults::text("turn_gate.dir"),
        defaults::text("turn_gate.prefix"),
        defaults::text("guardkit.state_ext")
    )
}

static GATE_LOCK: Mutex<()> = Mutex::new(());

/// True when the advisory should be shown (first time this turn, or the turn cannot be determined), recording that it was.
///
/// Mirrors `turn-gate.js` `firstThisTurn`.
pub fn first_this_turn(a: &Ask<'_>) -> bool {
    if !js_truthy(a.session_id) || a.key.is_empty() || a.home.is_empty() {
        return true;
    }
    let turn =
        if a.agent_id.is_empty() { current_turn_id(a.transcript_path) } else { Some(format!("{}{}", defaults::text("turn_gate.agent_prefix"), a.agent_id)) };
    let Some(turn) = turn else { return true };
    let slot = format!("{}|{}", a.key, if a.agent_id.is_empty() { defaults::text("turn_gate.main_label") } else { a.agent_id });
    let sig = "";
    let session = a.session_id.map(js_string_coerce).unwrap_or_default();
    let path = state_path(a.home, &session);
    let _g = GATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    // `JSON.parse(readFileSync(p)) || {}`; anything that throws is an empty state
    let mut state = std::fs::read_to_string(&path).ok().and_then(|t| OVal::parse(&t)).filter(OVal::truthy).unwrap_or(OVal::Obj(Vec::new()));
    let (mut sigs, seen) = match state.get(&slot) {
        Some(prev) if matches!(prev.get("turn"), Some(OVal::Str(t)) if *t == turn) => match prev.get("sigs") {
            Some(OVal::Arr(s)) => (s.clone(), s.iter().any(|x| matches!(x, OVal::Str(v) if v == sig))),
            _ => (Vec::new(), false),
        },
        _ => (Vec::new(), false),
    };
    if seen {
        return false;
    }
    let keep = (defaults::num("turn_gate.max_sigs") as usize).saturating_sub(1);
    if sigs.len() > keep {
        sigs.drain(..sigs.len() - keep);
    }
    sigs.push(OVal::Str(sig.to_string()));
    match &state {
        OVal::Obj(_) => state.set(&slot, OVal::Obj(vec![("turn".into(), OVal::Str(turn)), ("sigs".into(), OVal::Arr(sigs))])),
        // an array keeps only its elements when stringified; a truthy primitive cannot take a property (a TypeError in Node)
        OVal::Arr(_) => {}
        _ => return true,
    }
    let dir = path.rsplit_once('/').map_or("", |(d, _)| d);
    if write_atomic(&path, &state.stringify()).is_ok() {
        prune_stale(dir, defaults::text("turn_gate.prefix"), Some(&path));
    }
    true
}
