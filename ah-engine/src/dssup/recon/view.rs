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
