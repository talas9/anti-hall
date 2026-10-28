//! `devswarm.js inbox tick <id> [--quiet] [--json] [--child]`, ported from `scripts/devswarm-lib/inbox-cmd.js` `cmdInboxTick` (with the
//! `count` it runs) and `inboxTickQuietLine`.
//!
//! A tick counts the unread mail of a workspace (its NDJSON inbox plus its store partition, see [`crate::meshw::union`]),
//! then writes three small records and prints one line (`--quiet`) or the JSON of the `count` it ran:
//!
//! * the wake-tick marker `wake-tick/<id>.json` (`ts`, `unreadTotal`, `meshGapWithheld`, `known`, the carried-over `seq`);
//! * the heartbeat refresh: `ts`, `state_ts` and `version` of the existing `heartbeats/<id>.json` (a minimal record when
//!   there is none);
//! * the cron-found-mail line, when the tick found unread mail and a wake-watch lock exists.
//!
//! Every shape of the call is answered here, in Node's order. A call Node refuses (a missing or unsafe id, `--since` / `--tail`)
//! prints Node's refusal and exits 2; an id with no inbox gets `count`'s refusal inside the tick's own result; a store that cannot
//! be used (another project, a store that does not open) makes the count `known:false` with the reason, exactly as `count`
//! reports it; the watcher decision (`watcherArmed`: a live lock, `archived-skip`, `idle-skip`, `limit-skip`, or the lapse
//! `false` with its re-arm cue) is [`crate::meshw::tickarm`]'s. There is no Node to hand a verb to, so nothing here defers.
// Discard triage (E3): every `.ok()` / `harmless` / `unwrap_or*` in this file is a deliberate keep, for these reasons:
// - the three records a tick writes are best effort in Node (each in its own try/catch): a failed write is not an error
// - an unreadable optional file is the same as an absent one (Node's try/catch around readFileSync)
// - text that does not parse is the absent value (Node's JSON.parse catch parity)
use crate::checks::guardkit::ojson::OVal;
use crate::checks::guardkit::text::js_number_of_str;
use crate::defaults;
use crate::mesh::MeshReader;
use crate::meshw::args::Args;
use crate::meshw::common::{Inv, Obj, n, s};
use crate::meshw::heartbeat::running_version;
use crate::meshw::ident::{self, Defer, R};
use crate::meshw::idlock::{devswarm_root, is_safe_id};
use crate::meshw::send::{Answer, Effect, rehome_is_noop};
use crate::meshw::tickarm::{self, Armed};
use crate::meshw::union;
use serde_json::Value;
use std::path::{Path, PathBuf};

/// The two forms of the tick: the one line (`--quiet` without `--json`, read from the words themselves as `main()` does) or the JSON
/// of the count; and `--child`, which first pulls the native queue (see [`crate::meshw::pull`]). Any other flag is ignored, as in Node.
struct Form {
    /// `main()` prints the one-line rendering.
    line: bool,
    /// `hasFlag(flags, 'child')`: passed at all, with or without a value.
    child: bool,
}

/// `argv.includes('--<name>')`.
fn word(a: &Args, flag_key: &str) -> bool {
    let want = format!("--{}", defaults::text(flag_key));
    a.raw.contains(&want)
}

fn tick_form(a: &Args) -> Form {
    let quiet = word(a, "mesh_write.flag_quiet");
    let json = word(a, "mesh_write.flag_json");
    Form { line: quiet && !json, child: a.has(defaults::text("mesh_write.flag_child")) }
}

/// A `{ok:false, error}` result of this verb at exit 2, rendered the way `main()` renders it: its JSON, or `ok:false <error>` in the
/// tick's line form.
fn refused(a: &Args, error: &str) -> Answer {
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(false)).put("error", s(error));
    Answer { code: 2, stdout: format!("{}\n", rendered_refusal(a, &o.done())), effect: Effect::None }
}

fn rendered_refusal(a: &Args, result: &OVal) -> String {
    if tick_form(a).line { rendered_refusal_line(result) } else { result.stringify() }
}

/// What opening a project's store came to.
pub(crate) enum Probe {
    /// There is no store yet (Node's `openStore` would create it; a read-only open finds none).
    Missing,
    /// The store.
    Open(MeshReader),
    /// The store exists but cannot be used; the code names why (`storeUnavailableReason`).
    Unreadable(String),
}

/// The error code Node's `e.code` names for an I/O error on the store.
fn io_code(e: &std::io::Error) -> String {
    match e.raw_os_error() {
        Some(libc::EACCES) => "EACCES".to_string(),
        Some(libc::EPERM) => "EPERM".to_string(),
        Some(libc::ENOTDIR) => "ENOTDIR".to_string(),
        Some(libc::EISDIR) => "EISDIR".to_string(),
        Some(libc::EIO) => "EIO".to_string(),
        _ => defaults::text("mesh_write.store_unknown_code").to_string(),
    }
}

/// Open the read-only store of the project the way `openStore` settles it.
pub(crate) fn probe_reader(inv: &Inv, repo_key: &str) -> Probe {
    let dir = union::store_dir(&inv.home, repo_key);
    if !dir.exists() {
        return Probe::Missing;
    }
    let forced = inv.env.get(defaults::text("mesh_write.env_store_backend")).map(|v| v.trim().to_lowercase()).unwrap_or_default();
    if forced != defaults::text("mesh.backend_sqlite") {
        // a store of another backend (the journal) is not one this engine reads: it is reported as unusable, never as empty
        if !forced.is_empty() && forced == defaults::text("mesh_write.backend_journal") {
            return Probe::Unreadable(defaults::text("mesh_write.store_backend_code").to_string());
        }
        let marker = std::fs::read_to_string(dir.join(defaults::text("mesh.backend_marker"))).map(|m| m.trim().to_lowercase()).unwrap_or_default();
        if marker != defaults::text("mesh.backend_sqlite") {
            return Probe::Unreadable(defaults::text("mesh_write.store_backend_code").to_string());
        }
    }
    let db = dir.join(defaults::text("mesh_write.store_file"));
    if !db.exists() {
        return Probe::Missing;
    }
    match MeshReader::open(&db) {
        Ok(r) => Probe::Open(r),
        Err(_) => {
            Probe::Unreadable(std::fs::File::open(&db).err().map_or_else(|| defaults::text("mesh_write.store_unknown_code").to_string(), |e| io_code(&e)))
        }
    }
}

/// Open the read-only store of the project the way `openStore` settles it; `Ok(None)` is a store Node would first create. A store the
/// engine cannot use is a [`Defer`] for the verbs that need a reader (the count reports it as unavailable instead).
pub(crate) fn open_reader(inv: &Inv, repo_key: &str) -> R<Option<MeshReader>> {
    match probe_reader(inv, repo_key) {
        Probe::Missing => Ok(None),
        Probe::Open(r) => Ok(Some(r)),
        Probe::Unreadable(code) => Err(crate::meshw::readprimary::store_err("store-unreadable", code)),
    }
}

/// [`probe_reader`] for a verb whose Node counterpart opens (and so creates) the project's store: a project with no store yet gets a new
/// sqlite one first.
pub(crate) fn probe_reader_creating(inv: &Inv, repo_key: &str) -> Probe {
    match probe_reader(inv, repo_key) {
        Probe::Missing => {
            if let Err(Defer(why)) = crate::meshw::common::open_store(inv, repo_key) {
                return Probe::Unreadable(why);
            }
            probe_reader(inv, repo_key)
        }
        other => other,
    }
}

/// [`open_reader`] for a verb whose Node counterpart opens (and so creates) the project's store. Sweeps that must not create stores
/// use [`open_reader`].
pub(crate) fn open_reader_creating(inv: &Inv, repo_key: &str) -> R<MeshReader> {
    match probe_reader_creating(inv, repo_key) {
        Probe::Open(r) => Ok(r),
        Probe::Missing => Err(Defer::reason("store-create")),
        Probe::Unreadable(code) => Err(crate::meshw::readprimary::store_err("store-unreadable", code)),
    }
}

/// The reader nonce of this process, derived once (it walks the process table): the tick reads it and the background
/// verifier is handed the same value.
pub fn reader_nonce_cached(home: &Path) -> Option<String> {
    static NONCE: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    NONCE.get_or_init(|| ident::reader_nonce(home)).clone()
}

/// The project's open reader and its registry rows, as `resolveWorkspaceStoreForRead` settles them for a read of `id`.
pub(crate) struct Opened {
    /// The directory key of the store (the caller's project, else the legacy per-id bucket).
    pub repo_key: String,
    /// The caller's project key (`repoKey`); none outside a project.
    pub caller: Option<String>,
    /// The read-only store of that project.
    pub reader: MeshReader,
    /// The registry rows.
    pub rows: Vec<ident::Row>,
}

/// Why the store side of a read cannot be used (`storeUnavailable` of `count`): another project's id, a store that does not open, a
/// registry or cursor read that failed. The read still answers from the NDJSON side, and reports the store side as unknown.
#[derive(Debug, Clone)]
pub(crate) struct Unavail {
    /// `project-context-mismatch`, `store-unavailable`, `store-open-failed` or `store-read-error`.
    pub reason: String,
    /// The refusal's text.
    pub error: Option<String>,
    /// The project the id is registered under (`project-context-mismatch`).
    pub registered: Option<String>,
    /// The project the caller's directory resolves to.
    pub caller: Option<String>,
    /// The underlying code (`storeUnavailableReason`).
    pub code: Option<String>,
}

impl Unavail {
    fn of(reason: &str, error: String, code: Option<String>) -> Unavail {
        Unavail { reason: reason.to_string(), error: Some(error), registered: None, caller: None, code }
    }

    /// `isGenuineStoreUnavailableReason`: only a store that could not be opened or read is an outage.
    fn genuine(&self) -> bool {
        self.reason == defaults::text("mesh_write.reason_store_unavailable") || self.reason == defaults::text("mesh_write.reason_store_open_failed")
    }

    /// The detail object (`storeUnavailableDetail`).
    fn detail(&self) -> OVal {
        let opt = |v: &Option<String>| v.as_deref().map_or(OVal::Null, s);
        let mut o = Obj::default();
        o.put("reason", s(&self.reason))
            .put("error", opt(&self.error))
            .put("registeredRepoKey", opt(&self.registered))
            .put("callerRepoKey", opt(&self.caller))
            .put("storeUnavailableReason", opt(&self.code));
        o.done()
    }
}

/// `resolveWorkspaceStoreForRead`'s answer for a read of `id`.
pub(crate) enum PartitionOpen {
    /// The store, ready.
    Open(Opened),
    /// The store side is unusable (the read goes on without it).
    Unavailable {
        /// Why.
        why: Unavail,
        /// The directory key the store lives (or would live) under: the caller's project, else the legacy per-id bucket.
        store_key: String,
        /// The caller's project key (`repoKey` of the result).
        repo_key: Option<String>,
    },
}

/// `cwdInsideRegisteredWorktree(cwd, worktreePath)`: the caller's real directory lies inside the workspace's registered worktree (or
/// that worktree's git toplevel).
fn cwd_inside_registered_worktree(inv: &Inv, desc: &OVal) -> R<bool> {
    let Some(wt) = union::path_field(desc, defaults::text("mesh_write.field_worktree_path"))? else { return Ok(false) };
    let cwd_real = match ident::resolve_context(&inv.cwd, true) {
        Ok(_) => ident::realpath(&inv.cwd).or_else(|| {
            // a deleted cwd stands for its nearest existing ancestor
            let mut d = ident::dirname(&ident::resolve_abs(&inv.cwd));
            loop {
                if let Some(r) = ident::realpath(&d) {
                    break Some(r);
                }
                let up = ident::dirname(&d);
                if up == d {
                    break None;
                }
                d = up;
            }
        }),
        Err(e) => return Err(e),
    };
    let Some(cwd_real) = cwd_real else { return Ok(false) };
    let Some(wt_real) = ident::realpath(&wt) else { return Ok(false) };
    let mut roots = vec![wt_real];
    if let Some(top) = ident::resolve_context(&wt, false)?.toplevel {
        roots.push(top);
    }
    Ok(roots.iter().any(|r| cwd_real == *r || cwd_real.starts_with(&format!("{r}/"))))
}

/// `resolveWorkspaceStoreForRead` for a read of `id`: the caller's project against the id's registered project, then the re-home
/// trigger, then the store and its registry. A refusal or a store that cannot be used is [`PartitionOpen::Unavailable`], as
/// `count` reports it; it is never an error of the verb.
pub(crate) fn open_partition_ex(inv: &Inv, id: &str, desc: &OVal) -> R<PartitionOpen> {
    let mut caller = ident::resolve_context(&inv.cwd, true)?.repo_key;
    let registered = crate::meshw::inbox::registered_repo_key(desc, id)?;
    // an unresolved caller key is not evidence of a different project: inside the workspace's own worktree it reads under the registered key
    if registered.is_some() && caller.is_none() && cwd_inside_registered_worktree(inv, desc)? {
        caller.clone_from(&registered);
    }
    let legacy = crate::meshw::send::hash_from_workspace_id(id);
    if let Some(reg) = registered.as_deref()
        && Some(reg) != caller.as_deref()
    {
        let q = |t: &str| OVal::Str(t.to_string()).stringify();
        let mut error = defaults::render("mesh_write.msg_ctx_mismatch_head", &[("id", &q(id)), ("registered", &q(reg))]);
        match caller.as_deref() {
            Some(c) => error.push_str(&defaults::render("mesh_write.msg_ctx_mismatch_other", &[("caller", &q(c))])),
            None => error.push_str(defaults::text("mesh_write.msg_ctx_mismatch_none")),
        }
        error.push_str(defaults::text("mesh_write.msg_ctx_mismatch_tail"));
        let why = Unavail {
            reason: defaults::text("mesh_write.reason_ctx_mismatch").to_string(),
            error: Some(error),
            registered: Some(reg.to_string()),
            caller: caller.clone(),
            code: None,
        };
        return Ok(PartitionOpen::Unavailable { why, store_key: caller.clone().unwrap_or(legacy), repo_key: caller });
    }
    let store_key = caller.clone().unwrap_or(legacy);
    // the re-home of a workspace stranded in the legacy bucket moves rows: when it is due, the store side cannot be read as it stands
    if let Err(Defer(why)) = rehome_is_noop(inv, id) {
        let q = OVal::Str(id.to_string()).stringify();
        let error = defaults::render("mesh_write.msg_store_unreadable_code", &[("id", &q), ("code", &why)]);
        return Ok(PartitionOpen::Unavailable {
            why: Unavail::of(defaults::text("mesh_write.reason_store_unavailable"), error, Some(why)),
            store_key,
            repo_key: caller,
        });
    }
    match probe_reader_creating(inv, &store_key) {
        Probe::Open(reader) => match reader.roster() {
            Ok(roster) => Ok(PartitionOpen::Open(Opened { repo_key: store_key, caller, reader, rows: ident::rows_of(&roster) })),
            Err(e) => {
                let q = OVal::Str(id.to_string()).stringify();
                let error = defaults::render("mesh_write.msg_store_unreadable_code", &[("id", &q), ("code", &e.to_string())]);
                Ok(PartitionOpen::Unavailable {
                    why: Unavail::of(
                        defaults::text("mesh_write.reason_store_unavailable"),
                        error,
                        Some(defaults::text("mesh_write.store_unknown_code").to_string()),
                    ),
                    store_key,
                    repo_key: caller,
                })
            }
        },
        failed => {
            let code = match failed {
                Probe::Unreadable(c) => c,
                _ => defaults::text("mesh_write.store_unknown_code").to_string(),
            };
            let q = OVal::Str(id.to_string()).stringify();
            let error = defaults::render("mesh_write.msg_store_unopened_code", &[("id", &q), ("code", &code)]);
            Ok(PartitionOpen::Unavailable {
                why: Unavail::of(defaults::text("mesh_write.reason_store_unavailable"), error, Some(code)),
                store_key,
                repo_key: caller,
            })
        }
    }
}

/// [`open_partition_ex`] for a verb that needs the store itself: an unusable store side is a [`Defer`] named for its reason.
pub(crate) fn open_partition(inv: &Inv, id: &str, desc: &OVal) -> R<Opened> {
    match open_partition_ex(inv, id, desc)? {
        PartitionOpen::Open(o) => Ok(o),
        PartitionOpen::Unavailable { why, .. } => Err(Defer(why.reason)),
    }
}

/// `positions()`: the floor rows, then this reader's own rows when it is a declared reader: `(store base, nd base)`.
pub(crate) fn read_bases(inv: &Inv, reader: &MeshReader, id: &str, cursor_file: Option<&str>) -> R<(f64, f64)> {
    let me = crate::meshw::cursors::reader_key(reader_nonce_cached(&inv.home).as_deref());
    union::read_bases(reader, &inv.home, id, cursor_file, me.as_deref())
}

/// The recipient's identity family over a project's registry rows (`recipientFamilyIds`).
pub(crate) fn family_of(id: &str, rows: &[ident::Row]) -> std::collections::HashSet<String> {
    let pairs: Vec<(String, Option<String>)> = rows.iter().map(|r| (r.id.clone(), r.session_id.clone())).collect();
    union::family_ids(id, &pairs)
}

/// Count the unread rows a family's own sends took out of a count (`mesh_own_sends_excluded`).
pub(crate) fn note_own_excluded(u: &union::Unread) {
    if u.own_excluded > 0 {
        crate::metrics::bump("mesh_own_sends_excluded", &[]);
    }
}

/// `Number.isFinite(x) && x > 0 ? Math.floor(x) : 0`.
fn nd_base_floor(x: f64) -> f64 {
    if x.is_finite() && x > 0.0 { x.floor() } else { 0.0 }
}

/// One partition of the mesh group besides the workspace's own, as a read of the group sees it.
#[derive(Debug, Clone)]
pub(crate) struct Sibling {
    pub id: String,
    /// The store position its unread rows start at.
    pub cursor: f64,
    /// The rows the fold delivers (the ones past a gap are withheld).
    pub delivered: Vec<Value>,
    /// The physical rows the fold consumed, and the running count after each delivered row.
    pub consumed_count: f64,
    pub consumed_through: Vec<f64>,
    /// How many delivered rows the per-call cap kept, and the physical rows an ack may advance past for them.
    pub kept: usize,
    pub physical: f64,
}

/// What `count` reports for a single partition that a tick uses.
pub(crate) struct Counted {
    /// `repoKey`: the caller's project key (none outside a project).
    pub repo_key: Option<String>,
    /// The directory key the store lives under (`storePath`): the caller's project, else the legacy per-id bucket.
    pub store_key: String,
    /// `known` (`readSideKnown`): the inbox and its cursor file both read, the store side is usable and the mesh group resolved.
    pub known: bool,
    /// `unreadTotal`.
    pub unread: usize,
    /// `unreadNdjson`.
    pub nd_unread: usize,
    /// `unreadStore`.
    pub store_unread: usize,
    /// `cursorNdjson`.
    pub nd_cursor: f64,
    /// `cursorStore`.
    pub store_cursor: f64,
    /// `total`.
    pub total: usize,
    /// The unread NDJSON lines (what `inbox read` prints).
    pub nd_lines: Vec<String>,
    /// The unread store rows no NDJSON line covers.
    pub store_rows: Vec<serde_json::Value>,
    /// Where an ack-all moves the NDJSON position: the base, the twin-read lines skipped and the unread lines after them.
    pub nd_target: f64,
    /// `meshPartitionIds`: the partitions the count covered (just the workspace without a mesh group).
    pub mesh_ids: Vec<String>,
    /// `meshGapWithheldCount`: sibling rows held back behind a row the fold could not place.
    pub gap_withheld: usize,
    /// `truncatedCount`: unread rows over the read limit (counted, not listed).
    pub truncated: usize,
    /// The read limit this count was cut at (`--limit`, else the default).
    pub limit: usize,
    /// The mesh group's other partitions: what each contributes to a read and where an ack moves it.
    pub siblings: Vec<Sibling>,
    /// Why the store side could not be used (`storeUnavailable`), when it could not.
    pub unavail: Option<Unavail>,
    /// `meshGroupError`: the mesh group could not be resolved or one of its partitions read.
    pub mesh_error: Option<String>,
}

/// The mesh group's other partitions as a read of `id` sees them (`cmdInbox`'s count widening): the siblings, their unread count,
/// their total and the rows the fold withheld.
struct Widened {
    ids: Vec<String>,
    siblings: Vec<Sibling>,
    unread: usize,
    total: f64,
    gap_withheld: usize,
}

impl Widened {
    fn alone(id: &str) -> Widened {
        Widened { ids: vec![id.to_string()], siblings: Vec::new(), unread: 0, total: 0.0, gap_withheld: 0 }
    }
}

fn widen(inv: &Inv, o: &Opened, id: &str, desc: &OVal, store_base: f64, own_shown: &[Value]) -> R<Widened> {
    let group = crate::meshw::meshgroup::resolve(
        &o.rows,
        id,
        crate::meshw::meshgroup::worktree_of(&o.rows, id, union::path_field(desc, defaults::text("mesh_write.field_worktree_path"))?.as_deref()).as_deref(),
    )?;
    let mut w = Widened { ids: group.ids.clone(), ..Widened::alone(id) };
    if !group.active {
        return Ok(w);
    }
    let mut parts: Vec<(String, f64, Vec<Value>)> = Vec::new();
    for pid in group.ids.iter().filter(|p| p.as_str() != id) {
        let base = crate::meshw::meshgroup::base_cursor(inv, &o.reader, pid)?;
        // a sibling the caller may not ack keeps the watermark the caller left, so its rows are not counted twice
        let cursor =
            if crate::meshw::meshgroup::ack_gate(inv, &o.rows, id, pid)? { base.max(crate::meshw::meshgroup::seen_cursor(inv, id, pid)) } else { base };
        let total = o.reader.message_count(pid).map_err(|e| crate::meshw::readprimary::store_err("store-read", e))?;
        let mut rows: Vec<Value> = Vec::new();
        o.reader
            .for_each_message(pid, if cursor.is_finite() && cursor > 0.0 { cursor.floor() as u64 } else { 0 }, |m| {
                rows.push(m);
                true
            })
            .map_err(|e| crate::meshw::readprimary::store_err("store-read", e))?;
        w.total += total as f64;
        parts.push((pid.clone(), cursor, rows));
    }
    let mut dedup = crate::meshw::meshgroup::Dedup::seed(&o.reader, id, store_base)?;
    for r in own_shown {
        dedup.note_shown(r);
    }
    for (pid, cursor, rows) in parts {
        let folded = dedup.fold(inv, rows);
        w.gap_withheld += folded.gap_withheld;
        w.unread += folded.delivered.len();
        w.siblings.push(Sibling {
            id: pid,
            cursor,
            delivered: folded.delivered,
            consumed_count: folded.consumed_count,
            consumed_through: folded.consumed_through,
            kept: 0,
            physical: 0.0,
        });
    }
    Ok(w)
}

/// `count` for a single, registered partition. An unknown count (the inbox or its cursor file does not read, a store that cannot be
/// used) is reported as such in the result (`known: false`), exactly as Node's union reports it.
pub(crate) fn count_mail(inv: &Inv, id: &str, desc: &OVal, limit: usize) -> R<Counted> {
    let inbox = union::path_field(desc, defaults::text("mesh_write.field_inbox_path"))?;
    let cursor_file = union::path_field(desc, defaults::text("mesh_write.field_cursor_path"))?;
    // known: the inbox and its cursor file both read (otherwise Node prints a warning and the count is unknown)
    let nd_known = match (&inbox, &cursor_file) {
        (Some(i), Some(c)) => union::non_empty_lines(i)?.is_some() && union::cursor_position(c)?.is_some(),
        _ => false,
    };
    let (inbox_in, cursor_in) = (inbox.as_deref().filter(|_| nd_known), cursor_file.as_deref().filter(|_| nd_known));
    let (mut opened, store_key, repo_key, mut unavail) = match open_partition_ex(inv, id, desc)? {
        PartitionOpen::Open(o) => {
            let (key, caller) = (o.repo_key.clone(), o.caller.clone());
            (Some(o), key, caller, None)
        }
        PartitionOpen::Unavailable { why, store_key, repo_key } => (None, store_key, repo_key, Some(why)),
    };
    let me = crate::meshw::cursors::reader_key(reader_nonce_cached(&inv.home).as_deref());
    // the union at the reader's bases; a store read that fails is the store side unknown (`store-read-error`), counted without it
    let mut counted = None;
    if let Some(o) = &opened {
        let family = family_of(id, &o.rows);
        match union::unread_for(&o.reader, &inv.home, id, inbox_in, cursor_in, me.as_deref(), &family, inv.now) {
            Ok(c) => {
                note_own_excluded(&c);
                counted = Some((c.unread, c.store_base, c.nd_base, c.union));
            }
            Err(Defer(why)) => {
                let q = OVal::Str(id.to_string()).stringify();
                let error = defaults::render("mesh_write.msg_store_read_error", &[("id", &q), ("why", &why)]);
                unavail = Some(Unavail {
                    reason: defaults::text("mesh_write.reason_store_read_error").to_string(),
                    error: Some(error),
                    registered: None,
                    caller: None,
                    code: Some(why),
                });
            }
        }
    }
    if counted.is_none() {
        opened = None;
    }
    let (unread, store_base, nd_base, u) = match counted {
        Some(c) => c,
        None => {
            // no store behind the count (`countFor(null, ...)`): the NDJSON side alone, from the cursor file's position
            let nd_base = crate::migrate::readercur::legacy_nd_floor(cursor_in);
            let u = union::union_unread(&union::UnionIn { inbox: inbox_in, cursor_file: cursor_in, id, store: None, store_base: 0.0, nd_base, now: inv.now })?;
            (u.unread, 0.0, nd_base, u)
        }
    };
    let input = union::UnionIn { inbox: inbox_in, cursor_file: cursor_in, id, store: opened.as_ref().map(|o| &o.reader), store_base, nd_base, now: inv.now };
    let total = if nd_known {
        union::merged_total(&input)?
    } else {
        // an unknown count: Node's total is the inbox's own line count (0 when it does not read) plus the store rows no line covers
        union::merged_total(&union::UnionIn { inbox: inbox.as_deref(), ..input })?
    };
    let nd_target = nd_base_floor(nd_base) + u.nd_skipped as f64 + u.nd_unread_lines.len() as f64;
    let nd_cursor = if !nd_known {
        cursor_file.as_deref().map_or(0.0, |c| crate::meshw::cursors::read_cursor(Path::new(c)))
    } else if nd_base.is_finite() && nd_base > 0.0 {
        nd_base.floor()
    } else {
        0.0
    };
    // ---- the sibling partitions of the mesh group: a group that cannot be resolved narrows the read to the partition itself ----
    let mut mesh_error: Option<String> = None;
    let widened = match &opened {
        Some(o) => match widen(inv, o, id, desc, store_base, &u.store_only_unread) {
            Ok(w) => w,
            Err(Defer(why)) => {
                let q = OVal::Str(id.to_string()).stringify();
                mesh_error = Some(defaults::render("mesh_write.msg_mesh_unresolved", &[("id", &q), ("why", &why)]));
                Widened::alone(id)
            }
        },
        None => Widened::alone(id),
    };
    let Widened { ids, mut siblings, unread: added_unread, total: added_total, gap_withheld } = widened;
    // the read limit: the workspace's own rows are kept first, then each sibling's, up to the limit
    let mut u = u;
    let own_total = u.store_only_unread.len();
    let pre_cap = own_total + added_unread;
    let (store_unread, truncated) = if pre_cap > limit { (limit, pre_cap - limit) } else { (pre_cap, 0) };
    // the engine's own wake rows are acked with the rest but are not mail to report
    let store_unread = store_unread.saturating_sub(u.store_only_unread.iter().filter(|r| union::is_wake_row(r)).count());
    let mut remaining = limit;
    let own_kept = own_total.min(remaining);
    if truncated > 0 {
        remaining -= own_kept;
        u.store_only_unread.truncate(own_kept);
    }
    for sib in &mut siblings {
        let rows = sib.delivered.len();
        if truncated > 0 {
            let keep = rows.min(remaining);
            remaining -= keep;
            sib.kept = keep;
            // the physical rows to advance past for the `keep` delivered ones (the fold's own count when nothing was cut)
            sib.physical = if keep >= rows && sib.consumed_count.is_finite() {
                sib.consumed_count
            } else if keep == 0 {
                0.0
            } else {
                sib.consumed_through.get(keep - 1).copied().filter(|x| x.is_finite()).unwrap_or(keep as f64)
            };
        } else {
            sib.kept = rows;
            sib.physical = if sib.consumed_count.is_finite() { sib.consumed_count } else { rows as f64 };
        }
    }
    let known = nd_known && unavail.is_none() && mesh_error.is_none();
    Ok(Counted {
        repo_key,
        store_key,
        known,
        unread: unread + added_unread,
        nd_unread: u.nd_unread_lines.iter().filter(|l| !union::is_wake_line(l)).count(),
        store_unread,
        nd_cursor,
        store_cursor: store_base,
        total: total + added_total as usize,
        mesh_ids: ids,
        gap_withheld,
        truncated,
        limit,
        siblings,
        nd_lines: u.nd_unread_lines,
        store_rows: u.store_only_unread,
        nd_target: if nd_known { nd_target } else { nd_cursor },
        unavail,
        mesh_error,
    })
}

/// `pidIsAlive(pid)` without a start-time check: `Some(false)` only when the process is gone.
pub(crate) fn pid_alive(pid: f64) -> Option<bool> {
    if !pid.is_finite() || pid.fract() != 0.0 || pid <= 0.0 || pid > f64::from(i32::MAX) {
        return None;
    }
    // SAFETY: signal 0 only probes for the process.
    let rc = unsafe { libc::kill(pid as i32, 0) };
    if rc == 0 {
        return Some(true);
    }
    match std::io::Error::last_os_error().raw_os_error() {
        Some(libc::ESRCH) => Some(false),
        Some(libc::EPERM) => Some(true),
        _ => None,
    }
}

/// `Number(v)` for the JSON values a lock's `ts` can hold, as JavaScript converts them: an array is its elements joined by commas
/// (`Number([])` is 0, `Number([5])` is 5, `Number([1, 2])` is NaN), an object is `"[object Object]"` (NaN).
pub(crate) fn js_number(v: Option<&OVal>) -> R<f64> {
    fn text_of(v: &OVal) -> String {
        match v {
            OVal::Null => String::new(),
            OVal::Bool(b) => b.to_string(),
            OVal::Num(x) => crate::checks::jsport::num::to_js_string(*x),
            OVal::Str(t) => t.clone(),
            OVal::Arr(items) => items.iter().map(text_of).collect::<Vec<_>>().join(","),
            OVal::Obj(_) => defaults::text("mesh_write.js_object_string").to_string(),
        }
    }
    Ok(match v {
        None => f64::NAN,
        Some(OVal::Num(x)) => *x,
        Some(OVal::Str(t)) => js_number_of_str(t),
        Some(OVal::Null) => 0.0,
        Some(OVal::Bool(b)) => f64::from(u8::from(*b)),
        Some(other) => js_number_of_str(&text_of(other)),
    })
}

/// `watcherArmed`: a live watcher covers the workspace (its own lock, or another row of its checkout); the file is the workspace's
/// own lock, whose mere presence the cron-found-mail measurement counts. A check that fails reads as not armed (Node's catch).
fn watcher_lock(inv: &Inv, id: &str) -> (PathBuf, bool) {
    let armed = match crate::meshw::watcher::live_for_workspace(&inv.home, id, inv.now) {
        Ok(found) => {
            if found.by_checkout {
                crate::metrics::bump("mesh_watcher_matched_by_checkout", &[]);
            }
            found.armed
        }
        Err(_) => false,
    };
    (crate::meshw::watcher::lock_file(&inv.home, id), armed)
}

/// `Number(JSON.parse(file).seq) || 0`: a tick count that is not a number is 0; an infinite one stays (and is written as `null`).
fn previous_seq(file: &Path) -> f64 {
    let Ok(bytes) = std::fs::read(file) else { return 0.0 };
    let Some(OVal::Obj(o)) = OVal::parse(&String::from_utf8_lossy(&bytes)) else { return 0.0 };
    let seq = js_number(o.iter().find(|(k, _)| k == "seq").map(|(_, v)| v)).unwrap_or(f64::NAN);
    if seq.is_nan() { 0.0 } else { seq }
}

/// Stage `text` next to `dst` and rename it into place; the staged file never outlives a failed rename.
fn write_staged(dst: &Path, text: &str, now: i64) -> std::io::Result<()> {
    let mut tmp = dst.as_os_str().to_os_string();
    tmp.push(format!(".{}.{}{}", std::process::id(), now, defaults::text("mesh_write.tick_tmp_suffix")));
    let tmp = PathBuf::from(tmp);
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, dst).inspect_err(|_| {
        crate::discard::harmless(std::fs::remove_file(&tmp)); // keep: never leak a staged file
    })
}

/// Effect 1: the wake-tick marker. `unread` is `None` for a result that carries no count (a refused one): `unreadTotal: null`.
fn write_marker(inv: &Inv, id: &str, unread: Option<usize>, known: bool, seq: f64, gap: bool) {
    let dir = devswarm_root(&inv.home).join(defaults::text("mesh_write.dir_wake_tick"));
    let mut m = Obj::default();
    m.put("ts", n(inv.now as f64))
        .put("unreadTotal", unread.map_or(OVal::Null, |u| n(u as f64)))
        .put("meshGapWithheld", OVal::Bool(gap))
        .put("known", OVal::Bool(known));
    if seq != 0.0 && !seq.is_nan() {
        // JSON.stringify writes an infinite number as null
        m.put("seq", if seq.is_finite() { n(seq) } else { OVal::Null });
    }
    let file = dir.join(format!("{id}{}", defaults::text("mesh_write.json_suffix")));
    let go = || -> std::io::Result<()> {
        std::fs::create_dir_all(&dir)?;
        write_staged(&file, &m.done().stringify(), inv.now)
    };
    crate::discard::harmless(go()); // keep: the marker is instrumentation only (Node's catch)
}

/// Effect 2: the heartbeat refresh.
fn heartbeat_beat(inv: &Inv, id: &str) -> OVal {
    let file = devswarm_root(&inv.home).join(defaults::text("mesh_write.dir_heartbeats")).join(format!("{id}{}", defaults::text("mesh_write.json_suffix")));
    let now = inv.now as f64;
    let existing = std::fs::read(&file).ok().and_then(|b| OVal::parse(&String::from_utf8_lossy(&b)));
    match existing {
        Some(mut beat @ OVal::Obj(_)) => {
            beat.set("ts", n(now));
            beat.set("state_ts", n(now));
            beat.set("version", running_version());
            beat
        }
        // an array is an object to JavaScript: the assignments do not show in its JSON, which is written back as it was
        Some(arr @ OVal::Arr(_)) => arr,
        _ => {
            let mut b = Obj::default();
            b.put("id", s(id))
                .put("ts", n(now))
                .put("state_ts", n(now))
                .put("source", s(defaults::text("mesh_write.heartbeat_source_tick")))
                .put("progress_pct", OVal::Null)
                .put("phase", OVal::Null)
                .put("wip", OVal::Arr(Vec::new()))
                .put("blockers", OVal::Arr(Vec::new()))
                .put("sessionId", OVal::Null)
                .put("version", running_version());
            b.done()
        }
    }
}

fn write_heartbeat(inv: &Inv, id: &str, beat: &OVal) {
    let dir = devswarm_root(&inv.home).join(defaults::text("mesh_write.dir_heartbeats"));
    let file = dir.join(format!("{id}{}", defaults::text("mesh_write.json_suffix")));
    let go = || -> std::io::Result<()> {
        std::fs::create_dir_all(&dir)?;
        write_staged(&file, &beat.stringify(), inv.now)
    };
    crate::discard::harmless(go()); // keep: the refresh is best effort (Node's catch)
}

/// Effect 3: the cron-found-mail line, kept to the last N lines.
fn write_cron_found_mail(inv: &Inv, id: &str, unread: usize) {
    let file = devswarm_root(&inv.home).join(defaults::text("mesh_write.file_cron_found_mail"));
    let mut lines: Vec<String> =
        std::fs::read(&file).map(|b| String::from_utf8_lossy(&b).split('\n').filter(|l| !l.is_empty()).map(str::to_string).collect()).unwrap_or_default();
    let mut rec = Obj::default();
    rec.put("ts", n(inv.now as f64)).put("id", s(id)).put("unreadTotal", n(unread as f64));
    lines.push(rec.done().stringify());
    let cap = defaults::num("mesh_write.cron_found_mail_cap") as usize;
    if lines.len() > cap {
        lines.drain(..lines.len() - cap);
    }
    let go = || -> std::io::Result<()> {
        if let Some(d) = file.parent() {
            std::fs::create_dir_all(d)?;
        }
        std::fs::write(&file, lines.join("\n") + "\n")
    };
    crate::discard::harmless(go()); // keep: a measurement only, never breaks the tick (Node's catch)
}

/// What a tick adds to `count`'s result, in Node's order: the delivery-log fields, then `idMismatch`, `watcherArmed` and the anchor refresh.
pub(crate) struct TickTail {
    /// A pull refused because its delivery log is unwritable (`walBlocked`), with its error.
    pub wal_blocked: Option<Option<String>>,
    /// `walAlerts`.
    pub wal_alerts: Vec<OVal>,
    /// `idMismatch`.
    pub id_mismatch: bool,
    /// `watcherArmed`.
    pub armed: Armed,
    /// `anchorRefresh`, when the anchor was looked at and something came of it.
    pub anchor: Option<OVal>,
}

/// `known`, `storeUnavailable`, `storeUnavailableReason`, its detail, `meshGroupUnresolved`, `meshGroupError`, `totalsPartial` and
/// `unreadStoreUnknown`: how a read-side result reports a store side or a mesh group it could not use.
pub(crate) fn put_known_block(o: &mut Obj, c: &Counted) {
    let genuine = c.unavail.as_ref().is_some_and(Unavail::genuine);
    o.put("known", OVal::Bool(c.known))
        .put("storeUnavailable", OVal::Bool(genuine))
        .put("storeUnavailableReason", if genuine { c.unavail.as_ref().and_then(|u| u.code.as_deref()).map_or(OVal::Null, s) } else { OVal::Null });
    if let Some(u) = &c.unavail {
        o.put("storeUnavailableDetail", u.detail());
    }
    o.put("meshGroupUnresolved", OVal::Bool(c.mesh_error.is_some()))
        .put("meshGroupError", c.mesh_error.as_deref().map_or(OVal::Null, s))
        .put("totalsPartial", OVal::Bool(c.mesh_error.is_some()));
    if c.unavail.is_some() {
        o.put("unreadStoreUnknown", OVal::Bool(true));
    }
}

/// The `count` result's fields up to the aliases, in Node's order; `tail` is a tick's own addition.
pub(crate) fn count_obj(inv: &Inv, id: &str, c: &Counted, action: &str, resolved_from: Option<&str>, redirected_from: Option<&str>) -> Obj {
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(true)).put("action", s(action)).put("id", s(id));
    if let Some(f) = resolved_from {
        o.put("resolvedFrom", s(f));
    }
    if let Some(f) = redirected_from {
        o.put("redirected", OVal::Bool(true)).put("redirectedFrom", s(f));
    }
    o.put("repoKey", c.repo_key.as_deref().map_or(OVal::Null, s))
        .put("storePath", OVal::Str(union::store_dir(&inv.home, &c.store_key).to_string_lossy().into_owned()))
        .put("cwd", s(&inv.cwd))
        .put("meshPartitionIds", OVal::Arr(c.mesh_ids.iter().map(|x| s(x)).collect()))
        .put("unreadTotal", n(c.unread as f64))
        .put("unreadNdjson", n(c.nd_unread as f64))
        .put("unreadStore", n(c.store_unread as f64))
        .put("cursorNdjson", n(c.nd_cursor))
        .put("cursorStore", n(c.store_cursor))
        .put("total", n(c.total as f64));
    put_known_block(&mut o, c);
    if c.gap_withheld > 0 {
        o.put("meshGapWithheld", OVal::Bool(true)).put("meshGapWithheldCount", n(c.gap_withheld as f64));
    }
    if c.truncated > 0 {
        let limit = c.limit;
        let (count, lim) = (c.truncated.to_string(), limit.to_string());
        o.put("truncated", OVal::Bool(true)).put("truncatedCount", n(c.truncated as f64)).put("limit", n(limit as f64)).put(
            "truncatedHint",
            OVal::Str(crate::checks::devswarm_role::text::fill_once(defaults::text("mesh_write.truncated_hint"), &[("count", &count), ("limit", &lim)])),
        );
    }
    o.put("unread", n(c.unread as f64)).put("cursor", n(c.nd_cursor)).put("storeCursor", n(c.store_cursor)).put("storeUnread", n(c.store_unread as f64));
    o
}

/// Add a tick's fields to a result object, in Node's order (`Object.assign({}, counted, { action: 'tick', idMismatch, watcherArmed })`).
pub(crate) fn with_tail(mut o: Obj, tail: &TickTail) -> Obj {
    if let Some(err) = &tail.wal_blocked {
        o.put("known", OVal::Bool(false)).put("walBlocked", OVal::Bool(true)).put("walError", err.as_deref().map_or(OVal::Null, s));
    }
    if !tail.wal_alerts.is_empty() {
        o.put("walAlerts", OVal::Arr(tail.wal_alerts.clone()));
    }
    o.put("action", s(defaults::text("mesh_write.verb_tick"))).put("idMismatch", OVal::Bool(tail.id_mismatch)).put("watcherArmed", tail.armed.json());
    if let Some(a) = &tail.anchor {
        o.put("anchorRefresh", a.clone());
    }
    o
}

/// The reasons `emitKnownWarning` names for a result that reports `known: false`.
fn known_reasons(result: &OVal) -> Vec<String> {
    let text = |v: Option<&OVal>| match v {
        Some(OVal::Str(t)) if !t.is_empty() => Some(t.clone()),
        _ => None,
    };
    let truthy = |v: Option<&OVal>| matches!(v, Some(OVal::Bool(true)));
    let su_reason = text(result.get("storeUnavailableReason"));
    let su_kind = text(result.get("storeUnavailableDetail").and_then(|d| d.get("reason"))).or_else(|| text(result.get("reason")));
    let store_reason = |code: &str| defaults::render("mesh_write.known_reason_store", &[("code", &code)]);
    let mut reasons: Vec<String> = Vec::new();
    if truthy(result.get("storeUnavailable")) {
        match (&su_kind, &su_reason) {
            (Some(k), Some(code)) if k == defaults::text("mesh_write.reason_store_unavailable") => reasons.push(store_reason(code)),
            (None, Some(code)) => reasons.push(store_reason(code)),
            (kind, _) => reasons.push(format!(
                "{}{}",
                defaults::text("mesh_write.known_reason_flag"),
                kind.as_ref().map(|k| defaults::render("mesh_write.known_reason_kind", &[("kind", k)])).unwrap_or_default()
            )),
        }
    } else if let Some(k) = &su_kind {
        reasons.push(k.clone());
    } else if let Some(code) = &su_reason {
        reasons.push(store_reason(code));
    }
    let mesh = truthy(result.get("meshGroupUnresolved"));
    if mesh {
        let err = text(result.get("meshGroupError")).map(|e| format!("{}{e}", defaults::text("mesh_write.known_reason_colon"))).unwrap_or_default();
        reasons.push(format!("{}{err}", defaults::text("mesh_write.known_reason_mesh")));
    }
    if truthy(result.get("totalsPartial")) && !mesh {
        reasons.push(defaults::text("mesh_write.known_reason_partial").to_string());
    }
    if let Some(r) = text(result.get("reason"))
        && !reasons.iter().any(|x| x.contains(&r))
    {
        reasons.push(r);
    }
    if reasons.is_empty() {
        reasons.push(defaults::text("mesh_write.known_unknown").to_string());
    }
    reasons
}

/// Node's `emitKnownWarning(argv, result)` for an `inbox <sub>` result: one stderr line, naming the concrete reason, whenever the result
/// reports `known === false`.
pub(crate) fn emit_known_warning(sub: &str, result: &OVal) {
    if !matches!(result.get("known"), Some(OVal::Bool(false))) {
        return;
    }
    let id = match result.get("id") {
        Some(OVal::Str(t)) => t.clone(),
        Some(OVal::Null) | None => String::new(),
        Some(other) => other.stringify(),
    };
    let label = format!("{} {sub} {}", defaults::text("mesh_write.verb_inbox"), OVal::Str(id).stringify());
    eprintln!("{}", defaults::render("mesh_write.known_warning", &[("label", &label), ("reasons", &known_reasons(result).join("; "))]));
}

/// Where a tick's count comes from.
enum Target {
    /// A descriptor to count: the id as counted (a label resolves to its row), and how it got there.
    Count { id: String, desc: OVal, resolved_from: Option<String>, redirected_from: Option<String> },
    /// The refusal `count` prints for an id nothing backs.
    Refused(Answer),
}

/// Run `inbox tick <id>` in its line form (`--quiet`) or its JSON form.
pub fn run(inv: &Inv, a: &Args) -> R<Answer> {
    // `help` never gets here: `simple::classify` takes a help request before any verb, as `run()` does
    let Some(id) = a.positionals.get(2).map(String::as_str).filter(|i| is_safe_id(i)) else {
        return Ok(refused(a, defaults::text("devswarm_cli.msg_bad_id")));
    };
    // `--since` / `--tail` are refused before anything is read (`inboxWindowRejection`)
    if let Some(w) = crate::meshw::readprimary::window_refusal(inv, a, id, defaults::text("mesh_write.verb_tick"))? {
        let error = OVal::parse(w.stdout.trim()).unwrap_or(OVal::Null);
        return Ok(Answer { code: w.code, stdout: format!("{}\n", rendered_refusal(a, &error)), effect: w.effect });
    }
    let form = tick_form(a);
    let verb = defaults::text("mesh_write.verb_tick");
    let id_mismatch = tickarm::warn_id_mismatch(inv, id);
    let anchor = tickarm::refresh_anchor_session(inv);
    // ---- reads: everything that can fail is read before the first write ----
    let found = ident::read_descriptor(&inv.home, id);
    // a `--child` tick pulls first (`withSelfHeal(() => cmdInbox('pull', ...))`): the ensure completes the descriptor (or registers the
    // workspace) the count then reads. An ensure Node refuses leaves the pull undone and the tick goes on to count what is there.
    let prepared = if form.child {
        crate::meshw::pull::heal_first(inv);
        let (found, _) = crate::meshw::inboxcmd::promote_preface(inv, a, id, found.clone());
        let args = crate::meshw::pull::PullArgs {
            session: a.one(defaults::text("mesh_write.flag_session")).filter(|v| !v.is_empty()),
            worktree_flag: a.one(defaults::text("devswarm_cli.flag_worktree")),
            rows_left_by_fold: false,
        };
        match crate::meshw::pull::prepare_ex(inv, id, found.as_ref(), &args)? {
            crate::meshw::pull::Prepared::Plan(p) => Some(*p),
            crate::meshw::pull::Prepared::Refused(_) => None,
        }
    } else {
        None
    };
    let limit = crate::meshw::inboxcmd::limit_of(a);
    let target = match prepared.as_ref() {
        Some(p) => Target::Count { id: id.to_string(), desc: p.ensured().clone(), resolved_from: None, redirected_from: None },
        None => match crate::meshw::inboxcmd::locate(inv, verb, id, false, false)? {
            crate::meshw::inboxcmd::Found::Go { id, desc, resolved_from, redirected_from } => Target::Count { id, desc, resolved_from, redirected_from },
            crate::meshw::inboxcmd::Found::Out(refusal) => Target::Refused(refusal),
        },
    };
    // a `--child` tick's pre-count only proves the count can be answered: the pull pre-creates the inbox and cursor files that make
    // it known, and the count that is printed is taken after it
    let pre = match &target {
        Target::Count { id: rid, desc, .. } => Some(count_mail(inv, rid, desc, limit)?),
        Target::Refused(_) => None,
    };
    let marker_file =
        devswarm_root(&inv.home).join(defaults::text("mesh_write.dir_wake_tick")).join(format!("{id}{}", defaults::text("mesh_write.json_suffix")));
    let every = tickarm::roster_every(inv);
    let want_roster = every > 0 && word(a, "mesh_write.flag_quiet") && !form.child;
    let prev_seq = previous_seq(&marker_file);
    let tick_seq = if want_roster { prev_seq + 1.0 } else { prev_seq };
    let beat = heartbeat_beat(inv, id);
    let (lock_file, lock_armed) = watcher_lock(inv, id);
    // the pull's plan settles every remaining refusal (the lock, the delivery log, the native count) before any write
    let pull_plan = match prepared {
        Some(p) => Some(p.finish(inv, pre.as_ref().map_or(0, |c| c.store_unread), form.line)?),
        None => None,
    };
    // ---- writes ----
    let (counted, wal_blocked) = match pull_plan {
        Some(p) => {
            // `execute` takes the workspace's lock first and defers only while nothing is written; it marks the commit point itself
            let out = crate::meshw::pull::execute(inv, p)?;
            // the count runs after the pull, over what the pull left (a failure here is a committed failure: exit 70)
            let counted = match &target {
                Target::Count { id: rid, desc, .. } => {
                    let after = ident::read_descriptor(&inv.home, rid);
                    Some(count_mail(inv, rid, after.as_ref().unwrap_or(desc), limit)?)
                }
                Target::Refused(_) => None,
            };
            (counted, out.wal_blocked.then_some(out.res.error.clone()))
        }
        None => {
            crate::meshw::mark_committed();
            (pre, None)
        }
    };
    let armed = tickarm::decide(inv, id, form.child, lock_armed);
    let unread = counted.as_ref().map(|c| c.unread);
    // a pull refused because its delivery log is unwritable: mail may be waiting that this count cannot see, so it is UNKNOWN
    let known = counted.as_ref().is_some_and(|c| c.known) && wal_blocked.is_none();
    write_marker(inv, id, unread, known, tick_seq, counted.as_ref().is_some_and(|c| c.gap_withheld > 0));
    write_heartbeat(inv, id, &beat);
    if let Some(u) = unread.filter(|u| *u > 0)
        && lock_file.exists()
    {
        write_cron_found_mail(inv, id, u);
    }
    tickarm::record_rearm_cue(inv, id, armed);
    // ---- the result: `count`'s (or its refusal) with the tick's fields after it ----
    let (code, obj) = match (&target, &counted) {
        (Target::Count { id: rid, resolved_from, redirected_from, .. }, Some(c)) => {
            (0, count_obj(inv, rid, c, verb, resolved_from.as_deref(), redirected_from.as_deref()))
        }
        (Target::Refused(r), _) => {
            let mut obj = Obj::default();
            if let Some(OVal::Obj(fields)) = OVal::parse(r.stdout.trim()) {
                for (k, v) in fields {
                    obj.put(&k, v);
                }
            }
            (r.code, obj)
        }
        (Target::Count { .. }, None) => (2, Obj::default()),
    };
    let tail = TickTail {
        wal_blocked,
        wal_alerts: if form.line { Vec::new() } else { tickarm::wal_alerts(inv) },
        id_mismatch,
        armed,
        anchor: anchor.filter(|r| matches!(r.get("refreshed"), Some(OVal::Bool(true)))),
    };
    let roster = if want_roster && every > 0 && (tick_seq % every as f64) == 0.0 && counted.as_ref().is_some_and(|c| c.known && c.unread == 0) && code == 0 {
        tickarm::roster_text(inv, id)
    } else {
        None
    };
    let result = with_tail(obj, &tail).done();
    emit_known_warning(verb, &result);
    let stdout = if form.line { line_of(&result, roster.as_deref()) } else { result.stringify() };
    Ok(Answer { code, stdout: format!("{stdout}\n"), effect: Effect::None })
}

/// `inboxTickQuietLine(result)`.
fn line_of(result: &OVal, roster: Option<&str>) -> String {
    if !matches!(result.get("ok"), Some(OVal::Bool(true))) {
        return rendered_refusal_line(result);
    }
    let flag =
        |k: &str| if matches!(result.get(k), Some(OVal::Bool(true))) { defaults::text("mesh_write.js_true") } else { defaults::text("mesh_write.js_false") };
    let word = match result.get("watcherArmed") {
        Some(OVal::Str(w)) => w.as_str(),
        Some(OVal::Bool(true)) => defaults::text("mesh_write.js_true"),
        _ => defaults::text("mesh_write.js_false"),
    };
    let id = match result.get("id") {
        Some(OVal::Str(t)) => t.clone(),
        _ => String::new(),
    };
    let unread = match result.get("unreadTotal") {
        Some(OVal::Num(x)) => crate::checks::jsport::num::to_js_string(*x),
        _ => defaults::text("mesh_write.js_null").to_string(),
    };
    let line = defaults::render(
        "mesh_write.tick_line",
        &[("id", &id), ("unread", &unread), ("known", &flag("known")), ("gap", &flag("meshGapWithheld")), ("armed", &word)],
    );
    match roster {
        Some(r) if !r.is_empty() => format!("{line}\n{r}"),
        _ => line,
    }
}

fn rendered_refusal_line(result: &OVal) -> String {
    let why = ["error", "reason"].iter().find_map(|k| match result.get(k) {
        Some(OVal::Str(t)) if !t.is_empty() => Some(t.clone()),
        _ => None,
    });
    defaults::render("mesh_write.tick_refused_line", &[("error", &why.unwrap_or_else(|| defaults::text("mesh_write.tick_failed").to_string()))])
}
