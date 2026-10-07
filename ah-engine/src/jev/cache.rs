//! The answer cache, keyed by content hash.
//!
//! Mirrors the cache in `hooks/lib/jev-assist.js` (`readCache`, `writeCache`): only a successful answer is cached, the
//! key is the content hash of the integration id, the question version and the text (or an explicit cache key), and the
//! oldest entry goes first once the bound is reached. A hit costs nothing and is logged with backend `cache`.
//!
//! [`FileCache`] is the production cache: Node's own file, `~/.anti-hall/cache/jev-assist.json`, in Node's own shape, so
//! a text asked by a Node hook and by the engine is asked once. Node takes no lock there: it reads the whole file,
//! merges one entry (`Object.assign`), keeps the 500 highest `_seq` and replaces the file with a `.tmp.<pid>` rename.
//! The engine does the same (its temp name also carries a counter, because its writers are threads of one process, and
//! an in-process mutex serialises them); two processes can still lose each other's entry, exactly as two Node hooks can,
//! and a reader never sees a torn file. An entry the engine writes carries one extra field, `chain`, which Node ignores
//! and copies along when it rewrites the file.
//!
//! [`JevCache`] is the seam to storage: [`MemCache`] holds the entries in memory, bounded and lost on exit. Putting the
//! cache on the `Store` trait (hot.db, D22) is planned with the storage lane (D21); nothing outside this module depends
//! on the backend.
use super::client::Answer;
use crate::checks::jsport::json::{self, J};
use crate::defaults;
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// A cached answer.
#[derive(Debug, Clone, PartialEq)]
pub struct Cached {
    /// The answer.
    pub answer: Answer,
    /// Its confidence.
    pub confidence: f64,
    /// The vendor chain (transports, models, endpoints) that produced it. An entry Node wrote has none and is served to
    /// every chain, as Node serves it; an entry carrying one is served only to a session with the same chain.
    pub chain: Option<String>,
}

/// Where answers are remembered. Implementations must stay bounded (D25) and never block on I/O longer than a call may.
pub trait JevCache: Send + Sync {
    /// The cached answer for `hash`.
    fn get(&self, hash: &str) -> Option<Cached>;
    /// Remember an answer, replacing any earlier one for the same hash.
    fn put(&self, hash: &str, value: Cached);
    /// Entries held.
    fn len(&self) -> usize;
    /// True when nothing is held.
    fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// Node's cache file (`jev-assist.js`: `readCache`, `writeCache`, `nextCacheSeq`).
pub struct FileCache {
    path: PathBuf,
    cap: usize,
    write: Mutex<()>,
}

impl FileCache {
    /// The cache stored at `path`, bounded at `cap` entries.
    pub fn new(path: PathBuf, cap: usize) -> FileCache {
        FileCache { path, cap: cap.max(1), write: Mutex::new(()) }
    }

    /// Node's cache for `home`, bounded by the shipped default.
    pub fn for_home(home: &Path) -> FileCache {
        let path = home.join(defaults::text("paths.base_dir")).join(defaults::text("jev.cache_file"));
        FileCache::new(path, defaults::num("jev.cache_max_entries") as usize)
    }

    /// Whether a truthy entry is stored under `hash`, whatever its shape (what `dispatch-tier.js` `readCacheEntry` tests).
    /// `None` when the file is one only JavaScript reads.
    pub fn contains(&self, hash: &str) -> Option<bool> {
        let truthy = |v: &J| match v {
            J::Null => false,
            J::Bool(b) => *b,
            J::Num(n) => *n != 0.0 && !n.is_nan(),
            J::Str(s) => !s.is_empty(),
            J::Arr(_) | J::Obj(_) => true,
        };
        Some(self.read()?.iter().any(|(k, v)| k == hash && truthy(v)))
    }

    /// The file as Node's `readCache` sees it: a missing, unparsable or non-object file is an empty cache. `None` when
    /// the file is JSON that only JavaScript reads (nesting, lone surrogate): then it is left alone.
    fn read(&self) -> Option<Vec<(String, J)>> {
        let Ok(raw) = std::fs::read_to_string(&self.path) else { return Some(Vec::new()) };
        match json::parse(&raw, defaults::num("jev.cache_max_depth") as usize) {
            Ok(J::Obj(o)) => Some(o),
            Ok(_) | Err(json::Fail::Invalid) => Some(Vec::new()),
            Err(json::Fail::Unsupported) => None,
        }
    }
}

fn entry_of(v: &J) -> Option<Cached> {
    let answer = match v.get("answer")? {
        J::Bool(b) => Answer::Bool(*b),
        J::Str(s) => Answer::Label(s.clone()),
        _ => return None,
    };
    let confidence = match v.get("confidence")? {
        J::Num(n) if n.is_finite() => *n,
        _ => return None,
    };
    let chain = match v.get("chain") {
        Some(J::Str(s)) => Some(s.clone()),
        _ => None,
    };
    Some(Cached { answer, confidence, chain })
}

fn seq_of(v: &J) -> f64 {
    match v.get("_seq") {
        Some(J::Num(n)) if n.is_finite() => *n,
        _ => 0.0,
    }
}

impl JevCache for FileCache {
    fn get(&self, hash: &str) -> Option<Cached> {
        self.read()?.iter().find(|(k, _)| k == hash).and_then(|(_, v)| entry_of(v))
    }

    fn put(&self, hash: &str, value: Cached) {
        let _g = self.write.lock().unwrap_or_else(|e| e.into_inner());
        let Some(entries) = self.read() else { return };
        let mut cache = J::Obj(entries);
        let next = match &cache {
            J::Obj(o) => o.iter().map(|(_, v)| seq_of(v)).fold(0.0, f64::max) + 1.0,
            _ => 1.0,
        };
        let answer = match &value.answer {
            Answer::Bool(b) => J::Bool(*b),
            Answer::Label(s) => J::Str(s.clone()),
        };
        let mut e = vec![("answer".to_string(), answer), ("confidence".to_string(), J::Num(value.confidence)), ("_seq".to_string(), J::Num(next))];
        if let Some(c) = value.chain {
            e.push(("chain".to_string(), J::Str(c)));
        }
        cache.set(hash, J::Obj(e));
        if let J::Obj(o) = &mut cache
            && o.len() > self.cap
        {
            o.sort_by(|a, b| seq_of(&a.1).total_cmp(&seq_of(&b.1)));
            let drop = o.len() - self.cap;
            o.drain(..drop);
        }
        let Some(dir) = self.path.parent() else { return };
        if std::fs::create_dir_all(dir).is_err() {
            return;
        }
        // best effort: a lost write only means the verdict is asked again
        crate::discard::logged("jev_cache_write", crate::atomic::write(&self.path, json::stringify(&cache)));
    }

    fn len(&self) -> usize {
        self.read().map_or(0, |o| o.len())
    }
}

struct Inner {
    map: HashMap<String, (Cached, u64)>,
    order: BTreeMap<u64, String>,
    next: u64,
}

/// The in-memory cache: insertion-ordered eviction, bounded by `jev.cache_max_entries`.
pub struct MemCache {
    inner: Mutex<Inner>,
    cap: usize,
}

impl MemCache {
    /// A cache holding at most `cap` entries.
    pub fn new(cap: usize) -> MemCache {
        MemCache { inner: Mutex::new(Inner { map: HashMap::new(), order: BTreeMap::new(), next: 1 }), cap: cap.max(1) }
    }

    /// A cache bounded by the shipped default.
    pub fn with_defaults() -> MemCache {
        MemCache::new(defaults::num("jev.cache_max_entries") as usize)
    }
}

impl JevCache for MemCache {
    fn get(&self, hash: &str) -> Option<Cached> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner()).map.get(hash).map(|(c, _)| c.clone())
    }

    fn put(&self, hash: &str, value: Cached) {
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let seq = g.next;
        g.next += 1;
        if let Some((_, old)) = g.map.insert(hash.to_string(), (value, seq)) {
            g.order.remove(&old);
        }
        g.order.insert(seq, hash.to_string());
        while g.map.len() > self.cap {
            let Some((_, oldest)) = g.order.pop_first() else { break };
            g.map.remove(&oldest);
        }
    }

    fn len(&self) -> usize {
        self.inner.lock().unwrap_or_else(|e| e.into_inner()).map.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(b: bool) -> Cached {
        Cached { answer: Answer::Bool(b), confidence: 0.9, chain: None }
    }

    #[test]
    fn it_evicts_the_oldest_insertion_first_and_stays_bounded() {
        let m = MemCache::new(2);
        m.put("a", c(true));
        m.put("b", c(true));
        m.put("c", c(false));
        assert_eq!((m.len(), m.get("a"), m.get("b").is_some(), m.get("c").is_some()), (2, None, true, true));
    }

    #[test]
    fn rewriting_a_key_makes_it_the_newest() {
        let m = MemCache::new(2);
        m.put("a", c(true));
        m.put("b", c(true));
        m.put("a", c(false));
        m.put("c", c(true));
        assert_eq!(m.get("a"), Some(c(false)));
        assert_eq!(m.get("b"), None, "b was the oldest after a was rewritten");
    }
    fn tmp(tag: &str) -> PathBuf {
        static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let d = std::env::temp_dir().join(format!("ah-jev-cache-{tag}-{}-{}", std::process::id(), N.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
        std::fs::create_dir_all(&d).unwrap();
        d.join("cache").join("jev-assist.json")
    }

    fn cf(b: bool, chain: Option<&str>) -> Cached {
        Cached { answer: Answer::Bool(b), confidence: 0.94, chain: chain.map(str::to_string) }
    }

    #[test]
    fn the_file_is_written_in_nodes_shape_with_a_rising_seq() {
        let p = tmp("shape");
        let c = FileCache::new(p.clone(), 500);
        c.put("aaaa", cf(true, Some("v|m|e")));
        c.put("bbbb", Cached { answer: Answer::Label("urgent".into()), confidence: 1.0, chain: None });
        assert_eq!(
            std::fs::read_to_string(&p).unwrap(),
            r#"{"aaaa":{"answer":true,"confidence":0.94,"_seq":1,"chain":"v|m|e"},"bbbb":{"answer":"urgent","confidence":1,"_seq":2}}"#
        );
        // a rewrite replaces in place (Object.assign) and takes the next seq
        c.put("aaaa", cf(false, None));
        assert_eq!(
            std::fs::read_to_string(&p).unwrap(),
            r#"{"aaaa":{"answer":false,"confidence":0.94,"_seq":3},"bbbb":{"answer":"urgent","confidence":1,"_seq":2}}"#
        );
    }

    #[test]
    fn a_node_written_file_is_read_and_its_other_entries_survive_a_write() {
        let p = tmp("node");
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, r#"{"n1":{"answer":true,"confidence":0.9,"_seq":7},"odd":{"note":1}}"#).unwrap();
        let c = FileCache::new(p.clone(), 500);
        assert_eq!(c.get("n1"), Some(Cached { answer: Answer::Bool(true), confidence: 0.9, chain: None }));
        assert_eq!(c.get("odd"), None, "an entry without an answer is no hit");
        c.put("e1", cf(true, None));
        let text = std::fs::read_to_string(&p).unwrap();
        assert!(text.contains(r#""odd":{"note":1}"#) && text.contains(r#""e1":{"answer":true,"confidence":0.94,"_seq":8}"#), "{text}");
    }

    #[test]
    fn the_oldest_seq_goes_first_at_the_bound_as_in_node() {
        let p = tmp("bound");
        let c = FileCache::new(p, 3);
        for k in ["a", "b", "c", "d"] {
            c.put(k, cf(true, None));
        }
        c.put("b", cf(false, None)); // b is now the newest
        c.put("e", cf(true, None));
        assert_eq!((c.get("a"), c.get("c"), c.get("d").is_some(), c.get("b").is_some(), c.get("e").is_some(), c.len()), (None, None, true, true, true, 3));
    }

    #[test]
    fn a_corrupt_file_is_an_empty_cache_and_one_only_javascript_reads_is_left_alone() {
        let p = tmp("bad");
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        let c = FileCache::new(p.clone(), 500);
        for junk in ["", "not json", "[1,2]", "7"] {
            std::fs::write(&p, junk).unwrap();
            assert_eq!(c.get("x"), None);
            c.put("x", cf(true, None));
            assert_eq!(c.get("x"), Some(cf(true, None)), "{junk:?} is replaced as Node replaces it");
        }
        let deep = format!("{}{}", "[".repeat(200), "]".repeat(200));
        let text = format!(r#"{{"k":{deep}}}"#);
        std::fs::write(&p, &text).unwrap();
        assert_eq!(c.get("k"), None);
        c.put("y", cf(true, None));
        assert_eq!(std::fs::read_to_string(&p).unwrap(), text, "a file this parser cannot reproduce is not rewritten");
    }

    #[test]
    fn concurrent_writers_never_tear_the_file_and_none_of_their_entries_is_lost() {
        let p = tmp("threads");
        let c = std::sync::Arc::new(FileCache::new(p.clone(), 500));
        let hs: Vec<_> = (0..8)
            .map(|t| {
                let c = c.clone();
                std::thread::spawn(move || {
                    for i in 0..20 {
                        c.put(&format!("t{t}k{i}"), cf(i % 2 == 0, Some("c")));
                    }
                })
            })
            .collect();
        hs.into_iter().for_each(|h| h.join().unwrap());
        assert_eq!(c.len(), 160);
        let dir = p.parent().unwrap();
        let strays: Vec<_> = std::fs::read_dir(dir).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().contains(".tmp.")).collect();
        assert!(strays.is_empty(), "temp files left behind");
    }
}
