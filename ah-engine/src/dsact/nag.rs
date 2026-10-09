//! The "done but open" nag (DevSwarm expansion feature 2). A workspace that is done (everything in `devswarm_act.nag_done_requires`
//! holds, it is clean, has no unread mail and is past idleMin) but still open gets a nag to the Primary: once when it becomes done
//! (the edge), then a digest every `nag.everyMs`. Each nag carries a one-command archive hint.
//!
//! The decision (is it done, is a nag due, the text) is the plugin script (`kind = nag`); this module keeps the state (what was
//! said at which HEAD, the rolling hour), the idempotency key `nag:<id>:<doneHead>:<bucket>` in the ledger, the delivery and the
//! telemetry. It is silent for ids auto-archive owns (it reads `auto_archive_state_file` the way Node does) and for archived or
//! closed workspaces (they are no candidates; a previously nagged one that left the candidates counts as `resolved`).
//! It acts on nothing: the only effect is a message.
use super::decide::decide;
use super::exec::{Act, append_line, write_atomic};
use super::ledger::{Begin, Word};
use super::tele::{Attempt, gate_values};
use crate::defaults;
use serde_json::{Value, json};
use std::path::PathBuf;

/// Where a nag goes.
pub trait Notifier {
    /// Deliver `text` to the Primary. An `Err` means it was not delivered (the nag is then recorded as failed and tried again).
    fn notify(&self, text: &str) -> Result<(), String>;
}

/// Queues the text in `devswarm_act.nag_pending_file`; the realtime advisory channel hands it to the Primary's next prompt.
pub struct PendingFile(pub PathBuf);

impl Notifier for PendingFile {
    fn notify(&self, text: &str) -> Result<(), String> {
        append_line(&self.0.join(defaults::text("devswarm_act.nag_pending_file")), &Value::String(text.to_string()));
        Ok(())
    }
}

/// Take (read and clear) the queued nag text. `None` when there is none.
pub fn take_pending(state_dir: &std::path::Path) -> Option<String> {
    let path = state_dir.join(defaults::text("devswarm_act.nag_pending_file"));
    let text = std::fs::read_to_string(&path).ok()?;
    write_atomic(&path, "");
    let lines: Vec<String> = text.lines().filter_map(|l| serde_json::from_str::<String>(l).ok()).collect();
    (!lines.is_empty()).then(|| lines.join("\n"))
}

impl Act<'_> {
    fn nag_state(&self) -> Value {
        std::fs::read_to_string(self.state_dir.join(defaults::text("devswarm_act.nag_state_file")))
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_else(|| json!({}))
    }

    fn owned_by_auto_archive(&self) -> Vec<String> {
        std::fs::read_to_string(self.home.join(defaults::text("devswarm_act.auto_archive_state_file")))
            .ok()
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
            .and_then(|v| v.get("owned").and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()))
            .unwrap_or_default() // keep: no state file = auto-archive owns nothing
    }

    /// One nag pass: decide for every active workspace, send ONE message holding every due nag, record state and telemetry.
    pub fn nag_tick(&self, notifier: &dyn Notifier) -> Value {
        let s = self.settings();
        if !s.nag || !self.live.present() {
            return json!({"nag": s.nag, "sent": 0});
        }
        let started = std::time::Instant::now();
        let now = self.live.now_ms();
        let (feature, outs, trig) = (
            defaults::list("devswarm_act.feature_names")[1],
            defaults::list("devswarm_act.outcome_words"),
            defaults::list("devswarm_act.trigger_words")[1],
        );
        let kind = defaults::text("devswarm_act.nag_kind");
        let mut state = self.nag_state();
        let mut per: serde_json::Map<String, Value> = state.get("ws").and_then(Value::as_object).cloned().unwrap_or_default();
        let mut sent: Vec<i64> = state.get("sent").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_i64).collect()).unwrap_or_default();
        sent.retain(|t| now - t < defaults::num("devswarm_act.nag_hour_ms") as i64);
        let active = self.live.candidates();
        // a nagged workspace that is no longer open: the nag worked
        for id in per.keys().filter(|id| !active.contains(id)).cloned().collect::<Vec<_>>() {
            let head = per.remove(&id).map(|e| e["lastHead"].clone()).unwrap_or(Value::Null);
            self.tele.attempt(
                &Attempt { feature, action: defaults::text("devswarm_act.nag_resolved"), trigger: trig, id: &id, head: &head, gates: json!({}), outcome: outs[0], reason: None, latency_ms: 0, key: "", via_execute: false },
                now,
            );
        }
        let owned = self.owned_by_auto_archive();
        let mut due: Vec<(String, Value, String)> = Vec::new();
        for id in &active {
            let Some(facts) = self.live.facts(kind, id) else { continue };
            let entry = per.get(id).cloned().unwrap_or_else(|| json!({}));
            let nag = json!({"lastHead": entry["lastHead"], "lastNagMs": entry["lastNagMs"], "hourCount": sent.len()});
            let mut p = self.payload(kind, facts.clone(), json!({}), vec![], &s);
            p["nag"] = nag;
            p["owned"] = json!(owned.contains(id));
            let Ok(d) = decide(&self.home_str(), &p) else { continue };
            if d["eligible"] == json!(true) {
                due.push((id.clone(), d, facts["head"].as_str().unwrap_or_default().to_string()));
                continue;
            }
            let capped = d["blockers"].as_array().is_some_and(|b| b.iter().any(|x| x["gate"] == "hourly-cap"));
            if capped {
                self.tele.attempt(
                    &Attempt { feature, action: "notify", trigger: trig, id, head: &facts["head"], gates: gate_values(&d["blockers"]), outcome: outs[1], reason: Some("hourly-cap"), latency_ms: 0, key: "", via_execute: false },
                    now,
                );
            } else if d["blockers"].as_array().is_some_and(|b| !b.is_empty() && !b.iter().all(|x| x["gate"] == "cadence")) {
                // no longer done (or not idle): the cycle count restarts
                if let Some(e) = per.get_mut(id) {
                    e["cycles"] = json!(0);
                }
            }
        }
        // claim each key, then send one message
        let mut claimed: Vec<(String, Value, String, String)> = Vec::new();
        for (id, d, head) in due {
            let key = d["key"].as_str().unwrap_or_default().to_string();
            if matches!(self.ledger.begin(&key, kind, &id, now), Begin::Claimed(_)) {
                claimed.push((id, d, head, key));
            }
        }
        let mut result = Ok(());
        if !claimed.is_empty() {
            let text = claimed.iter().map(|(_, d, _, _)| d["text"].as_str().unwrap_or_default()).collect::<Vec<_>>().join("\n");
            result = notifier.notify(&text);
            if result.is_ok() {
                sent.push(now);
            }
        }
        let latency = started.elapsed().as_millis() as u64;
        let ignored = defaults::num("devswarm_act.nag_ignored_cycles");
        for (id, d, head, key) in &claimed {
            let h = json!(head);
            let gates = gate_values(&json!([]));
            match &result {
                Ok(()) => {
                    self.ledger.finish(key, kind, id, now, Word::Done, None);
                    let e = per.entry(id.clone()).or_insert_with(|| json!({"cycles": 0}));
                    let cycles = if e["lastHead"] == h { e["cycles"].as_u64().unwrap_or(0) + 1 } else { 1 };
                    *e = json!({"lastHead": head, "lastNagMs": now, "cycles": cycles});
                    self.tele.attempt(&Attempt { feature, action: "notify", trigger: trig, id, head: &h, gates, outcome: outs[0], reason: None, latency_ms: latency, key, via_execute: false }, now);
                    if cycles >= ignored {
                        self.tele.mistake(feature, defaults::text("devswarm_act.mistake_nag_ignored"), &format!("{id}:{head}"), id, json!({"cycles": cycles, "edge": d["edge"]}), now);
                    }
                }
                Err(why) => {
                    self.ledger.finish(key, kind, id, now, Word::Failed, Some(why));
                    self.tele.attempt(&Attempt { feature, action: "notify", trigger: trig, id, head: &h, gates, outcome: outs[2], reason: Some(why), latency_ms: latency, key, via_execute: false }, now);
                }
            }
        }
        state = json!({"ws": per, "sent": sent});
        write_atomic(&self.state_dir.join(defaults::text("devswarm_act.nag_state_file")), &state.to_string());
        json!({"nag": true, "sent": claimed.len(), "delivered": result.is_ok()})
    }
}
