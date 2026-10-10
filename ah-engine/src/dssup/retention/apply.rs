//! `pruneStore` of `companion/lib/devswarm-retention.js`, the write half: archive first, then tombstone, then reclaim space.
//!
//! The order is Node's and it is what makes this safe: a batch's rows are appended to the month's gzip archive (and the archive
//! is fsynced) BEFORE the transaction that sets their bodies to NULL; a crash between the two re-archives the same rows next time
//! (duplicate lines, which `retention restore` dedupes by id). A tombstone keeps the row's id, partition, timestamp, hash,
//! sender, recipient, type, urgency, flags, sequence and nonce, so positions, counts and dedupe are unchanged.
//!
//! Stricter than Node, never weaker: inside the transaction each row is checked again against the live database and is skipped
//! unless it is still the row that was planned (same partition and hash), still at the planned position, still not an open
//! question, still older than the window when it was chosen by age, and (broadcast rows) still at or below every workspace's
//! broadcast cursor. The set of rows tombstoned is therefore always a subset of what Node's own transaction would tombstone.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this module is a deliberate keep, for these reasons:
// - the event log and the directory fsync are best effort (Node: `try { ... } catch (_) { /* logging never breaks retention */ }`)
// - a missing freelist or page count reads as ratio 0 (Node: `catch (_) { ratio = 0 }`)
use super::plan::{self, Cand, Plan};
use crate::checks::guardkit::ojson::OVal;
use crate::defaults;
use crate::meshw::ident::{Defer, R, defer};
use crate::meshw::idlock::devswarm_root;
use rusqlite::types::ValueRef;
use rusqlite::{Connection, OpenFlags, params};
use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Instant;

/// The five retention settings.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Settings {
    /// Days of bodies kept; 0 switches retention off.
    pub days: f64,
    /// Store size limit in MB; 0 = none.
    pub max_store_mb: f64,
    /// Newest rows per partition never pruned.
    pub keep: i64,
    /// Archive bodies before tombstoning them.
    pub archive: bool,
    /// Archive size cap in MB; 0 = never evict.
    pub archive_max_mb: f64,
}

impl Settings {
    /// `settings.enabled`.
    pub fn enabled(&self) -> bool {
        self.days > 0.0
    }

    /// The store size limit in bytes (`Infinity` when none).
    pub fn max_bytes(&self) -> f64 {
        if self.max_store_mb > 0.0 { self.max_store_mb * defaults::num("devswarm_sup.rt_mb") as f64 } else { f64::INFINITY }
    }

    /// The rules the plan depends on.
    pub fn rules(&self) -> plan::Rules {
        plan::Rules { days: self.days, keep: self.keep }
    }
}

/// What a sweep of one store did (Node's `res`).
#[derive(Debug, Clone, Default)]
pub struct Pruned {
    /// The store.
    pub hash: String,
    /// No error.
    pub ok: bool,
    /// The error text.
    pub error: Option<String>,
    /// Size on disk (database and log) before.
    pub bytes_before: u64,
    /// After.
    pub bytes_after: u64,
    /// Candidates older than the window.
    pub age_candidates: usize,
    /// Added to reach the size limit.
    pub size_candidates: usize,
    /// Body bytes of everything chosen.
    pub candidate_bytes: i64,
    /// Rows tombstoned.
    pub tombstoned: i64,
    /// Their body bytes.
    pub tombstoned_bytes: i64,
    /// Archive months written (file relative to the archive root, rows).
    pub archived: Vec<(String, usize)>,
    /// Batches committed.
    pub batches: usize,
    /// The store was over its limit when chosen.
    pub over_limit: bool,
    /// Still over after everything that may be pruned was.
    pub over_limit_protected: bool,
    /// The vacuum record (Node's `maybeVacuum` object).
    pub vacuum: Option<OVal>,
    /// The time budget ran out.
    pub budget_exhausted: bool,
    /// Rows the plan saw (`totalRows`).
    pub total_rows: i64,
    /// Rows already tombstoned when the plan was made.
    pub already_tombstoned: i64,
    /// What the plan protected, per reason (the names of `devswarm_sup.rt_protected_names`).
    pub protected: [i64; 7],
}

/// The rows to prune, chosen from an agreed plan: the old enough ones, then (over the size limit) the oldest remaining
/// eligible ones until the bodies freed cover the excess.
#[derive(Debug, Clone, Default)]
pub struct Chosen {
    /// In choosing order.
    pub list: Vec<Cand>,
    set: HashSet<i64>,
}

impl Chosen {
    /// The old enough candidates of `plan`.
    pub fn by_age(plan: &Plan) -> Chosen {
        let mut c = Chosen::default();
        for x in plan.cands.iter().filter(|x| x.old_enough) {
            c.set.insert(x.id);
            c.list.push(x.clone());
        }
        c
    }

    /// `addSizeCandidates(excess)`: how many were added.
    pub fn add_for(&mut self, plan: &Plan, excess: f64) -> usize {
        let mut freed: f64 = self.list.iter().map(|x| x.blen as f64).sum();
        let mut added = 0;
        for x in &plan.cands {
            if freed >= excess {
                break;
            }
            if self.set.contains(&x.id) {
                continue;
            }
            self.set.insert(x.id);
            self.list.push(x.clone());
            freed += x.blen as f64;
            added += 1;
        }
        added
    }

    /// Body bytes of everything chosen.
    pub fn bytes(&self) -> i64 {
        self.list.iter().map(|x| x.blen).sum()
    }
}

/// The store's size on disk: the database and its log.
pub fn store_bytes(home: &Path, hash: &str) -> u64 {
    let db = plan::db_path(home, hash);
    let size = |p: &Path| std::fs::metadata(p).map_or(0, |m| m.len());
    let mut wal = db.as_os_str().to_os_string();
    wal.push(defaults::text("devswarm_sup.rt_wal_suffix"));
    size(&db) + size(Path::new(&wal))
}

fn archive_root(home: &Path) -> PathBuf {
    devswarm_root(home).join(defaults::text("devswarm_sup.rt_archive_dir"))
}

/// `monthOf(ts)`: `yyyy-mm` in UTC.
fn month_of(ts: f64) -> String {
    let ms = if ts.is_finite() { ts as i64 } else { 0 };
    let (y, m, _) = crate::checks::jsport::date::civil_from_days(ms.div_euclid(defaults::num("devswarm_sup.rt_day_ms") as i64));
    format!("{y}-{m:02}")
}

/// The log of retention events (Node's file, Node's shape).
pub fn log_event(home: &Path, rec: &[(&str, OVal)]) {
    let p = home.join(defaults::text("devswarm_sup.rt_log_file"));
    if let Some(d) = p.parent() {
        crate::discard::harmless(std::fs::create_dir_all(d)); // keep: logging never breaks retention
    }
    let mut pairs: Vec<(String, OVal)> = vec![("ts".into(), OVal::Str(crate::checks::agent_scan::iso_utc(super::now_ms() as f64)))];
    pairs.extend(rec.iter().map(|(k, v)| ((*k).to_string(), v.clone())));
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&p) {
        crate::discard::harmless(writeln!(f, "{}", OVal::Obj(pairs).stringify())); // keep: logging never breaks retention
    }
}

pub(super) fn fsync_dir(d: &Path) {
    if let Ok(f) = std::fs::File::open(d) {
        crate::discard::harmless(f.sync_all()); // keep: not supported everywhere (Node: same)
    }
}

/// One archived row, in `ROW_COLS` order.
struct Row {
    id: i64,
    ts: f64,
    cols: Vec<(String, OVal)>,
    body_bytes: i64,
}

fn value_of(v: ValueRef<'_>) -> R<OVal> {
    Ok(match v {
        ValueRef::Null => OVal::Null,
        ValueRef::Integer(i) => {
            if i.unsigned_abs() > defaults::num("mesh.js_safe_int") {
                return defer("integer-range");
            }
            OVal::Num(i as f64)
        }
        ValueRef::Real(f) => OVal::Num(f),
        ValueRef::Text(t) => OVal::Str(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(_) => return defer("blob-value"),
    })
}

/// The rows of a batch that still have a body, with every column (Node's `full`).
fn full_rows(c: &Connection, ids: &[i64]) -> R<Vec<Row>> {
    let ph = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let sql = format!("{}{ph}{}", crate::sql::RT_FULL_OPEN, crate::sql::RT_FULL_CLOSE);
    let mut st = c.prepare(&sql).map_err(|e| Defer(format!("full-rows:{e}")))?;
    let mut rows = st.query(rusqlite::params_from_iter(ids.iter())).map_err(|e| Defer(format!("full-rows:{e}")))?;
    let names = defaults::list("devswarm_sup.rt_row_cols");
    let mut out = Vec::new();
    while let Some(r) = rows.next().map_err(|e| Defer(format!("full-rows:{e}")))? {
        let mut cols = Vec::new();
        let (mut id, mut ts, mut body_bytes) = (0i64, 0f64, 0i64);
        for (i, n) in names.iter().enumerate() {
            let v = value_of(r.get_ref(i).map_err(|e| Defer(format!("full-rows:{e}")))?)?;
            match (i, &v) {
                (0, OVal::Num(x)) => id = *x as i64,
                (2, OVal::Num(x)) => ts = *x,
                (4, OVal::Str(s)) => body_bytes = s.len() as i64,
                _ => {}
            }
            cols.push(((*n).to_string(), v));
        }
        out.push(Row { id, ts, cols, body_bytes });
    }
    Ok(out)
}

/// `appendArchive(home, hash, rows, now)`: one gzip member per month, verified, appended and fsynced.
fn append_archive(home: &Path, hash: &str, rows: &[Row], now: f64) -> R<Vec<(String, usize)>> {
    let dir = archive_root(home).join(hash);
    std::fs::create_dir_all(&dir).map_err(|e| Defer(format!("archive-dir:{e}")))?;
    let mut order: Vec<String> = Vec::new();
    let mut by_month: HashMap<String, Vec<&Row>> = HashMap::new();
    for r in rows {
        let m = month_of(r.ts);
        if !by_month.contains_key(&m) {
            order.push(m.clone());
        }
        by_month.entry(m).or_default().push(r);
    }
    let mut written = Vec::new();
    for m in order {
        let list = &by_month[&m];
        let file = dir.join(format!("{m}{}", defaults::text("devswarm_sup.rt_archive_ext")));
        let created = !file.exists();
        let mut text = String::new();
        for r in list {
            let mut cols = r.cols.clone();
            cols.push((defaults::text("devswarm_sup.rt_archived_at").to_string(), OVal::Num(now)));
            text.push_str(&OVal::Obj(cols).stringify());
            text.push('\n');
        }
        let gz = super::gz::compress_verified(text.as_bytes())?;
        let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&file).map_err(|e| Defer(format!("archive-open:{e}")))?;
        f.write_all(&gz).and_then(|()| f.sync_all()).map_err(|e| Defer(format!("archive-write:{e}")))?;
        if created {
            fsync_dir(&dir);
        }
        let rel = file.strip_prefix(archive_root(home)).map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
        written.push((rel, list.len()));
    }
    Ok(written)
}

fn parse_ratio(key: &str) -> f64 {
    defaults::text(key).parse().unwrap_or(f64::NAN)
}

/// `maybeVacuum(db, prunedBytes, fileBytes, clock, force)`.
fn maybe_vacuum(c: &Connection, pruned_bytes: i64, file_bytes: u64, force: bool) -> Option<OVal> {
    if pruned_bytes <= 0 {
        return None;
    }
    let count = |sql: &str| c.query_row(sql, [], |r| r.get::<_, i64>(0)).ok();
    let ratio = match (count(crate::sql::RT_PAGE_COUNT), count(crate::sql::RT_FREELIST_COUNT)) {
        (Some(pc), Some(fl)) if pc > 0 => fl as f64 / pc as f64,
        _ => 0.0,
    };
    let pruned_ratio = if file_bytes > 0 { pruned_bytes as f64 / file_bytes as f64 } else { 0.0 };
    let limit = parse_ratio("devswarm_sup.rt_vacuum_ratio");
    let obj = |extra: Vec<(&str, OVal)>| {
        let mut v: Vec<(String, OVal)> = extra.into_iter().map(|(k, x)| (k.to_string(), x)).collect();
        v.push(("freelistRatio".into(), OVal::Num(ratio)));
        v.push(("prunedRatio".into(), OVal::Num(pruned_ratio)));
        v
    };
    if !force && ratio <= limit && pruned_ratio <= limit {
        return Some(OVal::Obj(obj(vec![("ran", OVal::Bool(false))]).into_iter().collect()));
    }
    let t = Instant::now();
    match c.execute_batch(crate::sql::RT_VACUUM) {
        Ok(()) => {
            crate::discard::harmless(c.execute_batch(crate::sql::RT_CHECKPOINT)); // keep: Node ignores a checkpoint failure
            let mut v = obj(vec![("ran", OVal::Bool(true)), ("ms", OVal::Num(t.elapsed().as_millis() as f64))]);
            let tail = v.split_off(2);
            v.extend(tail);
            Some(OVal::Obj(v))
        }
        Err(e) => {
            let mut v = obj(vec![("ran", OVal::Bool(false)), ("deferred", OVal::Bool(true))]);
            v.push(("error".into(), OVal::Str(e.to_string())));
            Some(OVal::Obj(v))
        }
    }
}

/// Everything a prune needs besides the plan.
pub struct Run<'a> {
    /// The home directory.
    pub home: &'a Path,
    /// The store.
    pub hash: &'a str,
    /// The settings.
    pub settings: Settings,
    /// The sweep's clock (ms).
    pub now: f64,
    /// The time budget (ms).
    pub budget_ms: f64,
    /// The retention state (updated in place: `stores.<hash>.maxArchivedId`).
    pub state: &'a mut OVal,
    /// A command-line run: mark the commit point of the front door before the first write (Node must never repeat it).
    pub commit: bool,
}

/// Open the store for writing (never creating it).
fn open_rw(home: &Path, hash: &str) -> R<Connection> {
    let c = Connection::open_with_flags(plan::db_path(home, hash), OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX)
        .map_err(|e| Defer(format!("store-open:{e}")))?;
    crate::discard::harmless(c.busy_timeout(defaults::millis("devswarm_sup.rt_busy_ms"))); // keep: the default timeout only fails sooner
    Ok(c)
}

fn num_of(v: ValueRef<'_>) -> f64 {
    match v {
        ValueRef::Integer(i) => i as f64,
        ValueRef::Real(f) => f,
        ValueRef::Text(t) => crate::checks::guardkit::text::js_number_of_str(&String::from_utf8_lossy(t)),
        _ => f64::NAN,
    }
}

/// What the live row looks like now: (partition, ts, hash, needs reply, has body).
type Live = (String, f64, Option<String>, bool, bool);

fn live_row(c: &Connection, id: i64) -> Option<Live> {
    c.query_row(crate::sql::RT_ROW_NOW, params![id], |r| {
        let text = |i: usize| match r.get_ref(i) {
            Ok(ValueRef::Text(t)) => Some(String::from_utf8_lossy(t).into_owned()),
            _ => None,
        };
        Ok((
            text(0).unwrap_or_default(),
            r.get_ref(1).map(num_of).unwrap_or(f64::NAN),
            text(2),
            r.get_ref(3).map(num_of).unwrap_or(0.0) == 1.0,
            r.get_ref(4).map(num_of).unwrap_or(0.0) == 1.0,
        ))
    })
    .ok()
}

/// The minimum broadcast cursor over the table and every registered workspace (`planStore`'s `minBc`).
fn min_broadcast_cursor(c: &Connection) -> f64 {
    let js_min = |a: f64, b: f64| if a.is_nan() || b.is_nan() { f64::NAN } else { a.min(b) };
    let mut min_bc = f64::INFINITY;
    let mut ok = true;
    match c.prepare(crate::sql::RT_BC_ALL) {
        Ok(mut q) => match q.query([]) {
            Ok(mut rows) => {
                while let Ok(Some(r)) = rows.next() {
                    min_bc = js_min(min_bc, r.get_ref(0).map_or(f64::NAN, num_of));
                }
            }
            Err(_) => ok = false,
        },
        Err(_) => ok = false,
    }
    if !ok {
        min_bc = 0.0;
    }
    if let Ok(mut q) = c.prepare(crate::sql::RT_REGISTRY)
        && let Ok(mut rows) = q.query([])
    {
        let mut ids: Vec<String> = Vec::new();
        while let Ok(Some(r)) = rows.next() {
            if let Ok(ValueRef::Text(t)) = r.get_ref(0) {
                ids.push(String::from_utf8_lossy(t).into_owned());
            }
        }
        for id in ids {
            let v = c.query_row(crate::sql::RT_BC_ONE, params![id], |r| r.get_ref(0).map(num_of)).unwrap_or(0.0);
            min_bc = js_min(min_bc, v);
        }
    }
    if min_bc.is_finite() { min_bc } else { 0.0 }
}

/// `doBatches(list)` for one list of chosen rows: `false` when the time budget ran out.
#[allow(clippy::too_many_arguments)]
fn do_batches(c: &Connection, run: &mut Run, plan_cutoff: f64, list: &[Cand], t0: &Instant, res: &mut Pruned) -> R<bool> {
    let batch_rows = defaults::num("devswarm_sup.rt_batch_rows") as usize;
    let broadcast_id = defaults::text("devswarm_sup.rt_broadcast_partition");
    for chunk in list.chunks(batch_rows) {
        if t0.elapsed().as_millis() as f64 > run.budget_ms {
            res.budget_exhausted = true;
            return Ok(false);
        }
        let by_id: HashMap<i64, &Cand> = chunk.iter().map(|x| (x.id, x)).collect();
        let ids: Vec<i64> = chunk.iter().map(|x| x.id).collect();
        let full = full_rows(c, &ids)?;
        if full.is_empty() {
            continue;
        }
        if run.commit {
            crate::meshw::mark_committed();
        }
        let written = if run.settings.archive { append_archive(run.home, run.hash, &full, run.now)? } else { Vec::new() };
        // the tombstoning transaction
        let (mut pruned, mut pruned_bytes) = (0i64, 0i64);
        let mut done: Vec<i64> = Vec::new();
        c.execute_batch(crate::sql::RT_BEGIN).map_err(|e| Defer(format!("begin:{e}")))?;
        let body = (|| -> R<()> {
            let mut bound_cache: HashMap<String, Option<f64>> = HashMap::new();
            let min_bc = min_broadcast_cursor(c);
            for r in &full {
                let Some(cand) = by_id.get(&r.id) else { continue };
                // the strict re-check against the live row (never weaker than Node's bound re-check)
                let Some((ws, ts, hash, needs_reply, has_body)) = live_row(c, r.id) else { continue };
                if !has_body || ws != cand.partition || hash != cand.hash || needs_reply {
                    continue;
                }
                let older = ts < plan_cutoff;
                if cand.old_enough && !older {
                    continue;
                }
                if cand.partition != broadcast_id {
                    let pos: i64 = c.query_row(crate::sql::RT_POSITION, params![&cand.partition, r.id], |x| x.get(0)).unwrap_or(-1);
                    if pos != cand.pos {
                        continue;
                    }
                    let b = *bound_cache.entry(cand.partition.clone()).or_insert_with(|| plan::sql_bound(c, &cand.partition));
                    if let Some(b) = b {
                        let within = cand.pos as f64 <= b;
                        if !within {
                            continue; // a reader fell back (an un-retire): keep it
                        }
                    }
                } else if !c
                    .query_row(crate::sql::RT_ROW_BROADCAST, params![r.id], |x| Ok((x.get::<_, Option<f64>>(0)?, x.get::<_, Option<i64>>(1)?)))
                    .ok()
                    .is_some_and(|(seq, hb)| hb == Some(1) || seq.is_some_and(|s| s <= min_bc))
                {
                    continue;
                }
                let n = c.execute(crate::sql::RT_TOMBSTONE, params![r.id]).map_err(|e| Defer(format!("tombstone:{e}")))?;
                if n > 0 {
                    pruned += 1;
                    pruned_bytes += r.body_bytes;
                    done.push(r.id);
                }
            }
            Ok(())
        })();
        match body {
            Ok(()) => c.execute_batch(crate::sql::RT_COMMIT).map_err(|e| Defer(format!("commit:{e}")))?,
            Err(e) => {
                crate::discard::harmless(c.execute_batch(crate::sql::RT_ROLLBACK)); // keep: the original error is what is reported
                return Err(e);
            }
        }
        res.tombstoned += pruned;
        res.tombstoned_bytes += pruned_bytes;
        res.batches += 1;
        res.archived.extend(written.iter().cloned());
        if let Some(&last) = done.last() {
            let key = run.hash.to_string();
            let entry = obj_mut(obj_mut(run.state, defaults::text("devswarm_sup.rt_state_stores")), &key);
            let prev = match entry.get(defaults::text("devswarm_sup.rt_state_max_archived")) {
                Some(OVal::Num(n)) if n.is_finite() => *n,
                Some(OVal::Str(s)) => crate::checks::guardkit::text::js_number_of_str(s),
                _ => 0.0,
            };
            entry.set(defaults::text("devswarm_sup.rt_state_max_archived"), OVal::Num(prev.max(last as f64)));
        }
        let archived = if run.settings.archive {
            OVal::Arr(written.iter().map(|(f, n)| OVal::Obj(vec![("file".into(), OVal::Str(f.clone())), ("rows".into(), OVal::Num(*n as f64))])).collect())
        } else {
            OVal::Bool(false)
        };
        log_event(
            run.home,
            &[
                ("event", OVal::Str(defaults::text("devswarm_sup.rt_ev_prune_batch").into())),
                ("store", OVal::Str(run.hash.into())),
                ("rows", OVal::Num(pruned as f64)),
                ("bytes", OVal::Num(pruned_bytes as f64)),
                ("minId", done.first().map_or(OVal::Null, |x| OVal::Num(*x as f64))),
                ("maxId", done.last().map_or(OVal::Null, |x| OVal::Num(*x as f64))),
                ("archived", archived),
            ],
        );
    }
    Ok(true)
}

/// `state[key]` as a mutable object, created (empty) when missing or not an object.
pub fn obj_mut<'a>(o: &'a mut OVal, key: &str) -> &'a mut OVal {
    if !matches!(o, OVal::Obj(_)) {
        *o = OVal::Obj(Vec::new());
    }
    let OVal::Obj(v) = o else { return o };
    let idx = match v.iter().position(|(k, _)| k == key) {
        Some(idx) => idx,
        None => {
            v.push((key.to_string(), OVal::Obj(Vec::new())));
            v.len() - 1
        }
    };
    if !matches!(v[idx].1, OVal::Obj(_)) {
        v[idx].1 = OVal::Obj(Vec::new());
    }
    &mut v[idx].1
}

/// The write half of `pruneStore` for rows chosen from an agreed plan. `Err` only before or between batches, never inside the
/// tombstoning transaction (which is rolled back first): the rows already committed stay committed and Node's own sweep
/// resumes the rest, as it would after its own crash.
pub fn prune(run: &mut Run, plan: &Plan, mut chosen: Chosen, size_added: usize, age_n: usize, bytes_before: u64, over_limit: bool) -> R<Pruned> {
    let t0 = Instant::now();
    let max_bytes = run.settings.max_bytes();
    let mut res = Pruned {
        hash: run.hash.to_string(),
        ok: true,
        bytes_before,
        age_candidates: age_n,
        size_candidates: size_added,
        over_limit,
        candidate_bytes: chosen.bytes(),
        ..Pruned::default()
    };
    let c = open_rw(run.home, run.hash)?;
    let cutoff = run.now - run.settings.days * defaults::num("devswarm_sup.rt_day_ms") as f64;
    let mut ordered = chosen.list.clone();
    ordered.sort_by_key(|x| x.id);
    let mut finished = do_batches(&c, run, cutoff, &ordered, &t0, &mut res)?;
    res.vacuum = maybe_vacuum(&c, res.tombstoned_bytes, res.bytes_before, res.over_limit);
    res.bytes_after = store_bytes(run.home, run.hash);
    // size rounds: the body-bytes estimate can undershoot the real reclaim
    let mut round = 1;
    while finished && res.bytes_after as f64 > max_bytes && round < defaults::num("devswarm_sup.rt_size_rounds") {
        round += 1;
        let before = chosen.list.len();
        let pruned_so_far = res.tombstoned_bytes;
        chosen.add_for(plan, chosen.bytes() as f64 + (res.bytes_after as f64 - max_bytes));
        let mut extra: Vec<Cand> = chosen.list[before..].to_vec();
        extra.sort_by_key(|x| x.id);
        if extra.is_empty() {
            break;
        }
        res.size_candidates += extra.len();
        finished = do_batches(&c, run, cutoff, &extra, &t0, &mut res)?;
        if let Some(v) = maybe_vacuum(&c, res.tombstoned_bytes - pruned_so_far, res.bytes_after, true) {
            res.vacuum = Some(v);
        }
        res.bytes_after = store_bytes(run.home, run.hash);
    }
    res.over_limit_protected = res.bytes_after as f64 > max_bytes && finished && chosen.list.len() >= plan.cands.len();
    if res.bytes_after as f64 > max_bytes {
        let ev =
            if res.over_limit_protected { defaults::text("devswarm_sup.rt_ev_over_limit_protected") } else { defaults::text("devswarm_sup.rt_ev_over_limit") };
        log_event(
            run.home,
            &[
                ("event", OVal::Str(ev.into())),
                ("store", OVal::Str(run.hash.into())),
                ("bytes", OVal::Num(res.bytes_after as f64)),
                ("limitBytes", OVal::Num(max_bytes)),
            ],
        );
    }
    Ok(res)
}
