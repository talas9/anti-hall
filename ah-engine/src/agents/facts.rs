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

fn pat(k: &str) -> Option<&'static Regex> {
    static C: crate::defaults::Cache<Vec<(String, Option<Regex>)>> = crate::defaults::Cache::new();
    let all = C.get_or_init(|| {
        defaults::raw("agent_tracker.patterns")
            .as_table()
            .map(|t| {
                t.iter().map(|(k, v)| ((*k).to_string(), v.as_str().and_then(|s| regex::RegexBuilder::new(s).case_insensitive(true).build().ok()))).collect()
            })
            .unwrap_or_default()
    });
    all.iter().find(|(n, _)| n == k).and_then(|(_, r)| r.as_ref())
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
    let mut start = a.offset;
    let mut skip_first = false;
    if start == 0 && len > lim("first_read_bytes") {
        start = len - lim("first_read_bytes");
        a.partial = true;
        skip_first = true;
    }
    if len - start > lim("read_max_bytes") {
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
    let text = String::from_utf8_lossy(&buf[..end]);
    let mut lines = text.lines();
    if skip_first {
        lines.next();
    }
    for l in lines {
        if let Ok(v) = serde_json::from_str::<Value>(l) {
            line(a, &v, now);
        }
    }
}

fn line(a: &mut Agent, v: &Value, now: u64) {
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
        for b in blocks {
            if str_of(b, tr("type_key")) == tr("tool_use") {
                a.running = true;
                tool_use(a, b, ts);
            }
        }
    } else if ty == tr("user") {
        a.last_output_ms = a.last_output_ms.max(ts);
        a.running = true;
        for b in blocks {
            if str_of(b, tr("type_key")) == tr("tool_result") {
                tool_result(a, b, ts);
            }
        }
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
    a.tools += 1;
    let arg = [tr("command"), tr("file_path"), tr("pattern"), tr("path")].iter().map(|k| str_of(&input, k)).find(|s| !s.is_empty()).unwrap_or("");
    let label = cap(arg, lim("text_cap"));
    let is_edit = tools("edit").contains(&name);
    push_ring(&mut a.recent, (format!("{name}:{:x}", crate::health::fnv(&input.to_string())), format!("{name} {label}"), is_edit, ts), lim("loop_window"));
    let mut class = String::new();
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
        if pat("commit").is_some_and(|r| r.is_match(arg)) {
            class = "commit".into();
        } else if pat("test").is_some_and(|r| r.is_match(arg)) {
            class = "test".into();
        }
        if input.get(tr("background")).and_then(Value::as_bool) == Some(true) {
            push_ring(&mut a.bg_bash, ts, lim("loop_window"));
        }
    } else if tools("todo").contains(&name) {
        todos(a, &input);
    } else if tools("task_update").contains(&name) {
        match str_of(&input, tr("task_status")) {
            s if s == tr("completed") => {
                a.steps_done += 1;
                a.progress += weight("step");
            }
            s if s == tr("in_progress") => {
                let t = [tr("active_form"), tr("subject"), "taskId"].iter().map(|k| str_of(&input, k)).find(|s| !s.is_empty()).unwrap_or("");
                set_step(a, t);
            }
            _ => {}
        }
    }
    wake(a, name, &input, ts);
    if !id.is_empty() {
        a.pending.insert(id, Pending { name: name.to_string(), ts, label, class });
        while a.pending.len() > lim("loop_window") as usize {
            let Some(k) = a.pending.iter().min_by_key(|(_, p)| p.ts).map(|(k, _)| k.clone()) else { break };
            a.pending.remove(&k);
        }
    }
}

pub(crate) fn set_step(a: &mut Agent, text: &str) {
    let t = cap(text, lim("text_cap"));
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
    if let Some(t) = list.iter().find(|t| str_of(t, tr("task_status")) == tr("in_progress")) {
        let s = [tr("active_form"), tr("content_key")].iter().map(|k| str_of(t, k)).find(|s| !s.is_empty()).unwrap_or("");
        set_step(a, s);
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
    let Some(p) = a.pending.remove(str_of(b, tr("tool_use_id"))) else { return };
    let text = result_text(b.get(tr("content_key")).unwrap_or(&Value::Null));
    let failed = b.get(tr("is_error")).and_then(Value::as_bool) == Some(true);
    if failed {
        a.errors += 1;
        let head: String = text.chars().filter(|c| !c.is_ascii_digit()).take(lim("text_cap") as usize).collect();
        push_ring(&mut a.errs, (crate::health::fnv(&head), cap(&text, lim("text_cap")), ts), lim("error_window"));
        return;
    }
    if p.class == "commit" {
        a.commits += 1;
        a.progress += weight("commit");
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
