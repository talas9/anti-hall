//! SQL text: the schema migrations and every statement the engine runs (D19, D21).
//!
//! Why here and not in `defaults/*.toml`: the schema is code. It is versioned with the binary through the migration
//! lists below, a migration is never edited after it ships (a new one is appended instead), and a user override of a
//! table definition could only corrupt data. Values that are tunable (retention, caps, limits) are bound as
//! parameters at run time and come from the defaults; nothing tunable is written into a statement.

/// hot.db migrations, applied in order; `PRAGMA user_version` records how many have run. Append only.
pub const HOT_MIGRATIONS: &[&str] = &[HOT_V1, HOT_V2, HOT_V3, HOT_V4, HOT_V5, HOT_V6];

/// archive.db migrations, applied in order; `PRAGMA user_version` records how many have run. Append only.
pub const ARCHIVE_MIGRATIONS: &[&str] = &[ARCHIVE_V1, ARCHIVE_V2, ARCHIVE_V3, ARCHIVE_V4];

/// hot.db v1: the impact ledger (one row per event) and its exact per-combination totals (D52).
const HOT_V1: &str = "
CREATE TABLE IF NOT EXISTS impact (id INTEGER PRIMARY KEY, ts_ms INTEGER NOT NULL, kind TEXT NOT NULL, check_name TEXT NOT NULL, reason TEXT NOT NULL, project TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS impact_totals (kind TEXT NOT NULL, check_name TEXT NOT NULL, reason TEXT NOT NULL, project TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (kind, check_name, reason, project)) WITHOUT ROWID;
";

/// hot.db v2: per-project key-value pairs (with optional expiry) and mailboxes (a consumed message is marked, never
/// deleted), plus the write ids already applied, which make a retried or spooled write idempotent (D20-D24).
const HOT_V2: &str = "
CREATE TABLE IF NOT EXISTS kv (project TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, expires_ms INTEGER, updated_ms INTEGER NOT NULL, PRIMARY KEY (project, key)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS mailbox (id INTEGER PRIMARY KEY, project TEXT NOT NULL, body TEXT NOT NULL, created_ms INTEGER NOT NULL, consumed_ms INTEGER);
CREATE INDEX IF NOT EXISTS mailbox_pending ON mailbox (project, consumed_ms, id);
CREATE TABLE IF NOT EXISTS applied (write_id TEXT PRIMARY KEY, ts_ms INTEGER NOT NULL, result TEXT NOT NULL) WITHOUT ROWID;
";

/// hot.db v3: one row per maintenance run with its report (D26), so the runs are visible in metrics and status.
const HOT_V3: &str = "
CREATE TABLE IF NOT EXISTS maintenance (id INTEGER PRIMARY KEY, ts_ms INTEGER NOT NULL, report TEXT NOT NULL);
";

/// hot.db v4: the latest metrics snapshot (D51), one row, replaced on every snapshot: it is derived from the running
/// counters, so only the newest one matters.
const HOT_V4: &str = "
CREATE TABLE IF NOT EXISTS metrics_snapshot (id INTEGER PRIMARY KEY CHECK (id = 1), ts_ms INTEGER NOT NULL, body TEXT NOT NULL);
";

/// hot.db v5: the scheduler (D33): each persisted job's schedule, and one row per run (persisted jobs: every run;
/// others: failed runs only).
const HOT_V5: &str = "
CREATE TABLE IF NOT EXISTS schedule_state (job TEXT PRIMARY KEY, next_ms INTEGER NOT NULL, failures INTEGER NOT NULL, cooldown_until_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS schedule_runs (id INTEGER PRIMARY KEY, job TEXT NOT NULL, due_ms INTEGER NOT NULL, started_ms INTEGER NOT NULL, ended_ms INTEGER, status TEXT NOT NULL, attempt INTEGER NOT NULL, detail TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS schedule_runs_job ON schedule_runs (job, id);
";

/// archive.db v3: metric rollups (D51), one row per resolution and time bucket holding the snapshot at the bucket's end.
const ARCHIVE_V3: &str = "
CREATE TABLE IF NOT EXISTS metrics_rollup (resolution TEXT NOT NULL, bucket_ms INTEGER NOT NULL, ts_ms INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY (resolution, bucket_ms)) WITHOUT ROWID;
";

/// archive.db v2: consumed messages and expired key values moved out of hot.db (D26). A message keeps its id and a
/// value keys on (project, key, updated_ms), so a repeated move is a no-op.
const ARCHIVE_V2: &str = "
CREATE TABLE IF NOT EXISTS mailbox (id INTEGER PRIMARY KEY, project TEXT NOT NULL, body TEXT NOT NULL, created_ms INTEGER NOT NULL, consumed_ms INTEGER, archived_ms INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS kv (project TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, expires_ms INTEGER, updated_ms INTEGER NOT NULL, archived_ms INTEGER NOT NULL, PRIMARY KEY (project, key, updated_ms)) WITHOUT ROWID;
";

/// archive.db v1: impact events moved out of hot.db keep their id, so a repeated move is a no-op.
const ARCHIVE_V1: &str = "
CREATE TABLE IF NOT EXISTS impact (id INTEGER PRIMARY KEY, ts_ms INTEGER NOT NULL, kind TEXT NOT NULL, check_name TEXT NOT NULL, reason TEXT NOT NULL, project TEXT NOT NULL, archived_ms INTEGER NOT NULL);
";

/// Record one impact event.
pub const IMPACT_INSERT: &str = "INSERT INTO impact (ts_ms, kind, check_name, reason, project) VALUES (?1, ?2, ?3, ?4, ?5)";

/// Count one impact event in its combination's total.
pub const IMPACT_COUNT: &str = "INSERT INTO impact_totals (kind, check_name, reason, project, count) VALUES (?1, ?2, ?3, ?4, 1) ON CONFLICT (kind, check_name, reason, project) DO UPDATE SET count = count + 1";

/// Exact totals, optionally narrowed by kind (?1) and project (?2); an empty filter matches everything.
pub const IMPACT_TOTALS: &str = "SELECT kind, check_name, reason, project, count FROM impact_totals WHERE (?1 = '' OR kind = ?1) AND (?2 = '' OR project = ?2) ORDER BY kind, check_name, reason, project";

/// The newest events held in hot.db, newest first, filtered like `IMPACT_TOTALS`, at most ?3.
pub const IMPACT_RECENT: &str =
    "SELECT ts_ms, kind, check_name, reason, project FROM impact WHERE (?1 = '' OR kind = ?1) AND (?2 = '' OR project = ?2) ORDER BY id DESC LIMIT ?3";

/// Events held in hot.db.
pub const IMPACT_HELD: &str = "SELECT COUNT(*) FROM impact";

/// The result recorded for a write id, if it was applied.
pub const APPLIED_GET: &str = "SELECT result FROM applied WHERE write_id = ?1";

/// Record that a write id was applied, with its result.
pub const APPLIED_PUT: &str = "INSERT INTO applied (write_id, ts_ms, result) VALUES (?1, ?2, ?3)";

/// True when the project holds a key or a pending message.
pub const PROJECT_KNOWN: &str =
    "SELECT EXISTS (SELECT 1 FROM kv WHERE project = ?1) OR EXISTS (SELECT 1 FROM mailbox WHERE project = ?1 AND consumed_ms IS NULL)";

/// Projects holding a key or a pending message.
pub const PROJECT_COUNT: &str = "SELECT COUNT(*) FROM (SELECT project FROM kv UNION SELECT project FROM mailbox WHERE consumed_ms IS NULL)";

/// Pending (unconsumed) messages of a project.
pub const MAIL_PENDING: &str = "SELECT COUNT(*) FROM mailbox WHERE project = ?1 AND consumed_ms IS NULL";

/// Append a message.
pub const MAIL_PUT: &str = "INSERT INTO mailbox (project, body, created_ms) VALUES (?1, ?2, ?3)";

/// The oldest pending message of a project.
pub const MAIL_NEXT: &str = "SELECT id, body FROM mailbox WHERE project = ?1 AND consumed_ms IS NULL ORDER BY id LIMIT 1";

/// Mark a message consumed.
pub const MAIL_CONSUME: &str = "UPDATE mailbox SET consumed_ms = ?2 WHERE id = ?1";

/// True when a key holds a value that has not expired at ?3.
pub const KV_ACTIVE: &str = "SELECT EXISTS (SELECT 1 FROM kv WHERE project = ?1 AND key = ?2 AND (expires_ms IS NULL OR expires_ms > ?3))";

/// Keys of a project whose values have not expired at ?2.
pub const KV_COUNT: &str = "SELECT COUNT(*) FROM kv WHERE project = ?1 AND (expires_ms IS NULL OR expires_ms > ?2)";

/// Set a key.
pub const KV_SET: &str = "INSERT INTO kv (project, key, value, expires_ms, updated_ms) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT (project, key) DO UPDATE SET value = excluded.value, expires_ms = excluded.expires_ms, updated_ms = excluded.updated_ms";

/// A key's value and expiry.
pub const KV_GET: &str = "SELECT value, expires_ms FROM kv WHERE project = ?1 AND key = ?2";

/// Consumed messages at or before ?1, oldest first, at most ?2.
pub const MAIL_ARCHIVABLE: &str =
    "SELECT id, project, body, created_ms, consumed_ms FROM mailbox WHERE consumed_ms IS NOT NULL AND consumed_ms <= ?1 ORDER BY id LIMIT ?2";

/// Copy a message into archive.db.
pub const ARCH_MAIL_INSERT: &str = "INSERT OR IGNORE INTO mailbox (id, project, body, created_ms, consumed_ms, archived_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6)";

/// Remove an archived message from hot.db (only if it is still consumed).
pub const MAIL_DELETE_ARCHIVED: &str = "DELETE FROM mailbox WHERE id = ?1 AND consumed_ms IS NOT NULL";

/// Key values that expired at or before ?1, oldest first, at most ?2.
pub const KV_ARCHIVABLE: &str =
    "SELECT project, key, value, expires_ms, updated_ms FROM kv WHERE expires_ms IS NOT NULL AND expires_ms <= ?1 ORDER BY updated_ms LIMIT ?2";

/// Copy a key value into archive.db.
pub const ARCH_KV_INSERT: &str = "INSERT OR IGNORE INTO kv (project, key, value, expires_ms, updated_ms, archived_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6)";

/// Remove an archived key value from hot.db, only if nobody set the key again since it was copied.
pub const KV_DELETE_ARCHIVED: &str = "DELETE FROM kv WHERE project = ?1 AND key = ?2 AND updated_ms = ?3 AND expires_ms IS NOT NULL AND expires_ms <= ?4";

/// The id at the hot.db impact cap: events with this id or older are beyond the cap (no row when under it).
pub const IMPACT_CAP_ID: &str = "SELECT id FROM impact ORDER BY id DESC LIMIT 1 OFFSET ?1";

/// Impact events at or before ?1 or with an id at or below ?2, oldest first, at most ?3.
pub const IMPACT_ARCHIVABLE: &str = "SELECT id, ts_ms, kind, check_name, reason, project FROM impact WHERE ts_ms <= ?1 OR id <= ?2 ORDER BY id LIMIT ?3";

/// Copy an impact event into archive.db.
pub const ARCH_IMPACT_INSERT: &str =
    "INSERT OR IGNORE INTO impact (id, ts_ms, kind, check_name, reason, project, archived_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)";

/// Remove an archived impact event from hot.db (its totals stay in impact_totals).
pub const IMPACT_DELETE_ARCHIVED: &str = "DELETE FROM impact WHERE id = ?1";

/// Forget applied write ids recorded at or before ?1 (derived bookkeeping, D59).
pub const APPLIED_PRUNE: &str = "DELETE FROM applied WHERE ts_ms <= ?1";

/// Archived user data older than ?1, removed only when `retention.archive_delete_after_s` is set (D26).
pub const ARCH_DELETE_MAIL: &str = "DELETE FROM mailbox WHERE archived_ms <= ?1";

/// See `ARCH_DELETE_MAIL`.
pub const ARCH_DELETE_KV: &str = "DELETE FROM kv WHERE archived_ms <= ?1";

/// See `ARCH_DELETE_MAIL`.
pub const ARCH_DELETE_IMPACT: &str = "DELETE FROM impact WHERE archived_ms <= ?1";

/// Record a maintenance run.
pub const MAINT_LOG: &str = "INSERT INTO maintenance (ts_ms, report) VALUES (?1, ?2)";

/// Maintenance runs so far and when the last one ran.
pub const MAINT_STATS: &str = "SELECT COUNT(*), COALESCE(MAX(ts_ms), 0) FROM maintenance";

/// True when a table exists.
pub const TABLE_EXISTS: &str = "SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)";

/// The distinct values of one text column; `{table}` and `{col}` come from `backup.scrub_columns`.
pub const SCRUB_SELECT: &str = "SELECT DISTINCT {col} FROM {table}";

/// Replace one value of a column everywhere it occurs; placeholders as in `SCRUB_SELECT`.
pub const SCRUB_UPDATE: &str = "UPDATE {table} SET {col} = ?2 WHERE {col} = ?1";

/// Replace the metrics snapshot.
pub const METRICS_SAVE: &str =
    "INSERT INTO metrics_snapshot (id, ts_ms, body) VALUES (1, ?1, ?2) ON CONFLICT (id) DO UPDATE SET ts_ms = excluded.ts_ms, body = excluded.body";

/// The metrics snapshot.
pub const METRICS_LOAD: &str = "SELECT ts_ms, body FROM metrics_snapshot WHERE id = 1";

/// Record (or replace) the rollup of one resolution and bucket.
pub const ROLLUP_SAVE: &str = "INSERT INTO metrics_rollup (resolution, bucket_ms, ts_ms, body) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (resolution, bucket_ms) DO UPDATE SET ts_ms = excluded.ts_ms, body = excluded.body";

/// Rollups of one resolution from bucket ?2 on, oldest first.
pub const ROLLUP_LIST: &str = "SELECT bucket_ms, ts_ms, body FROM metrics_rollup WHERE resolution = ?1 AND bucket_ms >= ?2 ORDER BY bucket_ms";

/// Forget rollups of one resolution older than bucket ?2 (derived data, D59).
pub const ROLLUP_PRUNE: &str = "DELETE FROM metrics_rollup WHERE resolution = ?1 AND bucket_ms < ?2";

/// Save one job's schedule.
pub const SCHED_SAVE: &str = "INSERT INTO schedule_state (job, next_ms, failures, cooldown_until_ms, updated_ms) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT (job) DO UPDATE SET next_ms = excluded.next_ms, failures = excluded.failures, cooldown_until_ms = excluded.cooldown_until_ms, updated_ms = excluded.updated_ms";

/// Every saved schedule.
pub const SCHED_LOAD: &str = "SELECT job, next_ms, failures, cooldown_until_ms FROM schedule_state";

/// Record a run that starts now (status running).
pub const RUN_START: &str = "INSERT INTO schedule_runs (job, due_ms, started_ms, status, attempt, detail) VALUES (?1, ?2, ?3, ?4, ?5, '')";

/// Record how a run ended.
pub const RUN_END: &str = "UPDATE schedule_runs SET ended_ms = ?2, status = ?3, detail = ?4 WHERE id = ?1";

/// Record a finished run in one go (a job that keeps only failed runs).
pub const RUN_INSERT: &str = "INSERT INTO schedule_runs (job, due_ms, started_ms, ended_ms, status, attempt, detail) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)";

/// Runs a killed daemon left as running: they were interrupted.
pub const RUN_INTERRUPTED: &str = "UPDATE schedule_runs SET status = ?2, ended_ms = ?1 WHERE status = ?3";

/// The newest runs, optionally of one job (?1, empty for all), at most ?2, newest first.
pub const RUN_HISTORY: &str =
    "SELECT id, job, due_ms, started_ms, ended_ms, status, attempt, detail FROM schedule_runs WHERE (?1 = '' OR job = ?1) ORDER BY id DESC LIMIT ?2";

/// Forget run history older than ?1 (derived log, D59).
pub const RUN_PRUNE: &str = "DELETE FROM schedule_runs WHERE started_ms <= ?1 AND status != ?2";
/// hot.db v6: telemetry (D78). Per-day counters per (k, h, e, o) with a latency histogram (JSON), and the rich events
/// (routing decisions, spawn results, Jev calls, spills) with the fields they are joined on.
const HOT_V6: &str = "
CREATE TABLE IF NOT EXISTS tel_counts (day INTEGER NOT NULL, k TEXT NOT NULL, h TEXT NOT NULL, e TEXT NOT NULL, o TEXT NOT NULL, n INTEGER NOT NULL, us_sum INTEGER NOT NULL, ib_sum INTEGER NOT NULL, hist TEXT NOT NULL, PRIMARY KEY (day, k, h, e, o)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS tel_events (id INTEGER PRIMARY KEY, ts_ms INTEGER NOT NULL, k TEXT NOT NULL, h TEXT NOT NULL, e TEXT NOT NULL, o TEXT NOT NULL, ms INTEGER NOT NULL, ib INTEGER NOT NULL, spawn_key TEXT NOT NULL, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS tel_events_ts ON tel_events (ts_ms);
CREATE INDEX IF NOT EXISTS tel_events_spawn ON tel_events (spawn_key);
";

/// archive.db v4: the daily telemetry rollups (D78), one row per day and (k, h, e, o); a re-run replaces a day's rows.
const ARCHIVE_V4: &str = "
CREATE TABLE IF NOT EXISTS tel_daily (day INTEGER NOT NULL, k TEXT NOT NULL, h TEXT NOT NULL, e TEXT NOT NULL, o TEXT NOT NULL, n INTEGER NOT NULL, us_sum INTEGER NOT NULL, ib_sum INTEGER NOT NULL, hist TEXT NOT NULL, PRIMARY KEY (day, k, h, e, o)) WITHOUT ROWID;
";

/// One day's counter row for a combination (?1 day, ?2 k, ?3 h, ?4 e, ?5 o), if any.
pub const TEL_COUNT_GET: &str = "SELECT n, us_sum, ib_sum, hist FROM tel_counts WHERE day = ?1 AND k = ?2 AND h = ?3 AND e = ?4 AND o = ?5";

/// Set a day's counter row (the caller merged the old values in).
pub const TEL_COUNT_PUT: &str = "INSERT INTO tel_counts (day, k, h, e, o, n, us_sum, ib_sum, hist) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) ON CONFLICT (day, k, h, e, o) DO UPDATE SET n = excluded.n, us_sum = excluded.us_sum, ib_sum = excluded.ib_sum, hist = excluded.hist";

/// Counter rows for days ?1 to ?2 inclusive.
pub const TEL_COUNTS_RANGE: &str = "SELECT day, k, h, e, o, n, us_sum, ib_sum, hist FROM tel_counts WHERE day >= ?1 AND day <= ?2 ORDER BY day, k, h, e, o";

/// Remove a counter row that is still exactly as it was read (?6 is the count then): nothing newer is lost.
pub const TEL_COUNT_DELETE_IF: &str = "DELETE FROM tel_counts WHERE day = ?1 AND k = ?2 AND h = ?3 AND e = ?4 AND o = ?5 AND n = ?6";

/// Store an event.
pub const TEL_EVENT_INSERT: &str = "INSERT INTO tel_events (ts_ms, k, h, e, o, ms, ib, spawn_key, data) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)";

/// The newest events of kind ?1 (empty: any) at or after ?2, newest first, at most ?3.
pub const TEL_EVENTS_RECENT: &str = "SELECT data FROM tel_events WHERE (?1 = '' OR k = ?1) AND ts_ms >= ?2 ORDER BY id DESC LIMIT ?3";

/// The events the impact report joins (routing decisions, spawn results, Jev calls) at or after ?1, oldest first.
pub const TEL_EVENTS_IMPACT: &str = "SELECT data FROM tel_events WHERE ts_ms >= ?1 AND k IN ('route', 'spawn', 'jev') ORDER BY id";

/// Forget events older than ?1.
pub const TEL_EVENTS_PRUNE: &str = "DELETE FROM tel_events WHERE ts_ms < ?1";

/// Forget the oldest events beyond the newest ?1 (the row cap).
pub const TEL_EVENTS_CAP: &str = "DELETE FROM tel_events WHERE id <= (SELECT id FROM tel_events ORDER BY id DESC LIMIT 1 OFFSET ?1)";

/// Events held.
pub const TEL_EVENTS_HELD: &str = "SELECT COUNT(*) FROM tel_events";

/// Set a daily rollup row in archive.db (a re-run replaces it with the same values).
pub const TEL_DAILY_PUT: &str = "INSERT INTO tel_daily (day, k, h, e, o, n, us_sum, ib_sum, hist) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) ON CONFLICT (day, k, h, e, o) DO UPDATE SET n = excluded.n, us_sum = excluded.us_sum, ib_sum = excluded.ib_sum, hist = excluded.hist";

/// Daily rollup rows for days ?1 to ?2 inclusive.
pub const TEL_DAILY_RANGE: &str = "SELECT day, k, h, e, o, n, us_sum, ib_sum, hist FROM tel_daily WHERE day >= ?1 AND day <= ?2 ORDER BY day, k, h, e, o";

// ---- the DevSwarm mesh store reader (D45 S0): statements run against Node's per-repo store, read-only -------------
// These mirror the statements in companion/lib/devswarm-store.js (sqlite backend) one for one, with the same explicit
// column lists. The store's schema is Node's; nothing here creates, alters or writes it.

/// Messages of one workspace in insertion order, from the n-th (`?2` rows skipped); the positional index of a row is
/// its place in this order (Node's `listMessages`).
pub const MESH_MESSAGES: &str = "SELECT id, ts, hash, body, sender, recipient, mtype, urgency, is_heartbeat, needs_reply, orig_hash, instance_nonce, seq FROM messages WHERE workspace_id = ?1 ORDER BY id ASC LIMIT -1 OFFSET ?2";
/// The newest `?2` messages of one workspace, newest first.
pub const MESH_MESSAGES_LAST: &str = "SELECT id, ts, hash, body, sender, recipient, mtype, urgency, is_heartbeat, needs_reply, orig_hash, instance_nonce, seq FROM messages WHERE workspace_id = ?1 ORDER BY id DESC LIMIT ?2";
/// The newest `?2` messages a workspace SENT, whichever inbox they went to (the evidence sweep reads what a child told its parent).
pub const MESH_SENT_BY: &str = "SELECT id, ts, hash, body, sender, recipient, mtype, urgency, is_heartbeat, needs_reply, orig_hash, instance_nonce, seq FROM messages WHERE sender = ?1 ORDER BY id DESC LIMIT ?2";
/// How many messages one workspace holds.
pub const MESH_MESSAGE_COUNT: &str = "SELECT COUNT(*) AS c FROM messages WHERE workspace_id = ?1";
/// Every workspace id that has messages.
pub const MESH_IDS_MESSAGES: &str = "SELECT DISTINCT workspace_id AS id FROM messages";
/// Every registered workspace id.
pub const MESH_IDS_REGISTRY: &str = "SELECT id FROM registry";
/// Every workspace id that has a cursor row.
pub const MESH_IDS_CURSORS: &str = "SELECT DISTINCT workspace_id AS id FROM cursors";
/// Every workspace id that has a gate row.
pub const MESH_IDS_GATES: &str = "SELECT DISTINCT workspace_id AS id FROM gates";
/// The registry, in id order, every column (a store that predates a column simply lacks it).
pub const MESH_REGISTRY: &str = "SELECT * FROM registry ORDER BY id ASC";
/// One workspace's direct-inbox read position.
pub const MESH_CURSOR: &str = "SELECT value FROM cursors WHERE workspace_id = ?1";
/// Whether one workspace has a cursor row.
pub const MESH_CURSOR_ROW: &str = "SELECT 1 FROM cursors WHERE workspace_id = ?1";
/// One workspace's broadcast read position.
pub const MESH_BROADCAST_CURSOR: &str = "SELECT value FROM broadcast_cursors WHERE workspace_id = ?1";
/// A workspace's gate values, oldest row first (the last row per name is the current value).
pub const MESH_GATES: &str = "SELECT gate_name, value FROM gates WHERE workspace_id = ?1 ORDER BY id ASC";
/// A workspace's gate setters, oldest row first.
pub const MESH_GATE_SET_BY: &str = "SELECT gate_name, set_by FROM gates WHERE workspace_id = ?1 ORDER BY id ASC";
/// The direct rows of a workspace that need a reply, in insertion order.
pub const MESH_NEEDS_REPLY: &str = "SELECT sender, ts, seq FROM messages WHERE workspace_id = ?1 AND needs_reply = 1 AND mtype = 'direct' ORDER BY id ASC";
/// The first `?3` characters of one needs-reply row's body.
pub const MESH_PREVIEW: &str =
    "SELECT substr(body, 1, ?3) AS b FROM messages WHERE workspace_id = ?1 AND seq = ?2 AND needs_reply = 1 AND mtype = 'direct' LIMIT 1";
/// Every reader-cursor row of one partition.
pub const MESH_READER_CURSORS: &str = "SELECT partition, ns, reader, value, retired_line, updated_at FROM reader_cursors WHERE partition = ?1";
/// The newest message of one workspace, without its body: when and what, for the unread summary.
pub const MESH_LAST_META: &str = "SELECT ts, seq, sender, recipient, mtype FROM messages WHERE workspace_id = ?1 ORDER BY id DESC LIMIT 1";
