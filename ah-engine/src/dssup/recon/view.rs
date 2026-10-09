//! Read-only views of the live home that the planners need: where things live, what a file's bytes are, a store's registry as
//! it is stored. Nothing here writes, and nothing here opens a store read-write (a read-only connection never changes a
//! schema).
use super::{Pre, RegRow};
use crate::checks::guardkit::ojson::OVal;
use crate::defaults;
use crate::meshw::ident::{Defer, R, defer};
use crate::meshw::store::{RegistryRow, hex};
use std::path::{Path, PathBuf};

/// The SHA-256 of `bytes`, lower-case hex.
pub fn sha256_hex(bytes: &[u8]) -> String {
    hex(ring::digest::digest(&ring::digest::SHA256, bytes).as_ref())
}

/// The DevSwarm state directory relative to the home (`.anti-hall/devswarm`).
pub fn root_rel() -> String {
    format!("{}/{}", defaults::text("mesh_write.dir_anti_hall"), defaults::text("mesh_write.dir_devswarm"))
}

/// `rel` under the DevSwarm state directory, relative to the home.
pub fn ds(rel: &str) -> String {
    format!("{}/{rel}", root_rel())
}

/// The descriptor of `id` relative to the home (`workspaces/<id>.json`).
pub fn descriptor_rel(id: &str) -> String {
    ds(&format!("{}/{id}{}", defaults::text("mesh_write.dir_workspaces"), defaults::text("mesh_write.json_suffix")))
}

/// The archived marker of `id` relative to the home.
pub fn archived_rel(id: &str) -> String {
    ds(&format!("{}/{id}{}", defaults::text("mesh_write.dir_archived"), defaults::text("mesh_write.json_suffix")))
}

/// A store's directory relative to the home.
pub fn store_rel(hash: &str) -> String {
    ds(&format!("{}/{hash}", defaults::text("mesh_write.dir_store")))
}

/// The database file of a store.
pub fn store_db(home: &Path, hash: &str) -> PathBuf {
    home.join(store_rel(hash)).join(defaults::text("mesh_write.store_file"))
}

/// What a file is right now, as a precondition.
pub fn pre_of(home: &Path, rel: &str) -> Pre {
    match std::fs::read(home.join(rel)) {
        Ok(b) => Pre::Digest(sha256_hex(&b)),
        Err(_) => Pre::Absent,
    }
}

/// `fs.existsSync(rel)` under the home: follows links, so a dangling link does not exist.
pub fn exists(home: &Path, rel: &str) -> bool {
    home.join(rel).exists()
}

fn sqlite_marker(home: &Path, hash: &str) -> bool {
    std::fs::read_to_string(home.join(store_rel(hash)).join(defaults::text("mesh.backend_marker")))
        .is_ok_and(|m| m.trim().to_ascii_lowercase() == defaults::text("mesh.backend_sqlite"))
}

/// Every registry row of a store as stored, ordered by id, or a deferral: not a sqlite store, no database, a registry without
/// `write_seq`, a column the reader cannot decode.
pub fn registry(home: &Path, hash: &str) -> R<Vec<RegRow>> {
    if !sqlite_marker(home, hash) {
        return defer("store-backend");
    }
    let db = store_db(home, hash);
    let reader = crate::mesh::MeshReader::open(&db).map_err(|e| Defer(format!("store-open:{e}")))?;
    let c = reader.conn();
    let cols: Vec<String> = {
        let mut st = c.prepare(crate::sql::MESHW_TABLE_INFO_REGISTRY).map_err(|e| Defer(format!("registry-shape:{e}")))?;
        let it = st.query_map([], |r| r.get::<_, String>(1)).map_err(|e| Defer(format!("registry-shape:{e}")))?;
        it.flatten().collect()
    };
    if !cols.iter().any(|x| x == defaults::text("mesh_write.write_seq_column")) {
        return defer("no-write-seq");
    }
    let mut st = c.prepare(crate::sql::RECON_REGISTRY_ALL).map_err(|e| Defer(format!("registry-shape:{e}")))?;
    let rows = st
        .query_map([], |r| {
            Ok(RegRow {
                row: RegistryRow {
                    id: r.get(0)?,
                    worktree_path: r.get(1)?,
                    session_id: r.get(2)?,
                    inbox_path: r.get(3)?,
                    cursor_path: r.get(4)?,
                    nudge_command: r.get(5)?,
                },
                updated_at: r.get(6)?,
                write_seq: r.get(7)?,
            })
        })
        .map_err(|e| Defer(format!("registry-shape:{e}")))?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| Defer(format!("registry-shape:{e}")))
}

/// `|| null` of `rowToDescriptor`: an empty text reads as no value.
fn or_null(v: &Option<String>) -> Option<String> {
    v.clone().filter(|s| !s.is_empty())
}

/// `serializeCmd(deserializeCmd(raw))` of a stored nudge command: parsed as JSON when it parses (else kept as the text), then
/// stringified again; `None` for SQL NULL or a JSON `null`.
fn nudge_roundtrip(raw: &Option<String>) -> Option<String> {
    let raw = raw.as_ref()?;
    match OVal::parse(raw) {
        Some(OVal::Null) => None,
        Some(v) => Some(v.stringify()),
        None => Some(OVal::Str(raw.clone()).stringify()),
    }
}

/// The descriptor Node's `listRegistry()` hands back for a stored row, in the form `upsertRegistry` writes it: what a read
/// followed by a write of the same row stores.
pub fn descriptor_of(r: &RegRow) -> RegistryRow {
    RegistryRow {
        id: r.row.id.clone(),
        worktree_path: or_null(&r.row.worktree_path),
        session_id: or_null(&r.row.session_id),
        inbox_path: or_null(&r.row.inbox_path),
        cursor_path: or_null(&r.row.cursor_path),
        nudge_command: nudge_roundtrip(&r.row.nudge_command),
    }
}

/// `String(v)` of a descriptor field the engine reproduces: a string as is, `null` as `None`; any other JSON type is a state
/// the engine does not model (`String(5)`, `String({})`), so the caller defers.
pub fn str_field(d: &OVal, key: &str) -> R<Option<String>> {
    match d.get(key) {
        None | Some(OVal::Null) => Ok(None),
        Some(OVal::Str(s)) => Ok(Some(s.clone())),
        Some(_) => defer("descriptor-field-type"),
    }
}

// ---- S6: what the fold reads of a store -----------------------------------------------------------------------------------------

/// One message row as the fold copies it (`listMessages`' shape, the columns the forward uses).
#[derive(Debug, Clone, PartialEq)]
pub struct Msg {
    /// Milliseconds since the epoch (an integer; any other stored type is a deferral).
    pub ts: i64,
    /// The dedupe hash.
    pub hash: Option<String>,
    /// The body (`''` for SQL NULL, as `listMessages` reads it).
    pub body: String,
    /// The sender label.
    pub sender: Option<String>,
    /// The recipient partition.
    pub recipient: Option<String>,
    /// `direct` or `broadcast`.
    pub mtype: Option<String>,
    /// The urgency word.
    pub urgency: Option<String>,
    /// A heartbeat broadcast (`is_heartbeat === 1`).
    pub is_heartbeat: bool,
    /// A question that needs a reply (`needs_reply === 1`).
    pub needs_reply: bool,
    /// The original row's hash on a forwarded copy.
    pub orig_hash: Option<String>,
    /// The writing process's reader nonce.
    pub instance_nonce: Option<String>,
}

fn shape<T, E: std::fmt::Display>(r: Result<T, E>, what: &str) -> R<T> {
    r.map_err(|e| Defer(format!("{what}:{e}")))
}

/// A read-only handle on a store the fold plans from.
pub fn reader(home: &Path, store: &str) -> R<crate::mesh::MeshReader> {
    shape(crate::mesh::MeshReader::open(&store_db(home, store)), "store-open")
}

/// A partition's message rows in storage order.
pub fn messages_of(rd: &crate::mesh::MeshReader, id: &str) -> R<Vec<Msg>> {
    let mut st = shape(rd.conn().prepare(crate::sql::RECON_MESSAGES_OF), "messages-shape")?;
    let mut rows = shape(st.query(rusqlite::params![id]), "messages-shape")?;
    let mut out = Vec::new();
    while let Some(r) = shape(rows.next(), "messages-read")? {
        let ts = match shape(r.get_ref(1), "messages-read")? {
            rusqlite::types::ValueRef::Integer(i) => i,
            _ => return defer("message-ts-type"),
        };
        let text = |i: usize| shape(r.get::<_, Option<String>>(i), "message-text-type");
        let flag = |i: usize| shape(r.get::<_, Option<i64>>(i), "message-flag-type").map(|v| v == Some(1));
        out.push(Msg {
            ts,
            hash: text(2)?,
            body: text(3)?.unwrap_or_default(),
            sender: text(4)?,
            recipient: text(5)?,
            mtype: text(6)?,
            urgency: text(7)?,
            is_heartbeat: flag(8)?,
            needs_reply: flag(9)?,
            orig_hash: text(10)?,
            instance_nonce: text(11)?,
        });
    }
    Ok(out)
}

/// The number of message rows in a partition.
pub fn message_count(rd: &crate::mesh::MeshReader, id: &str) -> R<i64> {
    shape(rd.conn().query_row(crate::sql::RECON_MESSAGE_COUNT, rusqlite::params![id], |r| r.get::<_, i64>(0)), "messages-shape")
}

/// Whether any partition of the store already holds a row with this hash (what `INSERT OR IGNORE` on the hash tests).
pub fn hash_present(rd: &crate::mesh::MeshReader, hash: &str) -> R<bool> {
    let mut st = shape(rd.conn().prepare(crate::sql::RECON_HASH_PRESENT), "messages-shape")?;
    shape(st.exists(rusqlite::params![hash]), "messages-read")
}

/// The `reader_cursors` rows of a partition.
pub fn cursor_rows(rd: &crate::mesh::MeshReader, id: &str) -> R<Vec<crate::meshw::store::CursorRow>> {
    crate::meshw::cursors::rows_from_reader(rd, id).map_err(|e| Defer(format!("cursor-rows:{e}")))
}

/// `cursors.value` of a partition (0 when there is no row).
pub fn store_cursor(rd: &crate::mesh::MeshReader, id: &str) -> R<i64> {
    Ok(shape(rd.cursor(id), "cursor-read")? as i64)
}

fn cursor_file(home: &Path, name: &str) -> PathBuf {
    crate::meshw::idlock::devswarm_root(home).join(defaults::text("mesh_write.dir_cursors")).join(name)
}

/// The floor of the store namespace as `readerCursors.floorOf` reports it: the floor row when it exists, else the legacy
/// floor computed dry (`#base` file or the shared pair, raised to the lowest per-instance file).
pub fn store_floor(home: &Path, rd: &crate::mesh::MeshReader, id: &str, rows: &[crate::meshw::store::CursorRow]) -> R<i64> {
    if let Some(f) = rows.iter().find(|r| r.ns == defaults::text("mesh_write.cursor_ns_store") && r.reader == defaults::text("mesh_write.cursor_floor_reader"))
    {
        return Ok(f.value);
    }
    let json = defaults::text("mesh_write.json_suffix");
    let legacy = crate::meshw::cursors::legacy_safe(id);
    let base_file = cursor_file(home, &format!("{id}{}{json}", defaults::text("mesh_write.cursor_base_suffix")));
    let baseline = if legacy && base_file.exists() {
        crate::meshw::cursors::read_cursor(&base_file) as i64
    } else {
        (crate::meshw::cursors::read_cursor(&crate::meshw::cursors::primary_cursor_path(home, id)) as i64).max(store_cursor(rd, id)?)
    };
    if !legacy {
        return Ok(baseline);
    }
    let prefix = format!("{id}{}", defaults::text("mesh_write.cursor_inst_sep"));
    let short = defaults::num("mesh_write.legacy_cursor_short_len") as usize;
    let mut min: Option<i64> = None;
    if let Ok(rdir) = std::fs::read_dir(cursor_file(home, "")) {
        for e in rdir.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            let Some(rest) = name.strip_prefix(&prefix).and_then(|r| r.strip_suffix(json)) else { continue };
            if rest.len() != short || !rest.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
                continue;
            }
            let v = crate::meshw::cursors::read_cursor(&e.path()) as i64;
            min = Some(min.map_or(v, |m| m.min(v)));
        }
    }
    Ok(min.map_or(baseline, |m| baseline.max(m)))
}

/// `hasReaderEvidence(id)`: something has drained this partition (a store cursor above 0, a floor above 0, or a read-path
/// cursor file above 0).
pub fn has_reader_evidence(home: &Path, rd: &crate::mesh::MeshReader, id: &str) -> R<bool> {
    let rows = cursor_rows(rd, id)?;
    if store_cursor(rd, id)?.max(store_floor(home, rd, id, &rows)?) > 0 {
        return Ok(true);
    }
    Ok(crate::meshw::cursors::read_cursor(&crate::meshw::cursors::primary_cursor_path(home, id)) > 0.0)
}

/// `cursors/<id>.json` relative to the home.
pub fn primary_cursor_rel(id: &str) -> String {
    ds(&format!("{}/{id}{}", defaults::text("mesh_write.dir_cursors"), defaults::text("mesh_write.json_suffix")))
}

/// The sibling-seen watermark `cursors/<caller>.seen-<sibling>.json` relative to the home, `None` when either id is not safe
/// for a watermark file name (`siblingSeenCursorPath`).
pub fn seen_cursor_rel(caller: &str, sibling: &str) -> Option<String> {
    let sep = defaults::text("devswarm_recon.seen_sep");
    let ok = |id: &str| crate::meshw::idlock::is_safe_id(id) && !id.contains(sep);
    (ok(caller) && ok(sibling))
        .then(|| ds(&format!("{}/{caller}{sep}{sibling}{}", defaults::text("mesh_write.dir_cursors"), defaults::text("mesh_write.json_suffix"))))
}

/// `heartbeats/<id>.json` relative to the home.
pub fn heartbeat_rel(id: &str) -> String {
    ds(&format!("{}/{id}{}", defaults::text("mesh_write.dir_heartbeats"), defaults::text("mesh_write.json_suffix")))
}

/// `retired/<id>.json` relative to the home (`retiredRedirectPath`).
pub fn retired_rel(id: &str) -> String {
    ds(&format!("{}/{id}{}", defaults::text("devswarm_recon.dir_retired"), defaults::text("mesh_write.json_suffix")))
}

/// What a partition looked like when a plan decided about it: message count, cursor, and every reader row.
pub fn partition_sig(home: &Path, store: &str, id: &str) -> R<String> {
    let rd = reader(home, store)?;
    let mut s = format!("{}|{}", message_count(&rd, id)?, store_cursor(&rd, id)?);
    for r in cursor_rows(&rd, id)? {
        s.push_str(&format!("|{}:{}:{}:{:?}:{}", r.ns, r.reader, r.value, r.retired_line, r.updated_at));
    }
    Ok(s)
}
