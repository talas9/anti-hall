//! The registry: holders, their limits, the soft/hard state machines and the process-wide check. See the module docs of
//! [`super`] for the contract.
use serde_json::{Value, json};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering::SeqCst};
use std::sync::{Arc, Mutex, Weak};
use std::time::Instant;

/// What a registered holder lets the registry do. All three are called outside the registry's own locks, so an owner may take
/// its own lock inside them.
pub trait Owner: Send + Sync {
    /// Bytes held now (an estimate is fine; it must be cheap).
    fn bytes(&self) -> usize;
    /// SOFT: get down to at most `target` bytes (evict least recently used, collect garbage, unload cold parts).
    fn shrink(&self, target: usize);
    /// HARD: drop everything recoverable.
    fn recycle(&self);
}

/// A holder's identity and the config keys its limits are read from (literal keys, so the build checks that they ship).
#[derive(Clone, Copy)]
pub struct Spec {
    /// Name shown in `status --memory`.
    pub name: &'static str,
    /// Key of the soft limit (bytes).
    pub soft: &'static str,
    /// Key of the hard limit (bytes).
    pub hard: &'static str,
    /// Key of the low-water mark, in percent of soft.
    pub low_pct: &'static str,
    /// Key of the entry-count cap, for caches that have one.
    pub entries: Option<&'static str>,
}

impl Spec {
    /// A spec with no entry-count cap.
    pub const fn new(name: &'static str, soft: &'static str, hard: &'static str, low_pct: &'static str) -> Spec {
        Spec { name, soft, hard, low_pct, entries: None }
    }

    /// The same spec with an entry-count cap read from `key`.
    pub const fn with_entries(mut self, key: &'static str) -> Spec {
        self.entries = Some(key);
        self
    }
}

/// What kind of event the sink is told about.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// A soft limit was reached.
    Soft,
    /// A hard limit was crossed.
    Hard,
    /// A clean restart was requested.
    Restart,
}

/// One logged transition.
#[derive(Debug, Clone)]
pub struct Event {
    /// What happened.
    pub kind: Kind,
    /// The holder, or the global name for the process total.
    pub holder: String,
    /// Usage when it happened.
    pub usage: usize,
    /// The limit that was reached.
    pub limit: usize,
}

/// The answer to an insert.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Admit {
    /// Store it.
    Ok,
    /// Do not store it: compute and use the result, keep nothing.
    Refused,
}

/// What an [`Instance`] must do after reporting its size.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    /// Nothing.
    None,
    /// Get down to this many bytes.
    Shrink(usize),
    /// Over the hard limit: drop everything, and fail the call that needed more open.
    Recycle,
}

/// A clean restart the registry asks for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Restart {
    /// The holder that stayed over its hard limit, or the global name for the process total.
    pub holder: String,
    /// Usage now.
    pub usage: usize,
    /// The hard limit.
    pub limit: usize,
    /// Seconds it has been over.
    pub secs: u64,
}

type Lookup = Box<dyn Fn(&str) -> u64 + Send + Sync>;
type Sink = Box<dyn Fn(&Event) + Send + Sync>;

/// The name the process total is reported under.
const GLOBAL_NAME: &str = "global";

#[derive(Default)]
struct Counters {
    soft: AtomicU64,
    hard: AtomicU64,
    refused: AtomicU64,
    recycles: AtomicU64,
}

/// The sizes of the per-worker instances of a holder whose limits apply to each instance.
#[derive(Default)]
struct InstanceSum {
    slots: Mutex<Vec<Weak<AtomicUsize>>>,
}

impl InstanceSum {
    fn lock(&self) -> std::sync::MutexGuard<'_, Vec<Weak<AtomicUsize>>> {
        self.slots.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

impl Owner for InstanceSum {
    fn bytes(&self) -> usize {
        let mut s = self.lock();
        s.retain(|w| w.strong_count() > 0);
        s.iter().filter_map(Weak::upgrade).map(|a| a.load(SeqCst)).sum()
    }
    fn shrink(&self, _: usize) {} // each instance shrinks itself when it reports
    fn recycle(&self) {}
}

struct Entry {
    spec: Spec,
    owner: Weak<dyn Owner>,
    /// Keeps an instance holder's sum alive (a cache is kept alive by its own owner).
    sum: Option<Arc<InstanceSum>>,
    soft_active: AtomicBool,
    hard_active: AtomicBool,
    n: Counters,
    /// Milliseconds of the last logged event + 1 (0 = none yet).
    last_log: AtomicU64,
    /// When the holder was first seen over its hard limit with nothing left to recycle.
    stuck_since: Mutex<Option<u64>>,
}

#[derive(Default)]
struct Global {
    process: AtomicU64,
    soft_active: AtomicBool,
    hard_active: AtomicBool,
    restart_asked: AtomicBool,
    n: Counters,
    restarts: AtomicU64,
    over_since: Mutex<Option<u64>>,
}

struct Inner {
    lookup: Lookup,
    sink: Sink,
    epoch: Instant,
    entries: Mutex<Vec<Arc<Entry>>>,
    g: Global,
}

/// The set of registered holders and the process-wide state. Cheap to clone.
#[derive(Clone)]
pub struct Registry(Arc<Inner>);

struct Lim {
    soft: usize,
    hard: usize,
    low: usize,
}

impl Registry {
    /// A registry whose limits come from `lookup(key)` and whose events go to `sink`.
    pub fn new(lookup: Lookup, sink: Sink) -> Registry {
        Registry(Arc::new(Inner { lookup, sink, epoch: Instant::now(), entries: Mutex::new(Vec::new()), g: Global::default() }))
    }

    fn ms(&self) -> u64 {
        self.0.epoch.elapsed().as_millis() as u64
    }

    fn get(&self, key: &str) -> usize {
        (self.0.lookup)(key) as usize
    }

    fn lim(&self, spec: &Spec) -> Lim {
        let soft = self.get(spec.soft);
        Lim { soft, hard: self.get(spec.hard), low: (soft as u128 * self.get(spec.low_pct).min(100) as u128 / 100) as usize }
    }

    fn entries(&self) -> Vec<Arc<Entry>> {
        self.0.entries.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone()
    }

    fn add(&self, e: Entry) -> Arc<Entry> {
        let e = Arc::new(e);
        let mut v = self.0.entries.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        v.retain(|x| x.spec.name != e.spec.name && (x.sum.is_some() || x.owner.strong_count() > 0));
        v.push(e.clone());
        e
    }

    /// Register a holder whose usage is `owner.bytes()`.
    pub fn register(&self, spec: Spec, owner: Weak<dyn Owner>) -> Budget {
        let e = self.add(Entry {
            spec,
            owner,
            sum: None,
            soft_active: AtomicBool::new(false),
            hard_active: AtomicBool::new(false),
            n: Counters::default(),
            last_log: AtomicU64::new(0),
            stuck_since: Mutex::new(None),
        });
        Budget { reg: self.clone(), e }
    }

    /// Register a holder that exists once per worker; its limits apply to each [`Instance`], and the registry shows the sum.
    pub fn register_instances(&self, spec: Spec) -> Budget {
        let sum = Arc::new(InstanceSum::default());
        let owner: Weak<dyn Owner> = Arc::downgrade(&(sum.clone() as Arc<dyn Owner>));
        let e = self.add(Entry {
            spec,
            owner,
            sum: Some(sum),
            soft_active: AtomicBool::new(false),
            hard_active: AtomicBool::new(false),
            n: Counters::default(),
            last_log: AtomicU64::new(0),
            stuck_since: Mutex::new(None),
        });
        Budget { reg: self.clone(), e }
    }

    fn emit(&self, e: Option<&Entry>, kind: Kind, holder: &str, usage: usize, limit: usize) {
        if let Some(e) = e
            && kind != Kind::Restart
        {
            // at most one line per holder per interval; the counters still count every excursion
            let (now, interval) = (self.ms() + 1, self.get("mem.global_log_min_interval_ms") as u64);
            let last = e.last_log.load(SeqCst);
            if last != 0 && now.saturating_sub(last) < interval {
                return;
            }
            e.last_log.store(now, SeqCst);
        }
        (self.0.sink)(&Event { kind, holder: holder.to_string(), usage, limit });
    }

    /// The process-wide check, called every `daemon.rss_check_ms` with the figure the memory cap uses (`process_bytes`) and a
    /// clock in milliseconds. Above the global soft limit every holder is asked to shrink; above the global hard limit every
    /// holder is recycled once, and if the total is still over the limit `mem.global_restart_after_s` later (or a holder that
    /// cannot shrink is still over its own hard limit that long) a clean restart is requested.
    pub fn tick(&self, process_bytes: u64, now_ms: u64) -> Option<Restart> {
        let g = &self.0.g;
        g.process.store(process_bytes, SeqCst);
        let p = process_bytes as usize;
        let (soft, hard) = (self.get("mem.global_soft_bytes"), self.get("mem.global_hard_bytes"));
        let pct = self.get("mem.global_low_water_pct").min(100);
        let wait = self.get("mem.global_restart_after_s") as u64 * 1000;
        let entries = self.entries();
        if soft > 0 && p >= soft {
            if !g.soft_active.swap(true, SeqCst) {
                g.n.soft.fetch_add(1, SeqCst);
                self.emit(None, Kind::Soft, GLOBAL_NAME, p, soft);
            }
            for e in &entries {
                if let Some(o) = e.owner.upgrade() {
                    o.shrink(self.lim(&e.spec).low);
                }
            }
        } else if p as u128 <= soft as u128 * pct as u128 / 100 {
            g.soft_active.store(false, SeqCst);
        }
        if hard > 0 && p > hard {
            if !g.hard_active.swap(true, SeqCst) {
                g.n.hard.fetch_add(1, SeqCst);
                self.emit(None, Kind::Hard, GLOBAL_NAME, p, hard);
                *g.over_since.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(now_ms);
                for e in &entries {
                    if let Some(o) = e.owner.upgrade() {
                        e.n.recycles.fetch_add(1, SeqCst);
                        o.recycle();
                    }
                }
            } else {
                let since = *g.over_since.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                if let Some(t) = since
                    && now_ms.saturating_sub(t) >= wait
                    && !g.restart_asked.swap(true, SeqCst)
                {
                    g.restarts.fetch_add(1, SeqCst);
                    self.emit(None, Kind::Restart, GLOBAL_NAME, p, hard);
                    return Some(Restart { holder: GLOBAL_NAME.into(), usage: p, limit: hard, secs: now_ms.saturating_sub(t) / 1000 });
                }
            }
        } else if p as u128 <= hard as u128 * pct as u128 / 100 {
            g.hard_active.store(false, SeqCst);
            *g.over_since.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = None;
        }
        // a holder that recycling cannot bring under its own hard limit (leaked memory) is freed only by a restart
        for e in entries.iter().filter(|e| e.sum.is_none()) {
            let (Some(o), hard) = (e.owner.upgrade(), self.lim(&e.spec).hard) else { continue };
            // holders that grow without inserting (the leaked config values) get their soft and hard triggers from here
            Budget { reg: self.clone(), e: e.clone() }.observe();
            let mut s = e.stuck_since.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            if hard > 0 && o.bytes() > hard {
                let t = *s.get_or_insert(now_ms);
                if now_ms.saturating_sub(t) >= wait && !g.restart_asked.swap(true, SeqCst) {
                    g.restarts.fetch_add(1, SeqCst);
                    let usage = o.bytes();
                    self.emit(None, Kind::Restart, e.spec.name, usage, hard);
                    return Some(Restart { holder: e.spec.name.into(), usage, limit: hard, secs: now_ms.saturating_sub(t) / 1000 });
                }
            } else {
                *s = None;
            }
        }
        None
    }

    /// Whether a restart has been requested and not yet acted on (the daemon drains after the first request).
    pub fn restart_requested(&self) -> bool {
        self.0.g.restart_asked.load(SeqCst)
    }

    /// Every holder's bytes against its limits, the trigger counts and the global totals (`status --memory`).
    pub fn snapshot(&self) -> Value {
        let g = &self.0.g;
        let mut registered = 0usize;
        let holders: Vec<Value> = self
            .entries()
            .iter()
            .filter_map(|e| {
                let bytes = e.owner.upgrade()?.bytes();
                registered += bytes;
                let l = self.lim(&e.spec);
                let level = if e.hard_active.load(SeqCst) {
                    "hard"
                } else if e.soft_active.load(SeqCst) {
                    "soft"
                } else {
                    "ok"
                };
                Some(json!({"name": e.spec.name, "bytes": bytes, "soft_bytes": l.soft, "hard_bytes": l.hard, "low_water_bytes": l.low,
                    "per_instance": e.sum.is_some(), "level": level,
                    "soft_trips": e.n.soft.load(SeqCst), "hard_trips": e.n.hard.load(SeqCst), "refused": e.n.refused.load(SeqCst),
                    "recycles": e.n.recycles.load(SeqCst)}))
            })
            .collect();
        json!({"global": {"process_bytes": g.process.load(SeqCst), "registered_bytes": registered, "soft_bytes": self.get("mem.global_soft_bytes"),
            "hard_bytes": self.get("mem.global_hard_bytes"), "soft_active": g.soft_active.load(SeqCst), "hard_active": g.hard_active.load(SeqCst),
            "soft_trips": g.n.soft.load(SeqCst), "hard_trips": g.n.hard.load(SeqCst), "restarts_requested": g.restarts.load(SeqCst)},
            "holders": holders})
    }
}

/// A holder's handle on the registry.
#[derive(Clone)]
pub struct Budget {
    reg: Registry,
    e: Arc<Entry>,
}

impl Budget {
    /// The holder's entry-count cap (0 = none), read from its config key.
    pub fn max_entries(&self) -> usize {
        self.e.spec.entries.map_or(0, |k| self.reg.get(k))
    }

    /// Re-arm the triggers once usage is back at or under the low-water mark (the hysteresis).
    fn rearm(&self, usage: usize, l: &Lim) {
        if usage <= l.low {
            self.e.soft_active.store(false, SeqCst);
            self.e.hard_active.store(false, SeqCst);
        }
    }

    fn soft_edge(&self, usage: usize, l: &Lim) {
        if !self.e.soft_active.swap(true, SeqCst) {
            self.e.n.soft.fetch_add(1, SeqCst);
            self.reg.emit(Some(&self.e), Kind::Soft, self.e.spec.name, usage, l.soft);
        }
    }

    fn hard_edge(&self, usage: usize, l: &Lim, o: &dyn Owner) {
        if !self.e.hard_active.swap(true, SeqCst) {
            self.e.n.hard.fetch_add(1, SeqCst);
            self.e.n.recycles.fetch_add(1, SeqCst);
            self.reg.emit(Some(&self.e), Kind::Hard, self.e.spec.name, usage, l.hard);
            o.recycle();
        }
    }

    /// Before storing `add` more bytes: at or past the soft limit the owner is shrunk to the low-water mark (leaving room
    /// for the insert); past the hard limit the holder is recycled (once per excursion) and the insert is refused. While the
    /// process total is over the global hard limit every insert is refused.
    pub fn admit(&self, add: usize) -> Admit {
        let Some(o) = self.e.owner.upgrade() else { return Admit::Ok };
        let l = self.reg.lim(&self.e.spec);
        let mut usage = o.bytes();
        self.rearm(usage, &l);
        if l.soft > 0 && usage.saturating_add(add) >= l.soft {
            self.soft_edge(usage + add, &l);
            o.shrink(l.low.saturating_sub(add));
            usage = o.bytes();
        }
        if l.hard > 0 && usage.saturating_add(add) > l.hard {
            self.e.n.refused.fetch_add(1, SeqCst);
            self.hard_edge(usage + add, &l, o.as_ref());
            return Admit::Refused;
        }
        if self.reg.0.g.hard_active.load(SeqCst) {
            self.e.n.refused.fetch_add(1, SeqCst);
            return Admit::Refused;
        }
        Admit::Ok
    }

    /// After usage grew by some other route than an insert: run the same triggers on the current size.
    pub fn observe(&self) {
        let Some(o) = self.e.owner.upgrade() else { return };
        let l = self.reg.lim(&self.e.spec);
        let usage = o.bytes();
        self.rearm(usage, &l);
        if l.soft > 0 && usage >= l.soft {
            self.soft_edge(usage, &l);
            o.shrink(l.low);
        }
        if l.hard > 0 && usage > l.hard {
            self.hard_edge(usage, &l, o.as_ref());
        }
    }

    /// A new per-worker instance of an instance holder (see [`Registry::register_instances`]).
    pub fn instance(&self) -> Instance {
        let bytes = Arc::new(AtomicUsize::new(0));
        if let Some(s) = &self.e.sum {
            s.lock().push(Arc::downgrade(&bytes));
        }
        Instance { b: self.clone(), bytes, soft_active: false, hard_active: false }
    }
}

/// One worker's share of an instance holder (a QuickJS runtime). It reports its size and is told what to do.
pub struct Instance {
    b: Budget,
    bytes: Arc<AtomicUsize>,
    soft_active: bool,
    hard_active: bool,
}

impl Instance {
    /// Report the current size. Over the hard limit: [`Action::Recycle`]. At or over the soft limit: [`Action::Shrink`] to
    /// the low-water mark (the soft trigger is counted and logged once per excursion; it re-arms at the low-water mark).
    pub fn report(&mut self, bytes: usize) -> Action {
        self.bytes.store(bytes, SeqCst);
        let l = self.b.reg.lim(&self.b.e.spec);
        if bytes <= l.low {
            self.soft_active = false;
            self.hard_active = false;
        }
        if l.hard > 0 && bytes > l.hard {
            if !self.hard_active {
                self.hard_active = true;
                self.b.e.n.hard.fetch_add(1, SeqCst);
                self.b.e.n.recycles.fetch_add(1, SeqCst);
                self.b.reg.emit(Some(&self.b.e), Kind::Hard, self.b.e.spec.name, bytes, l.hard);
            }
            return Action::Recycle;
        }
        if l.soft > 0 && bytes >= l.soft {
            if !self.soft_active {
                self.soft_active = true;
                self.b.e.n.soft.fetch_add(1, SeqCst);
                self.b.reg.emit(Some(&self.b.e), Kind::Soft, self.b.e.spec.name, bytes, l.soft);
            }
            return Action::Shrink(l.low);
        }
        Action::None
    }

    /// The hard limit a call's own ceiling must not pass.
    pub fn hard_limit(&self) -> usize {
        self.b.reg.lim(&self.b.e.spec).hard
    }
}
