//! What one agent did, read from its transcript since the last tick: tokens, tool calls, progress, loops, the declared step, wake paths.
//!
//! The transcript is read incrementally from a byte offset kept in the agent's state, so the cost of a tick follows what happened, not
//! the size of the file. Only complete lines are consumed; a half-written last line waits for the next tick.
use super::{Agent, Pending, cap, fmtn, lim, pth, tools, tr, weight};
use crate::checks::agent_scan;
use crate::defaults::{self, V};
use regex::Regex;
use serde_json::Value;
use std::io::{Read, Seek, SeekFrom};

fn pat(k: &str) -> Option<Regex> {
    static C: crate::defaults::Cache<Vec<(String, Option<Regex>)>> = crate::defaults::Cache::new();
    let all = C.get_or_init(|| {
        defaults::raw("agent_tracker.patterns")
            .as_table()
            .map(|t| {
                t.iter().map(|(k, v)| ((*k).to_string(), v.as_str().and_then(|s| regex::RegexBuilder::new(s).case_insensitive(true).build().ok()))).collect()
            })
            .unwrap_or_default()
    });
    all.iter().find(|(n, _)| n == k).and_then(|(_, r)| r.clone())
}

fn str_of<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

/// The words of a path or command: lower case, split on the configured characters, short and stop words dropped.
pub(crate) fn words(s: &str) -> Vec<String> {
    let split: Vec<char> = defaults::raw("agent_tracker.words").str_field("split").chars().collect();
    let stop = defaults::raw("agent_tracker.words").get("stop").map(V::strings).unwrap_or_default();
    let min = lim("drift_min_word_len") as usize;
    s.to_lowercase().split(|c| split.contains(&c)).filter(|w| w.chars().count() >= min && !stop.contains(w)).map(str::to_string).collect()
}

fn result_text(c: &Value) -> String {
    match c {
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().filter_map(|b| b.get(tr("text")).and_then(Value::as_str)).collect::<Vec<_>>().join(" "),
        _ => String::new(),
    }
}

fn push_ring<T>(v: &mut Vec<T>, x: T, max: u64) {
    v.push(x);
    let max = max as usize;
    if v.len() > max {
        v.drain(..v.len() - max);
    }
}

/// Read what is new in `a`'s transcript.
pub(crate) fn ingest(a: &mut Agent, now: u64) {
    a.transcript_complete = false;
    if a.path.is_empty() {
        return;
    }
    let Ok(mut f) = std::fs::File::open(&a.path) else { return };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    if a.offset > len {
        // the file was replaced: start over, keeping nothing of the old totals
        *a = Agent {
            id: a.id.clone(),
            kind: a.kind.clone(),
            parent: a.parent.clone(),
            name: a.name.clone(),
            path: a.path.clone(),
            source: a.source.clone(),
            first_seen: a.first_seen,
            seen: a.seen,
            ..Agent::default()
        };
    }
    if a.offset == 0 {
        a.transcript_from_start = true;
    }
    let mut start = a.offset;
    let mut skip_first = false;
    if start == 0 && len > lim("first_read_bytes") {
        start = len - lim("first_read_bytes");
        a.partial = true;
        skip_first = true;
    }
    if len - start > lim("read_max_bytes") {
        a.partial = true;
        start = len - lim("read_max_bytes");
        skip_first = true;
    }
    if f.seek(SeekFrom::Start(start)).is_err() {
        return;
    }
    let mut buf = Vec::new();
    if f.take(len - start).read_to_end(&mut buf).is_err() {
        return;
    }
    let end = buf.iter().rposition(|b| *b == b'\n').map_or(0, |i| i + 1);
    a.offset = start + end as u64;
    let text = match std::str::from_utf8(&buf[..end]) {
        Ok(text) => text,
        Err(_) => {
            a.partial = true;
            return;
        }
    };
    let mut lines = text.lines();
    if skip_first {
        lines.next();
    }
    for l in lines {
        match serde_json::from_str::<Value>(l) {
            Ok(v) => line(a, &v, now),
            Err(_) => a.partial = true,
        }
    }
    a.transcript_complete = a.transcript_from_start && !a.partial && a.offset == len && std::fs::metadata(&a.path).is_ok_and(|m| m.len() == len);
}

fn line(a: &mut Agent, v: &Value, now: u64) {
    let nw = defaults::raw("agent_tracker.no_work");
    if nw.get("agent_type_fields").map(V::strings).unwrap_or_default().iter().any(|k| str_of(v, k) == nw.str_field("rescue_type")) {
        a.codex_rescue = true;
    }
    let ty = str_of(v, tr("type_key"));
    if a.cwd.is_empty() {
        a.cwd = str_of(v, tr("cwd")).to_string();
    }
    let ts = agent_scan::date_parse(str_of(v, tr("ts"))).ok().filter(|t| t.is_finite()).map_or(now, |t| t as u64);
    let msg = v.get(tr("message"));
    let blocks: &[Value] = msg.and_then(|m| m.get(tr("content"))).and_then(Value::as_array).map_or(&[], Vec::as_slice);
    if ty == tr("assistant") {
        a.last_output_ms = a.last_output_ms.max(ts);
        a.running = true;
        if let Some(m) = msg {
            usage(a, m);
            if str_of(m, tr("stop_reason")) == tr("end_turn") {
                a.running = false;
            }
        }
        // Rescue wrappers can return a background Codex task id without making local tool calls.
        let returned = msg.and_then(|m| m.get(tr("content"))).map(result_text).unwrap_or_default();
        if pat("codex_job").is_some_and(|r| r.is_match(&returned)) {
            a.codex_rescue = true;
        }
        for b in blocks {
            if a.watch {
                turn(a, b, ts);
            }
            if str_of(b, tr("type_key")) == tr("tool_use") {
                a.running = true;
                tool_use(a, b, ts, str_of(v, tr("cwd")));
            }
        }
    } else if ty == tr("user") {
        a.last_output_ms = a.last_output_ms.max(ts);
        a.running = true;
        let content = msg.and_then(|m| m.get(tr("content")));
        if !super::is_child(a) && a.kind != super::kind_name("codex") && owner_turn(v, content) {
            a.owner_ms = a.owner_ms.max(ts);
        }
        task_results(a, content);
        if !a.bg_ids.is_empty() {
            task_ends(a, content, ts);
        }
        for b in blocks {
            if str_of(b, tr("type_key")) == tr("tool_result") {
                let text = result_text(b.get(tr("content_key")).unwrap_or(&Value::Null));
                let rescue = a.rescue_calls.remove(str_of(b, tr("tool_use_id"))) || pat("codex_job").is_some_and(|r| r.is_match(&text));
                if rescue {
                    let id = v
                        .get(nw.str_field("result_field"))
                        .and_then(|r| r.get(nw.str_field("result_agent_field")))
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .or_else(|| {
                            Regex::new(defaults::text("agent_scan.re_agent_id"))
                                .ok()
                                .and_then(|r| r.captures(&text).and_then(|c| c.get(1).map(|m| m.as_str().to_string())))
                        });
                    if let Some(id) = id.filter(|id| !id.is_empty()) {
                        a.rescue_children.insert(id);
                    }
                }
                tool_result(a, b, ts);
            }
        }
    }
}

/// Keep one assistant block of a watched agent (a parent with an open nudge) for the nudge's turn matching: a reply's text, or a tool
/// call as `<tool>\t<value>\t...` with the configured input fields (`agent_nudge.match`). A Bash command is kept only when it holds
/// one of the verbs that stop or message an agent.
pub(crate) fn turn(a: &mut Agent, b: &Value, ts: u64) {
    let m = defaults::raw("agent_nudge.match");
    let kind = |k: &str| defaults::text(k);
    let max = lim_n("turns_max");
    if str_of(b, tr("type_key")) == tr("text") {
        let t = str_of(b, tr("text"));
        if !t.is_empty() {
            push_ring(&mut a.turns, (ts, kind("agent_nudge.match_text_kind").to_string(), cap(t, lim_n("turn_text_cap"))), max);
        }
        return;
    }
    if str_of(b, tr("type_key")) != tr("tool_use") {
        return;
    }
    let name = str_of(b, tr("name"));
    let listed = |k: &str| m.get(k).map(V::strings).unwrap_or_default().contains(&name);
    if !(listed("stop_tools") || listed("msg_tools") || listed("spawn_tools") || listed("shell_tools")) {
        return;
    }
    let input = b.get(tr("input")).unwrap_or(&Value::Null);
    let shell = listed("shell_tools");
    let fields = m.get("fields").map(V::strings).unwrap_or_default();
    let mut text = name.to_string();
    for f in fields.iter().filter(|f| (**f == tr("command")) == shell) {
        let v = str_of(input, f);
        if !v.is_empty() {
            text.push('\t');
            text.push_str(&cap(v, lim_n("turn_text_cap")));
        }
    }
    if shell {
        let verbs = [kind("agent_nudge.match_stop_cmd"), kind("agent_nudge.match_send_cmd")];
        if !verbs.iter().any(|v| text.contains(v)) {
            return;
        }
    }
    push_ring(&mut a.turns, (ts, kind("agent_nudge.match_tool_kind").to_string(), text), max);
}

/// Keep the turns of `a` after `since` from the part of its transcript already consumed (the `replay_bytes` before `a.offset`), so a
/// parent that starts being watched late loses nothing it said after the delivery. Lines past `a.offset` are left to `ingest`.
pub(crate) fn replay_turns(a: &mut Agent, since: u64) {
    let (end, max) = (a.offset, lim_n("replay_bytes"));
    if a.path.is_empty() || end == 0 {
        return;
    }
    let start = end.saturating_sub(max);
    let Ok(mut f) = std::fs::File::open(&a.path) else { return };
    if f.seek(SeekFrom::Start(start)).is_err() {
        return;
    }
    let mut buf = Vec::new();
    if f.take(end - start).read_to_end(&mut buf).is_err() {
        return;
    }
    let text = String::from_utf8_lossy(&buf);
    let mut lines = text.lines();
    if start > 0 {
        lines.next(); // it may start mid-line
    }
    for l in lines {
        let Ok(v) = serde_json::from_str::<Value>(l) else { continue };
        let Some(ts) = agent_scan::date_parse(str_of(&v, tr("ts"))).ok().filter(|t| t.is_finite()).map(|t| t as u64).filter(|t| *t > since) else { continue };
        if str_of(&v, tr("type_key")) != tr("assistant") {
            continue;
        }
        let blocks: &[Value] = v.get(tr("message")).and_then(|m| m.get(tr("content"))).and_then(Value::as_array).map_or(&[], Vec::as_slice);
        for b in blocks {
            turn(a, b, ts);
        }
    }
}

/// A cap of the nudge loop (`agent_nudge.limits`).
pub(crate) fn lim_n(k: &str) -> u64 {
    defaults::raw("agent_nudge.limits").get(k).and_then(V::as_integer).unwrap_or(0).max(0) as u64
}

/// Whether a user line is the owner talking to this session: not a meta line, not a tool result, and either an origin kind the owner's
/// messages carry (`agent_tracker.owner_origins`) or, with no origin recorded, text that does not start like a notice
/// (`patterns.owner_skip`).
fn owner_turn(v: &Value, content: Option<&Value>) -> bool {
    let flag = |k: &str| v.get(tr(k)).and_then(Value::as_bool) == Some(true);
    if flag("meta") || flag("sidechain") || v.get(tr("tool_result_top")).is_some() {
        return false;
    }
    let text = match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(bs)) if !bs.is_empty() && !bs.iter().any(|b| str_of(b, tr("type_key")) == tr("tool_result")) => {
            bs.iter().map(|b| str_of(b, tr("text"))).collect::<Vec<_>>().join(" ")
        }
        _ => return false,
    };
    match v.get(tr("origin")).and_then(|o| o.get(tr("origin_kind"))).and_then(Value::as_str) {
        Some(kind) => defaults::raw("agent_tracker.owner_origins").strings().contains(&kind),
        None => !text.trim().is_empty() && !pat("owner_skip").is_some_and(|r| r.is_match(&text)) || matches!(content, Some(Value::Array(_))),
    }
}

/// Completed task notices in a user line for tasks that are not background shell commands the agent started: a subagent returned its
/// result to this agent. Counted once per task id, as the `agent_result` weight.
fn task_results(a: &mut Agent, content: Option<&Value>) {
    let text = match content {
        Some(Value::String(s)) => s.clone(),
        Some(c) => result_text(c),
        None => return,
    };
    let (block, id_re, st_re) = (
        crate::checks::lit_re(defaults::text("agent_scan.re_notification_block")),
        crate::checks::lit_re(defaults::text("agent_scan.re_task_id")),
        crate::checks::lit_re(defaults::text("agent_scan.re_status")),
    );
    let ok = defaults::raw("agent_tracker.result_statuses").strings();
    for b in block.captures_iter(&text) {
        let body = b.get(1).map_or("", |m| m.as_str());
        let id = id_re.captures(body).and_then(|c| c.get(1)).map_or("", |m| m.as_str());
        let st = st_re.captures(body).and_then(|c| c.get(1)).map_or("", |m| m.as_str());
        if id.is_empty() || a.bg_ids.contains_key(id) || a.report_ids.iter().any(|r| r == id) || !ok.iter().any(|w| w.eq_ignore_ascii_case(st)) {
            continue;
        }
        push_ring(&mut a.report_ids, id.to_string(), lim("files_max"));
        a.reports += 1;
        a.progress += weight("agent_result");
    }
}

/// Terminal task notices in a user line that name a background shell task the agent started: the task ended.
fn task_ends(a: &mut Agent, content: Option<&Value>, ts: u64) {
    let text = match content {
        Some(Value::String(s)) => s.clone(),
        Some(c) => result_text(c),
        None => return,
    };
    let (block, id_re, st_re) = (
        crate::checks::lit_re(defaults::text("agent_scan.re_notification_block")),
        crate::checks::lit_re(defaults::text("agent_scan.re_task_id")),
        crate::checks::lit_re(defaults::text("agent_scan.re_status")),
    );
    let terminal = defaults::words("transcript.terminal_statuses");
    for b in block.captures_iter(&text) {
        let body = b.get(1).map_or("", |m| m.as_str());
        let id = id_re.captures(body).and_then(|c| c.get(1)).map_or("", |m| m.as_str());
        let st = st_re.captures(body).and_then(|c| c.get(1)).map_or("", |m| m.as_str());
        if a.bg_ids.contains_key(id) && terminal.iter().any(|w| w.eq_ignore_ascii_case(st)) {
            a.bg_ids.remove(id);
            a.exited.push((id.to_string(), ts));
            // PR #472: a background check or shell write earns its HARD outcome only now, when it ended with success
            let call = a.bg_starts.remove(id);
            if let Some((check, writes)) = a.bg_outcomes.remove(id)
                && let Some((start, dir)) = call
                && defaults::raw("agent_tracker.bg_success_statuses").strings().iter().any(|w| w.eq_ignore_ascii_case(st))
            {
                hard_outcome(a, check, &writes, start, &dir);
            }
        }
    }
    let keep = lim("loop_window") as usize;
    if a.exited.len() > keep {
        a.exited.drain(..a.exited.len() - keep);
    }
}

fn usage(a: &mut Agent, m: &Value) {
    let id = str_of(m, tr("id"));
    if !id.is_empty() {
        if a.ids.iter().any(|x| x == id) {
            return;
        }
        push_ring(&mut a.ids, id.to_string(), lim("loop_window"));
    }
    let Some(u) = m.get(tr("usage")) else { return };
    let n = |k: &str| u.get(tr(k)).and_then(Value::as_u64).unwrap_or(0);
    a.tin += n("in_tok");
    a.tout += n("out_tok");
    a.tcr += n("cr_tok");
    a.tcw += n("cw_tok");
}

fn tool_use(a: &mut Agent, b: &Value, ts: u64, cwd: &str) {
    let name = str_of(b, tr("name"));
    let input = b.get(tr("input")).cloned().unwrap_or(Value::Null);
    let id = str_of(b, "id").to_string();
    let nw = defaults::raw("agent_tracker.no_work");
    if nw.get("agent_type_fields").map(V::strings).unwrap_or_default().iter().any(|k| str_of(&input, k) == nw.str_field("rescue_type")) {
        a.rescue_calls.insert(id.clone());
    }
    a.tools += 1;
    let arg = [tr("command"), tr("file_path"), tr("pattern"), tr("path")].iter().map(|k| str_of(&input, k)).find(|s| !s.is_empty()).unwrap_or("");
    let label = if tools("task_create").contains(&name) { cap(str_of(&input, tr("subject")), lim("text_cap")) } else { cap(arg, lim("text_cap")) };
    let is_edit = tools("edit").contains(&name);
    push_ring(&mut a.recent, (format!("{name}:{:x}", crate::health::fnv(&input.to_string())), format!("{name} {label}"), is_edit, ts), lim("loop_window"));
    let mut class = String::new();
    let mut writes = Vec::new();
    let mut push = false;
    let mut amp = false;
    let mut call_dir = if cwd.is_empty() { a.cwd.clone() } else { cwd.to_string() };
    if is_edit {
        a.edits += 1;
        let path = str_of(&input, tr("file_path"));
        if !path.is_empty() && !a.files.iter().any(|f| f == path) {
            a.progress += if pat("report_path").is_some_and(|r| r.is_match(path)) { weight("report_file").max(weight("file")) } else { weight("file") };
            push_ring(&mut a.files, path.to_string(), lim("files_max"));
        }
        a.step_events += 1;
        for w in words(path) {
            push_ring(&mut a.work, w, lim("work_words_max"));
        }
    } else if tools("read").contains(&name) {
        // reading is work on the step too: its targets are the words the drift check compares with the step
        a.step_events += 1;
        for w in words(arg) {
            push_ring(&mut a.work, w, lim("work_words_max"));
        }
    } else if tools("shell").contains(&name) {
        a.step_events += 1;
        for w in words(arg) {
            push_ring(&mut a.work, w, lim("work_words_max"));
        }
        // PR #472: the command is read by the engine shell splitter (host_shell::split_detailed, the scanner the `command` check and the
        // burn breaker's commit exemption use): its top-level segments hold no comment and no heredoc body, and its delimiters say
        // which segment runs in the background (agent_tracker.bg_delims). The class, the push and the written files come from them.
        let (segs, delims) = crate::script::host_shell::split_detailed(arg);
        let bgd = defaults::raw("agent_tracker.bg_delims").strings();
        amp = delims.iter().any(|d| bgd.iter().any(|b| b == d));
        let code = segs.join("\n");
        let arg = code.as_str();
        // PR #472 round 4: commit, push, check and probe are matched per top-level segment with its quoted strings blanked, anchored at
        // the program the segment runs: quoted argument text (`rg 'git commit' src`, `echo "git push"`) is never the command.
        let unq: Vec<String> = segs.iter().map(|s| unquoted(s)).collect();
        let seg_hit = |k: &str| pat(k).is_some_and(|r| unq.iter().any(|s| r.is_match(s)));
        push = seg_hit("push");
        if seg_hit("commit") {
            class = "commit".into();
        } else if pat("merge").is_some_and(|r| r.is_match(arg)) {
            class = "merge".into();
        } else if pat("deploy").is_some_and(|r| r.is_match(arg)) {
            class = "deploy".into();
        } else if pat("test").is_some_and(|r| r.is_match(arg)) {
            class = "test".into();
        } else if pat("build").is_some_and(|r| r.is_match(arg)) {
            class = "build".into();
        } else if seg_hit("check") {
            class = "check".into();
        } else if seg_hit("probe") {
            class = "probe".into();
        }
        // the directory each segment runs in: a `cd`/`pushd` to one literal directory, chained by a delimiter that runs the next segment
        // only after it (agent_tracker.cd_follow), is followed; any other directory change makes the later relative writes unresolvable
        // (at most SOFT). Each write is resolved here to an absolute path; one left relative names no file (PR #472 round 4).
        let cf = defaults::raw("agent_tracker.cd_follow");
        let (cds, lost, dls) = (
            cf.get("commands").map(V::strings).unwrap_or_default(),
            cf.get("unfollowed").map(V::strings).unwrap_or_default(),
            cf.get("delims").map(V::strings).unwrap_or_default(),
        );
        let deny = cf.str_field("non_literal");
        let base = if cwd.is_empty() { a.cwd.as_str() } else { cwd };
        let mut dir = (!base.is_empty()).then(|| std::path::PathBuf::from(base));
        for (i, s) in segs.iter().enumerate() {
            let toks = crate::script::host_shell::tokenize(s);
            let head = toks.first().map_or("", String::as_str);
            if cds.contains(&head) {
                let d = delims.get(i).copied().unwrap_or("");
                let lit = toks.get(1).filter(|t| toks.len() == 2 && !t.is_empty() && !t.starts_with('-') && !t.chars().any(|c| deny.contains(c)));
                dir = match lit {
                    Some(t) if dls.contains(&d) => {
                        if std::path::Path::new(t).is_absolute() {
                            Some(std::path::PathBuf::from(t))
                        } else {
                            dir.map(|b| b.join(t))
                        }
                    }
                    _ => None,
                };
                continue;
            }
            if lost.contains(&head) {
                dir = None;
            }
            for w in shell_writes(s) {
                let p = std::path::Path::new(&w);
                let w = if p.is_absolute() { w.clone() } else { dir.as_ref().map_or(w.clone(), |d| d.join(p).to_string_lossy().into_owned()) };
                if !writes.contains(&w) {
                    writes.push(w);
                }
            }
        }
        // the directory the call ran in once its `cd`s are followed (else the transcript's): its repository's state decides HARD credit
        call_dir = dir.as_ref().map_or_else(|| base.to_string(), |d| d.to_string_lossy().into_owned());
        // a build launch is one event of the burn episode: an endless chain of builds with no outcome spends the episode's cap (PR #472)
        if defaults::raw("burn.doubt").get("classes").map(V::strings).unwrap_or_default().iter().any(|c| *c == class) {
            episode_event(a, ts);
        }
        if input.get(tr("background")).and_then(Value::as_bool) == Some(true) {
            push_ring(&mut a.bg_bash, ts, lim("loop_window"));
        }
    } else if tools("todo").contains(&name) {
        todos(a, &input);
    } else if tools("task_update").contains(&name) {
        let task = str_of(&input, tr("task_id")).to_string();
        let text = [tr("active_form"), tr("subject")].iter().map(|k| str_of(&input, k)).find(|s| !s.is_empty()).unwrap_or("");
        let subject = str_of(&input, tr("subject"));
        if !task.is_empty() && !subject.is_empty() {
            remember_task(a, &task, subject);
        }
        match str_of(&input, tr("task_status")) {
            s if s == tr("completed") => {
                a.steps_done += 1;
                a.progress += weight("step");
                a.open = false;
                // the finished task was the declared step: nothing is being done now until another starts
                if !task.is_empty() && a.step_task == task {
                    a.step.clear();
                    a.step_task.clear();
                    a.step_events = 0;
                    a.work.clear();
                }
            }
            s if s == tr("in_progress") => {
                // a start that names nothing is the task the id was created or last renamed with
                let named = if text.is_empty() { a.task_names.get(&task).cloned().unwrap_or_default() } else { text.to_string() };
                set_step(a, &named);
                if !named.is_empty() {
                    a.step_task = task;
                }
            }
            _ => {}
        }
    }
    wake(a, name, &input, ts);
    if !id.is_empty() {
        let bg = tools("shell").contains(&name) && input.get(tr("background")).and_then(Value::as_bool) == Some(true);
        let ack = tools("agent").contains(&name) && input.get(tr("background")).and_then(Value::as_bool) == Some(true);
        a.pending.insert(id, Pending { name: name.to_string(), ts, label, class, bg, push, ack, writes, amp, cwd: call_dir });
        while a.pending.len() > lim("loop_window") as usize {
            let Some(k) = a.pending.iter().min_by_key(|(_, p)| p.ts).map(|(k, _)| k.clone()) else { break };
            a.pending.remove(&k);
        }
    }
}

fn remember_task(a: &mut Agent, id: &str, subject: &str) {
    a.task_names.insert(id.to_string(), cap(subject, lim("text_cap")));
    while a.task_names.len() > lim("task_names_max") as usize {
        let Some(k) = a.task_names.keys().next().cloned() else { break };
        a.task_names.remove(&k);
    }
}

pub(crate) fn set_step(a: &mut Agent, text: &str) {
    let t = cap(text, lim("text_cap"));
    if !t.is_empty() {
        a.open = true;
    }
    if !t.is_empty() && t != a.step {
        a.step = t;
        a.step_events = 0;
        a.work.clear();
    }
}

fn todos(a: &mut Agent, input: &Value) {
    let list = input.get(tr("todos")).and_then(Value::as_array).map_or(&[][..], Vec::as_slice);
    let done = list.iter().filter(|t| str_of(t, tr("task_status")) == tr("completed")).count() as u64;
    if done > a.todo_done {
        a.progress += (done - a.todo_done) * weight("step");
        a.steps_done += done - a.todo_done;
    }
    a.todo_done = done;
    a.open = (list.len() as u64) > done;
    if let Some(t) = list.iter().find(|t| str_of(t, tr("task_status")) == tr("in_progress")) {
        let s = [tr("active_form"), tr("content_key")].iter().map(|k| str_of(t, k)).find(|s| !s.is_empty()).unwrap_or("");
        set_step(a, s);
        a.step_task.clear();
    } else if !a.step.is_empty() && list.iter().any(|t| [tr("active_form"), tr("content_key")].iter().any(|k| cap(str_of(t, k), lim("text_cap")) == a.step)) {
        // the list no longer has the declared step in progress (it was completed or put back): nothing is being done now
        a.step.clear();
        a.step_events = 0;
        a.work.clear();
    }
}

fn wake(a: &mut Agent, name: &str, input: &Value, ts: u64) {
    let w = defaults::raw("agent_tracker.wake");
    let n = |k: &str| w.get(k).and_then(V::as_integer).unwrap_or(0).max(0) as u64;
    let until = if tools("monitor").contains(&name) {
        ts + if input.get(tr("persistent")).and_then(Value::as_bool) == Some(true) { n("persistent") } else { n("monitor") }
    } else if tools("cron").contains(&name) {
        ts + n("cron")
    } else if tools("wakeup").contains(&name) {
        ts + input.get(tr("delay")).and_then(Value::as_u64).unwrap_or(0) * fmtn("ms_per_s") + n("wakeup_slack")
    } else {
        return;
    };
    a.armed_until = a.armed_until.max(until);
    a.armed_at = a.armed_at.max(ts);
}

fn tool_result(a: &mut Agent, b: &Value, ts: u64) {
    let text = result_text(b.get(tr("content_key")).unwrap_or(&Value::Null));
    if pat("codex_job").is_some_and(|r| r.is_match(&text)) {
        a.codex_rescue = true;
    }
    let Some(p) = a.pending.remove(str_of(b, tr("tool_use_id"))) else { return };
    let failed = b.get(tr("is_error")).and_then(Value::as_bool) == Some(true);
    if !failed
        && tools("task_create").contains(&p.name.as_str())
        && let Some(id) = pat("task_created").and_then(|r| r.captures(&text).and_then(|c| c.get(1).map(|m| m.as_str().to_string())))
    {
        remember_task(a, &id, &p.label);
    }
    if pat("guard_fire").is_some_and(|r| r.is_match(&text)) {
        a.guard_fires += 1;
    }
    // a subagent launched in the foreground returned its result to this agent
    if !failed && !p.ack && tools("agent").contains(&p.name.as_str()) {
        a.reports += 1;
        a.progress += weight("agent_result");
    }
    if p.bg
        && !failed
        && let Some(id) = pat("bg_started").and_then(|r| r.captures(&text).and_then(|c| c.get(1).map(|m| m.as_str().to_string())))
    {
        if defaults::raw("burn.doubt").get("classes").map(V::strings).unwrap_or_default().iter().any(|c| *c == p.class) {
            push_ring(&mut a.bg_builds, id.clone(), lim("loop_window"));
        }
        // a task backgrounded inside the task as well (a top-level `&`) ends when its launching shell does: no outcome waits for it
        if !p.amp && (p.class == "check" || !p.writes.is_empty()) {
            a.bg_outcomes.insert(id.clone(), (p.class == "check", p.writes.clone()));
            a.bg_starts.insert(id.clone(), (p.ts, p.cwd.clone()));
        }
        a.bg_ids.insert(id, ts);
        while a.bg_ids.len() > lim("loop_window") as usize {
            let Some(k) = a.bg_ids.iter().min_by_key(|(_, t)| **t).map(|(k, _)| k.clone()) else { break };
            a.bg_ids.remove(&k);
        }
        let live = &a.bg_ids;
        a.bg_outcomes.retain(|k, _| live.contains_key(k));
        a.bg_starts.retain(|k, _| live.contains_key(k));
    }
    if failed {
        a.errors += 1;
        let head: String = text.chars().filter(|c| !c.is_ascii_digit()).take(lim("text_cap") as usize).collect();
        push_ring(&mut a.errs, (crate::health::fnv(&head), cap(&text, lim("text_cap")), ts), lim("error_window"));
        return;
    }
    // PR #472 HARD outcomes: a file the shell created or appended for the first time and a passing check add progress (and so restart the
    // burn count), like an edited file or a passing test. SOFT: a completed live probe or a shell write to a file already written; each
    // is one event of the burn episode, which may only hold off the pause within the episode's cap (burn.soft_hold).
    // A BACKGROUND launch's result is only its acknowledgment: the check has not run, so the launch is at most SOFT and the HARD outcome
    // waits for its completion notice (task_ends). A command backgrounded with a top-level `&` (p.amp) has no completion notice at all:
    // it is never more than SOFT.
    // a successful edit is a real change: a check after it may earn HARD again (PR #472 round 4)
    if tools("edit").contains(&p.name.as_str()) {
        a.changes += 1;
    }
    let om = defaults::raw("agent_tracker.outcome_metric");
    let hard = !p.bg && !p.amp && hard_outcome(a, p.class == "check", &p.writes, p.ts, &p.cwd);
    if !hard && (p.class == "probe" || p.class == "check" || !p.writes.is_empty()) {
        push_ring(&mut a.soft_ts, ts, lim("loop_window"));
        episode_event(a, ts);
        count_outcome(if p.class == "probe" || p.class == "check" { p.class.as_str() } else { om.str_field("shell_file") });
    }
    // a command backgrounded with a top-level `&` has not done its work when the launching shell exits: no commit, push, merge, deploy,
    // build or test credit either (PR #472)
    if p.amp {
        return;
    }
    if p.push || p.class == "commit" || p.class == "merge" || p.class == "deploy" {
        a.last_ship_ms = ts;
    }
    if p.push {
        a.pushes += 1;
        a.progress += weight("push");
        a.waste.reset_at = ts;
    }
    if p.class == "merge" || p.class == "deploy" {
        a.shipped += 1;
        a.progress += weight(&p.class);
    }
    if p.class == "commit" {
        a.commits += 1;
        a.changes += 1;
        a.progress += weight("commit");
        a.waste.reset_at = ts; // a commit in any repo the command ran git in starts the waste window afresh
    } else if p.class == "build" {
        if pat("build_pass").is_some_and(|r| r.is_match(&text)) && !pat("build_fail").is_some_and(|r| r.is_match(&text)) {
            a.builds_ok += 1;
            // PR #472 round 5: a passing build is full credit only when the repo state changed since the last HARD credit
            if repo_changed(a, super::repo::state(&p.cwd)) {
                a.progress += weight("build");
                a.waste.reset_at = ts;
            }
        }
    } else if p.class == "test" {
        let ok = pat("test_pass").is_some_and(|r| r.is_match(&text)) && !pat("test_fail").is_some_and(|r| r.is_match(&text));
        if ok {
            a.tests_pass += 1;
            if repo_changed(a, super::repo::state(&p.cwd)) {
                a.progress += weight("test");
            }
        }
    }
}

/// One event of the current burn episode (a soft outcome or a build launch, PR #472): a hard outcome since the episode began (progress
/// moved) starts a new one at `ts`. burn.soft_hold caps the events and the length of an episode.
pub(crate) fn episode_event(a: &mut Agent, ts: u64) {
    episode_sync(a, ts);
    a.soft_episode.2 += 1;
}

/// Start a new burn episode at `ts` when a hard outcome came since the current one began (or none began yet): the episode clock starts
/// at the last hard outcome (PR #472), and an agent with none yet starts its first episode when it is first seen.
pub(crate) fn episode_sync(a: &mut Agent, ts: u64) {
    if a.soft_episode.0 != a.progress || a.soft_episode.1 == 0 {
        a.soft_episode = (a.progress, ts, 0);
    }
}

/// A HARD outcome of a shell command that began at `start` in `dir` and ended with success (PR #472 round 5): full credit comes from a
/// change in repo state, never from the command text. A verified write (`written_since`: the file is there, modified at or after
/// `start`) or a passing check (`check`) earns HARD only when the state of the call's repository (agent::repo::state) changed since the
/// last HARD credit of any kind there; a write must also be inside that repository and not ignored by git (a temp file or a gitignored
/// one never changes the state). Outside a repository, or with git missing, failing or timing out, the verified-write rule applies: a
/// write of a file not written before and not a temp-dir scratch file outside `dir`, or a check after a real change (`changes`: an
/// edit, a fresh shell write, a commit) since the last HARD credit. False when it earned neither.
fn hard_outcome(a: &mut Agent, check: bool, writes: &[String], start: u64, dir: &str) -> bool {
    let verified: Vec<String> = writes.iter().filter_map(|w| written_since(w, start)).collect();
    if verified.is_empty() && !check {
        return false;
    }
    let st = super::repo::state(dir);
    let fresh: Vec<String> = match &st {
        Some((top, _)) => {
            let inside: Vec<String> = verified.into_iter().filter(|w| std::path::Path::new(w).starts_with(top)).collect();
            let ign = super::repo::ignored(top, &inside);
            inside.into_iter().filter(|w| !ign.contains(w)).collect()
        }
        None => verified.into_iter().filter(|w| !a.files.contains(w) && !super::repo::scratch(w, dir)).collect(),
    };
    if fresh.is_empty() && !check {
        return false;
    }
    // outside a repository a fresh verified write is itself the change; a check needs one since the last HARD credit
    let fallback_write = st.is_none() && !fresh.is_empty();
    if !fallback_write && !repo_changed(a, st) {
        return false;
    }
    if fresh.is_empty() {
        a.progress += weight("check");
        count_outcome("check");
        return true;
    }
    for w in fresh {
        if !a.files.contains(&w) {
            push_ring(&mut a.files, w, lim("files_max"));
        }
    }
    a.changes += 1;
    a.hard_changes = Some(a.changes);
    a.progress += weight("shell_file");
    count_outcome(defaults::raw("agent_tracker.outcome_metric").str_field("shell_file"));
    true
}

/// Whether the repo state `st` (agent::repo::state of the call's directory) changed since the last HARD credit there, recording it
/// as the new baseline when it did (PR #472 round 5). `st` None (no repository, git missing, failed or timed out): whether a real
/// change (`changes`) came since the last HARD credit. Called only for a call that would otherwise earn HARD.
fn repo_changed(a: &mut Agent, st: Option<(String, String)>) -> bool {
    match st {
        Some((top, state)) => {
            if a.repo_states.get(&top) == Some(&state) {
                return false;
            }
            a.repo_states.insert(top, state);
            while a.repo_states.len() > lim("loop_window") as usize {
                let Some(k) = a.repo_states.keys().next().cloned() else { break };
                a.repo_states.remove(&k);
            }
        }
        None if a.hard_changes == Some(a.changes) => return false,
        None => {}
    }
    a.hard_changes = Some(a.changes);
    true
}

/// The real path of a file the shell claims to have written, when it is a regular file (never a device, a pipe or a directory) that
/// exists now and was modified at or after `start` (milliseconds since the epoch). A relative path (one the call's directory could not
/// resolve) is None, as is anything else and a resolved path patterns.shell_write_skip names.
fn written_since(path: &str, start: u64) -> Option<String> {
    let p = std::path::Path::new(path);
    if !p.is_absolute() {
        return None;
    }
    let real = std::fs::canonicalize(p).ok()?;
    let s = real.to_string_lossy().into_owned();
    if pat("shell_write_skip").is_some_and(|r| r.is_match(&s)) {
        return None;
    }
    let md = std::fs::metadata(&real).ok().filter(std::fs::Metadata::is_file)?;
    let ms = md.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as u64;
    (ms >= start).then_some(s)
}

/// The files a shell command segment creates or appends: every capture of patterns.shell_write (the first group that matched), minus the
/// paths patterns.shell_write_skip names (a device such as /dev/null). Quoted strings (burn.quoted_re) are masked while matching, so
/// a `>` inside quotes is no redirect, and put back in a captured path (PR #472: `> "out/a.txt"` and `> "out/b.txt"` are two files);
/// agent_tracker.write_mask is the sentinel around a masked string's index (empty: quoted strings are blanked, as before).
fn shell_writes(cmd: &str) -> Vec<String> {
    let (Some(re), skip) = (pat("shell_write"), pat("shell_write_skip")) else { return Vec::new() };
    let mask = defaults::text("agent_tracker.write_mask");
    let mut quoted: Vec<String> = Vec::new();
    let masked = match Regex::new(defaults::text("burn.quoted_re")).ok().filter(|_| !mask.is_empty()) {
        Some(q) => q
            .replace_all(cmd, |c: &regex::Captures| {
                let m = c.get(0).map_or("", |m| m.as_str());
                quoted.push(m.get(1..m.len().saturating_sub(1)).unwrap_or("").to_string());
                format!("{mask}{}{mask}", quoted.len() - 1)
            })
            .into_owned(),
        None => unquoted(cmd),
    };
    let mut out: Vec<String> = Vec::new();
    for c in re.captures_iter(&masked) {
        let Some(m) = c.iter().skip(1).flatten().next() else { continue };
        let path: String = m
            .as_str()
            .split(mask)
            .enumerate()
            .map(|(i, s)| if i % 2 == 1 { s.parse::<usize>().ok().and_then(|n| quoted.get(n)).map_or(s, String::as_str) } else { s })
            .collect();
        if !path.is_empty() && !skip.as_ref().is_some_and(|s| s.is_match(&path)) && !out.contains(&path) {
            out.push(path);
        }
    }
    out
}

/// The command with each quoted string blanked (burn.quoted_re): text in an argument (`printf 'git diff --check'`, `echo "a > b"`) never
/// names the program run or a file written.
fn unquoted(cmd: &str) -> String {
    match Regex::new(defaults::text("burn.quoted_re")).ok() {
        Some(q) => q.replace_all(cmd, "q").into_owned(),
        None => cmd.to_string(),
    }
}

/// Count one outcome of a kind GH #458 added (shell_file, probe, check) in the registered counter agent_tracker.outcome_metric.
fn count_outcome(kind: &str) {
    let m = defaults::raw("agent_tracker.outcome_metric");
    crate::metrics::bump(m.str_field("name"), &[(m.str_field("label"), kind)]);
}

/// The path of a subagent's metadata file next to its transcript.
pub(crate) fn meta_path(transcript: &str) -> String {
    transcript.trim_end_matches(pth("transcript_ext")).to_string() + pth("meta_ext")
}
