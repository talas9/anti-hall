//! Daily rollups (D78): counts, sums and latency histograms per (k, h, e, o), copied from hot.db into archive.db.
//!
//! hot.db keeps one counter row per UTC day and combination, so a day's rollup is a copy of its rows. The copy REPLACES
//! the archive row, so running it again (or twice, or after a crash half way) leaves the same rows: it is idempotent. A
//! hot row is removed only after it is archived, only once its day is older than `telemetry.retention_days`, and only if
//! it has not changed since it was copied, so nothing recorded in between is lost. A flush is always tagged with the day
//! it happens in, so nothing is ever added to a day after its hot row was pruned. Old events are pruned by the same retention. The scheduler runs it once a day (job `telemetry_rollup`, D33), and `ah-engine telemetry rollup` runs it by hand.
use super::event::{day_of, DAY_MS};
use super::persist::{DayRow, TelDb, TelOp};
use crate::db::Op;
use crate::error::DbError;
use crate::sql;
use rusqlite::params;
use serde_json::{json, Value};
use std::collections::BTreeMap;

impl TelDb {
    /// Roll up every complete day (before the day of `now_ms`) into archive.db and apply the retention. Returns a report.
    pub fn rollup(&self, now_ms: u64, retention_days: u64) -> Result<Value, DbError> {
        let today = day_of(now_ms);
        let rows = self.counts(0, today - 1);
        let archived = self.db().archive(|c| {
            let tx = c.transaction()?;
            for r in &rows {
                let d = &r.delta;
                tx.prepare_cached(sql::TEL_DAILY_PUT)?.execute(params![
                    r.day,
                    d.k,
                    d.h,
                    d.e,
                    d.o,
                    d.n as i64,
                    d.us_sum as i64,
                    d.ib_sum as i64,
                    serde_json::to_string(&d.hist).unwrap_or_default()
                ])?;
            }
            tx.commit()?; // archived and synced before anything leaves hot.db
            Ok(rows.len())
        })?;
        let keep_from = today - retention_days as i64;
        let old: Vec<_> = rows
            .iter()
            .filter(|r| r.day < keep_from)
            .map(|r| (r.day, r.delta.k.clone(), r.delta.h.clone(), r.delta.e.clone(), r.delta.o.clone(), r.delta.n))
            .collect();
        let pruned = old.len();
        self.db().write(Op::Telemetry(TelOp::Prune { rows: old, events_before_ms: now_ms.saturating_sub(retention_days * DAY_MS) }))?;
        let days: std::collections::BTreeSet<i64> = rows.iter().map(|r| r.day).collect();
        Ok(json!({
            "through_day": today - 1,
            "days_rolled": days.len(),
            "rows_archived": archived,
            "rows_pruned_from_hot": pruned,
            "retention_days": retention_days,
            "events_held": self.held_events(),
        }))
    }
}

/// Merge hot and archived rows for the same window: for a (day, k, h, e, o) present in both, the hot row wins (it is
/// cumulative, so it holds at least what was archived).
pub fn merge_days(hot: Vec<DayRow>, archived: Vec<DayRow>) -> Vec<DayRow> {
    let mut by: BTreeMap<(i64, String, String, String, String), DayRow> = BTreeMap::new();
    for r in archived.into_iter().chain(hot) {
        by.insert((r.day, r.delta.k.clone(), r.delta.h.clone(), r.delta.e.clone(), r.delta.o.clone()), r);
    }
    by.into_values().collect()
}

#[cfg(test)]
mod tests {
    use super::super::recorder::Delta;
    use super::*;
    use crate::db::{Db, TempDir};

    fn delta(h: &str, o: &str, n: u64) -> Delta {
        Delta { k: "check".into(), h: h.into(), e: "PreToolUse".into(), o: o.into(), n, us_sum: n * 100, ib_sum: n * 7, hist: vec![n, 0, 0] }
    }

    #[test]
    fn rollup_copies_complete_days_to_archive_and_is_idempotent() {
        let d = TempDir::new("tel-rollup");
        let t = TelDb::new(Db::open(&d.0).unwrap());
        t.flush(100, vec![delta("git", "block", 3), delta("git", "allow", 10)], vec![]);
        t.flush(100, vec![delta("git", "block", 2)], vec![]);
        t.flush(101, vec![delta("git", "allow", 4)], vec![]);
        let now = 102 * DAY_MS + 5;
        let first = t.rollup(now, 30).unwrap();
        assert_eq!((first["days_rolled"].as_u64(), first["rows_archived"].as_u64(), first["rows_pruned_from_hot"].as_u64()), (Some(2), Some(3), Some(0)));
        let after_first = t.daily(0, 200);
        // again, and again: the same rows
        t.rollup(now, 30).unwrap();
        t.rollup(now + 1000, 30).unwrap();
        let after_third = t.daily(0, 200);
        assert_eq!(after_first, after_third);
        let block = after_third.iter().find(|r| r.day == 100 && r.delta.o == "block").unwrap();
        assert_eq!((block.delta.n, block.delta.us_sum, block.delta.ib_sum, block.delta.hist.clone()), (5, 500, 35, vec![5, 0, 0]));
        assert_eq!(t.counts(0, 200).len(), 3, "within retention the hot rows stay");
        // a day that is not complete is never rolled up
        t.flush(102, vec![delta("git", "allow", 1)], vec![]);
        t.rollup(now, 30).unwrap();
        assert!(t.daily(102, 102).is_empty());
    }

    #[test]
    fn rows_past_retention_leave_hot_only_after_they_are_archived_and_only_if_unchanged() {
        let d = TempDir::new("tel-retention");
        let t = TelDb::new(Db::open(&d.0).unwrap());
        t.flush(10, vec![delta("git", "allow", 4)], vec![]);
        t.flush(100, vec![delta("git", "allow", 1)], vec![]);
        let now = 101 * DAY_MS;
        let r = t.rollup(now, 30).unwrap();
        assert_eq!(r["rows_pruned_from_hot"], 1);
        assert_eq!(t.counts(0, 200).len(), 1, "the old row left hot");
        assert_eq!(t.daily(10, 10)[0].delta.n, 4, "and is in the archive");
        // merged view: both are visible
        let merged = merge_days(t.counts(0, 200), t.daily(0, 200));
        assert_eq!(merged.iter().map(|r| r.delta.n).sum::<u64>(), 5);
    }
}
