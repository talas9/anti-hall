//! The telemetry hot path (D78): counters and a bounded ring of rich events, in memory, with no I/O and no shared lock.
//!
//! Recording an invocation is a hash of its four labels (`k`, `h`, `e`, `o`), one lookup in a small open-addressed
//! table, and a handful of relaxed atomic additions (count, latency sum, injected-bytes sum, one latency bucket). The
//! tables are sharded: each thread uses the shard its thread id maps to, so threads rarely touch the same cache line.
//! A new label combination claims a free slot with one compare-and-swap; when a shard is full the sample is counted as
//! dropped instead of waiting for anything. Rich events (routing decisions, spawn results, Jev calls, spills) go into a
//! ring whose slots are written by index, so concurrent writers do not meet.
//!
//! The recorder never writes to disk. [`Recorder::drain`] hands the flusher what was recorded since the last
//! [`Recorder::commit`]; the flusher stores it (`persist`), and only then moves the cursors forward, so a failed
//! store is retried with nothing lost. Everything recorded after the last flush is lost on `kill -9`: that window is
//! `telemetry.flush_ms`.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an absent field is the empty value
// A failure that must be seen goes through `crate::discard` instead.

use super::event::{Event, Kind, Outcome, sanitize_name};
use crate::defaults;
use std::cell::Cell;
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering::Relaxed};
use std::sync::{Mutex, OnceLock};

/// Position of the count in a slot's fields; the latency sum (microseconds) and injected bytes follow, then the buckets.
const F_N: usize = 0;
const F_US: usize = 1;
const F_IB: usize = 2;
const F_BUCKETS: usize = 3;

/// What was recorded for one (k, h, e, o) combination since some cursor: the unit the store keeps per day.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Delta {
    /// Kind name.
    pub k: String,
    /// Hook or check name.
    pub h: String,
    /// Hook event name.
    pub e: String,
    /// Outcome name.
    pub o: String,
    /// Invocations.
    pub n: u64,
    /// Sum of latencies, microseconds.
    pub us_sum: u64,
    /// Sum of injected bytes.
    pub ib_sum: u64,
    /// Count per latency bucket (`telemetry.latency_buckets_us`, plus one for values above the last bound).
    pub hist: Vec<u64>,
}

impl Delta {
    /// Add `other` (same labels) into this one.
    pub fn merge(&mut self, other: &Delta) {
        self.n += other.n;
        self.us_sum += other.us_sum;
        self.ib_sum += other.ib_sum;
        if self.hist.len() < other.hist.len() {
            self.hist.resize(other.hist.len(), 0);
        }
        for (a, b) in self.hist.iter_mut().zip(&other.hist) {
            *a += b;
        }
    }
}

/// The labels of a slot, set once by the thread that claimed it.
struct Names {
    k: &'static str,
    h: String,
    e: String,
    o: &'static str,
}

struct Slot {
    /// Fingerprint of the labels; 0 while the slot is free.
    fp: AtomicU64,
    names: OnceLock<Names>,
    f: Box<[AtomicU64]>,
    /// What the flusher has already stored, per field.
    flushed: Box<[AtomicU64]>,
    /// What the metrics mirror has already added to the registry: count and injected bytes.
    mirrored: [AtomicU64; 2],
}

impl Slot {
    fn new(fields: usize) -> Slot {
        let zeros = |n: usize| (0..n).map(|_| AtomicU64::new(0)).collect::<Vec<_>>().into_boxed_slice();
        Slot { fp: AtomicU64::new(0), names: OnceLock::new(), f: zeros(fields), flushed: zeros(fields), mirrored: [AtomicU64::new(0), AtomicU64::new(0)] }
    }
}

struct Shard {
    slots: Box<[Slot]>,
}

/// A ring slot: the index the event was pushed at, and the event.
type Published = Option<(u64, Event)>;

/// One claimed slot as the flusher sees it: shard, slot, labels, current fields, flushed fields.
type SlotView<'a> = (usize, usize, &'a Names, Vec<u64>, Vec<u64>);

/// A bounded ring of events written by index.
struct Ring {
    slots: Box<[Mutex<Published>]>,
    /// Total events ever pushed (the next index to write).
    head: AtomicU64,
    /// Everything before this index has been flushed.
    cursor: AtomicU64,
    /// Events overwritten before they were flushed.
    lost: AtomicU64,
}

fn lk<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// What [`Recorder::drain`] took: the deltas, the events, and the cursors to move forward once they are stored.
pub struct Pending {
    /// Counter deltas since the last commit, merged across shards.
    pub deltas: Vec<Delta>,
    /// Ring events since the last commit, oldest first.
    pub events: Vec<Event>,
    cells: Vec<(usize, usize, Vec<u64>)>,
    ring_to: u64,
    ring_lost: u64,
}

impl Pending {
    /// True when there is nothing to store.
    pub fn is_empty(&self) -> bool {
        self.deltas.is_empty() && self.events.is_empty()
    }
}

/// Counts of what the recorder could not keep.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Drops {
    /// Samples refused because a shard's table was full.
    pub slots: u64,
    /// Events overwritten in the ring before a flush.
    pub ring: u64,
}

/// The in-memory recorder. See the module docs.
pub struct Recorder {
    enabled: AtomicBool,
    shards: Box<[Shard]>,
    bounds: Vec<u64>,
    fields: usize,
    name_cap: usize,
    ring: Ring,
    dropped_slots: AtomicU64,
    flush_lock: Mutex<()>,
}

static NEXT_THREAD: AtomicUsize = AtomicUsize::new(0);

thread_local! {
    static THREAD_ID: Cell<Option<usize>> = const { Cell::new(None) };
}

/// A small stable number for the calling thread.
fn thread_id() -> usize {
    THREAD_ID.with(|c| match c.get() {
        Some(i) => i,
        None => {
            let i = NEXT_THREAD.fetch_add(1, Relaxed);
            c.set(Some(i));
            i
        }
    })
}

/// FNV-1a over the labels (names capped to `cap` bytes, the same cap the stored names get).
fn fingerprint(kind: Kind, h: &str, e: &str, o: Outcome, cap: usize) -> u64 {
    let mut x: u64 = 0xcbf2_9ce4_8422_2325;
    let mut eat = |b: u8| x = (x ^ b as u64).wrapping_mul(0x0100_0000_01b3);
    for b in h.bytes().take(cap) {
        eat(b);
    }
    eat(0xff);
    for b in e.bytes().take(cap) {
        eat(b);
    }
    eat(kind as u8);
    eat(o as u8);
    if x == 0 { 1 } else { x }
}

impl Recorder {
    /// A recorder sized from the shipped defaults (`telemetry.shards`, `.slots`, `.ring_size`, latency buckets).
    pub fn from_defaults() -> Recorder {
        let bounds: Vec<u64> = defaults::raw("telemetry.latency_buckets_us")
            .as_array()
            .unwrap_or_default()
            .iter()
            .filter_map(defaults::V::as_integer)
            .map(|v| v.max(0) as u64)
            .collect();
        Recorder::new(
            defaults::num("telemetry.shards") as usize,
            defaults::num("telemetry.slots") as usize,
            defaults::num("telemetry.ring_size") as usize,
            bounds,
        )
    }

    /// A recorder with `shards` tables of `slots` slots each (rounded up to a power of two), a ring of `ring` events and
    /// the given latency bucket bounds (microseconds).
    pub fn new(shards: usize, slots: usize, ring: usize, bounds: Vec<u64>) -> Recorder {
        let slots = slots.max(2).next_power_of_two();
        let fields = F_BUCKETS + bounds.len() + 1;
        let shards =
            (0..shards.max(1)).map(|_| Shard { slots: (0..slots).map(|_| Slot::new(fields)).collect::<Vec<_>>().into_boxed_slice() }).collect::<Vec<_>>();
        let ring = Ring {
            slots: (0..ring.max(1)).map(|_| Mutex::new(None)).collect::<Vec<_>>().into_boxed_slice(),
            head: AtomicU64::new(0),
            cursor: AtomicU64::new(0),
            lost: AtomicU64::new(0),
        };
        Recorder {
            enabled: AtomicBool::new(true),
            shards: shards.into_boxed_slice(),
            bounds,
            fields,
            name_cap: defaults::num("telemetry.token_max_len") as usize,
            ring,
            dropped_slots: AtomicU64::new(0),
            flush_lock: Mutex::new(()),
        }
    }

    /// Turn recording on or off (`telemetry.enabled`); while off, [`Recorder::record`] returns at once.
    pub fn set_enabled(&self, on: bool) {
        self.enabled.store(on, Relaxed);
    }

    /// True while recording is on.
    pub fn enabled(&self) -> bool {
        self.enabled.load(Relaxed)
    }

    /// The latency bucket bounds in microseconds.
    pub fn bounds(&self) -> &[u64] {
        &self.bounds
    }

    /// Find or claim the slot for `fp` in `shard`; `None` when the table is full.
    fn find<'a>(&self, shard: &'a Shard, fp: u64, names: impl FnOnce() -> Names) -> Option<&'a Slot> {
        let mask = shard.slots.len() - 1;
        let mut i = (fp as usize) & mask;
        for _ in 0..shard.slots.len() {
            let s = &shard.slots[i];
            let cur = s.fp.load(Relaxed);
            if cur == fp {
                return Some(s);
            }
            if cur == 0 {
                match s.fp.compare_exchange(0, fp, Relaxed, Relaxed) {
                    Ok(_) => {
                        crate::discard::harmless(s.names.set(names())); // keep: the cell was already set by another thread
                        return Some(s);
                    }
                    Err(other) if other == fp => return Some(s),
                    Err(_) => {}
                }
            }
            i = (i + 1) & mask;
        }
        None
    }

    /// Count one invocation: kind, hook or check, event, outcome, latency in microseconds, bytes injected into model
    /// context. No I/O, no lock, no allocation unless the combination is new.
    pub fn record(&self, kind: Kind, h: &str, e: &str, o: Outcome, micros: u64, ib: u64) {
        if !self.enabled.load(Relaxed) {
            return;
        }
        let fp = fingerprint(kind, h, e, o, self.name_cap);
        let shard = &self.shards[thread_id() % self.shards.len()];
        let make =
            || Names { k: kind.name(), h: sanitize_name(h.as_bytes()).unwrap_or_default(), e: sanitize_name(e.as_bytes()).unwrap_or_default(), o: o.name() };
        let Some(s) = self.find(shard, fp, make) else {
            self.dropped_slots.fetch_add(1, Relaxed);
            return;
        };
        let b = self.bounds.iter().position(|b| micros <= *b).unwrap_or(self.bounds.len());
        s.f[F_N].fetch_add(1, Relaxed);
        s.f[F_US].fetch_add(micros, Relaxed);
        s.f[F_IB].fetch_add(ib, Relaxed);
        s.f[F_BUCKETS + b].fetch_add(1, Relaxed);
    }

    /// Count an event like [`Recorder::record`] and keep it in the ring for the next flush.
    pub fn event(&self, ev: Event) {
        if !self.enabled.load(Relaxed) {
            return;
        }
        self.record(ev.kind, ev.h.as_str(), ev.e.as_str(), ev.o, ev.ms as u64 * 1000, ev.ib);
        let i = self.ring.head.fetch_add(1, Relaxed);
        let slot = &self.ring.slots[(i % self.ring.slots.len() as u64) as usize];
        *lk(slot) = Some((i, ev));
    }

    fn delta_of(&self, names: &Names, cur: &[u64], flushed: &[u64]) -> Delta {
        let d = |i: usize| cur[i].saturating_sub(flushed[i]);
        Delta {
            k: names.k.to_string(),
            h: names.h.clone(),
            e: names.e.clone(),
            o: names.o.to_string(),
            n: d(F_N),
            us_sum: d(F_US),
            ib_sum: d(F_IB),
            hist: (F_BUCKETS..self.fields).map(d).collect(),
        }
    }

    /// Walk every claimed slot: `(shard, slot, names, current fields, flushed fields)`.
    fn cells(&self) -> Vec<SlotView<'_>> {
        let mut out = Vec::new();
        for (si, sh) in self.shards.iter().enumerate() {
            for (i, s) in sh.slots.iter().enumerate() {
                let Some(names) = s.names.get() else { continue };
                let cur: Vec<u64> = s.f.iter().map(|a| a.load(Relaxed)).collect();
                let fl: Vec<u64> = s.flushed.iter().map(|a| a.load(Relaxed)).collect();
                out.push((si, i, names, cur, fl));
            }
        }
        out
    }

    /// What has been recorded since the last commit, merged across shards, without moving any cursor (for live reports).
    pub fn pending_deltas(&self) -> Vec<Delta> {
        let mut by: BTreeMap<(String, String, String, String), Delta> = BTreeMap::new();
        for (_, _, names, cur, fl) in self.cells() {
            let d = self.delta_of(names, &cur, &fl);
            if d.n == 0 && d.us_sum == 0 && d.ib_sum == 0 {
                continue;
            }
            match by.get_mut(&(d.k.clone(), d.h.clone(), d.e.clone(), d.o.clone())) {
                Some(x) => x.merge(&d),
                None => {
                    by.insert((d.k.clone(), d.h.clone(), d.e.clone(), d.o.clone()), d);
                }
            }
        }
        by.into_values().collect()
    }

    /// Ring events since the last commit that are held and not in `drained`, oldest first, without moving the cursor.
    pub fn pending_events(&self) -> Vec<Event> {
        self.read_ring().0
    }

    fn read_ring(&self) -> (Vec<Event>, u64, u64) {
        let head = self.ring.head.load(Relaxed);
        let cap = self.ring.slots.len() as u64;
        let cursor = self.ring.cursor.load(Relaxed);
        let start = cursor.max(head.saturating_sub(cap));
        let lost = start - cursor;
        let mut out = Vec::new();
        let mut to = start;
        for i in start..head {
            match &*lk(&self.ring.slots[(i % cap) as usize]) {
                Some((s, ev)) if *s == i => {
                    out.push(ev.clone());
                    to = i + 1;
                }
                _ => break, // pushed but not yet stored: the next flush takes it
            }
        }
        (out, to, lost)
    }

    /// Take everything recorded since the last commit. The caller stores it and then calls [`Recorder::commit`]; until
    /// then nothing is forgotten, so a failed store is simply retried. One flusher at a time (see [`Recorder::flush_guard`]).
    pub fn drain(&self) -> Pending {
        let mut by: BTreeMap<(String, String, String, String), Delta> = BTreeMap::new();
        let mut cells = Vec::new();
        for (si, i, names, cur, fl) in self.cells() {
            let d = self.delta_of(names, &cur, &fl);
            if d.n == 0 && d.us_sum == 0 && d.ib_sum == 0 {
                continue;
            }
            match by.get_mut(&(d.k.clone(), d.h.clone(), d.e.clone(), d.o.clone())) {
                Some(x) => x.merge(&d),
                None => {
                    by.insert((d.k.clone(), d.h.clone(), d.e.clone(), d.o.clone()), d);
                }
            }
            cells.push((si, i, cur));
        }
        let (events, ring_to, ring_lost) = self.read_ring();
        Pending { deltas: by.into_values().collect(), events, cells, ring_to, ring_lost }
    }

    /// The deltas and events in `p` are stored: move the cursors past them.
    pub fn commit(&self, p: Pending) {
        for (si, i, cur) in p.cells {
            for (a, v) in self.shards[si].slots[i].flushed.iter().zip(cur) {
                a.store(v, Relaxed);
            }
        }
        self.ring.lost.fetch_add(p.ring_lost, Relaxed);
        self.ring.cursor.fetch_max(p.ring_to, Relaxed);
    }

    /// Held for the whole drain-store-commit cycle, so two flushers cannot store the same delta twice.
    pub fn flush_guard(&self) -> std::sync::MutexGuard<'_, ()> {
        lk(&self.flush_lock)
    }

    /// What could not be kept so far.
    pub fn drops(&self) -> Drops {
        Drops { slots: self.dropped_slots.load(Relaxed), ring: self.ring.lost.load(Relaxed) }
    }

    /// Add what was recorded since the last call to the metrics registry as `tel_events` and `tel_injected_bytes`, so
    /// `ah-engine metrics` shows the same counts (D51). The caller holds the registry's lock, which also serialises calls.
    pub fn mirror_into(&self, m: &mut crate::metrics::Metrics) {
        let mut n_by: BTreeMap<(&str, &str, &str, &str), u64> = BTreeMap::new();
        let mut ib_by: BTreeMap<(&str, &str), u64> = BTreeMap::new();
        for sh in self.shards.iter() {
            for s in sh.slots.iter() {
                let Some(nm) = s.names.get() else { continue };
                let (n, ib) = (s.f[F_N].load(Relaxed), s.f[F_IB].load(Relaxed));
                let (dn, dib) = (n.saturating_sub(s.mirrored[0].swap(n, Relaxed)), ib.saturating_sub(s.mirrored[1].swap(ib, Relaxed)));
                *n_by.entry((nm.k, nm.h.as_str(), nm.e.as_str(), nm.o)).or_insert(0) += dn;
                *ib_by.entry((nm.h.as_str(), nm.e.as_str())).or_insert(0) += dib;
            }
        }
        for ((k, h, e, o), n) in n_by.into_iter().filter(|(_, n)| *n > 0) {
            m.add("tel_events", &[("k", k), ("h", h), ("e", e), ("o", o)], n);
        }
        for ((h, e), n) in ib_by.into_iter().filter(|(_, n)| *n > 0) {
            m.add("tel_injected_bytes", &[("h", h), ("e", e)], n);
        }
        let d = self.drops();
        for (reason, n) in [("slots", d.slots), ("ring", d.ring)] {
            let seen = m.counter("tel_dropped", &[("reason", reason)]);
            if n > seen {
                m.add("tel_dropped", &[("reason", reason)], n - seen);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::event::{Extras, Token};
    use super::*;
    use std::sync::Arc;

    fn rec() -> Recorder {
        Recorder::new(4, 64, 8, vec![100, 1000])
    }

    fn total(r: &Recorder) -> (u64, u64, u64) {
        r.pending_deltas().iter().fold((0, 0, 0), |a, d| (a.0 + d.n, a.1 + d.us_sum, a.2 + d.ib_sum))
    }

    #[test]
    fn counts_sums_and_buckets_are_kept_per_label_combination() {
        let r = rec();
        r.record(Kind::Check, "git", "PreToolUse", Outcome::Block, 50, 0);
        r.record(Kind::Check, "git", "PreToolUse", Outcome::Block, 500, 0);
        r.record(Kind::Check, "git", "PreToolUse", Outcome::Advise, 5000, 120);
        let d = r.pending_deltas();
        assert_eq!(d.len(), 2);
        let b = d.iter().find(|x| x.o == "block").unwrap();
        assert_eq!((b.n, b.us_sum, b.ib_sum), (2, 550, 0));
        assert_eq!(b.hist, vec![1, 1, 0], "one value <=100us, one <=1000us, none above");
        let a = d.iter().find(|x| x.o == "advise").unwrap();
        assert_eq!((a.n, a.ib_sum, a.hist.clone()), (1, 120, vec![0, 0, 1]));
    }

    #[test]
    fn counters_are_exact_under_concurrent_hook_calls() {
        let r = Arc::new(Recorder::new(4, 128, 8, vec![100, 1000]));
        let (threads, each) = (8u64, 20_000u64);
        let hs: Vec<_> = (0..threads)
            .map(|t| {
                let r = r.clone();
                std::thread::spawn(move || {
                    for i in 0..each {
                        // every thread hits the same shared labels and some of its own
                        r.record(Kind::Hook, "hook", "PreToolUse", Outcome::Allow, 10, 1);
                        r.record(Kind::Check, ["git", "edit", "ask"][(i % 3) as usize], "PreToolUse", Outcome::Allow, 20, 2);
                        if i % 100 == 0 {
                            r.record(Kind::Check, &format!("own{t}"), "Stop", Outcome::Skip, 30, 0);
                        }
                    }
                })
            })
            .collect();
        for h in hs {
            h.join().unwrap();
        }
        let d = r.pending_deltas();
        let sum = |k: &str, h: &str| d.iter().filter(|x| x.k == k && x.h == h).map(|x| x.n).sum::<u64>();
        assert_eq!(sum("hook", "hook"), threads * each);
        assert_eq!(sum("check", "git") + sum("check", "edit") + sum("check", "ask"), threads * each);
        for t in 0..threads {
            assert_eq!(sum("check", &format!("own{t}")), each / 100);
        }
        let ib: u64 = d.iter().map(|x| x.ib_sum).sum();
        assert_eq!(ib, threads * each * 3, "injected bytes add up exactly too");
        assert_eq!(r.drops(), Drops::default());
    }

    #[test]
    fn a_full_table_drops_and_counts_instead_of_waiting() {
        let r = Recorder::new(1, 4, 2, vec![100]);
        for i in 0..20 {
            r.record(Kind::Check, &format!("c{i}"), "e", Outcome::Allow, 1, 0);
        }
        assert_eq!(total(&r).0, 4, "four slots, four combinations kept");
        assert_eq!(r.drops().slots, 16);
        r.record(Kind::Check, "c0", "e", Outcome::Allow, 1, 0);
        assert_eq!(total(&r).0, 5, "an existing combination still counts when the table is full");
    }

    #[test]
    fn names_from_outside_are_sanitized_and_capped() {
        let r = rec();
        r.record(Kind::Hook, "fix the login bug please", &"e".repeat(500), Outcome::Allow, 1, 0);
        let d = r.pending_deltas();
        assert_eq!(d[0].h, "fix_the_login_bug_please");
        assert_eq!(d[0].e.len(), defaults::num("telemetry.token_max_len") as usize);
    }

    #[test]
    fn drain_and_commit_move_the_cursor_and_a_failed_store_loses_nothing() {
        let r = rec();
        r.record(Kind::Hook, "hook", "Stop", Outcome::Allow, 10, 0);
        let p = r.drain();
        assert_eq!(p.deltas[0].n, 1);
        // the store failed: no commit, so the next drain still has it
        r.record(Kind::Hook, "hook", "Stop", Outcome::Allow, 10, 0);
        let p2 = r.drain();
        assert_eq!(p2.deltas[0].n, 2, "uncommitted work is offered again");
        r.commit(p2);
        assert!(r.drain().is_empty());
        r.record(Kind::Hook, "hook", "Stop", Outcome::Allow, 10, 0);
        assert_eq!(r.drain().deltas[0].n, 1, "only what is new since the commit");
        drop(p);
    }

    fn ev(i: u64) -> Event {
        Event {
            ts_ms: i,
            kind: Kind::Spill,
            h: Token::new("hook").unwrap(),
            e: Token::new("Stop").unwrap(),
            o: Outcome::Advise,
            ms: 1,
            ib: i,
            extras: Extras::Spill(i),
        }
    }

    #[test]
    fn the_ring_is_bounded_ordered_and_flushed_once() {
        let r = rec(); // ring of 8
        for i in 0..5 {
            r.event(ev(i));
        }
        let p = r.drain();
        assert_eq!(p.events.iter().map(|e| e.ts_ms).collect::<Vec<_>>(), vec![0, 1, 2, 3, 4]);
        r.commit(p);
        assert!(r.drain().events.is_empty());
        for i in 5..25 {
            r.event(ev(i));
        }
        let p = r.drain();
        assert_eq!(p.events.len(), 8, "only the newest ring-size events survive");
        assert_eq!(p.events.first().unwrap().ts_ms, 17);
        assert_eq!(p.events.last().unwrap().ts_ms, 24);
        r.commit(p);
        assert_eq!(r.drops().ring, 12, "the overwritten ones are counted");
        // events are counted like invocations too
        assert_eq!(total(&r).0, 0, "after the commit nothing is pending");
    }

    #[test]
    fn disabled_recording_changes_nothing() {
        let r = rec();
        r.set_enabled(false);
        r.record(Kind::Hook, "hook", "Stop", Outcome::Allow, 1, 1);
        r.event(ev(1));
        assert!(r.drain().is_empty());
        r.set_enabled(true);
        r.record(Kind::Hook, "hook", "Stop", Outcome::Allow, 1, 1);
        assert_eq!(total(&r).0, 1);
    }

    #[test]
    fn the_mirror_adds_each_count_to_the_registry_once() {
        let r = rec();
        let mut m = crate::metrics::Metrics::default();
        r.record(Kind::Check, "git", "PreToolUse", Outcome::Advise, 5, 40);
        r.record(Kind::Check, "git", "PreToolUse", Outcome::Advise, 5, 60);
        r.mirror_into(&mut m);
        r.mirror_into(&mut m);
        assert_eq!(m.counter("tel_events", &[("k", "check"), ("h", "git"), ("e", "PreToolUse"), ("o", "advise")]), 2);
        assert_eq!(m.counter("tel_injected_bytes", &[("h", "git"), ("e", "PreToolUse")]), 100);
        r.record(Kind::Check, "git", "PreToolUse", Outcome::Advise, 5, 0);
        r.mirror_into(&mut m);
        assert_eq!(m.counter_total("tel_events"), 3);
    }
}
