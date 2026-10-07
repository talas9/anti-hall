//! The sweeps over the files under `~/.anti-hall`: stale lock scratch files, in-flight drain markers whose time to live has
//! passed, state files past their retention window, stuck per-instance inbox cursors, stale summaries. Each is the Node sweep
//! (`doctor-repair.js`, `recovery.js`, `devswarm-store.js`) and reports the same way: in a preview or check it lists what it
//! would touch, in a repair it touches only what is provably past its window and never a fresh file.
//!
//! The directories can be large (a measured 34 thousand files in one), so the retention sweeps stream the directory entry by
//! entry and read no file whole; the only reads are the small JSON state files and a cursor file at a time.
use super::settings::{self, find};
use super::{Ctx, Detect, Row, for_each_line, is_enoent, j_finite, migration_fix, node_err, parse_json, read_dir_sorted, read_text_note};
use crate::checks::jsport::json::J;
use crate::checks::jsport::{date, fsx, num};
use crate::defaults;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

fn safe_id_re() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| crate::checks::lit_re(defaults::text("migrate.safe_id_re")))
}

fn is_safe_id(id: &str) -> bool {
    !id.is_empty() && id != "." && id != ".." && !id.contains("..") && safe_id_re().is_match(id)
}

// ---- the lock scratch sweep -------------------------------------------------------------------------------------------

/// `sweepStaleLockScratchFiles(home, {dryRun})`: scratch files of the lock protocol older than the stale window, in every lock
/// directory. `(pending, detail)`.
fn scan_lock_scratch(ctx: &Ctx, remove: bool) -> (bool, String) {
    let re = crate::checks::lit_re(defaults::text("migrate.lock_scratch_re"));
    let base = ctx.base();
    let ds = ctx.devswarm();
    let store = ds.join(defaults::text("migrate.store_dir"));
    let mut dirs = vec![ds.join(defaults::text("migrate.locks_dir")), base.clone(), base.join(defaults::text("migrate.logs_dir"))];
    match read_dir_sorted(&store) {
        Ok(hashes) => dirs.extend(hashes.into_iter().map(|h| store.join(h).join(defaults::text("migrate.store_journal_dir")))),
        Err(e) => ctx.io_note("scandir", &store, &e),
    }
    let now = date::now_ms();
    let stale_ms = defaults::num("migrate.lock_scratch_stale_ms") as f64;
    let (mut seen, mut stale) = (0, Vec::new());
    for dir in &dirs {
        let names = match read_dir_sorted(dir) {
            Ok(n) => n,
            Err(e) => {
                ctx.io_note("scandir", dir, &e);
                continue;
            }
        };
        seen += 1;
        for name in names {
            if !re.is_match(&name) {
                continue;
            }
            let full = dir.join(&name);
            let md = match std::fs::metadata(&full) {
                Ok(m) => m,
                Err(e) => {
                    ctx.io_note("stat", &full, &e);
                    continue;
                }
            };
            if !md.is_file() {
                continue;
            }
            let mtime = fsx::mtime_ms(&md);
            if mtime.is_finite() && now - mtime > stale_ms {
                stale.push(full);
            }
        }
    }
    if seen == 0 {
        return (false, defaults::text("migrate_msg.no_lock_dirs").to_string());
    }
    if remove {
        for full in &stale {
            if let Err(e) = std::fs::remove_file(full) {
                ctx.io_note("unlink", full, &e);
            }
        }
    }
    let list = if stale.is_empty() {
        String::new()
    } else {
        let names: Vec<String> = stale.iter().map(|f| f.strip_prefix(&base).unwrap_or(f).to_string_lossy().into_owned()).collect();
        format!(": {}", names.join(", "))
    };
    (!stale.is_empty(), format!("{}{list}", defaults::render("migrate_msg.lock_scratch", &[("n", &stale.len())])))
}

/// `sweep-lock-scratch`.
pub(super) fn lock_scratch(ctx: &Ctx, rows: &mut Vec<Row>) {
    migration_fix(
        rows,
        ctx,
        super::step("lock"),
        super::step("lock_action"),
        || {
            let (pending, detail) = scan_lock_scratch(ctx, false);
            Ok(Detect { pending, detail })
        },
        || {
            scan_lock_scratch(ctx, true);
            Ok(())
        },
    );
}

// ---- the sweeps of the repair pass ------------------------------------------------------------------------------------------

/// One item a sweep found or handled.
struct Item {
    /// `fixed`, `skipped`, `failed`, `pending`, or none (a listed item that has no state of its own).
    status: Option<&'static str>,
    msg: String,
}

fn item(status: &'static str, msg: String) -> Item {
    Item { status: Some(status), msg }
}

/// What a sweep came to: its items, or a deferral to the Node doctor.
enum Outcome {
    Items(Vec<Item>),
    Deferred,
}

fn failed_list(dir: &Path, e: &std::io::Error) -> Item {
    item("failed", defaults::render("migrate_msg.could_not_list", &[("dir", &dir.display()), ("error", &node_err(e, "scandir", dir))]))
}

fn failed_remove(path: &Path, e: &std::io::Error) -> Item {
    item("failed", defaults::render("migrate_msg.could_not_remove", &[("path", &path.display()), ("error", &node_err(e, "unlink", path))]))
}

/// `getWithEnv('devswarm', key, dflt, env)` as a number.
fn devswarm_number(ctx: &Ctx, key: &str, dflt: f64) -> f64 {
    let section = defaults::text("migrate.devswarm_section");
    let Some(entry) = find(section, key) else { return dflt };
    match settings::get(ctx, entry, Some(&J::Num(dflt))) {
        Some(J::Num(n)) => n,
        _ => dflt,
    }
}

// -- drain markers

fn drain_ttl(ctx: &Ctx) -> f64 {
    let t = defaults::raw("migrate.drain_ttl");
    let dflt = t.get("default").and_then(crate::defaults::V::as_integer).unwrap_or(0) as f64;
    devswarm_number(ctx, t.str_field("key"), dflt)
}

/// `readDrainMarker(home, id, {now})`: `(startedAt, stale)`, `None` when there is no readable marker.
fn read_drain_marker(ctx: &Ctx, dir: &Path, id: &str, ttl: f64, now: f64) -> Option<(f64, bool)> {
    let marker = parse_json(&read_text_note(ctx, &dir.join(format!("{id}{}", super::json_ext())))?)?;
    let started = j_finite(marker.get("startedAt"))?;
    let age = now - started;
    Some((started, !(age >= 0.0 && age <= ttl)))
}

fn drain_markers(ctx: &Ctx, repair: bool) -> Outcome {
    let dir = ctx.devswarm().join(defaults::text("migrate.drain_dir"));
    let names = match read_dir_sorted(&dir) {
        Ok(n) => n,
        Err(e) if is_enoent(&e) => return Outcome::Items(Vec::new()),
        Err(e) => return Outcome::Items(vec![failed_list(&dir, &e)]),
    };
    let (now, ttl) = (date::now_ms(), drain_ttl(ctx));
    let mut out = Vec::new();
    for name in names {
        let Some(id) = name.strip_suffix(super::json_ext()) else { continue };
        // `readDrainMarker` answers "no marker" for an id that is not safe to use in a path
        if !is_safe_id(id) {
            continue;
        }
        let Some((started, stale)) = read_drain_marker(ctx, &dir, id, ttl, now) else { continue };
        if !repair {
            out.push(Item { status: None, msg: String::new() });
            continue;
        }
        if !stale {
            out.push(item("skipped", String::new()));
            continue;
        }
        // `clearStaleDrainMarker`: read again, and remove only a marker that is still stale
        let path = dir.join(format!("{id}{}", super::json_ext()));
        let cleared = read_drain_marker(ctx, &dir, id, ttl, now).is_some_and(|(_, s)| s)
            && match std::fs::remove_file(&path) {
                Ok(()) => true,
                Err(e) => {
                    ctx.io_note("unlink", &path, &e);
                    is_enoent(&e)
                }
            };
        let msg = if cleared {
            defaults::render("migrate_msg.drain_removed", &[("id", &id), ("age", &num::to_js_string(now - started))])
        } else {
            defaults::render("migrate_msg.drain_not_removed", &[("id", &id)])
        };
        out.push(item(if cleared { "fixed" } else { "failed" }, msg));
    }
    Outcome::Items(out)
}

// -- unclaimed sessions

/// `readDescriptors(home)`: the workspace descriptors that name a worktree, a session and a safe id.
fn read_descriptors(ctx: &Ctx) -> Vec<J> {
    let dir = ctx.devswarm().join(defaults::text("migrate.workspaces_dir"));
    let names = match read_dir_sorted(&dir) {
        Ok(n) => n,
        Err(e) => {
            ctx.io_note("scandir", &dir, &e);
            return Vec::new();
        }
    };
    let mut out = Vec::new();
    for name in names.into_iter().filter(|n| n.ends_with(super::json_ext())) {
        let Some(d) = read_text_note(ctx, &dir.join(&name)).and_then(|t| parse_json(&t)) else { continue };
        let id_ok = matches!(d.get("id"), Some(J::Str(s)) if is_safe_id(s));
        if super::j_truthy(d.get("worktreePath")) && super::j_truthy(d.get("sessionId")) && id_ok {
            out.push(d);
        }
    }
    out
}

fn unclaimed(ctx: &Ctx, repair: bool) -> Outcome {
    let prefix = defaults::text("migrate.unclaimed_prefix");
    let marked: Vec<J> = read_descriptors(ctx)
        .into_iter()
        .filter(|d| {
            let id = d.get("id").map(super::j_string).unwrap_or_default();
            d.get("sessionId").map(super::j_string).unwrap_or_default() == format!("{prefix}{id}")
        })
        .collect();
    if marked.is_empty() {
        return Outcome::Items(Vec::new());
    }
    if repair {
        // promoting a session id rewrites the workspace registry, which lives in the DevSwarm stores
        return Outcome::Deferred;
    }
    Outcome::Items(marked.iter().map(|_| item("pending", String::new())).collect())
}

// -- retention

/// `parseInt(raw, 10)`: the leading integer of a string, `None` when there is none.
fn parse_int(raw: &str) -> Option<f64> {
    let t = crate::checks::guardkit::text::js_trim_start(raw);
    let (neg, rest) = match t.strip_prefix('-') {
        Some(r) => (true, r),
        None => (false, t.strip_prefix('+').unwrap_or(t)),
    };
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() {
        return None;
    }
    let n: f64 = digits.parse().ok()?;
    Some(if neg { -n } else { n })
}

/// A retention window in days: the settings chain when the sweep has a key, else the environment variable alone (a positive
/// integer), else the default.
fn retention_days(ctx: &Ctx, spec: &defaults::V) -> f64 {
    let dflt = spec.get("days").and_then(defaults::V::as_integer).unwrap_or(0) as f64;
    let key = spec.str_field("key");
    if !key.is_empty() {
        return devswarm_number(ctx, key, dflt);
    }
    ctx.env.get(spec.str_field("env")).and_then(|v| parse_int(v)).filter(|n| n.is_finite() && *n > 0.0).unwrap_or(dflt)
}

/// What one walk of a retention directory needs.
struct Aged<'a> {
    ctx: &'a Ctx,
    suffix: &'a str,
    max_age: f64,
    now: f64,
    repair: bool,
}

impl Aged<'_> {
    /// `sweepAgedFiles`'s walk: the directory's entries one at a time, one level of subdirectories, files with the suffix older
    /// than the window. A file inside the window is never touched.
    fn walk(&self, dir: &Path, depth: u32, out: &mut Vec<Item>) {
        let entries = match std::fs::read_dir(dir) {
            Ok(r) => r,
            Err(e) if is_enoent(&e) => return,
            Err(e) => {
                out.push(failed_list(dir, &e));
                return;
            }
        };
        for entry in entries {
            let entry = match entry {
                Ok(en) => en,
                Err(e) => {
                    self.ctx.io_note("scandir", dir, &e);
                    continue;
                }
            };
            let name = entry.file_name().to_string_lossy().into_owned();
            let full = dir.join(&name);
            let md = match std::fs::metadata(&full) {
                Ok(m) => m,
                Err(e) => {
                    self.ctx.io_note("stat", &full, &e);
                    continue;
                }
            };
            if md.is_dir() {
                if depth < defaults::num("migrate.walk_depth") as u32 {
                    self.walk(&full, depth + 1, out);
                }
                continue;
            }
            if !name.ends_with(self.suffix) || self.now - fsx::mtime_ms(&md) <= self.max_age {
                continue;
            }
            if !self.repair {
                out.push(item("pending", String::new()));
            } else {
                match std::fs::remove_file(&full) {
                    Ok(()) => out.push(item("fixed", String::new())),
                    Err(e) => out.push(failed_remove(&full, &e)),
                }
            }
        }
    }
}

fn sweep_aged(ctx: &Ctx, dir: &Path, suffix: &str, days: f64, repair: bool) -> Vec<Item> {
    let mut out = Vec::new();
    Aged { ctx, suffix, max_age: days * defaults::num("migrate.day_ms") as f64, now: date::now_ms(), repair }.walk(dir, 0, &mut out);
    out
}

// -- summaries

fn stale_summaries(ctx: &Ctx, repair: bool) -> Outcome {
    let spec = defaults::raw("migrate.summaries");
    let dflt = spec.get("days").and_then(defaults::V::as_integer).unwrap_or(0) as f64;
    let days = devswarm_number(ctx, spec.str_field("key"), dflt);
    let max_age = days * defaults::num("migrate.day_ms") as f64;
    let dir = ctx.devswarm().join(spec.str_field("dir"));
    let entries = match std::fs::read_dir(&dir) {
        Ok(r) => r,
        Err(e) if is_enoent(&e) => return Outcome::Items(Vec::new()),
        Err(e) => return Outcome::Items(vec![failed_list(&dir, &e)]),
    };
    let in_use = super::list_store_hashes(ctx);
    let now = date::now_ms();
    let mut out = Vec::new();
    for entry in entries {
        let name = match entry {
            Ok(en) => en.file_name().to_string_lossy().into_owned(),
            Err(e) => {
                ctx.io_note("scandir", &dir, &e);
                continue;
            }
        };
        let Some(hash) = name.strip_suffix(super::json_ext()) else { continue };
        if in_use.iter().any(|h| h == hash) {
            continue;
        }
        let full = dir.join(&name);
        let Some(obj) = read_text_note(ctx, &full).and_then(|t| parse_json(&t)) else { continue };
        let Some(generated) = j_finite(obj.get("generatedAt")) else { continue };
        if now - generated <= max_age {
            continue;
        }
        if !repair {
            out.push(item("pending", String::new()));
        } else {
            match std::fs::remove_file(&full) {
                Ok(()) => out.push(item("fixed", String::new())),
                Err(e) => out.push(failed_remove(&full, &e)),
            }
        }
    }
    Outcome::Items(out)
}

// -- cursors

fn cursors_spec(key: &str) -> &'static str {
    defaults::raw("migrate.cursors").str_field(key)
}

/// `readCursor(path)`: the line count a cursor file holds (a bare integer, or `{"line": n}`), 0 when unreadable.
fn read_cursor(ctx: &Ctx, path: &Path) -> f64 {
    let Some(text) = read_text_note(ctx, path) else { return 0.0 };
    let raw = crate::checks::guardkit::text::js_trim(&text);
    let c = if !raw.is_empty() && raw.chars().all(|c| c.is_ascii_digit()) {
        raw.parse::<f64>().unwrap_or(f64::NAN)
    } else {
        parse_json(raw).and_then(|j| j.get("line").map(super::j_number)).unwrap_or(f64::NAN)
    };
    if c.is_finite() && c >= 0.0 { c.floor() } else { 0.0 }
}

/// `countMessages(inbox)`: the non-blank lines, counted as the file streams by.
fn count_messages(ctx: &Ctx, path: &Path) -> f64 {
    let mut n = 0u64;
    match for_each_line(path, |l| {
        if !crate::checks::guardkit::text::js_trim(l).is_empty() {
            n += 1;
        }
    }) {
        Ok(_) => n as f64,
        Err(e) => {
            ctx.io_note("open", path, &e);
            0.0
        }
    }
}

/// `reconcileStuckNdCursors`: raise a per-instance cursor that fell behind its descriptor cursor, never lower one, never past
/// the inbox's real length.
fn nd_cursors(ctx: &Ctx, repair: bool) -> Outcome {
    let ds = ctx.devswarm();
    let dir = ds.join(cursors_spec("cursors"));
    let inbox = ds.join(cursors_spec("inbox"));
    let names = match read_dir_sorted(&dir) {
        Ok(n) => n,
        Err(e) if is_enoent(&e) => return Outcome::Items(Vec::new()),
        Err(e) => return Outcome::Items(vec![failed_list(&dir, &e)]),
    };
    let re = crate::checks::lit_re(cursors_spec("nd_re"));
    let mut out = Vec::new();
    for name in names {
        let Some(m) = re.captures(&name) else { continue };
        let id = &m[1];
        let inst = dir.join(&name);
        let desc = dir.join(format!("{id}{}", super::json_ext()));
        if !desc.exists() {
            continue;
        }
        let inst_cursor = read_cursor(ctx, &inst);
        let desc_cursor = read_cursor(ctx, &desc);
        let lines = count_messages(ctx, &inbox.join(format!("{id}{}", cursors_spec("inbox_ext"))));
        let target = desc_cursor.min(lines);
        if inst_cursor >= target {
            continue;
        }
        if !repair {
            out.push(item("pending", String::new()));
            continue;
        }
        // `ackTo(inst, descCursor, fs, inbox)`: clamp to the inbox length, never below the current value, atomic write
        let applied = desc_cursor.min(lines).max(inst_cursor);
        let mut tmp = inst.as_os_str().to_os_string();
        tmp.push(defaults::text("migrate.tmp_ext"));
        let tmp = PathBuf::from(tmp);
        let written = std::fs::write(&tmp, num::to_js_string(applied)).and_then(|()| std::fs::rename(&tmp, &inst));
        match written {
            Ok(()) => out.push(item("fixed", String::new())),
            Err(e) => {
                out.push(item("failed", defaults::render("migrate_msg.could_not_raise", &[("path", &inst.display()), ("error", &node_err(&e, "open", &tmp))])))
            }
        }
    }
    Outcome::Items(out)
}

/// `sweepOrphanedSiblingWatermarks`: a watermark names a sibling that may still have a row or messages in some store, which
/// only a store read can tell; with no store at all the sweep declines, as Node does, and with stores it is left to Node.
fn watermarks(ctx: &Ctx) -> Outcome {
    let dir = ctx.devswarm().join(cursors_spec("cursors"));
    let names = match read_dir_sorted(&dir) {
        Ok(n) => n,
        Err(e) if is_enoent(&e) => return Outcome::Items(Vec::new()),
        Err(e) => return Outcome::Items(vec![failed_list(&dir, &e)]),
    };
    let sep = cursors_spec("seen_sep");
    let has_candidate = names.iter().any(|n| {
        let Some(base) = n.strip_suffix(super::json_ext()) else { return false };
        let Some(i) = base.find(sep) else { return false };
        let (caller, sibling) = (&base[..i], &base[i + sep.len()..]);
        i > 0 && is_safe_id(caller) && is_safe_id(sibling) && !caller.contains(sep) && !sibling.contains(sep)
    });
    if !has_candidate {
        return Outcome::Items(Vec::new());
    }
    if super::list_store_hashes(ctx).is_empty() {
        return Outcome::Items(vec![item("skipped", defaults::text("migrate_msg.watermark_declined").to_string())]);
    }
    Outcome::Deferred
}

// ---- the pass ----------------------------------------------------------------------------------------------------------------

/// The `sweeps` loop of `runRepairs`: one row per sweep. A preview (`dry_run`) is "check" mode and lists; otherwise "repair".
pub(super) fn all(ctx: &Ctx, rows: &mut Vec<Row>) {
    let repair = !ctx.dry_run;
    let mut sweeps: Vec<(String, Outcome)> = Vec::new();
    sweeps.push((super::step("drain").into(), drain_markers(ctx, repair)));
    sweeps.push((super::step("promote").into(), unclaimed(ctx, repair)));
    let base = ctx.base();
    for spec in defaults::raw("migrate.retention_sweeps").as_array().unwrap_or_default() {
        let dir = if spec.get("devswarm").and_then(defaults::V::as_bool).unwrap_or(false) { ctx.devswarm() } else { base.clone() };
        let items = sweep_aged(ctx, &dir.join(spec.str_field("dir")), spec.str_field("suffix"), retention_days(ctx, spec), repair);
        sweeps.push((spec.str_field("id").to_string(), Outcome::Items(items)));
    }
    sweeps.push((super::step("watermarks").into(), watermarks(ctx)));
    sweeps.push((super::step("nd").into(), nd_cursors(ctx, repair)));
    sweeps.push((super::step("summaries").into(), stale_summaries(ctx, repair)));
    for (id, outcome) in sweeps {
        let mut push = |action: &str, status: &str, msg: String| rows.push(Row { id: id.clone(), action: action.into(), status: status.into(), msg });
        let list = match outcome {
            Outcome::Deferred => {
                push("none", "skipped", defaults::text("migrate_msg.deferred").to_string());
                continue;
            }
            Outcome::Items(l) => l,
        };
        let failed: Vec<&Item> = list.iter().filter(|r| r.status == Some("failed")).collect();
        let acted = list.iter().filter(|r| r.status == Some("fixed") || r.status == Some("promoted")).count();
        if !failed.is_empty() {
            let msgs: Vec<&str> = failed.iter().map(|r| r.msg.as_str()).filter(|m| !m.is_empty()).collect();
            let action = if repair { id.as_str() } else { "none" };
            push(action, "failed", defaults::render("migrate_msg.sweep_failed", &[("n", &failed.len()), ("total", &list.len()), ("msgs", &msgs.join("; "))]));
        } else if !repair {
            let msg = if list.is_empty() {
                defaults::text("migrate_msg.sweep_nothing_pending").to_string()
            } else {
                defaults::render("migrate_msg.sweep_pending", &[("n", &list.len())])
            };
            push("none", "skipped", msg);
        } else if acted > 0 {
            push(&id, "fixed", defaults::render("migrate_msg.sweep_handled", &[("n", &acted)]));
        } else {
            push("none", "skipped", defaults::text("migrate_msg.sweep_nothing").to_string());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_int_reads_the_leading_integer_like_javascript() {
        assert_eq!(parse_int("  12abc"), Some(12.0));
        assert_eq!(parse_int("-3"), Some(-3.0));
        assert_eq!(parse_int("+7.9"), Some(7.0));
        assert_eq!(parse_int("abc"), None);
        assert_eq!(parse_int(""), None);
    }

    #[test]
    fn safe_ids_refuse_traversal_and_separators() {
        for ok in ["abc", "a.b-c_d", "x1"] {
            assert!(is_safe_id(ok), "{ok}");
        }
        for bad in ["", ".", "..", "a/b", "a..b", "a b", "../x"] {
            assert!(!is_safe_id(bad), "{bad}");
        }
    }
}
