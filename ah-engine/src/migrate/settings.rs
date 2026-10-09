//! The settings store of the Node plugin (`hooks/lib/settings.js`, `~/.anti-hall/settings.json`) as far as the forward
//! migrations need it: resolve a setting through its precedence chain, validate and write one, and move the values that used to
//! live elsewhere (the legacy `jev.json`, the old per-integration keys, the plugin options the host stored) into the file.
//!
//! The schema is the plugin's `engine/defaults/migrate_settings.toml`, generated from `settings-schema.js` (`parity/gen-migrate-schema.js`; a test
//! fails when they differ). The migration never overwrites a value already set, never deletes a legacy file, and a corrupt
//! `settings.json` is renamed aside (never deleted) before the write starts from an empty store.
use super::{Ctx, Row, is_object, j_number, j_strict_eq, j_string, parse_json, read_json_note, read_markers, read_text_note, write_atomic};
use crate::checks::guardkit::nodelock;
use crate::checks::guardkit::text::js_trim;
use crate::checks::jsport::json::{self, J};
use crate::checks::jsport::{date, num};
use crate::defaults;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// One entry of the settings schema.
#[derive(Debug, Clone)]
pub(crate) struct Entry {
    pub section: String,
    pub key: String,
    pub ty: String,
    pub default: Option<J>,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub exclusive_min: Option<f64>,
    pub reject_below_min: bool,
    pub values: Vec<String>,
    pub env: Option<String>,
    pub env_aliases: Vec<String>,
    pub plugin_option: Option<String>,
    pub headline: bool,
    pub home_only: bool,
    pub locked: bool,
    pub safety_direction: Option<String>,
    pub legacy_file: Option<String>,
    pub legacy_key: Option<String>,
}

fn entry_of(v: &serde_json::Value) -> Entry {
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).map(str::to_string);
    let f = |k: &str| v.get(k).and_then(|x| x.as_f64());
    let b = |k: &str| v.get(k).and_then(|x| x.as_bool()).unwrap_or(false);
    let list = |k: &str| v.get(k).and_then(|x| x.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default();
    let default = v.get("default").map(|d| match d {
        serde_json::Value::Bool(x) => J::Bool(*x),
        serde_json::Value::Number(n) => J::Num(n.as_f64().unwrap_or(f64::NAN)),
        serde_json::Value::String(x) => J::Str(x.clone()),
        _ => J::Null,
    });
    Entry {
        section: s("section").unwrap_or_default(),
        key: s("key").unwrap_or_default(),
        ty: s("type").unwrap_or_default(),
        default,
        min: f("min"),
        max: f("max"),
        exclusive_min: f("exclusiveMin"),
        reject_below_min: b("rejectBelowMin"),
        values: list("values"),
        env: s("env"),
        env_aliases: list("envAliases"),
        plugin_option: s("pluginOption"),
        headline: b("headline"),
        home_only: b("homeOnly"),
        locked: b("locked"),
        safety_direction: s("safetyDirection"),
        legacy_file: s("legacyFile"),
        legacy_key: s("legacyKey"),
    }
}

/// Every schema entry, in schema order.
pub(crate) fn entries() -> &'static [Entry] {
    static ALL: OnceLock<Vec<Entry>> = OnceLock::new();
    ALL.get_or_init(|| {
        defaults::list("migrate.settings_schema").iter().filter_map(|t| serde_json::from_str::<serde_json::Value>(t).ok()).map(|v| entry_of(&v)).collect()
    })
}

/// `findSetting(section, key)`.
pub(crate) fn find(section: &str, key: &str) -> Option<&'static Entry> {
    entries().iter().find(|e| e.section == section && e.key == key)
}

// ---- reading ----------------------------------------------------------------------------------------------------------

pub(crate) fn settings_path(ctx: &Ctx) -> PathBuf {
    ctx.base().join(defaults::text("migrate.settings_file"))
}

/// `load()`: the settings object, `{}` when the file is missing, unreadable or not an object.
pub(crate) fn load(ctx: &Ctx) -> J {
    match read_json_note(ctx, &settings_path(ctx)) {
        Some(j @ J::Obj(_)) => j,
        _ => J::Obj(Vec::new()),
    }
}

/// `lookup(obj, key)`: the flat own key, else the nested path for a dotted key.
pub(crate) fn lookup<'a>(obj: Option<&'a J>, key: &str) -> Option<&'a J> {
    let obj = obj?;
    if !matches!(obj, J::Obj(_) | J::Arr(_)) {
        return None;
    }
    if let Some(v) = obj.get(key) {
        return Some(v);
    }
    if !key.contains('.') {
        return None;
    }
    let mut cur = obj;
    for part in key.split('.') {
        match cur {
            J::Obj(_) => cur = cur.get(part)?,
            _ => return None,
        }
    }
    Some(cur)
}

fn bool_token(s: &str) -> Option<bool> {
    let v = js_trim(s).to_lowercase();
    // `String(raw).toLowerCase().trim()`: the order of the two does not matter for these ASCII tokens
    let t = v.trim();
    if defaults::list("guardkit.true_tokens").contains(&t) {
        Some(true)
    } else if defaults::list("guardkit.false_tokens").contains(&t) {
        Some(false)
    } else {
        None
    }
}

/// `coerceValue(entry, raw)`: the typed value, or `None` when `raw` cannot be read as the entry's type.
pub(crate) fn coerce_value(entry: &Entry, raw: Option<&J>) -> Option<J> {
    let raw = raw?;
    if matches!(raw, J::Null) {
        return None;
    }
    if entry.ty == "object" {
        return matches!(raw, J::Obj(o) if !o.is_empty()).then(|| raw.clone());
    }
    if !matches!(raw, J::Str(_) | J::Num(_) | J::Bool(_)) {
        return None;
    }
    let trimmed = match raw {
        J::Str(s) => J::Str(js_trim(s).to_string()),
        other => other.clone(),
    };
    if matches!(&trimmed, J::Str(s) if s.is_empty()) {
        return None;
    }
    match entry.ty.as_str() {
        "boolean" => match &trimmed {
            J::Bool(b) => Some(J::Bool(*b)),
            other => bool_token(&j_string(other)).map(J::Bool),
        },
        "number" => {
            if matches!(trimmed, J::Bool(_)) {
                return None;
            }
            let mut n = j_number(&trimmed);
            if !n.is_finite() {
                return None;
            }
            if entry.exclusive_min.is_some_and(|m| n <= m) {
                return None;
            }
            if entry.reject_below_min && entry.min.is_some_and(|m| n < m) {
                return None;
            }
            if let Some(m) = entry.min.filter(|m| n < *m) {
                n = m;
            }
            if let Some(m) = entry.max.filter(|m| n > *m) {
                n = m;
            }
            Some(J::Num(n))
        }
        "enum" => {
            let v = j_string(&trimmed).to_lowercase();
            entry.values.contains(&v).then_some(J::Str(v))
        }
        "csv" | "string" => Some(J::Str(j_string(&trimmed))),
        _ => Some(trimmed),
    }
}

fn env_str(ctx: &Ctx, name: &str) -> Option<J> {
    ctx.env.get(name).map(|v| J::Str(v.clone()))
}

/// `readEnvOverride`.
pub(crate) fn read_env_override(ctx: &Ctx, entry: &Entry) -> Option<J> {
    let name = entry.env.as_deref().filter(|_| !entry.home_only)?;
    let mut v = coerce_value(entry, env_str(ctx, name).as_ref());
    if v.is_none() {
        for alias in &entry.env_aliases {
            v = coerce_value(entry, env_str(ctx, alias).as_ref());
            if v.is_some() {
                break;
            }
        }
    }
    v
}

/// `readStoredPluginOptions`: the answers the host stored for this plugin, flat and nested forms merged; `None` when none.
pub(crate) fn stored_plugin_options(ctx: &Ctx) -> Option<J> {
    let raw = read_json_note(ctx, &Path::new(&ctx.home).join(defaults::text("migrate.host_settings_file")))?;
    let map = raw.get("pluginConfigs")?;
    if !matches!(map, J::Obj(_) | J::Arr(_)) {
        return None;
    }
    let mut out: Option<J> = None;
    for k in defaults::list("migrate.plugin_config_keys") {
        let Some(e) = map.get(k).filter(|e| is_object(e)) else { continue };
        let o = out.get_or_insert_with(|| J::Obj(Vec::new()));
        if let Some(J::Obj(members)) = e.get("options") {
            for (n, v) in members {
                o.set(n, v.clone());
            }
        }
        if let J::Obj(members) = e {
            for (n, v) in members {
                if n != "options" {
                    o.set(n, v.clone());
                }
            }
        }
    }
    out
}

/// The default the manifest declares for a headline option (`userConfig[option].default`), `None` when it declares none.
fn manifest_default(ctx: &Ctx, entry: &Entry, plugin_root: Option<&str>) -> Option<J> {
    let option = entry.plugin_option.as_deref()?;
    let root = plugin_root?;
    let pj = read_json_note(ctx, &Path::new(root).join(defaults::text("migrate.plugin_manifest")))?;
    let d = pj.get("userConfig")?.get(option)?.get("default")?.clone();
    Some(d)
}

/// `readPluginOption`: the value of the entry's plugin option unless it equals the entry's default, which the host exports even
/// when the person never touched it and which must not mask a lower tier.
pub(crate) fn read_plugin_option(ctx: &Ctx, entry: &Entry) -> Option<J> {
    let option = entry.plugin_option.as_deref().filter(|_| !entry.home_only)?;
    let env_name = format!("{}{}", defaults::text("migrate.plugin_option_env_prefix"), option.to_uppercase());
    let manifest_default =
        if entry.headline { manifest_default(ctx, entry, ctx.plugin_root.as_deref()) } else { entry.default.clone().filter(|d| !matches!(d, J::Null)) };
    let is_default = |raw: &J| manifest_default.as_ref().is_some_and(|d| j_string(raw) == j_string(d));
    if let Some(v) = ctx.env.get(&env_name) {
        let raw = J::Str(v.clone());
        return if is_default(&raw) { None } else { coerce_value(entry, Some(&raw)) };
    }
    let opt = stored_plugin_options(ctx)?;
    let raw = opt.get(option)?;
    if is_default(raw) { None } else { coerce_value(entry, Some(raw)) }
}

/// `readLegacy`: the entry's value in its legacy file (`~/.anti-hall/jev.json` and the like).
pub(crate) fn read_legacy(ctx: &Ctx, entry: &Entry) -> Option<J> {
    let file = entry.legacy_file.as_deref().filter(|_| !entry.home_only)?;
    let raw = read_json_note(ctx, &ctx.base().join(file))?;
    if !matches!(raw, J::Obj(_) | J::Arr(_)) {
        return None;
    }
    coerce_value(entry, lookup(Some(&raw), entry.legacy_key.as_deref()?))
}

/// `settingsMigrationStamped`: the settings forward-migration is marked complete for the running plugin version.
pub(crate) fn migration_stamped(ctx: &Ctx) -> bool {
    super::is_applied(&read_markers(ctx), defaults::text("migrate.settings_marker_key"), ctx.version.as_deref())
}

/// `get(section, key, dflt)`: the effective value, walking the precedence chain: environment, `settings.json`, the tiers below
/// the file (plugin option and legacy file, in the order the migration stamp decides), then `dflt`, then the schema default.
pub(crate) fn get(ctx: &Ctx, entry: &Entry, dflt: Option<&J>) -> Option<J> {
    if let Some(v) = read_env_override(ctx, entry) {
        return Some(v);
    }
    let store = load(ctx);
    if let Some(v) = coerce_value(entry, lookup(store.get(&entry.section), &entry.key)) {
        return Some(v);
    }
    below_file(ctx, entry, dflt)
}

/// `resolveBelowFile(entry, dflt)`: what the tiers below `settings.json` (plugin option, legacy file, default) resolve to.
pub(crate) fn below_file(ctx: &Ctx, entry: &Entry, dflt: Option<&J>) -> Option<J> {
    let fallback = || dflt.cloned().or_else(|| entry.default.clone());
    if entry.home_only {
        return fallback();
    }
    let legacy_first = entry.legacy_file.is_some() && !migration_stamped(ctx);
    if legacy_first && let Some(v) = read_legacy(ctx, entry) {
        return Some(v);
    }
    if let Some(v) = read_plugin_option(ctx, entry) {
        return Some(v);
    }
    if !legacy_first && let Some(v) = read_legacy(ctx, entry) {
        return Some(v);
    }
    fallback()
}

// ---- writing ----------------------------------------------------------------------------------------------------------

/// `validate(entry, value)`: the coerced value, or why it is not acceptable.
fn validate(entry: &Entry, value: &J) -> Option<J> {
    match entry.ty.as_str() {
        // file-only: it cannot be set through `set()`
        "object" => None,
        "boolean" => match value {
            J::Bool(b) => Some(J::Bool(*b)),
            other => bool_token(&j_string(other)).filter(|_| !matches!(other, J::Null)).map(J::Bool),
        },
        "number" => {
            let n = j_number(value);
            let bad = !n.is_finite() || entry.min.is_some_and(|m| n < m) || entry.max.is_some_and(|m| n > m) || entry.exclusive_min.is_some_and(|m| n <= m);
            (!bad).then_some(J::Num(n))
        }
        "enum" => {
            let v = j_string(value);
            entry.values.contains(&v).then_some(J::Str(v))
        }
        _ => Some(J::Str(j_string(value))),
    }
}

/// `JSON.stringify(v, null, 2)`.
pub(crate) fn pretty(v: &J) -> String {
    fn go(v: &J, depth: usize, out: &mut String) {
        let pad = "  ".repeat(depth + 1);
        let end = "  ".repeat(depth);
        match v {
            J::Obj(o) if !o.is_empty() => {
                out.push_str("{\n");
                for (i, (k, x)) in o.iter().enumerate() {
                    out.push_str(&pad);
                    out.push_str(&json::quote(k));
                    out.push_str(": ");
                    go(x, depth + 1, out);
                    out.push_str(if i + 1 < o.len() { ",\n" } else { "\n" });
                }
                out.push_str(&end);
                out.push('}');
            }
            J::Arr(a) if !a.is_empty() => {
                out.push_str("[\n");
                for (i, x) in a.iter().enumerate() {
                    out.push_str(&pad);
                    go(x, depth + 1, out);
                    out.push_str(if i + 1 < a.len() { ",\n" } else { "\n" });
                }
                out.push_str(&end);
                out.push(']');
            }
            other => out.push_str(&json::stringify(other)),
        }
    }
    let mut s = String::new();
    go(v, 0, &mut s);
    s
}

/// The outcome of a `set`.
pub(crate) struct Set {
    pub ok: bool,
    pub skipped: bool,
}

/// `backupCorruptIfNeeded`: a settings file that exists but does not parse to an object is renamed aside (never deleted).
pub(crate) fn backup_corrupt(ctx: &Ctx) {
    let file = settings_path(ctx);
    let Some(raw) = read_text_note(ctx, &file) else { return };
    if parse_json(&raw).is_some_and(|j| is_object(&j)) {
        return;
    }
    let mut to = file.as_os_str().to_os_string();
    to.push(format!("{}{}", defaults::text("migrate.corrupt_infix"), num::to_js_string(date::now_ms())));
    if let Err(e) = std::fs::rename(&file, PathBuf::from(to)) {
        ctx.io_note("rename", &file, &e);
    }
}

pub(crate) fn csv_tokens(v: &str) -> Vec<String> {
    v.split([',', ':']).map(|s| js_trim(s).to_string()).filter(|s| !s.is_empty()).collect()
}

/// `isRiskyChange(entry, value, current)`: the change that weakens a safety guard.
pub(crate) fn is_risky(entry: &Entry, value: &J, current: Option<&J>) -> bool {
    match entry.safety_direction.as_deref().unwrap_or("off") {
        "on" => matches!(value, J::Bool(true)),
        "change" => !j_strict_eq(Some(value), current),
        "add" => {
            let cur: Vec<String> = csv_tokens(&current.map(j_string).unwrap_or_default());
            csv_tokens(&j_string(value)).iter().any(|t| !cur.contains(t))
        }
        _ => matches!(value, J::Bool(false)),
    }
}

/// `set(section, key, value, {home, guard, confirmed})`: validate, then read-modify-write the whole file under the settings
/// lock, every other key untouched, atomically.
pub(crate) fn set(ctx: &Ctx, section: &str, key: &str, value: &J, guard: Option<&dyn Fn(&J) -> bool>, confirmed: bool) -> Set {
    let fail = Set { ok: false, skipped: false };
    let Some(entry) = find(section, key) else { return fail };
    let Some(v) = validate(entry, value) else { return fail };
    let file = settings_path(ctx);
    let mut lock_path = file.as_os_str().to_os_string();
    lock_path.push(defaults::text("migrate.settings_lock_suffix"));
    let params = nodelock::Params {
        stale_ms: defaults::num("migrate.settings_lock_stale_ms"),
        wait_ms: defaults::num("migrate.settings_lock_wait_ms"),
        step_ms: defaults::num("migrate.settings_lock_step_ms"),
        ..nodelock::Params::swarm()
    };
    let Some(held) = nodelock::acquire(&lock_path.to_string_lossy(), params) else {
        ctx.note(defaults::render("migrate_msg.note_lock_busy", &[("path", &file.display())]));
        return fail;
    };
    let result = (|| {
        backup_corrupt(ctx);
        let store = load(ctx);
        if let Some(g) = guard
            && !g(&store)
        {
            return Set { ok: true, skipped: true };
        }
        if entry.locked {
            let current = get(ctx, entry, None);
            if is_risky(entry, &v, current.as_ref()) && !confirmed {
                return fail_set();
            }
        }
        let mut next = store.clone();
        let mut sec = match store.get(section) {
            Some(s @ J::Obj(_)) => s.clone(),
            _ => J::Obj(Vec::new()),
        };
        sec.set(key, v);
        next.set(section, sec);
        if let Some(dir) = file.parent()
            && let Err(e) = std::fs::create_dir_all(dir)
        {
            ctx.io_note("mkdir", dir, &e);
            return fail_set();
        }
        match write_atomic(&file, &(pretty(&next) + "\n")) {
            Ok(()) => Set { ok: true, skipped: false },
            Err(e) => {
                ctx.io_note("open", &file, &e);
                fail_set()
            }
        }
    })();
    held.release();
    result
}

fn fail_set() -> Set {
    Set { ok: false, skipped: false }
}

// ---- the operator command (`ah-engine settings`) ----------------------------------------------------------------------------

/// `source(section, key)`: the tier the effective value comes from (`env`, `file`, `plugin-option`, `legacy`, `default`).
pub(crate) fn source(ctx: &Ctx, entry: &Entry) -> &'static str {
    if read_env_override(ctx, entry).is_some() {
        return "env";
    }
    let store = load(ctx);
    if coerce_value(entry, lookup(store.get(&entry.section), &entry.key)).is_some() {
        return "file";
    }
    let legacy_first = entry.legacy_file.is_some() && !migration_stamped(ctx);
    if legacy_first && read_legacy(ctx, entry).is_some() {
        return "legacy";
    }
    if read_plugin_option(ctx, entry).is_some() {
        return "plugin-option";
    }
    if !legacy_first && read_legacy(ctx, entry).is_some() {
        return "legacy";
    }
    "default"
}

/// `validate(entry, value)` with the reason spelled as the CLI prints it.
pub(crate) fn validate_msg(entry: &Entry, value: &J) -> Result<J, String> {
    let got = || json::quote(&j_string(value));
    match entry.ty.as_str() {
        "object" => Err(defaults::text("ops.set_err_object").to_string()),
        "boolean" => match value {
            J::Bool(b) => Ok(J::Bool(*b)),
            other => bool_token(&j_string(other))
                .filter(|_| !matches!(other, J::Null))
                .map(J::Bool)
                .ok_or_else(|| defaults::render("ops.set_err_bool", &[("got", &got())])),
        },
        "number" => {
            let n = j_number(value);
            if !n.is_finite() {
                return Err(defaults::render("ops.set_err_number", &[("got", &got())]));
            }
            if let Some(m) = entry.min.filter(|m| n < *m) {
                return Err(defaults::render("ops.set_err_min", &[("bound", &num::to_js_string(m))]));
            }
            if let Some(m) = entry.max.filter(|m| n > *m) {
                return Err(defaults::render("ops.set_err_max", &[("bound", &num::to_js_string(m))]));
            }
            if let Some(m) = entry.exclusive_min.filter(|m| n <= *m) {
                return Err(defaults::render("ops.set_err_exclusive_min", &[("bound", &num::to_js_string(m))]));
            }
            Ok(J::Num(n))
        }
        "enum" => {
            let v = j_string(value);
            if entry.values.contains(&v) {
                Ok(J::Str(v))
            } else {
                Err(defaults::render("ops.set_err_enum", &[("values", &entry.values.join(defaults::text("ops.list_sep")))]))
            }
        }
        _ => Ok(J::Str(j_string(value))),
    }
}

/// `safetyWarning(entry, value, currentValue)`; `note` is the schema's `safetyNote` (empty when it has none).
pub(crate) fn safety_warning(entry: &Entry, note: &str, value: &J, current: Option<&J>) -> String {
    let note = if note.is_empty() { defaults::text("ops.safety_note_default") } else { note };
    let dir = entry.safety_direction.as_deref().unwrap_or("off");
    let guard = {
        let mut o = String::new();
        for c in entry.key.chars() {
            if c.is_ascii_uppercase() {
                o.push('-');
            }
            o.push(c);
        }
        o.to_lowercase()
    };
    if dir == "add" {
        let cur: Vec<String> = csv_tokens(&current.map(truthy_string).unwrap_or_default());
        let added: Vec<String> = csv_tokens(&truthy_string(value)).into_iter().filter(|t| !cur.contains(t)).collect();
        let list = if added.is_empty() { j_string(value) } else { added.join(defaults::text("ops.list_sep")) };
        return defaults::render("ops.safety_add", &[("list", &list), ("note", &note)]);
    }
    if dir == "change" {
        return defaults::render("ops.safety_change", &[("guard", &guard), ("note", &note)]);
    }
    let verb = if dir == "on" { defaults::text("ops.safety_verb_on") } else { defaults::text("ops.safety_verb_off") };
    defaults::render("ops.safety_turn", &[("verb", &verb), ("guard", &guard), ("note", &note)])
}

/// `String(v || '')`.
fn truthy_string(v: &J) -> String {
    let falsy = match v {
        J::Null => true,
        J::Bool(b) => !b,
        J::Num(n) => *n == 0.0 || n.is_nan(),
        J::Str(s) => s.is_empty(),
        _ => false,
    };
    if falsy { String::new() } else { j_string(v) }
}

/// What a `set` or `reset` of the operator command came to.
pub(crate) enum Outcome {
    /// Written (or nothing to write).
    Done,
    /// A safety key needs `--confirmed`; the warning to show.
    Needs(String),
    /// Refused, with the reason.
    Fail(String),
    /// The settings lock is held by a live writer past the wait budget: the Node command reports the holder's pid, which the
    /// engine cannot reproduce, so the caller defers.
    LockBusy,
}

fn with_lock(ctx: &Ctx, f: impl FnOnce() -> Outcome) -> Outcome {
    let file = settings_path(ctx);
    let mut lock_path = file.as_os_str().to_os_string();
    lock_path.push(defaults::text("migrate.settings_lock_suffix"));
    let params = nodelock::Params {
        stale_ms: defaults::num("migrate.settings_lock_stale_ms"),
        wait_ms: defaults::num("migrate.settings_lock_wait_ms"),
        step_ms: defaults::num("migrate.settings_lock_step_ms"),
        ..nodelock::Params::swarm()
    };
    let Some(held) = nodelock::acquire(&lock_path.to_string_lossy(), params) else { return Outcome::LockBusy };
    let r = f();
    held.release();
    r
}

fn write_store(ctx: &Ctx, next: &J) -> Outcome {
    let file = settings_path(ctx);
    if let Some(dir) = file.parent()
        && let Err(e) = std::fs::create_dir_all(dir)
    {
        return Outcome::Fail(js_message(&e, "mkdir", dir));
    }
    match write_atomic(&file, &(pretty(next) + "\n")) {
        Ok(()) => Outcome::Done,
        Err(e) => Outcome::Fail(js_message(&e, "open", &file)),
    }
}

/// `e.message` of the Node error for a failed file call.
fn js_message(e: &std::io::Error, syscall: &str, path: &Path) -> String {
    super::node_err(e, syscall, path)
}

/// `settings.set(section, key, rawValue, {confirmed})` as the command runs it.
pub(crate) fn set_cli(ctx: &Ctx, entry: &Entry, note: &str, raw: &str, confirmed: bool) -> Outcome {
    let v = match validate_msg(entry, &J::Str(raw.to_string())) {
        Ok(v) => v,
        Err(m) => return Outcome::Fail(m),
    };
    with_lock(ctx, || {
        backup_corrupt(ctx);
        let store = load(ctx);
        if entry.locked {
            let current = get(ctx, entry, None);
            if is_risky(entry, &v, current.as_ref()) && !confirmed {
                return Outcome::Needs(safety_warning(entry, note, &v, current.as_ref()));
            }
        }
        let mut next = store.clone();
        let mut sec = match store.get(&entry.section) {
            Some(s @ J::Obj(_)) => s.clone(),
            _ => J::Obj(Vec::new()),
        };
        sec.set(&entry.key, v);
        next.set(&entry.section, sec);
        write_store(ctx, &next)
    })
}

/// `settings.reset(section, key, {confirmed})`: drop the `settings.json` override of one key.
pub(crate) fn reset_cli(ctx: &Ctx, entry: &Entry, note: &str, confirmed: bool) -> Outcome {
    with_lock(ctx, || {
        backup_corrupt(ctx);
        let store = load(ctx);
        let has = store.get(&entry.section).is_some_and(|s| s.get(&entry.key).is_some());
        if entry.locked && !confirmed && has {
            let current = get(ctx, entry, None);
            let after = read_env_override(ctx, entry).or_else(|| below_file(ctx, entry, None));
            let changes = entry.safety_direction.as_deref() == Some("add") || !j_strict_eq(after.as_ref(), current.as_ref());
            let after_v = after.clone().unwrap_or(J::Null);
            if changes && is_risky(entry, &after_v, current.as_ref()) {
                return Outcome::Needs(safety_warning(entry, note, &after_v, current.as_ref()));
            }
        }
        if !has {
            return Outcome::Done;
        }
        let mut next = store.clone();
        let mut sec = match store.get(&entry.section) {
            Some(J::Obj(members)) => members.iter().filter(|(k, _)| *k != entry.key).cloned().collect::<Vec<_>>(),
            _ => Vec::new(),
        };
        if sec.is_empty() {
            if let J::Obj(m) = &mut next {
                m.retain(|(k, _)| *k != entry.section);
            }
        } else {
            next.set(&entry.section, J::Obj(std::mem::take(&mut sec)));
        }
        write_store(ctx, &next)
    })
}

// ---- the forward migrations -------------------------------------------------------------------------------------------

/// `migrateJevIntegrationsSection`: the old `jev["integrations.<id>"]` values into `jevIntegrations.<id>`, never over a value
/// already there; the old key is left in place.
fn migrate_integrations(ctx: &Ctx) -> (u64, u64) {
    let (mut migrated, mut errors) = (0, 0);
    let store = load(ctx);
    let old = store.get(defaults::text("migrate.settings_section_jev")).cloned().unwrap_or(J::Obj(Vec::new()));
    let new_section = defaults::text("migrate.settings_section_integrations");
    for id in defaults::list("migrate.jev_integration_ids") {
        if lookup(store.get(new_section), id).is_some() {
            continue;
        }
        let Some(val) = lookup(Some(&old), &format!("{}{id}", defaults::text("migrate.integrations_key_prefix"))) else { continue };
        if set(ctx, new_section, id, val, None, false).ok {
            migrated += 1;
        } else {
            errors += 1;
        }
    }
    (migrated, errors)
}

/// `migrateLegacyPluginOptions`: the plugin options the host stored, copied into `settings.json` when each is the value in
/// effect now (so the migration never changes what a setting resolves to).
fn migrate_plugin_options(ctx: &Ctx) -> (u64, u64) {
    let (mut migrated, mut errors) = (0, 0);
    let Some(opt) = stored_plugin_options(ctx) else { return (0, 0) };
    for entry in entries() {
        let Some(option) = entry.plugin_option.as_deref() else { continue };
        if entry.headline || entry.home_only {
            continue;
        }
        let Some(stored) = opt.get(option) else { continue };
        if entry.default.as_ref().is_some_and(|d| !matches!(d, J::Null) && j_string(stored) == j_string(d)) {
            continue;
        }
        let Some(v) = validate(entry, stored) else { continue };
        let guard = |store: &J| lookup(store.get(&entry.section), &entry.key).is_none() && j_strict_eq(get(ctx, entry, None).as_ref(), Some(&v));
        let r = set(ctx, &entry.section, &entry.key, &v, Some(&guard), entry.locked);
        if !r.ok {
            errors += 1;
        } else if !r.skipped {
            migrated += 1;
        }
    }
    (migrated, errors)
}

/// `migrateSettingsFromLegacy`: the legacy files' values, then the plugin options, into `settings.json`.
fn migrate_from_legacy(ctx: &Ctx) -> (bool, u64, u64) {
    let (mut migrated, mut errors) = migrate_integrations(ctx);
    let store = load(ctx);
    for entry in entries() {
        let (Some(file), Some(lkey)) = (entry.legacy_file.as_deref(), entry.legacy_key.as_deref()) else { continue };
        if entry.ty == "object" {
            continue;
        }
        if lookup(store.get(&entry.section), &entry.key).is_some() {
            continue;
        }
        let legacy = ctx.base().join(file);
        if !legacy.exists() {
            continue;
        }
        let Some(raw) = read_json_note(ctx, &legacy) else {
            errors += 1;
            continue;
        };
        let val = if matches!(raw, J::Obj(_) | J::Arr(_)) { lookup(Some(&raw), lkey) } else { None };
        let Some(val) = val else { continue };
        if set(ctx, &entry.section, &entry.key, val, None, false).ok {
            migrated += 1;
        } else {
            errors += 1;
        }
    }
    let (m, e) = migrate_plugin_options(ctx);
    migrated += m;
    errors += e;
    (errors == 0, migrated, errors)
}

/// `migrate-settings-from-legacy`: stamped per plugin version in the shared marker file.
pub(super) fn settings_migration(ctx: &Ctx, rows: &mut Vec<Row>) {
    let id = super::step("settings");
    let key = defaults::text("migrate.settings_marker_key");
    let version = ctx.version.as_deref();
    let row = |status: &str, msg: String| Row { id: id.into(), action: id.into(), status: status.into(), msg };
    if super::is_applied(&read_markers(ctx), key, version) {
        rows.push(row("skipped", defaults::render("migrate_msg.already_applied", &[("version", &version.unwrap_or(""))])));
        return;
    }
    let (ok, migrated, errors) = migrate_from_legacy(ctx);
    let stamped = ok && super::mark_applied(ctx, key, version);
    let status = if !ok {
        "failed"
    } else if migrated > 0 {
        "fixed"
    } else {
        "skipped"
    };
    let mut msg = defaults::render("migrate_msg.settings_migrated", &[("n", &migrated)]);
    if errors > 0 {
        msg.push_str(&defaults::render("migrate_msg.settings_errors", &[("n", &errors)]));
    }
    if !stamped && ok && version.is_some() {
        msg.push_str(defaults::text("migrate_msg.not_stamped"));
    }
    rows.push(row(status, msg));
}

/// `repair-jev-triage-cache`: drop the poisoned no-label entries (a bare `{_seq}` that was cached as a verdict before 0.200.0)
/// from the disposable triage cache; labelled entries and real no-label verdicts are kept.
pub(super) fn jev_triage_cache(ctx: &Ctx, rows: &mut Vec<Row>) {
    let id = super::step("triage");
    let row = |status: &str, msg: String| Row { id: id.into(), action: id.into(), status: status.into(), msg };
    let file = ctx.base().join(defaults::text("migrate.jev_triage_cache"));
    let Some(cache) = read_json_note(ctx, &file) else {
        rows.push(row("skipped", defaults::text("migrate_msg.triage_unreadable").to_string()));
        return;
    };
    let J::Obj(entries) = &cache else {
        rows.push(row("skipped", defaults::text("migrate_msg.triage_not_object").to_string()));
        return;
    };
    let mut keep: Vec<(String, J)> = Vec::new();
    let mut poisoned = 0u64;
    for (k, v) in entries {
        let labelled =
            matches!(v, J::Obj(_)) && (super::j_truthy(v.get("urgency")) || super::j_truthy(v.get("kind")) || matches!(v.get("nl"), Some(J::Bool(true))));
        if labelled {
            keep.push((k.clone(), v.clone()));
        } else {
            poisoned += 1;
        }
    }
    if poisoned == 0 {
        rows.push(row("skipped", defaults::text("migrate_msg.nothing_to_repair").to_string()));
        return;
    }
    if ctx.dry_run {
        rows.push(row("skipped", defaults::render("migrate_msg.triage_dry_run", &[("n", &poisoned)])));
        return;
    }
    let kept = keep.len();
    match write_atomic(&file, &json::stringify(&J::Obj(keep))) {
        Ok(()) => rows.push(row("fixed", defaults::render("migrate_msg.triage_fixed", &[("n", &poisoned), ("kept", &kept)]))),
        Err(e) => rows.push(row("failed", defaults::render("migrate_msg.triage_raised", &[("error", &super::node_err(&e, "open", &file))]))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_schema_parses_and_finds_entries() {
        assert_eq!(entries().len(), defaults::list("migrate.settings_schema").len(), "every shipped schema item parses");
        assert!(entries().len() > 200);
        let e = find("devswarm", "reapedRetentionDays").expect("entry");
        assert_eq!(e.exclusive_min, Some(0.0));
        assert_eq!(e.env.as_deref(), Some("ANTIHALL_DEVSWARM_REAPED_RETENTION_DAYS"));
    }

    #[test]
    fn pretty_matches_json_stringify_with_two_spaces() {
        let v = parse_json(r#"{"a":{"b":[1,2,{}],"c":[]},"d":"x"}"#).unwrap();
        assert_eq!(pretty(&v), "{\n  \"a\": {\n    \"b\": [\n      1,\n      2,\n      {}\n    ],\n    \"c\": []\n  },\n  \"d\": \"x\"\n}");
    }

    #[test]
    fn numbers_are_clamped_and_exclusive_bounds_reject() {
        let e = find("devswarm", "reapedRetentionDays").unwrap();
        assert_eq!(coerce_value(e, Some(&J::Str("0".into()))), None);
        assert_eq!(coerce_value(e, Some(&J::Str(" 12 ".into()))), Some(J::Num(12.0)));
        let m = find("devswarm", "summaryRetentionDays").unwrap();
        assert_eq!(coerce_value(m, Some(&J::Str("-4".into()))), Some(J::Num(0.0)));
    }
}
