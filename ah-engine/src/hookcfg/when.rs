//! The `when` predicate of a dispatch-table entry (D87): a small declarative filter that decides, per occurrence, whether the
//! entry applies. An entry without one applies whenever its matcher does.
//!
//! A predicate is a JSON/TOML value, parsed and validated once (a bad one is a config error, never a run-time surprise):
//!
//! ```toml
//! when = { all = [ { tool = "Bash" }, { field = "/tool_input/command", regex = '^git\s' }, { not = { env = "CI", exists = true } } ] }
//! ```
//!
//! Leaf kinds: `tool` (the payload's tool name: a string or a list), `field` (a JSON pointer into the payload, so
//! `/tool_input/file_path` is a tool-input field), `setting` (a boolean or enum of the engine's loaded settings), `env` (a
//! variable of the REQUEST environment, `request_env.allow`), `session` (per-session state the engine keeps in memory) and
//! `transcript` (a fact of the transcript index). Each leaf takes exactly one test: `equals`, `in`, `regex`, `glob`, `exists`,
//! `at_least`, `at_most` (`session` takes `first`, `every` or `at_least` instead). `all`, `any` and `not` combine conditions.
//!
//! Evaluation is three-valued: a leaf whose state is not available in the evaluating process (no session store, no transcript
//! index, no loaded settings) answers "unknown", and an unknown predicate APPLIES the entry: a guard is never skipped because
//! the engine could not tell. `all` is false when any part is false, else unknown when any part is, else true; `any` is true
//! when any part is true, else unknown when any part is; `not` keeps unknown.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - text that does not parse or decode is the absent value (Node Number()/JSON.parse catch parity)
// - an absent field is the empty value
// A failure that must be seen goes through `crate::discard` instead.

use crate::defaults::{self, V};
use crate::reqenv::RequestEnv;
use crate::transcript::index::Index;
use regex::Regex;
use serde_json::Value as Json;

use super::session::SessionStore;

/// A scalar a condition compares.
#[derive(Debug, Clone, PartialEq)]
pub enum Val {
    /// A boolean.
    Bool(bool),
    /// An integer.
    Int(i64),
    /// A string.
    Str(String),
}

impl Val {
    fn from_json(v: &Json) -> Option<Val> {
        match v {
            Json::Bool(b) => Some(Val::Bool(*b)),
            Json::Number(n) => n.as_i64().map(Val::Int).or_else(|| Some(Val::Str(n.to_string()))),
            Json::String(s) => Some(Val::Str(s.clone())),
            _ => None,
        }
    }

    fn text(&self) -> String {
        match self {
            Val::Bool(b) => b.to_string(),
            Val::Int(n) => n.to_string(),
            Val::Str(s) => s.clone(),
        }
    }

    fn int(&self) -> Option<i64> {
        match self {
            Val::Int(n) => Some(*n),
            Val::Str(s) => s.trim().parse().ok(),
            Val::Bool(_) => None,
        }
    }
}

/// The test a leaf applies to its value.
#[derive(Debug, Clone)]
pub enum Test {
    /// The value equals this one (compared as text, so `1` and `"1"` agree).
    Equals(Val),
    /// The value equals one of these.
    In(Vec<Val>),
    /// The value's text matches this unanchored regex.
    Regex(Regex),
    /// The value's text matches this glob.
    Glob(String),
    /// The value is present (true) or absent (false).
    Exists(bool),
    /// The value is an integer of at least this.
    AtLeast(i64),
    /// The value is an integer of at most this.
    AtMost(i64),
}

impl Test {
    /// Apply the test to a value that may be absent.
    pub fn check(&self, v: Option<&Val>) -> bool {
        match (self, v) {
            (Test::Exists(want), v) => v.is_some() == *want,
            (_, None) => false,
            (Test::Equals(x), Some(v)) => x.text() == v.text(),
            (Test::In(xs), Some(v)) => xs.iter().any(|x| x.text() == v.text()),
            (Test::Regex(re), Some(v)) => re.is_match(&v.text()),
            (Test::Glob(g), Some(v)) => glob_match(g, &v.text()),
            (Test::AtLeast(n), Some(v)) => v.int().is_some_and(|x| x >= *n),
            (Test::AtMost(n), Some(v)) => v.int().is_some_and(|x| x <= *n),
        }
    }
}

impl PartialEq for Test {
    fn eq(&self, o: &Test) -> bool {
        match (self, o) {
            (Test::Equals(a), Test::Equals(b)) => a == b,
            (Test::In(a), Test::In(b)) => a == b,
            (Test::Regex(a), Test::Regex(b)) => a.as_str() == b.as_str(),
            (Test::Glob(a), Test::Glob(b)) => a == b,
            (Test::Exists(a), Test::Exists(b)) => a == b,
            (Test::AtLeast(a), Test::AtLeast(b)) | (Test::AtMost(a), Test::AtMost(b)) => a == b,
            _ => false,
        }
    }
}

/// Glob matching: `*` any run of characters except `/`, `**` any run including `/`, `?` one character except `/`; every
/// other character matches itself.
pub fn glob_match(pattern: &str, text: &str) -> bool {
    fn go(p: &[char], t: &[char]) -> bool {
        match p.first() {
            None => t.is_empty(),
            Some('*') if p.get(1) == Some(&'*') => {
                let rest = &p[2..];
                (0..=t.len()).any(|i| go(rest, &t[i..]))
            }
            Some('*') => {
                let rest = &p[1..];
                (0..=t.len()).take_while(|&i| i == 0 || t[i - 1] != '/').any(|i| go(rest, &t[i..]))
            }
            Some('?') => t.first().is_some_and(|c| *c != '/') && go(&p[1..], &t[1..]),
            Some(c) => t.first() == Some(c) && go(&p[1..], &t[1..]),
        }
    }
    let (p, t): (Vec<char>, Vec<char>) = (pattern.chars().collect(), text.chars().collect());
    go(&p, &t)
}

/// A transcript-index fact a `transcript` condition may read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fact {
    /// Records the index has read.
    Records,
    /// Compaction boundaries seen.
    CompactBoundaries,
    /// Sidechain (sub-conversation) rows.
    SidechainRows,
    /// Meta rows.
    MetaRows,
    /// Whether the index holds a last typed prompt.
    HasLastPrompt,
    /// Whether the index holds a last assistant reply.
    HasLastAssistant,
    /// The newest tool use's name.
    LastTool,
    /// Background agents with a terminal notification.
    TerminalAgents,
    /// Agents a compaction re-injected as live that no terminal notification closed.
    UnresolvedAgents,
}

impl Fact {
    fn parse(name: &str) -> Option<Fact> {
        Some(match name {
            "records" => Fact::Records,
            "compact_boundaries" => Fact::CompactBoundaries,
            "sidechain_rows" => Fact::SidechainRows,
            "meta_rows" => Fact::MetaRows,
            "has_last_prompt" => Fact::HasLastPrompt,
            "has_last_assistant" => Fact::HasLastAssistant,
            "last_tool" => Fact::LastTool,
            "terminal_agents" => Fact::TerminalAgents,
            "unresolved_agents" => Fact::UnresolvedAgents,
            _ => return None,
        })
    }

    /// The fact's value on an index.
    pub fn read(self, ix: &Index) -> Val {
        let count = |n: u64| Val::Int(n.min(i64::MAX as u64) as i64);
        match self {
            Fact::Records => count(ix.records()),
            Fact::CompactBoundaries => count(ix.compact_boundaries()),
            Fact::SidechainRows => count(ix.sidechain_rows()),
            Fact::MetaRows => count(ix.meta_rows()),
            Fact::HasLastPrompt => Val::Bool(ix.last_prompt().is_some()),
            Fact::HasLastAssistant => Val::Bool(ix.last_assistant().is_some()),
            Fact::LastTool => Val::Str(ix.recent_tool_uses(1).first().map(|u| u.name.clone()).unwrap_or_default()),
            Fact::TerminalAgents => count(ix.terminal_agents().len() as u64),
            Fact::UnresolvedAgents => {
                let done: std::collections::HashSet<&str> = ix.terminal_agents().into_iter().chain(ix.finished_task_keys()).collect();
                count(ix.task_statuses().iter().filter(|s| !done.contains(s.task_id.as_str())).count() as u64)
            }
        }
    }
}

/// What a `setting` condition reads.
#[derive(Debug, Clone, PartialEq)]
pub enum SettingRef {
    /// A shipped boolean switch table (`section`, `key`, `env`, `aliases`, `default`), resolved against the request
    /// environment and the loaded `settings.json`.
    Switch(&'static V),
    /// One of the engine's own settings (`section.key` of `defaults/*.toml`).
    Engine(&'static str),
}

/// How a `session` condition counts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionOp {
    /// True the first time in the session (within the TTL).
    First,
    /// True on the 1st evaluation and then every Nth.
    Every(u64),
    /// True once the evaluation count reaches N.
    AtLeast(u64),
}

/// A `session` condition.
#[derive(Debug, Clone, PartialEq)]
pub struct SessionCond {
    /// The counter's name, unique per author (state is kept per session and name).
    pub name: String,
    /// How it counts.
    pub op: SessionOp,
    /// Its own TTL in seconds, else `hooks.session_ttl_s`.
    pub ttl_s: Option<u64>,
}

/// The value source of a leaf.
#[derive(Debug, Clone, PartialEq)]
pub enum Source {
    /// The payload's tool name.
    Tool,
    /// A JSON pointer into the payload.
    Field(String),
    /// A loaded setting.
    Setting(SettingRef),
    /// A request-environment variable.
    Env(String),
    /// A transcript-index fact.
    Transcript(Fact),
}

/// A parsed predicate.
#[derive(Debug, Clone, PartialEq)]
pub enum When {
    /// Every part holds.
    All(Vec<When>),
    /// At least one part holds.
    Any(Vec<When>),
    /// The part does not hold.
    Not(Box<When>),
    /// A value and a test.
    Leaf(Source, Test),
    /// Per-session state.
    Session(SessionCond),
}

/// Why a predicate was rejected: the shipped message text, ready to show.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WhenError(pub String);

impl std::fmt::Display for WhenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for WhenError {}

fn why(name: &str) -> &'static str {
    defaults::raw("hooks.reasons").str_field(name)
}

fn err(key: &str, args: &[(&str, &dyn std::fmt::Display)]) -> WhenError {
    WhenError(defaults::render(key, args))
}

fn has_op(o: &serde_json::Map<String, Json>) -> Vec<&str> {
    defaults::list("hooks.when_ops").into_iter().filter(|k| o.contains_key(*k)).collect()
}

fn parse_test(o: &serde_json::Map<String, Json>) -> Result<Test, WhenError> {
    let ops = has_op(o);
    let found = o.keys().cloned().collect::<Vec<_>>().join(", ");
    let allowed = defaults::list("hooks.when_ops").join(", ");
    let [op] = ops.as_slice() else { return Err(err("hooks.msg_when_unknown_op", &[("found", &found), ("allowed", &allowed)])) };
    let v = &o[*op];
    let bad = |what: String| err("hooks.msg_when_bad_value", &[("what", &what)]);
    Ok(match *op {
        "equals" => Test::Equals(Val::from_json(v).ok_or_else(|| bad(why("equals_value").into()))?),
        "in" => Test::In(
            v.as_array()
                .ok_or_else(|| bad(why("in_needs_list").into()))?
                .iter()
                .map(|x| Val::from_json(x).ok_or_else(|| bad(why("in_values").into())))
                .collect::<Result<_, _>>()?,
        ),
        "regex" => {
            let p = v.as_str().ok_or_else(|| bad(why("regex_needs_string").into()))?;
            Test::Regex(Regex::new(p).map_err(|e| err("hooks.msg_when_bad_regex", &[("pattern", &p), ("err", &e)]))?)
        }
        "glob" => Test::Glob(v.as_str().ok_or_else(|| bad(why("glob_needs_string").into()))?.to_string()),
        "exists" => Test::Exists(v.as_bool().ok_or_else(|| bad(why("exists_needs_bool").into()))?),
        "at_least" => Test::AtLeast(v.as_i64().ok_or_else(|| bad(why("at_least_needs_int").into()))?),
        _ => Test::AtMost(v.as_i64().ok_or_else(|| bad(why("at_most_needs_int").into()))?),
    })
}

fn find_setting(key: &str) -> Option<SettingRef> {
    let (section, name) = key.split_once('.')?;
    for e in defaults::all() {
        if let V::Table(_) = e.value
            && e.value.str_field("section") == section
            && e.value.str_field("key") == name
            && e.value.get("default").is_some_and(|d| d.as_bool().is_some())
        {
            return Some(SettingRef::Switch(&e.value));
        }
    }
    defaults::get(key).map(|e| SettingRef::Engine(e.key))
}

fn parse_session(o: &serde_json::Map<String, Json>) -> Result<When, WhenError> {
    let bad = |what: &str| err("hooks.msg_when_bad_session", &[("what", &what)]);
    let name = o.get("session").and_then(Json::as_str).filter(|n| !n.is_empty()).ok_or_else(|| bad(why("session_name")))?;
    let ops = defaults::list("hooks.session_ops");
    let given: Vec<&str> = ops.iter().copied().filter(|k| o.contains_key(*k)).collect();
    let [op] = given.as_slice() else { return Err(bad(&defaults::fill(why("exactly_one_of"), &[("ops", &ops.join(", "))]))) };
    let n = |k: &str| o.get(k).and_then(Json::as_u64).filter(|n| *n >= 1);
    let op = match *op {
        "first" if o.get("first").and_then(Json::as_bool) == Some(true) => SessionOp::First,
        "first" => return Err(bad(why("first_must_be_true"))),
        "every" => SessionOp::Every(n("every").ok_or_else(|| bad(why("every_n")))?),
        _ => SessionOp::AtLeast(n("at_least").ok_or_else(|| bad(why("at_least_n")))?),
    };
    let ttl_s = match o.get("ttl_s") {
        None => None,
        Some(t) => Some(t.as_u64().filter(|t| *t >= 1).ok_or_else(|| bad(why("ttl_s")))?),
    };
    let allowed: Vec<&str> = ["session", "ttl_s"].into_iter().chain(ops.iter().copied()).collect();
    if let Some(k) = o.keys().find(|k| !allowed.contains(&k.as_str())) {
        return Err(bad(&format!("{k} is not a session field")));
    }
    Ok(When::Session(SessionCond { name: name.to_string(), op, ttl_s }))
}

impl When {
    /// Parse and validate a predicate given as JSON (a TOML table converts to it).
    pub fn parse(v: &Json) -> Result<When, WhenError> {
        When::parse_at(v, 0)
    }

    fn parse_at(v: &Json, depth: u64) -> Result<When, WhenError> {
        let max = defaults::num("hooks.when_max_depth");
        if depth >= max {
            return Err(err("hooks.msg_when_depth", &[("max", &max)]));
        }
        let o = v.as_object().ok_or_else(|| err("hooks.msg_when_bad_value", &[("what", &why("condition_table"))]))?;
        let kinds = defaults::list("hooks.when_kinds");
        let given: Vec<&str> = kinds.iter().copied().filter(|k| o.contains_key(*k)).collect();
        let found = o.keys().cloned().collect::<Vec<_>>().join(", ");
        let [kind] = given.as_slice() else { return Err(err("hooks.msg_when_unknown_kind", &[("found", &found), ("allowed", &kinds.join(", "))])) };
        let list = |k: &str| -> Result<Vec<When>, WhenError> {
            let a = o[k]
                .as_array()
                .filter(|a| !a.is_empty())
                .ok_or_else(|| err("hooks.msg_when_bad_value", &[("what", &format!("{k} needs a non-empty list"))]))?;
            a.iter().map(|x| When::parse_at(x, depth + 1)).collect()
        };
        let rest = |own: &str| -> serde_json::Map<String, Json> { o.iter().filter(|(k, _)| k.as_str() != own).map(|(k, v)| (k.clone(), v.clone())).collect() };
        Ok(match *kind {
            "all" | "any" | "not" if o.len() != 1 => return Err(err("hooks.msg_when_unknown_kind", &[("found", &found), ("allowed", &kinds.join(", "))])),
            "all" => When::All(list("all")?),
            "any" => When::Any(list("any")?),
            "not" => When::Not(Box::new(When::parse_at(&o["not"], depth + 1)?)),
            "session" => parse_session(o)?,
            "tool" => {
                let names: Vec<Val> = match &o["tool"] {
                    Json::String(s) => vec![Val::Str(s.clone())],
                    Json::Array(a) => a.iter().filter_map(|x| x.as_str().map(|s| Val::Str(s.to_string()))).collect(),
                    _ => Vec::new(),
                };
                if names.is_empty() || o.len() != 1 {
                    return Err(err("hooks.msg_when_bad_value", &[("what", &why("tool_value"))]));
                }
                When::Leaf(Source::Tool, Test::In(names))
            }
            "field" => {
                let p = o["field"].as_str().ok_or_else(|| err("hooks.msg_when_bad_value", &[("what", &why("field_value"))]))?;
                if !p.starts_with('/') {
                    return Err(err("hooks.msg_when_bad_pointer", &[("pointer", &p)]));
                }
                When::Leaf(Source::Field(p.to_string()), parse_test(&rest("field"))?)
            }
            "setting" => {
                let k = o["setting"].as_str().ok_or_else(|| err("hooks.msg_when_bad_value", &[("what", &why("setting_value"))]))?;
                let r = find_setting(k).ok_or_else(|| err("hooks.msg_when_unknown_setting", &[("key", &k)]))?;
                let t = rest("setting");
                let test = if t.is_empty() { Test::Equals(Val::Bool(true)) } else { parse_test(&t)? };
                When::Leaf(Source::Setting(r), test)
            }
            "env" => {
                let n = o["env"].as_str().filter(|n| !n.is_empty()).ok_or_else(|| err("hooks.msg_when_bad_value", &[("what", &why("env_needs_name"))]))?;
                if !crate::reqenv::allowed(n) {
                    return Err(err("hooks.msg_when_env_not_forwarded", &[("name", &n)]));
                }
                let t = rest("env");
                let test = if t.is_empty() { Test::Exists(true) } else { parse_test(&t)? };
                When::Leaf(Source::Env(n.to_string()), test)
            }
            _ => {
                let n = o["transcript"].as_str().unwrap_or("");
                let facts = defaults::raw("hooks.transcript_facts").as_table().unwrap_or(&[]);
                let fact = Fact::parse(n).filter(|_| facts.iter().any(|(k, _)| *k == n)).ok_or_else(|| {
                    err("hooks.msg_when_unknown_fact", &[("name", &n), ("allowed", &facts.iter().map(|(k, _)| *k).collect::<Vec<_>>().join(", "))])
                })?;
                let t = rest("transcript");
                let test = if t.is_empty() { Test::Equals(Val::Bool(true)) } else { parse_test(&t)? };
                When::Leaf(Source::Transcript(fact), test)
            }
        })
    }

    /// Parse a predicate held in the shipped defaults.
    pub fn from_v(v: &V) -> Result<When, WhenError> {
        When::parse(&v.to_json())
    }

    /// Whether any part is a `session` condition (it needs the evaluating process to keep state across calls).
    pub fn needs_session(&self) -> bool {
        match self {
            When::All(xs) | When::Any(xs) => xs.iter().any(When::needs_session),
            When::Not(x) => x.needs_session(),
            When::Session(_) => true,
            When::Leaf(..) => false,
        }
    }

    /// Evaluate on one occurrence: `Some(true)` applies, `Some(false)` skips, `None` is unknown (the entry applies).
    pub fn eval(&self, cx: &Ctx<'_>) -> Option<bool> {
        match self {
            When::All(xs) => {
                let mut unknown = false;
                for x in xs {
                    match x.eval(cx) {
                        Some(false) => return Some(false),
                        None => unknown = true,
                        Some(true) => {}
                    }
                }
                if unknown { None } else { Some(true) }
            }
            When::Any(xs) => {
                let mut unknown = false;
                for x in xs {
                    match x.eval(cx) {
                        Some(true) => return Some(true),
                        None => unknown = true,
                        Some(false) => {}
                    }
                }
                if unknown { None } else { Some(false) }
            }
            When::Not(x) => x.eval(cx).map(|b| !b),
            When::Session(c) => {
                let store = cx.sessions?;
                Some(store.test(cx.session_id, c))
            }
            When::Leaf(src, test) => {
                let value = match src {
                    Source::Tool => cx.tool.or_else(|| cx.payload.get("tool_name").and_then(Json::as_str)).map(|t| Val::Str(t.to_string())),
                    Source::Field(p) => cx.payload.pointer(p).and_then(Val::from_json),
                    Source::Env(n) => cx.env.get(n).map(|v| Val::Str(v.to_string())),
                    Source::Setting(r) => cx.facts.setting(r, cx.env)?,
                    Source::Transcript(f) => cx.facts.transcript(cx.payload, *f)?,
                };
                Some(test.check(value.as_ref()))
            }
        }
    }
}

/// The state the engine holds that a predicate may read; a source that is not available answers `None` (unknown).
pub trait Facts {
    /// The value of a loaded setting (`None` = not loaded here; `Some(None)` = loaded and unset).
    fn setting(&self, r: &SettingRef, env: &RequestEnv) -> Option<Option<Val>>;
    /// A fact of the payload's transcript (`None` = no index available here; `Some(None)` = the payload names no transcript).
    fn transcript(&self, payload: &Json, f: Fact) -> Option<Option<Val>>;
}

/// No loaded state at all: every setting and transcript condition is unknown.
pub struct NoFacts;

impl Facts for NoFacts {
    fn setting(&self, _: &SettingRef, _: &RequestEnv) -> Option<Option<Val>> {
        None
    }
    fn transcript(&self, _: &Json, _: Fact) -> Option<Option<Val>> {
        None
    }
}

/// Everything a predicate reads on one occurrence.
pub struct Ctx<'a> {
    /// The hook payload.
    pub payload: &'a Json,
    /// The tool the host matched on (`--tool`), standing in for the payload's `tool_name`.
    pub tool: Option<&'a str>,
    /// The request environment.
    pub env: &'a RequestEnv,
    /// The session the payload names (`-` when none).
    pub session_id: &'a str,
    /// The session store of the evaluating process, when it keeps state across calls (the daemon, or `dispatch.in_process`).
    pub sessions: Option<&'a SessionStore>,
    /// The loaded settings and the transcript index.
    pub facts: &'a dyn Facts,
}

/// `Facts` over a loaded `settings.json`, the engine's resolved settings and (optionally) one transcript index.
pub struct LoadedFacts<'a> {
    /// `settings.json` as loaded (`Null` when absent).
    pub settings: &'a Json,
    /// The engine's resolved settings.
    pub effective: &'a crate::cfgstore::Effective,
    /// The index of the payload's transcript, when the evaluating process has one.
    pub index: Option<&'a Index>,
}

impl Facts for LoadedFacts<'_> {
    fn setting(&self, r: &SettingRef, env: &RequestEnv) -> Option<Option<Val>> {
        Some(match r {
            SettingRef::Engine(k) => self.effective.get(k).and_then(|x| Val::from_json(&x.value)),
            SettingRef::Switch(entry) => Some(Val::Bool(switch_value(entry, env, self.settings))),
        })
    }

    fn transcript(&self, _: &Json, f: Fact) -> Option<Option<Val>> {
        self.index.map(|ix| Some(f.read(ix)))
    }
}

/// A shipped boolean switch resolved against the request environment, then the loaded `settings.json`, then its default
/// (the Node chain `hooks/lib/settings.js` `get` without the plugin-option tier, which is not part of the loaded settings).
pub fn switch_value(entry: &V, env: &RequestEnv, settings: &Json) -> bool {
    use crate::checks::guardkit::settings::{coerce_json, token};
    let env_name = entry.str_field("env");
    if !env_name.is_empty() {
        let names = std::iter::once(env_name).chain(entry.get("aliases").map(V::strings).unwrap_or_default());
        for n in names {
            if let Some(b) = env.get(n).and_then(token) {
                return b;
            }
        }
    }
    let (section, key) = (entry.str_field("section"), entry.str_field("key"));
    settings
        .get(section)
        .and_then(Json::as_object)
        .and_then(|s| s.get(key))
        .and_then(coerce_json)
        .unwrap_or_else(|| entry.get("default").and_then(V::as_bool).unwrap_or(false))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ok(v: Json) -> When {
        When::parse(&v).unwrap_or_else(|e| panic!("{e}"))
    }

    fn eval_with(w: &When, payload: &Json, env: &RequestEnv, facts: &dyn Facts, sessions: Option<&SessionStore>) -> Option<bool> {
        w.eval(&Ctx { payload, tool: None, env, session_id: "s1", sessions, facts })
    }

    fn eval(w: &When, payload: &Json) -> Option<bool> {
        eval_with(w, payload, &RequestEnv::default(), &NoFacts, None)
    }

    #[test]
    fn tool_and_field_conditions_read_the_payload() {
        let p = json!({"tool_name": "Bash", "tool_input": {"command": "git push origin main", "file_path": "/repo/src/a/b.rs"}});
        assert_eq!(eval(&ok(json!({"tool": "Bash"})), &p), Some(true));
        assert_eq!(eval(&ok(json!({"tool": ["Edit", "Write"]})), &p), Some(false));
        assert_eq!(eval(&ok(json!({"field": "/tool_input/command", "regex": "^git (push|pull)"})), &p), Some(true));
        assert_eq!(eval(&ok(json!({"field": "/tool_input/command", "equals": "git push"})), &p), Some(false));
        assert_eq!(eval(&ok(json!({"field": "/tool_input/file_path", "glob": "/repo/**/*.rs"})), &p), Some(true));
        assert_eq!(eval(&ok(json!({"field": "/tool_input/file_path", "glob": "/repo/*.rs"})), &p), Some(false), "* stays within a segment");
        assert_eq!(eval(&ok(json!({"field": "/tool_input/command", "in": ["ls", "git push origin main"]})), &p), Some(true));
        assert_eq!(eval(&ok(json!({"field": "/tool_input/missing", "exists": false})), &p), Some(true));
        assert_eq!(eval(&ok(json!({"field": "/tool_input/command", "exists": true})), &p), Some(true));
    }

    #[test]
    fn the_tool_argument_stands_in_for_the_payloads_tool_name() {
        let w = ok(json!({"tool": "Agent"}));
        let p = json!({"tool_name": "Bash"});
        let cx = Ctx { payload: &p, tool: Some("Agent"), env: &RequestEnv::default(), session_id: "s", sessions: None, facts: &NoFacts };
        assert_eq!(w.eval(&cx), Some(true));
    }

    #[test]
    fn numbers_compare_as_integers_and_as_text() {
        let p = json!({"n": 7, "s": "7", "b": true});
        assert_eq!(eval(&ok(json!({"field": "/n", "at_least": 7})), &p), Some(true));
        assert_eq!(eval(&ok(json!({"field": "/s", "at_most": 6})), &p), Some(false), "a numeric string reads as a number");
        assert_eq!(eval(&ok(json!({"field": "/n", "equals": "7"})), &p), Some(true));
        assert_eq!(eval(&ok(json!({"field": "/b", "equals": true})), &p), Some(true));
    }

    #[test]
    fn env_conditions_read_the_request_environment_only() {
        let env = RequestEnv::from_pairs([("DEVSWARM_REPO_ID", "abc"), ("SECRET", "x")]);
        let p = json!({});
        let set = ok(json!({"env": "DEVSWARM_REPO_ID"}));
        assert_eq!(eval_with(&set, &p, &env, &NoFacts, None), Some(true));
        assert_eq!(eval_with(&set, &p, &RequestEnv::default(), &NoFacts, None), Some(false));
        assert_eq!(eval_with(&ok(json!({"env": "DEVSWARM_REPO_ID", "equals": "abc"})), &p, &env, &NoFacts, None), Some(true));
        assert_eq!(eval_with(&ok(json!({"env": "DEVSWARM_REPO_ID", "regex": "^z"})), &p, &env, &NoFacts, None), Some(false));
        let e = When::parse(&json!({"env": "SECRET"})).unwrap_err();
        assert!(e.0.contains("request_env.allow"), "a variable the request never carries is a config error: {e}");
    }

    #[test]
    fn combinators_are_three_valued_and_an_unknown_predicate_applies_the_entry() {
        let p = json!({"tool_name": "Bash"});
        let unknown = json!({"transcript": "unresolved_agents", "at_least": 1});
        let yes = json!({"tool": "Bash"});
        let no = json!({"tool": "Edit"});
        assert_eq!(eval(&ok(unknown.clone()), &p), None);
        assert_eq!(eval(&ok(json!({"all": [yes, unknown]})), &p), None);
        assert_eq!(eval(&ok(json!({"all": [no, unknown]})), &p), Some(false), "a false part decides an all");
        assert_eq!(eval(&ok(json!({"any": [yes, unknown]})), &p), Some(true), "a true part decides an any");
        assert_eq!(eval(&ok(json!({"any": [no, unknown]})), &p), None);
        assert_eq!(eval(&ok(json!({"not": no})), &p), Some(true));
        assert_eq!(eval(&ok(json!({"not": unknown})), &p), None);
    }

    #[test]
    fn setting_conditions_read_the_loaded_settings_with_the_switch_default() {
        let loaded = crate::cfgstore::Effective::defaults();
        let w = ok(json!({"setting": "guards.shipitGate"}));
        let off = json!(null);
        let on = json!({"guards": {"shipitGate": true}});
        let p = json!({});
        let env = RequestEnv::default();
        fn f<'a>(s: &'a Json, e: &'a crate::cfgstore::Effective) -> LoadedFacts<'a> {
            LoadedFacts { settings: s, effective: e, index: None }
        }
        assert_eq!(eval_with(&w, &p, &env, &f(&off, &loaded), None), Some(false), "the switch's default is off");
        assert_eq!(eval_with(&w, &p, &env, &f(&on, &loaded), None), Some(true));
        let env_on = RequestEnv::from_pairs([("ANTIHALL_SHIPIT_GATE", "1")]);
        assert_eq!(eval_with(&w, &p, &env_on, &f(&off, &loaded), None), Some(true), "the request environment outranks the file, as in Node");
        assert_eq!(eval_with(&w, &p, &env, &NoFacts, None), None, "no loaded settings: unknown");
        assert_eq!(eval_with(&ok(json!({"setting": "daemon.queue", "at_least": 1})), &p, &env, &f(&off, &loaded), None), Some(true), "an engine setting");
        assert!(When::parse(&json!({"setting": "guards.noSuchThing"})).is_err());
    }

    #[test]
    fn transcript_conditions_read_only_the_facts_the_index_computes() {
        assert!(When::parse(&json!({"transcript": "unresolved_agents", "at_least": 1})).is_ok());
        let e = When::parse(&json!({"transcript": "tool_use_count", "at_least": 1})).unwrap_err();
        assert!(e.0.contains("unresolved_agents"), "{e}");
        for (name, _) in defaults::raw("hooks.transcript_facts").as_table().unwrap() {
            assert!(Fact::parse(name).is_some(), "every shipped fact name has a reader: {name}");
        }
    }

    #[test]
    fn unknown_or_malformed_conditions_are_errors() {
        for bad in [
            json!({}),
            json!({"bogus": 1}),
            json!({"tool": "Bash", "env": "HOME"}),
            json!({"field": "no-slash", "equals": 1}),
            json!({"field": "/x"}),
            json!({"field": "/x", "equals": 1, "regex": "a"}),
            json!({"field": "/x", "regex": "("}),
            json!({"all": []}),
            json!({"all": [{"tool": "A"}], "any": [{"tool": "B"}]}),
            json!({"not": {"tool": "A"}, "tool": "B"}),
            json!({"field": "/x", "at_least": "many"}),
            json!({"session": "n"}),
            json!({"session": "n", "first": true, "every": 3}),
            json!({"session": "n", "every": 0}),
            json!("tool"),
        ] {
            assert!(When::parse(&bad).is_err(), "{bad} must be rejected");
        }
        let mut deep = json!({"tool": "A"});
        for _ in 0..defaults::num("hooks.when_max_depth") {
            deep = json!({"not": deep});
        }
        assert!(When::parse(&deep).is_err(), "nesting is bounded");
    }

    #[test]
    fn a_session_condition_is_unknown_without_a_store_and_counts_with_one() {
        let p = json!({});
        let first = ok(json!({"session": "welcome", "first": true}));
        assert!(first.needs_session());
        assert_eq!(eval(&first, &p), None, "a process that keeps no state cannot dedupe");
        let store = SessionStore::new();
        let ev = |w: &When, sid: &str| {
            w.eval(&Ctx { payload: &p, tool: None, env: &RequestEnv::default(), session_id: sid, sessions: Some(&store), facts: &NoFacts })
        };
        assert_eq!((ev(&first, "a"), ev(&first, "a"), ev(&first, "b")), (Some(true), Some(false), Some(true)));
        let every = ok(json!({"session": "nag", "every": 3}));
        let seq: Vec<_> = (0..7).map(|_| ev(&every, "a").unwrap()).collect();
        assert_eq!(seq, [true, false, false, true, false, false, true]);
        let atl = ok(json!({"session": "n3", "at_least": 3}));
        let seq: Vec<_> = (0..4).map(|_| ev(&atl, "a").unwrap()).collect();
        assert_eq!(seq, [false, false, true, true]);
    }

    #[test]
    fn a_transcript_condition_reads_the_index_and_flips_with_its_facts() {
        // two agents a compaction re-injected as live; one then reports a terminal status: one stays unresolved
        let dir = std::env::temp_dir().join(format!("ah-when-transcript-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.jsonl");
        let ts = "2026-10-04T10:00:00.000Z";
        let live = |id: &str| json!({"type": "attachment", "attachment": {"type": "task_status", "taskId": id, "taskType": "local_agent", "description": "d", "status": "running", "outputFilePath": "/tmp/o"}, "timestamp": ts});
        let note = json!({"type": "user", "message": {"role": "user", "content": "<task-notification>\n<task-id>agentaaaaaaaaaaa1</task-id>\n<tool-use-id>toolu_01</tool-use-id>\n<status>completed</status>\n</task-notification>"}, "timestamp": ts});
        let lines = [
            live("agentaaaaaaaaaaa1"),
            live("agentbbbbbbbbbbb2"),
            note,
            json!({"type": "user", "message": {"role": "user", "content": "hello"}, "timestamp": ts}),
        ];
        std::fs::write(&path, lines.iter().map(|l| l.to_string() + "\n").collect::<String>()).unwrap();
        let mut ix = Index::new(&path);
        ix.refresh().unwrap();
        let loaded = crate::cfgstore::Effective::defaults();
        let none = json!(null);
        let facts = LoadedFacts { settings: &none, effective: &loaded, index: Some(&ix) };
        let p = json!({});
        let at = |fact: &str, op: Json| {
            let mut o = serde_json::Map::new();
            o.insert("transcript".into(), json!(fact));
            o.extend(op.as_object().unwrap().clone());
            eval_with(&ok(Json::Object(o)), &p, &RequestEnv::default(), &facts, None)
        };
        assert_eq!(at("unresolved_agents", json!({"at_least": 1})), Some(true), "agent b never reported");
        assert_eq!(at("unresolved_agents", json!({"at_least": 2})), Some(false), "agent a did");
        assert_eq!(at("terminal_agents", json!({"equals": 1})), Some(true));
        assert_eq!(at("has_last_prompt", json!({"equals": true})), Some(true));
        assert_eq!(at("records", json!({"at_least": 4})), Some(true));
        assert_eq!(at("last_tool", json!({"exists": true})), Some(true));
        assert_eq!(at("compact_boundaries", json!({"at_least": 1})), Some(false));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn glob_semantics() {
        assert!(glob_match("*.rs", "a.rs") && !glob_match("*.rs", "d/a.rs"));
        assert!(glob_match("**/*.rs", "d/e/a.rs") && glob_match("src/**", "src/a/b"));
        assert!(glob_match("a?c", "abc") && !glob_match("a?c", "a/c"));
        assert!(glob_match("exact", "exact") && !glob_match("exact", "exactly"));
    }

    #[test]
    fn a_table_predicate_round_trips_from_toml_values() {
        let t: toml::Table = r#"when = { all = [ { tool = "Bash" }, { not = { env = "DEVSWARM_REPO_ID" } } ] }"#.parse().unwrap();
        let j = serde_json::to_value(t["when"].clone()).unwrap();
        assert!(matches!(When::parse(&j), Ok(When::All(_))));
    }
}
