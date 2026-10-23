//! Rule and settings layers: shipped, user (host) and project, merged key by key.
//!
//! Every name, limit, field list and text here is read from `defaults/layers.toml`; the file documents the layers and their safety
//! rules. In short:
//!
//! * **Host rules** (the daemon-wide set): the plugin's `engine/rules.json`, then the user's `rules.json` in the state directory
//!   (merged by rule id; it used to REPLACE the shipped file) and `<home>/<base_dir>/rules/*.toml`. The user may loosen anything
//!   but a locked rule (`layers.locked_rules`).
//! * **Project layer** (per session, found from the payload's cwd through the engine's one canonical top-level resolver): the
//!   rules in `<root>/.anti-hall/rules/*.toml` and the settings / hook sections of `hooks.project_file`. It is repository content,
//!   so it is data only, size capped, schema validated, tighten-only (a refused entry is logged and skipped), and an invalid
//!   file is ignored whole with one notice. Nothing here fails a request.
//! * The cache is keyed by project root, so two projects on one daemon never see each other's layer; the daemon-wide
//!   `defaults::*` overlay is never touched by a project.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an absent field is the empty value
// - an unreadable optional file is the same as an absent one (fail-open): the reason is reported as a notice where it matters
// A failure that must be seen goes through `crate::discard` instead.

use crate::cfgstore::ConfigError;
use crate::defaults;
use crate::hookcfg::{self, Origin};
use crate::rules::RuleSet;
use serde_json::Value as Json;
use std::collections::{BTreeMap, HashMap};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Instant;

fn lk<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// The name of a layer in a notice (`layers.origin_names`: shipped, user, project).
fn origin_name(o: Origin) -> &'static str {
    let names = defaults::list("layers.origin_names");
    names.get(match o {
        Origin::Shipped => 0,
        Origin::User => 1,
        Origin::Project => 2,
    })
    .copied()
    .unwrap_or("")
}

fn r(key: &str, args: &[(&str, &dyn std::fmt::Display)]) -> String {
    defaults::render(key, args)
}

fn ignored(path: &Path, origin: Origin, why: &str) -> String {
    r("msg.layer_ignored_file", &[("path", &path.display()), ("layer", &origin_name(origin)), ("why", &why)])
}

fn refused(path: &Path, origin: Origin, what: &str, why: &str) -> String {
    r("msg.layer_refused", &[("path", &path.display()), ("layer", &origin_name(origin)), ("what", &what), ("why", &why)])
}

/// One refused entry (or ignored file) of a layer, kept for `config explain` and the log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Notice {
    /// The rule id or setting key it is about (empty for a whole file).
    pub subject: String,
    /// The rendered message.
    pub text: String,
}

fn note(out: &mut Vec<Notice>, subject: &str, text: String) {
    out.push(Notice { subject: subject.to_string(), text });
}

fn log_notices(notes: &[Notice]) {
    for n in notes {
        crate::health::log_event(defaults::text("layers.log_kind"), "-", &n.text);
    }
}

/// Read a layer file with the caps: a plain file (a project's must not be a symlink, so it cannot point at a pipe or a file
/// outside the repository), at most `layers.max_file_bytes`. `Ok(None)` when it does not exist.
fn read_file(path: &Path, origin: Origin) -> Result<Option<String>, String> {
    let meta = if origin == Origin::Project { std::fs::symlink_metadata(path) } else { std::fs::metadata(path) };
    let meta = match meta {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    if !meta.is_file() {
        return Err(defaults::text("msg.layer_why_not_file").to_string());
    }
    let max = defaults::num("layers.max_file_bytes");
    if meta.len() > max {
        return Err(r("msg.layer_why_size", &[("max", &max)]));
    }
    let mut text = String::new();
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    file.take(max + 1).read_to_string(&mut text).map_err(|e| e.to_string())?;
    if text.len() as u64 > max {
        return Err(r("msg.layer_why_size", &[("max", &max)]));
    }
    Ok(Some(text))
}

fn action_rank(action: &str) -> Option<usize> {
    defaults::list("layers.action_rank").iter().position(|a| *a == action)
}

fn str_of<'a>(v: &'a Json, k: &str) -> &'a str {
    v.get(k).and_then(Json::as_str).unwrap_or("")
}

/// Check one rule table of a rule file and return it as JSON. The first problem is the reason the whole file is ignored.
fn check_rule(path: &Path, origin: Origin, idx: usize, v: &toml::Value) -> Result<Json, String> {
    let j = crate::cfgstore::toml_to_json(path, "rules", v).map_err(|e| e.to_string())?;
    let id = j.get("id").and_then(Json::as_str).map(str::to_string).unwrap_or_else(|| format!("#{idx}"));
    let Some(obj) = j.as_object() else { return Err(r("msg.layer_why_type", &[("id", &id), ("field", &"rules")])) };
    let allowed = defaults::list(if origin == Origin::Project { "layers.project_rule_fields" } else { "layers.rule_fields" });
    let max_len = defaults::num("layers.max_field_len") as usize;
    for (k, x) in obj {
        if !allowed.contains(&k.as_str()) {
            return Err(r("msg.layer_why_field", &[("id", &id), ("field", k)]));
        }
        let bad_type = || r("msg.layer_why_type", &[("id", &id), ("field", k)]);
        let long = || r("msg.layer_why_len", &[("id", &id), ("field", k), ("max", &max_len)]);
        match k.as_str() {
            "events" | "tools" | "paths" => {
                let a = x.as_array().ok_or_else(bad_type)?;
                for s in a {
                    if s.as_str().ok_or_else(bad_type)?.len() > max_len {
                        return Err(long());
                    }
                }
            }
            "enabled" => {
                x.as_bool().ok_or_else(bad_type)?;
            }
            "options" => {
                if !x.is_object() {
                    return Err(bad_type());
                }
            }
            _ => {
                if x.as_str().ok_or_else(bad_type)?.len() > max_len {
                    return Err(long());
                }
            }
        }
    }
    if let Some(a) = obj.get("action").and_then(Json::as_str)
        && action_rank(a).is_none()
    {
        return Err(r("msg.layer_why_action", &[("action", &a)]));
    }
    if let Some(c) = obj.get("check").and_then(Json::as_str)
        && crate::checks::get(c).is_none()
    {
        return Err(r("msg.layer_why_field", &[("id", &id), ("field", &"check")]));
    }
    let mut b = regex::RegexBuilder::new(str_of(&j, "pattern"));
    if origin == Origin::Project {
        b.size_limit(defaults::num("layers.regex_size_limit") as usize);
    }
    b.build().map_err(|e| r("msg.layer_why_regex", &[("id", &id), ("err", &e)]))?;
    Ok(j)
}

/// Parse one rule file (`[[rules]]` tables) into rule JSON.
fn parse_rule_file(path: &Path, origin: Origin, text: &str) -> Result<Vec<Json>, String> {
    let table: toml::Table = text.parse().map_err(|e: toml::de::Error| r("msg.layer_why_toml", &[("err", &e)]))?;
    if let Some(k) = table.keys().find(|k| *k != "rules") {
        return Err(r("msg.layer_why_top", &[("key", k)]));
    }
    let Some(rules) = table.get("rules") else { return Ok(vec![]) };
    let Some(arr) = rules.as_array() else { return Err(r("msg.layer_why_top", &[("key", &"rules")])) };
    let max = defaults::num("layers.max_rules") as usize;
    if arr.len() > max {
        return Err(r("msg.layer_why_count", &[("max", &max)]));
    }
    arr.iter().enumerate().map(|(i, v)| check_rule(path, origin, i, v)).collect()
}

/// The rule files of a layer's rules directory: `*<layers.rules_ext>` plain files, sorted by name, at most `layers.max_rule_files`.
fn rule_files(dir: &Path, notes: &mut Vec<Notice>, origin: Origin) -> Vec<PathBuf> {
    let Ok(rd) = std::fs::read_dir(dir) else { return vec![] };
    let ext = defaults::text("layers.rules_ext");
    let mut files: Vec<PathBuf> = rd.flatten().map(|e| e.path()).filter(|p| p.to_string_lossy().ends_with(ext)).collect();
    files.sort();
    let max = defaults::num("layers.max_rule_files") as usize;
    if files.len() > max {
        for extra in files.split_off(max) {
            note(notes, "", ignored(&extra, origin, &r("msg.layer_why_count", &[("max", &max)])));
        }
    }
    files
}

/// Read every rule file of `dir` as one layer. A file that is invalid is skipped whole (a notice), the others still apply; a
/// repeated id within the layer keeps the first.
fn load_rule_dir(dir: &Path, origin: Origin, notes: &mut Vec<Notice>) -> Vec<Json> {
    let mut out: Vec<Json> = Vec::new();
    for path in rule_files(dir, notes, origin) {
        let text = match read_file(&path, origin) {
            Ok(Some(t)) => t,
            Ok(None) => continue,
            Err(why) => {
                note(notes, "", ignored(&path, origin, &why));
                continue;
            }
        };
        match parse_rule_file(&path, origin, &text) {
            Err(why) => note(notes, "", ignored(&path, origin, &why)),
            Ok(rules) => {
                for rule in rules {
                    let id = str_of(&rule, "id").to_string();
                    if !id.is_empty() && out.iter().any(|x| str_of(x, "id") == id) {
                        note(notes, &id, refused(&path, origin, &id, defaults::text("msg.layer_why_dup")));
                    } else {
                        out.push(rule);
                    }
                }
            }
        }
    }
    out
}

/// Would applying `new` over `old` loosen the rule? `Err(reason)` when it would.
fn loosens(old: &Json, new: &Json) -> Result<(), String> {
    let id = str_of(old, "id");
    let tighten = defaults::list("layers.tighten_fields");
    let Some(obj) = new.as_object() else { return Ok(()) };
    for (k, v) in obj {
        if k == "id" {
            continue;
        }
        if k == "enabled" {
            if v.as_bool() == Some(false) && old.get("enabled").and_then(Json::as_bool) != Some(false) {
                return Err(r("msg.layer_why_loosen_off", &[("id", &id)]));
            }
            continue;
        }
        if tighten.contains(&k.as_str()) {
            if k == "action"
                && let (Some(a), Some(b)) = (action_rank(str_of(old, "action")), v.as_str().and_then(action_rank))
                && b < a
            {
                return Err(r("msg.layer_why_loosen_action", &[("id", &id), ("from", &str_of(old, "action")), ("to", &v.as_str().unwrap_or(""))]));
            }
            continue;
        }
        if old.get(k) != Some(v) {
            return Err(r("msg.layer_why_loosen_field", &[("id", &id), ("field", k)]));
        }
    }
    Ok(())
}

/// Lay `layer` over `base` (rules by id). A rule with a new id is added; a known id has the fields it names replaced. A project
/// layer (or any layer touching a locked rule) may only tighten, unless the user layer listed the id in
/// `layers.project_may_loosen` (never for a locked rule). A refusal is a notice and the entry is skipped.
fn merge_rules(base: &mut Vec<Json>, layer: Vec<Json>, origin: Origin, path: &Path, notes: &mut Vec<Notice>) {
    let locked = defaults::list("layers.locked_rules");
    let may_loosen = defaults::list("layers.project_may_loosen");
    for new in layer {
        let id = str_of(&new, "id").to_string();
        if id.is_empty() {
            if origin == Origin::Project {
                note(notes, "", refused(path, origin, &id, defaults::text("msg.layer_why_no_id")));
            } else {
                base.push(new);
            }
            continue;
        }
        let Some(i) = base.iter().position(|b| str_of(b, "id") == id) else {
            if str_of(&new, "action").is_empty() {
                note(notes, &id, refused(path, origin, &id, &r("msg.layer_why_incomplete", &[("id", &id)])));
            } else {
                base.push(new);
            }
            continue;
        };
        let tighten_only = locked.contains(&id.as_str()) || (origin == Origin::Project && !may_loosen.contains(&id.as_str()));
        if tighten_only && let Err(why) = loosens(&base[i], &new) {
            note(notes, &id, refused(path, origin, &id, &why));
            continue;
        }
        if let (Some(dst), Some(src)) = (base[i].as_object_mut(), new.as_object()) {
            for (k, v) in src {
                dst.insert(k.clone(), v.clone());
            }
        }
    }
}

// ---- host (daemon-wide) rules --------------------------------------------------------------------------------------------

/// The user's rules directory: `<home>/<base_dir>/<layers.rules_dir>`.
pub fn user_rules_dir() -> Option<PathBuf> {
    let home = defaults::env_var("home").filter(|h| !h.is_empty())?;
    Some(PathBuf::from(home).join(defaults::text("paths.base_dir")).join(defaults::text("layers.rules_dir")))
}

/// The files the host rules come from, in precedence order (lowest first): the shipped file `base`, the user's `rules.json`, the
/// files of the user's rules directory.
fn host_files(base: &Path, explicit: bool) -> Vec<PathBuf> {
    let mut v = vec![base.to_path_buf()];
    if explicit {
        return v;
    }
    v.push(crate::paths::user_rules_file());
    if let Some(d) = user_rules_dir() {
        v.extend(rule_files(&d, &mut vec![], Origin::User));
    }
    v
}

fn stat_key(p: &Path) -> String {
    use std::os::unix::fs::MetadataExt;
    match std::fs::metadata(p) {
        Ok(m) => format!("{}|{}|{}|{:?}\n", p.display(), m.len(), m.ino(), m.modified().ok()),
        Err(_) => format!("{}|-\n", p.display()),
    }
}

/// A fingerprint of every file the host rules come from; the daemon reloads when it changes.
pub fn host_fingerprint(base: &Path, explicit: bool) -> u64 {
    crate::health::fnv(&host_files(base, explicit).iter().map(|p| stat_key(p)).collect::<String>())
}

/// Load the daemon-wide rules: `base` (the shipped file; the whole set when `explicit`, a `AH_ENGINE_RULES` override), then the
/// user layers merged over it. An invalid user file is ignored with a notice. `Err` only when `base` itself cannot be read or
/// parsed: the daemon keeps the rules it has (a reload) or starts with none (a cold start).
pub fn load_host_rules(base: &Path, explicit: bool) -> Result<(RuleSet, Vec<Notice>), crate::error::RulesError> {
    let mut notes = Vec::new();
    let shipped = RuleSet::load(base)?;
    if explicit {
        return Ok((shipped, notes));
    }
    let mut merged = shipped.sources;
    let user_json = crate::paths::user_rules_file();
    match read_file(&user_json, Origin::User) {
        Ok(None) => {}
        Err(why) => note(&mut notes, "", ignored(&user_json, Origin::User, &why)),
        Ok(Some(text)) => match RuleSet::parse(&text) {
            Ok(rs) => merge_rules(&mut merged, rs.sources, Origin::User, &user_json, &mut notes),
            Err(e) => note(&mut notes, "", ignored(&user_json, Origin::User, &e.to_string())),
        },
    }
    if let Some(dir) = user_rules_dir() {
        let layer = load_rule_dir(&dir, Origin::User, &mut notes);
        merge_rules(&mut merged, layer, Origin::User, &dir, &mut notes);
    }
    let set = RuleSet::from_values(1, merged, None).unwrap_or_else(|e| {
        note(&mut notes, "", ignored(base, Origin::User, &e.to_string()));
        RuleSet::default()
    });
    log_notices(&notes);
    Ok((set, notes))
}

// ---- project layer -------------------------------------------------------------------------------------------------------

/// What one project's `.anti-hall` directory supplies, validated.
#[derive(Debug, Default)]
pub struct Project {
    /// The project root (the git top level).
    pub root: PathBuf,
    /// The rules of `rules/*.toml`.
    pub rules: Vec<Json>,
    /// The settings of `hooks.project_file` that survived the allow-list (the tighten-only check needs the value below, so it runs
    /// at resolution).
    pub settings: BTreeMap<String, Json>,
    /// The `[events.*]` / `[entries.*]` sections of `hooks.project_file`.
    pub hooks: hookcfg::Layer,
    /// Every ignored file and refused entry.
    pub notes: Vec<Notice>,
    fp: u64,
}

struct Entry {
    checked: Instant,
    used: Instant,
    project: Arc<Project>,
    /// The host set the project's rules were laid over, the user's loosening policy it was built under, and the result.
    composite: Option<(Arc<RuleSet>, u64, Arc<RuleSet>)>,
}

#[derive(Default)]
struct Cache {
    projects: HashMap<PathBuf, Entry>,
    roots: HashMap<String, (Instant, Option<PathBuf>)>,
}

fn cache() -> &'static Mutex<Cache> {
    static C: std::sync::OnceLock<Mutex<Cache>> = std::sync::OnceLock::new();
    C.get_or_init(Mutex::default)
}

/// The project root of `cwd`: the git top level the engine's canonical resolver names. `None` outside a repository, and for the
/// user's own base directory (a repository at `$HOME` must not read the user layer as a project layer).
pub fn project_root(cwd: &str) -> Option<PathBuf> {
    if cwd.is_empty() {
        return None;
    }
    let ttl = defaults::millis("layers.recheck_ms");
    if let Some((at, root)) = lk(cache()).roots.get(cwd)
        && at.elapsed() < ttl
    {
        return root.clone();
    }
    let top = crate::checks::jsport::ident::resolve_context(cwd, true, &crate::reqenv::RequestEnv::default()).toplevel.map(PathBuf::from);
    let top = top.filter(|t| defaults::env_var("home").is_none_or(|h| Path::new(&h) != t.as_path()));
    let mut c = lk(cache());
    if c.roots.len() >= defaults::num("layers.max_projects") as usize * 8 {
        c.roots.clear();
    }
    c.roots.insert(cwd.to_string(), (Instant::now(), top.clone()));
    top
}

fn project_files(root: &Path) -> (PathBuf, PathBuf) {
    let dir = root.join(defaults::text("layers.project_dir"));
    (root.join(defaults::text("hooks.project_file")), dir.join(defaults::text("layers.rules_dir")))
}

fn project_fingerprint(root: &Path) -> u64 {
    let (settings, rules_dir) = project_files(root);
    let mut s = stat_key(&settings);
    let mut names = rule_files(&rules_dir, &mut vec![], Origin::Project);
    names.sort();
    for p in names {
        s.push_str(&stat_key(&p));
    }
    crate::health::fnv(&s)
}

/// The direction (`up`, `down`, `on`, `off`, `add`) of a setting a project may set, from `layers.project_settings`.
fn direction(key: &str) -> Option<&'static str> {
    defaults::list("layers.project_settings").into_iter().find_map(|e| e.split_once(':').filter(|(k, _)| *k == key).map(|(_, d)| d))
}

fn load_project(root: &Path, fp: u64) -> Project {
    let mut p = Project { root: root.to_path_buf(), fp, ..Project::default() };
    let (file, rules_dir) = project_files(root);
    p.rules = load_rule_dir(&rules_dir, Origin::Project, &mut p.notes);
    if p.rules.len() > defaults::num("layers.max_rules") as usize {
        note(&mut p.notes, "", ignored(&rules_dir, Origin::Project, &r("msg.layer_why_count", &[("max", &defaults::num("layers.max_rules"))])));
        p.rules.clear();
    }
    match read_file(&file, Origin::Project) {
        Ok(None) => {}
        Err(why) => note(&mut p.notes, "", ignored(&file, Origin::Project, &why)),
        Ok(Some(text)) => match parse_project_file(&file, &text) {
            Err(why) => note(&mut p.notes, "", ignored(&file, Origin::Project, &why)),
            Ok((settings, hooks)) => {
                for (k, v) in settings {
                    if direction(&k).is_some() {
                        p.settings.insert(k, v);
                    } else {
                        note(&mut p.notes, &k, refused(&file, Origin::Project, &k, &r("msg.layer_why_setting_unlisted", &[("key", &k)])));
                    }
                }
                p.hooks = hooks;
            }
        },
    }
    p
}

/// The settings and hook sections of a project file; the first problem rejects the whole file.
fn parse_project_file(path: &Path, text: &str) -> Result<(BTreeMap<String, Json>, hookcfg::Layer), String> {
    let mut table: toml::Table = text.parse().map_err(|e: toml::de::Error| r("msg.layer_why_toml", &[("err", &e)]))?;
    let mut section = |name: &str| -> Result<Option<Json>, ConfigError> { table.remove(name).map(|v| crate::cfgstore::toml_to_json(path, name, &v)).transpose() };
    let (events, entries) = (section("events").map_err(|e| e.to_string())?, section("entries").map_err(|e| e.to_string())?);
    let mut settings = BTreeMap::new();
    crate::cfgstore::flatten(path, "", &table, &mut settings).map_err(|e| e.to_string())?;
    let hooks = hookcfg::parse_layer(path, Origin::Project, events.as_ref(), entries.as_ref()).map_err(|e| e.to_string())?;
    Ok((settings, hooks))
}

/// The project layer of `cwd`, loaded on first use and re-read when its files change (looked at most every
/// `layers.recheck_ms`). `None` when there is no project or it has no layer files. Never fails; problems are notices.
pub fn project(cwd: &str) -> Option<Arc<Project>> {
    let root = project_root(cwd)?;
    let recheck = defaults::millis("layers.recheck_ms");
    {
        let mut c = lk(cache());
        if let Some(e) = c.projects.get_mut(&root)
            && e.checked.elapsed() < recheck
        {
            e.used = Instant::now();
            return Some(e.project.clone());
        }
    }
    let fp = project_fingerprint(&root);
    let known = lk(cache()).projects.get(&root).map(|e| (e.project.fp, e.project.clone()));
    let project = match known {
        Some((old, p)) if old == fp => p,
        _ => {
            let p = Arc::new(load_project(&root, fp));
            log_notices(&p.notes);
            p
        }
    };
    let mut c = lk(cache());
    let keep = defaults::num("layers.max_projects") as usize;
    if c.projects.len() >= keep && !c.projects.contains_key(&root) {
        let oldest = c.projects.iter().min_by_key(|(_, e)| e.used).map(|(k, _)| k.clone());
        if let Some(k) = oldest {
            c.projects.remove(&k);
        }
    }
    let now = Instant::now();
    let composite = c.projects.get(&root).filter(|e| Arc::ptr_eq(&e.project, &project)).and_then(|e| e.composite.clone());
    c.projects.insert(root, Entry { checked: now, used: now, project: project.clone(), composite });
    Some(project)
}

/// The rules in force for a session in `cwd`: the daemon-wide set with the project's rules laid over it (tighten-only). Cheap when
/// the project has none: the shared set itself.
pub fn rules_for(cwd: &str, host: &Arc<RuleSet>) -> Arc<RuleSet> {
    let Some(p) = project(cwd) else { return host.clone() };
    if p.rules.is_empty() {
        return host.clone();
    }
    let policy = crate::health::fnv(&defaults::list("layers.project_may_loosen").join("\n"));
    if let Some(e) = lk(cache()).projects.get(&p.root)
        && let Some((h, k, c)) = &e.composite
        && Arc::ptr_eq(h, host)
        && *k == policy
    {
        return c.clone();
    }
    let mut merged = host.sources.clone();
    let mut notes = Vec::new();
    let (_, rules_dir) = project_files(&p.root);
    merge_rules(&mut merged, p.rules.clone(), Origin::Project, &rules_dir, &mut notes);
    log_notices(&notes);
    let set = match RuleSet::from_values(host.version, merged, None) {
        Ok(s) => Arc::new(s),
        Err(e) => {
            log_notices(&[Notice { subject: String::new(), text: ignored(&rules_dir, Origin::Project, &e.to_string()) }]);
            host.clone()
        }
    };
    if let Some(e) = lk(cache()).projects.get_mut(&p.root) {
        e.composite = Some((host.clone(), policy, set.clone()));
    }
    set
}

/// The project settings checked against what is below them: `value` if it is at least as strict in the listed direction (or the
/// user layer allowed the key), else the reason it was refused.
pub fn tighten_check(key: &str, value: &Json, below: &Json) -> Result<(), String> {
    if defaults::list("layers.project_may_loosen").contains(&key) {
        return Ok(());
    }
    let dir = direction(key).ok_or_else(|| r("msg.layer_why_setting_dir", &[("key", &key)]))?;
    let ok = match (dir, value, below) {
        ("up", Json::Number(a), Json::Number(b)) => a.as_i64() >= b.as_i64(),
        ("down", Json::Number(a), Json::Number(b)) => a.as_i64() <= b.as_i64(),
        ("on", Json::Bool(a), Json::Bool(b)) => *a || !*b,
        ("off", Json::Bool(a), Json::Bool(b)) => !*a || !*b,
        ("add", Json::Array(a), Json::Array(b)) => b.iter().all(|x| a.contains(x)),
        _ => false,
    };
    if ok { Ok(()) } else { Err(r("msg.layer_why_setting_loosen", &[("key", &key), ("value", &value), ("below", &below), ("dir", &dir)])) }
}

// ---- explain -------------------------------------------------------------------------------------------------------------

/// `config explain rule:<id>`: the rule as it stands after each layer (`null` when the layer has not defined it yet), the refusals
/// that name it, and the effective rule.
pub fn explain_rule(id: &str, cwd: &str) -> Option<Json> {
    let base = crate::paths::rules_file();
    let explicit = defaults::env_var("rules").is_some();
    let (host, mut notes) = load_host_rules(&base, explicit).ok()?;
    let find = |rules: &[Json]| rules.iter().find(|x| str_of(x, "id") == id).cloned();
    let shipped = RuleSet::load(&base).unwrap_or_default();
    let host = Arc::new(host);
    let project_set = project(cwd).map(|p| {
        notes.extend(p.notes.clone());
        rules_for(cwd, &host)
    });
    let effective = find(&project_set.as_ref().unwrap_or(&host).sources)?;
    let stages = [(Origin::Shipped, find(&shipped.sources)), (Origin::User, find(&host.sources)), (Origin::Project, Some(effective.clone()))];
    let layers: Vec<Json> = stages.iter().map(|(o, rule)| serde_json::json!({"layer": origin_name(*o), "rule": rule})).collect();
    let refused: Vec<&String> = notes.iter().filter(|n| n.subject == id).map(|n| &n.text).collect();
    Some(serde_json::json!({"key": id, "effective": effective, "layers": layers, "refused": refused}))
}
