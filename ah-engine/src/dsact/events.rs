//! Event-driven auto-archive (DevSwarm expansion feature 3). A state change (an edge of a kind in `devswarm_act.event_kinds`) puts the
//! workspace in the dirty set; once it has been quiet for the debounce time the event path runs the SAME auto-archive the sweep runs
//! ([`Act::archive_one`]: same gates a-h, same settings, same idempotency key, a live re-check right before acting, a bounded call,
//! a check in the app database, the ledger and the telemetry). The timer sweep stays as the safety net. A per-workspace in-flight
//! lock, shared by every trigger in the process, keeps an edge and the timer from running one archive twice; the ledger key
//! `auto-archive:<id>:<doneHead>` keeps even a second process from repeating it.
//!
//! This module also owns the mistake signals of the auto-archive: a workspace unarchived afterwards, or new commits / activity in
//! an archived one ([`Act::mistake_scan`]).
use super::exec::{Act, One, push};
use super::ledger::Word;
use crate::defaults;
use crate::devswarm_rt::state::Edge;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Mutex;

static IN_FLIGHT: Mutex<BTreeSet<String>> = Mutex::new(BTreeSet::new());

/// Holds the in-flight lock of one workspace until dropped.
pub struct IdLock(String);

impl Drop for IdLock {
    fn drop(&mut self) {
        IN_FLIGHT.lock().unwrap_or_else(|e| e.into_inner()).remove(&self.0);
    }
}

/// Take the in-flight lock of `id`; `None` when another trigger in this process holds it.
pub fn lock_id(id: &str) -> Option<IdLock> {
    IN_FLIGHT.lock().unwrap_or_else(|e| e.into_inner()).insert(id.to_string()).then(|| IdLock(id.to_string()))
}

/// The workspaces whose state changed and have not been looked at yet, with the time of their last change.
#[derive(Default)]
pub struct Dirty {
    set: Mutex<BTreeMap<String, i64>>,
}

impl Dirty {
    /// An empty set.
    pub fn new() -> Dirty {
        Dirty::default()
    }

    /// Mark the workspace of every edge whose kind is in `devswarm_act.event_kinds`. Returns how many edges marked.
    pub fn mark(&self, edges: &[Edge], now: i64) -> usize {
        let kinds = defaults::list("devswarm_act.event_kinds");
        let mut set = self.set.lock().unwrap_or_else(|e| e.into_inner());
        let mut n = 0;
        for e in edges.iter().filter(|e| kinds.contains(&e.kind.as_str())) {
            set.insert(e.ws.clone(), now);
            n += 1;
        }
        n
    }

    /// Mark one workspace.
    pub fn mark_id(&self, id: &str, now: i64) {
        self.set.lock().unwrap_or_else(|e| e.into_inner()).insert(id.to_string(), now);
    }

    /// Remove and return the workspaces quiet for at least `debounce_ms`.
    pub fn take_due(&self, now: i64, debounce_ms: i64) -> Vec<String> {
        let mut set = self.set.lock().unwrap_or_else(|e| e.into_inner());
        let due: Vec<String> = set.iter().filter(|(_, at)| now - **at >= debounce_ms).map(|(id, _)| id.clone()).collect();
        for id in &due {
            set.remove(id);
        }
        due
    }

    /// Whether anything is waiting.
    pub fn pending(&self) -> usize {
        self.set.lock().unwrap_or_else(|e| e.into_inner()).len()
    }
}

impl Act<'_> {
    /// Whether the event trigger is on in the settings (the sweep then leaves the archive of a plain edge to the event path).
    pub fn event_trigger_on(&self) -> bool {
        self.settings().event_trigger
    }

    /// The telemetry handle of this layer (share it with the next run to keep the totals).
    pub fn tele(&self) -> &super::tele::Tele {
        &self.tele
    }

    /// Use `tele` (a handle kept by the caller across runs) instead of a fresh one.
    pub fn with_tele(mut self, tele: super::tele::Tele) -> Self {
        self.tele = tele;
        self
    }

    /// Auto-archive the dirty workspaces that have been quiet for the debounce time, at most `maxPerSweep` actual archives per call
    /// (the rest stay dirty). Does nothing unless the mode is `on`, the event trigger is enabled and DevSwarm is present.
    pub fn auto_archive_events(&self, dirty: &Dirty) -> Value {
        let s = self.settings();
        let words = defaults::list("devswarm_act.plan_mode_words");
        if !s.event_trigger || s.mode != words[0] || !self.live.present() {
            return json!({"mode": s.mode, "eventTrigger": s.event_trigger, "archived": [], "failed": []});
        }
        let now = self.live.now_ms();
        let due = dirty.take_due(now, s.event_debounce_ms);
        let mut sum = json!({"mode": s.mode, "eventTrigger": true, "looked": due.len(), "archived": [], "failed": [], "notices": []});
        if due.is_empty() {
            return sum;
        }
        let cap = self.capability(defaults::list("devswarm_act.id_verbs")[0]);
        if let Err(why) = cap {
            sum["dormant"] = json!(why);
            return sum;
        }
        let tracked = self.live.candidates();
        let mut acted = 0;
        for id in due {
            if !tracked.contains(&id) {
                continue;
            }
            if acted >= s.max_per_sweep.max(1) {
                dirty.mark_id(&id, now - s.event_debounce_ms); // over the cap: still due on the next call
                continue;
            }
            match self.archive_one(&id, &s, defaults::list("devswarm_act.trigger_words")[0], None) {
                One::NotEligible => {}
                One::Done(d) => {
                    acted += 1;
                    push(&mut sum, "archived", json!(id));
                    push(&mut sum, "notices", json!({"id": id, "text": d["notice"]}));
                }
                One::Stale => push(&mut sum, "failed", json!({"id": id, "reason": Word::Stale.text()})),
                One::Refused(why) => push(&mut sum, "failed", json!({"id": id, "reason": why, "outcome": Word::Refused.text()})),
                One::Failed(r) => {
                    acted += 1;
                    push(&mut sum, "failed", json!({"id": id, "reason": r.detail.get("error").cloned().unwrap_or(json!(r.word.text())), "outcome": r.word.text()}));
                }
            }
        }
        sum
    }

    /// Look at the auto-archives made within `devswarm_act.mistake_window_ms` and record what went wrong afterwards, once each:
    /// the workspace is active again (unarchived), or its HEAD or newest activity moved after the archive. Returns how many new
    /// signals were recorded. Reads only; changes nothing.
    pub fn mistake_scan(&self) -> usize {
        let now = self.live.now_ms();
        let window = defaults::num("devswarm_act.mistake_window_ms") as i64;
        let kind = defaults::text("devswarm_act.auto_archive_kind");
        let feature = defaults::list("devswarm_act.feature_names")[0];
        let mut n = 0;
        for (key, id, at) in self.ledger.done_rows(&format!("{kind}:")) {
            if now - at > window {
                continue;
            }
            let head = key.rsplit(':').next().unwrap_or_default();
            if self.live.archived(&id) == Some(false) && self.tele.mistake(feature, defaults::text("devswarm_act.mistake_unarchived"), &key, &id, json!({"archivedAt": at}), now) {
                n += 1;
            }
            let Some(post) = self.live.post_archive(&id) else { continue };
            let moved_head = post["head"].as_str().is_some_and(|h| !h.is_empty() && !head.is_empty() && h != head);
            let moved_act = post["activityMs"].as_i64().is_some_and(|t| t - at > defaults::num("devswarm_act.mistake_activity_grace_ms") as i64);
            if (moved_head || moved_act)
                && self.tele.mistake(feature, defaults::text("devswarm_act.mistake_activity"), &key, &id, json!({"archivedAt": at, "post": post}), now)
            {
                n += 1;
            }
        }
        n
    }
}
