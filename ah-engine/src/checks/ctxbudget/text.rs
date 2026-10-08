//! The texts of the auto-handover hooks (`hooks/lib/auto-handover-text.js`) and the facts they are built from: the platform
//! a payload comes from, the handover path the skill would write next, and the session's newest handover file
//! (`hooks/lib/auto-handover-gate.js` `sessionHandover`, `hooks/lib/handover-find.js`). Every word is in
//! `defaults/ctxbudget.toml` (`ctxbudget.ah_*`); a number is shown the way JavaScript concatenates it.
use super::pct::{Label, Reading};
use crate::checks::git::util::{Settings, path_join};
use crate::checks::guardkit::jsval::number_to_string;
use crate::checks::guardkit::msg::{self, Kind, Parts};
use crate::checks::handover::find::{self, Kind as FileKind};
use crate::checks::jsport::fsx;
use crate::defaults;
use crate::reqenv::RequestEnv;
use serde_json::Value;

/// `detectPlatform(payload)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    /// Claude Code.
    Claude,
    /// Codex.
    Codex,
}

fn t(key: &str) -> &'static str {
    defaults::text(key)
}

/// `detectPlatform(payload)`: a non-empty `turn_id`, a rollout transcript file or a transcript under a `.codex` directory.
pub fn platform(p: &Value) -> Platform {
    if !(p.is_object() || p.is_array()) {
        return Platform::Claude;
    }
    if p.get("turn_id").and_then(Value::as_str).is_some_and(|s| !s.is_empty()) {
        return Platform::Codex;
    }
    let tp = p.get("transcript_path").and_then(Value::as_str).unwrap_or("");
    let is_sep = |c: char| c == '/' || c == '\\';
    let last = tp.rsplit(is_sep).next().unwrap_or(tp);
    let rollout = last.starts_with(t("ctxbudget.ah_rollout_prefix")) && last.ends_with(t("ctxbudget.ah_rollout_suffix"));
    let dir = t("ctxbudget.ah_codex_dir");
    let dotcodex = tp.match_indices(dir).any(|(i, _)| {
        tp[..i].chars().next_back().is_some_and(is_sep) && tp[i + dir.len()..].chars().next().is_some_and(is_sep)
    });
    if rollout || dotcodex { Platform::Codex } else { Platform::Claude }
}

fn skill(pl: Platform) -> &'static str {
    t(if pl == Platform::Codex { "ctxbudget.ah_skill_codex" } else { "ctxbudget.ah_skill_claude" })
}

fn reset(pl: Platform) -> &'static str {
    t(if pl == Platform::Codex { "ctxbudget.ah_reset_codex" } else { "ctxbudget.ah_reset_claude" })
}

/// `Math.round(x)` as JavaScript prints it.
pub fn round_str(x: f64) -> String {
    number_to_string(js_round(x))
}

/// `Math.round`.
pub fn js_round(x: f64) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let f = x.floor();
    if x - f >= 0.5 { f + 1.0 } else { f }
}

fn warn(what: &str, why: &str, instead: &str) -> String {
    msg::message(Kind::Warn, t("ctxbudget.ah_guard"), &Parts { what, why, instead, ..Parts::default() })
}

fn tip(what: &str, why: &str, instead: &str) -> String {
    msg::message(Kind::Tip, t("ctxbudget.ah_guard"), &Parts { what, why, instead, ..Parts::default() })
}

/// `sanitizeSessionId(raw)`: `String(raw || '')` without the characters outside letters, digits, `_` and `-`, else the
/// unknown-session name. `Err` for an id `String()` would spell from an object or array (not reproduced here).
pub fn sanitize_session_id(raw: Option<&Value>) -> Result<String, ()> {
    let s = match raw {
        None | Some(Value::Null) | Some(Value::Bool(false)) => String::new(),
        Some(Value::Bool(true)) => true.to_string(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.as_f64().filter(|f| *f != 0.0).map(number_to_string).unwrap_or_default(),
        Some(_) => return Err(()),
    };
    let safe: String = s.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-')).collect();
    Ok(if safe.is_empty() { t("ctxbudget.ah_unknown_session").to_string() } else { safe })
}

/// The session's working directory (`payload.cwd` when a non-empty string). `Err` for a relative one, which Node resolves
/// against its own directory.
fn cwd_of(p: &Value) -> Result<Option<&str>, ()> {
    match p.get("cwd").and_then(Value::as_str).filter(|c| !c.is_empty()) {
        Some(c) if !c.starts_with('/') => Err(()),
        c => Ok(c),
    }
}

/// `expectedHandoverPath(payload)`: `.anti-hall/handovers/<local date>/<session>/<next HANDOVER name>`, or none without a
/// working directory. `Err` where the repository root, the local date or the session id cannot be settled exactly.
pub fn expected_handover_path(p: &Value, st: &Settings, env: &RequestEnv) -> Result<Option<String>, ()> {
    let Some(cwd) = cwd_of(p)? else { return Ok(None) };
    let date = find::local_date().map_err(|_| ())?;
    let sid = sanitize_session_id(p.get("session_id"))?;
    let root = find::handovers_root(cwd, &st.home, env).map_err(|_| ())?;
    let dir = path_join(&root, &format!("{date}/{sid}"));
    let count = fsx::read_dir_names(&dir).unwrap_or_default().iter().filter(|(n, _)| find::match_name(n, FileKind::Handover).is_some()).count();
    let name = if count + 1 > 1 { msg::render("ctxbudget.ah_handover_name_n", &[("n", &(count + 1).to_string())]) } else { t("ctxbudget.ah_handover_name").to_string() };
    Ok(Some(format!("{}/{date}/{sid}/{name}", t("ctxbudget.ah_handover_dir_rel"))))
}

/// The session's newest handover file and its mtime (`sessionHandover(payload)`), or none.
pub fn session_handover(p: &Value, st: &Settings, env: &RequestEnv) -> Result<Option<(String, f64)>, ()> {
    let Some(cwd) = cwd_of(p)? else { return Ok(None) };
    let sid = sanitize_session_id(p.get("session_id"))?;
    let root = find::handovers_root(cwd, &st.home, env).map_err(|_| ())?;
    // `collectForSession`: every date directory, then `<date>/<session>` read directly (a link is followed there)
    let mut found: Vec<(String, f64)> = Vec::new();
    for (date, ty) in fsx::read_dir_names(&root).unwrap_or_default() {
        if !ty.is_dir() {
            continue;
        }
        let dir = path_join(&root, &format!("{date}/{sid}"));
        let Some(files) = fsx::read_dir_names(&dir) else { continue };
        for (name, _) in files {
            if find::match_name(&name, FileKind::Handover).is_none() {
                continue;
            }
            let file = format!("{dir}/{name}");
            let Ok(md) = std::fs::metadata(&file) else { continue };
            if md.is_file() {
                found.push((file, fsx::mtime_ms(&md)));
            }
        }
    }
    // `candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)`: a stable sort, newest first
    found.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    Ok(found.into_iter().next())
}

/// `relativeHandoverPath(payload, filePath)`: the path relative to the working directory when it lies under it.
pub fn relative_handover_path(p: &Value, file: &str) -> String {
    let Some(cwd) = p.get("cwd").and_then(Value::as_str).filter(|c| c.starts_with('/')) else { return file.to_string() };
    let rel = fsx::relative(cwd, file);
    if !rel.is_empty() && !rel.starts_with("..") { rel } else { file.to_string() }
}

/// `compactCommand(handoverPath, platform)`.
fn compact_command(hp: Option<&str>, pl: Platform) -> String {
    if pl == Platform::Codex {
        return t("ctxbudget.ah_compact_codex").to_string();
    }
    msg::render("ctxbudget.ah_compact_claude", &[("path", hp.unwrap_or(t("ctxbudget.ah_compact_no_path")))])
}

/// `buildFireDirective(result, via, payload, maxTokens)`; `hp` is [`expected_handover_path`].
pub fn fire(r: &Reading, tokens: bool, p: &Value, max_tokens: f64, hp: Option<&str>) -> String {
    let pl = platform(p);
    let what = if tokens {
        let used_k = round_str(r.used.filter(|u| *u != 0.0 && !u.is_nan()).unwrap_or(0.0) / 1000.0);
        let ceiling = if max_tokens.is_finite() && max_tokens > 0.0 {
            msg::render("ctxbudget.ah_ceiling", &[("k", &round_str(max_tokens / 1000.0))])
        } else {
            String::new()
        };
        msg::render("ctxbudget.ah_what_tokens", &[("usedK", &used_k), ("ceiling", &ceiling)])
    } else {
        let label = match (r.estimated, r.label) {
            (false, _) => "",
            (true, Label::Inferred) => t("ctxbudget.ah_label_inferred"),
            (true, _) => t("ctxbudget.ah_label_estimated"),
        };
        msg::render("ctxbudget.ah_what_pct", &[("pct", &round_str(r.pct)), ("label", label)])
    };
    let step3 = if pl == Platform::Codex {
        t("ctxbudget.ah_fire_step3_codex").to_string()
    } else {
        msg::render("ctxbudget.ah_fire_step3_claude", &[("cmd", &compact_command(hp, pl))])
    };
    let main_file = hp.map(|h| msg::render("ctxbudget.ah_fire_main_file", &[("path", h)])).unwrap_or_default();
    let instead = format!(
        "{}{main_file}{}{step3}{}",
        msg::render("ctxbudget.ah_fire_step1", &[("skill", skill(pl))]),
        t("ctxbudget.ah_fire_step2"),
        msg::render("ctxbudget.ah_fire_tail", &[("bloat", t("ctxbudget.ah_bloat"))])
    );
    warn(&what, t("ctxbudget.ah_fire_why"), &instead)
}

/// `buildMilestoneNag(pct, payload)`.
pub fn milestone(pct: f64, p: &Value) -> String {
    let what = msg::render("ctxbudget.ah_nag_what", &[("pct", &round_str(pct))]);
    tip(&what, "", &msg::render("ctxbudget.ah_nag_instead", &[("bloat", t("ctxbudget.ah_bloat")), ("reset", reset(platform(p)))]))
}

/// `buildSoftAdvisory(pct)`.
pub fn soft(pct: f64) -> String {
    let what = msg::render("ctxbudget.ah_soft_what", &[("pct", &round_str(pct))]);
    tip(&what, t("ctxbudget.ah_soft_why"), &msg::render("ctxbudget.ah_soft_instead", &[("bloat", t("ctxbudget.ah_bloat"))]))
}

/// `buildPauseNag(pct, payload)`.
pub fn pause(pct: f64, p: &Value) -> String {
    let what = msg::render("ctxbudget.ah_pause_what", &[("pct", &round_str(pct))]);
    tip(&what, "", &msg::render("ctxbudget.ah_pause_instead", &[("bloat", t("ctxbudget.ah_bloat")), ("reset", reset(platform(p)))]))
}

/// `buildDecisiveSuffix(payload, handoverPath, freshness, taskComplete)`.
pub fn decisive_suffix(p: &Value, path: &str, fresh: Option<bool>, complete: bool) -> String {
    let clear = t(if platform(p) == Platform::Codex { "ctxbudget.ah_clear_codex" } else { "ctxbudget.ah_clear_claude" });
    let path = if path.is_empty() { t("ctxbudget.ah_suffix_no_path") } else { path };
    let line = || msg::render(if complete { "ctxbudget.ah_line_complete" } else { "ctxbudget.ah_line_continue" }, &[("clear", clear), ("path", path)]);
    match fresh {
        Some(false) => msg::render("ctxbudget.ah_suffix_stale", &[("line", &line())]),
        None => msg::render("ctxbudget.ah_suffix_unknown", &[("path", path)]),
        Some(true) => msg::render("ctxbudget.ah_suffix_fresh", &[("line", &line())]),
    }
}

/// `budgetLabel(budgetPct, max)`.
fn budget_label(budget: f64, max: Option<f64>) -> String {
    let tok = max.filter(|m| m.is_finite() && *m > 0.0).map(|m| js_round(m * budget / 100.0 / 1000.0)).filter(|k| *k != 0.0 && !k.is_nan());
    let tok = tok.map(|k| msg::render("ctxbudget.ah_budget_tokens", &[("k", &number_to_string(k))])).unwrap_or_default();
    msg::render("ctxbudget.ah_budget", &[("b", &number_to_string(budget)), ("tok", &tok)])
}

/// `buildGateDirective(result, latch, cfg, payload)`.
pub fn gate(r: &Reading, handover_pct: f64, budget: f64, p: &Value) -> String {
    let pl = platform(p);
    let ask = t(if pl == Platform::Codex { "ctxbudget.ah_gate_ask_codex" } else { "ctxbudget.ah_gate_ask_claude" });
    let what = msg::render(
        "ctxbudget.ah_gate_what",
        &[("pct", &round_str(r.pct)), ("hp", &round_str(handover_pct)), ("budget", &budget_label(budget, r.max))],
    );
    let instead = msg::render("ctxbudget.ah_gate_instead", &[("ask", ask), ("reset", reset(pl))]);
    msg::message(
        Kind::Warn,
        t("ctxbudget.ah_guard"),
        &Parts {
            what: &what,
            why: t("ctxbudget.ah_gate_why"),
            instead: &instead,
            allowed: t("ctxbudget.ah_gate_allowed"),
            override_: t("ctxbudget.ah_gate_override"),
            ..Parts::default()
        },
    )
}

/// `buildGateBackstop(pct, latch, cfg, payload)`.
pub fn backstop(pct: f64, handover_pct: f64, budget: f64, p: &Value) -> String {
    let pl = platform(p);
    let what = msg::render("ctxbudget.ah_backstop_what", &[("pct", &round_str(pct)), ("b", &number_to_string(budget)), ("hp", &round_str(handover_pct))]);
    warn(&what, "", &msg::render("ctxbudget.ah_backstop_instead", &[("skill", skill(pl)), ("reset", reset(pl))]))
}
