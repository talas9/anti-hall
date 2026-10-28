//! Stuck / silent-child detection on events (feature 5), around the poke and escalate the action layer already runs.
//!
//! The silence clock of an active workspace is the newest of its sources (heartbeat, transcript, git directory,
//! `devswarm_rt.stall_*`); an event on any of them re-reads the state at once, and the moment a Working workspace's clock reaches
//! `stall_ms` the state is re-read too (the deadline check), instead of waiting for the periodic reconcile. What is done about a
//! stall is unchanged: the descriptor's own poke and escalate commands through `dsact`, with `nudgeMaxAttempts` and
//! `nudgeCooldownSec`, keys `poke:<id>:<n>` and `escalate:<id>`, and the live re-check in `RtLive::nudge_facts` (active, not
//! paused, not waiting on CI, still silent on enough sources). This module adds the trigger, the action log and the follow-up
//! that finds nudges which changed nothing and escalations that turned out to be needless.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this module is a deliberate keep, for these reasons:
// - an absent field of a log record is the empty value
use super::Wire;
use crate::actlog::{self, Action};
use crate::defaults;
use crate::devswarm_rt::detect::Mode;
use crate::devswarm_rt::reconcile::Cause;
use crate::devswarm_rt::state::{Activity, Lifecycle};
use crate::dsact::exec::Report;
use crate::dsact::ledger::Word;
use serde_json::{Value, json};
use std::sync::atomic::Ordering;

fn word(k: &str) -> &'static str {
    defaults::raw("actions.stall").str_field(k)
}

/// The action log outcome of an action layer word: `ok`, `failed` (it ran and did not work) or `refused` (it did not run).
pub fn outcome(w: Word) -> &'static str {
    match w {
        Word::Done => "ok",
        Word::Failed | Word::Timeout => "failed",
        _ => "refused",
    }
}

impl Wire {
    /// Log one poke / escalate (or its refusal) and, for one that ran, schedule the follow-up.
    pub(crate) fn record_stall(&self, r: &Report, now: i64) {
        let kinds = defaults::list("devswarm_act.automatic_kinds");
        if r.kind != kinds[1] && r.kind != kinds[2] {
            return;
        }
        let out = outcome(r.word);
        let reason = if out == "ok" { String::new() } else { format!("{} {}", r.word.text(), r.detail) };
        let inputs = r.inputs.get("inputs").cloned().unwrap_or_else(|| r.inputs.clone());
        actlog::record(
            &self.state_dir,
            &Action { feature: word("feature"), action: &r.kind, target: &r.id, inputs, outcome: out, reason: &reason, latency_ms: r.latency_ms },
            now as u64,
        );
        self.count(&mut |m| m.inc("dswire_stall_actions", &[("kind", &r.kind), ("outcome", out)]));
        if out == "ok" {
            let last = r.inputs.pointer("/inputs/last_activity_ms").and_then(Value::as_i64).unwrap_or(0);
            let due = now as u64 + defaults::num("devswarm_rt.stall_followup_wait_ms");
            actlog::followup_add(&self.state_dir, word("feature"), &r.kind, &r.id, due, json!({"last_activity_ms": last}), now as u64);
            self.followup_next.fetch_min(due as i64, Ordering::SeqCst);
        }
    }

    /// The workspaces among `ids` whose state says stuck: new activity on one of their sources should clear that at once.
    pub fn stuck_among(&self, ids: &[String]) -> bool {
        let snap = self.rt.current();
        ids.iter().any(|id| snap.workspaces.get(id).is_some_and(|w| w.activity.value == Activity::Stuck))
    }

    /// Whether a heartbeat of workspace `id` cannot change what a reconcile derives: the state has the workspace active and working.
    /// A newer beat leaves it working (silence needs the beat to be OLDER than `stall_ms`), and the deadline check in
    /// [`Wire::stall_tick`] reads the beat again when the working workspace's clock runs out, so the clock cannot be missed. A stuck
    /// or unknown workspace, one that is not active, and one the state has never seen are not quiet: their beat is a real change.
    pub fn beat_is_quiet(&self, id: &str) -> bool {
        self.rt.mode() == Mode::On
            && self.rt.current().workspaces.get(id).is_some_and(|w| w.lifecycle.value == Lifecycle::Active && w.activity.value == Activity::Working)
    }

    /// One cheap pass of the stall trigger, run by the watcher loop: the deadline check and the due follow-ups.
    pub fn stall_tick(&self) {
        if self.rt.mode() != Mode::On {
            return;
        }
        let now = super::now_ms();
        let gap = defaults::num("devswarm_rt.stall_check_min_gap_ms") as i64;
        if now - self.last_stall.load(Ordering::SeqCst) >= gap {
            let stall = self.rt.cfg().stall_ms;
            let reached = self
                .rt
                .current()
                .workspaces
                .values()
                .any(|w| w.lifecycle.value == Lifecycle::Active && w.activity.value == Activity::Working && w.activity.observed_ms + stall <= now);
            if reached {
                self.last_stall.store(now, Ordering::SeqCst);
                self.reconcile(Cause::Event);
            }
        }
        if now >= self.followup_next.load(Ordering::SeqCst) {
            self.stall_followups(now);
        }
    }

    /// Read the earliest follow-up time from the log (at start, and after the follow-ups have been looked at).
    pub fn refresh_followup_next(&self) {
        let due = actlog::followups_due(&self.state_dir, word("feature"), u64::MAX).iter().filter_map(|f| f.get("due_ms").and_then(Value::as_u64)).min();
        self.followup_next.store(due.map_or(i64::MAX, |d| d as i64), Ordering::SeqCst);
    }

    /// Milliseconds until [`Wire::stall_tick`] has something to do: the soonest of a follow-up coming due and the silence clock of a
    /// working workspace reaching `stall_ms` (never sooner than the check gap). `None` when nothing is waiting or the mode is not on.
    pub fn stall_due_in(&self, now: i64) -> Option<i64> {
        if self.rt.mode() != Mode::On {
            return None;
        }
        let stall = self.rt.cfg().stall_ms;
        let reach = self
            .rt
            .current()
            .workspaces
            .values()
            .filter(|w| w.lifecycle.value == Lifecycle::Active && w.activity.value == Activity::Working)
            .map(|w| w.activity.observed_ms + stall)
            .min()
            .map(|at| at.max(self.last_stall.load(Ordering::SeqCst) + defaults::num("devswarm_rt.stall_check_min_gap_ms") as i64));
        let follow = Some(self.followup_next.load(Ordering::SeqCst)).filter(|d| *d != i64::MAX);
        reach.into_iter().chain(follow).min().map(|at| (at - now).max(0))
    }

    /// Check the nudges and escalations whose wait has passed: did the workspace show new activity?
    pub fn stall_followups(&self, now: i64) {
        for f in actlog::followups_due(&self.state_dir, word("feature"), now as u64) {
            let (action, id) = (f["action"].as_str().unwrap_or_default(), f["target"].as_str().unwrap_or_default());
            let before = f.pointer("/ctx/last_activity_ms").and_then(Value::as_i64).unwrap_or(0);
            let snap = self.rt.current();
            let Some(w) = snap.workspaces.get(id) else {
                actlog::followup_done(&self.state_dir, word("feature"), action, id, "unknown", None, now as u64); // the workspace is gone: nothing to judge
                continue;
            };
            let moved = match w.activity.value {
                Activity::Working | Activity::Stuck => w.activity.observed_ms > before,
                Activity::WaitingCi | Activity::Done => true, // it went on (a PR, CI, merged): the nudge or escalation did not fail
                Activity::Unknown => {
                    if w.lifecycle.value == Lifecycle::Active {
                        let again = now as u64 + defaults::num("devswarm_rt.stall_followup_wait_ms");
                        actlog::followup_done(&self.state_dir, word("feature"), action, id, "", Some(again), now as u64); // not readable now: look again later
                    } else {
                        actlog::followup_done(&self.state_dir, word("feature"), action, id, "unknown", None, now as u64); // archived or closed since: nothing to judge
                    }
                    continue;
                }
            };
            let kinds = defaults::list("devswarm_act.automatic_kinds");
            let (bad, kind, detail) = if action == kinds[1] {
                (!moved, word("nudge_mistake"), word("nudge_detail"))
            } else {
                (moved, word("escalate_mistake"), word("escalate_detail"))
            };
            if bad {
                actlog::mistake(&self.state_dir, word("feature"), action, id, kind, detail, now as u64);
            }
            actlog::followup_done(&self.state_dir, word("feature"), action, id, if bad { "mistake" } else { "clean" }, None, now as u64);
        }
        self.refresh_followup_next();
    }
}
