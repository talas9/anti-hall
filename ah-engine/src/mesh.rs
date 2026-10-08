//! D45 stage S0: the read-only reader of the per-repo DevSwarm stores that Node writes.
//!
//! Node owns `~/.anti-hall/devswarm/store/<repoKey>/devswarm.db` (`companion/lib/devswarm-store.js`, sqlite backend). The
//! engine reads the same file in place, so the Node fallback (D11) and the recovery tools (D60) keep working with the
//! engine down and rollback is a no-op. This module only reads:
//!
//! * the file is opened `SQLITE_OPEN_READ_ONLY` and never created (a missing store is an error, as Node's read-only open
//!   returns null), with `query_only` on as a second guard; there is no statement in this module that writes;
//! * a store whose `BACKEND` marker is not `sqlite` (the journal backend) is refused: Node owns it;
//! * every method mirrors one Node store method, with the same statement, the same row order and the same value
//!   coercions (`Number(..)`, `String(..)`, `!= null`), so the parity harness can compare the two byte for byte;
//! * memory is bounded: one connection with a small page cache (`mesh.cache_kib`), rows are handed to a callback one at a
//!   time, a message body is never held after the call that read it, and `read` stops at `mesh.read_byte_cap` bytes.
//!
//! Not here, on purpose: the derived summary (`computeSummary`), `countFor` (it needs the NDJSON inbox files, the
//! descriptors and a process table) and every write. Those are stages S1 to S4 of the D45 plan; this module provides the
//! store-side reads they all sit on.
use crate::cli::Parsed;
use crate::{defaults, sql};
use rusqlite::types::ValueRef;
use rusqlite::{Connection, OpenFlags, Row, params};
use serde_json::{Map, Value, json};
use std::collections::BTreeSet;
use std::io::Write;
use std::path::{Path, PathBuf};

/// Why a store could not be read.
#[derive(Debug)]
pub enum MeshError {
    /// The store file does not exist. A reader never creates one.
    Missing(PathBuf),
    /// The store directory is pinned to a backend other than sqlite (Node's journal backend).
    Backend {
        /// The store file.
        path: PathBuf,
        /// The marker text found.
        backend: String,
    },
    /// SQLite failed, or a value cannot be read the way Node reads it.
    Sql(String),
}

impl MeshError {
    /// Stable code for logs and the parity harness.
    pub fn code(&self) -> &'static str {
        match self {
            MeshError::Missing(_) => "mesh_missing",
            MeshError::Backend { .. } => "mesh_backend",
            MeshError::Sql(_) => "mesh_sql",
        }
    }
}

impl std::fmt::Display for MeshError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MeshError::Missing(p) => f.write_str(&defaults::render("msg.err_mesh_missing", &[("path", &p.display())])),
            MeshError::Backend { path, backend } => f.write_str(&defaults::render("msg.err_mesh_backend", &[("path", &path.display()), ("backend", backend)])),
            MeshError::Sql(e) => f.write_str(&defaults::render("msg.err_mesh_sql", &[("err", e)])),
        }
    }
}

impl From<rusqlite::Error> for MeshError {
    fn from(e: rusqlite::Error) -> MeshError {
        MeshError::Sql(e.to_string())
    }
}

type Res<T> = Result<T, MeshError>;

/// JavaScript's number-to-JSON: a whole number prints as an integer, NaN and infinities as null.
fn num_value(f: f64) -> Value {
    if !f.is_finite() {
        Value::Null
    } else if f.fract() == 0.0 && f.abs() < 1e15 {
        Value::from(f as i64)
    } else {
        Value::from(f)
    }
}

fn safe_int(i: i64) -> Res<i64> {
    // Node's sqlite binding throws on an integer JavaScript cannot hold exactly; so does the reader, instead of rounding
    if i.unsigned_abs() > defaults::num("mesh.js_safe_int") { Err(MeshError::Sql(defaults::render("msg.err_mesh_range", &[("value", &i)]))) } else { Ok(i) }
}

/// `Number(x)` as JSON for a column value: NULL is 0, text parses as a decimal number (an empty string is 0, anything
/// else that is not a number is NaN, which JSON prints as null).
fn js_number(v: ValueRef<'_>) -> Res<Value> {
    Ok(match v {
        ValueRef::Null => Value::from(0),
        ValueRef::Integer(i) => Value::from(safe_int(i)?),
        ValueRef::Real(f) => num_value(f),
        ValueRef::Text(t) => {
            let s = String::from_utf8_lossy(t);
            let s = s.trim();
            if s.is_empty() {
                Value::from(0)
            } else {
                s.parse::<f64>().ok().filter(|f| f.is_finite() || s.eq_ignore_ascii_case("infinity")).map(num_value).unwrap_or(Value::Null)
            }
        }
        ValueRef::Blob(_) => Value::Null,
    })
}

/// `x == null ? null : Number(x)`.
fn js_number_or_null(v: ValueRef<'_>) -> Res<Value> {
    if matches!(v, ValueRef::Null) { Ok(Value::Null) } else { js_number(v) }
}

/// `x != null ? String(x) : null`.
fn js_string(v: ValueRef<'_>) -> Res<Option<String>> {
    Ok(match v {
        ValueRef::Null => None,
        ValueRef::Integer(i) => Some(safe_int(i)?.to_string()),
        ValueRef::Real(f) => Some(match num_value(f) {
            Value::Null => "NaN".to_string(),
            n => n.to_string(),
        }),
        ValueRef::Text(t) => Some(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => Some(b.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(",")),
    })
}

fn string_or_null(v: ValueRef<'_>) -> Res<Value> {
    Ok(js_string(v)?.map(Value::from).unwrap_or(Value::Null))
}

/// `v === 1` for a flag column.
fn is_one(v: ValueRef<'_>) -> bool {
    match v {
        ValueRef::Integer(i) => i == 1,
        ValueRef::Real(f) => f == 1.0,
        _ => false,
    }
}

/// `r.col || null`: an empty string, 0 and NULL all read as null.
fn truthy_string(v: ValueRef<'_>) -> Res<Value> {
    Ok(match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(0) => Value::Null,
        ValueRef::Real(0.0) => Value::Null,
        ValueRef::Text([]) => Value::Null,
        other => string_or_null(other)?,
    })
}

/// Node's `deserializeCmd`: NULL is null, valid JSON is parsed, anything else is returned as the raw text.
fn nudge_value(v: ValueRef<'_>) -> Res<Value> {
    Ok(match js_string(v)? {
        None => Value::Null,
        Some(raw) => serde_json::from_str::<Value>(&raw).unwrap_or(Value::from(raw)),
    })
}

/// One workspace's counts, without any body (the unread summary).
#[derive(Debug, Clone, PartialEq)]
pub struct Unread {
    /// The workspace (partition) id.
    pub id: String,
    /// Rows it holds.
    pub count: u64,
    /// Its direct-inbox read position (a count of consumed rows).
    pub cursor: u64,
    /// Rows after the cursor: `max(0, count - cursor)`.
    pub unread: u64,
    /// Direct rows that still need a reply.
    pub needs_reply: u64,
    /// Newest row: timestamp, mesh seq, sender, recipient and type, or null for an empty workspace.
    pub last: Value,
    /// Its reader-cursor rows.
    pub readers: Vec<Value>,
}

/// A read-only handle on one repo's store.
pub struct MeshReader {
    conn: Connection,
}

impl MeshReader {
    /// Open the store file `db` read-only. Fails when it is missing or its directory's `BACKEND` marker names another
    /// backend. Nothing is created, altered or written.
    pub fn open(db: &Path) -> Res<MeshReader> {
        if !db.is_file() {
            return Err(MeshError::Missing(db.to_path_buf()));
        }
        if let Some(dir) = db.parent()
            && let Ok(m) = std::fs::read_to_string(dir.join(defaults::text("mesh.backend_marker")))
            && m.trim().to_ascii_lowercase() != defaults::text("mesh.backend_sqlite")
        {
            return Err(MeshError::Backend { path: db.to_path_buf(), backend: m.trim().to_string() });
        }
        let conn = Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
        conn.busy_timeout(defaults::millis("mesh.busy_timeout_ms"))?;
        conn.pragma_update(None, "query_only", true)?;
        conn.pragma_update(None, "cache_size", -(defaults::num("mesh.cache_kib") as i64))?;
        Ok(MeshReader { conn })
    }

    /// Wrap a connection the caller opened (the writer's read-write one, `meshw::store`), so the read methods run on it.
    pub(crate) fn from_conn(conn: Connection) -> MeshReader {
        MeshReader { conn }
    }

    /// The underlying connection.
    pub(crate) fn conn(&self) -> &Connection {
        &self.conn
    }

    /// Every workspace id found anywhere in the store, sorted. A table that cannot be read contributes nothing, as in
    /// Node's `listWorkspaceIds`.
    pub fn workspace_ids(&self) -> Vec<String> {
        let mut ids = BTreeSet::new();
        for q in [sql::MESH_IDS_MESSAGES, sql::MESH_IDS_REGISTRY, sql::MESH_IDS_CURSORS, sql::MESH_IDS_GATES] {
            let Ok(mut st) = self.conn.prepare_cached(q) else { continue };
            let Ok(rows) = st.query_map([], |r| Ok(js_string(r.get_ref(0)?))) else { continue };
            for id in rows.flatten().flatten().flatten() {
                ids.insert(id);
            }
        }
        ids.into_iter().collect()
    }

    /// The registry (Node's `listRegistry`), one descriptor per row in id order.
    pub fn roster(&self) -> Res<Vec<Value>> {
        let mut st = self.conn.prepare_cached(sql::MESH_REGISTRY)?;
        let names: Vec<String> = st.column_names().iter().map(|s| s.to_string()).collect();
        let col = |n: &str| names.iter().position(|c| c == n);
        let (id, wt, sess, inbox, cur, nudge, upd, wseq) = (
            col("id"),
            col("worktree_path"),
            col("session_id"),
            col("inbox_path"),
            col("cursor_path"),
            col("nudge_command"),
            col("updated_at"),
            col("write_seq"),
        );
        let mut out = Vec::new();
        let mut rows = st.query([])?;
        while let Some(r) = rows.next()? {
            let get = |i: Option<usize>| -> Res<ValueRef<'_>> {
                Ok(match i {
                    Some(i) => r.get_ref(i)?,
                    None => ValueRef::Null,
                })
            };
            let mut d = Map::new();
            // `id: r.id`: the raw value, normally text
            d.insert(
                "id".into(),
                match get(id)? {
                    ValueRef::Null => Value::Null,
                    ValueRef::Integer(i) => Value::from(i),
                    other => string_or_null(other)?,
                },
            );
            d.insert("worktreePath".into(), truthy_string(get(wt)?)?);
            d.insert("sessionId".into(), truthy_string(get(sess)?)?);
            d.insert("inboxPath".into(), truthy_string(get(inbox)?)?);
            d.insert("cursorPath".into(), truthy_string(get(cur)?)?);
            d.insert("nudgeCommand".into(), nudge_value(get(nudge)?)?);
            d.insert("updatedAt".into(), js_number(get(upd)?)?);
            d.insert("writeSeq".into(), js_number_or_null(get(wseq)?)?);
            out.push(Value::Object(d));
        }
        Ok(out)
    }

    /// How many messages workspace `id` holds.
    pub fn message_count(&self, id: &str) -> Res<u64> {
        Ok(self.conn.prepare_cached(sql::MESH_MESSAGE_COUNT)?.query_row(params![id], |r| r.get::<_, i64>(0))? as u64)
    }

    fn message(r: &Row<'_>, index: u64) -> Res<Value> {
        let mut m = Map::new();
        let seq = js_number_or_null(r.get_ref(12)?)?;
        m.insert("index".into(), Value::from(index));
        m.insert("seq".into(), seq.clone());
        m.insert("storeSeq".into(), seq);
        m.insert("ts".into(), js_number(r.get_ref(1)?)?);
        m.insert("hash".into(), string_or_null(r.get_ref(2)?)?);
        m.insert("body".into(), Value::from(js_string(r.get_ref(3)?)?.unwrap_or_default()));
        m.insert("sender".into(), string_or_null(r.get_ref(4)?)?);
        m.insert("recipient".into(), string_or_null(r.get_ref(5)?)?);
        m.insert("mtype".into(), string_or_null(r.get_ref(6)?)?);
        m.insert("urgency".into(), string_or_null(r.get_ref(7)?)?);
        m.insert("isHeartbeat".into(), Value::from(is_one(r.get_ref(8)?)));
        m.insert("needsReply".into(), Value::from(is_one(r.get_ref(9)?)));
        m.insert("origHash".into(), string_or_null(r.get_ref(10)?)?);
        m.insert("instanceNonce".into(), string_or_null(r.get_ref(11)?)?);
        Ok(Value::Object(m))
    }

    /// Hand each message of workspace `id` after the first `since` to `f`, in insertion order (Node's `listMessages`
    /// with `sinceCursor`), one row at a time. `f` returns false to stop. Each message carries its 1-based positional
    /// `index`.
    pub fn for_each_message(&self, id: &str, since: u64, mut f: impl FnMut(Value) -> bool) -> Res<()> {
        let mut st = self.conn.prepare_cached(sql::MESH_MESSAGES)?;
        let mut rows = st.query(params![id, since as i64])?;
        let mut index = since;
        while let Some(r) = rows.next()? {
            index += 1;
            if !f(Self::message(r, index)?) {
                break;
            }
        }
        Ok(())
    }

    /// The newest `n` messages of workspace `id`, oldest first, with their positional index.
    pub fn last_messages(&self, id: &str, n: u64) -> Res<Vec<Value>> {
        let total = self.message_count(id)?;
        let mut st = self.conn.prepare_cached(sql::MESH_MESSAGES_LAST)?;
        let mut rows = st.query(params![id, n as i64])?;
        let mut out = Vec::new();
        let mut index = total;
        while let Some(r) = rows.next()? {
            out.push(Self::message(r, index)?);
            index = index.saturating_sub(1);
        }
        out.reverse();
        Ok(out)
    }

    /// The direct rows of workspace `id` that need a reply: sender, timestamp and mesh seq (Node's `listNeedsReply`).
    pub fn needs_reply(&self, id: &str) -> Res<Vec<Value>> {
        let mut st = self.conn.prepare_cached(sql::MESH_NEEDS_REPLY)?;
        let mut rows = st.query(params![id])?;
        let mut out = Vec::new();
        while let Some(r) = rows.next()? {
            let ts = js_number(r.get_ref(1)?)?;
            out.push(json!({"sender": string_or_null(r.get_ref(0)?)?, "ts": ts, "storeSeq": js_number_or_null(r.get_ref(2)?)?}));
        }
        Ok(out)
    }

    /// The first `mesh.preview_chars` characters of the body of each named needs-reply row (Node's
    /// `needsReplyPreviews`), keyed by the row's mesh seq.
    pub fn needs_reply_previews(&self, id: &str, seqs: &[i64]) -> Res<Map<String, Value>> {
        let mut st = self.conn.prepare_cached(sql::MESH_PREVIEW)?;
        let mut out = Map::new();
        for s in seqs {
            let mut rows = st.query(params![id, s, defaults::num("mesh.preview_chars") as i64])?;
            if let Some(r) = rows.next()?
                && let ValueRef::Text(t) = r.get_ref(0)?
            {
                out.insert(s.to_string(), Value::from(String::from_utf8_lossy(t).into_owned()));
            }
        }
        Ok(out)
    }

    fn position(&self, q: &str, id: &str) -> Res<u64> {
        let mut st = self.conn.prepare_cached(q)?;
        let mut rows = st.query(params![id])?;
        Ok(match rows.next()? {
            Some(r) => match js_number(r.get_ref(0)?)? {
                Value::Number(n) => n.as_u64().or_else(|| n.as_f64().map(|f| if f > 0.0 { f as u64 } else { 0 })).unwrap_or(0),
                _ => 0,
            },
            None => 0,
        })
    }

    /// `cursors.value` of workspace `id`, 0 when there is no row.
    pub fn cursor(&self, id: &str) -> Res<u64> {
        self.position(sql::MESH_CURSOR, id)
    }

    /// Whether workspace `id` has a `cursors` row at all.
    pub fn has_cursor_row(&self, id: &str) -> Res<bool> {
        Ok(self.conn.prepare_cached(sql::MESH_CURSOR_ROW)?.query(params![id])?.next()?.is_some())
    }

    /// `broadcast_cursors.value` of workspace `id`, 0 when there is no row.
    pub fn broadcast_cursor(&self, id: &str) -> Res<u64> {
        self.position(sql::MESH_BROADCAST_CURSOR, id)
    }

    /// Current gate values (the last row per name wins) and who set them.
    pub fn gates(&self, id: &str) -> Res<(Map<String, Value>, Map<String, Value>)> {
        let (mut values, mut set_by) = (Map::new(), Map::new());
        {
            let mut st = self.conn.prepare_cached(sql::MESH_GATES)?;
            let mut rows = st.query(params![id])?;
            while let Some(r) = rows.next()? {
                let name = js_string(r.get_ref(0)?)?.unwrap_or_default();
                values.insert(name, Value::from(is_one(r.get_ref(1)?)));
            }
        }
        let mut st = self.conn.prepare_cached(sql::MESH_GATE_SET_BY)?;
        let mut rows = st.query(params![id])?;
        while let Some(r) = rows.next()? {
            let name = js_string(r.get_ref(0)?)?.unwrap_or_default();
            set_by.insert(name, string_or_null(r.get_ref(1)?)?);
        }
        Ok((values, set_by))
    }

    /// A workspace's gate rows in insertion order: `String(gate_name)`, `value === 1` and `set_by` as text or null.
    pub fn gate_rows(&self, id: &str) -> Res<Vec<(String, bool, Option<String>)>> {
        let mut st = self.conn.prepare_cached(sql::MESH_GATE_ROWS)?;
        let mut rows = st.query(params![id])?;
        let mut out = Vec::new();
        while let Some(r) = rows.next()? {
            // a JavaScript property key: null becomes the text "null"
            let name = js_string(r.get_ref(0)?)?.unwrap_or_else(|| defaults::text("mesh_write.js_null").to_string());
            out.push((name, is_one(r.get_ref(1)?), js_string(r.get_ref(2)?)?));
        }
        Ok(out)
    }

    /// Each registry row's `String(id)` and its raw `nudge_command` text (NULL as `None`), in id order.
    pub fn registry_nudges(&self) -> Res<Vec<(String, Option<String>)>> {
        let mut st = self.conn.prepare_cached(sql::MESH_REGISTRY_NUDGES)?;
        let mut rows = st.query([])?;
        let mut out = Vec::new();
        while let Some(r) = rows.next()? {
            out.push((js_string(r.get_ref(0)?)?.unwrap_or_default(), js_string(r.get_ref(1)?)?));
        }
        Ok(out)
    }

    /// The `reader_cursors` rows of one partition; a store that predates the table has none (Node's
    /// `readerCursorRows`).
    pub fn reader_cursors(&self, partition: &str) -> Res<Vec<Value>> {
        let mut st = match self.conn.prepare_cached(sql::MESH_READER_CURSORS) {
            Ok(s) => s,
            Err(e) if e.to_string().to_ascii_lowercase().contains(defaults::text("mesh.missing_table_error")) => return Ok(Vec::new()),
            Err(e) => return Err(e.into()),
        };
        let mut rows = st.query(params![partition])?;
        let mut out = Vec::new();
        while let Some(r) = rows.next()? {
            out.push(json!({
                "partition": string_or_null(r.get_ref(0)?)?,
                "ns": string_or_null(r.get_ref(1)?)?,
                "reader": string_or_null(r.get_ref(2)?)?,
                "value": js_number(r.get_ref(3)?)?,
                "retiredLine": js_number_or_null(r.get_ref(4)?)?,
                "updatedAt": js_number(r.get_ref(5)?)?,
            }));
        }
        Ok(out)
    }

    fn last_meta(&self, id: &str) -> Res<Value> {
        let mut st = self.conn.prepare_cached(sql::MESH_LAST_META)?;
        let mut rows = st.query(params![id])?;
        Ok(match rows.next()? {
            Some(r) => json!({
                "ts": js_number(r.get_ref(0)?)?, "seq": js_number_or_null(r.get_ref(1)?)?,
                "sender": string_or_null(r.get_ref(2)?)?, "recipient": string_or_null(r.get_ref(3)?)?, "mtype": string_or_null(r.get_ref(4)?)?,
            }),
            None => Value::Null,
        })
    }

    /// The per-workspace counts the hooks read: rows, direct-inbox cursor, unread after it, pending questions, the
    /// newest row's metadata and the reader cursors. No message body is read.
    pub fn unread(&self, id: &str) -> Res<Unread> {
        let count = self.message_count(id)?;
        let cursor = self.cursor(id)?;
        Ok(Unread {
            id: id.to_string(),
            count,
            cursor,
            unread: count.saturating_sub(cursor),
            needs_reply: self.needs_reply(id)?.len() as u64,
            last: self.last_meta(id)?,
            readers: self.reader_cursors(id)?,
        })
    }
}

impl Unread {
    /// As JSON.
    pub fn to_json(&self) -> Value {
        json!({"id": self.id, "count": self.count, "cursor": self.cursor, "unread": self.unread, "needsReply": self.needs_reply, "last": self.last, "readers": self.readers})
    }
}

/// Write the canonical dump of one store, one JSON line per record with sorted keys: the registry, then per workspace
/// (sorted) a summary record followed by one record per message. This is the form the parity harness compares with
/// Node's. A workspace whose reads fail gets `{"error":true}` instead of a summary, as in Node's harness. Streaming: only
/// one message is alive at a time.
pub fn dump(r: &MeshReader, out: &mut impl Write) -> std::io::Result<()> {
    let line = |out: &mut dyn Write, v: Value| writeln!(out, "{v}");
    let reg = match r.roster() {
        Ok(v) => json!({"k": "registry", "v": v}),
        Err(_) => json!({"k": "registry", "error": true}),
    };
    line(out, reg)?;
    for id in r.workspace_ids() {
        let summary = (|| -> Res<Value> {
            let u = r.unread(&id)?;
            let nr = r.needs_reply(&id)?;
            let seqs: Vec<i64> = nr.iter().filter_map(|x| x["storeSeq"].as_i64()).collect();
            let (gates, set_by) = r.gates(&id)?;
            Ok(json!({
                "k": "ws", "id": id, "unread": u.to_json(), "hasCursorRow": r.has_cursor_row(&id)?, "broadcastCursor": r.broadcast_cursor(&id)?,
                "gates": gates, "gateSetBy": set_by, "needsReply": nr, "previews": r.needs_reply_previews(&id, &seqs)?,
                "last3": r.last_messages(&id, 3)?,
            }))
        })();
        match summary {
            Ok(v) => line(out, v)?,
            Err(_) => {
                line(out, json!({"k": "ws", "id": id, "error": true}))?;
                continue;
            }
        }
        let mut io_err = None;
        let res = r.for_each_message(&id, 0, |m| match line(out, json!({"k": "msg", "id": id, "v": m})) {
            Ok(()) => true,
            Err(e) => {
                io_err = Some(e);
                false
            }
        });
        if let Some(e) = io_err {
            return Err(e);
        }
        if res.is_err() {
            line(out, json!({"k": "msg-error", "id": id}))?;
        }
    }
    Ok(())
}

/// Hand `emit` the messages of `id` after the first `since`, stopping before the one that would take the bodies past `cap`
/// bytes (the first message always goes out, so a single large body cannot stall a reader). Returns where to resume
/// (`since` for the next call) when it stopped early.
pub fn read_capped(r: &MeshReader, id: &str, since: u64, cap: u64, mut emit: impl FnMut(&Value)) -> Res<Option<u64>> {
    let (mut bytes, mut last, mut next) = (0u64, since, None);
    r.for_each_message(id, since, |m| {
        let len = m["body"].as_str().map(str::len).unwrap_or(0) as u64;
        if bytes > 0 && bytes + len > cap {
            next = Some(last);
            return false;
        }
        bytes += len;
        last = m["index"].as_u64().unwrap_or(last);
        emit(&m);
        true
    })?;
    Ok(next)
}

/// A flag's value: the word after `--<name>`.
fn flag(p: &Parsed, name: &str) -> Option<String> {
    let f = format!("--{name}");
    p.rest.iter().position(|a| *a == f).and_then(|i| p.rest.get(i + 1)).cloned()
}

fn usage(p: &Parsed) -> i32 {
    let msg = defaults::text("msg.err_mesh_usage");
    if p.json {
        println!("{}", json!({"error": msg}));
    } else {
        eprintln!("{msg}");
    }
    1
}

fn fail(p: &Parsed, e: &MeshError) -> i32 {
    if p.json {
        println!("{}", json!({"error": e.to_string(), "code": e.code()}));
    } else {
        eprintln!("{e}");
    }
    1
}

/// `ah-engine mesh <verb>`: see `cmd.mesh` in the command registry.
pub fn run_cmd(p: &Parsed) -> i32 {
    // Without `--db` the words after `mesh` are a `devswarm.js` argv (D45 stage 2, `crate::meshw`).
    // argv[0] is the binary and argv[1] the command word (`mesh`); what follows is the devswarm.js argv.
    let mut argv = std::env::args_os();
    argv.nth(1);
    let raw: Vec<std::ffi::OsString> = argv.collect();
    if !raw.iter().any(|a| a.to_str() == Some(defaults::text("mesh.db_flag"))) && !p.rest.is_empty() {
        return crate::meshw::run_front(&raw);
    }
    let verb = p.rest.first().map(String::as_str).unwrap_or("");
    let Some(db) = flag(p, "db") else { return usage(p) };
    let reader = match MeshReader::open(Path::new(&db)) {
        Ok(r) => r,
        Err(e) => return fail(p, &e),
    };
    let stdout = std::io::stdout();
    let mut out = std::io::BufWriter::new(stdout.lock());
    let result: Res<()> = (|| match verb {
        "roster" => {
            let v = Value::Array(reader.roster()?);
            crate::discard::harmless(if p.json { writeln!(out, "{v}") } else { writeln!(out, "{}", crate::cli::human(&json!({"roster": v}))) }); // keep: a closed stdout leaves nobody to tell
            Ok(())
        }
        "unread" => {
            let rows: Res<Vec<Value>> = reader.workspace_ids().iter().map(|id| reader.unread(id).map(|u| u.to_json())).collect();
            let v = Value::Array(rows?);
            crate::discard::harmless(if p.json { writeln!(out, "{v}") } else { writeln!(out, "{}", crate::cli::human(&json!({"unread": v}))) }); // keep: a closed stdout leaves nobody to tell
            Ok(())
        }
        "read" => {
            let id = flag(p, "id").unwrap_or_default();
            let emit = |m: &Value, out: &mut dyn Write| {
                // keep: a closed stdout leaves nobody to tell
                crate::discard::harmless(if p.json {
                    writeln!(out, "{m}")
                } else {
                    writeln!(
                        out,
                        "{} {} {}: {}",
                        m["index"],
                        m["sender"].as_str().unwrap_or("-"),
                        m["mtype"].as_str().unwrap_or("-"),
                        m["body"].as_str().unwrap_or("").replace('\n', " ")
                    )
                });
            };
            if let Some(n) = flag(p, "last") {
                // bounded: a caller cannot make the reader hold more than `mesh.last_max` bodies at once
                let n = n.parse::<u64>().unwrap_or(defaults::num("mesh.last_default")).clamp(1, defaults::num("mesh.last_max"));
                for m in reader.last_messages(&id, n)? {
                    emit(&m, &mut out);
                }
            } else {
                let since = flag(p, "since").and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
                if let Some(next) = read_capped(&reader, &id, since, defaults::num("mesh.read_byte_cap"), |m| emit(m, &mut out))? {
                    crate::discard::harmless(writeln!(out, "{}", json!({"truncated": true, "nextSince": next}))); // keep: a closed stdout leaves nobody to tell
                }
            }
            Ok(())
        }
        "dump" => dump(&reader, &mut out).map_err(|e| MeshError::Sql(e.to_string())),
        _ => Err(MeshError::Sql(String::new())),
    })();
    crate::discard::harmless(out.flush()); // keep: a closed stdout leaves nobody to tell
    match result {
        Ok(()) => 0,
        Err(MeshError::Sql(s)) if s.is_empty() => usage(p),
        Err(e) => fail(p, &e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A store in Node's schema with `n` messages of workspace `w`, each body `len` bytes.
    fn store(n: usize, len: usize) -> (PathBuf, MeshReader) {
        let dir = std::env::temp_dir().join(format!("ah-mesh-unit-{}-{n}-{len}", std::process::id()));
        crate::discard::harmless(std::fs::remove_dir_all(&dir)); // keep: cleanup that raced; an absent directory is the goal state
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("devswarm.db");
        let c = Connection::open(&db).unwrap();
        c.execute_batch("CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, ts INTEGER NOT NULL, hash TEXT, body TEXT, sender TEXT, recipient TEXT, mtype TEXT, urgency TEXT, is_heartbeat INTEGER, needs_reply INTEGER, orig_hash TEXT, instance_nonce TEXT, seq INTEGER, UNIQUE(hash));").unwrap();
        for i in 0..n {
            c.execute(
                "INSERT INTO messages (workspace_id, ts, hash, body, seq) VALUES ('w', ?1, ?2, ?3, ?4)",
                params![i as i64, format!("h{i}"), "x".repeat(len), i as i64 + 1],
            )
            .unwrap();
        }
        drop(c);
        let r = MeshReader::open(&db).unwrap();
        (dir, r)
    }

    #[test]
    fn a_read_stops_at_the_byte_cap_and_says_where_to_resume() {
        let (dir, r) = store(10, 100);
        let mut got = Vec::new();
        let next = read_capped(&r, "w", 0, 350, |m| got.push(m["index"].as_u64().unwrap())).unwrap();
        assert_eq!(got, vec![1, 2, 3], "three 100-byte bodies fit in 350 bytes");
        assert_eq!(next, Some(3), "resume with --since 3");
        let mut rest = Vec::new();
        let next = read_capped(&r, "w", 3, 10_000, |m| rest.push(m["index"].as_u64().unwrap())).unwrap();
        assert_eq!((rest, next), ((4..=10).collect::<Vec<_>>(), None), "the resumed read gets the rest and is not truncated");
        let mut one = Vec::new();
        let next = read_capped(&r, "w", 0, 1, |m| one.push(m["index"].as_u64().unwrap())).unwrap();
        assert_eq!((one, next), (vec![1], Some(1)), "a body larger than the cap still goes out alone");
        crate::discard::harmless(std::fs::remove_dir_all(dir)); // keep: test cleanup; an absent directory is the goal state
    }

    #[test]
    fn last_messages_carry_their_positional_index() {
        let (dir, r) = store(7, 5);
        let last: Vec<u64> = r.last_messages("w", 3).unwrap().iter().map(|m| m["index"].as_u64().unwrap()).collect();
        assert_eq!(last, vec![5, 6, 7]);
        assert_eq!(r.message_count("w").unwrap(), 7);
        assert_eq!(r.message_count("nobody").unwrap(), 0);
        crate::discard::harmless(std::fs::remove_dir_all(dir)); // keep: test cleanup; an absent directory is the goal state
    }

    #[test]
    fn a_write_through_the_reader_connection_is_refused() {
        let (dir, r) = store(1, 1);
        assert!(r.conn.execute("DELETE FROM messages", []).is_err(), "the connection is read-only");
        assert_eq!(r.message_count("w").unwrap(), 1);
        crate::discard::harmless(std::fs::remove_dir_all(dir)); // keep: test cleanup; an absent directory is the goal state
    }
}
