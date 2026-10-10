//! DevSwarm realtime, lane B1: the live state of every DevSwarm workspace, kept in memory as an atomically swapped snapshot,
//! persisted in hot.db, and reconciled against its sources at start-up and periodically (v2 design, part B, B1/B2).
//!
//! The layer is inert unless DevSwarm is detected ([`detect`]): when it is absent, or `devswarm_rt.mode` is `off`, [`start`]
//! returns `None` and nothing is read, spawned or written. This lane starts no thread of its own; the owner of the event
//! layer calls [`Rt::run`] on a hint, on overflow and on the periodic tick.
//!
//! * [`sources`]: read-only readers (the app database, heartbeats, plans, the mesh unread union) behind the [`sources::Probe`]
//!   trait, plus the [`sources::GithubState`] trait through which the GitHub realtime feature (A) supplies PR and CI facts.
//! * [`state`]: the per-workspace record, the pure derivation from sources, the invariants I1 to I5 and the change diff.
//! * [`reconcile`]: the live store, start-up diff (`while_down`), periodic repair counting and persistence.
//! * [`linefile`]: the compact snapshot copy the statusline segment reads (feature 1; never the database at render time).
//! * [`shadow`]: the comparison against the Node witness (a non-acting Node run in a scratch HOME), appended to a log.
pub mod detect;
pub mod linefile;
pub mod reconcile;
pub mod shadow;
pub mod sources;
pub mod state;

pub use detect::{Detection, Mode, detect};
pub use reconcile::{Cause, Report, Rt};
pub use state::{Cfg, Edge, EdgeKind, Snapshot, Workspace};

use crate::meshw::ident::Env;
use std::path::Path;

/// Start the layer: `None` (inert, no state, no I/O beyond the detection probe) when DevSwarm is absent or the mode is off.
pub fn start(home: &Path, env: &Env) -> Option<Rt> {
    let d = detect(home, env);
    d.active().then(|| Rt::new(Cfg::from_defaults(), d))
}
