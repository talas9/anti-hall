//! The loss-free unread union of a workspace's mailbox: its durable NDJSON inbox plus the rows of its store partition,
//! deduplicated, ported from `companion/lib/devswarm-unread.js` (`unionUnread`), `companion/lib/liveness.js`
//! (`unreadBacklog`, `unionPendingFor`) and the floor view of `companion/lib/reader-cursors.js` (`positions`, `countFor`
//! with no reader).
//!
//! Everything here only READS. Where Node's answer depends on something this port cannot reproduce exactly (a store read
//! error, which Node reports as UNKNOWN; a partition without its `reader_cursors` floor rows, which Node first imports
//! from the legacy cursor files; a JSON value in a position where JavaScript would stringify an object) the function
//! returns a [`Defer`](crate::meshw::ident::Defer) and the caller hands the verb to Node before it has written anything.
//!
//! A message is counted once even when both channels carry it: a store row is dropped from the store-only set when an
//! NDJSON line reproduces its hash (`_h`, or the legacy line hash) or, failing that, covers it by body. Which store rows
//! are unread comes from the store base cursor, which NDJSON lines are unread from the NDJSON base cursor.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an unreadable optional file is the same as an absent one (Node's try/catch around readFileSync)
// - text that does not parse is the absent value (Node's JSON.parse catch parity)
use crate::checks::guardkit::ojson::OVal;
use crate::checks::guardkit::text::{js_number_of_str, js_trim};
use crate::defaults;
use crate::meshw::readprimary::store_err;
use crate::mesh::MeshReader;
use crate::meshw::ident::{self, R};
use crate::meshw::idlock::devswarm_root;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::Path;

/// What [`union_unread`] reports (only the fields a caller needs; `total` is not computed).
#[derive(Debug, Clone, PartialEq)]
pub struct Union {
    /// Unread NDJSON lines plus store-only unread rows.
    pub unread: usize,
    /// The unread NDJSON lines, untrimmed.
    pub nd_unread_lines: Vec<String>,
    /// Leading unread NDJSON lines skipped because their store twin (same hash) is already read. The NDJSON position an ack
    /// writes is `nd base + nd_skipped + nd_unread_lines.len()`, so the tail stays contiguous.
    pub nd_skipped: usize,
    /// The unread store rows no NDJSON line covers.
    pub store_only_unread: Vec<Value>,
    /// Age in ms of the oldest unread row that carries a timestamp, `None` when none does (or the age is negative).
    pub oldest_unread_age_ms: Option<f64>,
}

/// The inputs of [`union_unread`] (Node's `unionUnread` opts).
pub struct UnionIn<'a> {
    /// The descriptor's NDJSON inbox path.
    pub inbox: Option<&'a str>,
    /// The descriptor's NDJSON cursor file.
    pub cursor_file: Option<&'a str>,
    /// The partition id (`o.id`).
    pub id: &'a str,
    /// The open store, or `None` for an NDJSON-only report.
    pub store: Option<&'a MeshReader>,
    /// The store read base (`storeBaseCursor`).
    pub store_base: f64,
    /// The NDJSON read base (`ndBaseCursor`).
    pub nd_base: f64,
    /// `Date.now()` (or the pinned clock).
    pub now: i64,
}

/// `Number.isFinite(x) && x > 0 ? Math.floor(x) : 0`, as a usize.
fn floor_index(x: f64) -> usize {
    if x.is_finite() && x > 0.0 { x.floor() as usize } else { 0 }
}

/// `String(readFileSync(path, 'utf8')).split('\n').filter((l) => l.trim() !== '')`; `None` when the file cannot be read.
/// A FIFO, device or file over the cap defers ([`ident::read_bounded`]).
pub fn non_empty_lines(path: &str) -> R<Option<Vec<String>>> {
    Ok(ident::read_bounded(Path::new(path))?.map(|bytes| lines_of(&String::from_utf8_lossy(&bytes))))
}

fn lines_of(text: &str) -> Vec<String> {
    text.split('\n').filter(|l| !js_trim(l).is_empty()).map(str::to_string).collect()
}

/// Why an NDJSON cursor file does not give a position (`unreadBacklog`'s `known: false`).
pub fn cursor_position(path: &str) -> R<Option<f64>> {
    let Some(bytes) = ident::read_bounded(Path::new(path))? else { return Ok(None) };
    let text = String::from_utf8_lossy(&bytes).into_owned();
    let raw = js_trim(&text);
    let c = if !raw.is_empty() && raw.bytes().all(|b| b.is_ascii_digit()) {
        // V8's parseInt of a decimal digit string is correctly rounded, as `f64::from_str` is (checked: equal to Number() for
        // 400-digit strings, which both read as Infinity, i.e. not a position)
        raw.parse::<f64>().unwrap_or(f64::NAN)
    } else {
        match OVal::parse(raw) {
            // `JSON.parse(raw).line` of an object; any other JSON value has no `.line` (null throws): not known
            Some(o @ OVal::Obj(_)) => match o.get("line") {
                Some(OVal::Num(x)) => *x,
                Some(OVal::Str(t)) => js_number_of_str(t),
                Some(OVal::Null) => 0.0,
                Some(OVal::Bool(b)) => f64::from(u8::from(*b)),
                None => f64::NAN,
                // Number([..]) is Number(String([..])); Number({..}) is NaN
                Some(arr @ OVal::Arr(_)) => js_number_of_str(&crate::dssup::ingest::import::js_string(arr)),
                Some(OVal::Obj(_)) => f64::NAN,
            },
            _ => f64::NAN,
        }
    };
    Ok((c.is_finite() && c >= 0.0).then_some(c))
}

/// `String(o._h)` for a parsed NDJSON line: `Some(hash)` when it is an object (or array) with a non-null `_h`.
fn embedded_hash(line: &str) -> R<Option<String>> {
    let Some(o) = OVal::parse(line) else { return Ok(None) };
    match o.get(defaults::text("mesh_write.ndjson_hash_field")) {
        None | Some(OVal::Null) => Ok(None),
        Some(OVal::Str(s)) => Ok(Some(s.clone())),
        Some(OVal::Num(n)) => Ok(Some(crate::checks::jsport::num::to_js_string(*n))),
        Some(OVal::Bool(b)) => Ok(Some(b.to_string())),
        Some(other) => Ok(Some(crate::dssup::ingest::import::js_string(other))),
    }
}

/// `legacyLineHash(id, index, line)`.
pub fn legacy_line_hash(id: &str, index: usize, line: &str) -> String {
    let text = format!("{id}\0{index}\0{line}");
    let d = ring::digest::digest(&ring::digest::SHA256, text.as_bytes());
    format!("{}{}", defaults::text("mesh_write.legacy_hash_prefix"), crate::meshw::store::hex(d.as_ref()))
}

/// `ndjsonHashesFromLines(lines, id, startIndex)`: every hash under which each line could sit in the store.
fn line_hashes(lines: &[String], id: &str, start: usize) -> R<HashSet<String>> {
    let mut set = HashSet::new();
    for (i, line) in lines.iter().enumerate() {
        if let Some(h) = embedded_hash(line)? {
            set.insert(h);
        }
        set.insert(legacy_line_hash(id, start + i, line));
    }
    Ok(set)
}

fn str_of(row: &Value, k: &str) -> String {
    row[k].as_str().unwrap_or("").to_string()
}

/// The `hash` of a store row when it is set and non-empty (`r.hash` truthy).
fn truthy_hash(row: &Value) -> Option<&str> {
    row["hash"].as_str().filter(|h| !h.is_empty())
}

/// `bodyCoveredRows(rows, lines, storeHashes, id, startIndex)`: the indices of `rows` an NDJSON line covers by body.
fn body_covered(rows: &[Value], lines: &[String], store_hashes: &HashSet<String>, id: &str, start: usize) -> R<HashSet<usize>> {
    let mut covered = HashSet::new();
    if rows.is_empty() || lines.is_empty() {
        return Ok(covered);
    }
    let mut by_body: HashMap<String, std::collections::VecDeque<usize>> = HashMap::new();
    for (i, r) in rows.iter().enumerate() {
        by_body.entry(str_of(r, "body")).or_default().push_back(i);
    }
    for (i, line) in lines.iter().enumerate() {
        if embedded_hash(line)?.is_some() {
            continue; // native-drained: its store twin carries the same _h
        }
        if store_hashes.contains(&legacy_line_hash(id, start + i, line)) {
            continue; // already matched on the legacy hash
        }
        if let Some(pool) = by_body.get_mut(line.as_str())
            && let Some(r) = pool.pop_front()
        {
            covered.insert(r);
        }
    }
    Ok(covered)
}

/// `rowTs(row)` of an NDJSON line.
fn line_ts(line: &str) -> Option<f64> {
    let o = OVal::parse(line)?;
    for k in [defaults::text("mesh_write.ndjson_ts_field"), defaults::text("mesh_write.ndjson_created_field")] {
        if let Some(OVal::Num(n)) = o.get(k)
            && n.is_finite()
        {
            return Some(*n);
        }
    }
    None
}

/// `unionUnread(opts)` for an NDJSON inbox plus a store partition read at the given bases.
pub fn union_unread(i: &UnionIn<'_>) -> R<Union> {
    // readUnread / unreadBacklog: the lines are only known when the inbox and its cursor file both read
    let all = match i.inbox {
        Some(p) => non_empty_lines(p)?,
        None => None,
    };
    let position = match (&all, i.cursor_file) {
        (Some(_), Some(c)) => cursor_position(c)?,
        _ => None,
    };
    let known = all.is_some() && position.is_some();
    let all_lines = all.clone().unwrap_or_default();
    let total = all_lines.len();
    // the NDJSON read position is the reader_cursors base, not the cursor file (which only says "known")
    let mut nd_lines: Vec<String> = if known { all_lines.iter().skip(floor_index(i.nd_base)).cloned().collect() } else { Vec::new() };
    let mut nd_skipped = 0usize;
    let mut store_only: Vec<Value> = Vec::new();
    if let Some(reader) = i.store {
        let unread_start = total.saturating_sub(nd_lines.len());
        let unread_hashes = line_hashes(&nd_lines, i.id, unread_start)?;
        let mut store_hashes: HashSet<String> = HashSet::new();
        reader
            .for_each_message(i.id, 0, |m| {
                if let Some(h) = m["hash"].as_str() {
                    store_hashes.insert(h.to_string());
                }
                true
            })
            .map_err(|e| store_err("store-read", e))?;
        let mut unread_rows: Vec<Value> = Vec::new();
        reader
            .for_each_message(i.id, floor_index(i.store_base) as u64, |m| {
                unread_rows.push(m);
                true
            })
            .map_err(|e| store_err("store-read", e))?;
        let unread_row_hashes: HashSet<String> = unread_rows.iter().filter_map(|r| truthy_hash(r).map(str::to_string)).collect();
        let uncovered: Vec<Value> = unread_rows.into_iter().filter(|r| truthy_hash(r).is_none_or(|h| !unread_hashes.contains(h))).collect();
        let by_body = body_covered(&uncovered, &nd_lines, &store_hashes, i.id, unread_start)?;
        store_only = uncovered.into_iter().enumerate().filter(|(n, _)| !by_body.contains(n)).map(|(_, r)| r).collect();
        // leading twin-read run (Node `unionUnread`): a line whose store twin is at or behind the store read position was read
        let read_hashes: HashSet<&String> = store_hashes.iter().filter(|h| !unread_row_hashes.contains(*h)).collect();
        while nd_skipped < nd_lines.len() {
            let line = &nd_lines[nd_skipped];
            let twin_read = embedded_hash(line)?.is_some_and(|h| read_hashes.contains(&h))
                || read_hashes.contains(&legacy_line_hash(i.id, unread_start + nd_skipped, line));
            if !twin_read {
                break;
            }
            nd_skipped += 1;
        }
        nd_lines.drain(..nd_skipped);
    }
    let mut oldest: Option<f64> = None;
    for ts in nd_lines.iter().filter_map(|l| line_ts(l)).chain(store_only.iter().filter_map(|r| r["ts"].as_f64().filter(|t| t.is_finite()))) {
        oldest = Some(oldest.map_or(ts, |o| o.min(ts)));
    }
    let age = oldest.map(|o| i.now as f64 - o).filter(|a| *a >= 0.0);
    Ok(Union { unread: nd_lines.len() + store_only.len(), nd_unread_lines: nd_lines, nd_skipped, store_only_unread: store_only, oldest_unread_age_ms: age })
}

/// `unionUnread`'s merged `total` over the whole history: the NDJSON lines plus the store rows no line covers (by hash,
/// else by body). Only a read that reports `total` needs it.
pub fn merged_total(i: &UnionIn<'_>) -> R<usize> {
    let all = match i.inbox {
        Some(p) => non_empty_lines(p)?.unwrap_or_default(),
        None => Vec::new(),
    };
    let Some(reader) = i.store else { return Ok(all.len()) };
    let hashes = line_hashes(&all, i.id, 0)?;
    let mut rows: Vec<Value> = Vec::new();
    reader
        .for_each_message(i.id, 0, |m| {
            rows.push(m);
            true
        })
        .map_err(|e| store_err("store-read", e))?;
    let store_hashes: HashSet<String> = rows.iter().filter_map(|m| m["hash"].as_str().map(str::to_string)).collect();
    let uncovered: Vec<Value> = rows.into_iter().filter(|r| truthy_hash(r).is_none_or(|h| !hashes.contains(h))).collect();
    let by_body = body_covered(&uncovered, &all, &store_hashes, i.id, 0)?;
    Ok(all.len() + uncovered.len() - by_body.len())
}

/// The floor view of `positions(store, { reader: null, partition, cursorPath })`: `(store base, nd base)`. A namespace without its floor
/// row reads its legacy floor instead, as Node's `positions()` does (`legacyStoreFloor`, `legacyNdFloor` of the caller's cursor path or
/// the descriptor's); nothing is written.
pub fn floor_bases(reader: &MeshReader, home: &Path, partition: &str, cursor_path: Option<&str>) -> R<(f64, f64)> {
    let rows = reader.reader_cursors(partition).map_err(|e| store_err("cursor-rows", e))?;
    let floor_of = |ns: &str| -> Option<f64> {
        rows.iter().find(|r| r["ns"] == ns && r["reader"] == defaults::text("mesh_write.floor_reader")).and_then(|r| r["value"].as_f64())
    };
    let (store_row, nd_row) = (floor_of(defaults::text("mesh_write.cursor_ns_store")), floor_of(defaults::text("mesh_write.cursor_ns_nd")));
    let store = match store_row {
        Some(v) => v,
        None => crate::migrate::readercur::legacy_store_floor(reader, home, partition),
    };
    let Some(nd) = nd_row else {
        let desc_cp = crate::migrate::readercur::desc_cursor_path(crate::migrate::readercur::descriptor_of(home, partition).as_ref());
        let cp = cursor_path.filter(|c| !c.is_empty()).map(str::to_string).or(desc_cp);
        return Ok((store, crate::migrate::readercur::legacy_nd_floor(cp.as_deref())));
    };
    // distinctNdFloor: the legacy nd cursor, except when the file is the partition's shared store cursor
    let distinct = match cursor_path {
        None => 0.0,
        Some(cp) => {
            let shared = crate::meshw::cursors::primary_cursor_path(home, partition);
            if ident::resolve_abs(cp) == ident::resolve_abs(&shared.to_string_lossy()) { 0.0 } else { crate::meshw::cursors::read_cursor(Path::new(cp)) }
        }
    };
    Ok((store, nd.max(distinct)))
}

/// What [`unread_for`] reports: the union, the bases it was read at, and how many unread rows the caller's own family sent.
#[derive(Debug, Clone, PartialEq)]
pub struct Unread {
    /// The unread union at the bases (every row, own sends included: the lists an ack walks stay contiguous).
    pub union: Union,
    /// The unread count of the mail others sent: `union.unread` without the rows the recipient's family sent.
    pub unread: usize,
    /// Unread rows the family sent (already out of `unread`).
    pub own_excluded: usize,
    /// The store read base.
    pub store_base: f64,
    /// The NDJSON read base.
    pub nd_base: f64,
}

/// The ONE unread count of a partition for a reader: the floor rows, then the reader's own rows ([`read_bases`]), the loss-free
/// union at those bases, and the count without the mail the recipient's own identity family sent. Tick, read-primary, the
/// summary and the statusline all count through here, so they cannot disagree (Node: `countFor` plus `recipientFamilyIds`).
#[allow(clippy::too_many_arguments)]
pub fn unread_for(
    reader: &MeshReader,
    home: &Path,
    id: &str,
    inbox: Option<&str>,
    cursor_file: Option<&str>,
    me: Option<&str>,
    family: &HashSet<String>,
    now: i64,
) -> R<Unread> {
    let (store_base, nd_base) = read_bases(reader, home, id, cursor_file, me)?;
    unread_at(reader, id, inbox, cursor_file, (store_base, nd_base), family, now)
}

/// [`unread_for`] at bases the caller already settled (the summary's floor view, which has its own legacy-floor fallback).
pub fn unread_at(
    reader: &MeshReader,
    id: &str,
    inbox: Option<&str>,
    cursor_file: Option<&str>,
    (store_base, nd_base): (f64, f64),
    family: &HashSet<String>,
    now: i64,
) -> R<Unread> {
    let union = union_unread(&UnionIn { inbox, cursor_file, id, store: Some(reader), store_base, nd_base, now })?;
    // the engine's own wake prompts (stored by DevSwarm as direct mail) are not mail: never unread, like the family's own sends
    let wake = defaults::text("agent_tracker.wake_prefix");
    let own_nd = union
        .nd_unread_lines
        .iter()
        .filter(|l| line_sender(l).is_some_and(|s| family.contains(&s)) || line_body(l).is_some_and(|b| b.starts_with(wake)))
        .count();
    let own_store = union
        .store_only_unread
        .iter()
        .filter(|r| r.get("sender").and_then(Value::as_str).is_some_and(|s| family.contains(s)) || r.get("body").and_then(Value::as_str).is_some_and(|b| b.starts_with(wake)))
        .count();
    let own_excluded = own_nd + own_store;
    Ok(Unread { unread: union.unread - own_excluded, own_excluded, union, store_base, nd_base })
}

/// `positions()`: the floor rows, then the reader's own rows when `me` is a declared reader: `(store base, nd base)`.
pub fn read_bases(reader: &MeshReader, home: &Path, id: &str, cursor_file: Option<&str>, me: Option<&str>) -> R<(f64, f64)> {
    let (mut store_base, mut nd_base) = floor_bases(reader, home, id, cursor_file)?;
    if let Some(me) = me {
        let rows = reader.reader_cursors(id).map_err(|e| store_err("cursor-rows", e))?;
        let own = |ns: &str| rows.iter().find(|r| r["ns"] == ns && r["reader"] == me).and_then(|r| r["value"].as_f64());
        if let Some(v) = own(defaults::text("mesh_write.cursor_ns_store")) {
            store_base = v;
        }
        if let Some(v) = own(defaults::text("mesh_write.cursor_ns_nd")) {
            nd_base = v;
        }
    }
    Ok((store_base, nd_base))
}

/// The roster/summary read base of a partition (`liveBaseOf` in reader-cursors.js): per namespace the MINIMUM position over its LIVE
/// declared reader rows (`live_min`: not `#floor`, not retired), computed at read time. The stored `#floor` is never used: a dead or
/// stale reader can hold it back (the phantom unread of #181). `None` when the partition has no live reader row in either namespace.
#[derive(Debug, Clone, PartialEq)]
pub struct LiveBase {
    /// The least-advanced live reader's store position, when it has a store row.
    pub store: Option<f64>,
    /// The least-advanced live reader's NDJSON position, when it has an NDJSON row.
    pub nd: Option<f64>,
}

/// [`LiveBase`] over the raw `reader_cursors` rows of a partition.
pub fn live_base_of(rows: &[Value]) -> Option<LiveBase> {
    let floor = defaults::text("mesh_write.floor_reader");
    let at = |ns: &str| {
        rows.iter()
            .filter(|r| r["ns"] == ns && r["reader"].as_str().is_some_and(|x| x != floor))
            .filter_map(|r| {
                let (v, line) = (r["value"].as_f64()?, r["retiredLine"].as_f64());
                (!line.is_some_and(|l| v <= l)).then_some(v)
            })
            .reduce(f64::min)
    };
    let base = LiveBase { store: at(defaults::text("mesh_write.cursor_ns_store")), nd: at(defaults::text("mesh_write.cursor_ns_nd")) };
    (base.store.is_some() || base.nd.is_some()).then_some(base)
}

/// The `sender` an NDJSON line carries (the id `pull` resolved), when it names one.
pub fn line_sender(line: &str) -> Option<String> {
    match OVal::parse(line)?.get(defaults::text("mesh_write.ndjson_sender_field")) {
        Some(OVal::Str(s)) if !s.is_empty() => Some(s.clone()),
        _ => None,
    }
}

/// The body an NDJSON line carries.
pub fn line_body(line: &str) -> Option<String> {
    match OVal::parse(line)?.get(defaults::text("mesh_write.ndjson_message_field")) {
        Some(OVal::Str(s)) => Some(s.clone()),
        _ => None,
    }
}

/// `recipientFamilyIds(recipientId, rows)` on `(id, sessionId)` pairs: the recipient and every row cross-linked to it.
pub fn family_ids(rid: &str, rows: &[(String, Option<String>)]) -> HashSet<String> {
    let mut out = HashSet::new();
    if rid.is_empty() {
        return out;
    }
    out.insert(rid.to_string());
    let my_sess = rows.iter().find(|(id, _)| id == rid).and_then(|(_, s)| s.as_deref());
    for (id, sess) in rows {
        if crate::meshw::summary::cross_linked(rid, my_sess, id, sess.as_deref()) {
            out.insert(id.clone());
        }
    }
    out
}

/// Where a partition's reads go: its repo key's store directory.
pub fn store_dir(home: &Path, repo_key: &str) -> std::path::PathBuf {
    devswarm_root(home).join(defaults::text("mesh_write.dir_store")).join(repo_key)
}

/// A string that is a JavaScript-truthy path: `Some(non-empty)`, `None` for absent/null/empty/false/0; a value of another
/// type is no path any file call of Node's accepts (each throws into its own catch), so it reads as no path.
pub fn path_field(d: &OVal, key: &str) -> R<Option<String>> {
    match d.get(key) {
        None | Some(OVal::Null | OVal::Bool(false)) => Ok(None),
        Some(OVal::Str(s)) => Ok((!s.is_empty()).then(|| s.clone())),
        Some(OVal::Num(n)) if *n == 0.0 || n.is_nan() => Ok(None),
        Some(_) => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::{Connection, params};

    /// Runs `f` on a thread and returns its answer, failing when it takes longer than the bound (a read that blocks on a FIFO).
    fn within<T: Send + 'static>(what: &str, f: impl FnOnce() -> T + Send + 'static) -> T {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || crate::discard::harmless(tx.send(f())));
        rx.recv_timeout(std::time::Duration::from_secs(10)).unwrap_or_else(|_| panic!("{what}: still blocked after 10 s"))
    }

    fn scratch(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("ah-union-bounded-{}-{tag}", std::process::id()));
        crate::discard::harmless(std::fs::remove_dir_all(&dir)); // keep: an absent directory is the goal state
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn fifo(p: &std::path::Path) {
        let c = std::ffi::CString::new(p.to_string_lossy().as_bytes()).unwrap();
        // SAFETY: `c` is a NUL-terminated path that outlives the call; mkfifo only creates the node.
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0, "mkfifo");
    }

    #[test]
    fn a_fifo_inbox_or_cursor_defers_at_once_instead_of_blocking() {
        let dir = scratch("fifo");
        let (inbox, cursor) = (dir.join("in.ndjson"), dir.join("cur.json"));
        fifo(&inbox);
        fifo(&cursor);
        let (i, c) = (inbox.to_string_lossy().into_owned(), cursor.to_string_lossy().into_owned());
        let (i2, c2) = (i.clone(), c.clone());
        assert!(within("non_empty_lines", move || non_empty_lines(&i2).is_err()));
        assert!(within("cursor_position", move || cursor_position(&c2).is_err()));
        let got = within("union_unread", move || {
            union_unread(&UnionIn { inbox: Some(&i), cursor_file: Some(&c), id: "w", store: None, store_base: 0.0, nd_base: 0.0, now: 0 }).is_err()
        });
        assert!(got, "a FIFO inbox defers");
        crate::discard::harmless(std::fs::remove_dir_all(&dir)); // keep: cleanup of a scratch directory
    }

    #[test]
    fn a_file_past_the_hard_limit_reads_as_absent_without_being_read_and_a_directory_is_absent() {
        let dir = scratch("big");
        let big = dir.join("in.ndjson");
        std::fs::File::create(&big).unwrap().set_len(defaults::num("mesh_write.file_read_hard_max_bytes") + 1).unwrap();
        let b = big.to_string_lossy().into_owned();
        assert!(within("oversize", move || non_empty_lines(&b) == Ok(None) && cursor_position(&b).is_ok()));
        std::fs::create_dir_all(dir.join("d")).unwrap();
        assert_eq!(non_empty_lines(&dir.join("d").to_string_lossy()), Ok(None), "a directory reads as Node's caught EISDIR");
        assert_eq!(non_empty_lines(&dir.join("none").to_string_lossy()), Ok(None));
        crate::discard::harmless(std::fs::remove_dir_all(&dir)); // keep: cleanup of a scratch directory
    }

    #[test]
    fn a_fifo_session_record_does_not_block_the_reader_nonce_walk() {
        let home = scratch("nonce");
        let sess = home.join(defaults::text("mesh_write.claude_dir")).join(defaults::text("mesh_write.sessions_dir"));
        std::fs::create_dir_all(&sess).unwrap();
        let me = i64::from(std::process::id());
        fifo(&sess.join(format!("{me}{}", defaults::text("mesh_write.json_suffix"))));
        let h = home.clone();
        within("reader_nonce_from", move || ident::reader_nonce_from(&h, me));
        crate::discard::harmless(std::fs::remove_dir_all(&home)); // keep: cleanup of a scratch directory
    }

    /// A scratch inbox (one `_h` line per hash), a cursor file and a store holding one row per hash.
    fn fixture(tag: &str, hashes: &[&str], cursor: usize) -> (std::path::PathBuf, MeshReader, String, String) {
        let dir = std::env::temp_dir().join(format!("ah-union-twin-{}-{tag}", std::process::id()));
        crate::discard::harmless(std::fs::remove_dir_all(&dir)); // keep: cleanup that raced; an absent directory is the goal state
        std::fs::create_dir_all(&dir).unwrap();
        let inbox = dir.join("inbox.ndjson");
        let lines: String = hashes.iter().map(|h| format!("{{\"_h\":\"{h}\",\"message\":\"m\"}}\n")).collect();
        std::fs::write(&inbox, lines).unwrap();
        let cur = dir.join("inbox.cursor");
        std::fs::write(&cur, cursor.to_string()).unwrap();
        let db = dir.join("devswarm.db");
        let c = Connection::open(&db).unwrap();
        c.execute_batch("CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, ts INTEGER NOT NULL, hash TEXT, body TEXT, sender TEXT, recipient TEXT, mtype TEXT, urgency TEXT, is_heartbeat INTEGER, needs_reply INTEGER, orig_hash TEXT, instance_nonce TEXT, seq INTEGER, UNIQUE(hash));").unwrap();
        for (i, h) in hashes.iter().enumerate() {
            c.execute("INSERT INTO messages (workspace_id, ts, hash, body, seq) VALUES ('w', ?1, ?2, 'm', ?3)", params![i as i64, h, i as i64 + 1]).unwrap();
        }
        drop(c);
        let r = MeshReader::open(&db).unwrap();
        (dir, r, inbox.to_string_lossy().into_owned(), cur.to_string_lossy().into_owned())
    }

    fn run(r: &MeshReader, inbox: &str, cur: &str, store_base: f64, nd_base: f64) -> Union {
        union_unread(&UnionIn { inbox: Some(inbox), cursor_file: Some(cur), id: "w", store: Some(r), store_base, nd_base, now: 1 }).unwrap()
    }

    #[test]
    fn a_line_whose_store_twin_is_already_read_is_not_unread() {
        let (dir, r, inbox, cur) = fixture("read", &["native:a", "native:b"], 1);
        let u = run(&r, &inbox, &cur, 2.0, 1.0);
        assert_eq!((u.unread, u.nd_unread_lines.len(), u.nd_skipped), (0, 0, 1), "the phantom unread line is skipped");
        crate::discard::harmless(std::fs::remove_dir_all(dir)); // keep: test cleanup; an absent directory is the goal state
    }

    #[test]
    fn a_line_whose_store_twin_is_unread_stays_unread() {
        let (dir, r, inbox, cur) = fixture("unread", &["native:a", "native:b"], 1);
        let u = run(&r, &inbox, &cur, 1.0, 1.0);
        assert_eq!((u.unread, u.nd_unread_lines.len(), u.nd_skipped), (1, 1, 0));
        crate::discard::harmless(std::fs::remove_dir_all(dir)); // keep: test cleanup; an absent directory is the goal state
    }

    #[test]
    fn only_the_leading_read_run_is_skipped_and_the_tail_stays_contiguous() {
        let (dir, r, inbox, cur) = fixture("lead", &["native:a", "native:b", "native:c"], 0);
        let u = run(&r, &inbox, &cur, 2.0, 0.0);
        assert_eq!((u.nd_skipped, u.nd_unread_lines.len(), u.unread), (2, 1, 1));
        assert_eq!(u.nd_skipped + u.nd_unread_lines.len(), 3, "the ack target is the total");
        crate::discard::harmless(std::fs::remove_dir_all(dir)); // keep: test cleanup; an absent directory is the goal state
    }

    /// A store partition "w" holding one row per sender (`None` = NULL sender) and `#floor` rows at `floor`, plus extra reader rows
    /// `(reader, store position)`. No NDJSON inbox.
    fn senders_fixture(tag: &str, senders: &[Option<&str>], floor: i64, readers: &[(&str, i64, i64)]) -> (std::path::PathBuf, MeshReader) {
        let dir = std::env::temp_dir().join(format!("ah-union-for-{}-{tag}", std::process::id()));
        crate::discard::harmless(std::fs::remove_dir_all(&dir)); // keep: cleanup that raced; an absent directory is the goal state
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("devswarm.db");
        let c = Connection::open(&db).unwrap();
        c.execute_batch("CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, ts INTEGER NOT NULL, hash TEXT, body TEXT, sender TEXT, recipient TEXT, mtype TEXT, urgency TEXT, is_heartbeat INTEGER, needs_reply INTEGER, orig_hash TEXT, instance_nonce TEXT, seq INTEGER, UNIQUE(hash)); CREATE TABLE reader_cursors (partition TEXT NOT NULL, ns TEXT NOT NULL, reader TEXT NOT NULL, value INTEGER NOT NULL, retired_line INTEGER, updated_at INTEGER NOT NULL, PRIMARY KEY (partition, ns, reader));").unwrap();
        for (i, s) in senders.iter().enumerate() {
            c.execute(
                "INSERT INTO messages (workspace_id, ts, hash, body, sender, seq) VALUES ('w', ?1, ?2, 'm', ?3, ?4)",
                params![i as i64, format!("h{i}"), s, i as i64 + 1],
            )
            .unwrap();
        }
        let ns_store = defaults::text("mesh_write.cursor_ns_store");
        let ns_nd = defaults::text("mesh_write.cursor_ns_nd");
        let floor_reader = defaults::text("mesh_write.floor_reader");
        for ns in [ns_store, ns_nd] {
            c.execute("INSERT INTO reader_cursors VALUES ('w', ?1, ?2, ?3, NULL, 0)", params![ns, floor_reader, if ns == ns_store { floor } else { 0 }])
                .unwrap();
        }
        for (reader, pos, at) in readers {
            c.execute("INSERT INTO reader_cursors VALUES ('w', ?1, ?2, ?3, NULL, ?4)", params![ns_store, reader, pos, at]).unwrap();
        }
        drop(c);
        (dir, MeshReader::open(&db).unwrap())
    }

    #[test]
    fn the_unread_the_caller_has_read_is_zero_even_when_a_lagging_reader_holds_the_floor() {
        // #181: 3 messages, `#floor` 1 (reader B lags), reader A read all 3: A's unread is 0, the floor view still says 2
        let (dir, r) = senders_fixture("lag", &[None, None, None], 1, &[("h:1:1", 3, 10), ("h:2:2", 1, 5)]);
        let home = dir.clone();
        let none = HashSet::new();
        let a = unread_for(&r, &home, "w", None, None, Some("h:1:1"), &none, 1).unwrap();
        assert_eq!((a.store_base, a.unread), (3.0, 0), "A has read everything");
        let floor_view = unread_for(&r, &home, "w", None, None, None, &none, 1).unwrap();
        assert_eq!((floor_view.store_base, floor_view.unread), (1.0, 2), "no caller reader: the floor view");
        crate::discard::harmless(std::fs::remove_dir_all(dir)); // keep: test cleanup; an absent directory is the goal state
    }

    #[test]
    fn mail_the_recipients_own_family_sent_is_not_unread() {
        // #181: P's own send and a family alias's send are not inbound; another sender and a NULL sender are
        let (dir, r) = senders_fixture("own", &[Some("P"), Some("alias"), Some("other"), None], 0, &[]);
        let family: HashSet<String> = ["P", "alias"].iter().map(|s| s.to_string()).collect();
        let u = unread_for(&r, &dir, "w", None, None, None, &family, 1).unwrap();
        assert_eq!((u.unread, u.own_excluded, u.union.unread), (2, 2, 4), "other + NULL count; the union keeps every row");
        crate::discard::harmless(std::fs::remove_dir_all(dir)); // keep: test cleanup; an absent directory is the goal state
    }

    #[test]
    fn the_live_base_is_the_least_advanced_live_reader_and_a_retired_or_floor_row_is_none() {
        // #181: 3 messages, `#floor` 1, live readers at 3 and 1: the base is 1 (nothing a live reader has not read is hidden)
        let (dir, r) = senders_fixture("owner", &[None, None, None], 1, &[("h:1:1", 3, 10), ("h:2:2", 1, 5)]);
        let rows = r.reader_cursors("w").unwrap();
        assert_eq!(live_base_of(&rows).unwrap().store, Some(1.0));
        let floor_only: Vec<Value> = rows.iter().filter(|x| x["reader"] == "#floor").cloned().collect();
        assert_eq!(live_base_of(&floor_only), None, "no reader row: the floor is not a reader");
        let mut retired = rows.clone();
        for x in &mut retired {
            if x["reader"] == "h:2:2" {
                x["retiredLine"] = serde_json::json!(1);
            }
        }
        assert_eq!(live_base_of(&retired).unwrap().store, Some(3.0), "a retired row is not live");
        crate::discard::harmless(std::fs::remove_dir_all(dir)); // keep: test cleanup; an absent directory is the goal state
    }
}
