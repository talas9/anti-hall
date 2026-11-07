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

/// The statuses (lowercase) of the task files of the first directory of `taskstate.store_dir_names` that holds a readable task, or
/// `None` when the session has no readable store: no home, a session id with a character outside `[A-Za-z0-9_-]`, no such directory,
/// more than `taskstate.store_max_files` task files (the guards read that as absent too), or no file that is a task. A file that is
/// not valid JSON, has no string status or no string/number id, or is bigger than `taskstate.store_file_max_bytes` is skipped.
pub fn statuses(home: &str, session: &str) -> Option<Vec<String>> {
    if home.is_empty() || session.is_empty() || !session.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_')) {
        return None;
    }
    let base = defaults::list("taskstate.store_base").into_iter().fold(Path::new(home).to_path_buf(), |p, part| p.join(part));
    let sid8: String = session.chars().take(8).collect();
    let suffix = defaults::text("taskstate.store_file_suffix");
    let (max_files, max_bytes) = (defaults::num("taskstate.store_max_files") as usize, defaults::num("taskstate.store_file_max_bytes"));
    let fields = defaults::raw("taskstate.store_fields");
    let (id_field, status_field) = (fields.str_field("id"), fields.str_field("status"));
    for name in defaults::list("taskstate.store_dir_names") {
        let dir = base.join(defaults::fill(name, &[("sid", &session), ("sid8", &sid8)]));
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        let files: Vec<_> = rd
            .flatten()
            .filter(|e| e.file_name().to_str().is_some_and(|n| n.len() > suffix.len() && n.ends_with(suffix)))
            .take(max_files.saturating_add(1))
            .collect();
        if files.len() > max_files {
            return None;
        }
        let mut out: Vec<String> = Vec::new();
        for e in files {
            let mut raw = Vec::new();
            if std::fs::File::open(e.path()).and_then(|f| f.take(max_bytes).read_to_end(&mut raw)).is_err() {
                continue;
            }
            let Ok(rec) = serde_json::from_str::<Value>(&String::from_utf8_lossy(&raw)) else { continue };
            if matches!(rec.get(id_field), Some(Value::String(_) | Value::Number(_)))
                && let Some(status) = rec.get(status_field).and_then(Value::as_str)
            {
                out.push(status.to_lowercase());
            }
        }
        if !out.is_empty() {
            return Some(out);
        }
    }
    None
}

/// Whether the session's task store holds an open task (`taskstate.open_statuses`): `None` when the session has no readable store
/// (see [`statuses`]), so the transcript answers.
pub fn has_open(home: &str, session: &str) -> Option<bool> {
    let open = defaults::list("taskstate.open_statuses");
    statuses(home, session).map(|all| all.iter().any(|s| open.contains(&s.as_str())))
}

/// Whether the session has an open task, in the list task-guard reads: the task store when the session has a readable one, else the
/// transcript tail's reconstruction (`None`: neither can be read, or the reconstruction is not sure and shows no open task, which the
/// guard also leaves undecided).
pub fn session_has_open(home: &str, session: Option<&str>, transcript: Option<&str>) -> Option<bool> {
    if let Some(open) = session.and_then(|sid| has_open(home, sid)) {
        return Some(open);
    }
    let path = transcript.filter(|t| !t.is_empty())?;
    crate::script::host_d::guard_open_tasks(path, defaults::num("taskstate.tail_bytes"))
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
}
