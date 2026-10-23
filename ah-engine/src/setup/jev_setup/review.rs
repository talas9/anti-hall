//! `jev-setup review-due`, `reviewed` and `snooze`: the durable "time to review the Jev shadow numbers" tracking. Port of
//! `hooks/lib/jev-review.js` as `scripts/jev-setup.js` drives it. State: `~/.anti-hall/jev-review-state.json`, one entry per
//! integration (`shadowSince`, `lastReviewedAt`, `snoozedUntil`, `dueSince`); metrics: `~/.anti-hall/logs/jev-review.ndjson`.
//! A review is due for a shadow integration when it has been in shadow for `jev.reviewAfterDays`, has logged at least
//! `jev.reviewMinDecisions` decisions, is not snoozed and was not reviewed within the last `jev.reviewAfterDays`. Every number,
//! name and text is in `operator_cli.toml`.
use super::{Ctx, SetupError, base_dir, jev_json_path, key, parse_json, read_object, resolve_settings, write_json_atomic_if_changed};
use crate::checks::jsport::date::{self, Parsed};
use crate::checks::jsport::json::{J, stringify};
use crate::checks::jsport::num::to_js_string;
use crate::defaults;
use crate::jev::settings::{JevSettings, Sources};
use crate::setup::jsfmt::keys;
use crate::setup::{out, read_capped, text_of, warn};
use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

type Obj = Vec<(String, J)>;

fn k(name: &str) -> &'static str {
    defaults::raw("opcli.review_keys").str_field(name)
}

fn num_of(key_name: &str) -> f64 {
    defaults::num(key_name) as f64
}

/// JavaScript truthiness of an optional JSON value.
fn truthy(v: Option<&J>) -> bool {
    match v {
        Some(J::Str(s)) => !s.is_empty(),
        Some(J::Num(n)) => *n != 0.0 && !n.is_nan(),
        Some(J::Bool(b)) => *b,
        Some(J::Arr(_) | J::Obj(_)) => true,
        Some(J::Null) | None => false,
    }
}

fn iso(ms: f64) -> String {
    crate::jev::assist::iso_ms(ms.max(0.0) as u64)
}

/// `Date.parse` of a stored text when it is a date this tool reads, else `None` (a text whose JavaScript answer is not
/// reproduced counts as no date, like `NaN`).
fn date_ms(s: &str) -> Option<f64> {
    match date::parse(s) {
        Parsed::Ms(ms) if ms.is_finite() => Some(ms),
        _ => None,
    }
}

fn set(o: &mut Obj, name: &str, v: J) {
    match o.iter_mut().find(|(n, _)| n == name) {
        Some(slot) => slot.1 = v,
        None => o.push((name.to_string(), v)),
    }
}

fn str_of<'a>(o: &'a Obj, name: &str) -> Option<&'a str> {
    match o.iter().find(|(n, _)| n == name) {
        Some((_, J::Str(s))) => Some(s),
        _ => None,
    }
}

// ---- state ---------------------------------------------------------------------------------------------------------------

struct State {
    path: PathBuf,
    /// The whole state object (members this tool does not know are kept, in order).
    top: Obj,
    /// An `integrations` member that is an array: JavaScript keeps it as it is (named properties set on an array are not
    /// serialized), so the work goes on in an object and the array is written back unchanged.
    array_integrations: Option<J>,
}

impl State {
    fn read(home: &Path) -> State {
        let path = base_dir(home).join(defaults::text("opcli.review_state_file"));
        let parsed = match read_capped(&path) {
            Ok(Some(b)) => parse_json(&text_of(b)).ok(),
            _ => None,
        };
        let mut top = match parsed {
            Some(J::Obj(o)) => o,
            _ => Vec::new(),
        };
        let mut array_integrations = None;
        match top.iter().find(|(n, _)| n == k("integrations")) {
            Some((_, J::Obj(_))) => {}
            Some((_, a @ J::Arr(_))) => {
                array_integrations = Some(a.clone());
                set(&mut top, k("integrations"), J::Obj(Vec::new()));
            }
            _ => set(&mut top, k("integrations"), J::Obj(Vec::new())),
        }
        State { path, top, array_integrations }
    }

    fn integrations(&mut self) -> Result<&mut Obj, String> {
        let idx = match self.top.iter().position(|(n, _)| n == k("integrations")) {
            Some(idx) => idx,
            None => {
                self.top.push((k("integrations").to_string(), J::Obj(Vec::new())));
                self.top.len() - 1
            }
        };
        let Some((_, value)) = self.top.get_mut(idx) else {
            return Err(defaults::render("opcli.review_state_bad", &[("id", &k("integrations"))]));
        };
        if !matches!(value, J::Obj(_)) {
            *value = J::Obj(Vec::new());
        }
        match value {
            J::Obj(o) => Ok(o),
            _ => Err(defaults::render("opcli.review_state_bad", &[("id", &k("integrations"))])),
        }
    }

    /// The entry of `id`, created empty when absent; an entry that is not an object cannot be updated.
    fn entry(&mut self, id: &str) -> Result<&mut Obj, String> {
        let ints = self.integrations()?;
        // `state.integrations[id] || (state.integrations[id] = {})`: an absent or falsy entry is replaced by an empty one
        match ints.iter().position(|(n, _)| n == id) {
            None => ints.push((id.to_string(), J::Obj(Vec::new()))),
            Some(i) if ints.get(i).is_some_and(|e| !truthy(Some(&e.1))) => {
                if let Some(e) = ints.get_mut(i) {
                    e.1 = J::Obj(Vec::new());
                }
            }
            Some(_) => {}
        }
        match ints.iter_mut().find(|(n, _)| n == id) {
            Some((_, J::Obj(o))) => Ok(o),
            _ => Err(defaults::render("opcli.review_state_bad", &[("id", &id)])),
        }
    }

    /// Best effort, as in Node: a failure is said on stderr and the verb goes on. A state that serialises to the bytes already on
    /// disk is not written again: the SessionStart check calls this on every start, and an atomic write is a full disk sync
    /// (the write was the whole cost of that check, measured 2026-10-22: ~5 ms of a ~5 ms p95), for a file that would not change.
    fn write(&self) {
        let result = (|| -> Result<(), SetupError> {
            if let Some(dir) = self.path.parent() {
                std::fs::create_dir_all(dir).map_err(crate::setup::io_err(defaults::text("setup.what_create_dir").to_string()))?;
            }
            let mut top = self.top.clone();
            if let Some(a) = &self.array_integrations {
                set(&mut top, k("integrations"), a.clone());
            }
            write_json_atomic_if_changed(&self.path, J::Obj(top))
        })();
        if let Err(e) = result {
            warn(&defaults::render("opcli.review_write_failed", &[("error", &e)]));
        }
    }
}

fn append_metric(home: &Path, row: Obj) {
    let path = base_dir(home).join(defaults::text("opcli.review_metrics_file"));
    let mut o: Obj = vec![(k("ts").to_string(), J::Str(iso(date::now_ms())))];
    o.extend(row);
    let line = stringify(&J::Obj(o)) + "\n";
    let done = path
        .parent()
        .map_or(Ok(()), std::fs::create_dir_all)
        .and_then(|()| std::fs::OpenOptions::new().create(true).append(true).open(&path))
        .and_then(|mut f| f.write_all(line.as_bytes()));
    if let Err(e) = done {
        warn(&defaults::render("opcli.review_write_failed", &[("error", &e)]));
    }
}

// ---- decisions -------------------------------------------------------------------------------------------------------------

/// Per integration id: the decision rows logged for it and the earliest `ts` among them (milliseconds; infinite when none parses).
type RowStats = HashMap<String, (f64, f64)>;

/// The scan's registered memory holder (`jev_review_scan`, limits `mem.jev_review_scan_*`), one instance per running scan.
fn scan_budget() -> &'static crate::mem::Budget {
    static BUDGET: OnceLock<crate::mem::Budget> = OnceLock::new();
    BUDGET.get_or_init(|| {
        crate::mem::global().register_instances(crate::mem::Spec::new(
            "jev_review_scan",
            "mem.jev_review_scan_soft_bytes",
            "mem.jev_review_scan_hard_bytes",
            "mem.jev_review_scan_low_water_pct",
        ))
    })
}

enum Line {
    Read,
    End,
    TooLong,
}

/// One line (through its `\n`) of `r` into `buf`, stopping before `buf` would pass `cap` bytes (0 = no cap).
fn read_line_capped(r: &mut impl BufRead, buf: &mut Vec<u8>, cap: usize) -> std::io::Result<Line> {
    loop {
        let chunk = match r.fill_buf() {
            Ok(c) => c,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        };
        if chunk.is_empty() {
            return Ok(if buf.is_empty() { Line::End } else { Line::Read });
        }
        let (take, done) = chunk.iter().position(|&b| b == b'\n').map_or((chunk.len(), false), |i| (i + 1, true));
        if cap > 0 && buf.len() + take > cap {
            return Ok(Line::TooLong);
        }
        buf.extend_from_slice(&chunk[..take]);
        r.consume(take);
        if done {
            return Ok(Line::Read);
        }
    }
}

/// What the scan keeps of one log file between calls: the totals of its complete lines up to `parsed`, with a fingerprint of the
/// bytes at both ends of that range so a file that was rewritten (not appended to) is read afresh. A rotation renames a file and
/// keeps its inode, so the kept totals are found under (device, inode), not the name.
#[derive(Clone)]
struct FileStats {
    parsed: u64,
    head: u64,
    back: u64,
    stats: RowStats,
}

fn stats_cache() -> &'static crate::mem::BoundedCache<(u64, u64), FileStats> {
    static CACHE: OnceLock<crate::mem::BoundedCache<(u64, u64), FileStats>> = OnceLock::new();
    CACHE.get_or_init(|| {
        crate::mem::BoundedCache::new(
            crate::mem::global(),
            crate::mem::Spec::new("jev_review_stats", "mem.jev_review_stats_soft_bytes", "mem.jev_review_stats_hard_bytes", "mem.jev_review_stats_low_water_pct")
                .with_entries("opcli.review_stats_max_files"),
        )
    })
}

/// A digest of `len` bytes of `f` at `at` (`None` when they cannot be read).
fn digest_at(f: &std::fs::File, at: u64, len: u64) -> Option<u64> {
    use std::hash::Hasher;
    use std::os::unix::fs::FileExt;
    let mut b = vec![0u8; len as usize];
    f.read_exact_at(&mut b, at).ok()?;
    let mut h = std::collections::hash_map::DefaultHasher::new();
    h.write(&b);
    Some(h.finish())
}

/// Fold one log line into the per-id totals (a line that counts for nothing changes none).
fn fold_line(buf: &[u8], stats: &mut RowStats, held: &mut usize) {
    let text = String::from_utf8_lossy(buf);
    let t = crate::jev::js_trim(&text);
    if t.is_empty() {
        return;
    }
    let Ok(row @ J::Obj(_)) = parse_json(t) else { return };
    if !truthy(row.get(k("id"))) || truthy(row.get(k("type"))) {
        return;
    }
    // `idStats` matches rows by a text id only; a row with another truthy id counts for no integration
    let Some(J::Str(id)) = row.get(k("id")) else { return };
    let ts = match row.get(k("ts")) {
        Some(J::Str(ts)) => date_ms(ts),
        _ => None,
    };
    let slot = stats.entry(id.clone()).or_insert_with(|| {
        *held += id.len() + std::mem::size_of::<(String, (f64, f64))>();
        (0.0, f64::INFINITY)
    });
    slot.0 += 1.0;
    if let Some(t) = ts {
        slot.1 = slot.1.min(t);
    }
}

/// The totals of the lines of `file` from byte `from` to `len`, added to `stats`: the complete lines are folded into `stats` (and
/// the returned offset is after the last of them), a last line with no newline yet is returned as its own totals.
fn fold_file(mut f: std::fs::File, (from, len): (u64, u64), stats: &mut RowStats, inst: &mut crate::mem::Instance, cap: usize) -> Result<(u64, RowStats), ()> {
    use std::io::{Read, Seek, SeekFrom};
    if f.seek(SeekFrom::Start(from)).is_err() {
        return Ok((from, RowStats::new()));
    }
    let mut r = std::io::BufReader::new(f.take(len.saturating_sub(from)));
    let (mut held, mut off, mut buf) = (0usize, from, Vec::new());
    let mut partial = RowStats::new();
    loop {
        buf.clear();
        match read_line_capped(&mut r, &mut buf, cap) {
            Ok(Line::Read) => {}
            Ok(Line::End) | Err(_) => break,
            Ok(Line::TooLong) => return Err(()),
        }
        if matches!(inst.report(buf.capacity() + held), crate::mem::Action::Recycle) {
            return Err(());
        }
        if buf.last() == Some(&b'\n') {
            off += buf.len() as u64;
            fold_line(&buf, stats, &mut held);
        } else {
            fold_line(&buf, &mut partial, &mut held);
        }
    }
    Ok((off, partial))
}

/// The decision rows of the log's retained generations (objects with an id and no type), folded per id while the files are
/// streamed: only one line and the per-id totals are held, never the log. Holding every parsed row cost about 56 MB of heap on
/// each SessionStart for a 12 MB log (#104). The bytes held are reported to the `jev_review_scan` holder; a scan that would
/// pass its hard limit (a line longer than that) stops, and the review state counts as unusable (`Err`).
///
/// The log is append-only and the SessionStart check asks at every session start, so the totals of each file's complete lines are
/// kept (`jev_review_stats`, one entry per file) and a call reads only the bytes appended since: a 16 MB log was parsed afresh at
/// every start, 100 ms of CPU for an answer that had not changed. A file that is not the one kept (rewritten, shorter, other
/// inode) is read from its start.
fn decision_stats(home: &Path) -> Result<RowStats, String> {
    decision_stats_with(home, true)
}

fn decision_stats_with(home: &Path, kept: bool) -> Result<RowStats, String> {
    use std::os::unix::fs::MetadataExt;
    let mut inst = scan_budget().instance();
    let cap = inst.hard_limit();
    let over = |file: &Path| defaults::render("opcli.review_scan_over_limit", &[("file", &file.display()), ("limit", &cap)]);
    let fp = defaults::num("opcli.review_stats_fingerprint_bytes").max(1);
    let mut total = RowStats::new();
    for path in crate::jev::report::retained(&base_dir(home).join(defaults::text("jev.log_file"))) {
        let Ok(file) = std::fs::File::open(&path) else { continue };
        let Ok(meta) = file.metadata() else { continue };
        let (key, len) = ((meta.dev(), meta.ino()), meta.len());
        let mut entry = kept
            .then(|| stats_cache().remove(&key))
            .flatten()
            .filter(|e| {
                let n = fp.min(e.parsed);
                e.parsed <= len && digest_at(&file, 0, n) == Some(e.head) && digest_at(&file, e.parsed - n, n) == Some(e.back)
            })
            .unwrap_or(FileStats { parsed: 0, head: 0, back: 0, stats: RowStats::new() });
        let from = entry.parsed;
        let Ok((off, partial)) = fold_file(file.try_clone().map_err(|e| e.to_string())?, (from, len), &mut entry.stats, &mut inst, cap) else {
            return Err(over(&path));
        };
        entry.parsed = off;
        let n = fp.min(off);
        if kept && let (Some(head), Some(back)) = (digest_at(&file, 0, n), digest_at(&file, off - n, n)) {
            entry.head = head;
            entry.back = back;
            let weight = entry.stats.keys().map(|id| id.len() + std::mem::size_of::<(String, (f64, f64))>()).sum::<usize>() + std::mem::size_of::<FileStats>();
            stats_cache().insert(key, entry.clone(), weight);
        }
        for (id, (n, first)) in entry.stats.into_iter().chain(partial) {
            let slot = total.entry(id).or_insert((0.0, f64::INFINITY));
            slot.0 += n;
            slot.1 = slot.1.min(first);
        }
    }
    Ok(total)
}

/// The daily rollups: objects with a text day and a list of groups, in file-name order.
fn rollups(home: &Path) -> Vec<J> {
    let dir = base_dir(home).join(defaults::text("jevrep.rollup_dir"));
    let Ok(re) = regex::Regex::new(defaults::text("jevrep.rollup_name_re")) else { return Vec::new() };
    let Ok(rd) = std::fs::read_dir(&dir) else { return Vec::new() };
    let mut names: Vec<String> = rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| re.is_match(n)).collect();
    names.sort();
    names
        .iter()
        .filter_map(|n| std::fs::read(dir.join(n)).ok())
        .filter_map(|b| parse_json(&String::from_utf8_lossy(&b)).ok())
        .filter(|r| matches!(r.get(k("day")), Some(J::Str(_))) && matches!(r.get(k("groups")), Some(J::Arr(_))))
        .collect()
}

struct Evidence {
    rows: RowStats,
    rollups: Vec<J>,
}

/// `idStats`: the decisions logged for `id` (raw rows plus the days only a rollup still covers) and the earliest instant.
fn id_stats(ev: &Evidence, id: &str) -> (f64, Option<f64>) {
    let (mut decisions, oldest_raw) = ev.rows.get(id).copied().unwrap_or((0.0, f64::INFINITY));
    let mut earliest = oldest_raw;
    for rollup in &ev.rollups {
        let Some(J::Str(day)) = rollup.get(k("day")) else { continue };
        let Some(start) = date_ms(&format!("{day}{}", defaults::text("opcli.review_rollup_midnight"))) else { continue };
        if start + num_of("opcli.review_day_ms") > oldest_raw {
            continue; // covered by raw rows already
        }
        let Some(J::Arr(groups)) = rollup.get(k("groups")) else { continue };
        for g in groups {
            if !matches!(g.get(k("id")), Some(J::Str(s)) if s == id) {
                continue;
            }
            if let Some(J::Num(n)) = g.get(k("n"))
                && *n != 0.0
                && !n.is_nan()
            {
                decisions += n;
            }
            earliest = earliest.min(start);
        }
    }
    (decisions, earliest.is_finite().then_some(earliest))
}

// ---- review-due ---------------------------------------------------------------------------------------------------------

/// `Number(jev.<name>)` of the settings store, as text first (so a zero or an empty value reads as such).
fn setting_number(name: &str, default_text: &str) -> f64 {
    let text = crate::ops::settings::effective_text("jev", name, default_text).unwrap_or_else(|| default_text.to_string());
    crate::checks::guardkit::text::js_number_of_str(&text)
}

struct Due {
    id: String,
    days: f64,
    decisions: f64,
}

struct Computed {
    due: Vec<Due>,
    after: f64,
    min: f64,
}

fn compute_review_due(cx: &Ctx) -> Result<Computed, String> {
    let after = match setting_number("reviewAfterDays", &to_js_string(num_of("opcli.review_after_days_default"))) {
        n if n == 0.0 || n.is_nan() => num_of("opcli.review_after_days_default"),
        n => n,
    };
    let min = match setting_number("reviewMinDecisions", &to_js_string(num_of("opcli.review_min_decisions_default"))) {
        n if n.is_finite() => n,
        _ => num_of("opcli.review_min_decisions_default"),
    };
    compute_due(&cx.home, &resolve_settings(cx), after, min)
}

/// The integrations whose review is due, for the numbers `after` (days) and `min` (decisions) and the settings `s`; persists the
/// derived `shadowSince` / `dueSince` as Node does. The state-file write is best effort.
fn compute_due(home: &Path, s: &JevSettings, after: f64, min: f64) -> Result<Computed, String> {
    let now = date::now_ms();
    let window = after * num_of("opcli.review_day_ms");

    let legacy = read_object(&jev_json_path(home));
    // the settings registry lists the integrations in the order the Node schema does
    let mut ids: Vec<String> =
        crate::migrate::settings::entries().iter().filter(|e| e.section == key("integrations_section")).map(|e| e.key.to_string()).collect();
    for id in keys(legacy.get(key("legacy_integrations")).unwrap_or(&J::Null)) {
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    ids.retain(|id| s.mode(id, false).as_str() == defaults::text("opcli.review_mode_shadow"));

    let ev = Evidence { rows: decision_stats(home)?, rollups: rollups(home) };
    let mut state = State::read(home);
    let mut due = Vec::new();
    for id in &ids {
        let entry = state.entry(id)?;
        let since = match str_of(entry, k("shadow_since")).filter(|v| !v.is_empty()) {
            Some(v) => v.to_string(),
            None => {
                let derived = id_stats(&ev, id).1.map_or_else(|| iso(now), iso);
                set(entry, k("shadow_since"), J::Str(derived.clone()));
                derived
            }
        };
        let days = date_ms(&since).map_or(0.0, |ms| (now - ms) / num_of("opcli.review_day_ms"));
        let (decisions, _) = id_stats(&ev, id);
        let snoozed = str_of(entry, k("snoozed_until")).and_then(date_ms).is_some_and(|t| t > now);
        let reviewed_recently = str_of(entry, k("last_reviewed")).and_then(date_ms).is_some_and(|t| now - t < window);
        let is_due = days >= after && decisions >= min && !snoozed && !reviewed_recently;
        if is_due {
            if !truthy(entry.iter().find(|(n, _)| n == k("due_since")).map(|(_, v)| v)) {
                set(entry, k("due_since"), J::Str(iso(now)));
            }
            due.push(Due { id: id.clone(), days: days.floor(), decisions });
        } else if truthy(entry.iter().find(|(n, _)| n == k("due_since")).map(|(_, v)| v)) {
            set(entry, k("due_since"), J::Null);
        }
    }
    if !ids.is_empty() {
        state.write();
    }
    Ok(Computed { due, after, min })
}

/// The reviews due for the SessionStart hook: `(id, whole days in shadow, decisions)`
/// per due integration, in schema order. `after` and `min` are the already-resolved `jev.reviewAfterDays` / `jev.reviewMinDecisions`.
pub(crate) fn hook_review_due(home: &Path, env: &crate::jev::settings::Env, after: f64, min: f64) -> Result<Vec<(String, f64, f64)>, String> {
    let s = JevSettings::resolve(home, Sources::load(home, env.clone()));
    compute_due(home, &s, after, min).map(|c| c.due.into_iter().map(|d| (d.id, d.days, d.decisions)).collect())
}

/// `recordReminderShown(home, ids)`: one `reminder-shown` row in the review metrics log (best effort).
pub(crate) fn hook_reminder_shown(home: &Path, ids: &[String]) {
    if ids.is_empty() {
        return;
    }
    append_metric(
        home,
        vec![
            (k("type").to_string(), J::Str(defaults::text("opcli.review_shown_type").to_string())),
            (k("ids").to_string(), J::Arr(ids.iter().map(|i| J::Str(i.clone())).collect())),
        ],
    );
}

pub(super) fn cmd_review_due(cx: &mut Ctx, positional: &[String]) -> Result<(), SetupError> {
    let r = match compute_review_due(cx) {
        Ok(r) => r,
        Err(msg) => {
            cx.fail(&msg);
            return Ok(());
        }
    };
    if positional.iter().any(|a| a == defaults::text("opcli.review_json_flag")) {
        let rows: Vec<J> = r
            .due
            .iter()
            .map(|d| {
                J::Obj(vec![
                    (k("id").to_string(), J::Str(d.id.clone())),
                    (k("days").to_string(), J::Num(d.days)),
                    (k("decisions").to_string(), J::Num(d.decisions)),
                ])
            })
            .collect();
        return out(&stringify(&J::Arr(rows)));
    }
    if r.due.is_empty() {
        return out(&defaults::render("opcli.review_none", &[("after", &to_js_string(r.after)), ("min", &to_js_string(r.min))]));
    }
    out(defaults::text("opcli.review_head"))?;
    for d in &r.due {
        out(&defaults::render("opcli.review_row", &[("id", &d.id), ("days", &to_js_string(d.days)), ("decisions", &to_js_string(d.decisions))]))?;
    }
    Ok(())
}

// ---- reviewed / snooze ----------------------------------------------------------------------------------------------------

pub(super) fn cmd_reviewed(cx: &mut Ctx, positional: &[String]) -> Result<(), SetupError> {
    let Some(id) = positional.first().filter(|i| !i.is_empty()) else {
        cx.fail(defaults::text("opcli.reviewed_usage"));
        return Ok(());
    };
    let mut state = State::read(&cx.home);
    let now = date::now_ms();
    let latency = {
        let entry = match state.entry(id) {
            Ok(e) => e,
            Err(msg) => {
                cx.fail(&msg);
                return Ok(());
            }
        };
        let latency = str_of(entry, k("due_since")).filter(|v| !v.is_empty()).and_then(date_ms).map(|due| now - due);
        set(entry, k("last_reviewed"), J::Str(iso(now)));
        set(entry, k("due_since"), J::Null);
        latency
    };
    state.write();
    append_metric(
        &cx.home,
        vec![
            (k("type").to_string(), J::Str(k("reviewed_type").to_string())),
            (k("id").to_string(), J::Str(id.clone())),
            (k("latency").to_string(), latency.map_or(J::Null, J::Num)),
        ],
    );
    let late = latency.map_or(String::new(), |l| {
        let hours = (l / num_of("opcli.review_hour_ms") + 0.5).floor();
        defaults::render("opcli.reviewed_late", &[("hours", &to_js_string(hours))])
    });
    out(&defaults::render("opcli.reviewed_ok", &[("id", id), ("late", &late)]))
}

pub(super) fn cmd_snooze(cx: &mut Ctx, positional: &[String], days: Option<&str>) -> Result<(), SetupError> {
    let n = days.map_or(f64::NAN, crate::checks::guardkit::text::js_number_of_str);
    let Some(id) = positional.first().filter(|i| !i.is_empty()).filter(|_| n.is_finite() && n > 0.0) else {
        cx.fail(defaults::text("opcli.snooze_usage"));
        return Ok(());
    };
    let until = (date::now_ms() + n * num_of("opcli.review_day_ms")).floor();
    if until > num_of("opcli.review_max_time_ms") {
        cx.fail(defaults::text("opcli.snooze_range"));
        return Ok(());
    }
    let mut state = State::read(&cx.home);
    let stamp = iso(until);
    match state.entry(id) {
        Ok(entry) => set(entry, k("snoozed_until"), J::Str(stamp.clone())),
        Err(msg) => {
            cx.fail(&msg);
            return Ok(());
        }
    }
    state.write();
    out(&defaults::render("opcli.snooze_ok", &[("id", id), ("until", &stamp)]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::MetadataExt;

    fn home(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ah-review-{tag}-{}", std::process::id()));
        crate::discard::harmless(std::fs::remove_dir_all(&d)); // keep: a scratch dir that may not exist yet
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// #247: the SessionStart check recomputes the review state on every start; with nothing changed it must not rewrite (and fully
    /// sync) the state file. An atomic write replaces the file, so an unchanged inode is an untouched file.
    #[test]
    fn an_unchanged_review_state_is_not_written_again() {
        let h = home("same");
        // Jev on (the integrations then have a mode, shadow by default): only then is there a review state to keep
        std::fs::create_dir_all(base_dir(&h)).unwrap();
        std::fs::write(base_dir(&h).join("settings.json"), r#"{"jev":{"enabled":true}}"#).unwrap();
        let env = crate::jev::settings::Env::from_pairs([("HOME", h.to_string_lossy().to_string())]);
        let first = hook_review_due(&h, &env, 7.0, 30.0).unwrap();
        let state = base_dir(&h).join(defaults::text("opcli.review_state_file"));
        let before = std::fs::metadata(&state).unwrap_or_else(|e| panic!("the first call writes the state ({first:?}): {e}"));
        let bytes = std::fs::read(&state).unwrap();
        for _ in 0..3 {
            hook_review_due(&h, &env, 7.0, 30.0).unwrap();
        }
        let after = std::fs::metadata(&state).unwrap();
        assert_eq!((before.ino(), before.mtime_nsec()), (after.ino(), after.mtime_nsec()), "the state file was rewritten with the same content");
        assert_eq!(bytes, std::fs::read(&state).unwrap());
    }

    #[test]
    fn a_changed_review_state_is_still_written() {
        let h = home("changed");
        let state = base_dir(&h).join(defaults::text("opcli.review_state_file"));
        std::fs::create_dir_all(state.parent().unwrap()).unwrap();
        write_json_atomic_if_changed(&state, J::Obj(vec![("a".into(), J::Bool(true))])).unwrap();
        let first = std::fs::read(&state).unwrap();
        write_json_atomic_if_changed(&state, J::Obj(vec![("a".into(), J::Bool(false))])).unwrap();
        assert_ne!(first, std::fs::read(&state).unwrap());
    }

    fn sorted(s: RowStats) -> Vec<(String, u64, u64)> {
        let mut v: Vec<_> = s.into_iter().map(|(id, (n, t))| (id, n as u64, if t.is_finite() { t as u64 } else { 0 })).collect();
        v.sort();
        v
    }

    fn row(id: &str, ts: &str) -> String {
        format!("{{\"id\":\"{id}\",\"ts\":\"{ts}\",\"v\":1}}\n")
    }

    /// The kept totals answer as a read from the start through appends (a last line still unfinished included), a rotation (the
    /// file renamed, its inode kept) and a rewrite of the file.
    #[test]
    fn kept_decision_totals_answer_as_a_fresh_read_at_every_step() {
        use std::io::Write;
        let h = home("stats");
        let log = base_dir(&h).join(defaults::text("jev.log_file"));
        std::fs::create_dir_all(log.parent().unwrap()).unwrap();
        let same = |what: &str| {
            let kept = sorted(decision_stats_with(&h, true).unwrap());
            let fresh = sorted(decision_stats_with(&h, false).unwrap());
            assert_eq!(kept, fresh, "{what}");
            kept
        };
        std::fs::write(&log, row("a", "2026-10-01T00:00:00.000Z") + &row("b", "2026-10-02T00:00:00.000Z")).unwrap();
        assert_eq!(same("first read").len(), 2);
        let append = |text: &str| std::fs::OpenOptions::new().append(true).open(&log).unwrap().write_all(text.as_bytes()).unwrap();
        append(&row("a", "2026-09-30T00:00:00.000Z"));
        assert_eq!(same("appended line").iter().find(|r| r.0 == "a").unwrap().1, 2);
        // a last line still being written counts in the answer, and once finished counts once
        append("{\"id\":\"c\",\"ts\":\"2026-10-03T00:00:00.000Z\"");
        same("unfinished line");
        append("}\n");
        assert_eq!(same("finished line").iter().find(|r| r.0 == "c").unwrap().1, 1);
        // rotation: the live file becomes generation 1 (same inode), a new live file starts
        std::fs::rename(&log, format!("{}.1", log.display())).unwrap();
        std::fs::write(&log, row("b", "2026-10-04T00:00:00.000Z")).unwrap();
        assert_eq!(same("after rotation").iter().find(|r| r.0 == "b").unwrap().1, 2);
        // a rewrite of the live file with other content of at least the kept length
        std::fs::write(&log, row("z", "2026-10-05T00:00:00.000Z") + &row("z", "2026-10-06T00:00:00.000Z")).unwrap();
        assert_eq!(same("after rewrite").iter().find(|r| r.0 == "z").unwrap().1, 2);
        // a file cut shorter than what was kept
        std::fs::write(&log, row("y", "2026-10-07T00:00:00.000Z")).unwrap();
        same("after truncation");
    }
}
