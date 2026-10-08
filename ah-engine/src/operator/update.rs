//! `ah-engine update [--check] [--post-pull-only]`: the self-update of anti-hall, ported from
//! `skills/update/scripts/update.js`.
//!
//! Full update: `git pull --ff-only` of the marketplace clone (a dirty tree or a non-fast-forward is a hard STOP, an offline
//! failure fails open), a copy of the plugin into a NEW version-pinned cache directory (never over or beside an existing
//! one), the harness's own `claude plugin update` when its registry names an older version (bounded, never interactive,
//! never answering a confirmation), the changelog delta, and one JSON status line followed by a human summary.
//! `--check` only compares the installed version with the remote one: no pull, no writes.
//!
//! Guards kept from the Node script: `installed_plugins.json` is only ever read, never written; the pull is
//! fast-forward-only; nothing is deleted or overwritten; every failure is a status text and exit 0, except the two STOPs
//! (exit 1).
//!
//! The post-pull stages that work on the DevSwarm stores and the settings migration are NOT ported here: they run by the
//! plugin's own `update.js --post-pull-only` (the freshly pulled copy, as the Node script's re-exec does), and their status
//! keys are merged into this command's status exactly as the Node re-exec merges them. When Node or that script is not
//! there, those keys are simply absent.
use super::{out, t, warn};
use crate::checks::guardkit::paths::{basename, is_absolute, join, resolve_abs};
use crate::checks::guardkit::text::{js_number_of_str, js_trim, js_trim_end};
use crate::checks::jsport::json::{self, J, stringify};
use crate::checks::jsport::text::slice16_lossy;
use crate::cli::Parsed;
use crate::defaults;
use crate::jev::settings::{Env, bool_token};
use crate::proc;
use crate::setup::jsfmt::{js_string, obj};
use regex::Regex;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

/// The compiled patterns of a run.
struct Rx {
    semver: Regex,
    heading: Regex,
    vprefix: Regex,
    confirm: Regex,
    failed: Regex,
    offline: Regex,
    v_strip: Regex,
}

fn rx(key: &str) -> Result<Regex, String> {
    Regex::new(defaults::text(key)).map_err(|e| format!("{key}: {e}"))
}

impl Rx {
    fn new() -> Result<Rx, String> {
        let offline = format!("(?i){}", defaults::list("update.offline_patterns").join("|"));
        Ok(Rx {
            semver: rx("update.semver_re")?,
            heading: rx("update.heading_re")?,
            vprefix: rx("update.version_prefix_re")?,
            confirm: rx("update.confirm_re")?,
            failed: rx("update.failed_re")?,
            offline: Regex::new(&offline).map_err(|e| format!("update.offline_patterns: {e}"))?,
            v_strip: rx("update.v_strip_re")?,
        })
    }
}

/// Where everything lives.
struct Paths {
    marketplace: String,
    override_ignored: String,
    cache_root: String,
    installed_json: String,
    plugin_json: String,
    changelog: String,
    plugin_src: String,
}

fn resolve_paths(env: &Env, home: &str) -> Paths {
    let mut marketplace = join(home, t("update.marketplace_rel"));
    let mut override_ignored = String::new();
    let name = defaults::text("env.update_marketplace_dir");
    if let Some(o) = env.get(name).filter(|o| !o.is_empty()) {
        if is_absolute(o) && std::fs::metadata(o).is_ok_and(|m| m.is_dir()) {
            marketplace = o.to_string();
        } else {
            override_ignored = defaults::render("update_msg.override_ignored", &[("path", &o)]);
        }
    }
    let plugins_root = resolve_abs(&format!("{marketplace}/../.."));
    let plugin_src = join(&marketplace, t("update.plugin_src_rel"));
    Paths {
        override_ignored,
        cache_root: join(&plugins_root, t("update.cache_rel")),
        installed_json: join(&plugins_root, t("update.installed_json")),
        plugin_json: join(&plugin_src, t("update.plugin_json_rel")),
        changelog: join(&marketplace, t("update.changelog_file")),
        plugin_src,
        marketplace,
    }
}

// ---- reading ----------------------------------------------------------------------------------------------------------------

/// A bounded JSON read: `None` for a missing, oversized, unreadable or malformed file.
fn read_json(path: &str) -> Option<J> {
    let md = std::fs::metadata(path).ok()?;
    if md.len() > defaults::num("update.max_bytes") {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    json::parse(&String::from_utf8_lossy(&bytes), defaults::num("update.json_max_depth") as usize).ok()
}

fn str_of(v: Option<&J>) -> Option<&str> {
    match v {
        Some(J::Str(s)) => Some(s),
        _ => None,
    }
}

// ---- versions ---------------------------------------------------------------------------------------------------------------

fn is_semver(rx: &Rx, v: &str) -> bool {
    let t = js_trim(v);
    rx.semver.is_match(&rx.v_strip.replace(t, ""))
}

fn semver_opt(rx: &Rx, v: Option<&str>) -> bool {
    v.is_some_and(|v| is_semver(rx, v))
}

fn parse_version(rx: &Rx, v: &str) -> Option<Vec<f64>> {
    let t = rx.v_strip.replace(js_trim(v), "").into_owned();
    let m = rx.vprefix.captures(&t)?;
    let parts: Vec<f64> = m[1].split('.').map(|n| n.parse::<f64>().unwrap_or(f64::NAN)).collect();
    parts.iter().all(|n| n.is_finite()).then_some(parts)
}

/// -1, 0 or 1; an unparseable version reads as 0.
fn compare(rx: &Rx, a: &str, b: &str) -> i32 {
    let pa = parse_version(rx, a).unwrap_or_else(|| vec![0.0]);
    let pb = parse_version(rx, b).unwrap_or_else(|| vec![0.0]);
    for i in 0..pa.len().max(pb.len()) {
        let (x, y) = (pa.get(i).copied().unwrap_or(0.0), pb.get(i).copied().unwrap_or(0.0));
        if x < y {
            return -1;
        }
        if x > y {
            return 1;
        }
    }
    0
}

fn version_from_installed_json(rx: &Rx, path: &str) -> Option<String> {
    let data = read_json(path)?;
    if !matches!(data, J::Obj(_) | J::Arr(_)) {
        return None;
    }
    let reg = match data.get("plugins") {
        Some(p @ (J::Obj(_) | J::Arr(_))) => p,
        _ => &data,
    };
    match reg.get("anti-hall@anti-hall")? {
        J::Arr(entries) => {
            let valid: Vec<&J> = entries.iter().filter(|e| matches!(e, J::Obj(_)) && semver_opt(rx, str_of(e.get("version")))).collect();
            let scoped = |s: &str| valid.iter().find(|e| str_of(e.get("scope")) == Some(s));
            let pick = scoped("user").or_else(|| scoped("project")).or_else(|| valid.first())?;
            str_of(pick.get("version")).map(str::to_string)
        }
        J::Str(s) => is_semver(rx, s).then(|| s.clone()),
        e @ J::Obj(_) => str_of(e.get("version")).filter(|v| is_semver(rx, v)).map(str::to_string),
        _ => None,
    }
}

fn newest_cache_version(rx: &Rx, root: &str) -> Option<String> {
    let mut versions: Vec<String> = std::fs::read_dir(root)
        .ok()?
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| is_semver(rx, n))
        .collect();
    versions.sort_by(|a, b| compare(rx, a, b).cmp(&0));
    versions.pop()
}

fn version_from_marketplace(rx: &Rx, path: &str) -> Option<String> {
    let data = read_json(path)?;
    str_of(data.get("version")).filter(|v| is_semver(rx, v)).map(str::to_string)
}

/// The higher of the registry's version and the newest cache directory's; the marketplace manifest only when neither reads.
fn resolve_installed(rx: &Rx, paths: &Paths) -> Option<String> {
    let cache = newest_cache_version(rx, &paths.cache_root);
    let json = version_from_installed_json(rx, &paths.installed_json);
    if let (Some(c), Some(j)) = (&cache, &json) {
        return Some(if compare(rx, c, j) >= 0 { c.clone() } else { j.clone() });
    }
    cache.or(json).or_else(|| version_from_marketplace(rx, &paths.plugin_json))
}

/// The registry and the cache both read, and disagree.
fn installed_version_lag(rx: &Rx, paths: &Paths) -> Option<(String, String)> {
    let cache = newest_cache_version(rx, &paths.cache_root)?;
    let json = version_from_installed_json(rx, &paths.installed_json)?;
    (compare(rx, &cache, &json) != 0).then_some((json, cache))
}

// ---- changelog --------------------------------------------------------------------------------------------------------------

/// The `## <version>` sections newer than `from` (exclusive) up to `to` (inclusive), in file order.
fn extract_changelog(rx: &Rx, text: &str, from: Option<&str>, to: Option<&str>) -> String {
    if text.is_empty() {
        return String::new();
    }
    let pieces: Vec<&str> = text.split('\n').collect();
    let mut sections: Vec<(String, Vec<&str>)> = Vec::new();
    for (i, raw) in pieces.iter().enumerate() {
        let line = if i + 1 < pieces.len() { raw.strip_suffix('\r').unwrap_or(raw) } else { raw };
        if let Some(m) = rx.heading.captures(line) {
            sections.push((m[1].to_string(), vec![line]));
        } else if let Some(cur) = sections.last_mut() {
            cur.1.push(line);
        }
    }
    let kept: Vec<String> = sections
        .iter()
        .filter(|(v, _)| from.is_none_or(|f| f.is_empty() || compare(rx, v, f) > 0) && to.is_none_or(|t| t.is_empty() || compare(rx, v, t) <= 0))
        .map(|(_, body)| js_trim_end(&body.join("\n")).to_string())
        .collect();
    js_trim(&kept.join("\n\n")).to_string()
}

// ---- cache sync -------------------------------------------------------------------------------------------------------------

fn copy_dir(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let (from, to) = (entry.path(), dst.join(entry.file_name()));
        let ty = entry.file_type()?;
        if ty.is_dir() {
            copy_dir(&from, &to)?;
        } else if ty.is_symlink() {
            let target = std::fs::read_link(&from)?;
            let abs = if target.is_absolute() { target } else { src.join(target) };
            std::os::unix::fs::symlink(PathBuf::from(resolve_abs(&abs.to_string_lossy())), &to)?;
        } else if ty.is_file() {
            std::fs::copy(&from, &to)?;
        }
    }
    std::fs::set_permissions(dst, std::fs::metadata(src)?.permissions())
}

/// Copy the plugin into `cache/<version>/` only when the cache root exists and that directory does not; never beside or over
/// another. Returns whether it copied, and why.
fn sync_cache(paths: &Paths, version: Option<&str>) -> (bool, String) {
    let Some(v) = version.filter(|v| !v.is_empty()) else { return (false, t("update_msg.cache_no_target").into()) };
    if v != basename(v) || v.contains('/') || v.contains('\\') || v.contains("..") {
        return (false, t("update_msg.cache_unsafe").into());
    }
    if !std::fs::metadata(&paths.cache_root).is_ok_and(|m| m.is_dir()) {
        return (false, t("update_msg.cache_no_root").into());
    }
    let target = join(&paths.cache_root, v);
    if std::fs::metadata(&target).is_ok() {
        return (false, defaults::render("update_msg.cache_has", &[("version", &v)]));
    }
    if !std::fs::metadata(&paths.plugin_src).is_ok_and(|m| m.is_dir()) {
        return (false, t("update_msg.cache_no_src").into());
    }
    match copy_dir(Path::new(&paths.plugin_src), Path::new(&target)) {
        Ok(()) => (true, defaults::render("update_msg.cache_copied", &[("version", &v)])),
        Err(e) => (false, defaults::render("update_msg.cache_failed", &[("error", &e)])),
    }
}

// ---- child processes --------------------------------------------------------------------------------------------------------

/// What a child process gave: its stdout, or the reason text Node's `execFileSync` error would give.
pub(super) struct Ran {
    pub(super) status: Option<i32>,
    pub(super) stdout: String,
    /// `gitErr` of the failure: the first line of stderr, else of the error message.
    reason: String,
    spawn_not_found: bool,
}

fn first_line(msg: &str, fallback: &str) -> String {
    let m = js_trim(msg);
    let l = m.split('\n').next().unwrap_or("");
    if l.is_empty() { fallback.to_string() } else { l.to_string() }
}

pub(super) fn run_child(prog: &str, args: &[String], cwd: Option<&Path>, envs: &[(String, String)], timeout: Duration) -> Ran {
    let mut cmd = Command::new(prog);
    cmd.args(args);
    if let Some(c) = cwd {
        cmd.current_dir(c);
    }
    for (k, v) in envs {
        cmd.env(k, v);
    }
    let poll = Duration::from_millis(defaults::num("update.poll_ms"));
    let cmdline = format!("{prog} {}", args.join(" "));
    let fallback = t("update.git_error_fallback");
    let failed = |msg: String, nf: bool, status: Option<i32>, stdout: String| Ran { status, stdout, reason: first_line(&msg, fallback), spawn_not_found: nf };
    match proc::run(cmd, prog, timeout, poll) {
        Ok(o) if o.status.success() => {
            Ran { status: Some(0), stdout: String::from_utf8_lossy(&o.stdout).into_owned(), reason: String::new(), spawn_not_found: false }
        }
        Ok(o) => {
            let stderr = String::from_utf8_lossy(&o.stderr).into_owned();
            let msg = if stderr.is_empty() { defaults::render("update.git_failed_error", &[("cmd", &cmdline)]) } else { stderr };
            failed(msg, false, o.status.code().or(Some(-1)), String::from_utf8_lossy(&o.stdout).into_owned())
        }
        Err(proc::Error::Spawn(e)) => {
            let nf = e.kind() == std::io::ErrorKind::NotFound;
            let code = if nf { t("update.enoent").to_string() } else { e.to_string() };
            failed(defaults::render("update.git_spawn_error", &[("prog", &prog), ("code", &code)]), nf, None, String::new())
        }
        Err(proc::Error::Timeout) => failed(defaults::render("update.git_timeout_error", &[("prog", &prog)]), false, None, String::new()),
        Err(_) => failed(defaults::render("update.git_failed_error", &[("cmd", &cmdline)]), false, None, String::new()),
    }
}

fn git(args: &[String], dir: &str) -> Result<String, String> {
    let r = run_child(t("update.git_bin"), args, Some(Path::new(dir)), &[], defaults::millis("update.git_timeout_ms"));
    if r.status == Some(0) { Ok(r.stdout) } else { Err(r.reason) }
}

fn words(key: &str) -> Vec<String> {
    defaults::list(key).into_iter().map(str::to_string).collect()
}

// ---- --check ----------------------------------------------------------------------------------------------------------------

fn opt(v: &Option<String>) -> J {
    v.as_ref().map_or(J::Null, |s| J::Str(s.clone()))
}

fn status4(installed: &Option<String>, latest: &Option<String>, updated: bool, synced: bool) -> Vec<(String, J)> {
    vec![("installed".into(), opt(installed)), ("latest".into(), opt(latest)), ("updated".into(), J::Bool(updated)), ("cacheSynced".into(), J::Bool(synced))]
}

fn with_action(mut base: Vec<(String, J)>, action: String) -> J {
    base.push(("action".into(), J::Str(action)));
    J::Obj(base)
}

fn harness_cmd() -> String {
    format!("{} {}", t("update.claude_bin"), defaults::list("update.harness_args").join(" "))
}

fn remote_version(m: &str) -> Result<Option<String>, String> {
    git(&words("update.git_fetch"), m)?;
    let default_ref = t("update.git_default_ref").to_string();
    let r = git(&words("update.git_upstream"), m).ok().map(|s| js_trim(&s).to_string()).filter(|s| !s.is_empty()).unwrap_or(default_ref);
    let mut args = words("update.git_show");
    args.push(format!("{r}:{}", t("update.remote_manifest")));
    let raw = git(&args, m)?;
    let data = json::parse(&raw, defaults::num("update.json_max_depth") as usize).map_err(|_| t("update_msg.remote_json_bad").to_string())?;
    Ok(str_of(data.get("version")).map(str::to_string))
}

fn run_check(rx: &Rx, paths: &Paths) -> J {
    let installed = resolve_installed(rx, paths);
    let latest = match remote_version(&paths.marketplace) {
        Ok(l) => l,
        Err(reason) => {
            return with_action(status4(&installed, &None, false, false), defaults::render("update_msg.check_failed", &[("reason", &reason)]));
        }
    };
    if !semver_opt(rx, installed.as_deref()) {
        return with_action(status4(&None, &latest, false, false), t("update_msg.unknown_installed").into());
    }
    let inst = installed.clone().unwrap_or_default();
    let cmp = compare(rx, &inst, latest.as_deref().filter(|v| !v.is_empty()).unwrap_or(t("update.zero_version")));
    let lag = installed_version_lag(rx, paths).map(|(json, cache)| {
        let cmd = harness_cmd();
        let key = if compare(rx, &json, &cache) < 0 { "update_msg.lag_behind" } else { "update_msg.lag_ahead" };
        defaults::render(key, &[("json", &json), ("cache", &cache), ("cmd", &cmd)])
    });
    let head = if cmp < 0 {
        let shown = latest.clone().unwrap_or_else(|| t("update.null_word").to_string());
        defaults::render("update_msg.available", &[("installed", &inst), ("latest", &shown)])
    } else {
        t("update_msg.up_to_date").to_string()
    };
    with_action(status4(&installed, &latest, false, false), format!("{head}{}", lag.unwrap_or_default()))
}

// ---- harness registration ---------------------------------------------------------------------------------------------------

fn harness_obj(attempted: bool, ok: bool, detail: String) -> J {
    obj(vec![("attempted", J::Bool(attempted)), ("ok", J::Bool(ok)), ("detail", J::Str(detail))])
}

/// `claude plugin update`, only when the registry's own version is older than `latest`. Never interactive: a confirmation
/// request or any failure is reported with the command for a person to run.
fn harness_register(rx: &Rx, env: &Env, installed: Option<&str>, latest: Option<&str>) -> J {
    let cmd = harness_cmd();
    let (Some(i), Some(l)) = (installed.filter(|v| is_semver(rx, v)), latest.filter(|v| is_semver(rx, v))) else {
        return harness_obj(false, false, t("update_msg.harness_noop").into());
    };
    if compare(rx, i, l) >= 0 {
        return harness_obj(false, false, t("update_msg.harness_noop").into());
    }
    let args = words("update.harness_args");
    let timeout = defaults::millis("update.harness_timeout_ms");
    let mut r = run_child(t("update.claude_bin"), &args, None, &[], timeout);
    if r.spawn_not_found
        && let Some(alt) = env.get(defaults::text("env.claude_execpath")).filter(|a| !a.is_empty())
    {
        r = run_child(alt, &args, None, &[], timeout);
    }
    if r.status == Some(0) {
        if rx.confirm.is_match(&r.stdout) {
            let shown = slice16_lossy(js_trim(&r.stdout), defaults::num("update.confirm_shown") as usize);
            return harness_obj(true, false, defaults::render("update_msg.harness_confirm", &[("cmd", &cmd), ("text", &shown)]));
        }
        return harness_obj(true, true, defaults::render("update_msg.harness_done", &[("latest", &l)]));
    }
    let reason = if r.reason.is_empty() { t("update_msg.unknown_error").to_string() } else { r.reason };
    harness_obj(true, false, defaults::render("update_msg.harness_failed", &[("cmd", &cmd), ("reason", &reason)]))
}

fn harness_action(h: Option<&J>, updated: bool, latest: &str) -> String {
    let flag = |k: &str| h.and_then(|h| h.get(k)).is_some_and(|v| matches!(v, J::Bool(true)));
    if flag("ok") {
        return defaults::render("update_msg.harness_ok", &[("latest", &latest)]);
    }
    if flag("attempted") {
        return defaults::render("update_msg.harness_manual", &[("cmd", &harness_cmd())]);
    }
    if updated { t("update_msg.reload").into() } else { t("update_msg.up_to_date").into() }
}

// ---- the update -------------------------------------------------------------------------------------------------------------

/// The engine's own part of a run, before the Node stages are merged in.
struct Core {
    installed: Option<String>,
    latest: Option<String>,
    updated: bool,
    synced: bool,
    harness: Option<J>,
    action: String,
    changelog: String,
    stop: bool,
    /// An early return (offline, dirty, pull failure): no stages run and nothing is merged.
    early: bool,
}

fn early(installed: &Option<String>, action: String, stop: bool) -> Core {
    Core {
        installed: installed.clone(),
        latest: installed.clone(),
        updated: false,
        synced: false,
        harness: None,
        action,
        changelog: String::new(),
        stop,
        early: true,
    }
}

fn stage_quiet(env: &Env, home: &str) -> bool {
    let from_env = env.get(defaults::text("env.update_quiet")).and_then(|v| bool_token(js_trim(v)));
    if let Some(b) = from_env {
        return b;
    }
    let file = join(home, t("update.settings_file"));
    match read_json(&file).as_ref().and_then(|s| s.get("updates")).and_then(|u| u.get("quiet")) {
        Some(J::Bool(b)) => *b,
        Some(J::Str(s)) => bool_token(js_trim(s)).unwrap_or(false),
        _ => false,
    }
}

fn progress(line: &str) {
    use std::io::Write;
    if std::io::stderr().lock().write_all(line.as_bytes()).is_err() {
        // stderr is closed: progress is best-effort
    }
}

fn run_core(rx: &Rx, env: &Env, home: &str, paths: &Paths, skip_pull: bool) -> Core {
    let installed = resolve_installed(rx, paths);
    if !skip_pull {
        let m = &paths.marketplace;
        match git(&words("update.git_status"), m) {
            Err(reason) => return early(&installed, defaults::render("update_msg.no_git", &[("reason", &reason)]), false),
            Ok(o) if !js_trim(&o).is_empty() => return early(&installed, defaults::render("update_msg.stop_dirty", &[("dir", m)]), true),
            Ok(_) => {}
        }
        if let Err(reason) = git(&words("update.git_pull"), m) {
            let offline = rx.offline.is_match(&reason);
            let key = if offline { "update_msg.pull_offline" } else { "update_msg.pull_stop" };
            return early(&installed, defaults::render(key, &[("reason", &reason), ("dir", m)]), !offline);
        }
    }
    let latest = version_from_marketplace(rx, &paths.plugin_json).or_else(|| installed.clone().filter(|v| is_semver(rx, v)));
    let (synced, _) = sync_cache(paths, latest.as_deref());
    if !semver_opt(rx, installed.as_deref()) {
        return Core {
            installed: None,
            latest,
            updated: false,
            synced,
            harness: None,
            action: t("update_msg.unknown_installed").into(),
            changelog: String::new(),
            stop: false,
            early: false,
        };
    }
    let inst = installed.clone().unwrap_or_default();
    let updated = latest.as_deref().is_some_and(|l| compare(rx, &inst, l) < 0);
    let reg_version = version_from_installed_json(rx, &paths.installed_json);
    let quiet = stage_quiet(env, home);
    let name = t("update_msg.stage_harness");
    if !quiet {
        progress(&defaults::render("update_msg.stage_start", &[("name", &name)]));
    }
    let t0 = Instant::now();
    let harness = harness_register(rx, env, reg_version.as_deref(), latest.as_deref());
    if !quiet {
        progress(&defaults::render("update_msg.stage_done", &[("name", &name), ("ms", &t0.elapsed().as_millis())]));
    }
    let changelog = match std::fs::metadata(&paths.changelog) {
        Ok(md) if md.len() <= defaults::num("update.max_bytes") => std::fs::read(&paths.changelog)
            .map(|b| extract_changelog(rx, &String::from_utf8_lossy(&b), installed.as_deref(), latest.as_deref()))
            .unwrap_or_default(),
        _ => String::new(),
    };
    let action = harness_action(Some(&harness), updated, latest.as_deref().unwrap_or(t("update.null_word")));
    Core { installed, latest, updated, synced, harness: Some(harness), action, changelog, stop: false, early: false }
}

// ---- the Node stages --------------------------------------------------------------------------------------------------------

/// The overall post-pull budget, as the Node script reads it: a number from the environment (empty reads as 0), else the default.
fn postpull_budget_ms(env: &Env) -> u64 {
    match env.get(defaults::text("env.update_postpull_budget")) {
        Some(raw) => {
            let n = js_number_of_str(raw);
            if n.is_finite() && n >= 0.0 { n as u64 } else { defaults::num("update.default_postpull_budget_ms") }
        }
        None => defaults::num("update.default_postpull_budget_ms"),
    }
}

enum Stages {
    /// The stage script is not there: nothing to merge, nothing to say.
    Absent,
    /// The parsed `status` object of the stage run.
    Got(J),
    /// The run failed or printed nothing usable; the text for the action.
    Failed { unusable: bool, error: Option<String> },
}

fn node_stages(env: &Env, paths: &Paths) -> Stages {
    let script = join(&paths.plugin_src, t("update.node_script_rel"));
    if !Path::new(&script).is_file() {
        return Stages::Absent;
    }
    let node = env.get(defaults::text("env.node")).filter(|n| !n.is_empty()).unwrap_or_else(|| t("doctor.node_default"));
    let timeout = Duration::from_millis(postpull_budget_ms(env) + defaults::num("update.harness_timeout_ms") + defaults::num("update.reexec_margin_ms"));
    let envs = vec![
        (defaults::text("env.update_reexec").to_string(), t("update.reexec_value").to_string()),
        (defaults::text("env.update_marketplace_dir").to_string(), paths.marketplace.clone()),
    ];
    let cwd = std::env::current_dir().ok();
    let args = vec![script, t("update.post_pull_flag").to_string()];
    let r = run_child(node, &args, cwd.as_deref(), &envs, timeout);
    if r.status != Some(0) || r.stdout.is_empty() {
        return Stages::Failed { unusable: false, error: None };
    }
    let first = r.stdout.split('\n').find(|l| !l.is_empty()).unwrap_or(t("update.null_word"));
    match json::parse(first, defaults::num("update.json_max_depth") as usize) {
        Ok(p) => match p.get("status") {
            Some(s @ J::Obj(_)) => Stages::Got(s.clone()),
            _ => Stages::Failed { unusable: true, error: None },
        },
        Err(e) => Stages::Failed { unusable: false, error: Some(format!("{e:?}")) },
    }
}

fn flag_true(h: Option<&J>, k: &str) -> bool {
    h.and_then(|h| h.get(k)).is_some_and(|v| matches!(v, J::Bool(true)))
}

/// Merge the Node stage keys into the status the way the Node re-exec does.
fn assemble(rx: &Rx, env: &Env, paths: &Paths, core: &Core) -> J {
    let base = status4(&core.installed, &core.latest, core.updated, core.synced);
    if core.early {
        return with_action(base, core.action.clone());
    }
    let eligible = semver_opt(rx, core.latest.as_deref())
        && semver_opt(rx, core.installed.as_deref())
        && core.installed != core.latest
        && env.get(defaults::text("env.update_reexec")) != Some(t("update.reexec_value"));
    let mut action = core.action.clone();
    let mut harness = core.harness.clone();
    let mut stage_keys: Vec<(String, J)> = Vec::new();
    match node_stages(env, paths) {
        Stages::Absent => {}
        Stages::Failed { unusable, error } => {
            let (inst, lat) = (core.installed.clone().unwrap_or_default(), core.latest.clone().unwrap_or_default());
            let note = if !eligible {
                let reason = t(if unusable { "update_msg.reason_unusable" } else { "update_msg.reason_failed" });
                defaults::render("update_msg.stages_unavailable", &[("reason", &reason)])
            } else if let Some(e) = error {
                defaults::render("update_msg.reexec_raised", &[("error", &e)])
            } else if unusable {
                defaults::render("update_msg.reexec_unusable", &[("latest", &lat), ("installed", &inst)])
            } else {
                defaults::render("update_msg.reexec_failed", &[("latest", &lat), ("installed", &inst)])
            };
            action.push_str(&note);
        }
        Stages::Got(child) => {
            let kept = defaults::list("update.kept_local");
            let J::Obj(entries) = &child else { return with_action(base, action) };
            for (k, v) in entries {
                if !kept.contains(&k.as_str()) && k != "harnessRegistered" {
                    stage_keys.push((k.clone(), v.clone()));
                }
            }
            if eligible {
                let theirs = child.get("harnessRegistered");
                // a registration that ran here stays on record, with its action, over the other run's "nothing to do"
                if !(flag_true(core.harness.as_ref(), "attempted") && !flag_true(theirs, "attempted")) {
                    if let Some(t) = theirs {
                        harness = Some(t.clone());
                    }
                    if flag_true(theirs, "attempted")
                        && let Some(J::Str(a)) = child.get("action")
                    {
                        action = a.clone();
                    }
                }
            }
        }
    }
    let mut all = base;
    all.extend(stage_keys);
    if let Some(h) = harness {
        all.push(("harnessRegistered".into(), h));
    }
    with_action(all, action)
}

// ---- the human summary ------------------------------------------------------------------------------------------------------

fn truthy(v: Option<&J>) -> bool {
    match v {
        None | Some(J::Null) => false,
        Some(J::Bool(b)) => *b,
        Some(J::Num(n)) => *n != 0.0 && !n.is_nan(),
        Some(J::Str(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// `String(v)` of a member, `undefined` when it is missing.
fn js_member(v: &J, k: &str) -> String {
    v.get(k).map_or_else(|| t("update.undefined_word").to_string(), js_string)
}

fn num_or0(v: Option<&J>) -> String {
    if truthy(v) { v.map_or_else(|| t("update.zero_word").into(), js_string) } else { t("update.zero_word").into() }
}

fn bit_n(key: &str, n: &str) -> String {
    defaults::render(key, &[("n", &n)])
}

fn reconcile_lines(st: &J, lines: &mut Vec<String>) {
    let Some(J::Arr(results)) = st.get("results") else { return };
    for r in results {
        let mut bits = vec![bit_n("update_human.bit_imported", &num_or0(r.get("imported"))), bit_n("update_human.bit_duplicate", &num_or0(r.get("duplicate")))];
        if truthy(r.get("locked")) {
            bits.push(t("update_human.bit_locked").into());
        }
        if truthy(r.get("lost")) {
            bits.push(bit_n("update_human.bit_lost", &js_member(r, "lost")));
        }
        if truthy(r.get("skipped")) {
            let why = if truthy(r.get("skipReason")) { js_member(r, "skipReason") } else { t("update_human.bit_archived").into() };
            bits.push(defaults::render("update_human.bit_skipped", &[("reason", &why)]));
        } else if truthy(r.get("error")) {
            bits.push(defaults::render("update_human.bit_error", &[("error", &js_member(r, "error"))]));
        }
        lines.push(defaults::render("update_human.reconcile_item", &[("id", &js_member(r, "id")), ("bits", &bits.join(t("update_human.bit_sep")))]));
    }
}

fn heal_lines(st: &J, lines: &mut Vec<String>) {
    let Some(J::Arr(stores)) = st.get("stores") else { return };
    for s in stores {
        let rows = match s.get("rows") {
            Some(J::Arr(a)) => a.iter().map(js_string).collect::<Vec<_>>().join(t("update_human.bit_sep")),
            _ => t("update.undefined_word").to_string(),
        };
        lines.push(defaults::render("update_human.store_item", &[("repoKey", &js_member(s, "repoKey")), ("rows", &rows)]));
    }
}

fn render_human(rx: &Rx, status: &J, changelog: &str) -> String {
    let action = status.get("action").map(js_string).unwrap_or_default();
    let failed = rx.failed.is_match(&action);
    let updated = matches!(status.get("updated"), Some(J::Bool(true)));
    let shown = |k: &str, none: &str| {
        let v = status.get(k);
        if truthy(v) { v.map_or_else(String::new, js_string) } else { none.to_string() }
    };
    let latest_head = shown("latest", t("update_human.latest_none"));
    let (icon, state) = if failed {
        (t("update_human.icon_failed"), t("update_human.state_failed").to_string())
    } else if updated {
        (t("update_human.icon_updated"), defaults::render("update_human.state_updated", &[("latest", &latest_head)]))
    } else {
        (t("update_human.icon_ok"), t("update_human.state_ok").to_string())
    };
    let mut lines: Vec<String> = vec![defaults::render("update_human.head", &[("icon", &icon), ("state", &state)])];
    lines.push(defaults::render("update_human.installed", &[("value", &shown("installed", t("update_human.unknown")))]));
    lines.push(defaults::render("update_human.latest", &[("value", &shown("latest", t("update_human.unknown")))]));
    let synced = if truthy(status.get("cacheSynced")) { t("update_human.cache_synced") } else { "" };
    lines.push(defaults::render("update_human.updated", &[("value", &updated), ("synced", &synced)]));
    lines.push(defaults::render("update_human.action", &[("value", &action)]));
    for row in defaults::raw("update_human.stage_lines").as_array().unwrap_or(&[]) {
        let Some(st) = status.get(row.str_field("key")).filter(|s| truthy(Some(s)) && truthy(s.get("attempted"))) else { continue };
        lines.push(format!("{}{}", row.str_field("prefix"), js_member(st, "detail")));
        match row.str_field("more") {
            "reconcile" => reconcile_lines(st, &mut lines),
            "heal" => heal_lines(st, &mut lines),
            _ => {}
        }
    }
    if !changelog.is_empty() {
        lines.push(String::new());
        lines.push(t("update_human.changelog_head").into());
        lines.push(changelog.to_string());
    }
    lines.join("\n")
}

// ---- the command ------------------------------------------------------------------------------------------------------------

/// `update [--check] [--post-pull-only]`.
pub fn run(p: &Parsed) -> i32 {
    match go(p) {
        Ok(code) => code,
        Err(e) => {
            warn(&e);
            74
        }
    }
}

fn go(p: &Parsed) -> Result<i32, String> {
    let rx = Rx::new()?;
    let env = Env::process();
    let Some(home) = crate::setup::home_dir(&env) else { return Err(t("update_msg.no_home").into()) };
    let home = home.to_string_lossy().into_owned();
    let is_check = p.rest.iter().any(|a| a == t("update.check_flag"));
    let post_pull_only = p.rest.iter().any(|a| a == t("update.post_pull_flag"));
    let paths = resolve_paths(&env, &home);
    if !paths.override_ignored.is_empty() && !post_pull_only {
        out(&format!("{}\n", paths.override_ignored))?;
    }
    let shadow_script = join(&paths.plugin_src, t("update.node_script_rel"));
    let node_env = |a: &str| vec![a.to_string()];
    if is_check {
        let status = run_check(&rx, &paths);
        let line = stringify(&status);
        out(&format!("{line}\n{}\n", render_human(&rx, &status, "")))?;
        // the Node check runs after the engine's, so the two fetches never race
        if let Some(node) = super::shadow_line(&env, &shadow_script, &node_env(t("update.check_flag")), None).and_then(|o| o.lines().next().map(str::to_string))
            && node != line
        {
            crate::discard::note("update_check_shadow_mismatch", &defaults::render("operator.shadow_check_log", &[("node", &node), ("engine", &line)]));
        }
        return Ok(0);
    }
    let core = run_core(&rx, &env, &home, &paths, post_pull_only);
    let status = assemble(&rx, &env, &paths, &core);
    if post_pull_only {
        out(&format!("{}\n", stringify(&obj(vec![("status", status)]))))?;
        return Ok(0);
    }
    out(&format!("{}\n{}\n", stringify(&status), render_human(&rx, &status, &core.changelog)))?;
    // After the update, so the Node check's fetch cannot change what the pull reports. It must agree on the latest version.
    if !post_pull_only
        && !core.early
        && let Some(n) = super::shadow_line(&env, &shadow_script, &node_env(t("update.check_flag")), None)
            .and_then(|o| o.lines().next().and_then(|l| json::parse(l, defaults::num("update.json_max_depth") as usize).ok()))
    {
        let shown = |v: Option<&J>| v.map_or_else(|| t("update.null_word").to_string(), js_string);
        let (nl, el) = (shown(n.get("latest")), shown(status.get("latest")));
        if nl != el {
            crate::discard::note("update_shadow_mismatch", &defaults::render("operator.shadow_update_log", &[("nl", &nl), ("el", &el)]));
        }
    }
    Ok(i32::from(core.stop))
}
