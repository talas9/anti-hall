//! What the server knows, and the changes between its states. Every change gets a sequence number and is kept in a short ring, so a
//! stream asks "what moved since n" and is answered with one merged [`Delta`]; a stream that fell behind the ring gets a snapshot.
use ah_web_proto::{ActionEvt, Agent, Decision, Delta, FeedItem, JevEvt, Pulse, Snapshot};
use std::collections::{BTreeMap, VecDeque};

/// What one poll found (every field is "unchanged" when `None` / empty).
#[derive(Default)]
pub struct Found {
    pub engine_ok: Option<bool>,
    pub generated_ms: Option<u64>,
    pub pulse: Option<Pulse>,
    /// The full agent list when it was re-read; `None` when the engine said it is unchanged.
    pub agents: Option<Vec<Agent>>,
    pub feed: Vec<(u64, String, String)>,
    pub decisions: Vec<Decision>,
    pub actions: Vec<ActionEvt>,
    pub jev: Vec<JevEvt>,
    pub rev: Option<String>,
}

/// The reply to "what moved since".
pub enum Out {
    Nothing,
    Delta(Delta),
    Snapshot(Snapshot),
}

pub struct Model {
    seq: u64,
    engine_ok: bool,
    generated_ms: u64,
    agents: BTreeMap<String, Agent>,
    pulse: Option<Pulse>,
    feed: VecDeque<FeedItem>,
    feed_n: u64,
    ring: VecDeque<Delta>,
    ring_cap: usize,
    feed_cap: usize,
    recent: VecDeque<Decision>,
    recent_cap: usize,
    /// Cursors for the poller: the agent revision, the last decision and mesh message seen.
    pub rev: String,
    pub decisions_seq: u64,
    pub mesh_after: i64,
    pub mesh_reads_after: i64,
    /// Where the action log was read up to (`None` before the first read).
    pub actions_off: Option<u64>,
    pub jev_off: Option<u64>,
    /// False until the first poll has been folded in: a tab connecting before it would be shown an engine that "does not answer".
    pub ready: bool,
}

impl Model {
    pub fn new(ring_cap: usize, feed_cap: usize, recent_cap: usize) -> Model {
        Model {
            seq: 0,
            engine_ok: false,
            generated_ms: 0,
            agents: BTreeMap::new(),
            pulse: None,
            feed: VecDeque::new(),
            feed_n: 0,
            ring: VecDeque::new(),
            ring_cap: ring_cap.max(1),
            feed_cap: feed_cap.max(1),
            recent: VecDeque::new(),
            recent_cap,
            rev: String::new(),
            decisions_seq: 0,
            mesh_after: -1,
            mesh_reads_after: 0,
            actions_off: None,
            jev_off: None,
            ready: false,
        }
    }

    /// Fold one poll's findings in; the change (if any) becomes the next sequence number.
    pub fn commit(&mut self, f: Found) {
        self.ready = true;
        let mut d = Delta::default();
        if let Some(ok) = f.engine_ok.filter(|ok| *ok != self.engine_ok) {
            self.engine_ok = ok;
            d.engine_ok = Some(ok);
        }
        if let Some(r) = f.rev {
            self.rev = r;
        }
        if let Some(list) = f.agents {
            let mut next: BTreeMap<String, Agent> =
                list.into_iter().map(|a| (a.id.clone(), a)).collect();
            d.removed = self
                .agents
                .keys()
                .filter(|k| !next.contains_key(*k))
                .cloned()
                .collect();
            d.upsert = next
                .values()
                .filter(|a| self.agents.get(&a.id) != Some(*a))
                .cloned()
                .collect();
            std::mem::swap(&mut self.agents, &mut next);
            if let Some(g) = f.generated_ms.filter(|g| *g != self.generated_ms) {
                self.generated_ms = g;
                d.generated_ms = Some(g);
            }
        }
        if let Some(p) = f.pulse.filter(|p| self.pulse.as_ref() != Some(p)) {
            self.pulse = Some(p.clone());
            d.pulse = Some(p);
        }
        for (ts_ms, tone, text) in f.feed {
            self.feed_n += 1;
            let item = FeedItem {
                n: self.feed_n,
                ts_ms,
                tone,
                text,
            };
            self.feed.push_back(item.clone());
            while self.feed.len() > self.feed_cap {
                self.feed.pop_front();
            }
            d.feed.push(item);
        }
        for x in f.decisions {
            self.recent.push_back(x.clone());
            while self.recent.len() > self.recent_cap {
                self.recent.pop_front();
            }
            d.decisions.push(x);
        }
        d.actions = f.actions;
        d.jev = f.jev;
        if d.engine_ok.is_none()
            && d.generated_ms.is_none()
            && d.pulse.is_none()
            && d.upsert.is_empty()
            && d.removed.is_empty()
            && d.feed.is_empty()
            && d.decisions.is_empty()
            && d.actions.is_empty()
            && d.jev.is_empty()
        {
            return;
        }
        self.seq += 1;
        d.seq = self.seq;
        self.ring.push_back(d);
        while self.ring.len() > self.ring_cap {
            self.ring.pop_front();
        }
    }

    /// The tracked agent a (possibly shortened) id belongs to: an exact id, else the one it is the start of (or that starts with it).
    pub fn lookup(&self, id: &str, min_chars: usize) -> Option<Agent> {
        if id.is_empty() {
            return None;
        }
        self.agents.get(id).cloned().or_else(|| {
            (id.len() >= min_chars)
                .then(|| {
                    self.agents
                        .values()
                        .find(|a| !a.placeholder && (a.id.starts_with(id) || id.starts_with(&a.id)))
                        .cloned()
                })
                .flatten()
        })
    }

    pub fn snapshot(&self) -> Snapshot {
        Snapshot {
            seq: self.seq,
            pulse: self.pulse.clone(),
            feed: self.feed.iter().cloned().collect(),
            generated_ms: self.generated_ms,
            engine_ok: self.engine_ok,
            agents: self.agents.values().cloned().collect(),
            decisions: self.recent.iter().cloned().collect(),
        }
    }

    /// Everything that moved after `last`, merged into one delta.
    pub fn since(&self, last: u64) -> Out {
        if last == self.seq {
            return Out::Nothing;
        }
        // the ring holds seq-len+1 ..= seq; anything older than its first entry is a gap
        let first = self.ring.front().map_or(self.seq + 1, |d| d.seq);
        if last > self.seq || last + 1 < first {
            return Out::Snapshot(self.snapshot());
        }
        let mut out = Delta {
            seq: self.seq,
            ..Delta::default()
        };
        let mut up: BTreeMap<String, Agent> = BTreeMap::new();
        for d in self.ring.iter().filter(|d| d.seq > last) {
            out.engine_ok = d.engine_ok.or(out.engine_ok);
            out.generated_ms = d.generated_ms.or(out.generated_ms);
            if d.pulse.is_some() {
                out.pulse = d.pulse.clone();
            }
            for a in &d.upsert {
                out.removed.retain(|r| *r != a.id);
                up.insert(a.id.clone(), a.clone());
            }
            for r in &d.removed {
                up.remove(r);
                if !out.removed.contains(r) {
                    out.removed.push(r.clone());
                }
            }
            out.feed.extend(d.feed.iter().cloned());
            out.decisions.extend(d.decisions.iter().cloned());
            out.actions.extend(d.actions.iter().cloned());
            out.jev.extend(d.jev.iter().cloned());
        }
        out.upsert = up.into_values().collect();
        Out::Delta(out)
    }
}
