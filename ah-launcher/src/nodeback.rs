//! The Node fallback: while the switch (`ah-engine fallback node`, the marker file `files.fallback_switch`) is on, the launcher runs
//! the original Node hooks of the event itself, one after the other, instead of asking the engine, and writes one shadow-ledger row
//! per hook. No shell is involved: a list command is split into words, `${PLUGIN_ROOT}`-style variables are filled in, and the
//! program (one of `launcher.nodeback_runners`) is started directly under `proc::run_child`.
//!
//! The Node tree and the generated lists live in the Node backup directory (`nodeback.node_dir`, beside the plugin root); when it
//! is missing the call gets one notice line and goes through (exit 0, never a block).
//!
//! Outcome (the rules of the shell wrapper this replaces): a hook's exit 2 blocks (stdout and stderr passed through), a JSON block
//! on stdout blocks and is the whole answer, the other stdout is merged into one answer (the dispatch joiners); a timed-out hook
//! is skipped; a hook that dies or cannot start fails a guard event closed when nothing blocked.

use crate::cfg::Settings;
use crate::proc::{self, Feed, Opts, Retry, Run};
use crate::util::{json_true_field, now_ms, say};
use serde_json::{Map, Value};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Everything one fallback call needs.
pub struct Call<'a> {
    pub s: &'a Settings,
    pub event: &'a str,
    pub host: &'a str,
    pub tool_from_payload: bool,
    pub guard: bool,
    pub plugin_root: Option<&'a Path>,
    pub state_dir: &'a Path,
    /// The test-only list override (the shell wrapper's `AH_FALLBACK_LIST`).
    pub list_override: Option<PathBuf>,
    pub payload: &'a [u8],
    pub grace: Duration,
}

/// One hook row of the list.
struct Row {
    matcher: String,
    timeout: Option<u64>,
    command: String,
}

/// The rows of `event` and what its event row says.
#[derive(Default)]
struct Section {
    seen: bool,
    empty: bool,
    timeout: Option<u64>,
    rows: Vec<Row>,
}

fn parse_list(text: &str, event: &str, s: &Settings) -> Section {
    let (mark, comment, empty) = (
        s.text("dispatch.list_event_mark"),
        s.text("dispatch.list_comment_mark"),
        s.text("dispatch.list_empty_word"),
    );
    let mut sec = Section::default();
    let mut inside = false;
    for line in text.lines() {
        if line.is_empty() || line.starts_with(&comment) {
            continue;
        }
        if let Some(head) = line.strip_prefix(&mark) {
            let mut f = head.split('\t');
            inside = f.next() == Some(event);
            if inside {
                sec.seen = true;
                sec.timeout = f.next().and_then(|t| t.parse().ok()).filter(|t| *t > 0);
                sec.empty = head.ends_with(&format!("\t{empty}"));
            }
            continue;
        }
        if !inside {
            continue;
        }
        let Some((matcher, rest)) = line.split_once('\t') else {
            continue;
        };
        let (timeout, command) = match rest.split_once('\t') {
            Some((t, c)) => (t.parse().ok().filter(|t| *t > 0), c),
            None => (None, rest),
        };
        sec.rows.push(Row {
            matcher: matcher.to_string(),
            timeout,
            command: command.to_string(),
        });
    }
    sec
}

/// Whether `matcher` selects `tool`: a plain name list (letters, digits and `dispatch.exact_chars`, split on
/// `dispatch.list_separators`) is an exact match on one name, anything else an unanchored regex; an invalid regex matches nothing.
fn matches(s: &Settings, matcher: &str, tool: &str) -> bool {
    if s.list("dispatch.match_all").iter().any(|m| m == matcher) {
        return true;
    }
    let exact = s.text("dispatch.exact_chars");
    let seps = s.text("dispatch.list_separators");
    if matcher
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || exact.contains(c))
    {
        return matcher
            .split(|c| seps.contains(c))
            .any(|n| n.trim() == tool);
    }
    regex::Regex::new(matcher).is_ok_and(|r| r.is_match(tool))
}

/// The words of a list command with `${NAME}` filled in from `vars`; `None` when it needs a shell (an operator, a substitution,
/// an unclosed quote or a variable that is not known). The second value is the index of the words that came from a variable.
fn words(command: &str, vars: &[(String, String)]) -> Option<(Vec<String>, Vec<bool>)> {
    let mut out: Vec<String> = Vec::new();
    let mut rooted: Vec<bool> = Vec::new();
    let (mut cur, mut have, mut from_var) = (String::new(), false, false);
    let mut quote: Option<char> = None;
    let mut it = command.chars().peekable();
    while let Some(c) = it.next() {
        match (quote, c) {
            (Some(q), c) if c == q => quote = None,
            (None, '"' | '\'') => {
                quote = Some(c);
                have = true;
            }
            (None, c) if c.is_whitespace() => {
                if have {
                    out.push(std::mem::take(&mut cur));
                    rooted.push(from_var);
                    have = false;
                    from_var = false;
                }
            }
            (q, '$') if q != Some('\'') => {
                if it.next() != Some('{') {
                    return None;
                }
                let name: String = it.by_ref().take_while(|c| *c != '}').collect();
                let (_, v) = vars.iter().find(|(k, _)| *k == name)?;
                cur.push_str(v);
                have = true;
                from_var = true;
            }
            (None, c) if "\\`;&|<>()".contains(c) => return None,
            (_, c) => {
                cur.push(c);
                have = true;
            }
        }
    }
    if quote.is_some() {
        return None;
    }
    if have {
        out.push(cur);
        rooted.push(from_var);
    }
    Some((out, rooted))
}

/// `program` as an absolute path: itself when it has a directory part, else the first executable of `PATH`.
fn resolve(program: &str) -> Option<String> {
    if program.contains('/') {
        return crate::util::is_exec(Path::new(program)).then(|| program.to_string());
    }
    let paths = std::env::var_os("PATH")?;
    std::env::split_paths(&paths)
        .map(|d| d.join(program))
        .find(|p| crate::util::is_exec(p))
        .map(|p| p.display().to_string())
}

/// What the rows of a tool event are matched against.
enum Tool {
    Name(String),
    /// The payload names no tool (unreadable or truncated): every row is selected.
    Any,
    /// Not a tool event: only the rows that match every occurrence, and for a guard event every row.
    Unknown,
}

impl Tool {
    fn name(&self) -> &str {
        match self {
            Tool::Name(n) => n,
            _ => "",
        }
    }
}

/// How one hook ended.
#[derive(PartialEq)]
enum End {
    /// Past its row timeout.
    TimedOut,
    /// Could not be started, or its script or a module is missing.
    Unrunnable,
    /// Exited with this code (a signal death is 128 plus the signal).
    Code(i32),
}

struct Ran {
    end: End,
    out: Vec<u8>,
    err: Vec<u8>,
}

impl Ran {
    fn none(end: End) -> Ran {
        Ran {
            end,
            out: Vec::new(),
            err: Vec::new(),
        }
    }

    /// Killed by a signal, or unrunnable: the hook gave no answer of its own.
    fn hard_failure(&self) -> bool {
        match self.end {
            End::Unrunnable => true,
            End::Code(c) => c > 128,
            End::TimedOut => false,
        }
    }
}

fn json_object(text: &str) -> Option<Map<String, Value>> {
    match serde_json::from_str::<Value>(text.trim()).ok()? {
        Value::Object(m) => Some(m),
        _ => None,
    }
}

fn blocks_json(s: &Settings, out: &str) -> bool {
    let Some(o) = json_object(out) else {
        return false;
    };
    let says = |field: &str, v: Option<&Value>| {
        v.and_then(Value::as_str).is_some_and(|w| {
            s.list_for("dispatch.blocking_decisions", field)
                .iter()
                .any(|b| b == w)
        })
    };
    says("decision", o.get("decision"))
        || says(
            "permissionDecision",
            o.get("hookSpecificOutput")
                .and_then(|h| h.get("permissionDecision")),
        )
}

const HSO: &str = "hookSpecificOutput";
const CTX: &str = "additionalContext";
const MSG: &str = "systemMessage";
const EVENT_NAME: &str = "hookEventName";

/// The answers of the hooks that did not block, as ONE answer (the host reads a hook's whole stdout as one JSON object or as plain
/// text): no JSON among them, the texts one after another; one answer, verbatim; several, the contexts joined by
/// `dispatch.context_joiner` and the system messages by `dispatch.message_joiner`, the other fields the first object's. Plain text
/// next to JSON is folded into the context on `dispatch.plain_context_events`, else moved to stderr (returned second).
fn merge(s: &Settings, event: &str, outs: &[String]) -> (String, String) {
    let objs: Vec<Option<Map<String, Value>>> = outs.iter().map(|o| json_object(o)).collect();
    if objs.iter().all(Option::is_none) || outs.len() == 1 {
        return (outs.concat(), String::new());
    }
    let fold = s
        .list("dispatch.plain_context_events")
        .iter()
        .any(|e| e == event);
    let (mut ctx, mut msg, mut err) = (Vec::new(), Vec::new(), String::new());
    let mut base: Option<Map<String, Value>> = None;
    let mut name: Option<String> = None;
    let mut differs = false;
    let residual = |m: &Map<String, Value>| {
        let mut m = m.clone();
        if let Some(Value::Object(h)) = m.get_mut(HSO) {
            h.remove(EVENT_NAME);
            if h.is_empty() {
                m.remove(HSO);
            }
        }
        Value::Object(m).to_string()
    };
    for (raw, obj) in outs.iter().zip(objs) {
        let Some(mut o) = obj else {
            let t = raw.trim_end_matches('\n');
            if fold {
                if !t.is_empty() {
                    ctx.push(t.to_string());
                }
            } else {
                err.push_str(raw);
                if !raw.ends_with('\n') {
                    err.push('\n');
                }
            }
            continue;
        };
        if let Some(Value::Object(h)) = o.get_mut(HSO) {
            if name.is_none() {
                name = h
                    .get(EVENT_NAME)
                    .and_then(Value::as_str)
                    .map(str::to_string);
            }
            if let Some(Value::String(c)) = h.remove(CTX)
                && !c.is_empty()
            {
                ctx.push(c);
            }
        }
        if let Some(Value::String(m)) = o.remove(MSG)
            && !m.is_empty()
        {
            msg.push(m);
        }
        match &base {
            None => base = Some(o),
            Some(b) => differs |= residual(b) != residual(&o),
        }
    }
    if differs {
        err.push_str(&s.text("msg.launcher_nodeback_merge_differs"));
        err.push('\n');
    }
    let mut top = base.unwrap_or_default();
    if !ctx.is_empty() {
        let joined = ctx.join(&s.text("dispatch.context_joiner"));
        let h = top.entry(HSO).or_insert_with(|| Value::Object(Map::new()));
        if let Value::Object(h) = h {
            if !h.contains_key(EVENT_NAME) {
                h.insert(
                    EVENT_NAME.into(),
                    Value::String(name.unwrap_or_else(|| event.to_string())),
                );
            }
            h.insert(CTX.into(), Value::String(joined));
        }
    }
    if let Some(Value::Object(h)) = top.get(HSO)
        && h.keys().all(|k| k == EVENT_NAME)
    {
        top.remove(HSO);
    }
    if !msg.is_empty() {
        top.insert(
            MSG.into(),
            Value::String(msg.join(&s.text("dispatch.message_joiner"))),
        );
    }
    if top.is_empty() {
        return (String::new(), err);
    }
    (format!("{}\n", Value::Object(top)), err)
}

fn emit(out: &[u8], err: &[u8]) {
    let mut o = std::io::stdout();
    let _ = o.write_all(out);
    let _ = o.flush();
    let _ = std::io::stderr().write_all(err);
}

fn ident(s: &Settings, raw: &str) -> String {
    let cap = s.num("nodeback.ident_max_len") as usize;
    raw.chars()
        .take(cap)
        .map(|c| {
            if c.is_ascii_alphanumeric() || "._:@+-".contains(c) {
                c
            } else {
                '_'
            }
        })
        .collect()
}

impl Call<'_> {
    fn closed(&self, why_key: &str) -> i32 {
        let why = self.s.text(why_key);
        let subs = [("event", self.event), ("why", why.as_str())];
        let stop = self
            .s
            .list("dispatch.guard_events")
            .iter()
            .any(|e| e == self.event)
            && (self.event == "Stop" || self.event == "SubagentStop")
            && json_true_field(self.payload, "stop_hook_active");
        if stop {
            say(&self.s.msg("msg.launcher_fail_open_stop", &subs));
            return 0;
        }
        say(&self.s.msg("msg.launcher_fail_closed", &subs));
        2
    }

    /// Which tool the rows are matched against: the payload's `tool_name` on a tool event (or when asked), every row when the
    /// payload gives none, no name at all otherwise.
    fn tool(&self) -> Tool {
        if !self.tool_event() {
            return Tool::Unknown;
        }
        serde_json::from_slice::<Value>(self.payload)
            .ok()
            .and_then(|v| {
                v.get(self.s.text("launcher.nodeback_tool_field"))?
                    .as_str()
                    .map(str::to_string)
            })
            .map_or(Tool::Any, Tool::Name)
    }

    fn tool_event(&self) -> bool {
        self.tool_from_payload
            || self
                .s
                .list("launcher.nodeback_tool_events")
                .iter()
                .any(|e| e == self.event)
    }

    fn vars(&self, root: &Path) -> Vec<(String, String)> {
        self.s
            .list("launcher.plugin_root_envs")
            .into_iter()
            .map(|k| {
                let v = crate::util::env_nonempty(&k).unwrap_or_else(|| root.display().to_string());
                (k, v)
            })
            .collect()
    }

    /// The ledger name of a command: the dispatch-table id the map gives it, else the script's name.
    fn check_id(&self, node_dir: &Path, command: &str, script: Option<&str>) -> String {
        let map_key = format!("launcher.fallback_map_{}", self.host);
        let mapped = std::fs::read(node_dir.join(self.s.text(&map_key)))
            .ok()
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
            .and_then(|m| {
                m.get(self.event)?
                    .as_object()?
                    .iter()
                    .find(|(_, c)| c.as_str() == Some(command))
                    .map(|(k, _)| k.clone())
            });
        let name = mapped.or_else(|| {
            script
                .and_then(|p| Path::new(p).file_stem())
                .map(|f| f.to_string_lossy().into_owned())
        });
        ident(self.s, &name.unwrap_or_default())
    }

    /// One ledger row for the hook just run. Best effort: a ledger that cannot be written changes nothing.
    fn record(&self, inv: &str, tool: &str, chk: &str, ran: &Ran, ms: u64) {
        let file = self.s.text("files.shadow_ledger");
        if file.is_empty() || self.state_dir.as_os_str().is_empty() {
            return;
        }
        let (out, err) = (
            String::from_utf8_lossy(&ran.out),
            String::from_utf8_lossy(&ran.err),
        );
        let (v, why) = match ran.end {
            End::TimedOut => ("timeout", "timeout"),
            _ if ran.hard_failure() => ("error", "died"),
            End::Code(2) => ("block", ""),
            End::Code(0) if blocks_json(self.s, &out) => ("block", ""),
            End::Code(0) if !out.is_empty() || !err.is_empty() => ("advise", ""),
            End::Code(0) => ("allow", ""),
            _ => ("error", "exit"),
        };
        let row = serde_json::json!({
            "ts": now_ms(), "inv": inv, "src": "node", "host": self.host, "ev": self.event, "tool": ident(self.s, tool),
            "chk": chk, "v": v, "ms": ms, "err": why,
        });
        let path = self.state_dir.join(file);
        let _ = std::fs::create_dir_all(self.state_dir);
        if std::fs::metadata(&path).is_ok_and(|m| m.len() > self.s.num("nodeback.ledger_max_bytes"))
        {
            let mut old = path.clone().into_os_string();
            old.push(".1");
            let _ = std::fs::rename(&path, old);
        }
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
        {
            let _ = f.write_all(format!("{row}\n").as_bytes());
        }
    }

    fn run_one(&self, argv: &[String], timeout: u64, root: &Path) -> Ran {
        let envs: Vec<(String, String)> = self.vars(root);
        let r = proc::run_child(&Opts {
            argv,
            envs: &envs,
            env_remove: &[],
            feed: Feed::memory(
                self.payload,
                Duration::from_millis(self.s.num("launcher.write_timeout_ms")),
                self.s.num("launcher.io_chunk_bytes") as usize,
            ),
            budget: Duration::from_secs(timeout),
            wait_file: None,
            done_file: None,
            slow_max: Duration::ZERO,
            grace: self.grace,
            drain: Duration::from_millis(self.s.num("launcher.io_drain_ms")),
            strict_group: false,
            out_cap: self.s.num("launcher.out_cap_bytes") as usize,
            err_cap: self.s.num("launcher.err_cap_bytes") as usize,
            retry: Retry {
                max: self.s.num("launcher.spawn_retry_max"),
                base_ms: self.s.num("launcher.spawn_backoff_base_ms"),
                cap_ms: self.s.num("launcher.spawn_backoff_cap_ms"),
                jitter_pct: self.s.num("launcher.spawn_jitter_pct"),
            },
            reaper: None,
        });
        match r {
            Run::Exited { code, out, err, .. } => {
                // node exits 1 when it cannot load the script or a module: unrunnable, not the hook's own decision
                let text = String::from_utf8_lossy(&err);
                let markers = self.s.list("launcher.nodeback_unrunnable_markers");
                if code == 1
                    && !markers.is_empty()
                    && markers.iter().all(|m| text.contains(m.as_str()))
                {
                    return Ran {
                        end: End::Unrunnable,
                        out,
                        err,
                    };
                }
                Ran {
                    end: End::Code(code),
                    out,
                    err,
                }
            }
            Run::TimedOut => Ran::none(End::TimedOut),
            Run::GroupAlive | Run::SpawnFailed { .. } => Ran::none(End::Unrunnable),
        }
    }

    /// Run the Node hooks of the event; the exit code of the launcher.
    pub fn run(&self) -> i32 {
        let Some(root) = self.plugin_root else {
            return 0;
        };
        let node_dir = root.join(self.s.text("nodeback.node_dir"));
        if !node_dir.is_dir() {
            say(&self.s.msg(
                "nodeback.msg_no_node_dir",
                &[("dir", &node_dir.display().to_string())],
            ));
            return 0;
        }
        let list = self.list_override.clone().unwrap_or_else(|| {
            node_dir.join(
                self.s
                    .text(&format!("launcher.fallback_list_{}", self.host)),
            )
        });
        let Ok(text) = std::fs::read_to_string(&list) else {
            return if self.guard {
                self.closed("msg.launcher_nodeback_why_no_list")
            } else {
                0
            };
        };
        if self.guard && text.trim().is_empty() {
            return self.closed("msg.launcher_nodeback_why_no_list");
        }
        let sec = parse_list(&text, self.event, self.s);
        let default_timeout = sec
            .timeout
            .unwrap_or_else(|| self.s.num("client.wrapper_default_timeout_s").max(1));
        let tool = self.tool();
        let vars = self.vars(root);
        let inv = format!("fb{:x}{:x}", std::process::id(), now_ms());
        let (mut selected, mut ran_any, mut hard) = (0u32, false, false);
        let mut answers: Vec<String> = Vec::new();
        for row in &sec.rows {
            let wanted = match &tool {
                Tool::Any => true,
                _ if self.s.list("dispatch.match_all").contains(&row.matcher) => true,
                Tool::Name(t) => matches(self.s, &row.matcher, t),
                // no tool name at all: a guard event runs every row (a guard whose matcher cannot be tested must still run)
                Tool::Unknown => self.guard,
            };
            if !wanted {
                continue;
            }
            let Some((w, rooted)) = words(&row.command, &vars) else {
                selected += 1;
                hard = true;
                continue;
            };
            let Some(prog) = w.first() else { continue };
            selected += 1;
            if !self
                .s
                .list("launcher.nodeback_runners")
                .iter()
                .any(|r| r == prog)
            {
                // a no-op script of the dispatch table (the engine answers that entry in-process): nothing to run
                ran_any = true;
                continue;
            }
            let t0 = now_ms();
            let script = w
                .iter()
                .zip(&rooted)
                .skip(1)
                .find(|(_, r)| **r)
                .map(|(a, _)| a.clone());
            let ran = match (resolve(prog), &script) {
                (None, _) => Ran::none(End::Unrunnable),
                (Some(_), Some(p)) if !Path::new(p).is_file() => {
                    say(&self
                        .s
                        .msg("msg.launcher_nodeback_script_missing", &[("path", p)]));
                    Ran::none(End::Unrunnable)
                }
                (Some(abs), _) => {
                    let mut argv = vec![abs];
                    argv.extend(w[1..].iter().cloned());
                    self.run_one(&argv, row.timeout.unwrap_or(default_timeout), root)
                }
            };
            let chk = self.check_id(&node_dir, &row.command, script.as_deref());
            self.record(&inv, tool.name(), &chk, &ran, now_ms().saturating_sub(t0));
            if ran.end == End::TimedOut {
                continue;
            }
            if ran.hard_failure() {
                hard = true;
                continue;
            }
            ran_any = true;
            let out = String::from_utf8_lossy(&ran.out).into_owned();
            if ran.end == End::Code(2) {
                let (m, e) = merge(self.s, self.event, &answers);
                emit(m.as_bytes(), e.as_bytes());
                emit(&ran.out, &ran.err);
                return 2;
            }
            if blocks_json(self.s, &out) {
                // a JSON block is the whole answer, byte for byte (two JSON objects are not one answer)
                emit(&ran.out, &ran.err);
                return 0;
            }
            if !ran.out.is_empty() {
                answers.push(out);
            }
        }
        let (m, e) = merge(self.s, self.event, &answers);
        emit(m.as_bytes(), e.as_bytes());
        if sec.empty {
            return 0; // a thin trigger with no hook of its own: nothing to run and nothing to guard
        }
        if hard && self.guard {
            return self.closed("msg.launcher_nodeback_why_hard");
        }
        if ran_any || !self.guard {
            return 0;
        }
        if selected > 0 {
            return self.closed("msg.launcher_nodeback_why_not_run");
        }
        // nothing matched: events no Node hook is registered for have no section (the neutral no-op), and a tool that no row
        // names runs nothing on the host either; a list without the event row at all is damaged and stays fail-closed
        let keyless = self
            .s
            .list("launcher.nodeback_keyless_events")
            .iter()
            .any(|e| e == self.event);
        if (!sec.seen && keyless) || (sec.seen && matches!(tool, Tool::Name(_))) {
            return 0;
        }
        self.closed("msg.launcher_nodeback_why_no_match")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars() -> Vec<(String, String)> {
        vec![("CLAUDE_PLUGIN_ROOT".into(), "/p q".into())]
    }

    #[test]
    fn words_fill_variables_and_refuse_what_needs_a_shell() {
        let (w, rooted) = words(
            "node --flag \"${CLAUDE_PLUGIN_ROOT}/../x.js\" --post",
            &vars(),
        )
        .unwrap();
        assert_eq!(w, ["node", "--flag", "/p q/../x.js", "--post"]);
        assert_eq!(rooted, [false, false, true, false]);
        for bad in [
            "node x; rm y",
            "node $(x)",
            "node `x`",
            "node \"open",
            "node ${NOPE}/x",
            "node a | b",
            "node a > b",
        ] {
            assert!(words(bad, &vars()).is_none(), "{bad}");
        }
    }

    #[test]
    fn matchers_are_names_lists_or_regexes() {
        let s = Settings::default();
        assert!(matches(&s, "Bash", "Bash") && !matches(&s, "Bash", "Bashful"));
        assert!(matches(&s, "Write|Edit,Bash", "Edit") && matches(&s, "Agent | Task", "Task"));
        assert!(matches(
            &s,
            "^(?:collaboration)?spawn_agent$",
            "collaborationspawn_agent"
        ));
        assert!(!matches(
            &s,
            "^(?:collaboration)?spawn_agent$",
            "xspawn_agent"
        ));
        assert!(!matches(&s, "(unclosed", "anything"));
    }

    #[test]
    fn merge_joins_contexts_and_drops_an_empty_object() {
        let s = Settings::default();
        let a = r#"{"hookSpecificOutput":{"hookEventName":"X","additionalContext":"A"}}"#;
        let b = r#"{"hookSpecificOutput":{"hookEventName":"X","additionalContext":"B"},"systemMessage":"m"}"#;
        let (out, err) = merge(&s, "X", &[a.into(), b.into()]);
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["hookSpecificOutput"]["additionalContext"], "A\n\nB");
        assert_eq!(v["systemMessage"], "m");
        assert!(err.is_empty());
        let empty = r#"{"hookSpecificOutput":{"hookEventName":"X","additionalContext":""}}"#;
        assert_eq!(merge(&s, "X", &[empty.into(), empty.into()]).0, "");
        assert_eq!(
            merge(&s, "X", &["plain\n".into(), "more\n".into()]).0,
            "plain\nmore\n"
        );
        let (_, err) = merge(&s, "Other", &[a.into(), "text\n".into()]);
        assert_eq!(
            err, "text\n",
            "plain text next to JSON goes to stderr off the context events"
        );
    }
}
