//! The in-memory layer (D20, D22, D25): a byte-budgeted, TTL-aware cache of active items, and pub/sub channels.
//!
//! Lifecycle, for every kind of data that uses it: a write commits to SQLite first and only then becomes active here
//! (write-through, done by the writer thread after the commit, so memory follows the commit order). Memory holds only
//! active items: an item whose TTL has passed is dropped from memory and stays in SQLite; when the byte budget is
//! exceeded the least recently used item is dropped, which loses nothing because SQLite is the source of truth. A
//! restart starts with an empty layer and promotes items again as they are read, so only active items come back.
//!
//! The channels are the "redis" half of D20: a bounded queue per subscriber, never blocking the publisher; a
//! subscriber that falls behind loses notifications (counted), never data, because the data itself is in SQLite.
use std::collections::{BTreeMap, HashMap};
use std::hash::Hash;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering::SeqCst};
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};

struct Slot<V> {
    value: V,
    size: usize,
    expires_ms: Option<u64>,
    tick: u64,
}

/// A byte-budgeted LRU cache of active items with optional expiry.
pub struct Tiered<K: Hash + Eq + Clone, V: Clone> {
    map: HashMap<K, Slot<V>>,
    order: BTreeMap<u64, K>,
    tick: u64,
    bytes: usize,
    budget: usize,
    /// Reads answered from memory.
    pub hits: u64,
    /// Reads that had to go to SQLite.
    pub misses: u64,
    /// Items dropped to stay within the budget.
    pub evictions: u64,
    /// Items dropped because their lifecycle (TTL) ended.
    pub expired: u64,
}

impl<K: Hash + Eq + Clone, V: Clone> Tiered<K, V> {
    /// An empty layer holding at most `budget` bytes.
    pub fn new(budget: usize) -> Self {
        Tiered { map: HashMap::new(), order: BTreeMap::new(), tick: 0, bytes: 0, budget, hits: 0, misses: 0, evictions: 0, expired: 0 }
    }

    /// Bytes held (as estimated by the sizes given to `insert`).
    pub fn bytes(&self) -> usize {
        self.bytes
    }

    /// Items held.
    pub fn len(&self) -> usize {
        self.map.len()
    }

    /// True when nothing is held.
    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }

    fn next_tick(&mut self) -> u64 {
        self.tick += 1;
        self.tick
    }

    /// The active value for `k`, refreshing its recency; an expired item is dropped and reported as absent.
    pub fn get(&mut self, k: &K, now_ms: u64) -> Option<V> {
        let expired = match self.map.get(k) {
            None => {
                self.misses += 1;
                return None;
            }
            Some(s) => s.expires_ms.is_some_and(|e| e <= now_ms),
        };
        if expired {
            self.remove(k);
            self.expired += 1;
            self.misses += 1;
            return None;
        }
        let t = self.next_tick();
        let slot = self.map.get_mut(k)?;
        self.order.remove(&slot.tick);
        slot.tick = t;
        self.order.insert(t, k.clone());
        self.hits += 1;
        Some(slot.value.clone())
    }

    /// True when `k` is held (expired or not), without touching its recency.
    pub fn contains(&self, k: &K) -> bool {
        self.map.contains_key(k)
    }

    /// Make `k` active with `value` (of about `size` bytes), then drop least recently used items until the layer is
    /// within budget. An item larger than the whole budget is not held at all.
    pub fn insert(&mut self, k: K, value: V, size: usize, expires_ms: Option<u64>) {
        self.remove(&k);
        if size > self.budget {
            return;
        }
        let t = self.next_tick();
        self.order.insert(t, k.clone());
        self.map.insert(k, Slot { value, size, expires_ms, tick: t });
        self.bytes += size;
        while self.bytes > self.budget {
            let Some((&t, _)) = self.order.iter().next() else { break };
            if let Some(victim) = self.order.remove(&t)
                && let Some(s) = self.map.remove(&victim)
            {
                self.bytes -= s.size;
                self.evictions += 1;
            }
        }
    }

    /// Drop the least recently used item; its size, or `None` when empty.
    pub fn pop_lru(&mut self) -> Option<usize> {
        let (&t, _) = self.order.iter().next()?;
        let victim = self.order.remove(&t)?;
        let s = self.map.remove(&victim)?;
        self.bytes -= s.size;
        self.evictions += 1;
        Some(s.size)
    }

    /// Drop least recently used items until at most `target` bytes are held; the bytes freed.
    pub fn evict_to(&mut self, target: usize) -> usize {
        let before = self.bytes;
        while self.bytes > target && self.pop_lru().is_some() {}
        before - self.bytes
    }

    /// Drop everything; the bytes freed.
    pub fn clear(&mut self) -> usize {
        let before = self.bytes;
        self.map.clear();
        self.order.clear();
        self.bytes = 0;
        before
    }

    /// Drop `k` from memory (SQLite keeps it).
    pub fn remove(&mut self, k: &K) {
        if let Some(s) = self.map.remove(k) {
            self.order.remove(&s.tick);
            self.bytes -= s.size;
        }
    }
}

/// Pub/sub channels: each subscriber has a bounded queue; publishing never blocks.
pub struct Bus {
    subs: Mutex<HashMap<String, Vec<SyncSender<String>>>>,
    queue: usize,
    max_channels: usize,
    /// Notifications delivered to a subscriber queue.
    pub published: AtomicU64,
    /// Notifications a full subscriber queue could not take (the data is still in SQLite).
    pub dropped: AtomicU64,
}

impl Bus {
    /// A bus whose subscriber queues hold `queue` notifications, with at most `max_channels` channels.
    pub fn new(queue: usize, max_channels: usize) -> Bus {
        Bus { subs: Mutex::new(HashMap::new()), queue: queue.max(1), max_channels, published: AtomicU64::new(0), dropped: AtomicU64::new(0) }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Vec<SyncSender<String>>>> {
        self.subs.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Listen on `channel`; `None` when the channel cap is reached.
    pub fn subscribe(&self, channel: &str) -> Option<Receiver<String>> {
        let mut subs = self.lock();
        if !subs.contains_key(channel) && subs.len() >= self.max_channels {
            return None;
        }
        let (tx, rx) = mpsc::sync_channel(self.queue);
        subs.entry(channel.to_string()).or_default().push(tx);
        Some(rx)
    }

    /// Send `msg` to every live subscriber of `channel`; gone subscribers are forgotten.
    pub fn publish(&self, channel: &str, msg: &str) {
        let mut subs = self.lock();
        let Some(list) = subs.get_mut(channel) else { return };
        list.retain(|tx| match tx.try_send(msg.to_string()) {
            Ok(()) => {
                self.published.fetch_add(1, SeqCst);
                true
            }
            Err(TrySendError::Full(_)) => {
                self.dropped.fetch_add(1, SeqCst);
                true
            }
            Err(TrySendError::Disconnected(_)) => false,
        });
        if list.is_empty() {
            subs.remove(channel);
        }
    }

    /// Channels with at least one subscriber.
    pub fn channels(&self) -> usize {
        self.lock().len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_budget_evicts_least_recently_used_first() {
        let mut t: Tiered<String, String> = Tiered::new(30);
        t.insert("a".into(), "1".into(), 10, None);
        t.insert("b".into(), "2".into(), 10, None);
        t.insert("c".into(), "3".into(), 10, None);
        assert_eq!(t.get(&"a".into(), 0), Some("1".into()), "touching a makes b the oldest");
        t.insert("d".into(), "4".into(), 10, None);
        assert!(!t.contains(&"b".into()), "b was least recently used");
        assert!(t.contains(&"a".into()) && t.contains(&"c".into()) && t.contains(&"d".into()));
        assert_eq!(t.bytes(), 30);
        assert_eq!(t.evictions, 1);
        t.insert("huge".into(), "x".into(), 31, None);
        assert!(!t.contains(&"huge".into()), "an item over the whole budget is not held");
        assert_eq!(t.len(), 3);
    }

    #[test]
    fn an_expired_item_leaves_memory() {
        let mut t: Tiered<&str, u32> = Tiered::new(100);
        t.insert("k", 1, 5, Some(1000));
        assert_eq!(t.get(&"k", 999), Some(1));
        assert_eq!(t.get(&"k", 1000), None, "expired at its deadline");
        assert!(t.is_empty() && t.bytes() == 0);
        assert_eq!(t.expired, 1);
    }

    #[test]
    fn replacing_a_value_keeps_the_byte_count_right() {
        let mut t: Tiered<&str, u32> = Tiered::new(100);
        t.insert("k", 1, 40, None);
        t.insert("k", 2, 10, None);
        assert_eq!((t.bytes(), t.len(), t.get(&"k", 0)), (10, 1, Some(2)));
    }

    #[test]
    fn publishing_never_blocks_and_a_slow_subscriber_only_loses_notifications() {
        let bus = Bus::new(2, 4);
        let rx = bus.subscribe("project:a").unwrap();
        for i in 0..5 {
            bus.publish("project:a", &i.to_string());
        }
        assert_eq!(rx.try_iter().collect::<Vec<_>>(), vec!["0", "1"]);
        assert_eq!(bus.dropped.load(SeqCst), 3);
        bus.publish("project:b", "nobody listens");
        drop(rx);
        bus.publish("project:a", "x");
        assert_eq!(bus.channels(), 0, "a channel whose subscribers are gone is forgotten");
    }

    #[test]
    fn the_channel_count_is_capped() {
        let bus = Bus::new(1, 2);
        let _a = bus.subscribe("a").unwrap();
        let _b = bus.subscribe("b").unwrap();
        assert!(bus.subscribe("c").is_none());
        assert!(bus.subscribe("a").is_some(), "another subscriber on an existing channel is fine");
    }
}
