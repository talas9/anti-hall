//! The injection gate's per-session memory: what each gated hook block looked like the last time it was passed on, and on
//! which turn. The dispatcher (`dispatch::inject`) asks one question per block, "does the model already hold this?", and this
//! store answers: pass it on (first time, changed, or forced), drop it, or pass its short keepalive form.
//!
//! The state is bounded (the daemon has a memory cap): at most `inject_gate.max_sessions` sessions (the least recently used is
//! evicted) and `inject_gate.max_slots` blocks per session (the oldest is dropped). Eviction is safe by construction: a block
//! the gate has forgotten is simply passed on whole, which is what the Node hook did anyway. The figures that bound it are
//! reported by [`Gate::stats`] and shown with the daemon's other memory gauges.
use crate::defaults;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

/// What the gate is asked about one block.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Query {
    /// The block's name within the session (one per gated block kind).
    pub slot: String,
    /// The cut it belongs to (a telemetry label).
    pub cut: String,
    /// Fingerprint of the block's text after the rewrite that removes per-turn noise.
    pub hash: String,
    /// Bytes of the block as the Node hook printed it.
    pub len: usize,
    /// Bytes of its keepalive form (the block itself when it has none).
    pub keep_len: usize,
    /// Turns after which an unchanged block is passed on again.
    pub every: u64,
    /// Pass it on whatever the memory says (and remember it): a block that restarts the count.
    pub force: bool,
}

/// The answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    /// Pass the block on as it is.
    Emit,
    /// Drop it: the model already holds an identical copy.
    Suppress,
    /// Pass its keepalive form: the copy the model holds is old.
    Keepalive,
}

struct Slot {
    agent: String,
    name: String,
    hash: String,
    last_turn: u64,
    emitted: u64,
    emitted_bytes: u64,
    suppressed: u64,
    suppressed_bytes: u64,
}

#[derive(Default)]
struct Session {
    turn: u64,
    seq: u64,
    slots: Vec<Slot>,
}

#[derive(Default)]
struct Inner {
    sessions: HashMap<String, Session>,
    seq: u64,
    evictions: u64,
}

/// The size of the memory held, for the memory gauges.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Stats {
    /// Sessions held.
    pub sessions: usize,
    /// Blocks held, over all sessions.
    pub slots: usize,
    /// Estimated bytes held.
    pub bytes: usize,
    /// Sessions and blocks dropped to stay within the bounds.
    pub evictions: u64,
}

/// The gate's state. Cheap to lock: every operation is a short scan of at most `max_slots` entries.
#[derive(Default)]
pub struct Gate {
    inner: Mutex<Inner>,
}

fn cut_id(s: &str) -> String {
    s.chars().take(defaults::num("inject_gate.id_max") as usize).collect()
}

impl Gate {
    /// An empty gate.
    pub fn new() -> Gate {
        Gate::default()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn touch<'a>(g: &'a mut Inner, sid: &str) -> &'a mut Session {
        g.seq += 1;
        let seq = g.seq;
        if !g.sessions.contains_key(sid)
            && g.sessions.len() >= defaults::num("inject_gate.max_sessions") as usize
            && let Some(old) = g.sessions.iter().min_by_key(|(_, s)| s.seq).map(|(k, _)| k.clone())
        {
            g.sessions.remove(&old);
            g.evictions += 1;
        }
        let s = g.sessions.entry(sid.to_string()).or_default();
        s.seq = seq;
        s
    }

    /// One more turn of the session (a UserPromptSubmit dispatch).
    pub fn turn(&self, sid: &str) {
        let sid = cut_id(sid);
        let mut g = self.lock();
        Self::touch(&mut g, &sid).turn += 1;
    }

    /// Forget the session (its context may be gone: start, resume, clear or compaction).
    pub fn reset(&self, sid: &str) {
        self.lock().sessions.remove(&cut_id(sid));
    }

    /// Decide one block of agent `agent` (empty for the main thread) in session `sid`, and remember the answer.
    pub fn decide(&self, sid: &str, agent: &str, q: &Query) -> Decision {
        let (sid, agent) = (cut_id(sid), cut_id(agent));
        // every string kept is bounded, whatever a client sends
        let q = &Query { slot: cut_id(&q.slot), hash: q.hash.chars().take(2 * defaults::num("inject_gate.hash_chars") as usize).collect(), ..q.clone() };
        let mut g = self.lock();
        let max_slots = defaults::num("inject_gate.max_slots") as usize;
        let mut dropped = 0;
        let s = Self::touch(&mut g, &sid);
        let turn = s.turn;
        let i = match s.slots.iter().position(|x| x.agent == agent && x.name == q.slot) {
            Some(i) => i,
            None => {
                if s.slots.len() >= max_slots {
                    s.slots.remove(0);
                    dropped += 1;
                }
                s.slots.push(Slot {
                    agent,
                    name: q.slot.clone(),
                    hash: String::new(),
                    last_turn: turn,
                    emitted: 0,
                    emitted_bytes: 0,
                    suppressed: 0,
                    suppressed_bytes: 0,
                });
                s.slots.len() - 1
            }
        };
        let slot = &mut s.slots[i];
        let decision = if slot.hash.is_empty() || q.force || slot.hash != q.hash {
            Decision::Emit
        } else if turn.saturating_sub(slot.last_turn) >= q.every {
            Decision::Keepalive
        } else {
            Decision::Suppress
        };
        match decision {
            Decision::Emit => {
                slot.hash = q.hash.clone();
                slot.last_turn = turn;
                slot.emitted += 1;
                slot.emitted_bytes += q.len as u64;
            }
            Decision::Keepalive => {
                slot.last_turn = turn;
                slot.emitted += 1;
                slot.emitted_bytes += q.keep_len as u64;
                slot.suppressed_bytes += q.len.saturating_sub(q.keep_len) as u64;
            }
            Decision::Suppress => {
                slot.suppressed += 1;
                slot.suppressed_bytes += q.len as u64;
            }
        }
        g.evictions += dropped;
        decision
    }

    /// The memory held.
    pub fn stats(&self) -> Stats {
        let g = self.lock();
        let per = defaults::num("inject_gate.slot_overhead_bytes") as usize;
        let slots: usize = g.sessions.values().map(|s| s.slots.len()).sum();
        let names: usize = g
            .sessions
            .iter()
            .map(|(k, s)| k.len() + std::mem::size_of::<Session>() + s.slots.iter().map(|x| x.agent.len() + x.name.len() + x.hash.len()).sum::<usize>())
            .sum();
        Stats { sessions: g.sessions.len(), slots, bytes: names + slots * per, evictions: g.evictions }
    }

    /// Per session and block: what was passed on and what was kept out, in bytes and blocks (the daemon's `gate` control verb).
    pub fn report(&self) -> Value {
        let st = self.stats();
        let g = self.lock();
        let mut sessions: Vec<(&String, &Session)> = g.sessions.iter().collect();
        sessions.sort_by_key(|(_, s)| std::cmp::Reverse(s.seq));
        let rows: Vec<Value> = sessions
            .iter()
            .map(|(id, s)| {
                let slots: Vec<Value> = s
                    .slots
                    .iter()
                    .map(|x| {
                        json!({"agent": x.agent, "slot": x.name, "emitted": x.emitted, "emitted_bytes": x.emitted_bytes, "suppressed": x.suppressed, "suppressed_bytes": x.suppressed_bytes})
                    })
                    .collect();
                json!({"session": id, "turn": s.turn, "slots": slots})
            })
            .collect();
        json!({
            "sessions": st.sessions, "slots": st.slots, "bytes": st.bytes, "evictions": st.evictions,
            "max_sessions": defaults::num("inject_gate.max_sessions"), "max_slots": defaults::num("inject_gate.max_slots"),
            "per_session": rows,
        })
    }
}

/// The process-wide gate: the daemon's own state, or, with `dispatch.in_process`, the hook client's.
pub fn global() -> &'static Gate {
    static G: OnceLock<Gate> = OnceLock::new();
    G.get_or_init(Gate::new)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn q(slot: &str, hash: &str, every: u64) -> Query {
        Query { slot: slot.into(), cut: "t".into(), hash: hash.into(), len: 100, keep_len: 20, every, force: false }
    }

    #[test]
    fn first_is_emitted_unchanged_is_suppressed_changed_is_emitted_again() {
        let g = Gate::new();
        g.turn("s");
        assert_eq!(g.decide("s", "", &q("a", "h1", 5)), Decision::Emit, "first injection");
        g.turn("s");
        assert_eq!(g.decide("s", "", &q("a", "h1", 5)), Decision::Suppress, "unchanged");
        g.turn("s");
        assert_eq!(g.decide("s", "", &q("a", "h2", 5)), Decision::Emit, "changed");
        g.turn("s");
        assert_eq!(g.decide("s", "", &q("a", "h2", 5)), Decision::Suppress);
    }

    #[test]
    fn an_unchanged_block_comes_back_as_a_keepalive_after_n_turns() {
        let g = Gate::new();
        g.turn("s");
        assert_eq!(g.decide("s", "", &q("a", "h", 3)), Decision::Emit);
        let mut seen = Vec::new();
        for _ in 0..6 {
            g.turn("s");
            seen.push(g.decide("s", "", &q("a", "h", 3)));
        }
        use Decision::*;
        assert_eq!(seen, [Suppress, Suppress, Keepalive, Suppress, Suppress, Keepalive]);
    }

    #[test]
    fn a_reset_makes_the_next_block_whole_a_new_session_is_whole_and_agents_are_separate() {
        let g = Gate::new();
        g.turn("s");
        assert_eq!(g.decide("s", "", &q("a", "h", 9)), Decision::Emit);
        assert_eq!(g.decide("s", "", &q("a", "h", 9)), Decision::Suppress);
        assert_eq!(g.decide("s", "agent-1", &q("a", "h", 9)), Decision::Emit, "a subagent has its own context");
        g.reset("s"); // after compaction
        assert_eq!(g.decide("s", "", &q("a", "h", 9)), Decision::Emit);
        assert_eq!(g.decide("other", "", &q("a", "h", 9)), Decision::Emit, "a new session");
    }

    #[test]
    fn force_emits_and_restarts_the_count() {
        let g = Gate::new();
        g.turn("s");
        g.decide("s", "", &q("a", "h", 2));
        g.turn("s");
        let mut f = q("a", "h", 2);
        f.force = true;
        assert_eq!(g.decide("s", "", &f), Decision::Emit);
        g.turn("s");
        assert_eq!(g.decide("s", "", &q("a", "h", 2)), Decision::Suppress, "the count restarted at the forced block");
    }

    #[test]
    fn the_memory_is_bounded_and_counted() {
        let g = Gate::new();
        let (ms, mslots) = (defaults::num("inject_gate.max_sessions") as usize, defaults::num("inject_gate.max_slots") as usize);
        for i in 0..ms + 10 {
            g.decide(&format!("s{i}"), "", &q("a", "h", 9));
        }
        let st = g.stats();
        assert_eq!(st.sessions, ms);
        assert_eq!(st.evictions, 10);
        assert_eq!(g.decide("s0", "", &q("a", "h", 9)), Decision::Emit, "the evicted session is simply whole again");
        for i in 0..mslots + 5 {
            g.decide("big", "", &q(&format!("slot{i}"), "h", 9));
        }
        assert!(g.report()["per_session"].as_array().unwrap().iter().any(|s| s["session"] == "big" && s["slots"].as_array().unwrap().len() == mslots));
        assert!(g.stats().bytes > 0);
    }

    #[test]
    fn what_a_client_sends_is_bounded_before_it_is_kept() {
        let g = Gate::new();
        let huge = "x".repeat(100_000);
        let mut big = q(&huge, &huge, 5);
        big.cut = huge.clone();
        assert_eq!(g.decide(&huge, &huge, &big), Decision::Emit);
        assert_eq!(g.decide(&huge, &huge, &big), Decision::Suppress, "the cut names still identify the same block");
        assert!(g.stats().bytes < 4096, "{:?}", g.stats());
    }

    #[test]
    fn the_report_counts_bytes_both_ways() {
        let g = Gate::new();
        g.turn("s");
        g.decide("s", "", &q("a", "h", 2));
        g.turn("s");
        g.decide("s", "", &q("a", "h", 2));
        g.turn("s");
        g.decide("s", "", &q("a", "h", 2)); // keepalive: 20 emitted, 80 saved
        let r = g.report();
        let slot = &r["per_session"][0]["slots"][0];
        assert_eq!((slot["emitted"].as_u64(), slot["emitted_bytes"].as_u64()), (Some(2), Some(120)));
        assert_eq!((slot["suppressed"].as_u64(), slot["suppressed_bytes"].as_u64()), (Some(1), Some(180)));
    }
}
