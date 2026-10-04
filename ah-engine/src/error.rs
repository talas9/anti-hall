//! Typed error enums for the places that used to return `String` or `(String, String)`.
//!
//! Why enums: callers match on the cause (a full mailbox is a normal `ERR` reply, an unsafe state directory
//! is a start failure with a self-fix hint), and the stable [`DirError::code`] feeds the health classifier.
//! Display text is for people; never parse it.
use crate::defaults;
use std::fmt;
use std::path::PathBuf;

/// Why a rules file could not be loaded.
#[derive(Debug)]
pub enum RulesError {
    /// The file could not be read.
    Io {
        /// The rules file.
        path: PathBuf,
        /// The OS error.
        source: std::io::Error,
    },
    /// The text is not valid rules JSON.
    Json(serde_json::Error),
    /// The `version` field is not one this build understands.
    Version(u32),
    /// A rule's `action` is not `deny`, `warn` or `context`.
    Action {
        /// Zero-based position of the rule in the file.
        index: usize,
        /// The unknown action text.
        action: String,
    },
    /// A rule names a built-in check that is not registered.
    Check {
        /// Zero-based position of the rule in the file.
        index: usize,
        /// The unknown check name.
        name: String,
    },
    /// A rule's `pattern` is not a valid regular expression.
    Pattern {
        /// Zero-based position of the rule in the file.
        index: usize,
        /// The rule's `id`, possibly empty.
        id: String,
        /// The regex compiler's message.
        source: regex::Error,
    },
}

impl fmt::Display for RulesError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RulesError::Io { path, source } => f.write_str(&defaults::render("msg.err_path_io", &[("path", &path.display()), ("err", source)])),
            RulesError::Json(e) => f.write_str(&defaults::render("msg.err_rules_json", &[("err", e)])),
            RulesError::Version(v) => f.write_str(&defaults::render("msg.err_rules_version", &[("version", v)])),
            RulesError::Action { index, action } => {
                f.write_str(&defaults::render("msg.err_rules_action", &[("index", index), ("action", &format!("{action:?}"))]))
            }
            RulesError::Check { index, name } => f.write_str(&defaults::render("msg.err_rules_check", &[("index", index), ("name", &format!("{name:?}"))])),
            RulesError::Pattern { index, id, source } => {
                f.write_str(&defaults::render("msg.err_rules_pattern", &[("index", index), ("id", id), ("err", source)]))
            }
        }
    }
}

impl std::error::Error for RulesError {}

/// Why a state or socket directory is not usable.
#[derive(Debug)]
pub enum DirError {
    /// The path exists but is not a plain directory (a symlink, a file, ...).
    NotADirectory(PathBuf),
    /// The directory belongs to another user.
    WrongOwner {
        /// The directory.
        path: PathBuf,
        /// Its owner.
        found: u32,
        /// The uid it must have.
        expected: u32,
    },
    /// An OS call failed.
    Io {
        /// The directory.
        path: PathBuf,
        /// The OS error.
        source: std::io::Error,
    },
}

impl DirError {
    /// Stable error code for the health classifier: `unsafe_dir` for the two safety refusals, `os<errno>` otherwise.
    pub fn code(&self) -> String {
        match self {
            DirError::NotADirectory(_) | DirError::WrongOwner { .. } => "unsafe_dir".to_string(),
            DirError::Io { source, .. } => format!("os{}", source.raw_os_error().unwrap_or(0)),
        }
    }
}

impl fmt::Display for DirError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DirError::NotADirectory(p) => f.write_str(&defaults::render("msg.err_not_dir", &[("path", &p.display())])),
            DirError::WrongOwner { path, found, expected } => {
                f.write_str(&defaults::render("msg.err_wrong_owner", &[("path", &path.display()), ("found", found), ("expected", expected)]))
            }
            DirError::Io { path, source } => f.write_str(&defaults::render("msg.err_path_io", &[("path", &path.display()), ("err", source)])),
        }
    }
}

impl std::error::Error for DirError {}

/// Why a project-partition operation was refused. All of these become an `ERR` reply, never a panic.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StoreError {
    /// The daemon already tracks the maximum number of projects.
    TooManyProjects,
    /// The value is larger than the per-value cap.
    ValueTooLarge,
    /// The project's mailbox is at its cap.
    MailboxFull,
    /// The project already holds the maximum number of keys.
    TooManyKeys,
    /// The verb is not one the store knows.
    UnknownVerb(String),
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StoreError::TooManyProjects => f.write_str(defaults::text("msg.err_too_many_projects")),
            StoreError::ValueTooLarge => f.write_str(defaults::text("msg.err_value_too_large")),
            StoreError::MailboxFull => f.write_str(defaults::text("msg.err_mailbox_full")),
            StoreError::TooManyKeys => f.write_str(defaults::text("msg.err_too_many_keys")),
            StoreError::UnknownVerb(v) => f.write_str(&defaults::render("msg.err_unknown_verb", &[("verb", &format!("{v:?}"))])),
        }
    }
}

impl std::error::Error for StoreError {}

/// Why the storage layer could not do what was asked. A request that meets one of these is answered `ERR` (or `BUSY`),
/// never acknowledged: a write is acknowledged only after its commit (D23).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DbError {
    /// SQLite reported an error (the text is SQLite's own).
    Sql(String),
    /// The database was written by a newer build: its schema version is above every migration this build knows.
    Schema {
        /// Which database.
        db: String,
        /// The version found in the file.
        found: i64,
        /// The newest version this build knows.
        known: usize,
    },
    /// The journal mode could not be set (the file system may not support WAL).
    JournalMode(String),
    /// The writer queue is full; the client retries, then spools.
    Busy,
    /// Storage is closed or never opened.
    Unavailable,
    /// The write was queued but did not commit within `storage.ack_timeout_ms`; it may still commit later, and its
    /// write id makes a retry harmless.
    Timeout,
    /// The write was refused by a store rule (a cap, an unknown verb).
    Rejected(StoreError),
}

impl From<rusqlite::Error> for DbError {
    fn from(e: rusqlite::Error) -> DbError {
        DbError::Sql(e.to_string())
    }
}

impl DbError {
    /// Stable error code for logs and the health classifier.
    pub fn code(&self) -> &'static str {
        match self {
            DbError::Sql(_) => "db_sql",
            DbError::Schema { .. } => "db_schema",
            DbError::JournalMode(_) => "db_journal",
            DbError::Busy => "db_busy",
            DbError::Unavailable => "db_unavailable",
            DbError::Timeout => "db_timeout",
            DbError::Rejected(_) => "db_rejected",
        }
    }
}

impl fmt::Display for DbError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DbError::Sql(e) => f.write_str(&defaults::render("msg.err_db_sql", &[("err", e)])),
            DbError::Schema { db, found, known } => f.write_str(&defaults::render("msg.err_db_schema", &[("db", db), ("found", found), ("known", known)])),
            DbError::JournalMode(m) => f.write_str(&defaults::render("msg.err_db_journal", &[("mode", m)])),
            DbError::Busy => f.write_str(defaults::text("msg.err_db_busy")),
            DbError::Unavailable => f.write_str(defaults::text("msg.err_db_unavailable")),
            DbError::Timeout => f.write_str(defaults::text("msg.err_db_timeout")),
            DbError::Rejected(e) => e.fmt(f),
        }
    }
}

impl std::error::Error for DbError {}

/// Why the per-event dispatcher (D58) could not start.
#[derive(Debug)]
pub enum DispatchError {
    /// `--host` names a host the dispatch table does not have.
    Host(String),
    /// The `--fallback-map` file is unreadable or not an object of events to hook ids to commands.
    Map {
        /// The map file.
        path: PathBuf,
        /// What went wrong.
        detail: String,
    },
}

impl fmt::Display for DispatchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DispatchError::Host(h) => {
                f.write_str(&defaults::render("dispatch.msg_unknown_host", &[("host", h), ("hosts", &crate::dispatch::table::hosts().join(", "))]))
            }
            DispatchError::Map { path, detail } => f.write_str(&defaults::render("dispatch.msg_bad_map", &[("path", &path.display()), ("err", detail)])),
        }
    }
}

impl std::error::Error for DispatchError {}
