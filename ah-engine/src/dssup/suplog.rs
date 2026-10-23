//! Rotation of the supervision event log (`logs/devswarm-supervision.ndjson`), Node's `rotateIfNeeded` of
//! `companion/lib/devswarm-supervision-metrics.js`: past `mesh_write.supervision_max_bytes` the daily roll-ups are written from every
//! retained generation (so the report keeps the days the oldest generation takes with it), then the generations shift up to
//! `mesh_write.supervision_rotated_files`. Nothing is lost: when the roll-ups cannot be built (a row with a name JavaScript orders
//! specially, which the report leaves to Node), the oldest generation is not replaced; the chain grows by one instead.
// Discard triage (E3): every `harmless` in this file is a deliberate keep, for these reasons:
// - a missing generation in the chain is a gap (Node: `try { renameSync } catch (_) { /* gap in the chain */ }`)
// - a failed rename of the live file leaves it oversized, as Node's catch does; the next pass tries again
use crate::checks::jsport::date::{self, Parsed};
use crate::defaults;
use crate::meshw::reportverbs::{build_daily, log_files, read_rows};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

fn logs_dir(home: &Path) -> PathBuf {
    home.join(defaults::text("mesh_write.dir_anti_hall")).join(defaults::text("mesh_write.dir_logs"))
}

/// The supervision log's path.
pub fn log_path(home: &Path) -> PathBuf {
    logs_dir(home).join(defaults::text("mesh_write.supervision_log"))
}

fn generation(p: &Path, n: u64) -> PathBuf {
    let mut s = p.as_os_str().to_os_string();
    s.push(format!(".{n}"));
    PathBuf::from(s)
}

/// The highest numbered generation of the log on disk, 0 when there is none.
fn highest_generation(p: &Path) -> u64 {
    let (Some(dir), Some(base)) = (p.parent(), p.file_name().map(|b| b.to_string_lossy().into_owned())) else { return 0 };
    std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| e.file_name().to_string_lossy().strip_prefix(&format!("{base}."))?.parse::<u64>().ok())
        .max()
        .unwrap_or(0)
}

/// `writeDailyRollups(home)`: one file per UTC day from every retained generation, written just before the oldest generation is
/// replaced. A day is (re)written when all its rows are still on disk, or when it has no roll-up yet. `Err` when the rows cannot be
/// rolled up here (see the module doc); `Ok(files written)` otherwise.
fn write_daily_rollups(home: &Path) -> Result<usize, String> {
    let logs = logs_dir(home);
    let files = log_files(&logs, defaults::text("mesh_write.supervision_log")).map_err(|d| d.0)?;
    let rows = read_rows(&files);
    let days = build_daily(&rows).map_err(|d| d.0)?;
    let ms = |s: &str| match date::parse(s) {
        Parsed::Ms(x) if x.is_finite() => Some(x),
        _ => None,
    };
    let oldest = rows.iter().filter_map(|r| match r.get("ts") {
        Some(crate::checks::guardkit::ojson::OVal::Str(t)) => ms(t),
        _ => None,
    });
    let oldest = oldest.fold(f64::INFINITY, f64::min);
    let dir = logs.join(defaults::text("devswarm_cli.sr_daily_dir"));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut written = 0;
    for (day, roll) in days {
        let file = dir.join(format!("{day}{}", defaults::text("mesh_write.json_suffix")));
        let complete = ms(&format!("{day}{}", defaults::text("devswarm_sup.sl_day_start"))).is_some_and(|d| d >= oldest);
        if !complete && file.exists() {
            continue;
        }
        if crate::atomic::write(&file, roll.to_file_value(&day, complete).stringify()).is_ok() {
            written += 1;
        }
    }
    Ok(written)
}

/// Rotate the supervision log when it is over its limit. The record names what happened; a log under the limit (or absent) is left alone.
pub fn rotate_if_needed(home: &Path) -> Value {
    let p = log_path(home);
    let Ok(md) = std::fs::metadata(&p) else { return json!({"rotated": false, "size": 0, "reason": defaults::text("devswarm_sup.reason_no_log")}) };
    if md.len() <= defaults::num("mesh_write.supervision_max_bytes") {
        return json!({"rotated": false, "size": md.len(), "reason": defaults::text("devswarm_sup.reason_under")});
    }
    let keep = defaults::num("mesh_write.supervision_rotated_files").max(1);
    let (rollups, top) = match write_daily_rollups(home) {
        Ok(n) => (Some(n), keep.saturating_sub(1)),
        // the roll-ups for the generation that would be replaced do not exist: keep it, shift the whole chain up
        Err(why) => {
            crate::discard::logged("dssup_suplog_rollups", Err::<(), _>(why));
            (None, highest_generation(&p).max(keep.saturating_sub(1)))
        }
    };
    for i in (1..=top).rev() {
        crate::discard::harmless(std::fs::rename(generation(&p, i), generation(&p, i + 1))); // gap in the chain
    }
    match std::fs::rename(&p, generation(&p, 1)) {
        Ok(()) => {
            json!({"rotated": true, "size": md.len(), "rollups": rollups, "reason": defaults::render("devswarm_sup.reason_rotated", &[("backup", &generation(&p, 1).display())])})
        }
        Err(e) => json!({"rotated": false, "size": md.len(), "reason": defaults::render("devswarm_sup.reason_rotate_failed", &[("err", &e)])}),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(tag: &str, signal: &str) -> (crate::db::TempDir, PathBuf) {
        crate::defaults::init().unwrap();
        let dir = crate::db::TempDir::new(tag);
        let home = dir.0.join("home");
        let p = log_path(&home);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        let row = format!("{{\"ts\":\"2025-10-09T08:00:00.000Z\",\"type\":\"warn\",\"id\":\"w1\",\"signal\":\"{signal}\",\"repeat\":false}}\n");
        let n = defaults::num("mesh_write.supervision_max_bytes") as usize / row.len() + 2;
        std::fs::write(&p, row.repeat(n)).unwrap();
        (dir, home)
    }

    #[test]
    fn dssup_suplog_rotates_past_the_limit_after_rolling_up_its_days() {
        let (_dir, home) = fixture("suplog-rotate", "stall");
        let p = log_path(&home);
        // an older generation already holds a day that must survive in the roll-ups
        std::fs::write(generation(&p, 1), "{\"ts\":\"2025-10-01T00:00:00.000Z\",\"type\":\"plan\"}\n").unwrap();
        let out = rotate_if_needed(&home);
        assert_eq!(out["rotated"], true, "{out}");
        assert!(!p.exists(), "the live file moved to .1");
        assert!(generation(&p, 1).exists() && generation(&p, 2).exists(), "the chain shifted up");
        let daily = p.parent().unwrap().join(defaults::text("devswarm_cli.sr_daily_dir"));
        let day: Value = serde_json::from_str(&std::fs::read_to_string(daily.join("2025-10-09.json")).unwrap()).unwrap();
        assert_eq!(day["complete"], true);
        assert!(day["warnings"]["stall"].as_u64().unwrap() > 0);
        assert!(day["jev"].is_object() && day["day"] == "2025-10-09");
        assert!(daily.join("2025-10-01.json").exists());
        // under the limit (a fresh, empty log) nothing moves
        std::fs::write(&p, "{}\n").unwrap();
        assert_eq!(rotate_if_needed(&home)["rotated"], false);
    }

    #[test]
    fn dssup_suplog_keeps_the_oldest_generation_when_rows_cannot_be_rolled_up() {
        // a signal named like an array index is a name the report leaves to Node: no roll-up, so no generation may be dropped
        let (_dir, home) = fixture("suplog-keep", "7");
        let p = log_path(&home);
        let keep = defaults::num("mesh_write.supervision_rotated_files");
        for i in 1..=keep {
            std::fs::write(generation(&p, i), format!("gen {i}\n")).unwrap();
        }
        let out = rotate_if_needed(&home);
        assert_eq!(out["rotated"], true, "{out}");
        assert_eq!(std::fs::read_to_string(generation(&p, keep + 1)).unwrap(), format!("gen {keep}\n"), "the oldest generation is kept one place up");
        assert!(!p.parent().unwrap().join(defaults::text("devswarm_cli.sr_daily_dir")).join("2025-10-09.json").exists());
    }
}
