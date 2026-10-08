//! `ah-engine install-codex [--global] [--dry-run] [--root <plugin dir>]`: the Codex port installer, ported from
//! `codex/install-codex.js`.
//!
//! It merges the plugin's generated hook registration (`codex/hooks/hooks.json`, one thin wrapper call per event, with the
//! plugin directory filled in) into `<.codex>/hooks.json`: every group of anti-hall's own is replaced, every other group is
//! kept in place; and it makes sure `<.codex>/config.toml` enables the hooks feature. A file that changes is first copied to
//! `<file>.bak-<time>`; nothing is deleted. `--dry-run` writes nothing. Running it twice changes nothing the second time.
use super::{out, t, warn};
use crate::checks::guardkit::text::js_trim;
use crate::checks::jsport::date::{now_ms, to_iso};
use crate::checks::jsport::json::{self, J};
use crate::cli::Parsed;
use crate::defaults;
use crate::jev::settings::Env;
use crate::setup::jsfmt::pretty;
use regex::Regex;
use std::path::{Path, PathBuf};

fn rx(key: &str) -> Result<Regex, String> {
    Regex::new(defaults::text(key)).map_err(|e| format!("{key}: {e}"))
}

/// A hook group is anti-hall's when one of its hook commands (backslashes read as slashes) names its hooks directory or thin trigger.
fn is_anti_hall_group(re: &Regex, g: &J) -> bool {
    let Some(J::Arr(hooks)) = g.get("hooks") else { return false };
    hooks.iter().any(|h| matches!(h.get("command"), Some(J::Str(c)) if re.is_match(&c.replace('\\', "/"))))
}

fn keys(v: &J) -> Vec<String> {
    match v {
        J::Obj(o) => o.iter().map(|(k, _)| k.clone()).collect(),
        _ => Vec::new(),
    }
}

/// The existing registration with anti-hall's groups replaced by the current ones; every other group kept, in place.
fn merge_hooks(re: &Regex, existing: &J, ours: &J) -> J {
    let old = match existing.get("hooks") {
        Some(h @ J::Obj(_)) => h.clone(),
        _ => J::Obj(Vec::new()),
    };
    let mut events = keys(&old);
    for k in keys(ours) {
        if !events.contains(&k) {
            events.push(k);
        }
    }
    let merged: Vec<(String, J)> = events
        .into_iter()
        .map(|event| {
            let mut groups: Vec<J> = match old.get(&event) {
                Some(J::Arr(a)) => a.iter().filter(|g| !is_anti_hall_group(re, g)).cloned().collect(),
                _ => Vec::new(),
            };
            if let Some(J::Arr(add)) = ours.get(&event) {
                groups.extend(add.iter().cloned());
            }
            (event, J::Arr(groups))
        })
        .collect();
    J::Obj(vec![("hooks".into(), J::Obj(merged))])
}

/// The config text with `hooks = true` under `[features]`, added only when the table has no `hooks` setting yet.
fn ensure_hooks_feature(toml: &str) -> Result<String, String> {
    if rx("codex_install.features_with_hooks_re")?.is_match(toml) {
        return Ok(toml.to_string());
    }
    if toml.contains(t("codex_install.features_heading")) {
        return Ok(toml.replacen(t("codex_install.features_nl"), t("codex_install.features_nl_hooks"), 1));
    }
    let prefix =
        if js_trim(toml).is_empty() { String::new() } else { rx("codex_install.trailing_ws_re")?.replace(toml, t("codex_install.separator")).into_owned() };
    Ok(format!("{prefix}{}", t("codex_install.features_new")))
}

/// Write `content` to `file` when it differs (a copy of the old file first); `true` when it differs.
fn write_changed(file: &Path, content: &str, dry_run: bool) -> Result<bool, String> {
    let old = match std::fs::read(file) {
        Ok(b) => Some(String::from_utf8_lossy(&b).into_owned()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(write_err(file, &e)),
    };
    if old.as_deref() == Some(content) {
        return Ok(false);
    }
    if !dry_run {
        if let Some(dir) = file.parent() {
            std::fs::create_dir_all(dir).map_err(|e| write_err(file, &e))?;
        }
        if old.is_some() {
            let stamp = to_iso(now_ms()).unwrap_or_default().replace([':', '.'], "-");
            let name = defaults::render("codex_install.backup_fmt", &[("file", &file.display()), ("stamp", &stamp)]);
            std::fs::copy(file, name).map_err(|e| write_err(file, &e))?;
        }
        std::fs::write(file, content).map_err(|e| write_err(file, &e))?;
    }
    Ok(true)
}

fn write_err(path: &Path, e: &dyn std::fmt::Display) -> String {
    defaults::render("codex_install.err_write", &[("path", &path.display()), ("error", &e)])
}

fn state(changed: bool) -> &'static str {
    if changed { t("codex_install.changed") } else { t("codex_install.unchanged") }
}

/// `install-codex [--global] [--dry-run] [--root <plugin dir>]`.
pub fn run(p: &Parsed) -> i32 {
    match go(p) {
        Ok(()) => 0,
        Err(e) => {
            warn(&e);
            1
        }
    }
}

fn go(p: &Parsed) -> Result<(), String> {
    let env = Env::process();
    let (root, rest) = crate::setup::take_root(&p.rest, &env);
    let root: PathBuf = root.map(PathBuf::from).or_else(|| crate::bootstrap::locate_root(None)).ok_or_else(|| t("codex_install.err_no_root").to_string())?;
    let global = rest.iter().any(|a| a == "--global");
    let dry_run = rest.iter().any(|a| a == "--dry-run");
    let target = if global {
        let home = crate::setup::home_dir(&env).ok_or_else(|| t("codex_install.err_home").to_string())?;
        home.join(t("codex_install.dir"))
    } else {
        std::env::current_dir().map_err(|e| e.to_string())?.join(t("codex_install.dir"))
    };
    let (hooks_path, config_path) = (target.join(t("codex_install.hooks_file")), target.join(t("codex_install.config_file")));

    // the Node installer in dry-run mode writes nothing: run before the engine writes, it reports what the engine is about to do
    let node_dry = {
        let mut a: Vec<String> = rest.iter().filter(|x| *x != t("operator.dry_run_flag")).cloned().collect();
        a.push(t("operator.dry_run_flag").to_string());
        let cwd = std::env::current_dir().ok();
        super::shadow_line(&env, &root.join(t("operator.codex_script_rel")).to_string_lossy(), &a, cwd.as_deref())
    };
    let thin = root.join(t("codex_install.thin_hooks_rel"));
    let src = std::fs::read(&thin).map_err(|e| defaults::render("codex_install.err_hooks", &[("path", &thin.display()), ("error", &e)]))?;
    let plugin_dir = root.to_string_lossy().replace('\\', "/");
    let filled = String::from_utf8_lossy(&src).replace(t("codex_install.root_token"), &plugin_dir);
    let parsed = json::parse(&filled, defaults::num("update.json_max_depth") as usize)
        .map_err(|e| defaults::render("codex_install.err_hooks", &[("path", &thin.display()), ("error", &format!("{e:?}"))]))?;
    let ours = match parsed.get("hooks") {
        Some(h @ J::Obj(_)) => h.clone(),
        _ => return Err(defaults::render("codex_install.err_hooks", &[("path", &thin.display()), ("error", &t("update_msg.remote_json_bad"))])),
    };

    let existing = std::fs::read(&hooks_path)
        .ok()
        .and_then(|b| json::parse(&String::from_utf8_lossy(&b), defaults::num("update.json_max_depth") as usize).ok())
        .unwrap_or_else(|| J::Obj(Vec::new()));
    let merged = merge_hooks(&rx("codex_install.hook_group_re")?, &existing, &ours);
    let hooks_changed = write_changed(&hooks_path, &format!("{}\n", pretty(&merged)), dry_run)?;

    let old_toml = match std::fs::read(&config_path) {
        Ok(b) => String::from_utf8_lossy(&b).into_owned(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(write_err(&config_path, &e)),
    };
    let config_changed = write_changed(&config_path, &ensure_hooks_feature(&old_toml)?, dry_run)?;

    let scope = t(if global { "codex_install.scope_global" } else { "codex_install.scope_project" });
    let status = t(if dry_run { "codex_install.status_dry" } else { "codex_install.status_done" });
    let mut text = defaults::render("codex_install.heading", &[("scope", &scope), ("status", &status)]);
    text.push_str(&defaults::render("codex_install.line_hooks", &[("path", &hooks_path.display()), ("state", &state(hooks_changed))]));
    text.push_str(&defaults::render("codex_install.line_config", &[("path", &config_path.display()), ("state", &state(config_changed))]));
    for n in defaults::list("codex_install.notes") {
        text.push_str(n);
    }
    out(&text)?;
    if let Some(node) = node_dry {
        // the first line differs by design (would update / updated); every other line is the result
        let tail = |t: &str| t.split_once('\n').map(|x| x.1.to_string());
        if tail(&node) != tail(&text) {
            crate::discard::note("install_codex_shadow_mismatch", &defaults::render("operator.shadow_codex_log", &[("node", &node), ("engine", &text)]));
        }
    }
    Ok(())
}
