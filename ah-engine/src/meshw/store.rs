//! The WRITE side of a per-repo DevSwarm store, in Node's schema and with Node's statements (D45 stage 2).
//!
//! Mirrors `companion/lib/devswarm-store.js` `openSqlite` (writer path) and the write methods the ported verbs use:
//! `appendMeshRow` (+ `appendMeshMessage`'s field mapping), `upsertRegistry`, `setCursor`, `setBroadcastCursor`,
//! `advanceBroadcastCursor` and `readerCursorTxn`. Node and the engine can write the same file at the same time:
//!
//! * the open runs Node's statements in Node's order (busy timeout first, then WAL, foreign keys, `CREATE ... IF NOT
//!   EXISTS` with Node's exact DDL, the additive `ALTER TABLE` migrations and the needs-reply index);
//! * every write is the statement Node runs, in autocommit, except the reader-cursor batch, which is one `BEGIN
//!   IMMEDIATE` transaction exactly as Node's `readerCursorTxn`; a write that still meets `SQLITE_BUSY` after the busy
//!   timeout is retried the way Node's `retrySqliteBusy` does (bounded attempts, jittered sleep, any other error fails);
//! * the mesh `seq` and the registry `write_seq` are computed inside the INSERT (SQLite serializes writers, so two
//!   processes can never mint the same value), a duplicate `hash` is ignored (`INSERT OR IGNORE`), and a reader-cursor
//!   value only ever rises (`MAX(value, excluded.value)`), so a message is never lost or duplicated and a cursor never
//!   moves back, whichever process writes first.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - a migration probe that cannot read the schema is "nothing to migrate" (Node's own try/catch, fail-open)
// - a best-effort index or ALTER that fails is ignored exactly as Node ignores it
// A failure that must be seen goes through `crate::discard` instead.
use crate::mesh::{MeshError, MeshReader};
use crate::{defaults, sql};
use rusqlite::{Connection, ErrorCode, params};
use std::path::Path;
use std::time::Duration;

type Res<T> = Result<T, MeshError>;

/// One row for `appendMeshRow`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MeshRow {
    /// The partition (`workspace_id`).
    pub workspace_id: String,
    /// Milliseconds since the epoch.
    pub ts: i64,
    /// Dedupe key; `None` inserts unconditionally (a legacy row).
    pub hash: Option<String>,
    /// Message body.
    pub body: String,
    /// Sender label.
    pub sender: Option<String>,
    /// Recipient partition (directs only).
    pub recipient: Option<String>,
    /// `direct` or `broadcast`.
    pub mtype: Option<String>,
    /// Urgency word.
    pub urgency: Option<String>,
    /// A heartbeat broadcast.
    pub is_heartbeat: bool,
    /// A question that needs a reply.
    pub needs_reply: bool,
    /// The original row's hash on a forwarded copy.
    pub orig_hash: Option<String>,
    /// The writing process's reader nonce.
    pub instance_nonce: Option<String>,
}

/// The outcome of one append: inserted or a duplicate, and the mesh seq when inserted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Appended {
    /// False when a row with the same hash already existed.
    pub inserted: bool,
    /// The mesh seq of the new row.
    pub seq: Option<i64>,
}

/// One reader-cursor record for [`MeshStore::reader_cursor_txn`].
#[derive(Debug, Clone, PartialEq)]
pub struct CursorPut {
    /// Partition.
    pub partition: String,
    /// `store` or `nd`.
    pub ns: String,
    /// Reader key.
    pub reader: String,
    /// Read position (never lowered).
    pub value: i64,
    /// `Some(x)` replaces `retired_line` with x (`None` inside = SQL NULL); `None` leaves it.
    pub retired_line: Option<Option<i64>>,
    /// When.
    pub updated_at: i64,
}

/// One registry descriptor for [`MeshStore::upsert_registry`] (Node's `nOrNull` already applied by the caller).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RegistryRow {
    /// Workspace id.
    pub id: String,
    /// Worktree path.
    pub worktree_path: Option<String>,
    /// Session id.
    pub session_id: Option<String>,
    /// Durable inbox path.
    pub inbox_path: Option<String>,
    /// Durable cursor path.
    pub cursor_path: Option<String>,
    /// `JSON.stringify(nudgeCommand)`.
    pub nudge_command: Option<String>,
}

/// A read-write handle on one repo's store.
pub struct MeshStore {
    reader: MeshReader,
    has_write_seq: bool,
}

/// `isSqliteBusyError`: SQLITE_BUSY (or its "database is locked" text).
pub fn is_busy(e: &rusqlite::Error) -> bool {
    match e {
        rusqlite::Error::SqliteFailure(f, msg) => {
            f.code == ErrorCode::DatabaseBusy || msg.as_deref().is_some_and(|m| m.to_ascii_lowercase().contains(defaults::text("mesh_write.busy_text")))
        }
        _ => false,
    }
}

/// `retrySqliteBusy(fn)`: bounded retry of a whole statement on SQLITE_BUSY; any other error fails at once.
pub fn retry_busy<T>(mut f: impl FnMut() -> rusqlite::Result<T>) -> rusqlite::Result<T> {
    let tries = defaults::num("mesh_write.busy_retries").max(1);
    let mut last = None;
    for _ in 0..tries {
        match f() {
            Ok(v) => return Ok(v),
            Err(e) if is_busy(&e) => {
                last = Some(e);
                let jitter = jitter_ms(defaults::num("mesh_write.busy_retry_jitter_ms"));
                std::thread::sleep(Duration::from_millis(defaults::num("mesh_write.busy_retry_base_ms") + jitter));
            }
            Err(e) => return Err(e),
        }
    }
    Err(last.unwrap_or(rusqlite::Error::InvalidQuery))
}

/// `Math.floor(Math.random() * n)`.
pub fn jitter_ms(n: u64) -> u64 {
    use std::hash::{BuildHasher, Hasher};
    if n == 0 {
        return 0;
    }
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u32(std::process::id());
    h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
    h.finish() % n
}

fn table_columns(conn: &Connection, q: &str) -> Option<Vec<String>> {
    let mut st = conn.prepare(q).ok()?;
    let rows = st.query_map([], |r| r.get::<_, String>(1)).ok()?;
    Some(rows.flatten().collect())
}

impl MeshStore {
    /// `openSqlite(home, id, {dir})` on the writer path: create the directory and the file when missing, then run Node's
    /// open sequence. The caller has already settled the backend (a `BACKEND` marker naming sqlite).
    pub fn open(db: &Path) -> Res<MeshStore> {
        if let Some(dir) = db.parent() {
            std::fs::create_dir_all(dir).map_err(|e| MeshError::Sql(e.to_string()))?;
        }
        let conn = Connection::open(db)?;
        // busy_timeout is the FIRST statement, before the pragmas and the DDL, as in Node (they can meet a lock too)
        conn.busy_timeout(defaults::millis("mesh.busy_timeout_ms"))?;
        conn.execute_batch(sql::MESHW_JOURNAL_WAL)?;
        conn.execute_batch(sql::MESHW_FOREIGN_KEYS)?;
        conn.execute_batch(sql::MESHW_DDL_MESSAGES)?;
        if let Some(cols) = table_columns(&conn, sql::MESHW_TABLE_INFO_MESSAGES) {
            for need in defaults::list("mesh_write.messages_added_columns") {
                let name = need.split_whitespace().next().unwrap_or("");
                if !cols.iter().any(|c| c == name) {
                    crate::discard::harmless(conn.execute_batch(&format!("{}{need};", sql::MESHW_ALTER_MESSAGES_ADD))); // keep: Node's ALTER is best-effort
                }
            }
        }
        crate::discard::harmless(conn.execute_batch(sql::MESHW_DDL_NEEDS_REPLY_INDEX)); // keep: an index is a performance aid; Node ignores a failure
        conn.execute_batch(sql::MESHW_DDL_REGISTRY)?;
        if let Some(cols) = table_columns(&conn, sql::MESHW_TABLE_INFO_REGISTRY)
            && !cols.iter().any(|c| c == defaults::text("mesh_write.write_seq_column"))
        {
            crate::discard::harmless(conn.execute_batch(sql::MESHW_ALTER_REGISTRY_WRITE_SEQ)); // keep: Node's ALTER is best-effort
        }
        conn.execute_batch(sql::MESHW_DDL_CURSORS)?;
        conn.execute_batch(sql::MESHW_DDL_GATES)?;
        conn.execute_batch(sql::MESHW_DDL_BROADCAST_CURSORS)?;
        conn.execute_batch(sql::MESHW_DDL_READER_CURSORS)?;
        let has_write_seq =
            table_columns(&conn, sql::MESHW_TABLE_INFO_REGISTRY).is_some_and(|c| c.iter().any(|x| x == defaults::text("mesh_write.write_seq_column")));
        Ok(MeshStore { reader: MeshReader::from_conn(conn), has_write_seq })
    }

    /// The read methods, on this connection.
    pub fn reader(&self) -> &MeshReader {
        &self.reader
    }

    fn conn(&self) -> &Connection {
        self.reader.conn()
    }

    /// `appendMeshRow(m)`: insert one row (a duplicate hash is ignored) with the next mesh seq.
    pub fn append_mesh_row(&self, m: &MeshRow) -> Res<Appended> {
        let q = if m.hash.is_some() { sql::MESHW_APPEND_OR_IGNORE } else { sql::MESHW_APPEND };
        let changes = retry_busy(|| {
            self.conn().prepare_cached(q)?.execute(params![
                m.workspace_id,
                m.ts,
                m.hash,
                m.body,
                m.sender,
                m.recipient,
                m.mtype,
                m.urgency,
                i64::from(m.is_heartbeat),
                i64::from(m.needs_reply),
                m.orig_hash,
                m.instance_nonce
            ])
        })?;
        if changes == 0 {
            return Ok(Appended { inserted: false, seq: None });
        }
        let id = self.conn().last_insert_rowid();
        let seq: Option<i64> = self.conn().prepare_cached(sql::MESHW_SEQ_OF_ID)?.query_row(params![id], |r| r.get(0)).ok();
        Ok(Appended { inserted: true, seq })
    }

    /// `appendMessage(m)` (the native-ingest insert): `Ok(true)` when a row was inserted, `Ok(false)` for a duplicate hash.
    pub fn append_message(&self, workspace_id: &str, ts: i64, hash: Option<&str>, body: &str) -> Res<bool> {
        let q = if hash.is_some() { sql::MESHW_APPEND_MESSAGE_OR_IGNORE } else { sql::MESHW_APPEND_MESSAGE };
        let changes = self.conn().prepare_cached(q)?.execute(params![workspace_id, ts, hash, body])?;
        Ok(changes > 0)
    }

    /// Whether `id` has a registry row (the partition door's recheck: a rehome may have moved it away).
    pub fn is_registered(&self, id: &str) -> Res<bool> {
        Ok(self.conn().prepare_cached(sql::MESHW_REGISTRY_HAS)?.exists(params![id])?)
    }

    /// The registry row of `id` as stored (the nudge command as its stored text), or `None`.
    pub fn registry_row(&self, id: &str) -> Res<Option<RegistryRow>> {
        let mut st = self.conn().prepare_cached(sql::MESHW_REGISTRY_ROW)?;
        let mut rows = st.query(params![id])?;
        let Some(r) = rows.next()? else { return Ok(None) };
        Ok(Some(RegistryRow {
            id: r.get(0)?,
            worktree_path: r.get(1)?,
            session_id: r.get(2)?,
            inbox_path: r.get(3)?,
            cursor_path: r.get(4)?,
            nudge_command: r.get(5)?,
        }))
    }

    /// The `(workspace_id, ts, body)` of the row with this hash, if any.
    pub fn message_by_hash(&self, hash: &str) -> Res<Option<(String, i64, String)>> {
        let mut st = self.conn().prepare_cached(sql::MESHW_MESSAGE_BY_HASH)?;
        let mut rows = st.query(params![hash])?;
        let Some(r) = rows.next()? else { return Ok(None) };
        Ok(Some((r.get(0)?, r.get(1)?, r.get(2)?)))
    }

    /// `upsertRegistry(d)`: false when the id already maps to a different worktree (Node's collision guard; the row is
    /// left alone and the same warning goes to stderr).
    pub fn upsert_registry(&self, d: &RegistryRow, now: i64, same_worktree: impl Fn(&str, &str) -> bool) -> Res<bool> {
        if let Some(incoming) = d.worktree_path.as_deref() {
            let existing: Option<String> =
                self.conn().prepare_cached(sql::MESHW_REGISTRY_PATH_OF)?.query_row(params![d.id], |r| r.get::<_, Option<String>>(0)).ok().flatten();
            if let Some(existing) = existing
                && !same_worktree(&existing, incoming)
            {
                let q = |s: &str| serde_json::to_string(s).unwrap_or_default();
                eprintln!(
                    "{}",
                    defaults::render("mesh_write.msg_registry_collision", &[("id", &q(&d.id)), ("existing", &q(&existing)), ("incoming", &q(incoming))])
                );
                return Ok(false);
            }
        }
        let q = if self.has_write_seq { sql::MESHW_REGISTRY_UPSERT } else { sql::MESHW_REGISTRY_UPSERT_LEGACY };
        self.conn().prepare_cached(q)?.execute(params![d.id, d.worktree_path, d.session_id, d.inbox_path, d.cursor_path, d.nudge_command, now])?;
        Ok(true)
    }

    /// `setGate({ workspaceId, name, value, setBy })`: one more row of the gate history (`set_at` is the clock).
    pub fn set_gate(&self, id: &str, name: &str, value: bool, set_by: &str, now: i64) -> Res<()> {
        retry_busy(|| self.conn().prepare_cached(sql::MESHW_SET_GATE)?.execute(params![id, name, i64::from(value), now, set_by]))?;
        Ok(())
    }

    /// `setCursor(id, value)`.
    pub fn set_cursor(&self, id: &str, value: i64, now: i64) -> Res<()> {
        self.conn().prepare_cached(sql::MESHW_SET_CURSOR)?.execute(params![id, value.max(0), now])?;
        Ok(())
    }

    /// `setBroadcastCursor(id, value)`.
    pub fn set_broadcast_cursor(&self, id: &str, value: i64, now: i64) -> Res<()> {
        self.conn().prepare_cached(sql::MESHW_SET_BROADCAST_CURSOR)?.execute(params![id, value.max(0), now])?;
        Ok(())
    }

    /// `advanceBroadcastCursor(id)`: move `id`'s broadcast cursor to the head of the broadcast partition; returns it.
    pub fn advance_broadcast_cursor(&self, id: &str, now: i64) -> Res<i64> {
        let head: Option<f64> = self.conn().prepare_cached(sql::MESHW_BROADCAST_HEAD)?.query_row([], |r| r.get::<_, Option<f64>>(0))?;
        let head = head.filter(|f| f.is_finite()).map(|f| f as i64).unwrap_or(0);
        self.conn().prepare_cached(sql::MESHW_SET_BROADCAST_CURSOR)?.execute(params![id, head, now])?;
        Ok(head)
    }

    /// `readerCursorTxn`: write every record in ONE `BEGIN IMMEDIATE` transaction (retried whole on SQLITE_BUSY).
    pub fn reader_cursor_txn(&self, puts: &[CursorPut]) -> Res<()> {
        self.cursor_txn(|tx| {
            for p in puts {
                tx.put(p)?;
            }
            Ok(())
        })
    }

    /// `readerCursorTxn(fn)`: run `f` inside ONE `BEGIN IMMEDIATE` transaction that reads and writes `reader_cursors`
    /// (rolled back when `f` fails, the whole of it retried on SQLITE_BUSY, so `f` must be repeatable).
    pub fn cursor_txn<T>(&self, mut f: impl FnMut(&CursorTx<'_>) -> rusqlite::Result<T>) -> Res<T> {
        let c = self.conn();
        let out = retry_busy(|| {
            c.execute_batch(sql::MESHW_BEGIN_IMMEDIATE)?;
            let tx = CursorTx { conn: c };
            match f(&tx) {
                Ok(v) => {
                    c.execute_batch(sql::MESHW_COMMIT)?;
                    Ok(v)
                }
                Err(e) => {
                    crate::discard::harmless(c.execute_batch(sql::MESHW_ROLLBACK)); // keep: Node's own `try { ROLLBACK } catch {}`
                    Err(e)
                }
            }
        })?;
        Ok(out)
    }
}

/// One `reader_cursors` row as `readerCursorRowsOn` returns it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CursorRow {
    /// `store` or `nd`.
    pub ns: String,
    /// Reader key, or the floor's name.
    pub reader: String,
    /// Read position.
    pub value: i64,
    /// Set when the reader was retired at this line.
    pub retired_line: Option<i64>,
    /// When it was last written (ms).
    pub updated_at: i64,
}

/// The reads and writes of one open `reader_cursors` transaction (`readerCursorTxn`'s `tx`).
pub struct CursorTx<'a> {
    conn: &'a Connection,
}

impl CursorTx<'_> {
    /// `tx.rows(partition)`.
    pub fn rows(&self, partition: &str) -> rusqlite::Result<Vec<CursorRow>> {
        let mut st = self.conn.prepare_cached(sql::MESH_READER_CURSORS)?;
        let mut rows = st.query(params![partition])?;
        let mut out = Vec::new();
        while let Some(r) = rows.next()? {
            out.push(CursorRow {
                ns: r.get(1)?,
                reader: r.get(2)?,
                value: r.get::<_, f64>(3)? as i64,
                retired_line: r.get::<_, Option<f64>>(4)?.map(|x| x as i64),
                updated_at: r.get::<_, f64>(5)? as i64,
            });
        }
        Ok(out)
    }

    /// `tx.put(rec)`: the value never lowers; `retired_line` changes only when the record carries it.
    pub fn put(&self, p: &CursorPut) -> rusqlite::Result<()> {
        let (set, rl) = match p.retired_line {
            Some(v) => (1i64, v.map(|x| x.max(0))),
            None => (0, None),
        };
        self.conn.prepare_cached(sql::MESHW_READER_CURSOR_PUT)?.execute(params![p.partition, p.ns, p.reader, p.value.max(0), rl, p.updated_at, set])?;
        Ok(())
    }
}

/// `meshMessageHash(fields)`: `mesh:` + sha256 of the space-joined field list (needsReply appended only when true).
pub fn mesh_message_hash(from: Option<&str>, to: Option<&str>, mtype: &str, urgency: &str, message: &str, timestamp: &str, needs_reply: bool) -> String {
    let mut parts = vec![from.unwrap_or(""), to.unwrap_or(""), mtype, urgency, message, timestamp];
    if needs_reply {
        parts.push("true");
    }
    let d = ring::digest::digest(&ring::digest::SHA256, parts.join(" ").as_bytes());
    format!("{}{}", defaults::text("mesh_write.mesh_hash_prefix"), hex(d.as_ref()))
}

/// Lowercase hex.
pub fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// `appendMeshMessage(store, fields)`'s mapping to a physical row: a direct lands in the recipient's partition, a
/// broadcast (heartbeat included) in the shared broadcast partition.
#[allow(clippy::too_many_arguments)]
pub fn mesh_message_row(
    from: Option<&str>,
    to: Option<&str>,
    broadcast: bool,
    message: &str,
    ts: i64,
    urgency: &str,
    hash: &str,
    needs_reply: bool,
    instance_nonce: Option<&str>,
) -> MeshRow {
    let workspace = if broadcast { defaults::text("mesh_write.broadcast_partition").to_string() } else { to.unwrap_or_default().to_string() };
    MeshRow {
        workspace_id: workspace,
        ts,
        hash: Some(hash.to_string()),
        body: message.to_string(),
        sender: from.map(str::to_string),
        recipient: if broadcast { None } else { to.map(str::to_string) },
        mtype: Some(if broadcast { defaults::text("mesh_write.mtype_broadcast") } else { defaults::text("mesh_write.mtype_direct") }.to_string()),
        urgency: Some(urgency.to_string()),
        is_heartbeat: false,
        needs_reply,
        orig_hash: None,
        instance_nonce: instance_nonce.map(str::to_string),
    }
}
