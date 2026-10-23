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
//! The post-pull stages (ingest-daemon heal, reconcile, folds, migrations, ...) are [`super::postpull`]'s: the engine answers the
//! cases that need no work itself and runs the script's own stage function for the rest.
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
    available: Regex,
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
            available: rx("update.available_re")?,
            offline: Regex::new(&offline).map_err(|e| format!("update.offline_patterns: {e}"))?,
            v_strip: rx("update.v_strip_re")?,
        })
    }
}

/// Where everything lives.
pub(super) struct Paths {
    marketplace: String,
    override_ignored: String,
    cache_root: String,
    installed_json: String,
    settings_json: String,
    plugin_json: String,
    changelog: String,
    pub(super) plugin_src: String,
}

fn resolve_paths(env: &Env, home: &str) -> Paths {
    let (marketplace, override_ignored) = marketplace_dir(env.get(defaults::text("env.update_marketplace_dir")).filter(|o| !o.is_empty()), home);
    let plugins_root = resolve_abs(&format!("{marketplace}/../.."));
    let plugin_src = join(&marketplace, t("update.plugin_src_rel"));
    Paths {
        override_ignored,
        cache_root: join(&plugins_root, t("update.cache_rel")),
        installed_json: join(&plugins_root, t("update.installed_json")),
        settings_json: resolve_abs(&join(&plugins_root, t("update.settings_rel"))),
        plugin_json: join(&plugin_src, t("update.plugin_json_rel")),
        changelog: join(&marketplace, t("update.changelog_file")),
        plugin_src,
        marketplace,
    }
}

/// The marketplace clone `update` pulls from and installs out of (the one source an "update available" notice may compare with),
/// and the note for an override that was ignored. `over` is the value of the override variable.
pub(crate) fn marketplace_dir(over: Option<&str>, home: &str) -> (String, String) {
    let mut marketplace = join(home, t("update.marketplace_rel"));
    let mut override_ignored = String::new();
    if let Some(o) = over {
        if is_absolute(o) && std::fs::metadata(o).is_ok_and(|m| m.is_dir()) {
            marketplace = o.to_string();
        } else {
            override_ignored = defaults::render("update_msg.override_ignored", &[("path", &o)]);
        }
    }
    (marketplace, override_ignored)
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
    let parts: Vec<f64> = m.get(1).map_or("", |x| x.as_str()).split('.').map(|n| n.parse::<f64>().unwrap_or(f64::NAN)).collect();
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

/// The version the registry records for the ENABLED anti-hall install (the pin only when none is enabled; #216).
fn version_from_installed_json(rx: &Rx, path: &str, settings_path: &str, only: Option<&str>) -> Option<String> {
    let data = read_json(path)?;
    if !matches!(data, J::Obj(_) | J::Arr(_)) {
        return None;
    }
    let reg = match data.get("plugins") {
        Some(p @ (J::Obj(_) | J::Arr(_))) => p,
        _ => &data,
    };
    let settings = read_json(settings_path);
    let keys = match only {
        Some(k) => vec![k.to_string()],
        None => crate::install::select_keys(reg, settings.as_ref()).0,
    };
    keys.iter().find_map(|key| match reg.get(key)? {
        J::Arr(entries) => {
            let valid: Vec<&J> = entries.iter().filter(|e| matches!(e, J::Obj(_)) && semver_opt(rx, str_of(e.get("version")))).collect();
            let scoped = |s: &str| valid.iter().find(|e| str_of(e.get("scope")) == Some(s));
            let pick = scoped("user").or_else(|| scoped("project")).or_else(|| valid.first())?;
            str_of(pick.get("version")).map(str::to_string)
        }
        J::Str(s) => is_semver(rx, s).then(|| s.clone()),
        e @ J::Obj(_) => str_of(e.get("version")).filter(|v| is_semver(rx, v)).map(str::to_string),
        _ => None,
    })
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
fn resolve_installed(rx: &Rx, paths: &Paths, chan: Option<&Chan>) -> Option<String> {
    let cache = newest_cache_version(rx, chan.map_or(&paths.cache_root, |c| &c.cache_root));
    let json = version_from_installed_json(rx, &paths.installed_json, &paths.settings_json, chan.map(|c| c.key.as_str()));
    if let (Some(c), Some(j)) = (&cache, &json) {
        return Some(if compare(rx, c, j) >= 0 { c.clone() } else { j.clone() });
    }
    cache.or(json).or_else(|| version_from_marketplace(rx, &paths.plugin_json))
}

/// The compiled patterns for the active defaults (`None` when they do not compile).
fn cached_rx() -> Option<std::sync::Arc<Rx>> {
    static RX: defaults::Cache<Option<std::sync::Arc<Rx>>> = defaults::Cache::new();
    (*RX.get_or_init(|| Rx::new().ok().map(std::sync::Arc::new))).clone()
}

/// `isSemver(v)` of `update.js`.
pub(crate) fn semver_ok(v: &str) -> bool {
    cached_rx().is_some_and(|rx| is_semver(&rx, v))
}

/// `compareVersions(a, b)` of `update.js`: -1, 0 or 1.
pub(crate) fn compare_versions(a: &str, b: &str) -> i32 {
    cached_rx().map_or(0, |rx| compare(&rx, a, b))
}

/// The registry and the cache both read, and disagree.
fn installed_version_lag(rx: &Rx, paths: &Paths, chan: &Chan) -> Option<(String, String)> {
    let cache = newest_cache_version(rx, &chan.cache_root)?;
    let json = version_from_installed_json(rx, &paths.installed_json, &paths.settings_json, Some(&chan.key))?;
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
            sections.push((m.get(1).map_or(String::new(), |x| x.as_str().to_string()), vec![line]));
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
    pub(super) reason: String,
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

/// `claude plugin update <key>` for one install.
fn harness_cmd_for(key: &str) -> String {
    format!("{} {} {key}", t("update.claude_bin"), defaults::list("update.harness_check_args").join(" "))
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

/// The install a `--check` is about: the ENABLED one, with its own cache, marketplace and update command.
struct Chan {
    key: String,
    name: String,
    cache_root: String,
    marketplace: String,
    /// A `directory` marketplace has no remote: its own source tree is the latest.
    local: bool,
}

/// The enabled install (when several are enabled, the one whose `installPath` holds the running plugin root) and the paths
/// that belong to it. A scratch registry without the entries falls back to the public install's own paths.
fn resolve_chan(paths: &Paths, env: &Env) -> Chan {
    let data = read_json(&paths.installed_json);
    let reg = data.as_ref().map(|d| match d.get("plugins") {
        Some(p @ (J::Obj(_) | J::Arr(_))) => p.clone(),
        _ => d.clone(),
    });
    let settings = read_json(&paths.settings_json);
    let (keys, _) = reg.as_ref().map_or_else(|| (vec![t("wake_watch.install_fallback_key").to_string()], false), |r| crate::install::select_keys(r, settings.as_ref()));
    let install_path = |k: &str| reg.as_ref().and_then(|r| match r.get(k) {
        Some(J::Arr(e)) => e.iter().find_map(|x| str_of(x.get("installPath")).map(str::to_string)),
        _ => None,
    });
    let root = env.get_nonempty(t("update.plugin_root_env")).unwrap_or_default();
    let key = keys.iter().find(|k| !root.is_empty() && install_path(k).is_some_and(|p| root.starts_with(&p))).or_else(|| keys.first()).cloned().unwrap_or_default();
    let (plugin, name) = key.split_once('@').map_or((key.as_str(), ""), |(p, n)| (p, n));
    let plugins_root = Path::new(&paths.installed_json).parent().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    let fallback = key == t("wake_watch.install_fallback_key");
    let cache_root = match install_path(&key).and_then(|p| Path::new(&p).parent().map(|d| d.to_string_lossy().into_owned())) {
        Some(c) => c,
        None if fallback => paths.cache_root.clone(),
        None => join(&join(&join(&plugins_root, t("update.cache_dir")), name), plugin),
    };
    let known = read_json(&join(&plugins_root, t("update.known_marketplaces"))).and_then(|k| k.get(name).cloned());
    let marketplace = match known.as_ref().and_then(|k| str_of(k.get("installLocation"))) {
        Some(l) => l.to_string(),
        None if fallback => paths.marketplace.clone(),
        None => join(&join(&plugins_root, t("update.marketplaces_dir")), name),
    };
    let local = known.as_ref().and_then(|k| k.get("source")).and_then(|s| str_of(s.get("source"))) == Some(t("update.directory_source"));
    Chan { key: key.clone(), name: name.to_string(), cache_root, marketplace, local }
}

fn run_check(rx: &Rx, paths: &Paths, env: &Env) -> J {
    let chan = resolve_chan(paths, env);
    let installed = resolve_installed(rx, paths, Some(&chan));
    let with_chan = |status: J, state: &str| {
        let J::Obj(mut m) = status else { return status };
        m.push(("channel".into(), J::Str(chan.name.clone())));
        m.push(("key".into(), J::Str(chan.key.clone())));
        m.push(("state".into(), J::Str(state.to_string())));
        J::Obj(m)
    };
    let latest = if chan.local {
        let src = join(&join(&chan.marketplace, t("update.plugin_src_rel")), t("update.plugin_json_rel"));
        Ok(version_from_marketplace(rx, &src))
    } else {
        remote_version(&chan.marketplace)
    };
    let latest = match latest {
        Ok(l) => l,
        Err(reason) => {
            return with_chan(with_action(status4(&installed, &None, false, false), defaults::render("update_msg.check_failed", &[("reason", &reason)])), t("update.state_failed"));
        }
    };
    if !semver_opt(rx, installed.as_deref()) {
        return with_chan(with_action(status4(&None, &latest, false, false), t("update_msg.unknown_installed").into()), t("update.state_unknown"));
    }
    let inst = installed.clone().unwrap_or_default();
    let lag = installed_version_lag(rx, paths, &chan).map(|(json, cache)| {
        let cmd = harness_cmd_for(&chan.key);
        let key = if compare(rx, &json, &cache) < 0 { "update_msg.lag_behind" } else { "update_msg.lag_ahead" };
        defaults::render(key, &[("json", &json), ("cache", &cache), ("cmd", &cmd)])
    });
    let (head, state) = match latest.as_deref().filter(|v| !v.is_empty()) {
        None => (defaults::render("update_msg.latest_unknown", &[("channel", &chan.name)]), t("update.state_unknown")),
        Some(l) if compare(rx, &inst, l) < 0 => (defaults::render("update_msg.available", &[("installed", &inst), ("latest", &l)]), t("update.state_available")),
        // a lagging registry is never reported as "up to date"
        Some(_) if lag.is_some() => (t("update_msg.lag_head").to_string(), t("update.state_lagging")),
        Some(_) => (t("update_msg.up_to_date").to_string(), t("update.state_current")),
    };
    with_chan(with_action(status4(&installed, &latest, false, false), format!("{head}{}", lag.unwrap_or_default())), state)
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
    /// The post-pull stages' answers, in the status order.
    stages: Vec<(String, J)>,
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
        stages: Vec::new(),
    }
}

pub(super) fn stage_quiet(env: &Env, home: &str) -> bool {
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

pub(super) fn progress(line: &str) {
    use std::io::Write;
    if std::io::stderr().lock().write_all(line.as_bytes()).is_err() {
        // stderr is closed: progress is best-effort
    }
}

fn run_core(rx: &Rx, env: &Env, home: &str, paths: &Paths, skip_pull: bool) -> Core {
    let installed = resolve_installed(rx, paths, None);
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
    let stages = super::postpull::run(&super::postpull::Run { env, home, paths, latest: latest.as_deref(), synced, budget_ms: postpull_budget_ms(env), outcome: Default::default() });
    units_heal(env, home);
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
            stages,
        };
    }
    let inst = installed.clone().unwrap_or_default();
    let updated = latest.as_deref().is_some_and(|l| compare(rx, &inst, l) < 0);
    let reg_version = version_from_installed_json(rx, &paths.installed_json, &paths.settings_json, None);
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
    Core { installed, latest, updated, synced, harness: Some(harness), action, changelog, stop: false, stages }
}

/// The engine's own post-pull stage: heal the background-service units (write the engine unit, move the Node units whose duty
/// the engine runs aside, never delete). It is not one of the script's stages, so it is not in the status object; its rows are
/// in the units ledger and the engine log, and a failure never fails the update.
fn units_heal(env: &Env, home: &str) {
    if !crate::setup::units::heal_enabled() {
        return;
    }
    let quiet = stage_quiet(env, home);
    let name = t("units.stage_name");
    if !quiet {
        progress(&defaults::render("update_msg.stage_start", &[("name", &name)]));
    }
    let t0 = Instant::now();
    drop(crate::setup::units::heal_changes(false)); // the ledger and the log have every action; the update goes on either way
    if !quiet {
        progress(&defaults::render("update_msg.stage_done", &[("name", &name), ("ms", &t0.elapsed().as_millis())]));
    }
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

/// The status object: the engine's own keys, the stages' answers, then the registration and the action.
fn assemble(core: &Core) -> J {
    let mut all = status4(&core.installed, &core.latest, core.updated, core.synced);
    all.extend(core.stages.iter().cloned());
    if let Some(h) = &core.harness {
        all.push(("harnessRegistered".into(), h.clone()));
    }
    with_action(all, core.action.clone())
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

/// The human text, last line the JSON status: the per-stage detail (the reconcile rows are many) and the changelog first, then the
/// head with the installed/latest/updated/action lines, then the JSON line. A caller that keeps only the tail (`| tail`) still
/// gets the outcome and the action.
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
    } else if rx.available.is_match(&action) {
        (t("update_human.icon_updated"), defaults::render("update_human.state_available", &[("latest", &latest_head)]))
    } else {
        (t("update_human.icon_ok"), t("update_human.state_ok").to_string())
    };
    let mut lines: Vec<String> = Vec::new();
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
        lines.push(String::new());
    }
    lines.push(defaults::render("update_human.head", &[("icon", &icon), ("state", &state)]));
    lines.push(defaults::render("update_human.installed", &[("value", &shown("installed", t("update_human.unknown")))]));
    lines.push(defaults::render("update_human.latest", &[("value", &shown("latest", t("update_human.unknown")))]));
    let synced = if truthy(status.get("cacheSynced")) { t("update_human.cache_synced") } else { "" };
    lines.push(defaults::render("update_human.updated", &[("value", &updated), ("synced", &synced)]));
    lines.push(defaults::render("update_human.action", &[("value", &action)]));
    lines.push(stringify(status));
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
    if is_check {
        let status = run_check(&rx, &paths, &env);
        out(&format!("{}\n", render_human(&rx, &status, "")))?;
        return Ok(0);
    }
    let core = run_core(&rx, &env, &home, &paths, post_pull_only);
    let status = assemble(&core);
    if post_pull_only {
        out(&format!("{}\n", stringify(&obj(vec![("status", status)]))))?;
        return Ok(0);
    }
    out(&format!("{}\n", render_human(&rx, &status, &core.changelog)))?;
    Ok(i32::from(core.stop))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// #216: the registry version is the ENABLED install's, not the `anti-hall@anti-hall` pin's. A scratch home only.
    #[test]
    fn the_registered_version_is_the_enabled_installs() {
        let dir = std::env::temp_dir().join(format!("ah-update-enabled-{}", std::process::id()));
        let plugins = dir.join(".claude/plugins");
        std::fs::create_dir_all(&plugins).unwrap();
        let reg = plugins.join("installed_plugins.json");
        let settings = dir.join(".claude/settings.json");
        std::fs::write(
            &reg,
            r#"{"version":2,"plugins":{"anti-hall@anti-hall":[{"scope":"user","version":"0.300.2"}],"anti-hall@anti-hall-engine-live":[{"scope":"user","version":"0.300.1"}]}}"#,
        )
        .unwrap();
        std::fs::write(&settings, r#"{"enabledPlugins":{"anti-hall@anti-hall":false,"anti-hall@anti-hall-engine-live":true}}"#).unwrap();
        let rx = Rx::new().unwrap();
        let (r, s) = (reg.to_string_lossy().into_owned(), settings.to_string_lossy().into_owned());
        assert_eq!(version_from_installed_json(&rx, &r, &s, None).as_deref(), Some("0.300.1"));
        std::fs::write(&settings, r#"{"enabledPlugins":{}}"#).unwrap();
        assert_eq!(version_from_installed_json(&rx, &r, &s, None).as_deref(), Some("0.300.2"), "none enabled -> the pin");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// SkyCrew 2026-10-22: ~70 reconcile rows printed AFTER the summary and the changelog, so `| tail` lost the outcome and the action.
    /// The tail is the outcome: details, changelog, then the head and action, then the JSON status line last.
    #[test]
    fn the_outcome_and_the_action_print_after_the_stage_rows_and_the_json_is_last() {
        let rx = Rx::new().unwrap();
        let rows: Vec<String> = (0..70).map(|i| format!(r#"{{"id":"ws{i}","imported":0,"duplicate":0}}"#)).collect();
        let raw = format!(
            r#"{{"installed":"0.1.0","latest":"0.2.0","updated":true,"cacheSynced":true,"action":"reload now","reconcile":{{"attempted":true,"detail":"70 workspaces","results":[{}]}}}}"#,
            rows.join(",")
        );
        let status = json::parse(&raw, 64).ok().unwrap();
        let text = render_human(&rx, &status, "## 0.2.0\n- a thing");
        let lines: Vec<&str> = text.lines().collect();
        let at = |needle: &str| lines.iter().position(|l| l.contains(needle)).unwrap_or_else(|| panic!("no line with {needle:?}"));
        assert!(at("ws69") < at("## 0.2.0"), "the reconcile rows come before the changelog");
        assert!(at("## 0.2.0") < at("anti-hall · update"), "the changelog comes before the summary");
        assert!(at("anti-hall · update") < at("reload now"), "the head precedes the action");
        assert_eq!(lines.last().copied(), Some(stringify(&status).as_str()), "the JSON status line is last");
        assert!(lines.len() - 1 - at("reload now") <= 1, "nothing but the JSON line follows the action");
    }
}

