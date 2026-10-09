//! The plugin and its configuration: how the defaults loaded (edited copy, last-known-good, pristine), settings the edited files
//! lack, unknown settings, the user's own config and settings files, the pristine copy, the plugin registry and its enablement
//! (disabled, doubled, an older Node build also on, a moved cache), and whether `hooks.json` is the thin form for each host.
//! Reads only; the one repair here (healing missing settings) is applied by [`super::apply`].
use super::{Doc, Fix};
use crate::defaults;
use crate::migrate::Ctx;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

fn read_json(p: &Path) -> Result<Value, String> {
    let text = std::fs::read_to_string(p).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

/// The `[key]` table headers of a defaults file.
fn headers(text: &str) -> BTreeSet<String> {
    let re = crate::checks::lit_re(defaults::text("doctor.header_re"));
    text.lines().filter_map(|l| re.captures(l).and_then(|c| c.get(1)).map(|m| m.as_str().trim().to_string())).collect()
}

/// CF-01..07: the configuration.
pub fn config_section(doc: &mut Doc, fixes: &mut Vec<Fix>, ctx: &Ctx) {
    doc.head(defaults::text("doctor_msg.head_config"));
    let Some(root) = defaults::root() else { return };
    let report = defaults::load_report();
    let mut clean = true;
    if let Some(r) = &report {
        for n in &r.notes {
            clean = false;
            let layer = n.layer.code();
            let flat = n.detail.split_whitespace().collect::<Vec<_>>().join(" ");
            let detail = if n.key.is_empty() { flat } else { format!("{flat} ({})", n.key) };
            doc.warnl(defaults::render("doctor_msg.config_fell_back", &[("file", &n.file), ("detail", &detail), ("layer", &layer), ("code", &n.code)]));
        }
        for (file, keys) in &r.missing {
            clean = false;
            doc.warnl(defaults::render("doctor_msg.config_missing_keys", &[("file", file), ("n", &keys.len()), ("keys", &keys.join(", "))]));
        }
        if !r.missing.is_empty() {
            fixes.push(Fix::Heal);
        }
    }
    let pristine = root.join(crate::bootstrap::PRISTINE_DIR);
    let edited = root.join(crate::bootstrap::DEFAULTS_DIR);
    if !pristine.join(crate::bootstrap::INDEX_FILE).is_file() {
        clean = false;
        doc.warnl(defaults::render("doctor_msg.config_no_pristine", &[("dir", &pristine.display())]));
    } else if let Ok(rd) = std::fs::read_dir(&edited) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if !name.ends_with(defaults::text("doctor.toml_ext")) {
                continue;
            }
            let (Ok(mine), Ok(theirs)) = (std::fs::read_to_string(e.path()), std::fs::read_to_string(pristine.join(&name))) else { continue };
            let extra: Vec<String> = headers(&mine).difference(&headers(&theirs)).cloned().collect();
            if !extra.is_empty() {
                doc.infol(defaults::render("doctor_msg.config_unknown", &[("file", &name), ("keys", &extra.join(", "))]));
            }
        }
    }
    let user = crate::paths::dir().join(defaults::text("config.user_file"));
    if let Ok(text) = std::fs::read_to_string(&user)
        && let Err(e) = toml::from_str::<toml::Value>(&text)
    {
        clean = false;
        doc.warnl(defaults::render("doctor_msg.config_user_broken", &[("path", &user.display()), ("err", &e.to_string().lines().next().unwrap_or(""))]));
    }
    let settings = Path::new(&ctx.home).join(defaults::text("paths.base_dir")).join(defaults::text("config.settings_file"));
    match std::fs::read_to_string(&settings) {
        Ok(text) => {
            if let Err(e) = serde_json::from_str::<Value>(&text) {
                clean = false;
                doc.warnl(defaults::render("doctor_msg.config_settings_bad", &[("path", &settings.display()), ("err", &e)]));
            }
        }
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
            clean = false;
            doc.warnl(defaults::render("doctor_msg.config_settings_bad", &[("path", &settings.display()), ("err", &e)]));
        }
        Err(_) => {}
    }
    if clean {
        doc.ok(defaults::render("doctor_msg.config_ok", &[("n", &defaults::all().len())]));
    }
}

/// The merged `enabledPlugins` of the settings scopes (later scopes override earlier ones), noting files that do not parse.
fn enabled_plugins(doc: &mut Doc, ctx: &Ctx) -> BTreeMap<String, (bool, String)> {
    let mut out = BTreeMap::new();
    for scope in defaults::raw("doctor.settings_scopes").as_array().unwrap_or_default() {
        let base = if scope.get("home").and_then(defaults::V::as_bool).unwrap_or(false) { &ctx.home } else { &ctx.cwd };
        let file = Path::new(base).join(scope.str_field("file"));
        match std::fs::read_to_string(&file) {
            Ok(text) => match serde_json::from_str::<Value>(&text) {
                Ok(v) => {
                    for (k, on) in v.get("enabledPlugins").and_then(Value::as_object).into_iter().flatten() {
                        if let Some(b) = on.as_bool() {
                            out.insert(k.clone(), (b, file.display().to_string()));
                        }
                    }
                }
                Err(e) => doc.warnl(defaults::render("doctor_msg.plugin_json_bad", &[("file", &file.display()), ("err", &e)])),
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => doc.warnl(defaults::render("doctor_msg.plugin_json_bad", &[("file", &file.display()), ("err", &e)])),
        }
    }
    out
}

/// The commands of a `hooks.json`, per event.
fn commands(v: &Value) -> BTreeMap<String, BTreeSet<String>> {
    let mut out: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for (event, groups) in v.get("hooks").and_then(Value::as_object).into_iter().flatten() {
        for g in groups.as_array().into_iter().flatten() {
            for h in g.get("hooks").and_then(Value::as_array).into_iter().flatten() {
                if let Some(c) = h.get("command").and_then(Value::as_str) {
                    out.entry(event.clone()).or_default().insert(c.to_string());
                }
            }
        }
    }
    out
}

/// How a `hooks.json` differs from the thin form of `host`: the number of differing events and the first example.
pub fn thin_diff(actual: &Value, host: &str) -> (usize, String) {
    let expected = serde_json::from_str::<Value>(&crate::hooksgen::hooks_json(host)).map(|v| commands(&v)).unwrap_or_default();
    let got = commands(actual);
    let mut n = 0;
    let mut first = String::new();
    for event in expected.keys().chain(got.keys()).collect::<BTreeSet<_>>() {
        if expected.get(event) != got.get(event) {
            n += 1;
            if first.is_empty() {
                let shown = got.get(event).and_then(|c| c.iter().next().cloned()).unwrap_or_else(|| defaults::text("doctor_msg.no_entry").to_string());
                first = format!("{event}: {shown}");
            }
        }
    }
    (n, first)
}

/// HK-01..03: the wrapper is there and each host's hooks file is the thin form.
pub fn thin_section(doc: &mut Doc, root: &Path) {
    doc.head(defaults::text("doctor_msg.head_thin"));
    let wrapper = root.join(defaults::text("doctor.wrapper_file"));
    if !wrapper.is_file() {
        doc.bad(defaults::render("doctor_msg.wrapper_missing", &[("file", &wrapper.display())]));
    }
    for entry in defaults::raw("doctor.hooks_files").as_array().unwrap_or_default() {
        let (host, rel) = (entry.str_field("host"), entry.str_field("file"));
        let file = root.join(rel);
        if !file.exists() {
            if host == defaults::text("dispatch.default_host") {
                doc.bad(defaults::render("doctor_msg.thin_missing", &[("file", &file.display())]));
            }
            continue;
        }
        match read_json(&file) {
            Err(e) => doc.bad(defaults::render("doctor_msg.hooks_invalid", &[("error", &e)])),
            Ok(v) => match thin_diff(&v, host) {
                (0, _) => doc.ok(defaults::render("doctor_msg.thin_ok", &[("file", &rel)])),
                (n, first) => doc.bad(defaults::render("doctor_msg.thin_not", &[("file", &rel), ("n", &n), ("first", &first), ("host", &host)])),
            },
        }
    }
}

/// PL-02..09: the plugin registry and its enablement.
pub fn registry_section(doc: &mut Doc, ctx: &Ctx, root: Option<&Path>, version: &str) {
    doc.head(defaults::text("doctor_msg.head_plugin"));
    let enabled = enabled_plugins(doc, ctx);
    let reg_file = Path::new(&ctx.home).join(defaults::text("doctor.registry_file"));
    let registry = match read_json(&reg_file) {
        Ok(v) => Some(v),
        Err(_) if !reg_file.exists() => None,
        Err(e) => {
            doc.warnl(defaults::render("doctor_msg.plugin_json_bad", &[("file", &reg_file.display()), ("err", &e)]));
            return;
        }
    };
    let Some(registry) = registry else {
        doc.infol(defaults::render("doctor_msg.plugin_no_registry", &[("file", &reg_file.display())]));
        return;
    };
    let prefix = defaults::text("doctor.plugin_prefix");
    let plugins = registry.get("plugins").unwrap_or(&registry);
    let mut installs: Vec<(String, PathBuf, String)> = Vec::new();
    for (key, entries) in plugins.as_object().into_iter().flatten().filter(|(k, _)| k.starts_with(prefix)) {
        for e in entries.as_array().into_iter().flatten() {
            let path = e.get("installPath").and_then(Value::as_str).unwrap_or("");
            installs.push((key.clone(), PathBuf::from(path), e.get("version").and_then(Value::as_str).unwrap_or("").to_string()));
        }
    }
    let file = reg_file.display().to_string();
    if installs.is_empty() {
        doc.warnl(defaults::render("doctor_msg.plugin_not_registered", &[("file", &file)]));
        return;
    }
    let here = root.and_then(|r| r.canonicalize().ok());
    let is_here = |p: &Path| here.as_deref().is_some_and(|h| p.canonicalize().ok().is_some_and(|c| h.starts_with(&c)));
    let on: Vec<&(String, PathBuf, String)> = installs.iter().filter(|i| enabled.get(&i.0).is_some_and(|e| e.0)).collect();
    for (key, path, _) in &installs {
        let off = enabled.get(key).is_some_and(|e| !e.0);
        if !path.exists() && !off {
            doc.bad(defaults::render("doctor_msg.plugin_moved", &[("key", key), ("path", &path.display())]));
        }
    }
    let mut problem = false;
    if on.len() > 1 {
        problem = true;
        let keys: Vec<String> = on.iter().map(|i| i.0.clone()).collect();
        doc.bad(defaults::render("doctor_msg.plugin_double", &[("n", &on.len()), ("keys", &keys.join(", "))]));
        for (key, path, ver) in &on {
            if is_here(path) {
                continue;
            }
            let file = path.join(defaults::text("doctor.claude_hooks_file"));
            if let Ok(v) = read_json(&file)
                && thin_diff(&v, defaults::text("dispatch.default_host")).0 > 0
            {
                doc.bad(defaults::render("doctor_msg.plugin_old_node", &[("key", key), ("version", ver)]));
            }
        }
    }
    let ours = installs.iter().find(|i| is_here(&i.1)).or(if installs.len() == 1 { installs.first() } else { None });
    if let Some((key, _, reg_ver)) = ours {
        if let Some((false, f)) = enabled.get(key) {
            problem = true;
            doc.bad(defaults::render("doctor_msg.plugin_disabled", &[("key", key), ("file", f)]));
        }
        if !reg_ver.is_empty() && !version.is_empty() && crate::version_cmp(version, reg_ver) == std::cmp::Ordering::Less {
            doc.warnl(defaults::render("doctor_msg.plugin_reload", &[("registered", reg_ver), ("running", &version)]));
        } else if !reg_ver.is_empty() && !version.is_empty() && crate::version_cmp(version, reg_ver) == std::cmp::Ordering::Greater {
            doc.warnl(defaults::render("doctor_msg.plugin_registry_behind", &[("registered", reg_ver), ("running", &version)]));
        } else if !problem && enabled.get(key).is_some_and(|e| e.0) {
            doc.ok(defaults::render("doctor_msg.plugin_ok", &[("key", key), ("version", reg_ver)]));
        }
    } else if on.is_empty() && installs.iter().all(|i| enabled.get(&i.0).is_some_and(|e| !e.0)) {
        let (key, _, _) = &installs[0];
        doc.bad(defaults::render("doctor_msg.plugin_disabled", &[("key", key), ("file", &enabled.get(key).map(|e| e.1.clone()).unwrap_or_default())]));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_generated_hooks_file_is_thin_and_a_legacy_one_is_not() {
        crate::defaults::init().unwrap();
        let thin: Value = serde_json::from_str(&crate::hooksgen::hooks_json("claude")).unwrap();
        assert_eq!(thin_diff(&thin, "claude").0, 0);
        let mut legacy = thin.clone();
        legacy["hooks"]["PreToolUse"] = serde_json::json!([{"hooks":[{"type":"command","command":"node /x/hooks/git-guard.js"}]}]);
        let (n, first) = thin_diff(&legacy, "claude");
        assert!(n == 1 && first.contains("PreToolUse") && first.contains("git-guard.js"), "{n} {first}");
        assert!(thin_diff(&serde_json::json!({}), "claude").0 >= 1);
    }

    #[test]
    fn headers_are_read_from_a_defaults_file() {
        crate::defaults::init().unwrap();
        let h = headers("# c\n[a.b]\ndoc = \"x\"\n[c]\n");
        assert_eq!(h.into_iter().collect::<Vec<_>>(), vec!["a.b", "c"]);
    }
}
