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
    if a.offset == 0 { a.transcript_from_start = true; }
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
        Err(_) => { a.partial = true; return; }
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
    a.transcript_complete = a.transcript_from_start && !a.partial && a.offset == len
        && std::fs::metadata(&a.path).is_ok_and(|m| m.len() == len);
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
        if pat("codex_job").is_some_and(|r| r.is_match(&returned)) { a.codex_rescue = true; }
        for b in blocks {
            if a.watch {
                turn(a, b, ts);
            }
            if str_of(b, tr("type_key")) == tr("tool_use") {
                a.running = true;
                tool_use(a, b, ts);
            }
        }
    } else if ty == tr("user") {
        a.last_output_ms = a.last_output_ms.max(ts);
        a.running = true;
        if !a.bg_ids.is_empty() {
            task_ends(a, msg.and_then(|m| m.get(tr("content"))), ts);
        }
        for b in blocks {
            if str_of(b, tr("type_key")) == tr("tool_result") {
                let text = result_text(b.get(tr("content_key")).unwrap_or(&Value::Null));
                let rescue = a.rescue_calls.remove(str_of(b, tr("tool_use_id"))) || pat("codex_job").is_some_and(|r| r.is_match(&text));
                if rescue {
                    let id = v.get(nw.str_field("result_field")).and_then(|r| r.get(nw.str_field("result_agent_field"))).and_then(Value::as_str).map(str::to_string)
                        .or_else(|| Regex::new(defaults::text("agent_scan.re_agent_id")).ok().and_then(|r| r.captures(&text).and_then(|c| c.get(1).map(|m| m.as_str().to_string()))));
                    if let Some(id) = id.filter(|id| !id.is_empty()) { a.rescue_children.insert(id); }
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

fn tool_use(a: &mut Agent, b: &Value, ts: u64) {
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
    let mut push = false;
    if is_edit {
        a.edits += 1;
        let path = str_of(&input, tr("file_path"));
        if !path.is_empty() && !a.files.iter().any(|f| f == path) {
            a.progress += weight("file");
            push_ring(&mut a.files, path.to_string(), lim("files_max"));
        }
        a.step_events += 1;
        for w in words(path) {
            push_ring(&mut a.work, w, lim("work_words_max"));
        }
    } else if tools("shell").contains(&name) {
        a.step_events += 1;
        for w in words(arg) {
            push_ring(&mut a.work, w, lim("work_words_max"));
        }
        push = pat("push").is_some_and(|r| r.is_match(arg));
        if pat("commit").is_some_and(|r| r.is_match(arg)) {
            class = "commit".into();
        } else if pat("merge").is_some_and(|r| r.is_match(arg)) {
            class = "merge".into();
        } else if pat("deploy").is_some_and(|r| r.is_match(arg)) {
            class = "deploy".into();
        } else if pat("test").is_some_and(|r| r.is_match(arg)) {
            class = "test".into();
        } else if pat("build").is_some_and(|r| r.is_match(arg)) {
            class = "build".into();
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
        a.pending.insert(id, Pending { name: name.to_string(), ts, label, class, bg, push });
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
    if pat("codex_job").is_some_and(|r| r.is_match(&text)) { a.codex_rescue = true; }
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
    if p.bg
        && !failed
        && let Some(id) = pat("bg_started").and_then(|r| r.captures(&text).and_then(|c| c.get(1).map(|m| m.as_str().to_string())))
    {
        a.bg_ids.insert(id, ts);
        while a.bg_ids.len() > lim("loop_window") as usize {
            let Some(k) = a.bg_ids.iter().min_by_key(|(_, t)| **t).map(|(k, _)| k.clone()) else { break };
            a.bg_ids.remove(&k);
        }
    }
    if failed {
        a.errors += 1;
        let head: String = text.chars().filter(|c| !c.is_ascii_digit()).take(lim("text_cap") as usize).collect();
        push_ring(&mut a.errs, (crate::health::fnv(&head), cap(&text, lim("text_cap")), ts), lim("error_window"));
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
        a.progress += weight("commit");
        a.waste.reset_at = ts; // a commit in any repo the command ran git in starts the waste window afresh
    } else if p.class == "build" {
        if pat("build_pass").is_some_and(|r| r.is_match(&text)) && !pat("build_fail").is_some_and(|r| r.is_match(&text)) {
            a.builds_ok += 1;
            a.progress += weight("build");
            a.waste.reset_at = ts;
        }
    } else if p.class == "test" {
        let ok = pat("test_pass").is_some_and(|r| r.is_match(&text)) && !pat("test_fail").is_some_and(|r| r.is_match(&text));
        if ok {
            a.tests_pass += 1;
            a.progress += weight("test");
        }
    }
}

/// The path of a subagent's metadata file next to its transcript.
pub(crate) fn meta_path(transcript: &str) -> String {
    transcript.trim_end_matches(pth("transcript_ext")).to_string() + pth("meta_ext")
}
