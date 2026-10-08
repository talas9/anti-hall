//! The Stop that blocks: everything `tasklist-guard.js` `main` does once it has decided the session did tracked-work-sized
//! work without tracking it (no task activity, tasks stalled in progress, or a missing or stale progress file).
//!
//! In Node order: the nag form (`lib/task-tool-evidence.js`: full, reduced or none), the Jev consult (`tasklistTrivial`,
//! relax-block), the loop state (dedupe on the signal hash, the block cap), the session start for the progress header, the
//! stale-build downgrade (`lib/stop-version-gate.js`), the signature acknowledgement (`lib/stop-ack.js`), the block text
//! (`lib/block-message.js`), the oh-my-claudecode loop advisory (`omc-detect.js`), the once-per-session handover advisories,
//! the per-prompt budget and the reduced-nag cap (`lib/stop-policy.js`), the state write, the prune and the acknowledgement
//! hint. Everything that may need Node (a file or date only JavaScript reads exactly, a cut through a surrogate pair) is
//! decided before the first file is written or the Jev ask goes out, so a deferral never follows an effect.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an unreadable optional file is the same as an absent one (fail-open, as Node's try/catch)
// - a failed best-effort write (a marker, a sweep stamp) is ignored, as Node ignores it
// A failure that must be seen goes through `crate::discard` instead.

use super::sanitize_reason;
use super::scan::Scan;
use crate::checks::agent_scan;
use crate::checks::git::util::Settings;
use crate::checks::guardkit::jsre;
use crate::checks::guardkit::msg::{self, Kind, Parts};
use crate::checks::guardkit::paths::{is_absolute, join, resolve_abs};
use crate::checks::guardkit::settings::{get_bool, get_number, get_setting};
use crate::checks::guardkit::text::js_trim;
use crate::checks::jsport::date::{self, Parsed, ZoneGuard};
use crate::checks::jsport::json::{self, Fail, J};
use crate::checks::jsport::num::to_js_string;
use crate::checks::jsport::{fsx, home, text as jstext};
use crate::checks::taskkit::jsval::{R, Unsure};
use crate::checks::taskkit::time;
use crate::checks::taskstate::tail::{lines_of, read_tail};
use crate::checks::{Exact, Verdict};
use crate::defaults;
use crate::reqenv::RequestEnv;
use serde_json::Value;

/// What the quiet half worked out, handed to the block path.
pub(super) struct Fire<'a> {
    pub p: &'a Value,
    pub st: &'a Settings,
    pub plugin_root: &'a str,
    pub transcript: &'a str,
    /// `String(payload.session_id)`, empty when absent.
    pub raw_sid: &'a str,
    /// The session id as it goes into paths (`sanitizeSessionId`).
    pub sid: &'a str,
    pub date: &'a str,
    /// The resolved project root, when `cwd` is a non-empty string.
    pub root: Option<&'a str>,
    pub progress_rel: String,
    pub history_rel: String,
    pub progress_abs: Option<&'a str>,
    pub history_abs: Option<&'a str>,
    pub scan: &'a Scan,
    pub needs_agents: bool,
    pub progress_fresh: bool,
    pub threshold: f64,
    /// `detectPlatform(payload) === 'codex'`.
    pub codex: bool,
}

fn t(k: &str) -> &'static str {
    defaults::text(&format!("tasklist_guard.{k}"))
}

fn n(k: &str) -> u64 {
    defaults::num(&format!("tasklist_guard.{k}"))
}

fn depth() -> usize {
    n("json_max_depth") as usize
}

/// `JSON.parse(text)`: `None` where JavaScript throws, `Err` where it reads what this parser does not reproduce.
fn parse(text: &str) -> R<Option<J>> {
    match json::parse(text, depth()) {
        Ok(v) => Ok(Some(v)),
        Err(Fail::Invalid) => Ok(None),
        Err(Fail::Unsupported) => Err(Unsure),
    }
}

/// `Date.parse(s)`: `None` for NaN.
fn date_parse(s: &str) -> R<Option<f64>> {
    match date::parse(s) {
        Parsed::Ms(ms) if ms.is_finite() => Ok(Some(ms)),
        Parsed::Ms(_) | Parsed::Nan => Ok(None),
        Parsed::Unknown => Err(Unsure),
    }
}

/// `new Date(ms).toISOString()`.
fn iso(ms: f64) -> R<String> {
    date::to_iso(ms).ok_or(Unsure)
}

fn sha1(s: &str) -> String {
    jstext::sha1_hex(s.as_bytes())
}

/// The stalled-in-progress sub-cause: more than one actionable task in progress and no agent provably running.
fn stalled(f: &Fire<'_>) -> R<bool> {
    if !f.needs_agents {
        return Ok(false);
    }
    let opts = agent_scan::Opts { now_ms: agent_scan::now_ms(), ignore_unanswered_stops: false };
    match agent_scan::running_agents_or_null(f.transcript, &opts) {
        Ok(Some(rows)) => Ok(rows.is_empty()),
        Ok(None) => Ok(false),
        Err(_) => Err(Unsure),
    }
}

/// `entryIsEvidence(entry)` of `lib/task-tool-evidence.js`.
fn entry_is_evidence(e: &J) -> bool {
    let J::Obj(_) = e else { return false };
    let names = defaults::list("tasklist_guard.task_tool_names");
    match e.get("type") {
        Some(J::Str(ty)) if ty == "assistant" => {
            let Some(J::Arr(content)) = e.get("message").and_then(|m| m.get("content")) else { return false };
            content.iter().any(|b| {
                matches!(b.get("type"), Some(J::Str(x)) if x == "tool_use") && matches!(b.get("name"), Some(J::Str(nm)) if names.contains(&nm.as_str()))
            })
        }
        Some(J::Str(ty)) if ty == "attachment" => {
            let Some(a @ (J::Obj(_) | J::Arr(_))) = e.get("attachment") else { return false };
            match a.get("type") {
                Some(J::Str(at)) if at == t("evidence_reminder") => true,
                Some(J::Str(at)) if at.starts_with(t("evidence_deferred_prefix")) => {
                    matches!(a.get("addedNames"), Some(J::Arr(added)) if added.iter().any(|x| matches!(x, J::Str(s) if s == t("evidence_tool"))))
                }
                _ => false,
            }
        }
        _ => false,
    }
}

/// `hasEvidence(transcriptPath)`: some line of the last 16 MB proves the session has task tools.
fn has_evidence(path: &str) -> R<bool> {
    let Some((text, cut)) = read_tail(path, defaults::num("tasklist_guard.wide_window_bytes")) else { return Ok(false) };
    let pre = defaults::list("tasklist_guard.evidence_names");
    for line in lines_of(&text, cut) {
        if !pre.iter().any(|p| line.contains(p)) {
            continue;
        }
        if let Some(e) = parse(line)?
            && entry_is_evidence(&e)
        {
            return Ok(true);
        }
    }
    Ok(false)
}

/// `nagForm({codex, transcriptPath})`: full, reduced or skip.
fn nag_form(f: &Fire<'_>) -> R<&'static str> {
    let full = t("form_full");
    let unset = Value::String(String::from('\u{0}'));
    let entry = defaults::raw("tasklist_guard.no_task_tools_setting");
    let v = get_setting(f.st, entry, Some(unset.clone()), f.plugin_root).map_err(|_| Unsure)?;
    let explicit = v.as_ref() != Some(&unset);
    let v = if explicit { v.as_ref().and_then(Value::as_str).unwrap_or("").to_string() } else { t("form_reduced").to_string() };
    if !explicit {
        let level = get_setting(f.st, defaults::raw("tasklist_guard.protocol_setting"), None, f.plugin_root).map_err(|_| Unsure)?;
        if level.as_ref().and_then(Value::as_str) == Some(full) {
            return Ok(full);
        }
    }
    let cfg = if v == full {
        full
    } else if v == t("form_skip") {
        t("form_skip")
    } else {
        t("form_reduced")
    };
    if cfg == full || !f.codex || has_evidence(f.transcript)? {
        return Ok(full);
    }
    Ok(cfg)
}

/// The loop state file: `(hash, blocks, started)`.
fn read_state(path: &str) -> R<(String, f64, String)> {
    let mut out = (String::new(), 0.0, String::new());
    let Some(raw) = fsx::read_utf8(path) else { return Ok(out) };
    let raw = js_trim(&raw);
    if raw.is_empty() {
        return Ok(out);
    }
    let Some(v @ (J::Obj(_) | J::Arr(_))) = parse(raw)? else { return Ok(out) };
    if let Some(J::Str(h)) = v.get("hash") {
        out.0 = h.clone();
    }
    if let Some(J::Num(b)) = v.get("blocks")
        && b.is_finite()
    {
        out.1 = *b;
    }
    if let Some(J::Str(s)) = v.get("started")
        && date_parse(s)?.is_some()
    {
        out.2 = s.clone();
    }
    Ok(out)
}

/// `firstTranscriptIso(path)`: the first timestamped entry of the transcript head, as ISO text; empty when none.
fn first_transcript_iso(path: &str) -> R<String> {
    use std::io::Read;
    let Ok(fh) = std::fs::File::open(path) else { return Ok(String::new()) };
    let mut buf = Vec::new();
    if fh.take(n("head_bytes")).read_to_end(&mut buf).is_err() {
        return Ok(String::new());
    }
    let text = crate::checks::guardkit::text::lossy_owned(buf);
    for line in text.split('\n') {
        if js_trim(line).is_empty() {
            continue;
        }
        let Some(e) = parse(line)? else { continue };
        if let Some(J::Str(ts)) = e.get("timestamp")
            && let Some(ms) = date_parse(ts)?
        {
            return iso(ms);
        }
    }
    Ok(String::new())
}

/// `readJsonBounded(path)` of `update.js`.
fn read_json_bounded(path: &str) -> R<Option<J>> {
    let Ok(m) = std::fs::metadata(path) else { return Ok(None) };
    if m.len() > n("registry_max_bytes") {
        return Ok(None);
    }
    let Some(text) = fsx::read_utf8(path) else { return Ok(None) };
    parse(&text)
}

/// `isSemver(v)` of `update.js`: `N.N.N` with an optional `-` or `+` suffix, after trimming and dropping one `v`.
fn is_semver(v: &str) -> bool {
    let tv = js_trim(v);
    let tv = tv.strip_prefix(['v', 'V']).unwrap_or(tv);
    let (core, suffix) = match tv.find(['-', '+']) {
        Some(i) => (&tv[..i], Some(&tv[i + 1..])),
        None => (tv, None),
    };
    let nums: Vec<&str> = core.split('.').collect();
    nums.len() == 3
        && nums.iter().all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
        && suffix.is_none_or(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-'))
}

/// `parseVersion(v)` of `update.js` for a semver string: its leading dotted numbers.
fn version_parts(v: &str) -> Vec<f64> {
    let tv = js_trim(v);
    let tv = tv.strip_prefix(['v', 'V']).unwrap_or(tv);
    let lead: String = tv.chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
    lead.split('.').take_while(|p| !p.is_empty()).map(|p| p.parse::<f64>().unwrap_or(0.0)).collect()
}

/// `compareVersions(a, b) < 0` of `update.js`, for two semver strings.
fn version_less(a: &str, b: &str) -> bool {
    let (pa, pb) = (version_parts(a), version_parts(b));
    for i in 0..pa.len().max(pb.len()) {
        let (x, y) = (pa.get(i).copied().unwrap_or(0.0), pb.get(i).copied().unwrap_or(0.0));
        if x != y {
            return x < y;
        }
    }
    false
}

/// `versionFromInstalledJson(path)` of `update.js`.
fn registry_version(data: &J) -> Option<String> {
    let reg = match data.get("plugins") {
        Some(p @ (J::Obj(_) | J::Arr(_))) => p,
        _ => data,
    };
    let semver = |e: &J| matches!(e.get("version"), Some(J::Str(v)) if is_semver(v));
    match reg.get(t("registry_key"))? {
        J::Arr(entries) => {
            let valid: Vec<&J> = entries.iter().filter(|e| matches!(e, J::Obj(_) | J::Arr(_)) && semver(e)).collect();
            let pick = defaults::list("tasklist_guard.registry_scopes")
                .iter()
                .find_map(|s| valid.iter().find(|e| matches!(e.get("scope"), Some(J::Str(x)) if x == s)).copied())
                .or_else(|| valid.first().copied())?;
            match pick.get("version") {
                Some(J::Str(v)) => Some(v.clone()),
                _ => None,
            }
        }
        J::Str(s) => is_semver(s).then(|| s.clone()),
        e @ J::Obj(_) if semver(e) => match e.get("version") {
            Some(J::Str(v)) => Some(v.clone()),
            _ => None,
        },
        _ => None,
    }
}

/// `isStale(pluginRoot, {env, home})` of `lib/stop-version-gate.js`: the host registered a newer anti-hall than the one
/// whose hooks run. The plugin root is the engine's own (the Node hook it stands in for lives under it).
fn version_stale(f: &Fire<'_>, home: Option<&str>) -> R<bool> {
    // `resolveHome()` throws on a test run against the real home: the gate is skipped and the block goes ahead
    let Some(home) = home else { return Ok(false) };
    if !get_bool(f.st, defaults::raw("tasklist_guard.version_setting")) {
        return Ok(false);
    }
    if f.plugin_root.is_empty() {
        return Err(Unsure);
    }
    let mut market = join(home, t("marketplace_dir"));
    if let Some(o) = f.st.env.get(t("marketplace_env")).filter(|o| !o.is_empty())
        && is_absolute(o)
        && std::fs::metadata(o).is_ok_and(|m| m.is_dir())
    {
        market = o.clone();
    }
    let registry = join(&resolve_abs(&format!("{market}/../..")), t("registry_file"));
    let Some(harness) = read_json_bounded(&registry)?.and_then(|d| registry_version(&d)) else { return Ok(false) };
    let Some(text) = fsx::read_utf8(&join(f.plugin_root, t("plugin_json"))) else { return Ok(false) };
    let running = match parse(&text)? {
        Some(v) => match v.get("version") {
            Some(J::Str(s)) => s.clone(),
            _ => return Ok(false),
        },
        None => return Ok(false),
    };
    if !is_semver(&harness) || !is_semver(&running) {
        return Ok(false);
    }
    Ok(version_less(&running, &harness))
}

/// `statePath(home, sessionId)` of `lib/stop-ack.js`.
fn ack_path(home: &str, session: &str) -> String {
    let safe: String = jstext::safe_name(session).chars().take(n("ack_session_max") as usize).collect();
    let dir = t("ack_dir");
    format!("{}/{dir}/{dir}-{safe}{}", join(home, defaults::text("paths.base_dir")), t("state_ext"))
}

/// `isAcked(home, sessionId, hook, signature)` of `lib/stop-ack.js`.
fn is_acked(f: &Fire<'_>, home: &str, session: &str, key: &str) -> R<bool> {
    if !get_bool(f.st, defaults::raw("tasklist_guard.ack_setting")) {
        return Ok(false);
    }
    let Some(text) = fsx::read_utf8(&ack_path(home, session)) else { return Ok(false) };
    let state = match parse(&text)? {
        Some(o @ J::Obj(_)) => o,
        _ => return Ok(false),
    };
    Ok(matches!(state.get(key), Some(J::Num(v)) if v.is_finite() && *v > 0.0))
}

/// `isCodexPayload(payload)` of `coordinator-detect.js`.
fn codex_host(p: &Value) -> bool {
    let Some(o) = p.as_object() else { return false };
    if o.get("tool_name").and_then(Value::as_str) == Some(t("codex_tool")) {
        return true;
    }
    defaults::list("tasklist_guard.codex_fields").iter().all(|k| o.get(*k).and_then(Value::as_str).is_some_and(|s| !s.is_empty()))
}

/// `findPriorSessionStateFile(root, date, sid)`: the newest handover state file another session left today, as a path
/// relative to the root.
fn prior_state_file(root: &str, date: &str, sid: &str) -> Option<String> {
    let mut segs: Vec<String> = defaults::list("tasklist_guard.handovers_dir").iter().map(|s| s.to_string()).collect();
    segs.push(date.to_string());
    let rel_day = segs.join("/");
    let day = join(root, &rel_day);
    let mut best: Option<String> = None;
    let mut best_mtime = -1.0f64;
    for (name, ft) in fsx::read_dir_names(&day)? {
        if !ft.is_dir() || name == sid {
            continue;
        }
        let state = format!("{day}/{name}/{}", t("handover_state_file"));
        let Ok(m) = std::fs::symlink_metadata(&state) else { continue };
        if !m.is_file() {
            continue;
        }
        let mt = fsx::mtime_ms(&m);
        if mt > best_mtime {
            best_mtime = mt;
            best = Some(format!("{rel_day}/{name}/{}", t("handover_state_file")));
        }
    }
    best
}

/// `isOmcLoopActive({cwd, sessionId})` of `omc-detect.js`.
fn omc_active(f: &Fire<'_>, home: &str) -> R<bool> {
    let env = &f.st.env;
    if env.get(t("omc_kill_env")).map(String::as_str) == Some("1") {
        return Ok(false);
    }
    if env.get(t("omc_skip_env")).is_some_and(|s| s.split(',').any(|x| js_trim(x) == t("omc_skip_token"))) {
        return Ok(false);
    }
    let cwd = match f.p.get("cwd") {
        Some(Value::String(c)) if !c.is_empty() => Some(c.as_str()),
        _ => None,
    };
    let files = defaults::list("tasklist_guard.omc_settings_files");
    let mut sources = vec![join(home, files.first().copied().unwrap_or_default())];
    if let Some(c) = cwd {
        sources.extend(files.iter().map(|fl| join(c, fl)));
    }
    let mut enabled = false;
    for s in sources {
        if settings_enable_omc(&s)? {
            enabled = true;
            break;
        }
    }
    if !enabled {
        return Ok(false);
    }
    let state_rel = defaults::list("tasklist_guard.omc_state_dir").join("/");
    let root = match cwd.map(|c| join(c, &state_rel)) {
        Some(d) if std::fs::metadata(&d).is_ok_and(|m| m.is_dir()) => d,
        _ => join(home, &state_rel),
    };
    let sid = match f.p.get("session_id") {
        Some(v) if crate::checks::taskkit::jsval::truthy(v) => Some(jstext::js_string(v)),
        _ => None,
    };
    for name in defaults::list("tasklist_guard.omc_state_files") {
        if omc_state_active(&join(&root, name), sid.as_deref())? {
            return Ok(true);
        }
    }
    Ok(false)
}

/// `settingsFileEnablesOmc(path)`.
fn settings_enable_omc(path: &str) -> R<bool> {
    let Ok(m) = std::fs::metadata(path) else { return Ok(false) };
    if m.len() > n("omc_settings_max_bytes") {
        return Ok(false);
    }
    let Some(text) = fsx::read_utf8(path) else { return Ok(false) };
    let Some(v @ (J::Obj(_) | J::Arr(_))) = parse(&text)? else { return Ok(false) };
    Ok(matches!(v.get("enabledPlugins").and_then(|p| p.get(t("omc_plugin"))), Some(J::Bool(true))))
}

/// `String(x)` of a parsed JSON value, where it is certain.
fn j_string(v: &J) -> R<String> {
    match v {
        J::Str(s) => Ok(s.clone()),
        J::Num(x) => Ok(to_js_string(*x)),
        J::Bool(b) => Ok(b.to_string()),
        _ => Err(Unsure),
    }
}

/// `checkStateFile(path, sessionId)`.
fn omc_state_active(path: &str, sid: Option<&str>) -> R<bool> {
    let Ok(m) = std::fs::metadata(path) else { return Ok(false) };
    if m.len() > n("omc_max_bytes") {
        return Ok(false);
    }
    let Some(text) = fsx::read_utf8(path) else { return Ok(false) };
    let Some(state @ (J::Obj(_) | J::Arr(_))) = parse(&text)? else { return Ok(false) };
    if state.get("active") != Some(&J::Bool(true)) {
        return Ok(false);
    }
    let now = date::now_ms();
    let fresh = n("omc_fresh_ms") as f64;
    let mut found = false;
    for k in defaults::list("tasklist_guard.omc_ts_keys") {
        let v = match state.get(k) {
            Some(J::Num(x)) => *x,
            Some(J::Str(s)) => date_parse(s)?.unwrap_or(0.0),
            _ => 0.0,
        };
        let v = if v.is_finite() { v } else { 0.0 };
        if v > 0.0 && now - v <= fresh {
            found = true;
            break;
        }
    }
    if !found {
        return Ok(false);
    }
    match state.get("session_id") {
        None | Some(J::Null) => Ok(true),
        Some(v) => match sid {
            Some(s) if !s.is_empty() => Ok(j_string(v)? == s),
            _ => Ok(false),
        },
    }
}

/// The handover advisory that rides this block, if one is due: the marker file to write, its body and the augmented reason.
fn handover_advisory(f: &Fire<'_>, root: &str, state_dir: &str, safe: &str, reason: &str) -> R<Option<(String, &'static str, String)>> {
    let mut segs: Vec<&str> = defaults::list("tasklist_guard.handovers_dir");
    segs.push(f.date);
    segs.push(f.sid);
    let dir = join(root, &segs.join("/"));
    let ext = t("state_ext");
    if !std::fs::metadata(&dir).is_ok_and(|m| m.is_dir()) {
        let marker = format!("{state_dir}/{}{safe}{ext}", t("advisory_prefix"));
        if std::path::Path::new(&marker).exists() {
            return Ok(None);
        }
        let text = sanitize_reason(&format!("{reason}{}", t("advisory_text"))).ok_or(Unsure)?;
        return Ok(Some((marker, t("advisory_body"), text)));
    }
    let re = jsre::compile(t("handover_file_re"), false);
    let mut newest = 0.0f64;
    for (name, _) in fsx::read_dir_names(&dir).unwrap_or_default() {
        if !re.is_match(&name) {
            continue;
        }
        if let Ok(m) = std::fs::metadata(format!("{dir}/{name}")) {
            newest = newest.max(fsx::mtime_ms(&m));
        }
    }
    let last = if f.scan.last_work_ts.is_finite() { f.scan.last_work_ts } else { 0.0 };
    if newest <= 0.0 || last <= 0.0 || last <= newest + n("handover_grace_ms") as f64 {
        return Ok(None);
    }
    let marker = format!("{state_dir}/{}{safe}{ext}", t("stale_prefix"));
    if std::path::Path::new(&marker).exists() {
        return Ok(None);
    }
    let text = sanitize_reason(&format!("{reason}{}", t("stale_text"))).ok_or(Unsure)?;
    Ok(Some((marker, t("stale_body"), text)))
}

/// `promptKey(payload, transcriptPath)` of `lib/stop-policy.js`.
fn prompt_key(f: &Fire<'_>) -> R<Option<String>> {
    if let Some(Value::String(id)) = f.p.get("prompt_id")
        && !id.is_empty()
    {
        return Ok(Some(id.clone()));
    }
    // `readTail` of `lib/transcript-tail.js`: split on `\n` only, an empty file is no tail
    let Some((text, cut)) = read_tail(f.transcript, n("policy_tail_bytes")).filter(|(d, _)| !d.is_empty()) else { return Ok(None) };
    let mut lines: Vec<&str> = text.split('\n').collect();
    if cut {
        lines.remove(0);
    }
    for line in lines.iter().rev() {
        let tl = js_trim(line);
        if tl.is_empty() || !tl.contains(t("policy_user_marker")) {
            continue;
        }
        let Some(e @ J::Obj(_)) = parse(tl)? else { continue };
        if !matches!(e.get("type"), Some(J::Str(x)) if x == "user") || e.get("isMeta") == Some(&J::Bool(true)) || e.get("isSidechain") == Some(&J::Bool(true)) {
            continue;
        }
        let Some(J::Str(uuid)) = e.get("uuid").filter(|u| matches!(u, J::Str(s) if !s.is_empty())) else { continue };
        let real = match e.get("message").and_then(|m| m.get("content")) {
            Some(J::Str(c)) => !js_trim(c).is_empty(),
            Some(J::Arr(blocks)) => blocks.iter().any(|b| {
                let truthy = match b {
                    J::Null => false,
                    J::Bool(x) => *x,
                    J::Num(x) => *x != 0.0 && !x.is_nan(),
                    J::Str(s) => !s.is_empty(),
                    _ => true,
                };
                truthy && !matches!(b.get("type"), Some(J::Str(x)) if x == "tool_result")
            }),
            _ => false,
        };
        if real {
            return Ok(Some(uuid.clone()));
        }
    }
    Ok(None)
}

/// The stop-policy buckets of one session (`readBuckets`): an object, else empty.
fn read_buckets(path: &str) -> R<J> {
    let Some(text) = fsx::read_utf8(path) else { return Ok(J::Obj(Vec::new())) };
    Ok(match parse(&text)? {
        Some(o @ J::Obj(_)) => o,
        _ => J::Obj(Vec::new()),
    })
}

/// `writeBuckets(file, buckets)`: true when written.
fn write_buckets(path: &str, buckets: &J) -> bool {
    let dir = path.rsplit_once('/').map_or("", |(d, _)| d);
    std::fs::create_dir_all(dir).is_ok() && crate::atomic::write_after_reply(path, json::stringify(buckets), crate::atomic::Style::default()).is_ok()
}

/// One stop-policy step decided before anything is written.
struct Policy {
    file: String,
    buckets: J,
    /// The per-prompt budget and the prompt key, when the budget is on and a key was found.
    prompt: Option<(f64, String)>,
}

impl Policy {
    fn bucket_key(&self, session: &str, kind: &str) -> String {
        format!("{session}|{}|{kind}", t("guard_name"))
    }

    /// `budgetSpent(...)`: true when the per-prompt budget is on and spent (or its count cannot be kept).
    fn budget_spent(&mut self, session: &str, now: f64) -> bool {
        let Some((budget, key)) = self.prompt.clone() else { return false };
        let bk = self.bucket_key(session, t("policy_prompt_kind"));
        let count = match self.buckets.get(&bk) {
            Some(b @ (J::Obj(_) | J::Arr(_))) if matches!(b.get("promptKey"), Some(J::Str(k)) if *k == key) => match b.get("count") {
                Some(J::Num(c)) if c.is_finite() => *c,
                _ => 0.0,
            },
            _ => 0.0,
        };
        if count >= budget {
            return true;
        }
        self.buckets.set(&bk, J::Obj(vec![("promptKey".into(), J::Str(key)), ("count".into(), J::Num(count + 1.0)), ("lastAt".into(), J::Num(now))]));
        !write_buckets(&self.file, &self.buckets)
    }

    /// `consume(home, sessionId, hook, [kind], cap).block`.
    fn consume(&mut self, session: &str, now: f64) -> bool {
        let k = self.bucket_key(session, t("policy_reduced_kind"));
        let count = match self.buckets.get(&k).and_then(|b| b.get("count")) {
            Some(J::Num(c)) if c.is_finite() => *c,
            _ => 0.0,
        };
        if count >= n("policy_reduced_cap") as f64 {
            return false;
        }
        self.buckets.set(&k, J::Obj(vec![("count".into(), J::Num(count + 1.0)), ("lastAt".into(), J::Num(now))]));
        write_buckets(&self.file, &self.buckets)
    }
}

/// The stop-policy state for this Stop, read before anything is written; `None` when the home cannot be resolved (Node's
/// `resolveHome()` throws there and the policy is skipped).
fn policy(f: &Fire<'_>, home: Option<&str>, safe: &str, reduced: bool) -> R<Option<Policy>> {
    let Some(home) = home else { return Ok(None) };
    let v = get_number(f.st, defaults::raw("tasklist_guard.budget_setting"));
    let budget = if v.is_finite() && v > 0.0 { v.floor() } else { 0.0 };
    let prompt = if budget > 0.0 { prompt_key(f)?.map(|k| (budget, k)) } else { None };
    if prompt.is_none() && !reduced {
        return Ok(Some(Policy { file: String::new(), buckets: J::Obj(Vec::new()), prompt: None }));
    }
    let mut dir = join(home, defaults::text("paths.base_dir"));
    for s in defaults::list("tasklist_guard.policy_dir") {
        dir = join(&dir, s);
    }
    let file = format!("{dir}/{safe}{}", t("state_ext"));
    let buckets = read_buckets(&file)?;
    Ok(Some(Policy { file, buckets, prompt }))
}

/// The block path, entered once Node would block on the signals alone.
pub(super) fn fire(f: &Fire<'_>) -> R<Verdict> {
    let req_env = RequestEnv::from_pairs(f.st.env.clone());
    let _zone = ZoneGuard::new(&req_env);
    // the Node hook's `os.homedir()` is HOME; a home the engine only knows from another variable is not reproduced
    if req_env.get(defaults::env_name("home")).is_none_or(str::is_empty) {
        return Err(Unsure);
    }
    let stale = stalled(f)?;
    let scan = f.scan;
    if scan.saw_task_activity && !stale && f.progress_fresh {
        return Ok(Verdict::Allow);
    }
    let form = nag_form(f)?;
    if form == t("form_skip") {
        return Ok(Verdict::Allow);
    }
    let reduced = form == t("form_reduced");
    let work = scan.work_count;
    let threshold = to_js_string(f.threshold);
    let jev_state = msg::render(
        "tasklist_guard.jev_state",
        &[
            ("work", &work.to_string()),
            ("threshold", &threshold),
            ("saw", &scan.saw_task_activity.to_string()),
            ("stale", &stale.to_string()),
            ("fresh", &f.progress_fresh.to_string()),
            ("open", &scan.open_task_ids.len().to_string()),
        ],
    );

    // loop state
    let session = if f.raw_sid.is_empty() { sha1(f.transcript)[..n("session_hash_len") as usize].to_string() } else { f.raw_sid.to_string() };
    let safe = jstext::safe_name(&session);
    let state_dir = join(&f.st.home, defaults::text("paths.base_dir"));
    let ext = t("state_ext");
    let state_file = format!("{state_dir}/{}-{safe}{ext}", t("state_prefix"));
    let bucket = ((work as f64) / f.threshold).floor().min(n("work_bucket_max") as f64);
    let mut ids = scan.open_task_ids.clone();
    ids.sort_by(|a, b| jstext::cmp16(a, b));
    let open_hash = sha1(&ids.join(t("open_ids_sep")))[..n("open_hash_len") as usize].to_string();
    let bit = |b: bool| if b { "1" } else { "0" };
    let sep = t("signal_sep");
    let signal = [to_js_string(bucket), bit(scan.saw_task_activity).into(), bit(stale).into(), bit(f.progress_fresh).into(), open_hash].join(sep);
    let hash = sha1(&signal);
    let (last_hash, blocks, stored_started) = read_state(&state_file)?;
    let jev = || consult_jev(f, &jev_state);
    if hash == last_hash || blocks >= n("max_blocks") as f64 {
        jev();
        return Ok(Verdict::Allow);
    }

    // everything below is read or computed before the first effect
    let started = if stored_started.is_empty() {
        let first = first_transcript_iso(f.transcript)?;
        if first.is_empty() { time::iso(time::now_ms()) } else { first }
    } else {
        stored_started
    };
    let home = home::resolve(&req_env);
    let version_stale = version_stale(f, home.as_deref())?;
    let sig = sha1(&hash)[..n("ack_sig_len") as usize].to_string();
    let ack_key = format!("{}:{sig}", t("guard_name"));
    let acked = match home.as_deref() {
        Some(h) => is_acked(f, h, &session, &ack_key)?,
        None => false,
    };
    let codex = codex_host(f.p);
    let progress_path = f.progress_abs.map_or_else(|| f.progress_rel.clone(), str::to_string);
    let history_path = f.history_abs.map_or_else(|| f.history_rel.clone(), str::to_string);
    let header = msg::render(
        "tasklist_guard.header",
        &[("session", if f.raw_sid.is_empty() { defaults::text("taskkit.unknown_session") } else { f.raw_sid }), ("started", &started)],
    );
    let work_s = work.to_string();
    let (mut what, mut why);
    if !scan.saw_task_activity && scan.task_store_reset {
        what = t("what_reset").to_string();
        why = t("why_reset").to_string();
    } else if !scan.saw_task_activity {
        what = msg::render("tasklist_guard.what_no_tasks", &[("n", &work_s)]);
        why = t("why_no_tasks").to_string();
        if let Some(prior) = f.root.and_then(|r| prior_state_file(r, f.date, f.sid)) {
            why.push_str(&msg::render("tasklist_guard.prior_snapshot", &[("path", &prior)]));
        }
    } else if stale {
        what = msg::render("tasklist_guard.what_stalled", &[("n", &scan.in_progress_count.to_string())]);
        why = t("why_stalled").to_string();
    } else {
        what = msg::render("tasklist_guard.what_progress", &[("n", &work_s), ("path", &progress_path)]);
        why = t("why_progress").to_string();
    }
    let instead = if reduced {
        if !scan.task_store_reset {
            what = msg::render("tasklist_guard.what_reduced", &[("n", &work_s)]);
            why = t("why_reduced").to_string();
        }
        msg::render("tasklist_guard.instead_reduced", &[("progress", &progress_path), ("history", &history_path)])
    } else {
        let mut s = String::new();
        if !scan.saw_task_activity && scan.task_store_reset {
            s.push_str(if codex { t("instead_reset_codex") } else { t("instead_reset") });
        }
        if stale && scan.saw_task_activity {
            s.push_str(t("instead_stalled"));
        }
        s.push_str(if codex { t("instead_capture_codex") } else { t("instead_capture") });
        s.push_str(&msg::render(
            "tasklist_guard.instead_files",
            &[
                ("progress", &progress_path),
                ("header", &header),
                ("history", &history_path),
                ("append", if codex { t("append_codex") } else { t("append_claude") }),
            ],
        ));
        s
    };
    let base = msg::message(Kind::Block, t("guard_name"), &Parts { what: &what, why: &why, instead: &instead, ..Parts::default() });
    let reason = sanitize_reason(&base).ok_or(Unsure)?;
    let omc = omc_active(f, &f.st.home)?;
    let advisory = match f.root {
        Some(r) if !reduced => handover_advisory(f, r, &state_dir, &safe, &reason)?,
        _ => None,
    };
    let mut policy = policy(f, home.as_deref(), &safe, reduced)?;
    let mut final_reason = advisory.as_ref().map_or_else(|| reason.clone(), |a| a.2.clone());
    if let Some(h) = home.as_deref() {
        let now = to_js_string(time::now_ms() as f64);
        let hint = msg::render("tasklist_guard.ack_hint", &[("key", &ack_key), ("now", &now), ("path", &ack_path(h, &session))]);
        final_reason = sanitize_reason(&format!("{final_reason}\n{hint}")).ok_or(Unsure)?;
    }
    let out = format!("{{\"decision\":\"block\",\"reason\":{}}}\n", json::quote(&final_reason));

    // effects, in Node order
    if jev() || version_stale || acked {
        return Ok(Verdict::Allow);
    }
    if omc {
        return Ok(Verdict::Exact(Exact { code: 0, out: t("omc_text").to_string(), err: String::new() }));
    }
    if let Some((marker, body, _)) = &advisory {
        crate::discard::harmless(std::fs::create_dir_all(&state_dir).and_then(|()| crate::atomic::write_after_reply(marker, body, crate::atomic::Style::default()))); // keep: best-effort cap
    }
    if let Some(pol) = policy.as_mut() {
        let now = date::now_ms();
        if pol.budget_spent(&safe, now) || (reduced && !pol.consume(&safe, now)) {
            return Ok(Verdict::Allow);
        }
    }
    let state = J::Obj(vec![("hash".into(), J::Str(hash)), ("blocks".into(), J::Num(blocks + 1.0)), ("started".into(), J::Str(started))]);
    if std::fs::create_dir_all(&state_dir).is_err() || crate::atomic::write_after_reply(&state_file, json::stringify(&state), crate::atomic::Style::default()).is_err() {
        return Ok(Verdict::Allow);
    }
    crate::checks::guardkit::fsio::prune_stale(&state_dir, t("state_prefix"), Some(&state_file));
    Ok(Verdict::Exact(Exact { code: 0, out, err: String::new() }))
}

/// The `tasklistTrivial` consult (`consultRelax`): true when Jev, in on mode, confidently judged the session trivial. In
/// shadow and off the ask goes out detached (its row lands in the log) and the answer is false.
fn consult_jev(f: &Fire<'_>, state: &str) -> bool {
    use crate::jev::{AskRequest, Question, Trust};
    let jenv = crate::jev::Env::from_pairs(f.st.env.clone());
    let q = Question::noul(t("jev_instructions"), t("jev_true"), t("jev_false"));
    let mut req = AskRequest::new(t("jev_id"), q, state, Trust::RelaxBlock, Value::Bool(true));
    req.session_id = (!f.raw_sid.is_empty()).then(|| f.raw_sid.to_string());
    req.turn_ref = crate::jev::shared::turn_ref_from_transcript(f.transcript);
    crate::jev::shared::consult_relax(std::path::Path::new(&f.st.home), &jenv, req).is_some_and(|d| d.outcome == Value::Bool(false))
}
