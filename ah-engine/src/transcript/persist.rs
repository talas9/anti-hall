//! The restart snapshot of a session store: its facts on disk, so a daemon restart does not mean a cold build.
//!
//! One file per transcript under `<state>/<transcript.snapshot_dir>/`, named by a hash of the transcript path. It holds the
//! facts and keyed maps plus the stamps that say it still describes the file: device and inode, the offset it read to, the
//! head and tail fingerprints, and a hash of the `transcript.*` settings. The store loads it on a first touch only when every stamp still
//! matches, and then parses only the bytes appended since. A file over `transcript.snapshot_max_bytes` is not written. The
//! transcript is the source of truth, so a lost or stale snapshot costs one cold build and nothing else.
//!
//! The format is JSON (`serde_json` is already a dependency; a binary format would be a new one).
use super::facts::{AgentRow, Fact, FifoMap, TaskRow};
use super::store::Session;
use crate::checks::agent_scan::lines::AgentState;
use crate::defaults;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::path::{Path, PathBuf};

/// The stored shape of a session.
#[derive(Debug, Serialize, Deserialize)]
pub(super) struct Snap {
    /// Format version (`transcript.snapshot_version`).
    pub v: u64,
    /// A hash of the `transcript.*` settings the facts were parsed under (a reload that changes none of them keeps the snapshot).
    pub generation: u64,
    /// The transcript path (a hash collision must not hand one session another's facts).
    pub path: String,
    /// Device and inode.
    pub id: (u64, u64),
    pub offset: u64,
    pub seen_size: u64,
    pub head: Option<(usize, u64)>,
    pub tail: Option<(u64, u64)>,
    pub covered_from: u64,
    pub seq: u64,
    pub facts: Vec<Fact>,
    pub oversize: Vec<u64>,
    pub tasks: FifoMap<TaskRow>,
    pub agents: FifoMap<AgentRow>,
    pub task_ids: FifoMap<String>,
    /// The agent-scan digests (absent in an older snapshot: no window before its offset is answered from digests then).
    #[serde(default)]
    pub agent: AgentState,
}

/// What [`write`] did.
pub(super) enum Wrote {
    Yes,
    TooBig,
    Failed,
}

/// A hash of every `transcript.*` setting in effect.
pub(super) fn config_stamp() -> u64 {
    let text: String = defaults::with_prefix(defaults::text("transcript.stamp_prefix")).iter().map(|e| format!("{}={}\n", e.key, e.value.to_json())).collect();
    text.bytes().fold(0xcbf2_9ce4_8422_2325u64, |h, x| (h ^ u64::from(x)).wrapping_mul(0x0000_0100_0000_01b3))
}

fn hash(path: &Path) -> u64 {
    path.as_os_str().as_encoded_bytes().iter().fold(0xcbf2_9ce4_8422_2325u64, |h, x| (h ^ u64::from(*x)).wrapping_mul(0x0000_0100_0000_01b3))
}

fn file_for(dir: &Path, path: &Path) -> PathBuf {
    dir.join(format!("{:016x}{}", hash(path), defaults::text("transcript.snapshot_ext")))
}

impl Snap {
    pub(super) fn into_session(self) -> Session {
        Session {
            built: true,
            id: Some(self.id),
            offset: self.offset,
            seen_size: self.seen_size,
            head: self.head,
            tail: self.tail,
            covered_from: self.covered_from,
            seq: self.seq,
            facts: VecDeque::from(self.facts),
            oversize: VecDeque::from(self.oversize),
            tasks: self.tasks,
            agents: self.agents,
            task_ids: self.task_ids,
            // digests made under other agent-scan settings answer nothing: they start again at the snapshot's offset
            agent: if self.agent.stamp == crate::checks::agent_scan::lines::config_stamp() { self.agent } else { AgentState::starting_at(self.offset) },
            ..Session::default()
        }
    }
}

/// Write the snapshot of `s` (a committed session; the pending overlay is not stored).
pub(super) fn write(dir: &Path, path: &Path, s: &Session, max: usize) -> Wrote {
    let Some(id) = s.id else { return Wrote::Failed };
    let snap = Snap {
        v: defaults::num("transcript.snapshot_version"),
        generation: config_stamp(),
        path: path.display().to_string(),
        id,
        offset: s.offset,
        seen_size: s.seen_size,
        head: s.head,
        tail: s.tail,
        covered_from: s.covered_from,
        seq: s.seq,
        facts: s.facts.iter().cloned().collect(),
        oversize: s.oversize.iter().copied().collect(),
        tasks: s.tasks.clone(),
        agents: s.agents.clone(),
        task_ids: s.task_ids.clone(),
        agent: s.agent.clone(),
    };
    let Ok(bytes) = serde_json::to_vec(&snap) else { return Wrote::Failed };
    if bytes.len() > max {
        return Wrote::TooBig;
    }
    if std::fs::create_dir_all(dir).is_err() {
        return Wrote::Failed;
    }
    match crate::atomic::write(file_for(dir, path), bytes) {
        Ok(()) => Wrote::Yes,
        Err(_) => Wrote::Failed,
    }
}

/// Why [`read`] gave no snapshot.
pub(super) enum Miss {
    /// There is no snapshot file for the transcript (a first touch).
    Absent,
    /// There is one and it cannot be used: unreadable, corrupt, over the cap, another version, configuration or path.
    Unusable,
}

/// The snapshot of `path`, when one exists, is not over the cap, and was written by this format version under this defaults
/// generation for this very path.
pub(super) fn read(dir: &Path, path: &Path, max: usize) -> Result<Snap, Miss> {
    let file = file_for(dir, path);
    let meta = std::fs::metadata(&file).map_err(|_| Miss::Absent)?;
    if meta.len() as usize > max {
        return Err(Miss::Unusable);
    }
    let bytes = std::fs::read(&file).map_err(|_| Miss::Unusable)?;
    let snap: Snap = serde_json::from_slice(&bytes).map_err(|_| Miss::Unusable)?;
    if snap.v == defaults::num("transcript.snapshot_version") && snap.generation == config_stamp() && snap.path == path.display().to_string() {
        Ok(snap)
    } else {
        Err(Miss::Unusable)
    }
}

/// Remove the snapshots older than `ttl_ms` and, beyond `max_files`, the oldest ones. Only files with the snapshot extension are
/// touched; a snapshot is a cache of a transcript, so a removed one costs one cold build. Returns how many were removed.
pub(super) fn sweep(dir: &Path, ttl_ms: u64, max_files: usize) -> usize {
    let ext = defaults::text("transcript.snapshot_ext");
    let Ok(rd) = std::fs::read_dir(dir) else { return 0 };
    let now = std::time::SystemTime::now();
    let mut files: Vec<(std::time::SystemTime, PathBuf)> =
        rd.flatten().filter(|e| e.file_name().to_string_lossy().ends_with(ext)).filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path()))).collect();
    files.sort_by_key(|(t, _)| std::cmp::Reverse(*t)); // newest first
    let mut removed = 0;
    for (i, (t, p)) in files.iter().enumerate() {
        let aged = now.duration_since(*t).is_ok_and(|age| age.as_millis() as u64 > ttl_ms);
        if (aged || i >= max_files) && std::fs::remove_file(p).is_ok() {
            removed += 1;
        }
    }
    removed
}
