//! `ah-engine harvest`: scan a code tree for deliberate-debt markers (`// anti-hall: <ceiling>, <when>` in any comment
//! syntax). Port of `scripts/harvest-debt.js`; the marker grammar is hand-matched so that it behaves like the JavaScript
//! regular expression it replaces (a line ending in CR, for example, matches nothing, because `.` stops at a CR).
use super::jsfmt::{len16, obj, pad_end, parse_int, pretty, slice16, tail16};
use super::{SetupError, cwd, list_dir, out, read_capped, text_of, warn, what};
use crate::checks::guardkit::paths::{join, resolve};
use crate::checks::jsport::json::J;
use crate::cli::Parsed;
use crate::defaults;
use crate::jev::is_js_whitespace;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Instant;

/// One marker found in a file.
struct Hit {
    line: usize,
    ceiling: String,
    when: Option<String>,
}

/// One marker with its rot assessment.
struct Marker {
    file: String,
    line: usize,
    ceiling: String,
    when: Option<String>,
    rot_risk: bool,
    rot_reason: Option<String>,
}

/// The characters `.` does not match in a JavaScript regular expression.
fn is_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// The length of the comment leader at `at`, if one starts there (`//`, `#`, `--`, `/*`, `<!--`).
fn leader_at(c: &[char], at: usize) -> Option<usize> {
    let starts = |s: &str| s.chars().enumerate().all(|(i, x)| c.get(at + i) == Some(&x));
    defaults::list("setup.harvest_leaders").into_iter().find(|l| starts(l)).map(|l| l.chars().count())
}

/// The end of `leader \s* anti-hall:` starting at `at`, if that is what is there.
fn marker_head(c: &[char], at: usize) -> Option<usize> {
    let mut i = at + leader_at(c, at)?;
    while c.get(i).is_some_and(|x| is_js_whitespace(*x)) {
        i += 1;
    }
    let tag: Vec<char> = defaults::text("setup.harvest_tag").chars().collect();
    if c.get(i..i + tag.len()) == Some(&tag[..]) { Some(i + tag.len()) } else { None }
}

/// `MARKER_RE.exec` from `from`: the next marker's capture and the index where the next search starts.
fn next_marker(c: &[char], from: usize) -> Option<(String, usize)> {
    for p in from..c.len() {
        let Some(mut i) = marker_head(c, p) else { continue };
        while c.get(i).is_some_and(|x| is_js_whitespace(*x)) {
            i += 1;
        }
        let start = i;
        // the lazy capture ends where another marker head begins or the line ends; a line terminator before that fails
        loop {
            if i >= c.len() || marker_head(c, i).is_some() {
                return Some((c[start..i].iter().collect(), i));
            }
            if is_line_terminator(c[i]) {
                break;
            }
            i += 1;
        }
    }
    None
}

/// `s.replace(/\s*(?:\*\/|-->)\s*$/, '')`.
fn strip_closer_at_end(s: &str) -> String {
    let t = s.trim_end_matches(is_js_whitespace);
    for closer in defaults::list("setup.harvest_closers") {
        if let Some(r) = t.strip_suffix(closer) {
            return r.trim_end_matches(is_js_whitespace).to_string();
        }
    }
    s.to_string()
}

/// `s.replace(/\s*(?:\*\/|-->).*$/, '')`: cut from the first closer whose remainder holds no line terminator.
fn cut_at_closer(s: &str) -> String {
    let c: Vec<char> = s.chars().collect();
    let closers: Vec<Vec<char>> = defaults::list("setup.harvest_closers").into_iter().map(|x| x.chars().collect()).collect();
    for p in 0..c.len() {
        let mut i = p;
        while c.get(i).is_some_and(|x| is_js_whitespace(*x)) {
            i += 1;
        }
        for cl in &closers {
            if c.get(i..i + cl.len()) == Some(&cl[..]) && !c[i + cl.len()..].iter().any(|x| is_line_terminator(*x)) {
                return c[..p].iter().collect();
            }
        }
    }
    s.to_string()
}

fn js_trim(s: &str) -> &str {
    crate::jev::js_trim(s)
}

/// The markers of one file (none for a file that is empty, oversized or binary; an unreadable one is said on stderr).
fn scan_file(path: &str) -> Vec<Hit> {
    let meta = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(e) => {
            report_stat(path, &e);
            return Vec::new();
        }
    };
    if !meta.is_file() || meta.len() == 0 || meta.len() > defaults::num("setup.harvest_max_file_bytes") {
        return Vec::new();
    }
    let buf = match read_capped(Path::new(path)) {
        Ok(Some(b)) => b,
        Ok(None) => return Vec::new(),
        Err(e) => {
            warn(&defaults::render("setup.msg_treated_absent", &[("error", &e)]));
            return Vec::new();
        }
    };
    let n = buf.len().min(defaults::num("setup.harvest_binary_check_bytes") as usize);
    if buf.get(..n).is_some_and(|head| head.contains(&0)) {
        return Vec::new();
    }
    let text = text_of(buf);
    let mut out = Vec::new();
    for (idx, line) in text.split('\n').enumerate() {
        let c: Vec<char> = line.chars().collect();
        let mut from = 0;
        while let Some((cap, next)) = next_marker(&c, from) {
            let raw = js_trim(&strip_closer_at_end(&cap)).to_string();
            let (ceiling, when) = match raw.find(',') {
                None => (js_trim(&cut_at_closer(&raw)).to_string(), None),
                Some(k) => {
                    let when = js_trim(&cut_at_closer(&raw[k + 1..])).to_string();
                    (js_trim(&raw[..k]).to_string(), if when.is_empty() { None } else { Some(when) })
                }
            };
            out.push(Hit { line: idx + 1, ceiling, when });
            from = next;
        }
    }
    out
}

/// A path that cannot be examined: a vanished or dangling path is the ordinary case and silent; the rest is said.
fn report_stat(path: &str, e: &std::io::Error) {
    if e.kind() != std::io::ErrorKind::NotFound {
        warn(&defaults::render(
            "setup.msg_treated_absent",
            &[("error", &SetupError::Io { what: what("setup.what_stat", &path), source: std::io::Error::new(e.kind(), e.to_string()) })],
        ));
    }
}

/// Every candidate file under `dir`, in the order Node's stack walk visits them.
fn walk(dir: &str) -> Vec<String> {
    let mut files = Vec::new();
    let mut stack = vec![dir.to_string()];
    while let Some(cur) = stack.pop() {
        let meta = match std::fs::metadata(&cur) {
            Ok(m) => m,
            Err(e) => {
                report_stat(&cur, &e);
                continue;
            }
        };
        if meta.is_file() {
            files.push(cur);
            continue;
        }
        if !meta.is_dir() {
            continue;
        }
        let mut entries = list_dir(Path::new(&cur));
        entries.sort_by(|a, b| crate::checks::jsport::text::cmp16(&a.0, &b.0));
        for (name, ft, _) in entries.into_iter().rev() {
            if defaults::list("setup.harvest_skip_dirs").contains(&name.as_str()) || name.starts_with('.') {
                continue;
            }
            if ft.is_dir() || ft.is_file() {
                stack.push(join(&cur, &name));
            }
        }
    }
    files
}

/// `git log -1 --format=%ct -- <file>`: the last commit time in epoch seconds, `None` when git says nothing useful (it is
/// not installed, the file is outside a repository, or it took too long).
fn git_time(file: &str) -> Option<f64> {
    let mut child = match Command::new(defaults::text("setup.git_binary"))
        .args(defaults::list("setup.git_args"))
        .arg(file)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            if e.kind() != std::io::ErrorKind::NotFound {
                warn(&defaults::render(
                    "setup.msg_treated_absent",
                    &[("error", &SetupError::Io { what: defaults::text("setup.what_git").to_string(), source: e })],
                ));
            }
            return None;
        }
    };
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut b = Vec::new();
        std::io::Read::read_to_end(&mut std::io::Read::take(&mut stdout, defaults::num("setup.git_output_max_bytes")), &mut b).map(|_| b)
    });
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) if start.elapsed() < defaults::millis("setup.git_timeout_ms") => std::thread::sleep(defaults::millis("setup.git_poll_ms")),
            Ok(None) => {
                stop_child(&mut child);
                return None;
            }
            Err(e) => {
                warn(&defaults::render(
                    "setup.msg_treated_absent",
                    &[("error", &SetupError::Io { what: defaults::text("setup.what_git").to_string(), source: e })],
                ));
                stop_child(&mut child);
                return None;
            }
        }
    };
    let bytes = match reader.join() {
        Ok(Ok(b)) => b,
        Ok(Err(e)) => {
            warn(&defaults::render(
                "setup.msg_treated_absent",
                &[("error", &SetupError::Io { what: defaults::text("setup.what_git").to_string(), source: e })],
            ));
            return None;
        }
        Err(_) => {
            warn(defaults::text("setup.msg_git_reader_panicked"));
            return None;
        }
    };
    if !status.success() {
        return None;
    }
    let text = text_of(bytes);
    let t = js_trim(&text);
    if t.is_empty() { None } else { parse_int(t) }
}

/// Kill and reap a git child that overran its time; a child that has already gone is not an error.
fn stop_child(child: &mut std::process::Child) {
    if let Err(e) = child.kill()
        && e.kind() != std::io::ErrorKind::InvalidInput
    {
        warn(&defaults::render("setup.msg_treated_absent", &[("error", &SetupError::Io { what: defaults::text("setup.what_git").to_string(), source: e })]));
    }
    if let Err(e) = child.wait() {
        warn(&defaults::render("setup.msg_treated_absent", &[("error", &SetupError::Io { what: defaults::text("setup.what_git").to_string(), source: e })]));
    }
}

/// `harvestMarkers({dir, staleDays})`.
fn harvest(dir: &str, stale_days: f64, now: f64, cwd: &str) -> Vec<Marker> {
    let root = resolve(cwd, dir);
    let threshold = stale_days * 24.0 * 60.0 * 60.0;
    let mut markers = Vec::new();
    for abs in walk(&root) {
        let hits = scan_file(&abs);
        if hits.is_empty() {
            continue;
        }
        let rel = crate::checks::guardkit::paths::relative(&root, &abs);
        let epoch = git_time(&abs);
        for h in hits {
            let (mut rot, mut why) = (false, None::<String>);
            if h.when.is_none() {
                rot = true;
                why = Some(defaults::text("setup.msg_no_trigger").to_string());
            }
            if let Some(e) = epoch
                && now - e > threshold
            {
                let stale = defaults::render("setup.msg_stale", &[("days", &crate::checks::jsport::num::to_js_string(stale_days))]);
                rot = true;
                why = Some(match why {
                    Some(w) => format!("{w}{}{stale}", defaults::text("setup.harvest_reason_sep")),
                    None => stale,
                });
            }
            markers.push(Marker { file: rel.clone(), line: h.line, ceiling: h.ceiling, when: h.when, rot_risk: rot, rot_reason: why });
        }
    }
    markers
}

fn marker_json(m: &Marker) -> J {
    obj(vec![
        ("file", J::Str(m.file.clone())),
        ("line", J::Num(m.line as f64)),
        ("ceiling", J::Str(m.ceiling.clone())),
        ("when", m.when.clone().map_or(J::Null, J::Str)),
        ("rotRisk", J::Bool(m.rot_risk)),
        ("rotReason", m.rot_reason.clone().map_or(J::Null, J::Str)),
    ])
}

/// A column width from the defaults.
fn width(key: &str) -> usize {
    defaults::num(key) as usize
}

/// The command: `harvest [--dir <path>] [--stale-days <n>] [--json]`.
pub fn run(p: &Parsed) -> Result<i32, SetupError> {
    let args = &p.rest;
    let default_days = defaults::num("setup.harvest_default_stale_days") as f64;
    let here = cwd()?;
    let mut dir = here.clone();
    let mut stale = default_days;
    let mut i = 0;
    while i < args.len() {
        if args[i] == "--dir" && args.get(i + 1).is_some_and(|v| !v.is_empty()) {
            i += 1;
            dir = args[i].clone();
        } else if args[i] == "--stale-days" && args.get(i + 1).is_some_and(|v| !v.is_empty()) {
            i += 1;
            stale = parse_int(&args[i]).filter(|n| *n != 0.0).unwrap_or(default_days).max(1.0);
        }
        i += 1;
    }
    let now = (crate::checks::jsport::date::now_ms() / 1000.0).floor();
    let markers = harvest(&dir, stale, now, &here);
    let rot = markers.iter().filter(|m| m.rot_risk).count();
    let with_trigger = markers.iter().filter(|m| m.when.is_some()).count();
    if p.json {
        let v = obj(vec![
            ("markers", J::Arr(markers.iter().map(marker_json).collect())),
            ("summary", obj(vec![("total", J::Num(markers.len() as f64)), ("rotRisk", J::Num(rot as f64)), ("withTrigger", J::Num(with_trigger as f64))])),
        ]);
        out(&pretty(&v))?;
        return Ok(0);
    }
    if markers.is_empty() {
        out(defaults::text("setup.msg_none_found"))?;
        return Ok(0);
    }
    let (wf, wl, wc, ww) = (width("setup.harvest_w_file"), width("setup.harvest_w_line"), width("setup.harvest_w_ceiling"), width("setup.harvest_w_when"));
    let (file_gap, tail_gap, cell_gap) = (width("setup.harvest_file_gap"), width("setup.harvest_file_tail_gap"), width("setup.harvest_cell_gap"));
    let heads = defaults::list("setup.harvest_headers");
    let head = |i: usize| heads.get(i).copied().unwrap_or("");
    out(&defaults::render("setup.fmt_harvest_title", &[("title", &defaults::text("setup.msg_table_title"))]))?;
    out(&format!("{}{}{}{}{}", pad_end(head(0), wf), pad_end(head(1), wl), pad_end(head(2), wc), pad_end(head(3), ww), head(4)))?;
    out(&defaults::text("setup.harvest_rule_char").repeat(wf + wl + wc + ww + width("setup.harvest_rule_extra")))?;
    for m in &markers {
        let file = if len16(&m.file) > wf.saturating_sub(file_gap) {
            format!("{}{}", defaults::text("setup.harvest_ellipsis"), tail16(&m.file, wf.saturating_sub(tail_gap)))
        } else {
            m.file.clone()
        };
        let ceil = slice16(&m.ceiling, 0, wc.saturating_sub(cell_gap));
        let when = slice16(m.when.as_deref().unwrap_or(defaults::text("setup.harvest_none")), 0, ww.saturating_sub(cell_gap));
        let rot_col = if m.rot_risk {
            slice16(&defaults::render("setup.harvest_rot_yes", &[("reason", &m.rot_reason.as_deref().unwrap_or(""))]), 0, width("setup.harvest_w_rot"))
        } else {
            String::new()
        };
        out(&format!("{}{}{}{}{}", pad_end(&file, wf), pad_end(&m.line.to_string(), wl), pad_end(&ceil, wc), pad_end(&when, ww), rot_col))?;
    }
    out(&defaults::render("setup.fmt_harvest_total", &[("total", &markers.len()), ("rot", &rot), ("trigger", &with_trigger)]))?;
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn caps(line: &str) -> Vec<(String, Option<String>)> {
        let c: Vec<char> = line.chars().collect();
        let mut from = 0;
        let mut found = Vec::new();
        while let Some((cap, next)) = next_marker(&c, from) {
            let raw = js_trim(&strip_closer_at_end(&cap)).to_string();
            found.push(match raw.find(',') {
                None => (js_trim(&cut_at_closer(&raw)).to_string(), None),
                Some(k) => (js_trim(&raw[..k]).to_string(), Some(js_trim(&cut_at_closer(&raw[k + 1..])).to_string())),
            });
            from = next;
        }
        found
    }

    #[test]
    fn a_marker_has_a_ceiling_and_a_trigger() {
        assert_eq!(caps("// anti-hall: no cache, when load>10"), vec![("no cache".to_string(), Some("when load>10".to_string()))]);
    }

    #[test]
    fn two_markers_on_one_line_are_both_found() {
        assert_eq!(caps("x -- anti-hall: one, two -- anti-hall: three, four").len(), 2);
    }

    #[test]
    fn a_line_ending_in_a_carriage_return_matches_nothing_as_in_javascript() {
        assert!(caps("/* anti-hall: c , d */ y\r").is_empty());
    }

    #[test]
    fn a_block_comment_closer_is_trimmed_off() {
        assert_eq!(caps("/* anti-hall: a, b */"), vec![("a".to_string(), Some("b".to_string()))]);
    }
}
