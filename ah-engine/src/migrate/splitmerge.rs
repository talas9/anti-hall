//! `mergeSplitBackendStoresAllStores` (`companion/lib/devswarm-store.js`): a sqlite store whose `journal/` directory also holds
//! `.ndjson` segments is SPLIT (the legacy journal backend of Node older than 22.5 wrote there before the store was pinned to
//! sqlite). The journal side is read, never written; its messages and registry rows that the sqlite side lacks are folded into
//! sqlite; neither physical form is deleted, renamed or truncated, and a second run finds nothing to do.
//!
//! * Messages: a row is skipped when its hash (or, for a row without one, its partition, time, sender, recipient, type and body)
//!   already exists on the sqlite side; every other row is appended (it lands UNREAD there by design: the two sides number their
//!   rows independently, so cursors are NEVER copied across them).
//! * Registry: a row the sqlite side lacks is added; a row on both sides is replaced only when the journal copy is strictly newer
//!   (`updatedAt`, else the upsert count).
//! * The store's summary is re-derived and a `MERGE-STATE.json` marker records what was merged.
//!
//! The journal side is read with the reduction the journal backend uses (`reduceRegistry`: the latest operation per id wins, a
//! conditional remove tombstones only a row that still matches its snapshot). A store whose journal side is the ONLY side (the
//! journal backend proper) is not read at all: it is legacy and reported by the doctor.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an unreadable or torn journal line is skipped (Node: `try { out.push(JSON.parse(line)) } catch (_) { torn += 1 }`)
// - the summary re-derive and the marker are best-effort (Node: "fail-open: the merge itself already succeeded and is durable")
use super::poststages::Tally;
use super::readercur as rc;
use crate::checks::guardkit::ojson::OVal;
use crate::checks::guardkit::text::js_trim;
use crate::checks::jsport::num::to_js_string;
use crate::defaults;
use crate::dssup::recon::view;
use crate::meshw::common::Inv;
use crate::meshw::store::{MeshRow, RegistryRow};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

/// One journal file's lines that parse, in file order.
fn read_all(path: &Path) -> Vec<OVal> {
    let Ok(bytes) = std::fs::read(path) else { return Vec::new() };
    String::from_utf8_lossy(&bytes).split('\n').map(js_trim).filter(|l| !l.is_empty()).filter_map(OVal::parse).collect()
}

fn text(v: Option<&OVal>) -> Option<String> {
    match v {
        None | Some(OVal::Null) => None,
        Some(OVal::Str(s)) => Some(s.clone()),
        Some(OVal::Num(n)) => Some(to_js_string(*n)),
        Some(OVal::Bool(b)) => Some(b.to_string()),
        Some(other) => Some(other.stringify()),
    }
}

fn finite(v: Option<&OVal>) -> Option<f64> {
    match v {
        Some(OVal::Num(n)) if n.is_finite() => Some(*n),
        _ => None,
    }
}

fn flag(v: Option<&OVal>) -> bool {
    v.is_some_and(OVal::truthy)
}

/// The read-only view of a store's `journal/` directory.
struct Journal {
    dir: PathBuf,
}

/// A registry row as the journal's reduction leaves it.
struct JReg {
    row: RegistryRow,
    updated_at: Option<f64>,
    write_seq: Option<f64>,
}

impl Journal {
    fn file(&self, key: &str) -> PathBuf {
        self.dir.join(defaults::text(key))
    }

    /// `listWorkspaceIds()`: every partition any journal file names.
    fn workspace_ids(&self) -> Vec<String> {
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        let mut add = |id: Option<String>| {
            if let Some(id) = id
                && seen.insert(id.clone())
            {
                out.push(id);
            }
        };
        for r in read_all(&self.file("update_post.journal_messages")) {
            add(text(r.get("workspaceId")));
        }
        for r in read_all(&self.file("update_post.journal_registry")) {
            add(text(r.get("id")));
        }
        for r in read_all(&self.file("update_post.journal_cursors")) {
            add(text(r.get("workspaceId")));
        }
        for r in read_all(&self.file("update_post.journal_gates")) {
            add(text(r.get("workspaceId")));
        }
        out
    }

    /// `listMessages(id)`: the partition's rows in file order, a repeated hash read once.
    fn messages(&self, id: &str) -> Vec<MeshRow> {
        let mut seen: HashSet<String> = HashSet::new();
        let mut out = Vec::new();
        for r in read_all(&self.file("update_post.journal_messages")) {
            if text(r.get("workspaceId")).as_deref() != Some(id) {
                continue;
            }
            let hash = text(r.get("hash"));
            if let Some(h) = &hash
                && !seen.insert(h.clone())
            {
                continue;
            }
            out.push(MeshRow {
                workspace_id: id.to_string(),
                ts: finite(r.get("ts")).map_or(-1, |t| t.floor() as i64),
                hash,
                body: text(r.get("body")).unwrap_or_default(),
                sender: text(r.get("sender")),
                recipient: text(r.get("recipient")),
                mtype: text(r.get("mtype")),
                urgency: text(r.get("urgency")),
                is_heartbeat: flag(r.get("isHeartbeat")),
                needs_reply: flag(r.get("needsReply")),
                orig_hash: text(r.get("origHash")),
                instance_nonce: text(r.get("instanceNonce")),
            });
            // a row without a finite time is kept with `-1`; the caller stamps it with the clock
            if finite(r.get("ts")).is_none()
                && let Some(last) = out.last_mut()
            {
                last.ts = -1;
            }
        }
        out
    }

    /// `reduceRegistry()`: the current descriptor set. The latest operation per id wins; an unconditional remove tombstones; a
    /// conditional remove (`ifUpdatedAt` / `ifSessionId` / `ifWriteSeq`) tombstones only a surviving upsert that still matches the
    /// snapshot it was written against, so a live re-register that raced the tombstone survives.
    fn registry(&self) -> Vec<JReg> {
        let mut latest: Vec<(String, Option<OVal>)> = Vec::new(); // None = tombstone
        let mut write_seq: HashMap<String, f64> = HashMap::new();
        let set = |latest: &mut Vec<(String, Option<OVal>)>, id: &str, v: Option<OVal>| match latest.iter_mut().find(|(k, _)| k == id) {
            Some(slot) => slot.1 = v,
            None => latest.push((id.to_string(), v)),
        };
        for row in read_all(&self.file("update_post.journal_registry")) {
            let Some(id) = text(row.get("id")) else { continue };
            let op = text(row.get("_op"));
            let conditional = op.as_deref() == Some("remove") && (row.get("ifUpdatedAt").is_some() || row.get("ifSessionId").is_some());
            if conditional {
                let prev = latest.iter().find(|(k, _)| *k == id).and_then(|(_, v)| v.as_ref());
                let prev_upd = prev.and_then(|p| finite(p.get("updatedAt")));
                let prev_sess = prev.and_then(|p| text(p.get("sessionId"))).filter(|s| !s.is_empty());
                let prev_ws = prev.and_then(|_| write_seq.get(&id).copied());
                let if_upd = match row.get("ifUpdatedAt") {
                    None | Some(OVal::Null) => None,
                    Some(v) => finite(Some(v)),
                };
                let if_sess = match row.get("ifSessionId") {
                    None | Some(OVal::Null) => None,
                    Some(v) => text(Some(v)),
                };
                let ws_ok = match row.get("ifWriteSeq") {
                    None => true,
                    Some(OVal::Null) => prev_ws.is_none(),
                    Some(v) => prev_ws == finite(Some(v)),
                };
                if prev.is_some() && prev_upd == if_upd && prev_sess == if_sess && ws_ok {
                    set(&mut latest, &id, None);
                }
                continue;
            }
            if op.as_deref() == Some("upsert") {
                *write_seq.entry(id.clone()).or_insert(0.0) += 1.0;
            }
            let removed = op.as_deref() == Some("remove");
            set(&mut latest, &id, if removed { None } else { Some(row) });
        }
        latest
            .into_iter()
            .filter_map(|(id, v)| {
                let r = v?;
                let nudge = match r.get("nudgeCommand") {
                    None | Some(OVal::Null) => None,
                    Some(v) => Some(v.stringify()),
                };
                let nonempty = |k: &str| text(r.get(k)).filter(|s| !s.is_empty());
                Some(JReg {
                    row: RegistryRow {
                        id: id.clone(),
                        worktree_path: nonempty("worktreePath"),
                        session_id: nonempty("sessionId"),
                        inbox_path: nonempty("inboxPath"),
                        cursor_path: nonempty("cursorPath"),
                        nudge_command: nudge,
                    },
                    updated_at: finite(r.get("updatedAt")),
                    write_seq: write_seq.get(&id).copied(),
                })
            })
            .collect()
    }
}

/// `nullHashDedupeKey(row)`: the identity of a row without a hash (`null` joins as the empty string).
fn null_key(id: &str, ts: Option<i64>, m: &MeshRow) -> String {
    let t = |v: &Option<String>| v.clone().unwrap_or_default();
    [id.to_string(), ts.map(|t| t.to_string()).unwrap_or_default(), t(&m.sender), t(&m.recipient), t(&m.mtype), m.body.clone()].join("\u{0}")
}

/// What one store came to.
#[derive(Default)]
struct StoreResult {
    split: bool,
    ok: bool,
    pending: bool,
    messages_merged: f64,
    registry_merged: f64,
}

/// `mergeSplitBackendStore(home, hash, { dryRun: false })` for a store whose chosen side is sqlite.
fn merge_store(ctx: &super::Ctx, hash: &str, now: i64) -> StoreResult {
    merge_store_with(ctx, hash, now, false)
}

/// `mergeSplitBackendStore(home, hash, { dryRun: true })` reduced to what the retention fold asks: `Some(pending)` for a store whose
/// merge could be checked (`pending`: the journal side holds a message or registry row the sqlite side lacks), `None` when it could not
/// (the store cannot be opened). Nothing is written: no row, no summary, no marker.
pub(crate) fn merge_pending(ctx: &super::Ctx, hash: &str, now: i64) -> Option<bool> {
    let r = merge_store_with(ctx, hash, now, true);
    r.ok.then_some(r.pending)
}

/// [`merge_pending`] for a store in `home`, with a throwaway context (the retention fold has none of the migration's).
pub fn merge_pending_at(home: &Path, hash: &str) -> Option<bool> {
    let ctx = super::Ctx::new(home.to_string_lossy().into_owned(), String::new(), std::collections::BTreeMap::new(), false, None, None);
    merge_pending(&ctx, hash, crate::health::now_ms() as i64)
}

fn merge_store_with(ctx: &super::Ctx, hash: &str, now: i64, dry: bool) -> StoreResult {
    let home = Path::new(&ctx.home);
    let dir = rc::store_dir(home, hash);
    let jdir = dir.join(defaults::text("update_post.journal_dir"));
    let split =
        std::fs::read_dir(&jdir).is_ok_and(|rd| rd.flatten().any(|e| e.file_name().to_string_lossy().ends_with(defaults::text("mesh_write.ndjson_suffix"))));
    let mut out = StoreResult { split, ok: true, ..StoreResult::default() };
    if !split {
        return out;
    }
    let journal = Journal { dir: jdir };
    let chosen = match rc::open(home, hash, dry) {
        Ok(h) => h,
        Err(e) => {
            super::poststages::swallowed(ctx, "merge-split-backend-stores", hash, &e);
            out.ok = false;
            out.pending = true;
            return out;
        }
    };
    let (mut only_in_other, mut registry_merged, mut merged) = (0u64, 0u64, 0u64);
    let result = (|| -> Result<(), String> {
        let st = if dry { None } else { Some(chosen.rw()?) };
        let mut ids: Vec<String> = journal.workspace_ids();
        for id in chosen.rd().workspace_ids() {
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
        for id in &ids {
            let other = journal.messages(id);
            if other.is_empty() {
                continue;
            }
            let mut seen_hash: HashSet<String> = HashSet::new();
            let mut seen_null: HashSet<String> = HashSet::new();
            for m in view::messages_of(chosen.rd(), id).map_err(|d| d.0)? {
                match &m.hash {
                    Some(h) => {
                        seen_hash.insert(h.clone());
                    }
                    None => {
                        let row = MeshRow {
                            sender: m.sender.clone(),
                            recipient: m.recipient.clone(),
                            mtype: m.mtype.clone(),
                            body: m.body.clone(),
                            ..MeshRow::default()
                        };
                        seen_null.insert(null_key(id, Some(m.ts), &row));
                    }
                }
            }
            for mut row in other {
                let ts = (row.ts >= 0).then_some(row.ts);
                let key = null_key(id, ts, &row);
                let dup = match &row.hash {
                    Some(h) => seen_hash.contains(h),
                    None => seen_null.contains(&key),
                };
                if dup {
                    continue;
                }
                only_in_other += 1;
                if row.ts < 0 {
                    row.ts = now;
                }
                if let Some(st) = st
                    && st.append_mesh_row(&row).map_err(|e| e.to_string())?.inserted
                {
                    merged += 1;
                }
                match &row.hash {
                    Some(h) => {
                        seen_hash.insert(h.clone());
                    }
                    None => {
                        seen_null.insert(key);
                    }
                }
            }
        }
        // the registry: a union; a row on both sides keeps the sqlite side's unless the journal copy is strictly newer
        let existing: HashMap<String, crate::dssup::recon::RegRow> =
            view::registry(home, hash).map_err(|d| d.0)?.into_iter().map(|r| (r.row.id.clone(), r)).collect();
        for d in journal.registry() {
            match existing.get(&d.row.id) {
                None => {
                    registry_merged += 1;
                    if let Some(st) = st {
                        st.upsert_registry(&d.row, now, |_, _| false).map_err(|e| e.to_string())?;
                    }
                }
                Some(e) => {
                    let newer = d.updated_at.unwrap_or(-1.0) > e.updated_at.map_or(-1.0, |u| u as f64)
                        || matches!((d.write_seq, e.write_seq), (Some(a), Some(b)) if a > b as f64);
                    if newer {
                        registry_merged += 1;
                        if let Some(st) = st {
                            st.upsert_registry(&d.row, now, |_, _| true).map_err(|e| e.to_string())?;
                        }
                    }
                }
            }
        }
        Ok(())
    })();
    out.messages_merged = merged as f64;
    out.registry_merged = registry_merged as f64;
    if let Err(e) = result {
        super::poststages::swallowed(ctx, "merge-split-backend-stores", hash, &e);
        out.ok = false;
    }
    out.pending = only_in_other > 0 || registry_merged > 0;
    if out.ok && !dry {
        // the summary reflects the merged rows at once, and the marker records what happened; both are best-effort (the merge itself is durable)
        let inv = Inv {
            home: home.to_path_buf(),
            env: ctx.env.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
            cwd: ctx.cwd.clone(),
            now,
            stdin: None,
            write_home: home.to_path_buf(),
            store_override: None,
        };
        if let Ok(st) = chosen.rw()
            && let Some(why) = crate::meshw::summary::derive_after_write(st, &inv, hash)
        {
            ctx.note(why);
        }
        let marker = OVal::Obj(vec![
            ("mergedAt".into(), OVal::Num(now as f64)),
            ("fromBackend".into(), OVal::Str(defaults::text("mesh_write.backend_journal").into())),
            ("intoBackend".into(), OVal::Str(defaults::text("mesh.backend_sqlite").into())),
            ("messagesMerged".into(), OVal::Num(out.messages_merged)),
            ("registryMerged".into(), OVal::Num(out.registry_merged)),
            ("cursorsAdvanced".into(), OVal::Num(0.0)),
            ("broadcastCursorsAdvanced".into(), OVal::Num(0.0)),
            ("readerCursorRowsMerged".into(), OVal::Num(0.0)),
        ]);
        crate::discard::logged("update_post_merge_marker", crate::atomic::write(dir.join(defaults::text("update_post.merge_marker")), marker.stringify()));
    }
    out
}

/// `mergeSplitBackendStoresAllStores(home)`: the counts across every store. `all` is every store directory (the count Node reports as
/// `stores`), `openable` the ones the engine can open as sqlite (a journal-backend store is legacy: it is not read).
pub(crate) fn merge_all(ctx: &super::Ctx, all: usize, openable: &[String]) -> Tally {
    let now = crate::health::now_ms() as i64;
    let mut t = Tally::default();
    t.set("stores", all as f64);
    for hash in openable {
        let r = merge_store(ctx, hash, now);
        if r.split {
            t.add("splitStores", 1.0);
        }
        if !r.ok {
            t.add("errors", 1.0);
        }
        t.add("messagesMerged", r.messages_merged);
        t.add("registryMerged", r.registry_merged);
        t.add("reDeliveredUnread", r.messages_merged);
    }
    t
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::meshw::store::MeshStore;

    fn write(p: &Path, text: &str) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }

    #[test]
    fn migrate_split_merge_folds_the_journal_side_into_sqlite_once_and_deletes_nothing() {
        crate::defaults::init().unwrap();
        let dir = crate::db::TempDir::new("split-merge");
        let home = dir.0.join("home");
        let hash = "abcd1234abcd1234";
        let store = rc::store_dir(&home, hash);
        // the sqlite side: one message the journal also has (by hash), one registry row older than the journal's copy
        {
            let st = MeshStore::open(&store.join(defaults::text("mesh_write.store_file"))).unwrap();
            let row = |h: &str, body: &str| MeshRow { workspace_id: "w1".into(), ts: 1000, hash: Some(h.into()), body: body.into(), ..MeshRow::default() };
            assert!(st.append_mesh_row(&row("h1", "A")).unwrap().inserted);
            st.upsert_registry(
                &RegistryRow { id: "w1".into(), worktree_path: Some("/wt/1".into()), session_id: Some("old".into()), ..RegistryRow::default() },
                5,
                |_, _| true,
            )
            .unwrap();
        }
        write(&store.join(defaults::text("mesh.backend_marker")), "sqlite\n");
        let journal = store.join(defaults::text("update_post.journal_dir"));
        let messages = concat!(
            "{\"workspaceId\":\"w1\",\"ts\":1000,\"hash\":\"h1\",\"body\":\"A\"}\n",
            "{\"workspaceId\":\"w1\",\"ts\":2000,\"hash\":\"h2\",\"body\":\"B\",\"sender\":\"s\",\"recipient\":\"w1\",\"mtype\":\"direct\",\"needsReply\":true}\n",
            "{\"workspaceId\":\"w1\",\"ts\":3000,\"hash\":null,\"body\":\"C\"}\n",
            "{\"workspaceId\":\"w1\",\"ts\":2000,\"hash\":\"h2\",\"body\":\"B\"}\n",
            "{\"workspaceId\":\"w1\"\n",
        );
        let registry = concat!(
            "{\"_op\":\"upsert\",\"id\":\"w1\",\"worktreePath\":\"/wt/1\",\"sessionId\":\"s1\",\"updatedAt\":10}\n",
            "{\"_op\":\"upsert\",\"id\":\"w2\",\"worktreePath\":\"/wt/2\",\"sessionId\":\"s2\",\"updatedAt\":20}\n",
            "{\"_op\":\"remove\",\"id\":\"w2\"}\n",
            "{\"_op\":\"upsert\",\"id\":\"w3\",\"worktreePath\":\"/wt/3\",\"updatedAt\":30}\n",
        );
        write(&journal.join(defaults::text("update_post.journal_messages")), messages);
        write(&journal.join(defaults::text("update_post.journal_registry")), registry);
        let ctx = super::super::Ctx::new(home.to_string_lossy().into_owned(), String::new(), std::collections::BTreeMap::new(), false, None, None);
        let t = merge_all(&ctx, 1, &[hash.to_string()]);
        let n = |k: &str| t.n.get(k).copied().unwrap_or(0.0);
        assert_eq!((n("stores"), n("splitStores"), n("messagesMerged"), n("registryMerged"), n("errors")), (1.0, 1.0, 2.0, 2.0, 0.0), "{:?}", t.n);
        assert_eq!(n("reDeliveredUnread"), 2.0);
        let rd = rc::open(&home, hash, true).unwrap();
        let bodies: Vec<String> = view::messages_of(rd.rd(), "w1").unwrap().into_iter().map(|m| m.body).collect();
        assert_eq!(bodies, ["A", "B", "C"]);
        let rows = view::registry(&home, hash).unwrap();
        let ids: Vec<(&str, Option<&str>)> = rows.iter().map(|r| (r.row.id.as_str(), r.row.session_id.as_deref())).collect();
        assert_eq!(ids, [("w1", Some("s1")), ("w3", None)], "the removed row is not merged, the newer journal row replaced the older one");
        // neither physical form was touched, and the marker records the merge
        assert_eq!(std::fs::read_to_string(journal.join(defaults::text("update_post.journal_messages"))).unwrap(), messages);
        assert_eq!(std::fs::read_to_string(journal.join(defaults::text("update_post.journal_registry"))).unwrap(), registry);
        let marker = std::fs::read_to_string(store.join(defaults::text("update_post.merge_marker"))).unwrap();
        assert!(marker.contains("\"messagesMerged\":2") && marker.contains("\"fromBackend\":\"journal\""), "{marker}");
        // a second run finds nothing left to do
        let again = merge_all(&ctx, 1, &[hash.to_string()]);
        let m = |k: &str| again.n.get(k).copied().unwrap_or(0.0);
        assert_eq!((m("splitStores"), m("messagesMerged"), m("registryMerged"), m("errors")), (1.0, 0.0, 0.0, 0.0), "{:?}", again.n);
        assert_eq!(view::messages_of(rd.rd(), "w1").unwrap().len(), 3);
    }
}
