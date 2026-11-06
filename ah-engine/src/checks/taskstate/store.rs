//! Claude Code's own task store, read the way the task guards read it (`tk.storeTasks` of `logic/lib/69-tasks.js`).
//!
//! The store is the session's task list whenever it has one: the transcript tail of a long session no longer holds the creates, and
//! an old tail disagrees with the store. Every reader of "is a task open" that sits next to a task guard must ask the store FIRST and
//! the transcript only when the session has no readable store, or it takes a list the guard still sees as open for done.
//! Layout, bounds and field names are the `taskstate.*` keys of `task_guards.toml`.
//!
//! The three switches (`store_named_list`, `store_empty_is_list`, `named_list_scope`) are read as shipped, as the logic scripts read them (`ah.cfg`).
//! [`ladder`] is the one order of that lookup (named list, session directory, none), the Rust twin of `tk.storeLadder`.
//! [`session_has_open`] is the whole of that rule for a reader that only needs "is a task open": the store, else the transcript tail
//! reconstructed as task-guard reconstructs it (the `guard` variant over `taskstate.tail_bytes`), never the tasklist gate's own
//! scan, which keeps other facts and reads another window.
use crate::defaults;
use serde_json::Value;
use std::io::Read;
use std::path::Path;

/// One store directory: absent, unreadable (more than `taskstate.store_max_files` task files), or its tasks as (id, lowercase status). A
/// file that is not valid JSON, has no string status or no string/number id, or is bigger than `taskstate.store_file_max_bytes` is skipped.
enum Dir {
    Absent,
    Unreadable,
    Tasks(Vec<(String, String)>),
}

fn read_dir_tasks(dir: &Path) -> Dir {
    let suffix = defaults::text("taskstate.store_file_suffix");
    let (max_files, max_bytes) = (defaults::num("taskstate.store_max_files") as usize, defaults::num("taskstate.store_file_max_bytes"));
    let fields = defaults::raw("taskstate.store_fields");
    let (id_field, status_field) = (fields.str_field("id"), fields.str_field("status"));
    let Ok(rd) = std::fs::read_dir(dir) else { return Dir::Absent };
    let files: Vec<_> = rd
        .flatten()
        .filter(|e| e.file_name().to_str().is_some_and(|n| n.len() > suffix.len() && n.ends_with(suffix)))
        .take(max_files.saturating_add(1))
        .collect();
    if files.len() > max_files {
        return Dir::Unreadable;
    }
    let mut out = Vec::new();
    for e in files {
        let mut raw = Vec::new();
        if std::fs::File::open(e.path()).and_then(|f| f.take(max_bytes).read_to_end(&mut raw)).is_err() {
            continue;
        }
        let Ok(rec) = serde_json::from_str::<Value>(&String::from_utf8_lossy(&raw)) else { continue };
        let id = match rec.get(id_field) {
            Some(Value::String(s)) => s.clone(),
            Some(Value::Number(n)) => n.to_string(),
            _ => continue,
        };
        if let Some(status) = rec.get(status_field).and_then(Value::as_str) {
            out.push((id, status.to_lowercase()));
        }
    }
    Dir::Tasks(out)
}

/// What the store ladder found: the tasks of the list as (id, lowercase status), and whether it is a NAMED list (shared by every session
/// that selects it).
pub struct Found {
    /// The list is a named one, shared by every session that selects it.
    pub shared: bool,
    /// Its tasks as (id, lowercase status).
    pub tasks: Vec<(String, String)>,
}

/// The store ladder every reader of Claude Code's task store shares (`tk.storeLadder` of `logic/lib/69-tasks.js`), in this order:
/// 1. the NAMED list: `list_id` (the value of `taskstate.list_id_env`) is a valid id (`taskstate.list_id_re`) whose directory exists, even
///    when empty (`taskstate.store_named_list` is its kill switch);
/// 2. the session's own directory (`taskstate.store_dir_names`): the first that holds a task, else, with `taskstate.store_empty_is_list`,
///    any that exists (empty means no tasks);
/// 3. `None`: the session has no readable store (no home, a session id with a character outside `[A-Za-z0-9_-]`, no directory, more than
///    `taskstate.store_max_files` task files), and the transcript answers.
pub fn ladder(home: &str, session: &str, list_id: Option<&str>) -> Option<Found> {
    if home.is_empty() {
        return None;
    }
    let base = defaults::list("taskstate.store_base").into_iter().fold(Path::new(home).to_path_buf(), |p, part| p.join(part));
    if defaults::shipped("taskstate.store_named_list").as_bool() == Some(true)
        && let Some(id) = list_id
        && regex::Regex::new(defaults::text("taskstate.list_id_re")).is_ok_and(|re| re.is_match(id))
        && base.join(id).is_dir()
    {
        match read_dir_tasks(&base.join(id)) {
            Dir::Tasks(tasks) => return Some(Found { shared: true, tasks }),
            // an unreadable named list falls through to the session's directory, as the guards do
            Dir::Absent | Dir::Unreadable => {}
        }
    }
    if session.is_empty() || !session.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_')) {
        return None;
    }
    let sid8: String = session.chars().take(8).collect();
    let mut seen = false;
    for name in defaults::list("taskstate.store_dir_names") {
        match read_dir_tasks(&base.join(defaults::fill(name, &[("sid", &session), ("sid8", &sid8)]))) {
            Dir::Absent => {}
            Dir::Unreadable => return None,
            Dir::Tasks(tasks) => {
                seen = true;
                if !tasks.is_empty() {
                    return Some(Found { shared: false, tasks });
                }
            }
        }
    }
    (seen && defaults::shipped("taskstate.store_empty_is_list").as_bool() == Some(true)).then(|| Found { shared: false, tasks: Vec::new() })
}

/// Whether the session's task store holds an open task (`taskstate.open_statuses`): `None` when the session has no readable store (see
/// [`ladder`]), so the transcript answers. A shared named list is the whole list here (see [`session_has_open`] for the session's share).
pub fn has_open(home: &str, session: &str) -> Option<bool> {
    let open = defaults::list("taskstate.open_statuses");
    ladder(home, session, None).map(|f| f.tasks.iter().any(|(_, s)| open.contains(&s.as_str())))
}

/// Whether the session has an open task, in the list task-guard reads: the task store when the session has a readable one, else the
/// transcript tail's reconstruction (`None`: neither can be read, or the reconstruction is not sure and shows no open task, which the
/// guard also leaves undecided). A NAMED list is shared by every session that selects it: with `taskstate.named_list_scope` `session`
/// (the default) only the ids the transcript tail knows count, with the state the named list gives them; `list` counts the whole list.
pub fn session_has_open(home: &str, session: Option<&str>, transcript: Option<&str>, list_id: Option<&str>) -> Option<bool> {
    let open = defaults::list("taskstate.open_statuses");
    let found = ladder(home, session.unwrap_or(""), list_id);
    if let Some(f) = &found
        && (!f.shared || defaults::shipped("taskstate.named_list_scope").as_str() == Some("list"))
    {
        return Some(f.tasks.iter().any(|(_, s)| open.contains(&s.as_str())));
    }
    let path = transcript.filter(|t| !t.is_empty())?;
    let Some(f) = found else { return crate::script::host_d::guard_open_tasks(path, defaults::num("taskstate.tail_bytes")) };
    let known = crate::script::host_d::guard_task_ids(path, defaults::num("taskstate.tail_bytes"))?;
    Some(f.tasks.iter().any(|(id, s)| known.contains(id) && open.contains(&s.as_str())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn home(tag: &str) -> PathBuf {
        let h = std::env::temp_dir().join(format!("ah-store-{tag}-{}", std::process::id()));
        crate::discard::harmless(std::fs::remove_dir_all(&h));
        std::fs::create_dir_all(&h).unwrap();
        h
    }
    fn put(h: &Path, dir: &str, file: &str, body: &str) {
        let d = h.join(".claude/tasks").join(dir);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join(file), body).unwrap();
    }
    fn task(status: &str) -> String {
        format!(r#"{{"id":"1","subject":"x","status":"{status}"}}"#)
    }
    fn open(h: &Path, sid: &str) -> Option<bool> {
        has_open(h.to_str().unwrap(), sid)
    }

    #[test]
    fn a_store_is_found_under_either_directory_name_and_open_means_the_open_statuses() {
        let h = home("names");
        put(&h, "session-0a1b2c3d", "1.json", &task("pending"));
        put(&h, "0a1b2c3d-1111-2222", "1.json", &task("completed"));
        assert_eq!(open(&h, "0a1b2c3d-1111-2222"), Some(true), "`session-<first 8>` is tried first");
        assert_eq!(open(&h, "0a1b2c3d"), Some(true), "a session id of 8 characters is its own first 8");
        put(&h, "session-ffffffff", "1.json", &task("In_Progress"));
        assert_eq!(open(&h, "ffffffff-x"), Some(true), "any letter case, in_progress is open");
        put(&h, "session-eeeeeeee", "1.json", &task("cancelled"));
        put(&h, "session-eeeeeeee", "2.json", &task("COMPLETED"));
        assert_eq!(open(&h, "eeeeeeee"), Some(false), "a store of finished tasks is a store: nothing is open");
        crate::discard::harmless(std::fs::remove_dir_all(&h));
    }

    #[test]
    fn a_session_without_a_readable_store_has_no_answer_and_the_transcript_decides() {
        let h = home("absent");
        assert_eq!(open(&h, "s1"), None, "no store directory");
        put(&h, "session-s1", "1.json", "{not json");
        put(&h, "session-s1", "2.json", r#"{"id":"2","subject":"x","status":3}"#);
        put(&h, "session-s1", "3.json", r#"{"subject":"x","status":"pending"}"#);
        put(&h, "session-s1", "4.json", "[1]");
        put(&h, "session-s1", "5.json.tmp", &task("pending"));
        put(&h, "session-s1", ".lock", &task("pending"));
        assert_eq!(open(&h, "s1"), None, "files that are not tasks make no store");
        assert_eq!(open(&h, ""), None);
        assert_eq!(has_open("", "s1"), None);
        put(&h, "session-s1", "6.json", &task("pending"));
        assert_eq!(open(&h, "s1"), Some(true), "one task among the junk is the store");
        crate::discard::harmless(std::fs::remove_dir_all(&h));
    }

    #[test]
    fn a_session_id_with_a_character_the_guards_do_not_look_up_has_no_store() {
        let h = home("sid");
        for sid in ["s.1", "s 1", "s/1", "../s1", "sé1"] {
            put(&h, &format!("session-{sid}"), "1.json", &task("pending"));
            put(&h, sid, "1.json", &task("pending"));
            assert_eq!(open(&h, sid), None, "{sid:?}");
        }
        crate::discard::harmless(std::fs::remove_dir_all(&h));
    }

    #[test]
    fn a_numeric_id_is_a_task_and_a_file_over_the_byte_cap_is_skipped() {
        let h = home("bytes");
        put(&h, "session-s1", "1.json", r#"{"id":1,"subject":"x","status":"pending"}"#);
        assert_eq!(open(&h, "s1"), Some(true));
        let big = format!(r#"{{"id":"2","subject":"{}","status":"pending"}}"#, "y".repeat(defaults::num("taskstate.store_file_max_bytes") as usize));
        put(&h, "session-s2", "1.json", &big);
        assert_eq!(open(&h, "s2"), None, "the only file is too big: no store");
        crate::discard::harmless(std::fs::remove_dir_all(&h));
    }

    #[test]
    fn a_directory_over_the_file_cap_is_absent_not_a_partial_list() {
        let h = home("many");
        let max = defaults::num("taskstate.store_max_files") as usize;
        let d = h.join(".claude/tasks/session-s1");
        std::fs::create_dir_all(&d).unwrap();
        for n in 0..=max {
            std::fs::write(d.join(format!("{n}.json")), task("completed")).unwrap();
        }
        std::fs::write(d.join("zz.json"), task("pending")).unwrap();
        put(&h, "s1", "1.json", &task("pending"));
        assert_eq!(open(&h, "s1"), None, "the guards read it as absent and do not try the next name either");
        crate::discard::harmless(std::fs::remove_dir_all(&h));
    }

    fn rec(id: &str, status: &str) -> String {
        format!(r#"{{"id":"{id}","subject":"x","status":"{status}"}}"#)
    }
    fn transcript(h: &Path, name: &str, ids: &[&str]) -> String {
        let mut t = String::new();
        for id in ids {
            t.push_str(&format!(
                "{}\n{}\n",
                serde_json::json!({"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":format!("c{id}"),"name":"TaskCreate","input":{"subject":"s"}}]}}),
                serde_json::json!({"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":format!("c{id}"),"content":format!("Task #{id} created successfully: s")}]}})
            ));
        }
        let p = h.join(name);
        std::fs::write(&p, t).unwrap();
        p.to_string_lossy().into_owned()
    }

    #[test]
    fn the_ladder_reads_the_named_list_first_even_when_empty_and_falls_through_when_it_is_missing() {
        let h = home("named");
        let hs = h.to_str().unwrap();
        put(&h, "session-s1", "1.json", &rec("1", "completed"));
        put(&h, "L", "7.json", &rec("7", "pending"));
        let f = ladder(hs, "s1", Some("L")).unwrap();
        assert!(f.shared);
        assert_eq!(f.tasks, [("7".to_string(), "pending".to_string())], "the named list is THE list, not the session's directory");
        for bad in ["../L", "L/x", "", ".hidden/..", "-x"] {
            assert!(!ladder(hs, "s1", Some(bad)).unwrap().shared, "{bad:?} is no list id");
        }
        assert!(!ladder(hs, "s1", Some("nolist")).unwrap().shared, "a named list without a directory falls through to the session's");
        std::fs::create_dir_all(h.join(".claude/tasks/E")).unwrap();
        let e = ladder(hs, "", Some("E")).unwrap();
        assert!(e.shared && e.tasks.is_empty(), "an empty named list is the list, with no session id too");
        assert!(ladder(hs, "", Some("nolist")).is_none());
        crate::discard::harmless(std::fs::remove_dir_all(&h));
    }

    #[test]
    fn an_empty_session_directory_is_no_store_by_default_and_a_named_list_is_read_session_scoped() {
        let h = home("scoped");
        let hs = h.to_str().unwrap();
        std::fs::create_dir_all(h.join(".claude/tasks/session-s1")).unwrap();
        assert!(ladder(hs, "s1", None).is_none(), "taskstate.store_empty_is_list is off: the transcript answers");
        for (id, st) in [("1", "pending"), ("2", "completed"), ("3", "pending")] {
            put(&h, "L", &format!("{id}.json"), &rec(id, st));
        }
        let (a, b, c) = (transcript(&h, "a.jsonl", &["2"]), transcript(&h, "b.jsonl", &["1", "2"]), transcript(&h, "c.jsonl", &["3"]));
        assert_eq!(session_has_open(hs, Some("s1"), Some(&a), Some("L")), Some(false), "#3 and #1 are open, but session A knows only #2, which is done");
        assert_eq!(session_has_open(hs, Some("s1"), Some(&b), Some("L")), Some(true), "session B knows #1");
        assert_eq!(session_has_open(hs, Some("s1"), Some(&c), Some("L")), Some(true), "session C knows #3");
        assert_eq!(session_has_open(hs, Some("s1"), None, Some("L")), None, "a shared list needs the transcript to scope it");
        crate::discard::harmless(std::fs::remove_dir_all(&h));
    }
}
