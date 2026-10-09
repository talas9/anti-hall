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

/// What `companion/lib/devswarm-pull.js` `defaultRun` reports for one `spawnSync`.
#[derive(Debug, Clone, Default)]
pub struct Call {
    /// A clean exit 0 (`res.ok`).
    pub ok: bool,
    /// The stdout: kept on a non-zero exit or a signal (a failed read can still carry what it popped), empty when the binary
    /// never ran, was stopped at its timeout, or printed past the buffer limit (Node's `r.error` branch).
    pub raw: String,
    /// The call was stopped at its timeout (`timedOut`).
    pub timed_out: bool,
}

/// The outcome of one call: the stdout of a clean exit 0, else `None` (`res.ok` false).
pub fn run(args: &[&str], env: &Env) -> Option<String> {
    let c = call(args, env, defaults::millis("mesh_write.hivecontrol_timeout_ms"));
    c.ok.then_some(c.raw)
}

/// One call bounded by `timeout`, reporting what `defaultRun` reports (see [`Call`]).
pub fn call(args: &[&str], env: &Env, timeout: std::time::Duration) -> Call {
    call_full(args, env, None, timeout).call
}

/// Everything one `spawnSync` of `defaultRun` tells its caller, enough to build the `error` text it returns.
#[derive(Debug, Clone, Default)]
pub struct Full {
    /// What [`call`] reports.
    pub call: Call,
    /// The stderr (decoded as UTF-8, lossily).
    pub stderr: String,
    /// The exit code of a process that exited.
    pub code: Option<i32>,
    /// The signal that ended the process.
    pub signal: Option<i32>,
    /// The process could not be started (the error kind), as `r.error` of a missing binary or working directory.
    pub spawn_failed: Option<std::io::ErrorKind>,
    /// The stdout passed the buffer limit (`ENOBUFS`).
    pub overflow: bool,
}

/// [`call`] in a working directory, with the stderr, the status and the failure kind kept.
pub fn call_full(args: &[&str], env: &Env, cwd: Option<&str>, timeout: std::time::Duration) -> Full {
    use std::os::unix::process::ExitStatusExt;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    let mut cmd = Command::new(defaults::text("mesh_write.hivecontrol_bin"));
    cmd.args(args).env_clear().envs(env).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(d) = cwd {
        cmd.current_dir(d);
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return Full { spawn_failed: Some(e.kind()), ..Full::default() },
    };
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
    let err = Arc::new(Mutex::new(Vec::<u8>::new()));
    let err_done = Arc::new(AtomicBool::new(false));
    if let Some(mut e) = child.stderr.take() {
        let (buf, done) = (Arc::clone(&err), Arc::clone(&err_done));
        std::thread::spawn(move || {
            let mut chunk = vec![0u8; defaults::num("mesh_write.hivecontrol_read_chunk") as usize];
            loop {
                match e.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if let Ok(mut b) = buf.lock()
                            && b.len() <= limit
                        {
                            b.extend_from_slice(&chunk[..n]);
                        }
                    }
                }
            }
            done.store(true, Ordering::SeqCst);
        });
    } else {
        err_done.store(true, Ordering::SeqCst);
    }
    let deadline = Instant::now() + timeout;
    let poll = defaults::millis("mesh_write.hivecontrol_poll_ms");
    let grace = defaults::millis("mesh_write.hivecontrol_kill_grace_ms");
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break Some(st),
            Ok(None) if Instant::now() >= deadline || over.load(Ordering::SeqCst) => {
                timed_out = !over.load(Ordering::SeqCst);
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
    let overflow = over.load(Ordering::SeqCst);
    let Some(st) = status else {
        return Full { call: Call { ok: false, raw: String::new(), timed_out }, overflow, ..Full::default() };
    };
    // the pipes close with the child; give the readers a moment to take the last bytes
    let until = Instant::now() + grace;
    while !(out_done.load(Ordering::SeqCst) && err_done.load(Ordering::SeqCst)) && Instant::now() < until {
        std::thread::sleep(poll);
    }
    let bytes = out.lock().map(|b| b.clone()).unwrap_or_default();
    let stderr = String::from_utf8_lossy(&err.lock().map(|b| b.clone()).unwrap_or_default()).into_owned();
    if bytes.len() > limit {
        return Full { overflow: true, ..Full::default() };
    }
    Full {
        call: Call { ok: st.success(), raw: String::from_utf8_lossy(&bytes).into_owned(), timed_out: false },
        stderr,
        code: st.code(),
        signal: st.signal(),
        spawn_failed: None,
        overflow: false,
    }
}

/// What the capability gate says about one workspace verb, from the cache alone.
#[derive(Debug, PartialEq, Eq)]
pub enum Cap {
    /// The binary cannot be found: Node's `can` answers `hivecontrol-absent` and never spawns or writes.
    Absent,
    /// The build has the verb and is new enough.
    Ok,
    /// The build lacks the verb or is too old and Node already recorded the dormant line: the reason it reports.
    Dormant(String),
    /// Node would probe the binary or record the dormant line in its cache: not reproducible.
    Probe,
}

/// `parseVersion(v)` as numbers; `None` when there is no `x.y.z` in it.
fn version_parts(v: &str) -> Option<[u64; 3]> {
    let re = regex::Regex::new(defaults::text("devswarm_cli.hc_version_re")).ok()?;
    let c = re.captures(v)?;
    Some([c[1].parse().ok()?, c[2].parse().ok()?, c[3].parse().ok()?])
}

/// `can('workspace.<verb>')` from the cache alone: `verb` with its `minVersion` (`None` for any build) and the note the dormant
/// line carries.
pub fn cap_verb(env: &Env, home: &Path, verb: &str, min_version: Option<&str>, note: Option<&str>) -> Cap {
    let Ok(found) = resolve_bin(env, home) else { return Cap::Probe };
    let Some(bin) = found else { return Cap::Absent };
    let cache = home
        .join(defaults::text("mesh_write.dir_anti_hall"))
        .join(defaults::text("mesh_write.dir_devswarm"))
        .join(defaults::text("mesh_write.hivecontrol_cache_file"));
    let Some(c @ OVal::Obj(_)) = std::fs::read_to_string(cache).ok().and_then(|t| OVal::parse(&t)) else { return Cap::Probe };
    let key_ok = matches!(c.get("key"), Some(OVal::Str(k)) if cache_keys(&bin).contains(k));
    let probe = c.get("probe");
    if !key_ok || !probe.is_some_and(|p| matches!(p, OVal::Obj(_)) && p.get("present").is_some_and(OVal::truthy)) {
        return Cap::Probe;
    }
    let name = format!("{}{verb}", defaults::text("devswarm_cli.hc_cap_prefix"));
    let version = match probe.and_then(|p| p.get("version")) {
        Some(OVal::Str(v)) if !v.is_empty() => Some(v.as_str()),
        _ => None,
    };
    let too_old = match (min_version.and_then(version_parts), version.and_then(version_parts)) {
        (Some(min), Some(have)) => have < min,
        _ => false,
    };
    let has_verb = probe.and_then(|p| p.get("verbs")).and_then(|v| v.get(verb)).is_some_and(OVal::truthy);
    if !too_old && has_verb {
        return Cap::Ok;
    }
    let tpl = crate::meshw::extverbs::tpl;
    let min = min_version.unwrap_or_default();
    let have = version.unwrap_or(defaults::text("devswarm_cli.hc_unknown_version"));
    let reason = if too_old {
        tpl("devswarm_cli.hc_reason_old", &[("min", min), ("have", have)])
    } else {
        let lead = if min.is_empty() { String::new() } else { tpl("devswarm_cli.hc_reason_lead", &[("min", min)]) };
        format!("{lead}{}", tpl("devswarm_cli.hc_reason_missing", &[("verb", verb)]))
    };
    let note_part = note.map_or(String::new(), |n| tpl("devswarm_cli.hc_line_note", &[("note", n)]));
    let because = if min.is_empty() { reason.clone() } else { tpl("devswarm_cli.hc_line_needs", &[("min", min), ("have", have)]) };
    let line = tpl("devswarm_cli.hc_line", &[("name", &name), ("note", &note_part), ("because", &because)]);
    // Node records the dormant line in its cache unless the cache already holds exactly it
    match c.get("dormantLog").and_then(|d| d.get(&name)) {
        Some(OVal::Str(l)) if *l == line => Cap::Dormant(reason),
        _ => Cap::Probe,
    }
}
