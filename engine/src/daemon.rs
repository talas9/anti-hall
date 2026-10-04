//! The resident daemon: one per socket, guarded by an flock'd lock file next to it.
//!
//! Wire protocol (one request per connection, client half-closes after writing):
//!   hook:    `V <client-version>\n<raw hook JSON>`   -> reply = hook output JSON ("" = say nothing)
//!   control: `CTL ping|reload|stop\n`                -> `pong <version> <pid>` / `ok`
//! A hook request from a NEWER client makes this daemon answer, drain queued connections, then exit,
//! so the client's next call cold-starts the new build.
use crate::paths;
use crate::rules::RuleSet;
use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::io::AsRawFd;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime};

const MAX_REQUEST: u64 = 8 * 1024 * 1024;
const LOCK_WAIT: Duration = Duration::from_millis(1500);

static HUP: AtomicBool = AtomicBool::new(false);
extern "C" {
    fn signal(sig: i32, handler: extern "C" fn(i32)) -> usize;
    fn flock(fd: i32, op: i32) -> i32;
}
extern "C" fn on_hup(_: i32) {
    HUP.store(true, Ordering::SeqCst);
}
const LOCK_EX: i32 = 2;
const LOCK_NB: i32 = 4;

/// What to do after replying.
#[derive(Debug, PartialEq, Eq)]
pub enum After {
    Continue,
    Exit,
}

/// Pure request handler (no I/O) so it is unit-testable. `reload` is invoked for `CTL reload`.
pub fn handle_request(req: &[u8], rules: &RuleSet, own_version: &str, reload: &mut dyn FnMut()) -> (String, After) {
    let text = String::from_utf8_lossy(req);
    let (head, body) = text.split_once('\n').unwrap_or((&text, ""));
    if let Some(v) = head.strip_prefix("V ") {
        let reply = crate::hookio::respond(body, rules);
        let newer = crate::version_cmp(v.trim(), own_version) == std::cmp::Ordering::Greater;
        return (reply, if newer { After::Exit } else { After::Continue });
    }
    match head.strip_prefix("CTL ").map(str::trim) {
        Some("ping") => (format!("pong {} {}", own_version, std::process::id()), After::Continue),
        Some("reload") => {
            reload();
            ("ok".into(), After::Continue)
        }
        Some("stop") => ("ok".into(), After::Exit),
        _ => (String::new(), After::Continue),
    }
}

fn read_request(s: &mut UnixStream) -> Vec<u8> {
    let mut buf = Vec::new();
    let _ = s.take(MAX_REQUEST).read_to_end(&mut buf);
    buf
}

/// Take the singleton lock. Waits briefly for an outgoing (version-handoff) daemon to release it, but
/// gives up at once if a live daemon is already answering on the socket.
fn acquire_lock(lock_path: &Path, sock: &Path) -> Option<std::fs::File> {
    let f = std::fs::OpenOptions::new().create(true).write(true).truncate(false).open(lock_path).ok()?;
    let start = std::time::Instant::now();
    loop {
        if unsafe { flock(f.as_raw_fd(), LOCK_EX | LOCK_NB) } == 0 {
            return Some(f);
        }
        if start.elapsed() > LOCK_WAIT || crate::client::ping(sock).is_some() {
            return None;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn mtime(p: &Path) -> Option<(SystemTime, u64)> {
    std::fs::metadata(p).ok().and_then(|m| Some((m.modified().ok()?, m.len())))
}

pub fn serve() {
    let sock = paths::socket();
    let lock_path = paths::lock_for(&sock);
    for d in [paths::dir(), sock.parent().map(Path::to_path_buf).unwrap_or_default()] {
        if !d.as_os_str().is_empty() {
            let _ = std::fs::create_dir_all(&d);
            let _ = std::fs::set_permissions(&d, std::fs::Permissions::from_mode(0o700));
        }
    }
    let Some(_lock) = acquire_lock(&lock_path, &sock) else { return };
    // We hold the lock, so no other daemon owns this socket: whatever file is there is stale.
    let _ = std::fs::remove_file(&sock);
    let Ok(listener) = UnixListener::bind(&sock) else { return };
    let _ = std::fs::set_permissions(&sock, std::fs::Permissions::from_mode(0o600));
    unsafe { signal(1, on_hup) };

    let rules_path = paths::rules_file();
    let mut rules = RuleSet::load(&rules_path).unwrap_or_default();
    let mut seen = mtime(&rules_path);
    let own = crate::version();
    let mut exiting = false;
    // Poll accept with a short timeout so SIGHUP / file-change reloads happen while idle.
    listener.set_nonblocking(true).ok();
    let mut last_check = std::time::Instant::now();
    loop {
        match listener.accept() {
            Ok((mut s, _)) => {
                s.set_nonblocking(false).ok();
                s.set_read_timeout(Some(Duration::from_secs(2))).ok();
                s.set_write_timeout(Some(Duration::from_secs(2))).ok();
                let req = read_request(&mut s);
                let mut want_reload = false;
                let (reply, after) = handle_request(&req, &rules, &own, &mut || want_reload = true);
                let _ = s.write_all(reply.as_bytes());
                drop(s);
                if want_reload {
                    rules = RuleSet::load(&rules_path).unwrap_or(rules);
                    seen = mtime(&rules_path);
                }
                if after == After::Exit && !exiting {
                    exiting = true;
                    // Stop accepting NEW clients (they cold-start the next build), but drain what is queued.
                    let _ = std::fs::remove_file(&sock);
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if exiting {
                    break; // queue drained
                }
                std::thread::sleep(Duration::from_millis(5));
                // every ~200 ms (wall clock, so a busy daemon still reloads): SIGHUP or rules-file change
                if last_check.elapsed() >= Duration::from_millis(200) {
                    last_check = std::time::Instant::now();
                    let now = mtime(&rules_path);
                    if HUP.swap(false, Ordering::SeqCst) || now != seen {
                        // A bad edit keeps the previous rules rather than dropping all protection.
                        if let Ok(r) = RuleSet::load(&rules_path) {
                            rules = r;
                        }
                        seen = now;
                    }
                }
            }
            Err(_) => std::thread::sleep(Duration::from_millis(5)),
        }
    }
    let _ = std::fs::remove_file(&lock_path); // lock itself is released on process exit
}

#[cfg(test)]
mod tests {
    use super::*;
    fn rs() -> RuleSet {
        RuleSet::parse(r#"{"version":1,"rules":[{"pattern":"BAD","action":"deny","message":"no"}]}"#).unwrap()
    }
    fn call(req: &str, own: &str) -> (String, After) {
        handle_request(req.as_bytes(), &rs(), own, &mut || {})
    }

    #[test]
    fn same_or_older_client_keeps_daemon_alive() {
        let req = r#"V 0.1.0
{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"BAD"}}"#;
        let (reply, after) = call(req, "0.1.0");
        assert!(reply.contains("deny"));
        assert_eq!(after, After::Continue);
        assert_eq!(call(req, "0.2.0").1, After::Continue);
    }

    #[test]
    fn newer_client_still_gets_its_answer_then_daemon_retires() {
        let req = "V 0.2.0\n{\"hook_event_name\":\"PreToolUse\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"BAD\"}}";
        let (reply, after) = call(req, "0.1.0");
        assert!(reply.contains("deny"), "in-flight request is still served");
        assert_eq!(after, After::Exit);
    }

    #[test]
    fn control_requests() {
        assert!(call("CTL ping\n", "9.9.9").0.starts_with("pong 9.9.9 "));
        assert_eq!(call("CTL stop\n", "1").1, After::Exit);
        let mut reloaded = false;
        handle_request(b"CTL reload\n", &rs(), "1", &mut || reloaded = true);
        assert!(reloaded);
        assert_eq!(call("garbage", "1"), (String::new(), After::Continue));
    }
}
