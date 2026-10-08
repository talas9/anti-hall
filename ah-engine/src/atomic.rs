//! The one atomic file write: a temporary file in the target's directory, flushed to disk, then renamed over the target.
//! A reader sees the old file or the new one, never a half-written one, and a crash leaves at most a stray temporary file
//! (never a damaged target). The directory entry itself is not fsynced: a power cut right after the rename can still
//! surface the old file, which every caller here tolerates (state files are advisory and rebuilt).
use crate::defaults;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static SEQ: AtomicU64 = AtomicU64::new(0);

/// How [`write_styled`] names its temporary file and what it leaves behind when the rename fails. The two non-default
/// styles exist for byte-for-byte parity with the Node hooks, whose state files this engine shares. `Style::default()`
/// appends the tag and removes the temporary file on any failure.
#[derive(Clone, Copy, Default)]
pub struct Style {
    /// A `.json` target keeps a `.json` ending after the tag (`x.<pid>.<n>.tmp.json`), so a sweep that reaps `*.json` also
    /// reaps a leftover. Otherwise the tag is appended (`x.json.<pid>.<n>.tmp`).
    pub keep_json_ext: bool,
    /// Leave the temporary file in place when the final rename fails, as Node's `writeFileSync` + `renameSync` do.
    pub leave_temp_on_rename_failure: bool,
    /// Do not `sync_all` the temporary file before the rename. A reader still never sees a half-written file; only a power cut
    /// right after the rename can then leave the new name with empty contents. For advisory state that is rebuilt at the next
    /// run (a scripted write sets this from `script.write_sync`).
    pub skip_sync: bool,
    /// Create the file with this mode (e.g. `0o600` for a private cache) instead of the process default.
    pub mode: Option<u32>,
    /// Name the temporary file with [`crate::bootstrap::TMP_SUFFIX`] instead of `atomic.tmp_suffix`: for the writes made
    /// when no defaults could be loaded (the failure record, `defaults.error`), where reading a setting is impossible.
    pub bootstrap: bool,
}

/// The temporary sibling of `path`. Unique per process and per call (pid + counter), so two threads, or two daemons, never
/// share one.
fn tmp_path(path: &Path, style: Style) -> PathBuf {
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    let mut name = path.as_os_str().to_os_string();
    let suffix = if style.bootstrap { crate::bootstrap::TMP_SUFFIX } else { defaults::text("atomic.tmp_suffix") };
    let tag = format!(".{}.{n}{suffix}", std::process::id());
    if let Some(ext) = path.extension().filter(|e| style.keep_json_ext && *e == "json") {
        let mut s = name.to_string_lossy().into_owned();
        s.truncate(s.len() - ext.len() - 1);
        name = format!("{s}{tag}.{}", ext.to_string_lossy()).into();
    } else {
        name.push(tag);
    }
    PathBuf::from(name)
}

/// Write `bytes` to `path` atomically (temporary file beside it, `sync_all`, rename), with the default [`Style`].
///
/// # Errors
/// Any I/O error from creating, writing, syncing or renaming; on error the temporary file is removed and `path` is left
/// as it was. The parent directory must already exist.
pub fn write(path: impl AsRef<Path>, bytes: impl AsRef<[u8]>) -> std::io::Result<()> {
    write_styled(path, bytes, Style::default())
}

/// [`write`] with an explicit [`Style`].
///
/// # Errors
/// As [`write`]; with `leave_temp_on_rename_failure` the temporary file stays after a failed rename.
pub fn write_styled(path: impl AsRef<Path>, bytes: impl AsRef<[u8]>, style: Style) -> std::io::Result<()> {
    let path = path.as_ref();
    let tmp = tmp_path(path, style);
    if let Err(e) = stage(&tmp, bytes, style) {
        // Best effort: the original error is the one worth returning; a leftover temp file is swept later.
        crate::discard::harmless(std::fs::remove_file(&tmp)); // keep: cleanup that raced; an absent file is the goal state
        return Err(e);
    }
    replace(&tmp, path, style)
}

/// [`write_styled`] for state that silences a later answer (a Stop block's loop counter, a nudge's once-only cap). Inside a
/// daemon request the temporary file is written now and renamed over `path` only after the reply reached the client in time
/// ([`crate::deadline::commit_staged`]); otherwise `path` is left as it was, so the Node fallback that answers a client which
/// stopped waiting does not find a stamp for a decision it never received (review P1-2). Outside a request it is
/// [`write_styled`].
///
/// # Errors
/// As [`write_styled`] when written at once; inside a request only the staging (create, write, sync) can fail, and a failed
/// rename at commit is logged.
pub fn write_after_reply(path: impl AsRef<Path>, bytes: impl AsRef<[u8]>, style: Style) -> std::io::Result<()> {
    let path = path.as_ref();
    if !crate::deadline::in_request() {
        return write_styled(path, bytes, style);
    }
    let tmp = tmp_path(path, style);
    if let Err(e) = stage(&tmp, bytes, style) {
        crate::discard::harmless(std::fs::remove_file(&tmp)); // keep: cleanup that raced; an absent file is the goal state
        return Err(e);
    }
    crate::deadline::stage(tmp, path.to_path_buf(), style);
    Ok(())
}

/// The first half of an atomic write, for a caller that must name the temporary file itself (a temp name the Node hooks
/// share, see DECISIONS "atomic-write exceptions"): create `tmp` (with `style.mode`), write `bytes`, sync it to disk.
///
/// # Errors
/// Any I/O error from creating, writing or syncing; `tmp` is then left for the caller to remove or report.
pub fn stage(tmp: impl AsRef<Path>, bytes: impl AsRef<[u8]>, style: Style) -> std::io::Result<()> {
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create(true).truncate(true);
    if let Some(m) = style.mode {
        std::os::unix::fs::OpenOptionsExt::mode(&mut o, m);
    }
    let mut f = o.open(tmp.as_ref())?;
    f.write_all(bytes.as_ref())?;
    if style.skip_sync { Ok(()) } else { f.sync_all() }
}

/// The second half: rename `tmp` over `path`. On failure the temporary file is removed, unless
/// `style.leave_temp_on_rename_failure`.
///
/// # Errors
/// The rename's I/O error.
pub fn replace(tmp: impl AsRef<Path>, path: impl AsRef<Path>, style: Style) -> std::io::Result<()> {
    let renamed = std::fs::rename(tmp.as_ref(), path.as_ref());
    if renamed.is_err() && !style.leave_temp_on_rename_failure {
        crate::discard::harmless(std::fs::remove_file(tmp.as_ref())); // keep: cleanup that raced; an absent file is the goal state
    }
    renamed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ah-atomic-{tag}-{}", std::process::id()));
        crate::discard::harmless(std::fs::remove_dir_all(&d)); // keep: cleanup that raced; an absent file is the goal state
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn entries(d: &Path) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(d).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        v.sort();
        v
    }

    #[test]
    fn a_private_write_is_created_0600_and_a_bootstrap_write_reads_no_setting() {
        // review finding 22: the defaults snapshot cache keeps its 0600 mode through the shared atomic write
        use std::os::unix::fs::PermissionsExt;
        let d = dir("mode");
        let f = d.join("defaults.cache");
        write_styled(&f, "x", Style { mode: Some(0o600), bootstrap: true, ..Style::default() }).unwrap();
        assert_eq!(std::fs::metadata(&f).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(entries(&d), vec!["defaults.cache"]);
        assert!(tmp_path(&f, Style { bootstrap: true, ..Style::default() }).to_string_lossy().ends_with(crate::bootstrap::TMP_SUFFIX));
        crate::discard::harmless(std::fs::remove_dir_all(&d)); // keep: cleanup that raced; an absent file is the goal state
    }

    #[test]
    fn writes_and_replaces_without_leftovers() {
        let d = dir("basic");
        let f = d.join("state.json");
        write(&f, "one").unwrap();
        write(&f, b"two".as_slice()).unwrap();
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "two");
        assert_eq!(entries(&d), vec!["state.json"]);
        crate::discard::harmless(std::fs::remove_dir_all(&d)); // keep: cleanup that raced; an absent file is the goal state
    }

    #[test]
    fn an_unsynced_write_still_replaces_atomically_without_leftovers() {
        let d = dir("nosync");
        let f = d.join("state.json");
        for text in ["one", "two"] {
            write_styled(&f, text, Style { skip_sync: true, ..Style::default() }).unwrap();
            assert_eq!(std::fs::read_to_string(&f).unwrap(), text);
        }
        assert_eq!(entries(&d), vec!["state.json"]);
        crate::discard::harmless(std::fs::remove_dir_all(&d)); // keep: cleanup that raced; an absent file is the goal state
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
        crate::discard::harmless(std::fs::remove_dir_all(&d)); // keep: cleanup that raced; an absent file is the goal state
    }

    #[test]
    fn node_parity_style_leaves_the_temp_after_a_failed_rename() {
        let d = dir("leave");
        let target = d.join("t");
        std::fs::create_dir(&target).unwrap();
        std::fs::write(target.join("keep"), "x").unwrap();
        assert!(write_styled(&target, "new", Style { leave_temp_on_rename_failure: true, ..Style::default() }).is_err());
        assert_eq!(entries(&d).len(), 2, "the temp file stays, as Node leaves it: {:?}", entries(&d));
        crate::discard::harmless(std::fs::remove_dir_all(&d));
    }

    #[test]
    fn missing_parent_is_an_error_not_a_panic() {
        let d = dir("noparent");
        assert!(write(d.join("nope/x.json"), "a").is_err());
        crate::discard::harmless(std::fs::remove_dir_all(&d)); // keep: cleanup that raced; an absent file is the goal state
    }

    #[test]
    fn a_stray_temp_from_a_killed_writer_never_changes_the_target() {
        // A writer killed after creating its temp but before the rename leaves a partial temp; the target stays whole.
        let d = dir("crash");
        let f = d.join("state.json");
        write(&f, "{\"v\":1}").unwrap();
        std::fs::write(tmp_path(&f, Style::default()), "{\"v\":").unwrap(); // the partial write
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "{\"v\":1}");
        write(&f, "{\"v\":2}").unwrap(); // a later write is unaffected by the stray file
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "{\"v\":2}");
        crate::discard::harmless(std::fs::remove_dir_all(&d)); // keep: cleanup that raced; an absent file is the goal state
    }

    #[test]
    fn json_temp_keeps_the_json_ending_and_other_names_do_not_collide() {
        let p = Path::new("/x/orch-1.json");
        let json = Style { keep_json_ext: true, ..Style::default() };
        let (a, b) = (tmp_path(p, json), tmp_path(p, json));
        assert_ne!(a, b);
        assert!(a.to_string_lossy().ends_with(".tmp.json") && a.to_string_lossy().starts_with("/x/orch-1."));
        assert!(
            tmp_path(p, Style::default()).to_string_lossy().starts_with("/x/orch-1.json.") && tmp_path(p, Style::default()).to_string_lossy().ends_with(".tmp")
        );
        assert!(tmp_path(Path::new("/x/log"), json).to_string_lossy().ends_with(".tmp"));
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
        crate::discard::harmless(std::fs::remove_dir_all(&d)); // keep: cleanup that raced; an absent file is the goal state
    }
}
