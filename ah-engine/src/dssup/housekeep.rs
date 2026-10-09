//! The housekeeping duty, native: `housekeepingSweepIfDue` of `companion/devswarm-supervisor.js` with the two sweeps it runs
//! (`sweepReapedLogs`, `sweepChildGateFiles` of `hooks/lib/doctor-repair.js`, both `sweepAgedFiles` in repair mode).
//!
//! What it does and what it keeps: it removes, from the reaped-workspace logs and the per-session child-gate state, only
//! files whose modification time is older than the retention window (days, from the same settings Node reads), looking one
//! directory level down, and only files with the sweep's own suffix. Nothing else under the DevSwarm directory is touched.
//! The cool-down state file `housekeeping-sweep-state.json` is written BEFORE the sweep (a sweep that hangs must not re-arm
//! on every tick), exactly as Node writes it. The result rows have Node's keys and words.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this module is a deliberate keep, for these reasons:
// - a file that vanished between the listing and the stat is skipped (Node's `catch (_) { continue }`)
// - an unwritable state file only loses rate limiting (Node: "fail-open, best-effort")
use super::setting;
use super::tick::Ctx;
use crate::defaults;
use serde_json::{Value, json};
use std::os::unix::fs::MetadataExt;
use std::path::Path;

fn mtime_ms(md: &std::fs::Metadata) -> f64 {
    md.mtime() as f64 * 1000.0 + (md.mtime_nsec() as f64 / 1e6)
}

/// The retention window in days of one sweep: the setting when it is a positive number, else the shipped default (Node's
/// `retentionDays`: an unparseable or non-positive value must never widen, or here narrow, a deletion window).
fn days(ctx: &Ctx, key: &str) -> f64 {
    let entry = defaults::raw(key);
    let fallback = entry.get("default").and_then(crate::defaults::V::as_integer).unwrap_or(0) as f64;
    match setting(ctx.st, key).as_f64() {
        Some(d) if d > 0.0 => d,
        _ => fallback,
    }
}

fn row(file: &Path, age_ms: f64, status: &str, msg: String) -> Value {
    json!({"file": file.to_string_lossy(), "ageMs": age_ms, "status": status, "msg": msg})
}

/// `sweepAgedFiles` in repair mode over `dir` (one level of sub-directories), for `suffix` and `window_days`.
pub fn sweep_aged(dir: &Path, suffix: &str, window_days: f64, now: i64) -> Vec<Value> {
    let max_age = window_days * defaults::num("devswarm_sup.hk_day_ms") as f64;
    let mut results = Vec::new();
    walk(dir, 0, suffix, max_age, now as f64, &mut results);
    results
}

fn walk(dir: &Path, depth: u64, suffix: &str, max_age: f64, now: f64, out: &mut Vec<Value>) {
    let names = match std::fs::read_dir(dir) {
        Ok(rd) => rd.flatten().map(|e| e.file_name()).collect::<Vec<_>>(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return, // routine: nothing has ever been written here
        Err(e) => {
            out.push(json!({"file": dir.to_string_lossy(), "status": "failed", "msg": defaults::render("devswarm_sup.hk_msg_list_failed", &[("dir", &dir.display()), ("err", &e)])}));
            return;
        }
    };
    for name in names {
        let full = dir.join(&name);
        let Ok(md) = std::fs::metadata(&full) else { continue }; // vanished mid-sweep: nothing to do
        if md.is_dir() {
            // stricter than Node: a link to a directory is never followed, so a stray link can never make the sweep remove files
            // that live somewhere else
            if std::fs::symlink_metadata(&full).is_ok_and(|l| l.file_type().is_symlink()) {
                continue;
            }
            // one level of date partitioning is the only nesting these directories have; bounded so a link loop cannot make the walk unbounded
            if depth < defaults::num("devswarm_sup.hk_max_depth") {
                walk(&full, depth + 1, suffix, max_age, now, out);
            }
            continue;
        }
        if !suffix.is_empty() && !name.to_string_lossy().ends_with(suffix) {
            continue;
        }
        let age = now - mtime_ms(&md);
        if age <= max_age {
            continue; // inside the retention window: never touched
        }
        match std::fs::remove_file(&full) {
            Ok(()) => out.push(row(
                &full,
                age,
                defaults::text("devswarm_sup.hk_status_fixed"),
                defaults::render(
                    "devswarm_sup.hk_msg_removed",
                    &[("file", &full.display()), ("days", &((age / defaults::num("devswarm_sup.hk_day_ms") as f64).round() as i64))],
                ),
            )),
            Err(e) => out.push(row(
                &full,
                age,
                defaults::text("devswarm_sup.hk_status_failed"),
                defaults::render("devswarm_sup.hk_msg_remove_failed", &[("file", &full.display()), ("err", &e)]),
            )),
        }
    }
}

/// Write `{"lastRunAt": <ms>}` to the cool-down state file the way Node does (temporary file, rename); a failure only loses rate limiting.
fn write_state(home: &Path, now: i64) {
    let p = super::root(home).join(defaults::text("devswarm_sup.hk_state"));
    if let Some(d) = p.parent() {
        crate::discard::harmless(std::fs::create_dir_all(d)); // keep: rate limiting is best effort
    }
    crate::discard::harmless(crate::atomic::write(&p, json!({"lastRunAt": now}).to_string())); // keep: rate limiting is best effort
}

/// One housekeeping pass. The caller (the tick) has already applied the duty's gate (switch and cool-down), so this runs the
/// sweeps: state first, then each sweep of `devswarm_sup.hk_sweeps` in order. Returns Node's `{ran, results}`.
pub fn run(ctx: &Ctx) -> Value {
    write_state(ctx.home, ctx.now);
    let root = super::root(ctx.home);
    let mut results = serde_json::Map::new();
    for sweep in defaults::raw("devswarm_sup.hk_sweeps").as_array().unwrap_or_default() {
        let window = days(ctx, sweep.str_field("days"));
        let rows = sweep_aged(&root.join(sweep.str_field("dir")), sweep.str_field("suffix"), window, ctx.now);
        results.insert(sweep.str_field("name").to_string(), Value::Array(rows));
    }
    json!({"ran": true, "results": Value::Object(results)})
}

/// The witness mirror of the housekeeping inputs, taken BEFORE the sweep: for each sweep directory, every file older than the
/// retention window (the ones the sweep removes) and a small sample of the newer ones (so a Node that removes too much shows).
/// Names, sizes and modification times only. `None` when there is nothing to compare or the directory is too big to mirror.
pub fn witness_prepare(ctx: &Ctx) -> Option<super::witness::Job> {
    let scratch = super::witness::scratch(ctx, "housekeeping")?;
    let (live_root, scratch_root) = (super::root(ctx.home), super::root(&scratch));
    let cap = defaults::num("devswarm_sup.witness_max_files") as usize;
    let mut names = Vec::new();
    let mut windows = Vec::new();
    for sweep in defaults::raw("devswarm_sup.hk_sweeps").as_array().unwrap_or_default() {
        let window = days(ctx, sweep.str_field("days"));
        windows.push(window);
        let max_age = window * defaults::num("devswarm_sup.hk_day_ms") as f64;
        let (suffix, mut sample) = (sweep.str_field("suffix"), defaults::num("devswarm_sup.witness_keep_sample"));
        let dir = sweep.str_field("dir");
        let mirrored = super::witness::mirror_dir(&live_root.join(dir), &scratch_root.join(dir), cap, |name, md| {
            if !suffix.is_empty() && !name.ends_with(suffix) {
                return false;
            }
            if ctx.now as f64 - mtime_ms(md) > max_age {
                return true;
            }
            let keep = sample > 0;
            sample = sample.saturating_sub(1);
            keep
        });
        let Some(set) = mirrored else {
            crate::discard::harmless(std::fs::remove_dir_all(&scratch)); // keep: our own empty scratch
            return None;
        };
        names.extend(set.into_iter().map(|n| format!("{dir}/{n}")));
    }
    Some(super::witness::Job {
        duty: "housekeeping".to_string(),
        scratch: scratch.clone(),
        facts: json!({"days": windows, "names": names, "live": live_root.to_string_lossy(), "scratch": scratch_root.to_string_lossy()}),
        live: false,
    })
}
