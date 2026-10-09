//! The native port of DevSwarm `reconcile` and the sweep tail (design: `RECONCILE-SWEEP-DESIGN.md`), slice by slice.
//!
//! Everything here moves user state, so nothing is applied on the engine's word alone. The shape of every slice is the same:
//!
//! 1. **Plan** (read-only). A planner reads the live home and returns a list of [`Op`]s grouped in [`Unit`]s (one unit = one
//!    thing that must be applied under one lock: a workspace's registry row and descriptor, or a single side file). A planner
//!    that meets a state it does not reproduce exactly returns a deferral; nothing has been written.
//! 2. **Witness** ([`gate`]). The inputs are mirrored twice into scratch homes (`M_node`, `M_eng`; SQLite stores by the
//!    online backup, never a raw copy of a live file). Node's own function runs on `M_node` with its clock pinned; the
//!    engine's op list is applied to `M_eng` by the very code that will touch the real home; the two post-states are
//!    normalised ([`norm`]) and compared byte for byte, together with the values the functions returned.
//! 3. **Apply**. Only on equality is the same op list applied to the real home, unit by unit, under the unit's lock, after
//!    every precondition the plan recorded is re-checked ([`apply`]). A drifted precondition, a busy lock or a failed step
//!    hands that unit back to Node's scheduled function: the caller gets [`UnitEnd::Deferred`] and writes nothing for it.
//!
//! Nothing here deletes a message row and nothing updates one: the ops cannot express it (see the static test
//! `no_message_row_is_deleted_or_updated`). The two removals Node's reconcile family performs on index state (a registry
//! row tombstone and the descriptor hard-link-then-unlink retire) belong to later slices and are conditional there.
//!
//! Crash safety: every op is individually atomic (a rename, one SQL statement, one `write(2)` on an append-mode file) and
//! the op order is Node's, so a SIGKILL between any two ops leaves a state every reader and Node's next tick accept and
//! converge from. [`Hooks`] lets a test kill the process at each boundary.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this module tree is a deliberate keep, for these reasons:
// - an unreadable optional file is the absent one (Node's try/catch, fail-open)
// - the witness is advisory: a scratch file that cannot be removed only costs disk
pub mod apply;
pub mod archived;
pub mod dup;
pub mod fold;
pub mod archive;
pub mod gate;
pub mod heal;
pub mod mirror;
pub mod norm;
pub mod orphans;
pub mod pull;
pub mod side;
pub mod sweep;
pub mod view;

use crate::meshw::store::{MeshRow, RegistryRow};

/// The inputs of a job that its mirrors hold: files (kept with their modification time), whole directories (small ones, with a
/// file cap) and stores (copied with SQLite's online backup). Paths are relative to the home; stores are repo keys.
#[derive(Debug, Clone, Default)]
pub struct Scope {
    /// Files, copied when present.
    pub files: Vec<String>,
    /// Directories, copied recursively.
    pub dirs: Vec<String>,
    /// Stores (repo keys).
    pub stores: Vec<String>,
    /// Files (relative to the home) whose text names the home they were copied from; each mirror rewrites that home to its own, so
    /// a function that follows a path stored in the file (a descriptor's inbox path) stays inside the mirror.
    pub rebase: Vec<String>,
}

/// What a file must look like for an op to apply: the plan's own reading of it, re-checked under the lock.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Pre {
    /// No requirement (the file is the engine's own, or Node overwrites it blindly too).
    Any,
    /// The file does not exist.
    Absent,
    /// The file exists and its bytes have this SHA-256 (lower-case hex).
    Digest(String),
}

/// A registry row as it is stored, with the two columns Node's conditional operations compare.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct RegRow {
    /// The descriptor fields (`id`, path, session, inbox, cursor, nudge command text).
    pub row: RegistryRow,
    /// `updated_at`.
    pub updated_at: Option<i64>,
    /// `write_seq`.
    pub write_seq: Option<i64>,
}

/// One step. Every variant is atomic on its own and none can delete or update a message row.
#[derive(Debug, Clone, PartialEq)]
pub enum Op {
    /// Replace a file atomically (unique temporary file beside it, flushed, renamed over it).
    Write {
        /// Path relative to the home.
        rel: String,
        /// The new bytes.
        bytes: Vec<u8>,
        /// What the file must be right now.
        pre: Pre,
    },
    /// Remove a file the plan read (a marker that is no longer needed).
    Unlink {
        /// Path relative to the home.
        rel: String,
        /// What the file must be right now.
        pre: Pre,
    },
    /// Append bytes to a file (one `write(2)` on an append-mode descriptor; creates it).
    Append {
        /// Path relative to the home.
        rel: String,
        /// The bytes.
        bytes: Vec<u8>,
    },
    /// Rename a file when it exists (a log rotation).
    Rename {
        /// Path relative to the home.
        rel: String,
        /// The new path relative to the home.
        to: String,
    },
    /// `upsertRegistry(row, {allowPathChange: true})` on one store: the id keeps its row, the descriptor fields are replaced,
    /// `updated_at` is the clock and `write_seq` rises by one.
    Upsert {
        /// The store (repo key).
        store: String,
        /// The row to write.
        row: Box<RegistryRow>,
        /// The row as the plan read it (`None`: the id had no row). Re-checked before the write.
        pre: Option<Box<RegRow>>,
    },
    /// `deriveSummary` of one store: the projection file under `summaries/`.
    Derive {
        /// The store (repo key).
        store: String,
    },
    /// The fold's forward (`appendIntoPartition`): under the destination's id lock, and only while the destination is still
    /// registered in the store, add the rows to its partition (a row whose hash already exists anywhere in the store is
    /// ignored, which is what makes a re-run harmless). A busy lock or a destination that went away writes nothing and hands
    /// the unit back (`apply::skip`). Only ever adds rows.
    Forward {
        /// The store (repo key).
        store: String,
        /// The destination partition.
        dest: String,
        /// The rows, already addressed to `dest`.
        rows: Vec<MeshRow>,
    },
    /// `readerCursors.raiseAllLossFree` on the store namespace, then the legacy projection (the shared cursor file, then the
    /// `cursors` table, both upward only). Only valid after a forward that made every row below `value` reachable elsewhere.
    RaiseCursors {
        /// The store (repo key).
        store: String,
        /// The partition whose readers move.
        partition: String,
        /// The position every reader row below it is raised to.
        value: i64,
    },
    /// `removeRegistryIf(id, guard)`: one conditional statement that deletes the registry row only while its session, its
    /// `updated_at` and its `write_seq` are still what the plan read. The only removal the fold family performs.
    RemoveRegistryIf {
        /// The store (repo key).
        store: String,
        /// The registry id.
        id: String,
        /// The guard's session (`None`: SQL NULL).
        session_id: Option<String>,
        /// The guard's `updated_at`.
        updated_at: Option<i64>,
        /// The guard's `write_seq`.
        write_seq: Option<i64>,
        /// The row as the plan read it, re-checked before the statement.
        pre: Box<RegRow>,
    },
    /// A precondition and nothing else: what a partition (its rows, positions and the files the decision read) looked like
    /// when the plan decided. A drifted guard hands the whole unit back.
    Guard {
        /// The store (repo key).
        store: String,
        /// The partition.
        partition: String,
        /// Its signature (see `view::partition_sig`).
        sig: String,
        /// Files the decision read, with what they were.
        files: Vec<(String, Pre)>,
    },
    /// `fs.linkSync(from, to)`: a second name for the same file. An existing `to` is fine (the step is idempotent; the next
    /// op decides whether it is the same file). Never copies and never removes anything.
    Link {
        /// The existing file, relative to the home.
        from: String,
        /// The new name, relative to the home.
        to: String,
        /// What `from` must be right now.
        pre: Pre,
        /// The `(device, inode)` of `from` the plan classified (Node re-proves the generation under the lock). Checked on the
        /// real home only: a scratch mirror's files have inodes of their own.
        ino: Option<(u64, u64)>,
    },
    /// Remove the name `rel` only when `other` is another name of the very same file (same device and inode). This is the
    /// second half of a retire / restore: the file always survives under `other`, so a crash between [`Op::Link`] and this
    /// step leaves it under both names, never under none.
    UnlinkLinked {
        /// The name to remove, relative to the home.
        rel: String,
        /// The name that must stay, relative to the home.
        other: String,
    },
    /// `removeRegistryIf(id, guard)` on one store: delete the registry row only if it is still exactly the row the plan read
    /// (session, `updated_at` and `write_seq`, NULL-safe). The one statement is the whole step; no message row is touched.
    Remove {
        /// The store (repo key).
        store: String,
        /// The row as the plan read it.
        guard: Box<RegRow>,
    },
    /// The ensure and the delivery-log replay of one workspace's drain (`inbox pull` as `reconcile` runs it, after the destructive
    /// read was captured to the delivery log): the descriptor and registry row are made right, every open batch of the log is
    /// ingested into the inbox and the store and closed, a log that has grown is rotated. Applied by `pull::apply_pull`.
    Pull {
        /// The workspace id.
        id: String,
        /// The git root the pull stands in.
        cwd: String,
    },
    /// One line of the central log, as `anti-hall-log.js` `logEvent` writes it.
    Log {
        /// The component.
        component: String,
        /// The operation.
        op: String,
        /// The level.
        level: String,
        /// The message.
        msg: String,
        /// The context object, serialised (`repoKey` and `meshId` are lifted to the entry as Node does).
        ctx: String,
    },
}

/// Ops that belong together: applied under one lock, checked as one, handed back to Node as one.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Unit {
    /// A short label for logs and reports (`heal:<id>`, `resume`, ...).
    pub label: String,
    /// The per-workspace-id lock the unit runs under (Node's `withIdLock`); `None` for a side file nobody locks.
    pub lock: Option<String>,
    /// The steps, in Node's order.
    pub ops: Vec<Op>,
}

/// How one unit ended on the real home.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UnitEnd {
    /// Every op was applied.
    Applied,
    /// Nothing was written for this unit; Node's function owns it. The text says why (`witness-mismatch`, `drift:<what>`,
    /// `lock-busy`, `node-unavailable`, ...).
    Deferred(String),
    /// A step failed after earlier steps were applied. Every step is idempotent, so Node's next run converges; the text is
    /// the failure.
    Failed(String),
}

/// Kill points for the crash tests: `at(name)` is called at every op boundary (`<label>:<n>:before` / `:after`). The
/// production hook does nothing.
pub struct Hooks<'a> {
    /// Called with the boundary name.
    pub at: &'a dyn Fn(&str),
}

impl Hooks<'_> {
    /// A hook that does nothing.
    pub fn none() -> Hooks<'static> {
        Hooks { at: &|_| {} }
    }
}
