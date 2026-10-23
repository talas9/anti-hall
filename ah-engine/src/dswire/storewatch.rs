//! Change detection for SQLite files without watching them: one read-only connection is held per source and asked
//! `PRAGMA data_version`, which differs between two reads exactly when another connection committed in between.
//!
//! Watching a database's files by name does not work for a reader: opening one touches its `-shm` index, and a checkpoint or a
//! WAL reset rewrites files without any data changing, so the reader woke itself (the live P0 of 2026-10-15). The counter has no
//! such echo: this process's own reads never move it. A source that cannot be opened is retried at the next poll; the periodic
//! reconcile covers the gap.
use crate::defaults;
use rusqlite::{Connection, OpenFlags};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

struct Held {
    conn: Connection,
    version: i64,
}

/// The held connections.
#[derive(Default)]
pub struct VersionWatch {
    held: HashMap<PathBuf, Held>,
}

fn version(conn: &Connection) -> Option<i64> {
    conn.query_row(crate::sql::DATA_VERSION, [], |r| r.get::<_, i64>(0)).ok()
}

fn open(db: &Path) -> Option<Held> {
    if !db.is_file() {
        return None;
    }
    let conn = Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX).ok()?;
    conn.busy_timeout(defaults::millis("mesh.busy_timeout_ms")).ok()?;
    let version = version(&conn)?;
    Some(Held { conn, version })
}

impl VersionWatch {
    /// An empty set.
    pub fn new() -> VersionWatch {
        VersionWatch::default()
    }

    /// Hold exactly the sources in `want`: open the new ones (their current version is the baseline, a reconcile covers what
    /// came before), drop the ones no longer wanted. Returns how many are held.
    pub fn sync(&mut self, want: &[PathBuf]) -> usize {
        self.held.retain(|p, _| want.contains(p));
        for p in want {
            if !self.held.contains_key(p)
                && let Some(h) = open(p)
            {
                self.held.insert(p.clone(), h);
            }
        }
        self.held.len()
    }

    /// Whether any held source committed since the last call. A source whose read fails is dropped (it is reopened by the next
    /// [`sync`](Self::sync)) and counts as changed: its content is unknown.
    pub fn changed(&mut self) -> bool {
        let mut any = false;
        let mut broken: Vec<PathBuf> = Vec::new();
        for (p, h) in self.held.iter_mut() {
            match version(&h.conn) {
                Some(v) if v == h.version => {}
                Some(v) => {
                    h.version = v;
                    any = true;
                }
                None => {
                    broken.push(p.clone());
                    any = true;
                }
            }
        }
        for p in broken {
            self.held.remove(&p);
        }
        any
    }

    /// How many sources are held.
    pub fn len(&self) -> usize {
        self.held.len()
    }

    /// Whether nothing is held.
    pub fn is_empty(&self) -> bool {
        self.held.is_empty()
    }
}
