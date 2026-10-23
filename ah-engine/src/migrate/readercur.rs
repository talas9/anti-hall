//! The reader-cursor model of `companion/lib/reader-cursors.js` as the post-update store repairs use it (roadmap #61 chunk C1):
//! the one-time import of the legacy read positions (`importLegacy`), the loss-free raise (`raiseAllLossFree`), the retirement of
//! provably ended readers (`retireEnded`) and the repair of the floors the v0.106.0 import pinned (`repairPinnedFloors`).
//!
//! Everything works on the engine's own store handles (`crate::meshw::store`, `crate::mesh`), in Node's statements and order:
//! one transaction per partition, a value that only ever rises, a reader that leaves the floor's minimum only when its process
//! is PROVABLY gone (a row is retired by marking it, never removed), and the legacy cursor files read and raised, never deleted.
//!
//! Where Node's answer depends on something the engine cannot decide by itself (a session's working directory that only git can
//! classify) the port sets [`Cx::deferred`]; the stage then hands the whole run to Node (idempotent, so the part already done is
//! not repeated).
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` / `let _ =` in this file is a deliberate keep, for these reasons:
// - the legacy cursor projections and the per-file reads are best-effort in Node (`try { ... } catch (_) {}`)
// - a file that does not read or parse is the absent value
use crate::checks::guardkit::ojson::OVal;
use crate::checks::jsport::num::to_js_string;
use crate::defaults;
use crate::mesh::MeshReader;
use crate::meshw::cursors::{self, ProcTable, Procs, live_min, row_of};
use crate::meshw::ident;
use crate::meshw::idlock::{devswarm_root, is_safe_id};
use crate::meshw::store::{CursorPut, CursorRow, CursorTx, MeshStore};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

/// What a run needs besides the store: the home, the one process snapshot, whether Node must decide.
pub(crate) struct Cx {
    pub home: PathBuf,
    pub procs: Procs,
    /// Set when the engine met a case only Node decides (see the module docs).
    pub deferred: bool,
    pub now: i64,
}

impl Cx {
    pub(crate) fn new(home: &str) -> Cx {
        Cx { home: PathBuf::from(home), procs: Procs::default(), deferred: false, now: crate::meshw::common::now_ms() }
    }

    fn table(&mut self) -> Option<ProcTable> {
        self.procs.get().cloned()
    }
}

/// An open store: read-write, or read-only for a preview.
pub(crate) enum Handle {
    Rw(MeshStore),
    Ro(MeshReader),
}

impl Handle {
    pub(crate) fn rd(&self) -> &MeshReader {
        match self {
            Handle::Rw(s) => s.reader(),
            Handle::Ro(r) => r,
        }
    }

    pub(crate) fn rw(&self) -> Result<&MeshStore, String> {
        match self {
            Handle::Rw(s) => Ok(s),
            Handle::Ro(_) => Err(defaults::text("update_post.err_read_only").to_string()),
        }
    }
}

/// `<home>/.anti-hall/devswarm/store/<hash>`.
pub(crate) fn store_dir(home: &Path, hash: &str) -> PathBuf {
    devswarm_root(home).join(defaults::text("mesh_write.dir_store")).join(hash)
}

/// True when the engine can open this store the way `openStore` would: a sqlite `BACKEND` marker and a database file.
pub(crate) fn sqlite_store(home: &Path, hash: &str) -> bool {
    let dir = store_dir(home, hash);
    let marker = std::fs::read_to_string(dir.join(defaults::text("mesh.backend_marker"))).map(|s| s.trim().to_lowercase()).unwrap_or_default();
    marker == defaults::text("mesh.backend_sqlite") && dir.join(defaults::text("mesh_write.store_file")).is_file()
}

/// `resolveStoreBackend` for a store with no `BACKEND` marker (or one that names neither backend): a non-empty database file means
/// sqlite (`inferBackendFromDisk` prefers it over any journal), and a read-write open pins that with the marker (a temporary file,
/// then a rename). A journal marker, no database or an empty one is not the engine's to settle: false.
pub(crate) fn adopt_legacy_marker(home: &Path, hash: &str, read_only: bool) -> bool {
    let dir = store_dir(home, hash);
    let (marker_name, sqlite) = (defaults::text("mesh.backend_marker"), defaults::text("mesh.backend_sqlite"));
    let marker = std::fs::read_to_string(dir.join(marker_name)).map(|s| s.trim().to_lowercase()).unwrap_or_default();
    if marker == defaults::text("mesh_write.backend_journal") || marker == sqlite {
        return false; // a journal store stays Node's; a sqlite marker with no database file is a store the engine cannot open either
    }
    if !std::fs::metadata(dir.join(defaults::text("mesh_write.store_file"))).is_ok_and(|m| m.len() > 0) {
        return false;
    }
    if read_only {
        return true;
    }
    let tmp = dir.join(format!("{marker_name}.{}.{}{}", std::process::id(), crate::health::now_ms(), defaults::text("mesh_write.tmp_suffix")));
    let style = crate::atomic::Style { leave_temp_on_rename_failure: true, ..crate::atomic::Style::default() }; // Node leaves the temp file after a failed rename
    crate::atomic::stage(&tmp, sqlite, style).and_then(|()| crate::atomic::replace(&tmp, dir.join(marker_name), style)).is_ok()
}

/// `openStore({ home, hash, readOnly })`.
pub(crate) fn open(home: &Path, hash: &str, read_only: bool) -> Result<Handle, String> {
    let db = store_dir(home, hash).join(defaults::text("mesh_write.store_file"));
    if read_only {
        MeshReader::open(&db).map(Handle::Ro).map_err(|e| e.to_string())
    } else {
        MeshStore::open(&db).map(Handle::Rw).map_err(|e| e.to_string())
    }
}

fn floor_name() -> &'static str {
    defaults::text("mesh_write.floor_reader")
}

fn namespaces() -> Vec<&'static str> {
    defaults::list("mesh_write.cursor_namespaces")
}

// ---- the legacy (pre-Phase-3) positions, read only --------------------------------------------------------------------------

fn cursors_dir(home: &Path) -> PathBuf {
    devswarm_root(home).join(defaults::text("mesh_write.dir_cursors"))
}

fn strict_digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

/// `parseReader`: `h:<digits>:<digits>` -> `(pid, startMs)`.
fn parse_reader(reader: &str) -> Option<(f64, f64)> {
    let rest = reader.strip_prefix(defaults::text("mesh_write.nonce_prefix"))?;
    let (pid, start) = rest.split_once(':')?;
    (strict_digits(pid) && strict_digits(start)).then_some(())?;
    Some((pid.parse().ok()?, start.parse().ok()?))
}

/// `legacyShortFor(reader)`: the tag the pre-Phase-3 build minted for the same harness, `sha1("anc:<pid>:<startMs>")`.
pub(crate) fn legacy_short_for(reader: &str) -> Option<String> {
    let (pid, start) = parse_reader(reader)?;
    Some(cursors::short_nonce(&format!("{}{}:{}", defaults::text("update_post.anchor_prefix"), to_js_string(pid), to_js_string(start))))
}

/// `provablyEnded(reader, procTable)`: true only on proof; no snapshot, an unparseable reader and everything uncertain is live.
fn provably_ended(reader: &str, table: Option<&ProcTable>) -> bool {
    match (parse_reader(reader), table) {
        (Some(_), Some(t)) => cursors::provably_ended(reader, t),
        _ => false,
    }
}

/// `listLegacy(home, id, sep)`: `(short, value)` for every `<id><sep><short6>.json`; an unreadable file counts as 0.
pub(crate) fn list_legacy(home: &Path, id: &str, sep: &str) -> Vec<(String, f64)> {
    let mut out = Vec::new();
    if !cursors::legacy_safe(id) {
        return out;
    }
    let dir = cursors_dir(home);
    let Ok(rd) = std::fs::read_dir(&dir) else { return out };
    let mut names: Vec<String> = rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    let prefix = format!("{id}{sep}");
    let suffix = defaults::text("mesh_write.json_suffix");
    for n in names {
        if !n.starts_with(&prefix) || !n.ends_with(suffix) || n.len() < prefix.len() + suffix.len() {
            continue;
        }
        let Some(short) = n.get(prefix.len()..n.len() - suffix.len()) else { continue };
        if short.len() != defaults::num("mesh_write.legacy_cursor_short_len") as usize || !short.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
            continue;
        }
        out.push((short.to_string(), cursors::read_cursor(&dir.join(&n))));
    }
    out
}

fn legacy_shared_cursor(rd: &MeshReader, home: &Path, id: &str) -> f64 {
    let json = cursors::read_cursor(&cursors::primary_cursor_path(home, id));
    let row = rd.cursor(id).unwrap_or(0) as f64;
    json.max(row)
}

fn legacy_baseline(rd: &MeshReader, home: &Path, id: &str) -> f64 {
    if cursors::legacy_safe(id) {
        let bp = cursors_dir(home).join(format!("{id}{}", defaults::text("update_post.legacy_base_suffix")));
        if bp.exists() {
            return cursors::read_cursor(&bp);
        }
    }
    legacy_shared_cursor(rd, home, id)
}

/// `legacyStoreFloor`: HEAD's `instanceFloor`, dry: `max(#base | shared pair, MIN over the #inst files)`. Read only: `positions()` takes
/// it as the store floor of a partition that has no floor row yet.
pub(crate) fn legacy_store_floor(rd: &MeshReader, home: &Path, id: &str) -> f64 {
    let baseline = legacy_baseline(rd, home, id);
    let files = list_legacy(home, id, defaults::text("update_post.legacy_inst_sep"));
    match files.iter().map(|f| f.1).reduce(f64::min) {
        None => baseline,
        Some(min) => baseline.max(min),
    }
}

/// `legacyNdFloor(cursorPath)`: the legacy NDJSON cursor, 0 without one.
pub(crate) fn legacy_nd_floor(cursor_path: Option<&str>) -> f64 {
    cursor_path.filter(|p| !p.is_empty()).map_or(0.0, |p| cursors::read_cursor(Path::new(p)))
}

/// `descriptorOf(home, partition)`: the descriptor object, else `None`.
pub(crate) fn descriptor_of(home: &Path, partition: &str) -> Option<OVal> {
    if !is_safe_id(partition) {
        return None;
    }
    let p = devswarm_root(home).join(defaults::text("mesh_write.dir_workspaces")).join(format!("{partition}{}", defaults::text("mesh_write.json_suffix")));
    match OVal::parse(&String::from_utf8_lossy(&std::fs::read(p).ok()?)) {
        Some(v @ OVal::Obj(_)) => Some(v),
        _ => None,
    }
}

pub(crate) fn desc_cursor_path(desc: Option<&OVal>) -> Option<String> {
    match desc.and_then(|d| d.get("cursorPath")) {
        Some(OVal::Str(s)) if !s.is_empty() => Some(s.clone()),
        _ => None,
    }
}

/// `distinctNdFloor`: the legacy nd cursor, but only when that file is a real nd cursor (not the partition's own shared store
/// cursor, which holds store positions).
fn distinct_nd_floor(home: &Path, partition: &str, cursor_path: Option<&str>) -> f64 {
    let Some(cp) = cursor_path.filter(|p| !p.is_empty()) else { return 0.0 };
    if ident::resolve_abs(cp) == ident::resolve_abs(&cursors::primary_cursor_path(home, partition).to_string_lossy()) {
        return 0.0;
    }
    legacy_nd_floor(Some(cp))
}

fn mapped_shorts(home: &Path, partition: &str) -> HashSet<String> {
    let mut s = HashSet::new();
    for sep in ["update_post.legacy_inst_sep", "update_post.legacy_nd_sep"] {
        s.extend(list_legacy(home, partition, defaults::text(sep)).into_iter().map(|f| f.0));
    }
    s
}

// ---- sessions ---------------------------------------------------------------------------------------------------------------

fn js_str(v: &OVal) -> String {
    match v {
        OVal::Str(s) => s.clone(),
        OVal::Num(n) => to_js_string(*n),
        OVal::Bool(b) => b.to_string(),
        _ => v.stringify(),
    }
}

fn sessions_dir(home: &Path) -> PathBuf {
    home.join(defaults::text("update_post.sessions_rel"))
}

/// The pid of a session file name (`<digits>.json`).
fn session_pid(name: &str) -> Option<f64> {
    let stem = name.strip_suffix(defaults::text("mesh_write.json_suffix"))?;
    strict_digits(stem).then(|| stem.parse().ok()).flatten()
}

struct Session {
    reader: String,
    cwd: Option<String>,
}

/// `liveHarnessSessions`: every session file whose process is not PROVABLY ended (the file only names the candidate).
fn live_sessions(cx: &mut Cx) -> Vec<Session> {
    let mut out = Vec::new();
    let dir = sessions_dir(&cx.home);
    let Ok(rd) = std::fs::read_dir(&dir) else { return out };
    let mut names: Vec<String> = rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    let mut table: Option<Option<ProcTable>> = None;
    for n in names {
        if session_pid(&n).is_none() {
            continue;
        }
        let fp = dir.join(&n);
        let Some(rec) = std::fs::read(&fp).ok().and_then(|b| OVal::parse(&String::from_utf8_lossy(&b))) else { continue };
        let Some(OVal::Num(pid)) = rec.get("pid") else { continue };
        if pid.fract() != 0.0 || *pid <= 1.0 || format!("{}{}", to_js_string(*pid), defaults::text("mesh_write.json_suffix")) != n {
            continue;
        }
        let start = match rec.get("startedAt") {
            Some(OVal::Num(x)) if x.is_finite() => *x,
            _ => mtime_ms(&fp).unwrap_or(0.0),
        };
        let reader = format!("{}{}:{}", defaults::text("mesh_write.nonce_prefix"), to_js_string(*pid), to_js_string(if start.is_finite() { start } else { 0.0 }));
        let t = table.get_or_insert_with(|| cx.table());
        if !provably_ended(&reader, t.as_ref()) {
            out.push(Session { reader, cwd: rec.get("cwd").filter(|c| !matches!(c, OVal::Null)).map(js_str) });
        }
    }
    out
}

/// `fs.statSync(p).mtimeMs`.
fn mtime_ms(p: &Path) -> Option<f64> {
    let d = std::fs::metadata(p).ok()?.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?;
    Some(d.as_secs() as f64 * 1000.0 + f64::from(d.subsec_nanos()) / 1e6)
}

// ---- partition <-> session locality ----------------------------------------------------------------------------------------

/// `partitionMeshIds(partition, desc)`.
fn partition_mesh_ids(cx: &mut Cx, partition: &str, desc: Option<&OVal>) -> HashSet<String> {
    let mut ids = HashSet::new();
    let hexn = defaults::num("mesh_write.mesh_id_hex") as usize;
    if let Some(rest) = partition.strip_prefix(defaults::text("mesh_write.primary_prefix"))
        && rest.len() == hexn
        && rest.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        ids.insert(partition.to_string());
    }
    if let Some(OVal::Str(wt)) = desc.and_then(|d| d.get("worktreePath"))
        && !wt.is_empty()
    {
        match ident::resolve_context(wt, false) {
            Ok(c) => {
                if let Some(root) = c.worktree_root {
                    ids.insert(ident::mesh_id_for_real_path(&root));
                }
            }
            Err(_) => cx.deferred = true,
        }
    }
    ids
}

/// `cwdInPartition(cwd, meshIds)`: tri-state; only a CONFIRMED `false` excludes a session.
fn cwd_in_partition(cx: &mut Cx, cwd: Option<&str>, ids: &HashSet<String>) -> Option<bool> {
    // Node: `!cwd` is a confident `false` (no working directory is local to nothing), never "uncertain".
    let Some(cwd) = cwd.filter(|c| !c.is_empty()) else { return Some(false) };
    if ids.is_empty() {
        return Some(false);
    }
    match ident::resolve_context(cwd, false) {
        Ok(c) => Some(c.worktree_root.is_some_and(|r| ids.contains(&ident::mesh_id_for_real_path(&r)))),
        // a resolution git could not answer (a failed or timed-out superproject query) is Node's `c.uncertain`: `null`, which every
        // caller reads as "keep / include", never as a confident "no". Any other reason (a relative path Node would resolve against
        // its own working directory) is not reproducible: Node's.
        Err(d) if d.0 == "git-superproject" => None,
        Err(_) => {
            cx.deferred = true;
            None
        }
    }
}

// ---- the import ---------------------------------------------------------------------------------------------------------------

/// A value per cursor namespace.
#[derive(Clone, Copy, Default)]
pub(crate) struct Two<T> {
    pub store: T,
    pub nd: T,
}

impl<T: Copy> Two<T> {
    fn at(&self, ns: &str) -> T {
        if ns == defaults::text("mesh_write.ns_store") { self.store } else { self.nd }
    }

    fn set(&mut self, ns: &str, v: T) {
        if ns == defaults::text("mesh_write.ns_store") {
            self.store = v;
        } else {
            self.nd = v;
        }
    }

    fn both(&self) -> [T; 2] {
        [self.store, self.nd]
    }
}

/// `(store, nd)` namespace names in Node's order.
fn ns_pair() -> (&'static str, &'static str) {
    let l = namespaces();
    (l.first().copied().unwrap_or_default(), l.get(1).copied().unwrap_or_default())
}

/// Both namespace names, to iterate.
fn ns_array() -> [&'static str; 2] {
    let (store, nd) = ns_pair();
    [store, nd]
}

struct Plan {
    floors: Two<f64>,
    /// `(reader, ns, value)`.
    readers: Vec<(String, &'static str, f64)>,
}

/// `importPlan` for its side effect on [`Cx::deferred`] only: nothing is written.
pub(crate) fn import_plan_dry(cx: &mut Cx, h: &Handle, partition: &str, cursor_path: Option<&str>) {
    import_plan(cx, h, partition, cursor_path);
}

/// What `raiseAllLossFree` would plan for a partition not yet imported, for its side effect on [`Cx::deferred`] only.
pub(crate) fn raise_probe(cx: &mut Cx, h: &Handle, partition: &str) {
    if cursors::rows_from_reader(h.rd(), partition).is_ok_and(|rows| cursors::needs_import(&rows)) {
        import_plan(cx, h, partition, None);
    }
}

/// `importPlan(store, { partition, cursorPath, home })`.
fn import_plan(cx: &mut Cx, h: &Handle, partition: &str, cursor_path: Option<&str>) -> Plan {
    let home = cx.home.clone();
    let desc = descriptor_of(&home, partition);
    let cursor_path = cursor_path.filter(|p| !p.is_empty()).map(str::to_string).or_else(|| desc_cursor_path(desc.as_ref()));
    let floors = Two { store: legacy_store_floor(h.rd(), &home, partition), nd: legacy_nd_floor(cursor_path.as_deref()) };
    let mesh_ids = partition_mesh_ids(cx, partition, desc.as_ref());
    let mapped = mapped_shorts(&home, partition);
    let mut harnesses = Vec::new();
    for s in live_sessions(cx) {
        let is_mapped = legacy_short_for(&s.reader).is_some_and(|sh| mapped.contains(&sh));
        if is_mapped || cwd_in_partition(cx, s.cwd.as_deref(), &mesh_ids) != Some(false) {
            harnesses.push(s.reader);
        }
    }
    let mut readers = Vec::new();
    if !harnesses.is_empty() {
        let baseline = legacy_baseline(h.rd(), &home, partition);
        let inst: HashMap<String, f64> = list_legacy(&home, partition, defaults::text("update_post.legacy_inst_sep")).into_iter().collect();
        let nd: HashMap<String, f64> = list_legacy(&home, partition, defaults::text("update_post.legacy_nd_sep")).into_iter().collect();
        let (store_ns, nd_ns) = ns_pair();
        for reader in harnesses {
            let short = legacy_short_for(&reader);
            let sv = short.as_ref().and_then(|s| inst.get(s)).map_or(floors.store, |v| baseline.max(*v));
            let nv = short.as_ref().and_then(|s| nd.get(s)).copied().unwrap_or(floors.nd);
            readers.push((reader.clone(), store_ns, sv));
            readers.push((reader, nd_ns, nv));
        }
    }
    Plan { floors, readers }
}

/// `applyImport(tx, rows, plan, now)`: the missing floor rows and every planned reader row; true when anything was written.
fn apply_import(tx: &CursorTx<'_>, partition: &str, rows: &[CursorRow], plan: &Plan, now: i64) -> rusqlite::Result<bool> {
    let mut wrote = false;
    for ns in namespaces() {
        if row_of(rows, ns, floor_name()).is_some() {
            continue;
        }
        tx.put(&CursorPut { partition: partition.into(), ns: ns.into(), reader: floor_name().into(), value: plan.floors.at(ns) as i64, retired_line: None, updated_at: now })?;
        wrote = true;
        for (reader, rns, value) in &plan.readers {
            if *rns != ns || row_of(rows, ns, reader).is_some() {
                continue;
            }
            tx.put(&CursorPut { partition: partition.into(), ns: ns.into(), reader: reader.clone(), value: *value as i64, retired_line: None, updated_at: now })?;
        }
    }
    Ok(wrote)
}

/// What the rows of a partition would be once `applyImport` has run, without writing anything: the missing floor rows and every
/// planned reader row. `cx.deferred` is set when the plan met a case only Node decides.
pub(crate) fn simulate_import(cx: &mut Cx, h: &Handle, partition: &str, rows: &[CursorRow]) -> Vec<CursorRow> {
    let plan = import_plan(cx, h, partition, None);
    let mut out = rows.to_vec();
    for ns in namespaces() {
        if row_of(rows, ns, floor_name()).is_some() {
            continue;
        }
        out.push(CursorRow { ns: ns.into(), reader: floor_name().into(), value: plan.floors.at(ns) as i64, retired_line: None, updated_at: cx.now });
        for (reader, rns, value) in &plan.readers {
            if *rns != ns || row_of(rows, ns, reader).is_some() {
                continue;
            }
            out.push(CursorRow { ns: ns.into(), reader: reader.clone(), value: *value as i64, retired_line: None, updated_at: cx.now });
        }
    }
    out
}

/// `dualWrite`: the legacy projection after a commit, best effort and upward only.
fn dual_write(h: &Handle, cx: &Cx, partition: &str, ns: &str, cursor_path: Option<&str>, floor: f64) {
    if !floor.is_finite() || floor <= 0.0 {
        return;
    }
    if ns == defaults::text("mesh_write.ns_store") {
        if let Ok(st) = h.rw() {
            cursors::dual_write(st, &cx.home, partition, ns, floor as i64);
        }
    } else if let Some(cp) = cursor_path.filter(|p| !p.is_empty()) {
        let p = Path::new(cp);
        if cursors::read_cursor(p) < floor {
            crate::discard::harmless(cursors::ack_to(p, floor)); // keep: best-effort projection, as in Node
        }
    }
}

/// What `importLegacy` did.
pub(crate) struct Imported {
    pub imported: bool,
    pub would: bool,
}

/// `importLegacy(store, { partition, home, cursorPath, dryRun })`: gated on the absence of the `#floor` rows, checked INSIDE the
/// transaction, so a second run is a no-op. Never deletes anything.
pub(crate) fn import_legacy(cx: &mut Cx, h: &Handle, partition: &str, cursor_path: Option<&str>, dry: bool) -> Result<Imported, String> {
    if dry {
        let rows = cursors::rows_from_reader(h.rd(), partition)?;
        if !cursors::needs_import(&rows) {
            return Ok(Imported { imported: false, would: false });
        }
        import_plan(cx, h, partition, cursor_path);
        return Ok(Imported { imported: false, would: true });
    }
    let st = h.rw()?;
    let now = cx.now;
    let mut floors = None;
    let imported = st
        .cursor_txn(|tx| {
            let rows = tx.rows(partition)?;
            if !cursors::needs_import(&rows) {
                return Ok(false);
            }
            let plan = import_plan(cx, h, partition, cursor_path);
            if cx.deferred {
                return Err(rusqlite::Error::ExecuteReturnedResults); // a case only Node decides: roll back, write nothing
            }
            let wrote = apply_import(tx, partition, &rows, &plan, now)?;
            floors = Some(plan.floors);
            Ok(wrote)
        })
        .or_else(|e| if cx.deferred { Ok(false) } else { Err(e.to_string()) })?;
    if imported && let Some(f) = floors {
        for ns in namespaces() {
            dual_write(h, cx, partition, ns, cursor_path, f.at(ns));
        }
    }
    Ok(Imported { imported, would: false })
}

/// `raiseAllLossFree(store, { partition, ns, value, home })`: every row of the namespace, floor included, rises to `value`; a
/// retired row's `retired_line` moves in lockstep. Returns the rows raised.
pub(crate) fn raise_all_loss_free(cx: &mut Cx, h: &Handle, partition: &str, ns: &str, value: i64) -> Result<usize, String> {
    if value <= 0 {
        return Ok(0);
    }
    let st = h.rw()?;
    let now = cx.now;
    let n = st
        .cursor_txn(|tx| {
            let mut rows = tx.rows(partition)?;
            if cursors::needs_import(&rows) {
                let plan = import_plan(cx, h, partition, None);
                if cx.deferred {
                    return Err(rusqlite::Error::ExecuteReturnedResults); // a case only Node decides: roll back, write nothing
                }
                apply_import(tx, partition, &rows, &plan, now)?;
                rows = tx.rows(partition)?;
            }
            let mut c = 0;
            for r in &rows {
                if r.ns != ns || r.value >= value {
                    continue;
                }
                let retired = cursors::is_retired(r).then_some(Some(value));
                tx.put(&CursorPut { partition: partition.into(), ns: ns.into(), reader: r.reader.clone(), value, retired_line: retired, updated_at: now })?;
                c += 1;
            }
            Ok(c)
        })
        .or_else(|e| if cx.deferred { Ok(0) } else { Err(e.to_string()) })?;
    if cx.deferred {
        return Ok(0);
    }
    dual_write(h, cx, partition, ns, None, value as f64);
    Ok(n)
}

/// `floorCursor` / `floorOf(store, partition, 'store')`: the stored floor, or before the import the legacy floor computed dry;
/// an unreadable table reads as 0.
pub(crate) fn floor_store(cx: &Cx, h: &Handle, partition: &str) -> i64 {
    match cursors::rows_from_reader(h.rd(), partition) {
        Err(_) => 0,
        Ok(rows) => match row_of(&rows, defaults::text("mesh_write.ns_store"), floor_name()) {
            Some(f) => f.value,
            None => legacy_store_floor(h.rd(), &cx.home, partition) as i64,
        },
    }
}

/// `retireEnded(store, { partition, procTable })`: readers whose process provably ended are marked retired at their value (one
/// snapshot outside the transaction, compare-and-set inside). Returns how many.
pub(crate) fn retire_ended(cx: &mut Cx, h: &Handle, partition: &str) -> Result<usize, String> {
    let Some(table) = cx.table() else { return Ok(0) };
    let st = h.rw()?;
    let now = cx.now;
    let pre = cursors::rows_from_reader(h.rd(), partition)?;
    let observed: HashMap<(String, String), i64> = pre.iter().map(|r| ((r.ns.clone(), r.reader.clone()), r.value)).collect();
    st.cursor_txn(|tx| {
        let mut n = 0;
        for r in tx.rows(partition)? {
            if r.reader == floor_name() || cursors::is_retired(&r) {
                continue;
            }
            if observed.get(&(r.ns.clone(), r.reader.clone())) != Some(&r.value) || !provably_ended(&r.reader, Some(&table)) {
                continue;
            }
            tx.put(&CursorPut {
                partition: partition.into(),
                ns: r.ns.clone(),
                reader: r.reader.clone(),
                value: r.value,
                retired_line: Some(Some(r.value)),
                updated_at: if r.updated_at != 0 { r.updated_at } else { now },
            })?;
            n += 1;
        }
        Ok(n)
    })
    .map_err(|e| e.to_string())
}

// ---- the repair of pinned floors ----------------------------------------------------------------------------------------------

#[derive(Clone)]
enum SessionRec {
    Ambiguous,
    Rec { start: Option<f64>, cwd: Option<String> },
}

/// `sessionFilesByPid(home)`: `None` when there is no sessions directory.
fn session_files_by_pid(home: &Path) -> Option<HashMap<i64, SessionRec>> {
    let dir = sessions_dir(home);
    let rd = std::fs::read_dir(&dir).ok()?;
    let mut m = HashMap::new();
    for e in rd.flatten() {
        let n = e.file_name().to_string_lossy().into_owned();
        let Some(pid) = session_pid(&n) else { continue };
        let rec = std::fs::read(dir.join(&n)).ok().and_then(|b| OVal::parse(&String::from_utf8_lossy(&b)));
        let key = pid as i64;
        let ok = matches!(rec.as_ref().and_then(|r| r.get("pid")), Some(OVal::Num(p)) if *p == pid);
        let Some(rec) = rec.filter(|_| ok) else {
            m.insert(key, SessionRec::Ambiguous);
            continue;
        };
        let start = match rec.get("startedAt") {
            Some(OVal::Num(x)) if x.is_finite() => Some(*x),
            _ => None,
        };
        m.insert(key, SessionRec::Rec { start, cwd: rec.get("cwd").filter(|c| !matches!(c, OVal::Null)).map(js_str) });
    }
    Some(m)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Verdict {
    Ended,
    SessionGone,
    NotLocal,
}

/// What `repairPinnedFloors` did to one partition.
#[derive(Default)]
pub(crate) struct Repair {
    pub retired: usize,
    /// `(from, to)` of the store and the nd floor.
    pub floors: Two<(i64, i64)>,
    pub changed: bool,
}

impl Repair {
    /// Floors that rose.
    pub(crate) fn floors_raised(&self) -> usize {
        self.floors.both().iter().filter(|(f, t)| t > f).count()
    }
}

struct Plan3 {
    retire: Vec<CursorRow>,
    raise: Vec<(CursorRow, i64)>,
    floors: Two<(i64, i64)>,
}

/// `repairPinnedFloors(store, { partition, home, dryRun })`. Per partition ONE transaction: a declared, non-retired row is
/// RETIRED (never deleted) when its process provably ended, its session file is gone or names another session, or its session is
/// live but not local to the partition and never advanced past the floor; the floor is recomputed `max(F, MIN(remaining))`.
pub(crate) fn repair_pinned_floors(cx: &mut Cx, h: &Handle, partition: &str, dry: bool) -> Result<Repair, String> {
    let pre = cursors::rows_from_reader(h.rd(), partition)?;
    if cursors::needs_import(&pre) {
        return Ok(Repair::default());
    }
    let home = cx.home.clone();
    let desc = descriptor_of(&home, partition);
    let cursor_path = desc_cursor_path(desc.as_ref());
    let mesh_ids = partition_mesh_ids(cx, partition, desc.as_ref());
    let mapped = mapped_shorts(&home, partition);
    let sessions = session_files_by_pid(&home);
    let table = cx.table();
    let legacy_nd = legacy_nd_floor(cursor_path.as_deref());
    let distinct_nd = distinct_nd_floor(&home, partition, cursor_path.as_deref());
    let mut verdicts: HashMap<String, Option<Verdict>> = HashMap::new();
    let (_, nd_ns) = ns_pair();
    let mut plan_for = |cx: &mut Cx, rows: &[CursorRow]| -> Plan3 {
        let mut verdict_of = |cx: &mut Cx, reader: &str| -> Option<Verdict> {
            if let Some(v) = verdicts.get(reader) {
                return *v;
            }
            let mut v = None;
            if let Some((pid, start)) = parse_reader(reader)
                && !legacy_short_for(reader).is_some_and(|s| mapped.contains(&s))
            {
                if provably_ended(reader, table.as_ref()) {
                    v = Some(Verdict::Ended);
                } else if let Some(sessions) = &sessions {
                    v = match sessions.get(&(pid as i64)) {
                        None => Some(Verdict::SessionGone),
                        Some(SessionRec::Ambiguous) | Some(SessionRec::Rec { start: None, .. }) => None,
                        Some(SessionRec::Rec { start: Some(s), .. }) if *s != start => Some(Verdict::SessionGone),
                        Some(SessionRec::Rec { cwd, .. }) => (cwd_in_partition(cx, cwd.as_deref(), &mesh_ids) == Some(false)).then_some(Verdict::NotLocal),
                    };
                }
            }
            verdicts.insert(reader.to_string(), v);
            v
        };
        let mut retire = Vec::new();
        for r in rows {
            if r.reader == floor_name() || cursors::is_retired(r) {
                continue;
            }
            let Some(v) = verdict_of(cx, &r.reader) else { continue };
            let f = row_of(rows, &r.ns, floor_name());
            if v == Verdict::NotLocal && f.is_none_or(|f| r.value > f.value) {
                continue; // advanced past the floor: a real read
            }
            retire.push(r.clone());
        }
        let gone: HashSet<(String, String)> = retire.iter().map(|r| (r.ns.clone(), r.reader.clone())).collect();
        let nd_seed = row_of(rows, nd_ns, floor_name()).map_or(0, |r| r.value);
        let mut raise = Vec::new();
        for r in rows {
            if r.ns != nd_ns || r.reader == floor_name() || cursors::is_retired(r) || gone.contains(&(r.ns.clone(), r.reader.clone())) {
                continue;
            }
            if legacy_short_for(&r.reader).is_some_and(|s| mapped.contains(&s)) {
                continue;
            }
            if r.value <= nd_seed && (r.value as f64) < distinct_nd {
                raise.push((r.clone(), distinct_nd as i64));
            }
        }
        let remaining: Vec<CursorRow> = rows
            .iter()
            .filter(|r| !gone.contains(&(r.ns.clone(), r.reader.clone())))
            .map(|r| match raise.iter().find(|(x, _)| r.ns == nd_ns && x.reader == r.reader) {
                Some((_, to)) => CursorRow { value: *to, ..r.clone() },
                None => r.clone(),
            })
            .collect();
        let mut floors: Two<(i64, i64)> = Two::default();
        for ns in ns_array() {
            let from = row_of(rows, ns, floor_name()).map_or(0, |f| f.value);
            let pin = live_min(&remaining, ns);
            let mut to = pin.map_or(from, |p| from.max(p.value));
            if ns == nd_ns && pin.is_none() && from == 0 && legacy_nd > 0.0 {
                to = legacy_nd as i64;
            }
            if ns == nd_ns && distinct_nd > to as f64 {
                to = distinct_nd as i64;
            }
            floors.set(ns, (from, to));
        }
        Plan3 { retire, raise, floors }
    };
    let shape = |p: &Plan3| Repair {
        retired: p.retire.len(),
        floors: p.floors,
        changed: !p.retire.is_empty() || !p.raise.is_empty() || p.floors.both().iter().any(|(f, t)| t > f),
    };
    if dry {
        return Ok(shape(&plan_for(cx, &pre)));
    }
    let st = h.rw()?;
    let now = cx.now;
    let plan = st
        .cursor_txn(|tx| {
            let rows = tx.rows(partition)?;
            if cursors::needs_import(&rows) {
                return Ok(Plan3 { retire: vec![], raise: vec![], floors: Two::default() });
            }
            let p = plan_for(cx, &rows);
            for r in &p.retire {
                tx.put(&CursorPut { partition: partition.into(), ns: r.ns.clone(), reader: r.reader.clone(), value: r.value, retired_line: Some(Some(r.value)), updated_at: if r.updated_at != 0 { r.updated_at } else { now } })?;
            }
            for (r, to) in &p.raise {
                tx.put(&CursorPut { partition: partition.into(), ns: nd_ns.into(), reader: r.reader.clone(), value: *to, retired_line: None, updated_at: now })?;
            }
            for ns in ns_array() {
                let (from, to) = p.floors.at(ns);
                if to > from {
                    tx.put(&CursorPut { partition: partition.into(), ns: ns.into(), reader: floor_name().into(), value: to, retired_line: None, updated_at: now })?;
                }
            }
            Ok(p)
        })
        .map_err(|e| e.to_string())?;
    let out = shape(&plan);
    for ns in ns_array() {
        let (from, to) = plan.floors.at(ns);
        if to > from {
            dual_write(h, cx, partition, ns, cursor_path.as_deref(), to as f64);
        }
    }
    Ok(out)
}
