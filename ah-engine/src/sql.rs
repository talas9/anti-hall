//! SQL text: the schema migrations and every statement the engine runs (D19, D21).
//!
//! Why here and not in `defaults/*.toml`: the schema is code. It is versioned with the binary through the migration
//! lists below, a migration is never edited after it ships (a new one is appended instead), and a user override of a
//! table definition could only corrupt data. Values that are tunable (retention, caps, limits) are bound as
//! parameters at run time and come from the defaults; nothing tunable is written into a statement.

/// hot.db migrations, applied in order; `PRAGMA user_version` records how many have run. Append only.
pub const HOT_MIGRATIONS: &[&str] = &[HOT_V1, HOT_V2, HOT_V3, HOT_V4, HOT_V5, HOT_V6, HOT_V7];

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

/// hot.db v7: realtime state (lane B1, v2 design I2): the latest body of each entity per namespace, and a capped log of
/// the changes (edges) between snapshots. Both are the engine's own derived data; no source is ever written from them.
const HOT_V7: &str = "
CREATE TABLE IF NOT EXISTS rt_entity (ns TEXT NOT NULL, key TEXT NOT NULL, body TEXT NOT NULL, src_sig TEXT NOT NULL, observed_ms INTEGER NOT NULL, PRIMARY KEY (ns, key)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS rt_edges (id INTEGER PRIMARY KEY, ns TEXT NOT NULL, key TEXT NOT NULL, kind TEXT NOT NULL, from_v TEXT NOT NULL, to_v TEXT NOT NULL, generation INTEGER NOT NULL, at_ms INTEGER NOT NULL, while_down INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS rt_edges_ns ON rt_edges (ns, id);
";

/// Insert or replace one realtime entity.
pub const RT_ENTITY_PUT: &str = "INSERT INTO rt_entity (ns, key, body, src_sig, observed_ms) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT (ns, key) DO UPDATE SET body = excluded.body, src_sig = excluded.src_sig, observed_ms = excluded.observed_ms";

/// Every key held in one namespace.
pub const RT_ENTITY_KEYS: &str = "SELECT key FROM rt_entity WHERE ns = ?1";

/// Remove one realtime entity (a workspace the source no longer lists).
pub const RT_ENTITY_DROP: &str = "DELETE FROM rt_entity WHERE ns = ?1 AND key = ?2";

/// Every entity of one namespace.
pub const RT_ENTITY_ALL: &str = "SELECT key, body, src_sig, observed_ms FROM rt_entity WHERE ns = ?1 ORDER BY key";

/// Append one change record.
pub const RT_EDGE_PUT: &str = "INSERT INTO rt_edges (ns, key, kind, from_v, to_v, generation, at_ms, while_down) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)";

/// Keep only the newest ?2 change records of a namespace.
pub const RT_EDGE_TRIM: &str = "DELETE FROM rt_edges WHERE ns = ?1 AND id <= (SELECT COALESCE(MAX(id), 0) FROM rt_edges WHERE ns = ?1) - ?2";

/// The newest ?2 change records of a namespace, oldest first.
pub const RT_EDGE_RECENT: &str =
    "SELECT key, kind, from_v, to_v, generation, at_ms, while_down FROM (SELECT * FROM rt_edges WHERE ns = ?1 ORDER BY id DESC LIMIT ?2) ORDER BY id";

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
/// A workspace's gate rows (name, value, setter), oldest first: what `currentGates` and `currentGateSetBy` fold.
pub const MESH_GATE_ROWS: &str = "SELECT gate_name, value, set_by FROM gates WHERE workspace_id = ?1 ORDER BY id ASC";
/// Every registry row's id and raw nudge command, in id order (the summary keeps the nudge's JSON key order).
pub const MESH_REGISTRY_NUDGES: &str = "SELECT id, nudge_command FROM registry ORDER BY id ASC";
/// The direct rows of a workspace that need a reply, in insertion order.
pub const MESH_NEEDS_REPLY: &str = "SELECT sender, ts, seq FROM messages WHERE workspace_id = ?1 AND needs_reply = 1 AND mtype = 'direct' ORDER BY id ASC";
/// The first `?3` characters of one needs-reply row's body.
pub const MESH_PREVIEW: &str =
    "SELECT substr(body, 1, ?3) AS b FROM messages WHERE workspace_id = ?1 AND seq = ?2 AND needs_reply = 1 AND mtype = 'direct' LIMIT 1";
/// Every reader-cursor row of one partition.
pub const MESH_READER_CURSORS: &str = "SELECT partition, ns, reader, value, retired_line, updated_at FROM reader_cursors WHERE partition = ?1";
/// The newest message of one workspace, without its body: when and what, for the unread summary.
pub const MESH_LAST_META: &str = "SELECT ts, seq, sender, recipient, mtype FROM messages WHERE workspace_id = ?1 ORDER BY id DESC LIMIT 1";

// ---- the DevSwarm mesh store WRITER (D45 stage 2): Node's own schema and write statements, byte for byte -----------
// Every statement below is the text `companion/lib/devswarm-store.js` (sqlite backend) runs, so the engine and Node can
// write one store side by side: the same DDL (a store the engine creates is identical to one Node creates), the same
// AUTOINCREMENT/seq/write_seq arithmetic inside one statement, and the same MAX-only reader-cursor upsert.

/// Node's `messages` table.
pub const MESHW_DDL_MESSAGES: &str = "CREATE TABLE IF NOT EXISTS messages ( id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, ts INTEGER NOT NULL, hash TEXT, body TEXT, sender TEXT, recipient TEXT, mtype TEXT, urgency TEXT, is_heartbeat INTEGER, needs_reply INTEGER, orig_hash TEXT, instance_nonce TEXT, seq INTEGER, UNIQUE(hash));";
/// Node's needs-reply index.
pub const MESHW_DDL_NEEDS_REPLY_INDEX: &str = "CREATE INDEX IF NOT EXISTS idx_messages_needs_reply ON messages (workspace_id, needs_reply);";
/// Node's `registry` table.
pub const MESHW_DDL_REGISTRY: &str = "CREATE TABLE IF NOT EXISTS registry ( id TEXT PRIMARY KEY, worktree_path TEXT, session_id TEXT, inbox_path TEXT, cursor_path TEXT, nudge_command TEXT, updated_at INTEGER, write_seq INTEGER);";
/// Node's `cursors` table.
pub const MESHW_DDL_CURSORS: &str = "CREATE TABLE IF NOT EXISTS cursors ( workspace_id TEXT PRIMARY KEY, value INTEGER NOT NULL, updated_at INTEGER);";
/// Node's `gates` table.
pub const MESHW_DDL_GATES: &str = "CREATE TABLE IF NOT EXISTS gates ( id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, gate_name TEXT NOT NULL, value INTEGER NOT NULL, set_at INTEGER, set_by TEXT);";
/// Node's `broadcast_cursors` table.
pub const MESHW_DDL_BROADCAST_CURSORS: &str =
    "CREATE TABLE IF NOT EXISTS broadcast_cursors ( workspace_id TEXT PRIMARY KEY, value INTEGER NOT NULL, updated_at INTEGER);";
/// Node's `reader_cursors` table.
pub const MESHW_DDL_READER_CURSORS: &str = "CREATE TABLE IF NOT EXISTS reader_cursors ( partition TEXT NOT NULL, ns TEXT NOT NULL CHECK (ns IN ('store','nd')), reader TEXT NOT NULL, value INTEGER NOT NULL CHECK (value >= 0), retired_line INTEGER, updated_at INTEGER NOT NULL, PRIMARY KEY (partition, ns, reader)) WITHOUT ROWID;";
/// Column names of a table (`PRAGMA table_info`), for Node's additive migrations.
pub const MESHW_TABLE_INFO_MESSAGES: &str = "PRAGMA table_info(messages);";
/// Column names of the registry.
pub const MESHW_TABLE_INFO_REGISTRY: &str = "PRAGMA table_info(registry);";
/// `appendMeshRow` with a hash: a duplicate hash is ignored; the mesh seq is computed inside the statement.
pub const MESHW_APPEND_OR_IGNORE: &str = "INSERT OR IGNORE INTO messages (workspace_id, ts, hash, body, sender, recipient, mtype, urgency, is_heartbeat, needs_reply, orig_hash, instance_nonce, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(seq),0)+1 FROM messages));";
/// `appendMeshRow` without a hash.
pub const MESHW_APPEND: &str = "INSERT INTO messages (workspace_id, ts, hash, body, sender, recipient, mtype, urgency, is_heartbeat, needs_reply, orig_hash, instance_nonce, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(seq),0)+1 FROM messages));";
/// `appendMessage` with a hash (the native-ingest insert): no mesh columns, no seq; a duplicate hash is ignored.
pub const MESHW_APPEND_MESSAGE_OR_IGNORE: &str = "INSERT OR IGNORE INTO messages (workspace_id, ts, hash, body) VALUES (?, ?, ?, ?);";
/// `appendMessage` without a hash.
pub const MESHW_APPEND_MESSAGE: &str = "INSERT INTO messages (workspace_id, ts, hash, body) VALUES (?, ?, ?, ?);";
/// One registry row (the columns `upsertRegistry` writes), for the merge-preserving self-registration.
pub const MESHW_REGISTRY_ROW: &str = "SELECT id, worktree_path, session_id, inbox_path, cursor_path, nudge_command FROM registry WHERE id = ?;";
/// The ids of the registry (`listRegistry`), for the partition door's "still registered here" recheck.
pub const MESHW_REGISTRY_HAS: &str = "SELECT 1 FROM registry WHERE id = ?;";
/// A message row by hash, the columns the ingest witness compares.
pub const MESHW_MESSAGE_BY_HASH: &str = "SELECT workspace_id, ts, body FROM messages WHERE hash = ?;";
/// The seq of the row just inserted.
pub const MESHW_SEQ_OF_ID: &str = "SELECT seq FROM messages WHERE id = ?;";
/// `upsertRegistry`'s id-collision probe.
pub const MESHW_REGISTRY_PATH_OF: &str = "SELECT worktree_path FROM registry WHERE id = ?;";
/// `upsertRegistry` on a store with `write_seq`.
pub const MESHW_REGISTRY_UPSERT: &str = "INSERT INTO registry (id, worktree_path, session_id, inbox_path, cursor_path, nudge_command, updated_at, write_seq) VALUES (?, ?, ?, ?, ?, ?, ?, 1) ON CONFLICT(id) DO UPDATE SET worktree_path=excluded.worktree_path, session_id=excluded.session_id, inbox_path=excluded.inbox_path, cursor_path=excluded.cursor_path, nudge_command=excluded.nudge_command, updated_at=excluded.updated_at, write_seq=COALESCE(registry.write_seq,0)+1;";
/// `upsertRegistry` on a store without `write_seq`.
pub const MESHW_REGISTRY_UPSERT_LEGACY: &str = "INSERT INTO registry (id, worktree_path, session_id, inbox_path, cursor_path, nudge_command, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET worktree_path=excluded.worktree_path, session_id=excluded.session_id, inbox_path=excluded.inbox_path, cursor_path=excluded.cursor_path, nudge_command=excluded.nudge_command, updated_at=excluded.updated_at;";
/// Every gate row, oldest first (the Node witness compares the history of two stores).
pub const MESHW_GATES_DUMP: &str = "SELECT workspace_id, gate_name, value, set_at, set_by FROM gates ORDER BY id ASC;";
/// `setGate`.
pub const MESHW_SET_GATE: &str = "INSERT INTO gates (workspace_id, gate_name, value, set_at, set_by) VALUES (?, ?, ?, ?, ?);";
/// `setCursor`.
pub const MESHW_SET_CURSOR: &str = "INSERT INTO cursors (workspace_id, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(workspace_id) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at;";
/// `setBroadcastCursor` and the write half of `advanceBroadcastCursor`.
pub const MESHW_SET_BROADCAST_CURSOR: &str = "INSERT INTO broadcast_cursors (workspace_id, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(workspace_id) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at;";
/// The head of the broadcast partition (`advanceBroadcastCursor`).
pub const MESHW_BROADCAST_HEAD: &str = "SELECT MAX(seq) AS m FROM messages WHERE mtype = 'broadcast';";
/// `readerCursorTxn`'s put: the value only ever rises; `retired_line` is replaced only when the record carries it.
pub const MESHW_READER_CURSOR_PUT: &str = "INSERT INTO reader_cursors (partition, ns, reader, value, retired_line, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(partition, ns, reader) DO UPDATE SET value = MAX(value, excluded.value), retired_line = CASE WHEN ? THEN excluded.retired_line ELSE retired_line END, updated_at = excluded.updated_at;";
/// Begin Node's reader-cursor write transaction.
pub const MESHW_BEGIN_IMMEDIATE: &str = "BEGIN IMMEDIATE;";
/// Commit it.
pub const MESHW_COMMIT: &str = "COMMIT;";
/// Roll it back.
pub const MESHW_ROLLBACK: &str = "ROLLBACK;";
/// Node's additive `messages` migration, followed by `<name> <type>;` for each missing column.
pub const MESHW_ALTER_MESSAGES_ADD: &str = "ALTER TABLE messages ADD COLUMN ";
/// Node's additive `registry` migration.
pub const MESHW_ALTER_REGISTRY_WRITE_SEQ: &str = "ALTER TABLE registry ADD COLUMN write_seq INTEGER;";
/// Node's WAL journal pragma.
pub const MESHW_JOURNAL_WAL: &str = "PRAGMA journal_mode = WAL;";
/// Node's foreign-keys pragma.
pub const MESHW_FOREIGN_KEYS: &str = "PRAGMA foreign_keys = ON;";
/// The DevSwarm app's `builders` columns (`devswarm-app-db.js` `tableColumns`), read-only.
pub const MESHW_APP_BUILDER_COLUMNS: &str = "PRAGMA table_info(builders)";
/// Start of the `builders` read `builderForWorktree` needs: id and active flag, then the worktree and type columns.
pub const MESHW_APP_BUILDERS_SELECT: &str = "SELECT \"id\", \"isActive\", ";
/// The worktree column.
pub const MESHW_APP_COL_WORKTREE: &str = "\"worktreePath\"";
/// The builder-type column.
pub const MESHW_APP_COL_BUILDER_TYPE: &str = "\"builderType\"";
/// A column the app database lacks reads as null (`selectPresent`).
pub const MESHW_APP_COL_NULL: &str = "NULL";
/// End of the `builders` read.
pub const MESHW_APP_BUILDERS_FROM: &str = " FROM builders";
/// The newest message rowid (the shadow's snapshot mark).
pub const MESHW_MAX_MESSAGE_ID: &str = "SELECT MAX(id) FROM messages";
/// Rows written after a mark (the shadow's concurrency signal).
pub const MESHW_COUNT_AFTER_ID: &str = "SELECT COUNT(*) FROM messages WHERE id > ?1";
/// One message row by hash, every column but the rowid (the shadow compares the two stores' copies).
pub const MESHW_ROW_BY_HASH: &str = "SELECT workspace_id, ts, hash, body, sender, recipient, mtype, urgency, is_heartbeat, needs_reply, orig_hash, instance_nonce, seq FROM messages WHERE hash = ?1";
/// A row's timestamp by hash (the shadow replays Node's clock).
pub const MESHW_TS_BY_HASH: &str = "SELECT ts FROM messages WHERE hash = ?1";

/// Start of `PRAGMA table_info(<table>)` on the DevSwarm app database (`devswarm-app-db.js` `tableColumns`).
pub const MESHW_APP_TABLE_INFO_OPEN: &str = "PRAGMA table_info(";
/// End of it.
pub const MESHW_APP_TABLE_INFO_CLOSE: &str = ")";
/// Start of a snapshot read (`selectPresent`).
pub const MESHW_APP_SELECT: &str = "SELECT ";
/// Between the column list and the table.
pub const MESHW_APP_FROM: &str = " FROM ";
/// A terminal's prompt is read as its length only.
pub const MESHW_APP_LENGTH_OPEN: &str = "length(";
/// End of that expression.
pub const MESHW_APP_LENGTH_CLOSE: &str = ")";
/// Separator of the select list.
pub const MESHW_APP_LIST_SEP: &str = ", ";
/// Identifier quote of the select list.
pub const MESHW_APP_QUOTE: &str = "\"";

// ---- retention (src/dssup/retention): the statements of `companion/lib/devswarm-retention.js`, verbatim where Node's text is
// one fixed statement ----

/// The partitions that hold messages (`planStore`).
pub const RT_PARTITIONS: &str = "SELECT DISTINCT workspace_id AS w FROM messages";
/// The rows of one partition.
pub const RT_COUNT: &str = "SELECT COUNT(*) FROM messages WHERE workspace_id = ?1";
/// A partition's rows in order, without the body (the body's length only).
pub const RT_ROWS: &str = "SELECT id, ts, seq, needs_reply, is_heartbeat, sender, urgency, body IS NULL AS tomb, COALESCE(LENGTH(body),0) AS blen, hash, typeof(body) AS bt FROM messages WHERE workspace_id = ?1 ORDER BY id ASC";
/// The same, with the body (the broadcast partition's run detection reads it).
pub const RT_ROWS_BODY: &str = "SELECT id, ts, seq, needs_reply, is_heartbeat, sender, urgency, body IS NULL AS tomb, COALESCE(LENGTH(body),0) AS blen, hash, typeof(body) AS bt, body FROM messages WHERE workspace_id = ?1 ORDER BY id ASC";
/// One row's body.
pub const RT_BODY: &str = "SELECT body FROM messages WHERE id = ?1";
/// Every workspace's broadcast cursor.
pub const RT_BC_ALL: &str = "SELECT value FROM broadcast_cursors";
/// One workspace's broadcast cursor.
pub const RT_BC_ONE: &str = "SELECT value FROM broadcast_cursors WHERE workspace_id = ?1";
/// The registry rows (id and NDJSON inbox path).
pub const RT_REGISTRY: &str = "SELECT id, inbox_path FROM registry ORDER BY id ASC";
/// A partition's reader cursor rows.
pub const RT_READER_ROWS: &str = "SELECT ns, reader, value, retired_line FROM reader_cursors WHERE partition = ?1";
/// A partition's store-namespace reader rows (the in-transaction bound).
pub const RT_READER_STORE: &str = "SELECT reader, value, retired_line FROM reader_cursors WHERE partition = ?1 AND ns = 'store'";
/// Whether a legacy cursor row exists.
pub const RT_CURSOR_ROW: &str = "SELECT 1 FROM cursors WHERE workspace_id = ?1";
/// A legacy cursor row's value.
pub const RT_CURSOR_VALUE: &str = "SELECT value FROM cursors WHERE workspace_id = ?1";
/// A row's current state, read inside the tombstoning transaction.
pub const RT_ROW_NOW: &str = "SELECT workspace_id, ts, hash, needs_reply, body IS NOT NULL FROM messages WHERE id = ?1";
/// A row's position in its partition.
pub const RT_POSITION: &str = "SELECT COUNT(*) FROM messages WHERE workspace_id = ?1 AND id <= ?2";
/// The tombstone: the body goes, everything else stays.
pub const RT_TOMBSTONE: &str = "UPDATE messages SET body = NULL WHERE id = ?1 AND body IS NOT NULL";
/// The columns an archived row keeps (before the placeholders).
pub const RT_FULL_OPEN: &str = "SELECT id, workspace_id, ts, hash, body, sender, recipient, mtype, urgency, is_heartbeat, needs_reply, orig_hash, instance_nonce, seq FROM messages WHERE body IS NOT NULL AND id IN (";
/// The end of that statement.
pub const RT_FULL_CLOSE: &str = ") ORDER BY id";
/// Page and freelist counts.
pub const RT_PAGE_COUNT: &str = "PRAGMA page_count";
/// See above.
pub const RT_FREELIST_COUNT: &str = "PRAGMA freelist_count";
/// Reclaim the freed space.
pub const RT_VACUUM: &str = "VACUUM";
/// Fold the log back into the database file.
pub const RT_CHECKPOINT: &str = "PRAGMA wal_checkpoint(TRUNCATE)";
/// Start the tombstoning transaction.
pub const RT_BEGIN: &str = "BEGIN IMMEDIATE";
/// Commit it.
pub const RT_COMMIT: &str = "COMMIT";
/// Roll it back.
pub const RT_ROLLBACK: &str = "ROLLBACK";
/// A broadcast row's sequence number and heartbeat flag.
pub const RT_ROW_BROADCAST: &str = "SELECT seq, is_heartbeat FROM messages WHERE id = ?1";
/// The app's messages in a time window: the repository, the branch they went to and when (never the text).
pub const AS_MESSAGES: &str = "SELECT repositoryId, toBranch, createdAt FROM workspace_messages WHERE createdAt >= ?1 AND createdAt < ?2";
/// The timestamps of the app messages a store has ingested.
pub const AS_NATIVE_TS: &str = "SELECT ts FROM messages WHERE hash LIKE ?1";
/// The reconcile port: every registry row with the two columns the conditional operations compare.
pub const RECON_REGISTRY_ALL: &str = "SELECT id, worktree_path, session_id, inbox_path, cursor_path, nudge_command, updated_at, write_seq FROM registry ORDER BY id ASC;";
/// The reconcile port, orphan heal: the workspace ids a store holds messages for (`listWorkspaceIds`, first source).
pub const RECON_IDS_MESSAGES: &str = "SELECT DISTINCT workspace_id AS id FROM messages;";
/// The reconcile port, orphan heal: the ids of the registry rows (`listWorkspaceIds`, second source).
pub const RECON_IDS_REGISTRY: &str = "SELECT id FROM registry;";
/// The reconcile port, orphan heal: the ids that hold a cursor (`listWorkspaceIds`, third source).
pub const RECON_IDS_CURSORS: &str = "SELECT DISTINCT workspace_id AS id FROM cursors;";
/// The reconcile port, orphan heal: the ids that hold a gate (`listWorkspaceIds`, fourth source).
pub const RECON_IDS_GATES: &str = "SELECT DISTINCT workspace_id AS id FROM gates;";
/// The reconcile port's normaliser: the user tables of a store.
pub const RECON_TABLES: &str = "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name;";
/// The reconcile port's normaliser: every row of a table in storage order (`{table}` is filled from `RECON_TABLES`).
pub const RECON_DUMP: &str = "SELECT * FROM \"{table}\" ORDER BY rowid;";
/// The reconcile port: the registry row of one id, every column.
pub const RECON_REGISTRY_ONE: &str = "SELECT id, worktree_path, session_id, inbox_path, cursor_path, nudge_command, updated_at, write_seq FROM registry WHERE id = ?;";
