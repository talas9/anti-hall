//! Primitives shared by the Node-vs-engine parity lanes: running a process with a clean environment and a watchdog, a small
//! worker pool, the seeded generator the corpora draw from (the same generator the retired JavaScript runners used, so a
//! corpus is reproduced exactly), and the lookup of the Node hooks. Node is only ever the system under comparison here:
//! it is spawned as the reference, never used to run test tooling.
#![allow(dead_code)]

use serde_json::{Map, Value};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const ENGINE: &str = env!("CARGO_BIN_EXE_ah-engine");

/// An environment for a child: `None` removes a variable (the equivalent of an `undefined` value).
pub type Env = Vec<(String, Option<String>)>;

pub fn env_of(pairs: &[(&str, &str)]) -> Env {
    pairs.iter().map(|(k, v)| (k.to_string(), Some(v.to_string()))).collect()
}

/// Layer `over` on top of `base`: a later entry for the same name replaces the earlier one (keeping its place), and a `None`
/// value removes the variable.
pub fn env_merge(base: &Env, over: &Env) -> Env {
    let mut out = base.clone();
    for (k, v) in over {
        if let Some(e) = out.iter_mut().find(|(n, _)| n == k) {
            e.1 = v.clone();
        } else {
            out.push((k.clone(), v.clone()));
        }
    }
    out
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64
}

pub fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

/// The Node hooks directory of this checkout, when Node and the hooks are both present (the engine can be built outside
/// the monorepo; the parity lanes are then skipped). In CI (`CI=true`) a missing Node or missing hooks FAIL instead: a
/// parity lane that silently skips there proves nothing.
pub fn hooks_dir() -> Option<PathBuf> {
    hooks_dir_with("node", std::env::var("CI").is_ok_and(|v| v == "true"))
}

fn hooks_dir_with(node: &str, ci: bool) -> Option<PathBuf> {
    let hooks = repo_root().join("plugins/anti-hall/hooks");
    if !hooks.join("auto-handover.js").exists() || Command::new(node).arg("--version").output().is_err() {
        assert!(!ci, "CI=true but no Node ({node}) or no plugin hooks next to the engine: the Node parity lanes cannot be skipped in CI");
        eprintln!("skipped: no Node or no plugin hooks next to the engine");
        return None;
    }
    Some(hooks.canonicalize().unwrap_or(hooks))
}

#[test]
fn a_missing_node_fails_in_ci_and_skips_elsewhere() {
    // review P2 #10: in CI the lanes skipped silently when Node was missing
    assert_eq!(hooks_dir_with("ah-no-such-node-binary", false), None);
    assert!(std::panic::catch_unwind(|| hooks_dir_with("ah-no-such-node-binary", true)).is_err(), "CI must fail, not skip");
}

/// The result of one child process. `code` is the exit status, or `sig:<n>` when the child was killed by a signal.
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct Out {
    pub code: String,
    pub out: String,
    pub err: String,
}

impl Out {
    pub fn code_is(&self, n: i32) -> bool {
        self.code == n.to_string()
    }
    /// The same outcome with stdout and stderr trimmed (the guard lanes compare trimmed text).
    pub fn trimmed(&self) -> Out {
        Out { code: self.code.clone(), out: self.out.trim().to_string(), err: self.err.trim().to_string() }
    }
}

/// The test build's script CPU limit (`.cargo/config.toml`: a debug interpreter is about 4 times slower than the release one the shipped
/// 50 ms limit is sized for) is the one thing a cleared environment must still carry, or the engine defers on a limit that only the
/// debug build misses. The `ah.exec` scale is NOT carried: the freshness cap case needs the shipped child-process limit. Node ignores the name.
pub fn forward_test_scale(c: &mut Command) {
    if let Ok(v) = std::env::var("AH_ENGINE_SCRIPT_TIME_MS") {
        c.env("AH_ENGINE_SCRIPT_TIME_MS", v);
    }
}

/// Run `cmd args` with exactly `env` (nothing inherited), `input` on stdin, in `cwd`; killed after 60 seconds.
pub fn run(cmd: &str, args: &[String], input: &[u8], env: &Env, cwd: &str) -> Out {
    let t0 = Instant::now();
    let r = run_untimed(cmd, args, input, env, cwd);
    timing::add(cmd, t0.elapsed());
    r
}

/// `AH_PARITY_TIMING=1`: the summed wall time of the Node, engine and other children a lane spawned (summed over its worker
/// threads, so with `conc` workers the sums can exceed the lane's wall time). Each nextest test is its own process, so the
/// counters are per test.
pub mod timing {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{Duration, Instant};
    static NODE: [AtomicU64; 2] = [AtomicU64::new(0), AtomicU64::new(0)];
    static ENGINE: [AtomicU64; 2] = [AtomicU64::new(0), AtomicU64::new(0)];
    static OTHER: [AtomicU64; 2] = [AtomicU64::new(0), AtomicU64::new(0)];
    static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();

    pub fn on() -> bool {
        std::env::var("AH_PARITY_TIMING").is_ok_and(|v| v == "1")
    }
    pub(super) fn add(cmd: &str, d: Duration) {
        START.get_or_init(Instant::now);
        let slot = if cmd == super::ENGINE {
            &ENGINE
        } else if cmd == super::node_binary() {
            &NODE
        } else {
            &OTHER
        };
        slot[0].fetch_add(d.as_nanos() as u64, Ordering::Relaxed);
        slot[1].fetch_add(1, Ordering::Relaxed);
    }
    /// Count a span of Node time that did not go through `run` (a replayed golden counts nothing).
    pub fn add_node(d: Duration) {
        START.get_or_init(Instant::now);
        NODE[0].fetch_add(d.as_nanos() as u64, Ordering::Relaxed);
        NODE[1].fetch_add(1, Ordering::Relaxed);
    }
    /// One line for a lane's summary, empty unless timing is on.
    pub fn line(name: &str) -> String {
        if !on() {
            return String::new();
        }
        let s = |a: &[AtomicU64; 2]| (a[0].load(Ordering::Relaxed) as f64 / 1e9, a[1].load(Ordering::Relaxed));
        let (n, e, o) = (s(&NODE), s(&ENGINE), s(&OTHER));
        let wall = START.get().map_or(0.0, |t| t.elapsed().as_secs_f64());
        let share = if n.0 + e.0 + o.0 > 0.0 { 100.0 * n.0 / (n.0 + e.0 + o.0) } else { 0.0 };
        format!(
            "  TIMING {name}: wall={wall:.1}s node={:.1}s/{} engine={:.1}s/{} other={:.1}s/{} node-share={share:.1}% (child time summed over workers)\n",
            n.0, n.1, e.0, e.1, o.0, o.1
        )
    }
}

fn run_untimed(cmd: &str, args: &[String], input: &[u8], env: &Env, cwd: &str) -> Out {
    let mut c = Command::new(cmd);
    c.args(args).env_clear().current_dir(cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    for (k, v) in env {
        if let Some(v) = v {
            c.env(k, v);
        }
    }
    forward_test_scale(&mut c);
    let mut child = match c.spawn() {
        Ok(ch) => ch,
        Err(e) => return Out { code: "spawn-failed".into(), out: String::new(), err: e.to_string() },
    };
    let pid = child.id() as libc::pid_t;
    let mut stdin = child.stdin.take().unwrap();
    let data = input.to_vec();
    let w = std::thread::spawn(move || {
        stdin.write_all(&data).ok();
    });
    let mut so = child.stdout.take().unwrap();
    let mut se = child.stderr.take().unwrap();
    let ro = std::thread::spawn(move || {
        let mut b = Vec::new();
        so.read_to_end(&mut b).ok();
        b
    });
    let re = std::thread::spawn(move || {
        let mut b = Vec::new();
        se.read_to_end(&mut b).ok();
        b
    });
    let deadline = Instant::now() + Duration::from_secs(60);
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Some(s),
            Ok(None) => {}
            Err(_) => break None,
        }
        if Instant::now() >= deadline {
            // SAFETY: `pid` is the id of a child this function spawned and has not yet reaped, so it names no other process
            unsafe { libc::kill(pid, libc::SIGKILL) };
            // the child is being killed; its exit status is not needed
            child.wait().ok();
            break None;
        }
        std::thread::sleep(Duration::from_millis(2));
    };
    w.join().ok();
    let out = String::from_utf8_lossy(&ro.join().unwrap_or_default()).to_string();
    let err = String::from_utf8_lossy(&re.join().unwrap_or_default()).to_string();
    let code = match status {
        Some(s) => match s.code() {
            Some(c) => c.to_string(),
            None => {
                use std::os::unix::process::ExitStatusExt;
                format!("sig:{}", s.signal().unwrap_or(0))
            }
        },
        None => "sig:9".into(),
    };
    Out { code, out, err }
}

/// The `node` the parent's `PATH` finds, as an absolute path: a scenario may give the child a `PATH` without it.
pub(crate) fn node_binary() -> &'static str {
    static NODE: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    NODE.get_or_init(|| {
        let path = std::env::var("PATH").unwrap_or_default();
        path.split(':')
            .map(|d| Path::new(if d.is_empty() { "." } else { d }).join("node"))
            .find(|p| p.is_file())
            .map_or_else(|| "node".to_string(), |p| p.to_string_lossy().to_string())
    })
}

pub fn node(args: &[String], input: &[u8], env: &Env, cwd: &str) -> Out {
    run(node_binary(), args, input, env, cwd)
}

pub fn strs(a: &[&str]) -> Vec<String> {
    a.iter().map(|s| s.to_string()).collect()
}

/// Run `f` for every item on `conc` worker threads (the items are claimed in order).
pub fn pool<T: Sync>(items: &[T], conc: usize, f: impl Fn(&T, usize) + Sync) {
    let next = AtomicUsize::new(0);
    std::thread::scope(|s| {
        for _ in 0..conc.max(1) {
            s.spawn(|| {
                loop {
                    let i = next.fetch_add(1, Ordering::SeqCst);
                    if i >= items.len() {
                        break;
                    }
                    f(&items[i], i);
                }
            });
        }
    });
}

/// The deterministic generator of the corpora: `s = imul(s, 1664525) + 1013904223` over u32, scaled to [0, 1).
pub struct Rng(u32);

impl Rng {
    pub fn new(seed: u32) -> Rng {
        Rng(seed)
    }
    pub fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_mul(1664525).wrapping_add(1013904223);
        self.0 as f64 / 4294967296.0
    }
    /// `Math.floor(R() * n)`
    pub fn below(&mut self, n: usize) -> usize {
        (self.next() * n as f64).floor() as usize
    }
    pub fn pick<'a, T>(&mut self, a: &'a [T]) -> &'a T {
        let i = self.below(a.len());
        &a[i]
    }
}

/// Merge `extra`'s members over `base` (JavaScript `Object.assign`).
pub fn assign(mut base: Value, extra: Value) -> Value {
    if let (Some(b), Some(e)) = (base.as_object_mut(), extra.as_object()) {
        for (k, v) in e {
            b.insert(k.clone(), v.clone());
        }
    }
    base
}

pub fn obj(pairs: Vec<(&str, Value)>) -> Value {
    let mut m = Map::new();
    for (k, v) in pairs {
        m.insert(k.to_string(), v);
    }
    Value::Object(m)
}

/// Remove members (the equivalent of `delete p.x` or of an `undefined` value that `JSON.stringify` drops).
pub fn without(mut v: Value, keys: &[&str]) -> Value {
    if let Some(m) = v.as_object_mut() {
        for k in keys {
            m.remove(*k);
        }
    }
    v
}

/// Replace the token `$HOME` in every string value of a payload (the keys are left alone).
pub fn subst_home(v: &Value, home: &str) -> Value {
    match v {
        Value::String(s) => Value::String(s.replace("$HOME", home)),
        Value::Array(a) => Value::Array(a.iter().map(|x| subst_home(x, home)).collect()),
        Value::Object(m) => Value::Object(m.iter().map(|(k, x)| (k.clone(), subst_home(x, home))).collect()),
        other => other.clone(),
    }
}

/// The file-name part of a session id as the guards build it (letters, digits and `. _ -` kept, the rest `_`, cut to `max`
/// UTF-16 units).
pub fn safe_sid(sid: &str, max: usize) -> String {
    // the replacement works per UTF-16 unit (a scalar outside the BMP becomes two `_`)
    let mut out = String::new();
    let mut units = 0;
    for c in sid.chars() {
        for _ in 0..c.len_utf16() {
            if units < max {
                out.push(if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' { c } else { '_' });
                units += 1;
            }
        }
    }
    out
}

pub fn write_file(path: &Path, body: &[u8]) {
    if let Some(p) = path.parent() {
        std::fs::create_dir_all(p).unwrap();
    }
    std::fs::write(path, body).unwrap();
}

/// Set a file's modification time (and access time) to `secs` seconds since the epoch.
pub fn set_mtime(path: &Path, secs: f64) {
    let t = UNIX_EPOCH + Duration::from_secs_f64(secs.max(0.0));
    let f = std::fs::OpenOptions::new().write(true).open(path).or_else(|_| std::fs::File::open(path));
    if let Ok(f) = f {
        f.set_times(std::fs::FileTimes::new().set_accessed(t).set_modified(t)).ok();
    }
}

pub fn hostname() -> String {
    let mut buf = [0u8; 256];
    // SAFETY: the buffer is valid for `buf.len()` bytes and gethostname writes at most that many (NUL-terminated or truncated)
    unsafe { libc::gethostname(buf.as_mut_ptr() as *mut libc::c_char, buf.len()) };
    let n = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
    String::from_utf8_lossy(&buf[..n]).to_string()
}

/// A scratch directory under the system temp dir, removed on drop.
pub struct Scratch(pub PathBuf);

impl Scratch {
    pub fn new(tag: &str) -> Scratch {
        static N: AtomicUsize = AtomicUsize::new(0);
        // a short base: a daemon's Unix socket path must stay under the platform limit
        let base = if Path::new("/tmp").is_dir() { PathBuf::from("/tmp") } else { std::env::temp_dir() };
        let d = base.join(format!("ah-par-{tag}-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
        std::fs::remove_dir_all(&d).ok();
        std::fs::create_dir_all(&d).unwrap();
        Scratch(d)
    }
    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        if std::env::var_os("AH_PARITY_KEEP").is_some() {
            eprintln!("kept {}", self.0.display());
        } else {
            wipe(&self.0);
        }
    }
}

/// Remove a tree, giving permissions back first (a scenario may have taken away its own).
pub fn wipe(dir: &Path) {
    fn unlock(d: &Path) {
        use std::os::unix::fs::PermissionsExt;
        let Ok(md) = std::fs::symlink_metadata(d) else { return };
        if md.file_type().is_symlink() {
            return;
        }
        if md.is_dir() {
            std::fs::set_permissions(d, std::fs::Permissions::from_mode(0o755)).ok();
            if let Ok(rd) = std::fs::read_dir(d) {
                for e in rd.flatten() {
                    unlock(&e.path());
                }
            }
        } else {
            std::fs::set_permissions(d, std::fs::Permissions::from_mode(0o644)).ok();
        }
    }
    unlock(dir);
    std::fs::remove_dir_all(dir).ok();
}

/// One serialised test lane at a time inside this binary: each lane spawns many processes of its own.
pub static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub fn serial() -> std::sync::MutexGuard<'static, ()> {
    SERIAL.lock().unwrap_or_else(|e| e.into_inner())
}

/// Truncate to at most `n` UTF-16 units on a scalar boundary (what `.slice(0, n)` shows in a report).
pub fn clip(s: &str, n: usize) -> String {
    let mut out = String::new();
    let mut u = 0;
    for c in s.chars() {
        u += c.len_utf16();
        if u > n {
            break;
        }
        out.push(c);
    }
    out
}

/// What `/\s/` matches in JavaScript.
pub fn js_ws(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// `s.replace(/\s+/g, '_')`
pub fn ws_to_underscore(s: &str) -> String {
    let mut out = String::new();
    let mut in_run = false;
    for c in s.chars() {
        if js_ws(c) {
            if !in_run {
                out.push('_');
            }
            in_run = true;
        } else {
            in_run = false;
            out.push(c);
        }
    }
    out
}

/// `s.replace(/[^A-Za-z0-9]/g, '_')` per UTF-16 unit.
pub fn non_alnum_underscore(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars() {
        for _ in 0..c.len_utf16() {
            out.push(if c.is_ascii_alphanumeric() { c } else { '_' });
        }
    }
    out
}

/// Real-world inputs a developer can feed the corpora from local data (never committed): the file named by the environment
/// variable, one JSON document per line; lines that do not parse are skipped.
pub fn real_lines(var: &str) -> Vec<Value> {
    let Some(p) = std::env::var_os(var) else { return Vec::new() };
    let Ok(t) = std::fs::read_to_string(&p) else { return Vec::new() };
    t.split('\n').filter(|l| !l.is_empty()).filter_map(|l| serde_json::from_str::<Value>(l).ok()).collect()
}

/// `AH_PARITY_REAL_CMDS`: lines `{cmd, session, cwd, ...}`; only those with a string `cmd` count.
pub fn real_cmds() -> Vec<Value> {
    real_lines("AH_PARITY_REAL_CMDS").into_iter().filter(|v| v.get("cmd").is_some_and(Value::is_string)).collect()
}

/// `AH_PARITY_REAL_EDITS`: lines `{tool, file, code}`.
pub fn real_edits() -> Vec<Value> {
    real_lines("AH_PARITY_REAL_EDITS")
}

pub fn real_limit() -> usize {
    std::env::var("AH_PARITY_REAL").ok().and_then(|s| s.parse().ok()).unwrap_or(usize::MAX)
}

/// A JSON object text with its members in the given order (values are JSON texts), as `JSON.stringify` of an object literal.
pub fn oj(pairs: &[(&str, String)]) -> String {
    format!("{{{}}}", pairs.iter().map(|(k, v)| format!("{}:{v}", Value::String(k.to_string()))).collect::<Vec<_>>().join(","))
}

/// A JSON string literal.
pub fn js(s: &str) -> String {
    Value::String(s.to_string()).to_string()
}

/// Node's `path.join`: the parts joined with `/`, then normalized (`.` and `..` resolved, repeated separators collapsed, a
/// trailing separator kept).
pub fn path_join(parts: &[&str]) -> String {
    let joined = parts.iter().filter(|p| !p.is_empty()).copied().collect::<Vec<_>>().join("/");
    if joined.is_empty() {
        return ".".into();
    }
    let abs = joined.starts_with('/');
    let trailing = joined.ends_with('/');
    let mut stack: Vec<&str> = Vec::new();
    for seg in joined.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                if stack.last().is_some_and(|l| *l != "..") {
                    stack.pop();
                } else if !abs {
                    stack.push("..");
                }
            }
            s => stack.push(s),
        }
    }
    let mut out = stack.join("/");
    if abs {
        out.insert(0, '/');
    }
    if out.is_empty() {
        out = if abs { "/".into() } else { ".".into() };
    }
    if trailing && !out.ends_with('/') {
        out.push('/');
    }
    out
}

/// `s.replace(/[^A-Za-z0-9]/g, '-')` per UTF-16 unit.
pub fn enc_dashes(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars() {
        for _ in 0..c.len_utf16() {
            out.push(if c.is_ascii_alphanumeric() { c } else { '-' });
        }
    }
    out
}

pub fn sha1_hex(s: &str) -> String {
    ring::digest::digest(&ring::digest::SHA1_FOR_LEGACY_USE_ONLY, s.as_bytes()).as_ref().iter().map(|b| format!("{b:02x}")).collect()
}

/// The local calendar date `days_ago` days before now, `YYYY-MM-DD` (what `new Date(...)`'s local getters give).
pub fn local_day(days_ago: f64) -> String {
    let t = (now_ms() as f64 / 1000.0 - days_ago * 86400.0) as libc::time_t;
    // SAFETY: `tm` is plain old data for which all-zero is a valid value, and localtime_r only writes into it
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    // SAFETY: both pointers are valid for the duration of the call
    unsafe { libc::localtime_r(&t, &mut tm) };
    format!("{:04}-{:02}-{:02}", tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday)
}

/// `new Date(secs * 1000).toISOString()`
pub fn iso_from_secs(secs: i64) -> String {
    let days = secs.div_euclid(86400);
    let rem = secs.rem_euclid(86400);
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z.rem_euclid(146097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.000Z", rem / 3600, (rem % 3600) / 60, rem % 60)
}

/// `new Date(ms).toISOString()`
pub fn iso_from_ms(ms: i64) -> String {
    let base = iso_from_secs(ms.div_euclid(1000));
    format!("{}.{:03}Z", &base[..19], ms.rem_euclid(1000))
}

/// Whole real transcripts under `~/.claude/projects` (read only): the files containing `needle`, bounded by size, in a seeded
/// shuffle. Local data; the corpora use it only when `AH_PARITY_REAL_TRANSCRIPTS` is set.
pub fn real_files(needle: &str, min: f64, max: f64, limit: usize, seed: u32) -> Vec<String> {
    if std::env::var_os("AH_PARITY_REAL_TRANSCRIPTS").is_none() {
        return Vec::new();
    }
    let home = std::env::var("HOME").unwrap_or_default();
    let cmd = format!(
        "find {home}/.claude/projects -name '*.jsonl' -size +{}k -size -{}k -print0 2>/dev/null | xargs -0 grep -l -F -- '{needle}' 2>/dev/null; true",
        (min / 1024.0).floor().max(1.0),
        (max / 1024.0).ceil()
    );
    let out = std::process::Command::new("sh").arg("-c").arg(cmd).output().expect("sh");
    let files: Vec<String> = String::from_utf8_lossy(&out.stdout).split('\n').filter(|l| !l.is_empty()).map(str::to_string).collect();
    let mut r = Rng::new(seed);
    let mut keyed: Vec<(f64, String)> = files.into_iter().map(|f| (r.next(), f)).collect();
    keyed.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    keyed.into_iter().map(|x| x.1).take(limit).collect()
}

pub fn sha1_hex_bytes(b: &[u8]) -> String {
    ring::digest::digest(&ring::digest::SHA1_FOR_LEGACY_USE_ONLY, b).as_ref().iter().map(|x| format!("{x:02x}")).collect()
}
