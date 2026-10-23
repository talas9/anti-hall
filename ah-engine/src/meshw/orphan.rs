//! Classification of an orphan partition for the summary projection: `companion/lib/devswarm-orphan-policy.js`
//! `makeArchivedStrandedTest` (and the not-archived half of `makeForwardedDrainedTest`) over `devswarm-archive-gate.js`
//! `resolveArchiveGate`.
//!
//! An orphan is a partition with unread mail and no live registry row. Node sorts it into `archivedStranded[]` (archived, and
//! its worktree family has no registry row at all), `forwardedDrained[]`, `heldPartitions[]` or the plain `orphans[]`. The
//! engine decides the two shapes that are plain facts of the files it reads:
//!
//! * the archive gate says "not archived" (no marker of the id that applies, the worktree not archived under another id) or the
//!   id has no descriptor at all: not stranded and not forwarded-drained, so held or plain;
//! * the gate says "archived" without the liveness proof (the marker and the descriptor name no two different sessions) and
//!   the family has no registry row: archived-stranded.
//!
//! Everything else is Node's, decided before anything is written: an archived id whose family still has a registry row (the
//! forwarded-drained proof hashes every unread row against the survivor's partition), a marker and a descriptor that name two
//! different sessions (the sibling-liveness proof), a field of a type the engine does not model, a relative path.
use crate::checks::guardkit::ojson::OVal;
use crate::defaults;
use crate::meshw::ident::{self, R, defer};
use crate::meshw::idlock::{devswarm_root, is_safe_id};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

/// How an orphan with unread mail is sorted before the owner-held check.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Class {
    /// `archivedStranded[]`.
    Stranded,
    /// Neither stranded nor forwarded-drained.
    Other,
}

/// One archive marker as the worktree index holds it: its id and session id.
struct Marked {
    id: String,
    sid: Option<String>,
}

/// Per-projection state: the registry's worktrees, the archived-worktree index and the family keys, each built at most once.
pub(crate) struct Classifier {
    home: PathBuf,
    worktrees: Vec<String>,
    index: Option<HashMap<String, Vec<Marked>>>,
    families: Option<HashSet<String>>,
}

fn json_suffix() -> &'static str {
    defaults::text("mesh_write.json_suffix")
}

fn archived_dir(home: &Path) -> PathBuf {
    devswarm_root(home).join(defaults::text("mesh_write.dir_archived"))
}

/// `JSON.parse` of a file's text: the value, `None` when it is not JSON. A text the engine's parser rejects and that holds an
/// escape sequence may still parse in JavaScript, so that case is Node's.
fn parse(text: &str) -> R<Option<OVal>> {
    match OVal::parse(text) {
        Some(v) => Ok(Some(v)),
        None if text.contains(defaults::text("devswarm_prompt.escape_marker")) => defer("orphan-escapes"),
        None => Ok(None),
    }
}

/// A regular file holding a JSON object, as `readDescriptorPathState` accepts it (a link or a directory is no descriptor).
fn read_object(p: &Path) -> R<Option<OVal>> {
    match std::fs::symlink_metadata(p) {
        Ok(m) if m.is_file() => {}
        _ => return Ok(None),
    }
    let Ok(bytes) = std::fs::read(p) else { return Ok(None) };
    Ok(match parse(&String::from_utf8_lossy(&bytes))? {
        Some(v @ OVal::Obj(_)) => Some(v),
        _ => None,
    })
}

/// `realWorktreePath(p)`: the real path, else the text as it is (a worktree that is gone).
fn real_or_raw(p: &str) -> R<String> {
    if !p.starts_with('/') {
        return defer("orphan-relative-path");
    }
    Ok(ident::realpath(p).unwrap_or_else(|| p.to_string()))
}

/// `x != null && String(x) !== ''` for a session id; a value that is not text is Node's.
fn sid_of(v: Option<&OVal>) -> R<Option<String>> {
    match v {
        None | Some(OVal::Null) => Ok(None),
        Some(OVal::Str(s)) if s.is_empty() => Ok(None),
        Some(OVal::Str(s)) => Ok(Some(s.clone())),
        Some(_) => defer("orphan-session-type"),
    }
}

/// `typeof x === 'string' && x ? x : null` for a worktree path; any other truthy type is Node's.
fn wt_of(v: Option<&OVal>) -> R<Option<String>> {
    match v {
        None | Some(OVal::Null) | Some(OVal::Bool(false)) => Ok(None),
        Some(OVal::Str(s)) if s.is_empty() => Ok(None),
        Some(OVal::Str(s)) => Ok(Some(s.clone())),
        Some(_) => defer("orphan-worktree-type"),
    }
}

impl Classifier {
    /// `worktrees`: the worktree path of every registry row that names one.
    pub(crate) fn new(home: &Path, worktrees: Vec<String>) -> Classifier {
        Classifier { home: home.to_path_buf(), worktrees, index: None, families: None }
    }

    /// `buildArchivedWorktreeIndex`: the real worktree path of every archive marker that names one, to the markers.
    fn index(&mut self) -> R<&HashMap<String, Vec<Marked>>> {
        if self.index.is_none() {
            let mut out: HashMap<String, Vec<Marked>> = HashMap::new();
            let dir = archived_dir(&self.home);
            let mut names: Vec<String> = match std::fs::read_dir(&dir) {
                Ok(rd) => rd.flatten().filter_map(|e| e.file_name().into_string().ok()).collect(),
                Err(_) => Vec::new(),
            };
            names.sort();
            for n in names {
                let Some(id) = n.strip_suffix(json_suffix()) else { continue };
                if !is_safe_id(id) {
                    continue;
                }
                let Ok(bytes) = std::fs::read(dir.join(&n)) else { continue };
                let Some(marker) = parse(&String::from_utf8_lossy(&bytes))? else { continue };
                let Some(wt) = wt_of(marker.get(defaults::text("mesh_write.field_worktree_path"))).ok().flatten() else { continue };
                let sid = sid_of(marker.get(defaults::text("mesh_write.field_session_id")))?;
                out.entry(real_or_raw(&wt)?).or_default().push(Marked { id: id.to_string(), sid });
            }
            self.index = Some(out);
        }
        Ok(self.index.get_or_insert_with(HashMap::new))
    }

    /// The canonical mesh ids of the registry rows (`groupRegistryByMeshId`'s keys).
    fn families(&mut self) -> R<&HashSet<String>> {
        if self.families.is_none() {
            let mut keys = HashSet::new();
            for wt in &self.worktrees {
                if let Some(k) = ident::canonical_mesh_id(wt)? {
                    keys.insert(k);
                }
            }
            self.families = Some(keys);
        }
        Ok(self.families.get_or_insert_with(HashSet::new))
    }

    /// `resolveOrphanDescriptor`: the live descriptor, else the archive marker of the id.
    fn descriptor(&self, id: &str) -> R<Option<OVal>> {
        let file = format!("{id}{}", json_suffix());
        if let Some(d) = read_object(&devswarm_root(&self.home).join(defaults::text("mesh_write.dir_workspaces")).join(&file))? {
            return Ok(Some(d));
        }
        read_object(&archived_dir(&self.home).join(&file))
    }

    /// `resolveArchiveGate(...)`: `archived && !migrateAsLive`. The liveness proof is Node's.
    fn archived(&mut self, id: &str, desc: &OVal) -> R<bool> {
        let desc_wt = wt_of(desc.get(defaults::text("mesh_write.field_worktree_path")))?;
        let desc_sid = sid_of(desc.get(defaults::text("mesh_write.field_session_id")))?;
        let marker_path = archived_dir(&self.home).join(format!("{id}{}", json_suffix()));
        let mut marker: Option<OVal> = None;
        if let Ok(bytes) = std::fs::read(&marker_path) {
            match parse(&String::from_utf8_lossy(&bytes))? {
                Some(m @ (OVal::Obj(_) | OVal::Arr(_))) => marker = Some(m),
                _ => return Ok(true), // archived-marker-unreadable
            }
        }
        if let (Some(m), Some(dwt)) = (&marker, &desc_wt)
            && let Some(mwt) = wt_of(m.get(defaults::text("mesh_write.field_worktree_path")))?
            && real_or_raw(&mwt)? != real_or_raw(dwt)?
        {
            marker = None; // a new workspace reusing the id
        }
        let mut marker_sid: Option<String> = None;
        let mut group = false;
        if let Some(m) = &marker {
            marker_sid = sid_of(m.get(defaults::text("mesh_write.field_session_id")))?;
        } else if let Some(dwt) = &desc_wt {
            let real = real_or_raw(dwt)?;
            let hits = self.index()?.get(&real).map(|h| h.iter().map(|x| (x.id.clone(), x.sid.clone())).collect::<Vec<_>>()).unwrap_or_default();
            if hits.is_empty() {
                return Ok(false);
            }
            // the hit Node picks depends on the directory order; every candidate must give the same verdict
            let immediate = |sid: &Option<String>| sid.is_none() || desc_sid.is_none() || *sid == desc_sid;
            if !hits.iter().all(|(_, s)| immediate(s)) {
                return defer("orphan-liveness");
            }
            group = true;
            marker_sid = hits.iter().find(|(h, _)| h != id).or(hits.first()).and_then(|(_, s)| s.clone());
        }
        if marker.is_none() && !group {
            return Ok(false);
        }
        if marker_sid.is_none() || desc_sid.is_none() || marker_sid == desc_sid {
            return Ok(true);
        }
        defer("orphan-liveness") // two different sessions: the sibling-liveness proof
    }

    /// Sort one orphan: `Stranded`, or `Other` when it is certainly neither stranded nor forwarded-drained.
    pub(crate) fn classify(&mut self, id: &str) -> R<Class> {
        let Some(desc) = self.descriptor(id)? else { return Ok(Class::Other) };
        if !self.archived(id, &desc)? {
            return Ok(Class::Other);
        }
        let Some(wt) = wt_of(desc.get(defaults::text("mesh_write.field_worktree_path")))? else { return Ok(Class::Stranded) };
        let Some(key) = ident::canonical_mesh_id(&wt)? else { return Ok(Class::Stranded) };
        if self.families()?.contains(&key) {
            return defer("orphan-forwarded"); // the family has a survivor: the forwarded-drained proof is Node's
        }
        Ok(Class::Stranded)
    }
}
