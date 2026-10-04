//! Telemetry persistence (D78): the flusher's writes to hot.db, and the reads and rollups the reports use.
//!
//! Writes go through the group-committing writer ([`crate::db::Op::Telemetry`]), reads through the same connections the
//! rest of the Store uses, so telemetry adds no database handle of its own. Counters are kept per UTC day and
//! (k, h, e, o), merged additively; events keep their typed fields and the JSON form of the whole event.
use super::event::{day_of, Event};
use super::recorder::Delta;
use crate::db::{Db, Op};
use crate::error::DbError;
use crate::sql;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use std::sync::Arc;

/// One write the telemetry layer asks the writer thread to apply.
#[derive(Debug, Clone)]
pub enum TelOp {
    /// A flush: add `deltas` to day `day`'s counters and keep `events`.
    Flush {
        /// The UTC day the deltas are added to.
        day: i64,
        /// Counter deltas since the previous flush.
        deltas: Vec<Delta>,
        /// Events since the previous flush.
        events: Vec<Event>,
    },
    /// Imported lines, each with its dedupe key; a line already stored is ignored and not counted again.
    Import {
        /// `(dedupe key, event)`.
        rows: Vec<(String, Event)>,
    },
    /// Remove these counter rows (day, k, h, e, o, count as read) after they were copied to archive.db, then apply the
    /// event retention.
    Prune {
        /// Rows to remove if still unchanged.
        rows: Vec<(i64, String, String, String, String, u64)>,
        /// Events older than this are removed (milliseconds since the epoch).
        events_before_ms: u64,
    },
}

/// A counter row for one day.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DayRow {
    /// UTC day (days since the epoch).
    pub day: i64,
    /// The labels and values.
    pub delta: Delta,
}

/// How a flush ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Flushed {
    /// Committed.
    Stored,
    /// The writer did not answer in time: the write is queued and will probably commit, so it is not retried (retrying
    /// could count it twice).
    Unknown,
    /// Not queued or refused: safe to retry.
    Failed,
}

/// The latency bucket of `us` for the shipped bounds (for imported events, which carry milliseconds).
fn bucket_of(us: u64) -> usize {
    let bounds = defaults_bounds();
    bounds.iter().position(|b| us <= *b).unwrap_or(bounds.len())
}

/// The shipped latency bucket bounds in microseconds.
pub fn defaults_bounds() -> Vec<u64> {
    crate::defaults::raw("telemetry.latency_buckets_us")
        .as_array()
        .unwrap_or_default()
        .iter()
        .filter_map(crate::defaults::V::as_integer)
        .map(|v| v.max(0) as u64)
        .collect()
}

fn hist_json(h: &[u64]) -> String {
    serde_json::to_string(h).unwrap_or_default()
}

fn hist_parse(s: &str) -> Vec<u64> {
    serde_json::from_str(s).unwrap_or_default()
}

/// Add `d` to the stored row for `day`.
fn add_count(c: &Connection, day: i64, d: &Delta) -> Result<(), DbError> {
    let old: Option<(i64, i64, i64, String)> =
        c.prepare_cached(sql::TEL_COUNT_GET)?.query_row(params![day, d.k, d.h, d.e, d.o], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).optional()?;
    let mut m = d.clone();
    if let Some((n, us, ib, hist)) = old {
        m.merge(&Delta {
            k: d.k.clone(),
            h: d.h.clone(),
            e: d.e.clone(),
            o: d.o.clone(),
            n: n.max(0) as u64,
            us_sum: us.max(0) as u64,
            ib_sum: ib.max(0) as u64,
            hist: hist_parse(&hist),
        });
    }
    c.prepare_cached(sql::TEL_COUNT_PUT)?.execute(params![day, m.k, m.h, m.e, m.o, m.n as i64, m.us_sum as i64, m.ib_sum as i64, hist_json(&m.hist)])?;
    Ok(())
}

fn insert_event(c: &Connection, e: &Event, dedupe: Option<&str>) -> Result<usize, DbError> {
    Ok(c.prepare_cached(sql::TEL_EVENT_INSERT)?.execute(params![
        e.ts_ms as i64,
        e.kind.name(),
        e.h.as_str(),
        e.e.as_str(),
        e.o.name(),
        e.ms as i64,
        e.ib as i64,
        e.spawn_key().unwrap_or(""),
        e.to_json().to_string(),
        dedupe
    ])?)
}

/// Apply one telemetry write inside the writer's transaction (called from `db.rs`). The answer is the number of rows
/// the write stored (events inserted for a flush or import).
pub fn apply(c: &Connection, op: &TelOp) -> Result<String, DbError> {
    match op {
        TelOp::Flush { day, deltas, events } => {
            for d in deltas {
                add_count(c, *day, d)?;
            }
            for e in events {
                insert_event(c, e, None)?;
            }
            Ok(events.len().to_string())
        }
        TelOp::Import { rows } => {
            let mut stored = 0;
            for (key, e) in rows {
                // a line stored before is ignored AND not counted again: the count moves only with the insert
                if insert_event(c, e, Some(key))? == 1 {
                    let us = e.ms as u64 * 1000;
                    let mut hist = vec![0; defaults_bounds().len() + 1];
                    hist[bucket_of(us)] = 1;
                    add_count(
                        c,
                        day_of(e.ts_ms),
                        &Delta {
                            k: e.kind.name().into(),
                            h: e.h.as_str().into(),
                            e: e.e.as_str().into(),
                            o: e.o.name().into(),
                            n: 1,
                            us_sum: us,
                            ib_sum: e.ib,
                            hist,
                        },
                    )?;
                    stored += 1;
                }
            }
            Ok(stored.to_string())
        }
        TelOp::Prune { rows, events_before_ms } => {
            for (day, k, h, e, o, n) in rows {
                c.prepare_cached(sql::TEL_COUNT_DELETE_IF)?.execute(params![day, k, h, e, o, *n as i64])?;
            }
            c.prepare_cached(sql::TEL_EVENTS_PRUNE)?.execute(params![*events_before_ms as i64])?;
            c.prepare_cached(sql::TEL_EVENTS_CAP)?.execute(params![crate::defaults::num("telemetry.max_event_rows") as i64])?;
            Ok(String::new())
        }
    }
}

/// Telemetry's view of the databases.
#[derive(Clone)]
pub struct TelDb {
    db: Arc<Db>,
}

fn row_of(r: &rusqlite::Row<'_>) -> rusqlite::Result<DayRow> {
    let n = |i: usize| r.get::<_, i64>(i).map(|v| v.max(0) as u64);
    Ok(DayRow {
        day: r.get(0)?,
        delta: Delta {
            k: r.get(1)?,
            h: r.get(2)?,
            e: r.get(3)?,
            o: r.get(4)?,
            n: n(5)?,
            us_sum: n(6)?,
            ib_sum: n(7)?,
            hist: hist_parse(&r.get::<_, String>(8)?),
        },
    })
}

impl TelDb {
    /// Telemetry over an open database.
    pub fn new(db: Arc<Db>) -> TelDb {
        TelDb { db }
    }

    /// The database.
    pub fn db(&self) -> &Arc<Db> {
        &self.db
    }

    /// Store a flush and wait for its commit.
    pub fn flush(&self, day: i64, deltas: Vec<Delta>, events: Vec<Event>) -> Flushed {
        match self.db.write(Op::Telemetry(TelOp::Flush { day, deltas, events })) {
            Ok(_) => Flushed::Stored,
            Err(DbError::Timeout) => Flushed::Unknown,
            Err(_) => Flushed::Failed,
        }
    }

    /// Store imported lines; the number actually stored (not already there).
    pub fn import(&self, rows: Vec<(String, Event)>) -> Result<u64, DbError> {
        self.db.write(Op::Telemetry(TelOp::Import { rows })).map(|s| s.parse().unwrap_or(0))
    }

    /// Counter rows for days `from..=to` (hot.db).
    pub fn counts(&self, from: i64, to: i64) -> Vec<DayRow> {
        let _ = self.db.barrier();
        self.db.read(|c| c.prepare_cached(sql::TEL_COUNTS_RANGE)?.query_map(params![from, to], row_of)?.collect()).unwrap_or_default()
    }

    /// Daily rollup rows for days `from..=to` (archive.db).
    pub fn daily(&self, from: i64, to: i64) -> Vec<DayRow> {
        self.db
            .archive(|c| Ok(c.prepare_cached(sql::TEL_DAILY_RANGE)?.query_map(params![from, to], row_of)?.collect::<rusqlite::Result<Vec<_>>>()?))
            .unwrap_or_default()
    }

    fn events_from(&self, sql_text: &str, p: &[&dyn rusqlite::ToSql]) -> Vec<Event> {
        let _ = self.db.barrier();
        let texts: Vec<String> = self.db.read(|c| c.prepare_cached(sql_text)?.query_map(p, |r| r.get::<_, String>(0))?.collect()).unwrap_or_default();
        texts.iter().filter_map(|t| serde_json::from_str::<Value>(t).ok()).filter_map(|v| Event::from_json(&v).ok()).collect()
    }

    /// The newest `limit` events of `kind` (empty: any) at or after `since_ms`, oldest first.
    pub fn events(&self, kind: &str, since_ms: u64, limit: usize) -> Vec<Event> {
        let mut v = self.events_from(sql::TEL_EVENTS_RECENT, &[&kind, &(since_ms as i64), &(limit as i64)]);
        v.reverse();
        v
    }

    /// Routing decisions, spawn results and Jev calls at or after `since_ms`, oldest first: what `impact` joins.
    pub fn impact_events(&self, since_ms: u64) -> Vec<Event> {
        self.events_from(sql::TEL_EVENTS_IMPACT, &[&(since_ms as i64)])
    }

    /// Events held in hot.db.
    pub fn held_events(&self) -> u64 {
        let _ = self.db.barrier();
        self.db.read(|c| c.query_row(sql::TEL_EVENTS_HELD, [], |r| r.get::<_, i64>(0))).map(|n| n.max(0) as u64).unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::super::event::{Extras, Kind, Outcome, Token};
    use super::*;
    use crate::db::TempDir;

    fn delta(h: &str, n: u64) -> Delta {
        Delta { k: "hook".into(), h: h.into(), e: "Stop".into(), o: "allow".into(), n, us_sum: n * 10, ib_sum: n, hist: vec![n, 0, 0] }
    }

    fn event(ts: u64) -> Event {
        Event {
            ts_ms: ts,
            kind: Kind::Spill,
            h: Token::new("hook").unwrap(),
            e: Token::new("Stop").unwrap(),
            o: Outcome::Advise,
            ms: 1,
            ib: 5,
            extras: Extras::Spill(5),
        }
    }

    #[test]
    fn flushes_add_up_per_day_and_survive_reopening() {
        let d = TempDir::new("tel-flush");
        {
            let t = TelDb::new(Db::open(&d.0).unwrap());
            assert_eq!(t.flush(10, vec![delta("a", 2), delta("b", 1)], vec![event(864_000_000)]), Flushed::Stored);
            assert_eq!(t.flush(10, vec![delta("a", 3)], vec![]), Flushed::Stored);
            assert_eq!(t.flush(11, vec![delta("a", 1)], vec![]), Flushed::Stored);
            t.db().close();
        }
        let t = TelDb::new(Db::open(&d.0).unwrap());
        let rows = t.counts(0, 100);
        let a10 = rows.iter().find(|r| r.day == 10 && r.delta.h == "a").unwrap();
        assert_eq!((a10.delta.n, a10.delta.us_sum, a10.delta.hist.clone()), (5, 50, vec![5, 0, 0]));
        assert_eq!(rows.iter().filter(|r| r.day == 11).count(), 1);
        assert_eq!(t.events("", 0, 10).len(), 1);
        assert_eq!(t.held_events(), 1);
    }

    #[test]
    fn an_import_counts_a_line_only_when_it_is_new() {
        let d = TempDir::new("tel-import");
        let t = TelDb::new(Db::open(&d.0).unwrap());
        let rows = vec![("f:1:aa".to_string(), event(1000)), ("f:2:bb".to_string(), event(2000))];
        assert_eq!(t.import(rows.clone()).unwrap(), 2);
        assert_eq!(t.import(rows).unwrap(), 0, "the same lines again store nothing");
        let n: u64 = t.counts(0, 10).iter().map(|r| r.delta.n).sum();
        assert_eq!(n, 2, "and count nothing");
        assert_eq!(t.held_events(), 2);
    }
}
