//! Socket / lock / rules locations. Unix sockets are capped at 104 bytes on macOS (108 on Linux), so
//! the default `~/.anti-hall/engine/e.sock` falls back to `$TMPDIR/ah-<uid>.sock` when too long.
use std::path::PathBuf;

const MAX_SOCK: usize = 100; // headroom under 104 (sun_path incl. NUL)

extern "C" {
    fn getuid() -> u32;
}

pub fn uid() -> u32 {
    unsafe { getuid() }
}

/// State dir: `$ANTIHALL_ENGINE_DIR` or `~/.anti-hall/engine`.
pub fn dir() -> PathBuf {
    if let Some(d) = std::env::var_os("ANTIHALL_ENGINE_DIR") {
        return PathBuf::from(d);
    }
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/tmp"));
    home.join(".anti-hall").join("engine")
}

pub fn socket() -> PathBuf {
    let primary = dir().join("e.sock");
    if primary.as_os_str().len() <= MAX_SOCK {
        return primary;
    }
    let name = format!("ah-{}.sock", uid());
    if let Some(t) = std::env::var_os("TMPDIR") {
        let p = PathBuf::from(t).join(&name);
        if p.as_os_str().len() <= MAX_SOCK {
            return p;
        }
    }
    PathBuf::from("/tmp").join(name)
}

/// Lock file lives next to the socket so one lock guards exactly one socket.
pub fn lock_for(sock: &std::path::Path) -> PathBuf {
    let mut s = sock.as_os_str().to_os_string();
    s.push(".lock");
    PathBuf::from(s)
}

pub fn rules_file() -> PathBuf {
    std::env::var_os("ANTIHALL_ENGINE_RULES").map(PathBuf::from).unwrap_or_else(|| dir().join("rules.json"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn long_dir_falls_back_under_limit() {
        // single-threaded env mutation is fine: only this test touches ANTIHALL_ENGINE_DIR in-process
        std::env::set_var("ANTIHALL_ENGINE_DIR", format!("/tmp/{}", "x".repeat(120)));
        let s = socket();
        std::env::remove_var("ANTIHALL_ENGINE_DIR");
        assert!(s.as_os_str().len() <= MAX_SOCK, "{:?}", s);
        assert!(s.to_string_lossy().contains(&format!("ah-{}.sock", uid())));
    }
    #[test]
    fn lock_next_to_socket() {
        assert_eq!(lock_for(std::path::Path::new("/a/e.sock")), PathBuf::from("/a/e.sock.lock"));
    }
}
