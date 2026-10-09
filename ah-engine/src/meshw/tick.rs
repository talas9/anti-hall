//! `devswarm.js inbox tick <id> [--quiet] [--json]`, ported from `scripts/devswarm-lib/inbox-cmd.js` `cmdInboxTick` (with the `count`
//! it runs) and `inboxTickQuietLine`.
//!
//! A tick counts the unread mail of a workspace (its NDJSON inbox plus its store partition, see [`crate::meshw::union`]),
//! then writes three small records and prints one line (`--quiet`) or the JSON of the `count` it ran:
//!
//! * the wake-tick marker `wake-tick/<id>.json` (`ts`, `unreadTotal`, `meshGapWithheld`, `known`, the carried-over `seq`);
//! * the heartbeat refresh: `ts`, `state_ts` and `version` of the existing `heartbeats/<id>.json` (a minimal record when
//!   there is none);
//! * the cron-found-mail line, when the tick found unread mail and a wake-watch lock exists.
//!
//! The engine answers the common steady state and nothing else: the line form or the JSON form, a workspace with a
//! descriptor, a single store partition (no mesh group), reader-cursor floor rows in place, a LIVE wake-watch lock (so
//! `watcherArmed` is `true` and none of the idle, archived or limit skips, nor the re-arm cue, is involved), no delivery-log
//! alert, no roster setting. A count that is not known (the inbox or its cursor file does not read) is answered in the line
//! form, with Node's `known:false` warning on stderr. Everything else (a `--child` tick that first imports the native queue,
//! the JSON form of an unknown count, a mesh group, a watcher that is not armed, a Primary whose anchor session Node
//! would refresh) is a
//! [`Defer`]: decided before the first write, so Node then runs the verb and nothing is written twice. After the first
//! write nothing defers; every write is best effort, as in Node (`try { ... } catch (_) {}`).
// Discard triage (E3): every `.ok()` / `harmless` / `unwrap_or*` in this file is a deliberate keep, for these reasons:
// - the three records a tick writes are best effort in Node (each in its own try/catch): a failed write is not an error
// - an unreadable optional file is the same as an absent one (Node's try/catch around readFileSync)
// - text that does not parse is the absent value (Node's JSON.parse catch parity)
use crate::checks::guardkit::ojson::OVal;
use crate::checks::guardkit::text::js_number_of_str;
use crate::defaults;
use crate::mesh::MeshReader;
use crate::meshw::args::{Args, FlagVal};
use crate::meshw::common::{Inv, Obj, n, s};
use crate::meshw::heartbeat::{anchor_refresh_possible, id_mismatch_possible, running_version};
use crate::meshw::ident::{self, R, defer};
use crate::meshw::idlock::{devswarm_root, is_safe_id};
use crate::meshw::send::{Answer, Effect, mesh_candidates, rehome_is_noop};
use crate::meshw::union;
use std::path::{Path, PathBuf};

/// The one-line form (`--quiet`) or the JSON form (no flag, or `--json`): the flag sets the engine answers. Every other
/// flag (`--child` first imports the native queue) is Node's.
struct Form {
    /// `main()` prints the one-line rendering (`--quiet` without `--json`).
    line: bool,
    /// `--child`: the tick first pulls the native queue (see [`crate::meshw::pull`]).
    child: bool,
}

fn tick_form(a: &Args) -> R<Form> {
    let bare = |name: &str| -> R<bool> {
        match a.flags.get(name) {
            None => Ok(false),
            Some(v) if v.iter().all(|x| *x == FlagVal::True) => Ok(true),
            Some(_) => defer("flag-value"),
        }
    };
    let (quiet, json) = (bare(defaults::text("mesh_write.flag_quiet"))?, bare(defaults::text("mesh_write.flag_json"))?);
    let child = bare(defaults::text("mesh_write.flag_child"))?;
    let known = [defaults::text("mesh_write.flag_quiet"), defaults::text("mesh_write.flag_json"), defaults::text("mesh_write.flag_child")];
    if a.flags.keys().any(|k| !known.contains(&k.as_str())) {
        return defer("flags");
    }
    Ok(Form { line: quiet && !json, child })
}

/// The `devswarm.tickRosterEvery` setting might be set anywhere Node reads it (the environment, `~/.anti-hall/settings.json`,
/// the plugin options in `~/.claude/settings.json`): any trace of it sends the tick to Node, which appends the roster
/// on every Nth tick. Reading the number itself would repeat the settings resolution for no gain.
fn roster_setting_possible(inv: &Inv) -> bool {
    if inv.env.get(defaults::text("mesh_write.tick_roster_env")).is_some_and(|v| !v.trim().is_empty()) {
        return true;
    }
    let key = defaults::text("mesh_write.tick_roster_setting");
    defaults::list("mesh_write.tick_settings_files").iter().any(|f| std::fs::read_to_string(inv.home.join(f)).is_ok_and(|t| t.contains(key)))
}

/// `devswarm-read-wal.js` `health()` reports an alert (or something this port cannot judge): then the tick carries
/// `walAlerts` and Node prints it. Defer on any pending batch, spilled batch or last-resort batch; a log with every batch
/// closed (the normal state) is quiet.
fn wal_is_quiet(inv: &Inv, own: Option<&Path>) -> R<()> {
    let root = devswarm_root(&inv.home);
    let suffix = defaults::text("mesh_write.wal_suffix");
    if let Ok(rd) = std::fs::read_dir(root.join(defaults::text("mesh_write.dir_wal"))) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if !name.ends_with(suffix) {
                continue;
            }
            let text = match std::fs::read(e.path()) {
                Ok(b) => String::from_utf8_lossy(&b).into_owned(),
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => return defer("wal-unreadable"),
            };
            let (mut opened, mut closed) = (std::collections::HashSet::new(), std::collections::HashSet::new());
            for line in text.split('\n').filter(|l| !crate::checks::guardkit::text::js_trim(l).is_empty()) {
                let Ok(rec) = serde_json::from_str::<serde_json::Value>(line) else { continue };
                let Some(id) = rec["e"].as_str() else { continue };
                match rec["t"].as_str() {
                    Some("batch") if rec["raw"].is_string() => {
                        opened.insert(id.to_string());
                    }
                    Some("done" | "quarantine") => {
                        closed.insert(id.to_string());
                    }
                    _ => {}
                }
            }
            // a `--child` tick's own log is replayed and closed by the pull before the health report
            if opened.iter().any(|b| !closed.contains(b)) && own != Some(e.path().as_path()) {
                return defer("wal-pending");
            }
        }
    }
    if std::fs::read_dir(root.join(defaults::text("mesh_write.dir_wal_spill"))).is_ok_and(|mut d| d.next().is_some()) {
        return defer("wal-spill");
    }
    let tmp = defaults::list("mesh_write.env_tmpdir")
        .iter()
        .find_map(|k| inv.env.get(*k).filter(|v| !v.is_empty()))
        .map_or_else(|| PathBuf::from(defaults::text("mesh_write.default_tmpdir")), PathBuf::from);
    let prefix = defaults::text("mesh_write.wal_lastresort_prefix");
    if std::fs::read_dir(tmp).is_ok_and(|d| d.flatten().any(|e| e.file_name().to_string_lossy().starts_with(prefix))) {
        return defer("wal-lastresort");
    }
    Ok(())
}

/// Open the read-only store of the project the way `openStore` settles it; `Ok(None)` is a store Node would first create.
pub(crate) fn open_reader(inv: &Inv, repo_key: &str) -> R<Option<MeshReader>> {
    let dir = union::store_dir(&inv.home, repo_key);
    if !dir.exists() {
        return Ok(None);
    }
    let forced = inv.env.get(defaults::text("mesh_write.env_store_backend")).map(|v| v.trim().to_lowercase()).unwrap_or_default();
    if forced != defaults::text("mesh.backend_sqlite") {
        if !forced.is_empty() && forced == defaults::text("mesh_write.backend_journal") {
            return defer("journal-backend");
        }
        let marker = std::fs::read_to_string(dir.join(defaults::text("mesh.backend_marker"))).map(|m| m.trim().to_lowercase()).unwrap_or_default();
        if marker != defaults::text("mesh.backend_sqlite") {
            return defer("store-backend");
        }
    }
    let db = dir.join(defaults::text("mesh_write.store_file"));
    if !db.exists() {
        return Ok(None);
    }
    MeshReader::open(&db).map(Some).map_err(|e| ident::Defer(format!("store-open:{e}")))
}

/// The reader nonce of this process, derived once (it walks the process table): the tick reads it and the background
/// verifier is handed the same value.
pub fn reader_nonce_cached(home: &Path) -> Option<String> {
    static NONCE: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    NONCE.get_or_init(|| ident::reader_nonce(home)).clone()
}

/// The project's open reader and its registry rows, as `resolveWorkspaceStoreForRead` settles them for a read of `id`.
pub(crate) struct Opened {
    /// The caller's project key.
    pub repo_key: String,
    /// The read-only store of that project.
    pub reader: MeshReader,
    /// The registry rows.
    pub rows: Vec<ident::Row>,
}

/// `resolveWorkspaceStoreForRead` for a read of `id`: the caller's project against the id's registered project, then the
/// re-home trigger, then the store (read only) and its registry. Anything Node would write or refuse defers.
pub(crate) fn open_partition(inv: &Inv, id: &str, desc: &OVal) -> R<Opened> {
    let Some(repo_key) = ident::resolve_context(&inv.cwd, true)?.repo_key else { return defer("no-project") };
    if let Some(reg) = crate::meshw::inbox::registered_repo_key(desc, id)?
        && reg != repo_key
    {
        return defer("project-context-mismatch");
    }
    rehome_is_noop(inv, id)?;
    let Some(reader) = open_reader(inv, &repo_key)? else { return defer("no-store") };
    let rows = ident::rows_of(&reader.roster().map_err(|e| ident::Defer(format!("registry:{e}")))?);
    Ok(Opened { repo_key, reader, rows })
}

/// `resolveMeshPartitionIds`: a second registry row of the same worktree widens the read to a mesh group, which Node folds.
pub(crate) fn single_partition(rows: &[ident::Row], desc: &OVal, id: &str) -> R<()> {
    let own_wt = rows.iter().find(|r| r.id == id).and_then(|r| r.worktree_path.clone());
    let wt = match own_wt {
        Some(w) if !w.is_empty() => Some(w),
        _ => union::path_field(desc, defaults::text("mesh_write.field_worktree_path"))?,
    };
    if let Some(wt) = wt
        && let Some(mesh) = ident::canonical_mesh_id(&wt)?
    {
        let mut ids: Vec<String> = mesh_candidates(rows, Some(mesh.as_str()))?.into_iter().map(|r| r.id).collect();
        ids.sort();
        ids.dedup();
        if ids.len() > 1 && ids.iter().any(|x| x == id) {
            return defer("mesh-group");
        }
    }
    Ok(())
}

/// `positions()`: the floor rows, then this reader's own rows when it is a declared reader: `(store base, nd base)`.
pub(crate) fn read_bases(inv: &Inv, reader: &MeshReader, id: &str, cursor_file: Option<&str>) -> R<(f64, f64)> {
    let (mut store_base, mut nd_base) = union::floor_bases(reader, &inv.home, id, cursor_file)?;
    if let Some(me) = crate::meshw::cursors::reader_key(reader_nonce_cached(&inv.home).as_deref()) {
        let cursor_rows = reader.reader_cursors(id).map_err(|e| ident::Defer(format!("cursor-rows:{e}")))?;
        let own = |ns: &str| cursor_rows.iter().find(|r| r["ns"] == ns && r["reader"] == me.as_str()).and_then(|r| r["value"].as_f64());
        if let Some(v) = own(defaults::text("mesh_write.cursor_ns_store")) {
            store_base = v;
        }
        if let Some(v) = own(defaults::text("mesh_write.cursor_ns_nd")) {
            nd_base = v;
        }
    }
    Ok((store_base, nd_base))
}

/// What `count` reports for a single partition that a tick uses.
pub(crate) struct Counted {
    /// The caller's project key.
    pub repo_key: String,
    /// `known`: the inbox and its cursor file both read.
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
    /// `total` (only a known count reports a merged total).
    pub total: Option<usize>,
}

/// `count` for a single, registered partition. An unknown count (the inbox or its cursor file does not read) is the store
/// alone, exactly as Node's union reports it; only the line form can print that, since its JSON carries more.
fn count_mail(inv: &Inv, id: &str, desc: &OVal, line_form: bool) -> R<Counted> {
    if !matches!(desc.get(defaults::text("mesh_write.field_id")), Some(OVal::Str(d)) if d == id) {
        return defer("descriptor-id");
    }
    let Some(inbox) = union::path_field(desc, defaults::text("mesh_write.field_inbox_path"))? else { return defer("no-inbox-path") };
    let Some(cursor_file) = union::path_field(desc, defaults::text("mesh_write.field_cursor_path"))? else { return defer("no-cursor-path") };
    let o = open_partition(inv, id, desc)?;
    single_partition(&o.rows, desc, id)?;
    let (store_base, nd_base) = read_bases(inv, &o.reader, id, Some(cursor_file.as_str()))?;
    // known: the inbox and its cursor file both read (otherwise Node prints a warning and the count is unknown)
    let known = union::non_empty_lines(&inbox).is_some() && union::cursor_position(&cursor_file)?.is_some();
    if !known && !line_form {
        return defer("unknown-count");
    }
    let input = union::UnionIn {
        inbox: known.then_some(inbox.as_str()),
        cursor_file: known.then_some(cursor_file.as_str()),
        id,
        store: Some(&o.reader),
        store_base,
        nd_base,
        now: inv.now,
    };
    let u = union::union_unread(&input)?;
    let total = if known { Some(union::merged_total(&input)?) } else { None };
    let nd_cursor = if nd_base.is_finite() && nd_base > 0.0 { nd_base.floor() } else { 0.0 };
    Ok(Counted {
        repo_key: o.repo_key,
        known,
        unread: u.unread,
        nd_unread: u.nd_unread_lines.len(),
        store_unread: u.store_only_unread.len(),
        nd_cursor,
        store_cursor: store_base,
        total,
    })
}

/// `pidIsAlive(pid)` without a start-time check: `Some(false)` only when the process is gone.
fn pid_alive(pid: f64) -> Option<bool> {
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

/// `Number(v)` for the JSON values a lock's `ts` can hold; anything JavaScript would convert in its own way defers.
fn js_number(v: Option<&OVal>) -> R<f64> {
    match v {
        None => Ok(f64::NAN),
        Some(OVal::Num(x)) => Ok(*x),
        Some(OVal::Str(t)) => Ok(js_number_of_str(t)),
        Some(OVal::Null) => Ok(0.0),
        Some(OVal::Bool(b)) => Ok(f64::from(u8::from(*b))),
        Some(_) => defer("lock-field-type"),
    }
}

/// `watcherArmed` from the lock file alone: a fresh lock whose pid is not provably gone. An unreadable or malformed lock
/// reads as not armed.
fn watcher_lock(inv: &Inv, id: &str) -> R<(PathBuf, bool)> {
    let file = devswarm_root(&inv.home).join(defaults::text("mesh_write.dir_locks")).join(format!(
        "{}{id}{}",
        defaults::text("mesh_write.wake_lock_prefix"),
        defaults::text("mesh_write.wake_lock_suffix")
    ));
    let Ok(bytes) = std::fs::read(&file) else { return Ok((file, false)) };
    let Some(lock @ OVal::Obj(_)) = OVal::parse(&String::from_utf8_lossy(&bytes)) else { return Ok((file, false)) };
    let ts = js_number(lock.get("ts"))?;
    let fresh = ts.is_finite() && (inv.now as f64 - ts) <= defaults::num("mesh_write.wake_lock_stale_ms") as f64;
    let alive = match lock.get("pid") {
        Some(OVal::Num(p)) if p.is_finite() && p.fract() == 0.0 => pid_alive(*p),
        _ => None,
    };
    Ok((file, fresh && alive != Some(false)))
}

/// `Number(JSON.parse(file).seq) || 0`.
fn previous_seq(file: &Path) -> R<f64> {
    let Ok(bytes) = std::fs::read(file) else { return Ok(0.0) };
    let Some(OVal::Obj(o)) = OVal::parse(&String::from_utf8_lossy(&bytes)) else { return Ok(0.0) };
    let seq = js_number(o.iter().find(|(k, _)| k == "seq").map(|(_, v)| v))?;
    if seq.is_nan() {
        return Ok(0.0);
    }
    if !seq.is_finite() {
        return defer("seq-not-finite");
    }
    Ok(seq)
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

/// Effect 1: the wake-tick marker.
fn write_marker(inv: &Inv, id: &str, unread: usize, known: bool, seq: f64) {
    let dir = devswarm_root(&inv.home).join(defaults::text("mesh_write.dir_wake_tick"));
    let mut m = Obj::default();
    m.put("ts", n(inv.now as f64)).put("unreadTotal", n(unread as f64)).put("meshGapWithheld", OVal::Bool(false)).put("known", OVal::Bool(known));
    if seq != 0.0 {
        m.put("seq", n(seq));
    }
    let file = dir.join(format!("{id}{}", defaults::text("mesh_write.json_suffix")));
    let go = || -> std::io::Result<()> {
        std::fs::create_dir_all(&dir)?;
        write_staged(&file, &m.done().stringify(), inv.now)
    };
    crate::discard::harmless(go()); // keep: the marker is instrumentation only (Node's catch)
}

/// Effect 2: the heartbeat refresh. `Err(Defer)` only for an existing record the engine cannot update like Node does.
fn heartbeat_beat(inv: &Inv, id: &str) -> R<OVal> {
    let file = devswarm_root(&inv.home).join(defaults::text("mesh_write.dir_heartbeats")).join(format!("{id}{}", defaults::text("mesh_write.json_suffix")));
    let now = inv.now as f64;
    let existing = std::fs::read(&file).ok().and_then(|b| OVal::parse(&String::from_utf8_lossy(&b)));
    match existing {
        Some(mut beat @ OVal::Obj(_)) => {
            beat.set("ts", n(now));
            beat.set("state_ts", n(now));
            beat.set("version", running_version());
            Ok(beat)
        }
        // an array is an object to JavaScript (the assignments do not show in its JSON); defer rather than copy that
        Some(OVal::Arr(_)) => defer("heartbeat-array"),
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
            Ok(b.done())
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

/// The JSON form of a tick: `count`'s result with `action` renamed in place, then `idMismatch` and `watcherArmed`.
fn count_json(inv: &Inv, id: &str, c: &Counted) -> R<String> {
    let Some(total) = c.total else { return defer("unknown-count-json") };
    if c.store_unread > defaults::num("mesh_write.inbox_read_limit") as usize {
        return defer("read-cap");
    }
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(true))
        .put("action", s(defaults::text("mesh_write.verb_tick")))
        .put("id", s(id))
        .put("repoKey", s(&c.repo_key))
        .put("storePath", OVal::Str(union::store_dir(&inv.home, &c.repo_key).to_string_lossy().into_owned()))
        .put("cwd", s(&inv.cwd))
        .put("meshPartitionIds", OVal::Arr(vec![s(id)]))
        .put("unreadTotal", n(c.unread as f64))
        .put("unreadNdjson", n(c.nd_unread as f64))
        .put("unreadStore", n(c.store_unread as f64))
        .put("cursorNdjson", n(c.nd_cursor))
        .put("cursorStore", n(c.store_cursor))
        .put("total", n(total as f64))
        .put("known", OVal::Bool(c.known))
        .put("storeUnavailable", OVal::Bool(false))
        .put("storeUnavailableReason", OVal::Null)
        .put("meshGroupUnresolved", OVal::Bool(false))
        .put("meshGroupError", OVal::Null)
        .put("totalsPartial", OVal::Bool(false))
        .put("unread", n(c.unread as f64))
        .put("cursor", n(c.nd_cursor))
        .put("storeCursor", n(c.store_cursor))
        .put("storeUnread", n(c.store_unread as f64))
        .put("idMismatch", OVal::Bool(false))
        .put("watcherArmed", OVal::Bool(true));
    Ok(o.done().stringify())
}

/// Run `inbox tick <id>` in its line form (`--quiet`) or its JSON form.
pub fn run(inv: &Inv, a: &Args) -> R<Answer> {
    if a.is_help() {
        return defer("help");
    }
    if a.positionals.len() != 3 {
        return defer("argv-shape");
    }
    let Some(id) = a.positionals.get(2).map(String::as_str).filter(|i| is_safe_id(i)) else { return defer("bad-id") };
    let form = tick_form(a)?;
    if id_mismatch_possible(inv, id) {
        return defer("id-mismatch");
    }
    if anchor_refresh_possible(inv)? {
        return defer("anchor-refresh");
    }
    if roster_setting_possible(inv) {
        return defer("roster-setting");
    }
    // ---- reads: everything that can defer happens before the first write ----
    let Some(desc) = ident::read_descriptor(&inv.home, id) else { return defer("no-descriptor") };
    // a `--child` tick pulls first: the ensure may complete the descriptor the count then reads
    let prepared = if form.child { Some(crate::meshw::pull::prepare(inv, id, &desc)?) } else { None };
    let counted = count_mail(inv, id, prepared.as_ref().map_or(&desc, |p| p.ensured()), form.line)?;
    wal_is_quiet(inv, prepared.as_ref().map(|p| p.wal_path()))?;
    let marker_file =
        devswarm_root(&inv.home).join(defaults::text("mesh_write.dir_wake_tick")).join(format!("{id}{}", defaults::text("mesh_write.json_suffix")));
    let seq = previous_seq(&marker_file)?;
    let beat = heartbeat_beat(inv, id)?;
    let (lock_file, armed) = watcher_lock(inv, id)?;
    if !armed {
        // the idle, archived and limit skips and the re-arm cue are Node's
        return defer("watcher-not-armed");
    }
    // the pull's plan settles every remaining deferral (the lock, the delivery log, the native count) before any write
    let pull_plan = match prepared {
        Some(p) => Some(p.finish(inv, counted.store_unread, form.line)?),
        None => None,
    };
    // ---- writes ----
    let (counted, wal_blocked) = match pull_plan {
        Some(p) => {
            // `execute` takes the workspace's lock first and defers only while nothing is written; it marks the commit point itself
            let out = crate::meshw::pull::execute(inv, p)?;
            // the count runs after the pull, over what the pull left (a failure here is a committed failure: exit 70)
            let after = ident::read_descriptor(&inv.home, id).unwrap_or(desc);
            (count_mail(inv, id, &after, form.line)?, out.wal_blocked)
        }
        None => {
            crate::meshw::mark_committed();
            (counted, false)
        }
    };
    let unread = counted.unread;
    // a pull refused because its delivery log is unwritable: mail may be waiting that this count cannot see, so it is UNKNOWN
    let known = counted.known && !wal_blocked;
    write_marker(inv, id, unread, known, seq);
    write_heartbeat(inv, id, &beat);
    if unread > 0 && lock_file.exists() {
        write_cron_found_mail(inv, id, unread);
    }
    if !counted.known {
        // `emitKnownWarning`: the count is not known and the caller is told on stderr
        eprintln!(
            "{}",
            defaults::render(
                "mesh_write.known_warning",
                &[
                    (
                        "label",
                        &format!(
                            "{} {} {}",
                            defaults::text("mesh_write.verb_inbox"),
                            defaults::text("mesh_write.verb_tick"),
                            OVal::Str(id.to_string()).stringify()
                        )
                    ),
                    ("reasons", &defaults::text("mesh_write.known_unknown"))
                ]
            )
        );
    }
    if !form.line {
        if wal_blocked {
            return defer("wal-blocked-json");
        }
        return Ok(Answer { code: 0, stdout: format!("{}\n", count_json(inv, id, &counted)?), effect: Effect::None });
    }
    let line = defaults::render(
        "mesh_write.tick_line",
        &[
            ("id", &id),
            ("unread", &unread),
            ("known", &if known { defaults::text("mesh_write.js_true") } else { defaults::text("mesh_write.js_false") }),
            ("gap", &defaults::text("mesh_write.js_false")),
            ("armed", &defaults::text("mesh_write.js_true")),
        ],
    );
    Ok(Answer { code: 0, stdout: format!("{line}\n"), effect: Effect::None })
}
