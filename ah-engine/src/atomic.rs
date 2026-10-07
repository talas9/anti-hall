//! The one atomic file write: a temporary file in the target's directory, flushed to disk, then renamed over the target.
//! A reader sees the old file or the new one, never a half-written one, and a crash leaves at most a stray temporary file
//! (never a damaged target). The directory entry itself is not fsynced: a power cut right after the rename can still
//! surface the old file, which every caller here tolerates (state files are advisory and rebuilt).
use crate::defaults;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static SEQ: AtomicU64 = AtomicU64::new(0);

/// The temporary sibling of `path`. Unique per process and per call (pid + counter), so two threads, or two daemons, never
/// share one. A `.json` target keeps a `.json` ending so the stale-file sweeps that match `*.json` still reap a leftover.
fn tmp_path(path: &Path) -> PathBuf {
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    let mut name = path.as_os_str().to_os_string();
    let tag = format!(".{}.{n}{}", std::process::id(), defaults::text("atomic.tmp_suffix"));
    if let Some(ext) = path.extension().filter(|e| *e == "json") {
        let mut s = name.to_string_lossy().into_owned();
        s.truncate(s.len() - ext.len() - 1);
        name = format!("{s}{tag}.{}", ext.to_string_lossy()).into();
    } else {
        name.push(tag);
    }
    PathBuf::from(name)
}

/// Write `bytes` to `path` atomically (temporary file beside it, `sync_all`, rename).
///
/// # Errors
/// Any I/O error from creating, writing, syncing or renaming; on error the temporary file is removed and `path` is left
/// as it was. The parent directory must already exist.
pub fn write(path: impl AsRef<Path>, bytes: impl AsRef<[u8]>) -> std::io::Result<()> {
    let path = path.as_ref();
    let tmp = tmp_path(path);
    let result = (|| {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes.as_ref())?;
        f.sync_all()?;
        drop(f);
        std::fs::rename(&tmp, path)
    })();
    if result.is_err() {
        // Best effort: the original error is the one worth returning; a leftover temp file is swept later.
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ah-atomic-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn entries(d: &Path) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(d).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        v.sort();
        v
    }

    #[test]
    fn writes_and_replaces_without_leftovers() {
        let d = dir("basic");
        let f = d.join("state.json");
        write(&f, "one").unwrap();
        write(&f, b"two".as_slice()).unwrap();
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "two");
        assert_eq!(entries(&d), vec!["state.json"]);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn failed_rename_keeps_the_target_and_removes_the_temp() {
        // Rename of a file onto a non-empty directory fails: the "crash between write and rename" shape.
        let d = dir("fail");
        let target = d.join("t");
        std::fs::create_dir(&target).unwrap();
        std::fs::write(target.join("keep"), "x").unwrap();
        assert!(write(&target, "new").is_err());
        assert!(target.join("keep").exists(), "target untouched");
        assert_eq!(entries(&d), vec!["t"], "no temp file left behind");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn missing_parent_is_an_error_not_a_panic() {
        let d = dir("noparent");
        assert!(write(d.join("nope/x.json"), "a").is_err());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_stray_temp_from_a_killed_writer_never_changes_the_target() {
        // A writer killed after creating its temp but before the rename leaves a partial temp; the target stays whole.
        let d = dir("crash");
        let f = d.join("state.json");
        write(&f, "{\"v\":1}").unwrap();
        std::fs::write(tmp_path(&f), "{\"v\":").unwrap(); // the partial write
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "{\"v\":1}");
        write(&f, "{\"v\":2}").unwrap(); // a later write is unaffected by the stray file
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "{\"v\":2}");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn json_temp_keeps_the_json_ending_and_other_names_do_not_collide() {
        let p = Path::new("/x/orch-1.json");
        let (a, b) = (tmp_path(p), tmp_path(p));
        assert_ne!(a, b);
        assert!(a.to_string_lossy().ends_with(".tmp.json") && a.to_string_lossy().starts_with("/x/orch-1."));
        assert!(tmp_path(Path::new("/x/log")).to_string_lossy().ends_with(".tmp"));
    }

    #[test]
    fn concurrent_readers_never_see_a_partial_file() {
        let d = dir("conc");
        let f = d.join("state.json");
        let (a, b) = ("a".repeat(256 * 1024), "b".repeat(256 * 1024));
        write(&f, &a).unwrap();
        std::thread::scope(|s| {
            s.spawn(|| {
                for i in 0..40 {
                    write(&f, if i % 2 == 0 { &b } else { &a }).unwrap();
                }
            });
            s.spawn(|| {
                for _ in 0..400 {
                    let got = std::fs::read_to_string(&f).unwrap();
                    assert!(got == a || got == b, "partial read of {} bytes", got.len());
                }
            });
        });
        assert_eq!(entries(&d), vec!["state.json"]);
        let _ = std::fs::remove_dir_all(&d);
    }
}
