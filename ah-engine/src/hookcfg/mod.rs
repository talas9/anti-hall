//! Per-event and per-entry hook configuration (D87): how the dispatcher uses each event, and which of its table entries run.
//!
//! Layers, lowest first: the shipped defaults (`hooks.event_*` / `hooks.entry_*` and any `[events.<Event>]` /
//! `[entries."<id>"]` tables in `defaults/hooks.toml` and `defaults/hooks.d/*.toml`), the project file (`hooks.project_file`
//! under the payload's cwd; it may not touch guard events or their entries), then the engine's user file (`config.toml`).
//! Each layer is parsed and validated whole when it is read: one bad key rejects the file (the previous snapshot stays when
//! the daemon reloads, the layer reads as empty at a cold start) and is reported through the existing `last_error` path.
//!
//! The guard rule: PreToolUse, PermissionRequest, Stop and SubagentStop can never be configured into a silent allow. On such
//! an event, `mode` off or shadow and `enabled = false` are errors, `max_rules` must stay 0 and an entry's `when` cannot be
//! overridden; on one of its entries, off and shadow are allowed only when the entry has a built-in check, because then its
//! Node hook still runs as the real decider (off skips only the engine's check, shadow runs it and logs whether it agrees).
pub mod session;
pub mod when;

use crate::cfgstore::ConfigError;
use crate::defaults;
use crate::dispatch::table;
use serde_json::{Map, Value as Json, json};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::OnceLock;
use when::When;

/// What a layer may be: the project file is untrusted (a repository ships it), the others are the user's own.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Origin {
    /// The shipped defaults.
    Shipped,
    /// A project file under the payload's cwd.
    Project,
    /// The engine's user file.
    User,
}

/// How an event or an entry is used.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// It decides.
    On,
    /// It runs and is logged, but never changes the outcome.
    Shadow,
    /// It is skipped.
    Off,
}

impl Mode {
    fn parse(s: &str) -> Option<Mode> {
        let known = defaults::list("hooks.modes");
        let i = known.iter().position(|m| *m == s)?;
        Some([Mode::On, Mode::Shadow, Mode::Off][i.min(2)])
    }

    /// The word the config uses for it.
    pub fn name(self) -> &'static str {
        defaults::list("hooks.modes")[match self {
            Mode::On => 0,
            Mode::Shadow => 1,
            Mode::Off => 2,
        }]
    }
}

/// The settings of one event, resolved.
#[derive(Debug, Clone, PartialEq)]
pub struct EventCfg {
    /// On, shadow or off.
    pub mode: Mode,
    /// Most entries evaluated per occurrence (0 = all).
    pub max_rules: usize,
    /// Wall budget of one occurrence in milliseconds (0 = none).
    pub budget_ms: u64,
    /// Entry ids that run and combine first, in this order.
    pub order: Vec<String>,
}

/// The settings of one entry on one event, resolved.
#[derive(Debug, Clone, PartialEq)]
pub struct EntryCfg {
    /// On, shadow or off.
    pub mode: Mode,
    /// A `when` that replaces the table row's own.
    pub when: Option<When>,
}

#[derive(Debug, Clone, Default, PartialEq)]
struct EventPatch {
    mode: Option<Mode>,
    max_rules: Option<u64>,
    budget_ms: Option<u64>,
    order: Option<Vec<String>>,
}

#[derive(Debug, Clone, Default, PartialEq)]
struct EntryPatch {
    mode: Option<Mode>,
    when: Option<(Json, When)>,
}

/// One validated layer: the `[events.*]` and `[entries.*]` tables of one file.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Layer {
    events: BTreeMap<String, EventPatch>,
    entries: BTreeMap<String, EntryPatch>,
}

impl Layer {
    /// How many events and entries the layer configures.
    pub fn len(&self) -> usize {
        self.events.len() + self.entries.len()
    }

    /// True when the layer sets nothing.
    pub fn is_empty(&self) -> bool {
        self.events.is_empty() && self.entries.is_empty()
    }

    /// The layer as JSON (what the config hash is taken over).
    pub fn to_json(&self) -> Json {
        let mut ev = Map::new();
        for (k, p) in &self.events {
            ev.insert(k.clone(), json!({"mode": p.mode.map(Mode::name), "max_rules": p.max_rules, "budget_ms": p.budget_ms, "order": p.order}));
        }
        let mut en = Map::new();
        for (k, p) in &self.entries {
            en.insert(k.clone(), json!({"mode": p.mode.map(Mode::name), "when": p.when.as_ref().map(|(j, _)| j)}));
        }
        json!({"events": ev, "entries": en})
    }
}

fn bad(path: &Path, key: &str, why: &str, args: &[(&str, &dyn std::fmt::Display)]) -> ConfigError {
    ConfigError::Hooks { path: path.to_path_buf(), key: key.to_string(), detail: defaults::render(why, args) }
}

fn why(name: &str) -> &'static str {
    defaults::raw("hooks.reasons").str_field(name)
}

fn is_guard(event: &str) -> bool {
    defaults::list("dispatch.guard_events").contains(&event)
}

/// Every event either host has a trigger for.
fn known_events() -> BTreeSet<&'static str> {
    table::hosts().into_iter().flat_map(crate::hooksgen::events).collect()
}

/// Every table entry named `id`: its event and whether it has a built-in check.
fn occurrences(id: &str, only: Option<&str>) -> Vec<(&'static str, bool)> {
    let mut out = Vec::new();
    for host in table::hosts() {
        for ev in table::events(host) {
            if only.is_some_and(|o| o != ev) {
                continue;
            }
            for e in table::entries(host, ev) {
                if e.id == id {
                    out.push((ev, e.check.is_some()));
                }
            }
        }
    }
    out
}

fn event_ids(event: &str) -> BTreeSet<String> {
    table::hosts().into_iter().flat_map(|h| table::entries(h, event)).map(|e| e.id).collect()
}

fn bound(key: &str) -> (i64, i64) {
    let e = defaults::all().iter().find(|e| e.key == key);
    (e.and_then(|e| e.min).unwrap_or(0), e.and_then(|e| e.max).unwrap_or(i64::MAX))
}

fn expect_object<'a>(path: &Path, key: &str, v: &'a Json) -> Result<&'a Map<String, Json>, ConfigError> {
    v.as_object().ok_or_else(|| bad(path, key, "hooks.msg_cfg_bad_type", &[("field", &key), ("expected", &"a table")]))
}

fn only_fields(path: &Path, key: &str, o: &Map<String, Json>, allowed: &[&str]) -> Result<(), ConfigError> {
    match o.keys().find(|k| !allowed.contains(&k.as_str())) {
        Some(k) => Err(bad(path, &format!("{key}.{k}"), "hooks.msg_cfg_unknown_field", &[("field", k), ("allowed", &allowed.join(", "))])),
        None => Ok(()),
    }
}

fn mode_of(path: &Path, key: &str, o: &Map<String, Json>) -> Result<Option<Mode>, ConfigError> {
    let enabled = match o.get("enabled") {
        None => None,
        Some(v) => Some(
            v.as_bool().ok_or_else(|| bad(path, &format!("{key}.enabled"), "hooks.msg_cfg_bad_type", &[("field", &"enabled"), ("expected", &"a boolean")]))?,
        ),
    };
    let mode = match o.get("mode") {
        None => None,
        Some(v) => {
            let s = v.as_str().ok_or_else(|| bad(path, &format!("{key}.mode"), "hooks.msg_cfg_bad_type", &[("field", &"mode"), ("expected", &"a string")]))?;
            Some(Mode::parse(s).ok_or_else(|| {
                bad(path, &format!("{key}.mode"), "hooks.msg_cfg_bad_mode", &[("value", &s), ("allowed", &defaults::list("hooks.modes").join(", "))])
            })?)
        }
    };
    Ok(if enabled == Some(false) { Some(Mode::Off) } else { mode })
}

fn number(path: &Path, key: &str, field: &str, o: &Map<String, Json>, setting: &str) -> Result<Option<u64>, ConfigError> {
    let Some(v) = o.get(field) else { return Ok(None) };
    let full = format!("{key}.{field}");
    let n = v.as_i64().ok_or_else(|| bad(path, &full, "hooks.msg_cfg_bad_type", &[("field", &field), ("expected", &"an integer")]))?;
    let (min, max) = bound(setting);
    if n < min || n > max {
        return Err(bad(path, &full, "hooks.msg_cfg_range", &[("field", &field), ("value", &n), ("min", &min), ("max", &max)]));
    }
    Ok(Some(n as u64))
}

fn parse_event(path: &Path, origin: Origin, event: &str, v: &Json) -> Result<EventPatch, ConfigError> {
    let key = format!("events.{event}");
    if !known_events().contains(event) {
        return Err(bad(path, &key, "hooks.msg_cfg_unknown_event", &[("event", &event)]));
    }
    let o = expect_object(path, &key, v)?;
    only_fields(path, &key, o, &defaults::list("hooks.event_fields"))?;
    let mode = mode_of(path, &key, o)?;
    let max_rules = number(path, &key, "max_rules", o, "hooks.event_max_rules")?;
    let budget_ms = number(path, &key, "budget_ms", o, "hooks.event_budget_ms")?;
    let order = match o.get("order") {
        None => None,
        Some(a) => {
            let ids: Vec<String> = a
                .as_array()
                .and_then(|a| a.iter().map(|x| x.as_str().map(str::to_string)).collect())
                .ok_or_else(|| bad(path, &format!("{key}.order"), "hooks.msg_cfg_bad_type", &[("field", &"order"), ("expected", &"a list of entry ids")]))?;
            let known = event_ids(event);
            if let Some(id) = ids.iter().find(|i| !known.contains(*i)) {
                return Err(bad(path, &format!("{key}.order"), "hooks.msg_cfg_unknown_order", &[("id", id), ("event", &event)]));
            }
            Some(ids)
        }
    };
    if is_guard(event) && origin != Origin::Shipped {
        if origin == Origin::Project {
            return Err(bad(path, &key, "hooks.msg_cfg_project_guard", &[("what", &event)]));
        }
        if mode.is_some_and(|m| m != Mode::On) {
            return Err(bad(path, &key, "hooks.msg_cfg_guard_event", &[("event", &event), ("what", &why("guard_mode"))]));
        }
        if max_rules.is_some_and(|n| n != 0) {
            return Err(bad(path, &key, "hooks.msg_cfg_guard_event", &[("event", &event), ("what", &why("guard_max_rules"))]));
        }
    }
    Ok(EventPatch { mode, max_rules, budget_ms, order })
}

fn parse_entry(path: &Path, origin: Origin, key_name: &str, v: &Json) -> Result<EntryPatch, ConfigError> {
    let key = format!("entries.{key_name}");
    let (only, id) = match key_name.split_once('/') {
        Some((ev, id)) if known_events().contains(ev) => (Some(ev), id),
        _ => (None, key_name),
    };
    let occ = occurrences(id, only);
    if occ.is_empty() {
        return Err(bad(path, &key, "hooks.msg_cfg_unknown_entry", &[("id", &key_name)]));
    }
    let o = expect_object(path, &key, v)?;
    only_fields(path, &key, o, &defaults::list("hooks.entry_fields"))?;
    let mode = mode_of(path, &key, o)?;
    let when = match o.get("when") {
        None => None,
        Some(w) => Some((w.clone(), When::parse(w).map_err(|e| ConfigError::Hooks { path: path.to_path_buf(), key: format!("{key}.when"), detail: e.0 })?)),
    };
    if origin != Origin::Shipped {
        for (event, has_check) in occ.iter().filter(|(ev, _)| is_guard(ev)) {
            if origin == Origin::Project {
                return Err(bad(path, &key, "hooks.msg_cfg_project_guard", &[("what", &format!("{id} on {event}"))]));
            }
            if when.is_some() {
                return Err(bad(path, &key, "hooks.msg_cfg_guard_when", &[("id", &id), ("event", event)]));
            }
            if mode.is_some_and(|m| m != Mode::On) && !has_check {
                return Err(bad(path, &key, "hooks.msg_cfg_guard_entry", &[("id", &id), ("event", event), ("what", &why("guard_mode"))]));
            }
        }
    }
    Ok(EntryPatch { mode, when })
}

/// Parse and validate the `events` and `entries` tables of one config file (as JSON; a TOML file converts to it).
pub fn parse_layer(path: &Path, origin: Origin, events: Option<&Json>, entries: Option<&Json>) -> Result<Layer, ConfigError> {
    let mut layer = Layer::default();
    if let Some(e) = events {
        for (name, v) in expect_object(path, "events", e)? {
            layer.events.insert(name.clone(), parse_event(path, origin, name, v)?);
        }
    }
    if let Some(e) = entries {
        for (name, v) in expect_object(path, "entries", e)? {
            layer.entries.insert(name.clone(), parse_entry(path, origin, name, v)?);
        }
    }
    Ok(layer)
}

/// The shipped layer: every `events.*` and `entries.*` table of the defaults.
fn shipped() -> &'static Layer {
    static L: OnceLock<Layer> = OnceLock::new();
    L.get_or_init(|| {
        let (mut ev, mut en) = (Map::new(), Map::new());
        for e in defaults::all() {
            if let Some(n) = e.key.strip_prefix("events.") {
                ev.insert(n.to_string(), e.value.to_json());
            } else if let Some(n) = e.key.strip_prefix("entries.") {
                en.insert(n.to_string(), e.value.to_json());
            }
        }
        parse_layer(Path::new("defaults/hooks.d"), Origin::Shipped, Some(&Json::Object(ev)), Some(&Json::Object(en))).unwrap_or_else(|e| panic!("{e}"))
    })
}

/// Read the project layer of `cwd` (`hooks.project_file`); `Ok(None)` when there is none.
pub fn load_project(cwd: &str) -> Result<Option<Layer>, ConfigError> {
    if cwd.is_empty() {
        return Ok(None);
    }
    let path = Path::new(cwd).join(defaults::text("hooks.project_file"));
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(ConfigError::Io { path, source: e }),
    };
    let table: toml::Table = text.parse().map_err(|e: toml::de::Error| ConfigError::Parse { path: path.clone(), message: e.to_string() })?;
    if let Some(k) = table.keys().find(|k| *k != "events" && *k != "entries") {
        return Err(ConfigError::UnknownKey { path, key: k.clone() });
    }
    let j = |k: &str| table.get(k).map(|v| crate::cfgstore::toml_to_json(&path, k, v)).transpose();
    parse_layer(&path, Origin::Project, j("events")?.as_ref(), j("entries")?.as_ref()).map(Some)
}

/// The resolved configuration of the hooks: shipped, project and user layers, and the hash of what is not default.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct HookCfg {
    project: Layer,
    user: Layer,
    hash: String,
}

impl HookCfg {
    /// Layer the project and user files over the shipped defaults.
    pub fn new(project: Option<Layer>, user: Layer) -> HookCfg {
        let project = project.unwrap_or_default();
        let hash = if project.is_empty() && user.is_empty() {
            String::new()
        } else {
            format!("{:012x}", crate::health::fnv(&json!({"project": project.to_json(), "user": user.to_json()}).to_string()) & 0xffff_ffff_ffff)
        };
        HookCfg { project, user, hash }
    }

    /// The config hash: empty when nothing but the shipped defaults applies, else a short hex digest of the layers.
    pub fn hash(&self) -> &str {
        &self.hash
    }

    /// The settings of `event`.
    pub fn event(&self, event: &str) -> EventCfg {
        let mut cfg = EventCfg {
            mode: if defaults::raw("hooks.event_enabled").as_bool().unwrap_or(true) {
                Mode::parse(defaults::text("hooks.event_mode")).unwrap_or(Mode::On)
            } else {
                Mode::Off
            },
            max_rules: defaults::num("hooks.event_max_rules") as usize,
            budget_ms: defaults::num("hooks.event_budget_ms"),
            order: defaults::list("hooks.event_order").into_iter().map(str::to_string).collect(),
        };
        for layer in [shipped(), &self.project, &self.user] {
            if let Some(p) = layer.events.get(event) {
                cfg.mode = p.mode.unwrap_or(cfg.mode);
                cfg.max_rules = p.max_rules.map_or(cfg.max_rules, |n| n as usize);
                cfg.budget_ms = p.budget_ms.unwrap_or(cfg.budget_ms);
                if let Some(o) = &p.order {
                    cfg.order = o.clone();
                }
            }
        }
        cfg
    }

    /// The settings of entry `id` on `event`.
    pub fn entry(&self, event: &str, id: &str) -> EntryCfg {
        let mut cfg = EntryCfg {
            mode: if defaults::raw("hooks.entry_enabled").as_bool().unwrap_or(true) {
                Mode::parse(defaults::text("hooks.entry_mode")).unwrap_or(Mode::On)
            } else {
                Mode::Off
            },
            when: defaults::raw("hooks.entry_when").as_table().filter(|t| !t.is_empty()).and_then(|_| When::from_v(defaults::raw("hooks.entry_when")).ok()),
        };
        let qualified = format!("{event}/{id}");
        for layer in [shipped(), &self.project, &self.user] {
            for k in [id, qualified.as_str()] {
                if let Some(p) = layer.entries.get(k) {
                    cfg.mode = p.mode.unwrap_or(cfg.mode);
                    if let Some((_, w)) = &p.when {
                        cfg.when = Some(w.clone());
                    }
                }
            }
        }
        cfg
    }

    /// Whether `event` or any of its entries is configured away from the defaults (so the dispatcher must plan, not just look up).
    pub fn is_default(&self) -> bool {
        self.hash.is_empty() && shipped().is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn layer(origin: Origin, toml_text: &str) -> Result<Layer, ConfigError> {
        let t: toml::Table = toml_text.parse().unwrap();
        let p = Path::new("t.toml");
        let j = |k: &str| t.get(k).map(|v| crate::cfgstore::toml_to_json(p, k, v).unwrap());
        parse_layer(p, origin, j("events").as_ref(), j("entries").as_ref())
    }

    fn code(r: Result<Layer, ConfigError>) -> String {
        match r {
            Ok(_) => "ok".into(),
            Err(e) => format!("{}: {e}", e.code()),
        }
    }

    #[test]
    fn the_shipped_layer_parses_and_the_generic_defaults_hold() {
        let _ = shipped();
        let c = HookCfg::default();
        let e = c.event("PostToolUse");
        assert_eq!((e.mode, e.max_rules, e.budget_ms, e.order.len()), (Mode::On, 0, 0, 0));
        assert_eq!(c.entry("PostToolUse", "git-guard:audit"), EntryCfg { mode: Mode::On, when: None });
        assert!(c.hash().is_empty() && c.is_default());
    }

    #[test]
    fn a_user_layer_overrides_a_project_layer_which_overrides_the_defaults() {
        let project =
            layer(Origin::Project, "[events.PostToolUse]\nmax_rules = 3\nbudget_ms = 100\n[entries.\"git-guard:audit\"]\nmode = \"shadow\"\n").unwrap();
        let user = layer(Origin::User, "[events.PostToolUse]\nmax_rules = 5\n[entries.\"PostToolUse/git-guard:audit\"]\nmode = \"off\"\n").unwrap();
        let c = HookCfg::new(Some(project.clone()), user);
        let e = c.event("PostToolUse");
        assert_eq!((e.max_rules, e.budget_ms), (5, 100), "user over project; project's other keys survive");
        assert_eq!(c.entry("PostToolUse", "git-guard:audit").mode, Mode::Off, "the event-qualified user key is the most specific");
        let only_project = HookCfg::new(Some(project), Layer::default());
        assert_eq!(only_project.event("PostToolUse").max_rules, 3);
        assert_eq!(only_project.entry("PostToolUse", "git-guard:audit").mode, Mode::Shadow);
        assert_eq!(c.event("SessionStart").max_rules, 0, "other events keep the defaults");
        assert!(!c.hash().is_empty() && c.hash() != only_project.hash());
    }

    #[test]
    fn enabled_false_is_the_same_as_mode_off_and_either_may_be_written() {
        let l = layer(Origin::User, "[events.PostToolUse]\nenabled = false\n[events.SessionStart]\nmode = \"shadow\"\n").unwrap();
        let c = HookCfg::new(None, l);
        assert_eq!((c.event("PostToolUse").mode, c.event("SessionStart").mode), (Mode::Off, Mode::Shadow));
    }

    #[test]
    fn validation_rejects_unknown_events_ids_fields_types_modes_and_ranges() {
        let u = |t: &str| code(layer(Origin::User, t));
        assert!(u("[events.Nope]\nmode=\"on\"\n").starts_with("hooks: ") && u("[events.Nope]\nmode=\"on\"\n").contains("not an event"));
        assert!(u("[entries.nope]\nmode=\"on\"\n").contains("not an entry"));
        assert!(u("[events.PostToolUse]\nbogus = 1\n").contains("not a field"));
        assert!(u("[events.PostToolUse]\nmode = \"loud\"\n").contains("is not one of"));
        assert!(u("[events.PostToolUse]\nmax_rules = \"3\"\n").contains("must be an integer"));
        assert!(u("[events.PostToolUse]\nmax_rules = 5000\n").contains("outside"));
        assert!(u("[events.PostToolUse]\nbudget_ms = -1\n").contains("outside"));
        assert!(u("[events.PostToolUse]\norder = [\"no-such-id\"]\n").contains("does not have"));
        assert!(u("[entries.\"git-guard:audit\"]\nwhen = { bogus = 1 }\n").contains("exactly one"));
        assert!(u("[entries.\"git-guard:audit\"]\nenabled = \"yes\"\n").contains("a boolean"));
        assert_eq!(u("[events.PostToolUse]\norder = [\"git-guard:audit\", \"output-verify-guard\"]\nmax_rules = 2\n"), "ok");
        assert_eq!(u("[entries.\"git-guard:audit\"]\nwhen = { tool = \"Bash\" }\nmode = \"shadow\"\n"), "ok");
    }

    #[test]
    fn a_guard_event_can_never_be_configured_into_a_silent_allow() {
        let u = |t: &str| code(layer(Origin::User, t));
        for ev in ["PreToolUse", "PermissionRequest", "Stop", "SubagentStop"] {
            assert!(u(&format!("[events.{ev}]\nmode = \"off\"\n")).contains("guard event"), "{ev} off");
            assert!(u(&format!("[events.{ev}]\nmode = \"shadow\"\n")).contains("guard event"), "{ev} shadow");
            assert!(u(&format!("[events.{ev}]\nenabled = false\n")).contains("guard event"), "{ev} disabled");
            assert!(u(&format!("[events.{ev}]\nmax_rules = 1\n")).contains("max_rules"), "{ev} max_rules");
            assert_eq!(u(&format!("[events.{ev}]\nmode = \"on\"\nmax_rules = 0\nbudget_ms = 500\n")), "ok", "{ev}: a budget is allowed (it fails closed)");
        }
        // an entry with no built-in check decides only through its Node hook: it cannot be turned off or shadowed
        assert!(u("[entries.\"merge-gate\"]\nmode = \"off\"\n").contains("only through its Node hook"));
        assert!(u("[entries.\"PreToolUse/merge-gate\"]\nenabled = false\n").contains("only through its Node hook"));
        // an entry with a built-in check keeps its Node hook as the real decider, so off and shadow are allowed
        assert_eq!(u("[entries.\"PreToolUse/git-guard\"]\nmode = \"shadow\"\n"), "ok");
        assert_eq!(u("[entries.\"PreToolUse/git-guard\"]\nmode = \"off\"\n"), "ok");
        assert!(u("[entries.\"PreToolUse/git-guard\"]\nwhen = { tool = \"Bash\" }\n").contains("only come from the dispatch table"));
        // a non-guard event and its entries are free
        assert_eq!(u("[events.PostToolUse]\nmode = \"off\"\n[entries.\"output-verify-guard\"]\nmode = \"off\"\n"), "ok");
    }

    #[test]
    fn a_project_file_may_not_touch_guard_events_or_their_entries() {
        let p = |t: &str| code(layer(Origin::Project, t));
        assert!(p("[events.PreToolUse]\nbudget_ms = 100\n").contains("project file"));
        assert!(p("[entries.\"PreToolUse/git-guard\"]\nmode = \"shadow\"\n").contains("project file"));
        assert!(p("[entries.\"git-guard\"]\nmode = \"shadow\"\n").contains("project file"), "a bare id that is also a guard entry");
        assert_eq!(p("[events.PostToolUse]\nmax_rules = 2\n[entries.\"output-verify-guard\"]\nmode = \"off\"\n"), "ok");
    }

    #[test]
    fn the_project_file_is_read_from_the_payload_cwd_and_a_missing_one_is_none() {
        let d = std::env::temp_dir().join(format!("ah-hookcfg-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join(".anti-hall")).unwrap();
        assert_eq!(load_project(d.to_str().unwrap()).unwrap(), None);
        std::fs::write(d.join(defaults::text("hooks.project_file")), "[events.PostToolUse]\nmax_rules = 2\n").unwrap();
        let l = load_project(d.to_str().unwrap()).unwrap().unwrap();
        assert_eq!(HookCfg::new(Some(l), Layer::default()).event("PostToolUse").max_rules, 2);
        std::fs::write(d.join(defaults::text("hooks.project_file")), "other = 1\n").unwrap();
        assert_eq!(load_project(d.to_str().unwrap()).unwrap_err().code(), "unknown_key");
        std::fs::write(d.join(defaults::text("hooks.project_file")), "[events.PreToolUse]\nmode = \"off\"\n").unwrap();
        assert_eq!(load_project(d.to_str().unwrap()).unwrap_err().code(), "hooks");
        let _ = std::fs::remove_dir_all(&d);
    }
}
