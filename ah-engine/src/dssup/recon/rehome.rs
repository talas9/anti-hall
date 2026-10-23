//! The store re-home (`scripts/devswarm-lib/fold.js`: `rehomeAcrossStores`, `rehomeCore`, `rehomeMiskeyedRow`,
//! `repairRootMappedChildRows`; `repair.js`: `rehomeStrandedProjectDescriptors`).
//!
//! A workspace registered while its repository key was unknown lands in the legacy hash bucket `store/<hash(id)>/`, a store the
//! Primary's reads never open. The re-home moves the registry row, the UNREAD tail of the id's own partition and the descriptor's
//! ownership into `store/<repoKey>/`. It is copy-before-tombstone and never deletes a message:
//!
//! * everything runs under the id's lock; the source's unread tail and cursor floor are read COMPLETELY before anything is written
//!   (an unreadable cursor table or message table leaves the source authoritative and nothing moved);
//! * the destination registry row goes in through the same id-collision guard every upsert has (a DIFFERENT non-null worktree
//!   already there skips the write and the move reports a conflict instead of tombstoning the source);
//! * the copied rows are appended with hash-dedupe (a re-run adds nothing), then the copy is VERIFIED (every hash present, the
//!   destination row carries the path and session that were written) before the source registry row is removed;
//! * only the registry row of the source is ever removed, and only after that verification; both summaries are re-derived and the
//!   descriptor's `ownerKey` follows.
//!
//! A store on the legacy journal backend (Node older than 22.5) is not read: the move reports `legacy-journal-store` and changes
//! nothing.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an unreadable optional descriptor or store is the absent one (Node: `try { ... } catch (_) { x = null }`)
// - the summary re-derive is best-effort (Node: `try { store.deriveSummary(...) } catch (_) {}`)
use super::view::{self, Msg, descriptor_rel};
use crate::checks::guardkit::ojson::OVal;
use crate::defaults;
use crate::dssup::tick::Ctx;
use crate::meshw::common::Inv;
use crate::meshw::cursors;
use crate::meshw::ident::{self, read_descriptor, repo_key_for_worktree};
use crate::meshw::idlock::{self, is_safe_id};
use crate::meshw::store::{MeshRow, MeshStore, RegistryRow};
use crate::migrate::readercur as rc;
use serde_json::{Value, json};
use std::collections::HashSet;
use std::path::Path;

/// What one move came to (Node's `{rehomed, movedMessages, movedRegistry, reason?, regConflict?}`).
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Moved {
    /// The registry row and the unread tail are in the destination, verified.
    pub rehomed: bool,
    /// Rows copied.
    pub moved_messages: usize,
    /// The source's registry row was tombstoned (it came from the source store, not seeded from a descriptor).
    pub moved_registry: bool,
    /// Why nothing moved.
    pub reason: Option<String>,
    /// The destination already has a row for the id that does not match: the source was kept.
    pub reg_conflict: bool,
}

fn inv_of(ctx: &Ctx) -> Inv {
    Inv {
        home: ctx.home.to_path_buf(),
        env: ctx.st.env.clone(),
        cwd: String::new(),
        now: ctx.now,
        stdin: None,
        write_home: ctx.home.to_path_buf(),
        store_override: None,
    }
}

fn reason(out: &mut Moved, key: &str) {
    out.reason = Some(defaults::text(key).to_string());
}

/// `openStore({ home, hash })` for a store the engine can open: sqlite (pinned by its marker, or by a non-empty database), a new store
/// (marked sqlite, as Node's open does). A journal store is `Err(legacy)`.
pub(super) fn open_store(home: &Path, key: &str) -> Result<MeshStore, String> {
    let dir = rc::store_dir(home, key);
    let marker_file = dir.join(defaults::text("mesh.backend_marker"));
    let marker = std::fs::read_to_string(&marker_file).map(|s| s.trim().to_lowercase()).unwrap_or_default();
    let sqlite = defaults::text("mesh.backend_sqlite");
    if marker == defaults::text("mesh_write.backend_journal") {
        return Err(defaults::text("devswarm_recon.reason_legacy_store").to_string());
    }
    if marker != sqlite {
        let has_db = std::fs::metadata(dir.join(defaults::text("mesh_write.store_file"))).is_ok_and(|m| m.len() > 0);
        let has_journal = std::fs::read_dir(dir.join(defaults::text("update_post.journal_dir")))
            .is_ok_and(|rd| rd.flatten().any(|e| e.file_name().to_string_lossy().ends_with(defaults::text("mesh_write.ndjson_suffix"))));
        if !has_db && has_journal {
            return Err(defaults::text("devswarm_recon.reason_legacy_store").to_string());
        }
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        crate::atomic::write(&marker_file, sqlite).map_err(|e| e.to_string())?;
    }
    MeshStore::open(&view::store_db(home, key)).map_err(|e| e.to_string())
}

fn derive(ctx: &Ctx, st: &MeshStore, key: &str) {
    if let Some(why) = crate::meshw::summary::derive_after_write(st, &inv_of(ctx), key) {
        crate::discard::note("dssup_rehome_derive", &why);
    }
}

/// A registry row from a descriptor (the seed when the source store has no row for the id).
fn row_from_descriptor(d: &OVal, id: &str) -> RegistryRow {
    let text = |k: &str| match d.get(k) {
        Some(OVal::Str(s)) if !s.is_empty() => Some(s.clone()),
        _ => None,
    };
    let nudge = match d.get("nudgeCommand") {
        None | Some(OVal::Null) => None,
        Some(v) => Some(v.stringify()),
    };
    RegistryRow {
        id: id.to_string(),
        worktree_path: text("worktreePath"),
        session_id: text("sessionId"),
        inbox_path: text("inboxPath"),
        cursor_path: text("cursorPath"),
        nudge_command: nudge,
    }
}

/// `meshRowCopy(m, 'row', { workspaceId })`: every field verbatim, only the partition replaced.
fn row_copy(m: &Msg, id: &str) -> MeshRow {
    MeshRow {
        workspace_id: id.to_string(),
        ts: m.ts,
        hash: m.hash.clone(),
        body: m.body.clone(),
        sender: m.sender.clone(),
        recipient: m.recipient.clone(),
        mtype: m.mtype.clone(),
        urgency: m.urgency.clone(),
        is_heartbeat: m.is_heartbeat,
        needs_reply: m.needs_reply,
        orig_hash: m.orig_hash.clone(),
        instance_nonce: m.instance_nonce.clone(),
    }
}

/// `descriptorFreshRepoKey(desc)`: the key re-derived from the descriptor's own worktree path, `None` when it does not resolve.
fn fresh_repo_key(d: &OVal) -> Option<String> {
    match d.get("worktreePath") {
        Some(OVal::Str(w)) if !w.is_empty() => repo_key_for_worktree(w).ok().flatten(),
        _ => None,
    }
}

/// The two paths name the same worktree (the registry's id-collision guard): equal, or equal once resolved.
pub(super) fn same_worktree(a: &str, b: &str) -> bool {
    a == b || ident::realpath(a).is_some_and(|ra| ident::realpath(b) == Some(ra))
}

/// `rehomeAcrossStores(home, id, fromKey, toKey)` with the id's lock HELD by the caller.
pub fn across_stores_locked(ctx: &Ctx, id: &str, from: &str, to: &str) -> Moved {
    let mut out = Moved::default();
    if from.is_empty() || to.is_empty() || from == to {
        return out;
    }
    let home = ctx.home;
    let opened = open_store(home, from).and_then(|f| open_store(home, to).map(|t| (f, t)));
    let (from_h, to_h) = match opened {
        Ok((f, t)) => (rc::Handle::Rw(f), rc::Handle::Rw(t)),
        Err(e) => {
            out.reason = Some(e);
            return out;
        }
    };
    let (Ok(from_st), Ok(to_st)) = (from_h.rw(), to_h.rw()) else { return out };
    // 1) the registry row: the source's, else the descriptor's (descriptor-only split-brain)
    let descriptor = || read_descriptor(home, id).filter(|d| matches!(d.get("id"), Some(OVal::Str(i)) if i == id));
    let (reg, from_source) = match from_st.registry_row(id) {
        Ok(Some(r)) => (r, true),
        _ => match descriptor() {
            Some(d) => (row_from_descriptor(&d, id), false),
            // nothing stranded and nothing to seed a row from: not a split-brain, and a stub must not clobber a real row
            None => return out,
        },
    };
    // the copy base is read STRICTLY before anything is written: an unreadable cursor table makes the floor unknown
    let Ok(rows) = cursors::rows_from_reader(from_h.rd(), id) else {
        reason(&mut out, "devswarm_recon.reason_cursors_unreadable");
        return out;
    };
    let mut cx = rc::Cx::new(&home.to_string_lossy());
    cx.now = ctx.now;
    let since = match cursors::row_of(&rows, defaults::text("mesh_write.ns_store"), defaults::text("mesh_write.floor_reader")) {
        Some(f) => f.value,
        None => rc::floor_store(&cx, &from_h, id),
    };
    // the source's whole unread tail is read before the first destination write: a torn read must not pass the verify below
    // (a timestamp that is not a whole number cannot be copied exactly: the move waits, the source stays authoritative)
    let all = match view::messages_of(from_h.rd(), id) {
        Ok(all) if all.iter().all(|m| m.exact_ts) => all,
        _ => {
            reason(&mut out, "devswarm_recon.reason_source_unreadable");
            return out;
        }
    };
    let msgs: Vec<Msg> = all.into_iter().skip(since.max(0) as usize).collect();
    // 2) the destination registry row, through the id-collision guard
    if let Err(e) = to_st.upsert_registry(&reg, ctx.now, same_worktree) {
        crate::discard::note("dssup_rehome_upsert", &e.to_string());
        return out;
    }
    // 3) the unread tail, through the one door (the lock is held; the id was just registered)
    if !msgs.is_empty() {
        match to_st.is_registered(id) {
            Ok(true) => {}
            Ok(false) => {
                reason(&mut out, "devswarm_recon.reason_dest_gone");
                return out;
            }
            Err(_) => return out,
        }
        for m in &msgs {
            if let Err(e) = to_st.append_mesh_row(&row_copy(m, id)) {
                crate::discard::note("dssup_rehome_append", &e.to_string());
                return out;
            }
        }
    }
    // 4) VERIFY the copy landed BEFORE anything is removed
    let dest_hashes: HashSet<String> = view::messages_of(to_h.rd(), id).map(|v| v.into_iter().filter_map(|m| m.hash).collect()).unwrap_or_default();
    let all_present = msgs.iter().all(|m| m.hash.as_ref().is_none_or(|h| dest_hashes.contains(h)));
    let dest_row = to_st.registry_row(id).ok().flatten();
    let reg_present = dest_row.as_ref().is_some_and(|d| d.worktree_path == reg.worktree_path && d.session_id == reg.session_id);
    if !all_present || !reg_present {
        if dest_row.is_some() && !reg_present {
            out.reg_conflict = true;
            crate::discard::note("dssup_rehome_conflict", &defaults::render("devswarm_recon.msg_rehome_conflict", &[("id", &id)]));
        }
        derive(ctx, to_st, to);
        return out;
    }
    // 5) the copy is verified: tombstone ONLY the source registry row (message rows stay), only when it came from the source store
    if from_source {
        crate::discard::logged("dssup_rehome_remove", crate::meshw::store::retry_busy(|| from_st.reader().conn().prepare_cached(crate::sql::RECON_REGISTRY_DELETE)?.execute(rusqlite::params![id])));
    }
    derive(ctx, from_st, from);
    derive(ctx, to_st, to);
    // 6) the descriptor's ownership follows, so ensure stops rejecting the id
    if let Some(mut d) = descriptor() {
        d.set("ownerKey", OVal::Str(to.to_string()));
        if fresh_repo_key(&d).as_deref() == Some(to) {
            d.set("repoKey", OVal::Str(to.to_string()));
        }
        crate::discard::logged("dssup_rehome_descriptor", crate::atomic::write(home.join(descriptor_rel(id)), d.stringify()));
    }
    out.rehomed = true;
    out.moved_messages = msgs.len();
    out.moved_registry = from_source;
    out
}

/// `rehomeAcrossStores` taking the id's lock itself (a busy lock moves nothing).
pub fn across_stores(ctx: &Ctx, id: &str, from: &str, to: &str) -> Moved {
    let mut out = Moved::default();
    if from.is_empty() || to.is_empty() || from == to {
        return out;
    }
    let Some(held) = idlock::acquire(ctx.home, id) else {
        reason(&mut out, "devswarm_recon.why_lock_busy");
        return out;
    };
    let moved = across_stores_locked(ctx, id, from, to);
    held.release();
    moved
}

/// `rehomeCore(home, id, repoKey)`: the legacy per-id hash bucket into `store/<repoKey>/`.
pub fn core(ctx: &Ctx, id: &str, repo_key: &str) -> Moved {
    if repo_key.is_empty() {
        return Moved::default();
    }
    across_stores(ctx, id, &crate::meshw::send::hash_from_workspace_id(id), repo_key)
}

/// The `healRegistry` row of a genuinely mis-keyed registry row: `rehomeMiskeyedRow`'s move branch. `worktree` is the descriptor's
/// verified current path; the source row's stale path snapshot is refreshed to it first (so the destination's id-collision guard
/// matches a canonical copy already there), then the row moves.
pub fn mis_keyed(ctx: &Ctx, id: &str, store: &str, fresh: &str, worktree: &str) -> Value {
    let row = |rehomed: bool, why: Option<&str>| json!({"id": id, "rehomed": rehomed, "healedDescriptor": false, "reason": why});
    let Some(held) = idlock::acquire(ctx.home, id) else { return row(false, Some(defaults::text("devswarm_recon.why_lock_busy"))) };
    // best-effort: the in-place path refresh on a row about to be tombstoned
    if let Ok(st) = open_store(ctx.home, store)
        && let Ok(Some(srow)) = st.registry_row(id)
        && srow.worktree_path.as_deref() != Some(worktree)
    {
        crate::discard::logged("dssup_rehome_normalise", st.upsert_registry(&RegistryRow { worktree_path: Some(worktree.to_string()), ..srow }, ctx.now, |_, _| true));
    }
    let r = across_stores_locked(ctx, id, store, fresh);
    held.release();
    let mut v = row(r.rehomed, (!r.rehomed && !r.reg_conflict).then_some(defaults::text("devswarm_recon.reason_rehome_not_applied")));
    v["movedMessages"] = json!(r.moved_messages);
    v["movedRegistry"] = json!(r.moved_registry);
    if r.reg_conflict {
        v["regConflict"] = json!(true);
    }
    v
}

// ---- repairRootMappedChildRows ----------------------------------------------------------------------------------------------

/// `prefixSwap(v, from, to)`.
fn prefix_swap(v: &str, from: &str, to: &str) -> String {
    if v == from || v.starts_with(&format!("{from}/")) { format!("{to}{}", &v[from.len()..]) } else { v.to_string() }
}

/// The positive proof for one row: the app's own record says it is a non-primary builder whose worktree exists, belongs to the same
/// project, and the row's current path IS the Primary checkout.
struct Proof {
    old_path: String,
    new_path: String,
    branch: Option<String>,
}

fn proof(ctx: &Ctx, app: &[crate::devswarm_rt::sources::AppBuilder], row: &RegistryRow) -> Option<Proof> {
    let old_path = row.worktree_path.clone().filter(|w| !w.is_empty())?;
    if !is_safe_id(&row.id) || row.id.starts_with(defaults::text("devswarm_recon.primary_id_prefix")) {
        return None;
    }
    let b = app.iter().find(|b| b.id == row.id)?;
    let primary = defaults::text("devswarm_recon.app_primary_type");
    let app_wt = b.worktree.clone().filter(|w| !w.is_empty())?;
    if b.builder_type.as_deref() == Some(primary) {
        return None;
    }
    let old = ident::resolve_context(&old_path, false).ok()?;
    let old_root = old.worktree_root.clone()?;
    if !ident::is_primary_checkout(&old_root, old.main_worktree.as_deref(), ctx.home, &ctx.st.env).ok()? {
        return None;
    }
    let new_path = ident::realpath(&app_wt)?; // a gone worktree: no proof
    let new = ident::resolve_context(&new_path, false).ok()?;
    if new.worktree_root.as_deref() != Some(new_path.as_str()) || new.repo_key != old.repo_key || new_path == old_root {
        return None;
    }
    Some(Proof { old_path, new_path, branch: b.branch.clone() })
}

/// `repairRootMappedChildRows(home, repoKey)`: rows of the store registered against the Primary checkout's path before the identity
/// fix are rewritten to the app's own path for the child (the registry row, and the descriptor when it still carries the same wrong
/// path; the inbox, cursor and nudge paths that start with the old path move with it). Idempotent (a repaired row no longer
/// matches), fail-open per row, no delete. Returns the rows repaired.
pub fn repair_root_mapped(ctx: &Ctx, repo_key: &str) -> usize {
    if repo_key.is_empty() {
        return 0;
    }
    let home = ctx.home;
    let Some(file) = ident::app_db_path(home, &ctx.st.env) else { return 0 };
    let Some(app) = crate::devswarm_rt::sources::read_app(Path::new(&file)) else { return 0 };
    let Ok(rows) = view::registry(home, repo_key) else { return 0 };
    let mut repaired = 0;
    for r in rows {
        if proof(ctx, &app.builders, &r.row).is_none() {
            continue;
        }
        let id = r.row.id.clone();
        let Some(held) = idlock::acquire(home, &id) else { continue };
        let done = (|| -> Option<()> {
            let st = open_store(home, repo_key).ok()?;
            let cur = st.registry_row(&id).ok()??;
            let pr = proof(ctx, &app.builders, &cur)?;
            let swap = |v: &Option<String>| v.as_deref().map(|s| prefix_swap(s, &pr.old_path, &pr.new_path));
            let mut nudge = cur.nudge_command.clone();
            if let Some(OVal::Arr(a)) = nudge.as_deref().and_then(OVal::parse) {
                let mut moved: Vec<String> = a.iter().map(|x| if let OVal::Str(s) = x { prefix_swap(s, &pr.old_path, &pr.new_path) } else { String::new() }).collect();
                let same = a.iter().zip(&moved).all(|(x, m)| matches!(x, OVal::Str(s) if s == m));
                // the poke script's last argument is the branch it pokes: the child's, not the Primary's
                if !same && let Some(b) = &pr.branch && moved.len() > 1 {
                    *moved.last_mut()? = b.clone();
                }
                nudge = Some(OVal::Arr(moved.into_iter().map(OVal::Str).collect()).stringify());
            }
            let fixed = RegistryRow {
                worktree_path: Some(pr.new_path.clone()),
                inbox_path: swap(&cur.inbox_path),
                cursor_path: swap(&cur.cursor_path),
                nudge_command: nudge,
                ..cur.clone()
            };
            st.upsert_registry(&fixed, ctx.now, |_, _| true).ok()?;
            if let Some(mut d) = read_descriptor(home, &id)
                && matches!(d.get("id"), Some(OVal::Str(i)) if *i == id)
                && matches!(d.get("worktreePath"), Some(OVal::Str(w)) if *w == pr.old_path)
            {
                d.set("worktreePath", OVal::Str(pr.new_path.clone()));
                for k in ["inboxPath", "cursorPath"] {
                    if let Some(OVal::Str(s)) = d.get(k).cloned() {
                        d.set(k, OVal::Str(prefix_swap(&s, &pr.old_path, &pr.new_path)));
                    }
                }
                if let Some(OVal::Arr(a)) = d.get("nudgeCommand").cloned() {
                    let moved = a.into_iter().map(|x| if let OVal::Str(s) = x { OVal::Str(prefix_swap(&s, &pr.old_path, &pr.new_path)) } else { x }).collect();
                    d.set("nudgeCommand", OVal::Arr(moved));
                }
                crate::discard::logged("dssup_rootmap_descriptor", crate::atomic::write(home.join(descriptor_rel(&id)), d.stringify()));
            }
            derive(ctx, &st, repo_key);
            Some(())
        })();
        held.release();
        if done.is_some() {
            repaired += 1;
        }
    }
    repaired
}

/// Whether the entry is a rows-result element Node's `healRegistry` counts as rehomed.
pub fn is_rehomed(row: &Value) -> bool {
    row["rehomed"] == json!(true)
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::checks::git::util::Settings;
    use crate::dssup::recon::Hooks;
    use std::process::Command;

    struct Fix {
        _dir: crate::db::TempDir,
        home: std::path::PathBuf,
        st: Settings,
    }

    fn fix(tag: &str) -> Fix {
        crate::defaults::init().unwrap();
        let dir = crate::db::TempDir::new(tag);
        let home = dir.0.join("home");
        std::fs::create_dir_all(&home).unwrap();
        let mut env = std::collections::HashMap::new();
        env.insert("HOME".to_string(), home.to_string_lossy().into_owned());
        let st = Settings { home: home.to_string_lossy().into_owned(), env };
        Fix { _dir: dir, home, st }
    }

    impl Fix {
        fn ctx(&self) -> Ctx<'_> {
            Ctx { home: &self.home, root: &self.home, st: &self.st, now: 1_760_000_000_000, engine_pokes: true }
        }
        fn store(&self, key: &str) -> MeshStore {
            open_store(&self.home, key).unwrap()
        }
        fn descriptor(&self, id: &str, wt: &str, session: &str, owner: &str) {
            let dir = self.home.join(".anti-hall/devswarm/workspaces");
            std::fs::create_dir_all(&dir).unwrap();
            let d = json!({"id": id, "worktreePath": wt, "sessionId": session, "ownerKey": owner});
            std::fs::write(dir.join(format!("{id}.json")), d.to_string()).unwrap();
        }
        fn row(st: &MeshStore, id: &str, wt: &str, session: &str) {
            st.upsert_registry(&RegistryRow { id: id.into(), worktree_path: Some(wt.into()), session_id: Some(session.into()), ..RegistryRow::default() }, 5, |_, _| true).unwrap();
        }
        fn msg(st: &MeshStore, id: &str, hash: &str, ts: i64) {
            let m = MeshRow { workspace_id: id.into(), ts, hash: Some(hash.into()), body: format!("body {hash}"), ..MeshRow::default() };
            assert!(st.append_mesh_row(&m).unwrap().inserted);
        }
        fn hashes(&self, key: &str, id: &str) -> Vec<String> {
            let h = rc::open(&self.home, key, true).unwrap();
            view::messages_of(h.rd(), id).unwrap().into_iter().filter_map(|m| m.hash).collect()
        }
        fn descriptor_owner(&self, id: &str) -> String {
            read_descriptor(&self.home, id).and_then(|d| if let Some(OVal::Str(s)) = d.get("ownerKey") { Some(s.clone()) } else { None }).unwrap_or_default()
        }
    }

    #[test]
    fn dssup_recon_rehome_moves_the_row_and_the_unread_tail_and_deletes_no_message() {
        let f = fix("rehome-move");
        let (from, to) = ("legacyhash00000000", "repokey0000000001");
        {
            let st = f.store(from);
            Fix::row(&st, "w1", "/wt/1", "s1");
            for (h, ts) in [("h1", 1), ("h2", 2), ("h3", 3)] {
                Fix::msg(&st, "w1", h, ts);
            }
        }
        f.descriptor("w1", "/wt/1", "s1", from);
        let out = across_stores(&f.ctx(), "w1", from, to);
        assert_eq!(out, Moved { rehomed: true, moved_messages: 3, moved_registry: true, reason: None, reg_conflict: false });
        assert_eq!(f.hashes(to, "w1"), ["h1", "h2", "h3"]);
        assert_eq!(f.hashes(from, "w1"), ["h1", "h2", "h3"], "no message row is ever deleted from the source");
        assert!(f.store(from).registry_row("w1").unwrap().is_none(), "the source registry row is tombstoned after the verified copy");
        assert!(f.store(to).registry_row("w1").unwrap().is_some());
        assert_eq!(f.descriptor_owner("w1"), to);
        // a second run adds nothing (the source row is gone: the descriptor seeds it, hashes dedupe)
        let again = across_stores(&f.ctx(), "w1", from, to);
        assert!(!again.moved_registry);
        assert_eq!(f.hashes(to, "w1"), ["h1", "h2", "h3"]);
        // the same store, an empty key, a journal store: nothing moves
        assert_eq!(across_stores(&f.ctx(), "w1", to, to), Moved::default());
        std::fs::write(rc::store_dir(&f.home, "journalstore0000").join("BACKEND"), "journal\n").unwrap_or_else(|_| {
            std::fs::create_dir_all(rc::store_dir(&f.home, "journalstore0000")).unwrap();
            std::fs::write(rc::store_dir(&f.home, "journalstore0000").join("BACKEND"), "journal\n").unwrap();
        });
        let legacy = across_stores(&f.ctx(), "w1", "journalstore0000", to);
        assert_eq!((legacy.rehomed, legacy.reason.as_deref()), (false, Some("legacy-journal-store")));
    }

    #[test]
    fn dssup_recon_rehome_keeps_the_source_when_the_destination_row_conflicts() {
        let f = fix("rehome-conflict");
        let (from, to) = ("legacyhash00000000", "repokey0000000001");
        {
            let st = f.store(from);
            Fix::row(&st, "w1", "/wt/1", "s1");
            Fix::msg(&st, "w1", "h1", 1);
            // the destination already maps the id to ANOTHER worktree (the id-collision guard)
            Fix::row(&f.store(to), "w1", "/other/wt", "s2");
        }
        let out = across_stores(&f.ctx(), "w1", from, to);
        assert!(!out.rehomed && out.reg_conflict, "{out:?}");
        assert!(f.store(from).registry_row("w1").unwrap().is_some(), "the source row stays when the destination refused");
        assert_eq!(f.store(to).registry_row("w1").unwrap().unwrap().worktree_path.as_deref(), Some("/other/wt"));
    }

    fn git(dir: &Path, args: &[&str]) {
        assert!(Command::new("git").args(args).current_dir(dir).env("GIT_CONFIG_GLOBAL", "/dev/null").status().unwrap().success(), "git {args:?}");
    }

    #[test]
    fn dssup_recon_rehome_heals_a_mis_keyed_row_by_moving_it_to_its_worktrees_store() {
        let f = fix("rehome-heal");
        let repo = f._dir.0.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q"]);
        let repo = std::fs::canonicalize(&repo).unwrap().to_string_lossy().into_owned();
        let right = ident::repo_key_for_worktree(&repo).unwrap().unwrap();
        let wrong = "wrongkey000000001";
        {
            let st = f.store(wrong);
            // the row carries a stale path snapshot; the descriptor has the real, current one
            Fix::row(&st, "w1", "/old/stale", "s1");
            Fix::msg(&st, "w1", "h1", 1);
        }
        f.descriptor("w1", &repo, "s1", wrong);
        let run = super::super::heal::run(&f.ctx(), &crate::dsact::runner::System::configured(), wrong, &Hooks::none()).unwrap();
        assert!(run.deferred.is_empty(), "{:?}", run.deferred);
        assert_eq!((run.result["rehomed"].as_u64(), run.result["checked"].as_u64()), (Some(1), Some(1)), "{}", run.result);
        assert_eq!(f.hashes(&right, "w1"), ["h1"]);
        let moved = f.store(&right).registry_row("w1").unwrap().unwrap();
        assert_eq!(moved.worktree_path.as_deref(), Some(repo.as_str()), "the destination row carries the descriptor's current path");
        assert_eq!(f.descriptor_owner("w1"), right);
        // idempotent: a second heal finds the row where it belongs
        let again = super::super::heal::run(&f.ctx(), &crate::dsact::runner::System::configured(), &right, &Hooks::none()).unwrap();
        assert_eq!(again.result["rehomed"].as_u64(), Some(0));
    }

    #[test]
    fn dssup_recon_rehome_repairs_a_child_registered_against_the_primary_checkout() {
        let mut f = fix("rehome-rootmap");
        let primary = f._dir.0.join("primary");
        std::fs::create_dir_all(&primary).unwrap();
        git(&primary, &["init", "-q"]);
        git(&primary, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]);
        let child = f._dir.0.join("child");
        git(&primary, &["worktree", "add", "-q", &child.to_string_lossy()]);
        let (primary, child) = (std::fs::canonicalize(&primary).unwrap().to_string_lossy().into_owned(), std::fs::canonicalize(&child).unwrap().to_string_lossy().into_owned());
        let key = ident::repo_key_for_worktree(&primary).unwrap().unwrap();
        // the app's own record: the child is a standard builder in the child worktree
        let db = f._dir.0.join("app.db");
        {
            let c = rusqlite::Connection::open(&db).unwrap();
            c.execute_batch(&format!(
                "CREATE TABLE builders (id TEXT, repositoryId TEXT, sourceBranch TEXT, branchName TEXT, worktreePath TEXT, terminalId TEXT, label TEXT, createdAt TEXT, lastAccessed TEXT, rank INTEGER, isHidden INTEGER, pullRequestId TEXT, builderType TEXT, isPinned INTEGER, isActive INTEGER, lastSelectedAt TEXT);
                 INSERT INTO builders (id, branchName, worktreePath, builderType, isActive, isHidden) VALUES ('kid', 'kid-branch', '{child}', 'standard', 1, 0);"
            ))
            .unwrap();
        }
        f.st.env.insert(defaults::text("mesh_write.env_app_db").to_string(), db.to_string_lossy().into_owned());
        {
            let st = f.store(&key);
            let nudge = json!(["poke.sh", format!("{primary}/x"), "main"]).to_string();
            st.upsert_registry(
                &RegistryRow { id: "kid".into(), worktree_path: Some(primary.clone()), session_id: Some("s1".into()), inbox_path: Some(format!("{primary}/inbox")), nudge_command: Some(nudge), ..RegistryRow::default() },
                5,
                |_, _| true,
            )
            .unwrap();
        }
        f.descriptor("kid", &primary, "s1", &key);
        assert_eq!(repair_root_mapped(&f.ctx(), &key), 1);
        let fixed = f.store(&key).registry_row("kid").unwrap().unwrap();
        assert_eq!(fixed.worktree_path.as_deref(), Some(child.as_str()));
        assert_eq!(fixed.inbox_path.as_deref(), Some(format!("{child}/inbox").as_str()));
        assert_eq!(fixed.nudge_command.as_deref(), Some(json!(["poke.sh", format!("{child}/x"), "kid-branch"]).to_string().as_str()));
        // idempotent: the repaired row no longer matches the proof
        assert_eq!(repair_root_mapped(&f.ctx(), &key), 0);
    }
}
