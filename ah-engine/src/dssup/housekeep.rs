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

/// Move stale workspace heartbeats out of the watched heartbeats directory (GH #912: 974 beats, 876 of them over a week old, each
/// one more file for the state watcher and a leak of its own). A beat moves to `devswarm_sup.hk_beat_retired_dir` (never deleted)
/// only when it is older than `devswarm_sup.hk_beat_retire_ms` AND its workspace has no descriptor in the workspaces directory
/// (an active workspace's beat always stays, however old); a staged temp file is never touched; at most
/// `devswarm_sup.hk_beat_retire_max` move per pass. A name already in the retired directory gets the time appended, so nothing
/// is overwritten.
pub fn retire_beats(root: &Path, now: i64) -> Vec<Value> {
    let t = defaults::text;
    let (dir, to) = (root.join(t("mesh_write.dir_heartbeats")), root.join(t("devswarm_sup.hk_beat_retired_dir")));
    let (suffix, tmp) = (t("mesh_write.json_suffix"), t("mesh_write.tmp_suffix"));
    let max_age = defaults::num("devswarm_sup.hk_beat_retire_ms") as f64;
    let max = defaults::num("devswarm_sup.hk_beat_retire_max") as usize;
    let workspaces = root.join(t("mesh_write.dir_workspaces"));
    let Ok(rd) = std::fs::read_dir(&dir) else { return Vec::new() }; // no heartbeats directory: nothing to retire
    let mut out = Vec::new();
    for e in rd.flatten() {
        if out.len() >= max {
            break;
        }
        let name = e.file_name();
        let n = name.to_string_lossy();
        let Some(id) = n.strip_suffix(suffix) else { continue };
        if n.contains(tmp) || id.is_empty() {
            continue;
        }
        let Ok(md) = std::fs::symlink_metadata(e.path()) else { continue }; // vanished mid-sweep
        if !md.is_file() {
            continue;
        }
        let age = now as f64 - mtime_ms(&md);
        if age <= max_age || workspaces.join(&*n).exists() {
            continue; // fresh, or the workspace is active: its beat stays
        }
        if let Err(err) = std::fs::create_dir_all(&to) {
            out.push(row(
                &e.path(),
                age,
                t("devswarm_sup.hk_status_failed"),
                defaults::render("devswarm_sup.hk_msg_retire_failed", &[("file", &e.path().display()), ("err", &err)]),
            ));
            break;
        }
        let mut dst = to.join(&name);
        if dst.exists() {
            dst = to.join(format!("{n}.{now}"));
        }
        let days = (age / defaults::num("devswarm_sup.hk_day_ms") as f64).round() as i64;
        match std::fs::rename(e.path(), &dst) {
            Ok(()) => out.push(row(
                &e.path(),
                age,
                t("devswarm_sup.hk_status_fixed"),
                defaults::render("devswarm_sup.hk_msg_retired", &[("file", &e.path().display()), ("to", &dst.display()), ("days", &days)]),
            )),
            Err(err) => out.push(row(
                &e.path(),
                age,
                t("devswarm_sup.hk_status_failed"),
                defaults::render("devswarm_sup.hk_msg_retire_failed", &[("file", &e.path().display()), ("err", &err)]),
            )),
        }
    }
    crate::threads::tally(t("devswarm_sup.hk_beat_counter"), out.iter().filter(|r| r["status"] == t("devswarm_sup.hk_status_fixed")).count() as u64);
    out
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
    results.insert(defaults::text("devswarm_sup.hk_beat_result").to_string(), Value::Array(retire_beats(&root, ctx.now)));
    json!({"ran": true, "results": Value::Object(results)})
}

#[cfg(test)]
mod tests {
    use super::*;

    /// GH #912: stale beats leave the watched heartbeats directory (moved, never deleted); an active workspace's beat, a fresh
    /// beat and a staged temp file stay; a name already retired is not overwritten.
    #[test]
    fn stale_heartbeats_are_moved_out_and_active_or_fresh_ones_stay() {
        let root = std::env::temp_dir().join(format!("ah-hk-beats-{}", std::process::id()));
        crate::discard::harmless(std::fs::remove_dir_all(&root)); // our own scratch directory
        let t = defaults::text;
        let (beats, ws, retired) =
            (root.join(t("mesh_write.dir_heartbeats")), root.join(t("mesh_write.dir_workspaces")), root.join(t("devswarm_sup.hk_beat_retired_dir")));
        for d in [&beats, &ws, &retired] {
            std::fs::create_dir_all(d).unwrap();
        }
        let now = crate::health::now_ms() as i64;
        let old = std::time::SystemTime::now() - std::time::Duration::from_millis(defaults::num("devswarm_sup.hk_beat_retire_ms") + 86_400_000);
        let put = |name: &str, aged: bool| {
            let p = beats.join(name);
            std::fs::write(&p, "{}").unwrap();
            if aged {
                std::fs::File::options().write(true).open(&p).unwrap().set_modified(old).unwrap();
            }
        };
        let staged = format!("gone-2.json{}", t("mesh_write.tmp_suffix"));
        put("gone-1.json", true);
        put("gone-2.json", true);
        put("active.json", true);
        put("fresh.json", false);
        put(&staged, true);
        std::fs::write(ws.join("active.json"), "{}").unwrap();
        std::fs::write(retired.join("gone-2.json"), "earlier").unwrap();
        let rows = retire_beats(&root, now);
        assert_eq!(rows.len(), 2, "{rows:?}");
        assert!(rows.iter().all(|r| r["status"] == t("devswarm_sup.hk_status_fixed")), "{rows:?}");
        assert!(retired.join("gone-1.json").exists() && !beats.join("gone-1.json").exists());
        assert_eq!(std::fs::read_to_string(retired.join("gone-2.json")).unwrap(), "earlier", "an earlier retired beat is never overwritten");
        assert!(retired.join(format!("gone-2.json.{now}")).exists() && !beats.join("gone-2.json").exists());
        for stays in ["active.json", "fresh.json", staged.as_str()] {
            assert!(beats.join(stays).exists(), "{stays} must stay");
        }
        assert!(retire_beats(&root, now).is_empty(), "a second pass has nothing left to move");
        crate::discard::harmless(std::fs::remove_dir_all(&root)); // our own scratch directory
    }
}
