//! A read-only reader of the DevSwarm desktop app's own database, ported from `companion/lib/devswarm-app-db.js`
//! (`readSnapshot`, `builderStates`, `appArchivedVerdict` and the cross-invocation cache). The database is the ground
//! truth for archive state: a builder is archived when `isActive = 0` and `isHidden = 1`.
//!
//! The reader opens the file read-only and never waits for a lock (Node's `node:sqlite` does not either): a missing,
//! unreadable, locked or unexpected database is `Ok(None)`, "no opinion", exactly as Node's `null`. Everything the
//! engine cannot read like Node (a relative worktree path, a value of a type JavaScript converts in ways the engine does
//! not reproduce, a cache file of the wrong shape) defers before anything is written.
//!
//! The one write is Node's cross-invocation cache (`<devswarm root>/cache/app-archived.json`, 30 s, keyed by the database's
//! mtime and size and its `-wal` file's). It is returned to the caller as a [`CacheWrite`] so the verb can perform it after
//! its own commit point, never before.
// Discard triage (E3): every `.ok()` / `harmless` in this file is a deliberate keep: Node's reader is fail-open (a throw is
// `null`) and its cache write is best effort (`try { ... } catch (_) {}`).
use crate::checks::guardkit::ojson::OVal;
use crate::defaults;
use crate::meshw::common::{Obj, n, s};
use crate::meshw::ident::{self, Env, R, defer};
use crate::meshw::idlock::devswarm_root;
use rusqlite::types::ValueRef;
use std::collections::HashMap;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

/// One builder as `builderStates` reports it (`archived` is null only for a row read back from a cache file that says so).
#[derive(Debug, Clone, PartialEq)]
pub struct State {
    /// The builder id.
    pub id: String,
    /// `isActive = 1`.
    pub active: bool,
    /// `Some(true)` archived, `Some(false)` not, `None` unknown.
    pub archived: Option<bool>,
    /// The worktree, `normPath`ed.
    pub worktree: Option<String>,
    /// `builderType`.
    pub builder_type: Option<String>,
}

/// The cache file the verb writes after its own commit point.
#[derive(Debug)]
pub struct CacheWrite {
    target: PathBuf,
    text: String,
}

impl CacheWrite {
    /// `writeCrossCache`'s write: tmp then rename, any failure swallowed.
    pub fn perform(&self) {
        let mut tmp = self.target.as_os_str().to_os_string();
        tmp.push(format!(".{}{}", std::process::id(), defaults::text("mesh_write.tmp_suffix")));
        let tmp = PathBuf::from(tmp);
        let r = (|| -> std::io::Result<()> {
            if let Some(d) = self.target.parent() {
                std::fs::create_dir_all(d)?;
            }
            std::fs::write(&tmp, &self.text)?;
            std::fs::rename(&tmp, &self.target)
        })();
        if r.is_err() {
            crate::discard::harmless(std::fs::remove_file(&tmp)); // keep: a failed cache write is swallowed, a staged temp must not leak
        }
    }
}

/// What a lookup found: the states plus the cache write it owes (None when the cache served it, or caching is off).
#[derive(Debug)]
pub struct Found {
    /// `builderStates`' map, in Node's iteration order.
    pub states: Vec<State>,
    /// The cache write to perform after the verb's commit point.
    pub cache: Option<CacheWrite>,
}

fn col_set(conn: &rusqlite::Connection, table: &str) -> Option<Vec<String>> {
    let q = format!("{}{table}{}", crate::sql::MESHW_APP_TABLE_INFO_OPEN, crate::sql::MESHW_APP_TABLE_INFO_CLOSE);
    let mut st = conn.prepare(&q).ok()?;
    let cols: Vec<String> = st.query_map([], |r| r.get::<_, String>(1)).ok()?.collect::<Result<_, _>>().ok()?;
    (!cols.is_empty()).then_some(cols)
}

/// `selectPresent`'s select list: the SCHEMA columns the table has, the prompt column as its length.
fn select_for(table: &str, schema: &[&str], have: &[String]) -> Option<String> {
    let q = crate::sql::MESHW_APP_QUOTE;
    let list: Vec<String> = schema
        .iter()
        .filter(|c| have.iter().any(|h| h == *c))
        .map(|c| {
            if *c == defaults::text("mesh_write.app_prompt_column") {
                format!("{}{c}{}", crate::sql::MESHW_APP_LENGTH_OPEN, crate::sql::MESHW_APP_LENGTH_CLOSE)
            } else {
                format!("{q}{c}{q}")
            }
        })
        .collect();
    (!list.is_empty()).then(|| format!("{}{}{}{table}", crate::sql::MESHW_APP_SELECT, list.join(crate::sql::MESHW_APP_LIST_SEP), crate::sql::MESHW_APP_FROM))
}

/// Read one cell the way a snapshot does, so a damaged page fails here as it would in Node; `Err` = Node throws.
fn touch_row(r: &rusqlite::Row<'_>, cols: usize) -> Result<(), ()> {
    for i in 0..cols {
        r.get_ref(i).map_err(|_| ())?;
    }
    Ok(())
}

/// `Number(v)` for the flag columns: null is 0, a number is itself; text and blobs (JavaScript converts them in ways the
/// engine does not reproduce) defer.
fn flag(v: ValueRef<'_>) -> R<f64> {
    match v {
        ValueRef::Null => Ok(0.0),
        ValueRef::Integer(i) if (i as f64).abs() <= defaults::num("mesh_write.app_max_exact_int") as f64 => Ok(i as f64),
        ValueRef::Real(f) => Ok(f),
        _ => defer("app-db-flag-type"),
    }
}

/// `String(v)` for the text columns (`id`, `builderType`): null is absent; a blob defers (JavaScript prints its bytes).
fn text_of(v: ValueRef<'_>) -> R<Option<String>> {
    match v {
        ValueRef::Null => Ok(None),
        ValueRef::Integer(i) if (i as f64).abs() <= defaults::num("mesh_write.app_max_exact_int") as f64 => Ok(Some(i.to_string())),
        ValueRef::Integer(_) | ValueRef::Blob(_) => defer("app-db-column-type"),
        ValueRef::Real(f) => Ok(Some(crate::checks::guardkit::ojson::js_number_text(f))),
        ValueRef::Text(t) => Ok(Some(String::from_utf8_lossy(t).into_owned())),
    }
}

/// `normPath(p)`: a relative path resolves against the cwd, which the engine does not reproduce.
fn norm_path(p: &str) -> R<Option<String>> {
    if p.is_empty() {
        return Ok(None);
    }
    if !p.starts_with('/') {
        return defer("relative-path");
    }
    let r = ident::resolve_abs(p);
    Ok(Some(ident::realpath(&r).unwrap_or(r)))
}

/// Open the app database read only without waiting for a lock.
pub fn open(file: &str) -> Option<rusqlite::Connection> {
    let conn = rusqlite::Connection::open_with_flags(file, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX).ok()?;
    conn.busy_timeout(defaults::millis("mesh_write.app_busy_timeout_ms")).ok()?;
    Some(conn)
}

/// `readSnapshot(file)` reduced to what `builderStates` reports; `Ok(None)` is Node's null.
pub fn read_states(file: &str) -> R<Option<Vec<State>>> {
    if !std::fs::metadata(file).map(|m| m.is_file()).unwrap_or(false) {
        return Ok(None);
    }
    let Some(conn) = open(file) else { return Ok(None) };
    let Some(bcols) = col_set(&conn, defaults::text("mesh_write.app_table_builders")) else { return Ok(None) };
    for core in defaults::list("mesh_write.app_core_columns") {
        if !bcols.iter().any(|c| c == core) {
            return Ok(None);
        }
    }
    let schema = |key: &str| -> Vec<&'static str> { defaults::list(key) };
    // the other tables: a failed read of any of them makes Node's snapshot null
    let others = [
        (defaults::text("mesh_write.app_table_terminals"), defaults::list("mesh_write.app_cols_builder_terminals")),
        (defaults::text("mesh_write.app_table_pull_requests"), defaults::list("mesh_write.app_cols_pull_requests")),
        (defaults::text("mesh_write.app_table_repositories"), defaults::list("mesh_write.app_cols_repositories")),
    ];
    for (table, cols) in others {
        let Some(have) = col_set(&conn, table) else { continue };
        let Some(q) = select_for(table, &cols, &have) else { continue };
        let width = cols.iter().filter(|c| have.iter().any(|h| h == *c)).count();
        let Ok(mut st) = conn.prepare(&q) else { return Ok(None) };
        let Ok(mut rows) = st.query([]) else { return Ok(None) };
        loop {
            match rows.next() {
                Ok(Some(r)) => {
                    if touch_row(r, width).is_err() {
                        return Ok(None);
                    }
                }
                Ok(None) => break,
                Err(_) => return Ok(None),
            }
        }
    }
    let cols = schema("mesh_write.app_cols_builders");
    let Some(q) = select_for(defaults::text("mesh_write.app_table_builders"), &cols, &bcols) else { return Ok(None) };
    let present: Vec<&str> = cols.iter().copied().filter(|c| bcols.iter().any(|h| h == c)).collect();
    let idx = |name: &str| present.iter().position(|c| *c == name);
    let (i_id, i_active) = (idx(defaults::text("mesh_write.app_col_id")), idx(defaults::text("mesh_write.app_col_active")));
    let (i_hidden, i_wt, i_bt) = (
        idx(defaults::text("mesh_write.app_col_hidden")),
        idx(defaults::text("mesh_write.app_col_worktree")),
        idx(defaults::text("mesh_write.app_col_builder_type")),
    );
    let (Some(i_id), Some(i_active)) = (i_id, i_active) else { return Ok(None) };
    let Ok(mut st) = conn.prepare(&q) else { return Ok(None) };
    let Ok(mut rows) = st.query([]) else { return Ok(None) };
    // Map(id -> state): a repeated id keeps its first position with the last values (JavaScript Map.set)
    let mut out: Vec<State> = Vec::new();
    let mut at: HashMap<String, usize> = HashMap::new();
    loop {
        let r = match rows.next() {
            Ok(Some(r)) => r,
            Ok(None) => break,
            Err(_) => return Ok(None),
        };
        if touch_row(r, present.len()).is_err() {
            return Ok(None);
        }
        let get = |i: usize| r.get_ref(i).map_err(|_| ident::Defer("app-db-read".into()));
        let Some(id) = text_of(get(i_id)?)? else { continue };
        let active_n = flag(get(i_active)?)?;
        let hidden_n = match i_hidden {
            Some(i) => Some(flag(get(i)?)?),
            None => None,
        };
        // `Number(b.isActive) === 0 && (!hasHidden || Number(b.isHidden) === 1)`
        let archived = active_n == 0.0 && hidden_n.is_none_or(|h| h == 1.0);
        let worktree = match i_wt.map(get).transpose()? {
            Some(ValueRef::Text(t)) => norm_path(&String::from_utf8_lossy(t))?,
            Some(ValueRef::Blob(_)) => return defer("app-db-column-type"),
            _ => None,
        };
        let builder_type = match i_bt {
            Some(i) => text_of(get(i)?)?,
            None => None,
        };
        let st = State { id: id.clone(), active: active_n == 1.0, archived: Some(archived), worktree, builder_type };
        match at.get(&id) {
            Some(&p) => out[p] = st,
            None => {
                at.insert(id, out.len());
                out.push(st);
            }
        }
    }
    Ok(Some(out))
}

/// The signature of the database file the cache is keyed by.
#[derive(Debug, Clone, PartialEq)]
struct Sig {
    mtime: f64,
    size: f64,
    wal_mtime: Option<f64>,
    wal_size: Option<f64>,
}

/// `st.mtimeMs`.
fn mtime_ms(m: &std::fs::Metadata) -> f64 {
    m.mtime() as f64 * 1000.0 + m.mtime_nsec() as f64 / 1e6
}

fn db_file_sig(file: &str) -> Option<Sig> {
    let m = std::fs::metadata(file).ok()?;
    let wal = std::fs::metadata(format!("{file}{}", defaults::text("mesh_write.app_wal_suffix"))).ok();
    Some(Sig { mtime: mtime_ms(&m), size: m.size() as f64, wal_mtime: wal.as_ref().map(mtime_ms), wal_size: wal.as_ref().map(|w| w.size() as f64) })
}

fn sig_json(g: &Sig) -> OVal {
    let opt = |v: Option<f64>| v.map_or(OVal::Null, n);
    let mut o = Obj::default();
    o.put("mtimeMs", n(g.mtime)).put("size", n(g.size)).put("walMtimeMs", opt(g.wal_mtime)).put("walSize", opt(g.wal_size));
    o.done()
}

fn cache_target(home: &Path) -> PathBuf {
    devswarm_root(home).join(defaults::text("mesh_write.app_cache_dir")).join(defaults::text("mesh_write.app_cache_file"))
}

fn sig_matches(j: Option<&OVal>, g: &Sig) -> bool {
    let Some(j) = j else { return false };
    let num = |k: &str| match j.get(k) {
        Some(OVal::Num(x)) => Some(Some(*x)),
        Some(OVal::Null) => Some(None),
        _ => None,
    };
    num("mtimeMs") == Some(Some(g.mtime)) && num("size") == Some(Some(g.size)) && num("walMtimeMs") == Some(g.wal_mtime) && num("walSize") == Some(g.wal_size)
}

/// `readCrossCache`: the states of a valid cache, `None` (query the database) on any mismatch or error.
fn read_cache(home: &Path, file: &str, sig: &Sig, now: i64) -> R<Option<Vec<State>>> {
    let Ok(bytes) = std::fs::read(cache_target(home)) else { return Ok(None) };
    let Some(j) = OVal::parse(&String::from_utf8_lossy(&bytes)) else { return Ok(None) };
    if !matches!(j, OVal::Obj(_)) {
        return Ok(None);
    }
    if !matches!(j.get("file"), Some(OVal::Str(f)) if f == file) || !sig_matches(j.get("sig"), sig) {
        return Ok(None);
    }
    let Some(OVal::Num(at)) = j.get("at") else { return Ok(None) };
    let age = now as f64 - at;
    if !at.is_finite() || age < 0.0 || age >= defaults::num("mesh_write.app_cache_ttl_ms") as f64 {
        return Ok(None);
    }
    let Some(OVal::Obj(states)) = j.get("states") else {
        // an array or another non-object `states` is read key by key by JavaScript; not reproduced
        return if matches!(j.get("states"), Some(OVal::Arr(_))) { defer("app-cache-shape") } else { Ok(None) };
    };
    let mut out: Vec<State> = Vec::new();
    let mut at_ix: HashMap<String, usize> = HashMap::new();
    for (id, v) in states {
        let (active, archived, worktree, builder_type) = match v {
            OVal::Obj(_) => {
                let str_or_null = |k: &str| match v.get(k) {
                    None | Some(OVal::Null) => Ok(None),
                    Some(OVal::Str(x)) => Ok(Some(x.clone())),
                    Some(_) => defer("app-cache-shape"),
                };
                let archived = match v.get("archived") {
                    Some(OVal::Bool(b)) => Some(*b),
                    _ => None,
                };
                (matches!(v.get("active"), Some(OVal::Bool(true))), archived, str_or_null("worktreePath")?, str_or_null("builderType")?)
            }
            OVal::Arr(_) => return defer("app-cache-shape"),
            _ => continue, // `!v || typeof v !== 'object'`
        };
        let st = State { id: id.clone(), active, archived, worktree, builder_type };
        match at_ix.get(id) {
            Some(&p) => out[p] = st,
            None => {
                at_ix.insert(id.clone(), out.len());
                out.push(st);
            }
        }
    }
    Ok(Some(out))
}

fn cache_text(home: &Path, file: &str, sig: &Sig, now: i64, states: &[State]) -> CacheWrite {
    let mut st = Obj::default();
    for s_ in states {
        let opt = |v: &Option<String>| v.as_deref().map_or(OVal::Null, s);
        let mut o = Obj::default();
        o.put("active", OVal::Bool(s_.active))
            .put("archived", s_.archived.map_or(OVal::Null, OVal::Bool))
            .put("worktreePath", opt(&s_.worktree))
            .put("builderType", opt(&s_.builder_type));
        st.put(&s_.id, o.done());
    }
    let mut payload = Obj::default();
    payload.put("file", s(file)).put("sig", sig_json(sig)).put("at", n(now as f64)).put("states", st.done());
    CacheWrite { target: cache_target(home), text: payload.done().stringify() }
}

/// `builderStates({ home, env, now, xcache })`; `Ok(None)` is Node's null (no database, unreadable, unexpected shape).
pub fn builder_states(home: &Path, env: &Env, now: i64, xcache: bool) -> R<Option<Found>> {
    let Some(file) = ident::app_db_path(home, env) else { return Ok(None) };
    let sig = if xcache { db_file_sig(&file) } else { None };
    if let Some(g) = &sig
        && let Some(states) = read_cache(home, &file, g, now)?
    {
        return Ok(Some(Found { states, cache: None }));
    }
    let Some(states) = read_states(&file)? else { return Ok(None) };
    let cache = sig.map(|g| cache_text(home, &file, &g, now, &states));
    Ok(Some(Found { states, cache }))
}

/// `appArchivedVerdict({ home, env, id, worktreePath, now, xcache })`: `Some(true)` archived, `Some(false)` not, `None`
/// no opinion. Also returns the cache write the lookup owes.
pub fn archived_verdict(home: &Path, env: &Env, now: i64, id: &str, worktree: Option<&str>, xcache: bool) -> R<(Option<bool>, Option<CacheWrite>)> {
    let Some(found) = builder_states(home, env, now, xcache)? else { return Ok((None, None)) };
    let cache = found.cache;
    if !id.is_empty()
        && let Some(st) = found.states.iter().find(|s| s.id == id)
    {
        return Ok((st.archived, cache));
    }
    let Some(wt) = worktree.map(norm_path).transpose()?.flatten() else { return Ok((None, cache)) };
    let mut saw_archived = false;
    for b in found.states.iter().filter(|b| b.worktree.as_deref() == Some(wt.as_str())) {
        if b.active || b.archived != Some(true) {
            return Ok((Some(false), cache));
        }
        saw_archived = true;
    }
    Ok((saw_archived.then_some(true), cache))
}
