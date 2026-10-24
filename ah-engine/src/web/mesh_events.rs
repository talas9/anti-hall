//! `CTL mesh-events` and `CTL mesh-msg`: the mesh store for the dashboard's traffic view, read-only.
//!
//! `mesh-events db=<store> after=<id> [reads_after=<ms>] [limit=<n>]` returns the `messages` rows with an id above `after`, without
//! their `body` and without heartbeats, plus the `reader_cursors` rows updated after `reads_after` (a read advances one). `mesh-msg
//! db=<store> id=<n> [max=<chars>]` returns one body, scrubbed of the home path and secrets and cut to `max` characters. The store is
//! opened read-only and never waits for a lock; only a file named `mesh_write.store_file` under a `devswarm` directory is opened.
use crate::{defaults, health};
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use std::path::Path;

fn arg(args: &str, key: &str) -> Option<String> {
    args.split_whitespace().find_map(|a| a.strip_prefix(key).map(str::to_string))
}

fn open(args: &str) -> Result<Connection, Value> {
    let err = |k: &str| json!({"error": defaults::text(k)});
    let db = arg(args, "db=").ok_or_else(|| err("mesh_events.msg_no_db"))?;
    let p = Path::new(&db);
    let named = p.file_name().is_some_and(|n| n == defaults::text("mesh_write.store_file"));
    let in_devswarm = p.components().any(|c| c.as_os_str() == defaults::text("mesh_events.dir_component"));
    if !named || !in_devswarm || p.components().any(|c| c.as_os_str() == "..") {
        return Err(err("mesh_events.msg_bad_db"));
    }
    crate::meshw::appdb::open(&db).ok_or_else(|| err("mesh_events.msg_unreadable"))
}

/// `CTL mesh-events`.
pub fn events(args: &str) -> Value {
    let conn = match open(args) {
        Ok(c) => c,
        Err(e) => return e,
    };
    let after: i64 = arg(args, "after=").and_then(|v| v.parse().ok()).unwrap_or(0);
    let reads_after: i64 = arg(args, "reads_after=").and_then(|v| v.parse().ok()).unwrap_or(0);
    let limit = arg(args, "limit=").and_then(|v| v.parse::<i64>().ok()).unwrap_or(i64::MAX).min(defaults::num("mesh_events.limit") as i64);
    // `latest=<n>`: the newest n rows instead of the oldest after `after` (a first look at a store with a long history)
    let latest = arg(args, "latest=").and_then(|v| v.parse::<i64>().ok()).map(|n| n.clamp(1, defaults::num("mesh_events.limit") as i64));
    let (order, limit) = if latest.is_some() { ("DESC", latest.unwrap_or(limit)) } else { ("ASC", limit) };
    let rows = conn.prepare(&defaults::render("mesh_events.sql_messages", &[("order", &order)])).and_then(|mut s| {
        s.query_map(params![after, limit], |r| {
            Ok(json!({"id": r.get::<_, i64>(0)?, "partition": r.get::<_, String>(1)?, "ts": r.get::<_, i64>(2)?, "sender": r.get::<_, Option<String>>(3)?,
                    "recipient": r.get::<_, Option<String>>(4)?, "type": r.get::<_, Option<String>>(5)?, "urgency": r.get::<_, Option<String>>(6)?,
                    "needs_reply": r.get::<_, Option<i64>>(7)?, "seq": r.get::<_, Option<i64>>(8)?, "body_bytes": r.get::<_, Option<i64>>(9)?}))
        })
        .and_then(Iterator::collect::<Result<Vec<_>, _>>)
    });
    let reads = conn
        .prepare(defaults::text("mesh_events.sql_reads"))
        .and_then(|mut s| {
            s.query_map(params![reads_after], |r| {
                Ok(json!({"partition": r.get::<_, String>(0)?, "ns": r.get::<_, String>(1)?, "reader": r.get::<_, String>(2)?, "value": r.get::<_, i64>(3)?, "updated_at": r.get::<_, i64>(4)?}))
            })
            .and_then(Iterator::collect::<Result<Vec<_>, _>>)
        });
    let rows = rows.map(|mut m| {
        if latest.is_some() {
            m.reverse(); // newest-first from the query, oldest-first for the reader
        }
        m
    });
    match (rows, reads) {
        (Ok(m), Ok(c)) => json!({"messages": m, "reads": c, "at_ms": health::now_ms()}),
        (Err(e), _) | (_, Err(e)) => json!({"error": e.to_string()}),
    }
}

/// `CTL mesh-msg`.
pub fn message(args: &str) -> Value {
    let conn = match open(args) {
        Ok(c) => c,
        Err(e) => return e,
    };
    let (Some(id), max) = (arg(args, "id=").and_then(|v| v.parse::<i64>().ok()), arg(args, "max=").and_then(|v| v.parse::<usize>().ok())) else {
        return json!({"error": defaults::text("mesh_events.msg_no_id")});
    };
    let max = max.unwrap_or(usize::MAX).min(defaults::num("mesh_events.body_max") as usize);
    match conn.query_row(defaults::text("mesh_events.sql_body"), params![id], |r| r.get::<_, Option<String>>(0)) {
        Ok(body) => {
            let body = health::scrub(&body.unwrap_or_default());
            let cut = body.chars().count() > max;
            json!({"id": id, "body": body.chars().take(max).collect::<String>(), "truncated": cut})
        }
        Err(e) => json!({"error": e.to_string()}),
    }
}
