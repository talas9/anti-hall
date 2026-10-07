//! One transcript line, parsed into the facts the index keeps.
//!
//! Every function names the Node reader it mirrors, because the index replaces those readers and a drift between
//! them is a behaviour change (D31). Where the Node code has a quirk that matters to a verdict (the duplicated text
//! of the legacy assistant extraction, the two different task-notification status sets), the quirk is kept and named.
//!
//! JSON differences from Node: serde_json rejects a lone surrogate escape that `JSON.parse` accepts; such a line is
//! counted as malformed here. `Date.parse` accepts many forms; only RFC 3339 timestamps (what the harness writes)
//! are read, anything else is `None` (JS `NaN`).
use crate::defaults;
use regex::Regex;
use serde_json::{Map, Value};

/// Which of the three transcript shapes carried a task-notification
/// (`companion/lib/devswarm-idle.js` `notificationTexts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Shape {
    /// A `user` entry: `message.content` as a string or as `text` blocks.
    User,
    /// An `attachment` entry: `attachment.prompt`.
    Attachment,
    /// A `queue-operation` entry: `content`.
    QueueOperation,
}

/// One `<task-notification>` block.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Notification {
    /// Which shape carried it.
    pub shape: Shape,
    /// Record number of the entry (1-based, counting every non-empty line indexed).
    pub seq: u64,
    /// The entry's `timestamp` in epoch milliseconds, when it parses.
    pub ts_ms: Option<i64>,
    /// `<task-id>` as `hooks/lib/agent-scan.js` reads it (first match in the block, not trimmed; may be empty).
    pub task_id: Option<String>,
    /// `<status>` as `agent-scan.js` reads it (not trimmed).
    pub status: Option<String>,
    /// `<task-id>` as `devswarm-idle.js` `finishedTaskKeys` reads it (trimmed, no inner whitespace).
    pub idle_task_id: Option<String>,
    /// `<tool-use-id>` as `finishedTaskKeys` reads it.
    pub idle_tool_use_id: Option<String>,
    /// The block's status is one of `transcript.final_statuses` (`finishedTaskKeys` only counts those).
    pub final_status: bool,
}

impl Notification {
    /// The agent id `agent-scan.js` marks terminal: a non-empty `<task-id>` whose `<status>` is one of
    /// `transcript.terminal_statuses` (case-insensitive, whole text, so surrounding whitespace disqualifies it).
    pub fn terminal_agent(&self) -> Option<&str> {
        let id = self.task_id.as_deref().filter(|i| !i.is_empty())?;
        let st = self.status.as_deref()?;
        defaults::words("transcript.terminal_statuses").iter().any(|w| w.eq_ignore_ascii_case(st)).then_some(id)
    }

    /// The keys `devswarm-idle.js` `finishedTaskKeys` returns for this block: task id then tool-use id, only when
    /// the status is final.
    pub fn finished_keys(&self) -> Vec<&str> {
        if !self.final_status {
            return Vec::new();
        }
        self.idle_task_id.iter().chain(self.idle_tool_use_id.iter()).map(String::as_str).collect()
    }
}

/// A `task_status` attachment, which a compaction writes for each live background agent
/// (`hooks/lib/agent-scan.js`, step a0).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskStatus {
    /// Record number of the entry.
    pub seq: u64,
    /// `attachment.taskId`.
    pub task_id: String,
    /// `attachment.status` (stringified like the Node reader does).
    pub status: String,
    /// `attachment.outputFilePath`, or empty.
    pub output_file: String,
    /// `attachment.description`, or empty.
    pub description: String,
    /// The entry's `timestamp`, else `attachment.timestamp`, in epoch milliseconds.
    pub ts_ms: Option<i64>,
}

/// One tool use found in an entry (`hooks/lib/task-state.js` `collectTU`).
#[derive(Debug, Clone, PartialEq)]
pub struct ToolUse {
    /// The `tool_use` block's `id`, when it has a string one.
    pub id: Option<String>,
    /// The tool name.
    pub name: String,
    /// The input, or `Null` when it was larger than the cap (see `input_truncated`).
    pub input: Value,
    /// The input was larger than the configured cap and was dropped.
    pub input_truncated: bool,
    /// `message.id` of the entry that held the block (parallel calls of one assistant message share it).
    pub msg_id: Option<String>,
    /// Record number of the entry.
    pub seq: u64,
    /// The entry's `timestamp` in epoch milliseconds.
    pub ts_ms: Option<i64>,
}

/// One event of the task tools, in transcript order: enough to rebuild a task list as
/// `hooks/lib/task-state.js` `reconstructTasks` does.
#[derive(Debug, Clone, PartialEq)]
pub enum TaskEvent {
    /// A use of one of `transcript.task_tools`.
    Use(ToolUse),
    /// The string result of a call to one of them.
    Result {
        /// `tool_use_id` the result answers.
        tool_use_id: String,
        /// Result text (`''` when the result content is not a string, like the Node reader), possibly cut.
        text: String,
        /// The text was longer than the cap and was cut.
        truncated: bool,
        /// Record number of the entry.
        seq: u64,
    },
}

/// An assistant reply as one of the two extractions of `hooks/speculation-guard.js` returns it (the index keeps the
/// newest of each: `collectTextFromEntryDedup` repeats no text, `collectTextFromEntryLegacy` is byte-identical to the
/// pre-3e72bf3 hook, which repeats text read from `message.content`; the regex path and a stored loop-safety hash
/// depend on the legacy one).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Assistant {
    /// The extracted text.
    pub text: String,
    /// The entry has `isSidechain: true` (a sub-conversation, not the main thread).
    pub sidechain: bool,
    /// Record number of the entry.
    pub seq: u64,
    /// The entry's `timestamp` in epoch milliseconds.
    pub ts_ms: Option<i64>,
    /// A text was longer than the cap and was cut.
    pub truncated: bool,
}

/// The last typed user prompt (`hooks/lib/inference-check.js` `lastUserPrompt`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Prompt {
    /// The prompt text.
    pub text: String,
    /// Record number of the entry.
    pub seq: u64,
    /// The text was longer than the cap and was cut.
    pub truncated: bool,
}

/// Everything one line contributes.
#[derive(Debug, Default)]
pub struct Record {
    /// The entry's `type`, else the overflow kind; the malformed kind for a line that is not a JSON object.
    pub kind: String,
    /// `isSidechain === true` (what `devswarm-idle.js` skips and `auto-handover-pause-nag.js` filters).
    pub sidechain: bool,
    /// `isMeta` is truthy (what `lastUserPrompt` skips).
    pub meta: bool,
    /// `isCompactSummary` is truthy (the summary entry a compaction writes).
    pub compact_summary: bool,
    /// A `system` entry with `subtype: compact_boundary` (the start of a compaction).
    pub compact_boundary: bool,
    /// The entry's `timestamp` in epoch milliseconds.
    pub ts_ms: Option<i64>,
    /// The entry has the assistant role and `collectTextFromEntryDedup` found text.
    pub assistant_dedup: Option<String>,
    /// The entry has the assistant role and `collectTextFromEntryLegacy` found text.
    pub assistant_legacy: Option<String>,
    /// Tool uses, in the order `collectTU` finds them.
    pub tool_uses: Vec<ToolUse>,
    /// String results of tool calls: (`tool_use_id`, text).
    pub tool_results: Vec<(String, String)>,
    /// Task-notification blocks.
    pub notifications: Vec<Notification>,
    /// A `task_status` attachment.
    pub task_status: Option<TaskStatus>,
    /// A typed user prompt.
    pub prompt: Option<String>,
}

// ---- JS semantics the readers rely on ---------------------------------------------------------------------------

/// JS `\s` / `String.prototype.trim` whitespace (differs from Rust's: it has U+FEFF and lacks U+0085).
fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    ) || ('\u{2000}'..='\u{200a}').contains(&c)
}

/// JS `trim()`.
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

fn js_trim_start(s: &str) -> &str {
    s.trim_start_matches(is_js_space)
}

/// JS truthiness of a JSON value (`[]` and `{}` are truthy; `""`, `0`, `null` and `false` are not).
fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(_) => true,
    }
}

fn str_of<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k).and_then(Value::as_str)
}

/// An RFC 3339 timestamp in epoch milliseconds (`Date.parse` of what the harness writes); `None` for anything else.
pub fn parse_ts_ms(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || !(b[10] == b'T' || b[10] == b't' || b[10] == b' ') || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let num = |a: usize, z: usize| -> Option<i64> { s.get(a..z)?.parse::<i64>().ok().filter(|_| s.as_bytes()[a..z].iter().all(u8::is_ascii_digit)) };
    let (y, mo, d, h, mi, sec) = (num(0, 4)?, num(5, 7)?, num(8, 10)?, num(11, 13)?, num(14, 16)?, num(17, 19)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 24 || mi > 59 || sec > 59 {
        return None;
    }
    let mut i = 19;
    let mut ms = 0i64;
    if b.get(i) == Some(&b'.') {
        let start = i + 1;
        i = start;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == start {
            return None;
        }
        let frac = &s[start..i];
        let three: String = frac.chars().chain(std::iter::repeat('0')).take(3).collect();
        ms = three.parse().ok()?;
    }
    let offset_min = match b.get(i) {
        Some(b'Z') | Some(b'z') if i + 1 == b.len() => 0,
        Some(sign @ (b'+' | b'-')) if i + 6 == b.len() && b[i + 3] == b':' => {
            let oh = num(i + 1, i + 3)?;
            let om = num(i + 4, i + 6)?;
            let v = oh * 60 + om;
            if *sign == b'-' { -v } else { v }
        }
        _ => return None,
    };
    // days from civil (Howard Hinnant's algorithm)
    let (yy, mm) = if mo <= 2 { (y - 1, mo + 9) } else { (y, mo - 3) };
    let era = yy.div_euclid(400);
    let yoe = yy - era * 400;
    let doy = (153 * mm + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    Some(((days * 24 + h) * 60 + mi - offset_min) * 60_000 + sec * 1000 + ms)
}

// ---- text extraction --------------------------------------------------------------------------------------------

/// `hooks/speculation-guard.js` `collectTextFromEntryLegacy` (`dedup = false`) and `collectTextFromEntryDedup`
/// (`dedup = true`): text of one node, joined with a space.
fn collect_text(node: &Value, dedup: bool) -> String {
    let Some(obj) = node.as_object() else { return String::new() };
    let mut parts: Vec<String> = Vec::new();
    if let Some(t) = obj.get("text").and_then(Value::as_str) {
        parts.push(t.to_string());
    }
    let msg = obj.get("message");
    let content = if truthy(obj.get("content")) { obj.get("content") } else { msg.and_then(|m| m.get("content")) };
    match content {
        Some(Value::String(s)) => parts.push(s.clone()),
        Some(Value::Array(a)) => {
            for block in a {
                if let Some(t) = block.as_object().and_then(|b| b.get("text")).and_then(Value::as_str) {
                    parts.push(t.to_string());
                }
            }
        }
        _ => {}
    }
    if let Some(m @ Value::Object(_)) = msg
        && (!dedup || truthy(obj.get("content")))
    {
        let sub = collect_text(m, dedup);
        if !sub.is_empty() {
            parts.push(sub);
        }
    }
    parts.join(" ")
}

/// The role `hooks/speculation-guard.js` reads: `entry.role || entry.message.role`.
fn is_assistant_role(e: &Value) -> bool {
    let role = if truthy(e.get("role")) { e.get("role") } else { e.get("message").and_then(|m| m.get("role")) };
    role.and_then(Value::as_str) == Some("assistant")
}

/// `hooks/lib/task-state.js` `collectTU`: every `tool_use` block with a name, found by recursing through
/// `content`, `message`, `messages`, `tool_uses` and `parts`.
fn collect_tool_uses<'a>(node: &'a Value, out: &mut Vec<&'a Value>) {
    let Some(obj) = node.as_object() else { return };
    if str_of(node, "type") == Some("tool_use") && obj.get("name").and_then(Value::as_str).is_some_and(|n| !n.is_empty()) {
        out.push(node);
    }
    for k in ["content", "message", "messages", "tool_uses", "parts"] {
        match obj.get(k) {
            Some(Value::Array(a)) => a.iter().for_each(|it| collect_tool_uses(it, out)),
            Some(v @ Value::Object(_)) => collect_tool_uses(v, out),
            _ => {}
        }
    }
}

// ---- task-notifications -----------------------------------------------------------------------------------------

fn block_re() -> &'static Regex {
    static R: crate::defaults::Cache<Regex> = crate::defaults::Cache::new();
    R.get_or_init(|| crate::checks::lit_re(r"(?s)<task-notification>(.*?)</task-notification>"))
}

fn wrapped_re() -> &'static Regex {
    static R: crate::defaults::Cache<Regex> = crate::defaults::Cache::new();
    R.get_or_init(|| crate::checks::lit_re(r"<system-reminder>[\s\x{feff}]*<task-notification>"))
}

/// `devswarm-idle.js` `notificationTexts`: the text leaves of an entry that hold a notification, across the three
/// shapes. A genuine notice BEGINS with the tag or sits directly inside a `<system-reminder>`; a message that
/// merely quotes a block mid-text is not a completion.
fn notification_texts(e: &Value) -> Vec<(Shape, String)> {
    let mut out: Vec<(Shape, String)> = Vec::new();
    match str_of(e, "type") {
        Some("user") => match e.get("message").and_then(|m| m.get("content")) {
            Some(Value::String(s)) => out.push((Shape::User, s.clone())),
            Some(Value::Array(a)) => {
                for b in a {
                    if str_of(b, "type") == Some("text")
                        && let Some(t) = str_of(b, "text")
                    {
                        out.push((Shape::User, t.to_string()));
                    }
                }
            }
            _ => {}
        },
        Some("attachment") => {
            if let Some(p) = e.get("attachment").and_then(|a| a.get("prompt")).and_then(Value::as_str) {
                out.push((Shape::Attachment, p.to_string()));
            }
        }
        Some("queue-operation") => {
            if let Some(c) = str_of(e, "content") {
                out.push((Shape::QueueOperation, c.to_string()));
            }
        }
        _ => {}
    }
    out.retain(|(_, t)| js_trim_start(t).starts_with("<task-notification>") || wrapped_re().is_match(t));
    out
}

fn final_re() -> &'static Regex {
    static R: crate::defaults::Cache<Regex> = crate::defaults::Cache::new();
    R.get_or_init(|| {
        let alt = defaults::words("transcript.final_statuses").iter().map(|w| regex::escape(w)).collect::<Vec<_>>().join("|");
        crate::checks::lit_re(&format!(r"(?i)<status>[\s\x{{feff}}]*(?:{alt})[\s\x{{feff}}]*</status>"))
    })
}

fn tag_re(tag: &str, trimmed_no_space: bool) -> Regex {
    // `agent-scan.js` reads `<tag>([^<]*)</tag>`; `devswarm-idle.js` reads `<tag>\s*([^<\s]+)\s*</tag>`.
    if trimmed_no_space {
        crate::checks::lit_re(&format!(r"<{tag}>[\s\x{{feff}}]*([^<\s\x{{feff}}]+)[\s\x{{feff}}]*</{tag}>"))
    } else {
        crate::checks::lit_re(&format!(r"<{tag}>([^<]*)</{tag}>"))
    }
}

struct TagRes {
    task_raw: Regex,
    status_raw: Regex,
    task_idle: Regex,
    tool_idle: Regex,
}

fn tag_res() -> &'static TagRes {
    static R: crate::defaults::Cache<TagRes> = crate::defaults::Cache::new();
    R.get_or_init(|| TagRes {
        task_raw: tag_re("task-id", false),
        status_raw: tag_re("status", false),
        task_idle: tag_re("task-id", true),
        tool_idle: tag_re("tool-use-id", true),
    })
}

fn notifications_of(e: &Value, seq: u64, ts_ms: Option<i64>) -> Vec<Notification> {
    let mut out = Vec::new();
    let r = tag_res();
    for (shape, text) in notification_texts(e) {
        for m in block_re().captures_iter(&text) {
            let body = m.get(1).map_or("", |g| g.as_str());
            let cap = |re: &Regex| re.captures(body).and_then(|c| c.get(1)).map(|g| g.as_str().to_string());
            out.push(Notification {
                shape,
                seq,
                ts_ms,
                task_id: cap(&r.task_raw),
                status: cap(&r.status_raw),
                idle_task_id: cap(&r.task_idle),
                idle_tool_use_id: cap(&r.tool_idle),
                final_status: final_re().is_match(body),
            });
        }
    }
    out
}

// ---- typed prompts ----------------------------------------------------------------------------------------------

/// `inference-check.js` `lastUserPrompt`, one entry: the typed prompt this entry holds, if any.
fn prompt_of(e: &Value) -> Option<String> {
    if str_of(e, "type") == Some("event_msg")
        && let Some(p) = e.get("payload")
        && str_of(p, "type") == Some("user_message")
        && let Some(m) = str_of(p, "message")
    {
        return Some(m.to_string());
    }
    if truthy(e.get("isMeta")) {
        return None;
    }
    let empty = Map::new();
    let msg_val = e.get("message");
    // `msg = e.message && typeof e.message === 'object' ? e.message : e` (an array is an object with no fields)
    let msg: &Map<String, Value> = match msg_val {
        Some(Value::Object(m)) if truthy(msg_val) => m,
        Some(Value::Array(_)) => &empty,
        _ => e.as_object()?,
    };
    let pick = |k: &str| msg.get(k).filter(|v| truthy(Some(v))).and_then(Value::as_str).map(str::to_string);
    let role = if truthy(e.get("role")) { str_of(e, "role").map(str::to_string) } else { pick("role").or_else(|| str_of(e, "type").map(str::to_string)) };
    if role.as_deref() != Some("user") {
        return None;
    }
    let text = match msg.get("content") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(a)) if !a.iter().any(|b| str_of(b, "type") == Some("tool_result")) => {
            a.iter().filter(|b| str_of(b, "type") == Some("text")).filter_map(|b| str_of(b, "text")).collect::<Vec<_>>().join("\n")
        }
        _ => String::new(),
    };
    if js_trim(&text).is_empty() {
        return None;
    }
    let lead = js_trim_start(&text);
    if defaults::list("transcript.non_prompt_prefixes").iter().any(|p| lead.starts_with(p)) {
        return None;
    }
    Some(text)
}

// ---- the line ---------------------------------------------------------------------------------------------------

/// Parse one non-empty line. `seq` is its record number; `input_cap` bounds a kept tool input.
pub fn parse_line(line: &str, seq: u64, input_cap: usize, task_input_cap: usize) -> Record {
    let trimmed = js_trim(line);
    let overflow = defaults::text("transcript.overflow_kind");
    let Ok(e @ Value::Object(_)) = serde_json::from_str::<Value>(trimmed) else {
        return Record { kind: defaults::text("transcript.malformed_kind").to_string(), ..Record::default() };
    };
    let mut r = Record { kind: str_of(&e, "type").map_or_else(|| overflow.to_string(), str::to_string), ..Record::default() };
    r.sidechain = e.get("isSidechain") == Some(&Value::Bool(true));
    r.meta = truthy(e.get("isMeta"));
    r.compact_summary = truthy(e.get("isCompactSummary"));
    r.compact_boundary = r.kind == "system" && str_of(&e, "subtype") == Some("compact_boundary");
    r.ts_ms = str_of(&e, "timestamp").and_then(parse_ts_ms);
    if is_assistant_role(&e) {
        // speculation-guard keeps a reply only `if (text)`, for each extraction on its own
        let (dedup, legacy) = (collect_text(&e, true), collect_text(&e, false));
        r.assistant_dedup = Some(dedup).filter(|t| !t.is_empty());
        r.assistant_legacy = Some(legacy).filter(|t| !t.is_empty());
    }
    let task_tools = defaults::list("transcript.task_tools");
    let msg_id = e.get("message").and_then(|m| str_of(m, "id")).map(str::to_string);
    let mut found = Vec::new();
    collect_tool_uses(&e, &mut found);
    for tu in found {
        let name = str_of(tu, "name").unwrap_or_default().to_string();
        let input = tu.get("input").cloned().unwrap_or(Value::Null);
        let cap = if task_tools.contains(&name.as_str()) { task_input_cap } else { input_cap };
        let big = serde_json::to_vec(&input).map_or(0, |v| v.len()) > cap;
        r.tool_uses.push(ToolUse {
            id: str_of(tu, "id").map(str::to_string),
            name,
            input: if big { Value::Null } else { input },
            input_truncated: big,
            msg_id: msg_id.clone(),
            seq,
            ts_ms: r.ts_ms,
        });
    }
    if str_of(&e, "type") == Some("user")
        && let Some(Value::Array(c)) = e.get("message").and_then(|m| m.get("content"))
    {
        for it in c {
            if str_of(it, "type") == Some("tool_result")
                && let Some(id) = str_of(it, "tool_use_id")
            {
                r.tool_results.push((id.to_string(), it.get("content").and_then(Value::as_str).unwrap_or("").to_string()));
            }
        }
    }
    r.notifications = notifications_of(&e, seq, r.ts_ms);
    if let Some(att) = e.get("attachment")
        && str_of(att, "type") == Some("task_status")
        && let Some(id) = str_of(att, "taskId").filter(|i| !i.is_empty())
    {
        r.task_status = Some(TaskStatus {
            seq,
            task_id: id.to_string(),
            status: match att.get("status") {
                Some(Value::String(s)) => s.clone(),
                Some(Value::Null) | None => "undefined".to_string(),
                Some(v) => v.to_string(),
            },
            output_file: str_of(att, "outputFilePath").unwrap_or_default().to_string(),
            description: str_of(att, "description").unwrap_or_default().to_string(),
            ts_ms: r.ts_ms.or_else(|| str_of(att, "timestamp").and_then(parse_ts_ms)),
        });
    }
    r.prompt = prompt_of(&e);
    r
}

/// Cut `s` to at most `max` bytes at a character boundary; true when it was cut.
pub fn cap_text(s: &mut String, max: usize) -> bool {
    if s.len() <= max {
        return false;
    }
    let mut cut = max;
    while !s.is_char_boundary(cut) {
        cut -= 1;
    }
    s.truncate(cut);
    true
}
