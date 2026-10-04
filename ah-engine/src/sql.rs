//! SQL text: the schema migrations and every statement the engine runs (D19, D21).
//!
//! Why here and not in `defaults/*.toml`: the schema is code. It is versioned with the binary through the migration
//! lists below, a migration is never edited after it ships (a new one is appended instead), and a user override of a
//! table definition could only corrupt data. Values that are tunable (retention, caps, limits) are bound as
//! parameters at run time and come from the defaults; nothing tunable is written into a statement.

/// hot.db migrations, applied in order; `PRAGMA user_version` records how many have run. Append only.
pub const HOT_MIGRATIONS: &[&str] = &[HOT_V1, HOT_V2, HOT_V3];

/// archive.db migrations, applied in order; `PRAGMA user_version` records how many have run. Append only.
pub const ARCHIVE_MIGRATIONS: &[&str] = &[ARCHIVE_V1, ARCHIVE_V2];

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
