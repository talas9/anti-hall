//! The Node shadow of an operator command (owner rule: every ported behaviour stays comparable against its Node version until
//! proven). The engine's result is the real one; for a sampled run the Node script runs in the background in a scratch home
//! (a snapshot of the state it may change, links to the rest it only reads), and a mismatch of stdout, exit code or the
//! resulting state is logged to telemetry (`cmd` event `shadow`, outcome `error`) with both outputs kept for review.
//!
//! The sampling rates are the plugin's `ops.shadow_rate_*` settings (per thousand; 0 turns a shadow off); the scratch layout,
//! the masks and the Node binary are shipped settings too. Nothing here ever touches the real state: the scratch home is the
//! only place the Node script can write, and it is removed when the comparison matches.
use super::{env_snapshot, err_capture_take, out_capture_take, plugin_root, start_capture};
use crate::defaults;
use ring::digest;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// A sampled run waiting for the engine to finish.
pub struct Plan {
    dir: PathBuf,
    verb: String,
    script: PathBuf,
    args: Vec<String>,
    cwd: String,
    home: String,
    has_stdin: bool,
    started: std::time::Instant,
    /// The installers' shadow: the Node script runs in `cwd` (a scratch copy) and the compared state is the settings files.
    real_cwd: Option<String>,
}

fn rate(verb: &str) -> u64 {
    let is = |key: &str| verb == defaults::text(key);
    if is("ops.verb_statusline") {
        defaults::num("ops.shadow_rate_statusline")
    } else if is("ops.verb_settings") {
        defaults::num("ops.shadow_rate_settings")
    } else if is("ops.verb_phase") {
        defaults::num("ops.shadow_rate_phase")
    } else if is("ops.verb_install") {
        defaults::num("ops.shadow_rate_install")
    } else if is("ops.verb_uninstall") {
        defaults::num("ops.shadow_rate_uninstall")
    } else {
        defaults::num("ops.shadow_rate_defect")
    }
}

/// Cheap sampling: the clock's nanoseconds mixed with the process id, per thousand.
fn sampled(verb: &str) -> bool {
    let r = rate(verb);
    if r == 0 {
        return false;
    }
    let ns = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.subsec_nanos()) as u64;
    (ns ^ u64::from(std::process::id())) % defaults::num("ops.shadow_per") < r
}

fn copy_tree(from: &Path, to: &Path, budget: &mut u64) {
    let Ok(md) = std::fs::symlink_metadata(from) else { return };
    if md.is_dir() {
        if std::fs::create_dir_all(to).is_err() {
            return;
        }
        if let Ok(rd) = std::fs::read_dir(from) {
            for e in rd.flatten() {
                copy_tree(&e.path(), &to.join(e.file_name()), budget);
            }
        }
    } else if md.is_file() && *budget > md.len() {
        *budget -= md.len();
        crate::discard::harmless(std::fs::copy(from, to)); // keep: a file that vanished is simply not in the snapshot
    }
}

/// Start a shadow for `verb` when this run is sampled; the engine's stdout and stderr are captured from here on.
pub fn begin(verb: &str, script_rel: &str, args: &[String], stdin: Option<&[u8]>) -> Option<Plan> {
    if std::env::var_os(defaults::text("ops.shadow_child_env")).is_some() || !sampled(verb) {
        return None;
    }
    let env = env_snapshot();
    let home = super::home(&env);
    let root = plugin_root(&env)?;
    let script = Path::new(&root).join(script_rel);
    if !script.exists() {
        return None;
    }
    let id = format!("{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos()));
    let dir = crate::paths::dir().join(defaults::text("ops.shadow_dir")).join(id);
    let scratch = dir.join("home");
    let base = Path::new(&home).join(defaults::text("paths.base_dir"));
    let sbase = scratch.join(defaults::text("paths.base_dir"));
    std::fs::create_dir_all(&sbase).ok()?;
    let copy: Vec<&str> = defaults::list("ops.shadow_copy");
    let skip: Vec<&str> = defaults::list("ops.shadow_skip");
    let mut budget = defaults::num("ops.shadow_copy_bytes");
    if let Ok(rd) = std::fs::read_dir(&base) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if skip.contains(&name.as_str()) {
                continue;
            }
            if copy.contains(&name.as_str()) {
                copy_tree(&e.path(), &sbase.join(&name), &mut budget);
            } else if !name.ends_with(defaults::text("ops.shadow_lock_ext")) {
                crate::discard::harmless(std::os::unix::fs::symlink(e.path(), sbase.join(&name))); // keep: read-only view; a failed link only narrows the comparison
            }
        }
    }
    for name in defaults::list("ops.shadow_link_home") {
        let src = Path::new(&home).join(name);
        if src.exists() {
            crate::discard::harmless(std::os::unix::fs::symlink(&src, scratch.join(name))); // keep: as above
        }
    }
    let has_stdin = stdin.is_some();
    if let Some(b) = stdin {
        crate::discard::harmless(std::fs::write(dir.join(defaults::text("ops.shadow_stdin_file")), b)); // keep: a missing input file makes the child skip
    }
    start_capture();
    Some(Plan { dir, verb: verb.to_string(), script, args: args.to_vec(), cwd: std::env::current_dir().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default(), home, has_stdin, started: std::time::Instant::now(), real_cwd: None })
}

/// The paths replaced by a word before two outputs are compared: the real and the scratch home, and for the installers the
/// real and the scratch working directory (replaced first: a project usually sits inside the home).
struct Mk<'a> {
    home: &'a str,
    scratch_home: &'a str,
    cwd: &'a str,
    scratch_cwd: &'a str,
}

fn masks(m: &Mk, bytes: &[u8]) -> Vec<u8> {
    let mut s = String::from_utf8_lossy(bytes).into_owned();
    for cwd in [m.cwd, m.scratch_cwd] {
        if !cwd.is_empty() {
            s = s.replace(cwd, defaults::text("ops.shadow_cwd_word"));
        }
    }
    s = s.replace(m.scratch_home, defaults::text("ops.shadow_home_word")).replace(m.home, defaults::text("ops.shadow_home_word"));
    for rule in defaults::list("ops.shadow_masks") {
        if let Some((re, with)) = rule.split_once(defaults::text("defect.step_sep")) {
            s = regex::Regex::new(re).map_or(s.clone(), |r| r.replace_all(&s, with).into_owned());
        }
    }
    s.into_bytes()
}

fn short_hash(bytes: &[u8]) -> String {
    let h = digest::digest(&digest::SHA256, bytes);
    h.as_ref().iter().take(defaults::num("ops.shadow_digest_bytes") as usize).map(|b| format!("{b:02x}")).collect::<String>()
}

/// A digest of the state a command may change: every file under the copied entries, masked.
fn digest_state(home: &str, scratch_home: &str, base: &Path) -> String {
    let mut lines: Vec<String> = Vec::new();
    fn walk(root: &Path, p: &Path, home: &str, shome: &str, out: &mut Vec<String>) {
        let Ok(md) = std::fs::symlink_metadata(p) else { return };
        if md.is_dir() {
            if let Ok(rd) = std::fs::read_dir(p) {
                let mut es: Vec<_> = rd.flatten().map(|e| e.path()).collect();
                es.sort();
                for e in es {
                    walk(root, &e, home, shome, out);
                }
            }
        } else if md.is_file() {
            let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            if defaults::list("ops.shadow_ignore_ext").iter().any(|e| name.ends_with(e)) {
                return;
            }
            let body = std::fs::read(p).unwrap_or_default();
            let hash = short_hash(&masks(&Mk { home, scratch_home: shome, cwd: "", scratch_cwd: "" }, &body));
            let rel = p.strip_prefix(root).map(|r| r.to_string_lossy().into_owned()).unwrap_or_default();
            out.push(format!("{rel} {hash}"));
        }
    }
    for name in defaults::list("ops.shadow_copy") {
        walk(base, &base.join(name), home, scratch_home, &mut lines);
    }
    lines.join("\n")
}

/// The installers' state: the settings files they may change, under the home and the working directory, masked.
fn digest_inst(home_root: &Path, cwd_root: &Path, m: &Mk) -> String {
    let mut lines: Vec<String> = Vec::new();
    for (root, key, tag) in [(home_root, "ops.shadow_inst_home", "ops.shadow_inst_home_tag"), (cwd_root, "ops.shadow_inst_cwd", "ops.shadow_inst_cwd_tag")] {
        for rel in defaults::list(key) {
            if let Ok(body) = std::fs::read(root.join(rel)) {
                lines.push(format!("{}{rel} {}", defaults::text(tag), short_hash(&masks(m, &body))));
            }
        }
    }
    lines.join("\n")
}

/// Start a shadow for an installer: the Node script runs later on a scratch copy of the settings files it may change (in a
/// scratch home and a scratch working directory), so it never writes twice for real. Not sampled when the scratch
/// copy cannot stand for the real run: the project's local settings file is tracked by git, or the working directory holds
/// the home.
pub fn begin_install(verb: &str, script_rel: &str, args: &[String]) -> Option<Plan> {
    if std::env::var_os(defaults::text("ops.shadow_child_env")).is_some() || !sampled(verb) {
        return None;
    }
    let env = env_snapshot();
    let home = super::home(&env);
    let root = plugin_root(&env)?;
    let script = Path::new(&root).join(script_rel);
    if !script.exists() {
        return None;
    }
    let cwd = std::env::current_dir().ok()?.to_string_lossy().into_owned();
    if Path::new(&home).starts_with(&cwd) || super::slcfg::tracked_by_git(&cwd) {
        return None;
    }
    let id = format!("{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos()));
    let dir = crate::paths::dir().join(defaults::text("ops.shadow_dir")).join(id);
    let (scratch_home, scratch_cwd) = (dir.join("home"), dir.join(defaults::text("ops.shadow_cwd_dir")));
    std::fs::create_dir_all(&scratch_home).ok()?;
    std::fs::create_dir_all(&scratch_cwd).ok()?;
    let copy = |from_root: &Path, to_root: &Path, key: &str| {
        for rel in defaults::list(key) {
            let (from, to) = (from_root.join(rel), to_root.join(rel));
            if from.is_file() {
                if let Some(parent) = to.parent() {
                    crate::discard::harmless(std::fs::create_dir_all(parent)); // keep: a failed copy only narrows the comparison
                }
                crate::discard::harmless(std::fs::copy(&from, &to)); // keep: as above
            }
        }
    };
    copy(Path::new(&home), &scratch_home, "ops.shadow_inst_home");
    copy(Path::new(&cwd), &scratch_cwd, "ops.shadow_inst_cwd");
    for rel in defaults::list("ops.shadow_inst_link") {
        let (src, dst) = (Path::new(&home).join(rel), scratch_home.join(rel));
        if src.exists() {
            if let Some(parent) = dst.parent() {
                crate::discard::harmless(std::fs::create_dir_all(parent)); // keep: a missing link only narrows the comparison
            }
            crate::discard::harmless(std::os::unix::fs::symlink(&src, &dst)); // keep: as above
        }
    }
    start_capture();
    Some(Plan {
        dir,
        verb: verb.to_string(),
        script,
        args: args.to_vec(),
        cwd: scratch_cwd.to_string_lossy().into_owned(),
        home,
        has_stdin: false,
        started: std::time::Instant::now(),
        real_cwd: Some(cwd),
    })
}

/// The engine has finished with exit `code`: hand the comparison to a detached child and return at once.
pub fn end(plan: Option<Plan>, code: i32) {
    let Some(p) = plan else { return };
    let out = out_capture_take();
    let err = err_capture_take();
    if code == super::defer_code() {
        // the engine left the work to Node: there is nothing to compare
        crate::discard::harmless(std::fs::remove_dir_all(&p.dir)); // keep: our own scratch directory
        return;
    }
    let base = Path::new(&p.home).join(defaults::text("paths.base_dir"));
    let scratch_home = p.dir.join("home");
    let scratch_home_s = scratch_home.to_string_lossy().into_owned();
    let post = match &p.real_cwd {
        Some(real_cwd) => digest_inst(Path::new(&p.home), Path::new(real_cwd), &Mk { home: &p.home, scratch_home: &scratch_home_s, cwd: real_cwd, scratch_cwd: &p.cwd }),
        None => digest_state(&p.home, &scratch_home_s, &base),
    };
    let job = serde_json::json!({
        "verb": p.verb, "script": p.script, "args": p.args, "cwd": p.cwd, "home": p.home, "code": code,
        "stdin": p.has_stdin, "micros": p.started.elapsed().as_micros() as u64, "post": post, "real_cwd": p.real_cwd,
    });
    let ok = std::fs::write(p.dir.join(defaults::text("ops.shadow_job_file")), job.to_string()).is_ok()
        && std::fs::write(p.dir.join(defaults::text("ops.shadow_engine_out")), &out).is_ok()
        && std::fs::write(p.dir.join(defaults::text("ops.shadow_engine_err")), &err).is_ok();
    if !ok {
        crate::discard::harmless(std::fs::remove_dir_all(&p.dir)); // keep: our own scratch directory
        return;
    }
    let Ok(exe) = std::env::current_exe() else { return };
    let spawned = Command::new(exe).arg(defaults::text("ops.shadow_command")).arg(&p.dir).env(defaults::text("ops.shadow_child_env"), "1").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).process_group(0).spawn();
    // the child outlives this process; dropping the handle without waiting leaves it to init
    drop(spawned);
}

/// `shadow-compare <dir>`: run the Node script on the scratch home and compare.
pub fn compare(dir: &Path) -> i32 {
    let rd = |n: &str| std::fs::read(dir.join(defaults::text(n))).unwrap_or_default();
    let Ok(job) = serde_json::from_slice::<serde_json::Value>(&rd("ops.shadow_job_file")) else { return 1 };
    let s = |k: &str| job.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let (verb, home) = (s("verb"), s("home"));
    let scratch = dir.join("home");
    let scratch_s = scratch.to_string_lossy().into_owned();
    let args: Vec<String> = job.get("args").and_then(|a| a.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default();
    let mut cmd = Command::new(std::env::var_os(defaults::env_name("node")).unwrap_or_else(|| defaults::text("ops.shadow_node").into()));
    cmd.arg(s("script")).args(&args).current_dir(s("cwd")).env(defaults::env_name("home"), &scratch).env(defaults::text("ops.shadow_dry_env"), "1");
    for (k, v) in env_snapshot() {
        if k != defaults::env_name("home") && k != defaults::text("ops.shadow_dry_env") {
            cmd.env(k, v);
        }
    }
    if job.get("stdin").and_then(|v| v.as_bool()) == Some(true) {
        cmd.stdin(std::fs::File::open(dir.join(defaults::text("ops.shadow_stdin_file"))).map_or(Stdio::null(), Stdio::from));
    } else {
        cmd.stdin(Stdio::null());
    }
    let Ok(o) = crate::proc::run(cmd, defaults::text("ops.shadow_node"), defaults::millis("ops.shadow_timeout_ms"), defaults::millis("statusline.poll_ms")) else { return 1 };
    let node_code = o.status.code().unwrap_or(-1);
    let want_code = job.get("code").and_then(serde_json::Value::as_i64).unwrap_or(-1) as i32;
    let real_cwd = job.get("real_cwd").and_then(|v| v.as_str()).map(str::to_string);
    let (rc_s, sc_s) = (real_cwd.clone().unwrap_or_default(), if real_cwd.is_some() { s("cwd") } else { String::new() });
    let m = |b: &[u8]| masks(&Mk { home: &home, scratch_home: &scratch_s, cwd: &rc_s, scratch_cwd: &sc_s }, b);
    let (e_out, e_err) = (m(&rd("ops.shadow_engine_out")), m(&rd("ops.shadow_engine_err")));
    let (n_out, n_err) = (m(&o.stdout), m(&o.stderr));
    let post_node = match &real_cwd {
        Some(rc) => digest_inst(&scratch, Path::new(&s("cwd")), &Mk { home: &home, scratch_home: &scratch_s, cwd: rc, scratch_cwd: &s("cwd") }),
        None => digest_state(&home, &scratch_s, &scratch.join(defaults::text("paths.base_dir"))),
    };
    let post_engine = job.get("post").and_then(|v| v.as_str()).unwrap_or("").to_string();
    // the Node tree lives under the scratch home, the engine's under the real one: compare relative names and digests only
    let norm = |t: &str| t.lines().collect::<Vec<_>>().join("\n");
    let mismatch = e_out != n_out || e_err != n_err || want_code != node_code || norm(&post_engine) != norm(&post_node);
    let micros = job.get("micros").and_then(serde_json::Value::as_u64).unwrap_or(0);
    crate::telemetry::emit::event(crate::telemetry::emit::command_run(defaults::text("ops.shadow_event"), &verb, i32::from(mismatch), micros, u64::from(mismatch)));
    if mismatch {
        let report = defaults::render(
            "ops.shadow_report",
            &[
                ("want", &want_code),
                ("got", &node_code),
                ("e_out", &String::from_utf8_lossy(&e_out)),
                ("n_out", &String::from_utf8_lossy(&n_out)),
                ("e_err", &String::from_utf8_lossy(&e_err)),
                ("n_err", &String::from_utf8_lossy(&n_err)),
                ("e_state", &post_engine),
                ("n_state", &post_node),
            ],
        );
        crate::discard::harmless(std::fs::write(dir.join(defaults::text("ops.shadow_report_file")), report)); // keep: the telemetry event already says it mismatched
        crate::discard::harmless(std::fs::remove_dir_all(&scratch)); // keep: our own scratch home
        prune(dir.parent());
    } else {
        crate::discard::harmless(std::fs::remove_dir_all(dir)); // keep: our own scratch directory
    }
    0
}

/// Keep only the newest `ops.shadow_keep` mismatch directories.
fn prune(parent: Option<&Path>) {
    let Some(parent) = parent else { return };
    let mut dirs: Vec<PathBuf> = std::fs::read_dir(parent).map(|rd| rd.flatten().map(|e| e.path()).filter(|p| p.join(defaults::text("ops.shadow_report_file")).exists()).collect()).unwrap_or_default();
    dirs.sort();
    let keep = defaults::num("ops.shadow_keep") as usize;
    if dirs.len() > keep {
        for d in &dirs[..dirs.len() - keep] {
            crate::discard::harmless(std::fs::remove_dir_all(d)); // keep: our own old diagnostics
        }
    }
}
