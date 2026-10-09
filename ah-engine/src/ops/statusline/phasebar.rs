//! Line 2 of the status line: the phase bar (an orchestration run), else the live swarm activity, else the context-window
//! gauge. Port of `statusline/phase-bar.js` (its in-process entry `runWithInput`).
use super::util::{n, parse_int_of, safe_label, trim};
use crate::checks::jsport::json::{self, J};
use crate::checks::jsport::{num, text};
use crate::defaults;
use crate::migrate::j_truthy;
use crate::ops::js::{Defer, head16, len16};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// What the renderers read: the process's home, temp directory, environment and the clock.
pub struct Ctx {
    pub home: String,
    pub tmpdir: String,
    pub now: f64,
}

fn color(name: &str) -> &'static str {
    defaults::raw("statusline.phase_colors").get(name).and_then(defaults::V::as_str).unwrap_or("")
}

fn parse(text: &str) -> Option<J> {
    json::parse(text, defaults::num("setup.json_max_depth") as usize).ok()
}

/// `os.tmpdir()`
pub fn tmpdir(env: &BTreeMap<String, String>) -> String {
    let mut p = defaults::list("statusline.tmp_env")
        .iter()
        .filter_map(|k| env.get(*k))
        .find(|v| !v.is_empty())
        .cloned()
        .unwrap_or_else(|| defaults::text("statusline.tmp_default").to_string());
    if p.len() > 1 && p.ends_with('/') {
        p.pop();
    }
    p
}

fn state_candidates(cx: &Ctx) -> Vec<PathBuf> {
    vec![
        Path::new(&cx.home).join(defaults::text("paths.base_dir")).join(defaults::text("statusline.phase_state_file")),
        Path::new(&cx.tmpdir).join(defaults::text("statusline.tmp_dir")).join(defaults::text("statusline.phase_state_file")),
    ]
}

/// `readState()`: the first state file that exists and is fresh.
fn read_state(cx: &Ctx) -> Option<String> {
    for f in state_candidates(cx) {
        let Ok(md) = std::fs::metadata(&f) else { continue };
        let mtime = crate::checks::jsport::fsx::mtime_ms(&md);
        if cx.now - mtime > defaults::num("statusline.phase_stale_ms") as f64 {
            continue;
        }
        if let Ok(b) = std::fs::read(&f) {
            return Some(String::from_utf8_lossy(&b).into_owned());
        }
    }
    None
}

fn spinner(now: f64) -> &'static str {
    let frames = defaults::list("statusline.spinner");
    frames[((now / 1000.0).floor() as usize) % frames.len()]
}

fn bar_width() -> usize {
    defaults::num("statusline.bar_width") as usize
}

/// `renderBar(done, total, color)`
fn render_bar(done: f64, total: f64, now: f64) -> String {
    let w = bar_width() as f64;
    let filled = if total > 0.0 { num::js_round((done / total) * w) } else { 0.0 };
    let clamped = filled.clamp(0.0, w) as usize;
    let empty = bar_width() - clamped;
    format!(
        "[{}{}{}{}{}{}{}{}{}]",
        color("green"),
        defaults::text("statusline.bar_fill").repeat(clamped),
        color("reset"),
        color("cyan"),
        spinner(now),
        color("reset"),
        color("dim"),
        defaults::text("statusline.bar_empty").repeat(empty),
        color("reset")
    )
}

/// `renderLevelBar(pct, color)`
fn render_level_bar(pct: f64, col: &str) -> String {
    let w = bar_width() as f64;
    let filled = num::js_round((pct.clamp(0.0, 100.0) / 100.0) * w);
    let clamped = filled.clamp(0.0, w) as usize;
    let empty = bar_width() - clamped;
    format!(
        "[{col}{}{}{}{}{}]",
        defaults::text("statusline.bar_fill").repeat(clamped),
        color("reset"),
        color("dim"),
        defaults::text("statusline.bar_empty").repeat(empty),
        color("reset")
    )
}

fn level_color(pct: f64) -> &'static str {
    if pct >= defaults::num("statusline.level_red") as f64 {
        color("red")
    } else if pct >= defaults::num("statusline.level_yellow") as f64 {
        color("yellow")
    } else {
        color("green")
    }
}

fn kfmt(x: f64) -> String {
    if x.abs() >= 1000.0 { format!("{}k", n(num::js_round(x / 1000.0))) } else { n(num::js_round(x)) }
}

/// Outcome of the phase bar: a line, nothing, or "the JavaScript code threw" (no line 2 at all, not even the fallbacks).
pub enum Phase {
    /// Rendered.
    Line(String),
    /// No phase bar; try the next source.
    None,
    /// The Node renderer throws here and prints nothing.
    Threw,
}

fn s_field(state: &J, k: &str) -> String {
    match state.get(k) {
        None | Some(J::Null) => String::new(),
        Some(J::Bool(false)) => String::new(),
        Some(J::Str(s)) if s.is_empty() => String::new(),
        Some(J::Num(x)) if *x == 0.0 || x.is_nan() => String::new(),
        Some(v) => crate::migrate::j_string(v),
    }
}

/// `phaseBarLine()`
fn phase_bar_line(cx: &Ctx) -> Result<Phase, Defer> {
    let Some(raw) = read_state(cx) else { return Ok(Phase::None) };
    let Some(state) = parse(&raw) else { return Ok(Phase::None) };
    if matches!(state, J::Null) {
        return Ok(Phase::Threw);
    }
    let code = trim(&safe_label(&s_field(&state, "code"))?).to_string();
    let mut desc = trim(&safe_label(&s_field(&state, "desc"))?).to_string();
    let done = parse_int_of(state.get("done"));
    let total = parse_int_of(state.get("total"));
    let (Some(done), Some(total)) = (done, total) else { return Ok(Phase::None) };
    if code.is_empty() || desc.is_empty() || total <= 0.0 {
        return Ok(Phase::None);
    }
    if len16(&desc) > defaults::num("statusline.desc_max") as usize {
        desc = head16(&desc, defaults::num("statusline.desc_max") as usize - 1)? + defaults::text("statusline.ellipsis");
    }
    let pct = num::js_round((done / total) * 100.0).clamp(0.0, 100.0);
    let bar = render_bar(done, total, cx.now);
    let mut extras: Vec<String> = Vec::new();
    if let Some(started) = parse_int_of(state.get("started")).filter(|s| *s > 0.0) {
        let secs = ((cx.now - started) / 1000.0).floor().max(0.0);
        let human = if secs >= 3600.0 {
            format!("{}h{}m", n((secs / 3600.0).floor()), n(((secs % 3600.0) / 60.0).floor()))
        } else if secs >= 60.0 {
            format!("{}m", n((secs / 60.0).floor()))
        } else {
            format!("{}s", n(secs))
        };
        let col = if secs > defaults::num("statusline.phase_slow_secs") as f64 { color("yellow") } else { color("dim") };
        extras.push(format!("{col}{human}{}", color("reset")));
    }
    if let Some(agents) = parse_int_of(state.get("agents")).filter(|a| *a >= 0.0) {
        let word = if agents == 1.0 { defaults::text("statusline.agent_one") } else { defaults::text("statusline.agent_many") };
        extras.push(format!("{}{}{word}{}", color("blue"), n(agents), color("reset")));
    }
    let mut step = trim(&safe_label(&s_field(&state, "step"))?).to_string();
    if !step.is_empty() {
        if len16(&step) > defaults::num("statusline.step_max") as usize {
            step = head16(&step, defaults::num("statusline.step_max") as usize - 1)? + defaults::text("statusline.ellipsis");
        }
        extras.push(format!("{}{step}{}", color("dim"), color("reset")));
    }
    let extra_str = if extras.is_empty() { String::new() } else { format!(" {}|{} {}", color("dim"), color("reset"), extras.join(" ")) };
    let (bold, magenta, white, cyan, yellow) = (color("bold"), color("magenta"), color("white"), color("cyan"), color("yellow"));
    Ok(Phase::Line(defaults::render(
        "statusline.phase_template",
        &[
            ("bar", &bar),
            ("yellow", &yellow),
            ("pct", &n(pct)),
            ("reset", &color("reset")),
            ("dim", &color("dim")),
            ("bold", &bold),
            ("magenta", &magenta),
            ("code", &code),
            ("white", &white),
            ("desc", &desc),
            ("cyan", &cyan),
            ("done", &n(done)),
            ("total", &n(total)),
            ("extra", &extra_str),
        ],
    )))
}

/// The percentage fields of a `context_window` object, as `contextLine` and `persistContextPct` read them.
fn context_pct(cw: &J) -> Option<f64> {
    match cw.get("used_percentage") {
        Some(J::Num(p)) => Some(*p),
        _ => match cw.get("remaining_percentage") {
            Some(J::Num(r)) => Some(100.0 - r),
            _ => None,
        },
    }
}

fn num_field(cw: &J, keys: &[&str]) -> Option<f64> {
    keys.iter().find_map(|k| match cw.get(k) {
        Some(J::Num(x)) => Some(*x),
        _ => None,
    })
}

/// `contextLine(input)`
fn context_line(input: &str) -> Option<String> {
    let data = parse(input)?;
    let cw = data.get("context_window").filter(|c| matches!(c, J::Obj(_) | J::Arr(_)))?;
    let pct = num::js_round(context_pct(cw)?).clamp(0.0, 100.0);
    let col = level_color(pct);
    let bar = render_level_bar(pct, col);
    let used = num_field(cw, &defaults::list("statusline.used_keys"));
    let max = num_field(cw, &defaults::list("statusline.max_keys"));
    let tokens = match (used, max) {
        (Some(u), Some(m)) if m > 0.0 => format!(" {}·{} {}{}/{} tokens{}", color("dim"), color("reset"), color("dim"), kfmt(u), kfmt(m), color("reset")),
        _ => String::new(),
    };
    Some(defaults::render(
        "statusline.context_template",
        &[("bar", &bar), ("col", &col), ("pct", &n(pct)), ("reset", &color("reset")), ("dim", &color("dim")), ("tokens", &tokens)],
    ))
}

/// `currentSessionTag(input)`
fn current_session_tag(input: &str) -> Option<String> {
    let data = parse(input)?;
    if !matches!(data, J::Obj(_) | J::Arr(_)) {
        return None;
    }
    if let Some(J::Str(s)) = data.get("session_id") {
        let t = trim(s);
        if !t.is_empty() {
            let tag: String = t.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-').collect();
            let tag = head16(&tag, defaults::num("statusline.tag_max") as usize).ok()?;
            return (!tag.is_empty()).then_some(tag);
        }
    }
    let cwd = match data.get("cwd") {
        v if j_truthy(v) => v,
        _ => data.get("workspace").and_then(|w| w.get("current_dir")),
    };
    let cwd = match cwd {
        Some(v) if j_truthy(Some(v)) => crate::migrate::j_string(v),
        _ => String::new(),
    };
    if cwd.is_empty() {
        return None;
    }
    Some(format!("{}{}", defaults::text("statusline.cwd_tag_prefix"), &text::sha1_hex(cwd.as_bytes())[..12]))
}

/// `recentSpawns(tag)`
fn recent_spawns(cx: &Ctx, tag: &str) -> usize {
    let log = Path::new(&cx.home).join(defaults::text("paths.base_dir")).join(defaults::text("statusline.spawn_log"));
    let Ok(b) = std::fs::read(log) else { return 0 };
    let text = String::from_utf8_lossy(&b).into_owned();
    trim(&text)
        .split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
        .filter(|l| {
            let Some(sp) = l.find(' ') else { return false };
            let ms = crate::setup::jsfmt::parse_int(&l[..sp]);
            let line_tag = trim(&l[sp + 1..]);
            ms.is_some_and(|ms| ms.is_finite() && cx.now - ms < defaults::num("statusline.activity_ms") as f64) && line_tag == tag
        })
        .count()
}

/// `activityLine(input)`
fn activity_line(cx: &Ctx, input: &str) -> Option<String> {
    let tag = current_session_tag(input)?;
    let count = recent_spawns(cx, &tag);
    if count == 0 {
        return None;
    }
    let w = bar_width();
    let pos = ((cx.now / defaults::num("statusline.sweep_ms") as f64).floor() as usize) % w;
    let mut cells = String::new();
    for i in 0..w {
        if i == pos {
            cells.push_str(&format!("{}{}{}", color("cyan"), defaults::text("statusline.bar_fill"), color("reset")));
        } else {
            cells.push_str(&format!("{}{}{}", color("dim"), defaults::text("statusline.bar_empty"), color("reset")));
        }
    }
    let plural = if count == 1 { "" } else { defaults::text("statusline.plural_s") };
    Some(defaults::render(
        "statusline.activity_template",
        &[
            ("cells", &cells),
            ("cyan", &color("cyan")),
            ("reset", &color("reset")),
            ("dim", &color("dim")),
            ("blue", &color("blue")),
            ("count", &count),
            ("plural", &plural),
        ],
    ))
}

/// `persistContextPct(input)`: bridge the harness's own context figure to the hooks (throttled, atomic, best effort).
fn persist_context_pct(cx: &Ctx, input: &str) {
    let Some(data) = parse(input) else { return };
    let Some(cw) = data.get("context_window").filter(|c| matches!(c, J::Obj(_) | J::Arr(_))) else { return };
    let Some(pct) = context_pct(cw) else { return };
    let pct = pct.clamp(0.0, 100.0);
    let used = num_field(cw, &defaults::list("statusline.used_keys"));
    let max = num_field(cw, &defaults::list("statusline.max_keys"));
    let tag = match data.get("session_id") {
        Some(J::Str(s)) if !trim(s).is_empty() => {
            let t: String = trim(s).chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-').collect();
            match head16(&t, defaults::num("statusline.tag_max") as usize) {
                Ok(t) if !t.is_empty() => t,
                _ => return,
            }
        }
        _ => return,
    };
    let path = Path::new(&cx.home).join(defaults::text("paths.base_dir")).join(defaults::text("statusline.pct_dir")).join(format!("{tag}.json"));
    if let Some(prev) = std::fs::read_to_string(&path).ok().and_then(|t| parse(&t))
        && let (Some(J::Num(ts)), Some(J::Num(pp))) = (prev.get("ts"), prev.get("pct"))
        && cx.now - ts < defaults::num("statusline.pct_write_interval_ms") as f64
        && (pct - pp).abs() < defaults::num("statusline.pct_min_delta") as f64
    {
        return;
    }
    if let Some(dir) = path.parent() {
        crate::discard::harmless(std::fs::create_dir_all(dir)); // keep: best effort; the write below fails and is dropped the same way
    }
    let opt = |v: Option<f64>| v.map_or(J::Null, J::Num);
    let body = json::stringify(&J::Obj(vec![
        ("pct".into(), J::Num(pct)),
        ("usedTokens".into(), opt(used)),
        ("maxTokens".into(), opt(max)),
        ("ts".into(), J::Num(cx.now)),
    ]));
    let mut tmp = path.as_os_str().to_os_string();
    tmp.push(format!(".{}.{:08x}.tmp", std::process::id(), (cx.now as u64) ^ u64::from(std::process::id())));
    let tmp = PathBuf::from(tmp);
    if std::fs::write(&tmp, body).is_ok() && std::fs::rename(&tmp, &path).is_err() {
        crate::discard::harmless(std::fs::remove_file(&tmp)); // keep: cleanup of a failed best-effort write
    }
}

/// `runWithInput(input)` of the phase bar: the line (with its newline trimmed), `None` when nothing renders.
pub fn run(cx: &Ctx, input: &str) -> Result<Option<String>, Defer> {
    persist_context_pct(cx, input);
    let line = match phase_bar_line(cx)? {
        Phase::Threw => return Ok(None),
        Phase::Line(l) => Some(l),
        Phase::None => activity_line(cx, input).or_else(|| context_line(input)),
    };
    Ok(line)
}
