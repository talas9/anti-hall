//! The capability gate in front of a `hivecontrol workspace list` call, and ONE bounded call, as Node makes them.
//!
//! Gate (`companion/lib/devswarm-capabilities.js` `gatedRun` / `can` / `probe`): Node finds the binary (an explicit
//! environment path, `PATH`, a saved path file, the DevSwarm app's own copy on macOS), reads the probe it cached for that
//! exact file (`capabilities.json`, keyed by path, mtime and size) and refuses the call when the build's `workspace --help`
//! lacks the verb. A missing or stale cache makes Node probe the binary (spawns) and WRITE the cache with the clock in it,
//! which the engine cannot reproduce, so that case is [`Gate::Probe`] and the verb is Node's. A binary that cannot be found
//! at all passes straight through to the spawn, which then fails exactly as Node's does.
//!
//! The call (`companion/lib/devswarm-pull.js` `defaultRun`; `spawnSync(bin, args, { encoding: 'utf8', timeout, env })`): the child gets the process environment and a closed stdin, its stdout is read to `companion/lib/devswarm-pull.js` `defaultRun` makes it (`spawnSync(bin, args,
//! { encoding: 'utf8', timeout, env })`): the child gets the process environment and a closed stdin, its stdout is read to
//! a limit, and anything but a clean exit 0 is "not ok" (a missing binary, a spawn error, a timeout, a signal, a non-zero
//! exit, output past the buffer limit). Node waits for a child that ignores its termination signal for ever; the engine
//! kills it after a short grace, so a hanging binary is never worse than a missing one.
use crate::checks::guardkit::ojson::OVal;
use crate::checks::jsport::num::to_js_string;
use crate::checks::guardkit::text::js_trim;
use crate::defaults;
use crate::meshw::ident::Env;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Instant;

/// What the capability gate says about `workspace list`.
#[derive(Debug, PartialEq, Eq)]
pub enum Gate {
    /// Node runs the call (the binary may or may not exist: a missing one fails in the spawn).
    Spawn,
    /// Node refuses the call without a spawn and writes nothing: the build lacks the verb and says so already.
    Refused,
    /// Node would probe the binary and write its cache: not reproducible.
    Probe,
}

fn is_file(p: &Path) -> bool {
    std::fs::metadata(p).is_ok_and(|m| m.is_file())
}

/// `resolveBin({ env, home })`; `Err(())` when a `PATH` entry joins to a spelling `path.join` would normalise.
fn resolve_bin(env: &Env, home: &Path) -> Result<Option<PathBuf>, ()> {
    let name = defaults::text("mesh_write.hivecontrol_bin");
    if let Some(explicit) = env.get(defaults::text("mesh_write.env_hivecontrol")) {
        let t = js_trim(explicit);
        if t.starts_with('/') && is_file(Path::new(t)) {
            return Ok(Some(PathBuf::from(t)));
        }
    }
    for dir in env.get("PATH").map(String::as_str).unwrap_or("").split(':') {
        if dir.is_empty() {
            continue;
        }
        if dir.contains("//") || dir.split('/').any(|c| c == "." || c == "..") {
            return Err(());
        }
        let p = Path::new(dir).join(name);
        if is_file(&p) {
            return Ok(Some(p));
        }
    }
    let saved = home
        .join(defaults::text("mesh_write.dir_anti_hall"))
        .join(defaults::text("mesh_write.dir_devswarm"))
        .join(defaults::text("mesh_write.hivecontrol_path_file"));
    if let Some(OVal::Obj(o)) = std::fs::read_to_string(saved).ok().and_then(|t| OVal::parse(&t))
        && let Some((_, OVal::Str(p))) = o.iter().rev().find(|(k, _)| k == name)
        && p.starts_with('/')
        && is_file(Path::new(p))
    {
        return Ok(Some(PathBuf::from(p)));
    }
    if cfg!(target_os = "macos") {
        for k in defaults::list("mesh_write.hivecontrol_known_locations") {
            if is_file(Path::new(k)) {
                return Ok(Some(PathBuf::from(k)));
            }
        }
    }
    Ok(None)
}

/// The key `probe` caches under: `bin|mtimeMs|size`, spelled both ways Node's `mtimeMs` has been computed; a cache that
/// matches neither is not trusted.
fn cache_keys(bin: &Path) -> Vec<String> {
    use std::os::unix::fs::MetadataExt;
    let Ok(m) = std::fs::metadata(bin) else { return Vec::new() };
    let (sec, nsec) = (m.mtime() as f64, m.mtime_nsec() as f64);
    let fractional = sec * 1000.0 + nsec / 1e6;
    let whole = sec * 1000.0 + (m.mtime_nsec() / 1_000_000) as f64;
    let mut keys: Vec<String> = [fractional, whole].iter().map(|ms| format!("{}|{}|{}", bin.to_string_lossy(), to_js_string(*ms), m.size())).collect();
    keys.dedup();
    keys
}

/// `gatedRun`'s decision for `workspace list`, from the cache alone.
pub fn gate(env: &Env, home: &Path) -> Gate {
    let Ok(found) = resolve_bin(env, home) else { return Gate::Probe };
    let Some(bin) = found else { return Gate::Spawn };
    let cache = home
        .join(defaults::text("mesh_write.dir_anti_hall"))
        .join(defaults::text("mesh_write.dir_devswarm"))
        .join(defaults::text("mesh_write.hivecontrol_cache_file"));
    let Some(c @ OVal::Obj(_)) = std::fs::read_to_string(cache).ok().and_then(|t| OVal::parse(&t)) else { return Gate::Probe };
    let key_ok = matches!(c.get("key"), Some(OVal::Str(k)) if cache_keys(&bin).contains(k));
    let probe = c.get("probe");
    if !key_ok || !probe.is_some_and(|p| matches!(p, OVal::Obj(_)) && p.get("present").is_some_and(OVal::truthy)) {
        return Gate::Probe;
    }
    let has_verb = probe.and_then(|p| p.get("verbs")).and_then(|v| v.get(defaults::text("mesh_write.hivecontrol_list_verb"))).is_some_and(OVal::truthy);
    if has_verb {
        return Gate::Spawn;
    }
    // the verb is missing: Node records the dormant line unless the cache already holds exactly it
    let recorded = c.get("dormantLog").and_then(|d| d.get(defaults::text("mesh_write.hivecontrol_list_cap")));
    match recorded {
        Some(OVal::Str(l)) if l == defaults::text("mesh_write.hivecontrol_dormant_line") => Gate::Refused,
        _ => Gate::Probe,
    }
}

/// The outcome of one call: the stdout of a clean exit 0, else `None` (`res.ok` false).
pub fn run(args: &[&str], env: &Env) -> Option<String> {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    let mut child = Command::new(defaults::text("mesh_write.hivecontrol_bin"))
        .args(args)
        .env_clear()
        .envs(env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;
    let limit = defaults::num("mesh_write.hivecontrol_max_stdout_bytes") as usize;
    // both pipes are drained while the child runs, so a chatty child cannot block on a full pipe; the reader fills a shared
    // buffer chunk by chunk, so a grandchild that keeps the pipe open after the child is gone can never hold the verb up
    let out = Arc::new(Mutex::new(Vec::<u8>::new()));
    let out_done = Arc::new(AtomicBool::new(false));
    let over = Arc::new(AtomicBool::new(false));
    if let Some(mut o) = child.stdout.take() {
        let (buf, done, too_much) = (Arc::clone(&out), Arc::clone(&out_done), Arc::clone(&over));
        std::thread::spawn(move || {
            let mut chunk = vec![0u8; defaults::num("mesh_write.hivecontrol_read_chunk") as usize];
            loop {
                match o.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if let Ok(mut b) = buf.lock() {
                            b.extend_from_slice(&chunk[..n]);
                            if b.len() > limit {
                                too_much.store(true, Ordering::SeqCst);
                                break;
                            }
                        }
                    }
                }
            }
            done.store(true, Ordering::SeqCst);
        });
    } else {
        out_done.store(true, Ordering::SeqCst);
    }
    if let Some(mut e) = child.stderr.take() {
        std::thread::spawn(move || {
            let mut sink = vec![0u8; defaults::num("mesh_write.hivecontrol_read_chunk") as usize];
            while matches!(e.read(&mut sink), Ok(n) if n > 0) {}
        });
    }
    let deadline = Instant::now() + defaults::millis("mesh_write.hivecontrol_timeout_ms");
    let poll = defaults::millis("mesh_write.hivecontrol_poll_ms");
    let grace = defaults::millis("mesh_write.hivecontrol_kill_grace_ms");
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break Some(st),
            Ok(None) if Instant::now() >= deadline || over.load(Ordering::SeqCst) => {
                // SAFETY: terminating our own child by pid.
                unsafe { libc::kill(child.id() as i32, libc::SIGTERM) };
                let until = Instant::now() + grace;
                while Instant::now() < until && matches!(child.try_wait(), Ok(None)) {
                    std::thread::sleep(poll);
                }
                crate::discard::harmless(child.kill()); // keep: already gone is fine
                crate::discard::harmless(child.wait()); // keep: reaping
                break None;
            }
            Ok(None) => std::thread::sleep(poll),
            Err(_) => break None,
        }
    };
    let st = status?;
    // the pipe closes with the child; give the reader a moment to take the last bytes
    let until = Instant::now() + grace;
    while !out_done.load(Ordering::SeqCst) && Instant::now() < until {
        std::thread::sleep(poll);
    }
    let bytes = out.lock().map(|b| b.clone()).unwrap_or_default();
    if !st.success() || bytes.len() > limit {
        return None;
    }
    Some(String::from_utf8_lossy(&bytes).into_owned())
}
