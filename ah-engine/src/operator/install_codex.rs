//! `ah-engine install-codex [--global] [--dry-run] [--root <plugin dir>]`: the Codex port installer, ported from
//! `codex/install-codex.js`.
//!
//! It merges the current dispatch table's generated hook registration (one thin client call per event, with the
//! plugin directory filled in) into `<.codex>/hooks.json`: anti-hall's own hooks are replaced, while other hooks and their
//! group metadata stay in place; and it makes sure `<.codex>/config.toml` enables the hooks feature. A file that changes is first copied to
//! `<file>.bak-<time>`; nothing is deleted. `--dry-run` writes nothing. Running it twice changes nothing the second time.
//! Engine-only: no Node script is started (v1.0 lane L16); the Node installer stays only as the witness of the parity test.
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

/// An anti-hall hook command (backslashes read as slashes) names its hooks directory or thin client.
fn is_anti_hall_hook(re: &Regex, h: &J) -> bool {
    matches!(h.get("command"), Some(J::Str(c)) if re.is_match(&c.replace('\\', "/")))
}

fn keys(v: &J) -> Vec<String> {
    match v {
        J::Obj(o) => o.iter().map(|(k, _)| k.clone()).collect(),
        _ => Vec::new(),
    }
}

/// The existing registration with anti-hall's hooks replaced by the current ones; foreign hooks and group metadata stay in place.
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
                Some(J::Arr(a)) => a
                    .iter()
                    .filter_map(|g| {
                        let Some(J::Arr(hooks)) = g.get("hooks") else { return Some(g.clone()) };
                        let kept: Vec<J> = hooks.iter().filter(|h| !is_anti_hall_hook(re, h)).cloned().collect();
                        if !hooks.is_empty() && kept.is_empty() {
                            return None;
                        }
                        let mut group = g.clone();
                        group.set("hooks", J::Arr(kept));
                        Some(group)
                    })
                    .collect(),
                _ => Vec::new(),
            };
            if let Some(J::Arr(add)) = ours.get(&event) {
                groups.extend(add.iter().cloned());
            }
            (event, J::Arr(groups))
        })
        .collect();
    let mut result = existing.clone();
    if !matches!(result, J::Obj(_)) {
        result = J::Obj(Vec::new());
    }
    result.set("hooks", J::Obj(merged));
    result
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
pub(crate) fn write_changed(file: &Path, content: &str, dry_run: bool) -> Result<bool, String> {
    let old = match std::fs::read(file) {
        Ok(b) => Some(b),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(write_err(file, &e)),
    };
    if old.as_deref() == Some(content.as_bytes()) {
        return Ok(false);
    }
    if !dry_run {
        if let Some(dir) = file.parent() {
            std::fs::create_dir_all(dir).map_err(|e| write_err(file, &e))?;
        }
        let mode = std::fs::metadata(file).ok().map(|m| std::os::unix::fs::PermissionsExt::mode(&m.permissions()));
        if let Some(old) = old {
            let stamp = to_iso(now_ms()).unwrap_or_default().replace([':', '.'], "-");
            let name = defaults::render("codex_install.backup_fmt", &[("file", &file.display()), ("stamp", &stamp)]);
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            if let Some(mode) = mode {
                std::os::unix::fs::OpenOptionsExt::mode(&mut options, mode);
            }
            let mut backup = options.open(name).map_err(|e| write_err(file, &e))?;
            std::io::Write::write_all(&mut backup, &old).and_then(|_| backup.sync_all()).map_err(|e| write_err(file, &e))?;
        }
        crate::atomic::write_styled(file, content, crate::atomic::Style { mode, ..Default::default() }).map_err(|e| write_err(file, &e))?;
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

    let thin = root.join(t("codex_install.thin_hooks_rel"));
    let src = crate::hooksgen::hooks_json(t("hooks_form.host_codex"));
    let plugin_dir = root.to_string_lossy().replace('\\', "/");
    let parsed = json::parse(&src, defaults::num("update.json_max_depth") as usize)
        .map_err(|e| defaults::render("codex_install.err_hooks", &[("path", &thin.display()), ("error", &format!("{e:?}"))]))?;
    let mut ours = match parsed.get("hooks") {
        Some(h @ J::Obj(_)) => h.clone(),
        _ => return Err(defaults::render("codex_install.err_hooks", &[("path", &thin.display()), ("error", &t("update_msg.remote_json_bad"))])),
    };
    if let J::Obj(events) = &mut ours {
        for (_, groups) in events {
            if let J::Arr(groups) = groups {
                for group in groups {
                    if let Some(J::Arr(mut hooks)) = group.get("hooks").cloned() {
                        for hook in &mut hooks {
                            if let Some(J::Str(command)) = hook.get("command") {
                                let command = command.replace(t("codex_install.root_token"), &plugin_dir);
                                hook.set("command", J::Str(command));
                            }
                        }
                        group.set("hooks", J::Arr(hooks));
                    }
                }
            }
        }
    }

    let existing = match std::fs::read_to_string(&hooks_path) {
        Ok(text) => json::parse(&text, defaults::num("update.json_max_depth") as usize)
            .map_err(|e| defaults::render("codex_install.err_hooks", &[("path", &hooks_path.display()), ("error", &format!("{e:?}"))]))?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => J::Obj(Vec::new()),
        Err(e) => return Err(write_err(&hooks_path, &e)),
    };
    let valid = matches!(&existing, J::Obj(_))
        && match existing.get("hooks") {
            None => true,
            Some(J::Obj(events)) => events.iter().all(|(_, groups)| matches!(groups, J::Arr(_))),
            _ => false,
        };
    if !valid {
        return Err(defaults::render("codex_install.err_hooks", &[("path", &hooks_path.display()), ("error", &t("update_msg.remote_json_bad"))]));
    }
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
    Ok(())
}
