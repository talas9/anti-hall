//! Disk hygiene: `ah-engine hygiene [--report|--clean]` and the scheduled job `disk_hygiene` (a `hygiene --report`
//! subprocess). The report classifies what lies under the configured work roots: scratch clones (KEEP, REMOVE-TARGET-ONLY,
//! REMOVE-SAFE), deploy copies beyond the newest few and old spill files. It fails closed: a clone is REMOVE-SAFE only when it
//! is proved idle, clean, fully pushed, without stash or linked worktree, and no live process works inside it; whatever a probe
//! cannot answer is KEEP. The job only reports (and logs a notice below the disk_watch warn floor). Only an explicit `--clean`
//! acts: it re-checks each item, moves REMOVE-SAFE items to the Trash by rename (never a recursive delete, never across
//! volumes) and deletes only the build directories of REMOVE-TARGET-ONLY clones. Every value lives in `disk_hygiene.toml`.
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
    /// KEEP, REMOVE-TARGET-ONLY or REMOVE-SAFE (`disk_hygiene.class_*`).
    pub class: &'static str,
    /// Why (`disk_hygiene.reasons`).
    pub reason: &'static str,
    /// Where it is.
    pub path: PathBuf,
    /// What a clean would free: the whole item (REMOVE-SAFE), its build directories (REMOVE-TARGET-ONLY), 0 (KEEP).
    pub bytes: u64,
    /// The build directories a REMOVE-TARGET-ONLY clean deletes.
    pub targets: Vec<PathBuf>,
}

/// The tunables of one run.
struct Cfg {
    home: PathBuf,
    idle_s: u64,
    spill_s: u64,
    deploy_keep: usize,
    reusable: String,
}

impl Cfg {
    fn load(st: &Settings) -> Cfg {
        Cfg {
            home: PathBuf::from(&st.home),
            idle_s: get_number(st, defaults::raw("disk_hygiene.idle_hours")).max(0.0) as u64 * defaults::num("disk_hygiene.secs_per_hour"),
            spill_s: get_number(st, defaults::raw("disk_hygiene.spill_days")).max(0.0) as u64 * defaults::num("disk_hygiene.secs_per_day"),
            deploy_keep: get_number(st, defaults::raw("disk_hygiene.deploy_keep")).max(0.0) as usize,
            reusable: get_string(st, defaults::raw("disk_hygiene.reusable_clone")),
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

fn git(key: &str, dir: &Path) -> Option<String> {
    let out = Command::new(t("git_program"))
        .args(defaults::list(&format!("disk_hygiene.{key}")))
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

/// What git says against removal: None (clean and fully pushed), Some(reason), or Err (unprovable).
fn git_objection(clone: &Path) -> Result<Option<&'static str>, ()> {
    let status = git("git_status", clone).ok_or(())?;
    let ignored = t("git_ignored_prefix");
    let regen = defaults::list("disk_hygiene.regenerable_ignored");
    let dirty = status.lines().filter(|l| !l.is_empty()).any(|l| match l.strip_prefix(ignored) {
        Some(p) => !p.split('/').next().is_some_and(|top| regen.contains(&top)),
        None => true,
    });
    if dirty {
        return Ok(Some(reason("dirty")));
    }
    if !git("git_unpushed", clone).ok_or(())?.trim().is_empty() {
        return Ok(Some(reason("unpushed")));
    }
    if !git("git_stash", clone).ok_or(())?.trim().is_empty() {
        return Ok(Some(reason("stash")));
    }
    let wt = t("worktree_prefix");
    if git("git_worktrees", clone).ok_or(())?.lines().filter(|l| l.starts_with(wt)).count() > 1 {
        return Ok(Some(reason("worktrees")));
    }
    Ok(None)
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
    match git_objection(path) {
        Err(()) => keep(kind, path, reason("unprovable")),
        Ok(None) => Item { kind, class: t("class_safe"), reason: reason("safe"), path: path.to_path_buf(), bytes: size_of(path), targets: Vec::new() },
        Ok(Some(why)) => {
            let targets = build_dirs(path);
            let bytes: u64 = targets.iter().map(|d| size_of(d)).sum();
            if bytes == 0 {
                return keep(kind, path, why);
            }
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
                items.push(Item { kind: t("kind_spill"), class: t("class_safe"), reason: reason("safe"), bytes: size_of(&f), path: f, targets: Vec::new() });
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

/// Act on the REMOVE items, re-checking each one just before. Returns (bytes reclaimed, refusals by reason).
fn clean(st: &Settings, items: &[Item], busy: &Busy) -> (u64, BTreeMap<String, u64>) {
    let cfg = Cfg::load(st);
    let mut freed = 0u64;
    let mut skipped: BTreeMap<String, u64> = BTreeMap::new();
    for it in items.iter().filter(|i| i.class != t("class_keep")) {
        let again = if it.kind == t("kind_spill") {
            it.clone()
        } else if it.kind == t("kind_deploy") {
            classify_deploy(&it.path, &cfg, busy)
        } else {
            classify_clone(it.kind, &it.path, false, &cfg, busy)
        };
        if again.class != it.class {
            refused(&it.path, t("why_changed"));
            *skipped.entry(again.reason.to_string()).or_insert(0) += 1;
            continue;
        }
        if again.class == t("class_safe") {
            if to_trash(&cfg.home, &again.path) {
                freed += again.bytes;
            } else {
                refused(&again.path, t("why_no_trash"));
                *skipped.entry(t("why_no_trash").to_string()).or_insert(0) += 1;
            }
            continue;
        }
        for d in &again.targets {
            let size = size_of(d);
            if real_dir(d) && std::fs::remove_dir_all(d).is_ok() {
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

fn count(name: &str, value: u64, micros: u64) {
    crate::telemetry::emit::event(crate::telemetry::emit::command_run(t("tel_cmd"), name, 0, micros, value));
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
    for i in items.iter().filter(|i| i.class == t("class_keep")) {
        *skipped.entry(i.reason.to_string()).or_insert(0) += 1;
    }
    let reclaimable: u64 = items.iter().map(|i| i.bytes).sum();
    let mut reclaimed = 0u64;
    if is_clean {
        let (freed, refusals) = clean(&st, &items, &busy);
        reclaimed = freed;
        for (k, v) in refusals {
            *skipped.entry(k).or_insert(0) += v;
        }
    }
    let notice = low_disk(&st, reclaimable.saturating_sub(reclaimed));
    if let Some(n) = &notice {
        crate::health::log_event(t("health_kind"), t("health_low"), n);
    }
    let micros = started.elapsed().as_micros() as u64;
    let c = defaults::raw("disk_hygiene.tel_counters");
    count(c.str_field("reclaimable"), reclaimable, micros);
    count(c.str_field("reclaimed"), reclaimed, micros);
    count(c.str_field("listed"), items.len() as u64, micros);
    for (k, v) in &skipped {
        count(&format!("{}{k}", c.str_field("skipped")), *v, micros);
    }
    let report = json!({
        "ts_s": now_s(), "mode": if is_clean { t("flag_clean") } else { t("flag_report") },
        "items": items.iter().map(item_json).collect::<Vec<_>>(),
        "bytes_reclaimable": reclaimable, "bytes_reclaimed": reclaimed, "items_listed": items.len(), "items_skipped": skipped,
        "notice": notice,
    });
    let dir = crate::paths::dir();
    crate::discard::logged("hygiene_report", std::fs::create_dir_all(&dir));
    crate::discard::logged("hygiene_report", crate::atomic::write(dir.join(t("report_file")), report.to_string()));
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
    0
}
