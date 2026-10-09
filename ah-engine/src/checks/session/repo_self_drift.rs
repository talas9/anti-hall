//! Built-in `check = "repo-self-drift"`: a port of the Node SessionStart hook `hooks/repo-self-drift.js`.
//!
//! Probe 3 of the drift family, with no network and no background process: it compares the hook and skill counts that
//! `docs/KB.md` claims in its own prose with what is on disk, and says when the model KBs were last audited more than the
//! threshold ago. The scan is cached for a day; each advisory is said once per unchanged finding.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an unreadable optional file is the same as an absent one (fail-open, as Node's try/catch)
// - text that does not parse or decode is the absent value (Node Number()/JSON.parse catch parity)
// A failure that must be seen goes through `crate::discard` instead.

use crate::checks::jsport::num::to_js_string;
use super::drift::{self, Cache};
use super::jval::{J, obj};
use super::time::{days_of_iso_date, iso_date};
use super::{emit, home_of, is_session_start, join, judge_child, now_ms, plugin_root, read_text, skipped, switch_on, template_text};
use crate::checks::git::util::Settings;
use crate::checks::guardkit::jsre;
use crate::checks::guardkit::msg::render;
use crate::checks::{Check, Verdict};
use crate::defaults;
use crate::reqenv::RequestEnv;
use crate::rules::Subject;
use serde_json::Value;
use std::os::unix::ffi::OsStrExt;

/// The registered `repo-self-drift` check.
pub struct RepoSelfDrift;

impl Check for RepoSelfDrift {
    fn name(&self) -> &'static str {
        "repo-self-drift"
    }

    fn summary(&self) -> &'static str {
        defaults::text("session.repo_self_drift_summary")
    }

    fn run(&self, _s: &Subject<'_>, _opts: &Value) -> Option<Verdict> {
        Some(Verdict::Defer)
    }

    fn run_env(&self, s: &Subject<'_>, _payload: &Value, opts: &Value, env: &RequestEnv) -> Option<Verdict> {
        if !is_session_start(s) {
            return Some(Verdict::Defer);
        }
        Some(decide(opts, env))
    }
}

/// `countJsFiles(dir)`: entries whose name ends in `.js`; `None` when the directory cannot be read.
fn count_js_files(dir: &str) -> Option<usize> {
    let n = std::fs::read_dir(dir).ok()?.flatten().filter(|e| e.file_name().as_bytes().ends_with(defaults::text("session.js_ext").as_bytes())).count();
    Some(n)
}

/// `countSkillDirs(dir)`: subdirectories (a symbolic link is not one); `None` when the directory cannot be read.
fn count_skill_dirs(dir: &str) -> Option<usize> {
    Some(std::fs::read_dir(dir).ok()?.flatten().filter(|e| e.file_type().is_ok_and(|t| t.is_dir())).count())
}

/// The first existing `docs/KB.md` of `resolveKbPath`: beside the hooks directory (installed layout), else three levels up
/// (repository layout).
fn kb_path(root: &str) -> Option<String> {
    [defaults::text("session.kb_installed"), defaults::text("session.kb_repo")]
        .into_iter()
        .map(|rel| join(root, rel))
        .find(|p| std::path::Path::new(p).exists())
}

/// A claimed count read from the KB text: `Ok(None)` when the claim is not there, `Err(())` for a number too long to
/// compare exactly (JavaScript would round it), which defers.
fn claim(re: &regex::Regex, text: &str) -> Result<Option<f64>, ()> {
    match re.captures(text).and_then(|c| c.get(1)) {
        None => Ok(None),
        Some(m) if m.as_str().len() > defaults::num("session.claim_max_digits") as usize => Err(()),
        Some(m) => Ok(m.as_str().parse::<f64>().ok()),
    }
}

fn count_json(n: Option<usize>) -> J {
    n.map_or(J::Null, |n| J::Num(n as f64))
}

/// `scan(hooksDir)`: the cache object for this run. `Err(())` defers.
fn scan(root: &str, now: f64) -> Result<J, ()> {
    let mut out = obj(vec![("checkedAt", J::Num(now))]);
    let hooks = join(root, defaults::text("session.hooks_dir"));
    let actual_hooks = count_js_files(&hooks);
    let actual_skills = count_skill_dirs(&join(root, defaults::text("session.skills_dir")));
    if let Some(kb) = kb_path(root)
        && let Some(text) = read_text(&kb).filter(|t| !t.is_empty())
    {
        let hooks_re = jsre::compile(defaults::text("session.hooks_claim_re"), false);
        let skills_re = jsre::compile(defaults::text("session.skills_claim_re"), false);
        let (ch, cs) = (claim(&hooks_re, &text)?, claim(&skills_re, &text)?);
        out.set("claimedHooks", ch.map_or(J::Null, J::Num));
        out.set("actualHooks", count_json(actual_hooks));
        out.set("claimedSkills", cs.map_or(J::Null, J::Num));
        out.set("actualSkills", count_json(actual_skills));
    }
    let audit = defaults::text("session.model_kb_audit_date");
    let today = days_of_iso_date(&iso_date(now));
    let age = days_of_iso_date(audit).zip(today).map(|(a, b)| J::Num((b - a) as f64));
    out.set("modelKbAuditDate", J::Str(audit.to_string()));
    out.set("modelKbAgeDays", age.unwrap_or(J::Null));
    Ok(out)
}

fn decide(opts: &Value, env: &RequestEnv) -> Verdict {
    if judge_child(env) {
        return Verdict::Allow;
    }
    let (Some(home), Some(root)) = (home_of(env), plugin_root(opts, env)) else { return Verdict::Defer };
    let st = Settings::from_env(env);
    if !switch_on(&st, "session.setting_repo_self_drift") || skipped(&st, defaults::text("session.repo_self_drift_guard")) {
        return Verdict::Allow;
    }
    let file = join(&home, defaults::text("session.repo_self_drift_cache"));
    let now = now_ms();
    let cached = match drift::read_cache(&file, |_| true) {
        Cache::Valid(c) if drift::is_fresh(&c, now, defaults::num("session.drift_cache_ttl_ms") as f64) => Some(c),
        Cache::Unsure => return Verdict::Defer,
        _ => None,
    };
    let cache = match cached {
        Some(c) => c,
        None => {
            let Ok(fresh) = scan(&root, now) else { return Verdict::Defer };
            if drift::atomic_write(&file, &fresh).is_err() {
                return Verdict::Allow; // Node returns quietly when the cache cannot be written
            }
            fresh
        }
    };

    // `(cache && cache.lastAdvised) || {}`: only an object (or a falsy value) is read the way Node reads it
    let last: Vec<(String, J)> = match cache.get("lastAdvised") {
        None | Some(J::Null) | Some(J::Bool(false)) => Vec::new(),
        Some(J::Num(n)) if *n == 0.0 => Vec::new(),
        Some(J::Str(s)) if s.is_empty() => Vec::new(),
        Some(J::Obj(o)) => o.clone(),
        Some(_) => return Verdict::Defer,
    };
    let sub = |name: &str| last.iter().find(|(k, _)| k == name).map(|(_, v)| v);
    let get_num = |k: &str| cache.get(k).and_then(J::finite);
    let mut lines: Vec<String> = Vec::new();

    // check 1: the counts docs/KB.md claims against the counts on disk
    let mut counts_key: Option<J> = None;
    if let (Some(ch), Some(ah), Some(cs), Some(asks)) = (get_num("claimedHooks"), get_num("actualHooks"), get_num("claimedSkills"), get_num("actualSkills")) {
        let (hooks_off, skills_off) = (ch != ah, cs != asks);
        if hooks_off || skills_off {
            let key = obj(vec![("claimedHooks", J::Num(ch)), ("actualHooks", J::Num(ah)), ("claimedSkills", J::Num(cs)), ("actualSkills", J::Num(asks))]);
            let advised = sub("counts").is_some_and(|c| drift::already_advised_key(&obj(vec![("lastAdvised", c.clone())]), &key));
            if !advised {
                let mut parts: Vec<String> = Vec::new();
                if hooks_off {
                    parts.push(render("session.drift_hooks_part", &[("claimed", &to_js_string(ch)), ("actual", &to_js_string(ah))]));
                }
                if skills_off {
                    parts.push(render("session.drift_skills_part", &[("claimed", &to_js_string(cs)), ("actual", &to_js_string(asks))]));
                }
                lines.push(render("session.drift_counts_line", &[("parts", &parts.join(defaults::text("session.parts_sep")))]));
            }
            counts_key = Some(key);
        }
    }

    // check 2: the model KBs were audited too long ago
    let mut stale_key: Option<J> = None;
    if let Some(age) = get_num("modelKbAgeDays")
        && age > defaults::num("session.staleness_threshold_days") as f64
    {
        let Some(date) = cache.get("modelKbAuditDate").and_then(template_text) else { return Verdict::Defer };
        let key = obj(vec![("modelKbAuditDate", cache.get("modelKbAuditDate").cloned().unwrap_or(J::Null))]);
        let advised = sub("staleness").is_some_and(|c| drift::already_advised_key(&obj(vec![("lastAdvised", c.clone())]), &key));
        if !advised {
            let threshold = defaults::num("session.staleness_threshold_days").to_string();
            lines.push(render("session.drift_stale_line", &[("date", &date), ("age", &to_js_string(age)), ("threshold", &threshold)]));
        }
        stale_key = Some(key);
    }
    if lines.is_empty() {
        return Verdict::Allow;
    }
    let mut next = J::Obj(last);
    if let Some(k) = counts_key {
        next.set("counts", k);
    }
    if let Some(k) = stale_key {
        next.set("staleness", k);
    }
    drift::persist_advised_key(&file, &cache, next);
    emit(&lines.join("\n"))
}
