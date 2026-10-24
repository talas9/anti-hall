//! The ONE install routine (task #229): `ah-engine update --from-local <dir>`, `update --rollback`, and the install step every update
//! path ends in. Three paths feed it and none installs by itself:
//!
//! 1. a GitHub release: the thin client (`ah-hook update`) downloads and checksum-verifies it (the engine has no network code), unpacks it
//!    into a staging directory and runs the NEW engine's `update --from-local <staging> --source release --yes`;
//! 2. a local build: `ah-engine update --from-local <dir> --yes` (the layout of `<dir>` is `routine.*_candidates`);
//! 3. `scripts/engine-deploy.sh`: one line that calls path 2.
//!
//! Steps: pre-check (the new binary runs, loads the new defaults on every plugin root, passes the entry-path audit) -> downgrade gate ->
//! install with a rollback copy of the previous binaries and every replaced plugin file -> settle -> validate (one daemon, the new sha,
//! a client round trip, the guards answer, nothing bad in the event log since the start) -> on ANY failure automatic rollback to the saved
//! copy and the same validation again -> cleanup (stray processes by verified pid, old binary and deploy copies beyond the kept count)
//! -> record what was installed (`routine.state_file`) -> one summary. Nothing is hardcoded here: every name, limit and text is in
//! `engine/defaults/routine.toml`.
use crate::cli::Parsed;
use crate::operator::{post_update, sweep};
use crate::{client, defaults, health, paths};
use serde_json::{Value, json};
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

fn t(key: &str) -> &'static str {
    defaults::text(key)
}

fn flag(name: &str) -> &'static str {
    defaults::text(&format!("routine.flag_{name}"))
}

fn now_s() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

fn short(sha: &str) -> String {
    sha.chars().take(defaults::num("post_update.sha_chars") as usize).collect()
}

// ---- options --------------------------------------------------------------------------------------------------------------

#[derive(Default)]
struct Opts {
    from: Option<PathBuf>,
    engine: Option<PathBuf>,
    hook: Option<PathBuf>,
    web: Option<PathBuf>,
    tree: Option<PathBuf>,
    deploy: Option<PathBuf>,
    source: String,
    check: bool,
    rollback: bool,
    yes: bool,
    force: bool,
    leftovers: bool,
    json: bool,
}

/// True when `update`'s arguments ask for the install routine (rather than the plugin update).
pub fn wanted(p: &Parsed) -> bool {
    p.rest.iter().any(|a| a == flag("from_local") || a == flag("rollback"))
}

fn parse(p: &Parsed) -> Result<Opts, String> {
    let mut o = Opts { source: t("routine.source_local").to_string(), json: p.json, ..Opts::default() };
    let mut it = p.rest.iter();
    while let Some(a) = it.next() {
        let mut val = |a: &str| it.next().cloned().ok_or_else(|| defaults::render("routine.msg_flag_value", &[("flag", &a)]));
        match a.as_str() {
            x if x == flag("from_local") => o.from = Some(PathBuf::from(val(a)?)),
            x if x == flag("engine_bin") => o.engine = Some(PathBuf::from(val(a)?)),
            x if x == flag("hook_bin") => o.hook = Some(PathBuf::from(val(a)?)),
            x if x == flag("web_bin") => o.web = Some(PathBuf::from(val(a)?)),
            x if x == flag("tree") => o.tree = Some(PathBuf::from(val(a)?)),
            x if x == flag("deploy") => o.deploy = Some(PathBuf::from(val(a)?)),
            x if x == flag("source") => {
                o.source = val(a)?;
                if !defaults::list("routine.sources").contains(&o.source.as_str()) {
                    return Err(defaults::render("routine.msg_bad_source", &[("source", &o.source), ("allowed", &defaults::list("routine.sources").join(", "))]));
                }
            }
            x if x == flag("check") => o.check = true,
            x if x == flag("rollback") => o.rollback = true,
            x if x == flag("yes") => o.yes = true,
            x if x == flag("force") => o.force = true,
            x if x == flag("allow_leftovers") => o.leftovers = true,
            "--json" => {}
            other => return Err(defaults::render("routine.msg_bad_arg", &[("arg", &other)])),
        }
    }
    if !o.rollback && o.from.is_none() && o.engine.is_none() {
        return Err(t("routine.msg_no_source").to_string());
    }
    Ok(o)
}

// ---- output ---------------------------------------------------------------------------------------------------------------

/// The lines of one run: printed as they happen (not in `--json` mode) and kept for the JSON report.
struct Log {
    json: bool,
    lines: Vec<String>,
}

impl Log {
    fn say(&mut self, line: String) {
        if !self.json {
            let mut out = std::io::stdout().lock();
            let _ = writeln!(out, "{line}"); // keep: a closed pipe must not stop an install half way
            let _ = out.flush(); // keep: same
        }
        self.lines.push(line);
    }
}

// ---- subprocesses ---------------------------------------------------------------------------------------------------------

struct Ran {
    /// None: it did not start or ran out of time.
    code: Option<i32>,
    out: String,
}

static RUNS: AtomicU32 = AtomicU32::new(0);

/// Run `bin args` with only the given environment (plus PATH), output to a file in `scratch`, bounded by `limit`.
fn run(bin: &Path, args: &[&str], envs: &[(String, String)], limit: Duration, scratch: &Path, stdin: Option<&Path>) -> Ran {
    let n = RUNS.fetch_add(1, Ordering::Relaxed);
    let outf = scratch.join(format!("out.{n}"));
    let Ok(file) = std::fs::File::create(&outf) else { return Ran { code: None, out: String::new() } };
    let Ok(err) = file.try_clone() else { return Ran { code: None, out: String::new() } };
    let mut cmd = Command::new(bin);
    cmd.args(args).env_clear().envs(envs.iter().map(|(k, v)| (k, v))).stdout(file).stderr(err);
    if let Some(path) = std::env::var_os("PATH") {
        cmd.env("PATH", path);
    }
    match stdin.and_then(|p| std::fs::File::open(p).ok()) {
        Some(f) => cmd.stdin(f),
        None => cmd.stdin(Stdio::null()),
    };
    let Ok(mut child) = cmd.spawn() else { return Ran { code: None, out: String::new() } };
    let until = Instant::now() + limit;
    let code = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st.code(),
            Ok(None) if Instant::now() < until => std::thread::sleep(defaults::millis("post_update.poll_ms")),
            _ => {
                let _ = child.kill(); // keep: a child that already exited is the outcome we wanted
                let _ = child.wait(); // keep: reaping only
                break None;
            }
        }
    };
    Ran { code, out: std::fs::read_to_string(&outf).unwrap_or_default() }
}

fn first_line(s: &str) -> String {
    s.lines().next().unwrap_or_default().trim().to_string()
}

// ---- source and target ----------------------------------------------------------------------------------------------------

struct Source {
    engine: PathBuf,
    hook: Option<PathBuf>,
    web: Option<PathBuf>,
    tree: Option<PathBuf>,
}

fn first_file(dir: &Path, rels: &[&str]) -> Option<PathBuf> {
    rels.iter().map(|r| dir.join(r)).find(|p| p.is_file())
}

fn resolve_source(o: &Opts) -> Result<Source, String> {
    let dir = o.from.clone();
    let under = |key: &str| dir.as_deref().and_then(|d| first_file(d, &defaults::list(key)));
    let engine = o.engine.clone().or_else(|| under("routine.engine_candidates")).ok_or_else(|| defaults::render("routine.msg_no_engine", &[("dir", &dir.as_deref().map_or(String::new(), |d| d.display().to_string()))]))?;
    if !engine.is_file() {
        return Err(defaults::render("routine.msg_not_file", &[("path", &engine.display())]));
    }
    let hook = o.hook.clone().or_else(|| under("routine.hook_candidates")).filter(|h| h.is_file());
    let web = o.web.clone().or_else(|| under("routine.web_candidates")).filter(|w| w.is_file());
    let marker = t("routine.tree_marker");
    let tree = o.tree.clone().or_else(|| dir.as_deref().and_then(|d| defaults::list("routine.tree_candidates").iter().map(|r| d.join(r)).find(|p| p.join(marker).is_file())));
    if let Some(tr) = tree.as_ref().filter(|tr| !tr.join(marker).is_file()) {
        return Err(defaults::render("routine.msg_bad_tree", &[("path", &tr.display()), ("marker", &marker)]));
    }
    Ok(Source { engine, hook, web, tree })
}

struct Target {
    state: PathBuf,
    bin_dir: PathBuf,
    engine: PathBuf,
    hook: PathBuf,
    roots: Vec<PathBuf>,
}

fn fill_home(s: &str, home: &str) -> String {
    s.replace(t("routine.home_token"), home)
}

fn roots_of_installed(home: &str) -> Vec<PathBuf> {
    let file = PathBuf::from(fill_home(t("routine.installed_json"), home));
    let Some(v) = std::fs::read_to_string(file).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok()) else { return Vec::new() };
    let reg = v.get("plugins").unwrap_or(&v);
    reg.get(t("routine.plugin_key")).and_then(Value::as_array).into_iter().flatten().filter_map(|e| e.get("installPath").and_then(Value::as_str)).map(PathBuf::from).collect()
}

/// The plugin roots the install routine keeps in step (the engine's own, the registered installs, `routine.default_roots`).
pub fn plugin_roots() -> Vec<PathBuf> {
    resolve_target().roots
}

fn resolve_target() -> Target {
    let state = paths::dir();
    let bin_dir = state.join(t("rollback.bin_dir"));
    let home = defaults::env_var("home").unwrap_or_default();
    let mut roots: Vec<PathBuf> = std::env::var(t("routine.env_roots")).ok().filter(|s| !s.is_empty()).map(|s| s.split(':').filter(|p| !p.is_empty()).map(PathBuf::from).collect()).unwrap_or_default();
    if roots.is_empty() {
        roots.extend(defaults::root());
        roots.extend(roots_of_installed(&home));
        roots.extend(defaults::list("routine.default_roots").iter().map(|r| PathBuf::from(fill_home(r, &home))).filter(|r| r.join(t("routine.tree_marker")).is_file()));
    }
    let mut seen = Vec::new();
    roots.retain(|r| {
        let key = std::fs::canonicalize(r).unwrap_or_else(|_| r.clone());
        let fresh = !seen.contains(&key);
        seen.push(key);
        fresh && r.join(t("routine.tree_marker")).is_file()
    });
    Target { engine: bin_dir.join(t("rollback.bin_name")), hook: bin_dir.join(t("rollback.client")), state, bin_dir, roots }
}

fn sha_of(p: &Path) -> Option<String> {
    crate::doctor::facts::sha256_file(p).ok()
}

// ---- the install record -----------------------------------------------------------------------------------------------------

fn record_path(tg: &Target) -> PathBuf {
    tg.state.join(t("routine.state_file"))
}

fn read_record(tg: &Target) -> Value {
    std::fs::read_to_string(record_path(tg)).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null)
}

fn mtime_s(p: &Path) -> u64 {
    std::fs::metadata(p).ok().and_then(|m| m.modified().ok()).and_then(|m| m.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_secs())
}

/// What runs now: its build version (the daemon's own answer, else the record, else the binary's), sha, build time and source.
struct Running {
    version: String,
    sha: Option<String>,
    built: u64,
    source: String,
}

fn running(tg: &Target, scratch: &Path) -> Running {
    let rec = read_record(tg);
    let sha = sha_of(&tg.engine);
    let same_as_record = sha.is_some() && rec["sha"].as_str() == sha.as_deref();
    let status = client::status_value();
    let version = status["version"].as_str().map(str::to_string).filter(|_| status["running"] == json!(true)).or_else(|| rec["version"].as_str().map(str::to_string).filter(|_| same_as_record)).unwrap_or_else(|| {
        let envs = scratch_env(scratch, tg.roots.first().map(PathBuf::as_path));
        first_line(&run(&tg.engine, &["version"], &envs, defaults::secs("routine.call_timeout_s"), scratch, None).out)
    });
    let built = if same_as_record { rec["built_at"].as_u64().unwrap_or_else(|| mtime_s(&tg.engine)) } else { mtime_s(&tg.engine) };
    let source = if same_as_record { rec["source"].as_str().unwrap_or(t("routine.source_manual")).to_string() } else { t("routine.source_manual").to_string() };
    Running { version, sha, built, source }
}

fn scratch_env(scratch: &Path, root: Option<&Path>) -> Vec<(String, String)> {
    let home = scratch.join("home");
    let mut v = vec![(defaults::env_name("home").to_string(), home.display().to_string()), (defaults::env_name("dir").to_string(), home.join("st").display().to_string())];
    if let Some(r) = root {
        v.push((defaults::env_name("plugin_root").to_string(), r.display().to_string()));
    }
    v
}

fn write_atomic(path: &Path, text: &str) -> std::io::Result<()> {
    let tmp = path.with_extension(format!("{}.{}", t("routine.tmp_ext"), std::process::id()));
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, path)
}

// ---- file sync with a journal ---------------------------------------------------------------------------------------------

struct Staged {
    tmp: PathBuf,
    dst: PathBuf,
}

/// Every file of the plugin tree the sync handles, relative to its root: `engine/defaults*` go first (their own step), then the rest.
fn tree_files(src: &Path) -> Vec<PathBuf> {
    fn walk(base: &Path, dir: &Path, out: &mut Vec<PathBuf>, skip_dirs: &[&str]) {
        let mut ents: Vec<_> = std::fs::read_dir(dir).into_iter().flatten().flatten().collect();
        ents.sort_by_key(std::fs::DirEntry::file_name);
        for e in ents {
            let p = e.path();
            let name = e.file_name().to_string_lossy().into_owned();
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_dir() {
                if !skip_dirs.contains(&name.as_str()) {
                    walk(base, &p, out, skip_dirs);
                }
            } else if ft.is_file()
                && let Ok(rel) = p.strip_prefix(base)
            {
                out.push(rel.to_path_buf());
            }
        }
    }
    let skip_dirs = defaults::list("routine.tree_skip_dirs");
    let mut all = Vec::new();
    walk(src, src, &mut all, &skip_dirs);
    let skip = defaults::list("routine.tree_skip_substrings");
    let (mut first, mut rest): (Vec<_>, Vec<_>) = all.into_iter().filter(|r| !skip.iter().any(|s| r.to_string_lossy().contains(s))).partition(|r| defaults::list("routine.defaults_dirs").iter().any(|d| r.starts_with(d)));
    first.append(&mut rest);
    first
}

/// Where a file the tree sync does not copy comes from: the defaults dirs are taken whole (also the files the skip list would hide).
fn defaults_files(src: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for d in defaults::list("routine.defaults_dirs") {
        let mut ents: Vec<_> = std::fs::read_dir(src.join(d)).into_iter().flatten().flatten().filter(|e| e.file_type().is_ok_and(|t| t.is_file())).collect();
        ents.sort_by_key(std::fs::DirEntry::file_name);
        out.extend(ents.into_iter().filter(|e| !defaults::list("routine.tree_skip_substrings").iter().any(|s| e.file_name().to_string_lossy().contains(s))).map(|e| Path::new(d).join(e.file_name())));
    }
    out
}

fn same_file(a: &Path, b: &Path) -> bool {
    std::fs::read(a).ok().is_some_and(|x| std::fs::read(b).ok().as_ref() == Some(&x))
}

fn stage_copy(src: &Path, dst: &Path) -> std::io::Result<PathBuf> {
    let name = dst.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp = dst.with_file_name(format!(".{name}{}{}", t("routine.stage_infix"), std::process::id()));
    if let Some(dir) = dst.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::copy(src, &tmp)?;
    Ok(tmp)
}

/// The journal of one install: where replaced files were saved. Written before the first rename so an interrupted install can be rolled back.
struct Journal {
    dir: PathBuf,
    entries: Vec<Value>,
}

impl Journal {
    fn save_file(&mut self, dst: &Path) -> std::io::Result<()> {
        let n = self.entries.len();
        if dst.exists() {
            let backup = self.dir.join(t("routine.files_dir")).join(n.to_string());
            std::fs::create_dir_all(&backup)?;
            let b = backup.join(dst.file_name().unwrap_or_default());
            std::fs::copy(dst, &b)?;
            self.entries.push(json!({"dst": dst.display().to_string(), "backup": b.display().to_string()}));
        } else {
            self.entries.push(json!({"dst": dst.display().to_string(), "backup": Value::Null}));
        }
        Ok(())
    }

    fn write(&self, head: &Value) -> std::io::Result<()> {
        let mut v = head.clone();
        v["entries"] = Value::Array(self.entries.clone());
        write_atomic(&self.dir.join(t("routine.manifest_file")), &serde_json::to_string_pretty(&v).unwrap_or_default())
    }
}

/// Stage `src_rel` files of `src` into `dst_root`, saving every replaced file in the journal. Returns the staged renames and the count.
fn stage_tree(src: &Path, dst_root: &Path, files: &[PathBuf], j: &mut Journal, out: &mut Vec<Staged>) -> Result<usize, String> {
    let mut n = 0;
    for rel in files {
        let (from, to) = (src.join(rel), dst_root.join(rel));
        if to.is_file() && same_file(&from, &to) {
            continue;
        }
        j.save_file(&to).map_err(|e| defaults::render("routine.msg_stage_failed", &[("path", &to.display()), ("why", &e)]))?;
        let tmp = stage_copy(&from, &to).map_err(|e| defaults::render("routine.msg_stage_failed", &[("path", &to.display()), ("why", &e)]))?;
        out.push(Staged { tmp, dst: to });
        n += 1;
    }
    Ok(n)
}

fn commit(staged: &[Staged]) -> Result<(), String> {
    for s in staged {
        std::fs::rename(&s.tmp, &s.dst).map_err(|e| defaults::render("routine.msg_commit_failed", &[("path", &s.dst.display()), ("why", &e)]))?;
    }
    Ok(())
}

fn unstage(staged: &[Staged]) {
    for s in staged {
        let _ = std::fs::remove_file(&s.tmp); // keep: our own temp file; absent is fine
    }
}

// ---- the maintenance hold ---------------------------------------------------------------------------------------------------

/// While held, hooks pass through and start no engine (the thin client's "daemon down" marker, a future time in ms). Dropping it puts the
/// previous content back; the TTL makes a crashed install leave the guards off for at most that long.
struct Hold {
    file: PathBuf,
    before: Option<String>,
    ttl: Duration,
    on: bool,
}

impl Hold {
    fn take(tg: &Target) -> Hold {
        let file = tg.state.join(t("files.daemon_down_marker"));
        let ttl = defaults::secs("routine.hold_ttl_s");
        let h = Hold { before: std::fs::read_to_string(&file).ok(), file, ttl, on: !ttl.is_zero() };
        h.refresh();
        h
    }

    fn refresh(&self) {
        if self.on {
            let until = (now_s() + self.ttl.as_secs()) * 1000;
            let _ = write_atomic(&self.file, &until.to_string()); // keep: a failed refresh only shortens the hold
        }
    }
}

impl Drop for Hold {
    fn drop(&mut self) {
        if self.on {
            let _ = write_atomic(&self.file, self.before.as_deref().unwrap_or("0")); // keep: the TTL expires it anyway
        }
    }
}

// ---- the daemon ------------------------------------------------------------------------------------------------------------

fn daemon_pid() -> Option<u32> {
    let s = client::status_value();
    (s["running"] == json!(true)).then(|| s["pid"].as_u64().and_then(|p| u32::try_from(p).ok())).flatten()
}

fn alive(pid: u32) -> bool {
    // SAFETY: signal 0 only tests that the process exists.
    let r = unsafe { libc::kill(pid as libc::pid_t, 0) };
    r == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// Ask the daemon to stop and wait for its process to be gone; the verified-pid kill when it will not. True when none runs.
fn stop_daemon() -> bool {
    let Some(pid) = daemon_pid() else { return true };
    let _ = client::ctl(t("routine.ctl_stop")); // keep: the pid wait below is the check
    let until = Instant::now() + defaults::secs("routine.stop_wait_s");
    while alive(pid) && Instant::now() < until {
        std::thread::sleep(defaults::millis("post_update.poll_ms"));
    }
    !alive(pid) || post_update::stop_pid(pid)
}

/// Start the daemon from the installed binary and wait until it answers.
fn start_daemon(tg: &Target) -> bool {
    if client::ping(&paths::socket()).is_some() {
        return true;
    }
    drop(client::spawn_daemon_from_reason(Ok(tg.engine.clone()), tg.roots.first().map(PathBuf::as_path), health::starts::reason("routine")));
    let until = Instant::now() + defaults::secs("routine.start_wait_s");
    while Instant::now() < until {
        if client::ping(&paths::socket()).is_some() {
            return true;
        }
        std::thread::sleep(defaults::millis("post_update.poll_ms"));
    }
    false
}

fn integrity_accept(tg: &Target, scratch: &Path) {
    if tg.hook.is_file() {
        let envs = tg.roots.first().map(|r| vec![(defaults::env_name("plugin_root").to_string(), r.display().to_string()), (defaults::env_name("dir").to_string(), tg.state.display().to_string()), (defaults::env_name("home").to_string(), defaults::env_var("home").unwrap_or_default())]).unwrap_or_default();
        let args: Vec<&str> = defaults::list("routine.integrity_accept_args");
        let _ = run(&tg.hook, &args, &envs, defaults::secs("routine.call_timeout_s"), scratch, None); // keep: the next integrity check records it if this one could not
    }
}

// ---- pre-check ------------------------------------------------------------------------------------------------------------

struct Pre {
    problems: Vec<String>,
    version: String,
    /// The version stamps the new thin client and dashboard report (empty when not part of the set).
    hook_version: String,
    web_version: String,
    /// The lowest client and dashboard versions the new engine serves (`version --json` `compat`); empty when it did not say.
    hook_min: String,
    web_min: String,
    sha: String,
}

fn precheck(o: &Opts, src: &Source, tg: &Target, scratch: &Path, log: &mut Log) -> Pre {
    let mut pre = Pre { problems: Vec::new(), version: String::new(), hook_version: String::new(), web_version: String::new(), hook_min: String::new(), web_min: String::new(), sha: sha_of(&src.engine).unwrap_or_default() };
    let limit = defaults::secs("routine.call_timeout_s");
    let envs = scratch_env(scratch, src.tree.as_deref().or(tg.roots.first().map(PathBuf::as_path)));
    let v = run(&src.engine, &["version"], &envs, limit, scratch, None);
    pre.version = first_line(&v.out);
    if v.code != Some(0) || !pre.version.starts_with(|c: char| c.is_ascii_digit()) {
        pre.problems.push(defaults::render("routine.problem_new_binary", &[("path", &src.engine.display()), ("got", &pre.version)]));
        return pre;
    }
    log.say(defaults::render("routine.line_new_binary", &[("path", &src.engine.display()), ("version", &pre.version), ("sha", &short(&pre.sha))]));
    let facts = run(&src.engine, &["version", "--json"], &envs, limit, scratch, None);
    if let Ok(j) = serde_json::from_str::<Value>(facts.out.trim()) {
        pre.hook_min = j["compat"]["hook_min"].as_str().unwrap_or_default().to_string();
        pre.web_min = j["compat"]["web_min"].as_str().unwrap_or_default().to_string();
    }
    if let Some(h) = &src.hook {
        let args: Vec<&str> = defaults::list("routine.hook_version_args");
        let r = run(h, &args, &[], limit, scratch, None);
        if r.code != Some(0) {
            pre.problems.push(defaults::render("routine.problem_new_hook", &[("path", &h.display()), ("got", &first_line(&r.out))]));
        } else {
            pre.hook_version = first_line(&r.out);
            log.say(defaults::render("routine.line_new_hook", &[("path", &h.display()), ("version", &pre.hook_version)]));
        }
    }
    if let Some(w) = &src.web {
        let args: Vec<&str> = defaults::list("routine.web_version_args");
        let r = run(w, &args, &[], limit, scratch, None);
        if r.code != Some(0) {
            pre.problems.push(defaults::render("routine.problem_new_web", &[("path", &w.display()), ("got", &first_line(&r.out))]));
        } else {
            pre.web_version = first_line(&r.out);
            log.say(defaults::render("routine.line_new_web", &[("path", &w.display()), ("version", &pre.web_version)]));
        }
    }
    if let Some(tree) = &src.tree {
        let args = defaults::list("routine.audit_args");
        let root = tree.display().to_string();
        let args: Vec<String> = args.iter().map(|a| a.replace(t("routine.root_token"), &root)).collect();
        let argr: Vec<&str> = args.iter().map(String::as_str).collect();
        let a = run(&src.engine, &argr, &envs, limit, scratch, None);
        match a.code {
            Some(0) => log.say(defaults::render("routine.line_audit_clean", &[("root", &root)])),
            Some(1) if o.leftovers => log.say(defaults::render("routine.line_audit_override", &[("root", &root)])),
            Some(1) => {
                log.say(a.out.trim_end().to_string());
                pre.problems.push(defaults::render("routine.problem_audit", &[("root", &root)]));
            }
            other => pre.problems.push(defaults::render("routine.problem_audit_run", &[("code", &other.map_or_else(|| t("routine.no_code").to_string(), |c| c.to_string())), ("out", &first_line(&a.out))])),
        }
    }
    let empty = scratch.join(t("routine.empty_toml"));
    let _ = std::fs::write(&empty, ""); // keep: validate only needs a readable empty file; a failure shows as a validate problem
    for (i, root) in tg.roots.iter().enumerate() {
        let sim = scratch.join(format!("sim{i}"));
        let mut copy_ok = true;
        for d in defaults::list("routine.defaults_dirs") {
            copy_ok &= copy_dir(&root.join(d), &sim.join(d)).is_ok();
        }
        if let Some(tree) = &src.tree {
            for rel in defaults_files(tree) {
                let to = sim.join(&rel);
                copy_ok &= to.parent().is_none_or(|p| std::fs::create_dir_all(p).is_ok()) && std::fs::copy(tree.join(&rel), &to).is_ok();
            }
        }
        if !copy_ok {
            pre.problems.push(defaults::render("routine.problem_scratch", &[("root", &root.display())]));
            continue;
        }
        let e = scratch_env(scratch, Some(&sim));
        let r = run(&src.engine, &["config", "validate", &empty.display().to_string()], &e, limit, scratch, None);
        if r.code == Some(0) {
            log.say(defaults::render("routine.line_root_ok", &[("root", &root.display())]));
        } else {
            pre.problems.push(defaults::render("routine.problem_root", &[("root", &root.display()), ("code", &r.code.map_or_else(|| t("routine.no_code").to_string(), |c| c.to_string())), ("out", &first_line(&r.out))]));
        }
    }
    if tg.roots.is_empty() && src.tree.is_none() {
        log.say(t("routine.line_no_roots").to_string());
    }
    pre
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for e in std::fs::read_dir(from)?.flatten() {
        if e.file_type()?.is_file() {
            std::fs::copy(e.path(), to.join(e.file_name()))?;
        }
    }
    Ok(())
}

// ---- downgrade gate ---------------------------------------------------------------------------------------------------------

/// Why installing `target` over `cur` is a downgrade, or None: the plugin version decides, then (same version) the build time.
fn downgrade(cur: &Running, target_version: &str, target_built: u64, target_source: &str) -> Option<String> {
    if cur.version.is_empty() {
        return None;
    }
    match crate::version_cmp(target_version, &cur.version) {
        std::cmp::Ordering::Less => Some(t("routine.why_plugin_lower").to_string()),
        // a release (or a file) of the SAME engine version is not newer than a local or hand-installed build of it
        std::cmp::Ordering::Equal if target_source != t("routine.source_local") && (cur.source != t("routine.source_release") || cur.version.contains('+')) => Some(t("routine.why_local_running").to_string()),
        std::cmp::Ordering::Equal if cur.built > 0 && target_built > 0 && target_built < cur.built => Some(t("routine.why_build_older").to_string()),
        _ => None,
    }
}

// ---- validation -------------------------------------------------------------------------------------------------------------

/// The guard probe: the thin client answers a force push to main with the block exit code, `routine.probe_n` times in a row.
fn guard_probe(tg: &Target, scratch: &Path) -> Option<String> {
    if !tg.hook.is_file() {
        return Some(t("routine.problem_no_hook").to_string());
    }
    let root = tg.roots.last()?;
    let payload = scratch.join(t("routine.probe_file"));
    let body = defaults::fill(t("routine.probe_payload"), &[("cwd", &scratch.display())]);
    std::fs::write(&payload, body).ok()?;
    let envs = vec![
        (defaults::env_name("home").to_string(), defaults::env_var("home").unwrap_or_default()),
        (defaults::env_name("dir").to_string(), tg.state.display().to_string()),
        (t("routine.probe_root_env").to_string(), root.display().to_string()),
    ];
    let limit = defaults::secs("routine.call_timeout_s");
    let call = || run(&tg.hook, &[t("routine.probe_event")], &envs, limit, scratch, Some(&payload)).code;
    let _ = call(); // keep: the warm-up call may start the daemon
    let n = defaults::num("routine.probe_n").max(1);
    let blocked = (0..n).filter(|_| call() == i32::try_from(defaults::num("routine.probe_block_code")).ok()).count() as u64;
    (blocked != n).then(|| defaults::render("routine.problem_probe", &[("blocked", &blocked), ("n", &n)]))
}

/// Everything that must hold after an install. Each failure is one problem text; none is a reason to stop looking.
fn validate(tg: &Target, expect_sha: &str, started_ms: u64, scratch: &Path) -> Vec<String> {
    let mut problems = Vec::new();
    // settle: the first ticks, jobs and hooks run before the evidence is read
    std::thread::sleep(defaults::secs("routine.settle_s"));
    let post = post_update::evaluate(true, Some(expect_sha.to_string()));
    problems.extend(post.problems);
    let daemons = post_update::daemon_count();
    if daemons != 1 {
        problems.push(defaults::render("routine.problem_daemons", &[("n", &daemons)]));
    }
    if let Some(p) = guard_probe(tg, scratch) {
        problems.push(p);
    }
    let bad = defaults::list("routine.bad_event_kinds");
    let failed_codes = defaults::list("routine.failed_job_codes");
    let job_kind = t("routine.job_event_kind");
    for e in health::events().into_iter().filter(|e| e.ts >= started_ms) {
        let job_failed = e.kind == job_kind && failed_codes.contains(&e.code.as_str());
        if bad.contains(&e.kind.as_str()) || job_failed {
            problems.push(defaults::render("routine.problem_event", &[("kind", &e.kind), ("code", &e.code), ("detail", &e.detail.chars().take(defaults::num("routine.detail_chars") as usize).collect::<String>())]));
        }
    }
    let derr = tg.state.join(crate::bootstrap::ERROR_FILE);
    if let Ok(text) = std::fs::read_to_string(&derr) {
        let stamp = text.split_whitespace().next().and_then(|w| w.parse::<u64>().ok()).unwrap_or(0);
        if stamp * 1000 >= started_ms || stamp == 0 && !text.trim().is_empty() {
            // Keep the writer context even when the error itself exceeds the detail limit. Old lines have no suffix.
            let (detail, writer) = text.trim().rsplit_once("\tpid=").map(|(d, w)| (d, format!("pid={w}"))).unwrap_or((text.trim(), String::new()));
            problems.push(defaults::render("routine.problem_defaults_error", &[
                ("text", &detail.chars().take(defaults::num("routine.detail_chars") as usize).collect::<String>()),
                ("writer", &writer),
            ]));
        }
    }
    problems
}

// ---- rollback ---------------------------------------------------------------------------------------------------------------

fn latest_deploy(tg: &Target) -> Option<PathBuf> {
    let mut d: Vec<PathBuf> = std::fs::read_dir(tg.state.join(t("routine.deploys_dir"))).ok()?.flatten().map(|e| e.path()).filter(|p| p.join(t("routine.manifest_file")).is_file()).collect();
    d.sort();
    d.pop()
}

/// Put the saved copies of one install back: files, then binaries (a file the install added is moved aside, never deleted).
fn restore(dir: &Path, tg: &Target, scratch: &Path, log: &mut Log) -> Result<usize, String> {
    let m: Value = std::fs::read_to_string(dir.join(t("routine.manifest_file"))).ok().and_then(|s| serde_json::from_str(&s).ok()).ok_or_else(|| defaults::render("routine.msg_no_manifest", &[("dir", &dir.display())]))?;
    if !stop_daemon() {
        return Err(t("routine.msg_stop_failed").to_string());
    }
    let mut n = 0;
    let aside = dir.join(t("routine.added_dir"));
    for e in m["entries"].as_array().into_iter().flatten().chain(m["bins"].as_array().into_iter().flatten()) {
        let Some(dst) = e["dst"].as_str().map(PathBuf::from) else { continue };
        match e["backup"].as_str().map(PathBuf::from) {
            Some(b) if b.is_file() => {
                let tmp = stage_copy(&b, &dst).map_err(|e| defaults::render("routine.msg_restore_failed", &[("path", &dst.display()), ("why", &e)]))?;
                if dst.is_file() {
                    std::fs::set_permissions(&tmp, std::fs::metadata(&dst).map(|m| m.permissions()).unwrap_or_else(|_| PermissionsExt::from_mode(0o755))).ok();
                }
                std::fs::rename(&tmp, &dst).map_err(|e| defaults::render("routine.msg_restore_failed", &[("path", &dst.display()), ("why", &e)]))?;
                n += 1;
            }
            Some(b) => return Err(defaults::render("routine.msg_backup_missing", &[("path", &b.display())])),
            None if dst.is_file() => {
                std::fs::create_dir_all(&aside).map_err(|e| e.to_string())?;
                let to = aside.join(format!("{}-{}", n, dst.file_name().unwrap_or_default().to_string_lossy()));
                std::fs::rename(&dst, &to).map_err(|e| defaults::render("routine.msg_restore_failed", &[("path", &dst.display()), ("why", &e)]))?;
                n += 1;
            }
            None => {}
        }
    }
    integrity_accept(tg, scratch);
    log.say(defaults::render("routine.line_restored", &[("n", &n), ("dir", &dir.display())]));
    Ok(n)
}

// ---- install ----------------------------------------------------------------------------------------------------------------

enum Done {
    Ok,
    Failed,
    Refused,
    Usage,
}

impl Done {
    fn code(&self) -> i32 {
        match self {
            Done::Ok => 0,
            Done::Failed => 1,
            Done::Usage => 2,
            Done::Refused => 3,
        }
    }
}

fn summary(log: &mut Log, o: &Opts, fields: Value, done: &Done) -> i32 {
    if o.json {
        let mut v = fields;
        v["ok"] = json!(matches!(done, Done::Ok));
        v["lines"] = json!(log.lines);
        let mut out = std::io::stdout().lock();
        let _ = writeln!(out, "{v}"); // keep: nothing to do about a closed pipe at the very end
    }
    done.code()
}

/// `update --from-local <dir> | --rollback` and their flags.
pub fn run_routine(p: &Parsed) -> i32 {
    let o = match parse(p) {
        Ok(o) => o,
        Err(e) => {
            super::warn(&e);
            return Done::Usage.code();
        }
    };
    let scratch = std::env::temp_dir().join(format!("{}{}", t("routine.scratch_prefix"), std::process::id()));
    if std::fs::create_dir_all(scratch.join("home")).is_err() {
        super::warn(&defaults::render("routine.msg_scratch", &[("path", &scratch.display())]));
        return 1;
    }
    let mut log = Log { json: o.json, lines: Vec::new() };
    let (code, fields) = if o.rollback { manual_rollback(&o, &scratch, &mut log) } else { install(&o, &scratch, &mut log) };
    let _ = std::fs::remove_dir_all(&scratch); // keep: our own scratch directory (created above under the temp dir)
    summary(&mut log, &o, fields, &code)
}

fn manual_rollback(o: &Opts, scratch: &Path, log: &mut Log) -> (Done, Value) {
    let tg = resolve_target();
    let Some(dir) = o.deploy.clone().or_else(|| latest_deploy(&tg)) else {
        log.say(defaults::render("routine.msg_no_deploy", &[("dir", &tg.state.join(t("routine.deploys_dir")).display())]));
        return (Done::Failed, json!({"action": "rollback"}));
    };
    log.say(defaults::render("routine.line_rollback_plan", &[("dir", &dir.display())]));
    if !o.yes {
        log.say(t("routine.line_dry").to_string());
        return (Done::Ok, json!({"action": "rollback", "dry_run": true, "deploy": dir.display().to_string()}));
    }
    let hold = Hold::take(&tg);
    let started = health::now_ms();
    match restore(&dir, &tg, scratch, log) {
        Ok(_) => {
            drop(hold); // the guards must answer during the validation below: the hold makes every hook pass through
            let _ = start_daemon(&tg); // keep: validation below reports a daemon that did not come up
            let sha = sha_of(&tg.engine).unwrap_or_default();
            let problems = validate(&tg, &sha, started, scratch);
            for pr in &problems {
                log.say(defaults::render("routine.line_problem", &[("text", pr)]));
            }
            if problems.is_empty() {
                // the record says what is installed now: what the restored install had been before (its manifest's `from`)
                let from = std::fs::read_to_string(dir.join(t("routine.manifest_file"))).ok().and_then(|m| serde_json::from_str::<Value>(&m).ok()).map(|m| m["from"].clone()).unwrap_or(Value::Null);
                let record = json!({
                    "version": from["version"], "sha": sha, "source": from["source"].as_str().unwrap_or(t("routine.source_manual")),
                    "time": now_s(), "built_at": mtime_s(&tg.engine), "rolled_back_from": dir.display().to_string(),
                    (crate::bootstrap::INSTALL_ROOT_FIELD): from.get(crate::bootstrap::INSTALL_ROOT_FIELD).cloned()
                        .unwrap_or_else(|| json!(tg.roots.first())),
                });
                if let Err(e) = write_atomic(&record_path(&tg), &serde_json::to_string_pretty(&record).unwrap_or_default()) {
                    log.say(defaults::render("routine.msg_record_failed", &[("why", &e)]));
                }
                log.say(defaults::render("routine.line_rollback_ok", &[("sha", &short(&sha))]));
            }
            (if problems.is_empty() { Done::Ok } else { Done::Failed }, json!({"action": "rollback", "deploy": dir.display().to_string(), "problems": problems, "sha": sha}))
        }
        Err(e) => {
            log.say(defaults::render("routine.line_rollback_failed", &[("why", &e)]));
            (Done::Failed, json!({"action": "rollback", "error": e}))
        }
    }
}

fn install(o: &Opts, scratch: &Path, log: &mut Log) -> (Done, Value) {
    let src = match resolve_source(o) {
        Ok(s) => s,
        Err(e) => {
            log.say(e);
            return (Done::Usage, json!({"action": "install"}));
        }
    };
    let mut tg = resolve_target();
    // the tree being installed is not a place to install into (the installer may run against it)
    if let Some(tree) = src.tree.as_ref().and_then(|t| std::fs::canonicalize(t).ok()) {
        tg.roots.retain(|r| std::fs::canonicalize(r).ok().as_ref() != Some(&tree));
    }
    let pre = precheck(o, &src, &tg, scratch, log);
    let cur = running(&tg, scratch);
    // only a build directory keeps the time its binary was built; an unpacked release or a staged copy carries the time it was written
    let new_built = if o.source == t("routine.source_local") { mtime_s(&src.engine) } else { 0 };
    let head = json!({"action": "install", "source": o.source, "from": {"version": cur.version, "sha": cur.sha, "source": cur.source}, "to": {"version": pre.version, "sha": pre.sha}});
    log.say(defaults::render("routine.line_running", &[("version", &cur.version), ("sha", &cur.sha.as_deref().map_or_else(String::new, short)), ("source", &cur.source)]));
    if !pre.problems.is_empty() {
        for pr in &pre.problems {
            log.say(defaults::render("routine.line_problem", &[("text", pr)]));
        }
        log.say(t("routine.line_check_failed").to_string());
        return (Done::Failed, json!({"action": "install", "problems": pre.problems}));
    }
    // a set to install is one build: no uncommitted changes in it, and one version stamp across engine, client and dashboard
    let set: Vec<(&str, &str)> = [(t("routine.word_engine"), pre.version.as_str()), (t("routine.word_hook"), pre.hook_version.as_str()), (t("routine.word_web"), pre.web_version.as_str())]
        .into_iter()
        .filter(|(_, v)| !v.is_empty())
        .collect();
    let dirty = set.iter().filter(|(_, v)| v.ends_with(t("routine.dirty_suffix"))).map(|(n, v)| format!("{n} {v}")).collect::<Vec<_>>();
    if !dirty.is_empty() {
        let msg = defaults::render("routine.msg_dirty", &[("which", &dirty.join(", ")), ("flag", &flag("force"))]);
        if !o.force {
            log.say(msg);
            return (Done::Refused, json!({"action": "install", "refused": "dirty", "which": dirty}));
        }
        log.say(defaults::render("routine.line_dirty_forced", &[("which", &dirty.join(", "))]));
    }
    // each part has its own version: the set must satisfy the minimums the new engine declares of the client and the dashboard
    let (eng, hook, web) = (t("compat.part_engine"), t("compat.part_hook"), t("compat.part_web"));
    let incompatible: Vec<String> = [
        crate::compat::check(eng, &pre.version, hook, &pre.hook_min, &pre.hook_version),
        crate::compat::check(eng, &pre.version, web, &pre.web_min, &pre.web_version),
    ]
    .into_iter()
    .flatten()
    .collect();
    if !incompatible.is_empty() {
        let list = incompatible.iter().map(|l| format!("  {l}")).collect::<Vec<_>>().join("\n");
        let msg = defaults::render("routine.msg_mismatch", &[("set", &list), ("flag", &flag("force"))]);
        if !o.force {
            log.say(msg);
            return (Done::Refused, json!({"action": "install", "refused": "mismatch", "problems": incompatible}));
        }
        log.say(defaults::render("routine.line_mismatch_forced", &[]));
    }
    if let Some(why) = downgrade(&cur, &pre.version, new_built, &o.source) {
        let msg = defaults::render("routine.msg_downgrade", &[("running", &cur.version), ("target", &pre.version), ("why", &why), ("flag", &flag("force"))]);
        if !o.force {
            log.say(msg);
            return (Done::Refused, json!({"action": "install", "refused": "downgrade", "running": cur.version, "target": pre.version}));
        }
        log.say(defaults::render("routine.line_downgrade_forced", &[("running", &cur.version), ("target", &pre.version)]));
    }
    let same = cur.sha.as_deref() == Some(pre.sha.as_str());
    if o.check || !o.yes {
        log.say(defaults::render(if o.check { "routine.line_check_ok" } else { "routine.line_dry_plan" }, &[("roots", &tg.roots.len()), ("same", &if same { t("routine.word_same") } else { "" })]));
        sweep::run(src.tree.as_deref(), &tg.roots, true, true, &mut |l| log.say(l));
        return (Done::Ok, json!({"action": "install", "dry_run": true, "plan": {"roots": tg.roots.len(), "same_binary": same}, "from": head["from"], "to": head["to"]}));
    }
    do_install(o, &src, &tg, &pre, &cur, same, new_built, scratch, log, head)
}

#[allow(clippy::too_many_arguments)]
fn do_install(o: &Opts, src: &Source, tg: &Target, pre: &Pre, cur: &Running, same: bool, new_built: u64, scratch: &Path, log: &mut Log, head: Value) -> (Done, Value) {
    let ts = now_s();
    let jdir = tg.state.join(t("routine.deploys_dir")).join(format!("{ts:012}-{}", short(&pre.sha)));
    if let Err(e) = std::fs::create_dir_all(&jdir) {
        log.say(defaults::render("routine.msg_stage_failed", &[("path", &jdir.display()), ("why", &e)]));
        return (Done::Failed, head);
    }
    let mut j = Journal { dir: jdir.clone(), entries: Vec::new() };
    let mut bins: Vec<Value> = Vec::new();
    let mut staged: Vec<Staged> = Vec::new();
    // plugin files first, into every root; then the binaries
    let mut changed = 0;
    for root in &tg.roots {
        if let Some(tree) = &src.tree {
            let mut files = defaults_files(tree);
            let rest: Vec<PathBuf> = tree_files(tree).into_iter().filter(|r| !files.contains(r)).collect();
            files.extend(rest);
            match stage_tree(tree, root, &files, &mut j, &mut staged) {
                Ok(n) => changed += n,
                Err(e) => {
                    unstage(&staged);
                    log.say(e);
                    return (Done::Failed, head);
                }
            }
        }
    }
    log.say(defaults::render("routine.line_staged", &[("files", &changed), ("roots", &tg.roots.len())]));
    let stage_bin = |from: &Path, to: &Path, bins: &mut Vec<Value>, staged: &mut Vec<Staged>| -> Result<(), String> {
        let backup = jdir.join(to.file_name().unwrap_or_default());
        let had = to.is_file();
        if had {
            std::fs::copy(to, &backup).map_err(|e| defaults::render("routine.msg_stage_failed", &[("path", &backup.display()), ("why", &e)]))?;
        }
        let tmp = stage_copy(from, to).map_err(|e| defaults::render("routine.msg_stage_failed", &[("path", &to.display()), ("why", &e)]))?;
        std::fs::set_permissions(&tmp, PermissionsExt::from_mode(0o755)).map_err(|e| e.to_string())?;
        bins.push(json!({"dst": to.display().to_string(), "backup": had.then(|| backup.display().to_string())}));
        staged.push(Staged { tmp, dst: to.to_path_buf() });
        Ok(())
    };
    if let Err(e) = std::fs::create_dir_all(&tg.bin_dir).map_err(|e| e.to_string()).and_then(|()| {
        if !same {
            stage_bin(&src.engine, &tg.engine, &mut bins, &mut staged)?;
        }
        match &src.hook {
            Some(h) if sha_of(h) != sha_of(&tg.hook) => stage_bin(h, &tg.hook, &mut bins, &mut staged),
            _ => Ok(()),
        }
    }) {
        unstage(&staged);
        log.say(e);
        return (Done::Failed, head);
    }
    let mut manifest = head.clone();
    manifest["bins"] = Value::Array(bins.clone());
    manifest["time"] = json!(ts);
    if let Err(e) = j.write(&manifest) {
        unstage(&staged);
        log.say(defaults::render("routine.msg_stage_failed", &[("path", &jdir.display()), ("why", &e)]));
        return (Done::Failed, head);
    }
    // commit: hold, stop, rename everything into place, accept the integrity record, stop again, start, release
    let hold = Hold::take(tg);
    if !stop_daemon() {
        unstage(&staged);
        log.say(t("routine.msg_stop_failed").to_string());
        return (Done::Failed, head);
    }
    hold.refresh();
    let had_prev = tg.engine.is_file() && !same;
    if had_prev {
        let prev = tg.engine.with_file_name(format!("{}{}", t("rollback.bin_name"), t("updater.prev_suffix")));
        let _ = stage_copy(&tg.engine, &prev).and_then(|tmp| std::fs::rename(tmp, &prev)); // keep: the journal copy is the real rollback source
    }
    if let Err(e) = commit(&staged) {
        log.say(e);
        return fail_and_restore(&jdir, tg, pre, cur, scratch, log, head, vec![t("routine.problem_commit").to_string()]);
    }
    integrity_accept(tg, scratch);
    if !stop_daemon() {
        log.say(t("routine.msg_stop_failed").to_string());
    }
    hold.refresh();
    let started_ms = health::now_ms();
    let up = start_daemon(tg);
    drop(hold);
    log.say(defaults::render("routine.line_installed", &[("sha", &short(&pre.sha)), ("started", &if up { t("routine.word_up") } else { t("routine.word_down") })]));
    let problems = validate(tg, &pre.sha, started_ms, scratch);
    if !problems.is_empty() {
        for pr in &problems {
            log.say(defaults::render("routine.line_problem", &[("text", pr)]));
        }
        return fail_and_restore(&jdir, tg, pre, cur, scratch, log, head, problems);
    }
    log.say(defaults::render("routine.line_validated", &[("pid", &daemon_pid().unwrap_or(0))]));
    // the legacy sweep: files of the old install the new tree does not hold, artefacts of the old installers, state migrations
    let swept = sweep::run(src.tree.as_deref(), &tg.roots, false, true, &mut |l| log.say(l));
    manifest["retired"] = swept.to_json();
    if let Err(e) = j.write(&manifest) {
        log.say(defaults::render("routine.msg_record_failed", &[("why", &e)]));
    }
    // cleanup, record, summary
    let clean = post_update::evaluate(false, Some(pre.sha.clone()));
    if !clean.human.is_empty() {
        log.say(clean.human.clone());
    }
    let kept = prune_deploys(tg);
    let record = json!({
        "version": pre.version, "sha": pre.sha, "source": o.source, "time": now_s(), "built_at": new_built,
        "previous": {"version": cur.version, "sha": cur.sha, "source": cur.source},
        "deploy": jdir.display().to_string(),
        (crate::bootstrap::INSTALL_ROOT_FIELD): tg.roots.first(),
    });
    if let Err(e) = write_atomic(&record_path(tg), &serde_json::to_string_pretty(&record).unwrap_or_default()) {
        log.say(defaults::render("routine.msg_record_failed", &[("why", &e)]));
    }
    log.say(defaults::render("routine.line_summary", &[("version", &pre.version), ("sha", &short(&pre.sha)), ("source", &o.source), ("files", &changed), ("kept", &kept), ("deploy", &jdir.display())]));
    (Done::Ok, json!({"action": "install", "installed": record, "cleanup": clean.value, "files": changed, "retired": swept.to_json()}))
}

/// Install failed validation (or its commit): put the saved copies back, start the old binary, validate it, say so. Never a downgrade check.
#[allow(clippy::too_many_arguments)]
fn fail_and_restore(jdir: &Path, tg: &Target, pre: &Pre, cur: &Running, scratch: &Path, log: &mut Log, head: Value, problems: Vec<String>) -> (Done, Value) {
    log.say(defaults::render("routine.line_auto_rollback", &[("sha", &short(&pre.sha))]));
    let hold = Hold::take(tg);
    let mut out = json!({"action": "install", "rolled_back": true, "problems": problems, "from": head["from"], "to": head["to"]});
    match restore(jdir, tg, scratch, log) {
        Ok(_) => {
            let started = health::now_ms();
            let up = start_daemon(tg);
            drop(hold);
            let want = cur.sha.clone().unwrap_or_default();
            let again = if want.is_empty() { Vec::new() } else { validate(tg, &want, started, scratch) };
            for pr in &again {
                log.say(defaults::render("routine.line_problem", &[("text", pr)]));
            }
            out["restored"] = json!({"daemon_up": up, "problems": again, "sha": want});
            log.say(defaults::render(if again.is_empty() && up { "routine.line_rolled_back_ok" } else { "routine.line_rolled_back_bad" }, &[("sha", &short(&want)), ("version", &cur.version)]));
        }
        Err(e) => {
            drop(hold);
            log.say(defaults::render("routine.line_rollback_failed", &[("why", &e)]));
            out["restore_error"] = json!(e);
        }
    }
    (Done::Failed, out)
}

/// Remove the saved copies of older installs beyond the kept count (the newest stay). Returns how many remain.
fn prune_deploys(tg: &Target) -> usize {
    let dir = tg.state.join(t("routine.deploys_dir"));
    let mut d: Vec<PathBuf> = std::fs::read_dir(&dir).into_iter().flatten().flatten().map(|e| e.path()).filter(|p| p.join(t("routine.manifest_file")).is_file()).collect();
    d.sort();
    let keep = defaults::num("routine.keep_deploys").max(1) as usize;
    while d.len() > keep {
        let old = d.remove(0);
        let _ = std::fs::remove_dir_all(&old); // keep: an old saved copy beyond the kept count (owner-specified cleanup); a failure leaves it for the next run
    }
    d.len()
}

// ---- what the Updates page shows --------------------------------------------------------------------------------------------

/// `update --check --json`'s `engine` object: the running build version, where it came from, and the latest release the thin client sees.
pub fn engine_facts() -> Value {
    let tg = resolve_target();
    let scratch = std::env::temp_dir().join(format!("{}{}", t("routine.scratch_prefix"), std::process::id()));
    let made = std::fs::create_dir_all(scratch.join("home")).is_ok();
    let cur = running(&tg, &scratch);
    let rec = read_record(&tg);
    let latest = if tg.hook.is_file() && made {
        let args: Vec<&str> = defaults::list("routine.release_check_args");
        let root = tg.roots.first().cloned().or_else(defaults::root);
        let mut envs = vec![(defaults::env_name("dir").to_string(), tg.state.display().to_string()), (defaults::env_name("home").to_string(), defaults::env_var("home").unwrap_or_default())];
        envs.extend(root.map(|r| (defaults::env_name("plugin_root").to_string(), r.display().to_string())));
        let r = run(&tg.hook, &args, &envs, defaults::secs("routine.release_check_timeout_s"), &scratch, None);
        r.out.lines().rev().find(|l| l.trim_start().starts_with('{')).and_then(|l| serde_json::from_str::<Value>(l).ok()).unwrap_or_else(|| json!({"error": first_line(&r.out)}))
    } else {
        json!({"error": t("routine.word_no_client")})
    };
    let _ = std::fs::remove_dir_all(&scratch); // keep: our own scratch directory
    json!({
        "build_version": cur.version, "sha": cur.sha, "source": cur.source,
        "installed_at": rec["time"], "previous": rec["previous"], "latest_release": latest,
    })
}
