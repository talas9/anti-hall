//! The resident daemon: one per socket, guarded by an flock'd lock file next to it.
//!
//! Requests (one per connection; the client half-closes after writing), replies are always framed
//! (`frame.rs`):
//!   hook:     `V <client-version>\n<raw hook JSON>`  -> OK <hook output JSON, "" = nothing to say> | ERR | BUSY
//!   control:  `CTL ping|reload|stop|status`           -> OK
//!   project:  `P <cwd>\n<verb> <args>`                -> OK <value> | ERR   (state partitioned by project)
//! A hook request from a NEWER client makes this daemon answer, drain queued connections, then exit,
//! so the client's next call cold-starts the new build.
//!
//! Threads: the accept loop (poll, no busy wait), `workers` request threads fed by a bounded queue
//! (overflow = BUSY), and a watchdog (heartbeats + RSS check) that turns a stall into a clean drain+exit.
use crate::config::Config;
use crate::frame::{self, Kind};
use crate::health;
use crate::limits::{self, Buckets};
use crate::paths;
use crate::rules::RuleSet;
use crate::store::{KeyCache, Store};
use std::collections::VecDeque;
use std::io::{Read, Write};
use std::os::unix::fs::{FileTypeExt, PermissionsExt};
use std::os::unix::io::AsRawFd;
use std::os::unix::net::{UnixListener, UnixStream};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering::SeqCst};
use std::sync::{Arc, Condvar, Mutex, RwLock};
use std::time::{Duration, Instant, SystemTime};

const LOCK_WAIT: Duration = Duration::from_millis(1500);
/// After a drain starts, a worker or loop that does not finish in this long is cut off.
const DRAIN_GRACE: Duration = Duration::from_millis(1000);

static HUP: AtomicBool = AtomicBool::new(false);
static TERM: AtomicBool = AtomicBool::new(false);
extern "C" fn on_hup(_: libc::c_int) {
    HUP.store(true, SeqCst);
}
extern "C" fn on_term(_: libc::c_int) {
    TERM.store(true, SeqCst);
}

/// What to do after replying.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum After {
    Continue,
    Exit,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Reply {
    Ok(String),
    Busy,
    Err(String),
}

impl Reply {
    pub fn frame(&self) -> Vec<u8> {
        match self {
            Reply::Ok(b) => frame::encode(Kind::Ok, b),
            Reply::Busy => frame::encode(Kind::Busy, ""),
            Reply::Err(b) => frame::encode(Kind::Err, b),
        }
    }
}

#[derive(Default)]
pub struct Stats {
    pub requests: AtomicU64,
    pub busy: AtomicU64,
    pub errors: AtomicU64,
    pub budget_trips: AtomicU64,
    pub panics: AtomicU64,
    pub rejected: AtomicU64,
}

/// Everything the request handler and the threads share.
pub struct Shared {
    pub cfg: Config,
    pub own: String,
    pub rules: RwLock<Arc<RuleSet>>,
    rules_path: std::path::PathBuf,
    seen: Mutex<Option<(SystemTime, u64)>>,
    sessions: Mutex<Buckets>,
    projects: Mutex<Buckets>,
    store: Mutex<Store>,
    keys: Mutex<KeyCache>,
    pub stats: Stats,
    queue: Mutex<VecDeque<UnixStream>>,
    cv: Condvar,
    pub depth: AtomicUsize,
    started: Instant,
    pub rlimit: String,
    pub draining: AtomicBool,
    /// ms since `started` at the last accept-loop iteration
    loop_beat: AtomicU64,
    /// per worker: 0 = idle, else (ms since `started`) + 1 when it picked up the current request
    busy_since: Vec<AtomicU64>,
    stall_ms: AtomicU64,
    pub rss_kb: AtomicU64,
    starts: u64,
}

fn lk<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl Shared {
    pub fn new(cfg: Config, own: &str, rules: RuleSet, rules_path: std::path::PathBuf) -> Shared {
        let workers = cfg.workers;
        Shared {
            sessions: Mutex::new(Buckets::new(cfg.session_rps, cfg.session_burst)),
            projects: Mutex::new(Buckets::new(cfg.project_rps, cfg.project_burst)),
            cfg,
            own: own.to_string(),
            rules: RwLock::new(Arc::new(rules)),
            seen: Mutex::new(mtime(&rules_path)),
            rules_path,
            store: Mutex::new(Store::default()),
            keys: Mutex::new(KeyCache::default()),
            stats: Stats::default(),
            queue: Mutex::new(VecDeque::new()),
            cv: Condvar::new(),
            depth: AtomicUsize::new(0),
            started: Instant::now(),
            rlimit: "off".into(),
            draining: AtomicBool::new(false),
            loop_beat: AtomicU64::new(0),
            busy_since: (0..workers).map(|_| AtomicU64::new(0)).collect(),
            stall_ms: AtomicU64::new(0),
            rss_kb: AtomicU64::new(0),
            starts: 0,
        }
    }

    fn ms(&self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }

    /// Re-read the rules file; a file that fails to parse keeps the previous rules.
    fn reload(&self) {
        if let Ok(r) = RuleSet::load(&self.rules_path) {
            *self.rules.write().unwrap_or_else(|e| e.into_inner()) = Arc::new(r);
        }
        *lk(&self.seen) = mtime(&self.rules_path);
    }

    fn status(&self) -> String {
        let rules = self.rules.read().unwrap_or_else(|e| e.into_inner()).clone();
        let b = health::breaker_remaining();
        let c = health::crashloop_remaining();
        serde_json::json!({
            "running": true,
            "pid": std::process::id(),
            "version": self.own,
            "uptime_s": self.started.elapsed().as_secs(),
            "rss_kb": limits::rss_kb(),
            "cpu_s": (limits::process_cpu_secs() * 1000.0).round() / 1000.0,
            "queue_depth": self.depth.load(SeqCst),
            "queue_cap": self.cfg.queue,
            "workers": self.cfg.workers,
            "requests": self.stats.requests.load(SeqCst),
            "busy_replies": self.stats.busy.load(SeqCst),
            "errors": self.stats.errors.load(SeqCst),
            "budget_trips": self.stats.budget_trips.load(SeqCst),
            "panics": self.stats.panics.load(SeqCst),
            "rejected_peers": self.stats.rejected.load(SeqCst),
            "starts": self.starts,
            "restarts": self.starts.saturating_sub(1),
            "breaker": b.map_or("closed".to_string(), |d| format!("open ({} s left)", d.as_secs() + 1)),
            "crashloop": c.map_or("clear".to_string(), |d| format!("stopped ({} s left)", d.as_secs() + 1)),
            "rules": {"version": rules.version, "count": rules.rules.len(), "fingerprint": format!("{:016x}", rules.fingerprint())},
            "mem_limit": self.rlimit,
            "rss_cap_kb": self.cfg.rss_cap_kb,
        })
        .to_string()
    }
}

/// Pure-ish request handler (no socket I/O) so it is unit-testable.
pub fn handle_request(req: &[u8], sh: &Shared) -> (Reply, After) {
    sh.stats.requests.fetch_add(1, SeqCst);
    let text = String::from_utf8_lossy(req);
    let (head, body) = text.split_once('\n').unwrap_or((&text, ""));
    if let Some(v) = head.strip_prefix("V ") {
        let reply = hook(body, sh);
        let newer = crate::version_cmp(v.trim(), &sh.own) == std::cmp::Ordering::Greater;
        return (reply, if newer { After::Exit } else { After::Continue });
    }
    if let Some(cwd) = head.strip_prefix("P ") {
        return (project_op(cwd.trim(), body, sh), After::Continue);
    }
    match head.strip_prefix("CTL ").map(str::trim) {
        Some("ping") => (Reply::Ok(format!("pong {} {}", sh.own, std::process::id())), After::Continue),
        Some("reload") => {
            sh.reload();
            (Reply::Ok("ok".into()), After::Continue)
        }
        Some("stop") => (Reply::Ok("ok".into()), After::Exit),
        Some("status") => (Reply::Ok(sh.status()), After::Continue),
        Some(t) if sh.cfg.test_hooks => test_verb(t, sh),
        _ => (Reply::Err("unknown request".into()), After::Continue),
    }
}

/// Verbs that exist only to test the watchdog and panic containment (`ANTIHALL_ENGINE_TEST_HOOKS=1`).
fn test_verb(t: &str, sh: &Shared) -> (Reply, After) {
    let (verb, arg) = t.split_once(' ').unwrap_or((t, ""));
    let ms: u64 = arg.trim().parse().unwrap_or(0);
    match verb {
        "sleep" => std::thread::sleep(Duration::from_millis(ms)),
        "stall" => sh.stall_ms.store(ms, SeqCst),
        "panic" => panic!("test panic"),
        _ => return (Reply::Err("unknown request".into()), After::Continue),
    }
    (Reply::Ok("ok".into()), After::Continue)
}

fn project_key(sh: &Shared, cwd: &str) -> String {
    lk(&sh.keys).key(cwd)
}

fn hook(body: &str, sh: &Shared) -> Reply {
    let Ok(p) = serde_json::from_str::<serde_json::Value>(body) else {
        sh.stats.errors.fetch_add(1, SeqCst);
        return Reply::Err("malformed payload".into());
    };
    let session = p.get("session_id").and_then(|v| v.as_str()).unwrap_or("-");
    let pkey = project_key(sh, p.get("cwd").and_then(|v| v.as_str()).unwrap_or("/"));
    if !lk(&sh.sessions).allow(session) || !lk(&sh.projects).allow(&pkey) {
        sh.stats.busy.fetch_add(1, SeqCst);
        return Reply::Busy;
    }
    let rules = sh.rules.read().unwrap_or_else(|e| e.into_inner()).clone();
    let (start, budget) = (limits::thread_cpu_us(), sh.cfg.eval_budget_us);
    let over = move || budget > 0 && limits::thread_cpu_us().saturating_sub(start) > budget;
    match crate::hookio::respond_value(&p, &rules, &over) {
        Ok(out) if out == crate::hookio::FALLBACK => Reply::Err("built-in check defers to the Node hook".into()),
        Ok(out) => Reply::Ok(out),
        Err(_) => {
            sh.stats.budget_trips.fetch_add(1, SeqCst);
            health::log_event("budget", "-", "rule evaluation exceeded its cpu budget");
            Reply::Err("cpu budget exceeded".into())
        }
    }
}

/// `P <cwd>\n<verb> <args>`: the partition is derived here from `cwd`; the request cannot name a key.
fn project_op(cwd: &str, body: &str, sh: &Shared) -> Reply {
    if cwd.is_empty() {
        return Reply::Err("missing cwd".into());
    }
    let key = project_key(sh, cwd);
    if !lk(&sh.projects).allow(&key) {
        sh.stats.busy.fetch_add(1, SeqCst);
        return Reply::Busy;
    }
    let (verb, args) = body.trim_end_matches('\n').split_once(' ').unwrap_or((body.trim(), ""));
    match lk(&sh.store).op(&key, verb, args) {
        Ok(v) => Reply::Ok(v),
        Err(e) => Reply::Err(e),
    }
}

/// Read a whole request within `read_deadline` and `max` bytes.
fn read_request(s: &mut UnixStream, cfg: &Config) -> Result<Vec<u8>, &'static str> {
    s.set_read_timeout(Some(Duration::from_millis(100))).ok();
    let start = Instant::now();
    let (mut buf, mut chunk) = (Vec::new(), [0u8; 8192]);
    loop {
        if start.elapsed() > cfg.read_deadline {
            return Err("read deadline");
        }
        match s.read(&mut chunk) {
            Ok(0) => return Ok(buf),
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.len() as u64 > cfg.max_request {
                    return Err("request too large");
                }
            }
            Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut | std::io::ErrorKind::Interrupted) => continue,
            Err(_) => return Err("read error"),
        }
    }
}

fn write_reply(s: &mut UnixStream, r: &Reply, cfg: &Config) {
    s.set_write_timeout(Some(cfg.write_deadline)).ok();
    let _ = s.write_all(&r.frame());
}

fn serve_conn(mut s: UnixStream, sh: &Shared) -> After {
    s.set_nonblocking(false).ok();
    let req = match read_request(&mut s, &sh.cfg) {
        Ok(r) => r,
        Err(why) => {
            sh.stats.errors.fetch_add(1, SeqCst);
            write_reply(&mut s, &Reply::Err(why.into()), &sh.cfg);
            return After::Continue;
        }
    };
    let (reply, after) = match catch_unwind(AssertUnwindSafe(|| handle_request(&req, sh))) {
        Ok(r) => r,
        Err(_) => {
            sh.stats.panics.fetch_add(1, SeqCst);
            health::log_event("panic", "panic", "a request handler panicked");
            health::record_failure("panic", "panic", "a request handler panicked");
            (Reply::Err("internal error".into()), After::Continue)
        }
    };
    write_reply(&mut s, &reply, &sh.cfg);
    after
}

fn worker(sh: Arc<Shared>, idx: usize) {
    loop {
        let conn = {
            let mut q = lk(&sh.queue);
            loop {
                if let Some(c) = q.pop_front() {
                    sh.depth.fetch_sub(1, SeqCst);
                    break Some(c);
                }
                let (g, _) = sh.cv.wait_timeout(q, Duration::from_millis(200)).unwrap_or_else(|e| e.into_inner());
                q = g;
                if q.is_empty() {
                    break None;
                }
            }
        };
        let Some(conn) = conn else { continue };
        sh.busy_since[idx].store(sh.ms() + 1, SeqCst);
        let after = serve_conn(conn, &sh);
        sh.busy_since[idx].store(0, SeqCst);
        if after == After::Exit {
            begin_drain(&sh, "handoff or stop", false);
        }
    }
}

/// Stop taking new clients (unlink the socket) and arm the forced-exit timer. Idempotent.
fn begin_drain(sh: &Arc<Shared>, why: &str, forced_exit: bool) {
    if sh.draining.swap(true, SeqCst) {
        return;
    }
    let _ = std::fs::remove_file(paths::socket());
    if forced_exit {
        let why = why.to_string();
        std::thread::spawn(move || {
            std::thread::sleep(DRAIN_GRACE);
            health::clear_marker();
            health::log_event("exit", "forced", &why);
            std::process::exit(75);
        });
    }
}

fn watchdog(sh: Arc<Shared>) {
    let mut last_rss = Instant::now();
    loop {
        std::thread::sleep(sh.cfg.watchdog_tick);
        if sh.draining.load(SeqCst) {
            continue;
        }
        let now = sh.ms();
        if now.saturating_sub(sh.loop_beat.load(SeqCst)) > sh.cfg.stall.as_millis() as u64 {
            health::log_event("watchdog", "stall", "accept loop stalled");
            health::record_failure("watchdog", "stall", "the engine loop stalled");
            begin_drain(&sh, "loop stalled", true);
            continue;
        }
        for (i, b) in sh.busy_since.iter().enumerate() {
            let since = b.load(SeqCst);
            if since != 0 && now.saturating_sub(since - 1) > sh.cfg.stuck.as_millis() as u64 {
                health::log_event("watchdog", "stuck", &format!("worker {i} stuck"));
                health::record_failure("watchdog", "stuck", "an engine worker got stuck");
                begin_drain(&sh, "worker stuck", true);
                break;
            }
        }
        if last_rss.elapsed() >= sh.cfg.rss_check {
            last_rss = Instant::now();
            let rss = limits::rss_kb();
            sh.rss_kb.store(rss, SeqCst);
            if sh.cfg.rss_cap_kb > 0 && rss > sh.cfg.rss_cap_kb {
                health::log_event("rss", "rss", &format!("rss {rss} KB over cap {} KB; restarting cleanly", sh.cfg.rss_cap_kb));
                begin_drain(&sh, "rss cap", true);
            }
        }
    }
}

/// Take the singleton lock. Waits briefly for an outgoing (version-handoff) daemon to release it, but
/// gives up at once if a live daemon is already answering on the socket.
fn acquire_lock(lock_path: &Path, sock: &Path) -> Result<Option<std::fs::File>, std::io::Error> {
    let f = std::fs::OpenOptions::new().create(true).read(true).write(true).truncate(false).open(lock_path)?;
    let start = Instant::now();
    loop {
        if unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
            return Ok(Some(f));
        }
        if start.elapsed() > LOCK_WAIT || crate::client::ping(sock).is_some() {
            return Ok(None);
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn mtime(p: &Path) -> Option<(SystemTime, u64)> {
    std::fs::metadata(p).ok().and_then(|m| Some((m.modified().ok()?, m.len())))
}

fn start_fail(code: &str, detail: &str) -> ! {
    health::log_event("start_fail", code, detail);
    health::record_failure("start_fail", code, detail);
    std::process::exit(78);
}

fn io_code(e: &std::io::Error) -> String {
    format!("os{}", e.raw_os_error().unwrap_or(0))
}

pub fn serve() {
    let cfg = Config::from_env();
    let sock = paths::socket();
    let lock_path = paths::lock_for(&sock);
    // state dir + socket dir: private (0700), ours, not a symlink
    for d in [Some(paths::dir()), sock.parent().map(Path::to_path_buf)].into_iter().flatten() {
        if !d.as_os_str().is_empty() {
            if let Err((code, detail)) = limits::ensure_private_dir(&d) {
                start_fail(&code, &detail);
            }
        }
    }
    let lock = match acquire_lock(&lock_path, &sock) {
        Ok(Some(l)) => l,
        Ok(None) => return, // a live daemon owns the socket (or the handoff is not done): not an error
        Err(e) => start_fail(&io_code(&e), &format!("lock {}: {e}", lock_path.display())),
    };
    // We hold the flock, so no other daemon owns this socket. Verify before touching anything: if the
    // pid recorded in the lock file is still a live engine (flock not honoured here), do not steal.
    let prev: u32 = std::fs::read_to_string(&lock_path).ok().and_then(|t| t.trim().parse().ok()).unwrap_or(0);
    if prev != 0 && prev != std::process::id() && health::pid_is_engine(prev) && crate::client::ping(&sock).is_some() {
        return;
    }
    health::reap_marker();
    let _ = (&lock).set_len(0);
    let _ = (&lock).write_all(std::process::id().to_string().as_bytes());
    // a stale socket FILE (from a dead daemon) is removed; anything else at that path is left alone
    if let Ok(m) = std::fs::symlink_metadata(&sock) {
        if m.file_type().is_socket() {
            let _ = std::fs::remove_file(&sock);
        } else {
            start_fail("unsafe_dir", &format!("{} exists and is not a socket", sock.display()));
        }
    }
    let listener = match UnixListener::bind(&sock) {
        Ok(l) => l,
        Err(e) => {
            let code = if sock.as_os_str().len() >= 100 { "path_too_long".to_string() } else { io_code(&e) };
            start_fail(&code, &format!("bind {}: {e}", sock.display()));
        }
    };
    let _ = std::fs::set_permissions(&sock, std::fs::Permissions::from_mode(0o600));
    listener.set_nonblocking(true).ok();
    unsafe {
        libc::signal(libc::SIGHUP, on_hup as extern "C" fn(libc::c_int) as libc::sighandler_t);
        libc::signal(libc::SIGTERM, on_term as extern "C" fn(libc::c_int) as libc::sighandler_t);
    }
    let rlimit = limits::apply_mem_limit(cfg.mem_mb);
    limits::apply_nice(cfg.nice);
    health::write_marker();
    health::clear_env_failure();
    let starts = next_start_count();
    health::log_event("start", "-", &format!("v{} pid {} mem_limit {}", crate::version(), std::process::id(), rlimit));

    let rules_path = paths::rules_file();
    let mut sh = Shared::new(cfg, &crate::version(), RuleSet::load(&rules_path).unwrap_or_default(), rules_path);
    sh.rlimit = rlimit;
    sh.starts = starts;
    let sh = Arc::new(sh);
    for i in 0..sh.cfg.workers {
        let s = sh.clone();
        std::thread::spawn(move || worker(s, i));
    }
    {
        let s = sh.clone();
        std::thread::spawn(move || watchdog(s));
    }
    accept_loop(&sh, &listener);
    health::clear_marker();
    health::log_event("exit", "clean", "drained");
    // The socket was unlinked when the drain began (a successor may already own that path); the lock
    // file is never removed (that would let two daemons hold different inodes) and is released on exit.
}

fn next_start_count() -> u64 {
    let p = paths::dir().join("starts");
    let n = std::fs::read_to_string(&p).ok().and_then(|t| t.trim().parse::<u64>().ok()).unwrap_or(0) + 1;
    let _ = std::fs::write(&p, n.to_string());
    n
}

fn accept_loop(sh: &Arc<Shared>, listener: &UnixListener) {
    let me = limits::uid();
    let fd = listener.as_raw_fd();
    let mut last_check = Instant::now();
    loop {
        sh.loop_beat.store(sh.ms(), SeqCst);
        let st = sh.stall_ms.swap(0, SeqCst);
        if st > 0 {
            std::thread::sleep(Duration::from_millis(st)); // test hook: simulate a wedged loop
        }
        if TERM.swap(false, SeqCst) {
            begin_drain(sh, "SIGTERM", false);
        }
        let draining = sh.draining.load(SeqCst);
        let mut pfd = libc::pollfd { fd, events: libc::POLLIN, revents: 0 };
        let timeout = if draining { 20 } else { 200 };
        unsafe { libc::poll(&mut pfd, 1, timeout) };
        let mut got_any = false;
        loop {
            match listener.accept() {
                Ok((s, _)) => {
                    got_any = true;
                    if !limits::peer_allowed(&s, me) {
                        sh.stats.rejected.fetch_add(1, SeqCst);
                        continue; // dropped: another uid never gets a reply
                    }
                    let mut q = lk(&sh.queue);
                    if q.len() >= sh.cfg.queue {
                        drop(q);
                        sh.stats.busy.fetch_add(1, SeqCst);
                        let mut s = s;
                        s.set_nonblocking(false).ok();
                        s.set_write_timeout(Some(Duration::from_millis(100))).ok();
                        let _ = s.write_all(&Reply::Busy.frame());
                    } else {
                        q.push_back(s);
                        sh.depth.fetch_add(1, SeqCst);
                        drop(q);
                        sh.cv.notify_one();
                    }
                }
                Err(_) => break, // WouldBlock (or a transient error): back to poll
            }
        }
        if draining && !got_any && lk(&sh.queue).is_empty() && sh.busy_since.iter().all(|b| b.load(SeqCst) == 0) {
            return; // queue drained, nothing in flight
        }
        // every ~200 ms: SIGHUP or a rules-file change
        if !draining && last_check.elapsed() >= Duration::from_millis(200) {
            last_check = Instant::now();
            let now = mtime(&sh.rules_path);
            if HUP.swap(false, SeqCst) || now != *lk(&sh.seen) {
                sh.reload();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn shared() -> Shared {
        let rs = RuleSet::parse(r#"{"version":1,"rules":[{"pattern":"BAD","action":"deny","message":"no"}]}"#).unwrap();
        Shared::new(Config::from_env(), "0.1.0", rs, "/nonexistent/rules.json".into())
    }
    fn call(req: &str, own: &str) -> (Reply, After) {
        let mut sh = shared();
        sh.own = own.into();
        handle_request(req.as_bytes(), &sh)
    }
    fn ok(r: &Reply) -> &str {
        match r {
            Reply::Ok(s) => s,
            o => panic!("not OK: {o:?}"),
        }
    }

    #[test]
    fn same_or_older_client_keeps_daemon_alive() {
        let req = "V 0.1.0\n{\"hook_event_name\":\"PreToolUse\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"BAD\"}}";
        let (reply, after) = call(req, "0.1.0");
        assert!(ok(&reply).contains("deny"));
        assert_eq!(after, After::Continue);
        assert_eq!(call(req, "0.2.0").1, After::Continue);
    }

    #[test]
    fn newer_client_still_gets_its_answer_then_daemon_retires() {
        let req = "V 0.2.0\n{\"hook_event_name\":\"PreToolUse\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"BAD\"}}";
        let (reply, after) = call(req, "0.1.0");
        assert!(ok(&reply).contains("deny"), "in-flight request is still served");
        assert_eq!(after, After::Exit);
    }

    #[test]
    fn control_requests() {
        assert!(ok(&call("CTL ping\n", "9.9.9").0).starts_with("pong 9.9.9 "));
        assert_eq!(call("CTL stop\n", "1").1, After::Exit);
        let st: serde_json::Value = serde_json::from_str(ok(&call("CTL status\n", "1").0)).unwrap();
        assert_eq!(st["running"], true);
        assert_eq!(st["rules"]["count"], 1);
        assert!(matches!(call("garbage", "1"), (Reply::Err(_), After::Continue)));
        assert!(matches!(call("CTL panic\n", "1"), (Reply::Err(_), _)), "test verbs are off by default");
    }

    #[test]
    fn malformed_payload_is_an_error_reply_never_an_allow() {
        assert!(matches!(call("V 0.1.0\nnot json at all", "0.1.0").0, Reply::Err(_)));
        assert!(matches!(call("V 0.1.0\n", "0.1.0").0, Reply::Err(_)));
    }

    #[test]
    fn per_session_rate_limit_is_independent_per_session() {
        let mut cfg = Config::from_env();
        cfg.session_rps = 0.001;
        cfg.session_burst = 2.0;
        let rs = RuleSet::parse(r#"{"version":1,"rules":[]}"#).unwrap();
        let sh = Shared::new(cfg, "1", rs, "/x".into());
        let q = |s: &str| handle_request(format!("V 1\n{{\"hook_event_name\":\"Stop\",\"session_id\":\"{s}\"}}").as_bytes(), &sh).0;
        assert!(matches!(q("a"), Reply::Ok(_)) && matches!(q("a"), Reply::Ok(_)));
        assert_eq!(q("a"), Reply::Busy);
        assert!(matches!(q("b"), Reply::Ok(_)), "another session is unaffected");
    }

    #[test]
    fn project_ops_are_partitioned_by_cwd() {
        let sh = shared();
        let p = |cwd: &str, body: &str| handle_request(format!("P {cwd}\n{body}").as_bytes(), &sh).0;
        assert_eq!(p("/nonexistent-a", "put hello"), Reply::Ok("ok".into()));
        assert_eq!(p("/nonexistent-b", "take"), Reply::Ok(String::new()));
        assert_eq!(p("/nonexistent-a", "take"), Reply::Ok("hello".into()));
    }
}
