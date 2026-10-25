//! Small helpers that cannot panic: time, environment, safe stderr, byte scans.

use std::io::Write;
use std::os::unix::fs::MetadataExt;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn env_nonempty(name: &str) -> Option<String> {
    if name.is_empty() {
        return None;
    }
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

pub fn is_exec(p: &Path) -> bool {
    std::fs::metadata(p).is_ok_and(|m| m.is_file() && m.mode() & 0o111 != 0)
}

pub fn uid() -> u32 {
    // SAFETY: getuid has no preconditions and cannot fail.
    unsafe { libc::getuid() }
}

/// One line on stderr. Never panics (`eprintln!` does when stderr is closed or a broken pipe).
pub fn say(line: &str) {
    let mut e = std::io::stderr();
    let _ = e.write_all(line.as_bytes());
    let _ = e.write_all(b"\n");
}

pub fn positive(v: &str) -> Option<u64> {
    (!v.is_empty() && v.chars().all(|c| c.is_ascii_digit()))
        .then(|| v.parse().ok())
        .flatten()
        .filter(|n| *n > 0)
}

pub fn find_sub(hay: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || hay.len() < needle.len() {
        return None;
    }
    hay.windows(needle.len()).position(|w| w == needle)
}

fn skip_ws(b: &[u8]) -> &[u8] {
    let n = b.iter().take_while(|c| c.is_ascii_whitespace()).count();
    &b[n..]
}

/// A top-level string field of a JSON object, found by a scan of the (bounded) prefix; works on bytes, so a payload that
/// is not valid UTF-8 elsewhere still yields its session id.
pub fn json_str_field(payload: &[u8], field: &str) -> Option<String> {
    let pat = format!("\"{field}\"");
    let at = find_sub(payload, pat.as_bytes())? + pat.len();
    let rest = skip_ws(&payload[at..]).strip_prefix(b":")?;
    let rest = skip_ws(rest).strip_prefix(b"\"")?;
    let end = rest.iter().position(|c| *c == b'"')?;
    Some(String::from_utf8_lossy(&rest[..end]).into_owned())
}

/// `"<field>": true` anywhere in the prefix.
pub fn json_true_field(payload: &[u8], field: &str) -> bool {
    let pat = format!("\"{field}\"");
    let Some(i) = find_sub(payload, pat.as_bytes()) else {
        return false;
    };
    skip_ws(&payload[i + pat.len()..])
        .strip_prefix(b":")
        .is_some_and(|r| skip_ws(r).starts_with(b"true"))
}

/// Replace `{name}` placeholders.
pub fn fill(template: &str, subs: &[(&str, &str)]) -> String {
    let mut s = template.to_string();
    for (k, v) in subs {
        s = s.replace(&format!("{{{k}}}"), v);
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scans_work_on_bytes() {
        let p = b"{\"a\":1,\"session_id\" : \"s-1\",\"stop_hook_active\": true,\"x\":\"\xff\xfe\"}";
        assert_eq!(json_str_field(p, "session_id").as_deref(), Some("s-1"));
        assert!(json_true_field(p, "stop_hook_active"));
        assert!(!json_true_field(
            b"{\"stop_hook_active\":false}",
            "stop_hook_active"
        ));
        assert_eq!(json_str_field(b"{}", "session_id"), None);
        assert_eq!(fill("a {x} b {y}", &[("x", "1"), ("y", "2")]), "a 1 b 2");
    }
}
