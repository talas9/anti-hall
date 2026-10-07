//! Project-partitioned state. Every operation is keyed by a project key that the DAEMON derives from the
//! request's `cwd` (nearest ancestor holding `.git`, else the cwd itself); a request cannot name another
//! project's key, so project A has no path to project B's mailbox or values.
use crate::db::{Db, Op, ProjVerb};
use crate::error::{DbError, StoreError};
use crate::sql;
use rusqlite::{OptionalExtension, params};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

/// A numeric store cap from the defaults (`store.<name>`).
fn cap(name: &str) -> usize {
    crate::defaults::num(&format!("store.{name}")) as usize
}

/// Lexical normalization: collapse `.`/`..`/repeated slashes. Does not touch the filesystem.
pub fn normalize(p: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for c in p.split('/') {
        match c {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            c => parts.push(c),
        }
    }
    format!("/{}", parts.join("/"))
}

/// Project key for a cwd: the nearest ancestor containing a `.git` entry, else the normalized cwd.
pub fn project_key(cwd: &str) -> String {
    let n = normalize(cwd);
    let mut cur = n.as_str();
    loop {
        if Path::new(cur).join(".git").symlink_metadata().is_ok() {
            return cur.to_string();
        }
        match cur.rfind('/') {
            Some(0) | None => return n,
            Some(i) => cur = &cur[..i],
        }
    }
}

/// Bounded cwd -> key cache so the hot path does not stat per request.
#[derive(Default)]
pub struct KeyCache(HashMap<String, String>);

impl KeyCache {
    /// Entries held.
    pub fn len(&self) -> usize {
        self.0.len()
    }
    /// True when none is held.
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
    /// Project key for `cwd`, cached.
    pub fn key(&mut self, cwd: &str) -> String {
        if let Some(k) = self.0.get(cwd) {
            return k.clone();
        }
        if self.0.len() >= cap("key_cache_cap") {
            self.0.clear();
        }
        let k = project_key(cwd);
        self.0.insert(cwd.to_string(), k.clone());
        k
    }
}

/// Per-project mailboxes and key-value pairs, stored in hot.db with the active key-value items in memory (D20-D22).
///
/// Writes (`put`, `take`, `set`, `setex`) go through the writer and are answered only after they commit (D23). Reads
/// (`get`, `len`) never write: `get` is served from the in-memory layer when the item is active there and from SQLite
/// otherwise (then promoted), `len` counts pending messages in SQLite. Without a database every operation is refused,
/// so the client retries and then spools (D24); nothing is kept in memory alone.
pub struct Store {
    db: Option<Arc<Db>>,
}

/// How long a `setex` value stays active, from its argument.
fn ttl_ms(arg: &str) -> Option<u64> {
    arg.trim().parse::<u64>().ok().map(|s| s.saturating_mul(1000))
}

impl Store {
    /// A store over `db` (`None`: storage did not open, every operation is refused).
    pub fn new(db: Option<Arc<Db>>) -> Store {
        Store { db }
    }

    /// Run `verb` against the partition `key`. Verbs: `put <text>`, `take`, `len`, `set <k> <v>`, `setex <k> <ttl_s> <v>`,
    /// `get <k>`. A non-empty `write_id` makes a write idempotent (a repeat returns the first answer).
    pub fn op(&self, key: &str, write_id: &str, verb: &str, args: &str) -> Result<String, DbError> {
        let db = self.db.as_ref().ok_or(DbError::Unavailable)?;
        if args.len() > cap("value_cap") {
            return Err(DbError::Rejected(StoreError::ValueTooLarge));
        }
        let write = |verb: ProjVerb| db.write(Op::Proj { project: key.to_string(), write_id: write_id.to_string(), verb });
        match verb {
            "put" => write(ProjVerb::Put(args.to_string())),
            "take" => write(ProjVerb::Take),
            "set" => {
                let (k, v) = args.split_once(' ').unwrap_or((args, ""));
                write(ProjVerb::Set { key: k.to_string(), value: v.to_string(), expires_ms: None })
            }
            "setex" => {
                let mut it = args.splitn(3, ' ');
                let (k, ttl, v) = (it.next().unwrap_or(""), it.next().unwrap_or(""), it.next().unwrap_or(""));
                let Some(ttl) = ttl_ms(ttl) else { return Err(DbError::Rejected(StoreError::UnknownVerb(format!("{verb} {k} {ttl}")))) };
                write(ProjVerb::Set { key: k.to_string(), value: v.to_string(), expires_ms: Some(crate::health::now_ms().saturating_add(ttl)) })
            }
            "len" => db.read(|c| c.prepare_cached(sql::MAIL_PENDING)?.query_row(params![key], |r| r.get::<_, i64>(0))).map(|n| n.to_string()),
            "get" => self.get(db, key, args.trim()),
            v => Err(DbError::Rejected(StoreError::UnknownVerb(v.to_string()))),
        }
    }

    fn get(&self, db: &Db, project: &str, k: &str) -> Result<String, DbError> {
        let now = crate::health::now_ms();
        let item = (project.to_string(), k.to_string());
        if let Some(v) = db.mem.kv.lock().unwrap_or_else(|e| e.into_inner()).get(&item, now) {
            return Ok(v);
        }
        let seq = db.mem.seq();
        let row = db.read(|c| {
            c.prepare_cached(sql::KV_GET)?.query_row(params![project, k], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<i64>>(1)?))).optional()
        })?;
        match row {
            Some((v, exp)) if exp.is_none_or(|e| e > now as i64) => {
                db.mem.promote(seq, item, v.clone(), exp.map(|e| e.max(0) as u64));
                Ok(v)
            }
            _ => Ok(String::new()), // absent, or its lifecycle ended (the row stays in SQLite)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::TempDir;
    use crate::defaults;

    #[test]
    fn normalize_is_lexical() {
        assert_eq!(normalize("/a/b/../c/./d//e"), "/a/c/d/e");
        assert_eq!(normalize("/../.."), "/");
    }

    fn store(tag: &str) -> (TempDir, Arc<Db>, Store) {
        let d = TempDir::new(tag);
        let db = Db::open(&d.0).unwrap();
        (d, db.clone(), Store::new(Some(db)))
    }

    #[test]
    fn project_a_cannot_read_project_b() {
        let base = std::env::temp_dir().join(format!("ah-store-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        for p in ["A/.git", "A/sub/deep", "B/.git", "A-evil"] {
            std::fs::create_dir_all(base.join(p)).unwrap();
        }
        let b = base.to_str().unwrap();
        let mut kc = KeyCache::default();
        let (ka, ka2, kb, ke) = (kc.key(&format!("{b}/A")), kc.key(&format!("{b}/A/sub/deep")), kc.key(&format!("{b}/A/../B")), kc.key(&format!("{b}/A-evil")));
        assert_eq!(ka, ka2, "a subdirectory belongs to its repo");
        assert_ne!(ka, kb);
        assert_ne!(ka, ke, "a sibling sharing a name prefix is a different project");
        let (_d, _db, s) = store("iso");
        s.op(&ka, "", "put", "secret for A").unwrap();
        s.op(&ka, "", "set", "token a-only").unwrap();
        assert_eq!(s.op(&kb, "", "take", "").unwrap(), "");
        assert_eq!(s.op(&kb, "", "get", "token").unwrap(), "");
        assert_eq!(s.op(&ke, "", "take", "").unwrap(), "");
        assert_eq!(s.op(&kb, "", "len", "").unwrap(), "0");
        assert_eq!(s.op(&ka2, "", "get", "token").unwrap(), "a-only");
        assert_eq!(s.op(&ka2, "", "take", "").unwrap(), "secret for A");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn caps_hold() {
        let (_d, _db, s) = store("caps");
        for i in 0..cap("mailbox_cap") {
            s.op("/p", "", "put", &i.to_string()).unwrap();
        }
        assert_eq!(s.op("/p", "", "put", "x"), Err(DbError::Rejected(StoreError::MailboxFull)));
        assert_eq!(s.op("/p", "", "take", "").unwrap(), "0", "oldest first");
        s.op("/p", "", "put", "x").unwrap();
        for i in 0..cap("max_projects") {
            let _ = s.op(&format!("/q{i}"), "", "put", "x");
        }
        assert_eq!(s.op("/one-too-many", "", "put", "x"), Err(DbError::Rejected(StoreError::TooManyProjects)));
        assert!(s.op("/p", "", "set", &format!("k {}", "v".repeat(cap("value_cap")))).is_err(), "value cap");
    }

    #[test]
    fn writes_are_durable_and_reads_survive_a_restart() {
        let d = TempDir::new("restart");
        {
            let db = Db::open(&d.0).unwrap();
            let s = Store::new(Some(db.clone()));
            s.op("/p", "", "put", "first").unwrap();
            s.op("/p", "", "put", "second").unwrap();
            s.op("/p", "", "set", "k v1").unwrap();
            s.op("/p", "", "take", "").unwrap();
            db.close();
        }
        let db = Db::open(&d.0).unwrap();
        let s = Store::new(Some(db.clone()));
        assert!(db.mem.kv.lock().unwrap().is_empty(), "a restart starts with no active items in memory");
        assert_eq!(s.op("/p", "", "len", "").unwrap(), "1");
        assert_eq!(s.op("/p", "", "get", "k").unwrap(), "v1", "read from SQLite");
        assert_eq!(db.mem.kv.lock().unwrap().len(), 1, "and promoted, because it is active");
        assert_eq!(s.op("/p", "", "take", "").unwrap(), "second", "a consumed message stays consumed");
    }

    #[test]
    fn write_through_makes_an_item_active_only_after_its_commit() {
        let (_d, db, s) = store("through");
        s.op("/p", "", "set", "k v").unwrap();
        let other = rusqlite::Connection::open(db.dir().join("hot.db")).unwrap();
        let v: String = other.query_row("SELECT value FROM kv WHERE key = 'k'", [], |r| r.get(0)).unwrap();
        assert_eq!(v, "v", "committed");
        assert!(db.mem.kv.lock().unwrap().contains(&("/p".to_string(), "k".to_string())), "and active");
        let hits = db.mem.kv.lock().unwrap().hits;
        assert_eq!(s.op("/p", "", "get", "k").unwrap(), "v");
        assert_eq!(db.mem.kv.lock().unwrap().hits, hits + 1, "served from memory");
    }

    #[test]
    fn eviction_loses_nothing() {
        let (_d, db, s) = store("evict");
        let n = 200;
        let big = "x".repeat(defaults::num("tier.budget_kb") as usize * 1024 / 50);
        for i in 0..n {
            s.op(&format!("/p{}", i % 50), "", "set", &format!("k{i} {big}{i}")).unwrap();
        }
        let t = db.mem.kv.lock().unwrap();
        assert!(t.bytes() <= defaults::num("tier.budget_kb") as usize * 1024 && t.evictions > 0, "the budget holds");
        drop(t);
        for i in 0..n {
            assert_eq!(s.op(&format!("/p{}", i % 50), "", "get", &format!("k{i}")).unwrap(), format!("{big}{i}"), "every value is still there");
        }
    }

    #[test]
    fn a_ttl_ends_the_items_lifecycle_but_keeps_the_row() {
        let (_d, db, s) = store("ttl");
        s.op("/p", "", "setex", "k 0 gone").unwrap();
        s.op("/p", "", "setex", "keep 3600 here").unwrap();
        assert_eq!(s.op("/p", "", "get", "k").unwrap(), "", "expired at once");
        assert_eq!(s.op("/p", "", "get", "keep").unwrap(), "here");
        let n: i64 = db.read(|c| c.query_row("SELECT COUNT(*) FROM kv", [], |r| r.get(0))).unwrap();
        assert_eq!(n, 2, "the expired row is kept in SQLite (D22, D26)");
        assert!(s.op("/p", "", "setex", "k notanumber v").is_err());
    }

    #[test]
    fn a_repeated_write_id_is_applied_once() {
        let (_d, _db, s) = store("idem");
        assert_eq!(s.op("/p", "w1", "put", "once").unwrap(), "ok");
        assert_eq!(s.op("/p", "w1", "put", "once").unwrap(), "ok");
        assert_eq!(s.op("/p", "", "len", "").unwrap(), "1");
        assert_eq!(s.op("/p", "t1", "take", "").unwrap(), "once");
        assert_eq!(s.op("/p", "t1", "take", "").unwrap(), "once", "a retried take returns the same message, not the next");
    }

    #[test]
    fn committed_writes_are_announced_on_the_project_channel() {
        let (_d, db, s) = store("bus");
        let ch = format!("{}{}", defaults::text("tier.project_channel_prefix"), crate::telemetry::project_hash("/p"));
        let rx = db.mem.bus.subscribe(&ch).unwrap();
        s.op("/p", "", "put", "hello").unwrap();
        s.op("/p", "", "set", "k v").unwrap();
        let got: Vec<String> = rx.try_iter().collect();
        assert_eq!(got.len(), 2, "{got:?}");
        assert!(got[0].contains("mail") && got[1].contains("kv"));
        assert!(!got.iter().any(|m| m.contains("hello")), "a notification carries no content; the data is in SQLite");
    }

    #[test]
    fn without_storage_every_operation_is_refused() {
        let s = Store::new(None);
        assert_eq!(s.op("/p", "", "put", "x"), Err(DbError::Unavailable));
        assert_eq!(s.op("/p", "", "get", "k"), Err(DbError::Unavailable));
    }
}
