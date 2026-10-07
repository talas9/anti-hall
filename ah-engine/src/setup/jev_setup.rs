//! `ah-engine jev-setup`: activate, configure and inspect the opt-in Jev classifier and manage its credential. Port of
//! `scripts/jev-setup.js` (verbs `status`, `enable`, `disable`, `set-key`, `bind-generic-key`, `mode`).
//!
//! The security contract is the Node one and is never relaxed: the key is read from STDIN only (never an argument, never
//! echoed or logged); `status` reports key presence as yes or no; the key file is written atomically (a temp file
//! created already private, then renamed) with mode 0600; and every write to `~/.anti-hall/settings.json` or
//! `~/.anti-hall/jev.json` is a read-modify-write that keeps the fields this command does not know about, in their order.
//!
//! The engine's Jev resolver (`jev::settings`, `jev::credentials`) answers every "what would the hooks use" question, so
//! `status` cannot show a value the hooks are not using. Left on Node: `test` (a real gateway call) and the shadow-review
//! verbs `review-due`, `reviewed` and `snooze`.
use super::jsfmt::{keys, pretty, to_fixed2};
use super::{SetupError, home_dir, io_err, out, read_capped, read_prefix, text_of, warn, what};
use crate::checks::guardkit::nodelock;
use crate::checks::jsport::date;
use crate::checks::jsport::json::{self, J, stringify};
use crate::defaults;
use crate::jev::credentials::{read_key_file, resolve_key};
use crate::jev::error::Reason;
use crate::jev::settings::{Env, JevSettings, Mode, Sources, Vendor, known_integrations};
use crate::jev::transport::{BodyError, HttpTransport, NetError, Request, Transport};
use std::io::{BufRead, Read, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::Instant;

/// The process state a verb works from: the home directory and the environment, never read again.
struct Ctx {
    home: PathBuf,
    env: Env,
    /// The exit code; `fail` raises it to 1 and the run goes on, as Node's `process.exitCode = 1` does.
    code: i32,
}

/// A name from the shipped table of settings keys (`setup.json_keys`).
fn key(name: &str) -> &'static str {
    defaults::raw("setup.json_keys").str_field(name)
}

fn parse_json(text: &str) -> Result<J, json::Fail> {
    json::parse(text, defaults::num("setup.json_max_depth") as usize)
}

fn base_dir(home: &Path) -> PathBuf {
    home.join(defaults::text("paths.base_dir"))
}

fn jev_json_path(home: &Path) -> PathBuf {
    base_dir(home).join(defaults::text("jev.legacy_file"))
}

fn settings_path(home: &Path) -> PathBuf {
    base_dir(home).join(defaults::text("jev.settings_file"))
}

fn empty_obj() -> J {
    J::Obj(Vec::new())
}

/// What a JSON object file held.
enum Loaded {
    /// No such file.
    Absent,
    /// A JSON object.
    Object(J),
    /// A file that is not a JSON object (malformed, or an array or scalar).
    Corrupt,
}

/// Read a file that should hold a JSON object. A file this build cannot parse faithfully (nesting past the limit) is an
/// error, so that it is never rewritten from an emptied copy.
fn load(path: &Path) -> Result<Loaded, SetupError> {
    let Some(bytes) = read_capped(path)? else { return Ok(Loaded::Absent) };
    match parse_json(&text_of(bytes)) {
        Ok(j @ J::Obj(_)) => Ok(Loaded::Object(j)),
        Ok(_) | Err(json::Fail::Invalid) => Ok(Loaded::Corrupt),
        Err(json::Fail::Unsupported) => Err(SetupError::Msg(defaults::render("setup.msg_unsupported_json", &[("path", &path.display())]))),
    }
}

/// A file read as a plain JSON object for a report; anything else (missing, unreadable, malformed, an array, a scalar) is
/// `{}`, as Node does, and a problem other than "missing" is said on stderr.
fn read_object(path: &Path) -> J {
    match load(path) {
        Ok(Loaded::Object(j)) => j,
        Ok(Loaded::Absent | Loaded::Corrupt) => empty_obj(),
        Err(e) => {
            warn(&defaults::render("setup.msg_treated_absent", &[("error", &e)]));
            empty_obj()
        }
    }
}

/// Move a file that does not hold a JSON object aside (never delete it) so that a write can start from an empty store.
fn set_aside(path: &Path) -> Result<(), SetupError> {
    let backup = defaults::render("setup.corrupt_fmt", &[("file", &path.display()), ("ms", &(date::now_ms() as u64))]);
    std::fs::rename(path, &backup).map_err(io_err(what("setup.what_set_aside", &path.display())))
}

/// The members of a file's object for a read-modify-write: an absent file is empty, a corrupt one is set aside first.
fn load_for_write(path: &Path) -> Result<Vec<(String, J)>, SetupError> {
    match load(path)? {
        Loaded::Absent => Ok(Vec::new()),
        Loaded::Object(J::Obj(o)) => Ok(o),
        Loaded::Object(_) => Ok(Vec::new()),
        Loaded::Corrupt => {
            set_aside(path)?;
            Ok(Vec::new())
        }
    }
}

/// `Object.assign({}, v)`: the own enumerable members of a value as a fresh object's entries (a string spreads into its
/// characters, an array into its indices, a scalar into nothing).
fn assign_entries(v: Option<&J>) -> Vec<(String, J)> {
    match v {
        Some(J::Obj(o)) => o.clone(),
        Some(J::Str(s)) => s.chars().enumerate().map(|(i, c)| (i.to_string(), J::Str(c.to_string()))).collect(),
        Some(J::Arr(a)) => a.iter().enumerate().map(|(i, x)| (i.to_string(), x.clone())).collect(),
        _ => Vec::new(),
    }
}

/// Re-read an object through `JSON.parse` so its keys take the order a JavaScript object would give them.
fn normalised(v: J) -> J {
    parse_json(&stringify(&v)).unwrap_or(v)
}

fn is_valid(list_key: &str, v: &str) -> bool {
    defaults::list(list_key).contains(&v)
}

// ---- the settings store (hooks/lib/settings.js `set`) -----------------------------------------------------------------

/// The lock parameters of the settings store.
fn lock_params() -> nodelock::Params {
    nodelock::Params {
        stale_ms: defaults::num("setup.lock_stale_ms"),
        wait_ms: defaults::num("setup.lock_wait_ms"),
        step_ms: defaults::num("setup.lock_step_ms"),
        reclaim_stale_ms: defaults::num("setup.lock_reclaim_stale_ms"),
        release_tries: defaults::num("setup.lock_release_tries"),
        release_step_ms: defaults::num("setup.lock_release_step_ms"),
        boot_slop_s: defaults::num("setup.lock_boot_slop_s"),
    }
}

/// The pid recorded in a lock file, for the "being written by another process" message.
fn lock_holder(path: &str) -> String {
    let text = match read_prefix(Path::new(path), defaults::num("setup.lock_record_max_bytes")) {
        Ok(Some(b)) => text_of(b),
        Ok(None) => String::new(),
        Err(e) => {
            warn(&defaults::render("setup.msg_treated_absent", &[("error", &e)]));
            String::new()
        }
    };
    match parse_json(&text).ok().as_ref().and_then(|j| j.get("pid")) {
        Some(J::Num(n)) => crate::checks::jsport::num::to_js_string(*n),
        _ => defaults::text("setup.word_unknown").to_string(),
    }
}

/// `settings.set(section, key, value)` for the keys this command writes: validate against the shipped table, take the lock,
/// move a corrupt file aside (never delete it), read-modify-write the whole file atomically.
fn settings_set(home: &Path, section: &str, name: &str, value: J) -> Result<(), SetupError> {
    let full = format!("{section}.{name}");
    let kind = if section == key("integrations_section") && known_integrations().contains(&name) {
        Some("setup.valid_modes")
    } else {
        defaults::raw("setup.settings_entries").get(&full).and_then(|v| v.as_str())
    };
    let Some(kind) = kind else { return Err(SetupError::Msg(defaults::render("setup.msg_unknown_setting", &[("setting", &full)]))) };
    let boolean = defaults::text("setup.kind_boolean");
    let value = match (kind, value) {
        (k, v @ J::Bool(_)) if k == boolean => v,
        (k, other) if k == boolean => return Err(SetupError::Msg(defaults::render("setup.msg_expected_boolean", &[("got", &stringify(&other))]))),
        (list_key, J::Str(s)) if is_valid(list_key, &s) => J::Str(s),
        (list_key, _) => return Err(SetupError::Msg(defaults::render("setup.msg_must_be_one_of", &[("values", &defaults::list(list_key).join(", "))]))),
    };
    let file = settings_path(home);
    let file_s = file.to_string_lossy().into_owned();
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(io_err(what("setup.what_create_dir", &dir.display())))?;
    }
    let lock_path = format!("{file_s}{}", defaults::text("setup.lock_suffix"));
    let Some(held) = nodelock::acquire(&lock_path, lock_params()) else {
        return Err(SetupError::Msg(defaults::render("setup.msg_settings_busy", &[("pid", &lock_holder(&lock_path))])));
    };
    let result = write_settings_locked(&file, section, name, value);
    if !held.release() {
        warn(defaults::text("setup.msg_lock_not_released"));
    }
    result
}

fn write_settings_locked(file: &Path, section: &str, name: &str, value: J) -> Result<(), SetupError> {
    let store = load_for_write(file)?;
    let store_obj = J::Obj(store.clone());
    let mut next = store;
    let mut sec = assign_entries(store_obj.get(section));
    match sec.iter_mut().find(|(k, _)| k == name) {
        Some(slot) => slot.1 = value,
        None => sec.push((name.to_string(), value)),
    }
    match next.iter_mut().find(|(k, _)| k == section) {
        Some(slot) => slot.1 = J::Obj(sec),
        None => next.push((section.to_string(), J::Obj(sec))),
    }
    let tmp = defaults::render("setup.tmp_settings_fmt", &[("file", &file.display()), ("pid", &std::process::id()), ("ms", &(date::now_ms() as u64))]);
    write_json_atomic(file, &tmp, J::Obj(next))
}

/// Write `value` pretty-printed with a final newline to `tmp`, then rename it over `file`; the temp file does not outlive a
/// failure.
fn write_json_atomic(file: &Path, tmp: &str, value: J) -> Result<(), SetupError> {
    let mut body = pretty(&normalised(value));
    body.push('\n');
    let result = std::fs::write(tmp, body).and_then(|()| std::fs::rename(tmp, file));
    if let Err(e) = result {
        if let Err(cleanup) = std::fs::remove_file(tmp)
            && cleanup.kind() != std::io::ErrorKind::NotFound
        {
            warn(&defaults::render("setup.msg_treated_absent", &[("error", &SetupError::Io { what: what("setup.what_remove", &tmp), source: cleanup })]));
        }
        return Err(SetupError::Io { what: what("setup.what_write", &file.display()), source: e });
    }
    Ok(())
}

/// `writeJevJsonMerged`: read-modify-write of the legacy `jev.json`, atomic, keeping every field the mutator leaves.
fn write_jev_json(home: &Path, mutate: impl FnOnce(&mut Vec<(String, J)>)) -> Result<(), SetupError> {
    let path = jev_json_path(home);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(io_err(what("setup.what_create_dir", &dir.display())))?;
    }
    let mut cfg = load_for_write(&path)?;
    mutate(&mut cfg);
    let tmp = defaults::render("setup.tmp_fmt", &[("file", &path.display()), ("pid", &std::process::id())]);
    write_json_atomic(&path, &tmp, J::Obj(cfg))
}

// ---- resolution -------------------------------------------------------------------------------------------------------

fn resolve_settings(cx: &Ctx) -> JevSettings {
    JevSettings::resolve(&cx.home, Sources::load(&cx.home, cx.env.clone()))
}

fn resolve_fallback(s: &JevSettings, primary: Vendor) -> Option<Vendor> {
    s.fallback.filter(|f| *f != primary)
}

/// The key file the hooks would read for `vendor` (an explicit `jev.keyFile` counts only for the vendor the generic key
/// is bound to).
fn key_file_path(s: &JevSettings, vendor: Vendor) -> PathBuf {
    match &s.key_file {
        Some(f) if s.generic_key_vendor == vendor => f.clone(),
        _ => crate::jev::credentials::default_key_file(vendor, s.home()),
    }
}

fn key_present(s: &JevSettings, vendor: Vendor) -> bool {
    resolve_key(s, vendor).key.is_some()
}

/// Node's `credentials.js` wording for why a key file was refused (the engine's own messages are worded for its logs).
fn node_reason(engine_msg: &str) -> String {
    let pairs = [
        ("msg.jev_key_outside_roots", "setup.reason_outside"),
        ("msg.jev_key_not_file", "setup.reason_not_file"),
        ("msg.jev_key_multiline", "setup.reason_multiline"),
        ("msg.jev_key_unreadable", "setup.reason_unreadable"),
    ];
    for (engine, node) in pairs {
        if engine_msg == defaults::text(engine) {
            return defaults::text(node).to_string();
        }
    }
    defaults::render("setup.reason_too_large", &[("max", &defaults::num("jev.key_file_max_bytes"))])
}

/// `resolveKey('jev', ...)` with the diagnostics worded as `credentials.js` words them: (has key, rejected reason, diagnostic).
fn lookup_with_notes(s: &JevSettings, vendor: Vendor) -> (bool, Option<String>, Option<String>) {
    let r = resolve_key(s, vendor);
    if r.key.is_some() {
        return (true, None, None);
    }
    let mut diagnostic = None;
    if s.env().get(own_var(vendor)).is_none_or(|v| js_trim(v).is_empty())
        && s.env().get(defaults::text("env.jev_key_generic")).is_some_and(|v| !js_trim(v).is_empty())
    {
        let bound = s.generic_key_vendor;
        if bound != vendor {
            diagnostic = Some(defaults::render(
                "setup.diag_generic_bound",
                &[
                    ("bound", &bound.as_str()),
                    ("vendor", &vendor.as_str()),
                    ("option", &defaults::render("setup.option_name_fmt", &[("vendor", &vendor.as_str())])),
                ],
            ));
        }
    }
    let mut rejected = None;
    if s.allow_legacy_key_read && s.env().get(legacy_var(vendor)).is_none_or(|v| js_trim(v).is_empty()) {
        let file = key_file_path(s, vendor);
        if let Err(why) = read_key_file(&file, s.home()) {
            rejected = Some(node_reason(&why));
        }
    }
    (false, rejected, diagnostic)
}

fn own_var(v: Vendor) -> &'static str {
    match v {
        Vendor::Vercel => defaults::text("env.jev_key_vercel"),
        Vendor::Typesafe => defaults::text("env.jev_key_typesafe"),
    }
}

fn legacy_var(v: Vendor) -> &'static str {
    match v {
        Vendor::Vercel => defaults::text("env.jev_legacy_key_vercel"),
        Vendor::Typesafe => defaults::text("env.jev_legacy_key_typesafe"),
    }
}

fn js_trim(s: &str) -> &str {
    crate::jev::js_trim(s)
}

impl Ctx {
    /// Print an error line the way Node's `fail` does and make the run exit 1; the run goes on.
    fn fail(&mut self, msg: &str) {
        warn(&format!("{}{msg}", defaults::text("setup.fail_prefix")));
        self.code = 1;
    }

    /// Write one `jev.<key>` setting; a failure is reported through `fail` and answered `false`.
    fn set_jev(&mut self, name: &str, value: J) -> bool {
        match settings_set(&self.home, key("section"), name, value) {
            Ok(()) => true,
            Err(e) => {
                self.fail(&defaults::render("setup.msg_could_not_set", &[("key", &name), ("error", &e)]));
                false
            }
        }
    }
}

// ---- status -----------------------------------------------------------------------------------------------------------

/// Whether a decision-log row counts as a call: an object with an `id` that is truthy and a `type` other than `outcome`.
fn is_call_row(row: &J) -> bool {
    if matches!(row.get("type"), Some(J::Str(s)) if s == defaults::text("setup.log_outcome_type")) {
        return false;
    }
    match row.get("id") {
        Some(J::Str(s)) => !s.is_empty(),
        Some(J::Num(n)) => *n != 0.0 && !n.is_nan(),
        Some(J::Bool(b)) => *b,
        Some(J::Arr(_) | J::Obj(_)) => true,
        Some(J::Null) | None => false,
    }
}

/// The 24-hour call count of one log file, streamed line by line.
fn count_calls_in(path: &str, cutoff: f64) -> Result<usize, SetupError> {
    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(SetupError::Io { what: what("setup.what_read", &path), source: e }),
    };
    let mut reader = std::io::BufReader::new(file.take(defaults::num("setup.log_max_bytes")));
    let mut line = Vec::new();
    let mut count = 0;
    loop {
        line.clear();
        let n = reader.read_until(b'\n', &mut line).map_err(io_err(what("setup.what_read", &path)))?;
        if n == 0 {
            return Ok(count);
        }
        let text = String::from_utf8_lossy(&line);
        let t = js_trim(&text);
        if t.is_empty() {
            continue;
        }
        let Ok(row @ J::Obj(_)) = parse_json(t) else { continue }; // a corrupt row is skipped, as Node skips it
        if !is_call_row(&row) {
            continue;
        }
        if let Some(J::Str(ts)) = row.get("ts")
            && let date::Parsed::Ms(ms) = date::parse(ts)
            && ms >= cutoff
        {
            count += 1;
        }
    }
}

/// The 24-hour call count of the Jev decision log (current and first rotated file).
fn calls_last_24h(home: &Path) -> Result<usize, SetupError> {
    let log = base_dir(home).join(defaults::text("jev.log_file")).to_string_lossy().into_owned();
    let cutoff = date::now_ms() - defaults::num("setup.day_ms") as f64;
    Ok(count_calls_in(&format!("{log}{}", defaults::text("setup.log_rotated_suffix")), cutoff)? + count_calls_in(&log, cutoff)?)
}

/// One mode line of `status`: the resolved mode, with ids that only the legacy `integrations` map names handled the way
/// Node's `getMode` handles them (an exact `on`, `shadow` or `off`, else the legacy default).
fn mode_of(s: &JevSettings, legacy: &J, id: &str) -> String {
    if known_integrations().contains(&id) {
        return s.mode(id, true).as_str().to_string();
    }
    if s.env().get(&crate::jev::settings::integration_env_name(id)) == Some(defaults::text("setup.kill_switch_value")) {
        return Mode::Off.as_str().into();
    }
    match legacy.get(key("legacy_integrations")).and_then(|m| m.get(id)) {
        Some(J::Str(v)) if is_valid("setup.valid_modes", v) => v.clone(),
        _ if defaults::list("jev.legacy_on_default").contains(&id) => Mode::On.as_str().into(),
        _ => defaults::text("jev.unlisted_mode").to_string(),
    }
}

/// One tier of a `jev.*` value: coerce a JSON value the way the settings store does for a boolean or an enum.
fn coerce(entry_boolean: bool, values: &[&str], raw: Option<&J>) -> Option<J> {
    let text = match raw? {
        J::Str(s) => js_trim(s).to_string(),
        J::Num(n) => crate::checks::jsport::num::to_js_string(*n),
        J::Bool(b) => b.to_string(),
        J::Null | J::Arr(_) | J::Obj(_) => return None,
    };
    if text.is_empty() {
        return None;
    }
    let lower = text.to_lowercase();
    if entry_boolean {
        if let Some(J::Bool(b)) = raw {
            return Some(J::Bool(*b));
        }
        return crate::jev::settings::bool_token(&lower).map(J::Bool);
    }
    values.contains(&lower.as_str()).then_some(J::Str(lower))
}

/// Where a `jev.*` value came from.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Tier {
    Env,
    File,
    Legacy,
    Option,
    Default,
}

/// The value and tier of one of the keys a status warning compares (`settings.get` and `settings.source`): environment,
/// `settings.json`, the legacy `jev.json`, the plugin option, then the default. A plugin option equal to the default counts
/// as unset. How each key is read is the shipped table `setup.tier_keys`.
fn tier(cx: &Ctx, settings: &J, legacy: &J, name: &str) -> (J, Tier) {
    let spec = defaults::raw("setup.tier_keys").get(name);
    let kind = spec.map_or("", |v| v.str_field("kind"));
    let boolean = kind == defaults::text("setup.kind_boolean");
    let values: Vec<&str> = if boolean { Vec::new() } else { defaults::list(kind) };
    let default_text = spec.map_or("", |v| v.str_field("default"));
    let default = if boolean { J::Bool(crate::jev::settings::bool_token(default_text).unwrap_or(false)) } else { J::Str(default_text.to_string()) };
    if boolean && let Some(v) = cx.env.get(defaults::text("env.jev_enabled")).and_then(|e| coerce(true, &[], Some(&J::Str(e.to_string())))) {
        return (v, Tier::Env);
    }
    if let Some(v) = settings.get(key("section")).and_then(|obj| coerce(boolean, &values, obj.get(name))) {
        return (v, Tier::File);
    }
    if let Some(v) = coerce(boolean, &values, legacy.get(name)) {
        return (v, Tier::Legacy);
    }
    let option = format!("{}{}", defaults::text("env.jev_option_prefix"), spec.map_or("", |v| v.str_field("option")));
    if let Some(raw) = cx.env.get(&option)
        && let Some(v) = coerce(boolean, &values, Some(&J::Str(raw.to_string())))
        && v != default
    {
        return (v, Tier::Option);
    }
    (default, Tier::Default)
}

/// Warnings for a legacy `jev.json` value a higher tier overrides (`configDisagreements`).
fn disagreement_lines(cx: &Ctx, legacy: &J) -> Vec<String> {
    let settings = read_object(&settings_path(&cx.home));
    let mut lines = Vec::new();
    for name in defaults::list("setup.disagreement_keys") {
        let Some(old) = legacy.get(name) else { continue };
        let (effective, source) = tier(cx, &settings, legacy, name);
        if matches!(source, Tier::Legacy | Tier::Default) || &effective == old {
            continue;
        }
        let winner = match source {
            Tier::File => defaults::text("setup.winner_file"),
            Tier::Env => defaults::text("setup.winner_env"),
            Tier::Option | Tier::Legacy | Tier::Default => defaults::text("setup.winner_option"),
        };
        lines.push(defaults::render(
            "setup.msg_disagree",
            &[("key", &name), ("legacy", &stringify(old)), ("winner", &winner), ("effective", &stringify(&effective))],
        ));
    }
    lines
}

/// What `getCreditBalanceCached` returned, as the object Node builds.
struct Credit(J);

fn credits_cache_path(home: &Path) -> PathBuf {
    base_dir(home).join(defaults::text("setup.credits_cache_file"))
}

/// `Number(x)` for the response fields the credit endpoint carries.
fn js_number_of(v: Option<&J>) -> f64 {
    match v {
        Some(J::Num(n)) => *n,
        Some(J::Str(s)) => crate::checks::guardkit::text::js_number_of_str(s),
        Some(J::Bool(b)) => f64::from(u8::from(*b)),
        Some(J::Null) => 0.0,
        Some(J::Arr(_) | J::Obj(_)) | None => f64::NAN,
    }
}

/// A credit answer that is a refusal for `reason`, with the extra members given.
fn refusal(reason: &str, extra: Vec<(String, J)>) -> J {
    let mut v = vec![("ok".to_string(), J::Bool(false)), ("reason".to_string(), J::Str(reason.to_string()))];
    v.extend(extra);
    J::Obj(v)
}

/// `getCreditBalance`: one real request to the Vercel credits endpoint.
fn fetch_credit(s: &JevSettings) -> J {
    if !s.enabled {
        return refusal(&Reason::Disabled.to_string(), Vec::new());
    }
    let primary = s.transport == Vendor::Vercel;
    if !primary && s.fallback != Some(Vendor::Vercel) {
        return refusal(defaults::text("setup.credit_reason_unsupported"), vec![("transport".into(), J::Str(s.transport.as_str().into()))]);
    }
    // `resolveCredential` words what it found, once, on stderr
    let (has_key, rejected, diagnostic) = lookup_with_notes(s, Vendor::Vercel);
    if let Some(why) = rejected {
        warn(&format!("{}{}", defaults::text("setup.warn_prefix"), defaults::render("setup.msg_rejected", &[("why", &why)])));
    }
    if !has_key && let Some(d) = diagnostic {
        warn(&format!("{}{d}", defaults::text("setup.diag_prefix")));
    }
    let Some(key) = resolve_key(s, Vendor::Vercel).key else { return refusal(&Reason::NoKey.to_string(), Vec::new()) };
    let url = s.endpoint_overrides[0]
        .clone()
        .or_else(|| if primary { s.endpoint_override.clone() } else { None })
        .unwrap_or_else(|| defaults::text("setup.credits_endpoint").to_string());
    let start = Instant::now();
    let ms = || ("ms".to_string(), J::Num(start.elapsed().as_millis() as f64));
    let fail = |r: &Reason| refusal(&r.to_string(), vec![ms()]);
    let req = Request { body: None, url: &url, bearer: key.expose(), timeout: std::time::Duration::from_millis(s.timeout_ms) };
    let resp = match HttpTransport::new().send(&req) {
        Ok(r) => r,
        Err(NetError::Timeout) => return fail(&Reason::Timeout),
        Err(NetError::Network) => return fail(&Reason::NetworkError),
    };
    if !(200..300).contains(&resp.status) {
        return fail(&Reason::Http(resp.status));
    }
    let body = match resp.body {
        Ok(b) => b,
        Err(BodyError::Timeout | BodyError::Other) => return fail(&Reason::ParseError),
    };
    let Ok(parsed) = parse_json(&body) else { return fail(&Reason::ParseError) };
    let fields = defaults::list("setup.credit_fields");
    let field = |i: usize| js_number_of(fields.get(i).and_then(|f| parsed.get(f)));
    let (balance, used) = (field(0), field(1));
    if !balance.is_finite() {
        return fail(&Reason::BadResponse);
    }
    J::Obj(vec![
        ("ok".into(), J::Bool(true)),
        ("vendor".into(), J::Str(Vendor::Vercel.as_str().into())),
        ("balanceUsd".into(), J::Num(balance)),
        ("totalUsedUsd".into(), if used.is_finite() { J::Num(used) } else { J::Null }),
        ms(),
    ])
}

/// Write the credit cache entry (best effort in Node; a failure is said on stderr here).
fn write_credit_cache(path: &Path, entry: &J) -> Result<(), SetupError> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(io_err(what("setup.what_create_dir", &dir.display())))?;
    }
    let tmp = defaults::render("setup.tmp_fmt", &[("file", &path.display()), ("pid", &std::process::id())]);
    std::fs::write(&tmp, stringify(entry)).and_then(|()| std::fs::rename(&tmp, path)).map_err(io_err(what("setup.what_write", &path.display())))
}

/// `getCreditBalanceCached({})`: a fresh vendor-tagged cache entry is served, else one request whose answer is cached
/// unless it was only a local configuration answer.
fn credit_cached(cx: &Ctx, s: &JevSettings) -> Credit {
    let path = credits_cache_path(&cx.home);
    let now = date::now_ms();
    let cached = match read_capped(&path) {
        Ok(Some(b)) => parse_json(&text_of(b)).ok(),
        Ok(None) => None,
        Err(e) => {
            warn(&defaults::render("setup.msg_treated_absent", &[("error", &e)]));
            None
        }
    };
    if let Some(c @ J::Obj(_)) = cached
        && matches!(c.get("vendor"), Some(J::Str(v)) if v == Vendor::Vercel.as_str())
        && let Some(J::Obj(result)) = c.get("result")
        && let Some(J::Num(at)) = c.get("fetchedAt")
        && at.is_finite()
        && now - at < defaults::num("setup.credits_ttl_ms") as f64
    {
        let mut r = result.clone();
        match r.iter_mut().find(|(k, _)| k == "cached") {
            Some(slot) => slot.1 = J::Bool(true),
            None => r.push(("cached".into(), J::Bool(true))),
        }
        return Credit(J::Obj(r));
    }
    let result = fetch_credit(s);
    let local = matches!(result.get("reason"), Some(J::Str(r)) if defaults::list("setup.credit_local_reasons").contains(&r.as_str()));
    if !local || matches!(result.get("ok"), Some(J::Bool(true))) {
        let entry =
            J::Obj(vec![("fetchedAt".into(), J::Num(now)), ("vendor".into(), J::Str(Vendor::Vercel.as_str().into())), ("result".into(), result.clone())]);
        if let Err(e) = write_credit_cache(&path, &entry) {
            warn(&defaults::render("setup.msg_treated_absent", &[("error", &e)]));
        }
    }
    let mut r = match result {
        J::Obj(o) => o,
        _ => Vec::new(),
    };
    r.push(("cached".into(), J::Bool(false)));
    Credit(J::Obj(r))
}

fn credit_line(c: &Credit) -> Option<String> {
    let j = &c.0;
    if matches!(j.get("ok"), Some(J::Bool(true))) {
        // `balanceUsd.toFixed` throws on a non-number, which `status` swallows
        let Some(J::Num(n)) = j.get("balanceUsd") else { return None };
        let cached = if matches!(j.get("cached"), Some(J::Bool(true))) { defaults::text("setup.fmt_cached") } else { "" };
        return Some(defaults::render("setup.msg_credit_ok", &[("amount", &to_fixed2(*n)), ("cached", &cached)]));
    }
    let reason = match j.get("reason") {
        Some(J::Str(r)) => r.clone(),
        Some(other) => stringify(other),
        None => defaults::text("setup.word_undefined").to_string(),
    };
    if reason == Reason::NoKey.to_string() {
        return Some(defaults::text("setup.msg_credit_nokey").to_string());
    }
    if defaults::list("setup.credit_silent_reasons").contains(&reason.as_str()) {
        return None;
    }
    Some(defaults::render("setup.msg_credit_na", &[("reason", &reason)]))
}

/// The words `status` prints for a true and a false answer.
fn yes_no(b: bool) -> &'static str {
    defaults::text(if b { "setup.word_yes" } else { "setup.word_no" })
}

fn cmd_status(cx: &mut Ctx) -> Result<(), SetupError> {
    let s = resolve_settings(cx);
    let legacy = read_object(&jev_json_path(&cx.home));
    let transport = s.transport;
    let present = key_present(&s, transport);
    let line = |key: &str, value: &dyn std::fmt::Display| defaults::render(key, &[("value", value)]);
    let note = |text: &dyn std::fmt::Display| defaults::render("setup.fmt_status_indent", &[("text", text)]);

    let mut ids: Vec<String> = defaults::list("setup.known_integrations").into_iter().map(str::to_string).collect();
    for k in keys(legacy.get(key("legacy_integrations")).unwrap_or(&J::Null)) {
        if !ids.contains(&k) {
            ids.push(k);
        }
    }
    out(&line("setup.fmt_status_enabled", &s.enabled))?;
    out(&line("setup.fmt_status_transport", &transport.as_str()))?;
    for l in disagreement_lines(cx, &legacy) {
        out(&l)?;
    }
    out(&line("setup.fmt_status_key", &yes_no(present)))?;
    let generic_opt = cx.env.get(defaults::text("env.jev_key_generic")).is_some_and(|v| !v.is_empty());
    if s.key_file.is_some() || generic_opt {
        out(&defaults::render("setup.msg_generic_bound", &[("vendor", &s.generic_key_vendor.as_str())]))?;
    }
    let fallback = resolve_fallback(&s, transport);
    out(&line("setup.fmt_status_fallback", &fallback.map_or(defaults::text("setup.word_none"), Vendor::as_str)))?;
    if let Some(f) = fallback {
        out(&line("setup.fmt_status_fallback_key", &yes_no(key_present(&s, f))))?;
        out(defaults::text("setup.msg_fallback_note"))?;
    }
    if !present {
        out(&note(&defaults::text("setup.msg_no_key_notice")))?;
    }
    let (_, rejected, diagnostic) = lookup_with_notes(&s, transport);
    if let Some(why) = rejected {
        out(&note(&defaults::render("setup.msg_rejected", &[("why", &why)])))?;
    }
    if let Some(d) = diagnostic {
        out(&note(&d))?;
    }
    if let Some(f) = fallback
        && let (_, _, Some(d)) = lookup_with_notes(&s, f)
    {
        out(&defaults::render("setup.fmt_status_fallback_diag", &[("text", &d)]))?;
    }
    // a legacy key that exists but is not read
    if !s.allow_legacy_key_read {
        let env_present = cx.env.get(legacy_var(transport)).is_some_and(|v| !v.is_empty());
        let file_present = std::fs::metadata(key_file_path(&s, transport)).is_ok_and(|m| m.is_file() && m.len() > 0);
        if env_present || file_present {
            out(&defaults::render("setup.fmt_status_notice", &[("text", &defaults::text("setup.msg_migration_notice"))]))?;
        }
    }
    out(defaults::text("setup.fmt_status_integrations"))?;
    for id in &ids {
        out(&defaults::render("setup.fmt_status_integration", &[("id", id), ("mode", &mode_of(&s, &legacy, id))]))?;
    }
    out(&defaults::render("setup.fmt_status_calls", &[("count", &calls_last_24h(&cx.home)?)]))?;
    let mut targets = vec![transport];
    targets.extend(fallback);
    for t in targets {
        if t == Vendor::Typesafe {
            out(defaults::text("setup.msg_credit_typesafe"))?;
            continue;
        }
        if !s.enabled {
            continue;
        }
        if let Some(line) = credit_line(&credit_cached(cx, &s)) {
            out(&line)?;
        }
    }
    Ok(())
}

// ---- configure --------------------------------------------------------------------------------------------------------

struct Opts {
    transport: Option<String>,
    fallback: Option<String>,
    role: Option<String>,
    vendor: Option<String>,
    positional: Vec<String>,
}

/// `parseArgs`: an option takes the word after it (missing is `undefined`, kept as `None`); `--days` is consumed too.
fn parse_args(argv: &[String]) -> Opts {
    let mut o = Opts { transport: None, fallback: None, role: None, vendor: None, positional: Vec::new() };
    let mut i = 0;
    while i < argv.len() {
        let a = argv[i].as_str();
        let slot = match a {
            "--transport" => Some(0),
            "--fallback" => Some(1),
            "--role" => Some(2),
            "--vendor" => Some(3),
            _ => None,
        };
        match slot {
            Some(n) => {
                i += 1;
                let v = argv.get(i).cloned();
                match n {
                    0 => o.transport = v,
                    1 => o.fallback = v,
                    2 => o.role = v,
                    _ => o.vendor = v,
                }
            }
            None if a == "--days" => i += 1,
            None => o.positional.push(a.to_string()),
        }
        i += 1;
    }
    o
}

fn cmd_enable(cx: &mut Ctx, o: &Opts) -> Result<(), SetupError> {
    if let Some(t) = o.transport.as_deref().filter(|t| !t.is_empty())
        && !is_valid("setup.valid_transports", t)
    {
        cx.fail(&defaults::render("setup.msg_enable_bad_transport", &[("value", &t)]));
        return Ok(());
    }
    if let Some(f) = o.fallback.as_deref()
        && !is_valid("setup.valid_fallbacks", f)
    {
        cx.fail(&defaults::render("setup.msg_enable_bad_fallback", &[("value", &f)]));
        return Ok(());
    }
    if !cx.set_jev(key("enabled"), J::Bool(true)) {
        return Ok(());
    }
    let transport = o.transport.as_deref().filter(|t| !t.is_empty());
    if let Some(t) = transport
        && !cx.set_jev(key("transport"), J::Str(t.to_string()))
    {
        return Ok(());
    }
    if let Some(f) = &o.fallback
        && !cx.set_jev(key("fallback"), J::Str(f.clone()))
    {
        return Ok(());
    }
    for v in [transport, o.fallback.as_deref()].into_iter().flatten() {
        warn_unbound_vendor(cx, v)?;
    }
    let s = resolve_settings(cx);
    let none = defaults::text("setup.word_none");
    let fb = resolve_fallback(&s, s.transport).map_or(none, Vendor::as_str);
    out(&defaults::render("setup.fmt_enabled", &[("transport", &s.transport.as_str()), ("fallback", &fb)]))?;
    if o.fallback.is_some() && fb == none && o.fallback.as_deref() != Some(none) {
        out(defaults::text("setup.msg_fallback_equal"))?;
    }
    Ok(())
}

/// `v` was just chosen as primary or fallback: when no key for it is visible here and the generic key is bound to the
/// other vendor, say so. The binding is never changed.
fn warn_unbound_vendor(cx: &Ctx, v: &str) -> Result<(), SetupError> {
    let Some(vendor) = Vendor::parse(v) else { return Ok(()) };
    let s = resolve_settings(cx);
    if s.generic_key_vendor == vendor || key_present(&s, vendor) {
        return Ok(());
    }
    let option = defaults::render("setup.option_name_fmt", &[("vendor", &v)]);
    out(&defaults::render("setup.msg_unbound_warning", &[("vendor", &v), ("bound", &s.generic_key_vendor.as_str()), ("option", &option)]))
}

fn cmd_bind_generic_key(cx: &mut Ctx, o: &Opts) -> Result<(), SetupError> {
    let Some(v) = o.vendor.as_deref().filter(|v| is_valid("setup.valid_transports", v)) else {
        cx.fail(defaults::text("setup.msg_bind_usage"));
        return Ok(());
    };
    match settings_set(&cx.home, key("section"), key("generic_vendor"), J::Str(v.to_string())) {
        Ok(()) => out(&defaults::render("setup.msg_bound", &[("vendor", &v)])),
        Err(e) => {
            cx.fail(&defaults::render("setup.msg_could_not_set", &[("key", &key("generic_vendor")), ("error", &e)]));
            Ok(())
        }
    }
}

fn cmd_disable(cx: &mut Ctx) -> Result<(), SetupError> {
    if cx.set_jev(key("enabled"), J::Bool(false)) {
        out(defaults::text("setup.fmt_disabled"))?;
    }
    Ok(())
}

/// `isPrintable`: no control character or DEL.
fn printable(s: &str) -> bool {
    s.chars().all(|c| (c as u32) >= 0x20 && c as u32 != 0x7f)
}

/// `writeKeyFileAtomic`: a temp file created already private (mode 0600), then renamed over the key file.
fn write_key_file(path: &Path, contents: &str) -> Result<(), SetupError> {
    if let Some(dir) = path.parent() {
        std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir).map_err(io_err(what("setup.what_create_dir", &dir.display())))?;
    }
    let tmp = defaults::render("setup.tmp_fmt", &[("file", &path.display()), ("pid", &std::process::id())]);
    let result = (|| {
        let mut f = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp)?;
        f.write_all(contents.as_bytes())?;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))?;
        std::fs::rename(&tmp, path)
    })();
    if let Err(e) = result {
        if let Err(cleanup) = std::fs::remove_file(&tmp)
            && cleanup.kind() != std::io::ErrorKind::NotFound
        {
            warn(&defaults::render("setup.msg_treated_absent", &[("error", &SetupError::Io { what: what("setup.what_remove", &tmp), source: cleanup })]));
        }
        return Err(SetupError::Io { what: what("setup.what_write", &path.display()), source: e });
    }
    Ok(())
}

/// Stdin as text, at most `setup.stdin_max_bytes`; `Ok(None)` when there is more than that.
fn read_stdin() -> Result<Option<String>, SetupError> {
    let max = defaults::num("setup.stdin_max_bytes");
    let mut raw = Vec::new();
    std::io::stdin().take(max + 1).read_to_end(&mut raw).map_err(io_err(defaults::text("setup.what_read_stdin")))?;
    Ok((raw.len() as u64 <= max).then(|| text_of(raw)))
}

fn cmd_set_key(cx: &mut Ctx, o: &Opts) -> Result<(), SetupError> {
    let transport_override = o.transport.as_deref().filter(|t| !t.is_empty());
    if let Some(t) = transport_override
        && !is_valid("setup.valid_transports", t)
    {
        cx.fail(&defaults::render("setup.msg_setkey_bad_transport", &[("value", &t)]));
        return Ok(());
    }
    if let Some(r) = o.role.as_deref()
        && r != defaults::text("setup.role_fallback")
    {
        cx.fail(&defaults::render("setup.msg_setkey_bad_role", &[("value", &r)]));
        return Ok(());
    }
    let s = resolve_settings(cx);
    let is_fallback = o.role.as_deref() == Some(defaults::text("setup.role_fallback"));
    let vendor = if is_fallback {
        let Some(v) = resolve_fallback(&s, s.transport) else {
            cx.fail(defaults::text("setup.msg_setkey_no_fallback"));
            return Ok(());
        };
        v
    } else {
        transport_override.and_then(Vendor::parse).unwrap_or(s.transport)
    };
    let Some(text) = read_stdin()? else {
        cx.fail(&defaults::render("setup.msg_setkey_too_large", &[("max", &defaults::num("setup.stdin_max_bytes"))]));
        return Ok(());
    };
    let secret = js_trim(&text);
    if secret.is_empty() {
        cx.fail(defaults::text("setup.msg_setkey_empty"));
        return Ok(());
    }
    if !printable(secret) {
        cx.fail(defaults::text("setup.msg_setkey_nonprintable"));
        return Ok(());
    }
    write_key_file(&key_file_path(&s, vendor), &format!("{secret}\n"))?;
    if let Some(t) = transport_override
        && !is_fallback
        && !cx.set_jev(key("transport"), J::Str(t.to_string()))
    {
        return Ok(());
    }
    out(&defaults::render("setup.fmt_key_saved", &[("vendor", &vendor.as_str())]))?;
    if !s.allow_legacy_key_read {
        out(&defaults::render("setup.msg_setkey_note", &[("option", &defaults::render("setup.option_name_fmt", &[("vendor", &vendor.as_str())]))]))?;
    }
    Ok(())
}

fn cmd_mode(cx: &mut Ctx, o: &Opts) -> Result<(), SetupError> {
    let (integration, value) = (o.positional.first(), o.positional.get(1));
    let (Some(integration), Some(value)) = (integration, value.filter(|v| is_valid("setup.valid_modes", v))) else {
        cx.fail(defaults::text("setup.msg_mode_usage"));
        return Ok(());
    };
    write_jev_json(&cx.home, |cfg| {
        let section = key("legacy_integrations");
        let current = cfg.iter().find(|(k, _)| k == section).map(|(_, v)| v.clone());
        let mut merged = assign_entries(current.as_ref());
        match merged.iter_mut().find(|(k, _)| k == integration) {
            Some(slot) => slot.1 = J::Str(value.clone()),
            None => merged.push((integration.clone(), J::Str(value.clone()))),
        }
        match cfg.iter_mut().find(|(k, _)| k == section) {
            Some(slot) => slot.1 = J::Obj(merged),
            None => cfg.push((section.into(), J::Obj(merged))),
        }
    })?;
    // an integration with its own settings key is also written to settings.json, which outranks jev.json
    if known_integrations().contains(&integration.as_str())
        && let Err(e) = settings_set(&cx.home, key("integrations_section"), integration, J::Str(value.clone()))
    {
        warn(&defaults::render("setup.msg_settings_not_updated", &[("error", &e)]));
    }
    out(&defaults::render("setup.fmt_mode_set", &[("integration", integration), ("value", value)]))
}

/// The command: `jev-setup <verb> [options]`; the exit code is 1 after a `fail`.
pub fn run(args: &[String]) -> Result<i32, SetupError> {
    let env = Env::process();
    let Some(home) = home_dir(&env) else {
        warn(defaults::text("setup.msg_no_home"));
        return Ok(64);
    };
    let mut cx = Ctx { home, env, code: 0 };
    let verb = args.first().map(String::as_str).unwrap_or("");
    let o = parse_args(args.get(1..).unwrap_or(&[]));
    match verb {
        "status" => cmd_status(&mut cx)?,
        "enable" => cmd_enable(&mut cx, &o)?,
        "disable" => cmd_disable(&mut cx)?,
        "set-key" => cmd_set_key(&mut cx, &o)?,
        "bind-generic-key" => cmd_bind_generic_key(&mut cx, &o)?,
        "mode" => cmd_mode(&mut cx, &o)?,
        _ => {
            warn(defaults::text("setup.msg_usage"));
            cx.code = 1;
        }
    }
    Ok(cx.code)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home() -> Result<PathBuf, SetupError> {
        let d = std::env::temp_dir().join(format!("ah-setup-{}-{:?}", std::process::id(), std::thread::current().id()));
        if d.exists() {
            std::fs::remove_dir_all(&d).map_err(io_err("clear the scratch home"))?;
        }
        std::fs::create_dir_all(&d).map_err(io_err("make the scratch home"))?;
        Ok(d)
    }

    #[test]
    fn a_setting_is_added_to_the_store_and_the_other_keys_keep_their_order() -> Result<(), SetupError> {
        let h = home()?;
        std::fs::create_dir_all(h.join(".anti-hall")).map_err(io_err("make the state directory"))?;
        std::fs::write(h.join(".anti-hall/settings.json"), r#"{"b":1,"jev":{"z":2,"transport":"vercel"},"a":{}}"#).map_err(io_err("seed settings"))?;
        settings_set(&h, "jev", "enabled", J::Bool(true))?;
        let text = std::fs::read_to_string(h.join(".anti-hall/settings.json")).map_err(io_err("read settings"))?;
        assert_eq!(text, "{\n  \"b\": 1,\n  \"jev\": {\n    \"z\": 2,\n    \"transport\": \"vercel\",\n    \"enabled\": true\n  },\n  \"a\": {}\n}\n");
        Ok(())
    }

    #[test]
    fn a_corrupt_settings_file_is_set_aside_not_overwritten() -> Result<(), SetupError> {
        let h = home()?;
        std::fs::create_dir_all(h.join(".anti-hall")).map_err(io_err("make the state directory"))?;
        std::fs::write(h.join(".anti-hall/settings.json"), "{broken").map_err(io_err("seed settings"))?;
        settings_set(&h, "jev", "enabled", J::Bool(true))?;
        let kept: Vec<String> = std::fs::read_dir(h.join(".anti-hall"))
            .map_err(io_err("list"))?
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains(".corrupt-"))
            .collect();
        assert_eq!(kept.len(), 1);
        let aside = std::fs::read_to_string(h.join(".anti-hall").join(&kept[0])).map_err(io_err("read the copy"))?;
        assert_eq!(aside, "{broken");
        Ok(())
    }

    #[test]
    fn a_value_that_is_not_allowed_is_refused_and_nothing_is_written() -> Result<(), SetupError> {
        let h = home()?;
        let r = settings_set(&h, "jev", "transport", J::Str("other".into()));
        assert!(matches!(r, Err(SetupError::Msg(ref m)) if m.contains("must be one of")));
        assert!(!h.join(".anti-hall/settings.json").exists());
        Ok(())
    }

    #[test]
    fn a_key_is_printable_unless_it_holds_a_control_character() {
        assert!(printable("sk-abc_123.xyz"));
        assert!(!printable("a\u{1}b"));
        assert!(!printable("a\u{7f}"));
    }

    #[test]
    fn the_credit_line_names_the_amount_and_whether_it_was_cached() {
        let ok = Credit(J::Obj(vec![("ok".into(), J::Bool(true)), ("balanceUsd".into(), J::Num(12.345)), ("cached".into(), J::Bool(true))]));
        assert_eq!(credit_line(&ok).as_deref(), Some("credit balance (vercel): $12.35 (cached)"));
        let off = Credit(J::Obj(vec![("ok".into(), J::Bool(false)), ("reason".into(), J::Str("disabled".into()))]));
        assert_eq!(credit_line(&off), None);
    }
}
