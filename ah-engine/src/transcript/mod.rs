//! The per-session transcript index (X1, D22): hooks ask for facts about a session transcript, never for lines.
//!
//! Why it exists: at least 20 hooks read the transcript, each in its own process, so a Stop with 11 hooks re-read
//! the same tail up to 11 times. The index reads a transcript once, keeps a byte offset, and on every refresh reads
//! only what was appended. Truncation and rotation are noticed and answered with a rebuild from the file, so the
//! index is always reproducible from the transcript alone (it can be lost in a crash without losing anything).
//!
//! What it keeps (all bounded, see `defaults/transcript.toml`): record counts by kind, the last assistant reply
//! (in both of the Node extractions), the newest tool uses, the task-tool events in order, every task-notification
//! in all three transcript shapes, `task_status` attachments, the last typed user prompt, and counts of sidechain,
//! meta and compact-summary rows plus compaction boundaries.
//!
//! Modules: [`record`] parses one line into facts (each function cites the Node reader it mirrors), [`index`] is
//! the incremental reader, [`registry`] holds one index per transcript path with a size cap and an idle TTL.
//!
//! Not wired into any guard yet (D75 wave 2): this is the API the ported checks will call.
pub mod index;
pub mod record;
pub mod registry;

pub use index::{Index, Limits, Rebuild, Refresh};
pub use record::{Assistant, Notification, Prompt, Shape, TaskEvent, TaskStatus, ToolUse};
pub use registry::Indexes;

use crate::defaults;
use std::fmt;
use std::path::PathBuf;

/// Why a transcript could not be read.
#[derive(Debug)]
pub enum TranscriptError {
    /// The file exists but a read failed.
    Io {
        /// The transcript.
        path: PathBuf,
        /// The OS error.
        source: std::io::Error,
    },
}

impl fmt::Display for TranscriptError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            TranscriptError::Io { path, source } => f.write_str(&defaults::render("transcript.msg_io", &[("path", &path.display()), ("err", source)])),
        }
    }
}

impl std::error::Error for TranscriptError {}
