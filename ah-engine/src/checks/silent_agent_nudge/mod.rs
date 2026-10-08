//! Built-in `check = "silent-agent-nudge"`: the Stop hook that nudges once when a background agent has gone quiet.
//!
//! The whole hook is ported, the nudge included: read the transcript tail, find the agents launched and not finished (with
//! `agent_scan`), judge each by the newest of its output file, its sidechain transcript and its resume, add the heartbeat
//! files of this session's own subagents, then compare with the state file. A silent agent not yet nudged for this snapshot
//! and not covered by the once-per-agent cap is nudged: the state is written (the bytes the Node hook writes) and the Stop is
//! blocked with the hook's text, unless the host already registered a newer plugin version than the one running
//! (`stop-version-gate`: nothing said, nothing written) or this exact set of agents was acked for the session (`stop-ack`:
//! state written, nothing said). When every silent agent was already nudged, the state is rewritten pruned to the agents
//! still live and nothing is said.
//!
//! Differences from the Node hook (deliberate): the slow-run diagnostics line the Node hook writes to the central log for a
//! transcript over 8 MB is not written (the engine records its own latency). These defer to Node: a transcript the scan
//! cannot read exactly as JavaScript would, a state, registry, manifest or ack file whose bytes this cannot reproduce (a list
//! member, a number-like key, a lone surrogate), a request without `HOME`, a nudge whose name `oneLine` would cut through a
//! surrogate pair (JavaScript prints the lone half), and a nudge when the request does not name the plugin root (the
//! stale-build check compares against the running plugin's own manifest).
//!
//! Mirrors `hooks/silent-agent-nudge.js`.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - serializing a string cannot fail
// A failure that must be seen goes through `crate::discard` instead.

use crate::checks::agent_scan::{self, Opts, Unsupported, mtime_ms};
use crate::checks::git::util::Settings;
use crate::checks::guardkit::msg::{self, Kind, Parts};
use crate::checks::guardkit::settings::{get_bool, get_number, is_skipped, plugin_root};
use crate::checks::guardkit::text::{collapse_ws, js_trim, js_trim_end, slice_utf16};
use crate::checks::jsport::num::to_js_string;
use crate::checks::jsport::text::cmp16;
use crate::checks::{Check, Exact, Verdict};
use crate::defaults;
use crate::reqenv::RequestEnv;
use crate::rules::Subject;
use serde::de::{Deserializer, MapAccess, Visitor};
use serde_json::Value;
use std::collections::HashSet;

pub(crate) mod stopgate;
#[cfg(test)]
mod tests;

/// One snapshot that is silent past the threshold.
#[derive(Debug, Clone, PartialEq)]
pub struct Candidate {
    /// The state key: `t:<id>` for the transcript, `h:<id>` for a heartbeat.
    pub key: String,
    /// The agent id.
    pub id: String,
    /// The resume time the cap is keyed by, 0 when it was never resumed.
    pub resumed_at_ms: f64,
    /// What the nudge is deduplicated on: the output file mtime or `missing`, plus the resume; a heartbeat's time.
    pub snapshot: String,
    /// The text the nudge names it by before `oneLine`: the launch description, the heartbeat step, or the id.
    pub label_src: String,
    /// Milliseconds since its latest sign of life.
    pub age: f64,
}

/// A JSON object's members in file order: a JavaScript object keeps insertion order, which the rewritten file shows.
#[derive(Default, Debug, Clone, PartialEq)]
pub struct Pairs(pub Vec<(String, Value)>);

impl Pairs {
    fn get(&self, k: &str) -> Option<&Value> {
        self.0.iter().find(|(n, _)| n == k).map(|(_, v)| v)
    }
    /// `obj[k] = v`: an existing key keeps its place.
    fn set(&mut self, k: &str, v: Value) {
        match self.0.iter_mut().find(|(n, _)| n == k) {
            Some(slot) => slot.1 = v,
            None => self.0.push((k.to_string(), v)),
        }
    }
}

impl<'de> serde::Deserialize<'de> for Pairs {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Pairs, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Pairs;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(defaults::text("silent_nudge.expecting"))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut m: A) -> Result<Pairs, A::Error> {
                let mut out = Pairs::default();
                while let Some((k, v)) = m.next_entry::<String, Value>()? {
                    out.set(&k, v);
                }
                Ok(out)
            }
        }
        d.deserialize_map(V)
    }
}

/// One member of the state file as the hook reads it.
enum Member {
    Absent,
    Object(Pairs),
    /// A list: JavaScript reads its indices as keys, which this cannot reproduce.
    List,
}

impl<'de> serde::Deserialize<'de> for Member {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Member, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Member;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(defaults::text("silent_nudge.expecting"))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut m: A) -> Result<Member, A::Error> {
                let mut out = Pairs::default();
                while let Some((k, v)) = m.next_entry::<String, Value>()? {
                    out.set(&k, v);
                }
                Ok(Member::Object(out))
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut s: A) -> Result<Member, A::Error> {
                while s.next_element::<serde::de::IgnoredAny>()?.is_some() {}
                Ok(Member::List)
            }
            fn visit_bool<E>(self, _: bool) -> Result<Member, E> {
                Ok(Member::Absent)
            }
            fn visit_i64<E>(self, _: i64) -> Result<Member, E> {
                Ok(Member::Absent)
            }
            fn visit_u64<E>(self, _: u64) -> Result<Member, E> {
                Ok(Member::Absent)
            }
            fn visit_f64<E>(self, _: f64) -> Result<Member, E> {
                Ok(Member::Absent)
            }
            fn visit_str<E>(self, _: &str) -> Result<Member, E> {
                Ok(Member::Absent)
            }
            fn visit_unit<E>(self) -> Result<Member, E> {
                Ok(Member::Absent)
            }
        }
        d.deserialize_any(V)
    }
}

/// The state file's two members.
struct Top {
    nudged: Member,
    ever: Member,
}

impl<'de> serde::Deserialize<'de> for Top {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Top, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Top;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(defaults::text("silent_nudge.expecting"))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut m: A) -> Result<Top, A::Error> {
                let (mut nudged, mut ever) = (Member::Absent, Member::Absent);
                while let Some(k) = m.next_key::<String>()? {
                    if k == defaults::text("silent_nudge.nudged_key") {
                        nudged = m.next_value::<Member>()?;
                    } else if k == defaults::text("silent_nudge.ever_key") {
                        ever = m.next_value::<Member>()?;
                    } else {
                        m.next_value::<serde::de::IgnoredAny>()?;
                    }
                }
                Ok(Top { nudged, ever })
            }
        }
        d.deserialize_map(V)
    }
}

/// The nudge state: the per-snapshot records and the once-per-agent records.
#[derive(Default, Debug, PartialEq)]
pub struct State {
    /// `nudged`: key to the snapshot last nudged.
    pub nudged: Pairs,
    /// `everNudged`: `session::id` to the time it was nudged.
    pub ever: Pairs,
}

/// A key JavaScript would order before every other (an array index): the written order would differ from file order.
fn index_like(k: &str) -> bool {
    !k.is_empty() && k.bytes().all(|b| b.is_ascii_digit()) && (k == "0" || !k.starts_with('0')) && k.parse::<u64>().is_ok_and(|n| n < 4_294_967_295)
}

/// Read the state file as the hook does: anything that is not a JSON object leaves both records empty.
pub fn parse_state(text: &str) -> Result<State, Unsupported> {
    match agent_scan::parse_json(text)? {
        Some(Value::Object(_)) => {}
        _ => return Ok(State::default()),
    }
    let Ok(top) = serde_json::from_str::<Top>(text) else { return Ok(State::default()) };
    let take = |m: Member| -> Result<Pairs, Unsupported> {
        match m {
            Member::Absent => Ok(Pairs::default()),
            Member::List => Err(Unsupported),
            Member::Object(p) if p.0.iter().any(|(k, _)| index_like(k)) => Err(Unsupported),
            Member::Object(p) => Ok(p),
        }
    };
    Ok(State { nudged: take(top.nudged)?, ever: take(top.ever)? })
}

/// `Number(v)` for a state value; NaN when JavaScript gives NaN.
fn js_number_of(v: &Value) -> f64 {
    match v {
        Value::Null => 0.0,
        Value::Bool(b) => f64::from(u8::from(*b)),
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) => js_number_text(s),
        Value::Array(a) => match a.len() {
            0 => 0.0,
            1 => js_number_of(&a[0]),
            _ => f64::NAN,
        },
        Value::Object(_) => f64::NAN,
    }
}

fn js_number_text(s: &str) -> f64 {
    let t = crate::checks::guardkit::text::js_trim(s);
    if t.is_empty() {
        return 0.0;
    }
    crate::checks::guardkit::settings::js_number(t).unwrap_or(f64::NAN)
}

/// `String(n)` of a time: an integer prints without a fraction.
fn num_text(n: f64) -> String {
    if n == n.trunc() && n.abs() < defaults::num("agent_scan.safe_int") as f64 { format!("{}", n as i64) } else { format!("{n}") }
}

/// The text the hook writes: `JSON.stringify({nudged, everNudged})`.
fn render_state(nudged: &Pairs, ever: &[(String, f64)]) -> Result<String, Unsupported> {
    let q = |s: &str| serde_json::to_string(s).unwrap_or_default();
    let mut n = String::new();
    for (i, (k, v)) in nudged.0.iter().enumerate() {
        let Value::String(s) = v else { return Err(Unsupported) };
        if i > 0 {
            n.push(',');
        }
        n.push_str(&format!("{}:{}", q(k), q(s)));
    }
    let mut e = String::new();
    for (i, (k, t)) in ever.iter().enumerate() {
        if i > 0 {
            e.push(',');
        }
        if *t != t.trunc() || t.abs() >= defaults::num("agent_scan.safe_int") as f64 {
            return Err(Unsupported);
        }
        e.push_str(&format!("{}:{}", q(k), num_text(*t)));
    }
    Ok(format!("{{\"{}\":{{{n}}},\"{}\":{{{e}}}}}", defaults::text("silent_nudge.nudged_key"), defaults::text("silent_nudge.ever_key")))
}

fn sidechain_mtime(transcript: &str, id: &str) -> Result<f64, Unsupported> {
    if id.contains('/') || id.contains("..") {
        return Err(Unsupported);
    }
    let dir = format!("{}/{}/{}", agent_scan::dir_of(transcript), agent_scan::base_without_jsonl(transcript), defaults::text("agent_scan.subagents_dir"));
    let file = format!("{dir}/{}{id}{}", defaults::text("silent_nudge.sidechain_file_prefix"), defaults::text("agent_scan.transcript_ext"));
    Ok(mtime_ms(std::path::Path::new(&file)).unwrap_or(f64::NAN))
}

/// `transcriptCandidates(transcriptPath, now, thresholdMs)`.
fn transcript_candidates(transcript: &str, now: f64, threshold: f64) -> Result<Vec<Candidate>, Unsupported> {
    if transcript.is_empty() {
        return Ok(Vec::new());
    }
    let opts = Opts { now_ms: now, ignore_unanswered_stops: false };
    let Some(scan) = agent_scan::scan_transcript(transcript, defaults::num("silent_nudge.scan_bytes"), &opts)? else { return Ok(Vec::new()) };
    let mut out = Vec::new();
    for (id, rec) in scan.launched.iter() {
        if scan.terminal.contains(id) || rec.pending_message {
            continue;
        }
        let mut reference = f64::NAN;
        let mut snapshot = defaults::text("silent_nudge.missing").to_string();
        let mut output_missing = true;
        if !rec.output_file.is_empty() && !rec.output_file.starts_with('/') {
            // Node resolves it against the hook's own directory, which the engine does not share.
            return Err(Unsupported);
        }
        if !rec.output_file.is_empty()
            && let Some(m) = mtime_ms(std::path::Path::new(&rec.output_file))
        {
            reference = m;
            snapshot = format!("{}", m.floor() as i64);
            output_missing = false;
        }
        if output_missing {
            if rec.adopted && !rec.launched_at_ms.is_finite() {
                continue;
            }
            reference = if rec.launched_at_ms.is_finite() { rec.launched_at_ms } else { 0.0 };
            snapshot = defaults::text("silent_nudge.missing").to_string();
        }
        let sc = sidechain_mtime(transcript, id)?;
        if sc.is_finite() && sc > reference {
            reference = sc;
        }
        if rec.last_seen_ms.is_finite() && rec.last_seen_ms > reference {
            reference = rec.last_seen_ms;
        }
        let resumed = rec.resumed_at_ms.filter(|r| r.is_finite()).unwrap_or(0.0);
        if resumed > reference {
            reference = resumed;
        }
        if resumed != 0.0 {
            snapshot = format!("{snapshot}{}{}", defaults::text("silent_nudge.resume_mark"), num_text(resumed));
        }
        if now - reference < threshold {
            continue;
        }
        let label_src = if rec.description.is_empty() { id.clone() } else { rec.description.clone() };
        out.push(Candidate {
            key: format!("{}{id}", defaults::text("silent_nudge.key_transcript")),
            id: id.clone(),
            resumed_at_ms: resumed,
            snapshot,
            label_src,
            age: now - reference,
        });
    }
    Ok(out)
}

/// `heartbeatCandidates(home, now, thresholdMs, sessionId)`.
fn heartbeat_candidates(home: &str, now: f64, threshold: f64, session: &str) -> Result<Vec<Candidate>, Unsupported> {
    let dir = format!("{home}/{}", defaults::text("silent_nudge.agents_dir"));
    let Ok(rd) = std::fs::read_dir(&dir) else { return Ok(Vec::new()) };
    let ext = defaults::text("silent_nudge.heartbeat_ext");
    let mut out = Vec::new();
    // `fs.readdirSync` lists a directory sorted (libuv scandir sorts by name, byte order in the C locale Node runs in).
    let mut entries: Vec<(String, std::path::PathBuf)> = rd.flatten().map(|e| (e.file_name().to_string_lossy().to_string(), e.path())).collect();
    entries.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
    for (f, path) in entries {
        if !f.ends_with(ext) || f == defaults::text("silent_nudge.heartbeat_skip_name") || f.starts_with(defaults::text("silent_nudge.heartbeat_skip_prefix")) {
            continue;
        }
        let Ok(bytes) = std::fs::read(&path) else { continue };
        let text = String::from_utf8_lossy(&bytes);
        let Some(data) = agent_scan::parse_json(&text)? else { continue };
        let (Some(id), Some(status)) = (data.get("id").and_then(Value::as_str).filter(|s| !s.is_empty()), data.get("status").and_then(Value::as_str)) else {
            continue;
        };
        let Some(sess) = data.get("session").and_then(Value::as_str).filter(|s| !s.is_empty()) else { continue };
        if session.is_empty() || sess != session {
            continue;
        }
        let ts = data.get("ts").and_then(Value::as_f64).filter(|t| t.is_finite()).unwrap_or(0.0);
        if ts == 0.0 {
            continue;
        }
        let st = crate::checks::guardkit::text::js_trim(status);
        if defaults::words("silent_nudge.finished_words").iter().any(|w| w.eq_ignore_ascii_case(st)) {
            continue;
        }
        if now - ts < threshold {
            continue;
        }
        if ts != ts.trunc() || ts.abs() >= defaults::num("agent_scan.safe_int") as f64 {
            return Err(Unsupported);
        }
        let step = data.get("step").and_then(Value::as_str).filter(|s| !s.is_empty()).unwrap_or(id);
        out.push(Candidate {
            key: format!("{}{id}", defaults::text("silent_nudge.key_heartbeat")),
            id: id.to_string(),
            resumed_at_ms: 0.0,
            snapshot: num_text(ts),
            label_src: step.to_string(),
            age: now - ts,
        });
    }
    Ok(out)
}

/// The check's decision on one payload.
///
/// Mirrors `hooks/silent-agent-nudge.js` `main`.
pub fn decide(p: &Value, opts: &Value, env: &RequestEnv) -> Verdict {
    if env.get(defaults::text("silent_nudge.judge_child_env")) == Some(defaults::text("silent_nudge.judge_child_value")) {
        return Verdict::Allow;
    }
    let Some(home) = agent_scan::home_dir(env) else { return Verdict::Defer };
    let st = Settings::from_env(env);
    if !get_bool(&st, defaults::raw("silent_nudge.setting")) {
        return Verdict::Allow;
    }
    if is_skipped(&st, defaults::text("silent_nudge.guard_name")) {
        return Verdict::Allow;
    }
    if !p.is_object() && !p.is_array() {
        return Verdict::Allow;
    }
    let session = p.get("session_id").and_then(Value::as_str).unwrap_or("");
    let mut minutes = get_number(&st, defaults::raw("silent_nudge.min_setting"));
    if !minutes.is_finite() || minutes < 1.0 {
        minutes = defaults::num("silent_nudge.min_default") as f64;
    }
    let threshold = minutes * 60_000.0;
    let now = agent_scan::now_ms();
    let transcript = p.get("transcript_path").and_then(Value::as_str).unwrap_or("");

    let mut candidates = match transcript_candidates(transcript, now, threshold) {
        Ok(c) => c,
        Err(Unsupported) => return Verdict::Defer,
    };
    match heartbeat_candidates(&home, now, threshold, session) {
        Ok(c) => candidates.extend(c),
        Err(Unsupported) => return Verdict::Defer,
    }
    if candidates.is_empty() {
        return Verdict::Allow;
    }

    let state_path = format!("{home}/{}", defaults::text("silent_nudge.state_file"));
    let state = match std::fs::read_to_string(&state_path) {
        Ok(text) => match parse_state(&text) {
            Ok(s) => s,
            Err(Unsupported) => return Verdict::Defer,
        },
        Err(_) => State::default(),
    };

    let live: HashSet<&str> = candidates.iter().map(|c| c.key.as_str()).collect();
    let stale: Vec<&Candidate> = candidates.iter().filter(|c| state.nudged.get(&c.key).and_then(Value::as_str) != Some(c.snapshot.as_str())).collect();

    let mut next_nudged = Pairs::default();
    for (k, v) in &state.nudged.0 {
        if live.contains(k.as_str()) {
            next_nudged.set(k, v.clone());
        }
    }

    // The once-per-agent cap, with the records older than its TTL dropped.
    let ttl = defaults::num("silent_nudge.ever_nudged_ttl_ms") as f64;
    let mut next_ever: Vec<(String, f64)> = Vec::new();
    for (k, v) in &state.ever.0 {
        let ts = js_number_of(v);
        if ts.is_finite() && now - ts < ttl {
            next_ever.push((k.clone(), ts));
        }
    }
    let ever_key = |c: &Candidate| {
        let resume =
            if c.resumed_at_ms != 0.0 { format!("{}{}", defaults::text("silent_nudge.resume_mark"), num_text(c.resumed_at_ms)) } else { String::new() };
        format!("{session}{}{}{resume}", defaults::text("silent_nudge.ever_sep"), c.id)
    };
    let capped = |c: &&Candidate| !session.is_empty() && next_ever.iter().any(|(k, _)| *k == ever_key(c));
    let to_nudge: Vec<&Candidate> = stale.iter().copied().filter(|c| session.is_empty() || !capped(c)).collect();
    if to_nudge.is_empty() {
        for c in &stale {
            next_nudged.set(&c.key, Value::String(c.snapshot.clone()));
        }
        let Ok(text) = render_state(&next_nudged, &next_ever) else { return Verdict::Defer };
        write_state(&state_path, text);
        return Verdict::Allow;
    }

    // STALE-BUILD DOWNGRADE: a newer version is already registered than the running plugin; say nothing and keep the state
    // as it was, so the once-per-agent cap is not spent on a nudge that was never shown.
    let root = plugin_root(opts, env);
    if root.is_empty() {
        // Node judges this against its own install directory, which the request does not name.
        return Verdict::Defer;
    }
    match stopgate::is_stale(env, &home, &root) {
        Ok(true) => return Verdict::Allow,
        Ok(false) => {}
        Err(Unsupported) => return Verdict::Defer,
    }

    for c in &stale {
        next_nudged.set(&c.key, Value::String(c.snapshot.clone()));
    }
    // One line per agent id, even when the transcript and a heartbeat both report it.
    let mut seen: HashSet<&str> = HashSet::new();
    let shown: Vec<&Candidate> = to_nudge.into_iter().filter(|c| seen.insert(c.id.as_str())).collect();
    if !session.is_empty() {
        for c in &shown {
            let k = ever_key(c);
            match next_ever.iter_mut().find(|(n, _)| *n == k) {
                Some(slot) => slot.1 = now,
                None => next_ever.push((k, now)),
            }
        }
    }
    let Ok(text) = render_state(&next_nudged, &next_ever) else { return Verdict::Defer };

    let max = defaults::num("silent_nudge.label_max") as usize;
    let mut labels = Vec::new();
    for c in &shown {
        match one_line(&c.label_src, max) {
            Ok(l) => labels.push(l),
            Err(Unsupported) => return Verdict::Defer,
        }
    }
    let guard = defaults::text("silent_nudge.guard_name");
    let mut ids: Vec<&str> = shown.iter().map(|c| c.id.as_str()).collect();
    ids.sort_by(|a, b| cmp16(a, b));
    let signature = stopgate::signature_for(&ids.join(defaults::text("silent_nudge.ack_subject_sep")));
    let acked = if session.is_empty() {
        false
    } else {
        match stopgate::is_acked(env, &home, session, guard, &signature) {
            Ok(a) => a,
            Err(Unsupported) => return Verdict::Defer,
        }
    };
    write_state(&state_path, text);
    if acked {
        return Verdict::Allow;
    }

    let named = defaults::num("silent_nudge.max_named") as usize;
    let items: Vec<String> = shown
        .iter()
        .zip(&labels)
        .take(named)
        .map(|(c, l)| msg::render("silent_nudge.msg_item", &[("label", l), ("mins", &to_js_string((c.age / 60_000.0).floor()))]))
        .collect();
    let more = if shown.len() > named { msg::render("silent_nudge.msg_more", &[("n", &(shown.len() - named).to_string())]) } else { String::new() };
    let what = msg::render(
        "silent_nudge.msg_what",
        &[
            ("count", &shown.len().to_string()),
            ("min", &to_js_string(minutes)),
            ("shown", &items.join(defaults::text("silent_nudge.msg_item_sep"))),
            ("more", &more),
        ],
    );
    let them = defaults::text(if shown.len() == 1 { "silent_nudge.pronoun_one" } else { "silent_nudge.pronoun_many" });
    let instead = msg::render("silent_nudge.msg_instead", &[("them", them)]);
    // ackHint stamps its own clock reading, taken after the state was written
    let hint = if session.is_empty() { String::new() } else { stopgate::ack_hint(guard, &signature, &home, session, agent_scan::now_ms()) };
    let extra = [hint.as_str()];
    let reason = msg::message(
        Kind::Block,
        guard,
        &Parts {
            what: &what,
            why: defaults::text("silent_nudge.msg_why"),
            instead: &instead,
            allowed: defaults::text("silent_nudge.msg_allowed"),
            extra: &extra,
            ..Parts::default()
        },
    );
    let out = format!("{{\"decision\":\"block\",\"reason\":{}}}\n", serde_json::to_string(&reason).unwrap_or_default());
    Verdict::Exact(Exact { code: 0, out, err: String::new() })
}

/// `fs.writeFileSync(stateFile, ...)` after `mkdirSync(dirname, { recursive: true })`; a failure is logged, never fatal.
fn write_state(state_path: &str, text: String) {
    crate::discard::logged(
        "silent_nudge_state_write",
        (|| -> std::io::Result<()> {
            if let Some(d) = std::path::Path::new(state_path).parent() {
                std::fs::create_dir_all(d)?;
            }
            std::fs::write(state_path, text)
        })(),
    );
}

/// `oneLine(s, max)`: control characters and white space runs become one space, and a text past `max` UTF-16 units is cut.
/// A cut through a surrogate pair leaves a lone half in JavaScript, which this cannot reproduce.
fn one_line(s: &str, max: usize) -> Result<String, Unsupported> {
    static R: crate::defaults::Cache<regex::Regex> = crate::defaults::Cache::new();
    let re = R.get_or_init(|| crate::checks::lit_re(defaults::text("silent_nudge.control_re")));
    let spaced = re.replace_all(s, " ");
    let o = js_trim(&collapse_ws(&spaced)).to_string();
    if agent_scan::utf16_len(&o) > max {
        let cut = slice_utf16(&o, max).ok_or(Unsupported)?;
        return Ok(format!("{}{}", js_trim_end(&cut), defaults::text("silent_nudge.ellipsis")));
    }
    Ok(o)
}

/// The registered `silent-agent-nudge` check.
pub struct SilentAgentNudge;

impl Check for SilentAgentNudge {
    fn name(&self) -> &'static str {
        "silent-agent-nudge"
    }

    fn summary(&self) -> &'static str {
        defaults::text("silent_nudge.summary")
    }

    fn run(&self, _s: &Subject<'_>, _opts: &Value) -> Option<Verdict> {
        Some(Verdict::Defer)
    }

    fn run_env(&self, _s: &Subject<'_>, payload: &Value, opts: &Value, env: &RequestEnv) -> Option<Verdict> {
        Some(decide(payload, opts, env))
    }
}
