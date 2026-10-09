//! DevSwarm ingest daemons the scheduler still has loaded but that nothing on disk explains: the report every `doctor` run gives
//! (read-only) and the explicit `--repair-ingest-orphans [--apply]` unload. Ported from `companion/install-devswarm-ingest.js`
//! (`orphanReapPlan`, `bootoutLoadedLabel`, `stopLoadedUnit`) and `doctor-repair.js` (`runIngestOrphanRepair`).
//!
//! Only an entry with no unit file on disk, no resolvable directory and no live heartbeat or lock is eligible for an unload; every
//! other class is report-only. The unload is `launchctl bootout` / `systemctl --user stop` by label (the scheduler stops the
//! process; nothing is ever signalled here) and, as in the Node installer, never runs when the dry-run variable is set or the home
//! is under the temp directory.
use super::Doc;
use crate::checks::jsport::json::J;
use crate::defaults;
use crate::migrate::{self, Ctx};
use std::path::{Path, PathBuf};
use std::process::Command;

/// One loaded scheduler entry with what is known about it.
struct Entry {
    label: Option<String>,
    unit: Option<String>,
    pid: Option<u64>,
    script: Option<String>,
    plist: bool,
    path_exists: bool,
    kind: &'static str,
    class: &'static str,
    eligible: bool,
}

/// What `listInstalledIngestUnits` reads back about an installed unit.
struct Installed {
    label: Option<String>,
    unit: Option<String>,
    working_dir: Option<String>,
    script: Option<String>,
}

fn platform() -> &'static str {
    super::node_platform().0
}

fn run_text(ctx: &Ctx, argv: &[&str]) -> Option<String> {
    let (prog, args) = argv.split_first()?;
    let mut cmd = Command::new(prog);
    cmd.args(args).env_clear().envs(&ctx.env);
    let out =
        crate::proc::run(cmd, defaults::text("doctor.probe_label"), defaults::millis("doctor.orphans_timeout_ms"), defaults::millis("doctor.probe_poll_ms"))
            .ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

/// `listLoadedIngestLabels`: `(label|unit, pid)` of what the scheduler has loaded under the ingest name.
fn loaded(ctx: &Ctx, os: &str) -> Vec<(String, Option<u64>)> {
    if os == defaults::text("doctor.os_darwin") {
        let Some(text) = run_text(ctx, &defaults::list("doctor.orphans_launchctl_list")) else { return Vec::new() };
        text.lines()
            .skip(1)
            .filter_map(|l| {
                let f: Vec<&str> = l.split_whitespace().collect();
                (f.len() >= 3 && f[2].starts_with(defaults::text("doctor.ingest_label")))
                    .then(|| (f[2].to_string(), if f[0] == defaults::text("doctor.orphans_no_pid") { None } else { f[0].parse::<u64>().ok() }))
            })
            .collect()
    } else if os == defaults::text("doctor.os_linux") {
        let Some(text) = run_text(ctx, &defaults::list("doctor.orphans_systemctl_list")) else { return Vec::new() };
        let ext = defaults::text("doctor.service_ext");
        text.lines()
            .filter_map(|l| l.split_whitespace().next())
            .filter(|u| u.starts_with(defaults::text("doctor.ingest_unit")) && u.ends_with(ext))
            .map(|u| (u[..u.len() - ext.len()].to_string(), None))
            .collect()
    } else {
        Vec::new()
    }
}

fn unescape_xml(s: &str) -> String {
    let mut out = s.to_string();
    for pair in defaults::list("doctor.xml_unescape") {
        if let Some((from, to)) = pair.split_once(defaults::text("doctor.pair_sep")) {
            out = out.replace(from, to);
        }
    }
    out
}

fn unsd_quote(s: &str) -> String {
    let mut v = s.trim();
    if v.len() >= 2 && v.starts_with('"') && v.ends_with('"') {
        v = &v[1..v.len() - 1];
    }
    v.replace("$$", "$").replace("\\\"", "\"").replace("\\\\", "\\")
}

/// The suffix of an installed unit's name when it is a shape the ingest installer writes (`""` legacy base, a hash or a project key).
fn suffix_ok(rest: &str, sep: &str) -> bool {
    if rest.is_empty() {
        return true;
    }
    let Some(s) = rest.strip_prefix(sep) else { return false };
    crate::checks::lit_re(defaults::text("doctor.unit_hash_re")).is_match(s) || crate::checks::lit_re(defaults::text("doctor.unit_key_re")).is_match(s)
}

/// `listInstalledIngestUnits`: the units installed on disk (plist, systemd unit or crontab entry) with their baked directory and script.
fn installed(ctx: &Ctx, os: &str) -> Vec<Installed> {
    let mut units = Vec::new();
    let home = Path::new(&ctx.home);
    if os == defaults::text("doctor.os_darwin") {
        let dir: PathBuf = home.join(defaults::list("doctor.launchd_dir").iter().collect::<PathBuf>());
        let (label, ext) = (defaults::text("doctor.ingest_label"), defaults::text("doctor.plist_ext"));
        let wd = crate::checks::lit_re(defaults::text("doctor.plist_wd_re"));
        let arr = crate::checks::lit_re(defaults::text("doctor.plist_args_re"));
        let strs = crate::checks::lit_re(defaults::text("doctor.plist_string_re"));
        for name in migrate::read_dir_sorted(&dir).unwrap_or_default() {
            if !name.starts_with(label) || !name.ends_with(ext) {
                continue;
            }
            if !suffix_ok(&name[label.len()..name.len() - ext.len()], ".") {
                continue;
            }
            let Ok(xml) = std::fs::read_to_string(dir.join(&name)) else { continue };
            let working_dir = wd.captures(&xml).map(|c| unescape_xml(&c[1]));
            let script = arr.captures(&xml).and_then(|c| strs.captures_iter(&c[1]).nth(1).map(|m| unescape_xml(&m[1])));
            units.push(Installed { label: Some(name[..name.len() - ext.len()].to_string()), unit: None, working_dir, script });
        }
    } else if os == defaults::text("doctor.os_linux") {
        let dir: PathBuf = home.join(defaults::list("doctor.systemd_dir").iter().collect::<PathBuf>());
        let (unit, ext) = (defaults::text("doctor.ingest_unit"), defaults::text("doctor.service_ext"));
        let wd = crate::checks::lit_re(defaults::text("doctor.service_wd_re"));
        let exec = crate::checks::lit_re(defaults::text("doctor.service_exec_re"));
        let quoted = crate::checks::lit_re(defaults::text("doctor.service_quoted_re"));
        for name in migrate::read_dir_sorted(&dir).unwrap_or_default() {
            if !name.starts_with(unit) || !name.ends_with(ext) {
                continue;
            }
            if !suffix_ok(&name[unit.len()..name.len() - ext.len()], "-") {
                continue;
            }
            let Ok(svc) = std::fs::read_to_string(dir.join(&name)) else { continue };
            let working_dir = wd.captures(&svc).map(|c| unsd_quote(&c[1]));
            let script = exec.captures(&svc).and_then(|c| quoted.find_iter(&c[1]).nth(1).map(|m| unsd_quote(m.as_str())));
            units.push(Installed { label: None, unit: Some(name[..name.len() - ext.len()].to_string()), working_dir, script });
        }
        // the crontab fallback: a marker comment line, then the command line it labels
        if let Some(tab) = run_text(ctx, &defaults::list("doctor.orphans_crontab")) {
            let lines: Vec<&str> = tab.lines().collect();
            let marker = format!("{}{unit}", defaults::text("doctor.cron_marker"));
            let cd = crate::checks::lit_re(defaults::text("doctor.cron_cd_re"));
            let sq = crate::checks::lit_re(defaults::text("doctor.cron_quoted_re"));
            for (i, l) in lines.iter().enumerate() {
                let t = l.trim();
                if !t.starts_with(&marker) || !suffix_ok(&t[marker.len()..], "-") {
                    continue;
                }
                let cmd = lines.get(i + 1).copied().unwrap_or("");
                let working_dir = cd.captures(cmd).map(|c| c[2].replace("'\\''", "'"));
                let after = if cd.is_match(cmd) { cmd.split_once("&&").map_or(cmd, |x| x.1) } else { cmd };
                let after = crate::checks::lit_re(defaults::text("doctor.cron_assign_re")).replace(after, "").into_owned();
                let script = sq.captures_iter(&after).nth(1).map(|c| c[1].replace("'\\''", "'"));
                units.push(Installed { label: None, unit: Some(t[defaults::text("doctor.cron_marker").len()..].to_string()), working_dir, script });
            }
        }
    }
    units
}

/// The kind of a loaded name and its key: `Some((kind, key))` for a recognised shape, `None` for one that must never be touched.
fn parse_loaded(name: &str, prefix: &str, sep: &str) -> Option<(&'static str, Option<String>)> {
    let rest = name.strip_prefix(prefix)?;
    if rest.is_empty() {
        return Some((defaults::text("doctor.kind_base"), None));
    }
    let suffix = rest.strip_prefix(sep)?;
    if crate::checks::lit_re(defaults::text("doctor.unit_hash_re")).is_match(suffix) {
        Some((defaults::text("doctor.kind_hash"), Some(suffix.to_string())))
    } else if crate::checks::lit_re(defaults::text("doctor.unit_key_re")).is_match(suffix) {
        Some((defaults::text("doctor.kind_key"), Some(suffix.to_string())))
    } else {
        None
    }
}

fn read_json(p: &Path) -> Option<J> {
    migrate::parse_json(&std::fs::read_to_string(p).ok()?)
}

fn field_u64(j: &J, k: &str) -> Option<u64> {
    match j.get(k) {
        Some(J::Num(n)) if n.is_finite() && *n >= 0.0 => Some(*n as u64),
        _ => None,
    }
}

/// A heartbeat file written within the stale window.
fn fresh_beat(ctx: &Ctx, key: &str) -> bool {
    let p = ctx.devswarm().join(defaults::text("doctor.heartbeat_dir")).join(defaults::render("doctor.ingest_file", &[("key", &key)]));
    let Some(ts) = read_json(&p).and_then(|b| match b.get("ts") {
        Some(J::Num(n)) if n.is_finite() => Some(*n),
        _ => None,
    }) else {
        return false;
    };
    crate::checks::jsport::date::now_ms() - ts <= defaults::num("doctor.heartbeat_stale_ms") as f64
}

/// A lock file whose holder is a running process.
fn live_lock(ctx: &Ctx, file: &str) -> bool {
    read_json(&ctx.devswarm().join(defaults::text("doctor.lock_dir")).join(file))
        .and_then(|h| field_u64(&h, "pid"))
        .is_some_and(|p| u32::try_from(p).is_ok_and(crate::health::pid_alive))
}

/// `unitLiveness`: a fresh heartbeat or a live lock holder proves the daemon is in use; anything unresolvable counts as live.
fn unit_live(ctx: &Ctx, kind: &str, key: Option<&str>) -> bool {
    match (kind, key) {
        (k, Some(key)) if k == defaults::text("doctor.kind_key") => {
            fresh_beat(ctx, key) || live_lock(ctx, &defaults::render("doctor.project_lock_file", &[("key", &key)]))
        }
        (k, Some(key)) if k == defaults::text("doctor.kind_hash") => {
            live_lock(ctx, &defaults::render("doctor.ingest_lock_file", &[("key", &key)])) || fresh_beat(ctx, key)
        }
        _ => true,
    }
}

/// `orphanReapPlan`: every loaded entry, classified.
fn plan(ctx: &Ctx) -> Vec<Entry> {
    let os = platform();
    let (prefix, sep) =
        if os == defaults::text("doctor.os_darwin") { (defaults::text("doctor.ingest_label"), ".") } else { (defaults::text("doctor.ingest_unit"), "-") };
    let units = installed(ctx, os);
    let mut entries: Vec<(Entry, Option<String>)> = Vec::new();
    for (name, pid) in loaded(ctx, os) {
        let is_darwin = os == defaults::text("doctor.os_darwin");
        let matched = units.iter().find(|u| if is_darwin { u.label.as_deref() == Some(&name) } else { u.unit.as_deref() == Some(&name) });
        let parsed = parse_loaded(&name, prefix, sep);
        let kind = parsed.as_ref().map_or(defaults::text("doctor.kind_unknown"), |p| p.0);
        let key = parsed.as_ref().and_then(|p| p.1.clone());
        let working_dir = matched.and_then(|m| m.working_dir.clone());
        let path_exists = matched.is_some() && working_dir.as_deref().is_some_and(|w| Path::new(w).exists());
        let live = parsed.as_ref().is_none_or(|_| unit_live(ctx, kind, key.as_deref()));
        let class = if matched.is_none() {
            defaults::text("doctor.class_no_plist")
        } else if !path_exists {
            defaults::text("doctor.class_path_gone")
        } else if kind == defaults::text("doctor.kind_unknown") {
            defaults::text("doctor.class_unknown")
        } else if live {
            defaults::text("doctor.class_healthy")
        } else {
            defaults::text("doctor.class_unknown")
        };
        let entry = Entry {
            label: is_darwin.then(|| name.clone()),
            unit: (!is_darwin).then(|| name.clone()),
            pid,
            script: matched.and_then(|m| m.script.clone()),
            plist: matched.is_some(),
            path_exists,
            kind,
            class,
            eligible: class == defaults::text("doctor.class_no_plist") && !live,
        };
        entries.push((entry, working_dir));
    }
    // two loaded legacy units that resolve to the same project are duplicates (report-only; eligibility is never changed)
    let mut by_key: Vec<(String, Vec<usize>)> = Vec::new();
    for (i, (e, wd)) in entries.iter().enumerate() {
        let (true, Some(wd)) = (e.kind == defaults::text("doctor.kind_hash") && e.path_exists, wd) else { continue };
        let Some(rk) = crate::meshw::ident::repo_key_for_worktree(wd).ok().flatten() else { continue };
        match by_key.iter_mut().find(|(k, _)| *k == rk) {
            Some((_, v)) => v.push(i),
            None => by_key.push((rk, vec![i])),
        }
    }
    for (_, group) in by_key.iter().filter(|(_, g)| g.len() >= 2) {
        for &i in group {
            entries[i].0.class = defaults::text("doctor.class_duplicate");
            entries[i].0.eligible = false;
        }
    }
    // fail closed: an eligible entry must have neither a unit file nor a directory
    if entries.iter().any(|(e, _)| e.eligible && (e.plist || e.path_exists)) {
        return Vec::new();
    }
    entries.into_iter().map(|e| e.0).collect()
}

fn name_of(e: &Entry) -> String {
    e.label.clone().or_else(|| e.unit.clone()).unwrap_or_else(|| defaults::text("doctor.unknown_name").to_string())
}

/// The always-on report of loaded entries that are not healthy.
pub fn detect_section(doc: &mut Doc, ctx: &Ctx) {
    let all = plan(ctx);
    let flagged: Vec<&Entry> = all.iter().filter(|e| e.class != defaults::text("doctor.class_healthy")).collect();
    if flagged.is_empty() {
        return;
    }
    doc.head(defaults::text("doctor_msg.head_orphans"));
    doc.infol(defaults::render("doctor_msg.orphans_summary", &[("n", &flagged.len()), ("total", &all.len())]));
    let cap = defaults::num("doctor.orphans_table_cap") as usize;
    let yn = |b: bool| if b { defaults::text("doctor.yes_short") } else { defaults::text("doctor.no_short") };
    for e in flagged.iter().take(cap) {
        let pid = e.pid.map_or(defaults::text("doctor.dash").to_string(), |p| p.to_string());
        doc.warnl(defaults::render(
            "doctor_msg.orphan_row",
            &[
                ("name", &name_of(e)),
                ("pid", &pid),
                ("script", &e.script.as_deref().unwrap_or(defaults::text("doctor.dash"))),
                ("plist", &yn(e.plist)),
                ("path", &yn(e.path_exists)),
                ("class", &e.class),
            ],
        ));
    }
    if flagged.len() > cap {
        doc.infol(defaults::render("doctor_msg.orphans_more", &[("n", &(flagged.len() - cap))]));
    }
}

/// Whether a scheduler command must not really run: the installer's dry-run variable is set, or the home is under the temp directory.
fn dry_guard(ctx: &Ctx) -> bool {
    if ctx.env.get(defaults::text("doctor.ingest_dry_env")).is_some_and(|v| v == "1") {
        return true;
    }
    let tmp = ctx
        .env
        .get(defaults::text("doctor.tmpdir_env"))
        .filter(|t| !t.is_empty())
        .cloned()
        .unwrap_or_else(|| defaults::text("doctor.tmpdir_default").to_string());
    let tmp = tmp.trim_end_matches('/');
    let home = std::fs::canonicalize(&ctx.home).map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|_| ctx.home.clone());
    [tmp.to_string(), std::fs::canonicalize(tmp).map(|p| p.to_string_lossy().into_owned()).unwrap_or_default()]
        .iter()
        .any(|t| !t.is_empty() && (ctx.home.starts_with(&format!("{t}/")) || home.starts_with(&format!("{t}/"))))
}

/// One row of the explicit repair: `(id, status, message)` with status `fixed`, `skipped` or `failed`.
pub type RepairRow = (String, &'static str, String);

/// `runIngestOrphanRepair`: the plan as dry-run rows, or, with `apply`, the unload of every eligible entry.
pub fn repair(ctx: &Ctx, apply: bool) -> Vec<RepairRow> {
    let id = defaults::text("doctor.repair_orphans_id").to_string();
    let os = platform();
    let darwin = os == defaults::text("doctor.os_darwin");
    if !darwin && os != defaults::text("doctor.os_linux") {
        return vec![(id, "skipped", defaults::render("doctor_msg.orphans_platform", &[("platform", &os)]))];
    }
    let all = plan(ctx);
    let eligible: Vec<&Entry> = all.iter().filter(|e| e.eligible).collect();
    if eligible.is_empty() {
        let msg = if all.is_empty() {
            defaults::text("doctor_msg.orphans_none_loaded").to_string()
        } else {
            defaults::render("doctor_msg.orphans_none_eligible", &[("n", &all.len())])
        };
        return vec![(id, "skipped", msg)];
    }
    let uid = crate::limits::uid();
    let mut rows = Vec::new();
    for e in eligible {
        let name = name_of(e);
        let row_id = defaults::render("doctor.repair_orphan_id", &[("name", &name)]);
        let argv: Vec<String> = defaults::list(if darwin { "doctor.orphans_bootout" } else { "doctor.orphans_stop" })
            .iter()
            .map(|a| defaults::fill(a, &[("uid", &uid), ("label", &name), ("unit", &name)]))
            .collect();
        if !apply {
            let shown = defaults::render(if darwin { "doctor_msg.orphans_cmd_darwin" } else { "doctor_msg.orphans_cmd_linux" }, &[("name", &name)]);
            rows.push((row_id, "skipped", defaults::render("doctor_msg.orphans_would", &[("cmd", &shown), ("class", &e.class)])));
            continue;
        }
        let outcome: Result<(), String> = if dry_guard(ctx) {
            Ok(())
        } else {
            let mut cmd = Command::new(&argv[0]);
            cmd.args(&argv[1..]).env_clear().envs(&ctx.env);
            match crate::proc::run(
                cmd,
                defaults::text("doctor.probe_label"),
                defaults::millis("doctor.orphans_timeout_ms"),
                defaults::millis("doctor.probe_poll_ms"),
            ) {
                Ok(o) if o.status.success() => Ok(()),
                Ok(o) => Err(format!(
                    "{} {}",
                    defaults::text("doctor.exit_word"),
                    o.status.code().map_or(defaults::text("doctor.no_exit_code").to_string(), |c| c.to_string())
                )),
                Err(e) => Err(e.into_io().to_string()),
            }
        };
        match outcome {
            Ok(()) => rows.push((row_id, "fixed", defaults::render("doctor_msg.orphans_unloaded", &[("name", &name), ("class", &e.class)]))),
            Err(why) => rows.push((row_id, "failed", defaults::render("doctor_msg.orphans_failed", &[("name", &name), ("class", &e.class), ("why", &why)]))),
        }
    }
    rows
}
