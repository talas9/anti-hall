//! The polling backend: remember a signature (modification time, size, inode) for each watched file and report the names
//! whose signature differs at the next scan. It sees everything an OS event stream would, including an editor's atomic
//! save (the temp file is renamed onto the name, so the inode changes) and a file that vanishes and comes back, and it
//! needs nothing from the filesystem, which is why it is the one backend that works on 9p, drvfs, NFS, SMB and FUSE.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

/// Which file names of a directory are watched.
#[derive(Clone, Debug)]
pub enum Filter {
    /// Every entry of the directory (up to the entry cap).
    All,
    /// Exactly these names (stat'ed directly, so no directory listing is needed).
    Names(Vec<OsString>),
}

impl Filter {
    /// Exactly the given names.
    pub fn names<I, S>(names: I) -> Filter
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        Filter::Names(names.into_iter().map(Into::into).collect())
    }

    /// True when `name` is selected.
    pub fn matches(&self, name: &std::ffi::OsStr) -> bool {
        match self {
            Filter::All => true,
            Filter::Names(v) => v.iter().any(|n| n == name),
        }
    }

    /// A SQLite database and its side files: `db` plus `db` followed by each suffix. A commit lands in the write-ahead log
    /// and a checkpoint can truncate it, so the side files are watched with the database itself.
    pub fn sqlite(db: &str, suffixes: &[&str]) -> Filter {
        let mut v: Vec<OsString> = vec![db.into()];
        v.extend(suffixes.iter().map(|s| OsString::from(format!("{db}{s}"))));
        Filter::Names(v)
    }
}

/// What identifies a version of a file.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Sig {
    mtime: i64,
    mtime_ns: i64,
    size: u64,
    ino: u64,
}

fn sig_of(m: &std::fs::Metadata) -> Sig {
    Sig { mtime: m.mtime(), mtime_ns: m.mtime_nsec(), size: m.size(), ino: m.ino() }
}

/// The names that changed in one scan of a directory.
#[derive(Debug, Default)]
pub struct Scan {
    /// Full paths whose signature is new, different or gone.
    pub changed: Vec<PathBuf>,
    /// The directory holds more matching entries than the cap and its own listing changed: the caller must rescan.
    pub overflow: bool,
}

/// The remembered state of one watched directory.
#[derive(Debug)]
pub struct DirState {
    dir: PathBuf,
    filter: Filter,
    files: BTreeMap<OsString, Sig>,
    dir_sig: Option<Sig>,
    truncated: bool,
}

impl DirState {
    /// Start watching `dir`: the current contents are the baseline, so only later changes are reported.
    pub fn new(dir: &Path, filter: Filter, max_entries: usize) -> DirState {
        let mut s = DirState { dir: dir.to_path_buf(), filter, files: BTreeMap::new(), dir_sig: None, truncated: false };
        s.scan(max_entries);
        s
    }

    /// The directory being watched.
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn current(&self, max_entries: usize) -> (BTreeMap<OsString, Sig>, bool) {
        let mut now = BTreeMap::new();
        match &self.filter {
            Filter::Names(names) => {
                for n in names.iter().take(max_entries) {
                    if let Ok(m) = std::fs::symlink_metadata(self.dir.join(n)) {
                        now.insert(n.clone(), sig_of(&m));
                    }
                }
                (now, false)
            }
            Filter::All => {
                let Ok(rd) = std::fs::read_dir(&self.dir) else { return (now, false) };
                for e in rd.flatten() {
                    if now.len() >= max_entries {
                        return (now, true);
                    }
                    if let Ok(m) = e.metadata() {
                        now.insert(e.file_name(), sig_of(&m));
                    }
                }
                (now, false)
            }
        }
    }

    /// Compare the directory with the last scan, remember the new state and return what differs.
    pub fn scan(&mut self, max_entries: usize) -> Scan {
        let (now, truncated) = self.current(max_entries);
        let dir_sig = std::fs::metadata(&self.dir).ok().map(|m| sig_of(&m));
        let mut out = Scan::default();
        for (name, sig) in &now {
            if self.files.get(name) != Some(sig) {
                out.changed.push(self.dir.join(name));
            }
        }
        for name in self.files.keys() {
            if !now.contains_key(name) {
                out.changed.push(self.dir.join(name));
            }
        }
        // Past the cap the files that were not listed cannot be compared; the directory's own signature (it changes on a
        // create, delete or rename) is the only hint, so a change of it asks for a full rescan.
        out.overflow = truncated && (self.truncated != truncated || self.dir_sig != dir_sig);
        self.files = now;
        self.dir_sig = dir_sig;
        self.truncated = truncated;
        out
    }
}
