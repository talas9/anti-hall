//! The scratch mirrors the witness works on. A mirror is a home of its own holding exactly the inputs of one job: named files
//! (bytes and modification time kept, a link kept as a link), whole small directories, and SQLite stores copied with the
//! online backup API (a consistent snapshot whatever a live writer does; a raw copy of a live database and its `-wal` file is
//! never taken). The source is only ever read.
use super::Scope;
use super::view::{store_db, store_rel};
use crate::defaults;
use std::os::unix::fs::MetadataExt;
use std::path::Path;

fn copy_file(src: &Path, dst: &Path) -> Result<(), String> {
    let md = std::fs::symlink_metadata(src).map_err(|e| e.to_string())?;
    if let Some(p) = dst.parent() {
        std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
    }
    if md.file_type().is_symlink() {
        let target = std::fs::read_link(src).map_err(|e| e.to_string())?;
        return std::os::unix::fs::symlink(target, dst).map_err(|e| e.to_string());
    }
    if !md.is_file() {
        return Ok(());
    }
    std::fs::copy(src, dst).map_err(|e| e.to_string())?;
    let when = std::time::UNIX_EPOCH + std::time::Duration::new(md.mtime().max(0) as u64, md.mtime_nsec().max(0) as u32);
    std::fs::File::options().write(true).open(dst).and_then(|f| f.set_modified(when)).map_err(|e| e.to_string())
}

fn copy_dir(src: &Path, dst: &Path, left: &mut usize) -> Result<(), String> {
    let Ok(rd) = std::fs::read_dir(src) else { return Ok(()) };
    for e in rd.flatten() {
        let from = e.path();
        let to = dst.join(e.file_name());
        let md = std::fs::symlink_metadata(&from).map_err(|x| x.to_string())?;
        if md.is_dir() {
            copy_dir(&from, &to, left)?;
        } else {
            if *left == 0 {
                return Err(defaults::text("devswarm_recon.why_mirror_cap").to_string());
            }
            *left -= 1;
            copy_file(&from, &to)?;
        }
    }
    Ok(())
}

/// Copy one store's database with the online backup API into the mirror, with its backend marker.
fn copy_store(src: &Path, dst: &Path, hash: &str) -> Result<(), String> {
    let from_dir = src.join(store_rel(hash));
    let to_dir = dst.join(store_rel(hash));
    std::fs::create_dir_all(&to_dir).map_err(|e| e.to_string())?;
    let marker = defaults::text("mesh.backend_marker");
    if from_dir.join(marker).exists() {
        copy_file(&from_dir.join(marker), &to_dir.join(marker))?;
    }
    let db = store_db(src, hash);
    if !db.is_file() {
        return Ok(());
    }
    let from = rusqlite::Connection::open_with_flags(&db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX)
        .map_err(|e| e.to_string())?;
    from.busy_timeout(defaults::millis("mesh.busy_timeout_ms")).map_err(|e| e.to_string())?;
    let mut to = rusqlite::Connection::open(store_db(dst, hash)).map_err(|e| e.to_string())?;
    let b = rusqlite::backup::Backup::new(&from, &mut to).map_err(|e| e.to_string())?;
    b.run_to_completion(defaults::num("mesh_write.shadow_backup_pages") as i32, defaults::millis("mesh_write.shadow_backup_pause_ms"), None)
        .map_err(|e| e.to_string())
}

/// Build the mirror of `scope` (taken from `src`) at `dst`. An input that is not there is simply absent from the mirror; a
/// directory with more files than `devswarm_recon.mirror_max_files` is an error (a comparison is never partial).
pub fn make(src: &Path, dst: &Path, scope: &Scope) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    let mut left = defaults::num("devswarm_recon.mirror_max_files") as usize;
    for rel in &scope.files {
        if std::fs::symlink_metadata(src.join(rel)).is_ok() {
            copy_file(&src.join(rel), &dst.join(rel))?;
        }
    }
    for rel in &scope.dirs {
        copy_dir(&src.join(rel), &dst.join(rel), &mut left)?;
    }
    for hash in &scope.stores {
        copy_store(src, dst, hash)?;
    }
    Ok(())
}
