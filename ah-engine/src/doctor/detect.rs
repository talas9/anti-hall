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
    omc_compact_note(doc, ctx);
    None
}

/// GH #981: OMC's Stop context guard orders /compact from its threshold (OMC_CONTEXT_GUARD_THRESHOLD, else its default); below
/// anti-hall's compact-advice cutoff (autoHandover.pct minus guards.compactAdviceMarginPct) the two disagree about the same reply.
fn omc_compact_note(doc: &mut Doc, ctx: &Ctx) {
    let st = crate::checks::git::util::Settings { home: ctx.home.clone(), env: ctx.env.iter().map(|(k, v)| (k.clone(), v.clone())).collect() };
    let omc = ctx
        .env
        .get(defaults::text("ctxbudget.omc_guard_env"))
        .and_then(|v| v.trim().parse::<f64>().ok())
        .unwrap_or(defaults::num("ctxbudget.omc_guard_default_pct") as f64);
    let ah_pct = crate::checks::guardkit::settings::get_num(&st, defaults::raw("ctxbudget.set_ah_pct"));
    let margin = crate::checks::guardkit::settings::get_num(&st, defaults::raw("ctxbudget.set_ca_margin"));
    let cutoff = ah_pct - margin;
    if omc < cutoff {
        let defer = crate::checks::guardkit::settings::get_bool(&st, defaults::raw("ctxbudget.set_compact_defer_omc"));
        doc.infol(defaults::render(
            if defer { "doctor_msg.omc_compact_below_deferred" } else { "doctor_msg.omc_compact_below" },
            &[("omc", &omc.to_string()), ("cutoff", &cutoff.to_string())],
        ));
    }
}

/// GH #981: instruction files (doctor.omc_text_files) whose text steers models towards another orchestration layer's habits that
/// anti-hall's rules contradict (doctor.omc_text_rules: a foreign handover folder while that plugin is off, ...). One warning per
/// matching line, naming the file, the line number and the line; at most doctor.omc_text_max_findings. Read-only, fail-open.
pub fn omc_text_section(doc: &mut Doc, ctx: &Ctx) {
    let omc_on = omc_enabled(ctx);
    let max_bytes = defaults::num("doctor.omc_text_max_bytes");
    let (max_findings, line_max) = (defaults::num("doctor.omc_text_max_findings") as usize, defaults::num("doctor.omc_text_line_max") as usize);
    let rules: Vec<(&'static str, regex::Regex)> = defaults::raw("doctor.omc_text_rules")
        .as_array()
        .unwrap_or_default()
        .iter()
        .filter(|r| r.str_field("when") != defaults::text("doctor.omc_text_when_off") || !omc_on)
        .filter_map(|r| regex::Regex::new(r.str_field("re")).ok().map(|re| (r.str_field("msg"), re)))
        .collect();
    if rules.is_empty() {
        return;
    }
    let mut found: Vec<String> = Vec::new();
    for f in defaults::raw("doctor.omc_text_files").as_array().unwrap_or_default() {
        let base = if f.str_field("base") == defaults::text("doctor.omc_text_base_home") { &ctx.home } else { &ctx.cwd };
        if base.is_empty() {
            continue;
        }
        let path = Path::new(base).join(f.str_field("rel"));
        let Ok(meta) = std::fs::metadata(&path) else { continue };
        if !meta.is_file() || meta.len() > max_bytes {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else { continue };
        for (n, line) in text.lines().enumerate() {
            for (msg, re) in &rules {
                if found.len() < max_findings && re.is_match(line) {
                    let shown: String = line.trim().chars().take(line_max).collect();
                    found.push(defaults::render(
                        "doctor_msg.omc_text_line",
                        &[("file", &path.to_string_lossy()), ("line", &(n + 1).to_string()), ("why", msg), ("text", &shown)],
                    ));
                }
            }
        }
    }
    if found.is_empty() {
        return;
    }
    doc.head(defaults::text("doctor_msg.head_omc_text"));
    for f in found {
        doc.warnl(f);
    }
}

/// GH #981: a usage snapshot the configured source reads (limitConserve.usageSource) that is older than ctxbudget.usage_max_stale_ms:
/// usage readers ignore it, so limit conservation cannot see the real usage. One warning per stale file, with its age in hours.
pub fn usage_section(doc: &mut Doc, ctx: &Ctx) {
    let source = crate::ops::settings::effective_text(defaults::text("ctxbudget.usage_source_section"), defaults::text("ctxbudget.usage_source_key"), "")
        .unwrap_or_default();
    let omc = Path::new(&ctx.home).join(defaults::text("ctxbudget.usage_cache"));
    let sl = Path::new(&ctx.home).join(defaults::text("ctxbudget.usage_statusline_file"));
    let paths = if source == defaults::text("ctxbudget.usage_source_omc") {
        vec![omc]
    } else if source == defaults::text("ctxbudget.usage_source_statusline") {
        vec![sl]
    } else {
        vec![sl, omc]
    };
    let now = crate::checks::jsport::date::now_ms();
    let max = defaults::num("ctxbudget.usage_max_stale_ms") as f64;
    let mut stale: Vec<String> = Vec::new();
    for p in paths {
        let Some(snap) = read_bounded(&p, defaults::num("doctor.omc_text_max_bytes")) else { continue };
        let ts = match snap.get("timestamp") {
            Some(J::Num(n)) if n.is_finite() && *n > 0.0 => *n,
            _ => std::fs::metadata(&p)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0.0, |d| d.as_millis() as f64),
        };
        if ts > 0.0 && now - ts <= max {
            return; // a fresh snapshot of the configured source: the readers use it
        }
        let hours = ((now - ts) / defaults::num("doctor.usage_stale_hour_ms") as f64).round();
        stale.push(defaults::render("doctor_msg.usage_stale", &[("path", &p.to_string_lossy()), ("hours", &hours.to_string())]));
    }
    if stale.is_empty() {
        return;
    }
    doc.head(defaults::text("doctor_msg.head_usage"));
    for w in stale {
        doc.warnl(w);
    }
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

/// The commands of a Codex `hooks.json` that still run a Node-era anti-hall hook script (`node .../anti-hall/.../hooks/<name>.js`): how
/// many, and the first. The scripts no longer ship, so each of them fails on every call. `(0, "")` when none, or when the file is
/// absent or unreadable.
fn codex_node_entries(hooks_json: &Path) -> (usize, String) {
    let Ok(text) = std::fs::read_to_string(hooks_json) else { return (0, String::new()) };
    let Some(cfg) = migrate::parse_json(&text) else { return (0, String::new()) };
    let re = crate::checks::lit_re(defaults::text("doctor.codex_node_entry_re"));
    let mut found: Vec<String> = Vec::new();
    for (_, groups) in as_obj(cfg.get("hooks")).into_iter().flatten() {
        for g in as_arr(Some(groups)) {
            for h in as_arr(g.get("hooks")) {
                if let Some(J::Str(c)) = h.get("command")
                    && re.is_match(&c.replace('\\', "/"))
                {
                    found.push(c.clone());
                }
            }
        }
    }
    let max = defaults::num("doctor_l.excerpt_chars") as usize;
    (found.len(), found.first().map(|c| c.chars().take(max).collect()).unwrap_or_default())
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
    let mut found = Vec::new();
    for (label, base) in [(defaults::text("doctor_msg.codex_label_project"), &ctx.cwd), (defaults::text("doctor_msg.codex_label_global"), &ctx.home)] {
        let d = Path::new(base).join(dir);
        let cfg = d.join(defaults::text("codex_install.config_file"));
        let hooks = d.join(defaults::text("codex_install.hooks_file"));
        if !cfg.is_file() && !hooks.is_file() {
            continue;
        }
        let enabled = std::fs::read_to_string(&cfg).is_ok_and(|t| re.is_match(&t));
        let missing = std::fs::read_to_string(&hooks)
            .ok()
            .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
            .is_some_and(|value| crate::hooksgen::missing_launcher(&value, &ctx.home, root, &ctx.env));
        let node = if defaults::num("doctor.codex_node_entries") == 1 { codex_node_entries(&hooks) } else { (0, String::new()) };
        found.push((label, enabled, codex_wired(&hooks, &expected), missing, node, hooks));
    }
    if found.is_empty() {
        return Some(defaults::text("doctor_msg.codex_none"));
    }
    doc.head(defaults::text("doctor_msg.head_codex"));
    for (label, enabled, wired, missing, node, hooks) in found {
        if enabled {
            doc.ok(defaults::render("doctor_msg.codex_hooks_on", &[("label", &label)]));
        } else {
            doc.warnl(defaults::render("doctor_msg.codex_hooks_off", &[("label", &label)]));
        }
        if missing {
            doc.bad(defaults::render("doctor_msg.codex_launcher_missing", &[("label", &label), ("file", &hooks.display())]));
            continue;
        }
        if node.0 > 0 {
            // Node-era hooks that cannot run: they fail on every call, so no Codex guard runs (and `install-codex` replaces them)
            crate::metrics::bump_shared("doctor_codex_node_entries", &[]);
            doc.bad(defaults::render("doctor_msg.codex_node_entries", &[("label", &label), ("file", &hooks.display()), ("n", &node.0), ("first", &node.1)]));
            continue;
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
    let own = crate::install::owning(&ctx.home, &root.to_string_lossy()).map(|o| o.key).unwrap_or_else(|| defaults::text("doctor.self_plugin_key").to_string());
    enabled.retain(|k| k != &own);
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
                if (event == defaults::text("doctor.foreign_pre") || event == defaults::text("doctor.foreign_stop")) && defaults::list("doctor.foreign_observers").contains(&base.as_str()) {
                    results.push((false, defaults::render("doctor_msg.foreign_observer", &[("event", &event), ("plugin", &name), ("script", &base)])));
                } else if event == defaults::text("doctor.foreign_pre") && matches_bash(&matcher) {
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

/// Stray history in submodules is diagnostic only: never move, repair or remove it.
pub(super) fn stray_submodule_state(doc: &mut Doc, ctx: &Ctx) {
    use crate::checks::jsport::{gitrun, ident};
    use crate::reqenv::RequestEnv;
    let env = RequestEnv::from_pairs(ctx.env.clone());
    let context = ident::resolve_context(&ctx.cwd, false, &env);
    if context.unsure {
        return;
    }
    let Some(root) = context.worktree_root else { return };
    let canonical = std::fs::canonicalize(&root).unwrap_or_else(|_| PathBuf::from(&root));
    let mut pending = vec![(canonical.clone(), 0u64)];
    let history = defaults::list("task_lifecycle_log.history_dir").join("/");
    while let Some((dir, depth)) = pending.pop() {
        if depth >= defaults::num("codex_handover.max_submodule_hops") {
            continue;
        }
        let args = defaults::list("doctor.submodule_paths_args");
        let Some(out) = gitrun::git_scrubbed(
            &dir.to_string_lossy(),
            &args,
            defaults::millis("codex_handover.identity_git_timeout_ms"),
            &env,
            &defaults::list("codex_handover.git_scrub_env"),
        ) else {
            continue;
        };
        for line in out.lines() {
            let Some((_, rel)) = line.split_once(' ') else { continue };
            let Ok(sub) = std::fs::canonicalize(dir.join(rel)) else { continue };
            if !sub.starts_with(&canonical) || sub == dir {
                continue;
            }
            // An uninitialised submodule is a plain directory, not a separate checkout.
            let c = ident::resolve_context(&sub.to_string_lossy(), false, &env);
            if c.toplevel.as_deref() != sub.to_str() {
                continue;
            }
            let state = sub.join(&history);
            if state.is_dir() {
                doc.warnl(defaults::render("doctor_msg.stray_submodule_history", &[("path", &state.to_string_lossy())]));
            }
            pending.push((sub, depth + 1));
        }
    }
}

#[cfg(test)]
mod omc_text_tests {
    use super::*;
    use std::collections::BTreeMap;

    fn doc_for(home: &Path) -> Doc {
        let ctx = Ctx::new(home.to_string_lossy().into_owned(), String::new(), BTreeMap::new(), true, None, None);
        let mut doc = Doc::default();
        omc_text_section(&mut doc, &ctx);
        doc
    }

    /// GH #981 (1c): a global instruction file that names OMC's handover folder while the OMC plugin is off is flagged with the line.
    #[test]
    fn a_foreign_handover_folder_in_global_instructions_is_flagged_while_omc_is_off() {
        let home = crate::tmpsweep::scratch("ah-omc-doc-", "text");
        std::fs::create_dir_all(home.join(".claude")).unwrap();
        std::fs::write(home.join(".claude/CLAUDE.md"), "# rules\nRuntime state includes `.omc/plans/`, `.omc/handoffs/`.\n").unwrap();
        let doc = doc_for(&home);
        assert_eq!(doc.warn, 1, "{doc:?}");
        let body = format!("{doc:?}");
        assert!(body.contains("CLAUDE.md:2") && body.contains(".omc/handoffs/"), "{body}");
        // the OMC plugin enabled: its own text has something behind it, nothing is flagged
        std::fs::write(home.join(".claude/settings.json"), r#"{"enabledPlugins":{"oh-my-claudecode@omc":true}}"#).unwrap();
        assert_eq!(doc_for(&home).warn, 0);
    }
}
