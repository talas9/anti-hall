//! The transcript gate: whether a transcript event is worth reacting to. It only stats (inode, size) and never reads a transcript.
//!
//! A session appends to its transcript many times a second while it works, and every append is a file event. Reacting to each (a
//! Jev sweep mark, a stuck re-check) is wasted work: one reaction per `devswarm_wire.transcript_min_interval_ms` per workspace is
//! as informative. The gate acts only when a watched file GREW (a new inode counts as growth, a smaller size under the same inode
//! does not) and the interval since the workspace's last reaction has passed. Growth that arrives inside the interval is not
//! dropped: the gate keeps a deadline and acts on it once, when the interval ends ([`TranscriptGate::tick`]).
use std::collections::HashMap;
use std::os::unix::fs::MetadataExt;
use std::path::PathBuf;
use std::time::{Duration, Instant};

/// What identifies a version of a transcript for the gate.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Stat {
    ino: u64,
    size: u64,
}

fn stat(p: &std::path::Path) -> Option<Stat> {
    std::fs::metadata(p).ok().map(|m| Stat { ino: m.ino(), size: m.size() })
}

#[derive(Default)]
struct Slot {
    /// The files seen for this workspace and their state when the gate last acted (or last absorbed a shrink).
    base: HashMap<PathBuf, Stat>,
    last_act: Option<Instant>,
    /// When growth held back by the interval is acted on.
    due: Option<Instant>,
}

/// The per-workspace gate.
pub struct TranscriptGate {
    min: Duration,
    slots: HashMap<String, Slot>,
}

impl TranscriptGate {
    /// A gate that acts at most once per `min` per workspace.
    pub fn new(min: Duration) -> TranscriptGate {
        TranscriptGate { min, slots: HashMap::new() }
    }

    /// Use another interval (the setting changed).
    pub fn set_min(&mut self, min: Duration) {
        self.min = min;
    }

    /// Whether any of `paths` (files of workspace `id`'s transcript directory, as reported by an event) grew since the gate last
    /// acted. Does the workspace's reaction belong NOW: true when something grew and the interval has passed (the new state is then
    /// the baseline); false when nothing grew, or when the growth must wait for the interval (a deadline is kept).
    pub fn observe(&mut self, id: &str, paths: &[PathBuf], now: Instant) -> bool {
        let slot = self.slots.entry(id.to_string()).or_default();
        let mut now_stats: Vec<(PathBuf, Stat)> = Vec::new();
        let mut grew = false;
        for p in paths {
            let Some(cur) = stat(p) else {
                slot.base.remove(p); // gone: a file that comes back is new
                continue;
            };
            now_stats.push((p.clone(), cur));
            match slot.base.get(p) {
                Some(b) if b.ino == cur.ino && cur.size <= b.size => {
                    if cur.size < b.size {
                        slot.base.insert(p.clone(), cur); // truncated in place: the new size is the baseline, nothing grew
                    }
                }
                _ => grew = true,
            }
        }
        if !grew {
            return false;
        }
        if slot.last_act.is_none_or(|t| now.saturating_duration_since(t) >= self.min) {
            slot.base.extend(now_stats); // the state acted on is the baseline for the next growth
            slot.last_act = Some(now);
            slot.due = None;
            return true;
        }
        for (p, _) in now_stats {
            slot.base.entry(p).or_insert(Stat { ino: 0, size: 0 }); // known to the deadline check, still counts as growth
        }
        let at = slot.last_act.map_or(now, |t| t + self.min);
        slot.due = Some(slot.due.map_or(at, |d| d.min(at)));
        false
    }

    /// The workspaces whose held-back growth is due at `now` and that still show it. Their baseline is refreshed.
    pub fn tick(&mut self, now: Instant) -> Vec<String> {
        let mut out = Vec::new();
        for (id, slot) in self.slots.iter_mut() {
            if slot.due.is_none_or(|d| d > now) {
                continue;
            }
            slot.due = None;
            if slot.base.iter().any(|(p, b)| stat(p).is_some_and(|c| c.ino != b.ino || c.size > b.size)) {
                for (p, b) in slot.base.iter_mut() {
                    if let Some(c) = stat(p) {
                        *b = c;
                    }
                }
                slot.last_act = Some(now);
                out.push(id.clone());
            }
        }
        out
    }

    /// The earliest held-back deadline, so the thread can sleep until then.
    pub fn next_due(&self) -> Option<Instant> {
        self.slots.values().filter_map(|s| s.due).min()
    }

    /// Forget workspaces not in `keep` (they are no longer watched).
    pub fn retain(&mut self, keep: &dyn Fn(&str) -> bool) {
        self.slots.retain(|id, _| keep(id));
    }
}
