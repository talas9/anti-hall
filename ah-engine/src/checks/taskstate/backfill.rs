//! Recover the state and subject of tasks whose records sit before the transcript window: a port of
//! `lib/task-subject-backfill.js` `backfillSubjects`.
//!
//! Node scans backward from the window start in 1 MiB chunks, stopping after 64 MiB or 150 ms of wall clock. The engine
//! cannot reproduce a wall-clock stop, so it scans a fixed number of bytes ([`defaults`] `taskstate.backfill_exact_bytes`)
//! and returns [`Unsure`] when the search would need more: where Node would have stopped on its clock the answer is not
//! the engine's to give.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an absent field is the empty value
// - an unreadable optional file is the same as an absent one (fail-open, as Node's try/catch)
// A failure that must be seen goes through `crate::discard` instead.

use super::parse::{Facts, is_list_empty, is_not_found};
use super::{Task, norm_blocked_by, number_of_digits};
use crate::checks::guardkit::jsre;
use crate::checks::guardkit::text::{js_trim, slice_utf16};
use crate::checks::taskkit::jsval::{R, Unsure, get, scalar_string, truthy};
use crate::defaults;
use regex::Regex;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::io::{Read, Seek, SeekFrom};

struct Res {
    terminal: Regex,
    created: Regex,
}

fn res() -> &'static Res {
    static R: crate::defaults::Cache<Res> = crate::defaults::Cache::new();
    R.get_or_init(|| Res {
        terminal: jsre::compile(defaults::text("taskstate.terminal_status_re"), true),
        created: jsre::compile(defaults::text("taskstate.re_created"), true),
    })
}

fn terminal(s: &str) -> bool {
    res().terminal.is_match(s)
}

#[derive(Default)]
struct Found {
    status: bool,
    owner: bool,
    blocked_by: bool,
    blocked_on: bool,
    subject: bool,
}

struct Rec {
    need_status: bool,
    f: Found,
    st: Option<String>,
    own: String,
    bo: Option<Value>,
    bb: Vec<String>,
    adds: Vec<String>,
    subject: String,
    cr: bool,
    ab: bool,
    done: bool,
}

impl Rec {
    fn new(need_status: bool) -> Rec {
        Rec {
            need_status,
            f: Found::default(),
            st: None,
            own: String::new(),
            bo: None,
            bb: Vec::new(),
            adds: Vec::new(),
            subject: String::new(),
            cr: false,
            ab: false,
            done: false,
        }
    }
}

struct Need {
    subject: bool,
    status: bool,
    owner: bool,
    blocked_by: bool,
    blocked_on: bool,
}

fn blocked_on_of(inp: &Value) -> Option<Value> {
    super::create_blocked_on(inp)
}

/// `subjectOf(inp)`: the first truthy of subject, title, content and description when it is a string (trimmed and cut), else
/// empty.
fn subject_of(inp: &Value) -> R<String> {
    let v = crate::checks::taskkit::jsval::first_truthy(&[get(inp, "subject"), get(inp, "title"), get(inp, "content"), get(inp, "description")]);
    match v {
        Some(Value::String(s)) => slice_utf16(js_trim(s), defaults::num("taskstate.backfill_max_subject") as usize).ok_or(Unsure),
        _ => Ok(String::new()),
    }
}

fn rec_update(rec: &mut Rec, inp: &Value) -> R<()> {
    if !rec.f.status
        && let Some(s) = get(inp, "status").filter(|v| truthy(v))
    {
        rec.f.status = true;
        let Value::String(text) = s else { return Err(Unsure) };
        let text = text.clone();
        if rec.need_status && terminal(&text) {
            rec.done = true;
        }
        rec.st = Some(text);
    }
    if !rec.f.owner
        && let Some(o) = get(inp, "owner")
    {
        rec.f.owner = true;
        rec.own = match o {
            Value::String(s) => js_trim(s).to_string(),
            _ => String::new(),
        };
    }
    if !rec.f.blocked_on && super::has_blocked_on_update(inp) {
        rec.f.blocked_on = true;
        rec.bo = blocked_on_of(inp);
    }
    if !rec.f.blocked_by {
        if let Some(b) = get(inp, "blockedBy") {
            rec.f.blocked_by = true;
            let mut bb = norm_blocked_by(Some(b))?;
            if let Some(add) = get(inp, "addBlockedBy") {
                bb.extend(norm_blocked_by(Some(add))?);
            }
            rec.bb = bb;
        } else if let Some(add) = get(inp, "addBlockedBy") {
            for x in norm_blocked_by(Some(add))? {
                if !rec.adds.contains(&x) {
                    rec.adds.push(x);
                }
            }
        }
    }
    if !rec.f.subject
        && let Some(Value::String(s)) = get(inp, "subject")
        && !js_trim(s).is_empty()
    {
        rec.f.subject = true;
        rec.subject = slice_utf16(js_trim(s), defaults::num("taskstate.backfill_max_subject") as usize).ok_or(Unsure)?;
    }
    Ok(())
}

fn rec_create(rec: &mut Rec, inp: &Value) -> R<()> {
    if !rec.f.status {
        rec.f.status = true;
        rec.st = Some(super::truthy_status(get(inp, "status"))?.unwrap_or_else(|| "pending".to_string()));
    }
    if !rec.f.owner {
        rec.f.owner = true;
        rec.own = match get(inp, "owner") {
            Some(Value::String(s)) => js_trim(s).to_string(),
            _ => String::new(),
        };
    }
    if !rec.f.blocked_on {
        rec.f.blocked_on = true;
        rec.bo = blocked_on_of(inp);
    }
    if !rec.f.blocked_by {
        rec.f.blocked_by = true;
        rec.bb = norm_blocked_by(get(inp, "blockedBy"))?;
    }
    let s = subject_of(inp)?;
    if !rec.f.subject && !s.is_empty() {
        rec.f.subject = true;
        rec.subject = s;
    }
    rec.cr = true;
    rec.done = true;
    Ok(())
}

/// Apply a recovered record to a task, only for the fields it is missing (`applyRec`).
fn apply_rec(task: &mut Task, need: &Need, rec: &Rec) {
    if rec.ab {
        if need.status && !rec.f.status {
            task.status = Some("deleted".to_string());
        }
        return;
    }
    if need.status {
        task.status = if rec.f.status { rec.st.clone() } else { None };
    }
    if terminal(task.status.as_deref().unwrap_or("")) {
        return;
    }
    let mut unresolved = false;
    let dflt = rec.cr;
    if need.owner {
        if rec.f.owner {
            task.owner = rec.own.clone();
        } else if dflt {
            task.owner = String::new();
        } else {
            unresolved = true;
        }
    }
    if need.blocked_on {
        if rec.f.blocked_on {
            task.blocked_on = rec.bo.clone();
        } else if dflt {
            task.blocked_on = None;
        } else {
            unresolved = true;
        }
    }
    if need.blocked_by {
        let mut merged: Vec<String> = Vec::new();
        let base: Vec<&String> = if rec.f.blocked_by {
            rec.bb.iter().collect()
        } else if dflt {
            Vec::new()
        } else {
            vec![]
        };
        if rec.f.blocked_by || dflt {
            for id in base.into_iter().chain(rec.adds.iter()).chain(task.blocked_by.iter()) {
                if !merged.contains(id) {
                    merged.push(id.clone());
                }
            }
            task.blocked_by = merged;
        } else {
            unresolved = true;
        }
    }
    if need.subject && rec.f.subject {
        task.content = rec.subject.clone();
    }
    if unresolved {
        task.block_unknown = true;
    }
}

/// One classified transcript line.
#[derive(Default)]
struct Line {
    msg_id: Option<String>,
    cands: Vec<(String, f64)>,
    resets: Vec<(String, &'static [&'static str])>,
    calls: Vec<(String, String, Option<String>)>,
    creates: Vec<(String, Value)>,
    updates: Vec<(String, Value, Option<String>)>,
    todo: bool,
}

fn text_of(c: Option<&Value>) -> String {
    match c {
        Some(Value::Array(a)) => a.iter().map(|p| get(p, "text").and_then(Value::as_str).unwrap_or("")).collect(),
        Some(Value::String(s)) => s.clone(),
        _ => String::new(),
    }
}

fn id_of(inp: &Value) -> R<Option<String>> {
    match defaults::list("taskstate.id_keys").iter().find_map(|k| get(inp, k).filter(|v| !v.is_null())) {
        Some(v) => Ok(Some(scalar_string(v)?)),
        None => Ok(None),
    }
}

fn classify(line: &str) -> R<Line> {
    let mut r = Line::default();
    let entry: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => {
            // Same rule as the window parser: a line JavaScript might still parse is not ours to skip.
            return if super::parse::maybe_valid_for_js(line) { Err(Unsure) } else { Ok(r) };
        }
    };
    if entry.is_null() || get(&entry, "isSidechain") == Some(&Value::Bool(true)) {
        return Ok(r);
    }
    let msg = get(&entry, "message");
    r.msg_id = msg.and_then(|m| get(m, "id")).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string);
    let content = msg.and_then(|m| get(m, "content")).and_then(Value::as_array);
    let ty = get(&entry, "type").and_then(Value::as_str).unwrap_or("");
    for it in content.into_iter().flatten() {
        if !truthy(it) {
            continue;
        }
        let it_ty = get(it, "type").and_then(Value::as_str).unwrap_or("");
        if ty == "user" && it_ty == "tool_result" && get(it, "tool_use_id").is_some_and(Value::is_string) {
            let id = get(it, "tool_use_id").and_then(Value::as_str).unwrap_or("").to_string();
            let txt = text_of(get(it, "content"));
            if let Some(m) = res().created.captures(&txt) {
                r.cands.push((id, number_of_digits(m.get(1).map_or("", |g| g.as_str()))));
            } else if is_list_empty(&txt) {
                r.resets.push((id, &["TaskList"]));
            } else if is_not_found(&txt) {
                r.resets.push((id, &["TaskGet", "TaskUpdate"]));
            }
        } else if ty == "assistant" && it_ty == "tool_use" {
            let empty = Value::Object(serde_json::Map::new());
            let inp: &Value = match get(it, "input") {
                Some(v) if truthy(v) && v.is_object() => v,
                _ => &empty,
            };
            let name = get(it, "name").and_then(Value::as_str).unwrap_or("").to_string();
            let tid = get(it, "id").and_then(Value::as_str).map(str::to_string);
            if let Some(t) = &tid {
                r.calls.push((t.clone(), name.clone(), id_of(inp)?));
            }
            match name.as_str() {
                "TodoWrite" => r.todo = true,
                "TaskCreate" if tid.is_some() => r.creates.push((tid.clone().unwrap_or_default(), inp.clone())),
                "TaskUpdate" => {
                    if let Some(id) = id_of(inp)? {
                        r.updates.push((id, inp.clone(), tid));
                    }
                }
                _ => {}
            }
        }
    }
    Ok(r)
}

/// Read `n` bytes ending at `pos + n`.
fn read_at(f: &mut std::fs::File, pos: u64, n: usize) -> Option<Vec<u8>> {
    let mut buf = vec![0u8; n];
    f.seek(SeekFrom::Start(pos)).ok()?;
    f.read_exact(&mut buf).ok()?;
    Some(buf)
}

/// End (exclusive offset) of the line that straddles the window start, or `None`.
fn prefix_end_of(f: &mut std::fs::File, start: u64) -> Option<u64> {
    let step = 256 * 1024usize;
    let mut pos = start;
    let mut read = 0u64;
    while read < defaults::num("taskstate.backfill_prefix_scan_bytes") {
        f.seek(SeekFrom::Start(pos)).ok()?;
        let mut buf = vec![0u8; step];
        let got = f.read(&mut buf).ok()?;
        if got == 0 {
            return None;
        }
        if let Some(i) = buf[..got].iter().position(|b| *b == b'\n') {
            return Some(pos + i as u64 + 1);
        }
        pos += got as u64;
        read += step as u64;
    }
    None
}

/// `backfillSubjects(taskMap, transcriptPath, { windowReset, firstCreated })`: mutates `facts.tasks` in place.
pub fn backfill(facts: &mut Facts, path: &str, window: u64) -> R<()> {
    if facts.window_reset {
        return Ok(());
    }
    let first = facts.first_created;
    let mut wanted: Vec<(String, Need)> = Vec::new();
    for t in facts.tasks.values() {
        if !super::is_digits(&t.id) {
            continue;
        }
        if terminal(t.status.as_deref().unwrap_or("")) {
            continue;
        }
        if number_of_digits(&t.id) >= first {
            continue;
        }
        let u = t.unknown.unwrap_or_default();
        let need = Need { subject: t.content == t.id, status: u.status, owner: u.owner, blocked_by: u.blocked_by, blocked_on: u.blocked_on };
        if need.subject || need.status || need.owner || need.blocked_by || need.blocked_on {
            // `wanted` is a Map keyed by the number: a later task with the same number replaces the value in place.
            match wanted.iter_mut().find(|(id, _)| number_of_digits(id) == number_of_digits(&t.id)) {
                Some(slot) => *slot = (t.id.clone(), need),
                None => wanted.push((t.id.clone(), need)),
            }
        }
    }
    if wanted.is_empty() {
        return Ok(());
    }
    let size = std::fs::metadata(path).map_err(|_| Unsure)?.len();
    let win = window;
    if size <= win {
        return Ok(());
    }
    let start = size - win;
    let mut recs: HashMap<u64, Rec> = HashMap::new();
    let key = |id: &str| number_of_digits(id) as u64;
    for (id, need) in &wanted {
        recs.insert(key(id), Rec::new(need.status));
    }
    let mut f = std::fs::File::open(path).map_err(|_| Unsure)?;
    let Some(mut pos) = prefix_end_of(&mut f, start) else {
        // Node returns without applying anything when the straddling line's end is not found (`pos <= 0`).
        return Err(Unsure);
    };
    let chunk = defaults::num("taskstate.backfill_chunk_bytes") as usize;
    let max_scan = defaults::num("taskstate.backfill_exact_bytes");
    let max_cands = defaults::num("taskstate.backfill_max_candidates") as usize;
    let mut min_created = first;
    let mut group_id: Option<String> = None;
    let mut group_base = first;
    let mut cands: Vec<(String, f64)> = Vec::new();
    let mut reset_cands: Vec<(String, &'static [&'static str])> = Vec::new();
    let mut failed: HashSet<String> = HashSet::new();
    let mut carry: Vec<u8> = Vec::new();
    let mut scanned = 0u64;
    let mut stopped = false;
    let mut exhausted = true;
    let pending = |recs: &HashMap<u64, Rec>| recs.values().filter(|r| !r.done).count();
    while pos > 0 && !stopped {
        if pending(&recs) == 0 {
            exhausted = false;
            break;
        }
        if scanned >= max_scan {
            return Err(Unsure);
        }
        let n = (chunk as u64).min(pos) as usize;
        pos -= n as u64;
        scanned += n as u64;
        let Some(buf) = read_at(&mut f, pos, n) else { return Err(Unsure) };
        let mut comb = buf;
        comb.extend_from_slice(&carry);
        let body: &[u8];
        if pos > 0 {
            let Some(i) = comb.iter().position(|b| *b == b'\n') else {
                carry = comb;
                continue;
            };
            carry = comb[..i].to_vec();
            body = &comb[i + 1..];
        } else {
            body = &comb;
        }
        let text = String::from_utf8_lossy(body).into_owned();
        let lines: Vec<&str> = text.split('\n').collect();
        for line in lines.iter().rev() {
            if stopped {
                break;
            }
            if !line.contains("Task") && !line.contains("TodoWrite") && !line.contains(defaults::text("taskstate.no_tasks_marker")) {
                continue;
            }
            let r = classify(line)?;
            for c in r.cands {
                if cands.len() >= max_cands {
                    cands.remove(0);
                }
                match cands.iter_mut().find(|(k, _)| *k == c.0) {
                    Some(slot) => *slot = c,
                    None => cands.push(c),
                }
            }
            for x in r.resets {
                if reset_cands.len() >= max_cands {
                    reset_cands.remove(0);
                }
                match reset_cands.iter_mut().find(|(k, _)| *k == x.0) {
                    Some(slot) => *slot = x,
                    None => reset_cands.push(x),
                }
            }
            if r.todo {
                stopped = true;
                break;
            }
            for (cid, cname, ctask) in &r.calls {
                let Some((_, tools)) = reset_cands.iter().find(|(k, _)| k == cid) else { continue };
                if !tools.contains(&cname.as_str()) {
                    continue;
                }
                if cname == "TaskList" {
                    stopped = true;
                    break;
                }
                failed.insert(cid.clone());
                let rec = ctask.as_ref().filter(|t| super::is_digits(t)).and_then(|t| recs.get_mut(&key(t)));
                if let Some(rec) = rec
                    && !rec.done
                {
                    rec.ab = !rec.f.status;
                    rec.done = true;
                }
            }
            if stopped {
                break;
            }
            for (uid, inp, tid) in &r.updates {
                if tid.as_ref().is_some_and(|t| failed.contains(t)) {
                    continue;
                }
                let rec = super::is_digits(uid).then(|| recs.get_mut(&key(uid))).flatten();
                if let Some(rec) = rec
                    && !rec.done
                {
                    rec_update(rec, inp)?;
                }
            }
            if !r.creates.is_empty() && !(r.msg_id.is_some() && r.msg_id == group_id) {
                group_id = r.msg_id.clone();
                group_base = min_created;
            }
            for (cid, inp) in &r.creates {
                let Some(idx) = cands.iter().position(|(k, _)| k == cid) else { continue };
                let (_, num) = cands.remove(idx);
                if num >= group_base {
                    stopped = true;
                    break;
                }
                min_created = min_created.min(num);
                if let Some(rec) = recs.get_mut(&(num as u64))
                    && !rec.done
                {
                    rec_create(rec, inp)?;
                }
            }
        }
    }
    let _ = exhausted;
    for (id, need) in &wanted {
        let rec = recs.remove(&key(id)).unwrap_or_else(|| Rec::new(need.status));
        if let Some(t) = facts.tasks.get_mut(id) {
            apply_rec(t, need, &rec);
        }
    }
    Ok(())
}
