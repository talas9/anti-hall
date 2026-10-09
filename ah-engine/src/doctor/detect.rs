//! What else is installed beside anti-hall: the oh-my-claudecode plugin and its autonomous loops, the Codex port, and other
//! enabled plugins whose hooks or skills compete with anti-hall's own. Read-only; every unreadable file is skipped (fail-open),
//! as in the Node doctor.
use super::Doc;
use crate::checks::jsport::json::J;
use crate::defaults;
use crate::migrate::{self, Ctx};
use std::path::{Path, PathBuf};

/// A JSON file of at most `max` bytes, parsed; `None` when missing, too big or not JSON.
fn read_bounded(p: &Path, max: u64) -> Option<J> {
    let meta = std::fs::metadata(p).ok()?;
    if meta.len() > max {
        return None;
    }
    migrate::parse_json(&std::fs::read_to_string(p).ok()?)
}

fn as_obj(v: Option<&J>) -> Option<&Vec<(String, J)>> {
    match v {
        Some(J::Obj(o)) => Some(o),
        _ => None,
    }
}

fn as_arr(v: Option<&J>) -> &[J] {
    match v {
        Some(J::Arr(a)) => a,
        _ => &[],
    }
}

// ---- OMC ------------------------------------------------------------------------------------------------------------------------

fn settings_enable_omc(p: &Path) -> bool {
    let Some(s) = read_bounded(p, defaults::num("tasklist_guard.omc_settings_max_bytes")) else { return false };
    as_obj(s.get("enabledPlugins")).is_some_and(|o| o.iter().any(|(k, v)| k == defaults::text("tasklist_guard.omc_plugin") && matches!(v, J::Bool(true))))
}

/// `isOmcEnabled(cwd)`: the plugin is enabled in the home settings or either project settings file.
fn omc_enabled(ctx: &Ctx) -> bool {
    let files = defaults::list("tasklist_guard.omc_settings_files");
    let (first, second) = (files.first().copied().unwrap_or(""), files.get(1).copied().unwrap_or(""));
    settings_enable_omc(&Path::new(&ctx.home).join(first))
        || (!ctx.cwd.is_empty() && (settings_enable_omc(&Path::new(&ctx.cwd).join(first)) || settings_enable_omc(&Path::new(&ctx.cwd).join(second))))
}

fn state_root(ctx: &Ctx) -> PathBuf {
    let seg: PathBuf = defaults::list("tasklist_guard.omc_state_dir").iter().collect();
    let local = Path::new(&ctx.cwd).join(&seg);
    if !ctx.cwd.is_empty() && local.is_dir() { local } else { Path::new(&ctx.home).join(&seg) }
}

fn state_active(p: &Path, session: &str, now_ms: f64) -> bool {
    let Some(state) = read_bounded(p, defaults::num("tasklist_guard.omc_max_bytes")) else { return false };
    if !matches!(state, J::Obj(_)) || !matches!(state.get("active"), Some(J::Bool(true))) {
        return false;
    }
    let fresh = defaults::num("tasklist_guard.omc_fresh_ms") as f64;
    let stamp = |k: &str| match state.get(k) {
        Some(J::Num(n)) if n.is_finite() => *n,
        Some(J::Str(s)) => match crate::checks::jsport::date::parse(s) {
            crate::checks::jsport::date::Parsed::Ms(ms) => ms,
            _ => 0.0,
        },
        _ => 0.0,
    };
    let recent = defaults::list("doctor.omc_time_fields").into_iter().map(stamp).any(|v| v > 0.0 && now_ms - v <= fresh);
    if !recent {
        return false;
    }
    match state.get("session_id") {
        None | Some(J::Null) => true,
        Some(id) => !session.is_empty() && migrate::j_string(id) == session,
    }
}

/// `isOmcLoopActive({cwd, sessionId})`.
fn omc_loop_active(ctx: &Ctx, session: &str) -> bool {
    if ctx.env.get(defaults::text("tasklist_guard.omc_kill_env")).is_some_and(|v| v == "1") {
        return false;
    }
    let skip = ctx.env.get(defaults::text("tasklist_guard.omc_skip_env")).map(String::as_str).unwrap_or("");
    if skip.split(',').any(|s| s.trim() == defaults::text("tasklist_guard.omc_skip_token")) || !omc_enabled(ctx) {
        return false;
    }
    let root = state_root(ctx);
    let now = crate::checks::jsport::date::now_ms();
    defaults::list("tasklist_guard.omc_state_files").iter().any(|f| state_active(&root.join(f), session, now))
}

/// The OMC findings; a section of its own only when OMC is enabled.
/// Returns the "not detected" note when it is not (the caller shows the notes together).
pub fn omc_section(doc: &mut Doc, ctx: &Ctx) -> Option<&'static str> {
    if !omc_enabled(ctx) {
        return Some(defaults::text("doctor_msg.omc_none"));
    }
    doc.head(defaults::text("doctor_msg.head_omc"));
    doc.ok(defaults::render("doctor_msg.omc_enabled", &[("key", &defaults::text("tasklist_guard.omc_plugin"))]));
    if omc_loop_active(ctx, defaults::text("doctor.omc_probe_session")) {
        doc.ok(defaults::text("doctor_msg.omc_loop_active").to_string());
    } else {
        doc.ok(defaults::text("doctor_msg.omc_loop_idle").to_string());
    }
    None
}

// ---- Codex ----------------------------------------------------------------------------------------------------------------------

/// Whether a Codex `hooks.json` registers anti-hall's hooks for every event the plugin's own Codex registration has. `None`: the
/// file is absent or unreadable.
fn codex_wired(hooks_json: &Path, expected: &[String]) -> Option<bool> {
    let text = std::fs::read_to_string(hooks_json).ok()?;
    let cfg = migrate::parse_json(&text)?;
    let by_event = as_obj(cfg.get("hooks"));
    if expected.is_empty() {
        let flat = crate::checks::jsport::json::stringify(&cfg).replace(defaults::text("doctor.codex_double_backslash"), "/");
        return Some(flat.contains(defaults::text("doctor.codex_coarse_marker")));
    }
    let re = crate::checks::lit_re(defaults::text("codex_install.hook_group_re"));
    Some(expected.iter().all(|event| {
        let groups = by_event.and_then(|o| o.iter().find(|(k, _)| k == event)).map(|(_, v)| as_arr(Some(v))).unwrap_or(&[]);
        groups.iter().any(|g| as_arr(g.get("hooks")).iter().any(|h| matches!(h.get("command"), Some(J::Str(c)) if re.is_match(&c.replace('\\', "/")))))
    }))
}

/// The events of the plugin's own Codex registration (what the installer registers).
fn codex_events(root: Option<&Path>) -> Vec<String> {
    let Some(root) = root else { return Vec::new() };
    let Ok(text) = std::fs::read_to_string(root.join(defaults::text("codex_install.thin_hooks_rel"))) else { return Vec::new() };
    match migrate::parse_json(&text).as_ref().and_then(|j| as_obj(j.get("hooks"))) {
        Some(o) => o.iter().map(|(k, _)| k.clone()).collect(),
        None => Vec::new(),
    }
}

/// The Codex findings; a section of its own only when a Codex `config.toml` exists.
/// Returns the "not detected" note when there is no Codex configuration.
pub fn codex_section(doc: &mut Doc, ctx: &Ctx, root: Option<&Path>) -> Option<&'static str> {
    let expected = codex_events(root);
    let re = crate::checks::lit_re(defaults::text("doctor.codex_hooks_enabled_re"));
    let dir = defaults::text("codex_install.dir");
    let mut found: Vec<(&str, bool, Option<bool>)> = Vec::new();
    for (label, base) in [(defaults::text("doctor_msg.codex_label_project"), &ctx.cwd), (defaults::text("doctor_msg.codex_label_global"), &ctx.home)] {
        let d = Path::new(base).join(dir);
        let cfg = d.join(defaults::text("codex_install.config_file"));
        if !cfg.is_file() {
            continue;
        }
        let enabled = std::fs::read_to_string(&cfg).is_ok_and(|t| re.is_match(&t));
        found.push((label, enabled, codex_wired(&d.join(defaults::text("codex_install.hooks_file")), &expected)));
    }
    if found.is_empty() {
        return Some(defaults::text("doctor_msg.codex_none"));
    }
    doc.head(defaults::text("doctor_msg.head_codex"));
    for (label, enabled, wired) in found {
        if enabled {
            doc.ok(defaults::render("doctor_msg.codex_hooks_on", &[("label", &label)]));
        } else {
            doc.warnl(defaults::render("doctor_msg.codex_hooks_off", &[("label", &label)]));
        }
        match wired {
            Some(true) => doc.ok(defaults::render("doctor_msg.codex_wired", &[("label", &label)])),
            Some(false) => doc.warnl(defaults::render("doctor_msg.codex_unwired", &[("label", &label)])),
            None => doc.warnl(defaults::render("doctor_msg.codex_missing", &[("label", &label)])),
        }
    }
    None
}

// ---- other plugins' hooks and skills --------------------------------------------------------------------------------------------

/// `[{event, matcher, basename}]` of a plugin's hook registration. Only the script's file name is kept, never the command.
fn hook_entries(cfg: Option<&J>) -> Vec<(String, Option<String>, String)> {
    let re = crate::checks::lit_re(defaults::text("doctor.foreign_script_re"));
    let mut out = Vec::new();
    let Some(events) = cfg.and_then(|c| as_obj(c.get("hooks"))) else { return out };
    for (event, groups) in events {
        for g in as_arr(Some(groups)) {
            let matcher = match g.get("matcher") {
                Some(J::Str(m)) if !m.is_empty() => Some(m.clone()),
                _ => None,
            };
            for h in as_arr(g.get("hooks")) {
                let cmd = match h.get("command") {
                    Some(J::Str(c)) => c.as_str(),
                    _ => "",
                };
                let base = re.find(cmd).map_or_else(|| defaults::text("doctor.foreign_non_script").to_string(), |m| m.as_str().to_string());
                out.push((event.clone(), matcher.clone(), base));
            }
        }
    }
    out
}

fn matches_bash(matcher: &Option<String>) -> bool {
    match matcher {
        None => true,
        Some(m) => m == "*" || m.to_lowercase().contains(defaults::text("doctor.foreign_bash")),
    }
}

fn skill_dirs(dir: &Path) -> Vec<String> {
    migrate::read_dir_sorted(dir).unwrap_or_default().into_iter().filter(|n| dir.join(n).is_dir()).collect()
}

/// Other enabled plugins whose hooks or skills compete with anti-hall's own. Advisory: it never fails the run.
pub fn foreign_section(doc: &mut Doc, ctx: &Ctx, root: Option<&Path>) {
    doc.head(defaults::text("doctor_msg.head_foreign"));
    let Some(root) = root else { return };
    let max = defaults::num("doctor.foreign_max_bytes");
    let own = hook_entries(read_bounded(&root.join(defaults::text("doctor.hooks_dir")).join(defaults::text("doctor.hooks_registry")), max).as_ref());
    let own_has_stop = own.iter().any(|e| e.0 == defaults::text("doctor.foreign_stop"));
    let own_skills = skill_dirs(&root.join(defaults::text("doctor.skills_dir")));

    let mut enabled: Vec<String> = Vec::new();
    let scopes = [
        Path::new(&ctx.home).join(defaults::text("doctor.claude_settings")),
        Path::new(&ctx.cwd).join(defaults::text("doctor.claude_settings")),
        Path::new(&ctx.cwd).join(defaults::text("doctor.claude_settings_local_rel")),
    ];
    for p in scopes {
        if let Some(plugins) = read_bounded(&p, max).as_ref().and_then(|s| as_obj(s.get("enabledPlugins"))) {
            for (k, v) in plugins {
                if matches!(v, J::Bool(true)) && !enabled.contains(k) {
                    enabled.push(k.clone());
                }
            }
        }
    }
    enabled.retain(|k| k != defaults::text("doctor.self_plugin_key"));
    let mut results: Vec<(bool, String)> = Vec::new(); // (HIGH, message)
    if !enabled.is_empty() {
        let installed = read_bounded(&Path::new(&ctx.home).join(defaults::text("doctor.installed_plugins_rel")), defaults::num("doctor.installed_max_bytes"));
        for key in &enabled {
            let install = installed.as_ref().and_then(|d| as_obj(d.get("plugins"))).and_then(|o| o.iter().find(|(k, _)| k == key)).and_then(|(_, v)| {
                as_arr(Some(v)).iter().rev().find_map(|e| match e.get("installPath") {
                    Some(J::Str(p)) => Some(p.clone()),
                    _ => None,
                })
            });
            let Some(install) = install else { continue };
            let name = key.split('@').next().unwrap_or(key).to_string();
            let hooks_json = read_bounded(&Path::new(&install).join(defaults::text("doctor.hooks_dir")).join(defaults::text("doctor.hooks_json")), max);
            for (event, matcher, base) in hook_entries(hooks_json.as_ref()) {
                let shown = matcher.clone().unwrap_or_else(|| "*".into());
                if event == defaults::text("doctor.foreign_pre") && matches_bash(&matcher) {
                    results.push((true, defaults::render("doctor_msg.foreign_pre", &[("plugin", &name), ("script", &base), ("matcher", &shown)])));
                } else if event == defaults::text("doctor.foreign_stop") {
                    let tail = if own_has_stop { defaults::text("doctor_msg.foreign_stop_tail") } else { "" };
                    results.push((true, defaults::render("doctor_msg.foreign_stop", &[("plugin", &name), ("script", &base), ("tail", &tail)])));
                } else if defaults::list("doctor.foreign_additive").contains(&event.as_str()) {
                    results.push((false, defaults::render("doctor_msg.foreign_additive", &[("event", &event), ("plugin", &name), ("script", &base)])));
                }
            }
            if !own_skills.is_empty() {
                for s in skill_dirs(&Path::new(&install).join(defaults::text("doctor.skills_dir"))) {
                    if own_skills.contains(&s) {
                        results.push((true, defaults::render("doctor_msg.foreign_skill", &[("plugin", &name), ("skill", &s)])));
                    }
                }
            }
        }
    }
    let mut seen: Vec<&(bool, String)> = Vec::new();
    let mut any = false;
    for r in &results {
        if seen.contains(&r) {
            continue;
        }
        seen.push(r);
        any = true;
        if r.0 {
            doc.warnl(r.1.clone());
        } else {
            doc.infol(r.1.clone());
        }
    }
    if !any {
        doc.infol(defaults::text("doctor_msg.foreign_none").to_string());
    }
}
