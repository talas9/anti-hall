//! This session's background agents and named teammates, read from the transcript: the port of `hooks/lib/agent-scan.js`
//! that `ask-guard`, `silent-agent-nudge` and `stale-agent-stop-note` share.
//!
//! The Node scanner reads the tail of the transcript into memory and walks every line. This one streams the same window
//! line by line, so a 64 MiB window never sits in the daemon's memory at once; what it keeps is the small state the walk
//! needs (launches, terminal evidence, teammate events) plus the answers to `TaskOutput` / `SendMessage` calls, which the
//! delivered-but-unnotified safety net searches (bounded by `agent_scan.retain_bytes`).
//!
//! Where JavaScript would behave in a way this port cannot reproduce byte for byte (a JSON line with a lone surrogate
//! escape, a timestamp format only V8's legacy date parser reads, a retained-text budget overrun) the scan returns
//! [`Unsupported`], and the check defers to the Node hook, which decides. A deferral is never a silent allow (D11).
use crate::checks::guardkit::jsre;
use crate::checks::guardkit::text::{js_trim, js_trim_start as trim_start};
use crate::defaults;
use crate::mem::{BoundedCache, Spec};
use regex::Regex;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, Read, Seek, SeekFrom};
use std::os::unix::fs::{FileExt, MetadataExt};
use std::sync::OnceLock;

#[cfg(test)]
mod tests;

/// The Node hook must decide: this port cannot reproduce JavaScript's answer exactly.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Unsupported;

/// A scan result, or the request to defer to Node.
pub type Res<T> = Result<T, Unsupported>;

/// What a caller controls about one scan (`scanTranscript`'s `opts`).
#[derive(Debug, Clone, Copy)]
pub struct Opts {
    /// The clock for the pending-message bound (`Date.now()`).
    pub now_ms: f64,
    /// Skip a `TaskStop` tool_use that has no tool_result yet.
    pub ignore_unanswered_stops: bool,
}

/// `Date.now()`.
pub fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

/// One launched agent or teammate (the object `scanTranscript` keeps per id).
#[derive(Debug, Clone)]
pub struct Rec {
    /// Adopted from a `task_status` attachment or a resume rather than seen launching.
    pub adopted: bool,
    /// The harness's per-agent output file (empty when unknown).
    pub output_file: String,
    /// The `description` of the Agent call that launched it (empty when unknown).
    pub description: String,
    /// Launch time in ms since the epoch; NaN when unknown.
    pub launched_at_ms: f64,
    /// The launching tool_use id.
    pub tool_use_id: Option<String>,
    /// Newest resume time, when it was resumed.
    pub resumed_at_ms: Option<f64>,
    /// A named in-process teammate.
    pub teammate: bool,
    /// Newest sign of life of a teammate with a pending message; NaN when unknown.
    pub last_seen_ms: f64,
    /// A teammate that was sent a message and has not reported since.
    pub pending_message: bool,
    /// The `taskType` of the `task_status` attachment that adopted it (`local_agent`, `local_bash`); empty when launched or unknown.
    pub task_type: String,
    /// The input of the Agent/Task call that launched it (Node `rec.spawnInput`); `None` when that call is outside the window.
    pub spawn_input: Option<Value>,
}

/// A teammate message that has not been answered.
#[derive(Debug, Clone)]
pub struct Pending {
    /// When the message was sent.
    pub sent_at_ms: f64,
    /// The teammate's last report time; NaN when none.
    pub last_idle_ms: f64,
    /// The newest sign of life (the send itself, or the teammate's sidechain transcript).
    pub last_seen_ms: f64,
    /// Whether the teammate still counts as running.
    pub live: bool,
    /// The `<name>@<team>` agent id (empty when unknown).
    pub agent_id: String,
}

/// An insertion-ordered map: a JavaScript `Map` (setting an existing key keeps its position).
#[derive(Debug, Clone)]
pub struct OMap<T> {
    keys: Vec<String>,
    map: HashMap<String, T>,
}

impl<T> Default for OMap<T> {
    fn default() -> Self {
        OMap { keys: Vec::new(), map: HashMap::new() }
    }
}

impl<T> OMap<T> {
    /// `map.set(k, v)`.
    pub fn set(&mut self, k: &str, v: T) {
        if self.map.insert(k.to_string(), v).is_none() {
            self.keys.push(k.to_string());
        }
    }
    /// `map.get(k)`.
    pub fn get(&self, k: &str) -> Option<&T> {
        self.map.get(k)
    }
    /// `map.get(k)`, mutable.
    pub fn get_mut(&mut self, k: &str) -> Option<&mut T> {
        self.map.get_mut(k)
    }
    /// `map.has(k)`.
    pub fn has(&self, k: &str) -> bool {
        self.map.contains_key(k)
    }
    /// The entries in insertion order.
    pub fn iter(&self) -> impl Iterator<Item = (&String, &T)> {
        self.keys.iter().filter_map(|k| self.map.get(k).map(|v| (k, v)))
    }
    /// The keys in insertion order.
    pub fn keys(&self) -> impl Iterator<Item = &String> {
        self.keys.iter()
    }
}

/// What `scanTranscript` returns (the parts the ported checks read).
#[derive(Debug, Default, Clone)]
pub struct Scan {
    /// Every launched agent, adopted agent and live teammate, in order.
    pub launched: OMap<Rec>,
    /// Ids with terminal evidence that stands.
    pub terminal: HashSet<String>,
    /// Teammates sent a message they have not reported on.
    pub pending: Vec<(String, Pending)>,
}

/// One running agent as `rowsOf` lists it (the fields the ported checks read).
#[derive(Debug, Clone)]
pub struct Row {
    /// The agent id (or teammate name).
    pub id: String,
    /// Its description (empty when unknown).
    pub description: String,
    /// The whole record (launch, resume and sign-of-life times, output file).
    pub rec: Rec,
}

impl Scan {
    /// `rowsOf(scan)`: launched and not terminal.
    pub fn rows(&self) -> Vec<Row> {
        self.launched
            .iter()
            .filter(|(id, _)| !self.terminal.contains(*id))
            .map(|(id, r)| Row { id: id.clone(), description: r.description.clone(), rec: r.clone() })
            .collect()
    }
}

struct Pats {
    block: Regex,
    task_id: Regex,
    status: Regex,
    agent_id: Regex,
    output_file: Regex,
    resume_message: Regex,
    hex_id: Regex,
    hex_run: Regex,
    running_row: Regex,
    notif_reminder: Regex,
    inbox: Regex,
    teammate_block: Regex,
    queued: Regex,
    iso_dt: Regex,
    iso_d: Regex,
    surrogate: Regex,
}

fn pats() -> &'static Pats {
    static P: crate::defaults::Cache<Pats> = crate::defaults::Cache::new();
    P.get_or_init(|| Pats {
        block: crate::checks::lit_re(defaults::text("agent_scan.re_notification_block")),
        task_id: crate::checks::lit_re(defaults::text("agent_scan.re_task_id")),
        status: crate::checks::lit_re(defaults::text("agent_scan.re_status")),
        agent_id: jsre::compile(defaults::text("agent_scan.re_agent_id"), false),
        output_file: jsre::compile(defaults::text("agent_scan.re_output_file"), false),
        resume_message: jsre::compile(defaults::text("agent_scan.re_resume_message"), true),
        hex_id: crate::checks::lit_re(defaults::text("agent_scan.re_hex_id")),
        hex_run: crate::checks::lit_re(defaults::text("agent_scan.re_hex_run")),
        running_row: jsre::compile(defaults::text("agent_scan.re_running_row"), true),
        notif_reminder: jsre::compile(defaults::text("agent_scan.re_notification_in_reminder"), false),
        inbox: jsre::compile(defaults::text("agent_scan.re_inbox_send"), false),
        teammate_block: crate::checks::lit_re(defaults::text("agent_scan.re_teammate_block")),
        queued: jsre::compile(defaults::text("agent_scan.re_queued_message"), false),
        iso_dt: crate::checks::lit_re(defaults::text("agent_scan.re_iso_datetime")),
        iso_d: crate::checks::lit_re(defaults::text("agent_scan.re_iso_date")),
        surrogate: crate::checks::lit_re(defaults::text("agent_scan.re_surrogate_escape")),
    })
}

// ---- JavaScript value helpers ------------------------------------------------------------------------------

fn prop<'a>(v: &'a Value, k: &str) -> Option<&'a Value> {
    v.as_object()?.get(k)
}

fn sprop<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    prop(v, k)?.as_str()
}

/// JavaScript truthiness of a property value (`undefined`, `null`, `false`, `0`, `""` are falsy).
fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// `String(v)` for the values a transcript field can hold.
fn js_to_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().map(|x| if x.is_null() { String::new() } else { js_to_string(x) }).collect::<Vec<_>>().join(","),
        Value::Object(_) => defaults::text("agent_scan.object_string").to_string(),
        other => crate::checks::guardkit::text::js_string_of(other).unwrap_or_default(),
    }
}

fn is_terminal_status(s: &str) -> bool {
    defaults::words("transcript.terminal_statuses").iter().any(|w| w.eq_ignore_ascii_case(s))
}

fn in_list(key: &str, name: &str) -> bool {
    defaults::list(key).contains(&name)
}

/// `JSON.parse`, with the two outcomes a caller needs: not JSON (JavaScript throws too), or JSON that only JavaScript
/// reads (a lone surrogate escape, nesting past serde's limit, a number past f64 range). Text that holds a surrogate escape
/// and that serde rejects is never called garbage: JavaScript may read it.
pub fn parse_json(s: &str) -> Res<Option<Value>> {
    match serde_json::from_str::<Value>(s) {
        Ok(v) => Ok(Some(v)),
        Err(e) => {
            let m = e.to_string();
            if defaults::list("agent_scan.json_unsupported").iter().any(|k| m.contains(k)) || pats().surrogate.is_match(s) {
                Err(Unsupported)
            } else {
                Ok(None)
            }
        }
    }
}

/// `Date.parse` for the timestamp forms a transcript carries; NaN for text with no digit at all (V8 reads none of
/// those); anything else V8's legacy parser might read is [`Unsupported`].
pub fn date_parse(s: &str) -> Res<f64> {
    let p = pats();
    if let Some(c) = p.iso_dt.captures(s) {
        let n = |i: usize| c.get(i).map_or(0, |m| m.as_str().parse::<i64>().unwrap_or(0));
        let (y, mo, d, h, mi) = (n(1), n(2), n(3), n(4), n(5));
        let sec = n(6);
        let ms = c.get(7).map_or(0, |m| {
            let mut f: String = m.as_str().chars().take(3).collect();
            while f.len() < 3 {
                f.push('0');
            }
            f.parse::<i64>().unwrap_or(0)
        });
        let off = match c.get(8).map(|m| m.as_str()) {
            Some(z) if z.len() == 6 => {
                let sign = if z.starts_with('-') { -1 } else { 1 };
                let (oh, om) = (z[1..3].parse::<i64>().unwrap_or(99), z[4..6].parse::<i64>().unwrap_or(99));
                if oh > 23 || om > 59 {
                    return Err(Unsupported);
                }
                sign * (oh * 60 + om) * 60_000
            }
            _ => 0,
        };
        if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || sec > 59 {
            return Err(Unsupported);
        }
        let days = days_from_civil(y, mo, d);
        return Ok(((days * 86_400 + h * 3600 + mi * 60 + sec) * 1000 + ms - off) as f64);
    }
    if let Some(c) = p.iso_d.captures(s) {
        let n = |i: usize| c.get(i).map_or(0, |m| m.as_str().parse::<i64>().unwrap_or(0));
        let (y, mo, d) = (n(1), n(2), n(3));
        if !(1..=12).contains(&mo) || !(1..=31).contains(&d) {
            return Err(Unsupported);
        }
        return Ok((days_from_civil(y, mo, d) * 86_400_000) as f64);
    }
    if s.bytes().any(|b| b.is_ascii_digit()) { Err(Unsupported) } else { Ok(f64::NAN) }
}

/// Days from 1970-01-01 to the given civil date (day may run past the month, as V8's `MakeDay` lets it).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// `extractTexts(node)`: every string leaf under a message `content` value.
pub fn extract_texts(node: &Value, out: &mut Vec<String>) {
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

/// `notificationTexts(entry)` of `companion/lib/devswarm-idle.js`: the texts of this entry that hold a completion notice.
fn notification_texts(e: &Value) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let content = prop(e, "message").and_then(|m| prop(m, "content"));
    match sprop(e, "type") {
        Some("user") => match content {
            Some(Value::String(s)) => out.push(s.clone()),
            Some(Value::Array(a)) => {
                for b in a {
                    if sprop(b, "type") == Some("text")
                        && let Some(t) = sprop(b, "text")
                    {
                        out.push(t.to_string());
                    }
                }
            }
            _ => {}
        },
        Some("attachment") => {
            if let Some(p) = prop(e, "attachment").and_then(|a| sprop(a, "prompt")) {
                out.push(p.to_string());
            }
        }
        Some("queue-operation") => {
            if let Some(c) = sprop(e, "content") {
                out.push(c.to_string());
            }
        }
        _ => {}
    }
    let tag = defaults::text("agent_scan.notification_tag");
    out.retain(|t| trim_start(t).starts_with(tag) || pats().notif_reminder.is_match(t));
    out
}

// ---- reading the tail --------------------------------------------------------------------------------------

/// The home directory a Node hook's `os.homedir()` gives: `HOME`, or `None` when it is unset, empty or not an absolute path (the
/// hook would ask the password database, or resolve it against its own directory; the engine does neither).
pub fn home_dir(env: &crate::reqenv::RequestEnv) -> Option<String> {
    env.get(defaults::env_name("home")).filter(|h| h.starts_with('/')).map(str::to_string)
}

/// `new Date(ms).toISOString()` for a finite time in range.
pub fn iso_utc(ms: f64) -> String {
    let t = ms.floor() as i64;
    let (days, rem) = (t.div_euclid(86_400_000), t.rem_euclid(86_400_000));
    let (z, doe_era) = (days + 719_468, (days + 719_468).div_euclid(146_097));
    let doe = z - doe_era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + doe_era * 400 + i64::from(m <= 2);
    let (h, mi, sec, milli) = (rem / 3_600_000, rem / 60_000 % 60, rem / 1000 % 60, rem % 1000);
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{sec:02}.{milli:03}Z")
}

/// `toISOString().slice(11, 16) + ' UTC'`.
pub fn hhmm(ms: f64) -> String {
    format!("{}{}", &iso_utc(ms)[11..16], defaults::text("agent_scan.utc_suffix"))
}

/// A string's length in UTF-16 units (`.length`).
pub fn utf16_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// A line reader over the last `max` bytes of a file: `readTail`'s window, produced lazily.
struct Tail {
    r: std::io::BufReader<std::io::Take<std::fs::File>>,
    drop_first: bool,
}

impl Tail {
    /// `None` for a missing, unreadable or empty file (`readTail` returns null).
    fn open(path: &str, max: u64) -> Option<Tail> {
        if path.is_empty() {
            return None;
        }
        let mut f = std::fs::File::open(path).ok()?;
        let size = f.metadata().ok()?.len();
        if size == 0 {
            return None;
        }
        let n = size.min(max);
        f.seek(SeekFrom::Start(size - n)).ok()?;
        crate::load::note_scan(n);
        Some(Tail { r: std::io::BufReader::with_capacity(defaults::num("agent_scan.reader_buf_bytes") as usize, f.take(n)), drop_first: size > n })
    }

    /// The next line without its newline; `Ok(false)` at the end; `Err` when the read fails (`readTail` then returns null).
    fn read_line(&mut self, buf: &mut Vec<u8>) -> Result<bool, std::io::Error> {
        buf.clear();
        match self.r.read_until(b'\n', buf) {
            Ok(0) => Ok(false),
            Ok(_) => {
                if buf.last() == Some(&b'\n') {
                    buf.pop();
                }
                Ok(true)
            }
            Err(e) => Err(e),
        }
    }
}

/// `fs.statSync(p).mtimeMs`: Node computes `sec * 1000 + nsec / 1e6` in doubles, and so does this (the rounding is part
/// of the value other state, such as a nudge snapshot, is keyed by).
pub fn mtime_ms(p: &std::path::Path) -> Option<f64> {
    use std::os::unix::fs::MetadataExt;
    let m = std::fs::metadata(p).ok()?;
    Some(m.mtime() as f64 * 1000.0 + m.mtime_nsec() as f64 / 1e6)
}

/// `path.basename(p, '.jsonl')`.
pub fn base_without_jsonl(path: &str) -> String {
    let b = path.trim_end_matches('/').rsplit('/').next().unwrap_or("");
    let ext = defaults::text("agent_scan.transcript_ext");
    if b.len() > ext.len() && b.ends_with(ext) { b[..b.len() - ext.len()].to_string() } else { b.to_string() }
}

/// `path.dirname(p)` for a transcript path.
pub fn dir_of(path: &str) -> String {
    let t = path.trim_end_matches('/');
    match t.rfind('/') {
        Some(0) => "/".to_string(),
        Some(i) => t[..i].to_string(),
        None => ".".to_string(),
    }
}

/// `teammateSidechainMtimeMs`: the newest mtime of the teammate's sidechain transcript; NaN when absent.
fn teammate_sidechain_mtime(path: &str, name: &str) -> f64 {
    let dir = format!("{}/{}/{}", dir_of(path), base_without_jsonl(path), defaults::text("agent_scan.subagents_dir"));
    let pre = format!("{}{name}-", defaults::text("agent_scan.sidechain_prefix"));
    let ext = defaults::text("agent_scan.transcript_ext");
    let mut best = f64::NAN;
    let Ok(rd) = std::fs::read_dir(&dir) else { return best };
    for e in rd.flatten() {
        let f = e.file_name().to_string_lossy().to_string();
        let Some(rest) = f.strip_prefix(&pre) else { continue };
        let Some(hex) = rest.strip_suffix(ext) else { continue };
        if hex.is_empty() || !hex.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
            continue;
        }
        if let Some(m) = mtime_ms(&e.path())
            && (best.is_nan() || m > best)
        {
            best = m;
        }
    }
    best
}

// ---- the prefilter -------------------------------------------------------------------------------------------

/// Which of the prefilter substrings (`agent_scan.prefilter`) a line holds. A line with none of them changes nothing in the walk.
#[derive(Clone, Copy)]
struct Flags {
    launch: bool,
    notif: bool,
    agent_tu: bool,
    tool_result: bool,
    taskstop: bool,
    task_status: bool,
    tool_use: bool,
    idle: bool,
}

impl Flags {
    fn any(&self) -> bool {
        self.launch || self.notif || self.agent_tu || self.tool_result || self.taskstop || self.task_status || self.tool_use || self.idle
    }
}

/// The prefilter substrings as SIMD finders, built once per configuration generation. `fast` is true when every needle is ASCII
/// and starts and ends with a non-blank, which makes a search of the raw line bytes give the answer a `str::contains` of the
/// lossily decoded, trimmed line would; otherwise the scan decodes and trims first and searches the string.
struct Prefilter {
    fast: bool,
    keys: [&'static str; 10],
    finders: Vec<memchr::memmem::Finder<'static>>,
}

fn prefilter() -> &'static Prefilter {
    static P: crate::defaults::Cache<Prefilter> = crate::defaults::Cache::new();
    P.get_or_init(|| {
        let k = defaults::raw("agent_scan.prefilter");
        let keys: [&'static str; 10] = [
            k.str_field("launch"),
            k.str_field("notification"),
            k.str_field("agent_use"),
            k.str_field("agent_use_spaced"),
            k.str_field("tool_result"),
            k.str_field("taskstop"),
            k.str_field("taskstop_spaced"),
            k.str_field("task_status"),
            k.str_field("tool_use"),
            k.str_field("idle"),
        ];
        let blank = |b: u8| b.is_ascii_whitespace() || b == 0x0b;
        let fast = keys.iter().all(|n| n.is_ascii() && n.as_bytes().first().is_some_and(|b| !blank(*b)) && n.as_bytes().last().is_some_and(|b| !blank(*b)));
        Prefilter { fast, keys, finders: keys.iter().map(|n| memchr::memmem::Finder::new(n.as_bytes())).collect() }
    })
}

impl Prefilter {
    fn flags_with(&self, has: impl Fn(usize) -> bool) -> Flags {
        Flags {
            launch: has(0),
            notif: has(1),
            agent_tu: has(2) || has(3),
            tool_result: has(4),
            taskstop: has(5) || has(6),
            task_status: has(7),
            tool_use: has(8),
            idle: has(9),
        }
    }

    /// The flags of a raw line (only valid when `fast`).
    fn flags_bytes(&self, line: &[u8]) -> Flags {
        self.flags_with(|i| self.finders[i].find(line).is_some())
    }

    /// The flags of a decoded, trimmed line.
    fn flags_str(&self, line: &str) -> Flags {
        self.flags_with(|i| line.contains(self.keys[i]))
    }
}

// ---- the walk ----------------------------------------------------------------------------------------------

#[derive(Clone)]
struct ToolUse {
    name: Option<String>,
    input: Option<Value>,
}

#[derive(Clone)]
struct Stop {
    id: String,
    seq: u64,
    tool_use_id: Option<String>,
    ts: f64,
}

#[derive(Clone)]
struct TeamEv {
    kind: &'static str,
    ts: f64,
    seq: u64,
}

#[derive(Clone)]
struct TeamInfo {
    tool_use_id: Option<String>,
    agent_id: String,
}

#[derive(Clone)]
struct Other {
    tool_use_id: Option<String>,
    text: String,
    seq: u64,
    ts: f64,
}

#[derive(Clone)]
struct Walk {
    launched: OMap<Rec>,
    terminal: HashSet<String>,
    desc_by_tool_use: HashMap<String, String>,
    others: Vec<Other>,
    other_bytes: u64,
    dropped_ids: HashSet<String>,
    tool_uses: HashMap<String, ToolUse>,
    stops: Vec<Stop>,
    errored: HashSet<String>,
    answered: HashSet<String>,
    team_events: OMap<Vec<TeamEv>>,
    team_info: OMap<TeamInfo>,
    terminal_ev: HashMap<String, Vec<(u64, f64)>>,
    resume_seq: OMap<u64>,
    resume_full: HashSet<String>,
    resume_ts: HashMap<String, f64>,
}

impl Walk {
    fn new() -> Walk {
        Walk {
            launched: OMap::default(),
            terminal: HashSet::new(),
            desc_by_tool_use: HashMap::new(),
            others: Vec::new(),
            other_bytes: 0,
            dropped_ids: HashSet::new(),
            tool_uses: HashMap::new(),
            stops: Vec::new(),
            errored: HashSet::new(),
            answered: HashSet::new(),
            team_events: OMap::default(),
            team_info: OMap::default(),
            terminal_ev: HashMap::new(),
            resume_seq: OMap::default(),
            resume_full: HashSet::new(),
            resume_ts: HashMap::new(),
        }
    }

    fn mark_terminal(&mut self, id: &str, seq: u64, ts: f64) {
        self.terminal.insert(id.to_string());
        self.terminal_ev.entry(id.to_string()).or_default().push((seq, ts));
    }

    fn team_event(&mut self, name: &str, kind: &'static str, ts: f64, seq: u64) {
        if !self.team_events.has(name) {
            self.team_events.set(name, Vec::new());
        }
        if let Some(v) = self.team_events.get_mut(name) {
            v.push(TeamEv { kind, ts, seq });
        }
    }

    /// `answersCall(toolUseId, names)`: true when the call is unseen or one of `names`.
    fn answers(&self, tool_use_id: Option<&str>, list: &str) -> bool {
        match tool_use_id.and_then(|id| self.tool_uses.get(id)) {
            None => true,
            Some(c) => c.name.as_deref().is_some_and(|n| in_list(list, n)),
        }
    }

    fn register_tool_use(&mut self, id: &str, name: Option<&str>, input: Option<&Value>) -> Res<()> {
        let keep = name.is_some_and(|n| in_list("agent_scan.delivery_tools", n) || in_list("agent_scan.launch_tools", n));
        if let Some(prev) = self.tool_uses.get(id)
            && prev.name.as_deref() != name
            && self.dropped_ids.contains(id)
        {
            return Err(Unsupported);
        }
        self.tool_uses.insert(id.to_string(), ToolUse { name: name.map(str::to_string), input: if keep { input.cloned() } else { None } });
        Ok(())
    }

    /// One trimmed, non-empty transcript line (flags found the slow way, with `str::contains`).
    fn line(&mut self, seq: u64, line: &str) -> Res<()> {
        let fl = prefilter().flags_str(line);
        self.line_flagged(seq, line, fl)
    }

    /// One trimmed, non-empty transcript line whose prefilter flags are already known.
    fn line_flagged(&mut self, seq: u64, line: &str, fl: Flags) -> Res<()> {
        let Flags { launch: has_launch, notif: has_notif, agent_tu: has_agent_tu, taskstop: has_taskstop, tool_use: has_tool_use, idle: has_idle, .. } = fl;
        if !fl.any() {
            return Ok(());
        }
        let Some(entry) = parse_json(line)? else { return Ok(()) };
        if !entry.is_object() {
            return Ok(());
        }
        let entry_ts = match sprop(&entry, "timestamp") {
            Some(t) => date_parse(t)?,
            None => f64::NAN,
        };

        // (a0) compaction re-injects each live background agent as a `task_status` attachment.
        if let Some(att) = prop(&entry, "attachment")
            && sprop(att, "type") == Some("task_status")
            && let Some(task_id) = sprop(att, "taskId")
            && !task_id.is_empty()
        {
            let status = prop(att, "status");
            if status.and_then(Value::as_str) == Some("running") {
                if !self.launched.has(task_id) {
                    let t = match sprop(&entry, "timestamp") {
                        Some(ts) => date_parse(ts)?,
                        None => match sprop(att, "timestamp") {
                            Some(ts) => date_parse(ts)?,
                            None => f64::NAN,
                        },
                    };
                    self.launched.set(
                        task_id,
                        Rec {
                            adopted: true,
                            output_file: sprop(att, "outputFilePath").unwrap_or("").to_string(),
                            description: sprop(att, "description").unwrap_or("").to_string(),
                            launched_at_ms: t,
                            tool_use_id: None,
                            resumed_at_ms: None,
                            teammate: false,
                            last_seen_ms: f64::NAN,
                            pending_message: false,
                            task_type: sprop(att, "taskType").unwrap_or("").to_string(),
                            spawn_input: None,
                        },
                    );
                }
            } else if is_terminal_status(&status.map_or_else(|| defaults::text("agent_scan.undefined_string").to_string(), js_to_string)) {
                self.mark_terminal(task_id, seq, entry_ts);
            }
        }

        let content = prop(&entry, "message").and_then(|m| prop(m, "content"));
        let etype = sprop(&entry, "type");

        if has_tool_use
            && etype == Some("assistant")
            && let Some(Value::Array(blocks)) = content
        {
            for b in blocks {
                if sprop(b, "type") == Some("tool_use")
                    && let Some(id) = sprop(b, "id")
                {
                    self.register_tool_use(id, sprop(b, "name"), prop(b, "input"))?;
                }
            }
        }

        // (a) an Agent call's description, keyed by tool_use id.
        if has_agent_tu
            && etype == Some("assistant")
            && let Some(Value::Array(blocks)) = content
        {
            for b in blocks {
                if sprop(b, "type") == Some("tool_use")
                    && sprop(b, "name") == Some(defaults::text("agent_scan.agent_tool"))
                    && let Some(id) = sprop(b, "id")
                {
                    let desc = prop(b, "input").and_then(|i| sprop(i, "description")).unwrap_or("");
                    if !desc.is_empty() {
                        self.desc_by_tool_use.insert(id.to_string(), desc.to_string());
                    }
                }
            }
        }

        // (a2) a TaskStop call: the coordinator stopped that agent.
        if has_taskstop
            && etype == Some("assistant")
            && let Some(Value::Array(blocks)) = content
        {
            for b in blocks {
                if sprop(b, "type") == Some("tool_use")
                    && sprop(b, "name") == Some(defaults::text("agent_scan.stop_tool"))
                    && let Some(inp) = prop(b, "input")
                    && let Some(tid) = sprop(inp, "task_id")
                    && !tid.is_empty()
                {
                    self.stops.push(Stop { id: tid.to_string(), seq, tool_use_id: sprop(b, "id").map(str::to_string), ts: entry_ts });
                }
            }
        }

        // (b) a terminal notification, in any of its three shapes.
        if has_notif {
            for text in notification_texts(&entry) {
                for bm in pats().block.captures_iter(&text) {
                    let body = bm.get(1).map_or("", |m| m.as_str());
                    let tid = pats().task_id.captures(body).and_then(|c| c.get(1).map(|m| m.as_str().to_string()));
                    let st = pats().status.captures(body).and_then(|c| c.get(1).map(|m| m.as_str().to_string()));
                    if let (Some(t), Some(s)) = (tid, st)
                        && !t.is_empty()
                        && is_terminal_status(&s)
                    {
                        self.mark_terminal(&t, seq, entry_ts);
                    }
                }
            }
        }

        if has_idle {
            for i in self.teammate_idles(&entry, entry_ts)? {
                self.team_event(&i.0, "idle", i.1, seq);
            }
        }

        if etype != Some("user") {
            return Ok(());
        }

        // Teammate spawn: a structured field of the Agent/Task tool_result entry.
        if let Some(tur) = prop(&entry, "toolUseResult")
            && sprop(tur, "status") == Some("teammate_spawned")
            && let Some(name) = sprop(tur, "name")
            && !name.is_empty()
            && let Some(Value::Array(blocks)) = content
            && let Some(tr) = blocks.iter().find(|b| truthy(Some(b)) && sprop(b, "type") == Some("tool_result"))
        {
            let tuid = sprop(tr, "tool_use_id");
            if self.answers(tuid, "agent_scan.launch_tools") {
                self.team_event(name, "spawn", entry_ts, seq);
                self.team_info.set(name, TeamInfo { tool_use_id: tuid.map(str::to_string), agent_id: sprop(tur, "agent_id").unwrap_or("").to_string() });
            }
        }

        // Walk each content block (or the single string/object content itself).
        let synthetic;
        let blocks: Vec<&Value> = match content {
            Some(Value::Array(a)) => a.iter().collect(),
            other => {
                synthetic = match other {
                    Some(c) => serde_json::json!({ "content": c }),
                    None => Value::Object(Default::default()),
                };
                vec![&synthetic]
            }
        };
        for block in blocks {
            if !truthy(Some(block)) {
                continue;
            }
            let tuid = sprop(block, "tool_use_id");
            let block_content = prop(block, "content").unwrap_or(block);
            let is_tool_result = sprop(block, "type") == Some("tool_result");
            if is_tool_result
                && prop(block, "is_error") == Some(&Value::Bool(true))
                && let Some(id) = tuid
            {
                self.errored.insert(id.to_string());
            }
            if is_tool_result && let Some(id) = tuid {
                self.answered.insert(id.to_string());
            }
            let mut texts = Vec::new();
            extract_texts(block_content, &mut texts);
            for text in texts {
                if is_tool_result
                    && has_launch
                    && self.answers(tuid, "agent_scan.launch_tools")
                    && trim_start(&text).starts_with(defaults::text("agent_scan.launch_text"))
                {
                    let idm = pats().agent_id.captures(&text).and_then(|c| c.get(1).map(|m| m.as_str().to_string()));
                    let sid = prop(&entry, "toolUseResult").and_then(|t| sprop(t, "agentId")).filter(|s| pats().hex_id.is_match(s)).map(str::to_string);
                    if let Some(id) = sid.or(idm) {
                        let of = pats().output_file.captures(&text).and_then(|c| c.get(1).map(|m| m.as_str().to_string())).unwrap_or_default();
                        self.launched.set(
                            &id,
                            Rec {
                                adopted: false,
                                output_file: of,
                                description: String::new(),
                                launched_at_ms: entry_ts,
                                tool_use_id: tuid.map(str::to_string),
                                resumed_at_ms: None,
                                teammate: false,
                                last_seen_ms: f64::NAN,
                                pending_message: false,
                                task_type: String::new(),
                                spawn_input: None,
                            },
                        );
                    }
                }
                let resume = if is_tool_result && self.answers(tuid, "agent_scan.resume_tools") { parse_resume(&text)? } else { None };
                if let Some((rid, full)) = resume {
                    if full {
                        self.resume_full.insert(rid.clone());
                    }
                    self.resume_seq.set(&rid, seq);
                    if entry_ts.is_finite() {
                        self.resume_ts.insert(rid, entry_ts);
                    } else {
                        self.resume_ts.remove(&rid);
                    }
                    continue;
                }
                if is_queued_result(&text)? {
                    continue;
                }
                let inbox = if is_tool_result && self.answers(tuid, "agent_scan.send_tools") { parse_inbox_send(&text)? } else { None };
                if let Some(name) = inbox {
                    self.team_event(&name, "send", entry_ts, seq);
                    continue;
                }
                if is_tool_result {
                    // Only the answer to a delivery call (or to a call not seen) can ever be delivery evidence.
                    let call = tuid.and_then(|id| self.tool_uses.get(id));
                    if let Some(c) = call
                        && !c.name.as_deref().is_some_and(|n| in_list("agent_scan.delivery_tools", n))
                    {
                        if let Some(id) = tuid {
                            self.dropped_ids.insert(id.to_string());
                        }
                        continue;
                    }
                    self.other_bytes += text.len() as u64;
                    if self.other_bytes > defaults::num("agent_scan.retain_bytes") {
                        return Err(Unsupported);
                    }
                    self.others.push(Other { tool_use_id: tuid.map(str::to_string), text, seq, ts: entry_ts });
                }
            }
        }
        Ok(())
    }

    /// `teammateIdles(entry, entryTs, spawned)`: `(name, ts, reason)` of each genuine teammate report in this entry.
    fn teammate_idles(&self, entry: &Value, entry_ts: f64) -> Res<Vec<(String, f64)>> {
        let mut out = Vec::new();
        if sprop(entry, "type") != Some("user") {
            return Ok(out);
        }
        let Some(c) = prop(entry, "message").and_then(|m| prop(m, "content")).and_then(Value::as_str) else { return Ok(out) };
        let prefix = defaults::text("agent_scan.teammate_report_prefix");
        if !c.starts_with(prefix) {
            return Ok(out);
        }
        for k in defaults::list("agent_scan.not_a_report_keys") {
            let v = prop(entry, k);
            if k == defaults::text("agent_scan.sidechain_key") {
                if v == Some(&Value::Bool(true)) {
                    return Ok(out);
                }
            } else if v.is_some() {
                return Ok(out);
            }
        }
        let skew = defaults::num("agent_scan.report_future_skew_ms") as f64;
        let mut at = prefix.len();
        at += c[at..].len() - trim_start(&c[at..]).len();
        while let Some(m) = pats().teammate_block.captures(&c[at..]) {
            let (id, body) = (m.get(1).map_or("", |x| x.as_str()), m.get(2).map_or("", |x| x.as_str()));
            at += m.get(0).map_or(0, |x| x.end());
            at += c[at..].len() - trim_start(&c[at..]).len();
            if !self.team_info.has(id) || body.contains('\n') || !body.starts_with('{') {
                continue;
            }
            let Some(o) = parse_json(body)? else { continue };
            if sprop(&o, "type") != Some("idle_notification") || sprop(&o, "from") != Some(id) {
                continue;
            }
            let inner = match sprop(&o, "timestamp") {
                Some(t) => date_parse(t)?,
                None => f64::NAN,
            };
            if inner.is_finite() && entry_ts.is_finite() && inner > entry_ts + skew {
                continue;
            }
            let ts = if inner.is_finite() && entry_ts.is_finite() { inner } else { entry_ts };
            out.push((id.to_string(), ts));
        }
        Ok(out)
    }
}

/// `parseResumeResult(text)` -> `(id, full)`.
fn parse_resume(text: &str) -> Res<Option<(String, bool)>> {
    let t = js_trim(text);
    if !t.starts_with('{') {
        return Ok(pats().resume_message.captures(t).map(|c| (c[1].to_string(), false)));
    }
    if !t.contains(defaults::text("agent_scan.resuming_word")) && !t.contains(defaults::text("agent_scan.resumed_key")) {
        return Ok(None);
    }
    let Some(o) = parse_json(t)? else { return Ok(None) };
    if prop(&o, "success") != Some(&Value::Bool(true)) {
        return Ok(None);
    }
    let full = sprop(&o, defaults::text("agent_scan.resumed_key")).filter(|s| pats().hex_id.is_match(s));
    let pm = sprop(&o, "message").and_then(|m| pats().resume_message.captures(m).map(|c| c[1].to_string()));
    Ok(match (full, pm) {
        (Some(f), _) => Some((f.to_string(), true)),
        (None, Some(p)) => Some((p, false)),
        _ => None,
    })
}

/// `isQueuedMessageResult(text)`.
fn is_queued_result(text: &str) -> Res<bool> {
    if !text.contains(defaults::text("agent_scan.queued_phrase")) {
        return Ok(false);
    }
    let Some(o) = parse_json(text)? else { return Ok(false) };
    Ok(sprop(&o, "message").is_some_and(|m| pats().queued.is_match(m)))
}

/// `parseInboxSendResult(text)`: the teammate name.
fn parse_inbox_send(text: &str) -> Res<Option<String>> {
    if !text.contains(defaults::text("agent_scan.inbox_phrase")) {
        return Ok(None);
    }
    let t = js_trim(text);
    if !t.starts_with('{') {
        return Ok(None);
    }
    let Some(o) = parse_json(t)? else { return Ok(None) };
    if prop(&o, "success") != Some(&Value::Bool(true)) {
        return Ok(None);
    }
    Ok(sprop(&o, "message").and_then(|m| pats().inbox.captures(m).map(|c| c[1].to_string())))
}

/// `namesAgent(input, id, launched)`: does a tool_use input name this agent, by full id or a unique hex prefix?
fn names_agent(input: Option<&Value>, id: &str, launched: &OMap<Rec>) -> Res<bool> {
    let falsy = !truthy(input);
    let v = if falsy { None } else { input };
    if let Some(v) = v
        && unsafe_number(v)
    {
        return Err(Unsupported);
    }
    let s = match v {
        Some(v) => serde_json::to_string(v).unwrap_or_default(),
        None => defaults::text("agent_scan.empty_object").to_string(),
    };
    if s.contains(id) {
        return Ok(true);
    }
    for m in pats().hex_run.find_iter(&s) {
        if !id.starts_with(m.as_str()) {
            continue;
        }
        if launched.keys().filter(|k| k.starts_with(m.as_str())).count() == 1 {
            return Ok(true);
        }
    }
    Ok(false)
}

/// A number whose JavaScript text may differ from serde's (a float, or an integer past 2^53).
fn unsafe_number(v: &Value) -> bool {
    match v {
        Value::Number(n) => {
            !(n.as_i64().is_some_and(|i| i.unsigned_abs() <= defaults::num("agent_scan.safe_int"))
                || n.as_u64().is_some_and(|u| u <= defaults::num("agent_scan.safe_int")))
        }
        Value::Array(a) => a.iter().any(unsafe_number),
        Value::Object(o) => o.values().any(unsafe_number),
        _ => false,
    }
}

/// Feed one raw transcript line (no newline) to the walk; `seq` is the number of lines the walk has been given before it.
fn feed(w: &mut Walk, seq: &mut u64, raw: &[u8]) -> Res<()> {
    *seq += 1;
    let pre = prefilter();
    if pre.fast {
        let fl = pre.flags_bytes(raw);
        if !fl.any() {
            return Ok(());
        }
        let s = String::from_utf8_lossy(raw);
        let line = js_trim(&s);
        if line.is_empty() {
            return Ok(());
        }
        return w.line_flagged(*seq, line, fl);
    }
    let s = String::from_utf8_lossy(raw);
    let line = js_trim(&s);
    if line.is_empty() {
        return Ok(());
    }
    w.line(*seq, line)
}

/// What the scan of one transcript keeps between calls: the walk over every complete line up to `off`, while the whole file is
/// inside the scan window (so the window is the file, however much it grows, and appended lines only extend it).
#[derive(Clone)]
struct Kept {
    gen_: u64,
    dev: u64,
    ino: u64,
    off: u64,
    seq: u64,
    head: u64,
    back: u64,
    walk: Walk,
}

#[derive(Clone, Hash, PartialEq, Eq)]
struct ScanKey {
    path: String,
    gen_: u64,
    dev: u64,
    ino: u64,
    size: u64,
    mtime_sec: i64,
    mtime_nsec: i64,
    tail: u64,
    ignore_unanswered_stops: bool,
}

type WalkCache = BoundedCache<String, Kept>;
type ResultCache = BoundedCache<ScanKey, Scan>;

fn walk_cache() -> &'static WalkCache {
    static CACHE: OnceLock<WalkCache> = OnceLock::new();
    CACHE.get_or_init(|| {
        BoundedCache::new(
            crate::mem::global(),
            Spec::new("agent_scan_walk", "mem.agent_scan_walk_soft_bytes", "mem.agent_scan_walk_hard_bytes", "mem.agent_scan_walk_low_water_pct")
                .with_entries("agent_scan.cache_max_paths"),
        )
    })
}

fn result_cache() -> &'static ResultCache {
    static CACHE: OnceLock<ResultCache> = OnceLock::new();
    CACHE.get_or_init(|| {
        BoundedCache::new(
            crate::mem::global(),
            Spec::new("agent_scan_result", "mem.agent_scan_result_soft_bytes", "mem.agent_scan_result_hard_bytes", "mem.agent_scan_result_low_water_pct")
                .with_entries("agent_scan.cache_max_paths"),
        )
    })
}

/// (transcripts kept, their estimated bytes by the cache's own estimate, transcript bytes they have read) for the memory snapshot.
pub fn kept_usage() -> (usize, u64, u64) {
    let c = walk_cache();
    let vals = c.values();
    (c.len(), c.bytes() as u64, vals.iter().map(|k| k.off).sum())
}

/// A cheap digest of `len` bytes of the file at `at` (None when they cannot be read).
fn digest_at(f: &std::fs::File, at: u64, len: u64) -> Option<u64> {
    use std::hash::Hasher;
    let mut b = vec![0u8; len as usize];
    f.read_exact_at(&mut b, at).ok()?;
    let mut h = std::collections::hash_map::DefaultHasher::new();
    h.write(&b);
    Some(h.finish())
}

/// A rough size of what a walk holds, for the cache cap.
fn walk_bytes(w: &Walk) -> u64 {
    let per = defaults::num("agent_scan.cache_entry_bytes");
    w.other_bytes
        + per * (w.tool_uses.len() + w.answered.len() + w.errored.len() + w.launched.keys().count() + w.terminal.len() + w.stops.len() + w.others.len()) as u64
}

/// `scanTranscript(transcriptPath, readTail(path, tail), opts)`. `Ok(None)` is JavaScript's `null` (unreadable).
///
/// A transcript that fits the window is walked once: the walk over its complete lines is kept (per path, bounded by
/// `agent_scan.cache_*`) and the next call reads only the bytes appended since, then finishes a copy of the kept walk. The
/// kept walk is the very state a fresh scan of the whole file reaches, so the answer is identical; a file that is longer than
/// the window slides its window with every append and is scanned afresh.
pub fn scan_transcript(path: &str, tail: u64, opts: &Opts) -> Res<Option<Scan>> {
    if !path.is_empty() && !path.starts_with('/') {
        // A relative path means the hook's own working directory, which the engine does not share.
        return Err(Unsupported);
    }
    if !path.is_empty()
        && defaults::num("agent_scan.cache_max_paths") > 0
        && let Ok(f) = std::fs::File::open(path)
        && let Ok(m) = f.metadata()
        && m.len() > 0
    {
        if m.len() <= tail {
            return scan_kept(path, f, &m, opts);
        }
        return scan_cached_window(path, &m, tail, opts);
    }
    scan_window(path, tail, opts)
}

/// [`scan_transcript`] without the kept walk: the scan of the last `tail` bytes, read afresh. The reference the kept walk is tested against.
pub fn scan_transcript_uncached(path: &str, tail: u64, opts: &Opts) -> Res<Option<Scan>> {
    if !path.is_empty() && !path.starts_with('/') {
        return Err(Unsupported);
    }
    scan_window(path, tail, opts)
}

fn scan_key(path: &str, m: &std::fs::Metadata, tail: u64, opts: &Opts) -> ScanKey {
    ScanKey {
        path: path.to_string(),
        gen_: defaults::generation(),
        dev: m.dev(),
        ino: m.ino(),
        size: m.len(),
        mtime_sec: m.mtime(),
        mtime_nsec: m.mtime_nsec(),
        tail,
        ignore_unanswered_stops: opts.ignore_unanswered_stops,
    }
}

fn scan_weight(scan: &Scan) -> usize {
    let per = defaults::num("agent_scan.cache_entry_bytes") as usize;
    per.saturating_mul(scan.launched.keys().count() + scan.terminal.len() + scan.pending.len()).max(per)
}

fn scan_cached_window(path: &str, m: &std::fs::Metadata, tail: u64, opts: &Opts) -> Res<Option<Scan>> {
    let key = scan_key(path, m, tail, opts);
    if let Some(scan) = result_cache().get_at(&key, now_ms() as u64) {
        return Ok(Some(scan));
    }
    let scan = scan_window(path, tail, opts)?;
    if let Some(scan) = &scan
        && scan.pending.is_empty()
    {
        let ttl = defaults::num("agent_scan.cache_idle_ms");
        let now = now_ms() as u64;
        let exp = (ttl > 0).then(|| now.saturating_add(ttl));
        result_cache().insert_with_ttl(key, scan.clone(), scan_weight(scan), exp);
    }
    Ok(scan)
}

/// The scan of the last `tail` bytes, read afresh.
fn scan_window(path: &str, tail: u64, opts: &Opts) -> Res<Option<Scan>> {
    let Some(mut t) = Tail::open(path, tail) else { return Ok(None) };
    let mut w = Walk::new();
    let mut buf: Vec<u8> = Vec::new();
    let mut seq: u64 = 0;
    let mut first = t.drop_first;
    loop {
        // a script call cut at its request's deadline stops here; the host turns the cut into the call's failure
        if seq.is_multiple_of(defaults::num("agent_scan.cut_check_lines").max(1)) && crate::deadline::cut_due() {
            return Ok(None);
        }
        match t.read_line(&mut buf) {
            Ok(true) => {}
            Ok(false) => break,
            // `readTail` reads the whole window first and returns null when any read fails.
            Err(_) => return Ok(None),
        }
        if first {
            first = false;
            continue;
        }
        feed(&mut w, &mut seq, &buf)?;
    }
    finish(w, path, opts).map(Some)
}

/// The scan of a whole file that fits the window, resuming from the walk kept by the last scan when it is still valid.
fn scan_kept(path: &str, f: std::fs::File, m: &std::fs::Metadata, opts: &Opts) -> Res<Option<Scan>> {
    let size = m.len();
    let fp = defaults::num("agent_scan.cache_fingerprint_bytes").max(1);
    let gen_ = defaults::generation();
    let taken = walk_cache().remove(&path.to_string());
    let mut k = match taken {
        Some(k)
            if k.gen_ == gen_
                && k.dev == m.dev()
                && k.ino == m.ino()
                && k.off <= size
                && digest_at(&f, 0, fp.min(k.off)) == Some(k.head)
                && digest_at(&f, k.off - fp.min(k.off), fp.min(k.off)) == Some(k.back) =>
        {
            k
        }
        _ => Kept { gen_, dev: m.dev(), ino: m.ino(), off: 0, seq: 0, head: 0, back: 0, walk: Walk::new() },
    };
    let want = size - k.off;
    crate::load::note_scan(want);
    let mut rd = std::io::BufReader::with_capacity(defaults::num("agent_scan.reader_buf_bytes") as usize, &f);
    if rd.seek(SeekFrom::Start(k.off)).is_err() {
        return Ok(None);
    }
    let mut rd = rd.take(want);
    let mut buf: Vec<u8> = Vec::new();
    let mut partial: Option<Vec<u8>> = None;
    loop {
        if k.seq.is_multiple_of(defaults::num("agent_scan.cut_check_lines").max(1)) && crate::deadline::cut_due() {
            return Ok(None);
        }
        buf.clear();
        let n = match rd.read_until(b'\n', &mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(_) => return Ok(None),
        };
        if buf.last() == Some(&b'\n') {
            buf.pop();
            feed(&mut k.walk, &mut k.seq, &buf)?;
            k.off += n as u64;
        } else {
            // the last line has no newline yet: it counts in this answer, but is walked for good once it is complete
            partial = Some(std::mem::take(&mut buf));
            break;
        }
    }
    let mut w = k.walk.clone();
    if let Some(p) = partial {
        let mut seq = k.seq;
        feed(&mut w, &mut seq, &p)?;
    }
    let scan = finish(w, path, opts).map(Some);
    // keep the walk for the next call, unless it grew past the cap
    if scan.is_ok() && walk_bytes(&k.walk) <= defaults::num("agent_scan.cache_max_bytes") {
        let now = now_ms() as u64;
        if let (Some(head), Some(back)) = (digest_at(&f, 0, fp.min(k.off)), digest_at(&f, k.off - fp.min(k.off), fp.min(k.off))) {
            k.head = head;
            k.back = back;
            let ttl = defaults::num("agent_scan.cache_idle_ms");
            let exp = (ttl > 0).then(|| now.saturating_add(ttl));
            let weight = walk_bytes(&k.walk) as usize;
            walk_cache().insert_with_ttl(path.to_string(), k, weight, exp);
        }
    }
    scan
}

fn finish(mut w: Walk, path: &str, opts: &Opts) -> Res<Scan> {
    // Attach descriptions where the Agent tool_use was in the window.
    let ids: Vec<String> = w.launched.keys().cloned().collect();
    for id in &ids {
        let d = w.launched.get(id).and_then(|r| r.tool_use_id.as_ref()).and_then(|t| w.desc_by_tool_use.get(t)).cloned();
        if let (Some(d), Some(r)) = (d, w.launched.get_mut(id)) {
            r.description = d;
        }
        // `rec.spawnInput`: the input of the launching call when it is in the window (an object or array, as `typeof` says)
        let spawn = w.launched.get(id).and_then(|r| r.tool_use_id.as_ref()).and_then(|t| w.tool_uses.get(t)).and_then(|c| c.input.clone());
        if let (Some(i), Some(r)) = (spawn.filter(|i| i.is_object() || i.is_array()), w.launched.get_mut(id)) {
            r.spawn_input = Some(i);
        }
    }

    // Background-agent ids known from the walk: a teammate name equal to one is a collision.
    let mut background: HashSet<String> = w.launched.keys().cloned().collect();
    background.extend(w.terminal.iter().cloned());

    let stops = std::mem::take(&mut w.stops);
    for s in &stops {
        if s.tool_use_id.as_ref().is_some_and(|t| w.errored.contains(t)) {
            continue;
        }
        if opts.ignore_unanswered_stops && !s.tool_use_id.as_ref().is_some_and(|t| w.answered.contains(t)) {
            continue;
        }
        w.mark_terminal(&s.id, s.seq, s.ts);
        let names: Vec<String> = w.team_info.iter().filter(|(_, i)| i.agent_id == s.id).map(|(n, _)| n.clone()).collect();
        for n in names {
            if !w.team_events.has(&s.id) {
                w.team_event(&n, "stop", s.ts, s.seq);
            }
        }
        if w.team_events.has(&s.id) {
            w.team_event(&s.id, "stop", s.ts, s.seq);
        }
    }

    // SAFETY NET: a later answer to a TaskOutput/SendMessage call that quotes a launched agent's id.
    let launched_ids: Vec<String> = w.launched.keys().cloned().collect();
    for id in &launched_ids {
        if w.terminal.contains(id) {
            continue;
        }
        let own = w.launched.get(id).and_then(|r| r.tool_use_id.clone());
        let mut hit: Option<(u64, f64)> = None;
        for o in &w.others {
            if o.tool_use_id.is_some() && o.tool_use_id == own {
                continue;
            }
            let call = o.tool_use_id.as_ref().and_then(|t| w.tool_uses.get(t));
            if let Some(c) = call {
                let delivery = c.name.as_deref().is_some_and(|n| in_list("agent_scan.delivery_tools", n));
                if !(delivery && names_agent(c.input.as_ref(), id, &w.launched)?) {
                    continue;
                }
            }
            if o.text.split('\n').any(|ln| ln.contains(id.as_str()) && !pats().running_row.is_match(ln)) {
                hit = Some((o.seq, o.ts));
                break;
            }
        }
        if let Some((seq, ts)) = hit {
            w.mark_terminal(id, seq, ts);
        }
    }

    // RESUME RECONCILIATION.
    let mut known: Vec<String> = w.launched.keys().cloned().collect();
    for t in &w.terminal {
        if !known.contains(t) {
            known.push(t.clone());
        }
    }
    let resumes: Vec<(String, u64)> = w.resume_seq.iter().map(|(k, v)| (k.clone(), *v)).collect();
    let slack = defaults::num("agent_scan.resume_skew_slack_ms") as f64;
    for (rid, r_seq) in resumes {
        let mut targets: Vec<String> = known.iter().filter(|k| k.starts_with(rid.as_str())).cloned().collect();
        if !w.resume_full.contains(&rid) && targets.len() != 1 {
            targets.clear();
        }
        if targets.is_empty()
            && w.resume_full.contains(&rid)
            && let Some(ts) = w.resume_ts.get(&rid).copied()
        {
            w.launched.set(
                &rid,
                Rec {
                    adopted: true,
                    output_file: String::new(),
                    description: String::new(),
                    launched_at_ms: ts,
                    tool_use_id: None,
                    resumed_at_ms: None,
                    teammate: false,
                    last_seen_ms: f64::NAN,
                    pending_message: false,
                    task_type: String::new(),
                    spawn_input: None,
                },
            );
            targets.push(rid.clone());
        }
        let r_ts = w.resume_ts.get(&rid).copied();
        for id in targets {
            if let (Some(ts), Some(rec)) = (r_ts, w.launched.get_mut(&id)) {
                rec.resumed_at_ms = Some(rec.resumed_at_ms.unwrap_or(0.0).max(ts));
            }
            if !w.terminal.contains(&id) {
                continue;
            }
            let stands = w
                .terminal_ev
                .get(&id)
                .is_some_and(|evs| evs.iter().any(|(s, ts)| *s > r_seq && !(ts.is_finite() && r_ts.is_some_and(|r| r.is_finite() && *ts < r - slack))));
            if !stands {
                w.terminal.remove(&id);
            }
        }
    }

    // PENDING TEAMMATE MESSAGES: replay each teammate's events in time order.
    let mut pending: Vec<(String, Pending)> = Vec::new();
    let silence = defaults::num("agent_scan.pending_silence_ms") as f64;
    let names: Vec<String> = w.team_events.keys().cloned().collect();
    for name in names {
        let Some(evs) = w.team_events.get(&name) else { continue };
        if !evs.iter().any(|e| e.kind == "spawn" || e.kind == "idle") {
            continue;
        }
        if evs.iter().any(|e| !e.ts.is_finite()) {
            continue;
        }
        let mut ordered = evs.clone();
        ordered.sort_by(|a, b| a.ts.partial_cmp(&b.ts).unwrap_or(std::cmp::Ordering::Equal).then(a.seq.cmp(&b.seq)));
        #[derive(PartialEq)]
        enum St {
            Idle,
            Busy,
            Stopped,
        }
        let mut state = St::Idle;
        let (mut queued, mut pend, mut last_idle) = (f64::NAN, f64::NAN, f64::NAN);
        for e in &ordered {
            match e.kind {
                "spawn" => {
                    state = St::Busy;
                    queued = f64::NAN;
                    pend = f64::NAN;
                }
                "stop" => {
                    state = St::Stopped;
                    queued = f64::NAN;
                    pend = f64::NAN;
                }
                _ if state == St::Stopped => {}
                "send" => {
                    if state == St::Idle {
                        state = St::Busy;
                        pend = e.ts;
                    } else {
                        queued = e.ts;
                    }
                }
                _ => {
                    last_idle = e.ts;
                    if queued.is_finite() {
                        pend = queued;
                        queued = f64::NAN;
                        state = St::Busy;
                    } else {
                        pend = f64::NAN;
                        state = St::Idle;
                    }
                }
            }
        }
        let sent = if queued.is_finite() { queued } else { pend };
        if !sent.is_finite() || background.contains(&name) {
            continue;
        }
        let seen = teammate_sidechain_mtime(path, &name);
        let last_seen = if seen > sent { seen } else { sent };
        let live = opts.now_ms - last_seen < silence;
        let info = w.team_info.get(&name);
        let agent_id = info.map(|i| i.agent_id.clone()).unwrap_or_default();
        let tuid = info.and_then(|i| i.tool_use_id.clone());
        pending.push((name.clone(), Pending { sent_at_ms: sent, last_idle_ms: last_idle, last_seen_ms: last_seen, live, agent_id }));
        if !live {
            continue;
        }
        w.launched.set(
            &name,
            Rec {
                adopted: false,
                output_file: String::new(),
                description: tuid.and_then(|t| w.desc_by_tool_use.get(&t).cloned()).unwrap_or_default(),
                launched_at_ms: sent,
                tool_use_id: None,
                resumed_at_ms: Some(sent),
                teammate: true,
                last_seen_ms: last_seen,
                pending_message: true,
                task_type: String::new(),
                spawn_input: None,
            },
        );
        w.terminal.remove(&name);
    }
    Ok(Scan { launched: w.launched, terminal: w.terminal, pending })
}

/// What `agentCountProof` returns: the running agents (`None`: the count cannot be trusted), the ids the scanned window shows
/// launched (all finished when `rows` is `None`), and how many bytes of transcript the proof covers (0: the agents were found
/// in the default window; the whole file size when it fits a window).
pub struct Proof {
    /// The running agents, or `None` when the count cannot be trusted.
    pub rows: Option<Vec<Row>>,
    /// Ids launched in the scanned window, in launch order.
    pub seen: Vec<String>,
    /// Bytes of transcript the proof covers.
    pub window_bytes: u64,
}

/// `agentCountProof(path)`: [`running_agents_or_null`] with what it saw, so a caller can say why a count is unknown.
pub fn agent_count_proof(path: &str, opts: &Opts) -> Res<Proof> {
    let none = |seen: Vec<String>, window_bytes: u64| Proof { rows: None, seen, window_bytes };
    let seen_of = |s: &Scan| s.launched.iter().map(|(id, _)| id.clone()).collect::<Vec<String>>();
    let tail = defaults::num("agent_scan.tail_bytes");
    let Some(scan) = scan_transcript(path, tail, opts)? else { return Ok(none(Vec::new(), 0)) };
    let rows = scan.rows();
    if !rows.is_empty() {
        return Ok(Proof { rows: Some(rows), seen: seen_of(&scan), window_bytes: 0 });
    }
    let Ok(size) = std::fs::metadata(path).map(|m| m.len()) else { return Ok(none(Vec::new(), 0)) };
    if size <= tail {
        return Ok(Proof { rows: Some(rows), seen: seen_of(&scan), window_bytes: size });
    }
    let wide_bytes = defaults::num("agent_scan.wide_tail_bytes");
    // `scanTranscript(path, readTail(path, WIDE) )`: an unreadable wide read falls back to the default tail read.
    let wide_window = if Tail::open(path, wide_bytes).is_some() { wide_bytes } else { tail };
    let Some(wide) = scan_transcript(path, wide_window, opts)? else { return Ok(none(seen_of(&scan), tail)) };
    let wrows = wide.rows();
    let seen = seen_of(&wide);
    if !wrows.is_empty() {
        return Ok(Proof { rows: Some(wrows), seen, window_bytes: wide_bytes });
    }
    if size <= wide_bytes {
        return Ok(Proof { rows: Some(Vec::new()), seen, window_bytes: wide_bytes });
    }
    Ok(none(seen, wide_bytes))
}

/// `runningAgentsOrNull(path)`: the running agents, or `None` when the count cannot be trusted (an unreadable transcript,
/// or one longer than the widened window with no agent found in it).
pub fn running_agents_or_null(path: &str, opts: &Opts) -> Res<Option<Vec<Row>>> {
    Ok(agent_count_proof(path, opts)?.rows)
}
