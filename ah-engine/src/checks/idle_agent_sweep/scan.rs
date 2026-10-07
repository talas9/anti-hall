//! The part of `hooks/lib/agent-scan.js` `scanTranscript` that decides which named in-process teammates are finished but
//! never stopped (`finishedTeammates`), read from the transcript lines of one session.
//!
//! A teammate is spawned by an Agent tool result (`toolUseResult.status` = `teammate_spawned`), is sent messages by
//! SendMessage ("Message sent to `<name>`'s inbox"), reports a finished turn with an `idle_notification` block inside a
//! "Another Claude session sent a message:" user entry, and is ended by TaskStop. Replaying those events in time order
//! leaves a teammate idle with `idleReason` `available` or `failed` and no later send or stop: finished, not stopped.
//!
//! Only what that result depends on is ported: the replay itself, and the background agents' ids (a launch result, a
//! `task_status` attachment, a terminal `<task-notification>`), because a teammate whose name equals one of those ids is not
//! listed. The pending-message bookkeeping and the safety-net passes of the Node scan feed other callers and are not
//! reproduced. A transcript line that holds a relevant marker but that neither JSON parser reads, or a timestamp that is
//! not the strict ISO form, is [`Defer`]: JavaScript might read it and decide differently.
use crate::checks::emit_dedupe::Defer;
use crate::checks::guardkit::jsre;
use crate::checks::guardkit::jsval::{DateParse, date_parse, parse_line};
use crate::checks::guardkit::text::{is_js_space, js_trim};
use crate::defaults;
use regex::Regex;
use serde_json::Value;
use std::collections::HashSet;

/// A teammate that finished its work and was not stopped.
#[derive(Debug, Clone, PartialEq)]
pub struct Finished {
    /// The teammate's name (what TaskStop takes).
    pub name: String,
    /// When its last turn ended, in milliseconds since the epoch.
    pub idle_since_ms: f64,
}

struct Res {
    terminal_status: Regex,
    finished_reason: Regex,
    hex_id: Regex,
    agent_id: Regex,
    resume_message: Regex,
    queued_message: Regex,
    inbox_message: Regex,
    notification_block: Regex,
    task_id: Regex,
    status: Regex,
    system_reminder_notice: Regex,
}

fn res() -> &'static Res {
    static R: crate::defaults::Cache<Res> = crate::defaults::Cache::new();
    R.get_or_init(|| {
        let c = |k: &str, ci: bool| jsre::compile(defaults::text(k), ci);
        Res {
            terminal_status: c("idle_sweep.re_terminal_status", true),
            finished_reason: c("idle_sweep.re_finished_reason", false),
            hex_id: c("idle_sweep.re_hex_id", false),
            agent_id: c("idle_sweep.re_agent_id", false),
            resume_message: c("idle_sweep.re_resume_message", true),
            queued_message: c("idle_sweep.re_queued_message", false),
            inbox_message: c("idle_sweep.re_inbox_message", false),
            notification_block: c("idle_sweep.re_notification_block", false),
            task_id: c("idle_sweep.re_task_id", false),
            status: c("idle_sweep.re_status", false),
            system_reminder_notice: c("idle_sweep.re_system_reminder_notice", false),
        }
    })
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Spawn,
    Send,
    Idle,
    Stop,
}

struct Ev {
    kind: Kind,
    ts: f64,
    seq: usize,
    reason: String,
}

struct Info {
    agent_id: String,
}

/// One content block of a user entry, as the Node walk reads it.
struct Blk<'a> {
    tuid: Option<&'a str>,
    is_tool_result: bool,
    is_error: bool,
    inner: &'a Value,
}

/// An insertion-ordered map with a linear lookup (the sizes here are tens of entries).
struct OMap<V> {
    items: Vec<(String, V)>,
}

impl<V> OMap<V> {
    fn new() -> OMap<V> {
        OMap { items: Vec::new() }
    }
    fn has(&self, k: &str) -> bool {
        self.items.iter().any(|(n, _)| n == k)
    }
    fn get_mut(&mut self, k: &str) -> Option<&mut V> {
        self.items.iter_mut().find(|(n, _)| n == k).map(|(_, v)| v)
    }
    /// `Map.set`: replace in place, or append.
    fn set(&mut self, k: &str, v: V) {
        match self.get_mut(k) {
            Some(slot) => *slot = v,
            None => self.items.push((k.to_string(), v)),
        }
    }
}

struct Scan {
    tool_uses: std::collections::HashMap<String, Option<String>>,
    team_events: OMap<Vec<Ev>>,
    team_info: OMap<Info>,
    launched: HashSet<String>,
    terminal: HashSet<String>,
    errored: HashSet<String>,
    stops: Vec<(String, usize, Option<String>, f64)>,
}

impl Scan {
    fn event(&mut self, name: &str, kind: Kind, ts: f64, seq: usize, reason: &str) {
        if !self.team_events.has(name) {
            self.team_events.set(name, Vec::new());
        }
        if let Some(v) = self.team_events.get_mut(name) {
            v.push(Ev { kind, ts, seq, reason: reason.to_string() });
        }
    }

    /// `answersCall(toolUseId, names)`: true unless a seen tool call with that id has another name.
    fn answers(&self, tool_use_id: Option<&str>, names_key: &str) -> bool {
        match tool_use_id.and_then(|t| self.tool_uses.get(t)) {
            None => true,
            Some(name) => name.as_deref().is_some_and(|n| defaults::list(names_key).contains(&n)),
        }
    }
}

fn str_of<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

/// `Date.parse(entry.timestamp)` for an entry: NaN unless the timestamp is a string.
fn entry_ts(e: &Value) -> Result<f64, Defer> {
    match e.get("timestamp").and_then(Value::as_str) {
        Some(s) => ts_of(s),
        None => Ok(f64::NAN),
    }
}

fn ts_of(s: &str) -> Result<f64, Defer> {
    match date_parse(s) {
        DateParse::Ms(ms) => Ok(ms),
        DateParse::Nan => Ok(f64::NAN),
        DateParse::Unsupported => Err(Defer),
    }
}

/// `extractTexts(node)`: every string leaf of a message `content` value.
fn extract_texts(node: &Value, out: &mut Vec<String>) {
    match node {
        Value::String(s) => out.push(s.clone()),
        Value::Array(a) => a.iter().for_each(|x| extract_texts(x, out)),
        Value::Object(o) => {
            if let Some(Value::String(t)) = o.get("text") {
                out.push(t.clone());
            }
            if let Some(c) = o.get("content") {
                extract_texts(c, out);
            }
        }
        _ => {}
    }
}

/// `notificationTexts(entry)` of `devswarm-idle.js`: the entry's texts that start a `<task-notification>` block.
fn notification_texts(e: &Value) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let content = e.get("message").and_then(|m| m.get("content"));
    match e.get("type").and_then(Value::as_str) {
        Some("user") => match content {
            Some(Value::String(s)) => out.push(s.clone()),
            Some(Value::Array(a)) => {
                for b in a {
                    if str_of(b, "type") == Some("text")
                        && let Some(t) = str_of(b, "text")
                    {
                        out.push(t.to_string());
                    }
                }
            }
            _ => {}
        },
        Some("attachment") => {
            if let Some(p) = e.get("attachment").and_then(|a| str_of(a, "prompt")) {
                out.push(p.to_string());
            }
        }
        Some("queue-operation") => {
            if let Some(c) = str_of(e, "content") {
                out.push(c.to_string());
            }
        }
        _ => {}
    }
    let tag = defaults::text("idle_sweep.notification_tag");
    out.into_iter().filter(|t| t.trim_start_matches(is_js_space).starts_with(tag) || res().system_reminder_notice.is_match(t)).collect()
}

/// `parseResumeResult(text) !== null`.
fn is_resume_result(text: &str) -> bool {
    let t = js_trim(text);
    if !t.starts_with('{') {
        return res().resume_message.is_match(t);
    }
    if !t.contains("Resuming") && !t.contains("resumedAgentId") {
        return false;
    }
    let Some(o) = parse_line(t) else { return false };
    if !o.is_object() || o.get("success") != Some(&Value::Bool(true)) {
        return false;
    }
    let full = str_of(&o, "resumedAgentId").is_some_and(|id| res().hex_id.is_match(id));
    full || str_of(&o, "message").is_some_and(|m| res().resume_message.is_match(m))
}

/// `isQueuedMessageResult(text)`.
fn is_queued_message(text: &str) -> bool {
    if !text.contains(defaults::text("idle_sweep.queued_marker")) {
        return false;
    }
    parse_line(text).is_some_and(|o| str_of(&o, "message").is_some_and(|m| res().queued_message.is_match(m)))
}

/// `parseInboxSendResult(text)`: the teammate a SendMessage result names.
fn inbox_target(text: &str) -> Option<String> {
    if !text.contains(defaults::text("idle_sweep.inbox_marker")) {
        return None;
    }
    let t = js_trim(text);
    if !t.starts_with('{') {
        return None;
    }
    let o = parse_line(t)?;
    if !o.is_object() || o.get("success") != Some(&Value::Bool(true)) {
        return None;
    }
    let m = str_of(&o, "message")?;
    res().inbox_message.captures(m).map(|c| c[1].to_string())
}

/// `teammateIdles(entry, entryTs, spawned)`: the idle notifications a genuine teammate report carries.
fn teammate_idles(e: &Value, ts: f64, spawned: &OMap<Info>) -> Result<Vec<(String, f64, String)>, Defer> {
    let mut out = Vec::new();
    if str_of(e, "type") != Some("user") {
        return Ok(out);
    }
    let Some(c) = e.get("message").and_then(|m| m.get("content")).and_then(Value::as_str) else { return Ok(out) };
    let prefix = defaults::text("idle_sweep.report_prefix");
    if !c.starts_with(prefix) {
        return Ok(out);
    }
    for k in defaults::list("idle_sweep.not_a_report_keys") {
        let present = if k == "isSidechain" { e.get(k) == Some(&Value::Bool(true)) } else { e.get(k).is_some() };
        if present {
            return Ok(out);
        }
    }
    let (open, close) = (defaults::text("idle_sweep.block_open"), defaults::text("idle_sweep.block_close"));
    let skew = defaults::num("idle_sweep.report_future_skew_ms") as f64;
    let skip_ws = |at: usize| at + c[at..].chars().take_while(|ch| is_js_space(*ch)).map(char::len_utf8).sum::<usize>();
    let mut at = skip_ws(prefix.len());
    // `<teammate-message teammate_id="([^"]+)"[^>]*>\n([\s\S]*?)\n</teammate-message>`, matched at `at` exactly.
    while let Some(rest) = c[at..].strip_prefix(open) {
        let Some(q) = rest.find('"') else { break };
        if q == 0 {
            break;
        }
        let name = &rest[..q];
        let after_name = &rest[q + 1..];
        let Some(gt) = after_name.find('>') else { break };
        let Some(body_start) = after_name[gt + 1..].strip_prefix('\n') else { break };
        let Some(end) = body_start.find(close) else { break };
        let body = &body_start[..end];
        let consumed = c.len() - body_start.len() + end + close.len();
        at = skip_ws(consumed);
        if !spawned.has(name) || body.contains('\n') || !body.starts_with('{') {
            continue;
        }
        let Some(o) = parse_line(body) else { continue };
        if str_of(&o, "type") != Some("idle_notification") || str_of(&o, "from") != Some(name) {
            continue;
        }
        let inner = match str_of(&o, "timestamp") {
            Some(s) => ts_of(s)?,
            None => f64::NAN,
        };
        if inner.is_finite() && ts.is_finite() && inner > ts + skew {
            continue;
        }
        let when = if inner.is_finite() && ts.is_finite() { inner } else { ts };
        out.push((name.to_string(), when, str_of(&o, "idleReason").unwrap_or("").to_string()));
    }
    Ok(out)
}

/// The finished-but-not-stopped teammates of the transcript lines, in the order the Node scan lists them.
pub fn finished_teammates<S: AsRef<str>>(lines: impl IntoIterator<Item = S>) -> Result<Vec<Finished>, Defer> {
    let r = res();
    let mut sc = Scan {
        tool_uses: std::collections::HashMap::new(),
        team_events: OMap::new(),
        team_info: OMap::new(),
        launched: HashSet::new(),
        terminal: HashSet::new(),
        errored: HashSet::new(),
        stops: Vec::new(),
    };
    let marks = defaults::list("idle_sweep.prefilter");
    let launch_phrase = defaults::text("idle_sweep.launch_phrase");
    let mut seq = 0usize;
    for raw in lines {
        seq += 1;
        let line = js_trim(raw.as_ref());
        if line.is_empty() || !marks.iter().any(|m| line.contains(m)) {
            continue;
        }
        let Some(entry) = parse_line(line) else { return Err(Defer) };
        if !entry.is_object() {
            continue;
        }
        let has_launch = line.contains(launch_phrase);
        let has_notif = line.contains(defaults::text("idle_sweep.notification_tag"));
        let has_tool_use = line.contains("\"tool_use\"");
        let has_idle = line.contains(defaults::text("idle_sweep.idle_marker"));
        let has_task_stop = defaults::list("idle_sweep.task_stop_marks").iter().any(|m| line.contains(m));
        let ts = entry_ts(&entry)?;
        let etype = str_of(&entry, "type");

        // (a0) a `task_status` attachment re-injects a live (or finished) background agent.
        if let Some(att) = entry.get("attachment")
            && str_of(att, "type") == Some("task_status")
            && let Some(id) = str_of(att, "taskId").filter(|s| !s.is_empty())
        {
            let status = att.get("status");
            if status == Some(&Value::String("running".into())) {
                sc.launched.insert(id.to_string());
            } else if r.terminal_status.is_match(&status.map_or_else(|| "undefined".to_string(), crate::checks::guardkit::jsval::js_to_string)) {
                sc.terminal.insert(id.to_string());
            }
        }

        let content = entry.get("message").and_then(|m| m.get("content"));
        let blocks_of_content: &[Value] = match content {
            Some(Value::Array(a)) => a,
            _ => &[],
        };
        if has_tool_use && etype == Some("assistant") {
            for b in blocks_of_content {
                if str_of(b, "type") == Some("tool_use")
                    && let Some(id) = str_of(b, "id")
                {
                    sc.tool_uses.insert(id.to_string(), str_of(b, "name").map(str::to_string));
                }
            }
        }
        if has_task_stop && etype == Some("assistant") {
            for b in blocks_of_content {
                if str_of(b, "type") == Some("tool_use")
                    && str_of(b, "name") == Some("TaskStop")
                    && let Some(id) = b.get("input").and_then(|i| str_of(i, "task_id")).filter(|s| !s.is_empty())
                {
                    sc.stops.push((id.to_string(), seq, str_of(b, "id").map(str::to_string), ts));
                }
            }
        }
        // (b) terminal notifications, in every transcript shape.
        if has_notif {
            for text in notification_texts(&entry) {
                for m in r.notification_block.captures_iter(&text) {
                    let body = &m[1];
                    let tid = r.task_id.captures(body).map(|c| c[1].to_string());
                    let status = r.status.captures(body).map(|c| c[1].to_string());
                    if let (Some(tid), Some(st)) = (tid, status)
                        && !tid.is_empty()
                        && r.terminal_status.is_match(&st)
                    {
                        sc.terminal.insert(tid);
                    }
                }
            }
        }
        if has_idle {
            for (name, when, reason) in teammate_idles(&entry, ts, &sc.team_info)? {
                sc.event(&name, Kind::Idle, when, seq, &reason);
            }
        }
        if etype != Some("user") {
            continue;
        }
        // A teammate spawn is a structured field of the Agent tool result.
        if let Some(tur) = entry.get("toolUseResult")
            && str_of(tur, "status") == Some(defaults::text("idle_sweep.spawned_status"))
            && let Some(name) = str_of(tur, "name").filter(|s| !s.is_empty())
            && let Some(Value::Array(blocks)) = content
            && let Some(tr) = blocks.iter().find(|b| str_of(b, "type") == Some("tool_result"))
            && sc.answers(str_of(tr, "tool_use_id"), "idle_sweep.launch_tools")
        {
            sc.event(name, Kind::Spawn, ts, seq, "");
            sc.team_info.set(name, Info { agent_id: str_of(tur, "agent_id").unwrap_or("").to_string() });
        }
        // Walk each content block, or the single non-array content itself.
        let blocks: Vec<Blk<'_>> = match content {
            Some(Value::Array(a)) => a
                .iter()
                .filter(|b| truthy(b))
                .map(|b| Blk {
                    tuid: str_of(b, "tool_use_id"),
                    is_tool_result: str_of(b, "type") == Some("tool_result"),
                    is_error: b.get("is_error") == Some(&Value::Bool(true)),
                    inner: b.get("content").unwrap_or(b),
                })
                .collect(),
            Some(other) => vec![Blk { tuid: None, is_tool_result: false, is_error: false, inner: other }],
            None => Vec::new(),
        };
        for b in &blocks {
            if b.is_tool_result
                && b.is_error
                && let Some(t) = b.tuid
            {
                sc.errored.insert(t.to_string());
            }
            let mut texts = Vec::new();
            extract_texts(b.inner, &mut texts);
            for text in texts {
                if b.is_tool_result
                    && has_launch
                    && sc.answers(b.tuid, "idle_sweep.launch_tools")
                    && text.trim_start_matches(is_js_space).starts_with(launch_phrase)
                {
                    let sid = entry.get("toolUseResult").and_then(|t| str_of(t, "agentId")).filter(|id| r.hex_id.is_match(id)).map(str::to_string);
                    let idm = r.agent_id.captures(&text).map(|c| c[1].to_string());
                    if let Some(id) = sid.or(idm) {
                        sc.launched.insert(id);
                    }
                }
                if b.is_tool_result && sc.answers(b.tuid, "idle_sweep.resume_tools") && is_resume_result(&text) {
                    continue;
                }
                if is_queued_message(&text) {
                    continue;
                }
                if b.is_tool_result
                    && sc.answers(b.tuid, "idle_sweep.send_tools")
                    && let Some(name) = inbox_target(&text)
                {
                    sc.event(&name, Kind::Send, ts, seq, "");
                }
            }
        }
    }
    // Background-agent ids as of now: a teammate named like one of them is not a teammate.
    let background: HashSet<String> = sc.launched.union(&sc.terminal).cloned().collect();
    let stops = std::mem::take(&mut sc.stops);
    for (id, sseq, tuid, sts) in stops {
        if tuid.as_ref().is_some_and(|t| sc.errored.contains(t)) {
            continue;
        }
        let named: Vec<String> = sc.team_info.items.iter().filter(|(_, info)| info.agent_id == id).map(|(n, _)| n.clone()).collect();
        for name in named {
            if !sc.team_events.has(&id) {
                sc.event(&name, Kind::Stop, sts, sseq, "");
            }
        }
        if sc.team_events.has(&id) {
            sc.event(&id, Kind::Stop, sts, sseq, "");
        }
    }
    let mut finished = Vec::new();
    for (name, evs) in &sc.team_events.items {
        if !evs.iter().any(|e| matches!(e.kind, Kind::Spawn | Kind::Idle)) || evs.iter().any(|e| !e.ts.is_finite()) {
            continue;
        }
        let mut ordered: Vec<&Ev> = evs.iter().collect();
        ordered.sort_by(|a, b| a.ts.partial_cmp(&b.ts).unwrap_or(std::cmp::Ordering::Equal).then(a.seq.cmp(&b.seq)));
        #[derive(PartialEq)]
        enum State {
            Idle,
            Busy,
            Stopped,
        }
        let (mut state, mut queued, mut last_idle, mut last_reason) = (State::Idle, false, f64::NAN, String::new());
        for e in ordered {
            match e.kind {
                Kind::Spawn => {
                    state = State::Busy;
                    queued = false;
                }
                Kind::Stop => {
                    state = State::Stopped;
                    queued = false;
                }
                _ if state == State::Stopped => {}
                Kind::Send => {
                    if state == State::Idle {
                        state = State::Busy;
                    } else {
                        queued = true;
                    }
                }
                Kind::Idle => {
                    last_idle = e.ts;
                    last_reason = e.reason.clone();
                    if queued {
                        queued = false;
                        state = State::Busy;
                    } else {
                        state = State::Idle;
                    }
                }
            }
        }
        if state == State::Idle && r.finished_reason.is_match(&last_reason) && last_idle.is_finite() && !background.contains(name) {
            finished.push(Finished { name: name.clone(), idle_since_ms: last_idle });
        }
    }
    Ok(finished)
}

/// JavaScript truthiness of a JSON value.
fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|x| x != 0.0 && !x.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}
