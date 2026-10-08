//! Built-in `check = "defect-nudge"`: a port of the Node SessionStart hook `hooks/defect-nudge.js`.
//!
//! A once-a-day, non-blocking nudge about the file-based defect channel (`~/.anti-hall/defects/*.jsonl`, written by
//! `hooks/lib/defect-store.js`). In the anti-hall repository it counts unfinished reports; anywhere else it counts defects
//! this project reported that now carry a later ruling. The line holds counts and ages only, never a reporter's text.
//!
//! The defect files are other agents' data: read-only here, and a line this port cannot judge exactly as `JSON.parse`
//! and `Date.parse` would (a lone surrogate escape, a date in a form that depends on the time zone) hands the whole hook
//! back to Node, before the stamp is written.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an unreadable optional file is the same as an absent one (fail-open, as Node's try/catch)
// A failure that must be seen goes through `crate::discard` instead.

use super::drift::parse_semver;
use super::jval::{J, Parsed, js_num, parse};
use super::time::days_of_iso_date;
use super::{emit, home_of, is_session_start, join, judge_child, now_ms, read_text, skipped, switch_on};
use crate::checks::git::util::Settings;
use crate::checks::guardkit::msg::{self, Kind, Parts};
use crate::checks::guardkit::paths::{basename, is_absolute};
use crate::checks::guardkit::text::js_trim;
use crate::checks::{Check, Verdict};
use crate::defaults;
use crate::reqenv::RequestEnv;
use crate::rules::Subject;
use serde_json::Value;

/// The registered `defect-nudge` check.
pub struct DefectNudge;

impl Check for DefectNudge {
    fn name(&self) -> &'static str {
        "defect-nudge"
    }

    fn summary(&self) -> &'static str {
        defaults::text("session.defect_nudge_summary")
    }

    fn run(&self, _s: &Subject<'_>, _opts: &Value) -> Option<Verdict> {
        Some(Verdict::Defer)
    }

    fn run_env(&self, s: &Subject<'_>, payload: &Value, _opts: &Value, env: &RequestEnv) -> Option<Verdict> {
        if !is_session_start(s) {
            return Some(Verdict::Defer);
        }
        Some(decide(payload, env))
    }
}

/// One defect file, read: its parsed object lines in order.
struct Defect {
    fp: String,
    lines: Vec<J>,
}

/// What derives from a defect file's lines (`deriveState`): the status and the first dated line.
struct State {
    status: String,
    first_seen: Option<String>,
}

fn str_field<'a>(o: &'a J, k: &str) -> Option<&'a str> {
    o.get(k).and_then(J::as_str)
}

/// `deriveState(parsedLines)`, the parts the nudge reads.
fn derive(lines: &[J]) -> State {
    let mut status = defaults::text("session.defect_open").to_string();
    let mut first_seen: Option<String> = None;
    // the last ruling that set a status: (status, fixedIn)
    let mut last_ruling: Option<(String, Option<String>)> = None;
    for o in lines {
        if let Some(at) = str_field(o, "at").filter(|a| !a.is_empty())
            && first_seen.is_none()
        {
            first_seen = Some(at.to_string());
        }
        match str_field(o, "t") {
            Some(t) if t == defaults::text("session.defect_report") => {
                if let Some((s, Some(fixed_in))) = &last_ruling
                    && s == defaults::text("session.defect_fixed")
                    && !fixed_in.is_empty()
                {
                    // cmpSemver(obj.v, fixedIn): null (either unparseable) leaves the status alone
                    if let (Some(v), Some(f)) = (str_field(o, "v").and_then(parse_semver), parse_semver(fixed_in))
                        && (0..3).find(|i| v[*i] != f[*i]).is_none_or(|i| v[i] > f[i])
                    {
                        status = defaults::text("session.defect_regressed").to_string();
                    }
                }
            }
            Some(t) if t == defaults::text("session.defect_backfill") => {
                if let Some(s) = str_field(o, "status") {
                    status = s.to_string();
                }
            }
            Some(t) if t == defaults::text("session.defect_ruling") => {
                if let Some(s) = str_field(o, "status") {
                    status = s.to_string();
                    last_ruling = Some((s.to_string(), str_field(o, "fixedIn").map(str::to_string)));
                }
            }
            _ => {}
        }
    }
    State { status, first_seen }
}

/// `parseLines(readRawLines(file))`: the lines that are JSON objects; a torn line is skipped. `Err(())` when a line may
/// parse differently from `JSON.parse`.
fn read_lines(file: &str) -> Result<Vec<J>, ()> {
    let Some(text) = read_text(file) else { return Ok(Vec::new()) };
    let mut out = Vec::new();
    for l in text.split('\n').filter(|l| !l.is_empty()) {
        match parse(l) {
            Parsed::Ok(v @ J::Obj(_)) => out.push(v),
            Parsed::Ok(_) | Parsed::Bad => {}
            Parsed::Unsure => return Err(()),
        }
    }
    Ok(out)
}

/// `listDefects({home})`: every `*.jsonl` directly under the defects directory, in name order.
fn list_defects(home: &str) -> Result<Vec<Defect>, ()> {
    let dir = join(&join(home, defaults::text("session.state_dir")), defaults::text("session.defects_dir"));
    let Ok(rd) = std::fs::read_dir(&dir) else { return Ok(Vec::new()) };
    let ext = defaults::text("session.defect_ext");
    let mut names: Vec<String> = rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n.ends_with(ext)).collect();
    names.sort();
    names.into_iter().map(|n| Ok(Defect { fp: n[..n.len() - ext.len()].to_string(), lines: read_lines(&join(&dir, &n))? })).collect()
}

/// `showDefect(fp, home)`: the lines of the defect's open file, else its archive copy, else its history copy.
fn show_lines(home: &str, fp: &str) -> Result<Option<Vec<J>>, ()> {
    let ext = defaults::text("session.defect_ext");
    let defects = join(&join(home, defaults::text("session.state_dir")), defaults::text("session.defects_dir"));
    let mut file = join(&defects, &format!("{fp}{ext}"));
    if !std::path::Path::new(&file).exists() {
        let archive = join(&defects, defaults::text("session.archive_dir"));
        let mut months: Vec<String> =
            std::fs::read_dir(&archive).map(|rd| rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default();
        months.sort();
        let found = months.iter().map(|m| join(&join(&archive, m), &format!("{fp}{ext}"))).find(|c| std::path::Path::new(c).exists());
        let history = join(&join(&defects, defaults::text("session.history_dir")), &format!("{fp}{ext}"));
        match found {
            Some(f) => file = f,
            None if std::path::Path::new(&history).exists() => file = history,
            None => return Ok(None),
        }
    }
    read_lines(&file).map(Some)
}

/// `Date.parse(iso)` for the forms every engine reads the same way and that do not depend on the time zone: a plain date
/// or a UTC date-time with whole seconds and optional milliseconds. `Err(())` for anything else.
fn date_parse_ms(s: &str) -> Result<f64, ()> {
    let (date, time) = match s.split_once('T') {
        Some((d, t)) => (d, Some(t)),
        None => (s, None),
    };
    let days = days_of_iso_date(date).ok_or(())?;
    let mut ms = days as f64 * defaults::num("session.day_ms") as f64;
    if let Some(t) = time {
        let t = t.strip_suffix('Z').ok_or(())?;
        let (hms, frac) = match t.split_once('.') {
            Some((h, f)) if f.len() == 3 && f.bytes().all(|b| b.is_ascii_digit()) => (h, f.parse::<f64>().map_err(|_| ())?),
            Some(_) => return Err(()),
            None => (t, 0.0),
        };
        let b = hms.as_bytes();
        if b.len() != 8 || b[2] != b':' || b[5] != b':' || !b.iter().enumerate().all(|(i, c)| i == 2 || i == 5 || c.is_ascii_digit()) {
            return Err(());
        }
        let n = |r: std::ops::Range<usize>| hms[r].parse::<f64>().map_err(|_| ());
        let (h, m, sec) = (n(0..2)?, n(3..5)?, n(6..8)?);
        if h > 23.0 || m > 59.0 || sec > 59.0 {
            return Err(());
        }
        ms += h * 3_600_000.0 + m * 60_000.0 + sec * 1000.0 + frac;
    }
    Ok(ms)
}

/// `daysAgo(iso, now)`: whole days since `iso`, never negative; 0 when there is no date.
fn days_ago(iso: Option<&str>, now: f64) -> Result<f64, ()> {
    let Some(iso) = iso else { return Ok(0.0) };
    let ms = date_parse_ms(iso)?;
    Ok(((now - ms) / defaults::num("session.day_ms") as f64).floor().max(0.0))
}

fn closed(status: &str) -> bool {
    defaults::list("session.defect_closed").contains(&status)
}

fn maintainer_line(defects: &[Defect], now: f64) -> Result<String, ()> {
    let states: Vec<State> = defects.iter().map(|d| derive(&d.lines)).collect();
    let active: Vec<&State> = states.iter().filter(|s| !closed(&s.status)).collect();
    let regressed = states.iter().filter(|s| s.status == defaults::text("session.defect_regressed")).count();
    if active.is_empty() {
        return Ok(String::new());
    }
    let mut oldest = 0.0f64;
    for s in &active {
        oldest = oldest.max(days_ago(s.first_seen.as_deref(), now)?);
    }
    let what = msg::render(
        "session.defect_maintainer_what",
        &[("active", &active.len().to_string()), ("regressed", &regressed.to_string()), ("oldest", &js_num(oldest))],
    );
    Ok(msg::message(
        Kind::Tip,
        defaults::text("session.defect_nudge_guard"),
        &Parts { what: &what, instead: defaults::text("session.defect_maintainer_instead"), ..Parts::default() },
    ))
}

fn reporter_line(home: &str, defects: &[Defect], cwd: &str) -> Result<String, ()> {
    let proj = basename(cwd);
    let mut count = 0usize;
    for d in defects {
        let Some(lines) = show_lines(home, &d.fp)? else { continue };
        let own = |l: &J| str_field(l, "t") == Some(defaults::text("session.defect_report")) && str_field(l, "proj") == Some(proj);
        let Some(last_own) = lines.iter().rposition(own) else { continue };
        if lines[last_own + 1..].iter().any(|l| str_field(l, "t") == Some(defaults::text("session.defect_ruling"))) {
            count += 1;
        }
    }
    if count == 0 {
        return Ok(String::new());
    }
    let what = msg::render("session.defect_reporter_what", &[("count", &count.to_string())]);
    Ok(msg::message(
        Kind::Tip,
        defaults::text("session.defect_nudge_guard"),
        &Parts { what: &what, instead: defaults::text("session.defect_reporter_instead"), ..Parts::default() },
    ))
}

fn decide(payload: &Value, env: &RequestEnv) -> Verdict {
    if judge_child(env) {
        return Verdict::Allow;
    }
    let st = Settings::from_env(env);
    if !switch_on(&st, "session.setting_defect_nudge") || skipped(&st, defaults::text("session.defect_nudge_guard")) {
        return Verdict::Allow;
    }
    // the hook falls back to its own working directory when the payload has no cwd; the daemon does not know it
    let Some(cwd) = payload.get("cwd").and_then(Value::as_str).filter(|c| !c.is_empty() && is_absolute(c)) else { return Verdict::Defer };
    let Some(home) = home_of(env) else { return Verdict::Defer };

    // the once-a-day stamp: read now, written only once the sweep has been judged exactly
    let stamp = join(&join(&home, defaults::text("session.state_dir")), defaults::text("session.defect_stamp"));
    let now = now_ms();
    if let Some(text) = read_text(&stamp)
        && !js_trim(&text).is_empty()
    {
        match parse(js_trim(&text)) {
            Parsed::Ok(v) => {
                if v.get("lastSweep").and_then(J::finite).is_some_and(|last| last <= now && now - last < defaults::num("session.defect_throttle_ms") as f64) {
                    return Verdict::Allow;
                }
            }
            Parsed::Bad => {}
            Parsed::Unsure => return Verdict::Defer,
        }
    }
    let Ok(defects) = list_defects(&home) else { return Verdict::Defer };
    let marker = join(cwd, defaults::text("session.anti_hall_marker"));
    let line = if std::path::Path::new(&marker).exists() { maintainer_line(&defects, now) } else { reporter_line(&home, &defects, cwd) };
    let Ok(line) = line else { return Verdict::Defer };
    // arm the stamp first, best effort, as Node does before it sweeps
    if let Some(dir) = std::path::Path::new(&stamp).parent() {
        crate::discard::harmless(std::fs::create_dir_all(dir)); // keep: the write that follows fails too when the directory is missing
    }
    crate::discard::harmless(crate::atomic::write(&stamp, J::Obj(vec![("lastSweep".to_string(), J::Num(now))]).stringify())); // keep: a lost sweep stamp only repeats the sweep
    if line.is_empty() { Verdict::Allow } else { emit(&line) }
}
