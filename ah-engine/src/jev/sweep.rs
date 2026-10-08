//! The evidence sweep: where the facts of the supervisor's Jev questions about a child workspace are gathered in the engine.
//!
//! Node's supervisor used to ask devswarmWaitKind (is a quiet child stuck, or waiting?), devswarmLoop (is it looping?) and
//! devswarmStepMap (which plan step does a summary describe?) on a thin one-line input. They now go through the evidence gate
//! (`jev::evidence`), and this module gathers what the gate needs, per child with a plan file: the plan, the end of the child's own
//! transcript, its git log, the CI runs of its branch (the GitHub CLI) and the mesh store (what it told its parent and what it was
//! told). It runs as the scheduled job `jev_sweep` or on demand as `ah-engine jev sweep`. A child is looked at only for an
//! integration whose mode is not off; a question whose subject has not changed is not asked again within `sweep.limits.reask_ms`.
//! Acting on an answer stays with each integration's mode (nothing here edits a plan or a signal). Every window, command, pattern
//! and word is in `engine/defaults/jev_sweep.toml`.
use super::evidence;
use super::settings::{Env, Mode};
use crate::defaults;
use crate::mesh::MeshReader;
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

fn lim(k: &str) -> i64 {
    defaults::raw("sweep.limits").get(k).and_then(defaults::V::as_integer).unwrap_or(0)
}
fn path_cfg(k: &str) -> &'static str {
    defaults::raw("sweep.paths").str_field(k)
}
fn tr_list(k: &str) -> Vec<&'static str> {
    defaults::raw("sweep.transcript").get(k).map(defaults::V::strings).unwrap_or_default()
}
fn word(k: &str) -> &'static str {
    defaults::raw("sweep.words").str_field(k)
}
fn unit(k: &str) -> i64 {
    defaults::raw("sweep.duration").get(k).and_then(defaults::V::as_integer).unwrap_or(1).max(1)
}

/// `42m`, `5h` or `3d`: the plan's own duration text.
fn dur(ms: i64) -> String {
    let m = (ms.max(0)) / unit("ms_per_minute");
    if m < unit("minutes_per_hour") {
        return format!("{m}{}", word("dur_m"));
    }
    let h = m / unit("minutes_per_hour");
    if h < unit("hours_per_day") {
        return format!("{h}{}", word("dur_h"));
    }
    format!("{}{}", h / unit("hours_per_day"), word("dur_d"))
}
fn ago(now: i64, t: i64) -> String {
    word("ago_fmt").replace("{dur}", &dur(now - t))
}
fn cap(s: &str, n: i64) -> String {
    crate::checks::jsport::text::slice16_lossy(&s.split_whitespace().collect::<Vec<_>>().join(" "), n as usize)
}
fn num(v: &Value, k: &str) -> Option<i64> {
    v.get(k).and_then(Value::as_f64).map(|x| x as i64)
}

// ---- the plan ----------------------------------------------------------------------------------------

/// The step Node's `currentStep` picks: the newest doing or blocked step, else the first open one.
fn current_step(plan: &Value) -> Option<&Value> {
    let open: Vec<&Value> = plan.get("steps")?.as_array()?.iter().filter(|s| s["status"] != word("step_done")).collect();
    let mut best: Option<&Value> = None;
    for s in &open {
        if matches!(s["status"].as_str(), Some("doing" | "blocked")) && best.is_none_or(|b| num(s, "ts").unwrap_or(0) >= num(b, "ts").unwrap_or(0)) {
            best = Some(s);
        }
    }
    best.or_else(|| open.first().copied())
}

/// The latest sign of progress: step change, fresh-text activity or the last warning (what the supervisor's stall clock reads).
fn last_progress(plan: &Value, now: i64) -> i64 {
    let base = num(plan, "step_ts").or_else(|| num(plan, "created_at")).unwrap_or(now);
    base.max(num(plan, "activity_ts").unwrap_or(0)).max(num(plan, "warned_at").unwrap_or(0))
}

fn summaries(plan: &Value) -> Vec<&Value> {
    plan.get("summaries").and_then(Value::as_array).map(|a| a.iter().collect()).unwrap_or_default()
}

// ---- the child's transcript ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
enum Kind {
    Tool,
    Text,
    Err,
    User,
    Note,
}

#[derive(Debug, Clone)]
struct Ev {
    t: i64,
    kind: Kind,
    name: String,
    text: String,
    file: String,
}

fn project_dir_name(wt: &str) -> String {
    let dash: Vec<char> = path_cfg("path_dash_chars").chars().collect();
    wt.chars().map(|c| if dash.contains(&c) { '-' } else { c }).collect()
}

fn tool_arg(input: &Value) -> String {
    for k in tr_list("arg_keys") {
        if let Some(s) = input.get(k).and_then(Value::as_str) {
            return s.to_string();
        }
    }
    String::new()
}

fn text_of(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().filter_map(|b| b.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join("\n"),
        _ => String::new(),
    }
}

/// The events of the last `tail_bytes` of a transcript, oldest first.
fn read_events(path: &Path) -> Vec<Ev> {
    let Ok(mut f) = std::fs::File::open(path) else { return Vec::new() };
    let size = f.metadata().map(|m| m.len()).unwrap_or(0);
    let want = (lim("tail_bytes") as u64).min(size);
    let mut buf = Vec::new();
    if f.seek(SeekFrom::Start(size - want)).is_err() || f.take(want).read_to_end(&mut buf).is_err() {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&buf);
    let mut lines = text.lines();
    if want < size {
        lines.next(); // the first line is cut
    }
    parse_events(lines)
}

fn parse_events<'a>(lines: impl Iterator<Item = &'a str>) -> Vec<Ev> {
    let (edit_tools, skip, note) = (tr_list("edit_tools"), tr_list("skip_prompt_prefixes"), defaults::raw("sweep.transcript").str_field("task_note_prefix"));
    let mut out = Vec::new();
    for line in lines {
        let Ok(j) = serde_json::from_str::<Value>(line) else { continue };
        let Some(t) = j.get("timestamp").and_then(Value::as_str).and_then(crate::transcript::record::parse_ts_ms) else { continue };
        let content = &j["message"]["content"];
        match j["type"].as_str() {
            Some("assistant") => {
                for b in content.as_array().into_iter().flatten() {
                    match b["type"].as_str() {
                        Some("text") => out.push(Ev { t, kind: Kind::Text, name: String::new(), text: b["text"].as_str().unwrap_or("").to_string(), file: String::new() }),
                        Some("tool_use") => {
                            let name = b["name"].as_str().unwrap_or("").to_string();
                            let file = if edit_tools.contains(&name.as_str()) { b["input"]["file_path"].as_str().unwrap_or("").to_string() } else { String::new() };
                            out.push(Ev { t, kind: Kind::Tool, name, text: tool_arg(&b["input"]), file });
                        }
                        _ => {}
                    }
                }
            }
            Some("user") if j["isMeta"] != Value::Bool(true) => {
                if let Some(a) = content.as_array() {
                    for b in a.iter().filter(|b| b["type"] == "tool_result" && b["is_error"] == Value::Bool(true)) {
                        out.push(Ev { t, kind: Kind::Err, name: String::new(), text: text_of(&b["content"]), file: String::new() });
                    }
                }
                let p = if content.is_string() || content.as_array().is_some_and(|a| a.iter().all(|b| b["type"] == "text")) { text_of(content) } else { String::new() };
                let head = p.trim_start();
                if !note.is_empty() && head.starts_with(note) {
                    out.push(Ev { t, kind: Kind::Note, name: String::new(), text: String::new(), file: String::new() });
                } else if !head.is_empty() && !skip.iter().any(|pre| head.starts_with(pre)) {
                    out.push(Ev { t, kind: Kind::User, name: String::new(), text: p, file: String::new() });
                }
            }
            _ => {}
        }
    }
    out
}

fn contains_ci(hay: &str, pats: &[&str]) -> bool {
    let h = hay.to_lowercase();
    pats.iter().any(|p| h.contains(&p.to_lowercase()))
}

// ---- git, CI, mesh -------------------------------------------------------------------------------------

fn run_argv(argv: &[&str], wt: &str, branch: &str, timeout_ms: u64) -> Option<String> {
    let sub = |s: &str| s.replace("{wt}", wt).replace("{branch}", branch);
    let (prog, args) = argv.split_first()?;
    let mut cmd = Command::new(sub(prog));
    cmd.args(args.iter().map(|a| sub(a))).current_dir(wt);
    let o = crate::proc::run(cmd, prog, Duration::from_millis(timeout_ms), Duration::from_millis(defaults::num("client.fallback_poll_ms"))).ok()?;
    o.status.success().then(|| String::from_utf8_lossy(&o.stdout).to_string())
}

fn git_cfg() -> (Vec<&'static str>, Vec<&'static str>, &'static str, u64) {
    let g = defaults::raw("sweep.git");
    (g.get("log").map(defaults::V::strings).unwrap_or_default(), g.get("branch").map(defaults::V::strings).unwrap_or_default(), g.str_field("log_sep"), g.get("timeout_ms").and_then(defaults::V::as_integer).unwrap_or(0) as u64)
}

/// `(epoch ms, subject)` of the newest commits in the worktree, or `None` when git could not be read.
fn commits(wt: &str) -> Option<Vec<(i64, String)>> {
    let (log, _, sep, to) = git_cfg();
    let out = run_argv(&log, wt, "", to)?;
    Some(out.lines().filter_map(|l| l.split_once(sep)).filter_map(|(ct, s)| Some((ct.trim().parse::<i64>().ok()? * 1000, s.to_string()))).collect())
}

/// `(running, lines)` of the CI runs of the worktree's branch, or `None` when CI is off or could not be read.
fn ci(wt: &str, now: i64) -> Option<(bool, Vec<String>)> {
    let c = defaults::raw("sweep.ci");
    if c.get("enabled").and_then(defaults::V::as_bool) != Some(true) {
        return None;
    }
    let (_, branch_argv, _, git_to) = git_cfg();
    let branch = run_argv(&branch_argv, wt, "", git_to)?.trim().to_string();
    let argv = c.get("argv").map(defaults::V::strings)?;
    let out = run_argv(&argv, wt, &branch, c.get("timeout_ms").and_then(defaults::V::as_integer)? as u64)?;
    let runs: Vec<Value> = serde_json::from_str(&out).ok()?;
    let running = c.get("running_statuses").map(defaults::V::strings).unwrap_or_default();
    let is_running = |r: &Value| r["status"].as_str().is_some_and(|s| running.contains(&s));
    let shown = c.get("recent_runs").and_then(defaults::V::as_integer).unwrap_or(0) as usize;
    let lines = runs
        .iter()
        .take(shown)
        .map(|r| {
            let at = r["updatedAt"].as_str().and_then(crate::transcript::record::parse_ts_ms).unwrap_or(now);
            let status = if is_running(r) { r["status"].as_str().unwrap_or("") } else { r["conclusion"].as_str().or(r["status"].as_str()).unwrap_or("") };
            fill(word("line_ci"), &[("name", r["name"].as_str().unwrap_or("")), ("status", status), ("ago", &ago(now, at))])
        })
        .collect();
    Some((runs.iter().any(is_running), lines))
}

struct MeshFacts {
    unanswered: bool,
    newer: bool,
    lines: Vec<String>,
}

/// The mesh facts of a child, or `None` when its store cannot be read (then there is no mesh coverage).
fn mesh(base: &Path, desc: &Value, id: &str, now: i64) -> Option<MeshFacts> {
    let store = base.join(path_cfg("store"));
    let repo = desc["repoKey"].as_str().or(desc["ownerKey"].as_str()).filter(|k| !k.is_empty());
    let db = repo.map_or_else(|| store.join(path_cfg("store_file")), |k| store.join(k).join(path_cfg("store_file")));
    let r = MeshReader::open(&db).ok()?;
    let sent = r.sent_by(id, lim("mesh_sent") as u64).ok()?;
    let inbound = r.last_messages(id, 1).ok()?;
    let (last_out, last_in) = (sent.last(), inbound.last());
    let last_q = sent.iter().rev().find(|m| m["needsReply"] == Value::Bool(true));
    let in_ts = last_in.and_then(|m| num(m, "ts")).unwrap_or(0);
    let mut lines = Vec::new();
    for (m, dir) in [(last_in, "dir_in"), (last_out, "dir_out")].into_iter().filter_map(|(m, d)| Some((m?, d))) {
        let ask = if m["needsReply"] == Value::Bool(true) { word("ask") } else { "" };
        lines.push(fill(
            word("line_msg"),
            &[("ago", &ago(now, num(m, "ts").unwrap_or(now))), ("dir", word(dir)), ("ask", ask), ("text", &cap(m["body"].as_str().unwrap_or(""), lim("msg_cap")))],
        ));
    }
    Some(MeshFacts {
        unanswered: last_q.is_some_and(|q| num(q, "ts").unwrap_or(0) >= in_ts),
        newer: last_out.is_some_and(|m| num(m, "ts").unwrap_or(0) > in_ts),
        lines,
    })
}

fn fill(template: &str, args: &[(&str, &str)]) -> String {
    args.iter().fold(template.to_string(), |t, (k, v)| t.replace(&format!("{{{k}}}"), v))
}

// ---- one child ----------------------------------------------------------------------------------------

/// Everything the sweep knows about one child, gathered once and only as far as a question needs it.
struct Child {
    id: String,
    key: String,
    plan: Value,
    desc: Value,
    now: i64,
    base: PathBuf,
    home: PathBuf,
    events: Option<Vec<Ev>>,
    held: Vec<String>,
}

impl Child {
    fn wt(&self) -> String {
        self.desc["worktreePath"].as_str().or(self.plan["worktreePath"].as_str()).unwrap_or("").to_string()
    }

    fn events(&mut self) -> &[Ev] {
        if self.events.is_none() {
            let ev = match (self.desc["sessionId"].as_str(), self.wt()) {
                (Some(sid), wt) if !wt.is_empty() && sid.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') => {
                    let file = self.home.join(path_cfg("transcripts")).join(project_dir_name(&wt)).join(format!("{sid}{}", path_cfg("transcript_ext")));
                    read_events(&file)
                }
                _ => Vec::new(),
            };
            self.events = Some(ev);
        }
        self.events.as_deref().unwrap_or(&[])
    }

    fn archived(&self) -> bool {
        let rec = self.base.join(path_cfg("archived")).join(format!("{}{}", self.id, path_cfg("plan_ext")));
        let Ok(t) = std::fs::read_to_string(rec) else { return false };
        let wt = self.wt();
        serde_json::from_str::<Value>(&t).ok().is_some_and(|r| wt.is_empty() || r["worktreePath"].as_str().is_none_or(|w| w == wt))
    }

    fn on_hold(&self) -> bool {
        self.held.contains(&self.id)
    }
}

fn tool_lines(ev: &[Ev], now: i64, n: usize) -> Vec<String> {
    let tools: Vec<&Ev> = ev.iter().filter(|e| e.kind == Kind::Tool).collect();
    tools[tools.len().saturating_sub(n)..]
        .iter()
        .map(|e| fill(word("line_tool"), &[("ago", &ago(now, e.t)), ("name", &e.name), ("arg", &cap(&e.text, lim("arg_cap")))]))
        .collect()
}

fn facts_map(pairs: Vec<(&str, f64)>) -> Value {
    Value::Object(pairs.into_iter().map(|(k, v)| (k.to_string(), json!(v))).collect::<Map<String, Value>>())
}

fn wait_kind(c: &mut Child) -> Value {
    let (now, lookback) = (c.now, lim("lookback_min") * unit("ms_per_minute"));
    let (done, archived, hold) = (c.plan["done_reported_at"].as_f64().is_some(), c.archived(), c.on_hold());
    let quiet = now - last_progress(&c.plan, now);
    let (id, wt) = (c.id.clone(), c.wt());
    let mesh = mesh(&c.base, &c.desc, &id, now);
    let ci = if wt.is_empty() { None } else { ci(&wt, now) };
    let ev = c.events();
    let recent = |e: &&Ev| e.t >= now - lookback;
    let limit_pats = tr_list("usage_limit_patterns");
    let usage = ev.iter().filter(recent).any(|e| matches!(e.kind, Kind::Text | Kind::Err) && contains_ci(&e.text, &limit_pats));
    let texts: Vec<&Ev> = ev.iter().filter(|e| e.kind == Kind::Text).collect();
    let texts = &texts[texts.len().saturating_sub(lim("text_tail") as usize)..];
    let tool_lines = tool_lines(ev, now, lim("tool_tail") as usize);
    let errors: Vec<String> = ev.iter().filter(recent).filter(|e| e.kind == Kind::Err).map(|e| cap(&e.text, lim("err_cap"))).collect();
    let mut f = vec![
        ("done_reported", f64::from(u8::from(done))),
        ("archived", f64::from(u8::from(archived))),
        ("on_hold", f64::from(u8::from(hold))),
        ("usage_limit_pause", f64::from(u8::from(usage))),
        ("tool_calls", tool_lines.len() as f64),
        ("assistant_texts", texts.len() as f64),
    ];
    let mut sections = Map::new();
    sections.insert("tool_calls".into(), json!(tool_lines));
    sections.insert("assistant_texts".into(), json!(texts.iter().map(|e| fill(word("line_text"), &[("ago", &ago(now, e.t)), ("text", &cap(&e.text, lim("text_cap")))])).collect::<Vec<_>>()));
    sections.insert("errors".into(), json!(errors.iter().map(|t| fill(word("line_error"), &[("text", t)])).collect::<Vec<_>>()));
    if let Some(m) = &mesh {
        f.extend([("mesh_coverage", 1.0), ("unanswered_q_to_parent", f64::from(u8::from(m.unanswered))), ("last_report_newer", f64::from(u8::from(m.newer)))]);
        sections.insert("mesh".into(), json!(m.lines));
    }
    if let Some((running, lines)) = ci {
        f.push(("ci_running", f64::from(u8::from(running))));
        sections.insert("ci".into(), json!(lines));
    }
    json!({"id": "devswarmWaitKind", "child": c.key, "dur": dur(quiet), "facts": facts_map(f), "sections": sections})
}

fn looping(c: &mut Child) -> Value {
    let now = c.now;
    let cur = current_step(&c.plan).cloned().unwrap_or(Value::Null);
    let start = num(&cur, "started_at").or_else(|| num(&c.plan, "created_at")).unwrap_or(now);
    let since = now - start;
    let progress_min = (now - last_progress(&c.plan, now)) / unit("ms_per_minute");
    let window = start.max(now - lim("lookback_min") * unit("ms_per_minute"));
    let wt = c.wt();
    let git = if wt.is_empty() { None } else { commits(&wt) };
    let sums: Vec<String> = summaries(&c.plan)
        .iter()
        .filter(|s| num(s, "ts").unwrap_or(0) >= start)
        .map(|s| fill(word("line_summary"), &[("ago", &ago(now, num(s, "ts").unwrap_or(now))), ("text", &cap(s["text"].as_str().unwrap_or(""), lim("text_cap")))]))
        .collect();
    let ev = c.events();
    let on_step: Vec<&Ev> = ev.iter().filter(|e| e.kind == Kind::Tool && e.t >= start).collect();
    let mut counts: BTreeMap<String, i64> = BTreeMap::new();
    for e in on_step.iter().filter(|e| e.t >= window && !e.text.is_empty()) {
        *counts.entry(cap(&e.text, lim("arg_cap")).to_lowercase()).or_default() += 1;
    }
    let mut rep: Vec<(String, i64)> = counts.into_iter().filter(|(_, n)| *n >= lim("repeat_min")).collect();
    rep.sort_by_key(|(_, n)| std::cmp::Reverse(*n));
    let mut edits: BTreeMap<&str, i64> = BTreeMap::new();
    for e in on_step.iter().filter(|e| !e.file.is_empty()) {
        *edits.entry(e.file.as_str()).or_default() += 1;
    }
    let revert_pats = tr_list("revert_patterns");
    let reverts = on_step.iter().filter(|e| e.name == "Bash" && contains_ci(&e.text, &revert_pats)).count();
    let mut repeats: Vec<String> = rep.iter().take(lim("repeat_show") as usize).map(|(cmd, n)| fill(word("line_repeat"), &[("cmd", cmd), ("n", &n.to_string())])).collect();
    repeats.extend(edits.iter().filter(|(_, n)| **n >= lim("edit_repeat_min")).map(|(f, n)| fill(word("line_repeat"), &[("cmd", f), ("n", &n.to_string())])));
    let on_step_commits: Vec<&(i64, String)> = git.iter().flatten().filter(|(t, _)| *t >= start).collect();
    let git_lines: Vec<String> = on_step_commits.iter().map(|(t, s)| fill(word("line_commit"), &[("ago", &ago(now, *t)), ("subject", &cap(s, lim("text_cap")))])).collect();
    let mut f = vec![
        ("tool_calls", on_step.len() as f64),
        ("repeat_cmd_max", rep.first().map_or(0, |(_, n)| *n) as f64),
        ("reverts", reverts as f64),
        ("minutes_since_progress", progress_min as f64),
    ];
    if git.is_some() {
        f.extend([("git_known", 1.0), ("commits_on_step", on_step_commits.len() as f64)]);
    }
    let tools = tool_lines(c.events(), now, lim("tool_tail") as usize);
    let mut sections = Map::new();
    sections.insert("tool_calls".into(), json!(tools));
    sections.insert("repeats".into(), json!(repeats));
    sections.insert("git".into(), json!(git_lines));
    sections.insert("heartbeats".into(), json!(sums));
    json!({"id": "devswarmLoop", "child": c.key, "dur": dur(since), "facts": facts_map(f), "sections": sections})
}

fn step_map(c: &Child) -> Value {
    let steps: Vec<Value> = c.plan["steps"].as_array().into_iter().flatten().map(|s| json!({"n": s["n"], "text": s["text"], "status": s["status"]})).collect();
    let sums = summaries(&c.plan);
    let (last, before) = sums.split_last().map_or((None, &[][..]), |(l, b)| (Some(*l), b));
    let tol = lim("step_match_ms");
    // a summary sent with a step belongs to the step that was reported at that moment: the one whose own timestamp is next to it
    let reported = |s: &Value| -> Option<i64> {
        if s["stepped"] != Value::Bool(true) {
            return None;
        }
        let at = num(s, "ts")?;
        c.plan["steps"].as_array()?.iter().filter_map(|st| Some(((num(st, "ts")? - at).abs(), num(st, "n")?))).filter(|(d, _)| *d <= tol).min().map(|(_, n)| n)
    };
    let earlier: Vec<Value> = before.iter().map(|s| json!({"text": s["text"], "step": reported(s)})).collect();
    json!({"id": "devswarmStepMap", "child": c.key, "plan": {"steps": steps, "summary": last.map_or("", |s| s["text"].as_str().unwrap_or("")), "earlier": earlier}})
}

// ---- the sweep ---------------------------------------------------------------------------------------

/// Whether the integration has something to ask about this child now, and the key of that subject (a repeat of the same subject is not
/// asked again within `reask_ms`).
fn trigger(id: &str, plan: &Value, now: i64, stall: i64) -> Option<String> {
    let cur = current_step(plan)?;
    let n = cur["n"].as_i64().unwrap_or(0);
    let progress = last_progress(plan, now);
    let sums = summaries(plan);
    match id {
        "devswarmWaitKind" => (now - progress >= stall).then(|| format!("{n}|{progress}|{}", sums.last().and_then(|s| num(s, "ts")).unwrap_or(0))),
        "devswarmLoop" => {
            let start = num(cur, "started_at").or_else(|| num(plan, "created_at")).unwrap_or(now);
            (!plan["done_reported_at"].is_number() && now - start > lim("loop_factor") * stall).then(|| format!("{n}|{start}|{progress}"))
        }
        "devswarmStepMap" => {
            let last = sums.last()?;
            let steps = plan["steps"].as_array().map_or(0, Vec::len) as i64;
            (last["stepped"] == Value::Bool(false) && steps <= lim("max_steps_map")).then(|| format!("{}", num(last, "ts").unwrap_or(0)))
        }
        _ => None,
    }
}

fn load_state(path: &Path) -> Map<String, Value> {
    std::fs::read_to_string(path).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| v.as_object().cloned()).unwrap_or_default()
}

/// One sweep at time `now`: returns `{children, decided: [{child, integration, phase, source, label, reason}]}`.
pub fn sweep(home: &Path, env: &Env, now: i64) -> Value {
    let ids: Vec<&str> = defaults::list("sweep.integrations");
    let live: Vec<&str> = ids.iter().copied().filter(|id| super::shared::mode_of(home, env, id) != Mode::Off).collect();
    if live.is_empty() {
        return json!({"children": 0, "decided": [], "idle": true});
    }
    let base = home.join(defaults::text("paths.base_dir"));
    let var = |k: &str| env.get_nonempty(defaults::raw("sweep.env").str_field(k));
    let held: Vec<String> = var("held_partitions").map(|v| v.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect()).unwrap_or_default();
    let stall = var("step_stall_min").and_then(|v| v.trim().parse::<f64>().ok()).filter(|m| *m >= 1.0).map_or(lim("step_stall_ms"), |m| (m * unit("ms_per_minute") as f64) as i64);
    let state_path = base.join(path_cfg("state"));
    let mut state = load_state(&state_path);
    let mut files: Vec<PathBuf> = std::fs::read_dir(base.join(path_cfg("plans"))).map(|d| d.flatten().map(|e| e.path()).collect()).unwrap_or_default();
    files.retain(|p| p.to_string_lossy().ends_with(path_cfg("plan_ext")));
    files.sort();
    let (mut looked, mut decided) = (0, Vec::new());
    for file in files {
        let Some(plan) = std::fs::read_to_string(&file).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) else { continue };
        let key = file.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
        let id = plan["id"].as_str().unwrap_or(&key).to_string();
        if key.is_empty() || plan["steps"].as_array().is_none_or(Vec::is_empty) || looked >= lim("max_children") {
            continue;
        }
        let due: Vec<(&str, String)> = live.iter().filter_map(|i| trigger(i, &plan, now, stall).map(|k| (*i, k))).filter(|(i, k)| {
            let seen = state.get(&format!("{key}|{i}")).unwrap_or(&Value::Null);
            !(seen["subject"] == k.as_str() && now - num(seen, "at").unwrap_or(0) < lim("reask_ms"))
        }).collect();
        if due.is_empty() {
            continue;
        }
        looked += 1;
        let desc = std::fs::read_to_string(base.join(path_cfg("workspaces")).join(format!("{id}{}", path_cfg("plan_ext")))).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
        let mut child = Child { id, key: key.clone(), plan, desc, now, base: base.clone(), home: home.to_path_buf(), events: None, held: held.clone() };
        for (integ, subject) in due {
            let req = match integ {
                "devswarmWaitKind" => wait_kind(&mut child),
                "devswarmLoop" => looping(&mut child),
                _ => step_map(&child),
            };
            let o = evidence::evaluate(home, env, &req);
            state.insert(format!("{key}|{integ}"), json!({"subject": subject, "at": now}));
            decided.push(json!({"child": key, "integration": integ, "phase": o.phase, "source": o.source, "label": o.label, "reason": o.reason, "rule": o.rule, "actionable": o.actionable}));
        }
    }
    if looked > 0 {
        crate::discard::logged("jev_sweep_state", crate::atomic::write(&state_path, Value::Object(state).to_string()));
    }
    json!({"children": looked, "decided": decided})
}

/// `ah-engine jev sweep` and the scheduled job: sweep once, print the result as one JSON line.
pub fn run(home: &Path) -> i32 {
    let now = crate::checks::replykit::io::now_ms() as i64;
    println!("{}", sweep(home, &Env::process(), now));
    0
}

#[cfg(test)]
mod tests;
