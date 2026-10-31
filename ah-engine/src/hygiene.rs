//! Disk hygiene: `ah-engine hygiene [--report|--clean]` and the scheduled job `disk_hygiene` (a `hygiene --report`
//! subprocess). The report classifies what lies under the configured work roots: scratch clones, deploy copies beyond the
//! newest few and old spill files. The class contract of a clone:
//!
//! - KEEP: a live process has its working directory (or an open file) inside it, or it was active within the idle window;
//!   also the structural guards (symlink, reusable, outside a work root, `.git` a file, linked worktrees, a failed process
//!   probe). `--clean` does nothing.
//! - TARGET-ONLY: a dirty tree, untracked files, a stash, unpushed commits (HEAD included), or a remote that cannot be
//!   verified. `--clean` removes only ignored, untracked build directories (`target/`) inside the clone.
//! - REMOVE-SAFE: clean, no stash or untracked file, HEAD and every branch tip reachable from a tip the remote serves right
//!   now (`git ls-remote`, read only: never a local, possibly stale remote-tracking ref, never a fetch); idle. `--clean`
//!   moves it to the Trash by rename (never a recursive delete, never across volumes).
//!
//! Live processes: every process's working directory (macOS `proc_pidinfo(PROC_PIDVNODEPATHINFO)`, Linux
//! `/proc/<pid>/cwd`) plus the open-files listing `lsof -Fn` when installed; the working directory of a process of another
//! user cannot be read without privileges. `--clean` probes again just before acting on each item. The report path deletes
//! nothing except the temporary file of its own failed report write. Every value lives in `disk_hygiene.toml`.
use crate::checks::git::util::Settings;
use crate::checks::guardkit::settings::{get_bool, get_number, get_string};
use crate::cli::Parsed;
use crate::defaults;
use crate::procwatch::disk;
use crate::procwatch::host::{Host, RealHost};
use crate::reqenv::RequestEnv;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

fn t(k: &str) -> &'static str {
    defaults::text(&format!("disk_hygiene.{k}"))
}

fn reason(k: &str) -> &'static str {
    defaults::raw("disk_hygiene.reasons").str_field(k)
}

fn now_s() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// One classified item.
#[derive(Debug, Clone)]
pub struct Item {
    /// clone, deploy or spill (`disk_hygiene.kind_*`).
    pub kind: &'static str,
    /// KEEP, TARGET-ONLY or REMOVE-SAFE (`disk_hygiene.class_*`).
    pub class: &'static str,
    /// Why (`disk_hygiene.reasons`).
    pub reason: &'static str,
    /// Where it is.
    pub path: PathBuf,
    /// What a clean would free: the whole item (REMOVE-SAFE), its build directories (TARGET-ONLY), 0 (KEEP).
    pub bytes: u64,
    /// The build directories a TARGET-ONLY clean deletes.
    pub targets: Vec<PathBuf>,
}

/// The tunables of one run.
struct Cfg {
    home: PathBuf,
    idle_s: u64,
    spill_s: u64,
    deploy_keep: usize,
    reusable: String,
    remote_timeout: std::time::Duration,
}

impl Cfg {
    fn load(st: &Settings) -> Cfg {
        Cfg {
            home: PathBuf::from(&st.home),
            idle_s: get_number(st, defaults::raw("disk_hygiene.idle_hours")).max(0.0) as u64 * defaults::num("disk_hygiene.secs_per_hour"),
            spill_s: get_number(st, defaults::raw("disk_hygiene.spill_days")).max(0.0) as u64 * defaults::num("disk_hygiene.secs_per_day"),
            deploy_keep: get_number(st, defaults::raw("disk_hygiene.deploy_keep")).max(0.0) as usize,
            reusable: get_string(st, defaults::raw("disk_hygiene.reusable_clone")),
            remote_timeout: std::time::Duration::from_secs(get_number(st, defaults::raw("disk_hygiene.remote_timeout_secs")).max(1.0) as u64),
        }
    }

    fn roots(&self) -> Vec<PathBuf> {
        defaults::list("disk_hygiene.work_roots").into_iter().map(|r| self.home.join(r)).collect()
    }
}

/// What live processes hold: their working directories and (when the open-files lister is installed) their open files.
pub struct Busy {
    paths: Vec<PathBuf>,
    ok: bool,
}

impl Busy {
    /// One system-wide probe.
    pub fn probe() -> Busy {
        let mut host = RealHost::new();
        let rows = host.procs();
        if rows.is_empty() {
            return Busy { paths: Vec::new(), ok: false };
        }
        let mut paths: Vec<PathBuf> = rows.iter().filter_map(|r| host.cwd(r.pid)).collect();
        let argv = defaults::list("disk_hygiene.open_files_argv");
        if let Some((prog, args)) = argv.split_first() {
            let out = Command::new(prog).args(args).stdin(Stdio::null()).stderr(Stdio::null()).output();
            match out {
                Ok(o) => {
                    let pre = t("open_files_prefix");
                    paths.extend(
                        String::from_utf8_lossy(&o.stdout).lines().filter_map(|l| l.strip_prefix(pre)).filter(|p| p.starts_with('/')).map(PathBuf::from),
                    );
                }
                // not installed: the working directories still decide; any other failure leaves nothing provable
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Busy { paths, ok: false },
            }
        }
        Busy { paths, ok: true }
    }

    fn inside(&self, dir: &Path) -> bool {
        let canon = std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
        self.paths.iter().any(|p| p.starts_with(dir) || p.starts_with(&canon))
    }
}

fn mtime_s(p: &Path) -> Option<u64> {
    p.symlink_metadata().ok()?.modified().ok()?.duration_since(UNIX_EPOCH).ok().map(|d| d.as_secs())
}

/// Seconds since the newest activity stamp of `dir` (the directory itself and `disk_hygiene.idle_files`).
fn idle_for(dir: &Path) -> u64 {
    let newest =
        std::iter::once(dir.to_path_buf()).chain(defaults::list("disk_hygiene.idle_files").into_iter().map(|f| dir.join(f))).filter_map(|p| mtime_s(&p)).max();
    newest.map_or(0, |n| now_s().saturating_sub(n))
}

/// Allocated bytes of a tree (symlinks not followed), at most `disk_hygiene.size_max_entries` entries.
pub fn size_of(p: &Path) -> u64 {
    let Ok(m) = p.symlink_metadata() else { return 0 };
    let blk = |m: &std::fs::Metadata| std::os::unix::fs::MetadataExt::blocks(m) * defaults::num("disk_hygiene.block_bytes");
    if !m.is_dir() {
        return blk(&m);
    }
    let mut left = defaults::num("disk_hygiene.size_max_entries");
    let (mut total, mut stack) = (0u64, vec![p.to_path_buf()]);
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            left = left.saturating_sub(1);
            if left == 0 {
                return total;
            }
            let Ok(m) = e.path().symlink_metadata() else { continue };
            total += blk(&m);
            if m.is_dir() {
                stack.push(e.path());
            }
        }
    }
    total
}

fn git(key: &str, dir: &Path, extra: &[&str]) -> Option<String> {
    let out = Command::new(t("git_program"))
        .args(defaults::list(&format!("disk_hygiene.{key}")))
        .args(extra)
        .current_dir(dir)
        .env(t("git_env_name"), t("git_env_value"))
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

fn real_dir(p: &Path) -> bool {
    p.symlink_metadata().is_ok_and(|m| m.is_dir())
}

/// The build directories of a clone: a configured name at its top or under one of its first-level directories.
fn build_dirs(clone: &Path) -> Vec<PathBuf> {
    let names = defaults::list("disk_hygiene.build_dirs");
    let mut out: Vec<PathBuf> = names.iter().map(|n| clone.join(n)).filter(|p| real_dir(p)).collect();
    if let Ok(rd) = std::fs::read_dir(clone) {
        for e in rd.flatten().filter(|e| real_dir(&e.path())) {
            out.extend(names.iter().map(|n| e.path().join(n)).filter(|p| real_dir(p)));
        }
    }
    out
}

/// Whether `p` is proved to lie strictly inside a work root: it resolves to itself (no symlink anywhere on the way) and
/// under a root that resolves to itself. Anything else is never removed.
fn contained(cfg: &Cfg, p: &Path) -> bool {
    let Ok(c) = std::fs::canonicalize(p) else { return false };
    c == p && cfg.roots().iter().any(|r| std::fs::canonicalize(r).is_ok_and(|cr| cr == *r) && c.starts_with(r) && c != *r)
}

/// A build directory is regenerable only when git tracks nothing under it and ignores it (so nothing in it is unique).
fn regenerable(clone: &Path, dir: &Path) -> bool {
    let Some(rel) = dir.strip_prefix(clone).ok().and_then(Path::to_str) else { return false };
    let rel = format!("{rel}/");
    git("git_tracked", clone, &[&rel]).is_some_and(|o| o.trim().is_empty()) && git("git_check_ignore", clone, &[&rel]).is_some()
}

/// What git says about a clone: removable whole, only its build directories, or nothing.
enum Verdict {
    Safe,
    Target(&'static str),
    Keep(&'static str),
}

/// Whether HEAD and every local branch tip are reachable from a tip some remote serves right now (`git ls-remote` per
/// remote, bounded by `remote_timeout`, read only: no fetch, no object or ref written). Ok(true) proved, Ok(false) a commit
/// no remote holds, Err no remote, a remote that failed or timed out, or a served branch tip this clone lacks (it is behind
/// and never fetched, so the remote may hold the commit): cannot be verified.
fn remote_holds_all(clone: &Path, timeout: std::time::Duration) -> Result<bool, ()> {
    let remotes = git("git_remotes", clone, &[]).ok_or(())?;
    let names: Vec<&str> = remotes.lines().map(str::trim).filter(|r| !r.is_empty()).collect();
    if names.is_empty() {
        return Err(());
    }
    let (mut tips, mut heads): (Vec<String>, Vec<String>) = (Vec::new(), Vec::new());
    for r in names {
        let mut cmd = Command::new(t("git_program"));
        cmd.args(defaults::list("disk_hygiene.git_ls_remote")).arg(r).current_dir(clone).env(t("git_env_name"), t("git_env_value"));
        for kv in defaults::list("disk_hygiene.remote_env") {
            if let Some((k, v)) = kv.split_once('=') {
                cmd.env(k, v);
            }
        }
        let out = crate::proc::run(cmd, t("git_program"), timeout, defaults::millis("disk_hygiene.remote_poll_ms")).map_err(|_| ())?;
        if !out.status.success() {
            return Err(());
        }
        for l in String::from_utf8_lossy(&out.stdout).lines() {
            let mut f = l.split_whitespace();
            if let (Some(sha), Some(name)) = (f.next(), f.next()) {
                tips.push(sha.to_string());
                if name.starts_with(t("branch_ref_prefix")) {
                    heads.push(sha.to_string());
                }
            }
        }
    }
    // every served tip is reachability proof; a tip this clone lacks the objects of is skipped by rev-list
    let mut args: Vec<&str> = vec![t("git_not")];
    args.extend(tips.iter().map(String::as_str));
    if git("git_unreachable", clone, &args).ok_or(())?.trim().is_empty() {
        return Ok(true);
    }
    // a commit no present tip holds: unpushed, unless a branch tip the remote serves is missing here (the clone is behind
    // and never fetched): then the remote may hold it and it cannot be verified without a fetch, which the report never does
    if heads.is_empty() {
        return Ok(false);
    }
    let heads_ref: Vec<&str> = heads.iter().map(String::as_str).collect();
    let present = git("git_present", clone, &heads_ref).ok_or(())?;
    let present: std::collections::BTreeSet<&str> = present.lines().map(str::trim).collect();
    if heads.iter().any(|h| !present.contains(h.as_str())) {
        return Err(());
    }
    Ok(false)
}

/// What git says against removal (every checked-out submodule too): Safe, Target(reason) or Keep(reason). A local probe
/// that fails is Target (unprovable): a build directory goes only after its own tracked and ignored checks succeed.
fn git_verdict(clone: &Path, depth: u64, timeout: std::time::Duration) -> Verdict {
    if depth == 0 {
        return Verdict::Target(reason("unprovable"));
    }
    let Some(status) = git("git_status", clone, &[]) else { return Verdict::Target(reason("unprovable")) };
    let ignored = t("git_ignored_prefix");
    let untracked = t("git_untracked_prefix");
    let regen = defaults::list("disk_hygiene.regenerable_ignored");
    let lines: Vec<&str> = status.lines().filter(|l| !l.is_empty()).collect();
    if lines.iter().any(|l| !l.starts_with(ignored) && !l.starts_with(untracked)) {
        return Verdict::Target(reason("dirty"));
    }
    // an untracked file, or an ignored one outside the regenerable names, may be the only copy of local data
    let local_data = lines.iter().any(|l| match l.strip_prefix(ignored) {
        Some(p) => !p.split('/').next().is_some_and(|top| regen.contains(&top)),
        None => true,
    });
    if local_data {
        return Verdict::Target(reason("untracked"));
    }
    match git("git_stash", clone, &[]) {
        None => return Verdict::Target(reason("unprovable")),
        Some(o) if !o.trim().is_empty() => return Verdict::Target(reason("stash")),
        Some(_) => {}
    }
    let wt = t("worktree_prefix");
    match git("git_worktrees", clone, &[]) {
        None => return Verdict::Target(reason("unprovable")),
        Some(o) if o.lines().filter(|l| l.starts_with(wt)).count() > 1 => return Verdict::Keep(reason("worktrees")),
        Some(_) => {}
    }
    // each submodule is a repository of its own: its changes, commits and stashes count as the clone's
    let link = t("gitlink_prefix");
    let Some(index) = git("git_gitlinks", clone, &[]) else { return Verdict::Target(reason("unprovable")) };
    for rec in index.split('\0').filter(|r| r.starts_with(link)) {
        let Some((_, rel)) = rec.split_once('\t') else { return Verdict::Target(reason("unprovable")) };
        let sub = clone.join(rel);
        if sub.join(t("git_marker")).symlink_metadata().is_err() {
            // not checked out: nothing local, unless the directory holds files
            let holds_files = match std::fs::read_dir(&sub) {
                Ok(mut rd) => rd.next().is_some(),
                Err(_) => sub.exists(),
            };
            if holds_files {
                return Verdict::Target(reason("unprovable"));
            }
            continue;
        }
        match git_verdict(&sub, depth - 1, timeout) {
            Verdict::Safe => {}
            other => return other,
        }
    }
    // last: the only network probe, after every local check passed
    match remote_holds_all(clone, timeout) {
        Ok(true) => Verdict::Safe,
        Ok(false) => Verdict::Target(reason("unpushed")),
        Err(()) => Verdict::Target(reason("remote_unverified")),
    }
}

fn keep(kind: &'static str, path: &Path, why: &'static str) -> Item {
    Item { kind, class: t("class_keep"), reason: why, path: path.to_path_buf(), bytes: 0, targets: Vec::new() }
}

/// Classify one clone (fail closed).
fn classify_clone(kind: &'static str, path: &Path, reusable: bool, cfg: &Cfg, busy: &Busy) -> Item {
    if path.symlink_metadata().is_ok_and(|m| m.file_type().is_symlink()) {
        return keep(kind, path, reason("symlink"));
    }
    if reusable {
        return keep(kind, path, reason("reusable"));
    }
    if !contained(cfg, path) {
        return keep(kind, path, reason("outside"));
    }
    if !real_dir(&path.join(t("git_marker"))) {
        return keep(kind, path, reason("linked"));
    }
    if !busy.ok {
        return keep(kind, path, reason("unprovable"));
    }
    if busy.inside(path) {
        return keep(kind, path, reason("live"));
    }
    if idle_for(path) < cfg.idle_s {
        return keep(kind, path, reason("recent"));
    }
    match git_verdict(path, defaults::num("disk_hygiene.submodule_depth"), cfg.remote_timeout) {
        Verdict::Keep(why) => keep(kind, path, why),
        Verdict::Safe => Item { kind, class: t("class_safe"), reason: reason("safe"), path: path.to_path_buf(), bytes: size_of(path), targets: Vec::new() },
        Verdict::Target(why) => {
            // only an ignored, untracked build directory goes; none (or none provable) leaves 0 bytes and nothing to do
            let targets: Vec<PathBuf> = build_dirs(path).into_iter().filter(|d| contained(cfg, d) && regenerable(path, d)).collect();
            let bytes: u64 = targets.iter().map(|d| size_of(d)).sum();
            Item { kind, class: t("class_target"), reason: why, path: path.to_path_buf(), bytes, targets }
        }
    }
}

/// Classify a deploy copy beyond the kept newest ones: a git clone goes through the clone checks; otherwise live, then idle.
fn classify_deploy(path: &Path, cfg: &Cfg, busy: &Busy) -> Item {
    let kind = t("kind_deploy");
    if path.join(t("git_marker")).symlink_metadata().is_ok() {
        return classify_clone(kind, path, false, cfg, busy);
    }
    if !contained(cfg, path) {
        return keep(kind, path, reason("outside"));
    }
    if !busy.ok {
        return keep(kind, path, reason("unprovable"));
    }
    if busy.inside(path) {
        return keep(kind, path, reason("live"));
    }
    if idle_for(path) < cfg.idle_s {
        return keep(kind, path, reason("recent"));
    }
    Item { kind, class: t("class_safe"), reason: reason("safe"), path: path.to_path_buf(), bytes: size_of(path), targets: Vec::new() }
}

fn subdirs(dir: &Path) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = std::fs::read_dir(dir).map(|rd| rd.flatten().map(|e| e.path()).filter(|p| real_dir(p)).collect()).unwrap_or_default();
    v.sort();
    v
}

fn name_of(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

/// The clones under `dir` (depth `left`), classified.
fn walk_clones(root: &Path, dir: &Path, left: u64, cfg: &Cfg, busy: &Busy, out: &mut Vec<Item>) {
    let keep_names = defaults::list("disk_hygiene.keep_names");
    let deploy = t("deploy_prefix");
    for d in subdirs(dir) {
        let name = name_of(&d);
        if dir == root && name.starts_with(deploy) && !keep_names.contains(&name.as_str()) {
            continue; // a deploy copy: classified by its own rule
        }
        let rel = d.strip_prefix(root).map(|r| r.to_string_lossy().into_owned()).unwrap_or_default();
        let reusable = keep_names.contains(&name.as_str()) || (!cfg.reusable.is_empty() && rel == cfg.reusable);
        if reusable || d.join(t("git_marker")).symlink_metadata().is_ok() {
            out.push(classify_clone(t("kind_clone"), &d, reusable, cfg, busy));
        } else if left > 1 {
            walk_clones(root, &d, left - 1, cfg, busy, out);
        }
    }
}

/// The full classification, plus the counts of items skipped without being listed (young spill files).
pub fn classify(st: &Settings, busy: &Busy) -> (Vec<Item>, BTreeMap<String, u64>) {
    let cfg = Cfg::load(st);
    let mut items = Vec::new();
    let mut unlisted: BTreeMap<String, u64> = BTreeMap::new();
    let keep_names = defaults::list("disk_hygiene.keep_names");
    for root in cfg.roots() {
        walk_clones(&root, &root, defaults::num("disk_hygiene.clone_depth"), &cfg, busy, &mut items);
        let mut deploys: Vec<(u64, PathBuf)> = subdirs(&root)
            .into_iter()
            .filter(|d| {
                let n = name_of(d);
                n.starts_with(t("deploy_prefix")) && !keep_names.contains(&n.as_str())
            })
            .map(|d| (mtime_s(&d).unwrap_or(0), d))
            .collect();
        deploys.sort_by(|a, b| b.cmp(a));
        for (i, (_, d)) in deploys.iter().enumerate() {
            items.push(if i < cfg.deploy_keep { keep(t("kind_deploy"), d, reason("newest")) } else { classify_deploy(d, &cfg, busy) });
        }
    }
    let now = now_s();
    for sd in defaults::list("disk_hygiene.spill_dirs") {
        let Ok(rd) = std::fs::read_dir(cfg.home.join(sd)) else { continue };
        let mut files: Vec<PathBuf> = rd.flatten().map(|e| e.path()).filter(|p| p.symlink_metadata().is_ok_and(|m| m.is_file())).collect();
        files.sort();
        for f in files {
            if now.saturating_sub(mtime_s(&f).unwrap_or(now)) >= cfg.spill_s {
                // outside the work roots: listed for the owner, never removed
                items.push(keep(t("kind_spill"), &f, reason("spill_only")));
            } else {
                *unlisted.entry(reason("fresh").to_string()).or_insert(0) += 1;
            }
        }
    }
    (items, unlisted)
}

/// Move `p` into the Trash by rename (same volume only). The name gets a time suffix when taken.
fn to_trash(home: &Path, p: &Path) -> bool {
    let Some(rel) = defaults::raw("disk_hygiene.trash_dirs").get(std::env::consts::OS).and_then(defaults::V::as_str) else { return false };
    let trash = home.join(rel);
    if std::fs::create_dir_all(&trash).is_err() {
        return false;
    }
    let name = name_of(p);
    let mut dest = trash.join(&name);
    if dest.symlink_metadata().is_ok() {
        dest = trash.join(defaults::render("disk_hygiene.trash_name", &[("name", &name), ("ts", &now_s())]));
    }
    dest.symlink_metadata().is_err() && std::fs::rename(p, &dest).is_ok()
}

fn refused(p: &Path, why: &str) {
    let detail = defaults::render("disk_hygiene.msg_refused", &[("path", &p.display()), ("why", &why)]);
    crate::health::log_event(t("health_kind"), t("health_refused"), &detail);
}

/// Act on the REMOVE-SAFE and TARGET-ONLY items, re-checking each one just before against a fresh process probe. Returns
/// (bytes reclaimed, refusals by reason).
fn clean(st: &Settings, items: &[Item]) -> (u64, BTreeMap<String, u64>) {
    let cfg = Cfg::load(st);
    let mut freed = 0u64;
    let mut skipped: BTreeMap<String, u64> = BTreeMap::new();
    for it in items.iter().filter(|i| i.class != t("class_keep")) {
        if it.kind == t("kind_spill") {
            continue; // report only
        }
        // a process may have entered the item since the report's probe
        let busy = Busy::probe();
        let again = if it.kind == t("kind_deploy") { classify_deploy(&it.path, &cfg, &busy) } else { classify_clone(it.kind, &it.path, false, &cfg, &busy) };
        if again.class != it.class {
            refused(&it.path, t("why_changed"));
            *skipped.entry(again.reason.to_string()).or_insert(0) += 1;
            continue;
        }
        if again.class == t("class_safe") {
            if contained(&cfg, &again.path) && to_trash(&cfg.home, &again.path) {
                freed += again.bytes;
            } else {
                refused(&again.path, t("why_no_trash"));
                *skipped.entry(t("why_no_trash").to_string()).or_insert(0) += 1;
            }
            continue;
        }
        for d in &again.targets {
            let size = size_of(d);
            if contained(&cfg, d) && real_dir(d) && regenerable(&again.path, d) && std::fs::remove_dir_all(d).is_ok() {
                freed += size;
            }
        }
    }
    (freed, skipped)
}

fn item_json(i: &Item) -> Value {
    json!({"kind": i.kind, "class": i.class, "reason": i.reason, "path": i.path.to_string_lossy(), "bytes": i.bytes, "size": disk::human(i.bytes), "targets": i.targets.iter().map(|d| d.to_string_lossy().into_owned()).collect::<Vec<_>>()})
}

/// The low-disk notice: Some(text) when a volume of HOME or a work root is below the disk_watch warn floor.
fn low_disk(st: &Settings, reclaimable: u64) -> Option<String> {
    if !disk::Floors::enabled(st) {
        return None;
    }
    let cfg = Cfg::load(st);
    let mut paths = vec![cfg.home.clone()];
    paths.extend(cfg.roots().into_iter().filter(|r| r.exists()));
    let host = RealHost::new();
    let vols = disk::volumes(&host, &paths, &disk::Floors::load(st));
    let low: Vec<String> = vols
        .iter()
        .filter(|v| v.level != disk::Level::Ok)
        .map(|v| defaults::render("disk_hygiene.msg_vol", &[("path", &v.path.display()), ("free", &disk::human(v.space.free))]))
        .collect();
    if low.is_empty() {
        return None;
    }
    Some(defaults::render("disk_hygiene.msg_low", &[("list", &low.join(", ")), ("reclaimable", &disk::human(reclaimable))]))
}

fn count(name: &str, value: u64, micros: u64, exit: i32) {
    crate::telemetry::emit::event(crate::telemetry::emit::command_run(t("tel_cmd"), name, exit, micros, value));
}

/// The verb's handler.
pub fn run_cmd(p: &Parsed) -> i32 {
    let flags: Vec<&str> = p.rest.iter().map(String::as_str).collect();
    let is_clean = flags.contains(&t("flag_clean"));
    if flags.iter().any(|f| *f != t("flag_clean") && *f != t("flag_report")) || (is_clean && flags.contains(&t("flag_report"))) {
        eprintln!("{}", t("msg_usage"));
        return 64;
    }
    let st = Settings::from_env(&RequestEnv::capture());
    if !get_bool(&st, defaults::raw("disk_hygiene.sw_enabled")) {
        println!("{}", if p.json { json!({"enabled": false}).to_string() } else { t("msg_off").to_string() });
        return 0;
    }
    let started = std::time::Instant::now();
    let busy = Busy::probe();
    let (items, mut skipped) = classify(&st, &busy);
    let mut classes: BTreeMap<&str, u64> = [t("class_keep"), t("class_target"), t("class_safe")].into_iter().map(|c| (c, 0)).collect();
    for i in &items {
        *classes.entry(i.class).or_insert(0) += 1;
    }
    // every item a clean does not move whole counts its reason (KEEP and TARGET-ONLY alike)
    for i in items.iter().filter(|i| i.class != t("class_safe")) {
        *skipped.entry(i.reason.to_string()).or_insert(0) += 1;
    }
    let reclaimable: u64 = items.iter().map(|i| i.bytes).sum();
    let mut reclaimed = 0u64;
    if is_clean {
        let (freed, refusals) = clean(&st, &items);
        reclaimed = freed;
        for (k, v) in refusals {
            *skipped.entry(k).or_insert(0) += v;
        }
    }
    let notice = low_disk(&st, reclaimable.saturating_sub(reclaimed));
    if let Some(n) = &notice {
        crate::health::log_event(t("health_kind"), t("health_low"), n);
    }
    let mut report = json!({
        "ts_s": now_s(), "mode": if is_clean { t("flag_clean") } else { t("flag_report") },
        "items": items.iter().map(item_json).collect::<Vec<_>>(),
        "bytes_reclaimable": reclaimable, "bytes_reclaimed": reclaimed, "items_listed": items.len(), "items_skipped": skipped,
        "items_by_class": classes, "notice": notice,
    });
    // the report file: a failed write (the only file this run may then unlink is the temporary one it created) fails the run
    let dir = crate::paths::dir();
    let written = std::fs::create_dir_all(&dir).and_then(|()| crate::atomic::write(dir.join(t("report_file")), report.to_string()));
    let code = match &written {
        Ok(()) => 0,
        Err(e) => {
            let detail = defaults::render("disk_hygiene.msg_report_failed", &[("path", &dir.join(t("report_file")).display()), ("err", e)]);
            crate::health::log_event(t("health_kind"), t("health_report_failed"), &detail);
            eprintln!("{detail}");
            report["report_error"] = json!(e.to_string());
            defaults::num("disk_hygiene.exit_report_failed") as i32
        }
    };
    let micros = started.elapsed().as_micros() as u64;
    let c = defaults::raw("disk_hygiene.tel_counters");
    count(c.str_field("reclaimable"), reclaimable, micros, code);
    count(c.str_field("reclaimed"), reclaimed, micros, code);
    count(c.str_field("listed"), items.len() as u64, micros, code);
    count(c.str_field("report_failed"), u64::from(written.is_err()), micros, code);
    for (k, v) in &classes {
        count(&format!("{}{k}", c.str_field("class")), *v, micros, code);
    }
    for (k, v) in &skipped {
        count(&format!("{}{k}", c.str_field("skipped")), *v, micros, code);
    }
    if p.json {
        println!("{report}");
    } else {
        for i in &items {
            let size = disk::human(i.bytes);
            println!(
                "{}",
                defaults::render(
                    "disk_hygiene.msg_line",
                    &[("class", &i.class), ("kind", &i.kind), ("size", &size), ("reason", &i.reason), ("path", &i.path.display())]
                )
            );
        }
        println!(
            "{}",
            defaults::render(
                "disk_hygiene.msg_total",
                &[("n", &items.len()), ("reclaimable", &disk::human(reclaimable)), ("reclaimed", &disk::human(reclaimed))]
            )
        );
        if let Some(n) = notice {
            println!("{n}");
        }
    }
    code
}
