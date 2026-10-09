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
use crate::mesh::MeshReader;
use crate::meshw::ident::{self, Defer, R, defer};
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
pub fn non_empty_lines(path: &str) -> Option<Vec<String>> {
    let bytes = std::fs::read(path).ok()?;
    Some(lines_of(&String::from_utf8_lossy(&bytes)))
}

fn lines_of(text: &str) -> Vec<String> {
    text.split('\n').filter(|l| !js_trim(l).is_empty()).map(str::to_string).collect()
}

/// Why an NDJSON cursor file does not give a position (`unreadBacklog`'s `known: false`).
pub fn cursor_position(path: &str) -> R<Option<f64>> {
    let Ok(bytes) = std::fs::read(path) else { return Ok(None) };
    let text = String::from_utf8_lossy(&bytes).into_owned();
    let raw = js_trim(&text);
    let c = if !raw.is_empty() && raw.bytes().all(|b| b.is_ascii_digit()) {
        if raw.len() > defaults::num("mesh_write.cursor_max_digits") as usize {
            // parseInt of a long digit string is only approximated by the specification
            return defer("cursor-long-digits");
        }
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
                Some(_) => return defer("cursor-line-shape"),
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
        Some(OVal::Num(n)) => Ok(Some(crate::checks::guardkit::ojson::js_number_text(*n))),
        Some(OVal::Bool(b)) => Ok(Some(b.to_string())),
        Some(_) => defer("ndjson-hash-shape"),
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
    let all = i.inbox.and_then(non_empty_lines);
    let position = match (&all, i.cursor_file) {
        (Some(_), Some(c)) => cursor_position(c)?,
        _ => None,
    };
    let known = all.is_some() && position.is_some();
    let all_lines = all.clone().unwrap_or_default();
    let total = all_lines.len();
    // the NDJSON read position is the reader_cursors base, not the cursor file (which only says "known")
    let nd_lines: Vec<String> = if known { all_lines.iter().skip(floor_index(i.nd_base)).cloned().collect() } else { Vec::new() };
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
            .map_err(|e| Defer(format!("store-read:{e}")))?;
        let mut unread_rows: Vec<Value> = Vec::new();
        reader
            .for_each_message(i.id, floor_index(i.store_base) as u64, |m| {
                unread_rows.push(m);
                true
            })
            .map_err(|e| Defer(format!("store-read:{e}")))?;
        let uncovered: Vec<Value> = unread_rows.into_iter().filter(|r| truthy_hash(r).is_none_or(|h| !unread_hashes.contains(h))).collect();
        let by_body = body_covered(&uncovered, &nd_lines, &store_hashes, i.id, unread_start)?;
        store_only = uncovered.into_iter().enumerate().filter(|(n, _)| !by_body.contains(n)).map(|(_, r)| r).collect();
    }
    let mut oldest: Option<f64> = None;
    for ts in nd_lines.iter().filter_map(|l| line_ts(l)).chain(store_only.iter().filter_map(|r| r["ts"].as_f64().filter(|t| t.is_finite()))) {
        oldest = Some(oldest.map_or(ts, |o| o.min(ts)));
    }
    let age = oldest.map(|o| i.now as f64 - o).filter(|a| *a >= 0.0);
    Ok(Union { unread: nd_lines.len() + store_only.len(), nd_unread_lines: nd_lines, store_only_unread: store_only, oldest_unread_age_ms: age })
}

/// `unionUnread`'s merged `total` over the whole history: the NDJSON lines plus the store rows no line covers (by hash,
/// else by body). Only a read that reports `total` needs it.
pub fn merged_total(i: &UnionIn<'_>) -> R<usize> {
    let all = i.inbox.and_then(non_empty_lines).unwrap_or_default();
    let Some(reader) = i.store else { return Ok(all.len()) };
    let hashes = line_hashes(&all, i.id, 0)?;
    let mut rows: Vec<Value> = Vec::new();
    reader
        .for_each_message(i.id, 0, |m| {
            rows.push(m);
            true
        })
        .map_err(|e| Defer(format!("store-read:{e}")))?;
    let store_hashes: HashSet<String> = rows.iter().filter_map(|m| m["hash"].as_str().map(str::to_string)).collect();
    let uncovered: Vec<Value> = rows.into_iter().filter(|r| truthy_hash(r).is_none_or(|h| !hashes.contains(h))).collect();
    let by_body = body_covered(&uncovered, &all, &store_hashes, i.id, 0)?;
    Ok(all.len() + uncovered.len() - by_body.len())
}

/// The floor view of `positions(store, { reader: null, partition, cursorPath })`: `(store base, nd base)`. A partition
/// without both floor rows would be imported from the legacy cursor files by Node first: that defers.
pub fn floor_bases(reader: &MeshReader, home: &Path, partition: &str, cursor_path: Option<&str>) -> R<(f64, f64)> {
    let rows = reader.reader_cursors(partition).map_err(|e| Defer(format!("cursor-rows:{e}")))?;
    let floor_of = |ns: &str| -> Option<f64> {
        rows.iter().find(|r| r["ns"] == ns && r["reader"] == defaults::text("mesh_write.floor_reader")).and_then(|r| r["value"].as_f64())
    };
    let (Some(store), Some(nd)) = (floor_of(defaults::text("mesh_write.cursor_ns_store")), floor_of(defaults::text("mesh_write.cursor_ns_nd"))) else {
        return defer("cursor-import");
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

/// Where a partition's reads go: its repo key's store directory.
pub fn store_dir(home: &Path, repo_key: &str) -> std::path::PathBuf {
    devswarm_root(home).join(defaults::text("mesh_write.dir_store")).join(repo_key)
}

/// A string that is a JavaScript-truthy path: `Some(non-empty)`, `None` for absent/null/empty/false/0; a value of another
/// type (which JavaScript would stringify or reject in its own way) defers.
pub fn path_field(d: &OVal, key: &str) -> R<Option<String>> {
    match d.get(key) {
        None | Some(OVal::Null | OVal::Bool(false)) => Ok(None),
        Some(OVal::Str(s)) => Ok((!s.is_empty()).then(|| s.clone())),
        Some(OVal::Num(n)) if *n == 0.0 || n.is_nan() => Ok(None),
        Some(_) => defer("descriptor-field-type"),
    }
}
