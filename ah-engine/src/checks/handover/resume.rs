//! Built-in `check = "handover-resume"`: port of `hooks/handover-resume.js` (SessionStart).
//!
//! After a clear, a compaction or a fresh start, find the newest session handover under
//! `<repo>/.anti-hall/handovers/` and inject a guided resume procedure that points at it (never its content),
//! with git facts measured now, a note when the writer kept running, and the PreCompact snapshot when one exists.
use super::find::{self, Cand, Unsure};
use crate::checks::codex::availability::is_codex_payload;
use crate::checks::git::util::{path_join, posix_dirname};
use crate::checks::guardkit::msg::{self, Kind, Parts};
use crate::checks::guardkit::settings::get_bool;
use crate::checks::guardkit::text::js_trim;
use crate::checks::jsport::json::{self, J};
use crate::checks::jsport::{date, fsx, gitrun, home, num, text as jstext};
use crate::checks::{Check, Verdict};
use crate::defaults;
use crate::reqenv::RequestEnv;
use crate::rules::Subject;
use serde_json::Value;

fn tpl(key: &str, args: &[(&str, &str)]) -> String {
    msg::render(key, args)
}

/// `readIndexOutcome`: the outcome column of the INDEX.md row for this handover, or empty.
fn index_outcome(root: &str, date: &str, sid: &str, seq: u64) -> String {
    let Some(raw) = fsx::read_utf8(&format!("{root}/{}", defaults::text("codex_handover.index_file"))) else { return String::new() };
    let sep = defaults::text("codex_handover.index_sep");
    let want = format!("{}{seq}", defaults::text("codex_handover.index_seq_prefix"));
    let mut fallback = String::new();
    for line in raw.split('\n') {
        if !line.contains(date) || !line.contains(sid) {
            continue;
        }
        let parts: Vec<&str> = line.split(sep).map(js_trim).collect();
        if parts.len() >= 4 && !parts[3].is_empty() {
            if parts[2] == want {
                return parts[3].to_string();
            }
            fallback = parts[3].to_string();
        }
    }
    fallback
}

/// `freshnessLine`: git facts measured now against the handover's modification time, or empty outside a repository.
fn freshness(cwd: &str, since_ms: f64, env: &RequestEnv) -> String {
    let t = defaults::millis("codex_handover.resume_git_timeout_ms");
    let Some(head) = gitrun::git(cwd, &defaults::list("codex_handover.argv_head"), t, env) else { return String::new() };
    let at = num::to_js_string((since_ms / 1000.0).floor());
    let count_argv: Vec<String> = defaults::list("codex_handover.argv_count").iter().map(|a| a.replace("{since}", &at)).collect();
    let since = gitrun::git(cwd, &count_argv.iter().map(String::as_str).collect::<Vec<_>>(), t, env);
    let status = gitrun::git(cwd, &defaults::list("codex_handover.argv_porcelain"), t, env);
    let commits = since.map_or("?".to_string(), |s| parse_int(&s).to_string());
    let dirty = status.map_or("?".to_string(), |s| s.split('\n').filter(|l| !l.is_empty()).count().to_string());
    tpl("codex_handover.resume_freshness", &[("head", js_trim(&head)), ("commits", &commits), ("dirty", &dirty)])
}

/// `parseInt(s, 10) || 0`.
fn parse_int(s: &str) -> u64 {
    let t = js_trim(s);
    let digits: String = t.chars().take_while(char::is_ascii_digit).collect();
    digits.parse::<u64>().unwrap_or(0)
}

/// `writerActivityLine`: a line when the session that wrote the handover kept running well after it.
fn writer_line(cwd: &str, root: &str, cand: &Cand, home: &str) -> String {
    let sid = &cand.session_id;
    if sid.is_empty() || !sid.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-')) {
        return String::new();
    }
    let mut roots = vec![find::repo_of_handovers(root)];
    if !roots.iter().any(|r| r == cwd) {
        roots.push(cwd.to_string());
    }
    for r in roots {
        let encoded: String = r.chars().map(|c| if matches!(c, '/' | '\\' | ':' | '.') { '-' } else { c }).collect();
        let file = path_join(&format!("{home}/{}", defaults::text("codex_handover.projects_dir")), &format!("{encoded}/{sid}.jsonl"));
        let Ok(md) = std::fs::metadata(&file) else { continue };
        let m = fsx::mtime_ms(&md);
        let gap = m - cand.mtime_ms;
        if gap <= defaults::num("codex_handover.writer_grace_ms") as f64 || gap.is_nan() {
            return String::new();
        }
        let Some(iso) = date::to_iso(m) else { return String::new() };
        let iso = format!("{}Z", &iso[..iso.len() - defaults::num("codex_handover.iso_ms_tail") as usize]);
        return tpl("codex_handover.resume_writer", &[("sid", sid), ("min", &num::to_js_string(num::js_round(gap / 60000.0))), ("iso", &iso)]);
    }
    String::new()
}

/// `RESUME_CHECKLIST_HEADING`: `/^##\s*Resume-verification checklist\b/im`.
pub(super) fn has_checklist(content: &str) -> bool {
    let needle = defaults::text("codex_handover.checklist_title");
    let is_ws = crate::checks::guardkit::text::is_js_space;
    let mut starts = vec![0usize];
    for (i, c) in content.char_indices() {
        if matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}') {
            starts.push(i + c.len_utf8());
        }
    }
    starts.into_iter().any(|p| {
        let Some(rest) = content[p..].strip_prefix("##") else { return false };
        let rest = rest.trim_start_matches(is_ws);
        let Some(head) = rest.get(..needle.len()) else { return false };
        head.eq_ignore_ascii_case(needle) && !rest[needle.len()..].starts_with(|c: char| c.is_ascii_alphanumeric() || c == '_')
    })
}

fn build_context(c: &Cand, outcome: &str, prefix: &str, freshness: &str, codex: bool, writer: &str) -> String {
    let seq_label = if c.seq > 1 { format!("HANDOVER-{}.md", c.seq) } else { defaults::text("codex_handover.handover_plain").to_string() };
    let pred = if c.seq > 1 {
        Some(if c.seq == 2 { defaults::text("codex_handover.handover_plain").to_string() } else { format!("HANDOVER-{}.md", c.seq - 1) })
    } else {
        None
    };
    let rule = defaults::text(if codex { "codex_handover.rule_file_codex" } else { "codex_handover.rule_file_claude" });
    let has_check = fsx::read_utf8(&c.file_path).is_some_and(|t| has_checklist(&t));
    let dir = posix_dirname(&c.file_path);
    let details: Vec<&str> = defaults::list("codex_handover.detail_files").into_iter().filter(|f| fsx::is_file(&format!("{dir}/{f}"))).collect();
    let pred_txt = pred.map_or(String::new(), |p| tpl("codex_handover.resume_pred", &[("pred", &p)]));
    let outcome_txt = if outcome.is_empty() { String::new() } else { tpl("codex_handover.resume_outcome", &[("outcome", outcome)]) };
    let mut lines = vec![tpl(
        "codex_handover.resume_head",
        &[
            ("prefix", prefix),
            ("path", &c.file_path),
            ("seq_label", &seq_label),
            ("pred", &pred_txt),
            ("date", &c.date),
            ("sid", &c.session_id),
            ("outcome", &outcome_txt),
        ],
    )];
    if !freshness.is_empty() {
        lines.push(freshness.to_string());
    }
    if !writer.is_empty() {
        lines.push(writer.to_string());
    }
    lines.push(String::new());
    lines.push(defaults::text("codex_handover.resume_do_instead").to_string());
    let mut steps: Vec<String> = vec![tpl("codex_handover.step_read", &[("path", &c.file_path)])];
    steps.push(tpl(if has_check { "codex_handover.step_checklist" } else { "codex_handover.step_generic" }, &[("rule", rule), ("path", &c.file_path)]));
    if !details.is_empty() {
        steps.push(tpl("codex_handover.step_details", &[("files", &details.join(defaults::text("codex_handover.details_sep")))]));
    }
    if details.contains(&defaults::text("codex_handover.detail_trials")) {
        steps.push(defaults::text("codex_handover.step_trials").to_string());
    }
    steps.push(defaults::text("codex_handover.step_readback").to_string());
    steps.push(defaults::text("codex_handover.step_continue").to_string());
    if details.contains(&defaults::text("codex_handover.detail_state")) {
        steps.push(defaults::text("codex_handover.step_tasks").to_string());
    }
    for (i, s) in steps.iter().enumerate() {
        lines.push(format!("{}. {s}", i + 1));
    }
    lines.push(String::new());
    lines.push(defaults::text("codex_handover.resume_note").to_string());
    lines.join("\n")
}

fn snapshot_line(snap: &Cand, cand: &Cand) -> String {
    tpl(if snap.mtime_ms > cand.mtime_ms { "codex_handover.snap_newer" } else { "codex_handover.snap_older" }, &[("path", &snap.file_path)])
}

fn negative(event: &str) -> Verdict {
    let text = msg::message(
        Kind::Tip,
        defaults::text("codex_handover.resume_guard"),
        &Parts {
            what: defaults::text("codex_handover.neg_what"),
            why: defaults::text("codex_handover.neg_why"),
            instead: defaults::text("codex_handover.neg_instead"),
            ..Parts::default()
        },
    );
    Verdict::Advisory(msg::advisory_json(event, &text))
}

/// The check's decision on one payload.
pub fn decide(p: &Value, env: &RequestEnv) -> Result<Option<Verdict>, Unsure> {
    if crate::checks::codex::judge_child(env) {
        return Ok(None);
    }
    let st = crate::checks::codex::settings_of(env);
    if !get_bool(&st, defaults::raw("codex_handover.setting_resume")) || !p.is_object() {
        return Ok(None);
    }
    let Some(cwd) = jstext::str_member(p, "cwd").filter(|c| !c.is_empty()) else { return Ok(None) };
    let source = jstext::str_member(p, "source").unwrap_or("");
    let compact_or_clear = defaults::list("codex_handover.resume_sources").contains(&source);
    let Some(home) = home::resolve(env) else { return Err(Unsure) };
    let event = jstext::str_member(p, "hook_event_name").filter(|e| !e.is_empty()).unwrap_or(defaults::text("codex_handover.resume_event"));
    let root = find::handovers_root(cwd, &home, env)?;
    if !fsx::is_dir(&root) {
        return Ok(compact_or_clear.then(|| negative(event)));
    }
    let raw_sid = match jstext::member(p, "session_id") {
        Some(v) if !v.is_null() => jstext::js_string(v),
        _ => String::new(),
    };
    let unknown = defaults::text("codex_handover.unknown_session");
    let want = if raw_sid.is_empty() { String::new() } else { jstext::sanitize_session(&raw_sid, unknown) };
    let now = date::now_ms();
    let max_age = defaults::num("codex_handover.resume_max_age_ms") as f64;
    let mut snap = if want.is_empty() { None } else { find::newest_precompact(&root, &want)? };
    if snap.as_ref().is_some_and(|s| now - s.mtime_ms > max_age) {
        snap = None;
    }
    let found = find::newest_handover(&root, &want)?;
    let Some(cand) = found.clone().filter(|c| now - c.mtime_ms <= max_age) else {
        if let Some(s) = &snap {
            let what = tpl("codex_handover.snaponly_what", &[("path", &s.file_path), ("written", &date::to_iso(s.mtime_ms).ok_or(Unsure)?)]);
            let text = msg::message(
                Kind::Tip,
                defaults::text("codex_handover.resume_guard"),
                &Parts {
                    what: &what,
                    why: defaults::text("codex_handover.snaponly_why"),
                    instead: defaults::text("codex_handover.snaponly_instead"),
                    ..Parts::default()
                },
            );
            return Ok(Some(Verdict::Advisory(msg::advisory_json(event, &text))));
        }
        // a stale handover stays silent; no handover at all is reported on a clear or compaction
        return Ok((found.is_none() && compact_or_clear).then(|| negative(event)));
    };
    let prefix = defaults::text(if compact_or_clear { "codex_handover.prefix_continuation" } else { "codex_handover.prefix_previous" });
    let outcome = index_outcome(&root, &cand.date, &cand.session_id, cand.seq);
    let mut ctx = build_context(&cand, &outcome, prefix, &freshness(cwd, cand.mtime_ms, env), is_codex_payload(p), &writer_line(cwd, &root, &cand, &home));
    if let Some(s) = &snap {
        ctx.push_str("\n\n");
        ctx.push_str(&snapshot_line(s, &cand));
    }
    if !raw_sid.is_empty() {
        let name = format!("{}{}.json", defaults::text("codex_handover.resume_state_prefix"), jstext::sanitize_session(&raw_sid, unknown));
        let dir = format!("{home}/{}", defaults::text("codex_handover.state_dir"));
        if fsx::mkdir_p(&dir) {
            let body = json::stringify(&J::Obj(vec![("handoverFile".into(), J::Str(cand.file_path.clone())), ("ts".into(), J::Num(date::now_ms()))]));
            crate::discard::logged("handover_resume_write", crate::atomic::write(format!("{dir}/{name}"), body));
        }
    }
    Ok(Some(Verdict::Advisory(msg::advisory_json(event, &ctx))))
}

/// The registered `handover-resume` check.
pub struct HandoverResume;

impl Check for HandoverResume {
    fn name(&self) -> &'static str {
        "handover-resume"
    }

    fn summary(&self) -> &'static str {
        defaults::text("codex_handover.resume_summary")
    }

    fn run(&self, _s: &Subject<'_>, _opts: &Value) -> Option<Verdict> {
        Some(Verdict::Defer)
    }

    fn run_env(&self, _s: &Subject<'_>, payload: &Value, _opts: &Value, env: &RequestEnv) -> Option<Verdict> {
        match decide(payload, env) {
            Ok(v) => v.or(Some(Verdict::Allow)),
            Err(Unsure) => Some(Verdict::Defer),
        }
    }
}
