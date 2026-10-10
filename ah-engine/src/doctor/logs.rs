//! `doctor --logs`: the recent warn/error entries of the central anti-hall log (`companion/lib/anti-hall-log.js`), as the Node
//! doctor's `--logs` section reads them. Report-only: it touches no pass/fail count (warnings and notes only) and writes nothing.
//!
//! The log is JSON lines in `<log dir>/<file>`, with one rotated predecessor `<file>.1`. Like `readRecent({minLevel, limit})`:
//! the current file is read; when it alone holds fewer entries than the limit the rotated file is read too, older first; a line
//! that does not parse is skipped; entries below the minimum level are dropped; the most recent `limit` are kept, newest last.
use super::Doc;
use crate::checks::jsport::text::{cmp16, js_string, truthy};
use crate::defaults;
use crate::migrate::Ctx;
use serde_json::Value;
use std::path::{Path, PathBuf};

/// The log directory: the logger's own override variable, else the default under the home directory.
fn log_dir(ctx: &Ctx) -> PathBuf {
    match ctx.env.get(defaults::text("doctor.logs_dir_env")).filter(|d| !d.is_empty()) {
        Some(d) => PathBuf::from(d),
        None => Path::new(&ctx.home).join(defaults::list("doctor.logs_dir").iter().collect::<PathBuf>()),
    }
}

/// Every line of `file` that parses as JSON, in file order; a missing or unreadable file is empty.
fn parse_file(file: &Path) -> Vec<Value> {
    let Ok(bytes) = std::fs::read(file) else { return Vec::new() };
    String::from_utf8_lossy(&bytes).split('\n').filter(|l| !l.trim().is_empty()).filter_map(|l| serde_json::from_str::<Value>(l).ok()).collect()
}

/// The rank of a level name, `None` for anything that is not one.
fn rank(level: Option<&Value>) -> Option<usize> {
    let name = level?.as_str()?;
    defaults::list("doctor.logs_levels").iter().position(|l| *l == name)
}

/// The recent entries at or above the minimum level, newest last (`readRecent({minLevel, limit})`).
fn read_recent(dir: &Path) -> Vec<Value> {
    let file = defaults::text("doctor.logs_file");
    let limit = defaults::num("doctor.logs_limit") as usize;
    let current = parse_file(&dir.join(file));
    let entries = if current.len() < limit {
        let mut all = parse_file(&dir.join(format!("{file}{}", defaults::text("doctor.logs_rotated_suffix"))));
        all.extend(current);
        all
    } else {
        current
    };
    let min = rank(Some(&Value::String(defaults::text("doctor.logs_min_level").to_string())));
    let mut kept: Vec<Value> = entries.into_iter().filter(|e| rank(e.get("level")).is_some_and(|r| min.is_none_or(|m| r >= m))).collect();
    if kept.len() > limit {
        kept.drain(..kept.len() - limit);
    }
    kept
}

/// `(e && e.<key>) || fallback`, printed as JavaScript prints it.
fn field(e: &Value, key: &str, fallback: &str) -> String {
    let v = e.get(key);
    if truthy(v) { v.map(js_string).unwrap_or_default() } else { fallback.to_string() }
}

/// The `--logs` section.
pub fn section(doc: &mut Doc, ctx: &Ctx) {
    doc.head(defaults::text("doctor_msg.head_central_logs"));
    let dir = log_dir(ctx);
    let entries = read_recent(&dir);
    let at = defaults::render("doctor_msg.logs_dir_suffix", &[("dir", &dir.display())]);
    if entries.is_empty() {
        doc.infol(defaults::render("doctor_msg.logs_none", &[("at", &at)]));
        return;
    }
    let unknown = defaults::text("doctor.logs_unknown_component");
    let mut by: Vec<(String, usize)> = Vec::new();
    for e in &entries {
        let c = field(e, "component", unknown);
        match by.iter_mut().find(|(k, _)| *k == c) {
            Some(slot) => slot.1 += 1,
            None => by.push((c, 1)),
        }
    }
    by.sort_by(|a, b| cmp16(&a.0, &b.0));
    let summary = by.iter().map(|(c, n)| format!("{c}:{n}")).collect::<Vec<_>>().join(", ");
    doc.warnl(defaults::render("doctor_msg.logs_summary", &[("n", &entries.len()), ("components", &by.len()), ("summary", &summary), ("at", &at)]));
    let shown = defaults::num("doctor.logs_shown") as usize;
    let recent = &entries[entries.len().saturating_sub(shown)..];
    if entries.len() > recent.len() {
        doc.infol(defaults::render("doctor_msg.logs_showing", &[("shown", &recent.len()), ("n", &entries.len())]));
    }
    let q = defaults::text("doctor.logs_missing_mark");
    for e in recent {
        let repo = if truthy(e.get("repoKey")) { defaults::render("doctor_msg.logs_repo_tag", &[("repo", &field(e, "repoKey", ""))]) } else { String::new() };
        let msg = if truthy(e.get("msg")) {
            field(e, "msg", "")
        } else {
            match e.get("err").filter(|v| truthy(Some(v))).and_then(|err| err.get("message")).filter(|m| truthy(Some(m))) {
                Some(m) => js_string(m),
                None => defaults::text("doctor.logs_no_message").to_string(),
            }
        };
        doc.warnl(defaults::render(
            "doctor_msg.logs_entry",
            &[
                ("ts", &field(e, "ts", q)),
                ("level", &field(e, "level", q)),
                ("component", &field(e, "component", q)),
                ("op", &field(e, "op", q)),
                ("repo", &repo),
                ("msg", &msg.split('\n').next().unwrap_or("")),
            ],
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ah-doctor-logs-{name}-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&d);
        d
    }

    #[test]
    fn the_rotated_file_is_read_older_first_and_low_levels_and_bad_lines_are_dropped() {
        let d = dir("rot");
        let file = defaults::text("doctor.logs_file");
        std::fs::write(d.join(format!("{file}{}", defaults::text("doctor.logs_rotated_suffix"))), "{\"level\":\"error\",\"msg\":\"old\"}\n").unwrap();
        std::fs::write(d.join(file), "{\"level\":\"info\",\"msg\":\"quiet\"}\n{torn\n{\"level\":\"warn\",\"msg\":\"new\"}\n5\n").unwrap();
        let got: Vec<String> = read_recent(&d).iter().map(|e| field(e, "msg", "")).collect();
        assert_eq!(got, ["old", "new"]);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_missing_log_reads_as_empty() {
        assert!(read_recent(Path::new("/nonexistent/ah-doctor-logs")).is_empty());
    }

    #[test]
    fn fields_print_as_javascript_prints_them() {
        let e: Value = serde_json::json!({"component": 0, "op": 7, "level": ""});
        assert_eq!(field(&e, "component", "(unknown)"), "(unknown)");
        assert_eq!(field(&e, "op", "?"), "7");
        assert_eq!(field(&e, "level", "?"), "?");
    }
}
