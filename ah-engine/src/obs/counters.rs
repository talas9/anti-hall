//! Per-site hand-back counters and the uniform duty / stage accounting.
//!
//! Two kinds of count share one store:
//!
//! * the hand-back counters (`stand_in`: the native path could not model a case exactly, logged it and went on; `abandoned`: it could not
//!   decide and dropped the decision; `native_unable`: the name both had before they were split, only read from old journals; `fallback_intent`: a fall back
//!   to Node was decided; `node_launch`: a Node process was actually started), each keyed by a stable site id;
//! * the accounting of every duty and post-update stage: calls, CPU, wall time and one of five outcomes (`ok`, `error`,
//!   `disabled`, `held`, `refused`).
//!
//! Inside the daemon a count goes to an in-memory table. Every other process (a hook call, a one-shot command, the post-update
//! stages) appends one line to the shared journal in the state directory, whether or not the command is read-only: the journal is
//! the only place those processes can leave a count, and it is never created on a command's behalf (a state directory that does
//! not exist means no engine ever ran there). `status` folds the journal and the daemon's table into `node_handback` and
//! `accounting`. The journal is folded in place (one line per counter, under an exclusive lock) when it passes
//! `diagnostics.counters_max_bytes`, and the number of distinct counters is bounded by a soft and a hard limit.
//!
//! Journal line: `kind TAB name TAB outcome TAB n TAB cpu_us TAB wall_us`, the outcome empty for a hand-back.
use super::trace;
use crate::{defaults, health, paths};
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;
use std::sync::Mutex;

/// What a hand-back counter counts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Handback {
    /// Journal lines of the name before the split into [`Handback::StandIn`] and [`Handback::Abandoned`]; nothing counts it any more.
    NativeUnable,
    /// The native path could not model this input exactly, logged the case and went on with a stand-in value (the decision was still made).
    StandIn,
    /// The native path could not decide this input and dropped the decision (an allow, a held step, a refused verb; nothing was decided).
    Abandoned,
    /// A fall back to Node was decided.
    FallbackIntent,
    /// A Node process was started.
    NodeLaunch,
}

impl Handback {
    /// Every kind, in report order.
    pub fn all() -> [Handback; 5] {
        [Handback::NativeUnable, Handback::StandIn, Handback::Abandoned, Handback::FallbackIntent, Handback::NodeLaunch]
    }

    /// The name used in the journal and in `status --json`.
    pub fn name(self) -> &'static str {
        match self {
            Handback::NativeUnable => "native_unable",
            Handback::StandIn => "stand_in",
            Handback::Abandoned => "abandoned",
            Handback::FallbackIntent => "fallback_intent",
            Handback::NodeLaunch => "node_launch",
        }
    }

    fn parse(s: &str) -> Option<Handback> {
        Handback::all().into_iter().find(|h| h.name() == s)
    }
}

/// How a duty or stage ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// It ran and did its work (or found nothing to do).
    Ok,
    /// It ran and failed.
    Error,
    /// It is switched off: nothing ran, logged and counted.
    Disabled,
    /// An owner-gated operation that was held back.
    Held,
    /// The engine refused to do it (a native kill or rollback with no owner decision).
    Refused,
}

impl Outcome {
    /// Every outcome, in report order.
    pub fn all() -> [Outcome; 5] {
        [Outcome::Ok, Outcome::Error, Outcome::Disabled, Outcome::Held, Outcome::Refused]
    }

    /// The name used in the journal and in `status --json`.
    pub fn name(self) -> &'static str {
        match self {
            Outcome::Ok => "ok",
            Outcome::Error => "error",
            Outcome::Disabled => "disabled",
            Outcome::Held => "held",
            Outcome::Refused => "refused",
        }
    }

    fn parse(s: &str) -> Option<Outcome> {
        Outcome::all().into_iter().find(|o| o.name() == s)
    }
}

/// One counter's totals.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Val {
    /// How many times it was counted.
    pub n: u64,
    /// CPU microseconds spent.
    pub cpu_us: u64,
    /// Wall microseconds spent.
    pub wall_us: u64,
}

/// A counter's identity: kind, site or duty name, outcome (empty for a hand-back).
pub type Key = (String, String, String);

/// A folded journal.
#[derive(Debug, Default)]
pub struct Folded {
    /// The counters.
    pub rows: BTreeMap<Key, Val>,
    /// Counters folded into the `other` key because the hard limit was reached.
    pub dropped: u64,
    /// New counters seen past the soft limit.
    pub soft_hits: u64,
    /// Lines that could not be read.
    pub malformed: u64,
}

impl Folded {
    /// Add `v` under `key`, honouring the soft and hard limits on distinct counters.
    pub fn add(&mut self, key: Key, v: Val, soft: usize, hard: usize, other: &str) {
        let key = if !self.rows.contains_key(&key) && self.rows.len() >= hard {
            self.dropped += v.n;
            (key.0, other.to_string(), key.2)
        } else {
            if !self.rows.contains_key(&key) && self.rows.len() >= soft {
                self.soft_hits += 1;
            }
            key
        };
        let e = self.rows.entry(key).or_default();
        e.n += v.n;
        e.cpu_us += v.cpu_us;
        e.wall_us += v.wall_us;
    }
}

/// The limits the fold honours, read from the shipped settings.
fn limits() -> (usize, usize, &'static str) {
    (
        defaults::num("diagnostics.counters_soft_keys") as usize,
        defaults::num("diagnostics.counters_hard_keys") as usize,
        defaults::text("diagnostics.counters_other_key"),
    )
}

/// Fold journal `text` into one total per counter.
pub fn fold(text: &str, soft: usize, hard: usize, other: &str) -> Folded {
    let mut f = Folded::default();
    for line in text.lines().filter(|l| !l.is_empty()) {
        let mut it = line.split('\t');
        let parsed = (|| {
            let (kind, name, outcome) = (it.next()?, it.next()?, it.next()?);
            let (n, cpu_us, wall_us) = (it.next()?.parse().ok()?, it.next()?.parse().ok()?, it.next()?.parse().ok()?);
            Some(((kind.to_string(), name.to_string(), outcome.to_string()), Val { n, cpu_us, wall_us }))
        })();
        match parsed {
            Some((k, v)) => f.add(k, v, soft, hard, other),
            None => f.malformed += 1,
        }
    }
    f
}

fn line_of(k: &Key, v: &Val) -> String {
    format!("{}\t{}\t{}\t{}\t{}\t{}\n", k.0, k.1, k.2, v.n, v.cpu_us, v.wall_us)
}

/// A site or duty name safe for the journal: whitespace and control characters become `_`, cut to `diagnostics.counter_name_max`.
fn clean(s: &str) -> String {
    let max = defaults::num("diagnostics.counter_name_max") as usize;
    let c: String = s.chars().take(max).map(|c| if c.is_control() || c.is_whitespace() { '_' } else { c }).collect();
    if c.is_empty() { "_".to_string() } else { c }
}

fn lock_file(journal: &Path) -> std::io::Result<std::fs::File> {
    std::fs::OpenOptions::new().create(true).truncate(false).read(true).write(true).mode(0o600).open(paths::lock_for(journal))
}

/// Append `line` to `journal` under the shared lock; fold the journal when it has passed `max_bytes`. A missing directory is not
/// an error (nothing is created on a read-only command's behalf).
pub fn append_to(journal: &Path, line: &str, max_bytes: u64) -> std::io::Result<()> {
    if journal.parent().is_some_and(|d| !d.is_dir()) {
        return Ok(());
    }
    let lock = lock_file(journal)?;
    if !health::flock(&lock, libc::LOCK_SH) {
        return Err(std::io::Error::last_os_error());
    }
    let mut f = std::fs::OpenOptions::new().create(true).append(true).mode(0o600).open(journal)?;
    f.write_all(line.as_bytes())?;
    let len = f.metadata()?.len();
    drop(lock);
    if len > max_bytes {
        compact(journal)?;
    }
    Ok(())
}

/// Fold `journal` into one line per counter, atomically, under the exclusive lock. Another process already folding leaves the work
/// to it.
pub fn compact(journal: &Path) -> std::io::Result<()> {
    let lock = lock_file(journal)?;
    if !health::flock(&lock, libc::LOCK_EX | libc::LOCK_NB) {
        return Ok(());
    }
    let mut text = String::new();
    std::fs::File::open(journal)?.read_to_string(&mut text)?;
    let (soft, hard, other) = limits();
    let f = fold(&text, soft, hard, other);
    let out: String = f.rows.iter().map(|(k, v)| line_of(k, v)).collect();
    crate::atomic::write(journal, out)
}

/// The journal's totals (empty when it does not exist or cannot be read).
pub fn read_journal(journal: &Path) -> Folded {
    let (soft, hard, other) = limits();
    let Ok(mut f) = std::fs::File::open(journal) else { return Folded::default() };
    let mut text = String::new();
    if f.read_to_string(&mut text).is_err() {
        return Folded::default();
    }
    fold(&text, soft, hard, other)
}

fn journal_path() -> std::path::PathBuf {
    paths::dir().join(defaults::text("diagnostics.counters_file"))
}

/// The daemon's own counters (the daemon never writes the journal).
static MEM: Mutex<Option<Folded>> = Mutex::new(None);

fn note(kind: &str, name: &str, outcome: &str, v: Val) {
    let key = (kind.to_string(), clean(name), outcome.to_string());
    if crate::telemetry::emit::in_daemon() {
        let (soft, hard, other) = limits();
        MEM.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(Folded::default).add(key, v, soft, hard, other);
        return;
    }
    if let Err(e) = append_to(&journal_path(), &line_of(&key, &v), defaults::num("diagnostics.counters_max_bytes")) {
        health::log_event("obs", "counter", &defaults::render("msg.obs_counter_write_failed", &[("err", &e)]));
    }
}

/// Count one hand-back at `site` (a stable id such as `dispatch.git-guard`), and note it in the trace ring.
pub fn handback(kind: Handback, site: &str) {
    handback_why(kind, site, "");
}

/// Per abandoned site and reason: when its last event-log line was written and how many were counted since. Bounded: it is emptied
/// at `diagnostics.abandoned_log_keys_max` entries.
static LOGGED: Mutex<Option<BTreeMap<String, (u64, u64)>>> = Mutex::new(None);

/// [`handback`] with the reason and the key inputs of the decision. An abandoned decision is also written to the event log, at most
/// one line per site and reason per `diagnostics.abandoned_log_interval_ms` (the line says how many were counted since the last), so
/// a counter that grows always has a line that says why.
pub fn handback_why(kind: Handback, site: &str, why: &str) {
    trace::push(kind.name(), site, "", 0);
    note(kind.name(), site, "", Val { n: 1, ..Val::default() });
    if kind != Handback::Abandoned {
        return;
    }
    let (now, every) = (health::now_ms(), defaults::num("diagnostics.abandoned_log_interval_ms"));
    let n = {
        let mut g = LOGGED.lock().unwrap_or_else(|e| e.into_inner());
        let m = g.get_or_insert_with(BTreeMap::new);
        if m.len() >= defaults::num("diagnostics.abandoned_log_keys_max") as usize {
            m.clear();
        }
        let e = m.entry(format!("{site}\u{0}{why}")).or_insert((0, 0));
        e.1 += 1;
        if e.0 != 0 && now.saturating_sub(e.0) < every {
            return;
        }
        let n = e.1;
        *e = (now, 0);
        n
    };
    let why = if why.is_empty() { defaults::text("diagnostics.abandoned_no_reason") } else { why };
    health::log_event("abandoned", site, &defaults::render("diagnostics.msg_abandoned", &[("site", &site), ("n", &n), ("why", &why)]));
}

/// Count one advisory event (`flagged`, `asked`, `confirmed`, `injected`, `suppressed`, `jev_error`) of advisory `kind`; the report
/// keeps them under `advisory`, per kind.
pub fn advisory(kind: &str, metric: &str) {
    trace::push("advisory", &format!("{kind}.{metric}"), "", 0);
    note(defaults::text("diagnostics.advisory_counter_kind"), kind, metric, Val { n: 1, ..Val::default() });
}

/// Count one run of the duty or stage `name` of `kind` (`duty` or `stage`) with its outcome, CPU and wall time.
pub fn account(kind: &'static str, name: &str, outcome: Outcome, cpu_us: u64, wall_us: u64) {
    trace::push(kind, name, outcome.name(), wall_us);
    note(kind, name, outcome.name(), Val { n: 1, cpu_us, wall_us });
}

/// The accounting outcome of a record's own outcome word (`gate` is true when the record names a gate that skipped it). The map is
/// `diagnostics.outcome_map`; a word it does not list counts as an error so a new outcome cannot hide.
pub fn classify(word: &str, gate: bool) -> Outcome {
    let map = defaults::raw("diagnostics.outcome_map");
    let gated = format!("{word}+gate");
    let key = if gate { gated.as_str() } else { word };
    let mapped = map.get(key).or_else(|| map.get(word)).and_then(|v| v.as_str());
    mapped.and_then(Outcome::parse).unwrap_or(Outcome::Error)
}

/// [`account`] for a duty or stage record: its `outcome` (and `gate`) fields give the outcome.
pub fn account_record(kind: &'static str, name: &str, rec: &Value, cpu_us: u64, wall_us: u64) {
    let word = rec.get("outcome").and_then(Value::as_str).unwrap_or_default();
    let gate = rec.get("gate").and_then(Value::as_str).is_some_and(|g| !g.is_empty());
    account(kind, name, classify(word, gate), cpu_us, wall_us);
}

/// The report of folded counters: `node_handback` (totals per kind plus a per-site breakdown) and `accounting` (per kind and name).
pub fn report(f: &Folded) -> Value {
    let mut totals: BTreeMap<&str, u64> = BTreeMap::new();
    let mut sites: BTreeMap<&str, Map<String, Value>> = BTreeMap::new();
    let mut acct: BTreeMap<&str, BTreeMap<&str, Map<String, Value>>> = BTreeMap::new();
    let mut adv: BTreeMap<&str, Map<String, Value>> = BTreeMap::new();
    for ((kind, name, outcome), v) in &f.rows {
        if kind == defaults::text("diagnostics.advisory_counter_kind") {
            let e = adv.entry(name).or_default();
            let cur = e.get(outcome.as_str()).and_then(Value::as_u64).unwrap_or(0);
            e.insert(outcome.clone(), json!(cur + v.n));
            continue;
        }
        if let Some(h) = Handback::parse(kind) {
            *totals.entry(h.name()).or_default() += v.n;
            sites.entry(name).or_default().insert(h.name().to_string(), json!(v.n));
            continue;
        }
        let e = acct.entry(kind).or_default().entry(name).or_default();
        let adds = [("calls", v.n), ("cpu_ms", v.cpu_us / 1000), ("wall_ms", v.wall_us / 1000)];
        for (k, add) in adds {
            let cur = e.get(k).and_then(Value::as_u64).unwrap_or(0);
            e.insert(k.to_string(), json!(cur + add));
        }
        for o in Outcome::all() {
            let cur = e.get(o.name()).and_then(Value::as_u64).unwrap_or(0);
            e.insert(o.name().to_string(), json!(cur + if o.name() == outcome { v.n } else { 0 }));
        }
    }
    let mut hb = Map::new();
    for h in Handback::all() {
        hb.insert(h.name().to_string(), json!(totals.get(h.name()).copied().unwrap_or(0)));
    }
    hb.insert("sites".into(), json!(sites));
    json!({
        "node_handback": hb,
        "accounting": acct,
        "advisory": adv,
        "counters": {"dropped": f.dropped, "soft_hits": f.soft_hits, "malformed": f.malformed},
    })
}

/// Everything counted so far: the journal's totals plus this process's own table (the daemon's).
pub fn snapshot() -> Value {
    let mut all = read_journal(&journal_path());
    let (soft, hard, other) = limits();
    if let Some(own) = MEM.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
        for (k, v) in &own.rows {
            all.add(k.clone(), *v, soft, hard, other);
        }
        all.dropped += own.dropped;
        all.soft_hits += own.soft_hits;
    }
    report(&all)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counters_are_keyed_by_kind_site_and_outcome_and_the_fold_is_bounded() {
        let text = "node_launch\tdispatch.a\t\t1\t0\t0\nnode_launch\tdispatch.a\t\t2\t0\t0\nnode_launch\tdispatch.b\t\t1\t0\t0\n\
                    duty\treconcile\tok\t1\t5000\t9000\nduty\treconcile\terror\t1\t1000\t2000\nbroken line\n";
        let f = fold(text, 2, 3, "other");
        assert_eq!(f.rows[&("node_launch".into(), "dispatch.a".into(), String::new())].n, 3, "same kind+site adds up");
        assert_eq!(f.rows[&("node_launch".into(), "dispatch.b".into(), String::new())].n, 1, "another site is its own counter");
        assert_eq!(f.malformed, 1);
        assert_eq!(f.soft_hits, 1, "the third distinct counter is past the soft limit of two");
        assert_eq!(f.dropped, 1, "the fourth is past the hard limit of three and folds into other");
        assert_eq!(f.rows[&("duty".into(), "other".into(), "error".into())].n, 1);
        let r = report(&fold(text, 99, 99, "other"));
        assert_eq!(r["node_handback"]["node_launch"], 4);
        assert_eq!(r["node_handback"]["sites"]["dispatch.a"]["node_launch"], 3);
        assert_eq!(r["accounting"]["duty"]["reconcile"]["calls"], 2);
        assert_eq!(r["accounting"]["duty"]["reconcile"]["error"], 1);
        assert_eq!(r["accounting"]["duty"]["reconcile"]["held"], 0);
    }

    /// An abandoned decision leaves one event-log line with its site and reason, and a flood of the same one stays one line.
    #[test]
    fn an_abandoned_decision_is_logged_with_site_and_reason_once_per_interval() {
        let site = format!("test:abandoned-log-{}", std::process::id());
        let why = "workspace w-1 not drained: shortfall";
        let lines = || health::events().into_iter().filter(|e| e.kind == "abandoned" && e.code == site).collect::<Vec<_>>();
        for _ in 0..5 {
            handback_why(Handback::Abandoned, &site, why);
        }
        handback_why(Handback::StandIn, &site, why);
        let got = lines();
        assert_eq!(got.len(), 1, "five of the same decision in the interval are one line; a stand-in is not abandoned");
        assert!(got[0].detail.contains(why) && got[0].detail.contains(&site), "the line carries the site and the reason: {}", got[0].detail);
        handback_why(Handback::Abandoned, &site, "workspace w-2 not drained: path-outside-state-dir");
        assert_eq!(lines().len(), 2, "another reason at the site is its own line");
    }

    #[test]
    fn the_journal_is_appended_without_being_created_and_folded_past_its_cap() {
        let dir = std::env::temp_dir().join(format!("ah-obs-counters-{}", std::process::id()));
        let missing = dir.join("nope").join("j.log");
        append_to(&missing, "x\n", 1).unwrap();
        assert!(!missing.exists() && !missing.parent().unwrap().exists(), "a missing state dir is left alone");
        std::fs::create_dir_all(&dir).unwrap();
        let j = dir.join("j.log");
        let k = ("node_launch".to_string(), "s".to_string(), String::new());
        for _ in 0..20 {
            append_to(&j, &line_of(&k, &Val { n: 1, ..Val::default() }), 100).unwrap();
        }
        let text = std::fs::read_to_string(&j).unwrap();
        assert!(text.lines().count() < 20, "folded once past the cap: {text:?}");
        assert_eq!(read_journal(&j).rows[&k].n, 20, "folding loses no count");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
