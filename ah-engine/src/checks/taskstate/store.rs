//! Claude Code's own task store, read the way the task guards read it (`tk.storeTasks` of `logic/lib/69-tasks.js`).
//!
//! The store is the session's task list whenever it has one: the transcript tail of a long session no longer holds the creates, and
//! an old tail disagrees with the store. Every reader of "is a task open" that sits next to a task guard must ask the store FIRST and
//! the transcript only when the session has no readable store, or it takes a list the guard still sees as open for done.
//! Layout, bounds and field names are the `taskstate.*` keys of `task_guards.toml`.
//!
//! [`session_has_open`] is the whole of that rule for a reader that only needs "is a task open": the store, else the transcript tail
//! reconstructed as task-guard reconstructs it (the `guard` variant over `taskstate.tail_bytes`), never the tasklist gate's own
//! scan, which keeps other facts and reads another window.
use crate::defaults;
use serde_json::Value;
use std::io::Read;
use std::path::Path;

/// What the session's task store holds: the `(id, status lowercase)` of every readable task file of the first directory of
/// `taskstate.store_dir_names` that holds a readable task, and whether the store is UNSURE. Unsure means a directory tried on the way
/// (the answering one or one before it) exists but cannot be listed, or a task file of the answering directory cannot be read, is not
/// valid JSON, is over `taskstate.store_file_max_bytes`, or has no string/number id and string status: the readable tasks may then be
/// only part of the list, so a reader adds the transcript's tasks (see [`session_has_open`]) instead of letting the store answer alone.
pub struct Store {
    /// `(id, lowercase status)` of the readable tasks.
    pub tasks: Vec<(String, String)>,
    /// A directory or record could not be read.
    pub unsure: bool,
}

/// The store of the session, or `None` when the session has no readable store: no home, a session id with a character outside
/// `[A-Za-z0-9_-]`, no such directory, more than `taskstate.store_max_files` task files (the guards read that as absent too), or no
/// file that is a task.
pub fn read(home: &str, session: &str) -> Option<Store> {
    if home.is_empty() || session.is_empty() || !session.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_')) {
        return None;
    }
    let base = defaults::list("taskstate.store_base").into_iter().fold(Path::new(home).to_path_buf(), |p, part| p.join(part));
    let sid8: String = session.chars().take(8).collect();
    let suffix = defaults::text("taskstate.store_file_suffix");
    let (max_files, max_bytes) = (defaults::num("taskstate.store_max_files") as usize, defaults::num("taskstate.store_file_max_bytes"));
    let fields = defaults::raw("taskstate.store_fields");
    let (id_field, status_field) = (fields.str_field("id"), fields.str_field("status"));
    let mut unsure = false;
    for name in defaults::list("taskstate.store_dir_names") {
        let dir = base.join(defaults::fill(name, &[("sid", &session), ("sid8", &sid8)]));
        let rd = match std::fs::read_dir(&dir) {
            Ok(rd) => rd,
            Err(e) => {
                // a directory that is there but cannot be listed may hold open tasks; one that is not there holds none
                unsure |= e.kind() != std::io::ErrorKind::NotFound && dir.is_dir();
                continue;
            }
        };
        let files: Vec<_> = rd
            .flatten()
            .filter(|e| e.file_name().to_str().is_some_and(|n| n.len() > suffix.len() && n.ends_with(suffix)))
            .take(max_files.saturating_add(1))
            .collect();
        if files.len() > max_files {
            return None;
        }
        let mut out: Vec<(String, String)> = Vec::new();
        for e in files {
            let mut raw = Vec::new();
            if std::fs::File::open(e.path()).and_then(|f| f.take(max_bytes).read_to_end(&mut raw)).is_err() {
                unsure = true;
                continue;
            }
            let rec = serde_json::from_str::<Value>(&String::from_utf8_lossy(&raw)).ok();
            let id = rec.as_ref().and_then(|r| match r.get(id_field) {
                Some(Value::String(s)) => Some(s.clone()),
                Some(Value::Number(n)) => Some(n.to_string()),
                _ => None,
            });
            match (id, rec.as_ref().and_then(|r| r.get(status_field)).and_then(Value::as_str)) {
                (Some(id), Some(status)) => out.push((id, status.to_lowercase())),
                _ => unsure = true,
            }
        }
        if !out.is_empty() {
            return Some(Store { tasks: out, unsure });
        }
    }
    None
}

/// The statuses (lowercase) of the readable task files of the session's store (see [`read`]), or `None` when it has no readable store.
pub fn statuses(home: &str, session: &str) -> Option<Vec<String>> {
    read(home, session).map(|s| s.tasks.into_iter().map(|(_, st)| st).collect())
}

/// Whether the session's task store holds an open task among its readable records (`taskstate.open_statuses`): `None` when the session
/// has no readable store (see [`statuses`]), so the transcript answers. Unsure stores: see [`session_has_open`].
pub fn has_open(home: &str, session: &str) -> Option<bool> {
    let open = defaults::list("taskstate.open_statuses");
    statuses(home, session).map(|all| all.iter().any(|s| open.contains(&s.as_str())))
}

/// Whether the session has an open task, in the list task-guard reads: the task store when the session has a readable one, else the
/// transcript tail's reconstruction (`None`: neither can be read, or the reconstruction is not sure and shows no open task, which the
/// guard also leaves undecided). A store that is UNSURE (see [`Store`]) answers "open" when a readable record is open, and otherwise
/// lets the transcript's tasks that no readable record names decide, as `tk.tasksOf` unions them: never fewer open tasks than before.
pub fn session_has_open(home: &str, session: Option<&str>, transcript: Option<&str>) -> Option<bool> {
    let open = defaults::list("taskstate.open_statuses");
    let store = session.and_then(|sid| read(home, sid));
    if let Some(st) = &store {
        let store_open = st.tasks.iter().any(|(_, s)| open.contains(&s.as_str()));
        if !st.unsure {
            return Some(store_open);
        }
        if store_open {
            return Some(true);
        }
    }
    let path = transcript.filter(|t| !t.is_empty());
    let window = defaults::num("taskstate.tail_bytes");
    let Some(st) = store else { return crate::script::host_d::guard_open_tasks(path?, window) };
    // The store is unsure and shows no open task: the transcript's tasks that no readable record names decide (the records the store
    // could not read may be any of them). Neither readable: nothing is known to be open, which the guards leave undecided.
    let (tasks, unsure) = path.and_then(|p| crate::script::host_d::guard_task_states(p, window))?;
    let open_unnamed = tasks.iter().any(|(id, is_open)| *is_open && !st.tasks.iter().any(|(sid, _)| sid == id));
    (open_unnamed || !unsure).then_some(open_unnamed)
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
        assert!(read(h.to_str().unwrap(), "s1").unwrap().unsure, "and the junk makes it unsure");
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

    fn transcript(h: &Path, rows: &[&str]) -> String {
        let t = h.join("t.jsonl");
        std::fs::write(&t, rows.join("\n") + "\n").unwrap();
        t.to_str().unwrap().to_string()
    }
    const CREATE_9: [&str; 2] = [
        r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"c9","name":"TaskCreate","input":{"subject":"nine"}}]}}"#,
        r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"c9","content":"Task #9 created successfully: nine"}]}}"#,
    ];

    #[test]
    fn an_unsure_store_adds_the_transcripts_open_tasks_and_a_readable_record_overrides_its_id() {
        let h = home("unsure");
        put(&h, "session-s1", "1.json", &task("completed"));
        put(&h, "session-s1", "2.json", "{not json");
        let hs = h.to_str().unwrap();
        assert!(read(hs, "s1").unwrap().unsure);
        let t = transcript(&h, &CREATE_9);
        assert_eq!(session_has_open(hs, Some("s1"), Some(&t)), Some(true), "task 9 is named by no readable record: the junk one may be it");
        // a readable record that names the transcript's id wins: completed there means done
        put(&h, "session-s1", "9.json", &task("completed").replace("\"1\"", "\"9\""));
        assert_eq!(session_has_open(hs, Some("s1"), Some(&t)), Some(false), "the readable record for 9 says completed");
        // nothing open anywhere, or nothing readable: never a permanent block
        let none = transcript(&h, &[]);
        assert_eq!(session_has_open(hs, Some("s1"), Some(&none)), Some(false));
        assert_eq!(session_has_open(hs, Some("s1"), None), None, "unsure store, no transcript: undecided, not open");
        crate::discard::harmless(std::fs::remove_dir_all(&h));
    }

    #[cfg(unix)]
    #[test]
    fn an_unlistable_directory_and_an_unreadable_record_make_the_store_unsure() {
        use std::os::unix::fs::PermissionsExt;
        let h = home("modes");
        put(&h, "session-s1", "1.json", &task("pending"));
        put(&h, "session-s1", "2.json", &task("pending").replace("\"1\"", "\"2\""));
        let two = h.join(".claude/tasks/session-s1/2.json");
        std::fs::set_permissions(&two, std::fs::Permissions::from_mode(0o000)).unwrap();
        let st = read(h.to_str().unwrap(), "s1").unwrap();
        assert!(st.unsure && st.tasks.len() == 1, "the unreadable record is not dropped as junk");
        std::fs::set_permissions(&two, std::fs::Permissions::from_mode(0o644)).unwrap();
        let dir = h.join(".claude/tasks/session-s1");
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o000)).unwrap();
        let hs = h.to_str().unwrap();
        // the directory cannot be listed: no readable store, the transcript answers alone (and allows when it holds nothing)
        assert!(read(hs, "s1").is_none());
        let t = transcript(&h, &CREATE_9);
        assert_eq!(session_has_open(hs, Some("s1"), Some(&t)), Some(true));
        assert_eq!(session_has_open(hs, Some("s1"), Some(&transcript(&h, &[]))), Some(false));
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        crate::discard::harmless(std::fs::remove_dir_all(&h));
    }
}
