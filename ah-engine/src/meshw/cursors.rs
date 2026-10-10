//! The reader-cursor ack of `companion/lib/reader-cursors.js` (`ackFor`, `dualWrite`) and the cursor-write journal of
//! `scripts/devswarm-lib/cursors.js` (`logCursorWrite`), as `inbox ack-primary` uses them for the store namespace.
//!
//! Everything here is a cursor move that only ever raises a value (the SQL is `MAX(value, new)`, the legacy files are
//! raised only upward), so applying a move twice, late, or after a newer one is a no-op. The two things the engine does
//! not do itself are decided BEFORE a write by the caller: a partition without its floor rows (Node's one-time legacy
//! import) and nothing else; a foreign reader row that pins the floor is retired exactly as Node retires it, from one
//! `ps` snapshot (a pid absent from it and gone for `kill(pid, 0)`, or present with a later start time).
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` / `let _ =` in this file is a deliberate keep, for these reasons:
// - the legacy cursor projection and the journal are best-effort in Node (`try { ... } catch (_) {}`): a failure there
//   never changes the ack
// - a file that does not read or parse is the absent value (Node's readCursor / JSON.parse catch parity)
use crate::checks::guardkit::ojson::OVal;
use crate::defaults;
use crate::meshw::common::{self, Obj, n, s, s_or_null};
use crate::meshw::idlock::{devswarm_root, is_safe_id};
use crate::meshw::store::{CursorPut, CursorRow, MeshStore};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// What one `ackFor` returned (`{ ok, own, floor, from, retired }`, or `{ ok: false, error }`).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Acked {
    /// The transaction committed.
    pub ok: bool,
    /// The caller's own position (the floor's new value for a headless caller).
    pub own: Option<i64>,
    /// The floor after the move.
    pub floor: Option<i64>,
    /// The floor before it.
    pub from: Option<i64>,
    /// Readers retired by this move (`<ns>:<reader>`).
    pub retired: Vec<String>,
    /// Why it failed.
    pub error: Option<String>,
}

/// One `ps` snapshot: pid -> start time in ms (`None` when `ps` printed a time that does not parse).
pub type ProcTable = HashMap<i64, Option<f64>>;

/// The process snapshot of this call, taken at most once (`defaultProcTable`'s 30 s memo covers a whole CLI call).
#[derive(Default)]
pub struct Procs {
    taken: bool,
    table: Option<ProcTable>,
}

impl Procs {
    /// The snapshot, or `None` when `ps` is unavailable (nothing can then be proven).
    pub fn get(&mut self) -> Option<&ProcTable> {
        if !self.taken {
            self.taken = true;
            self.table = snapshot();
        }
        self.table.as_ref()
    }
}

/// `psSnapshot()`: one `ps -A -o pid=,lstart=` with a time limit; `None` on any failure or an empty table.
fn snapshot() -> Option<ProcTable> {
    use std::io::Read;
    let mut child = std::process::Command::new(defaults::text("mesh_write.ps_bin"))
        .args(defaults::list("mesh_write.ps_snapshot_args"))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    let mut out = child.stdout.take()?;
    // the table is larger than a pipe buffer: read while waiting
    let reader = std::thread::spawn(move || {
        let mut b = Vec::new();
        crate::discard::harmless(out.read_to_end(&mut b)); // keep: a short read ends in an unusable table below
        b
    });
    let deadline = std::time::Instant::now() + defaults::millis("mesh_write.ps_snapshot_timeout_ms");
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st,
            Ok(None) if std::time::Instant::now() < deadline => std::thread::sleep(defaults::millis("mesh_write.ps_poll_ms")),
            _ => {
                crate::discard::harmless(child.kill()); // keep: the process may already be gone
                crate::discard::harmless(child.wait()); // keep: reaping; the result is not used
                return None;
            }
        }
    };
    let bytes = reader.join().ok()?;
    if !status.success() {
        return None;
    }
    let mut m = ProcTable::new();
    for line in String::from_utf8_lossy(&bytes).lines() {
        let t = line.trim();
        let Some(i) = t.find(' ') else { continue };
        if i == 0 {
            continue;
        }
        let pid = &t[..i];
        if !pid.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        let Ok(pid) = pid.parse::<i64>() else { continue };
        m.insert(pid, crate::meshw::ident::parse_lstart(&t[i + 1..]));
    }
    (!m.is_empty()).then_some(m)
}

/// `readerKey(nonce)`: `h:<pid>:<startMs>` (digits only) or `None` (headless).
pub fn reader_key(nonce: Option<&str>) -> Option<String> {
    let nz = nonce?;
    let rest = nz.strip_prefix(defaults::text("mesh_write.nonce_prefix"))?;
    let (pid, start) = rest.split_once(':')?;
    let digits = |x: &str| !x.is_empty() && x.bytes().all(|b| b.is_ascii_digit());
    (digits(pid) && digits(start)).then(|| nz.to_string())
}

/// `parseReader(reader)`: `(pid, startMs)`.
fn parse_reader(reader: &str) -> Option<(i64, f64)> {
    let rest = reader.strip_prefix(defaults::text("mesh_write.nonce_prefix"))?;
    let (pid, start) = rest.split_once(':')?;
    Some((pid.parse().ok()?, start.parse().ok()?))
}

/// `provablyEnded(reader, procTable)`: true only on proof (see the module header); everything uncertain is live.
fn provably_ended(reader: &str, table: &ProcTable) -> bool {
    let Some((pid, start_ms)) = parse_reader(reader) else { return false };
    match table.get(&pid) {
        None => {
            if pid <= 0 || pid > i64::from(i32::MAX) {
                return false;
            }
            // SAFETY: signal 0 only probes for the process.
            let rc = unsafe { libc::kill(pid as i32, 0) };
            rc != 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
        }
        Some(started) => {
            let Some(started) = started.filter(|x| x.is_finite()) else { return false };
            if start_ms < defaults::num("mesh_write.min_plausible_start_ms") as f64 {
                return false;
            }
            started > start_ms + defaults::num("mesh_write.pid_reuse_margin_ms") as f64
        }
    }
}

pub(crate) fn is_retired(r: &CursorRow) -> bool {
    r.retired_line.is_some_and(|l| r.value <= l)
}

/// `liveMinRow(rows, ns)`: the declared, non-retired row with the lowest value (the first on a tie).
fn live_min<'a>(rows: &'a [CursorRow], ns: &str) -> Option<&'a CursorRow> {
    let mut best: Option<&CursorRow> = None;
    for r in rows {
        if r.ns != ns || r.reader == defaults::text("mesh_write.floor_reader") || is_retired(r) {
            continue;
        }
        if best.is_none_or(|b| r.value < b.value) {
            best = Some(r);
        }
    }
    best
}

fn row_of<'a>(rows: &'a [CursorRow], ns: &str, reader: &str) -> Option<&'a CursorRow> {
    rows.iter().find(|r| r.ns == ns && r.reader == reader)
}

/// `needsImport(rows)`: a namespace has no floor row yet, so Node would first import the legacy cursor files.
pub fn needs_import(rows: &[CursorRow]) -> bool {
    defaults::list("mesh_write.cursor_namespaces").iter().any(|ns| row_of(rows, ns, defaults::text("mesh_write.floor_reader")).is_none())
}

/// `Math.max(0, Math.floor(Number(x) || 0))`.
fn clamp_target(x: f64) -> i64 {
    if !x.is_finite() || x < 0.0 {
        return 0;
    }
    x.floor() as i64
}

/// `ackFor(store, { partition, ns, reader, target })` for a namespace whose floor rows exist: one transaction that
/// raises the caller's own row (declared readers only), retires foreign readers that are provably gone and pin the
/// floor, and recomputes the floor as `max(F, MIN(live declared))` (a headless caller moves it to its target when no
/// live declared reader exists); then the legacy projection ([`dual_write`]).
pub fn ack_for(st: &MeshStore, home: &Path, partition: &str, ns: &str, reader: Option<&str>, target: f64, procs: &mut Procs) -> Acked {
    let now = common::now_ms();
    let target = clamp_target(target);
    let floor_name = defaults::text("mesh_write.floor_reader");
    // retirement evidence is gathered OUTSIDE the transaction, and only when a FOREIGN declared row older than
    // retire_pin_age_ms pins the MIN below this ack's target; a failed read here is "no evidence"
    let mut table: Option<ProcTable> = None;
    let mut observed: HashMap<(String, String), i64> = HashMap::new();
    if let Ok(pre) = read_rows(st, partition) {
        let foreign: Vec<CursorRow> = pre.iter().filter(|r| Some(r.reader.as_str()) != reader).cloned().collect();
        if let Some(pin) = live_min(&foreign, ns)
            && pin.value < target
            && now - pin.updated_at > defaults::num("mesh_write.retire_pin_age_ms") as i64
        {
            table = procs.get().cloned();
            observed = pre.iter().filter(|r| r.reader != floor_name).map(|r| ((r.ns.clone(), r.reader.clone()), r.value)).collect();
        }
    }
    let res = st.cursor_txn(|tx| {
        let mut rows = tx.rows(partition)?;
        if needs_import(&rows) {
            return Ok(None);
        }
        let f = row_of(&rows, ns, floor_name).map_or(0, |r| r.value);
        let mut own = None;
        if let Some(rd) = reader {
            let cur = row_of(&rows, ns, rd).map_or(f, |r| r.value);
            let v = cur.max(target);
            tx.put(&CursorPut { partition: partition.into(), ns: ns.into(), reader: rd.into(), value: v, retired_line: Some(None), updated_at: now })?;
            own = Some(v);
            rows = tx.rows(partition)?;
        }
        let mut retired = Vec::new();
        if let Some(t) = &table {
            for r in &rows {
                if r.reader == floor_name || Some(r.reader.as_str()) == reader || is_retired(r) {
                    continue;
                }
                // CAS: advanced meanwhile -> not retired
                if observed.get(&(r.ns.clone(), r.reader.clone())) != Some(&r.value) {
                    continue;
                }
                if !provably_ended(&r.reader, t) {
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
                retired.push(format!("{}:{}", r.ns, r.reader));
            }
            rows = tx.rows(partition)?;
        }
        let next = f.max(live_min(&rows, ns).map_or(if reader.is_some() { f } else { target }, |p| p.value));
        tx.put(&CursorPut { partition: partition.into(), ns: ns.into(), reader: floor_name.into(), value: next, retired_line: None, updated_at: now })?;
        Ok(Some(Acked {
            ok: true,
            own: Some(if reader.is_some() { own.unwrap_or(next) } else { next }),
            floor: Some(next),
            from: Some(f),
            retired,
            error: None,
        }))
    });
    match res {
        Ok(Some(a)) => {
            if let Some(fl) = a.floor {
                dual_write(st, home, partition, ns, fl);
            }
            a
        }
        Ok(None) => Acked { error: Some(defaults::text("mesh_write.err_cursor_import_needed").into()), ..Acked::default() },
        Err(e) => Acked { error: Some(e.to_string()), ..Acked::default() },
    }
}

fn read_rows(st: &MeshStore, partition: &str) -> Result<Vec<CursorRow>, String> {
    rows_from_reader(st.reader(), partition)
}

/// The rows of a partition through a read-only handle.
pub fn rows_from_reader(rd: &crate::mesh::MeshReader, partition: &str) -> Result<Vec<CursorRow>, String> {
    let v = rd.reader_cursors(partition).map_err(|e| e.to_string())?;
    Ok(v.iter()
        .map(|r| CursorRow {
            ns: r["ns"].as_str().unwrap_or("").to_string(),
            reader: r["reader"].as_str().unwrap_or("").to_string(),
            value: r["value"].as_f64().unwrap_or(0.0) as i64,
            retired_line: r["retiredLine"].as_f64().map(|x| x as i64),
            updated_at: r["updatedAt"].as_f64().unwrap_or(0.0) as i64,
        })
        .collect())
}

/// The rows of a partition as `readerCursorRows` reports them, for a caller deciding BEFORE its first write.
pub fn rows_of(st: &MeshStore, partition: &str) -> Result<Vec<CursorRow>, String> {
    read_rows(st, partition)
}

/// `legacySafeId(id)`: safe, and not one of the names the legacy cursor files reserve.
pub(crate) fn legacy_safe(id: &str) -> bool {
    is_safe_id(id) && !defaults::list("mesh_write.legacy_cursor_forbidden").iter().any(|x| id.contains(x))
}

/// `cursors/<id>.json` (`primaryCursorPath`).
pub fn primary_cursor_path(home: &Path, id: &str) -> PathBuf {
    devswarm_root(home).join(defaults::text("mesh_write.dir_cursors")).join(format!("{id}{}", defaults::text("mesh_write.json_suffix")))
}

/// `devswarm-inbox-cursor.js` `readCursor(path)`: a bare integer or `{line: n}`; anything else is 0.
pub fn read_cursor(p: &Path) -> f64 {
    let Ok(bytes) = std::fs::read(p) else { return 0.0 };
    let raw = String::from_utf8_lossy(&bytes);
    let raw = raw.trim();
    let c = if !raw.is_empty() && raw.bytes().all(|b| b.is_ascii_digit()) {
        raw.parse::<f64>().unwrap_or(f64::NAN)
    } else {
        match OVal::parse(raw).as_ref().and_then(|v| v.get("line")) {
            Some(OVal::Num(x)) => *x,
            Some(OVal::Str(t)) => crate::checks::guardkit::text::js_number_of_str(t),
            Some(OVal::Null) => 0.0,
            Some(OVal::Bool(b)) => f64::from(u8::from(*b)),
            _ => f64::NAN,
        }
    };
    if c.is_finite() && c >= 0.0 { c.floor() } else { 0.0 }
}

/// `ackTo(path, n)` without an inbox clamp: raise the cursor file to `n` (never lower it) with a staged write.
pub(crate) fn ack_to(p: &Path, target: f64) -> std::io::Result<()> {
    let target = if target.is_finite() && target >= 0.0 { target.floor() } else { 0.0 };
    let t = target.max(read_cursor(p));
    if let Some(d) = p.parent() {
        std::fs::create_dir_all(d)?;
    }
    let mut tmp = p.as_os_str().to_os_string();
    tmp.push(defaults::text("mesh_write.tmp_suffix"));
    let tmp = PathBuf::from(tmp);
    std::fs::write(&tmp, crate::checks::jsport::num::to_js_string(t))?;
    std::fs::rename(&tmp, p)
}

/// `dualWrite` for the store namespace: one release of legacy projection after the commit, best effort and upward only
/// (the shared cursor file, then the `cursors` table).
fn dual_write(st: &MeshStore, home: &Path, partition: &str, ns: &str, floor: i64) {
    if floor <= 0 || ns != defaults::text("mesh_write.ns_store") {
        return;
    }
    if legacy_safe(partition) {
        let p = primary_cursor_path(home, partition);
        if read_cursor(&p) < floor as f64 {
            crate::discard::harmless(ack_to(&p, floor as f64)); // keep: the projection is best-effort in Node
        }
    }
    let cur = st.reader().cursor(partition).unwrap_or(0) as i64;
    if cur < floor {
        crate::discard::harmless(st.set_cursor(partition, floor, common::now_ms())); // keep: as above
    }
}

/// One journal record (`logCursorWrite`'s argument), only the fields the ack writes.
pub struct LogRec<'a> {
    /// The partition.
    pub id: &'a str,
    /// Who asked.
    pub caller_id: &'a str,
    /// The journal namespace.
    pub ns: &'a str,
    /// The floor before.
    pub from: Option<i64>,
    /// The position after (a failed move records the requested target).
    pub to: Option<f64>,
    /// Messages delivered by the read this ack confirms.
    pub delivered: Option<f64>,
    /// The short hash of the reader.
    pub nonce: Option<String>,
    /// Which door moved it.
    pub gate: &'a str,
    /// The verb.
    pub verb: &'a str,
    /// The caller's `ctx.cwd` (absent for the CLI).
    pub cwd: Option<&'a str>,
    /// Whether the move committed.
    pub ok: bool,
    /// The failure text.
    pub err: Option<&'a str>,
    /// The project key naming the journal file.
    pub repo_key: Option<&'a str>,
}

/// `shortInstanceNonce(nonce)`: the first 6 hex characters of its SHA-1.
pub fn short_nonce(nonce: &str) -> String {
    let d = ring::digest::digest(&ring::digest::SHA1_FOR_LEGACY_USE_ONLY, nonce.as_bytes());
    let h = crate::meshw::store::hex(d.as_ref());
    h[..(defaults::num("mesh_write.short_nonce_len") as usize).min(h.len())].to_string()
}

/// `cursorLogPath(home, repoKey)`.
pub(crate) fn log_path(home: &Path, repo_key: Option<&str>) -> PathBuf {
    let key = match repo_key {
        Some(k) if !k.is_empty() && k.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-')) => k,
        _ => defaults::text("mesh_write.cursor_log_unknown_key"),
    };
    devswarm_root(home).join(defaults::text("mesh_write.dir_cursor_log")).join(format!("{key}{}", defaults::text("mesh_write.ndjson_suffix")))
}

/// `logCursorWrite(home, rec)`: one JSON line, then tail-preserving rotation at `mesh_write.cursor_log_cap`. Never fails
/// the ack: a journal that cannot be written is only a missing line.
pub fn log_cursor_write(home: &Path, r: &LogRec<'_>) {
    let num_or_null = |v: Option<f64>| v.filter(|x| x.is_finite()).map_or(OVal::Null, n);
    let mut o = Obj::default();
    o.put("ts", n(common::now_ms() as f64))
        .put("id", s(r.id))
        .put("partition", s(r.id))
        .put("callerId", s(r.caller_id))
        .put("ns", s(r.ns))
        .put("from", num_or_null(r.from.map(|x| x as f64)))
        .put("to", num_or_null(r.to))
        .put("delivered", r.delivered.filter(|d| d.is_finite()).map_or(OVal::Null, n))
        .put("pid", n(f64::from(std::process::id())))
        .put("nonce", s_or_null(r.nonce.as_deref()))
        .put("gate", s(r.gate))
        .put("verb", s(r.verb))
        .put("cwd", s_or_null(r.cwd))
        .put("ok", OVal::Bool(r.ok));
    if let Some(e) = r.err {
        o.put("err", s(e));
    }
    let line = o.done().stringify();
    let p = log_path(home, r.repo_key);
    let write = || -> std::io::Result<()> {
        if let Some(d) = p.parent() {
            std::fs::create_dir_all(d)?;
        }
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&p)?;
        f.write_all(format!("{line}\n").as_bytes())?;
        let text = std::fs::read_to_string(&p).unwrap_or_default();
        let lines: Vec<&str> = text.split('\n').filter(|l| !l.trim().is_empty()).collect();
        let cap = defaults::num("mesh_write.cursor_log_cap") as usize;
        if lines.len() > cap {
            let cut = lines.len() - cap;
            let mut old = p.as_os_str().to_os_string();
            old.push(defaults::text("mesh_write.cursor_log_old_suffix"));
            crate::discard::harmless(std::fs::write(PathBuf::from(old), format!("{}\n", lines[..cut].join("\n")))); // keep: Node's inner try/catch
            std::fs::write(&p, format!("{}\n", lines[cut..].join("\n")))?;
        }
        Ok(())
    };
    crate::discard::harmless(write()); // keep: instrumentation never breaks an ack (Node returns false)
}
