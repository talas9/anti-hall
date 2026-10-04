//! SQL text: the schema migrations and every statement the engine runs (D19, D21).
//!
//! Why here and not in `defaults/*.toml`: the schema is code. It is versioned with the binary through the migration
//! lists below, a migration is never edited after it ships (a new one is appended instead), and a user override of a
//! table definition could only corrupt data. Values that are tunable (retention, caps, limits) are bound as
//! parameters at run time and come from the defaults; nothing tunable is written into a statement.

/// hot.db migrations, applied in order; `PRAGMA user_version` records how many have run. Append only.
pub const HOT_MIGRATIONS: &[&str] = &[HOT_V1];

/// archive.db migrations, applied in order; `PRAGMA user_version` records how many have run. Append only.
pub const ARCHIVE_MIGRATIONS: &[&str] = &[ARCHIVE_V1];

/// hot.db v1: the impact ledger (one row per event) and its exact per-combination totals (D52).
const HOT_V1: &str = "
CREATE TABLE IF NOT EXISTS impact (id INTEGER PRIMARY KEY, ts_ms INTEGER NOT NULL, kind TEXT NOT NULL, check_name TEXT NOT NULL, reason TEXT NOT NULL, project TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS impact_totals (kind TEXT NOT NULL, check_name TEXT NOT NULL, reason TEXT NOT NULL, project TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (kind, check_name, reason, project)) WITHOUT ROWID;
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
