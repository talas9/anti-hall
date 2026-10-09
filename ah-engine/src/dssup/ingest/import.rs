//! A monitor batch into the store: `parseMonitorPayload`, `messageHash`, `stableJson` and `ingestPayload` of
//! `companion/devswarm-ingest.js`, plus the partition door of `scripts/devswarm-lib/core.js` `appendIntoPartition`.
//!
//! LOSS-FREE: every message is content-hashed (`native:` + sha256) and appended `INSERT OR IGNORE`, so re-importing a batch (a
//! crash after the destructive read, a WAL replay) inserts nothing twice. Rows go in under the partition's own lock, after a
//! recheck that the partition is still registered in this store; a refusal writes NOTHING and the batch stays pending in the WAL.
//! A batch that has substantive bytes but no recognisable shape is `lossy`: the caller quarantines it.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this module is a deliberate keep, for these reasons:
// - text that does not parse is the unrecognised shape (Node: `catch (_) { return { messages: [], recognized: false } }`)
// - a field that is absent is the empty string in the hash (Node: `x != null ? String(x) : ''`)
use crate::checks::guardkit::ojson::OVal;
use crate::checks::guardkit::text::js_trim;
use crate::checks::jsport::num::to_js_string;
use crate::checks::jsport::date::{Parsed, parse as date_parse};
use crate::defaults;
use crate::meshw::idlock;
use crate::meshw::store::{MeshStore, hex};
use std::path::Path;

/// The messages of one batch and whether its shape was one of the known ones.
#[derive(Debug, Clone, PartialEq)]
pub struct Batch {
    /// The messages (objects; an empty list for a quiet poll).
    pub messages: Vec<OVal>,
    /// `parseMonitorPayload`'s `recognized`: an empty `[]` is recognised, unparseable text is not.
    pub recognized: bool,
}

/// `parseMonitorPayload(raw)`: an array, `{messages: [...]}`, `{data: [...]}` or one message object.
pub fn parse_batch(raw: &str) -> Batch {
    let t = raw.trim();
    if t.is_empty() {
        return Batch { messages: vec![], recognized: true };
    }
    let Some(val) = OVal::parse(t) else { return Batch { messages: vec![], recognized: false } };
    let objects = |a: &[OVal]| a.iter().filter(|x| matches!(x, OVal::Obj(_) | OVal::Arr(_))).cloned().collect::<Vec<_>>();
    match &val {
        OVal::Arr(a) => Batch { messages: objects(a), recognized: true },
        OVal::Obj(_) => {
            for k in defaults::list("devswarm_ingest.container_keys") {
                if let Some(OVal::Arr(a)) = val.get(k) {
                    return Batch { messages: objects(a), recognized: true };
                }
            }
            if defaults::list("devswarm_ingest.message_keys").iter().any(|k| val.get(k).is_some()) {
                return Batch { messages: vec![val], recognized: true };
            }
            Batch { messages: vec![], recognized: false }
        }
        _ => Batch { messages: vec![], recognized: false },
    }
}

/// `String(v)` for a JSON value (`null` does not occur where it is used: callers test `!= null` first).
pub fn js_string(v: &OVal) -> String {
    match v {
        OVal::Null => "null".to_string(),
        OVal::Bool(b) => b.to_string(),
        OVal::Num(n) => to_js_string(*n),
        OVal::Str(s) => s.clone(),
        OVal::Arr(a) => a.iter().map(|x| if matches!(x, OVal::Null) { String::new() } else { js_string(x) }).collect::<Vec<_>>().join(","),
        OVal::Obj(_) => defaults::text("devswarm_ingest.js_object_text").to_string(),
    }
}

/// `stableJson(obj)`: key-sorted JSON, so a hash does not depend on key order.
pub fn stable_json(v: &OVal) -> String {
    match v {
        OVal::Arr(a) => format!("[{}]", a.iter().map(stable_json).collect::<Vec<_>>().join(",")),
        OVal::Obj(o) => {
            let mut keys: Vec<&(String, OVal)> = o.iter().collect();
            keys.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
            let parts: Vec<String> = keys.iter().map(|(k, x)| format!("{}:{}", serde_json::to_string(k).unwrap_or_default(), stable_json(x))).collect();
            format!("{{{}}}", parts.join(","))
        }
        other => other.stringify(),
    }
}

fn field(m: &OVal, k: &str) -> Option<String> {
    match m.get(k) {
        None | Some(OVal::Null) => None,
        Some(v) => Some(js_string(v)),
    }
}

/// `messageHash(workspaceId, msg)`: `native:` + sha256 of the NUL-joined identifying fields (plus a canonical JSON of the whole
/// message when it has no `createdAt` to tell two same-text messages apart).
pub fn message_hash(workspace_id: &str, m: &OVal) -> String {
    let keys = defaults::list("devswarm_ingest.hash_fields");
    let mut parts = vec![workspace_id.to_string()];
    parts.extend(keys.iter().map(|k| field(m, k).unwrap_or_default()));
    let mut keyed = parts.join("\u{0}");
    if field(m, defaults::text("devswarm_ingest.created_key")).is_none() {
        keyed.push('\u{0}');
        keyed.push_str(&stable_json(m));
    }
    let d = ring::digest::digest(&ring::digest::SHA256, keyed.as_bytes());
    format!("{}{}", defaults::text("devswarm_ingest.hash_prefix"), hex(d.as_ref()))
}

/// One row to append.
#[derive(Debug, Clone, PartialEq)]
pub struct Row {
    /// The partition.
    pub workspace_id: String,
    /// `String(message)`, else the canonical JSON.
    pub body: String,
    /// The dedupe hash.
    pub hash: String,
    /// `Date.parse(createdAt)`, else the import time.
    pub ts: i64,
    /// The registered workspace checked out under the message's branch (`fromBranch`), `None` when unknown or ambiguous.
    pub sender: Option<String>,
    /// The time came from the import clock because `createdAt` was absent, unparseable, or a form whose `Date.parse` the engine
    /// does not reproduce.
    pub ts_fallback: bool,
}

/// The rows of a batch.
pub fn rows(workspace_id: &str, batch: &Batch, now: i64) -> Vec<Row> {
    batch
        .messages
        .iter()
        .map(|m| {
            let body = field(m, defaults::text("devswarm_ingest.body_key")).unwrap_or_else(|| stable_json(m));
            let parsed = match m.get(defaults::text("devswarm_ingest.created_key")) {
                None => Parsed::Nan,
                Some(v) => date_parse(&js_string(v)),
            };
            let (ts, ts_fallback) = match parsed {
                Parsed::Ms(ms) if ms.is_finite() => (ms as i64, false),
                Parsed::Unknown => (now, true),
                _ => (now, false),
            };
            Row { workspace_id: workspace_id.to_string(), body, hash: message_hash(workspace_id, m), ts, sender: None, ts_fallback }
        })
        .collect()
}

/// The checkout directory name DevSwarm gives a branch (`fix/foo` -> `fix-foo`).
fn branch_dir(branch: &str) -> String {
    branch.replace(defaults::text("devswarm_ingest.branch_dir_from"), defaults::text("devswarm_ingest.branch_dir_to"))
}

/// `resolveBranchSender(registry, branch)`: the one registered workspace whose checkout directory is the branch's directory
/// name; `None` when there is none or more than one (never a guess). `registry` is `(id, worktree path)` pairs.
pub fn branch_sender(registry: &[(String, String)], branch: &str) -> Option<String> {
    let branch = js_trim(branch);
    if branch.is_empty() {
        return None;
    }
    let want = branch_dir(branch);
    let mut hits: Vec<&String> = registry
        .iter()
        .filter(|(_, wt)| Path::new(wt).file_name().is_some_and(|n| n.to_string_lossy() == want.as_str()))
        .map(|(id, _)| id)
        .collect();
    hits.sort();
    hits.dedup();
    if hits.len() == 1 { Some(hits[0].clone()) } else { None }
}

/// `branchOfDoneBody(body)`: the branch a `DONE: <branch> ...` body names (the word after the prefix, which must be followed by
/// whitespace), else `None`.
pub fn done_branch(body: &str) -> Option<String> {
    let rest = body.strip_prefix(defaults::text("devswarm_ingest.done_body_prefix"))?;
    let after_ws = rest.trim_start_matches(|c: char| c.is_whitespace());
    if after_ws.len() == rest.len() {
        return None; // the prefix must be followed by whitespace
    }
    let end = after_ws.find(|c: char| c.is_whitespace())?;
    (end > 0).then(|| after_ws[..end].to_string())
}

/// The `(id, worktree path)` pairs of a store's registry.
pub fn registry_pairs(reader: &crate::mesh::MeshReader) -> Vec<(String, String)> {
    reader
        .roster()
        .unwrap_or_default() // keep: an unreadable registry attributes nobody (the sender stays NULL, as before)
        .iter()
        .filter_map(|r| Some((r["id"].as_str()?.to_string(), r["worktreePath"].as_str()?.to_string())))
        .collect()
}

/// Why a batch was not imported. The batch is not lost: it is pending in the WAL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refused {
    /// The partition's lock is held by another writer (`EPARTITIONBUSY`).
    Busy,
    /// The partition is no longer registered in this store (`EPARTITIONGONE`): register it again.
    Gone,
    /// The store failed.
    Store(String),
}

/// What an import did.
#[derive(Debug, Clone, PartialEq)]
pub struct Imported {
    /// Messages in the batch.
    pub total: usize,
    /// Rows that were new.
    pub inserted: usize,
    /// Rows that were already there.
    pub duplicate: usize,
    /// Substantive bytes of no known shape: unrecoverable, to be quarantined.
    pub lossy: bool,
    /// The rows, for the witness and the summary.
    pub rows: Vec<Row>,
}

/// `ingestPayload(s, raw, {workspaceId, home, now})`.
pub fn ingest_payload(store: &MeshStore, home: &Path, workspace_id: &str, raw: &str, now: i64) -> Result<Imported, Refused> {
    let batch = parse_batch(raw);
    let mut rows = rows(workspace_id, &batch, now);
    if !rows.is_empty() {
        // sender: the registry row checked out under the message's branch (a native message names only its branch)
        let registry = registry_pairs(store.reader());
        for (r, m) in rows.iter_mut().zip(&batch.messages) {
            r.sender = field(m, defaults::text("devswarm_ingest.from_branch_key")).and_then(|b| branch_sender(&registry, &b));
        }
    }
    let mut inserted = 0;
    if !rows.is_empty() {
        // the partition door: its lock, then "still registered here", then the rows; any refusal writes nothing
        let Some(lock) = idlock::acquire(home, workspace_id) else { return Err(Refused::Busy) };
        let go = || -> Result<usize, Refused> {
            if !store.is_registered(workspace_id).map_err(|e| Refused::Store(e.to_string()))? {
                return Err(Refused::Gone);
            }
            let mut n = 0;
            for r in &rows {
                if store.append_message_from(&r.workspace_id, r.ts, Some(&r.hash), &r.body, r.sender.as_deref()).map_err(|e| Refused::Store(e.to_string()))? {
                    n += 1;
                }
            }
            Ok(n)
        };
        let out = go();
        lock.release();
        inserted = out?;
    }
    let lossy = rows.is_empty() && !raw.trim().is_empty() && !batch.recognized;
    Ok(Imported { total: rows.len(), inserted, duplicate: rows.len() - inserted, lossy, rows })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::meshw::store::RegistryRow;

    fn pairs() -> Vec<(String, String)> {
        vec![
            ("c1".into(), "/x/repos/0/ab/fix-skydart-pdf-and-tests".into()),
            ("c2".into(), "/x/repos/0/cd/chore-find-new-website".into()),
            ("dupA".into(), "/x/a/same-dir".into()),
            ("dupB".into(), "/y/b/same-dir".into()),
        ]
    }

    #[test]
    fn the_sender_is_the_one_workspace_checked_out_under_the_branch() {
        let r = pairs();
        assert_eq!(branch_sender(&r, "fix/skydart-pdf-and-tests").as_deref(), Some("c1"));
        assert_eq!(branch_sender(&r, "chore/find-new-website").as_deref(), Some("c2"));
        assert_eq!(branch_sender(&r, "nope/unknown"), None);
        assert_eq!(branch_sender(&r, "same-dir"), None, "two rows share the directory: never a guess");
        assert_eq!(branch_sender(&r, "  "), None);
    }

    #[test]
    fn a_done_body_names_its_branch() {
        assert_eq!(done_branch("DONE: fix/skydart-pdf-and-tests \u{2014} skydart@main@acd48aad").as_deref(), Some("fix/skydart-pdf-and-tests"));
        assert_eq!(done_branch("hello DONE: a/b x"), None);
        assert_eq!(done_branch("DONE:a/b x"), None, "the prefix must be followed by whitespace");
        assert_eq!(done_branch("DONE: a/b"), None, "the branch must be followed by whitespace");
    }

    #[test]
    fn an_ingested_done_notice_carries_its_sender() {
        let dir = std::env::temp_dir().join(format!("ah-import-sender-{}", std::process::id()));
        crate::discard::harmless(std::fs::remove_dir_all(&dir)); // keep: cleanup that raced; an absent directory is the goal state
        std::fs::create_dir_all(&dir).unwrap();
        let st = MeshStore::open(&dir.join("devswarm.db")).unwrap();
        for (id, wt) in [("p", "/w/main"), ("c1", "/x/repos/0/ab/fix-foo")] {
            let row = RegistryRow { id: id.into(), worktree_path: Some(wt.into()), session_id: None, inbox_path: None, cursor_path: None, nudge_command: None };
            st.upsert_registry(&row, 1, |a, b| a == b).unwrap();
        }
        let raw = r#"[{"fromBranch":"fix/foo","message":"DONE: fix/foo - r@main@1","createdAt":"2026-01-01T00:00:00Z"},{"fromBranch":"fix/ghost","message":"DONE: fix/ghost - r@main@2","createdAt":"2026-01-01T00:00:01Z"}]"#;
        let done = ingest_payload(&st, &dir, "p", raw, 1).unwrap();
        assert_eq!(done.inserted, 2);
        let rows = st.reader().last_messages("p", 5).unwrap();
        let sender = |needle: &str| rows.iter().find(|m| m["body"].as_str().is_some_and(|b| b.contains(needle))).map(|m| m["sender"].clone());
        assert_eq!(sender("fix/foo"), Some(serde_json::json!("c1")));
        assert_eq!(sender("fix/ghost"), Some(serde_json::Value::Null), "an unregistered branch stays unattributed");
        crate::discard::harmless(std::fs::remove_dir_all(dir)); // keep: test cleanup; an absent directory is the goal state
    }
}
