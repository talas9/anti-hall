//! The file-system side of the guards' per-session state: the same files the Node guards keep under
//! `~/.anti-hall/`, written atomically, and the bounded self-pruning of old ones (`hooks/lib/state-prune.js`).
//!
//! Why files and not memory: a Node hook and the engine can answer for the same session in turn (the engine defers a
//! command it cannot decide exactly, Node then runs), so both must read and write one record. The files are also what
//! survives an engine restart.
use crate::defaults;

/// The state directory under a home directory (`~/.anti-hall`).
pub fn state_dir(home: &str) -> String {
    format!("{home}/{}", defaults::text("guardkit.state_dir_name"))
}

/// Write `body` to `path` through a temporary file in the same directory and a rename, so a reader never sees half a
/// file. Creates the parent directory.
pub fn write_atomic(path: &str, body: &str) -> std::io::Result<()> {
    let p = std::path::Path::new(path);
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir)?;
    }
    crate::atomic::write(p, body)
}

fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

/// `pruneStale({stateDir, prefix, keepFile})`: remove `<prefix>-*.json` files in `dir` older than the TTL, at most once
/// per throttle window (a stamp file), never `keep_file`. Best effort: every error is swallowed. Returns how many files
/// were removed.
///
/// Mirrors `hooks/lib/state-prune.js` `pruneStale`.
pub fn prune_stale(dir: &str, prefix: &str, keep_file: Option<&str>) -> usize {
    let ttl = defaults::num("guardkit.prune_ttl_ms") as f64;
    let throttle = defaults::num("guardkit.prune_throttle_ms") as f64;
    let stamp = format!("{dir}/{}", defaults::fill(defaults::text("guardkit.prune_stamp"), &[("prefix", &prefix)]));
    let now = now_ms();
    if let Ok(raw) = std::fs::read_to_string(&stamp) {
        let raw = crate::checks::guardkit::text::js_trim(&raw);
        if !raw.is_empty()
            && let Ok(v) = serde_json::from_str::<serde_json::Value>(raw)
            && let Some(last) = v.get(defaults::text("guardkit.prune_stamp_key")).and_then(serde_json::Value::as_f64)
            && last <= now
            && now - last < throttle
        {
            return 0;
        }
    }
    let body = format!("{{\"{}\":{}}}", defaults::text("guardkit.prune_stamp_key"), now as u64);
    crate::discard::harmless(crate::atomic::write(&stamp, body)); // keep: a lost sweep stamp only repeats the sweep
    let Ok(rd) = std::fs::read_dir(dir) else { return 0 };
    let full_prefix = format!("{prefix}-");
    let keep = keep_file.map(|k| k.rsplit('/').next().unwrap_or(k).to_string());
    let mut removed = 0;
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if !name.starts_with(&full_prefix) || !name.ends_with(defaults::text("guardkit.state_ext")) || keep.as_deref() == Some(name.as_str()) {
            continue;
        }
        let Ok(md) = e.metadata() else { continue };
        let Ok(mt) = md.modified() else { continue };
        let mt_ms = mt.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0);
        if now - mt_ms > ttl && std::fs::remove_file(e.path()).is_ok() {
            removed += 1;
        }
    }
    removed
}
