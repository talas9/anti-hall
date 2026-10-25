//! The task-relevant lines of a transcript window, kept between calls (task cpuB): `ah.transcript.tasks` rebuilds the task list
//! from the last `window` bytes, and a Stop (or a prompt) asks again after every few kilobytes. A line that names no task tool
//! and answers no task call changes nothing in any of the three reconstructions ([`crate::checks::taskstate::parse::reconstruct`]
//! for the guard and state variants, [`crate::checks::taskstate::scanview::scan_lines`] for the scan), so only the lines that can
//! matter are kept, each with the byte offset it starts at. A call then reads only the bytes appended since the last one, drops
//! the lines that left the window at the front and hands the kept lines to the same reconstruction, which gives the answer a read
//! of the whole window gives; a test compares the two across appends, windows, truncations, replacements and unreadable lines.
//!
//! A line is kept when it
//! - is not valid JSON but might be for JavaScript's parser, or is a JSON `null` (both make a reconstruction give up, so they stay
//!   visible to it);
//! - holds a tool use named by `taskstate.task_tools`, or one whose id is not a string, or one that re-uses the id of a task call;
//! - answers a task call (its `tool_use_id` is the id of one seen earlier in the window), or has a tool result the TaskCreate
//!   pattern reads (the scan counts those whatever call they answer).
//!
//! What is kept is bounded: `transcript.tasks_cache_max_paths` windows at most, each at most
//! `transcript.tasks_cache_entry_max_bytes`, all together under the `mem.tasks_cache_*` limits, and an entry unused for
//! `transcript.tasks_cache_idle_ms` goes. Nothing here is the source of truth: the file is. A cache that cannot answer (the feature
//! off, a file that cannot be read) hands the call to the plain reader, so a failure here is slower, never different.
use crate::checks::guardkit::text::{js_trim, lossy_owned};
use crate::checks::taskkit::jsval::{get, truthy};
use crate::checks::taskstate::parse::{collect_tool_uses, maybe_valid_for_js};
use crate::checks::taskstate::scanview;
use crate::defaults;
use crate::mem::{BoundedCache, Spec};
use serde_json::Value;
use std::collections::{HashSet, VecDeque};
use std::os::unix::fs::{FileExt, MetadataExt};
use std::sync::OnceLock;

/// One kept line: where it starts and its text (the trailing `\r` already taken off, as `lines_of` does).
#[derive(Clone)]
struct Line {
    start: u64,
    text: String,
}

/// What is kept of one window of one transcript: the relevant lines from `base` to `parsed_to` (every line before `parsed_to`
/// is complete), the ids of the task calls seen, and the file's identity with a digest of both ends so a rewrite is noticed.
#[derive(Clone)]
struct Kept {
    gen_: u64,
    dev: u64,
    ino: u64,
    base: u64,
    parsed_to: u64,
    head: u64,
    back: u64,
    task_calls: HashSet<String>,
    lines: VecDeque<Line>,
}

fn cache() -> &'static BoundedCache<String, Kept> {
    static CACHE: OnceLock<BoundedCache<String, Kept>> = OnceLock::new();
    CACHE.get_or_init(|| {
        BoundedCache::new(
            crate::mem::global(),
            Spec::new("tasks_cache", "mem.tasks_cache_soft_bytes", "mem.tasks_cache_hard_bytes", "mem.tasks_cache_low_water_pct")
                .with_entries("transcript.tasks_cache_max_paths"),
        )
    })
}

fn digest_at(f: &std::fs::File, at: u64, len: u64) -> Option<u64> {
    use std::hash::Hasher;
    let mut b = vec![0u8; len as usize];
    f.read_exact_at(&mut b, at).ok()?;
    let mut h = std::collections::hash_map::DefaultHasher::new();
    h.write(&b);
    Some(h.finish())
}

/// Where the first line of a window starts: the byte after the first newline at or after `from` (`Ok(None)`: no newline follows,
/// so the window holds no whole line).
fn first_line_start(f: &std::fs::File, from: u64, size: u64) -> Option<Option<u64>> {
    // a line is usually short: look in small steps first, then in larger ones up to the configured chunk
    let chunk = defaults::num("transcript.evidence_read_chunk_bytes").max(1);
    let mut step = chunk.min(defaults::num("transcript.tasks_cache_probe_bytes").max(1));
    let mut at = from;
    let mut buf: Vec<u8> = Vec::new();
    while at < size {
        let n = step.min(size - at) as usize;
        buf.resize(n, 0);
        f.read_exact_at(&mut buf, at).ok()?;
        crate::load::note_scan(n as u64);
        if let Some(i) = buf.iter().position(|b| *b == b'\n') {
            return Some(Some(at + i as u64 + 1));
        }
        at += n as u64;
        step = (step * 2).min(chunk);
    }
    Some(None)
}

/// Whether a line can change a reconstruction. `record` stores the ids of the task calls the line makes (a line still being
/// written is judged without recording).
fn relevant(text: &str, task_calls: &mut HashSet<String>, record: bool) -> bool {
    let t = js_trim(text);
    if t.is_empty() {
        return false;
    }
    let entry: Value = match serde_json::from_str(t) {
        Ok(v) => v,
        Err(_) => return maybe_valid_for_js(t),
    };
    if entry.is_null() {
        return true;
    }
    let mut keep = false;
    // the results first: they answer calls made on earlier lines
    if get(&entry, "type").and_then(Value::as_str) == Some("user") {
        let content = get(&entry, "message").and_then(|m| get(m, "content")).and_then(Value::as_array);
        for it in content.into_iter().flatten() {
            if get(it, "type").and_then(Value::as_str) != Some("tool_result") {
                continue;
            }
            let Some(use_id) = get(it, "tool_use_id").and_then(Value::as_str) else { continue };
            if task_calls.contains(use_id) || scanview::created_re().is_match(&scanview::result_text(it)) {
                keep = true;
            }
        }
    }
    let mut uses = Vec::new();
    collect_tool_uses(&entry, &mut uses);
    let names = defaults::list("taskstate.task_tools");
    let mut added: Vec<String> = Vec::new();
    for tu in uses {
        let name = get(tu, "name").and_then(Value::as_str).unwrap_or("");
        let task = names.contains(&name);
        keep |= task;
        match get(tu, "id").filter(|v| truthy(v)) {
            Some(Value::String(id)) => {
                if task {
                    added.push(id.clone());
                } else if task_calls.contains(id) {
                    keep = true;
                }
            }
            // an id JavaScript would read as something else than a string: the reconstructions give up on it
            Some(_) => keep = true,
            None => {}
        }
    }
    if record {
        task_calls.extend(added);
    }
    keep
}

/// One complete line of bytes as a kept line, or `None` when it cannot matter.
fn make_line(start: u64, bytes: &[u8], task_calls: &mut HashSet<String>, record: bool) -> Option<Line> {
    let text = lossy_owned(bytes.to_vec());
    let line = text.strip_suffix('\r').unwrap_or(&text);
    relevant(line, task_calls, record).then(|| Line { start, text: line.to_string() })
}

fn weight(k: &Kept) -> usize {
    k.lines.iter().map(|l| l.text.len() + std::mem::size_of::<Line>()).sum::<usize>()
        + k.task_calls.iter().map(|i| i.len() + 32).sum::<usize>()
        + std::mem::size_of::<Kept>()
}

/// Why a kept entry cannot serve a window starting at `fls`, or `None` when it can.
fn miss_reason(k: &Kept, f: &std::fs::File, m: &std::fs::Metadata, fls: u64) -> Option<&'static str> {
    if k.gen_ != defaults::generation() {
        return Some("gen");
    }
    if k.dev != m.dev() || k.ino != m.ino() || m.len() < k.parsed_to {
        return Some("file");
    }
    if k.base > fls || fls > k.parsed_to {
        return Some("window");
    }
    let fp = defaults::num("transcript.evidence_fingerprint_bytes").max(1);
    let n = fp.min(k.parsed_to - k.base);
    if digest_at(f, k.base, n) != Some(k.head) || digest_at(f, k.parsed_to - n, n) != Some(k.back) {
        return Some("digest");
    }
    None
}

/// The relevant lines of the last `w` bytes of `path` (the line still being written last) and whether the file was cut; `None`
/// when the call is left to the plain reader (the cache is off, or the file cannot be read here).
pub fn lines(path: &str, w: u64) -> Option<(Vec<String>, bool)> {
    if defaults::num("transcript.tasks_cache_max_paths") == 0 {
        return None;
    }
    let f = std::fs::File::open(path).ok()?;
    let m = f.metadata().ok()?;
    if !m.is_file() {
        return None;
    }
    let size = m.len();
    let truncated = size > w;
    let fls = if truncated {
        match first_line_start(&f, size - w, size)? {
            Some(s) => s,
            // the window holds no newline: its one piece is the cut first line, which is dropped
            None => return Some((Vec::new(), true)),
        }
    } else {
        0
    };
    let key = format!("{path}\0{w}");
    let fresh = || Kept {
        gen_: defaults::generation(),
        dev: m.dev(),
        ino: m.ino(),
        base: fls,
        parsed_to: fls,
        head: 0,
        back: 0,
        task_calls: HashSet::new(),
        lines: VecDeque::new(),
    };
    let mut k = match cache().remove(&key) {
        Some(k) => match miss_reason(&k, &f, &m, fls) {
            None => {
                crate::load::note_count("tasks_cache", "result", if size == k.parsed_to { "hit" } else { "extend" });
                k
            }
            Some(reason) => {
                crate::load::note_count("tasks_cache", "result", "rebuild");
                crate::load::note_count("tasks_cache_rebuild", "reason", reason);
                fresh()
            }
        },
        None => {
            crate::load::note_count("tasks_cache", "result", "rebuild");
            crate::load::note_count("tasks_cache_rebuild", "reason", "none");
            fresh()
        }
    };
    while k.lines.front().is_some_and(|l| l.start < fls) {
        k.lines.pop_front();
    }
    k.base = fls;
    // read what was appended: the complete lines are judged for good, a last line without its newline now and again next time
    let mut buf = vec![0u8; (size - k.parsed_to) as usize];
    f.read_exact_at(&mut buf, k.parsed_to).ok()?;
    crate::load::note_scan(buf.len() as u64);
    let mut at = 0usize;
    while let Some(i) = buf.get(at..).and_then(|r| r.iter().position(|b| *b == b'\n')) {
        let start = k.parsed_to;
        let mut calls = std::mem::take(&mut k.task_calls);
        if let Some(line) = make_line(start, buf.get(at..at + i).unwrap_or_default(), &mut calls, true) {
            k.lines.push_back(line);
        }
        k.task_calls = calls;
        k.parsed_to += (i + 1) as u64;
        at += i + 1;
    }
    let pending = (at < buf.len()).then(|| {
        let mut calls = k.task_calls.clone();
        make_line(k.parsed_to, buf.get(at..).unwrap_or_default(), &mut calls, false)
    });
    let out: Vec<String> = k.lines.iter().map(|l| l.text.clone()).chain(pending.into_iter().flatten().map(|l| l.text)).collect();
    // keep it for the next call, with a digest of both ends
    let fp = defaults::num("transcript.evidence_fingerprint_bytes").max(1);
    let n = fp.min(k.parsed_to - k.base);
    let w_bytes = weight(&k);
    if w_bytes as u64 <= defaults::num("transcript.tasks_cache_entry_max_bytes")
        && let (Some(head), Some(back)) = (digest_at(&f, k.base, n), digest_at(&f, k.parsed_to - n, n))
    {
        k.head = head;
        k.back = back;
        let ttl = defaults::num("transcript.tasks_cache_idle_ms");
        let exp = (ttl > 0).then(|| crate::health::now_ms().saturating_add(ttl));
        cache().insert_with_ttl(key, k, w_bytes, exp);
    }
    Some((out, truncated))
}

// ---- the widened search for task activity ---------------------------------------------------------------------------------------

use crate::checks::taskkit::jsval::{R, Unsure};
use crate::checks::taskstate::scanview::{Decisive, judge_wide_line, wide_finders};

/// What is kept of the widened search of one transcript: the lines from `from` to `to` that decide it (a task tool use, or a line
/// only JavaScript reads), each with its start. The lines between them decide nothing.
#[derive(Clone)]
struct WideKept {
    gen_: u64,
    dev: u64,
    ino: u64,
    from: u64,
    to: u64,
    head: u64,
    back: u64,
    decisive: VecDeque<(u64, Decisive)>,
}

fn wide_cache() -> &'static BoundedCache<String, WideKept> {
    static CACHE: OnceLock<BoundedCache<String, WideKept>> = OnceLock::new();
    CACHE.get_or_init(|| {
        BoundedCache::new(
            crate::mem::global(),
            Spec::new("tasks_wide_cache", "mem.tasks_cache_soft_bytes", "mem.tasks_cache_hard_bytes", "mem.tasks_cache_low_water_pct")
                .with_entries("transcript.tasks_cache_max_paths"),
        )
    })
}

fn wide_miss(k: &WideKept, f: &std::fs::File, m: &std::fs::Metadata, n1: u64) -> Option<&'static str> {
    if k.gen_ != defaults::generation() {
        return Some("gen");
    }
    if k.dev != m.dev() || k.ino != m.ino() || m.len() < k.to {
        return Some("file");
    }
    // the window starts before what was kept, or past all of it: the kept lines cannot stand for it
    if k.from > n1 || n1 > k.to {
        return Some("window");
    }
    let fp = defaults::num("transcript.evidence_fingerprint_bytes").max(1);
    let n = fp.min(k.to - k.from);
    if digest_at(f, k.from, n) != Some(k.head) || digest_at(f, k.to - n, n) != Some(k.back) {
        return Some("digest");
    }
    None
}

/// The bytes of the line that holds offset `at` from `at` to its newline (the newline excluded) and where the next line starts
/// (`None` at the end of the file).
fn rest_of_line(f: &std::fs::File, at: u64, size: u64) -> Option<(Vec<u8>, Option<u64>)> {
    let chunk = defaults::num("transcript.evidence_read_chunk_bytes").max(1);
    let (mut pos, mut out) = (at, Vec::new());
    let mut buf: Vec<u8> = Vec::new();
    while pos < size {
        let n = chunk.min(size - pos) as usize;
        buf.resize(n, 0);
        f.read_exact_at(&mut buf, pos).ok()?;
        crate::load::note_scan(n as u64);
        if let Some(i) = buf.iter().position(|b| *b == b'\n') {
            out.extend_from_slice(buf.get(..i)?);
            return Some((out, Some(pos + i as u64 + 1)));
        }
        out.extend_from_slice(&buf);
        pos += n as u64;
    }
    Some((out, None))
}

/// [`crate::checks::taskstate::scanview`]'s widened search (is there a task tool use in the last `wide` bytes) answered from the
/// kept deciding lines plus what was appended; `None` when the call is left to the plain reader (the cache is off, or the file
/// cannot be read here). The search starts at the window's first byte, which may cut a line: that piece is judged as it stands,
/// the lines after it from the kept ones.
pub fn wide_activity(path: &str, wide: u64) -> Option<R<bool>> {
    if defaults::num("transcript.tasks_cache_max_paths") == 0 {
        return None;
    }
    let f = std::fs::File::open(path).ok()?;
    let m = f.metadata().ok()?;
    if !m.is_file() {
        return None;
    }
    let size = m.len();
    let s1 = size.saturating_sub(wide);
    let names = defaults::list("tasklist_guard.task_tool_names");
    let finders = wide_finders(&names);
    let verdict = |d: Option<Decisive>| -> Option<R<bool>> {
        match d {
            Some(Decisive::Hit) => Some(Ok(true)),
            Some(Decisive::Unsure) => Some(Err(Unsure)),
            None => None,
        }
    };
    // the first line of the window: whole when the window starts at a line start, else the piece the cut leaves
    let n1 = if s1 == 0 {
        Some(0)
    } else {
        let mut b = [0u8; 1];
        f.read_exact_at(&mut b, s1 - 1).ok()?;
        if b == *b"\n" {
            Some(s1)
        } else {
            let (piece, next) = rest_of_line(&f, s1, size)?;
            if let Some(a) = verdict(judge_wide_line(&piece, &names, &finders)) {
                return Some(a);
            }
            next
        }
    };
    let Some(n1) = n1 else { return Some(Ok(false)) };
    let key = format!("{path}\0{wide}");
    let fresh = || WideKept { gen_: defaults::generation(), dev: m.dev(), ino: m.ino(), from: n1, to: n1, head: 0, back: 0, decisive: VecDeque::new() };
    let mut k = match wide_cache().remove(&key) {
        Some(k) => match wide_miss(&k, &f, &m, n1) {
            None => {
                crate::load::note_count("tasks_cache", "result", if size == k.to { "hit" } else { "extend" });
                k
            }
            Some(reason) => {
                crate::load::note_count("tasks_cache", "result", "rebuild");
                crate::load::note_count("tasks_cache_rebuild", "reason", reason);
                fresh()
            }
        },
        None => {
            crate::load::note_count("tasks_cache", "result", "rebuild");
            crate::load::note_count("tasks_cache_rebuild", "reason", "none");
            fresh()
        }
    };
    while k.decisive.front().is_some_and(|d| d.0 < n1) {
        k.decisive.pop_front();
    }
    k.from = n1;
    // judge what was appended, a chunk at a time: the complete lines for good, a last line without its newline now only
    let chunk = defaults::num("transcript.evidence_read_chunk_bytes").max(1);
    let mut carry: Vec<u8> = Vec::new();
    let mut buf: Vec<u8> = Vec::new();
    let mut pos = k.to;
    while pos < size {
        let n = chunk.min(size - pos) as usize;
        buf.resize(n, 0);
        f.read_exact_at(&mut buf, pos).ok()?;
        crate::load::note_scan(n as u64);
        let mut at = 0usize;
        while let Some(i) = buf.get(at..).and_then(|r| r.iter().position(|b| *b == b'\n')) {
            let seg = buf.get(at..at + i)?;
            let line = if carry.is_empty() { seg.to_vec() } else { [carry.as_slice(), seg].concat() };
            if let Some(d) = judge_wide_line(&line, &names, &finders) {
                k.decisive.push_back((k.to, d));
            }
            k.to += line.len() as u64 + 1;
            carry.clear();
            at += i + 1;
        }
        carry.extend_from_slice(buf.get(at..)?);
        pos += n as u64;
    }
    let pending = if carry.is_empty() { None } else { judge_wide_line(&carry, &names, &finders) };
    let answer = k.decisive.front().map(|d| d.1).or(pending);
    let fp = defaults::num("transcript.evidence_fingerprint_bytes").max(1);
    let n = fp.min(k.to - k.from);
    let w_bytes = std::mem::size_of::<WideKept>() + k.decisive.len() * std::mem::size_of::<(u64, Decisive)>();
    if w_bytes as u64 <= defaults::num("transcript.tasks_cache_entry_max_bytes")
        && let (Some(head), Some(back)) = (digest_at(&f, k.from, n), digest_at(&f, k.to - n, n))
    {
        k.head = head;
        k.back = back;
        let ttl = defaults::num("transcript.tasks_cache_idle_ms");
        let exp = (ttl > 0).then(|| crate::health::now_ms().saturating_add(ttl));
        wide_cache().insert_with_ttl(key, k, w_bytes, exp);
    }
    Some(verdict(answer).unwrap_or(Ok(false)))
}

/// (entries kept, their estimated bytes) for the memory snapshot.
pub fn usage() -> (usize, u64) {
    let (c, w) = (cache(), wide_cache());
    (c.len() + w.len(), (c.bytes() + w.bytes()) as u64)
}

#[cfg(test)]
mod tests {
    use super::super::host_d::{transcript_tasks, transcript_tasks_uncached};
    use crate::defaults;
    use serde_json::json;
    use std::io::Write;

    fn path(tag: &str) -> String {
        std::env::temp_dir().join(format!("ah-tkcache-{tag}-{}", std::process::id())).to_string_lossy().into_owned()
    }

    /// One transcript line of kind `i % 16`: task calls and their results mixed with lines that mean nothing to a reconstruction.
    fn line(i: usize) -> String {
        let pad = "x".repeat(i % 97);
        let n = i / 16;
        let v = match i % 16 {
            0 => {
                json!({"type": "assistant", "timestamp": "2026-10-16T08:00:00.000Z", "message": {"id": format!("m{n}"), "role": "assistant", "content": [{"type": "tool_use", "id": format!("c{n}"), "name": "TaskCreate", "input": {"subject": format!("task {n} {pad}"), "priority": if n.is_multiple_of(3) { "P1" } else { "low" }}}]}})
            }
            1 => {
                json!({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": format!("c{n}"), "content": format!("Task #{} created successfully: task", n + 1)}]}})
            }
            2 => {
                json!({"type": "assistant", "timestamp": "2026-10-16T08:01:00.000Z", "message": {"id": format!("u{n}"), "role": "assistant", "content": [{"type": "tool_use", "id": format!("u{n}"), "name": "TaskUpdate", "input": {"taskId": format!("{}", n + 1), "status": if n.is_multiple_of(2) { "in_progress" } else { "completed" }, "owner": "bob"}}]}})
            }
            3 => {
                json!({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": format!("u{n}"), "content": if n % 5 == 4 { "Task #99 not found".to_string() } else { format!("Updated {pad}") }}]}})
            }
            4 => {
                json!({"type": "assistant", "message": {"id": format!("b{n}"), "role": "assistant", "content": [{"type": "tool_use", "id": format!("b{n}"), "name": "Bash", "input": {"command": format!("echo {n} {pad}")}}]}})
            }
            5 => {
                json!({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": format!("b{n}"), "content": format!("out {pad}")}]}})
            }
            6 => {
                json!({"type": "assistant", "message": {"id": format!("l{n}"), "role": "assistant", "content": [{"type": "tool_use", "id": format!("l{n}"), "name": "TaskList", "input": {}}]}})
            }
            7 => {
                json!({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": format!("l{n}"), "content": if n % 9 == 8 { "No tasks found".to_string() } else { format!("#1 task {pad}") }}]}})
            }
            8 => {
                json!({"type": "assistant", "message": {"id": format!("w{n}"), "role": "assistant", "content": [{"type": "tool_use", "id": format!("w{n}"), "name": "TodoWrite", "input": {"todos": [{"content": format!("todo {n}"), "status": "pending"}, {"content": "second", "status": "in_progress"}]}}]}})
            }
            9 => {
                json!({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": format!("zz{n}"), "content": [{"type": "text", "text": format!("Task #{} created successfully: other", n + 40)}]}]}})
            }
            10 => {
                json!({"type": "assistant", "message": {"id": format!("g{n}"), "role": "assistant", "content": [{"type": "tool_use", "id": format!("g{n}"), "name": "TaskGet", "input": {"taskId": "7"}}]}})
            }
            11 => {
                json!({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": format!("g{n}"), "content": "Task #7 not found"}]}})
            }
            12 => json!(null),
            13 => {
                json!({"type": "assistant", "message": {"id": format!("n{n}"), "role": "assistant", "content": [{"type": "tool_use", "id": n, "name": "Read", "input": {"file_path": "/x"}}]}})
            }
            14 => json!({"type": "system", "content": format!("nothing to add {pad}")}),
            _ => {
                json!({"type": "assistant", "message": {"id": format!("r{n}"), "role": "assistant", "content": [{"type": "tool_use", "id": format!("c{n}"), "name": "Bash", "input": {"command": "reuses a task call id"}}]}})
            }
        };
        // a JSON null (line 412) and a numeric tool-use id (line 541) make the reconstructions give up while they are in the window: two lines, so most windows answer
        if matches!(i % 16, 12 | 13) && !matches!(i, 412 | 541) {
            return format!("{{\"type\":\"system\",\"content\":\"filler {i}\"}}\n");
        }
        let text = v.to_string();
        match i % 11 {
            3 => format!("{text}\r\n"),
            7 if i % 16 != 12 => format!("not json {i}\n"),
            9 => "\n".to_string(),
            _ => format!("{text}\n"),
        }
    }

    const WINDOWS: [u64; 5] = [400, 2_500, 9_000, 40_000, 1 << 20];

    fn same(p: &str, ctx: &str) {
        for w in WINDOWS {
            for variant in ["guard", "state", "scan"] {
                let a = transcript_tasks(p, variant, w as f64, (w * 4) as f64);
                let b = transcript_tasks_uncached(p, variant, w as f64, (w * 4) as f64);
                assert_eq!(a, b, "{ctx}: {variant} window {w}");
            }
        }
    }

    #[test]
    fn kept_task_lines_answer_as_a_whole_read_does_across_appends_windows_and_a_line_still_being_written() {
        let p = path("grow");
        std::fs::write(&p, "").unwrap();
        let mut f = std::fs::OpenOptions::new().append(true).open(&p).unwrap();
        let mut i = 0;
        for step in 0..70 {
            for _ in 0..(1 + step % 9) {
                f.write_all(line(i).as_bytes()).unwrap();
                i += 1;
            }
            if step % 5 == 0 {
                f.write_all(b"{\"type\":\"assistant\",\"message\":{\"id\":\"half\",\"content\":[{\"type\":\"tool_use\",\"id\":\"hh\",\"name\":\"TaskCreate\",\"input\":{\"subject\":\"half a").unwrap();
                same(&p, &format!("step {step} partial"));
                f.write_all(b" line\"}}]}}\n").unwrap();
            }
            same(&p, &format!("step {step}"));
        }
        same(&p, "idle");
        // the generator must leave most windows answerable, or the comparisons above prove little
        let a = transcript_tasks(&p, "guard", (1 << 20) as f64, 0.0);
        assert!(a.contains("\"tasks\":[{"), "the largest window holds tasks: {a}");
        crate::discard::harmless(std::fs::remove_file(&p)); // keep: cleanup; an absent file is the goal state
    }

    #[test]
    fn a_replaced_truncated_or_rewritten_file_is_read_afresh() {
        let p = path("swap");
        let build = |from: usize, n: usize| -> String { (from..from + n).map(line).collect() };
        std::fs::write(&p, build(0, 160)).unwrap();
        same(&p, "first");
        std::fs::write(&p, build(0, 40)).unwrap();
        same(&p, "truncated");
        let a = build(300, 90);
        std::fs::write(&p, &a).unwrap();
        same(&p, "other file");
        let b: String = a.chars().map(|c| if c == 'x' { 'y' } else { c }).collect();
        std::fs::write(&p, &b).unwrap();
        same(&p, "rewritten in place");
        crate::discard::harmless(std::fs::remove_file(&p)); // keep: the next write recreates it
        std::fs::write(&p, build(500, 200)).unwrap();
        same(&p, "recreated");
        crate::discard::harmless(std::fs::remove_file(&p)); // keep: cleanup; an absent file is the goal state
        same(&p, "missing");
    }

    #[test]
    fn every_tool_the_reconstructions_act_on_is_a_kept_task_tool() {
        // a name a reconstruction matches on that the list lacks would make the kept answer differ from a fresh read
        let tools = defaults::list("taskstate.task_tools");
        for name in ["TodoWrite", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet"] {
            assert!(tools.contains(&name), "{name} is acted on by the reconstructions");
        }
    }

    #[test]
    fn edge_files_and_windows_answer_as_the_whole_read_does() {
        let p = path("edge");
        let create = format!(
            "{}\n",
            json!({"type": "assistant", "message": {"id": "m", "content": [{"type": "tool_use", "id": "c", "name": "TaskCreate", "input": {"subject": "q".repeat(3000)}}]}})
        );
        let bodies: Vec<Vec<u8>> = vec![
            b"".to_vec(),
            b"\n".to_vec(),
            b"\n\n\r\n".to_vec(),
            create.clone().into_bytes(),
            [create.as_bytes(), b"\xff\xfe not utf8\n", create.as_bytes()].concat(),
            format!("{}{}", create.trim_end(), "").into_bytes(),
        ];
        for (i, body) in bodies.iter().enumerate() {
            std::fs::write(&p, body).unwrap();
            for w in [1u64, 100, 2_999, 3_000, 3_100, 10_000, 1 << 20] {
                for variant in ["guard", "state", "scan"] {
                    assert_eq!(
                        transcript_tasks(&p, variant, w as f64, (w * 2) as f64),
                        transcript_tasks_uncached(&p, variant, w as f64, (w * 2) as f64),
                        "body {i}: {variant} window {w}"
                    );
                }
            }
        }
        crate::discard::harmless(std::fs::remove_file(&p)); // keep: cleanup; an absent file is the goal state
    }

    #[test]
    fn the_second_call_reads_only_what_was_appended() {
        let p = path("bytes");
        let body: String = (0..4000).map(line).collect();
        std::fs::write(&p, &body).unwrap();
        let w = 200_000u64;
        // the cache is shared with the tests running beside this one, which can evict the entry between the two calls: ask again
        let mut last = String::new();
        let mut ok = false;
        for round in 0..5 {
            crate::load::take_scan();
            let _ = transcript_tasks(&p, "guard", w as f64, 0.0);
            let first = crate::load::take_scan();
            let mut f = std::fs::OpenOptions::new().append(true).open(&p).unwrap();
            let more: String = (4000 + round * 12..4012 + round * 12).map(line).collect();
            f.write_all(more.as_bytes()).unwrap();
            let _ = transcript_tasks(&p, "guard", w as f64, 0.0);
            let second = crate::load::take_scan();
            // the boundary search and the digests read a little; the window is not read again
            if second < more.len() as u64 + 20_000 {
                ok = true;
                break;
            }
            last = format!("round {round}: first {first}, second {second} for {} appended", more.len());
        }
        assert!(ok, "the second call kept reading its window: {last}");
        crate::discard::harmless(std::fs::remove_file(&p)); // keep: cleanup; an absent file is the goal state
    }

    /// Mostly lines that name no task tool; a few that do, one that only mentions one, and some JSON a parser may read oddly.
    fn wide_line(i: usize) -> String {
        let pad = "y".repeat(i % 131);
        match i {
            _ if i % 97 == 41 => format!(
                "{}\n",
                json!({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": format!("t{i}"), "name": "TaskUpdate", "input": {"taskId": "1"}}]}})
            ),
            _ if i % 53 == 7 => format!("{}\n", json!({"type": "user", "message": {"content": format!("please run TaskCreate later {pad}")}})),
            _ if i % 61 == 5 => format!("TaskCreate but not json {pad}\r\n"),
            _ if i % 23 == 3 => "\n".to_string(),
            _ => format!("{}\n", json!({"type": "assistant", "message": {"content": [{"type": "text", "text": format!("filler {i} {pad}")}]}})),
        }
    }

    fn wide_same(p: &str, ctx: &str) {
        for w in [60u64, 300, 2_000, 9_000, 40_000, 1 << 20] {
            let a = super::wide_activity(p, w);
            let b = crate::checks::taskstate::scanview::has_task_activity_in_file_uncached(p, w);
            assert_eq!(a.map(|r| r.ok()), b.map(|r| r.ok()), "{ctx}: wide window {w}");
        }
    }

    #[test]
    fn the_widened_search_answers_as_a_whole_read_does_across_appends_and_a_line_still_being_written() {
        let p = path("wide");
        std::fs::write(&p, "").unwrap();
        let mut f = std::fs::OpenOptions::new().append(true).open(&p).unwrap();
        let mut i = 0;
        let mut seen = std::collections::BTreeSet::new();
        for step in 0..120 {
            for _ in 0..(1 + step % 13) {
                f.write_all(wide_line(i).as_bytes()).unwrap();
                i += 1;
            }
            if step % 4 == 0 {
                f.write_all(b"{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"id\":\"h\",\"name\":\"TaskCr").unwrap();
                wide_same(&p, &format!("step {step} partial"));
                f.write_all(b"eate\",\"input\":{}}]}}\n").unwrap();
            }
            wide_same(&p, &format!("step {step}"));
            for w in [60u64, 300, 2_000, 9_000, 40_000, 1 << 20] {
                seen.insert(super::wide_activity(&p, w).map(|r| r.ok()));
            }
        }
        assert!(seen.contains(&Some(Some(true))) && seen.contains(&Some(Some(false))), "both answers occur: {seen:?}");
        crate::discard::harmless(std::fs::remove_file(&p)); // keep: cleanup; an absent file is the goal state
    }

    #[test]
    fn the_widened_search_after_a_replaced_or_shorter_file() {
        let p = path("wideswap");
        let build = |from: usize, n: usize| -> String { (from..from + n).map(wide_line).collect() };
        std::fs::write(&p, build(0, 600)).unwrap();
        wide_same(&p, "first");
        std::fs::write(&p, build(0, 90)).unwrap();
        wide_same(&p, "truncated");
        let a = build(1000, 300);
        std::fs::write(&p, &a).unwrap();
        wide_same(&p, "other file");
        std::fs::write(&p, a.replace('y', "z")).unwrap();
        wide_same(&p, "rewritten in place");
        crate::discard::harmless(std::fs::remove_file(&p)); // keep: cleanup; an absent file is the goal state
        wide_same(&p, "missing");
    }

    #[test]
    fn concurrent_calls_on_one_transcript_agree() {
        let p = path("conc");
        let body: String = (0..2500).map(line).collect();
        std::fs::write(&p, &body).unwrap();
        let want = transcript_tasks_uncached(&p, "guard", 120_000.0, 0.0);
        let handles: Vec<_> = (0..8)
            .map(|_| {
                let p = p.clone();
                std::thread::spawn(move || (0..20).map(|_| transcript_tasks(&p, "guard", 120_000.0, 0.0)).collect::<Vec<_>>())
            })
            .collect();
        for h in handles {
            for got in h.join().unwrap() {
                assert_eq!(got, want);
            }
        }
        crate::discard::harmless(std::fs::remove_file(&p)); // keep: cleanup; an absent file is the goal state
    }
}
