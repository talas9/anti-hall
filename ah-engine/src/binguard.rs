//! Binary guard: which engine binary has run healthy, and what to do when one that never did loops.
//!
//! The daemon records the sha256 of its own binary (`files.healthy_binary`) once it has stayed up for `daemon.healthy_after_s`
//! (a binary that dies on start never gets there). When the crash-loop rule trips on a binary that has no such record, the
//! client asks the thin client (`ah-hook integrity check`, `rollback.client`) to restore the last known-good binary: it writes
//! `files.rollback_request` and starts the check detached. The thin client owns the swap, because a hung or exiting binary cannot be
//! trusted to replace itself. A crash-loop cooldown also ends by itself when the binary is replaced (see [`cooldown_binary_replaced`]).
//! Every function is best-effort: a state-dir problem never breaks a hook call. Nothing here deletes a binary.
use crate::defaults;
use crate::health;
use crate::paths;
use std::io::Read;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, UNIX_EPOCH};

static HEALTHY_MARKED: AtomicBool = AtomicBool::new(false);

fn state_file(key: &str) -> PathBuf {
    paths::dir().join(defaults::text(&format!("files.{key}")))
}

/// Lowercase hex sha256 of a file, streamed (the binary is several MB).
pub fn sha256_file(p: &Path) -> Option<String> {
    let mut f = std::fs::File::open(p).ok()?;
    let mut ctx = ring::digest::Context::new(&ring::digest::SHA256);
    let mut buf = vec![0u8; defaults::num("rollback.hash_chunk") as usize];
    loop {
        let n = f.read(&mut buf).ok()?;
        if n == 0 {
            break;
        }
        ctx.update(buf.get(..n)?);
    }
    Some(ctx.finish().as_ref().iter().map(|b| format!("{b:02x}")).collect())
}

/// Size and modification time (ms) of a file: a cheap test for "is this still the file I hashed".
fn stamp(p: &Path) -> Option<(u64, u64)> {
    let m = std::fs::metadata(p).ok()?;
    let ms = m.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_millis() as u64;
    Some((m.len(), ms))
}

fn exe() -> Option<PathBuf> {
    std::env::current_exe().ok()
}

/// One line of `files.crashloop_bin`: size, modification time (ms) and sha256 of a binary, space separated.
fn record_line(len: u64, ms: u64, sha: &str) -> String {
    [len.to_string(), ms.to_string(), sha.to_string()].join(defaults::text("rollback.field_sep")) + defaults::text("rollback.line_end")
}

/// The sha256 recorded for the binary that last ran healthy, if any.
pub fn healthy_sha() -> Option<String> {
    let t = std::fs::read_to_string(state_file("healthy_binary")).ok()?;
    t.split_whitespace().next().map(str::to_string)
}

/// Daemon watchdog tick: once up for `daemon.healthy_after_s`, record this binary as having run healthy (once per process).
pub fn note_uptime(uptime: Duration) {
    if uptime < defaults::secs("daemon.healthy_after_s") || HEALTHY_MARKED.swap(true, Ordering::SeqCst) {
        return;
    }
    let Some(sha) = exe().and_then(|p| sha256_file(&p)) else { return };
    if healthy_sha().as_deref() != Some(sha.as_str()) {
        crate::discard::logged("healthy_binary_write", crate::atomic::write(state_file("healthy_binary"), format!("{sha}\n")));
    }
}

/// The crash-loop rule just tripped: remember which binary it tripped on, and when that binary never ran healthy ask for a
/// roll-back to the last known-good one. Returns whether a roll-back was requested.
pub fn on_crashloop_trip() -> bool {
    let Some(p) = exe() else { return false };
    let (Some(sha), Some((len, ms))) = (sha256_file(&p), stamp(&p)) else { return false };
    crate::discard::logged("crashloop_bin_write", crate::atomic::write(state_file("crashloop_bin"), record_line(len, ms, &sha)));
    if healthy_sha().as_deref() == Some(sha.as_str()) {
        return false; // this binary has run healthy: the loop is not its fault, so it stays
    }
    crate::discard::logged("rollback_request_write", crate::atomic::write(state_file("rollback_request"), format!("{sha}\n")));
    health::log_event("rollback_request", "crashloop", &defaults::render("msg.log_rollback_request", &[("sha", &sha)]));
    start_integrity_check();
    true
}

/// Start the thin client's integrity check (`<state>/bin/ah-hook integrity check`) detached, with the state dir this engine uses.
/// Best effort.
fn start_integrity_check() {
    let env = crate::ops::env_snapshot();
    let client = paths::dir().join(defaults::text("rollback.bin_dir")).join(defaults::text("rollback.client"));
    if !client.is_file() {
        return;
    }
    let mut cmd = std::process::Command::new(&client);
    if let Some(root) = crate::ops::plugin_root(&env) {
        cmd.arg("--plugin-root").arg(root);
    }
    let spawned = cmd
        .arg(defaults::text("launcher.cli_integrity_verb"))
        .arg("check")
        .env(defaults::env_name("dir"), paths::dir())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .process_group(0)
        .spawn();
    if let Err(e) = spawned {
        health::log_event("rollback_request", "spawn_fail", &e.to_string());
    }
}

/// True (and the cooldown stamp is dropped) when the binary that tripped the crash-loop rule has been replaced by a different
/// one: a new binary deserves its own chance, so the cooldown ends without waiting.
pub fn cooldown_binary_replaced() -> bool {
    let rec = state_file("crashloop_bin");
    let Ok(t) = std::fs::read_to_string(&rec) else { return false };
    let mut it = t.split_whitespace();
    let (Some(len), Some(ms), Some(sha)) = (it.next(), it.next(), it.next()) else { return false };
    let Some(p) = exe() else { return false };
    let Some((cur_len, cur_ms)) = stamp(&p) else { return false };
    if format!("{cur_len} {cur_ms}") == format!("{len} {ms}") {
        return false;
    }
    match sha256_file(&p) {
        Some(now) if now != sha => {
            health::log_event("crashloop_reset", "new_binary", &defaults::render("msg.log_crashloop_new_binary", &[("sha", &now)]));
            true
        }
        Some(_) => {
            // same content, new mtime (a copy): refresh the stamp so the next call is cheap again
            crate::discard::logged("crashloop_bin_write", crate::atomic::write(rec, record_line(cur_len, cur_ms, sha)));
            false
        }
        None => false,
    }
}

/// The last roll-back the integrity check recorded, as one line (empty when none).
pub fn last_rollback() -> String {
    std::fs::read_to_string(state_file("rollback_last")).map(|t| t.trim().to_string()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binguard_sha256_matches_the_known_vector_and_streams_large_files() {
        let d = std::env::temp_dir().join(format!("ah-binguard-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let f = d.join("abc");
        std::fs::write(&f, "abc").unwrap();
        assert_eq!(sha256_file(&f).unwrap(), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        let big = d.join("big");
        std::fs::write(&big, vec![b'a'; 200_000]).unwrap(); // several read chunks
        assert_eq!(sha256_file(&big).unwrap().len(), 64);
        assert!(sha256_file(&d.join("absent")).is_none());
        assert!(stamp(&f).is_some_and(|(len, _)| len == 3));
    }
}
