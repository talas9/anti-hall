//! Telemetry of the automatic DevSwarm actions (auto-archive, nag): one event line and one set of counters per attempt, and the
//! mistake signals seen afterwards, so a wrong automatic action is measurable. The words, file names and metric names are all in
//! `devswarm_act.toml`.
//!
//! * An attempt is recorded as `{ts, type: action, feature, action, trigger, target: {id, doneHead}, gates, outcome, reason,
//!   latency_ms}` in `devswarm_act.events_file`; `gates` holds every gate's value (`pass`, or the blocker's detail).
//! * A mistake is `{type: mistake, feature, signal, target, detail}` in the same file, written once per (signal, key) (the
//!   `devswarm_act.mistakes_file` remembers which were written).
//! * [`Tele::publish`] adds the counters (`dsx_actions`, `dsx_mistakes`, `dsx_latency_us`) and sets the rate gauges. Success rate is
//!   ok / (ok + failed): a refusal is the safety checks working, not a failure. Mistake rate is mistakes per ok action.
use super::exec::append_line;
use crate::defaults;
use crate::metrics::Metrics;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// One attempt to record.
pub struct Attempt<'a> {
    /// Feature word (`devswarm_act.feature_names`).
    pub feature: &'a str,
    /// What was done (`archive`, `notify`, `resolved`).
    pub action: &'a str,
    /// Trigger word (`devswarm_act.trigger_words`).
    pub trigger: &'a str,
    /// The workspace.
    pub id: &'a str,
    /// The done HEAD it acted on.
    pub head: &'a Value,
    /// Every gate's value.
    pub gates: Value,
    /// Outcome word (`devswarm_act.outcome_words`).
    pub outcome: &'a str,
    /// Why, when not ok.
    pub reason: Option<&'a str>,
    /// Wall time of the attempt.
    pub latency_ms: u64,
    /// The idempotency key (what a mistake signal refers back to); empty when there is none.
    pub key: &'a str,
    /// The attempt already went through `Act::execute`, which emits its own shared `act` event: do not emit a second one.
    pub via_execute: bool,
}

#[derive(Default)]
#[allow(clippy::type_complexity)] // (metric name, labels, value) rows, read once by the metrics flush
struct Inner {
    counters: Vec<(String, Vec<(String, String)>, u64)>,
    lat: Vec<(String, u64)>,
    /// Per feature: ok, failed, refused, mistakes.
    totals: [[u64; 4]; 2],
}

/// The telemetry handle; clones share the counters.
#[derive(Clone)]
pub struct Tele {
    dir: PathBuf,
    inner: Arc<Mutex<Inner>>,
}

fn feature_ix(feature: &str) -> usize {
    defaults::list("devswarm_act.feature_names").iter().position(|f| *f == feature).unwrap_or(0)
}

/// The gates of an auto-archive decision as `{gate: pass | detail}`, from the blockers the script returned.
pub fn gate_values(blockers: &Value) -> Value {
    let mut out = serde_json::Map::new();
    for g in defaults::list("devswarm_act.gate_names") {
        out.insert(g.to_string(), json!("pass"));
    }
    for b in blockers.as_array().map(Vec::as_slice).unwrap_or_default() {
        if let Some(g) = b.get("gate").and_then(Value::as_str) {
            out.insert(g.to_string(), b.get("detail").cloned().unwrap_or(json!("blocked")));
        }
    }
    Value::Object(out)
}

impl Tele {
    /// A handle writing to the state directory `dir`.
    pub fn new(dir: &Path) -> Tele {
        Tele { dir: dir.to_path_buf(), inner: Arc::new(Mutex::new(Inner::default())) }
    }

    fn file(&self) -> PathBuf {
        self.dir.join(defaults::text("devswarm_act.events_file"))
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Record one attempt: the event line and the counters.
    pub fn attempt(&self, a: &Attempt<'_>, now_ms: i64) {
        append_line(
            &self.file(),
            &json!({"ts": now_ms, "type": "action", "feature": a.feature, "action": a.action, "trigger": a.trigger,
                "target": {"id": a.id, "doneHead": a.head}, "gates": a.gates, "outcome": a.outcome, "reason": a.reason, "latency_ms": a.latency_ms}),
        );
        let outs = defaults::list("devswarm_act.outcome_words");
        if !a.via_execute {
            crate::telemetry::emit::act(&self.rec(a.feature, a.action, a.outcome, a.latency_ms, a.id, a.reason.unwrap_or_default(), a.key));
        }
        let mut g = self.lock();
        g.counters.push(("dsx_actions".into(), vec![("feature".into(), a.feature.into()), ("outcome".into(), a.outcome.into())], 1));
        g.lat.push((a.feature.into(), a.latency_ms.saturating_mul(1000)));
        let col = outs.iter().position(|o| *o == a.outcome).unwrap_or(0);
        g.totals[feature_ix(a.feature)][col] += 1;
    }

    #[allow(clippy::too_many_arguments)] // the fields of one act record
    fn rec<'b>(
        &self,
        feature: &'b str,
        action: &'b str,
        outcome: &str,
        latency_ms: u64,
        target: &'b str,
        reason: &'b str,
        key: &'b str,
    ) -> crate::telemetry::emit::ActRec<'b> {
        use crate::telemetry::event::Outcome;
        let outs = defaults::list("devswarm_act.outcome_words");
        let outcome = match outs.iter().position(|o| *o == outcome) {
            Some(0) => Outcome::Allow,
            Some(1) => Outcome::Block,
            _ => Outcome::Error,
        };
        crate::telemetry::emit::ActRec { feature, action, outcome, latency_ms, target, inputs: "", reason, action_id: key }
    }

    /// Record a mistake signal once per (signal, key). Returns whether it was new.
    pub fn mistake(&self, feature: &str, signal: &str, key: &str, id: &str, detail: Value, now_ms: i64) -> bool {
        if self.seen(signal, key) {
            return false;
        }
        append_line(&self.dir.join(defaults::text("devswarm_act.mistakes_file")), &Value::String(format!("{signal}|{key}")));
        crate::telemetry::emit::mistake(&self.rec(feature, signal, defaults::list("devswarm_act.outcome_words")[0], 0, id, "", key));
        append_line(
            &self.file(),
            &json!({"ts": now_ms, "type": "mistake", "feature": feature, "signal": signal, "target": {"id": id, "key": key}, "detail": detail}),
        );
        let mut g = self.lock();
        g.counters.push(("dsx_mistakes".into(), vec![("feature".into(), feature.into()), ("signal".into(), signal.into())], 1));
        g.totals[feature_ix(feature)][3] += 1;
        true
    }

    /// Whether the signal for `key` was already recorded.
    pub fn seen(&self, signal: &str, key: &str) -> bool {
        let tag = Value::String(format!("{signal}|{key}")).to_string();
        std::fs::read_to_string(self.dir.join(defaults::text("devswarm_act.mistakes_file"))).unwrap_or_default().lines().any(|l| l == tag) // keep: absent file = nothing seen
    }

    /// Add what happened since the last call to `m`, and set the rate gauges.
    pub fn publish(&self, m: &mut Metrics) {
        let mut g = self.lock();
        for (name, labels, by) in g.counters.drain(..) {
            let l: Vec<(&str, &str)> = labels.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect();
            m.add(&name, &l, by);
        }
        for (feature, us) in g.lat.drain(..) {
            m.observe("dsx_latency_us", &[("feature", &feature)], us);
        }
        let names = [("dsx_auto_archive_success_rate", "dsx_auto_archive_mistake_rate"), ("dsx_nag_success_rate", "dsx_nag_mistake_rate")];
        for (i, (succ, mist)) in names.iter().enumerate() {
            let [ok, failed, _refused, mistakes] = g.totals[i];
            if ok + failed > 0 {
                m.set(succ, ok as f64 / (ok + failed) as f64);
            }
            if ok > 0 {
                m.set(mist, mistakes as f64 / ok as f64);
            }
        }
    }
}

/// Per-feature counts, success rate and mistake rate over the whole events file (all time, across restarts).
pub fn report(dir: &Path) -> Value {
    let text = std::fs::read_to_string(dir.join(defaults::text("devswarm_act.events_file"))).unwrap_or_default(); // keep: absent file = no events
    let mut out = serde_json::Map::new();
    for f in defaults::list("devswarm_act.feature_names") {
        let (mut ok, mut failed, mut refused, mut mistakes) = (0u64, 0u64, 0u64, 0u64);
        for r in text.lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()).filter(|r| r["feature"] == f) {
            if r["type"] == "mistake" {
                mistakes += 1;
            } else {
                match r["outcome"].as_str().unwrap_or_default() {
                    "ok" => ok += 1,
                    "failed" => failed += 1,
                    _ => refused += 1,
                }
            }
        }
        let rate = |n: u64, d: u64| if d == 0 { Value::Null } else { json!(n as f64 / d as f64) };
        out.insert(f.to_string(), json!({"ok": ok, "failed": failed, "refused": refused, "mistakes": mistakes, "success_rate": rate(ok, ok + failed), "mistake_rate": rate(mistakes, ok)}));
    }
    Value::Object(out)
}
