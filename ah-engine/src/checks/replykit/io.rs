//! File and hash helpers the response guards share, each mirroring the Node idiom it replaces (`fs.readSync` on the
//! tail of a transcript, `crypto.createHash('sha1')`, `lib/state-prune.js`, the session-id sanitiser).
use crate::checks::guardkit::text::js_trim;
use crate::defaults;
use crate::reqenv::RequestEnv;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// The last bytes of a file, decoded as a Node `Buffer.toString('utf8')` does (invalid bytes become U+FFFD).
#[derive(Debug, Clone)]
pub struct Tail {
    /// The decoded text.
    pub data: String,
    /// True when the file was longer than the window, so the text starts in the middle of a line.
    pub truncated: bool,
}

/// Read at most the last `window` bytes of `path`. `None` on any error (the Node reader fails open the same way).
pub fn read_window(path: &str, window: u64) -> Option<Tail> {
    let size = std::fs::metadata(path).ok()?.len();
    crate::load::note_scan(size.min(window));
    if size <= window {
        let bytes = std::fs::read(path).ok()?;
        return Some(Tail { data: crate::checks::guardkit::text::lossy_owned(bytes), truncated: false });
    }
    let mut f = std::fs::File::open(path).ok()?;
    f.seek(SeekFrom::Start(size - window)).ok()?;
    let mut buf = Vec::with_capacity(window as usize);
    f.take(window).read_to_end(&mut buf).ok()?;
    Some(Tail { data: crate::checks::guardkit::text::lossy_owned(buf), truncated: true })
}

/// `data.split(/\r?\n/)`: a line ends at `\n`, and one `\r` just before it belongs to the separator.
pub fn split_lines(data: &str) -> Vec<&str> {
    data.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect()
}

pub use crate::checks::jsport::text::sha1_hex;

/// The home directory of this request (`os.homedir()` is `$HOME` first); `None` when the request carries none, in which
/// case the caller defers: the Node hook would ask the system for a home the engine cannot see.
pub fn home_of(env: &RequestEnv) -> Option<String> {
    env.get("HOME").filter(|h| !h.is_empty()).map(str::to_string)
}

/// `String(id).replace(/[^A-Za-z0-9_.-]/g, '_')`, one underscore per UTF-16 unit, cut to `max` units when given.
pub fn safe_session(id: &str, max: Option<usize>) -> String {
    let mut out = String::new();
    let mut units = 0usize;
    for c in id.chars() {
        let ok = c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-');
        for _ in 0..c.len_utf16() {
            if max.is_some_and(|m| units == m) {
                return out;
            }
            out.push(if ok { c } else { '_' });
            units += 1;
        }
    }
    out
}

/// `String(v)` for the session and agent ids a payload can carry; `None` for shapes whose JavaScript string form the
/// engine does not reproduce (the caller defers).
pub fn js_id_string(v: &serde_json::Value) -> Option<String> {
    match v {
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Bool(b) => Some(b.to_string()),
        serde_json::Value::Number(n) => n.as_f64().filter(|f| f.is_finite()).map(crate::checks::jsport::num::to_js_string),
        _ => None,
    }
}

/// JavaScript truthiness of a payload value.
pub fn truthy(v: &serde_json::Value) -> bool {
    match v {
        serde_json::Value::Null => false,
        serde_json::Value::Bool(b) => *b,
        serde_json::Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        serde_json::Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// Milliseconds since the epoch (`Date.now()`).
pub fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0.0, |d| d.as_millis() as f64)
}

/// `lib/state-prune.js` `pruneStale`: remove state files of one writer that are older than the TTL, at most once per
/// throttle window (a stamp file records the last sweep). Best effort and silent, like the original; it never removes
/// `keep`, the live session's own file.
pub fn prune_stale(dir: &Path, prefix: &str, keep: Option<&str>) {
    let stamp = dir.join(format!("{}{prefix}{}", defaults::text("replykit.prune_stamp_prefix"), defaults::text("replykit.json_ext")));
    let now = now_ms();
    let throttle = defaults::num("replykit.prune_throttle_ms") as f64;
    let ttl = defaults::num("replykit.prune_ttl_ms") as f64;
    if let Ok(raw) = std::fs::read_to_string(&stamp) {
        let raw = js_trim(&raw);
        if !raw.is_empty()
            && let Ok(v) = super::json::parse(raw)
            && let Some(super::json::Oj::Num(last)) = v.get("lastSweep")
            && last.is_finite()
            && *last <= now
            && now - *last < throttle
        {
            return;
        }
    }
    crate::discard::harmless(crate::atomic::write(&stamp, format!("{{\"lastSweep\":{}}}", crate::checks::jsport::num::to_js_string(now)))); // keep: a lost sweep stamp only repeats the sweep
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let full_prefix = format!("{prefix}-");
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if !name.starts_with(&full_prefix) || !name.ends_with(defaults::text("replykit.json_ext")) || keep == Some(name.as_str()) {
            continue;
        }
        let Ok(meta) = std::fs::metadata(e.path()) else { continue };
        let mtime = meta.modified().ok().and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0.0, |d| d.as_secs_f64() * 1000.0);
        if now - mtime > ttl {
            crate::discard::harmless(std::fs::remove_file(e.path())); // keep: cleanup that raced; an absent file is the goal state
        }
    }
}

/// `s.length` in UTF-16 units.
pub fn utf16_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// `s.slice(-n)` where `n` counts UTF-16 units; `None` when the cut would split a surrogate pair.
pub fn suffix_utf16(s: &str, n: usize) -> Option<String> {
    let total = utf16_len(s);
    if n >= total {
        return Some(s.to_string());
    }
    let skip = total - n;
    let mut units = 0usize;
    for (i, c) in s.char_indices() {
        if units == skip {
            return Some(s[i..].to_string());
        }
        units += c.len_utf16();
        if units > skip {
            return None;
        }
    }
    Some(String::new())
}

/// `s.slice(from, to)` is never needed; this is `s.slice(0, n)` over UTF-16 units, `None` when it would split a pair.
pub fn prefix_utf16(s: &str, n: usize) -> Option<String> {
    crate::checks::guardkit::text::slice_utf16(s, n)
}
