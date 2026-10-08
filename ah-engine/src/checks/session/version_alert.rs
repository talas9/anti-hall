//! Built-in `check = "version-alert"`: a port of the Node SessionStart hook `hooks/version-alert.js`.
//!
//! Two independent cases, as in Node. Case 2 (checked first, no network): a newer release is already mirrored into the
//! local plugin cache than the one running, so the user only needs to reload; the advice depends on whether the host's
//! plugin registry has caught up. Case 1: a fresh remote-latest cache names a newer release, so the user needs to update.
//! A stale or absent remote cache makes Node start a detached refresh process, which is Node's job, so the engine defers
//! then (before writing anything).
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - text that does not parse or decode is the absent value (Node Number()/JSON.parse catch parity)
// - an unreadable optional file is the same as an absent one (fail-open, as Node's try/catch)
// - an absent field is the empty value
// A failure that must be seen goes through `crate::discard` instead.

use super::drift::{self, Cache};
use super::jval::{J, Parsed, obj, parse};
use super::{emit, home_of, is_session_start, is_word, join, js_parse_int, now_ms, plugin_root, read_text, skipped, switch_on, truthy};
use crate::checks::git::util::Settings;
use crate::checks::guardkit::msg::{self, Kind, Parts};
use crate::checks::guardkit::paths::{is_absolute, resolve_abs};
use crate::checks::guardkit::text::{is_js_space, js_trim, slice_utf16};
use crate::checks::{Check, Verdict};
use crate::defaults;
use crate::reqenv::RequestEnv;
use crate::rules::Subject;
use serde_json::Value;

/// The registered `version-alert` check.
pub struct VersionAlert;

impl Check for VersionAlert {
    fn name(&self) -> &'static str {
        "version-alert"
    }

    fn summary(&self) -> &'static str {
        defaults::text("session.version_alert_summary")
    }

    fn run(&self, _s: &Subject<'_>, _opts: &Value) -> Option<Verdict> {
        Some(Verdict::Defer)
    }

    fn run_env(&self, s: &Subject<'_>, payload: &Value, opts: &Value, env: &RequestEnv) -> Option<Verdict> {
        if !is_session_start(s) {
            return Some(Verdict::Defer);
        }
        Some(decide(payload, opts, env))
    }
}

/// `semverGreater(a, b)`: `a > b` by three dot-separated integers read with `parseInt`; any part that is not a number
/// (or fewer than three parts) gives false, never an alert.
pub(crate) fn semver_greater(a: &str, b: &str) -> bool {
    let parts = |s: &str| -> Option<[f64; 3]> {
        let t = s.strip_prefix('v').unwrap_or(s);
        let v: Vec<f64> = t.split('.').map(js_parse_int).collect();
        let first: [f64; 3] = v.get(..3)?.try_into().ok()?;
        first.iter().all(|x| !x.is_nan()).then_some(first)
    };
    let (Some(x), Some(y)) = (parts(a), parts(b)) else { return false };
    for i in 0..3 {
        if x[i] != y[i] {
            return x[i] > y[i];
        }
    }
    false
}

/// `^v?\d+\.\d+\.\d+$` on a directory name.
fn is_version_dir(name: &str) -> bool {
    let t = name.strip_prefix('v').unwrap_or(name);
    let mut n = 0;
    t.split('.').all(|p| {
        n += 1;
        !p.is_empty() && p.chars().all(|c| c.is_ascii_digit())
    }) && n == 3
}

/// `newestMirroredVersion(root)`: the highest `vX.Y.Z` directory name under the plugin cache, or `None`.
fn newest_mirrored_version(root: &str) -> Option<String> {
    let mut names: Vec<String> = std::fs::read_dir(root)
        .ok()?
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| is_version_dir(n))
        .collect();
    if names.is_empty() {
        return None;
    }
    // libuv lists a directory sorted by name (byte order); the stable sort below keeps that order for equal versions
    names.sort();
    names.sort_by(|a, b| {
        if semver_greater(a, b) {
            std::cmp::Ordering::Less
        } else if semver_greater(b, a) {
            std::cmp::Ordering::Greater
        } else {
            std::cmp::Ordering::Equal
        }
    });
    names.into_iter().next()
}

/// `^##\s+v?<bare>\b` on one line.
fn is_version_heading(line: &str, bare: &str) -> bool {
    let Some(r) = line.strip_prefix("##") else { return false };
    let r2 = r.trim_start_matches(is_js_space);
    if r2.len() == r.len() {
        return false;
    }
    let r3 = r2.strip_prefix('v').unwrap_or(r2);
    r3.strip_prefix(bare).is_some_and(|rest| !rest.chars().next().is_some_and(is_word))
}

/// `^##\s+` on one line.
fn is_any_heading(line: &str) -> bool {
    line.strip_prefix("##").is_some_and(|r| r.starts_with(is_js_space))
}

/// `/^-\s+(.+)/` on a trimmed line: the text after the dash and its white space, up to the first line terminator.
fn bullet_text(trimmed: &str) -> Option<&str> {
    let r = trimmed.strip_prefix('-')?;
    let body = r.trim_start_matches(is_js_space);
    if body.len() == r.len() {
        return None;
    }
    let end = body.find(['\n', '\r', '\u{2028}', '\u{2029}']).unwrap_or(body.len());
    (end > 0).then(|| &body[..end])
}

/// `changelogHeadline(dir)`: the first bullet under that version's heading in the mirrored copy's CHANGELOG.md, cut to the
/// configured length. `Err(())` when the cut would split a surrogate pair (JavaScript keeps half of it, a Rust string
/// cannot), so the caller defers.
fn changelog_headline(home: &str, dir: &str) -> Result<Option<String>, ()> {
    let path = join(&join(&join(home, defaults::text("session.mirror_cache_root")), dir), defaults::text("session.changelog_file"));
    let Some(raw) = read_text(&path) else { return Ok(None) };
    let bare = dir.strip_prefix('v').unwrap_or(dir);
    let mut in_section = false;
    for line in raw.split('\n') {
        if is_version_heading(line, bare) {
            in_section = true;
            continue;
        }
        if in_section {
            if is_any_heading(line) {
                break;
            }
            if let Some(text) = bullet_text(js_trim(line)) {
                return slice_utf16(text, defaults::num("session.headline_max") as usize).map(Some).ok_or(());
            }
        }
    }
    Ok(None)
}

/// `isSemver(v)` of `update.js`: `N.N.N` with an optional `-` or `+` suffix, after trimming and dropping one `v`.
pub(crate) fn is_semver(v: &str) -> bool {
    let t = js_trim(v);
    let t = t.strip_prefix(['v', 'V']).unwrap_or(t);
    let (core, suffix) = match t.find(['-', '+']) {
        Some(i) => (&t[..i], Some(&t[i + 1..])),
        None => (t, None),
    };
    let nums: Vec<&str> = core.split('.').collect();
    nums.len() == 3
        && nums.iter().all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
        && suffix.is_none_or(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-'))
}

/// `versionFromInstalledJson` of `update.js` over a parsed registry; `None` when no valid version is found.
fn version_from_registry(data: &J) -> Option<String> {
    if !matches!(data, J::Obj(_) | J::Arr(_)) {
        return None;
    }
    let reg = match data.get("plugins") {
        Some(p @ (J::Obj(_) | J::Arr(_))) => p,
        _ => data,
    };
    match reg.get(defaults::text("session.registry_key"))? {
        J::Arr(entries) => {
            let valid: Vec<&J> = entries.iter().filter(|e| matches!(e, J::Obj(_)) && e.get("version").and_then(J::as_str).is_some_and(is_semver)).collect();
            let scope = |s: &str| valid.iter().find(|e| e.get("scope").and_then(J::as_str) == Some(s)).copied();
            let pick = scope("user").or_else(|| scope("project")).or_else(|| valid.first().copied())?;
            pick.get("version").and_then(J::as_str).map(str::to_string)
        }
        J::Str(s) => is_semver(s).then(|| s.clone()),
        e @ J::Obj(_) => e.get("version").and_then(J::as_str).filter(|v| is_semver(v)).map(str::to_string),
        _ => None,
    }
}

/// The version the host's plugin registry (`installed_plugins.json`) names, found the way `update.js` finds it.
/// `Err(())` when the registry text may parse differently here and in JavaScript.
pub(crate) fn harness_version(env: &RequestEnv, home: &str) -> Result<Option<String>, ()> {
    let mut marketplace = join(home, defaults::text("session.marketplace_dir"));
    if let Some(o) = env.get(defaults::text("session.marketplace_env")).filter(|o| !o.is_empty())
        && is_absolute(o)
        && std::fs::metadata(o).is_ok_and(|m| m.is_dir())
    {
        marketplace = o.to_string();
    }
    let plugins_root = resolve_abs(&format!("{marketplace}/../.."));
    let file = join(&plugins_root, defaults::text("session.registry_file"));
    let Ok(meta) = std::fs::metadata(&file) else { return Ok(None) };
    if meta.len() > defaults::num("session.registry_max_bytes") {
        return Ok(None);
    }
    let Some(text) = read_text(&file) else { return Ok(None) };
    match parse(&text) {
        Parsed::Ok(v) => Ok(version_from_registry(&v)),
        Parsed::Bad => Ok(None),
        Parsed::Unsure => Err(()),
    }
}

/// `isSubagentPayload(payload)`.
fn is_subagent(p: &Value) -> bool {
    let field = |k: &str| p.get(k);
    field("agent_id").is_some_and(truthy)
        || field("agent_type").is_some_and(truthy)
        || field("isSidechain") == Some(&Value::Bool(true))
        || field("is_sidechain") == Some(&Value::Bool(true))
}

fn decide(payload: &Value, opts: &Value, env: &RequestEnv) -> Verdict {
    if super::judge_child(env) {
        return Verdict::Allow;
    }
    let (Some(home), Some(root)) = (home_of(env), plugin_root(opts, env)) else { return Verdict::Defer };
    let st = Settings::from_env(env);
    if !switch_on(&st, "session.setting_version_alert") || skipped(&st, defaults::text("session.version_alert_guard")) {
        return Verdict::Allow;
    }
    if is_subagent(payload) {
        return Verdict::Allow;
    }
    let session_id = payload.get("session_id").and_then(Value::as_str).unwrap_or("");

    // the running version: plugin.json beside the hooks directory; unreadable or without a version, Node throws and says nothing
    let running = match read_text(&join(&root, defaults::text("session.plugin_json"))).map(|t| parse(&t)) {
        Some(Parsed::Ok(v)) => match v.get("version").and_then(J::as_str).filter(|s| !s.is_empty()) {
            Some(s) => s.to_string(),
            None => return Verdict::Allow,
        },
        Some(Parsed::Unsure) => return Verdict::Defer,
        _ => return Verdict::Allow,
    };
    let now = now_ms();
    let guard = defaults::text("session.version_alert_guard");

    // CASE 2: a newer release is already mirrored locally: reload only
    let mirror = join(&home, defaults::text("session.mirror_cache_root"));
    if let Some(mirrored) = newest_mirrored_version(&mirror).filter(|m| semver_greater(m, &running)) {
        let mark_file = join(&home, defaults::text("session.reload_mark_file"));
        let marker = match drift::read_cache(&mark_file, |_| true) {
            Cache::Valid(m) => Some(m),
            Cache::Stale => None,
            Cache::Unsure => return Verdict::Defer,
        };
        let key = obj(vec![
            ("case", J::Str(defaults::text("session.case_reload").to_string())),
            ("sessionId", J::Str(session_id.to_string())),
            ("mirrored", J::Str(mirrored.clone())),
            ("running", J::Str(running.clone())),
        ]);
        if !session_id.is_empty() && marker.as_ref().is_some_and(|m| drift::already_advised_key(m, &key)) {
            return Verdict::Allow;
        }
        let Ok(headline) = changelog_headline(&home, &mirrored) else { return Verdict::Defer };
        let Ok(harness) = harness_version(env, &home) else { return Verdict::Defer };
        let (mut registered, mut registry_ahead) = (true, false);
        if let Some(h) = harness.filter(|h| is_semver(h)) {
            if semver_greater(&mirrored, &h) {
                registered = false;
            } else if semver_greater(&h, &running) {
                registry_ahead = true;
            }
        }
        let hl = headline.map(|h| format!("{}{h}", defaults::text("session.highlight_prefix"))).unwrap_or_default();
        let extra = [hl.as_str()];
        let vars = [("mirrored", mirrored.as_str()), ("running", running.as_str())];
        let text = if registered {
            let what = msg::render("session.reload_what", &vars);
            let instead = msg::render(if registry_ahead { "session.reload_instead_ahead" } else { "session.reload_instead" }, &vars);
            msg::message(Kind::Update, guard, &Parts { what: &what, instead: &instead, extra: &extra, ..Parts::default() })
        } else {
            let what = msg::render("session.unregistered_what", &vars);
            msg::message(
                Kind::Update,
                guard,
                &Parts {
                    what: &what,
                    why: defaults::text("session.unregistered_why"),
                    instead: defaults::text("session.unregistered_instead"),
                    extra: &extra,
                    ..Parts::default()
                },
            )
        };
        if !session_id.is_empty() {
            let base = marker.unwrap_or_else(|| obj(vec![("checkedAt", J::Num(now))]));
            drift::persist_advised_key(&mark_file, &base, key);
        }
        return emit(&text);
    }

    // CASE 1: the remote-latest cache
    let file = join(&home, defaults::text("session.version_check_file"));
    let cache = match drift::read_cache(&file, |c| c.get("latest").and_then(J::as_str).is_some()) {
        Cache::Valid(c) if drift::is_fresh(&c, now, defaults::num("session.version_alert_ttl_ms") as f64) => c,
        // stale or absent: Node starts the detached refresh probe, so Node runs
        _ => return Verdict::Defer,
    };
    let latest = cache.get("latest").and_then(J::as_str).unwrap_or("");
    if !semver_greater(latest, &running) {
        return Verdict::Allow;
    }
    let key = obj(vec![
        ("case", J::Str(defaults::text("session.case_update").to_string())),
        ("sessionId", J::Str(session_id.to_string())),
        ("latest", J::Str(latest.to_string())),
        ("running", J::Str(running.clone())),
    ]);
    if !session_id.is_empty() && drift::already_advised_key(&cache, &key) {
        return Verdict::Allow;
    }
    let what = msg::render("session.update_what", &[("latest", latest), ("running", running.as_str())]);
    let text = msg::message(Kind::Update, guard, &Parts { what: &what, instead: defaults::text("session.update_instead"), ..Parts::default() });
    if !session_id.is_empty() {
        drift::persist_advised_key(&file, &cache, key);
    }
    emit(&text)
}
