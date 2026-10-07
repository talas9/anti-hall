//! The turn of a transcript, read from the end in one bounded streaming pass.
//!
//! Only the last `sibling_sweep.window_bytes` of the file are read, line by line into one reused buffer (a line over
//! `sibling_sweep.line_max_bytes` is skipped without being stored); nothing keeps the bytes and a decoded copy together.
//! A turn starts at the last human prompt; what is kept for it is small: per assistant text a cause hash and two flags,
//! per tool call its kind (search, edit, other). The newest `sibling_sweep.max_events` events are kept.
use super::matcher;
use super::tune::Tune;
use serde_json::Value;
use std::collections::VecDeque;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};

/// What a tool call is, for the check.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// A codebase search (Grep, Glob, rg/grep in a shell, a search subagent).
    Search,
    /// A file change.
    Edit,
    /// Anything else.
    Other,
}

/// One event of the turn, in transcript order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Ev {
    /// An assistant text.
    Text {
        /// Hash of its cause statement, when it holds one.
        cause: Option<String>,
        /// It says it searched for other occurrences.
        sweep: bool,
        /// It holds fix words.
        fix: bool,
    },
    /// A tool call.
    Tool(Kind),
}

/// The last turn of a transcript.
#[derive(Debug, Default)]
pub struct Turn {
    /// Events since the last human prompt, oldest first.
    pub events: Vec<Ev>,
    /// Where the turn starts: the byte offset of its prompt line in the file (`0` when the window holds none).
    pub id: String,
    /// The last assistant text of the turn.
    pub last_text: Option<String>,
    /// Lines that were not read (over the line cap, or not JSON).
    pub skipped: u64,
}

/// The kind of one `tool_use` block.
pub fn tool_kind(t: &Tune, block: &Value) -> Kind {
    let name = block.get(t.text("sibling_sweep.f_tool_name")).and_then(Value::as_str).unwrap_or("");
    let input = block.get(t.text("sibling_sweep.f_tool_input"));
    let field = |k: &str| input.and_then(|i| i.get(k)).and_then(Value::as_str).unwrap_or("");
    if t.list("sibling_sweep.search_tools").iter().any(|n| n == name) || t.pats.search_name.is_match(name) {
        return Kind::Search;
    }
    if t.list("sibling_sweep.edit_tools").iter().any(|n| n == name) {
        return Kind::Edit;
    }
    if name == t.text("sibling_sweep.bash_tool") && t.pats.bash_search.is_match(field(&t.text("sibling_sweep.f_command"))) {
        return Kind::Search;
    }
    let agent_type = field(&t.text("sibling_sweep.f_subagent_type"));
    if t.list("sibling_sweep.agent_tools").iter().any(|n| n == name) && t.list("sibling_sweep.search_agent_types").iter().any(|n| n == agent_type) {
        return Kind::Search;
    }
    Kind::Other
}

/// Whether a user entry is a human prompt: a string, or blocks with a text block, that is not an injected reminder.
fn is_prompt(t: &Tune, entry: &Value) -> bool {
    if entry.get("isMeta").and_then(Value::as_bool) == Some(true) {
        return false;
    }
    let content = entry.get("message").and_then(|m| m.get("content"));
    let human = |x: &str| !x.trim().is_empty() && !t.pats.injected.is_match(x);
    match content {
        Some(Value::String(s)) => human(s),
        Some(Value::Array(blocks)) => blocks.iter().any(|b| {
            b.get("type").and_then(Value::as_str) == Some(t.text("sibling_sweep.b_text").as_str()) && b.get("text").and_then(Value::as_str).is_some_and(human)
        }),
        _ => false,
    }
}

/// Read one line into `buf` (cleared first), without the newline. `Ok(None)` at the end of the input; otherwise whether the
/// line was kept (false: over `cap` bytes, skipped to its end, `buf` empty) and how many bytes it took including the newline.
fn read_line<R: BufRead>(r: &mut R, buf: &mut Vec<u8>, cap: usize) -> std::io::Result<Option<(bool, usize)>> {
    buf.clear();
    let mut total = 0usize;
    let mut over = false;
    loop {
        let chunk = r.fill_buf()?;
        if chunk.is_empty() {
            return Ok(if total == 0 { None } else { Some((!over, total)) });
        }
        let (take, found) = match chunk.iter().position(|b| *b == b'\n') {
            Some(i) => (i + 1, true),
            None => (chunk.len(), false),
        };
        total += take;
        if !over {
            if buf.len() + take > cap + 1 {
                over = true;
                buf.clear();
            } else {
                buf.extend_from_slice(&chunk[..take]);
            }
        }
        r.consume(take);
        if found {
            if !over && buf.last() == Some(&b'\n') {
                buf.pop();
            }
            return Ok(Some((!over, total)));
        }
    }
}

/// The last turn of the transcript at `path` (empty when the window holds no entry).
///
/// Errors: the file cannot be opened, measured, positioned or read.
pub fn read(t: &Tune, path: &str) -> std::io::Result<Turn> {
    let window = t.num("sibling_sweep.window_bytes");
    let cap = t.num("sibling_sweep.line_max_bytes") as usize;
    let max_events = t.num("sibling_sweep.max_events") as usize;
    let mut f = File::open(path)?;
    let size = f.metadata()?.len();
    let start = size.saturating_sub(window);
    f.seek(SeekFrom::Start(start))?;
    let mut r = BufReader::with_capacity(t.num("sibling_sweep.read_buf_bytes") as usize, f.take(size - start));
    let mut buf: Vec<u8> = Vec::new();
    let mut offset = start;
    if start > 0 {
        // the window starts inside a line: skip that partial line
        let mut sink = Vec::new();
        if let Some((_, n)) = read_line(&mut r, &mut sink, 0)? {
            offset += n as u64;
        }
    }
    let t_user = t.text("sibling_sweep.t_user");
    let t_assistant = t.text("sibling_sweep.t_assistant");
    let (b_text, b_tool) = (t.text("sibling_sweep.b_text"), t.text("sibling_sweep.b_tool_use"));
    let text_max = t.num("sibling_sweep.text_max_bytes") as usize;
    let mut events: VecDeque<Ev> = VecDeque::new();
    let mut turn = Turn { id: "0".into(), ..Turn::default() };
    while let Some((whole, n)) = read_line(&mut r, &mut buf, cap)? {
        let line_at = offset;
        offset += n as u64;
        if !whole {
            turn.skipped += 1;
            continue;
        }
        if buf.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let Ok(entry) = serde_json::from_slice::<Value>(&buf) else {
            turn.skipped += 1;
            continue;
        };
        let kind = entry.get("type").and_then(Value::as_str).unwrap_or("");
        if kind == t_user.as_str() {
            if is_prompt(t, &entry) {
                events.clear();
                turn.last_text = None;
                turn.id = line_at.to_string();
            }
        } else if kind == t_assistant.as_str() {
            let blocks = match entry.get("message").and_then(|m| m.get("content")) {
                Some(Value::Array(a)) => a.as_slice(),
                _ => &[],
            };
            for b in blocks {
                let bt = b.get("type").and_then(Value::as_str).unwrap_or("");
                if bt == b_text.as_str() {
                    let Some(txt) = b.get("text").and_then(Value::as_str).filter(|x| !x.trim().is_empty()) else { continue };
                    events.push_back(Ev::Text {
                        cause: matcher::find_cause(t, txt).map(|c| c.hash),
                        sweep: matcher::states_sweep(t, txt),
                        fix: matcher::has_fix_words(t, txt),
                    });
                    let mut end = txt.len().min(text_max);
                    while !txt.is_char_boundary(end) {
                        end -= 1;
                    }
                    turn.last_text = Some(txt[..end].to_string());
                } else if bt == b_tool.as_str() {
                    events.push_back(Ev::Tool(tool_kind(t, b)));
                }
                if events.len() > max_events {
                    events.pop_front();
                }
            }
        }
    }
    turn.events = events.into();
    Ok(turn)
}
