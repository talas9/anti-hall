//! `post-update-check` (owner requirement: "the updater must always check for valid running process after and cleanup").
//!
//! The one step every update path ends with (`ah-hook update`, `engine-update`, `scripts/engine-deploy.sh --deploy`):
//! 1. **verify** exactly one live `ah-engine serve` runs, its binary is the installed one (path, and not replaced after it started),
//!    its sha is the expected one, `status` answers and a real control round trip (`ping`) is inside its budget;
//! 2. **find every other anti-hall process** (the process table: pid, ppid, command, executable) and act: stale and scratch daemons
//!    are stopped by pid (TERM, KILL after the grace; never `pkill`), watchers on a replaced binary get a settle window to re-execute
//!    themselves (`wakew::rebin`) and are reported with the exact re-arm command when they do not, duplicate watchers of one session
//!    keep the newest, a server on an old binary is reported with its own command line;
//! 3. **clean up**: old engine and thin-client binaries beyond the kept rollback copy, a dead owner's pid files and socket, and temp
//!    files of a dead process. The current binary and every kept copy (`post_update.keep_suffixes`) are never touched.
//!
//! Nothing is stopped or removed unless the live daemon verified first (a failed verification never makes things worse), and
//! `--dry-run` reports what would be done and does nothing. Exit 0 when verified, 1 when not. Every list, grace time, pattern and
//! text is in `engine/defaults/post_update.toml`.
use crate::cli::Parsed;
use crate::defaults;
use crate::procwatch::table::{Row, Table};
use crate::{client, paths, procid};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashSet};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::time::Instant;

fn t(key: &str) -> &'static str {
    defaults::text(key)
}

struct Opts {
    dry: bool,
    expect: Option<String>,
}

fn parse(p: &Parsed) -> Result<Opts, String> {
    let mut o = Opts { dry: false, expect: None };
    let mut it = p.rest.iter();
    while let Some(a) = it.next() {
        if a == t("post_update.flag_dry_run") {
            o.dry = true;
        } else if a == t("post_update.flag_expect_sha") {
            let v = it.next().ok_or_else(|| defaults::render("post_update.msg_flag_value", &[("flag", a)]))?;
            o.expect = Some(v.to_lowercase());
        } else {
            return Err(defaults::render("post_update.msg_bad_arg", &[("arg", a)]));
        }
    }
    Ok(o)
}

/// What a process is, from its program and arguments.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Kind {
    Daemon,
    Watcher,
    Web,
}

impl Kind {
    fn word(self) -> &'static str {
        match self {
            Kind::Daemon => "daemon",
            Kind::Watcher => "watcher",
            Kind::Web => "web",
        }
    }
}

/// One row of the process table with the facts the decisions need.
struct Proc {
    row: Row,
    kind: Kind,
    exe: Option<PathBuf>,
    words: Vec<String>,
}

fn base(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

fn kind_of(words: &[String]) -> Option<Kind> {
    let prog = base(words.first()?);
    let has = |key: &str| words.iter().skip(1).any(|w| defaults::list(key).iter().any(|k| k == w));
    let is = |key: &str| defaults::list(key).contains(&prog);
    if is("post_update.engine_names") && has("post_update.watch_words") {
        Some(Kind::Watcher)
    } else if is("post_update.engine_names") && has("post_update.serve_words") {
        Some(Kind::Daemon)
    } else if is("post_update.web_names") && has("post_update.serve_words") {
        Some(Kind::Web)
    } else {
        None
    }
}

/// Which processes belong to THIS install: the ones that run a file in its binary directory, or that were started with its state
/// directory. Every other anti-hall process on the machine (another install, a scratch engine of somebody else) is not ours to touch.
struct Scope {
    bin_dir: Option<PathBuf>,
    state: PathBuf,
}

fn scope() -> Scope {
    let state = paths::dir();
    Scope { bin_dir: std::fs::canonicalize(state.join(t("rollback.bin_dir"))).ok(), state }
}

fn mine(table: &mut Table, sc: &Scope, pid: u32, exe: Option<&PathBuf>) -> bool {
    if let (Some(dir), Some(exe)) = (&sc.bin_dir, exe)
        && std::fs::canonicalize(exe).is_ok_and(|c| c.starts_with(dir))
    {
        return true;
    }
    table.environ(pid).iter().any(|(k, v)| k == defaults::env_name("dir") && Path::new(v) == sc.state)
}

fn procs(table: &mut Table, sc: &Scope) -> Vec<Proc> {
    let rows = table.list();
    rows.into_iter()
        .filter_map(|row| {
            let words: Vec<String> = row.cmd.split_whitespace().map(str::to_string).collect();
            let kind = kind_of(&words)?;
            let exe = procid::exe(row.pid);
            mine(table, sc, row.pid, exe.as_ref()).then_some(Proc { row, kind, exe, words })
        })
        .collect()
}

/// When the file at `path` last changed (modification or status change, whichever is later), seconds since the epoch.
fn changed_at(path: &Path) -> Option<u64> {
    let m = std::fs::metadata(path).ok()?;
    u64::try_from(m.mtime().max(m.ctime())).ok()
}

fn under(path: &str, roots: &[String]) -> bool {
    roots.iter().any(|r| path.starts_with(r.as_str()))
}

fn scratch_roots(home: &str) -> Vec<String> {
    defaults::list("post_update.scratch_roots").iter().map(|r| r.replace(t("post_update.home_token"), home)).collect()
}

/// Why the image this process runs is older than the file at its executable path (None when it is current or unknowable).
/// A watcher that re-executed itself carries the stamp of that restart in its environment.
fn old_image(table: &mut Table, p: &Proc) -> Option<&'static str> {
    let exe = p.exe.as_ref()?;
    if !exe.exists() {
        return Some(t("post_update.why_deleted"));
    }
    let changed = changed_at(exe)?;
    let stamp = if p.kind == Kind::Watcher {
        table.environ(p.row.pid).into_iter().find(|(k, _)| k == t("wake_watch.env_rebin")).and_then(|(_, v)| v.trim().parse::<u64>().ok()).unwrap_or(0)
    } else {
        0
    };
    (p.row.start_s.max(stamp) + defaults::num("post_update.change_slack_s") < changed).then_some(t("post_update.why_replaced"))
}

fn alive(pid: u32) -> bool {
    // SAFETY: signal 0 only tests that the process exists.
    let r = unsafe { libc::kill(pid as libc::pid_t, 0) };
    r == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

fn same_process(pid: u32, r: &Row) -> bool {
    Table::new().one(pid).is_some_and(|now| now.start_s == r.start_s && now.cmd == r.cmd)
}

/// TERM, wait the grace, KILL: by pid, and only while it is still the process that was seen. How it ended, or None (it did not).
fn stop(r: &Row) -> Option<&'static str> {
    let sent = |sig| procid::signal_verified(r.pid, sig, || same_process(r.pid, r));
    if !sent(libc::SIGTERM) {
        return (!same_process(r.pid, r)).then_some(t("post_update.how_gone"));
    }
    let until = Instant::now() + defaults::millis("post_update.grace_ms");
    while Instant::now() < until {
        if !same_process(r.pid, r) {
            return Some(t("post_update.how_term"));
        }
        std::thread::sleep(defaults::millis("post_update.poll_ms"));
    }
    if !sent(libc::SIGKILL) {
        return (!same_process(r.pid, r)).then_some(t("post_update.how_term"));
    }
    std::thread::sleep(defaults::millis("post_update.kill_wait_ms"));
    (!same_process(r.pid, r)).then_some(t("post_update.how_kill"))
}

/// The pids of this process and its ancestors: the updater that called us must never be stopped.
fn ancestry() -> HashSet<u32> {
    let mut s = HashSet::new();
    let mut p = Some(std::process::id());
    while let Some(pid) = p.filter(|p| *p > 1 && s.insert(*p)) {
        p = procid::parent(pid);
    }
    s
}

struct Report {
    problems: Vec<String>,
    daemon: Value,
    stopped: Vec<Value>,
    reexeced: Vec<Value>,
    left: Vec<Value>,
    cleaned: Vec<Value>,
}

fn short(sha: &str) -> String {
    sha.chars().take(defaults::num("post_update.sha_chars") as usize).collect()
}

/// Step 1: the live daemon. Retries while it is still coming up. Returns its pid when it answered `status`.
fn verify(o: &Opts, bin: &Path, rep: &mut Report) -> Option<u32> {
    let tries = defaults::num("post_update.verify_tries").max(1);
    let mut status = Value::Null;
    for i in 0..tries {
        status = client::status_value();
        if status["running"] == json!(true) {
            break;
        }
        if i + 1 < tries {
            std::thread::sleep(defaults::millis("post_update.verify_pause_ms"));
        }
    }
    if status["running"] != json!(true) {
        rep.problems.push(t("post_update.problem_not_running").to_string());
        return None;
    }
    let pid = status["pid"].as_u64().and_then(|p| u32::try_from(p).ok());
    let sha = crate::doctor::facts::sha256_file(bin).ok();
    let expected = o.expect.clone().or_else(|| {
        let f = bin.with_file_name(format!("{}{}", base(&bin.to_string_lossy()), t("rollback.expected_suffix")));
        std::fs::read_to_string(f).ok().map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty())
    });
    match (&sha, &expected) {
        (Some(have), Some(want)) if have != want => {
            rep.problems.push(defaults::render("post_update.problem_sha", &[("have", &short(have)), ("want", &short(want))]));
        }
        (None, _) => rep.problems.push(defaults::render("post_update.problem_unreadable", &[("path", &bin.display())])),
        _ => {}
    }
    let t0 = Instant::now();
    let pong = client::ping(&paths::socket());
    let ping_ms = t0.elapsed().as_millis() as u64;
    let budget = defaults::num("post_update.ping_budget_ms");
    match &pong {
        None => rep.problems.push(t("post_update.problem_ping").to_string()),
        Some(_) if ping_ms > budget => rep.problems.push(defaults::render("post_update.problem_slow", &[("ms", &ping_ms), ("budget", &budget)])),
        Some(_) => {}
    }
    let exe = pid.and_then(procid::exe);
    if let (Some(pid), Some(exe)) = (pid, exe.as_ref()) {
        if std::fs::canonicalize(exe).ok() != std::fs::canonicalize(bin).ok() {
            rep.problems.push(defaults::render("post_update.problem_path", &[("pid", &pid), ("exe", &exe.display()), ("bin", &bin.display())]));
        } else {
            let mut table = Table::new();
            if let Some(row) = table.one(pid) {
                let me = Proc { row, kind: Kind::Daemon, exe: Some(exe.clone()), words: Vec::new() };
                if let Some(why) = old_image(&mut table, &me) {
                    rep.problems.push(defaults::render("post_update.problem_old_daemon", &[("pid", &pid), ("why", &why)]));
                }
            }
        }
    }
    rep.daemon = json!({
        "pid": pid, "sha": sha, "expected_sha": expected, "sha_checked": expected.is_some(),
        "binary": bin.display().to_string(), "executable": exe.map(|e| e.display().to_string()),
        "uptime_s": status["uptime_s"], "footprint_kb": status["footprint_kb"], "rss_kb": status["rss_kb"],
        "version": status["version"], "ping_ms": pong.as_ref().map(|_| ping_ms),
    });
    pid
}

/// Stop `p` (or say it would be), recording it in the report.
fn act(o: &Opts, p: &Proc, reason: String, rep: &mut Report, stopped: &mut HashSet<u32>) {
    let mut v = json!({"pid": p.row.pid, "kind": p.kind.word(), "command": p.row.cmd, "reason": reason});
    if o.dry {
        v["would"] = json!(t("post_update.how_would_stop"));
    } else if let Some(how) = stop(&p.row) {
        v["how"] = json!(how);
        stopped.insert(p.row.pid);
    } else {
        v["how"] = json!(t("post_update.how_failed"));
        rep.problems.push(defaults::render("post_update.problem_stop", &[("pid", &p.row.pid)]));
    }
    rep.stopped.push(v);
}

/// Steps 2 and 3. `live` is the verified daemon's pid.
fn sweep(o: &Opts, live: u32, bin: &Path, home: &str, rep: &mut Report) {
    let roots = scratch_roots(home);
    let own = ancestry();
    let mut table = Table::new();
    let sc = scope();
    let all = procs(&mut table, &sc);
    let exe_of = |p: &Proc| p.exe.as_ref().map(|e| e.to_string_lossy().into_owned()).or_else(|| p.words.first().cloned()).unwrap_or_default();
    let mut gone: HashSet<u32> = HashSet::new();
    // old and scratch daemons
    for p in all.iter().filter(|p| p.kind == Kind::Daemon && p.row.pid != live && !own.contains(&p.row.pid)) {
        let why = if under(&exe_of(p), &roots) { t("post_update.why_scratch") } else { t("post_update.why_second_daemon") };
        act(o, p, why.to_string(), rep, &mut gone);
    }
    // duplicate watchers of one session: the newest stays
    let sess = defaults::list("wake_watch.session_env");
    let watch_words = defaults::list("post_update.watch_words");
    let mut groups: BTreeMap<(String, String), Vec<&Proc>> = BTreeMap::new();
    for p in all.iter().filter(|p| p.kind == Kind::Watcher && !own.contains(&p.row.pid)) {
        let env = table.environ(p.row.pid);
        let sid = sess.iter().find_map(|k| env.iter().find(|(n, v)| n == k && !v.is_empty()).map(|(_, v)| v.clone()));
        let verb = p.words.iter().skip(1).find(|w| !w.starts_with('-') && !watch_words.iter().any(|x| x == *w)).cloned().unwrap_or_default();
        if let Some(sid) = sid {
            groups.entry((verb, sid)).or_default().push(p);
        }
    }
    for ((verb, sid), mut g) in groups {
        g.sort_by_key(|p| (p.row.start_s, p.row.pid));
        g.pop();
        for p in g {
            act(o, p, defaults::render("post_update.why_duplicate", &[("verb", &verb), ("session", &sid)]), rep, &mut gone);
        }
    }
    // watchers on a replaced binary: a settle window for their own re-exec, then report with the re-arm command
    let dup_pids: HashSet<u32> = rep.stopped.iter().filter_map(|s| s["pid"].as_u64().and_then(|p| u32::try_from(p).ok())).collect();
    let mut pending: Vec<&Proc> = all
        .iter()
        .filter(|p| p.kind == Kind::Watcher && !dup_pids.contains(&p.row.pid) && !own.contains(&p.row.pid))
        .filter(|p| old_image(&mut table, p).is_some())
        .collect();
    if !o.dry && !pending.is_empty() {
        let until = Instant::now() + defaults::secs("post_update.watcher_settle_s");
        while Instant::now() < until && !pending.is_empty() {
            std::thread::sleep(defaults::millis("post_update.poll_ms"));
            let mut now = Table::new();
            let mut still = Vec::new();
            for p in pending {
                let Some(r) = now.one(p.row.pid).filter(|r| r.start_s == p.row.start_s) else { continue };
                let probe = Proc { row: r, kind: p.kind, exe: p.exe.clone(), words: p.words.clone() };
                if old_image(&mut now, &probe).is_some() {
                    still.push(p);
                } else {
                    rep.reexeced.push(json!({"pid": p.row.pid, "command": p.row.cmd}));
                }
            }
            pending = still;
        }
    }
    let hint = crate::checks::devswarm_role::text::engine_watcher(home);
    for p in pending {
        let mut v = json!({"pid": p.row.pid, "kind": p.kind.word(), "command": p.row.cmd, "reason": t("post_update.why_watcher_old"), "rearm": hint});
        if o.dry {
            v["would"] = json!(t("post_update.how_would_wait"));
        }
        rep.left.push(v);
    }
    // a server on a replaced binary is somebody's dashboard: report with its own command line, never stop
    for p in all.iter().filter(|p| p.kind == Kind::Web) {
        if let Some(why) = old_image(&mut table, p) {
            rep.left.push(json!({"pid": p.row.pid, "kind": p.kind.word(), "command": p.row.cmd, "reason": defaults::render("post_update.why_web_old", &[("why", &why)]), "restart": p.row.cmd}));
        }
    }
    // no daemon but the verified one may remain
    if !o.dry {
        let left = procs(&mut Table::new(), &sc).iter().filter(|p| p.kind == Kind::Daemon && p.row.pid != live && !own.contains(&p.row.pid)).count();
        if left > 0 {
            rep.problems.push(defaults::render("post_update.problem_daemons_left", &[("n", &left)]));
        }
    }
    clean(o, bin, &all, rep);
}

fn age_s(path: &Path) -> u64 {
    std::fs::metadata(path).ok().and_then(|m| m.modified().ok()).and_then(|m| m.elapsed().ok()).map_or(0, |d| d.as_secs())
}

fn remove(o: &Opts, path: &Path, why: String, rep: &mut Report) {
    let mut v = json!({"path": path.display().to_string(), "reason": why});
    if o.dry {
        v["would"] = json!(t("post_update.how_would_remove"));
    } else {
        let r = if path.is_dir() { std::fs::remove_dir_all(path) } else { std::fs::remove_file(path) };
        match r {
            Ok(()) => v["removed"] = json!(true),
            Err(e) => {
                v["removed"] = json!(false);
                v["error"] = json!(e.to_string());
            }
        }
    }
    rep.cleaned.push(v);
}

/// Step 3: artifacts. A file a live process runs, the current binary and every kept copy are never removed.
fn clean(o: &Opts, bin: &Path, all: &[Proc], rep: &mut Report) {
    let running: HashSet<PathBuf> = all.iter().filter_map(|p| p.exe.as_ref().and_then(|e| std::fs::canonicalize(e).ok())).collect();
    let state = paths::dir();
    let bin_dir = bin.parent().map_or_else(|| state.join(t("rollback.bin_dir")), Path::to_path_buf);
    let keep = defaults::list("post_update.keep_suffixes");
    let min_age = defaults::num("post_update.artifact_min_age_s");
    let prefixes: Vec<String> = defaults::list("post_update.artifact_names").iter().map(|n| format!("{n}.")).collect();
    let current = std::fs::canonicalize(bin).ok();
    let mut entries: Vec<_> = std::fs::read_dir(&bin_dir).into_iter().flatten().flatten().collect();
    entries.sort_by_key(std::fs::DirEntry::file_name);
    for e in entries {
        let name = e.file_name().to_string_lossy().into_owned();
        let path = e.path();
        let Some(prefix) = prefixes.iter().find(|p| name.starts_with(p.as_str())) else { continue };
        let suffix = name.get(prefix.len() - 1..).unwrap_or_default();
        let canon = std::fs::canonicalize(&path).ok();
        let kept = keep.contains(&suffix) || canon == current || canon.as_ref().is_some_and(|c| running.contains(c));
        if kept || !e.file_type().is_ok_and(|t| t.is_file()) || age_s(&path) < min_age {
            continue;
        }
        remove(o, &path, t("post_update.why_old_binary").to_string(), rep);
    }
    // pid files of a dead owner, then the socket when no engine runs
    for f in defaults::list("post_update.pid_files") {
        let path = state.join(f);
        let pid = std::fs::read_to_string(&path).ok().and_then(|s| s.split_whitespace().next().and_then(|w| w.parse::<u32>().ok()));
        if let Some(pid) = pid.filter(|p| !alive(*p)) {
            remove(o, &path, defaults::render("post_update.why_dead_owner", &[("pid", &pid)]), rep);
        }
    }
    let sock = paths::socket();
    if sock.exists() && client::ping(&sock).is_none() && !all.iter().any(|p| p.kind == Kind::Daemon) {
        remove(o, &sock, t("post_update.why_dead_socket").to_string(), rep);
    }
    // temp files of a dead process (`<name>.<pid>.<n>.tmp`) and the updater's own temp directories
    let tmp_age = defaults::num("post_update.tmp_min_age_s");
    for dir in [&state, &bin_dir] {
        for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            let path = e.path();
            if age_s(&path) < tmp_age {
                continue;
            }
            if name.starts_with(t("updater.tmp_prefix")) {
                remove(o, &path, t("post_update.why_update_tmp").to_string(), rep);
            } else if name.ends_with(t("post_update.tmp_suffix")) {
                let pid = name.split('.').find(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())).and_then(|s| s.parse::<u32>().ok());
                if let Some(pid) = pid.filter(|p| !alive(*p)) {
                    remove(o, &path, defaults::render("post_update.why_dead_owner", &[("pid", &pid)]), rep);
                }
            }
        }
    }
}

fn human(rep: &Report, verified: bool, dry: bool) -> String {
    let mut out = Vec::new();
    if dry {
        out.push(t("post_update.line_dry").to_string());
    }
    let d = &rep.daemon;
    out.push(if verified {
        defaults::render(
            "post_update.line_verified",
            &[
                ("pid", &d["pid"]),
                ("sha", &d["sha"].as_str().map_or(String::new(), short)),
                ("uptime", &d["uptime_s"]),
                ("kb", &d["footprint_kb"]),
                ("ms", &d["ping_ms"]),
            ],
        )
    } else {
        t("post_update.line_failed").to_string()
    });
    out.extend(rep.problems.iter().map(|p| defaults::render("post_update.line_problem", &[("text", p)])));
    let s = |v: &Value, k: &str| v[k].as_str().unwrap_or_default().to_string();
    for v in &rep.stopped {
        let how = v.get("how").or(v.get("would")).and_then(Value::as_str).unwrap_or_default();
        out.push(defaults::render("post_update.line_stopped", &[("pid", &v["pid"]), ("kind", &s(v, "kind")), ("reason", &s(v, "reason")), ("how", &how)]));
    }
    for v in &rep.reexeced {
        out.push(defaults::render("post_update.line_reexeced", &[("pid", &v["pid"])]));
    }
    for v in &rep.left {
        let next = v.get("rearm").or(v.get("restart")).and_then(Value::as_str).unwrap_or_default();
        out.push(defaults::render("post_update.line_left", &[("pid", &v["pid"]), ("kind", &s(v, "kind")), ("reason", &s(v, "reason")), ("next", &next)]));
    }
    for v in &rep.cleaned {
        let state = if v["removed"] == json!(false) {
            t("post_update.how_failed")
        } else if v.get("would").is_some() {
            t("post_update.how_would_remove")
        } else {
            t("post_update.how_removed")
        };
        out.push(defaults::render("post_update.line_cleaned", &[("path", &s(v, "path")), ("reason", &s(v, "reason")), ("state", &state)]));
    }
    out.join("\n")
}

/// What one pass found: `verified` is true when no problem was recorded; `value` is the JSON report (`post-update-check --json`).
pub(crate) struct Outcome {
    pub verified: bool,
    pub problems: Vec<String>,
    pub value: Value,
    pub human: String,
}

/// Verify the live daemon, then (unless `dry`) stop what must not run and clean old artifacts. `expect`: the sha the installed binary must
/// have (default: the recorded `.expected` file).
pub(crate) fn evaluate(dry: bool, expect: Option<String>) -> Outcome {
    let o = Opts { dry, expect };
    let home = defaults::env_var("home").unwrap_or_default();
    let bin = paths::dir().join(t("rollback.bin_dir")).join(t("rollback.bin_name"));
    let mut rep = Report { problems: Vec::new(), daemon: Value::Null, stopped: Vec::new(), reexeced: Vec::new(), left: Vec::new(), cleaned: Vec::new() };
    match verify(&o, &bin, &mut rep) {
        Some(pid) => sweep(&o, pid, &bin, &home, &mut rep),
        None => rep.problems.push(t("post_update.problem_no_sweep").to_string()),
    }
    let verified = rep.problems.is_empty();
    let value = json!({
        "verified": verified, "dry_run": o.dry, "problems": rep.problems, "daemon": rep.daemon,
        "stopped": rep.stopped, "reexeced": rep.reexeced, "left": rep.left, "cleaned": rep.cleaned,
    });
    let human = human(&rep, verified, o.dry);
    Outcome { verified, problems: rep.problems, value, human }
}

/// How many `ah-engine serve` daemons run (the process table, not the socket).
pub(crate) fn daemon_count() -> usize {
    procs(&mut Table::new(), &scope()).iter().filter(|p| p.kind == Kind::Daemon).count()
}

/// Stop the process `pid` (TERM, then KILL after the grace), only while it is still the process now seen. True when it is gone.
pub(crate) fn stop_pid(pid: u32) -> bool {
    match Table::new().one(pid) {
        Some(row) => stop(&row).is_some(),
        None => true,
    }
}

/// `post-update-check [--dry-run] [--expect-sha <hex>] [--json]`.
pub fn run(p: &Parsed) -> i32 {
    let o = match parse(p) {
        Ok(o) => o,
        Err(e) => {
            super::warn(&e);
            return 2;
        }
    };
    let out = evaluate(o.dry, o.expect);
    let line = if p.json { out.value.to_string() } else { out.human };
    if super::out(&format!("{line}\n")).is_err() {
        return 1;
    }
    i32::from(!out.verified)
}
