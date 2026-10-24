//! The mesh group of a workspace: the registry rows that share one worktree (a child that re-registered under a new id, a spawn's
//! label row and the child's own row) are ONE logical recipient, and a read of any of them reads all their partitions. This is the
//! shared half of `inbox read-primary` and `inbox count|tick` over such a group, ported from `resolveMeshPartitionIds`
//! (`send.js`), `siblingAckGate` / `siblingBaseCursor` / the seen watermark (`cursors.js`), `forwardedOrigHashOf`,
//! `consumedDedupSeed` and `foldSiblingGapRows` (`fold.js`):
//!
//! * [`resolve`]: which partitions the group holds;
//! * [`base_cursor`] / [`seen_cursor`]: where a sibling partition's unread starts for this reader;
//! * [`ack_gate`]: whether a sibling is live (or cannot be proven dead), so the caller must NOT move its cursor;
//! * [`Dedup`]: the duplicate check that keeps a message already read in the caller's own partition (or in an earlier sibling)
//!   from being delivered twice, and the gap rule that withholds everything after a row the fold cannot place.
//!
//! Nothing here writes. The writes (the receipt's `sibling` ops and their application) are in `readprimary` and `inbox`.
use crate::defaults;
use crate::mesh::MeshReader;
use crate::meshw::common::Inv;
use crate::meshw::ident::{self, R, Row};
use crate::meshw::send::mesh_candidates;
use crate::meshw::store::mesh_message_hash;
use crate::meshw::{summary, tick};
use serde_json::Value;
use std::collections::HashSet;
use std::path::PathBuf;

/// The partitions of a workspace's mesh group.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Group {
    /// The partition ids, in registry order (just the workspace itself when there is no group).
    pub ids: Vec<String>,
    /// Several rows share the worktree, and the workspace is one of them.
    pub active: bool,
}

/// `resolveMeshPartitionIds(store, id, worktreePath)`: the group is every registry row whose worktree derives to the mesh label of
/// `wt`; with fewer than two, no worktree, or `id` not among them, it is just `id`.
pub fn resolve(rows: &[Row], id: &str, wt: Option<&str>) -> R<Group> {
    let single = Group { ids: vec![id.to_string()], active: false };
    let Some(mesh) = (match wt.filter(|w| !w.is_empty()) {
        Some(w) => ident::canonical_mesh_id(w)?,
        None => None,
    }) else {
        return Ok(single);
    };
    let mut ids: Vec<String> = Vec::new();
    for r in mesh_candidates(rows, Some(mesh.as_str()))? {
        if !ids.contains(&r.id) {
            ids.push(r.id);
        }
    }
    Ok(if ids.len() > 1 && ids.iter().any(|x| x == id) { Group { ids, active: true } } else { single })
}

/// The worktree a read of `id` groups by: its registry row's, else its descriptor's.
pub fn worktree_of(rows: &[Row], id: &str, desc_wt: Option<&str>) -> Option<String> {
    rows.iter()
        .find(|r| r.id == id)
        .and_then(|r| r.worktree_path.clone())
        .filter(|w| !w.is_empty())
        .or_else(|| desc_wt.filter(|w| !w.is_empty()).map(str::to_string))
}

/// `siblingBaseCursor(store, home, pid, reader)`: the store position this reader starts from in a sibling partition.
pub fn base_cursor(inv: &Inv, reader: &MeshReader, pid: &str) -> R<f64> {
    Ok(tick::read_bases(inv, reader, pid, None)?.0)
}

fn seen_path(inv: &Inv, caller: &str, sibling: &str) -> Option<PathBuf> {
    crate::dssup::recon::view::seen_cursor_rel(caller, sibling).map(|rel| inv.home.join(rel))
}

/// `readSiblingSeenCursor(home, caller, sibling)`: how far the caller has SEEN a sibling it may not ack (0 when none).
pub fn seen_cursor(inv: &Inv, caller: &str, sibling: &str) -> f64 {
    seen_path(inv, caller, sibling).map_or(0.0, |p| crate::meshw::cursors::read_cursor(&p))
}

/// `writeSiblingSeenCursor(home, caller, sibling, value)`: raise the watermark; false when it could not be written.
pub fn write_seen_cursor(inv: &Inv, caller: &str, sibling: &str, value: f64) -> bool {
    let Some(p) = seen_path(inv, caller, sibling) else { return false };
    value.is_finite() && value > 0.0 && crate::meshw::cursors::ack_to(&p, value).is_ok()
}

/// `removeSiblingSeenCursor(home, caller, sibling)`.
pub fn remove_seen_cursor(inv: &Inv, caller: &str, sibling: &str) -> bool {
    seen_path(inv, caller, sibling).is_some_and(|p| std::fs::remove_file(p).is_ok())
}

/// `appSessionOnWorktree(home, env, sessionId, worktree)`: the DevSwarm app database maps a Claude session to the worktree it
/// runs in. `Some(true)` the session runs in `worktree`, `Some(false)` in another one; either only when the session's own
/// transcript records that cwd. Anything unproven is `None` (no opinion).
fn app_session_on_worktree(inv: &Inv, session: &str, worktree: &str) -> R<Option<bool>> {
    use crate::dssup::appsync::snap;
    if session.is_empty() || worktree.is_empty() {
        return Ok(None);
    }
    let Some(file) = ident::app_db_path(&inv.home, &inv.env) else { return Ok(None) };
    let Some(sn) = snap::read(&file)? else { return Ok(None) };
    let Some(own) = sn.workspaces.iter().find(|w| w.terminals.iter().any(|t| t.session_id.as_deref() == Some(session))) else { return Ok(None) };
    let Some(own_wt) = own.worktree_path.as_deref().filter(|w| !w.is_empty()) else { return Ok(None) };
    let canon = |p: &str| -> R<String> { Ok(ident::canonical_worktree_real_path(p)?.unwrap_or_else(|| p.to_string())) };
    let (a, b) = (canon(own_wt)?, canon(worktree)?);
    let same = a == b;
    // Claude files the transcript under the cwd as launched: the app's own spelling, then the caller's (same) / the canonical one
    let spellings = [own.worktree_path_raw.clone(), same.then(|| worktree.to_string()), Some(if same { b } else { a })];
    for p in spellings.into_iter().flatten().filter(|p| !p.is_empty()) {
        if snap::transcript_cwd_matches(&inv.home, session, &p)? == Some(true) {
            return Ok(Some(same));
        }
    }
    Ok(None)
}

/// `siblingAckGate(store, callerId, partId, home, now, { cwd, env })`: true when the sibling `part_id` is live (or cannot be shown
/// dead, or is another checkout's), so the caller must not move its cursor. False: the caller may ack it.
pub fn ack_gate(inv: &Inv, rows: &[Row], caller_id: &str, part_id: &str) -> R<bool> {
    let Some(row) = rows.iter().find(|r| r.id == part_id) else { return Ok(true) };
    let now = inv.now as f64;
    // the caller is a declared child standing on the anchor label: the label and the child are one identity
    if let Some(self_id) = ident::declared_self_id(&inv.env, &inv.cwd, rows)? {
        let anchor_id = ident::caller_identity_detailed(&inv.env, &inv.cwd)?.identity;
        let anchor_row = rows.iter().find(|r| r.id == anchor_id);
        let anchor_sid = anchor_row.and_then(|r| r.session_id.clone()).unwrap_or_default();
        let caller_sid = inv.env.get(defaults::text("mesh_write.env_session_id")).cloned().unwrap_or_default();
        let mut ours = anchor_sid.is_empty() || (!caller_sid.is_empty() && anchor_sid == caller_sid);
        if !ours
            && !caller_sid.is_empty()
            && let Some(anchor_row) = anchor_row
        {
            // the app's own record of which worktree the session runs in decides when it is corroborated by the transcript;
            // else the anchor is ours when the caller's session is provably alive and the anchor's recorded one is not
            let wt = anchor_row.worktree_path.as_deref().filter(|w| !w.is_empty()).unwrap_or(&inv.cwd);
            ours = match app_session_on_worktree(inv, &caller_sid, wt)? {
                Some(verdict) => verdict,
                None => crate::dssup::liveness::session_alive(&inv.home, &caller_sid)? && !crate::dssup::liveness::session_alive(&inv.home, &anchor_sid)?,
            };
        }
        let mut names = vec![self_id, anchor_id];
        names.sort();
        names.dedup();
        if ours && names.len() == 2 && names.iter().any(|n| n == caller_id) && names.iter().any(|n| n == part_id) {
            return Ok(false);
        }
    }
    if let Some(caller_row) = rows.iter().find(|r| r.id == caller_id)
        && summary::cross_linked(&caller_row.id, caller_row.session_id.as_deref(), &row.id, row.session_id.as_deref())
    {
        let real = |p: &str| -> R<Option<String>> { Ok(ident::canonical_worktree_real_path(p)?.or_else(|| Some(p.to_string()))) };
        let row_wt = match row.worktree_path.as_deref().filter(|w| !w.is_empty()) {
            Some(w) => real(w)?,
            None => None,
        };
        let caller_wt = if inv.cwd.is_empty() { None } else { real(&inv.cwd)? };
        return Ok(match (row_wt, caller_wt) {
            (Some(a), Some(b)) => a != b, // the same worktree is self; another checkout is not
            _ => false,
        });
    }
    let live = |r: &Row| crate::meshw::rosterrows::sibling_partition_live(inv, now, &r.id, r.worktree_path.as_deref(), r.session_id.as_deref());
    if live(row)? {
        return Ok(true);
    }
    for t in rows.iter().filter(|r| r.id != part_id && summary::cross_linked(&row.id, row.session_id.as_deref(), &r.id, r.session_id.as_deref())) {
        if live(t)? {
            return Ok(true);
        }
    }
    Ok(false)
}

// ---- the duplicate check ------------------------------------------------------------------------------------------------

/// `stripArchivedForwardPrefix(body)`: `[forwarded from archived <id>] ` leaves the id and the original body.
fn strip_forward_prefix(body: &str) -> (Option<String>, &str) {
    let Some(rest) = body.strip_prefix(defaults::text("mesh_write.forward_prefix")) else { return (None, body) };
    match rest.find(']') {
        Some(i) if i > 0 && rest[i + 1..].starts_with(' ') => (Some(rest[..i].to_string()), &rest[i + 2..]),
        _ => (None, body),
    }
}

fn str_of(v: &Value, k: &str) -> Option<String> {
    match &v[k] {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        other => Some(crate::checks::jsport::num::to_js_string(other.as_f64().unwrap_or(f64::NAN))),
    }
}

fn ts_text(v: &Value) -> Option<String> {
    v["ts"].as_f64().map(crate::checks::jsport::num::to_js_string)
}

/// `forwardedOrigHashOf(row)`: the hash of the row a forward carries, else the hash it would have had before the forward.
pub fn forwarded_orig_hash_of(row: &Value) -> Option<String> {
    if let Some(h) = row["origHash"].as_str().filter(|h| !h.is_empty()) {
        return Some(h.to_string());
    }
    let (archived, body) = strip_forward_prefix(row["body"].as_str()?);
    let archived = archived?;
    Some(mesh_message_hash(
        str_of(row, "sender").as_deref(),
        Some(&archived),
        defaults::text("mesh_write.mtype_direct"),
        &str_of(row, "urgency").unwrap_or_default(),
        body,
        &ts_text(row).unwrap_or_default(),
        row["needsReply"].as_bool().unwrap_or(false),
    ))
}

/// `logicalDeliveryKey(row)`: sender, time and un-forwarded body; `None` when all three are empty.
fn logical_key(row: &Value) -> Option<String> {
    let from = str_of(row, "sender").unwrap_or_default();
    let ts = ts_text(row).unwrap_or_default();
    let body = strip_forward_prefix(row["body"].as_str().unwrap_or("")).1.to_string();
    (!(from.is_empty() && ts.is_empty() && body.is_empty())).then(|| format!("{from}\0{ts}\0{body}"))
}

/// `isForwardableRow(msg)`: a direct, non-heartbeat row with a sender and a recipient.
pub fn is_forwardable(row: &Value) -> bool {
    !row["isHeartbeat"].as_bool().unwrap_or(false)
        && row["mtype"].as_str() == Some(defaults::text("mesh_write.mtype_direct"))
        && row["sender"].as_str().is_some_and(|s| !crate::checks::guardkit::text::js_trim(s).is_empty())
        && row["recipient"].as_str().is_some_and(|s| !crate::checks::guardkit::text::js_trim(s).is_empty())
}

/// What `foldSiblingGapRows` made of one sibling partition's unread rows.
#[derive(Debug, Clone, Default)]
pub struct Folded {
    /// The rows to deliver (not seen before, before the first row the fold cannot place).
    pub delivered: Vec<Value>,
    /// Where each delivered row stood in the partition's unread list (the read's cap bookkeeping needs it).
    pub delivered_idx: Vec<usize>,
    /// Rows withheld because an earlier row ended the deliverable prefix (never lost: the cursor never passes them).
    pub gap_withheld: usize,
    /// How many physical rows the ack may pass: delivered, already-seen, and logically duplicate ones, up to the gap.
    pub consumed_count: f64,
    /// `consumed_through[i]`: the physical rows consumed once the first `i + 1` delivered rows are.
    pub consumed_through: Vec<f64>,
}

/// The hashes and logical keys already delivered (or already read) in this group.
pub struct Dedup {
    hashes: HashSet<String>,
    logical: HashSet<String>,
}

impl Dedup {
    /// `consumedDedupSeed(store, id, cursor, cap)`: the newest `cap` rows of the caller's own partition below its read position.
    ///
    /// A store read that fails gives an EMPTY seed, as Node's `try { rows = s.listMessages(id) || []; } catch (_) { return out; }`
    /// does (`devswarm-lib/fold.js` `consumedDedupSeed`): a seed is only a dedup hint, so an unreadable history dedups less, never loses a row.
    pub fn seed(reader: &MeshReader, id: &str, cursor: f64) -> R<Dedup> {
        let mut d = Dedup { hashes: HashSet::new(), logical: HashSet::new() };
        let c = if cursor.is_finite() && cursor > 0.0 { cursor.floor() as u64 } else { 0 };
        if c == 0 {
            return Ok(d);
        }
        let Ok(total) = reader.message_count(id) else { return Ok(d) };
        let end = c.min(total);
        let start = end.saturating_sub(defaults::num("mesh_write.consumed_hash_seed_cap") as u64);
        let mut seen = start;
        let read = reader.for_each_message(id, start, |row| {
            if seen >= end {
                return false;
            }
            seen += 1;
            if let Some(h) = row["hash"].as_str().filter(|h| !h.is_empty()) {
                d.hashes.insert(h.to_string());
            }
            if let Some(oh) = forwarded_orig_hash_of(&row) {
                d.hashes.insert(oh);
            }
            if let Some(k) = logical_key(&row) {
                d.logical.insert(k);
            }
            true
        });
        if read.is_err() {
            d = Dedup { hashes: HashSet::new(), logical: HashSet::new() }; // Node returns the empty seed, not a partial one
        }
        Ok(d)
    }

    /// The rows the caller is about to be shown from its own partition count as seen (their hashes, not their logical keys).
    pub fn note_shown(&mut self, row: &Value) {
        if let Some(h) = row["hash"].as_str().filter(|h| !h.is_empty()) {
            self.hashes.insert(h.to_string());
        }
        if let Some(oh) = forwarded_orig_hash_of(row) {
            self.hashes.insert(oh);
        }
    }

    /// `foldSiblingGapRows(rows, seenHashes, seenLogical)` for one sibling partition's unread rows, oldest first.
    pub fn fold(&mut self, inv: &Inv, rows: Vec<Value>) -> Folded {
        let mut out = Folded::default();
        let mut gap_seen = false;
        for (pos, row) in rows.into_iter().enumerate() {
            let was_gap = gap_seen;
            let orig = forwarded_orig_hash_of(&row);
            let hash = row["hash"].as_str().filter(|h| !h.is_empty()).map(str::to_string);
            if hash.as_ref().is_some_and(|h| self.hashes.contains(h)) || orig.as_ref().is_some_and(|h| self.hashes.contains(h)) {
                if !was_gap {
                    out.consumed_count += 1.0; // a physical row was resolved here even though nothing was delivered
                }
                continue;
            }
            if was_gap {
                out.gap_withheld += 1; // an ambiguous suffix: withheld, never lost
                continue;
            }
            let key = logical_key(&row);
            if let Some(k) = &key
                && self.logical.contains(k)
            {
                out.consumed_count += 1.0;
                crate::meshw::clog::event(
                    inv,
                    defaults::text("mesh_write.log_op_sibling_dup"),
                    defaults::text("mesh_write.msg_sibling_dup"),
                    vec![
                        ("reason", crate::checks::guardkit::ojson::OVal::Str(defaults::text("mesh_write.reason_logical_dup").to_string())),
                        (
                            "from",
                            row["sender"]
                                .as_str()
                                .map_or(crate::checks::guardkit::ojson::OVal::Null, |s| crate::checks::guardkit::ojson::OVal::Str(s.to_string())),
                        ),
                        ("ts", row["ts"].as_f64().map_or(crate::checks::guardkit::ojson::OVal::Null, crate::checks::guardkit::ojson::OVal::Num)),
                    ],
                );
                continue;
            }
            if !is_forwardable(&row) {
                gap_seen = true; // delivered now, but it ends this window's deliverable prefix
            }
            if let Some(h) = hash {
                self.hashes.insert(h);
            }
            if let Some(h) = orig {
                self.hashes.insert(h);
            }
            if let Some(k) = key {
                self.logical.insert(k);
            }
            out.consumed_count += 1.0;
            out.delivered.push(row);
            out.delivered_idx.push(pos);
            out.consumed_through.push(out.consumed_count);
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn inv() -> Inv {
        let home = std::env::temp_dir().join(format!("ah-meshgroup-{}", std::process::id()));
        crate::discard::harmless(std::fs::create_dir_all(&home)); // keep: the dedup log write below reports nothing either way
        Inv { home: home.clone(), write_home: home, env: Default::default(), cwd: "/".into(), now: 1, stdin: None, store_override: None }
    }

    fn row(hash: &str, sender: &str, ts: f64, body: &str) -> Value {
        json!({"hash": hash, "sender": sender, "recipient": "me", "mtype": "direct", "isHeartbeat": false, "ts": ts, "body": body, "urgency": "normal", "needsReply": false, "origHash": null})
    }

    /// Node's `consumedDedupSeed` returns the empty seed when the store read throws; it never hands the verb to Node.
    #[test]
    fn an_unreadable_store_gives_an_empty_seed_not_a_deferral() {
        let reader = MeshReader::from_conn(rusqlite::Connection::open_in_memory().unwrap()); // no tables: every read fails
        assert!(reader.message_count("w1").is_err());
        let d = Dedup::seed(&reader, "w1", 5.0).expect("an unreadable history is an empty seed");
        assert!(d.hashes.is_empty() && d.logical.is_empty());
    }

    #[test]
    fn a_forward_prefix_is_stripped_only_when_whole() {
        assert_eq!(strip_forward_prefix("[forwarded from archived abc] hi"), (Some("abc".into()), "hi"));
        assert_eq!(strip_forward_prefix("[forwarded from archived ] hi"), (None, "[forwarded from archived ] hi"));
        assert_eq!(strip_forward_prefix("[forwarded from archived abc]hi"), (None, "[forwarded from archived abc]hi"));
        assert_eq!(strip_forward_prefix("plain"), (None, "plain"));
    }

    #[test]
    fn a_forwarded_row_names_the_hash_the_original_had() {
        let fwd = json!({"hash": "mesh:f", "sender": "a", "ts": 5.0, "urgency": "normal", "needsReply": false, "body": "[forwarded from archived old-ws] hello", "origHash": null});
        let expect = mesh_message_hash(Some("a"), Some("old-ws"), "direct", "normal", "hello", "5", false);
        assert_eq!(forwarded_orig_hash_of(&fwd), Some(expect));
        let marked = json!({"origHash": "mesh:orig", "body": "x"});
        assert_eq!(forwarded_orig_hash_of(&marked), Some("mesh:orig".into()));
    }

    /// The fold delivers the unseen rows, passes the seen ones, and a row it cannot place (a heartbeat) ends the prefix: what follows
    /// is withheld, not lost.
    #[test]
    fn the_fold_dedups_consumes_and_stops_at_a_gap() {
        let mut d = Dedup { hashes: HashSet::from(["h-seen".to_string()]), logical: HashSet::new() };
        let mut hb = row("h-hb", "a", 3.0, "beat");
        hb["isHeartbeat"] = json!(true);
        let rows = vec![row("h-seen", "a", 1.0, "old"), row("h-new", "a", 2.0, "new"), hb, row("h-after", "a", 4.0, "after")];
        let f = d.fold(&inv(), rows);
        assert_eq!(f.delivered.iter().map(|r| r["hash"].as_str().unwrap()).collect::<Vec<_>>(), vec!["h-new", "h-hb"]);
        assert_eq!((f.gap_withheld, f.consumed_count, f.consumed_through), (1, 3.0, vec![2.0, 3.0]));
    }

    #[test]
    fn a_weak_key_duplicate_is_consumed_but_not_delivered() {
        let mut d = Dedup { hashes: HashSet::new(), logical: HashSet::new() };
        d.logical.insert(logical_key(&row("x", "a", 7.0, "same")).unwrap());
        let f = d.fold(&inv(), vec![row("y", "a", 7.0, "same"), row("z", "a", 8.0, "other")]);
        assert_eq!((f.delivered.len(), f.consumed_count), (1, 2.0));
    }

    #[test]
    fn two_rows_of_one_worktree_are_a_group_and_a_lone_row_is_not() {
        let dir = std::env::temp_dir().join(format!("ah-meshgroup-wt-{}", std::process::id()));
        crate::discard::harmless(std::fs::create_dir_all(&dir)); // keep: the git init below reports a missing directory
        let st = std::process::Command::new("git").current_dir(&dir).args(["init", "-q", "-b", "main"]).status().unwrap();
        assert!(st.success());
        let wt = dir.canonicalize().unwrap().to_string_lossy().into_owned();
        let row_of = |id: &str| Row { id: id.into(), worktree_path: Some(wt.clone()), session_id: None, updated_at: None };
        let g = resolve(&[row_of("a"), row_of("b")], "b", Some(&wt)).unwrap();
        assert_eq!((g.ids.as_slice(), g.active), (["a".to_string(), "b".to_string()].as_slice(), true));
        assert!(!resolve(&[row_of("a")], "a", Some(&wt)).unwrap().active);
        assert!(!resolve(&[row_of("a"), row_of("b")], "c", Some(&wt)).unwrap().active, "an id outside the group does not widen");
        assert!(!resolve(&[row_of("a"), row_of("b")], "a", None).unwrap().active);
    }
}
