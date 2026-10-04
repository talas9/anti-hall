//! Socket / lock / rules locations. Unix sockets are capped at 104 bytes on macOS (108 on Linux), so
//! the default `~/.anti-hall/ah-engine/e.sock` falls back to `<TMPDIR|/tmp>/anti-hall-<uid>/<hash>.sock`
//! (a private 0700 directory the daemon creates and owner-checks) when too long.
use std::path::PathBuf;

const MAX_SOCK: usize = 100; // headroom under 104 (sun_path incl. NUL)

/// Real uid of this process.
pub fn uid() -> u32 {
    crate::limits::uid()
}

/// State dir: `$AH_ENGINE_DIR` or `~/.anti-hall/ah-engine`.
pub fn dir() -> PathBuf {
    if let Some(d) = std::env::var_os("AH_ENGINE_DIR") {
        return PathBuf::from(d);
    }
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/tmp"));
    home.join(".anti-hall").join("ah-engine")
}

/// The daemon socket path: inside the state dir when it fits, else a private per-user directory under the temp dir.
pub fn socket() -> PathBuf {
    let d = dir();
    let primary = d.join("e.sock");
    if primary.as_os_str().len() <= MAX_SOCK {
        return primary;
    }
    // stable hash (not DefaultHasher): two builds must agree on the path or a handoff would double-spawn
    let name = format!("{:012x}.sock", crate::health::fnv(&d.to_string_lossy()) & 0xffff_ffff_ffff);
    let private = format!("anti-hall-{}", uid());
    if let Some(t) = std::env::var_os("TMPDIR") {
        let p = PathBuf::from(t).join(&private).join(&name);
        if p.as_os_str().len() <= MAX_SOCK {
            return p;
        }
    }
    PathBuf::from("/tmp").join(private).join(name)
}

/// Lock file lives next to the socket so one lock guards exactly one socket.
pub fn lock_for(sock: &std::path::Path) -> PathBuf {
    let mut s = sock.as_os_str().to_os_string();
    s.push(".lock");
    PathBuf::from(s)
}

/// The rules file: `AH_ENGINE_RULES` or `rules.json` in the state dir.
pub fn rules_file() -> PathBuf {
    std::env::var_os("AH_ENGINE_RULES").map(PathBuf::from).unwrap_or_else(|| dir().join("rules.json"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn long_dir_falls_back_under_limit_in_a_private_dir() {
        // single-threaded env mutation is fine: only this test touches AH_ENGINE_DIR in-process
        std::env::set_var("AH_ENGINE_DIR", format!("/tmp/{}", "x".repeat(120)));
        let s = socket();
        let s2 = socket();
        std::env::remove_var("AH_ENGINE_DIR");
        assert!(s.as_os_str().len() <= MAX_SOCK, "{:?}", s);
        assert_eq!(s, s2, "deterministic");
        assert!(s.to_string_lossy().contains(&format!("anti-hall-{}/", uid())), "{s:?}");
        assert!(s.to_string_lossy().ends_with(".sock"));
    }
    #[test]
    fn lock_next_to_socket() {
        assert_eq!(lock_for(std::path::Path::new("/a/e.sock")), PathBuf::from("/a/e.sock.lock"));
    }
}
