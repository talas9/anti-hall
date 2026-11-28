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

/// The socket path of the daemon whose state directory is `dir`: the plain path while it fits `paths.socket_max_len`, else the
/// private per-user path named by the FNV-1a hash of the state directory, exactly as the engine names it (`paths::socket_in`).
pub fn engine_socket(s: &crate::cfg::Settings, dir: &Path) -> std::path::PathBuf {
    let plain = dir.join(s.text("paths.socket_file"));
    let max = s.num("paths.socket_max_len") as usize;
    if plain.as_os_str().len() <= max {
        return plain;
    }
    // FNV-1a 64: the hash the engine names the private socket by (ah-engine/src/health.rs); both must agree
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in dir.to_string_lossy().as_bytes() {
        h = (h ^ u64::from(*b)).wrapping_mul(0x0100_0000_01b3);
    }
    let name = format!(
        "{:012x}{}",
        h & 0xffff_ffff_ffff,
        s.text("paths.short_socket_ext")
    );
    let private = format!("{}{}", s.text("paths.private_dir_prefix"), uid());
    // like the engine (`defaults::env_var`): a set-but-empty TMPDIR is used as is, giving a relative path; both sides must agree
    let tmpdir = std::env::var(s.text("env.tmpdir")).ok();
    socket_under(
        tmpdir.as_deref(),
        &s.text("paths.fallback_tmp"),
        &private,
        &name,
        max,
    )
}

/// The engine's choice (`paths::socket_in`): under `tmpdir` when that path fits `max`, else under `fallback`.
fn socket_under(
    tmpdir: Option<&str>,
    fallback: &str,
    private: &str,
    name: &str,
    max: usize,
) -> std::path::PathBuf {
    if let Some(t) = tmpdir {
        let p = Path::new(t).join(private).join(name);
        if p.as_os_str().len() <= max {
            return p;
        }
    }
    Path::new(fallback).join(private).join(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A state directory whose plain socket path is over `paths.socket_max_len` gets the engine's private hashed path (the cold-start
    /// wait watched nothing for such a directory, so the first cold guard call passed unchecked); a short one keeps the plain path.
    #[test]
    fn engine_socket_follows_the_engines_long_path_rule() {
        let s = crate::cfg::Settings::load(Path::new(""));
        let short = Path::new("/tmp/f8/.anti-hall/ah-engine");
        assert_eq!(
            engine_socket(&s, short),
            short.join(s.text("paths.socket_file"))
        );
        let long = std::env::temp_dir()
            .join("a".repeat(30))
            .join("b".repeat(30))
            .join("c".repeat(30))
            .join("d".repeat(30));
        let long = long.as_path();
        assert!(long.join(s.text("paths.socket_file")).as_os_str().len() > 100);
        let p = engine_socket(&s, long);
        assert!(
            p.as_os_str().len() as u64 <= s.num("paths.socket_max_len"),
            "{p:?}"
        );
        assert!(
            p.to_string_lossy()
                .ends_with(&s.text("paths.short_socket_ext")),
            "{p:?}"
        );
        assert_ne!(p, long.join(s.text("paths.socket_file")));
    }

    #[test]
    fn socket_under_uses_tmpdir_when_it_fits_else_the_fallback() {
        assert_eq!(
            socket_under(Some("/t"), "/fb", "p-1", "n.sock", 100),
            Path::new("/t/p-1/n.sock")
        );
        assert_eq!(
            socket_under(Some("/t"), "/fb", "p-1", "n.sock", 5),
            Path::new("/fb/p-1/n.sock")
        );
        assert_eq!(
            socket_under(None, "/fb", "p-1", "n.sock", 100),
            Path::new("/fb/p-1/n.sock")
        );
    }

    /// The engine does not filter an empty TMPDIR (`defaults::env_var`): it builds the relative `p-1/n.sock`; the launcher must
    /// compute the same path (engine-side bug filed separately).
    #[test]
    fn socket_under_mirrors_the_engine_for_an_empty_tmpdir() {
        assert_eq!(
            socket_under(Some(""), "/fb", "p-1", "n.sock", 100),
            Path::new("p-1/n.sock")
        );
    }

    #[test]
    fn the_hash_covers_the_lossy_bytes_like_the_engine() {
        use std::os::unix::ffi::OsStrExt;
        let s = crate::cfg::Settings::load(Path::new(""));
        let bad = std::path::PathBuf::from(std::ffi::OsStr::from_bytes(
            &[b"/x/".as_slice(), &[0xff; 3], "q".repeat(120).as_bytes()].concat(),
        ));
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        for b in bad.to_string_lossy().as_bytes() {
            h = (h ^ u64::from(*b)).wrapping_mul(0x0100_0000_01b3);
        }
        let want = format!(
            "{:012x}{}",
            h & 0xffff_ffff_ffff,
            s.text("paths.short_socket_ext")
        );
        let p = engine_socket(&s, &bad);
        assert_eq!(p.file_name().unwrap().to_string_lossy(), want);
    }

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
