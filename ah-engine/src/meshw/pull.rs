//! The pull a `--child` tick runs first: `inbox tick <id> --child` is `withSelfHeal(() => cmdInbox('pull', ...))` followed by
//! the ordinary tick, ported from `scripts/devswarm-lib/inbox-cmd.js` `cmdInboxPull`, `register.js` `cmdRegister` (its
//! `ensure` branch for a descriptor that exists) and `companion/lib/devswarm-pull.js` `pullOnce`, over the delivery
//! write-ahead log of `companion/lib/devswarm-read-wal.js` (the engine's byte-compatible port is [`crate::dssup::ingest::wal`]).
//!
//! What a pull does, in Node's order:
//!
//! 1. the ensure: under the workspace's lock, backfill what a descriptor is missing (`ownerKey`, `repoKey`, a default inbox and
//!    cursor path), pre-create the cursor (`0`, exclusive) and the inbox (an empty append), upsert the registry row and refresh the
//!    summary;
//! 2. `pullOnce`, under the per-workspace pull lock (`locks/pull-<id>.lock`, stale after a minute, a live holder never taken
//!    over): replay every batch the WAL holds without a closing record, refuse a destructive read while the WAL cannot be
//!    appended and fsynced, run the non-destructive `hivecontrol workspace message-count`, and only for a count above zero the
//!    ONE bounded `workspace read-messages`. The raw bytes are appended and fsynced to the WAL the moment the read returns,
//!    BEFORE they are parsed; then the new rows are appended to the descriptor's NDJSON inbox (deduplicated by the content hash
//!    embedded in each line, fsynced), fed to the store (best effort, as in Node) and the batch is closed with a `done` (or
//!    `quarantine`) record. A crash anywhere after the WAL fsync re-delivers, never loses, and never duplicates: the replay is
//!    idempotent by the hash.
//!
//! The engine answers the steady state and nothing else, and decides EVERYTHING it can defer before the first write
//! ([`plan`]): a descriptor that needs a project move, a refusal, a second registry row of the same worktree, an `unclaimed:`
//! session, a self-heal that would spawn the installer, WAL batches of other readers or spilled ones, a replayed batch whose
//! dates the engine does not reproduce, a store that is not SQLite. What it cannot know before the destructive read (a date
//! form it does not reproduce in a fresh batch) is handled loss-free: the inbox append is made, the store feed is left to Node
//! and the batch stays PENDING in the WAL, so the next pull hands the replay to Node.
// Discard triage (E3): every `.ok()` / `harmless` / `unwrap_or*` in this file is a deliberate keep, for these reasons:
// - the pre-creates of the cursor and the inbox, the cross-invocation app cache and the store feed are best effort in Node
//   (`try { ... } catch (_) {}`); a failure there never stops the pull
// - an unreadable optional file is the same as an absent one (Node's try/catch around readFileSync)
// - text that does not parse is the absent value (Node's JSON.parse catch parity)
use crate::checks::guardkit::nodelock;
use crate::checks::guardkit::ojson::{OVal, js_number_text};
use crate::checks::guardkit::text::js_trim;
use crate::defaults;
use crate::dssup::ingest::{import, wal};
use crate::meshw::appdb::{self, CacheWrite};
use crate::meshw::common::{Inv, Obj, s};
use crate::meshw::hivecontrol;
use crate::meshw::ident::{self, R, defer};
use crate::meshw::idlock::{self, devswarm_root};
use crate::meshw::store::{CursorPut, MeshStore, RegistryRow};
use crate::meshw::{summary, tick, union};
use std::io::Write;
use std::path::{Path, PathBuf};

/// What the non-destructive `message-count` answered.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum Peek {
    /// The call failed (no binary, a non-zero exit, a timeout): the pull ends with an error and reads nothing.
    Failed,
    /// `parseCount` of the answer.
    Count(f64),
    /// The pull lock is held by another pull: the call is never made.
    NotAsked,
}

/// Everything the pull needs, settled before the first write.
pub(crate) struct Plan {
    id: String,
    /// The descriptor as the ensure leaves it.
    ensured: OVal,
    /// The ensure changes the descriptor file.
    rewrite_descriptor: bool,
    /// The registry row the ensure upserts.
    row: RegistryRow,
    /// The caller's project key (the store the ensure and the feed write).
    repo_key: String,
    store: MeshStore,
    cache: Option<CacheWrite>,
    /// The reader rows a created registration declares for the caller.
    declare: Vec<CursorPut>,
    sender: Option<String>,
    cwd: String,
    inbox: PathBuf,
    wal: PathBuf,
    lock_file: PathBuf,
    /// Batches the WAL holds without a closing record, oldest first.
    pending: Vec<wal::Open>,
    peek: Peek,
}

/// What the pull reports to the tick.
#[derive(Debug, Default)]
pub(crate) struct Outcome {
    /// `walBlocked`: the delivery log cannot be written, so mail may be waiting that the count cannot see.
    pub wal_blocked: bool,
}

fn field_str(d: &OVal, key: &str) -> Option<String> {
    match d.get(key) {
        Some(OVal::Str(x)) if !x.is_empty() => Some(x.clone()),
        _ => None,
    }
}

fn text_or_null(d: &OVal, key: &str) -> R<Option<String>> {
    match d.get(key) {
        None | Some(OVal::Null) => Ok(None),
        Some(OVal::Str(t)) => Ok(Some(t.clone())),
        Some(_) => defer("descriptor-field-shape"),
    }
}

/// `inboxDefaultPath(home, id)`.
fn inbox_default(home: &Path, id: &str) -> String {
    devswarm_root(home).join(defaults::text("mesh_write.dir_inbox")).join(format!("{id}{}", defaults::text("mesh_write.ndjson_suffix"))).to_string_lossy().into_owned()
}

/// `cursorDefaultPath(home, id)`.
fn cursor_default(home: &Path, id: &str) -> String {
    devswarm_root(home).join(defaults::text("mesh_write.dir_cursors")).join(format!("{id}{}", defaults::text("mesh_write.cursor_file_suffix"))).to_string_lossy().into_owned()
}

fn pull_lock_params() -> nodelock::Params {
    nodelock::Params {
        stale_ms: defaults::num("mesh_write.pull_lock_stale_ms"),
        wait_ms: 0,
        step_ms: defaults::num("mesh_write.pull_lock_step_ms"),
        reclaim_stale_ms: defaults::num("mesh_write.id_lock_reclaim_stale_ms"),
        release_tries: defaults::num("mesh_write.id_lock_release_tries"),
        release_step_ms: defaults::num("mesh_write.id_lock_release_step_ms"),
        boot_slop_s: defaults::num("mesh_write.id_lock_boot_slop_s"),
        steal_dead: false,
    }
}

/// `parseCount(raw)`: a bare number, a JSON object with a known count key, or the first integer in the text; anything else is 0.
fn parse_count(raw: &str) -> f64 {
    let t = js_trim(raw);
    if t.is_empty() {
        return 0.0;
    }
    let clamp = |n: f64| n.floor().max(0.0);
    if let Some(v) = OVal::parse(t) {
        match &v {
            OVal::Num(n) if n.is_finite() => return clamp(*n),
            OVal::Obj(_) => {
                for k in defaults::list("mesh_write.pull_count_keys") {
                    if let Some(OVal::Num(n)) = v.get(k)
                        && n.is_finite()
                    {
                        return clamp(*n);
                    }
                }
            }
            _ => {}
        }
    }
    // `t.match(/-?\d+/)` then `parseInt`
    let b = t.as_bytes();
    let mut i = 0;
    while i < b.len() {
        let start = i;
        if b[i] == b'-' {
            i += 1;
        }
        let digits = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i > digits {
            return t[start..i].parse::<f64>().map_or(0.0, |n| n.max(0.0));
        }
        i = start + 1;
    }
    0.0
}

/// Whether Node would adopt another reader's WAL (`pull-*.ndjson`) under that reader's lock: a file whose open batches ALL name
/// `worktree` (`adoptForWorktree`), or a file an earlier adopter claimed that still holds an open batch. The engine does not adopt.
fn foreign_open_batches(root: &Path, own: &Path, worktree: &str) -> bool {
    let dir = root.join(defaults::text("devswarm_ingest.dir_wal"));
    let suffix = defaults::text("devswarm_ingest.wal_suffix");
    let prefix = defaults::text("mesh_write.pull_file_prefix");
    let has_open = |f: &Path| wal::pending(f).map_or(true, |p| !p.is_empty());
    let all_name_it = |f: &Path| wal::pending(f).map_or(true, |p| !p.is_empty() && p.iter().all(|b| b.worktree.as_deref() == Some(worktree)));
    if !worktree.is_empty() {
        for e in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with(prefix) && name.ends_with(suffix) && e.path() != own && all_name_it(&e.path()) {
                return true;
            }
        }
    }
    let stem = own.file_stem().map(|x| x.to_string_lossy().into_owned()).unwrap_or_default();
    let adopted = dir.join(defaults::text("devswarm_ingest.dir_adopted")).join(stem);
    std::fs::read_dir(adopted).into_iter().flatten().flatten().any(|e| e.file_name().to_string_lossy().ends_with(suffix) && has_open(&e.path()))
}

/// The first half of the plan: the ensure (what the descriptor, the registry and the summary become), decided without writing. The
/// tick counts over [`Plan::ensured`], which is the descriptor Node's count reads after its own ensure.
pub(crate) fn prepare(inv: &Inv, id: &str, desc: Option<&OVal>) -> R<Plan> {
    if crate::meshw::heartbeat::is_primary_label(id) {
        return defer("primary-label");
    }
    // withSelfHeal: the probe reads; a heal that would spawn the installer is Node's
    crate::meshw::common::self_heal(inv)?; // the heal's fields are added to the pull result, which a tick never prints
    let wt = ident::resolve_caller_worktree(&inv.cwd)?.unwrap_or_else(|| inv.cwd.clone());
    let (verdict, cache) = appdb::archived_verdict(&inv.home, &inv.env, inv.now, id, Some(&wt), true)?;
    if verdict == Some(true) {
        return defer("app-archived");
    }
    let ctx = ident::resolve_context(&inv.cwd, true)?;
    if ctx.kind.starts_with(defaults::text("mesh_write.kind_submodule_prefix")) {
        return defer("submodule");
    }
    let Some(current) = ctx.repo_key.clone() else { return defer("no-project") };
    let owner_key = defaults::text("mesh_write.field_owner_key");
    let wt_field = defaults::text("mesh_write.field_worktree_path");
    let fresh = |d: &OVal| -> R<Option<String>> {
        match union::path_field(d, wt_field)? {
            Some(w) => ident::repo_key_for_worktree(&w),
            None => Ok(None),
        }
    };
    let create = desc.is_none();
    let (ensured, rewrite_descriptor) = match desc {
        Some(desc) => {
            let OVal::Obj(fields) = desc else { return defer("descriptor-shape") };
            if fields.iter().any(|(k, _)| k == "__proto__") {
                return defer("descriptor-keys");
            }
            if let Some(reg) = crate::meshw::inbox::registered_repo_key(desc, id)?
                && reg != current
            {
                return defer("project-context-mismatch");
            }
            let hash_key = crate::meshw::send::hash_from_workspace_id(id);
            let stored_owner = field_str(desc, owner_key);
            if stored_owner.as_deref() == Some(hash_key.as_str()) && hash_key != current {
                return defer("rehome");
            }
            let proven = match stored_owner.clone() {
                Some(k) => Some(k),
                None => match field_str(desc, defaults::text("mesh_write.field_repo_key")) {
                    Some(k) => Some(k),
                    None => fresh(desc)?,
                },
            };
            if proven.as_deref() != Some(current.as_str()) {
                return defer("ensure-refused");
            }
            // the descriptor as the ensure leaves it
            let mut ensured = desc.clone();
            if stored_owner.is_none() {
                ensured.set(owner_key, s(&current));
            }
            if fresh(&ensured)?.as_deref() == Some(current.as_str()) {
                ensured.set(defaults::text("mesh_write.field_repo_key"), s(&current));
            }
            for (key, default) in [
                (defaults::text("mesh_write.field_inbox_path"), inbox_default(&inv.home, id)),
                (defaults::text("mesh_write.field_cursor_path"), cursor_default(&inv.home, id)),
            ] {
                if matches!(ensured.get(key), None | Some(OVal::Null)) || matches!(ensured.get(key), Some(OVal::Str(x)) if x.is_empty()) {
                    ensured.set(key, s(&default));
                }
                if !matches!(ensured.get(key), Some(OVal::Str(_))) {
                    return defer("descriptor-path-type");
                }
            }
            let rewrite = ensured.stringify() != desc.stringify();
            (ensured, rewrite)
        }
        None => {
            // the auto-ensure CREATES the registration: refused ids, an archived twin and a cross-project worktree are Node's
            let reserved = defaults::list("mesh_write.reserved_id_tokens").iter().any(|t| id.contains(t))
                || id.ends_with(defaults::text("mesh_write.reserved_id_suffix"))
                || id == defaults::text("mesh_write.reserved_exact_id");
            if reserved {
                return defer("reserved-id");
            }
            if devswarm_root(&inv.home)
                .join(defaults::text("mesh_write.dir_archived"))
                .join(format!("{id}{}", defaults::text("mesh_write.json_suffix")))
                .exists()
            {
                return defer("archived-counterpart");
            }
            // buildDescriptorFromFlags(id, { worktree, session, inbox, cursor }, null, env): keys in Node's order
            let session = inv
                .env
                .get(defaults::text("mesh_write.env_builder_id"))
                .filter(|b| !b.is_empty())
                .cloned()
                .unwrap_or_else(|| format!("{}{id}", defaults::text("mesh_write.synthetic_session_prefix")));
            let repo_id = inv.env.get(defaults::text("devswarm_gates.repo_id_env")).filter(|r| !r.is_empty()).cloned();
            let mut d = Obj::default();
            d.put(defaults::text("mesh_write.field_id"), s(id))
                .put(wt_field, s(&ident::resolve_abs(&wt)))
                .put(defaults::text("mesh_write.field_session_id"), s(&session))
                .put(defaults::text("mesh_write.field_inbox_path"), s(&inbox_default(&inv.home, id)))
                .put(defaults::text("mesh_write.field_cursor_path"), s(&cursor_default(&inv.home, id)));
            if let Some(r) = &repo_id {
                d.put(defaults::text("mesh_write.field_repo_id"), s(r));
            }
            d.put(defaults::text("mesh_write.field_nudge_command"), OVal::Null);
            if repo_id.is_none() {
                d.put(defaults::text("mesh_write.field_repo_id"), OVal::Null);
            }
            let mut built = d.done();
            // the cross-project guard, then the project keys
            let worktree_key = fresh(&built)?;
            if let Some(wk) = &worktree_key
                && *wk != current
            {
                return defer("cross-project-register");
            }
            if worktree_key.as_deref() == Some(current.as_str()) {
                built.set(defaults::text("mesh_write.field_repo_key"), s(&current));
            }
            built.set(owner_key, s(&current));
            (built, true)
        }
    };
    let desc_wt = union::path_field(&ensured, wt_field)?;
    let nudge = match ensured.get(defaults::text("mesh_write.field_nudge_command")) {
        None | Some(OVal::Null) => None,
        Some(v) => Some(v.stringify()),
    };
    let row = RegistryRow {
        id: id.to_string(),
        worktree_path: text_or_null(&ensured, wt_field)?,
        session_id: text_or_null(&ensured, defaults::text("mesh_write.field_session_id"))?,
        inbox_path: text_or_null(&ensured, defaults::text("mesh_write.field_inbox_path"))?,
        cursor_path: text_or_null(&ensured, defaults::text("mesh_write.field_cursor_path"))?,
        nudge_command: nudge,
    };
    // maybePromoteUnclaimed: a row stamped `unclaimed:` is promoted by a session the caller proves it owns
    if row.session_id.as_deref() == Some(format!("{}{id}", defaults::text("mesh_write.synthetic_session_prefix")).as_str()) {
        return defer("unclaimed");
    }
    // the registry: the row's worktree must be the one the upsert would write (else the collision guard decides), and no other row
    // of the same worktree may exist (retireWorktreeDuplicates would fold it)
    let Some(reader) = tick::open_reader(inv, &current)? else { return defer("no-store") };
    let rows = ident::rows_of(&reader.roster().map_err(|e| ident::Defer(format!("registry:{e}")))?);
    if !create
        && let (Some(existing), Some(incoming)) = (rows.iter().find(|r| r.id == id).and_then(|r| r.worktree_path.clone()), row.worktree_path.as_deref())
        && existing != incoming
    {
        return defer("registry-collision");
    }
    if let Some(w) = desc_wt.as_deref() {
        let keep_mesh = ident::primary_workspace_id(w)?;
        if keep_mesh != id
            && let Some(keep_real) = ident::canonical_worktree_real_path(w)?
        {
            for r in rows.iter().filter(|r| r.id != id) {
                if let Some(rw) = r.worktree_path.as_deref().filter(|x| !x.is_empty())
                    && ident::canonical_worktree_real_path(rw)?.as_deref() == Some(keep_real.as_str())
                {
                    return defer("duplicate-registry-rows");
                }
            }
        }
    }
    let store = crate::meshw::common::open_store(inv, &current)?;
    summary::check(&store, inv, None)?;
    let declare = if create { plan_declare(inv, &store, id)? } else { Vec::new() };
    // pullOnce reads the store of the worktree the caller stands in
    let pull_repo = ident::repo_key_for_worktree(&wt)?;
    if pull_repo.as_deref() != Some(current.as_str()) {
        return defer("pull-store-differs");
    }
    let wctx = ident::resolve_context(&wt, false)?;
    if wctx.kind.starts_with(defaults::text("mesh_write.kind_submodule_prefix")) {
        return defer("submodule");
    }
    let sender = ident::primary_workspace_id(wctx.main_worktree.as_deref().unwrap_or(&wt)).ok().filter(|x| idlock::is_safe_id(x));
    let root = devswarm_root(&inv.home);
    let wal_file = wal::wal_path(&root, defaults::text("mesh_write.pull_wal_kind"), id);
    let lock_file = root.join(defaults::text("mesh_write.dir_locks")).join(format!(
        "{}{id}{}",
        defaults::text("mesh_write.pull_file_prefix"),
        defaults::text("mesh_write.lock_suffix")
    ));
    let inbox = PathBuf::from(field_str(&ensured, defaults::text("mesh_write.field_inbox_path")).unwrap_or_default());
    Ok(Plan {
        id: id.to_string(),
        ensured,
        rewrite_descriptor,
        row,
        repo_key: current,
        store,
        cache,
        sender,
        cwd: wt,
        inbox,
        wal: wal_file,
        lock_file,
        declare,
        pending: Vec::new(),
        peek: Peek::NotAsked,
    })
}

/// `readerCursors.declare(store, { partition, reader, home })` for a registration the pull creates: the caller's own `store` and
/// `nd` rows, seeded at the partition's floor (INSERT-if-absent; a retired row of the caller's is revived). Declared only when
/// the floor rows exist and no legacy per-instance cursor file maps the caller; the import of the legacy cursors is Node's.
fn plan_declare(inv: &Inv, store: &MeshStore, id: &str) -> R<Vec<CursorPut>> {
    let Some(reader) = crate::meshw::cursors::reader_key(tick::reader_nonce_cached(&inv.home).as_deref()) else { return Ok(Vec::new()) };
    let rows = crate::meshw::cursors::rows_of(store, id).map_err(|e| ident::Defer(format!("cursor-rows:{e}")))?;
    if crate::meshw::cursors::needs_import(&rows) {
        return defer("reader-declare-import");
    }
    let dir = devswarm_root(&inv.home).join(defaults::text("mesh_write.dir_cursors"));
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if defaults::list("mesh_write.legacy_cursor_seps").iter().any(|sep| name.starts_with(&format!("{id}{sep}"))) {
            return defer("reader-declare-legacy");
        }
    }
    let floor = defaults::text("mesh_write.floor_reader");
    let mut puts = Vec::new();
    for ns in defaults::list("mesh_write.cursor_namespaces") {
        match rows.iter().find(|r| r.ns == ns && r.reader == reader) {
            Some(r) if r.retired_line.is_some_and(|l| r.value <= l) => {
                puts.push(CursorPut { partition: id.to_string(), ns: ns.to_string(), reader: reader.clone(), value: r.value, retired_line: Some(None), updated_at: inv.now });
            }
            Some(_) => {}
            None => {
                let Some(f) = rows.iter().find(|r| r.ns == ns && r.reader == floor) else { return defer("reader-declare-import") };
                puts.push(CursorPut { partition: id.to_string(), ns: ns.to_string(), reader: reader.clone(), value: f.value, retired_line: Some(None), updated_at: inv.now });
            }
        }
    }
    Ok(puts)
}

impl Plan {
    /// The descriptor as the ensure leaves it.
    pub(crate) fn ensured(&self) -> &OVal {
        &self.ensured
    }

    /// This pull's delivery log (the pull replays and closes its open batches before the tick reports the log's health).
    pub(crate) fn wal_path(&self) -> &Path {
        &self.wal
    }

    /// The delivery-log half of the second half: the open batches this pull will replay, and the states of the log the engine does
    /// not reproduce (spilled batches, another reader's open batches, a replayed batch whose dates it does not reproduce). Still
    /// without writing.
    pub(crate) fn check_wal(&mut self, inv: &Inv) -> R<()> {
        let root = devswarm_root(&inv.home);
        self.pending = match wal::pending(&self.wal) {
            Ok(p) => p,
            Err(_) => return defer("wal-unreadable"),
        };
        if wal::spilled(&self.wal) > 0 {
            return defer("wal-spilled");
        }
        let worktree = field_str(&self.ensured, defaults::text("mesh_write.field_worktree_path")).unwrap_or_else(|| self.cwd.clone());
        if foreign_open_batches(&root, &self.wal, &worktree) {
            return defer("wal-foreign");
        }
        for p in &self.pending {
            if import::rows(&self.id, &import::parse_batch(&p.raw), inv.now).iter().any(|r| r.ts_fallback) {
                return defer("wal-replay-date");
            }
        }
        Ok(())
    }

    /// The second half: what `pullOnce` will find (the lock, the delivery log, the native count), still without writing.
    /// `store_unread` is the unread count of the store partition before the pull and `line_form` whether the tick prints its one
    /// line (the JSON form refuses a count over the read limit, which a drain could cause).
    pub(crate) fn finish(mut self, inv: &Inv, store_unread: usize, line_form: bool) -> R<Plan> {
        let busy = nodelock::held_by_other(&self.lock_file.to_string_lossy(), pull_lock_params());
        if busy {
            return Ok(self);
        }
        self.check_wal(inv)?;
        let c = hivecontrol::call(&defaults::list("mesh_write.hc_message_count"), &inv.env, defaults::millis("mesh_write.hivecontrol_timeout_ms"));
        self.peek = if c.ok { Peek::Count(parse_count(&c.raw)) } else { Peek::Failed };
        if let Peek::Count(n) = self.peek
            && !line_form
            && n > 0.0
            && (store_unread as f64) + n > defaults::num("mesh_write.inbox_read_limit") as f64
        {
            return defer("read-cap");
        }
        Ok(self)
    }

    /// The pull lock file of this workspace.
    pub(crate) fn lock_file(&self) -> &Path {
        &self.lock_file
    }

    /// The batches the log holds without a closing record, oldest first (set by [`Plan::check_wal`]).
    pub(crate) fn pending(&self) -> &[wal::Open] {
        &self.pending
    }
}

fn write_descriptor(inv: &Inv, id: &str, d: &OVal) -> std::io::Result<()> {
    let dir = devswarm_root(&inv.write_home).join(defaults::text("mesh_write.dir_workspaces"));
    let file = dir.join(format!("{id}{}", defaults::text("mesh_write.json_suffix")));
    let mut tmp = file.as_os_str().to_os_string();
    tmp.push(defaults::text("mesh_write.tmp_suffix"));
    let tmp = PathBuf::from(tmp);
    std::fs::create_dir_all(&dir)?;
    std::fs::write(&tmp, d.stringify())?;
    std::fs::rename(&tmp, &file)
}

/// `precreateCursorAndInbox(desc)`: the cursor at `0` (exclusive: never clobbered), the inbox by an empty append.
fn precreate(d: &OVal) {
    if let Some(c) = field_str(d, defaults::text("mesh_write.field_cursor_path")) {
        let p = Path::new(&c);
        if let Some(dir) = p.parent() {
            crate::discard::harmless(std::fs::create_dir_all(dir)); // keep: best effort, as Node's try/catch
        }
        if let Ok(mut f) = std::fs::OpenOptions::new().write(true).create_new(true).open(p) {
            crate::discard::harmless(f.write_all(defaults::text("mesh_write.cursor_initial").as_bytes())); // keep: best effort
        }
    }
    if let Some(i) = field_str(d, defaults::text("mesh_write.field_inbox_path")) {
        let p = Path::new(&i);
        if let Some(dir) = p.parent() {
            crate::discard::harmless(std::fs::create_dir_all(dir)); // keep: best effort
        }
        crate::discard::harmless(std::fs::OpenOptions::new().append(true).create(true).open(p)); // keep: best effort
    }
}

fn lacks_trailing_newline(file: &Path) -> bool {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut f) = std::fs::File::open(file) else { return false };
    let Ok(len) = f.metadata().map(|m| m.len()) else { return false };
    if len == 0 || f.seek(SeekFrom::Start(len - 1)).is_err() {
        return false;
    }
    let mut last = Vec::new();
    f.take(1).read_to_end(&mut last).is_ok() && last.first().is_some_and(|b| *b != b'\n')
}

/// What one batch made of the inbox.
pub(crate) struct Ingested {
    pub imported: usize,
    pub duplicate: usize,
    pub parsed: usize,
    /// The store feed was left to Node (a date form the engine does not reproduce).
    pub store_left: bool,
}

/// The hashes the inbox already holds (`collectExistingHashes`): the embedded content hash of each line; a torn line is skipped.
fn inbox_hashes(inbox: &Path) -> std::collections::HashSet<String> {
    let mut seen = std::collections::HashSet::<String>::new();
    if let Ok(bytes) = std::fs::read(inbox) {
        for line in String::from_utf8_lossy(&bytes).split('\n') {
            let t = js_trim(line);
            if t.is_empty() {
                continue;
            }
            if let Some(o) = OVal::parse(t)
                && let Some(h) = o.get(defaults::text("mesh_write.row_hash_field"))
                && !matches!(h, OVal::Null)
            {
                seen.insert(import::js_string(h));
            }
        }
    }
    seen
}

/// One batch against the hashes already seen: the lines to append and the counts (a message already seen, in the inbox or earlier
/// in the same batch, is a duplicate).
fn batch_lines(p: &Plan, batch: &import::Batch, seen: &mut std::collections::HashSet<String>) -> (String, usize, usize) {
    let (mut imported, mut duplicate) = (0, 0);
    let mut lines = String::new();
    let pick = |m: &OVal, k: &str| -> OVal {
        match m.get(k) {
            None | Some(OVal::Null) => OVal::Null,
            Some(v) => v.clone(),
        }
    };
    for m in &batch.messages {
        let h = import::message_hash(&p.id, m);
        if seen.contains(&h) {
            duplicate += 1;
            continue;
        }
        seen.insert(h.clone());
        let mut o = Obj::default();
        o.put(defaults::text("mesh_write.row_hash_field"), s(&h));
        for k in defaults::list("mesh_write.row_fields") {
            o.put(k, pick(m, k));
        }
        o.put(defaults::text("mesh_write.row_sender_field"), p.sender.as_deref().map_or(OVal::Null, s));
        lines.push_str(&o.done().stringify());
        lines.push('\n');
        imported += 1;
    }
    (lines, imported, duplicate)
}

/// What ingesting `raws` in order (the open batches, then the new one) would make of the LAST one: its imported and duplicate
/// counts and the number of messages it parsed, without writing.
pub(crate) fn preview(p: &Plan, raws: &[&str]) -> (usize, usize, usize) {
    let mut seen = inbox_hashes(&p.inbox);
    let mut last = (0, 0, 0);
    for raw in raws {
        let batch = import::parse_batch(raw);
        let (_, imported, duplicate) = batch_lines(p, &batch, &mut seen);
        last = (imported, duplicate, batch.messages.len());
    }
    last
}

/// Whether the store feed of this raw batch would be left to Node (a date form the engine does not reproduce).
pub(crate) fn store_feed_left(inv: &Inv, p: &Plan, raw: &str) -> bool {
    import::rows(&p.id, &import::parse_batch(raw), inv.now).iter().any(|r| r.ts_fallback)
}

/// `ingestRaw(raw)`: parse one raw native batch, append the new rows to the durable inbox (idempotent by the embedded content
/// hash) and fsync it, then the best-effort store feed. `Err` when the durable append fails (the WAL entry then stays pending).
fn ingest_raw(inv: &Inv, p: &Plan, raw: &str, at: &dyn Fn(&str)) -> Result<Ingested, String> {
    let batch = import::parse_batch(raw);
    let mut seen = inbox_hashes(&p.inbox);
    let (lines, imported, duplicate) = batch_lines(p, &batch, &mut seen);
    // DURABLE append precedes the WAL `done`: one append of the whole batch, a leading newline after a torn tail, then the fsync
    if !lines.is_empty() {
        if let Some(d) = p.inbox.parent() {
            std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
        }
        let lead = if lacks_trailing_newline(&p.inbox) { "\n" } else { "" };
        let mut f = std::fs::OpenOptions::new().append(true).create(true).open(&p.inbox).map_err(|e| e.to_string())?;
        f.write_all(format!("{lead}{lines}").as_bytes()).map_err(|e| e.to_string())?;
        drop(f);
        std::fs::File::open(&p.inbox).and_then(|f| f.sync_all()).map_err(|e| e.to_string())?;
    }
    at("inbox:after");
    // the store parity feed: best effort, as in Node (`try { ... } catch (_) {}`)
    let mut store_left = false;
    if import::rows(&p.id, &batch, inv.now).iter().any(|r| r.ts_fallback) {
        store_left = true;
    } else if import::ingest_payload(&p.store, &inv.home, &p.id, raw, inv.now).is_ok()
        && let Some(why) = summary::derive_after_write(&p.store, inv, &p.repo_key)
    {
        crate::meshw::log_summary_failure(defaults::text("mesh_write.verb_inbox"), &why);
    }
    Ok(Ingested { imported, duplicate, parsed: batch.messages.len(), store_left })
}

/// The ensure's writes (cache, descriptor, pre-created files, registry row, declared reader, summary), the caller holding the
/// workspace lock. `false` when a step Node's catch around the ensure would stop at failed (the pull is then skipped).
pub(crate) fn ensure_locked(inv: &Inv, p: &Plan) -> bool {
    if let Some(c) = &p.cache {
        c.perform();
    }
    if p.rewrite_descriptor && write_descriptor(inv, &p.id, &p.ensured).is_err() {
        return false;
    }
    precreate(&p.ensured);
    if p.store.upsert_registry(&p.row, inv.now, |_, _| true).is_err() {
        return false;
    }
    // a created registration declares the caller as a reader of the partition (best effort: an undeclared instance reads
    // from the floor)
    if !p.declare.is_empty() {
        crate::discard::harmless(p.store.reader_cursor_txn(&p.declare)); // keep: Node's `catch (_) { /* fail-soft */ }`
    }
    if let Some(why) = summary::derive_after_write(&p.store, inv, &p.repo_key) {
        crate::meshw::log_summary_failure(defaults::text("mesh_write.verb_inbox"), &why);
    }
    true
}

/// The ensure's writes and then `pullOnce`. Nothing here defers (the plan did): the first thing it does is take the workspace's
/// lock, and a lock that stays busy hands the verb to Node before anything is written.
pub(crate) fn execute(inv: &Inv, p: Plan) -> R<Outcome> {
    let Some(id_lock) = idlock::acquire(&inv.home, &p.id) else { return defer("lock-busy") };
    crate::meshw::mark_committed();
    // ---- the ensure, under the workspace lock (a failure skips the pull, as Node's catch around it does) ----
    let ensured = ensure_locked(inv, &p);
    id_lock.release();
    if !ensured {
        return Ok(Outcome::default());
    }
    Ok(pull_once(inv, &p))
}

/// `pullOnce`: one bounded, guard-safe drain of the child's native queue into its durable inbox.
fn pull_once(inv: &Inv, p: &Plan) -> Outcome {
    let none = Outcome::default();
    let Some(lock) = nodelock::acquire_stale_unless_live(&p.lock_file.to_string_lossy(), pull_lock_params()) else { return none };
    let out = pull_locked(inv, p);
    lock.release();
    out
}

/// The pull lock's parameters, for a caller that holds the lock across more than one step.
pub(crate) fn lock_params() -> nodelock::Params {
    pull_lock_params()
}

/// REPLAY FIRST: every batch a previous pull captured but never closed is ingested (inbox, store) and closed before any new
/// destructive read. A batch whose store feed is left to Node stays pending. `Err` when an ingest or a close failed: the rest
/// stays pending and nothing further is read.
pub(crate) fn replay_pending(inv: &Inv, p: &Plan, at: &dyn Fn(&str)) -> Result<(), ()> {
    for entry in &p.pending {
        let Ok(r) = ingest_raw(inv, p, &entry.raw, at) else { return Err(()) };
        if r.store_left {
            continue;
        }
        let raw_t = js_trim(&entry.raw);
        let empty = r.parsed == 0 && !raw_t.is_empty() && raw_t != defaults::text("mesh_write.empty_array");
        at("close:before");
        let closed = if empty {
            wal::close_batch(&p.wal, &entry.e, defaults::text("mesh_write.wal_quarantine"), &format!("\"reason\":\"{}\"", defaults::text("mesh_write.wal_reason_unparseable")), inv.now)
        } else {
            wal::close_batch(
                &p.wal,
                &entry.e,
                defaults::text("mesh_write.wal_done"),
                &format!("\"imported\":{},\"duplicate\":{},\"into\":{}", r.imported, r.duplicate, OVal::Str(p.id.clone()).stringify()),
                inv.now,
            )
        };
        if closed.is_err() {
            return Err(());
        }
    }
    Ok(())
}

/// What a fresh destructive read found.
pub(crate) enum Fresh {
    /// The delivery log cannot be appended and fsynced right now: no read was made.
    Blocked,
    /// `message-count` failed (no binary, a timeout, a non-zero exit): nothing was read.
    CountFailed,
    /// Nothing waits.
    Empty,
    /// `read-messages` ran. `entry` is the log entry that holds its raw bytes (`None`: empty stdout or a log write that failed).
    Read { native: f64, ok: bool, entry: Option<String>, wal_error: bool, raw: String },
}

/// The destructive half of `pullOnce`, up to and including the durable capture: the preflight, the non-destructive count and, for
/// a count above zero, the ONE bounded read whose raw bytes are appended and fsynced to the log before anything parses them.
/// The caller holds the pull lock.
pub(crate) fn capture_fresh(inv: &Inv, p: &Plan, worktree: &str, at: &dyn Fn(&str)) -> Fresh {
    if wal::preflight(&p.wal).is_some() {
        return Fresh::Blocked;
    }
    let c = hivecontrol::call(&defaults::list("mesh_write.hc_message_count"), &inv.env, defaults::millis("mesh_write.hivecontrol_timeout_ms"));
    if !c.ok {
        return Fresh::CountFailed;
    }
    let native = parse_count(&c.raw);
    if native <= 0.0 {
        return Fresh::Empty;
    }
    let r = hivecontrol::call(&defaults::list("mesh_write.hc_read_messages"), &inv.env, defaults::millis("mesh_write.pull_read_timeout_ms"));
    at("read:after");
    let (mut entry, mut wal_error) = (None, false);
    if !r.raw.is_empty() {
        match wal::capture_raw(&p.wal, &r.raw, inv.now, Some(worktree)) {
            wal::Capture::Wal(e) => entry = Some(e),
            _ => wal_error = true,
        }
    }
    at("wal:after");
    Fresh::Read { native, ok: r.ok, entry, wal_error, raw: r.raw }
}

fn pull_locked(inv: &Inv, p: &Plan) -> Outcome {
    let blocked = Outcome { wal_blocked: true };
    // the descriptor is read again, as Node does (the ensure has written it)
    let Some(desc) = std::fs::read(devswarm_root(&inv.home).join(defaults::text("mesh_write.dir_workspaces")).join(format!("{}{}", p.id, defaults::text("mesh_write.json_suffix"))))
        .ok()
        .and_then(|b| OVal::parse(&String::from_utf8_lossy(&b)))
    else {
        return Outcome::default();
    };
    let worktree = field_str(&desc, defaults::text("mesh_write.field_worktree_path")).unwrap_or_else(|| p.cwd.clone());
    // REPLAY FIRST: every batch a previous pull captured but never closed is ingested before any new destructive read
    if replay_pending(inv, p, &|_| {}).is_err() {
        return Outcome::default();
    }
    // FAIL CLOSED: never a destructive read into a WAL that cannot be appended and fsynced right now
    if wal::preflight(&p.wal).is_some() {
        return blocked;
    }
    let native = match p.peek {
        Peek::Count(n) => n,
        Peek::Failed | Peek::NotAsked => return Outcome::default(),
    };
    if native <= 0.0 {
        wal::maybe_rotate(&p.wal, inv.now);
        return Outcome::default();
    }
    // ONE bounded read-messages (finite timeout, never monitor)
    let r = hivecontrol::call(&defaults::list("mesh_write.hc_read_messages"), &inv.env, defaults::millis("mesh_write.pull_read_timeout_ms"));
    // WAL the RAW bytes immediately, before the exit status is looked at and before any parse
    let mut entry: Option<String> = None;
    let mut wal_error = false;
    if !r.raw.is_empty() {
        match wal::capture_raw(&p.wal, &r.raw, inv.now, Some(&worktree)) {
            wal::Capture::Wal(e) => entry = Some(e),
            _ => wal_error = true,
        }
    }
    if !r.ok {
        return Outcome { wal_blocked: wal_error };
    }
    let got = match ingest_raw(inv, p, &r.raw, &|_| {}) {
        Ok(g) => g,
        Err(_) => return Outcome { wal_blocked: wal_error },
    };
    let recovered = (got.imported + got.duplicate) as f64;
    let shortfall = recovered < native;
    if !wal_error && !got.store_left {
        // a close that fails leaves the batch pending: the next pull replays it idempotently. An empty read has no entry id and
        // Node closes it as `null` all the same.
        let (kind, extra) = if shortfall {
            (
                defaults::text("mesh_write.wal_quarantine"),
                format!(
                    "\"reason\":\"{}\",\"nativeCount\":{},\"recovered\":{}",
                    defaults::text("mesh_write.wal_reason_shortfall"),
                    js_number_text(native),
                    js_number_text(recovered)
                ),
            )
        } else {
            (defaults::text("mesh_write.wal_done"), format!("\"imported\":{},\"duplicate\":{}", got.imported, got.duplicate))
        };
        let closed = match &entry {
            Some(e) => wal::close_batch(&p.wal, e, kind, &extra, inv.now),
            None => wal::fsync_append(&p.wal, &format!("{{\"t\":\"{kind}\",{extra},\"e\":null,\"ts\":{}}}\n", inv.now)),
        };
        crate::discard::harmless(closed); // keep: the batch stays pending and the next pull replays it (Node's catch)
    }
    if shortfall {
        eprint!(
            "{}",
            defaults::render(
                "mesh_write.msg_pull_shortfall",
                &[
                    ("id", &OVal::Str(p.id.clone()).stringify()),
                    ("count", &js_number_text(native)),
                    ("recovered", &js_number_text(recovered)),
                    ("lost", &js_number_text(native - recovered)),
                    ("wal", &p.wal.display()),
                    ("entry", &entry.unwrap_or_else(|| defaults::text("mesh_write.js_null").to_string())),
                ]
            )
        );
    }
    Outcome { wal_blocked: wal_error }
}
