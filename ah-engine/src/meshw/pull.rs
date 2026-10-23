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
use crate::checks::guardkit::ojson::OVal;
use crate::checks::guardkit::text::js_trim;
use crate::checks::jsport::num::to_js_string;
use crate::defaults;
use crate::dssup::ingest::{import, wal};
use crate::meshw::appdb::{self, CacheWrite};
use crate::meshw::common::{Inv, Obj, s};
use crate::meshw::hivecontrol;
use crate::meshw::ident::{self, R};
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
    /// The store of the worktree the pull stands in, when that is not the caller's project (`pullOnce` feeds it).
    feed: Option<(String, MeshStore)>,
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
    /// `res.error` of a failed `message-count` and whether it timed out.
    peek_error: (String, bool),
    /// The ensure creates the reader rows the caller declares: the legacy read positions are imported first when the partition has
    /// no floor rows yet.
    import_first: bool,
    /// The worktree whose other registry rows the ensure folds into this id (after the registration, fail-open).
    retire_worktree: Option<String>,
    /// The worktree label this pull ran under the canonical id of (`redirectedFrom`).
    alias_of: Option<String>,
    /// The ensure creates the registration.
    create: bool,
    /// The descriptor is stranded in the legacy bucket of the caller's project: it is moved first, under the lock.
    rehome: bool,
}

/// What `pullOnce` reports: the fields `inbox pull` prints.
#[derive(Debug, Default, Clone)]
pub(crate) struct PullRes {
    pub ok: bool,
    pub locked: bool,
    pub imported: usize,
    pub duplicate: usize,
    pub native_count: f64,
    pub lost: f64,
    pub native_timeout: bool,
    pub error: Option<String>,
}

impl PullRes {
    fn failed(locked: bool, error: String) -> PullRes {
        PullRes { ok: false, locked, error: Some(error), ..PullRes::default() }
    }
}

/// What the pull reports to its caller.
#[derive(Debug, Default)]
pub(crate) struct Outcome {
    /// `walBlocked`: the delivery log cannot be written, so mail may be waiting that the count cannot see.
    pub wal_blocked: bool,
    /// What `pullOnce` returned.
    pub res: PullRes,
    /// The result Node's ensure refused with (`Object.assign({}, ensured, { action: 'pull', id })`): the pull did not run.
    pub refusal: Option<OVal>,
    /// The worktree label the pull ran under the canonical id of (`redirectedFrom`).
    pub alias_of: Option<String>,
}

/// What the first half of a pull came to: a plan to run, or the result Node's ensure refused with.
pub(crate) enum Prepared {
    /// The pull can run.
    Plan(Box<Plan>),
    /// The ensure refused: this is the whole result (`ok: false`, `action: 'pull'`, `id`, and the refusal's own fields).
    Refused(OVal),
}

/// The words of the call a pull reads (`cmdInboxPull`).
#[derive(Default)]
pub(crate) struct PullArgs<'a> {
    /// `--session`.
    pub session: Option<&'a str>,
    /// `--worktree`, read by the child-label guard only.
    pub worktree_flag: Option<&'a str>,
    /// The reconcile sweep has already run the project-wide fold.
    pub rows_left_by_fold: bool,
}

pub(crate) fn field_str(d: &OVal, key: &str) -> Option<String> {
    match d.get(key) {
        Some(OVal::Str(x)) if !x.is_empty() => Some(x.clone()),
        _ => None,
    }
}

pub(crate) fn text_or_null(d: &OVal, key: &str) -> R<Option<String>> {
    match d.get(key) {
        None | Some(OVal::Null) => Ok(None),
        Some(OVal::Str(t)) => Ok(Some(t.clone())),
        Some(_) => ident::refuse_text("mesh_write.msg_descriptor_field_shape", &[("field", key)]),
    }
}

/// `inboxDefaultPath(home, id)`.
pub(crate) fn inbox_default(home: &Path, id: &str) -> String {
    devswarm_root(home)
        .join(defaults::text("mesh_write.dir_inbox"))
        .join(format!("{id}{}", defaults::text("mesh_write.ndjson_suffix")))
        .to_string_lossy()
        .into_owned()
}

/// `cursorDefaultPath(home, id)`.
pub(crate) fn cursor_default(home: &Path, id: &str) -> String {
    devswarm_root(home)
        .join(defaults::text("mesh_write.dir_cursors"))
        .join(format!("{id}{}", defaults::text("mesh_write.cursor_file_suffix")))
        .to_string_lossy()
        .into_owned()
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

/// A refusal of `cmdInboxPull`: `Object.assign({}, refused, { action: 'pull', id })` (an `action` the refusal already has keeps its
/// place).
fn pull_refusal(id: &str, mut refused: Obj) -> OVal {
    refused.put("action", s(defaults::text("mesh_write.action_pull"))).put("id", s(id));
    refused.done()
}

fn quoted(t: &str) -> String {
    OVal::Str(t.to_string()).stringify()
}

/// `reservedIdToken(id)`: the reserved token an id carries, if any.
fn reserved_token(id: &str) -> Option<String> {
    defaults::list("mesh_write.reserved_id_tokens")
        .iter()
        .find(|t| id.contains(**t))
        .map(|t| (*t).to_string())
        .or_else(|| id.ends_with(defaults::text("mesh_write.reserved_id_suffix")).then(|| defaults::text("mesh_write.reserved_suffix_token").to_string()))
        .or_else(|| (id == defaults::text("mesh_write.reserved_exact_id")).then(|| id.to_string()))
}

/// What `childLabelRefusal` found: the label of a child's worktree is no identity.
struct LabelRefusal {
    id: String,
    resolved_to: Option<String>,
    worktree: Option<String>,
    error: String,
}

impl LabelRefusal {
    /// `Object.assign({ action: 'pull' }, labelRefusal)`.
    fn pull_result(&self) -> OVal {
        let mut o = Obj::default();
        o.put("action", s(defaults::text("mesh_write.action_pull")))
            .put("ok", OVal::Bool(false))
            .put("reason", s(defaults::text("mesh_write.reason_child_label")))
            .put("id", s(&self.id))
            .put("resolvedTo", self.resolved_to.as_deref().map_or(OVal::Null, s))
            .put("worktree", self.worktree.as_deref().map_or(OVal::Null, s))
            .put("error", s(&self.error));
        o.done()
    }
}

/// `childLabelRefusal(id, flags, ctx)`: a `primary-<hash>` label that is a CHILD worktree's, not an identity. `None` (Node's null) for
/// everything else, and on any failure (fail-open).
fn child_label_refusal(inv: &Inv, id: &str, worktree_flag: Option<&str>) -> Option<LabelRefusal> {
    let go = || -> R<Option<LabelRefusal>> {
        let repo_key = ident::repo_key_for_worktree(&inv.cwd)?;
        let rows = match repo_key.as_deref() {
            Some(k) => match tick::open_reader(inv, k)? {
                Some(r) => ident::rows_of(&r.roster().or_else(|e| ident::refuse_text("mesh_write.msg_registry_unreadable", &[("why", &e.to_string())]))?),
                None => Vec::new(),
            },
            None => Vec::new(),
        };
        let row = rows.iter().find(|r| r.id == id);
        let wt = if let Some(w) = row.and_then(|r| r.worktree_path.as_deref()).filter(|w| !w.is_empty()) {
            ident::canonical_worktree_real_path(w)?
        } else if let Some(w) = worktree_flag.filter(|w| ident::canonical_mesh_id(w).ok().flatten().as_deref() == Some(id)) {
            ident::canonical_worktree_real_path(w)?
        } else if ident::caller_identity_detailed(&inv.env, &inv.cwd)?.identity == id {
            ident::resolve_caller_worktree(&inv.cwd)?
        } else {
            None
        };
        let retired_to = crate::meshw::readprimary::read_retired_redirect(inv, id).filter(|r| r != id);
        let label = |resolved_to: Option<String>, worktree: Option<String>, error: String| LabelRefusal { id: id.to_string(), resolved_to, worktree, error };
        let Some(wt) = wt else {
            return Ok(retired_to.map(|to| {
                let error = defaults::render("mesh_write.msg_child_label_retired", &[("id", &quoted(id)), ("to", &quoted(&to))]);
                label(Some(to), None, error)
            }));
        };
        let ic = ident::resolve_context(&wt, false)?;
        if let Some(root) = ic.worktree_root.as_deref()
            && ident::is_primary_checkout(root, ic.main_worktree.as_deref(), &inv.home, &inv.env)?
        {
            return Ok(None);
        }
        let mut kids: Vec<String> = Vec::new();
        for r in rows.iter().filter(|r| !r.id.starts_with(defaults::text("mesh_write.primary_prefix"))) {
            if let Some(rw) = r.worktree_path.as_deref().filter(|x| !x.is_empty())
                && ident::canonical_worktree_real_path(rw)?.as_deref() == Some(wt.as_str())
                && !kids.contains(&r.id)
            {
                kids.push(r.id.clone());
            }
        }
        let app = ident::builder_for_worktree(&inv.home, &inv.env, &wt)?;
        let child_id = match app.filter(|a| kids.contains(&a.id)) {
            Some(a) => Some(a.id),
            None => (kids.len() == 1).then(|| kids[0].clone()),
        }
        .or(retired_to);
        if child_id.is_none() {
            // the label is still the only identity that worktree has (legacy children): allowed, except from the Primary checkout
            let caller_root = ident::resolve_context(&inv.cwd, true)?.worktree_root;
            let from_primary = match caller_root {
                Some(root) if root != wt => {
                    let c = ident::resolve_context(&root, false)?;
                    ident::is_primary_checkout(&root, c.main_worktree.as_deref(), &inv.home, &inv.env)?
                }
                _ => false,
            };
            if !from_primary {
                return Ok(None);
            }
        }
        let hint = match &child_id {
            Some(c) => defaults::render("mesh_write.msg_child_label_use", &[("child", &quoted(c))]),
            None => defaults::text("mesh_write.msg_child_label_unregistered").to_string(),
        };
        let error = defaults::render("mesh_write.msg_child_label", &[("id", &quoted(id)), ("worktree", &wt.as_str()), ("hint", &hint)]);
        Ok(Some(label(child_id, Some(wt), error)))
    };
    go().ok().flatten()
}

/// The first half of the plan: the ensure (what the descriptor, the registry and the summary become), decided without writing. The
/// tick counts over [`Plan::ensured`], which is the descriptor Node's count reads after its own ensure ([`prepare_ex`] is the entry).

/// [`prepare_ex`] for the reconcile sweep, which has already run the project-wide fold: another registry row on the workspace's worktree
/// is then one the fold deliberately LEFT (its descriptor, a live reader or a heartbeat anchors it; nothing may retire it), so it does
/// not stop the pull.
pub(crate) fn prepare_swept(inv: &Inv, id: &str, desc: Option<&OVal>) -> Result<Plan, Held> {
    let prepared = prepare_ex(inv, id, desc, &PullArgs { rows_left_by_fold: true, ..PullArgs::default() }).map_err(|d| Held(d.0))?;
    plan_or_held(prepared)
}

/// Why the reconcile sweep leaves a workspace's pull undone: a decision that keeps durable data in place (a refused ensure, a
/// delivery log another reader or a spill holds), reported by its reason. Never a hand-off to Node: the workspace stays as it is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Held(pub String);

/// The sweep stages a plan or hands the workspace back: a refusal of the ensure is the reason it was not drained.
fn plan_or_held(p: Prepared) -> Result<Plan, Held> {
    match p {
        Prepared::Plan(p) => Ok(*p),
        Prepared::Refused(o) => {
            let why = defaults::list("mesh_write.refusal_fields").iter().find_map(|k| field_str(&o, k)).unwrap_or_else(|| defaults::text("mesh_write.action_pull").to_string());
            Err(Held(why))
        }
    }
}

/// `cmdInboxPull`'s first half: the child-label guard, then `cmdRegister(id, flags, ctx, { requireNew: true })` (the ensure), decided
/// without writing. Everything Node refuses is [`Prepared::Refused`]; a descriptor field of a type the registry cannot take is refused
/// the same way, naming the field.
pub(crate) fn prepare_ex(inv: &Inv, id_in: &str, desc_in: Option<&OVal>, args: &PullArgs) -> R<Prepared> {
    let mut id = id_in.to_string();
    let mut alias_of: Option<String> = None;
    let relabeled: Option<OVal>;
    let mut desc = desc_in;
    if crate::meshw::heartbeat::is_primary_label(&id)
        && let Some(r) = child_label_refusal(inv, &id, args.worktree_flag)
    {
        match r.resolved_to.clone().filter(|t| idlock::is_safe_id(t)) {
            None => return Ok(Prepared::Refused(r.pull_result())),
            // pull under the child's canonical id
            Some(to) => {
                alias_of = Some(std::mem::replace(&mut id, to));
                relabeled = ident::read_descriptor(&inv.home, &id);
                desc = relabeled.as_ref();
            }
        }
    }
    let id = id.as_str();
    let refuse = |o: Obj| Ok(Prepared::Refused(pull_refusal(id, o)));
    let wt = ident::resolve_caller_worktree(&inv.cwd)?.unwrap_or_else(|| inv.cwd.clone());
    let (verdict, cache) = appdb::archived_verdict(&inv.home, &inv.env, inv.now, id, Some(&wt), true)?;
    if verdict == Some(true) {
        let mut o = Obj::default();
        o.put("ok", OVal::Bool(false))
            .put("action", s("app-archived-skip"))
            .put("id", s(id))
            .put("archived", OVal::Bool(true))
            .put("appArchived", OVal::Bool(true))
            .put("reason", s(&defaults::render("mesh_write.msg_pull_app_archived", &[("id", &id)])));
        return refuse(o);
    }
    let ctx = ident::resolve_context(&inv.cwd, true)?;
    // a submodule context keys on its outermost superproject (ident::resolve_context), which Node does too; the kind is only a label
    let current_key = ctx.repo_key.clone();
    // outside a project the legacy per-id bucket is the owner key (`repoKeyForCwd(ctx) || hashFromWorkspaceId(id)`)
    let current = current_key.clone().unwrap_or_else(|| crate::meshw::send::hash_from_workspace_id(id));
    let owner_key = defaults::text("mesh_write.field_owner_key");
    let wt_field = defaults::text("mesh_write.field_worktree_path");
    let fresh = |d: &OVal| -> R<Option<String>> {
        match union::path_field(d, wt_field)? {
            Some(w) => ident::repo_key_for_worktree(&w),
            None => Ok(None),
        }
    };
    let create = desc.is_none();
    let mut rehome = false;
    let (ensured, rewrite_descriptor) = match desc {
        Some(desc) => {
            let hash_key = crate::meshw::send::hash_from_workspace_id(id);
            if let Some(reg) = crate::meshw::inbox::registered_repo_key(desc, id)?
                && Some(reg.as_str()) != current_key.as_deref()
            {
                return refuse(project_mismatch(id, &reg, current_key.as_deref()));
            }
            let mut stored_owner = field_str(desc, owner_key);
            // a descriptor stranded in the legacy bucket of a project that now resolves is moved into it first (under the lock)
            if let Some(cur) = current_key.as_deref()
                && stored_owner.as_deref() == Some(hash_key.as_str())
                && hash_key != cur
            {
                rehome = true;
                stored_owner = Some(cur.to_string());
            }
            let proven = match stored_owner.clone() {
                Some(k) => Some(k),
                None => match field_str(desc, defaults::text("mesh_write.field_repo_key")) {
                    Some(k) => Some(k),
                    None => fresh(desc)?,
                },
            };
            let active_legacy_per_id = stored_owner.is_none() && proven.is_none() && current_key.is_none();
            if (proven.is_none() && !active_legacy_per_id) || proven.as_deref().is_some_and(|p| p != current) {
                return refuse(not_ours());
            }
            // the descriptor as the ensure leaves it (`Object.assign({}, existing)`: an own `__proto__` key is not copied)
            let mut ensured = match desc {
                OVal::Obj(fields) => OVal::Obj(fields.iter().filter(|(k, _)| k != "__proto__").cloned().collect()),
                other => other.clone(),
            };
            if rehome {
                ensured.set(owner_key, s(&current));
            }
            if stored_owner.is_none() {
                ensured.set(owner_key, s(&current));
            }
            if current_key.is_some() && fresh(&ensured)?.as_deref() == Some(current.as_str()) {
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
                    return refuse(malformed(id, key));
                }
            }
            let rewrite = ensured.stringify() != desc.stringify();
            (ensured, rewrite)
        }
        None => {
            // the auto-ensure CREATES the registration: refused ids, an archived twin and a cross-project worktree are refused
            if let Some(token) = reserved_token(id) {
                let mut o = Obj::default();
                o.put("ok", OVal::Bool(false))
                    .put("id", s(id))
                    .put("reason", s(defaults::text("mesh_write.reason_reserved_id_token")))
                    .put("error", s(&defaults::render("mesh_write.msg_reserved_id", &[("id", &quoted(id)), ("token", &quoted(&token))])));
                return refuse(o);
            }
            let archived =
                devswarm_root(&inv.home).join(defaults::text("mesh_write.dir_archived")).join(format!("{id}{}", defaults::text("mesh_write.json_suffix")));
            if archived.exists() && archived_is_same_workspace(&archived, &wt) {
                let mut o = Obj::default();
                o.put("ok", OVal::Bool(false))
                    .put("action", s("archived-skip"))
                    .put("id", s(id))
                    .put("archived", OVal::Bool(true))
                    .put("reason", s(&defaults::render("mesh_write.msg_pull_archived_skip", &[("id", &id)])));
                return refuse(o);
            }
            // buildDescriptorFromFlags(id, { worktree, session, inbox, cursor }, null, env): keys in Node's order
            let session = args
                .session
                .filter(|v| !v.is_empty())
                .map(str::to_string)
                .or_else(|| inv.env.get(defaults::text("mesh_write.env_builder_id")).filter(|b| !b.is_empty()).cloned())
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
            if let (Some(cur), Some(wk)) = (current_key.as_deref(), worktree_key.as_deref())
                && wk != cur
            {
                let mut o = Obj::default();
                o.put("ok", OVal::Bool(false)).put(
                    "error",
                    s(&defaults::render(
                        "mesh_write.msg_cross_project_register",
                        &[("worktree", &quoted(&ident::resolve_abs(&wt))), ("worktree_key", &wk), ("current", &cur)],
                    )),
                );
                return refuse(o);
            }
            if worktree_key.is_some() && worktree_key == current_key {
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
    let text = |key: &str| -> Result<Option<String>, String> {
        match ensured.get(key) {
            None | Some(OVal::Null) => Ok(None),
            Some(OVal::Str(t)) => Ok(Some(t.clone())),
            Some(_) => Err(key.to_string()),
        }
    };
    let row = match (
        text(wt_field),
        text(defaults::text("mesh_write.field_session_id")),
        text(defaults::text("mesh_write.field_inbox_path")),
        text(defaults::text("mesh_write.field_cursor_path")),
    ) {
        (Ok(worktree_path), Ok(session_id), Ok(inbox_path), Ok(cursor_path)) => {
            RegistryRow { id: id.to_string(), worktree_path, session_id, inbox_path, cursor_path, nudge_command: nudge }
        }
        (Err(f), ..) | (_, Err(f), ..) | (_, _, Err(f), _) | (.., Err(f)) => return refuse(malformed(id, &f)),
    };
    // the registry store: the caller's project (else the id's legacy bucket); the pull feeds the store of the worktree it stands in
    let store = crate::meshw::common::open_store(inv, &current)?;
    summary::check(&store, inv, None)?;
    let declare = if create { plan_declare_ex(inv, &store, id)? } else { Declare::default() };
    let pull_repo = ident::repo_key_for_worktree(&wt)?.unwrap_or_else(|| crate::meshw::send::hash_from_workspace_id(id));
    let feed = if pull_repo == current { None } else { Some((pull_repo.clone(), crate::meshw::common::open_store(inv, &pull_repo)?)) };
    let wctx = ident::resolve_context(&wt, false)?;
    // a submodule context keys on its outermost superproject (ident::resolve_context), which Node does too; the kind is only a label
    let sender = ident::primary_workspace_id(wctx.main_worktree.as_deref().unwrap_or(&wt)).ok().filter(|x| idlock::is_safe_id(x));
    let root = devswarm_root(&inv.home);
    let wal_file = wal::wal_path(&root, defaults::text("mesh_write.pull_wal_kind"), id);
    let lock_file = root.join(defaults::text("mesh_write.dir_locks")).join(format!(
        "{}{id}{}",
        defaults::text("mesh_write.pull_file_prefix"),
        defaults::text("mesh_write.lock_suffix")
    ));
    let inbox = PathBuf::from(field_str(&ensured, defaults::text("mesh_write.field_inbox_path")).unwrap_or_default());
    Ok(Prepared::Plan(Box::new(Plan {
        id: id.to_string(),
        ensured,
        rewrite_descriptor,
        row,
        repo_key: current,
        store,
        feed,
        cache,
        sender,
        cwd: wt,
        inbox,
        wal: wal_file,
        lock_file,
        declare: declare.puts,
        pending: Vec::new(),
        peek: Peek::NotAsked,
        peek_error: (String::new(), false),
        import_first: declare.import,
        retire_worktree: desc_wt.filter(|_| !args.rows_left_by_fold),
        alias_of,
        create,
        rehome,
    })))
}

/// `projectContextMismatch(id, registeredKey, callerKey, tail)` of an ensure.
fn project_mismatch(id: &str, registered: &str, caller: Option<&str>) -> Obj {
    let mut error = defaults::render("mesh_write.msg_ctx_mismatch_head", &[("id", &quoted(id)), ("registered", &quoted(registered))]);
    match caller {
        Some(c) => error.push_str(&defaults::render("mesh_write.msg_ctx_mismatch_other", &[("caller", &quoted(c))])),
        None => error.push_str(defaults::text("mesh_write.msg_ctx_mismatch_none")),
    }
    error.push_str(" — ");
    error.push_str(defaults::text("mesh_write.msg_ctx_mismatch_ensure_tail"));
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(false))
        .put("id", s(id))
        .put("reason", s(defaults::text("mesh_write.reason_ctx_mismatch")))
        .put("registeredRepoKey", s(registered))
        .put("callerRepoKey", caller.map_or(OVal::Null, s))
        .put("error", s(&error));
    o
}

/// `{ ok: false, error: 'existing descriptor does not belong to the current project' }`.
fn not_ours() -> Obj {
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(false)).put("error", s(defaults::text("mesh_write.msg_ensure_not_ours")));
    o
}

/// A descriptor field of a type the registry cannot take: a native refusal naming it.
fn malformed(id: &str, field: &str) -> Obj {
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(false)).put("error", s(&defaults::render("mesh_write.msg_descriptor_malformed", &[("id", &quoted(id)), ("field", &field)])));
    o
}

/// `archivedCounterpartInfo(...).sameWorkspace === true`: the archived record names the worktree this call stands in.
fn archived_is_same_workspace(archived: &Path, current_worktree: &str) -> bool {
    let Some(d) = ident::read_or_skip(archived, defaults::text("mesh_write.site_pull_descriptor")).and_then(|b| OVal::parse(&String::from_utf8_lossy(&b)))
    else {
        return false;
    };
    let Some(OVal::Str(a)) = d.get(defaults::text("mesh_write.field_worktree_path")).cloned().filter(|v| matches!(v, OVal::Str(s) if !s.is_empty())) else {
        return false;
    };
    if current_worktree.is_empty() {
        return false;
    }
    let a = ident::realpath(&a).unwrap_or(a);
    let c = ident::realpath(current_worktree).unwrap_or_else(|| current_worktree.to_string());
    ident::resolve_abs(&a) == ident::resolve_abs(&c)
}

/// What `readerCursors.declare` does for a registration the ensure creates.
#[derive(Default)]
pub(crate) struct Declare {
    /// The reader rows to write.
    pub puts: Vec<CursorPut>,
    /// The partition has no floor rows yet: the legacy read positions are imported first.
    pub import: bool,
}

/// `readerCursors.declare(store, { partition, reader, home })` for a registration the pull creates: the caller's own `store` and
/// `nd` rows, seeded at the partition's floor (INSERT-if-absent; a retired row of the caller's is revived), at the position a legacy
/// per-instance cursor file maps the caller to. A partition with no floor rows yet is imported first (the rows are planned over the
/// import's result). Declared only for a caller that has a reader identity; where the import is a case only a process table decides,
/// nothing is declared (Node's catch: an undeclared instance simply reads from the floor).
pub(crate) fn plan_declare_ex(inv: &Inv, store: &MeshStore, id: &str) -> R<Declare> {
    let Some(reader) = crate::meshw::cursors::reader_key(tick::reader_nonce_cached(&inv.home).as_deref()) else { return Ok(Declare::default()) };
    // Node's declare is inside a try/catch: a cursor table that cannot be read leaves the instance undeclared (it reads from the floor)
    let Ok(mut rows) = crate::meshw::cursors::rows_of(store, id) else { return Ok(Declare::default()) };
    let import = crate::meshw::cursors::needs_import(&rows);
    if import {
        let mut cx = crate::migrate::readercur::Cx::new(&inv.home.to_string_lossy());
        let Ok(h) = crate::migrate::readercur::open(&inv.home, &store_key_of(inv, id), false) else { return Ok(Declare::default()) };
        let simulated = crate::migrate::readercur::simulate_import(&mut cx, &h, id, &rows);
        if cx.deferred {
            return Ok(Declare::default());
        }
        rows = simulated;
    }
    let short = crate::migrate::readercur::legacy_short_for(&reader);
    let floor = defaults::text("mesh_write.floor_reader");
    let seps = defaults::list("mesh_write.legacy_cursor_seps");
    let mut puts = Vec::new();
    for (i, ns) in defaults::list("mesh_write.cursor_namespaces").into_iter().enumerate() {
        match rows.iter().find(|r| r.ns == ns && r.reader == reader) {
            // the caller is live by definition: a (false) retirement self-heals
            Some(r) if r.retired_line.is_some_and(|l| r.value <= l) => puts.push(CursorPut {
                partition: id.to_string(),
                ns: ns.to_string(),
                reader: reader.clone(),
                value: r.value,
                retired_line: Some(None),
                updated_at: inv.now,
            }),
            Some(_) => {}
            None => {
                let Some(f) = rows.iter().find(|r| r.ns == ns && r.reader == floor) else { continue };
                let sep = if ns == defaults::text("mesh_write.ns_store") { seps.first() } else { seps.get(1) }
                    .copied()
                    .unwrap_or(seps[i.min(seps.len().saturating_sub(1))]);
                let mapped = short
                    .as_deref()
                    .and_then(|sh| crate::migrate::readercur::list_legacy(&inv.home, id, sep).into_iter().find(|(s, _)| s == sh))
                    .map(|(_, v)| v);
                let seed = match mapped {
                    Some(m) if ns == defaults::text("mesh_write.ns_store") => f.value.max(m as i64),
                    Some(m) => m as i64,
                    None => f.value,
                };
                puts.push(CursorPut {
                    partition: id.to_string(),
                    ns: ns.to_string(),
                    reader: reader.clone(),
                    value: seed,
                    retired_line: Some(None),
                    updated_at: inv.now,
                });
            }
        }
    }
    Ok(Declare { puts, import })
}

/// The store key the registry of the caller's project lives under.
fn store_key_of(inv: &Inv, id: &str) -> String {
    ident::resolve_context(&inv.cwd, true).ok().and_then(|c| c.repo_key).unwrap_or_else(|| crate::meshw::send::hash_from_workspace_id(id))
}

/// [`plan_declare_ex`] for a caller that cannot import first: a partition that needs the import declares nothing.
pub(crate) fn plan_declare(inv: &Inv, store: &MeshStore, id: &str) -> R<Vec<CursorPut>> {
    let d = plan_declare_ex(inv, store, id)?;
    Ok(if d.import { Vec::new() } else { d.puts })
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

    /// The store the pull feeds (the worktree it stands in), and its key.
    fn feed_store(&self) -> &MeshStore {
        self.feed.as_ref().map_or(&self.store, |(_, s)| s)
    }

    fn feed_key(&self) -> &str {
        self.feed.as_ref().map_or(self.repo_key.as_str(), |(k, _)| k.as_str())
    }

    /// The delivery-log half of the plan the reconcile sweep stages with: the open batches this pull will replay, and the states of the
    /// log it hands back (spilled batches, another reader's open batches). Still without writing. The pull itself does not stop on
    /// these: it absorbs a spill and adopts a foreign log under that reader's lock (see `pull_locked`).
    pub(crate) fn check_wal(&mut self, inv: &Inv) -> Result<(), Held> {
        let root = devswarm_root(&inv.home);
        self.pending = match wal::pending(&self.wal) {
            Ok(p) => p,
            Err(_) => return Err(Held(defaults::text("mesh_write.held_wal_unreadable").into())),
        };
        if wal::spilled(&self.wal) > 0 {
            return Err(Held(defaults::text("mesh_write.held_wal_spilled").into()));
        }
        let worktree = field_str(&self.ensured, defaults::text("mesh_write.field_worktree_path")).unwrap_or_else(|| self.cwd.clone());
        if foreign_open_batches(&root, &self.wal, &worktree) {
            return Err(Held(defaults::text("mesh_write.held_wal_foreign").into()));
        }
        Ok(())
    }

    /// The second half: what `pullOnce` will find (the lock and the native count), still without writing.
    pub(crate) fn finish(mut self, inv: &Inv, _store_unread: usize, _line_form: bool) -> R<Plan> {
        let busy = nodelock::held_by_other(&self.lock_file.to_string_lossy(), pull_lock_params());
        if busy {
            return Ok(self);
        }
        let c = hivecontrol::call_in(
            &defaults::list("mesh_write.hc_message_count"),
            &inv.env,
            Some(&inv.cwd),
            defaults::millis("mesh_write.hivecontrol_timeout_ms"),
        );
        self.peek = if c.ok { Peek::Count(parse_count(&c.raw)) } else { Peek::Failed };
        if !c.ok {
            self.peek_error = (c.error.clone(), c.timed_out);
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

pub(crate) fn write_descriptor(inv: &Inv, id: &str, d: &OVal) -> std::io::Result<()> {
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
pub(crate) fn precreate(d: &OVal) {
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
}

/// The hashes the inbox already holds (`collectExistingHashes`): the embedded content hash of each line; a torn line is skipped.
/// `Err` for an inbox that is no regular file (a FIFO would block the append that follows) or is over the read cap.
fn inbox_hashes(inbox: &Path) -> Result<std::collections::HashSet<String>, String> {
    let mut seen = std::collections::HashSet::<String>::new();
    let bytes = ident::read_bounded(inbox).map_err(|e| e.0)?;
    if let Some(bytes) = bytes {
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
    Ok(seen)
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
    // the registered workspace checked out under a message's branch is its sender (a child's queue keeps the Primary's id)
    let registry = if batch.messages.is_empty() { Vec::new() } else { import::registry_pairs(p.feed_store().reader()) };
    let scope = import::hash_scope(p.feed_store().reader(), &p.id);
    for m in &batch.messages {
        let h = import::message_hash(&scope, m);
        // an inbox line written under the partition-id hash (before the label-scoped one) is the same message
        if seen.contains(&h) || import::legacy_hash(&scope, &p.id, m).is_some_and(|l| seen.contains(&l)) {
            duplicate += 1;
            continue;
        }
        seen.insert(h.clone());
        let mut o = Obj::default();
        o.put(defaults::text("mesh_write.row_hash_field"), s(&h));
        for k in defaults::list("mesh_write.row_fields") {
            o.put(k, pick(m, k));
        }
        let resolved = match m.get(defaults::text("devswarm_ingest.from_branch_key")) {
            None | Some(OVal::Null) => None,
            Some(b) => import::branch_sender(&registry, &import::js_string(b)),
        };
        o.put(defaults::text("mesh_write.row_sender_field"), resolved.or_else(|| p.sender.clone()).as_deref().map_or(OVal::Null, s));
        lines.push_str(&o.done().stringify());
        lines.push('\n');
        imported += 1;
    }
    (lines, imported, duplicate)
}

/// What ingesting `raws` in order (the open batches, then the new one) would make of the LAST one: its imported and duplicate
/// counts and the number of messages it parsed, without writing.
pub(crate) fn preview(p: &Plan, raws: &[&str]) -> (usize, usize, usize) {
    let mut seen = inbox_hashes(&p.inbox).unwrap_or_default();
    let mut last = (0, 0, 0);
    for raw in raws {
        let batch = import::parse_batch(raw);
        let (_, imported, duplicate) = batch_lines(p, &batch, &mut seen);
        last = (imported, duplicate, batch.messages.len());
    }
    last
}

/// `ingestRaw(raw)`: parse one raw native batch, append the new rows to the durable inbox (idempotent by the embedded content
/// hash) and fsync it, then the best-effort store feed. `Err` when the durable append fails (the WAL entry then stays pending).
fn ingest_raw(inv: &Inv, p: &Plan, raw: &str, at: &dyn Fn(&str)) -> Result<Ingested, String> {
    let batch = import::parse_batch(raw);
    let mut seen = inbox_hashes(&p.inbox).inspect_err(|why| {
        crate::metrics::bump("mesh_descriptor_read_skipped", &[("site", defaults::text("mesh_write.site_pull_inbox")), ("reason", why.as_str())]);
    })?;
    let before = seen.clone();
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
    // the store parity feed: best effort, as in Node (`try { ... } catch (_) {}`). A message whose time is a form `Date.parse`
    // accepts but the port does not reproduce is stored at the import time (`import::rows`' fallback); its body and hash are the
    // message's own, so the row is never lost or doubled and the batch closes like any other.
    let fallbacks = import::rows(&p.id, &import::hash_scope(p.feed_store().reader(), &p.id), &batch, inv.now).iter().filter(|r| r.ts_fallback).count();
    if fallbacks > 0 {
        crate::metrics::bump("mesh_pull_ts_fallback", &[]);
    }
    if import::ingest_payload_seen(p.feed_store(), &inv.home, &p.id, raw, inv.now, &before).is_ok()
        && let Some(why) = summary::derive_after_write(p.feed_store(), inv, p.feed_key())
    {
        crate::meshw::log_summary_failure(defaults::text("mesh_write.verb_inbox"), &why);
    }
    Ok(Ingested { imported, duplicate, parsed: batch.messages.len() })
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
    // the id-collision guard: an ensure over an existing registration may not move the id to another worktree (Node skips that write
    // and says so on stderr); a registration the ensure creates may
    let same = |a: &str, b: &str| a == b || ident::realpath(a).is_some_and(|x| ident::realpath(b) == Some(x));
    let upserted = if p.create { p.store.upsert_registry(&p.row, inv.now, |_, _| true) } else { p.store.upsert_registry(&p.row, inv.now, same) };
    if upserted.is_err() {
        return false;
    }
    // a created registration declares the caller as a reader of the partition (best effort: an undeclared instance reads
    // from the floor); a partition without floor rows imports the legacy read positions first
    if p.import_first {
        let mut cx = crate::migrate::readercur::Cx::new(&inv.home.to_string_lossy());
        let cursor = field_str(&p.ensured, defaults::text("mesh_write.field_cursor_path"));
        if let Ok(h) = crate::migrate::readercur::open(&inv.home, &p.repo_key, false) {
            crate::discard::harmless(crate::migrate::readercur::import_legacy(&mut cx, &h, &p.id, cursor.as_deref(), false)); // keep: Node's `catch (_) { /* fail-soft */ }`
        }
    }
    if !p.declare.is_empty() {
        crate::discard::harmless(p.store.reader_cursor_txn(&p.declare)); // keep: Node's `catch (_) { /* fail-soft */ }`
    }
    if let Some(why) = summary::derive_after_write(&p.store, inv, &p.repo_key) {
        crate::meshw::log_summary_failure(defaults::text("mesh_write.verb_inbox"), &why);
    }
    true
}

/// `retireWorktreeDuplicates(home, desc, ctx)` after the ensure: another registry row of the same physical worktree is folded into this
/// id, its unread mail forwarded first. Fail-open, as Node's catch is, and the lock is not held (the fold takes the partitions' own).
fn retire_duplicates(inv: &Inv, p: &Plan) {
    let Some(wt) = p.retire_worktree.as_deref() else { return };
    if !crate::meshw::lifeverbs::has_duplicate_rows(inv, &p.repo_key, &p.id, Some(wt)).unwrap_or(false) {
        return;
    }
    let st = inv.settings();
    let ctx = crate::dssup::tick::Ctx { home: &inv.home, root: &inv.home, st: &st, now: inv.now, engine_pokes: false };
    let runner = crate::dsact::runner::System::configured();
    let hooks = crate::dssup::recon::Hooks { at: &|_| {} };
    crate::discard::harmless(crate::dssup::recon::dup::retire_worktree_duplicates(&ctx, &runner, &inv.cwd, &p.id, wt, &hooks).map(|_| ())); // keep: Node's catch returns null
}

/// `withSelfHeal`'s heal, which runs before the pull: Node's `selfHeal` never throws, so a heal that cannot be settled adds nothing. An
/// attempt is recorded (the cooldown file) and is the first write of the call. The fields are added to the pull's result.
pub(crate) fn heal_first(inv: &Inv) -> Vec<(String, OVal)> {
    let heal = crate::meshw::common::self_heal(inv).unwrap_or_default();
    if heal.iter().any(|(k, _)| k == defaults::text("mesh_write.heal_attempted_key")) {
        crate::meshw::mark_committed();
        crate::meshw::common::self_heal_mark(inv, &heal);
    }
    heal
}

/// The ensure's writes and then `pullOnce`: the workspace's lock is taken first (`cmdRegister` fails closed on a lock that stays
/// busy, and the pull does not run).
pub(crate) fn execute(inv: &Inv, p: Plan) -> R<Outcome> {
    let Some(id_lock) = idlock::acquire(&inv.home, &p.id) else {
        let mut o = Obj::default();
        o.put("ok", OVal::Bool(false))
            .put("lockBusy", OVal::Bool(true))
            .put("id", s(&p.id))
            .put("error", s(&defaults::render("mesh_write.msg_id_lock_busy", &[("id", &quoted(&p.id))])));
        let refusal = pull_refusal(&p.id, o);
        let error = field_str(&refusal, "error").unwrap_or_default();
        return Ok(Outcome { res: PullRes::failed(false, error), refusal: Some(refusal), alias_of: p.alias_of.clone(), ..Outcome::default() });
    };
    crate::meshw::mark_committed();
    // the descriptor stranded in the legacy bucket of the caller's project is moved first; one that stays there is not ours
    if p.rehome {
        let st = inv.settings();
        let ctx = crate::dssup::tick::Ctx { home: &inv.home, root: &inv.home, st: &st, now: inv.now, engine_pokes: false };
        let from = crate::meshw::send::hash_from_workspace_id(&p.id);
        crate::dssup::recon::rehome::across_stores_locked(&ctx, &p.id, &from, &p.repo_key);
        let owner = ident::read_descriptor(&inv.home, &p.id).and_then(|d| field_str(&d, defaults::text("mesh_write.field_owner_key")));
        if owner.as_deref() != Some(p.repo_key.as_str()) {
            id_lock.release();
            let refusal = pull_refusal(&p.id, not_ours());
            let error = field_str(&refusal, "error").unwrap_or_default();
            return Ok(Outcome { res: PullRes::failed(false, error), refusal: Some(refusal), alias_of: p.alias_of.clone(), ..Outcome::default() });
        }
    }
    // ---- the ensure, under the workspace lock (a failure skips the pull, as Node's catch around it does) ----
    let ensured = ensure_locked(inv, &p);
    id_lock.release();
    if ensured {
        retire_duplicates(inv, &p);
    }
    if !ensured {
        return Ok(Outcome {
            res: PullRes::failed(false, defaults::text("mesh_write.msg_pull_ensure_failed").into()),
            alias_of: p.alias_of.clone(),
            ..Outcome::default()
        });
    }
    let mut out = pull_once(inv, &p);
    out.alias_of = p.alias_of.clone();
    Ok(out)
}

/// `pullOnce`: one bounded, guard-safe drain of the child's native queue into its durable inbox.
fn pull_once(inv: &Inv, p: &Plan) -> Outcome {
    let none = Outcome { res: PullRes::failed(false, defaults::text("mesh_write.msg_pull_lock_held").into()), ..Outcome::default() };
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
/// destructive read. `Err` when an ingest or a close failed: the rest
/// stays pending and nothing further is read.
pub(crate) fn replay_pending(inv: &Inv, p: &Plan, at: &dyn Fn(&str)) -> Result<(), ()> {
    for entry in &p.pending {
        let Ok(r) = ingest_raw(inv, p, &entry.raw, at) else { return Err(()) };
        let raw_t = js_trim(&entry.raw);
        let empty = r.parsed == 0 && !raw_t.is_empty() && raw_t != defaults::text("mesh_write.empty_array");
        at("close:before");
        let closed = if empty {
            wal::close_batch(
                &p.wal,
                &entry.e,
                defaults::text("mesh_write.wal_quarantine"),
                &format!("\"reason\":\"{}\"", defaults::text("mesh_write.wal_reason_unparseable")),
                inv.now,
            )
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
    /// The text is what the call said: its exit code and the first line it printed (see [`hivecontrol::failure_detail`]).
    CountFailed(String),
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
    // hivecontrol names the workspace by the directory it runs in, so the call stands in the workspace's own checkout (a daemon's
    // working directory is no git repository: "Not in a git repository")
    let full =
        hivecontrol::call_full(&defaults::list("mesh_write.hc_message_count"), &inv.env, Some(&inv.cwd), defaults::millis("mesh_write.hivecontrol_timeout_ms"));
    if !full.call.ok {
        return Fresh::CountFailed(hivecontrol::failure_detail(&full));
    }
    let c = full.call;
    let native = parse_count(&c.raw);
    if native <= 0.0 {
        return Fresh::Empty;
    }
    let r = hivecontrol::call_in(&defaults::list("mesh_write.hc_read_messages"), &inv.env, Some(&inv.cwd), defaults::millis("mesh_write.pull_read_timeout_ms"));
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

/// The workspace descriptor `<id>.json`, parsed; `None` when it is absent, unparsable or a file a read must not touch.
fn read_descriptor(home: &Path, id: &str) -> Option<OVal> {
    let file = devswarm_root(home).join(defaults::text("mesh_write.dir_workspaces")).join(format!("{id}{}", defaults::text("mesh_write.json_suffix")));
    ident::read_or_skip(&file, defaults::text("mesh_write.site_pull_descriptor")).and_then(|b| OVal::parse(&String::from_utf8_lossy(&b)))
}

/// The code Node names for an I/O error on a delivery log.
fn io_code(e: &std::io::Error) -> String {
    match e.raw_os_error() {
        Some(libc::EACCES) => "EACCES".to_string(),
        Some(libc::EISDIR) => "EISDIR".to_string(),
        Some(libc::ENOTDIR) => "ENOTDIR".to_string(),
        Some(libc::EIO) => "EIO".to_string(),
        _ => defaults::text("mesh_write.store_unknown_code").to_string(),
    }
}

/// `readWal.adoptForWorktree(F, home, 'pull', worktree, wal, lockFor)`: open batches left by a PRIOR reader key of the same worktree.
/// A foreign log is adopted only when EVERY open batch in it names this worktree, and only by CLAIMING it (an atomic rename into
/// `wal/adopted/<self>/`) while holding that reader's own pull lock (a busy reader is skipped this round). Logs claimed earlier that
/// still hold open batches (an adopter that crashed mid-replay) are returned again.
fn adopt_foreign(inv: &Inv, p: &Plan, worktree: &str) -> Vec<(PathBuf, wal::Open)> {
    if worktree.is_empty() {
        return Vec::new();
    }
    let root = devswarm_root(&inv.home);
    let dir = root.join(defaults::text("devswarm_ingest.dir_wal"));
    let suffix = defaults::text("devswarm_ingest.wal_suffix");
    let prefix = defaults::text("mesh_write.pull_file_prefix");
    let stem = p.wal.file_stem().map(|x| x.to_string_lossy().into_owned()).unwrap_or_default();
    let adopted = dir.join(defaults::text("devswarm_ingest.dir_adopted")).join(&stem);
    let mut names: Vec<String> = std::fs::read_dir(&dir).into_iter().flatten().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    for n in names {
        if !n.starts_with(prefix) || !n.ends_with(suffix) {
            continue;
        }
        let file = dir.join(&n);
        if file == p.wal {
            continue;
        }
        let Ok(open) = wal::pending(&file) else { continue };
        if open.is_empty() || !open.iter().all(|b| b.worktree.as_deref() == Some(worktree)) {
            continue;
        }
        let base = n.trim_end_matches(suffix);
        let reader_id = base.strip_prefix(prefix).unwrap_or(base);
        let reader_lock = root.join(defaults::text("mesh_write.dir_locks")).join(format!("{prefix}{reader_id}{}", defaults::text("mesh_write.lock_suffix")));
        let Some(held) = nodelock::acquire_stale_unless_live(&reader_lock.to_string_lossy(), pull_lock_params()) else { continue };
        if std::fs::create_dir_all(&adopted).is_ok() {
            crate::discard::harmless(std::fs::rename(&file, adopted.join(format!("{base}.{}.{}{suffix}", inv.now, std::process::id())))); // keep: ENOENT means another adopter won the claim
        }
        held.release();
    }
    let mut claimed: Vec<PathBuf> =
        std::fs::read_dir(&adopted).into_iter().flatten().flatten().map(|e| e.path()).filter(|f| f.to_string_lossy().ends_with(suffix)).collect();
    claimed.sort();
    let mut out = Vec::new();
    for file in claimed {
        if let Ok(open) = wal::pending(&file) {
            out.extend(open.into_iter().map(|b| (file.clone(), b)));
        }
    }
    out
}

/// Ingest and close every open batch, in order, each in the log it was found in. `Err` names why one failed: it stays pending and
/// nothing further is read.
fn replay_entries(inv: &Inv, p: &Plan, entries: &[(PathBuf, wal::Open)]) -> Result<(), String> {
    for (file, b) in entries {
        let r = ingest_raw(inv, p, &b.raw, &|_| {})?;
        let raw_t = js_trim(&b.raw);
        let empty = r.parsed == 0 && !raw_t.is_empty() && raw_t != defaults::text("mesh_write.empty_array");
        let closed = if empty {
            wal::close_batch(
                file,
                &b.e,
                defaults::text("mesh_write.wal_quarantine"),
                &format!("\"reason\":\"{}\"", defaults::text("mesh_write.wal_reason_unparseable")),
                inv.now,
            )
        } else {
            wal::close_batch(
                file,
                &b.e,
                defaults::text("mesh_write.wal_done"),
                &format!("\"imported\":{},\"duplicate\":{},\"into\":{}", r.imported, r.duplicate, OVal::Str(p.id.clone()).stringify()),
                inv.now,
            )
        };
        closed.map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn pull_locked(inv: &Inv, p: &Plan) -> Outcome {
    // the descriptor is read again, as Node does (the ensure has written it)
    let Some(desc) = read_descriptor(&inv.home, &p.id) else {
        let id = OVal::Str(p.id.clone()).stringify();
        return Outcome { res: PullRes::failed(true, defaults::render("mesh_write.msg_pull_no_descriptor", &[("id", &id)])), ..Outcome::default() };
    };
    let worktree = field_str(&desc, defaults::text("mesh_write.field_worktree_path")).unwrap_or_else(|| p.cwd.clone());
    // FAIL CLOSED, step 1: batches spilled when the log was unwritable go back into a writable log before anything else
    if let Err(why) = wal::absorb_spill(&p.wal, inv.now) {
        let msg = defaults::render("mesh_write.msg_wal_spill_blocked", &[("why", &why), ("dir", &wal::spill_dir(&p.wal).display())]);
        return Outcome { wal_blocked: true, res: PullRes::failed(true, msg), ..Outcome::default() };
    }
    // REPLAY FIRST: every batch a previous pull captured but never closed (in this log, or in the log of a prior reader of the same
    // worktree, adopted under that reader's lock) is ingested before any new destructive read
    let mut entries: Vec<(PathBuf, wal::Open)> = match wal::pending(&p.wal) {
        Ok(open) => open.into_iter().map(|b| (p.wal.clone(), b)).collect(),
        Err(e) => {
            let msg = defaults::render("mesh_write.msg_wal_unreadable", &[("code", &io_code(&e)), ("wal", &p.wal.display())]);
            return Outcome { wal_blocked: true, res: PullRes::failed(true, msg), ..Outcome::default() };
        }
    };
    entries.extend(adopt_foreign(inv, p, &worktree));
    if let Err(why) = replay_entries(inv, p, &entries) {
        return Outcome { res: PullRes::failed(true, defaults::render("mesh_write.msg_wal_replay_failed", &[("why", &why)])), ..Outcome::default() };
    }
    // FAIL CLOSED: never a destructive read into a WAL that cannot be appended and fsynced right now
    if let Some(why) = wal::preflight(&p.wal) {
        let msg = defaults::render("mesh_write.msg_pull_wal_unwritable", &[("why", &why), ("wal", &p.wal.display())]);
        return Outcome { wal_blocked: true, res: PullRes::failed(true, msg), ..Outcome::default() };
    }
    let native = match p.peek {
        Peek::Count(n) => n,
        Peek::Failed | Peek::NotAsked => {
            let (error, timed_out) = &p.peek_error;
            let error = if error.is_empty() { defaults::text("mesh_write.msg_pull_count_failed").to_string() } else { error.clone() };
            let timed_out = *timed_out || regex::Regex::new(defaults::text("mesh_write.pull_timeout_re")).is_ok_and(|re| re.is_match(&error));
            return Outcome { res: PullRes { native_timeout: timed_out, ..PullRes::failed(true, error) }, ..Outcome::default() };
        }
    };
    if native <= 0.0 {
        wal::maybe_rotate(&p.wal, inv.now);
        return Outcome { res: PullRes { ok: true, locked: true, ..PullRes::default() }, ..Outcome::default() };
    }
    // ONE bounded read-messages (finite timeout, never monitor)
    let r = hivecontrol::call_in(&defaults::list("mesh_write.hc_read_messages"), &inv.env, Some(&inv.cwd), defaults::millis("mesh_write.pull_read_timeout_ms"));
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
        let error = if r.error.is_empty() { defaults::text("mesh_write.msg_pull_read_failed").to_string() } else { r.error.clone() };
        return Outcome { wal_blocked: wal_error, res: PullRes::failed(true, error), ..Outcome::default() };
    }
    let got = match ingest_raw(inv, p, &r.raw, &|_| {}) {
        Ok(g) => g,
        Err(e) => return Outcome { wal_blocked: wal_error, res: PullRes::failed(true, e), ..Outcome::default() },
    };
    let recovered = (got.imported + got.duplicate) as f64;
    let shortfall = recovered < native;
    if !wal_error {
        // a close that fails leaves the batch pending: the next pull replays it idempotently. An empty read has no entry id and
        // Node closes it as `null` all the same.
        let (kind, extra) = if shortfall {
            (
                defaults::text("mesh_write.wal_quarantine"),
                format!(
                    "\"reason\":\"{}\",\"nativeCount\":{},\"recovered\":{}",
                    defaults::text("mesh_write.wal_reason_shortfall"),
                    to_js_string(native),
                    to_js_string(recovered)
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
                    ("count", &to_js_string(native)),
                    ("recovered", &to_js_string(recovered)),
                    ("lost", &to_js_string(native - recovered)),
                    ("wal", &p.wal.display()),
                    ("entry", &entry.unwrap_or_else(|| defaults::text("mesh_write.js_null").to_string())),
                ]
            )
        );
    }
    let res = if shortfall {
        PullRes {
            ok: false,
            locked: true,
            imported: got.imported,
            duplicate: got.duplicate,
            native_count: native,
            lost: native - recovered,
            ..PullRes::default()
        }
    } else {
        PullRes { ok: !wal_error, locked: true, imported: got.imported, duplicate: got.duplicate, native_count: native, ..PullRes::default() }
    };
    Outcome { wal_blocked: wal_error, res, ..Outcome::default() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::meshw::ident::fifo_kit::*;

    #[test]
    fn a_fifo_inbox_or_descriptor_returns_at_once_instead_of_blocking() {
        let dir = scratch("pull");
        let inbox = dir.join("in.ndjson");
        fifo(&inbox);
        let i = inbox.clone();
        assert!(within("inbox_hashes", move || inbox_hashes(&i).is_err()), "a FIFO inbox is refused, not read and not appended to");
        let home = dir.join("home");
        let ws = devswarm_root(&home).join(defaults::text("mesh_write.dir_workspaces"));
        std::fs::create_dir_all(&ws).unwrap();
        fifo(&ws.join("w1.json"));
        assert!(within("read_descriptor", move || read_descriptor(&home, "w1").is_none()));
        crate::discard::harmless(std::fs::remove_dir_all(dir)); // keep: cleanup of a scratch directory
    }

    #[test]
    fn a_descriptor_field_that_is_not_text_is_the_verbs_own_refusal() {
        let d = OVal::parse(r#"{"sessionId":7,"worktreePath":null,"inboxPath":"/x"}"#).unwrap();
        assert_eq!(text_or_null(&d, "worktreePath").unwrap(), None);
        assert_eq!(text_or_null(&d, "inboxPath").unwrap().as_deref(), Some("/x"));
        let Err(refusal) = text_or_null(&d, "sessionId") else { panic!("a numeric field must be refused") };
        let body = ident::refusal_body(&refusal).expect("a refusal, not a deferral");
        let o = OVal::parse(body).unwrap();
        assert!(matches!(o.get("ok"), Some(OVal::Bool(false))));
        assert!(matches!(o.get("error"), Some(OVal::Str(e)) if e.contains("sessionId")));
    }

    #[test]
    fn a_sweep_hold_names_its_reason_from_the_settings() {
        for k in ["mesh_write.held_wal_unreadable", "mesh_write.held_wal_spilled", "mesh_write.held_wal_foreign"] {
            assert!(!defaults::text(k).is_empty(), "{k}");
        }
    }
}
