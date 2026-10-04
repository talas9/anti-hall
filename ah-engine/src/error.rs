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
#[derive(Debug, PartialEq, Eq)]
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
