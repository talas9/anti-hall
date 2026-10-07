//! Built-in `check = "codex-nudge"`: port of `hooks/codex-nudge.js` (Stop).
//!
//! After a session made several substantial code edits with no Codex review, nudge once (a soft block with the
//! reason) to get an independent Codex second opinion. Bounded: at most two nudges per session, deduplicated on the
//! set of edited code files. Fail-open: every error allows the stop.
//!
//! What this port does not do: the Jev consult. When Jev is enabled for the `codexNudgeSubstantial` integration the
//! check defers to the Node hook, which owns the consult.
use super::quota::{self, Unsure};
use crate::checks::git::util::{posix_basename, posix_dirname, resolve};
use crate::checks::guardkit::jsre;
use crate::checks::guardkit::msg::{self, Kind, Parts};
use crate::checks::guardkit::settings::{get_bool, is_skipped, read_object};
use crate::checks::guardkit::text::js_trim;
use crate::checks::jsport::json::{self, Fail, J};
use crate::checks::jsport::num::{self, JsNum};
use crate::checks::jsport::{date, fsx, home, ident, text as jstext};
use crate::checks::{Check, Verdict};
use crate::defaults;
use crate::reqenv::RequestEnv;
use crate::rules::Subject;
use regex::Regex;
use serde_json::Value;
use std::collections::HashSet;
use std::sync::OnceLock;

fn code_ext() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| jsre::compile(defaults::text("codex_handover.nudge_code_ext_re"), true))
}
fn agent_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| jsre::compile(defaults::text("codex_handover.nudge_agent_re"), true))
}

/// What the transcript tail showed.
struct Scan {
    /// Base names of the counted code files, in first-seen order.
    files: Vec<String>,
    edits: usize,
    review: bool,
}

/// `readTranscriptTail`: the last window of the file (the whole file when it is smaller). `None` on any failure.
fn read_tail(path: &str) -> Option<(String, bool)> {
    use std::io::{Read, Seek, SeekFrom};
    let window = defaults::num("codex_handover.nudge_tail_bytes");
    let mut f = std::fs::File::open(path).ok()?;
    let size = f.metadata().ok()?.len();
    if size <= window {
        let mut b = Vec::new();
        f.read_to_end(&mut b).ok()?;
        return Some((String::from_utf8_lossy(&b).into_owned(), false));
    }
    f.seek(SeekFrom::Start(size - window)).ok()?;
    let mut b = vec![0u8; window as usize];
    let n = f.read(&mut b).ok()?;
    b.truncate(n);
    Some((String::from_utf8_lossy(&b).into_owned(), true))
}

/// `collectTU`: every `tool_use` node under `node`, parents before children.
fn collect_tu<'a>(node: &'a Value, out: &mut Vec<&'a Value>) {
    let Some(o) = node.as_object() else { return };
    if o.get("type").and_then(Value::as_str) == Some("tool_use") && jstext::truthy(o.get("name")) {
        out.push(node);
    }
    for k in defaults::list("codex_handover.nudge_child_keys") {
        match o.get(k) {
            Some(Value::Array(a)) => a.iter().for_each(|it| collect_tu(it, out)),
            Some(v @ Value::Object(_)) => collect_tu(v, out),
            _ => {}
        }
    }
}

/// The own-scratchpad directories of this session (`ownScratchpadDirs`), or none.
fn scratch_dirs(p: &Value, env: &RequestEnv) -> Vec<String> {
    let Some(sid) =
        jstext::str_member(p, "session_id").filter(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-')))
    else {
        return Vec::new();
    };
    let from_transcript = jstext::str_member(p, "transcript_path")
        .filter(|t| t.starts_with('/'))
        .map(|t| posix_basename(&posix_dirname(t)))
        .filter(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'));
    let Some(seg) = from_transcript.or_else(|| jstext::str_member(p, "cwd").filter(|c| c.starts_with('/')).map(jstext::dash_name)) else { return Vec::new() };
    let mut roots: Vec<String> = Vec::new();
    let tmp = defaults::list("codex_handover.tmp_env")
        .iter()
        .find_map(|k| env.get(k).filter(|v| !v.is_empty()))
        .unwrap_or(defaults::text("codex_handover.tmp_default"));
    let tmp = if tmp.len() > 1 { tmp.strip_suffix('/').unwrap_or(tmp) } else { tmp };
    for r in std::iter::once(tmp).chain(defaults::list("codex_handover.tmp_roots")) {
        if !r.is_empty() && !roots.iter().any(|x| x == r) {
            roots.push(r.to_string());
        }
    }
    let uid = home::uid();
    roots
        .iter()
        .map(|r| {
            crate::checks::git::util::path_join(
                r,
                &format!("{}{uid}/{seg}/{sid}/{}", defaults::text("codex_handover.scratch_prefix"), defaults::text("codex_handover.scratch_leaf")),
            )
        })
        .collect()
}

/// What the exclusion test needs, computed once and only when a code edit is found.
struct Exclude {
    base: Option<String>,
    scratch: Vec<String>,
    worktree: Option<String>,
}

fn exclusion(p: &Value, env: &RequestEnv) -> Result<Exclude, Unsure> {
    let cwd = jstext::str_member(p, "cwd").filter(|c| !c.is_empty());
    let worktree = match cwd {
        Some(c) => {
            let ctx = ident::resolve_context(c, true, env);
            if ctx.unsure {
                return Err(Unsure);
            }
            ctx.worktree_root
        }
        None => None,
    };
    Ok(Exclude { base: cwd.map(str::to_string), scratch: scratch_dirs(p, env), worktree })
}

/// `isExcludedFromEdits`.
fn excluded(fp: &str, ex: &Exclude) -> Result<bool, Unsure> {
    let abs = if fp.starts_with('/') {
        resolve(fp, "", "/")
    } else {
        match &ex.base {
            Some(b) if b.starts_with('/') => resolve(b, fp, "/"),
            _ => return Err(Unsure), // relative to the hook's own working directory, which is not known here
        }
    };
    if ex.scratch.iter().any(|d| fsx::is_inside_dir(&abs, d)) {
        return Ok(true);
    }
    Ok(ex.worktree.as_ref().is_some_and(|w| !fsx::is_inside_dir(&abs, w)))
}

fn scan_transcript(path: &str, p: &Value, env: &RequestEnv) -> Result<Option<Scan>, Unsure> {
    let Some((data, truncated)) = read_tail(path) else { return Ok(None) };
    let mut lines = split_lines(&data);
    if truncated && !lines.is_empty() {
        lines.remove(0);
    }
    let mut scan = Scan { files: Vec::new(), edits: 0, review: false };
    let mut ex: Option<Exclude> = None;
    let mut seen: HashSet<String> = HashSet::new();
    for line in lines {
        let t = js_trim(line);
        if t.is_empty() {
            continue;
        }
        let Some(entry) = jstext::parse_line(t).map_err(|_| Unsure)? else { continue };
        let mut tus = Vec::new();
        collect_tu(&entry, &mut tus);
        for tu in tus {
            let name = tu.get("name").and_then(Value::as_str).unwrap_or("");
            let empty = Value::Null;
            let inp = tu.get("input").filter(|i| i.is_object() || i.is_array()).unwrap_or(&empty);
            if defaults::list("codex_handover.nudge_edit_tools").contains(&name)
                && let Some(fp) = jstext::str_member(inp, "file_path").filter(|f| !f.is_empty() && code_ext().is_match(f))
            {
                if ex.is_none() {
                    ex = Some(exclusion(p, env)?);
                }
                if !excluded(fp, ex.as_ref().ok_or(Unsure)?)? {
                    scan.edits += 1;
                    let b = posix_basename(fp);
                    if seen.insert(b.clone()) {
                        scan.files.push(b);
                    }
                }
            }
            if defaults::list("codex_handover.nudge_agent_tools").contains(&name) {
                let at = jstext::first_str(inp, &defaults::list("codex_handover.agent_type_keys"));
                if agent_re().is_match(at) {
                    scan.review = true;
                }
            }
            if name == defaults::text("codex_handover.nudge_skill_tool") {
                let s = format!("{} {}", jstext::str_member(inp, "skill").unwrap_or(""), jstext::str_member(inp, "command").unwrap_or(""));
                if s.to_ascii_lowercase().contains(defaults::text("codex_handover.nudge_codex_word")) {
                    scan.review = true;
                }
            }
        }
    }
    Ok(Some(scan))
}

/// `data.split(/\r?\n/)`.
fn split_lines(data: &str) -> Vec<&str> {
    data.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect()
}

/// The effective `codexNudge.min`: environment, then settings.json, then the default (the Node `get`, clamped to 1).
fn min_setting(st: &crate::checks::git::util::Settings) -> Result<f64, Unsure> {
    let floor = defaults::num("codex_handover.nudge_min_floor") as f64;
    let coerce = |raw: &Value| -> Result<Option<f64>, Unsure> {
        let n = match raw {
            Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
            Value::String(s) => {
                let t = js_trim(s);
                if t.is_empty() {
                    return Ok(None);
                }
                match num::parse_js_number(t) {
                    JsNum::Val(v) => v,
                    JsNum::Nan => return Ok(None),
                    JsNum::Unsure => return Err(Unsure),
                }
            }
            _ => return Ok(None),
        };
        Ok(n.is_finite().then(|| n.max(floor)))
    };
    if let Some(raw) = st.env.get(defaults::text("codex_handover.nudge_min_env"))
        && let Some(v) = coerce(&Value::String(raw.clone()))?
    {
        return Ok(v);
    }
    if let Some(o) = read_object(st, defaults::text("guardkit.settings_file"))
        && let Some(v) =
            o.get(defaults::text("codex_handover.nudge_section")).and_then(Value::as_object).and_then(|s| s.get(defaults::text("codex_handover.nudge_min_key")))
        && let Some(v) = coerce(v)?
    {
        return Ok(v);
    }
    Ok(defaults::num("codex_handover.nudge_min_default") as f64)
}

/// The `codexNudgeSubstantial` consult; true when Jev, in `on` mode, confidently judged the edits trivial.
fn consult_jev(p: &Value, transcript: &str, home: &str, session: &str, scan: &Scan, env: &RequestEnv) -> bool {
    use crate::jev::{AskRequest, Question, Trust};
    let jenv = crate::jev::Env::from_pairs(env.to_map());
    let files: Vec<&str> = scan.files.iter().take(defaults::num("codex_handover.nudge_jev_files") as usize).map(String::as_str).collect();
    let state = format!(
        "{}{}\n{}{}",
        defaults::text("codex_handover.nudge_jev_files_label"),
        files.join(", "),
        defaults::text("codex_handover.nudge_jev_edits_label"),
        scan.edits
    );
    let q = Question::noul(
        defaults::text("codex_handover.nudge_jev_instructions"),
        defaults::text("codex_handover.nudge_jev_true"),
        defaults::text("codex_handover.nudge_jev_false"),
    );
    let mut req = AskRequest::new(defaults::text("codex_handover.nudge_jev_id"), q, &state, Trust::RelaxBlock, Value::Bool(true));
    req.session_id = Some(session.to_string());
    req.turn_ref = crate::jev::shared::turn_ref_from_transcript(transcript);
    req.project = crate::jev::shared::project_for(p.get("cwd").and_then(Value::as_str));
    crate::jev::shared::consult_relax(std::path::Path::new(home), &jenv, req).is_some_and(|d| d.outcome == Value::Bool(false))
}

/// `pruneStale` of `hooks/lib/state-prune.js`: remove this hook's per-session state files untouched for the TTL,
/// at most once per throttle window, never the live session's own file.
fn prune_stale(dir: &str, keep: &str, now: f64) {
    let prefix = defaults::text("codex_handover.nudge_state_prefix");
    let stamp = format!("{dir}/{}{prefix}.json", defaults::text("codex_handover.prune_stamp_prefix"));
    if let Some(raw) = fsx::read_utf8(&stamp)
        && let Ok(J::Obj(o)) = json::parse(js_trim(&raw), defaults::num("codex_handover.json_max_depth") as usize)
        && let Some((_, J::Num(last))) = o.iter().find(|(k, _)| k == "lastSweep")
        && *last <= now
        && now - *last < defaults::num("codex_handover.prune_throttle_ms") as f64
    {
        return;
    }
    let _ = std::fs::write(&stamp, json::stringify(&J::Obj(vec![("lastSweep".into(), J::Num(now))])));
    let Some(entries) = fsx::read_dir_names(dir) else { return };
    let full_prefix = format!("{prefix}-");
    let ttl = defaults::num("codex_handover.prune_ttl_ms") as f64;
    for (name, _) in entries {
        if !name.starts_with(&full_prefix) || !name.ends_with(defaults::text("codex_handover.json_suffix")) || name == keep {
            continue;
        }
        let path = format!("{dir}/{name}");
        if let Ok(md) = std::fs::metadata(&path)
            && now - fsx::mtime_ms(&md) > ttl
        {
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// The check's decision on one payload.
pub fn decide(p: &Value, env: &RequestEnv) -> Result<Option<Verdict>, Unsure> {
    let _zone = crate::checks::jsport::date::ZoneGuard::new(env);
    if super::judge_child(env) {
        return Ok(None);
    }
    let st = super::settings_of(env);
    if !get_bool(&st, defaults::raw("codex_handover.setting_nudge")) || is_skipped(&st, defaults::text("codex_handover.nudge_guard")) {
        return Ok(None);
    }
    let Some(tp) = jstext::str_member(p, "transcript_path").filter(|t| !t.is_empty()) else { return Ok(None) };
    if !tp.starts_with('/') {
        return Err(Unsure); // relative to the hook's own working directory, which is not known here
    }
    let Some(scan) = scan_transcript(tp, p, env)? else { return Ok(None) };
    let min = min_setting(&st)?;
    if (scan.edits as f64) < min || scan.review {
        return Ok(None);
    }
    let Some(home) = home::resolve(env) else { return Err(Unsure) };
    if get_bool(&st, defaults::raw("codex_handover.setting_quota_detect")) {
        quota::scan_job_logs(&home, date::now_ms())?;
    }
    if quota::read_quota(&home, date::now_ms())?.is_some() {
        return Ok(None);
    }
    let session = jstext::member(p, "session_id")
        .filter(|v| jstext::truthy(Some(v)))
        .map(jstext::js_string)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| jstext::sha1_hex(tp.as_bytes())[..defaults::num("codex_handover.nudge_session_hash_len") as usize].to_string());
    // JEV (`codexNudgeSubstantial`, `consultRelax`): on asks inside the cap and a confident "trivial" answer skips the nudge;
    // shadow and off fire a detached ask (Node's `askDetached`; an off call writes the off row).
    if consult_jev(p, tp, &home, &session, &scan, env) {
        return Ok(None);
    }
    let dir = format!("{home}/{}", defaults::text("codex_handover.state_dir"));
    let state = format!("{dir}/{}-{}.json", defaults::text("codex_handover.nudge_state_prefix"), jstext::safe_name(&session));
    let mut sorted = scan.files.clone();
    sorted.sort_by(|a, b| jstext::cmp16(a, b));
    let sig = jstext::sha1_hex(sorted.join(defaults::text("codex_handover.nudge_sig_sep")).as_bytes());
    let (mut last_sig, mut nudges) = (String::new(), 0.0f64);
    if let Some(raw) = fsx::read_utf8(&state) {
        let t = js_trim(&raw);
        if !t.is_empty() {
            match json::parse(t, defaults::num("codex_handover.json_max_depth") as usize) {
                Ok(v) => {
                    if let Some(J::Str(s)) = v.get("sig") {
                        last_sig = s.clone();
                    }
                    if let Some(J::Num(n)) = v.get("nudges")
                        && n.is_finite()
                    {
                        nudges = *n;
                    }
                }
                Err(Fail::Invalid) => {}
                Err(Fail::Unsupported) => return Err(Unsure),
            }
        }
    }
    if sig == last_sig || nudges >= defaults::num("codex_handover.nudge_max") as f64 {
        return Ok(None);
    }
    let body = json::stringify(&J::Obj(vec![("sig".into(), J::Str(sig)), ("nudges".into(), J::Num(nudges + 1.0))]));
    if !fsx::mkdir_p(&dir) || std::fs::write(&state, body).is_err() {
        return Ok(None);
    }
    prune_stale(&dir, &posix_basename(&state), date::now_ms());
    let shown: Vec<&str> = scan.files.iter().take(3).map(String::as_str).collect();
    let more = if scan.files.len() > 3 { defaults::text("codex_handover.nudge_more") } else { "" };
    let what = msg::render(
        "codex_handover.nudge_what",
        &[
            ("edits", &scan.edits.to_string()),
            ("files", &scan.files.len().to_string()),
            ("names", &shown.join(defaults::text("codex_handover.nudge_names_sep"))),
            ("more", more),
        ],
    );
    let reason = msg::message(
        Kind::Tip,
        defaults::text("codex_handover.nudge_guard"),
        &Parts {
            what: &what,
            why: defaults::text("codex_handover.nudge_why"),
            instead: defaults::text("codex_handover.nudge_instead"),
            allowed: defaults::text("codex_handover.nudge_allowed"),
            override_: defaults::text("codex_handover.nudge_override"),
            ..Parts::default()
        },
    );
    Ok(Some(Verdict::Advisory(format!("{{\"decision\":\"block\",\"reason\":{}}}", json::quote(&reason)))))
}

/// The registered `codex-nudge` check.
pub struct CodexNudge;

impl Check for CodexNudge {
    fn name(&self) -> &'static str {
        "codex-nudge"
    }

    fn summary(&self) -> &'static str {
        defaults::text("codex_handover.nudge_summary")
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
