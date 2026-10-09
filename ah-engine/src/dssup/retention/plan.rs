//! `planStore` of `companion/lib/devswarm-retention.js`, read only: which message bodies of one store may be tombstoned.
//!
//! A body is a candidate only when ALL of these hold (Node's rules 1-8): it still has a non-empty body; it is not among the
//! newest `keepPerPartition` rows of its partition; its position is at or below EVERY reader's position (a direct partition:
//! the stored floor, every declared reader that is not retired, and the legacy floor when any legacy cursor artefact exists);
//! it is not a row that needs a reply; its body is not a line of the partition's NDJSON inbox; in the broadcast partition it is
//! not the newest heartbeat of any sender, not inside the last runs, and (for a non-heartbeat) not above every workspace's
//! broadcast cursor; and no `retention restore` hold covers it. The age rule is applied by the caller (`oldEnough`).
//!
//! Anything this port cannot read exactly like Node (a value JavaScript would convert in a way the engine does not, an integer
//! beyond JavaScript's safe range, a cursor table that does not read) is a [`Defer`]: the caller then hands the whole sweep to
//! Node and writes nothing itself.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this module is a deliberate keep, for these reasons:
// - an unreadable optional file or table is the empty one (Node: `try { ... } catch (_) { ... }` around each of them)
use crate::checks::guardkit::ojson::OVal;
use crate::checks::guardkit::text::{js_number_of_str, js_trim};
use crate::defaults;
use crate::meshw::ident::{Defer, R, defer};
use crate::meshw::idlock::{devswarm_root, is_safe_id};
use rusqlite::types::ValueRef;
use rusqlite::{Connection, OpenFlags, params};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};

/// One tombstone candidate.
#[derive(Debug, Clone, PartialEq)]
pub struct Cand {
    /// The row id.
    pub id: i64,
    /// Its 1-based position in its partition.
    pub pos: i64,
    /// Its partition.
    pub partition: String,
    /// Its timestamp.
    pub ts: f64,
    /// Its body length (SQLite `LENGTH`).
    pub blen: i64,
    /// Older than the retention window.
    pub old_enough: bool,
    /// Its hash (a guard at write time: the row must still be this row).
    pub hash: Option<String>,
}

/// How many rows of one partition each rule protected.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Stat {
    /// Rows in the partition.
    pub rows: i64,
    /// Candidates older than the window.
    pub candidates: i64,
    /// Their body length.
    pub candidate_bytes: i64,
    /// Rows already tombstoned.
    pub tombstoned: i64,
    /// The position every reader has consumed (`None` for the broadcast partition: its cursor minimum is `bound`).
    pub bound: Option<f64>,
    /// Protected by age.
    pub too_new: i64,
    /// Protected as one of the newest rows.
    pub keep_last: i64,
    /// Protected as unread.
    pub unread: i64,
    /// Protected as an open question.
    pub question: i64,
    /// Protected as an NDJSON inbox line.
    pub ndjson: i64,
    /// Protected in the broadcast partition.
    pub broadcast: i64,
    /// Protected by a restore hold.
    pub held: i64,
}

/// The plan of one store.
#[derive(Debug, Clone, Default)]
pub struct Plan {
    /// Candidates, oldest id first (age NOT applied: `old_enough` says which are old enough).
    pub cands: Vec<Cand>,
    /// Per-partition statistics.
    pub parts: BTreeMap<String, Stat>,
    /// Rows in the store.
    pub total_rows: i64,
    /// Rows already tombstoned.
    pub total_tombstoned: i64,
}

/// The settings a plan depends on.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rules {
    /// Retention window, days.
    pub days: f64,
    /// Newest rows per partition never pruned.
    pub keep: i64,
}

/// A restore hold: an id range kept until `until`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Hold {
    /// First id.
    pub min: f64,
    /// Last id.
    pub max: f64,
}

/// The sqlite file of a store.
pub fn db_path(home: &Path, hash: &str) -> PathBuf {
    store_dir(home, hash).join(defaults::text("devswarm_sup.rt_db_file"))
}

/// The directory of a store.
pub fn store_dir(home: &Path, hash: &str) -> PathBuf {
    devswarm_root(home).join(defaults::text("devswarm_sup.rt_store_dir")).join(hash)
}

/// Open a store read only, the way Node's `openDb(home, hash, true)` does (a busy timeout, no waiting beyond it).
pub fn open_ro(file: &Path) -> R<Connection> {
    let c =
        Connection::open_with_flags(file, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX).map_err(|e| Defer(format!("store-open:{e}")))?;
    crate::discard::harmless(c.busy_timeout(defaults::millis("devswarm_sup.rt_busy_ms"))); // keep: the default timeout only makes a busy store fail sooner
    Ok(c)
}

/// `Number(x)` of a column value; NULL is 0, a blob defers.
fn number(v: ValueRef<'_>) -> R<f64> {
    match v {
        ValueRef::Null => Ok(0.0),
        ValueRef::Integer(i) => {
            if i.unsigned_abs() > defaults::num("mesh.js_safe_int") {
                return defer("integer-range");
            }
            Ok(i as f64)
        }
        ValueRef::Real(f) => Ok(f),
        ValueRef::Text(t) => Ok(js_number_of_str(&String::from_utf8_lossy(t))),
        ValueRef::Blob(_) => defer("blob-value"),
    }
}

/// `x != null ? String(x) : null` for a text column; any other type defers (JavaScript would stringify it its own way).
fn opt_text(v: ValueRef<'_>) -> R<Option<String>> {
    match v {
        ValueRef::Null => Ok(None),
        ValueRef::Text(t) => Ok(Some(String::from_utf8_lossy(t).into_owned())),
        _ => defer("non-text-column"),
    }
}

/// `Math.min(a, b)`: NaN wins.
fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() { f64::NAN } else { a.min(b) }
}

/// A body column that is neither text nor NULL is a value JavaScript would stringify its own way: it defers.
fn text_body(v: ValueRef<'_>) -> R<()> {
    match v {
        ValueRef::Text(t) if defaults::list("devswarm_sup.rt_text_types").iter().any(|w| w.as_bytes() == t) => Ok(()),
        _ => defer("non-text-body"),
    }
}

fn e<T>(r: rusqlite::Result<T>, what: &str) -> R<T> {
    r.map_err(|x| Defer(format!("{what}:{x}")))
}

/// What makes two broadcasts one run: sender, body, urgency.
type RunKey = (Option<String>, String, Option<String>);

/// One reader cursor row.
struct Reader {
    ns: String,
    reader: String,
    value: f64,
    retired_line: Option<f64>,
}

fn is_retired(r: &Reader) -> bool {
    r.retired_line.is_some_and(|l| r.value <= l)
}

/// `store.readerCursorRows(partition)`; a store without the table has no rows.
fn reader_rows(c: &Connection, partition: &str) -> R<Vec<Reader>> {
    let mut st = match c.prepare(crate::sql::RT_READER_ROWS) {
        Ok(s) => s,
        Err(x) if x.to_string().to_lowercase().contains(defaults::text("devswarm_sup.rt_no_table_text")) => return Ok(Vec::new()),
        Err(x) => return defer(&format!("reader-rows:{x}")),
    };
    let mut rows = e(st.query(params![partition]), "reader-rows")?;
    let mut out = Vec::new();
    while let Some(r) = e(rows.next(), "reader-rows")? {
        let get = |i: usize| e(r.get_ref(i), "reader-rows");
        out.push(Reader {
            ns: opt_text(get(0)?)?.unwrap_or_default(),
            reader: opt_text(get(1)?)?.unwrap_or_default(),
            value: number(get(2)?)?,
            retired_line: match get(3)? {
                ValueRef::Null => None,
                v => Some(number(v)?),
            },
        });
    }
    Ok(out)
}

/// `readCursor(path)` (a missing or unreadable file is 0).
fn cursor_file(p: &Path) -> f64 {
    crate::meshw::cursors::read_cursor(p)
}

/// `legacySafeId(id)`.
fn legacy_safe(id: &str) -> bool {
    is_safe_id(id) && !id.contains(defaults::text("devswarm_sup.rt_hash_sep")) && !id.contains(defaults::text("devswarm_sup.rt_seen_marker"))
}

fn cursors_dir(home: &Path) -> PathBuf {
    devswarm_root(home).join(defaults::text("devswarm_sup.rt_cursors_dir"))
}

/// `legacySharedCursor(store, home, id)`: the larger of the shared cursor file and the legacy `cursors` row.
fn legacy_shared(c: &Connection, home: &Path, id: &str) -> f64 {
    let json = cursor_file(&cursors_dir(home).join(format!("{id}{}", defaults::text("mesh_write.json_suffix"))));
    let row =
        c.query_row(crate::sql::RT_CURSOR_VALUE, params![id], |r| r.get_ref(0).map(|v| number(v).unwrap_or(0.0))).ok().filter(|v| v.is_finite()).unwrap_or(0.0);
    json.max(row)
}

/// `legacyBaseline(store, home, id)`.
fn legacy_baseline(c: &Connection, home: &Path, id: &str) -> f64 {
    if legacy_safe(id) {
        let bp = cursors_dir(home).join(format!("{id}{}{}", defaults::text("devswarm_sup.rt_base_marker"), defaults::text("mesh_write.json_suffix")));
        if bp.exists() {
            return cursor_file(&bp);
        }
    }
    legacy_shared(c, home, id)
}

/// `listLegacy(home, id, '#inst-')`: the values of the instance cursor files.
fn legacy_inst(home: &Path, id: &str) -> Vec<f64> {
    if !legacy_safe(id) {
        return Vec::new();
    }
    let prefix = format!("{id}{}", defaults::text("devswarm_sup.rt_inst_marker"));
    let suffix = defaults::text("mesh_write.json_suffix");
    let mut out = Vec::new();
    for e in std::fs::read_dir(cursors_dir(home)).into_iter().flatten().flatten() {
        let Ok(n) = e.file_name().into_string() else { continue };
        let Some(rest) = n.strip_prefix(&prefix).and_then(|r| r.strip_suffix(suffix)) else { continue };
        if rest.len() == defaults::num("devswarm_sup.rt_short_len") as usize && rest.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
            out.push(cursor_file(&cursors_dir(home).join(&n)));
        }
    }
    out
}

/// `legacyStoreFloor(store, home, id)`.
fn legacy_store_floor(c: &Connection, home: &Path, id: &str) -> f64 {
    let baseline = legacy_baseline(c, home, id);
    let inst = legacy_inst(home, id);
    match inst.iter().copied().reduce(f64::min) {
        None => baseline,
        Some(min) => baseline.max(min),
    }
}

/// `legacyPresent(handle, home, partition, cursorNames)`.
fn legacy_present(c: &Connection, partition: &str, names: &[String]) -> bool {
    match c.query_row(crate::sql::RT_CURSOR_ROW, params![partition], |_| Ok(())) {
        Ok(()) => return true,
        Err(rusqlite::Error::QueryReturnedNoRows) => {}
        Err(_) => return true, // Node: a throw reads as present
    }
    let suffix = defaults::text("mesh_write.json_suffix");
    let (base, inst) = (defaults::text("devswarm_sup.rt_base_marker"), defaults::text("devswarm_sup.rt_inst_marker"));
    names.iter().any(|n| {
        *n == format!("{partition}{suffix}")
            || *n == format!("{partition}{base}{suffix}")
            || (n.starts_with(&format!("{partition}{inst}")) && n.ends_with(suffix))
    })
}

/// `readerBound(handle, home, partition, cursorNames)`: the highest position every reader has consumed.
pub fn reader_bound(c: &Connection, home: &Path, partition: &str, names: &[String]) -> R<f64> {
    let rows = reader_rows(c, partition)?;
    let floor_name = defaults::text("mesh_write.floor_reader");
    let store_ns = defaults::text("mesh_write.cursor_ns_store");
    let floor = match rows.iter().find(|r| r.ns == store_ns && r.reader == floor_name) {
        Some(f) => f.value,
        None => legacy_store_floor(c, home, partition),
    };
    let nz = |x: f64| if x.is_nan() { 0.0 } else { x };
    let mut vals = vec![nz(floor)];
    for r in &rows {
        if r.ns == store_ns && r.reader != floor_name && !is_retired(r) {
            vals.push(nz(r.value));
        }
    }
    if legacy_present(c, partition, names) {
        vals.push(nz(legacy_store_floor(c, home, partition)));
    }
    Ok(vals.into_iter().fold(f64::INFINITY, f64::min).max(0.0))
}

/// `sqlBound(db, partition)`: the in-transaction re-check (`None` when no reader row exists at all).
pub fn sql_bound(c: &Connection, partition: &str) -> Option<f64> {
    let mut vals: Vec<f64> = Vec::new();
    if let Ok(mut st) = c.prepare(crate::sql::RT_READER_STORE)
        && let Ok(mut rows) = st.query(params![partition])
    {
        while let Ok(Some(r)) = rows.next() {
            let (reader, v, rl) = (
                r.get_ref(0).ok().and_then(|x| opt_text(x).ok()).flatten().unwrap_or_default(),
                r.get_ref(1).ok().and_then(|x| number(x).ok()).unwrap_or(f64::NAN),
                r.get_ref(2).ok().and_then(|x| if matches!(x, ValueRef::Null) { None } else { number(x).ok() }),
            );
            let retired = reader != defaults::text("mesh_write.floor_reader") && rl.is_some_and(|l| v <= l);
            if !retired {
                vals.push(v);
            }
        }
    }
    if let Ok(v) = c.query_row(crate::sql::RT_CURSOR_VALUE, params![partition], |r| r.get_ref(0).map(|x| number(x).unwrap_or(f64::NAN))) {
        vals.push(v);
    }
    if vals.is_empty() {
        return None;
    }
    let m = vals.into_iter().fold(f64::INFINITY, js_min);
    Some(if m.is_nan() { m } else { m.max(0.0) })
}

/// `ndjsonLineSet(home, desc)`: the non-blank lines of the partition's NDJSON inbox(es), untrimmed.
fn ndjson_lines(home: &Path, id: &str, registry_inbox: Option<&str>) -> HashSet<String> {
    let mut paths: Vec<String> = Vec::new();
    if let Some(p) = registry_inbox.filter(|p| !p.is_empty()) {
        paths.push(p.to_string());
    }
    let desc = devswarm_root(home).join(defaults::text("mesh_write.dir_workspaces")).join(format!("{id}{}", defaults::text("mesh_write.json_suffix")));
    if let Some(OVal::Obj(o)) = std::fs::read(desc).ok().and_then(|b| OVal::parse(&String::from_utf8_lossy(&b)))
        && let Some((_, OVal::Str(p))) = o.iter().find(|(k, _)| k == defaults::text("mesh_write.field_inbox_path"))
        && !p.is_empty()
        && !paths.contains(p)
    {
        paths.push(p.clone());
    }
    let mut set = HashSet::new();
    for p in paths {
        let Ok(bytes) = std::fs::read(&p) else { continue };
        for line in String::from_utf8_lossy(&bytes).split('\n') {
            if !js_trim(line).is_empty() {
                set.insert(line.to_string());
            }
        }
    }
    set
}

/// `heldIds(state, hash, now)` as plain ranges.
pub fn holds_of(state: &OVal, hash: &str, now: f64) -> Vec<Hold> {
    let Some(OVal::Arr(list)) = state.get("holds").and_then(|h| h.get(hash)) else { return Vec::new() };
    let num = |h: &OVal, k: &str| match h.get(k) {
        Some(OVal::Num(n)) => *n,
        Some(OVal::Str(s)) => js_number_of_str(s),
        Some(OVal::Bool(b)) => f64::from(u8::from(*b)),
        Some(OVal::Null) => 0.0,
        _ => f64::NAN,
    };
    list.iter().filter(|h| matches!(h, OVal::Obj(_)) && num(h, "until") > now).map(|h| Hold { min: num(h, "minId"), max: num(h, "maxId") }).collect()
}

/// `planStore({ home, hash, settings, now, state, ignoreAge: true })`.
pub fn plan_store(home: &Path, hash: &str, rules: Rules, now: f64, holds: &[Hold]) -> R<Plan> {
    let c = open_ro(&db_path(home, hash))?;
    let cutoff = now - rules.days * defaults::num("devswarm_sup.rt_day_ms") as f64;
    let names: Vec<String> = std::fs::read_dir(cursors_dir(home)).into_iter().flatten().flatten().filter_map(|x| x.file_name().into_string().ok()).collect();
    // the registry: id -> NDJSON inbox path
    let mut registry: HashMap<String, Option<String>> = HashMap::new();
    if let Ok(mut st) = c.prepare(crate::sql::RT_REGISTRY)
        && let Ok(mut rows) = st.query([])
    {
        while let Ok(Some(r)) = rows.next() {
            let id = r.get_ref(0).ok().and_then(|x| opt_text(x).ok()).flatten();
            let inbox = r.get_ref(1).ok().and_then(|x| opt_text(x).ok()).flatten();
            if let Some(id) = id {
                registry.insert(id, inbox);
            }
        }
    }
    let mut parts: Vec<String> = Vec::new();
    {
        let mut st = e(c.prepare(crate::sql::RT_PARTITIONS), "partitions")?;
        let mut rows = e(st.query([]), "partitions")?;
        while let Some(r) = e(rows.next(), "partitions")? {
            parts.push(opt_text(e(r.get_ref(0), "partitions")?)?.unwrap_or_default());
        }
    }
    let broadcast_id = defaults::text("devswarm_sup.rt_broadcast_partition");
    let mut plan = Plan::default();
    let recent_protected = defaults::num("devswarm_sup.rt_recent_runs") as usize;
    for partition in parts {
        let mut st = Stat::default();
        let is_broadcast = partition == broadcast_id;
        let n_rows: i64 = e(c.query_row(crate::sql::RT_COUNT, params![&partition], |r| r.get(0)), "count")?;
        st.rows = n_rows;
        plan.total_rows += n_rows;
        let mut protect: HashSet<i64> = HashSet::new();
        let mut bound = f64::INFINITY;
        if is_broadcast {
            // the broadcast partition: the latest heartbeat of each sender, the last runs, and what a cursor has not passed
            let mut latest_hb: HashMap<String, i64> = HashMap::new();
            let mut keys: Vec<(i64, RunKey, bool, Option<f64>)> = Vec::with_capacity(n_rows as usize);
            {
                let mut q = e(c.prepare(crate::sql::RT_ROWS_BODY), "rows")?;
                let mut rows = e(q.query(params![&partition]), "rows")?;
                while let Some(r) = e(rows.next(), "rows")? {
                    let g = |i: usize| e(r.get_ref(i), "rows");
                    let id = number(g(0)?)? as i64;
                    let seq = match g(2)? {
                        ValueRef::Null => None,
                        v => Some(number(v)?),
                    };
                    let hb = number(g(4)?)? == 1.0;
                    text_body(g(10)?)?;
                    let sender = opt_text(g(5)?)?;
                    let urgency = opt_text(g(6)?)?;
                    let body = match g(11)? {
                        ValueRef::Null => String::new(),
                        ValueRef::Text(t) => String::from_utf8_lossy(t).into_owned(),
                        _ => return defer("non-text-body"),
                    };
                    if hb && let Some(s) = &sender {
                        latest_hb.insert(s.clone(), id);
                    }
                    keys.push((id, (sender, body, urgency), hb, seq));
                }
            }
            protect.extend(latest_hb.values().copied());
            let (mut runs, mut last): (usize, Option<&RunKey>) = (0, None);
            for k in keys.iter().rev() {
                if runs > recent_protected {
                    break;
                }
                if last != Some(&k.1) {
                    runs += 1;
                    last = Some(&k.1);
                }
                if runs <= recent_protected {
                    protect.insert(k.0);
                }
            }
            // the minimum broadcast cursor over the table and every registered workspace
            let mut min_bc = f64::INFINITY;
            let mut table_ok = true;
            match c.prepare(crate::sql::RT_BC_ALL) {
                Ok(mut q) => match q.query([]) {
                    Ok(mut rows) => {
                        while let Ok(Some(r)) = rows.next() {
                            min_bc = js_min(min_bc, r.get_ref(0).ok().and_then(|x| number(x).ok()).unwrap_or(f64::NAN));
                        }
                    }
                    Err(_) => table_ok = false,
                },
                Err(_) => table_ok = false,
            }
            if !table_ok {
                min_bc = 0.0;
            }
            for id in registry.keys() {
                let v = c.query_row(crate::sql::RT_BC_ONE, params![id], |r| r.get_ref(0).map(|x| number(x).unwrap_or(0.0))).unwrap_or(0.0); // Node: a throw reads 0
                min_bc = js_min(min_bc, v);
            }
            if !min_bc.is_finite() {
                min_bc = 0.0;
            }
            st.bound = Some(min_bc);
            for k in &keys {
                if !k.2 && !k.3.is_some_and(|s| s <= min_bc) {
                    protect.insert(k.0);
                }
            }
        } else {
            bound = reader_bound(&c, home, &partition, &names)?;
            st.bound = Some(bound);
        }
        let lines = if is_broadcast { None } else { Some(ndjson_lines(home, &partition, registry.get(&partition).and_then(|x| x.as_deref()))) };
        // the candidates, in order
        let mut pending: Vec<Cand> = Vec::new();
        {
            let mut q = e(c.prepare(crate::sql::RT_ROWS), "rows")?;
            let mut rows = e(q.query(params![&partition]), "rows")?;
            let mut i: i64 = 0;
            while let Some(r) = e(rows.next(), "rows")? {
                let g = |k: usize| e(r.get_ref(k), "rows");
                let (id, ts) = (number(g(0)?)? as i64, number(g(1)?)?);
                let hash = opt_text(g(9)?)?;
                text_body(g(10)?)?;
                let needs_reply = number(g(3)?)? == 1.0;
                let tomb = number(g(7)?)? == 1.0;
                let blen = number(g(8)?)? as i64;
                let pos = i + 1;
                i += 1;
                if tomb {
                    st.tombstoned += 1;
                    continue;
                }
                if blen == 0 {
                    continue;
                }
                if pos > n_rows - rules.keep {
                    st.keep_last += 1;
                    continue;
                }
                if !is_broadcast && pos as f64 > bound {
                    st.unread += 1;
                    continue;
                }
                if needs_reply {
                    st.question += 1;
                    continue;
                }
                if is_broadcast && protect.contains(&id) {
                    st.broadcast += 1;
                    continue;
                }
                if holds.iter().any(|h| id as f64 >= h.min && id as f64 <= h.max) {
                    st.held += 1;
                    continue;
                }
                pending.push(Cand { id, pos, partition: partition.clone(), ts, blen, old_enough: ts < cutoff, hash });
            }
        }
        plan.total_tombstoned += st.tombstoned;
        // rule 6: a body equal to a line of the partition's NDJSON inbox stays
        let mut kept = pending;
        if let Some(set) = lines.as_ref().filter(|s| !s.is_empty()) {
            let mut out = Vec::with_capacity(kept.len());
            for cand in kept {
                let body: Option<String> = c
                    .query_row(crate::sql::RT_BODY, params![cand.id], |r| {
                        r.get_ref(0).map(|v| match v {
                            ValueRef::Text(t) => Some(String::from_utf8_lossy(t).into_owned()),
                            _ => None,
                        })
                    })
                    .ok()
                    .flatten();
                if body.is_some_and(|b| set.contains(&b)) {
                    st.ndjson += 1;
                    continue;
                }
                out.push(cand);
            }
            kept = out;
        }
        for cand in kept {
            if cand.old_enough {
                st.candidates += 1;
                st.candidate_bytes += cand.blen;
            } else {
                st.too_new += 1; // size-limit mode may still take it
            }
            plan.cands.push(cand);
        }
        plan.parts.insert(partition, st);
    }
    plan.cands.sort_by_key(|x| x.id);
    Ok(plan)
}
