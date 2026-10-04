//! Socket / lock / rules locations. Unix sockets are capped at 104 bytes on macOS (108 on Linux), so
//! the default `~/.anti-hall/ah-engine/e.sock` falls back to `<TMPDIR|/tmp>/anti-hall-<uid>/<hash>.sock`
//! (a private 0700 directory the daemon creates and owner-checks) when too long.
use crate::defaults;
use std::path::PathBuf;

/// Real uid of this process.
pub fn uid() -> u32 {
    crate::limits::uid()
}

/// State dir: the `dir` env override, else `<home>/<base_dir>/<state_dir>` (`~/.anti-hall/ah-engine`).
pub fn dir() -> PathBuf {
    if let Some(d) = defaults::env_var("dir") {
        return PathBuf::from(d);
    }
    let home = defaults::env_var("home").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(defaults::text("paths.fallback_tmp")));
    home.join(defaults::text("paths.base_dir")).join(defaults::text("paths.state_dir"))
}

/// The daemon socket path: inside the state dir when it fits, else a private per-user directory under the temp dir.
pub fn socket() -> PathBuf {
    socket_in(&dir())
}

/// The socket path of the daemon whose state directory is `d` (see [`socket`]).
pub fn socket_in(d: &std::path::Path) -> PathBuf {
    let max = defaults::num("paths.socket_max_len") as usize;
    let primary = d.join(defaults::text("paths.socket_file"));
    if primary.as_os_str().len() <= max {
        return primary;
    }
    // stable hash (not DefaultHasher): two builds must agree on the path or a handoff would double-spawn
    let name = format!("{:012x}{}", crate::health::fnv(&d.to_string_lossy()) & 0xffff_ffff_ffff, defaults::text("paths.short_socket_ext"));
    let private = format!("{}{}", defaults::text("paths.private_dir_prefix"), uid());
    if let Some(t) = defaults::env_var("tmpdir") {
        let p = PathBuf::from(t).join(&private).join(&name);
        if p.as_os_str().len() <= max {
            return p;
        }
    }
    PathBuf::from(defaults::text("paths.fallback_tmp")).join(private).join(name)
}

/// Lock file lives next to the socket so one lock guards exactly one socket.
pub fn lock_for(sock: &std::path::Path) -> PathBuf {
    let mut s = sock.as_os_str().to_os_string();
    s.push(defaults::text("paths.lock_suffix"));
    PathBuf::from(s)
}

/// The rules file: `AH_ENGINE_RULES` or `rules.json` in the state dir.
pub fn rules_file() -> PathBuf {
    defaults::env_var("rules").map(PathBuf::from).unwrap_or_else(|| dir().join(defaults::text("paths.rules_file")))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn long_dir_falls_back_under_limit_in_a_private_dir() {
        // single-threaded env mutation is fine: only this test touches AH_ENGINE_DIR in-process
        // FIXME: Audit that the environment access only happens in single-threaded code.
        unsafe { std::env::set_var("AH_ENGINE_DIR", format!("/tmp/{}", "x".repeat(120))) };
        let s = socket();
        let s2 = socket();
        // FIXME: Audit that the environment access only happens in single-threaded code.
        unsafe { std::env::remove_var("AH_ENGINE_DIR") };
        assert!(s.as_os_str().len() <= defaults::num("paths.socket_max_len") as usize, "{:?}", s);
        assert_eq!(s, s2, "deterministic");
        assert!(s.to_string_lossy().contains(&format!("anti-hall-{}/", uid())), "{s:?}");
        assert!(s.to_string_lossy().ends_with(".sock"));
    }
    #[test]
    fn lock_next_to_socket() {
        assert_eq!(lock_for(std::path::Path::new("/a/e.sock")), PathBuf::from("/a/e.sock.lock"));
    }
}
