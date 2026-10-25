//! The bounded host spawn primitive (v1.0 lane L07, generic, no rules): run one program the user has installed (an interpreter a
//! guard asks to probe, such as `python3` or `node`) and hand its output to the script. It holds no rule about WHAT to run or how to
//! read the answer: the script builds the argument list (the probe source travels as an argument, never interpolated into a shell)
//! and decides from the result. Installed by [`install`] from [`super::host::install`]; a script calls `ahHost.spawnProbe`.
//!
//! | raw function | what it does |
//! |---|---|
//! | `spawnProbeCached(prog, args, cwd, timeoutMs)` | `spawnProbe` for an answer that depends only on the interpreter and the arguments (a version probe): a completed run is kept per daemon, keyed by the resolved path with its size and modification time, the arguments and the request values named by `host_spawn.cache_key_env`, for `host_spawn.cache_ttl_ms`; a hit costs no run, no budget and no `max_calls` slot; a miss runs the program in a worker bounded by the program ceiling rather than by the request, so a request cut short by its deadline fails open (`skipped`) while the answer still lands for the next one, and a probe already running under the same key is not started twice, and at most `host_spawn.max_workers` workers live at once (a request over the cap, or with no time left, fails open without starting one); a timed-out, killed, skipped or overflowing run is never kept, nor one whose stdout matches `host_spawn.cache_skip_stdout` (an unknown-module answer, which a package install changes) |
//! | `spawnProbe(prog, args, cwd, timeoutMs)` | run `prog` (a bare name in `host_spawn.programs`, looked up on the REQUEST's `PATH`, never the daemon's or the plugin's) with `args`, in `cwd` when it is an existing absolute directory, with the request's environment minus the names `host_spawn.scrub_env` matches, no stdin, its own process group, killed at the timeout. The timeout is clamped to `host_spawn.timeout_max_ms` and to what is left of the request minus `host_spawn.deadline_reserve_ms`; at most `host_spawn.max_calls` runs per script call. Result as JSON text: `{"found":false}` (not installed or not allowed), `{"found":true,"skipped":true}` (no time or budget left: nothing ran), else `{"found":true,"path","status":n\|null,"signal":n\|null,"timedOut":b,"overflow":b,"stdout","stderr"}` (`overflow`: a stream went past `host_spawn.output_max_bytes`; both streams are cut there) |
// Discard triage (E3): nothing in this file is discarded silently; a spawn failure is logged by `crate::proc::run`.

use super::host::{credit_blocking, with_settings};
use crate::checks::guardkit::jsre;
use crate::checks::jsport::fsx;
use crate::defaults;
use crate::mem::{BoundedCache, Spec};
use rquickjs::{Ctx, Function, Object};
use serde_json::json;
use std::cell::RefCell;
use std::os::unix::process::ExitStatusExt;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

thread_local! {
    /// Programs started in this script call.
    static RUNS: RefCell<u64> = const { RefCell::new(0) };
}

/// Completed probe answers (JSON text) per interpreter file, arguments and environment fingerprint. On the memory registry as
/// `spawn_probe` (`mem.spawn_probe.*`).
fn cache() -> &'static BoundedCache<String, String> {
    static CACHE: OnceLock<BoundedCache<String, String>> = OnceLock::new();
    CACHE.get_or_init(|| {
        BoundedCache::new(
            crate::mem::global(),
            Spec::new("spawn_probe", "mem.spawn_probe_soft_bytes", "mem.spawn_probe_hard_bytes", "mem.spawn_probe_low_water_pct")
                .with_entries("mem.spawn_probe_max_entries"),
        )
    })
}

/// (entries, bytes) of the probe cache, for the memory snapshot.
pub fn cache_usage() -> (usize, usize) {
    let c = cache();
    (c.len(), c.bytes())
}

/// The cache key of a run: the interpreter file as it is now (a replaced or upgraded one re-probes), the arguments, and the
/// request values that pick a version behind a shim.
fn cache_key(bin: &str, args: &[String], env: &std::collections::HashMap<String, String>) -> Option<String> {
    let m = std::fs::metadata(bin).ok()?;
    let mtime = m.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_nanos();
    let picked: Vec<String> = defaults::list("host_spawn.cache_key_env").iter().map(|n| format!("{n}={}", env.get(*n).map_or("", String::as_str))).collect();
    Some(format!("{bin}\u{1}{}\u{1}{mtime}\u{1}{}\u{1}{}", m.len(), args.join("\u{2}"), picked.join("\u{2}")))
}

/// Keep `out` under `key` when it is a run that finished by itself: not a timeout or kill (those depend on the load), not an
/// overflow, not "not installed".
fn remember(key: &str, out: &str) -> bool {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(out) else { return false };
    if v["found"] != true || !v["signal"].is_null() || v["timedOut"] != false || v["overflow"] != false {
        return false;
    }
    // an answer that says "not found / unknown" depends on what is installed, which the key cannot see: never kept
    let unkept = defaults::text("host_spawn.cache_skip_stdout");
    if !unkept.is_empty() && jsre::compile(unkept, false).is_match(v["stdout"].as_str().unwrap_or("")) {
        return false;
    }
    let expires = crate::health::now_ms().saturating_add(defaults::num("host_spawn.cache_ttl_ms"));
    cache().insert_with_ttl(key.to_string(), out.to_string(), out.len(), Some(expires))
}

/// A new script call starts: nothing has run yet.
pub(super) fn reset_call() {
    RUNS.with(|r| *r.borrow_mut() = 0);
}

/// The first executable regular file named `name` on `path` (a colon list), searched the way a shell does; empty entries skipped.
fn which(name: &str, path: &str) -> Option<String> {
    path.split(':').filter(|d| !d.is_empty()).map(|d| format!("{}/{name}", d.trim_end_matches('/'))).find(|p| fsx::is_file(p) && fsx::is_executable(p))
}

/// The script's ask, clamped to the configured ceiling.
fn budget_ceiling(asked_ms: f64) -> Duration {
    let cap = defaults::num("host_spawn.timeout_max_ms");
    Duration::from_millis(if asked_ms.is_finite() && asked_ms > 0.0 { (asked_ms as u64).min(cap) } else { cap })
}

/// The timeout a run may use: the script's ask, clamped to the configured ceiling and to what the request has left.
fn budget(asked_ms: f64) -> Option<Duration> {
    let mut d = budget_ceiling(asked_ms);
    if let Some(left) = crate::deadline::remaining() {
        d = d.min(left.saturating_sub(defaults::millis("host_spawn.deadline_reserve_ms")));
    }
    (d >= defaults::millis("host_spawn.min_run_ms")).then_some(d)
}

/// `spawnProbe(prog, args, cwd, timeoutMs)`: see the module table.
pub fn spawn_probe(prog: &str, args: &[String], cwd: Option<&str>, timeout_ms: f64) -> rquickjs::Result<String> {
    spawn_probe_with(prog, args, cwd, timeout_ms, false)
}

/// `spawnProbeCached(prog, args, cwd, timeoutMs)`: see the module table.
pub fn spawn_probe_cached(prog: &str, args: &[String], cwd: Option<&str>, timeout_ms: f64) -> rquickjs::Result<String> {
    spawn_probe_with(prog, args, cwd, timeout_ms, true)
}

fn spawn_probe_with(prog: &str, args: &[String], cwd: Option<&str>, timeout_ms: f64, cacheable: bool) -> rquickjs::Result<String> {
    spawn_probe_in(prog, args, cwd, timeout_ms, cacheable, None)
}

/// `spawn_probe_with` against an explicit environment (the daemon's own, for the start-up warm-up) instead of the request's.
fn spawn_probe_in(
    prog: &str,
    args: &[String],
    cwd: Option<&str>,
    timeout_ms: f64,
    cacheable: bool,
    env: Option<std::collections::HashMap<String, String>>,
) -> rquickjs::Result<String> {
    if !defaults::list("host_spawn.programs").contains(&prog) {
        return Ok(json!({"found": false}).to_string());
    }
    let env = match env {
        Some(e) => e,
        None => with_settings(|st| st.env.clone())?,
    };
    // no PATH in the request: the default search path a C library's execvp uses (as Node's spawn does)
    let Some(bin) = which(prog, env.get(defaults::text("host_spawn.path_env")).map_or(defaults::text("host_spawn.default_path"), String::as_str)) else {
        return Ok(json!({"found": false}).to_string());
    };
    let key = (cacheable && defaults::raw("host_spawn.cache_enabled").as_bool().unwrap_or(false)).then(|| cache_key(&bin, args, &env)).flatten();
    if let Some(hit) = key.as_ref().and_then(|k| cache().get_at(k, crate::health::now_ms())) {
        return Ok(hit);
    }
    let spent = RUNS.with(|r| {
        let mut r = r.borrow_mut();
        *r += 1;
        *r > defaults::num("host_spawn.max_calls")
    });
    if spent {
        return Ok(json!({"found": true, "skipped": true}).to_string());
    }
    let run = Run { prog: prog.to_string(), bin, args: args.to_vec(), env, cwd: cwd.map(str::to_string) };
    let Some(k) = key else {
        // not kept: the request's remaining time bounds the run itself
        let Some(limit) = budget(timeout_ms) else {
            return Ok(json!({"found": true, "skipped": true}).to_string());
        };
        let started = Instant::now();
        let out = run.exec(limit).0;
        credit_blocking(started);
        return Ok(out);
    };
    // A kept answer is worth finishing: the run goes on in a worker bounded by the program ceiling, not by this request, and
    // the request waits for it only as long as its own deadline allows. A request cut short fails open as before, and the
    // finished answer serves the next one (the interpreter is not probed again for `host_spawn.cache_ttl_ms`).
    let ceiling = budget_ceiling(timeout_ms);
    // The request's wait, if it has time left. With none the probe still warms the cache in a worker (below) when a global slot is
    // free and no worker has the key; the request never waits on it and gains no time from it.
    let wait = budget(timeout_ms);
    let (tx, rx) = std::sync::mpsc::channel();
    if !take_slot() {
        // the global worker cap is reached (timed-out probes still running count): fail open, nothing starts
        return Ok(json!({"found": true, "skipped": true}).to_string());
    }
    if claim(&k) {
        let key = k.clone();
        let spawned = std::thread::Builder::new().name("ah-spawn-probe".into()).spawn(move || {
            let (out, completed) = run.exec(ceiling);
            if completed {
                remember(&key, &out);
            }
            release(&key);
            free_slot();
            crate::discard::harmless(tx.send(out));
        });
        if let Err(e) = spawned {
            release(&k);
            free_slot();
            crate::discard::note("spawn_probe_worker_failed", &e.to_string());
            return Ok(json!({"found": true, "skipped": true}).to_string());
        }
    } else {
        // another request is already running this very probe: it warms the cache, this one fails open
        free_slot();
        return Ok(json!({"found": true, "skipped": true}).to_string());
    }
    let Some(wait) = wait else {
        return Ok(json!({"found": true, "skipped": true}).to_string());
    };
    let started = Instant::now();
    let got = rx.recv_timeout(wait);
    credit_blocking(started);
    Ok(match got {
        Ok(out) => out,
        Err(_) => json!({"found": true, "skipped": true}).to_string(),
    })
}

/// Warm the probe cache with the version probes the guards ask for first (`host_spawn.prewarm_programs` with the version arguments
/// of `api_guard_v1.version_args`), in the daemon's own environment, which is the environment of the client that started it. Run
/// on a worker thread after the socket is listening, so it never delays a reply; a probe that cannot finish is simply not kept.
pub fn prewarm() {
    if !defaults::raw("host_spawn.prewarm").as_bool().unwrap_or(false) {
        return;
    }
    let args: Vec<String> = defaults::list("api_guard_v1.version_args").iter().map(|a| (*a).to_string()).collect();
    let timeout = defaults::num("host_spawn.prewarm_timeout_ms") as f64;
    let env: std::collections::HashMap<String, String> = std::env::vars().collect();
    for prog in defaults::list("host_spawn.prewarm_programs") {
        crate::discard::logged("probe_prewarm", spawn_probe_in(prog, &args, None, timeout, true, Some(env.clone())).map_err(|e| e.to_string()));
    }
}

/// A probe to run: everything copied off the request thread, so a worker can finish after the request has been answered.
struct Run {
    prog: String,
    bin: String,
    args: Vec<String>,
    env: std::collections::HashMap<String, String>,
    cwd: Option<String>,
}

impl Run {
    /// Run it for at most `limit`: the result JSON and whether the program finished by itself.
    fn exec(&self, limit: Duration) -> (String, bool) {
        let scrub = jsre::compile(defaults::text("host_spawn.scrub_env"), true);
        let mut cmd = std::process::Command::new(&self.bin);
        cmd.args(&self.args).env_clear();
        for (k, v) in self.env.iter().filter(|(k, _)| !scrub.is_match(k)) {
            cmd.env(k, v);
        }
        if let Some(c) = self.cwd.as_deref().filter(|c| c.starts_with('/') && fsx::is_dir(c)) {
            cmd.current_dir(c);
        }
        let ran = crate::proc::run(cmd, &self.prog, limit, defaults::millis("host_spawn.poll_ms"));
        let cap = defaults::num("host_spawn.output_max_bytes") as usize;
        let cut = |b: &[u8]| crate::checks::guardkit::text::lossy_owned(b[..b.len().min(cap)].to_vec());
        let bin = &self.bin;
        let completed = ran.is_ok();
        let out = match ran {
            Ok(o) => json!({
                "found": true, "path": bin, "status": o.status.code(), "signal": o.status.signal(), "timedOut": false,
                "overflow": o.stdout.len() > cap || o.stderr.len() > cap, "stdout": cut(&o.stdout), "stderr": cut(&o.stderr),
            }),
            Err(crate::proc::Error::Timeout) => {
                json!({"found": true, "path": bin, "status": null, "signal": null, "timedOut": true, "overflow": false, "stdout": "", "stderr": ""})
            }
            // could not start (a race with an uninstall), or its output never completed: the same as not installed
            Err(_) => json!({"found": false}),
        }
        .to_string();
        (out, completed)
    }
}

/// Keys whose probe a worker is running now.
fn inflight() -> std::sync::MutexGuard<'static, std::collections::HashSet<String>> {
    static SET: OnceLock<std::sync::Mutex<std::collections::HashSet<String>>> = OnceLock::new();
    SET.get_or_init(Default::default).lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

static WORKERS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Reserve one of the `host_spawn.max_workers` probe worker slots; false when all are in use.
fn take_slot() -> bool {
    use std::sync::atomic::Ordering::SeqCst;
    let max = defaults::num("host_spawn.max_workers");
    WORKERS.try_update(SeqCst, SeqCst, |n| (n < max).then_some(n + 1)).is_ok()
}

fn free_slot() {
    use std::sync::atomic::Ordering::SeqCst;
    crate::discard::harmless(WORKERS.try_update(SeqCst, SeqCst, |n| Some(n.saturating_sub(1))));
}

/// Take the right to run the probe under `key`; false when a worker already has it.
fn claim(key: &str) -> bool {
    inflight().insert(key.to_string())
}

fn release(key: &str) {
    inflight().remove(key);
}

/// Add the spawn function to `ahHost`.
pub fn install<'a>(c: &Ctx<'a>, h: &Object<'a>) -> rquickjs::Result<()> {
    h.set(
        "spawnProbe",
        Function::new(c.clone(), |prog: String, args: Vec<String>, cwd: Option<String>, timeout: f64| spawn_probe(&prog, &args, cwd.as_deref(), timeout))?,
    )?;
    h.set(
        "spawnProbeCached",
        Function::new(c.clone(), |prog: String, args: Vec<String>, cwd: Option<String>, timeout: f64| {
            spawn_probe_cached(&prog, &args, cwd.as_deref(), timeout)
        })?,
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn interp(tag: &str, body: &str) -> String {
        let d = std::env::temp_dir().join(format!("ah-sp-{tag}-{}", std::process::id()));
        crate::discard::harmless(std::fs::remove_dir_all(&d));
        std::fs::create_dir_all(&d).unwrap();
        let p = d.join("py");
        std::fs::write(&p, body).unwrap();
        p.to_string_lossy().to_string()
    }

    fn done(stdout: &str) -> String {
        json!({"found": true, "path": "/x", "status": 0, "signal": null, "timedOut": false, "overflow": false, "stdout": stdout, "stderr": ""}).to_string()
    }

    fn args() -> Vec<String> {
        vec!["--version".into()]
    }

    #[test]
    fn sp_01_hit_after_keep_and_miss_for_other_key() {
        let p = interp("hit", "#!/bin/sh\necho Python 3.12.1\n");
        let k = cache_key(&p, &args(), &HashMap::new()).unwrap();
        assert!(cache().get_at(&k, crate::health::now_ms()).is_none());
        assert!(remember(&k, &done("Python 3.12.1")));
        assert_eq!(cache().get_at(&k, crate::health::now_ms()).unwrap(), done("Python 3.12.1"));
        let other = cache_key(&p, &["-V".to_string()], &HashMap::new()).unwrap();
        assert!(cache().get_at(&other, crate::health::now_ms()).is_none());
        let venv = HashMap::from([("VIRTUAL_ENV".to_string(), "/v".to_string())]);
        assert_ne!(cache_key(&p, &args(), &venv).unwrap(), k);
    }

    #[test]
    fn sp_02_changed_interpreter_re_probes() {
        let p = interp("chg", "#!/bin/sh\necho Python 3.12.1\n");
        let k1 = cache_key(&p, &args(), &HashMap::new()).unwrap();
        assert!(remember(&k1, &done("Python 3.12.1")));
        std::fs::write(&p, "#!/bin/sh\necho Python 3.13.0 upgraded\n").unwrap();
        let k2 = cache_key(&p, &args(), &HashMap::new()).unwrap();
        assert_ne!(k1, k2);
        assert!(cache().get_at(&k2, crate::health::now_ms()).is_none());
    }

    #[test]
    fn sp_03_failed_runs_are_not_kept() {
        let k = "sp-03-key";
        assert!(!remember(k, &json!({"found": true, "timedOut": true, "signal": null, "overflow": false}).to_string()));
        assert!(!remember(k, &json!({"found": true, "timedOut": false, "signal": 9, "overflow": false}).to_string()));
        assert!(!remember(k, &json!({"found": true, "timedOut": false, "signal": null, "overflow": true}).to_string()));
        assert!(!remember(k, &json!({"found": false}).to_string()));
        assert!(!remember(k, &done("[1, 2, 0]")), "an unknown-module answer is not kept");
        assert!(remember("sp-03-known", &done("[1, 0, 12]")), "a resolved answer is kept");
        assert!(cache().get_at(&k.to_string(), crate::health::now_ms()).is_none());
    }

    #[test]
    fn sp_04_entry_cap_evicts_oldest() {
        let cap = defaults::num("mem.spawn_probe_max_entries") as usize;
        for i in 0..cap + 10 {
            remember(&format!("sp-04-{i}"), &done("v"));
        }
        assert!(cache().len() <= cap, "{} entries over the cap {cap}", cache().len());
        assert!(cache().get_at(&"sp-04-0".to_string(), crate::health::now_ms()).is_none());
        assert!(cache().get_at(&format!("sp-04-{}", cap + 9), crate::health::now_ms()).is_some());
    }

    fn fake_python(tag: &str, body: &str) -> HashMap<String, String> {
        use std::os::unix::fs::PermissionsExt;
        let d = std::env::temp_dir().join(format!("ah-sp-{tag}-{}", std::process::id()));
        crate::discard::harmless(std::fs::remove_dir_all(&d));
        std::fs::create_dir_all(&d).unwrap();
        let p = d.join("python3");
        std::fs::write(&p, body).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        HashMap::from([("PATH".to_string(), d.to_string_lossy().to_string())])
    }

    fn request<R>(env: HashMap<String, String>, deadline_ms: u64, f: impl FnOnce() -> R) -> R {
        crate::deadline::begin(Instant::now());
        crate::deadline::client_deadline(deadline_ms);
        let r = crate::script::host::with_call(crate::checks::git::util::Settings { home: String::new(), env }, || {
            reset_call();
            f()
        });
        crate::deadline::end();
        r
    }

    /// The worker counter is process-wide: the tests that read or fill it run one at a time.
    fn worker_lock() -> std::sync::MutexGuard<'static, ()> {
        static L: std::sync::Mutex<()> = std::sync::Mutex::new(());
        L.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    #[test]
    fn sp_05_timed_out_probes_stay_under_the_global_worker_cap() {
        let _g = worker_lock();
        let env = fake_python("cap", "#!/bin/sh\n/bin/sleep 2\necho Python 3.12.1\n");
        let cap = defaults::num("host_spawn.max_workers");
        let slack = defaults::num("daemon.reply_slack_ms");
        for req in 0..3 {
            request(env.clone(), 500 + slack, || {
                for g in 0..8 {
                    let a = vec![format!("r{req}g{g}")];
                    let out = spawn_probe_cached("python3", &a, None, 15000.0).unwrap();
                    assert!(out.contains("skipped"), "{out}");
                    let live = WORKERS.load(std::sync::atomic::Ordering::SeqCst);
                    assert!(live <= cap, "{live} live probe workers over the cap {cap}");
                }
            });
        }
        assert!(WORKERS.load(std::sync::atomic::Ordering::SeqCst) <= cap);
    }

    #[test]
    fn sp_06_no_budget_left_starts_one_warm_worker_and_the_next_request_hits_the_cache() {
        let _g = worker_lock();
        // workers left by the cap test (sleeping probes) finish first, so a slot is free
        assert!(
            (0..300).any(|_| {
                std::thread::sleep(Duration::from_millis(50));
                WORKERS.load(std::sync::atomic::Ordering::SeqCst) == 0
            }),
            "earlier workers drain"
        );
        let count = std::env::temp_dir().join(format!("ah-sp-warm-count-{}", std::process::id()));
        crate::discard::harmless(std::fs::remove_file(&count));
        let env = fake_python("warm", &format!("#!/bin/sh\necho x >>{}\necho Python 3.12.1\n", count.display()));
        let a = vec!["--version".to_string()];
        let t = Instant::now();
        // no request time left: the call answers skipped at once, and a worker still warms the cache
        request(env.clone(), 0, || {
            let out = spawn_probe_cached("python3", &a, None, 15000.0).unwrap();
            assert!(out.contains("skipped"), "{out}");
        });
        assert!(t.elapsed() < Duration::from_millis(500), "the request never waits on the warm worker: {:?}", t.elapsed());
        let warmed = (0..100).any(|_| {
            std::thread::sleep(Duration::from_millis(50));
            WORKERS.load(std::sync::atomic::Ordering::SeqCst) == 0 && inflight().iter().all(|k| !k.contains("ah-sp-warm"))
        });
        assert!(warmed, "the warm worker finishes");
        // a second request, with time, is served from the cache and runs nothing
        let out = request(env, 5000, || spawn_probe_cached("python3", &a, None, 15000.0).unwrap());
        assert!(out.contains("Python 3.12.1") && !out.contains("skipped"), "{out}");
        assert_eq!(std::fs::read_to_string(&count).unwrap().lines().count(), 1, "exactly one run warmed the cache");
    }

    #[test]
    fn sp_07_a_full_worker_cap_starts_no_warm_worker() {
        let _g = worker_lock();
        let env = fake_python("capfull", "#!/bin/sh\n/bin/sleep 2\n");
        let mut taken = 0;
        while take_slot() {
            taken += 1;
        }
        let before = WORKERS.load(std::sync::atomic::Ordering::SeqCst);
        request(env, 0, || {
            let out = spawn_probe_cached("python3", &["cf".to_string()], None, 15000.0).unwrap();
            assert!(out.contains("skipped"), "{out}");
        });
        assert_eq!(WORKERS.load(std::sync::atomic::Ordering::SeqCst), before, "no worker grew past the cap");
        assert!(inflight().iter().all(|k| !k.contains("capfull")), "{:?}", *inflight());
        for _ in 0..taken {
            free_slot();
        }
    }
}
