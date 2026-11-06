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

/// One store directory: absent, unreadable, or its tasks as (id, lowercase status). Unreadable is "not read IN FULL": more than
/// `taskstate.store_max_files` task files, a directory that exists but cannot be listed, or a task file that cannot be read, is bigger than
/// `taskstate.store_file_max_bytes`, is not JSON or has no string/number id or no string status. A partial list would make the missing
/// ids look gone, and a task is gone only when the whole list was read and every record accounted for.
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
    let rd = match std::fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(_) if dir.is_dir() => return Dir::Unreadable,
        Err(_) => return Dir::Absent,
    };
    let mut files = Vec::new();
    for e in rd {
        let Ok(e) = e else { return Dir::Unreadable };
        if e.file_name().to_str().is_some_and(|n| n.len() > suffix.len() && n.ends_with(suffix)) {
            files.push(e);
        }
        if files.len() > max_files {
            return Dir::Unreadable;
        }
    }
    let mut out = Vec::new();
    for e in files {
        let mut raw = Vec::new();
        if std::fs::File::open(e.path()).and_then(|f| f.take(max_bytes.saturating_add(1)).read_to_end(&mut raw)).is_err() || raw.len() as u64 > max_bytes {
            return Dir::Unreadable;
        }
        let Ok(rec) = serde_json::from_str::<Value>(&String::from_utf8_lossy(&raw)) else { return Dir::Unreadable };
        let id = match rec.get(id_field) {
            Some(Value::String(s)) => s.clone(),
            Some(Value::Number(n)) => n.to_string(),
            _ => return Dir::Unreadable,
        };
        let Some(status) = rec.get(status_field).and_then(Value::as_str) else { return Dir::Unreadable };
        out.push((id, status.to_lowercase()));
    }
    Dir::Tasks(out)
}

/// The three ladder switches (`taskstate.store_named_list`, `store_empty_is_list`, `named_list_scope`). The logic scripts read them as shipped
/// (`ah.cfg`); [`Switches::shipped`] is that, and a test passes its own to cover the other setting.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Switches {
    /// Rung 1 (the named list) is read.
    pub named: bool,
    /// An existing but empty session directory is the list (no tasks), not "no store".
    pub empty_is_list: bool,
    /// A named list is read whole (`named_list_scope` `list`), not session-scoped.
    pub scope_list: bool,
}

impl Switches {
    /// The shipped values.
    pub fn shipped() -> Self {
        Switches {
            named: defaults::shipped("taskstate.store_named_list").as_bool() == Some(true),
            empty_is_list: defaults::shipped("taskstate.store_empty_is_list").as_bool() == Some(true),
            scope_list: defaults::shipped("taskstate.named_list_scope").as_str() == Some("list"),
        }
    }
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
    ladder_with(home, session, list_id, Switches::shipped())
}

/// [`ladder`] with the switches given. A list that cannot be read in full (see `Dir`) ends the ladder at that rung with `None`: the
/// transcript answers, and no later rung (an empty session directory) stands in for it.
pub fn ladder_with(home: &str, session: &str, list_id: Option<&str>, sw: Switches) -> Option<Found> {
    if home.is_empty() {
        return None;
    }
    let base = defaults::list("taskstate.store_base").into_iter().fold(Path::new(home).to_path_buf(), |p, part| p.join(part));
    if sw.named
        && let Some(id) = list_id
        && regex::Regex::new(defaults::text("taskstate.list_id_re")).is_ok_and(|re| re.is_match(id))
        && base.join(id).is_dir()
    {
        match read_dir_tasks(&base.join(id)) {
            Dir::Tasks(tasks) => return Some(Found { shared: true, tasks }),
            Dir::Unreadable | Dir::Absent => return None,
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
    (seen && sw.empty_is_list).then(|| Found { shared: false, tasks: Vec::new() })
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
    session_has_open_with(home, session, transcript, list_id, Switches::shipped())
}

/// [`session_has_open`] with the switches given.
///
/// One difference from the guards' reader (`tk.tasksOf`), on purpose: the guards' known ids are the transcript tail's AND the session's
/// task snapshot's (a JavaScript-side file this reader does not read). Here the known ids are the tail's only, so for a shared named list
/// read session-scoped the answer is `Some(true)` when an open id the tail knows is open in the list, `Some(false)` when no open id of the list
/// is unknown to the tail, and `None` (cannot tell) when the list holds an open id the tail does not know: the snapshot might know it, and
/// "no open task" is never answered without proof.
pub fn session_has_open_with(home: &str, session: Option<&str>, transcript: Option<&str>, list_id: Option<&str>, sw: Switches) -> Option<bool> {
    let open = defaults::list("taskstate.open_statuses");
    let found = ladder_with(home, session.unwrap_or(""), list_id, sw);
    // A task a TodoWrite set is no member of the store, so the store never says it is gone: when the store shows nothing open, an open
    // TodoWrite task of the transcript still counts (and one that cannot be read is no answer, never "nothing open").
    let none_open = || -> Option<bool> {
        match transcript.filter(|t| !t.is_empty()) {
            Some(path) => crate::script::host_d::guard_open_todo(path, defaults::num("taskstate.tail_bytes")),
            None => Some(false),
        }
    };
    if let Some(f) = &found
        && (!f.shared || sw.scope_list)
    {
        return if f.tasks.iter().any(|(_, s)| open.contains(&s.as_str())) { Some(true) } else { none_open() };
    }
    let path = transcript.filter(|t| !t.is_empty())?;
    let Some(f) = found else { return crate::script::host_d::guard_open_tasks(path, defaults::num("taskstate.tail_bytes")) };
    let known = crate::script::host_d::guard_task_ids(path, defaults::num("taskstate.tail_bytes"))?;
    let mut unknown_open = false;
    for (id, s) in &f.tasks {
        if open.contains(&s.as_str()) {
            if known.contains(id) {
                return Some(true);
            }
            unknown_open = true;
        }
    }
    if unknown_open { None } else { none_open() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
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
        assert_eq!(open(&h, "s1"), None, "a task file that cannot be read in full makes no store (never a partial list)");
        assert_eq!(open(&h, ""), None);
        assert_eq!(has_open("", "s1"), None);
        std::fs::remove_dir_all(h.join(".claude/tasks/session-s1")).unwrap();
        put(&h, "session-s1", "6.json", &task("pending"));
        assert_eq!(open(&h, "s1"), Some(true), "the same directory without the junk is the store");
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
        assert_eq!(open(&h, "s2"), None, "a file over the byte cap cannot be read in full: no store");
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
        assert_eq!(
            session_has_open(hs, Some("s1"), Some(&a), Some("L")),
            None,
            "#1 and #3 are open and session A's tail does not know them (its snapshot, unread here, might): cannot tell, never 'nothing open'"
        );
        assert_eq!(session_has_open(hs, Some("s1"), Some(&b), Some("L")), Some(true), "session B knows #1");
        assert_eq!(session_has_open(hs, Some("s1"), Some(&c), Some("L")), Some(true), "session C knows #3");
        assert_eq!(session_has_open(hs, Some("s1"), None, Some("L")), None, "a shared list needs the transcript to scope it");
        crate::discard::harmless(std::fs::remove_dir_all(&h));
    }

    #[test]
    fn a_task_file_that_exists_but_cannot_be_read_ends_the_ladder_there_and_no_later_rung_stands_in() {
        let h = home("unreadable");
        let hs = h.to_str().unwrap();
        put(&h, "L", "1.json", "{not json");
        put(&h, "L", "2.json", &rec("2", "completed"));
        put(&h, "session-s1", "1.json", &rec("1", "pending"));
        assert!(ladder(hs, "s1", Some("L")).is_none(), "the named list is unreadable: no answer, not the session's directory and not a list without #1");
        let sw = Switches { empty_is_list: true, ..Switches::shipped() };
        std::fs::remove_dir_all(h.join(".claude/tasks/session-s1")).unwrap();
        std::fs::create_dir_all(h.join(".claude/tasks/session-s1")).unwrap();
        assert!(ladder_with(hs, "s1", Some("L"), sw).is_none(), "an empty session directory does not stand in for the unreadable list");
        put(&h, "session-s2", "1.json", &rec("1", "pending"));
        put(&h, "session-s2", "2.json", &task_no_status());
        assert!(ladder(hs, "s2", None).is_none(), "a record without a status: the directory is unreadable");
        // a directory that exists but cannot be listed
        use std::os::unix::fs::PermissionsExt;
        put(&h, "session-s3", "1.json", &rec("1", "pending"));
        let d = h.join(".claude/tasks/session-s3");
        std::fs::set_permissions(&d, std::fs::Permissions::from_mode(0o000)).unwrap();
        let denied = ladder(hs, "s3", None);
        std::fs::set_permissions(&d, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(denied.is_none(), "an unlistable directory is unreadable, not absent");
        crate::discard::harmless(std::fs::remove_dir_all(&h));
    }

    fn task_no_status() -> String {
        r#"{"id":"2","subject":"x"}"#.to_string()
    }

    #[test]
    fn each_switch_changes_the_ladder_in_both_directions() {
        let h = home("switches");
        let hs = h.to_str().unwrap();
        put(&h, "L", "1.json", &rec("1", "pending"));
        std::fs::create_dir_all(h.join(".claude/tasks/session-s1")).unwrap();
        let off = Switches { named: false, empty_is_list: false, scope_list: false };
        assert!(ladder_with(hs, "s1", Some("L"), off).is_none(), "named off, empty directory not a list: no store");
        assert!(ladder_with(hs, "s1", Some("L"), Switches { named: true, ..off }).unwrap().shared);
        let empty = ladder_with(hs, "s1", Some("L"), Switches { empty_is_list: true, ..off }).unwrap();
        assert!(!empty.shared && empty.tasks.is_empty(), "named off, empty directory is the list");
        let t = transcript(&h, "t.jsonl", &["1"]);
        let on = Switches { named: true, empty_is_list: false, scope_list: true };
        assert_eq!(session_has_open_with(hs, Some("s1"), Some(&t), Some("L"), on), Some(true), "scope list: the whole list");
        put(&h, "L", "9.json", &rec("9", "pending"));
        std::fs::write(h.join(".claude/tasks/L/1.json"), rec("1", "completed")).unwrap();
        assert_eq!(session_has_open_with(hs, Some("s1"), Some(&t), Some("L"), on), Some(true), "scope list: #9 counts");
        assert_eq!(
            session_has_open_with(hs, Some("s1"), Some(&t), Some("L"), Switches { scope_list: false, ..on }),
            None,
            "scope session: #9 is not known to the tail"
        );
        crate::discard::harmless(std::fs::remove_dir_all(&h));
    }

    /// The shared fixtures (`tests/fixtures/task-store-ladder.json`) through this reader; the JavaScript reader runs the same file
    /// (`host_tests_d`, `the_shared_ladder_fixtures_give_the_same_answers_through_the_script_reader`).
    #[test]
    fn the_shared_ladder_fixtures_give_the_documented_answers_through_the_rust_reader() {
        let fx: Value = serde_json::from_str(include_str!("../../../tests/fixtures/task-store-ladder.json")).unwrap();
        for (n, c) in fx["cases"].as_array().unwrap().iter().enumerate() {
            let name = c["name"].as_str().unwrap();
            let h = home(&format!("fx{n}"));
            let hs = h.to_str().unwrap();
            for (dir, files) in c["dirs"].as_object().unwrap() {
                std::fs::create_dir_all(h.join(".claude/tasks").join(dir)).unwrap();
                for (f, body) in files.as_object().unwrap() {
                    let text = body.as_str().map_or_else(|| body.to_string(), str::to_string);
                    put(&h, dir, f, &text);
                }
            }
            let ids: Vec<String> = c["created"].as_array().unwrap().iter().map(|v| v.to_string()).collect();
            let t = transcript(&h, "t.jsonl", &ids.iter().map(String::as_str).collect::<Vec<_>>());
            if let Some(todos) = c.get("todos").and_then(Value::as_array) {
                // a TodoWrite whose items are pending: no member of the task store
                let items: Vec<Value> = todos.iter().enumerate().map(|(i, v)| json!({"id": format!("todo-{i}"), "content": v, "status": "pending"})).collect();
                let row = json!({"type": "assistant", "timestamp": "2026-10-06T12:30:00.000Z", "message": {"role": "assistant", "content": [{"type": "tool_use", "id": "tw1", "name": "TodoWrite", "input": {"todos": items}}]}});
                let mut f = std::fs::OpenOptions::new().append(true).open(&t).unwrap();
                std::io::Write::write_all(&mut f, format!("{row}\n").as_bytes()).unwrap();
            }
            let s = &c["switches"];
            let sw = Switches {
                named: s["named"].as_bool().unwrap(),
                empty_is_list: s["empty_is_list"].as_bool().unwrap(),
                scope_list: s["scope_list"].as_bool().unwrap(),
            };
            let want = c.get("rust_open").unwrap_or(&c["open"]).as_bool();
            assert_eq!(session_has_open_with(hs, c["session"].as_str(), Some(&t), c["list_id"].as_str(), sw), want, "{name}");
            crate::discard::harmless(std::fs::remove_dir_all(&h));
        }
    }
}
