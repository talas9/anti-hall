//! #442 / #443: the v4 GATE for any change to the task reader (store / named list / transcript / snapshot resolution).
//!
//! The reader decides which tasks are OPEN; a Stop is blocked on them. A change to it has failed review five times for the same shape: a
//! task the base reader keeps is missed by the new one (unreadable store records read as deleted, an id-prefix ghost drop of a real
//! TodoWrite task, named-list scoping dropping TodoWrite tasks, a TodoWrite task overwritten by a store task with the same id, a ghost
//! "proof" matched on raw bytes). This file is the property that catches them BEFORE a resolver is written:
//!
//!   for every cell of the fixture matrix:   open(reader under test)  ⊇  golden open set  −  ids PROVEN to be ghosts
//!
//! * The matrix is generated here (store x named list x transcript source x snapshot x extra row types).
//! * The golden open sets are captured from the base decision path (the JS `tk.tasks` the task-guard Stop calls, through the script
//!   host, plus the Rust ladder `store::session_has_open` and the task-guard Stop verdict) and committed in
//!   `tests/fixtures/task-reader-open-sets.json`. Regenerate ONLY on the base commit named in the file:
//!   `AH_REGEN_TASK_READER_GOLDEN=1 cargo test --test task_reader_open_set`.
//! * A PROVEN ghost is an id whose every mention, found by DECODING each transcript row's JSON (never by matching raw bytes), sits in a
//!   row of a type in `taskstate.skipped_row_types`. An id that also appears in a conversation row, an unknown-typed row, a store record
//!   or a snapshot is never proven.
//!
//! The reader under test is [`read_cell`]: today it IS the base reader, so the property holds with equality; a resolver lane makes it
//! point at the new code and must keep the property green.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::unreachable)]

use ah_engine::reqenv::RequestEnv;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

const SID: &str = "s1abcdefgh12"; // longer than 8 characters: `session-<8>` and `<sid>` are different directories
const SID8: &str = "s1abcdef";
const NAMED_LIST: &str = "team-list";
const GOLDEN: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/task-reader-open-sets.json");

// ---- THE ADAPTER ------------------------------------------------------------------------------------------------------------
//
// Every call into the engine's task reader goes through this section and nowhere else. A resolver lane that changes a signature or a
// defaults key edits ONLY this section; the matrix, the golden and the assertions below stay as they are.

/// The reader's JS entry, run inside the script host: `tk.tasks(transcript, home, session)` plus the store probe `tk.storeTasks`.
/// The returned object must carry `tasks` ([[id, status]]), `unsure` and `store`.
/// Plants the snapshot entry `p.entry` the way the reader writes its snapshot of transcript `p.t` (sets `out.ok`).
const JS_PLANT_CALL: &str = "var size = ah.fs.size(p.t), win = ah.cfgNum('taskstate.tail_bytes'); \
           var doc = {format: ah.cfgNum('taskstate.snapshot_format'), path: p.t, gen: taskSnap.fingerprint(p.t, size, win), session: p.s, \
             variants: {guard: {size: size, ms: ah.clock.now(), tasks: [p.entry], ids: {}}}}; \
           out = {ok: ah.state.writeAtomic(taskSnap.rel(p.t), JSON.stringify(doc))};";

const JS_READ_CALL: &str = "var ts = tk.tasks(p.t, ah.home(), p.s); \
           out = {tasks: ts.map(function (t) { return [t.id, t.status === null || t.status === undefined ? null : t.status]; }), unsure: !!ts.unsure, store: tk.storeTasks(ah.home(), p.s) !== null};";

/// A defaults list. A key the engine under test does not define degrades to an empty list (with a printed note, once per key) instead
/// of aborting the whole gate.
fn cfg_list(key: &str) -> Vec<&'static str> {
    if ah_engine::defaults::has(key) {
        ah_engine::defaults::list(key)
    } else {
        static NOTED: std::sync::Mutex<BTreeSet<String>> = std::sync::Mutex::new(BTreeSet::new());
        if NOTED.lock().unwrap().insert(key.to_string()) {
            eprintln!("note: defaults key {key:?} is not defined by the engine under test; treated as an empty list");
        }
        Vec::new()
    }
}

/// The Rust ladder `store::session_has_open` (the base signature; a lane with a different one changes only this body).
fn ladder_has_open(home: &Path, transcript: &Path) -> Option<bool> {
    ah_engine::checks::taskstate::store::session_has_open(home.to_str().unwrap(), Some(SID), Some(transcript.to_str().unwrap()))
}

// ---- the matrix -------------------------------------------------------------------------------------------------------------

/// The task store of the session.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Store {
    /// No store directory at all.
    Absent,
    /// `session-<8>` exists and holds no task file.
    Empty,
    /// Tasks 1 (pending), 2 (completed), 3 (in_progress).
    NonEmpty,
    /// The same, under the directory named by the full session id.
    NonEmptySidDir,
    /// One valid pending task (id 1) next to a record that is not JSON.
    OneJunkRecord,
    /// One valid pending task (id 1) next to a valid pending task (id 2) whose file cannot be read (mode 000).
    OneUnreadableRecord,
    /// Only records that are not tasks (invalid JSON, a numeric status).
    OnlyJunk,
    /// A valid pending task in a directory that cannot be listed (mode 000).
    UnreadableDir,
    /// Consumers axis only (not in [`STORES`], so not in the golden matrix): two records with the SAME id 1 (pending in a.json, completed in
    /// b.json) next to a record that is not JSON.
    DupIdWithJunk,
    /// Consumers axis only: a completed task 1 next to a record that is not JSON.
    CompletedWithJunk,
    /// Hand-written obligation cells only (W1-1F): one completed task 1 and nothing else.
    CompletedOnly,
}
const STORES: [Store; 8] = [
    Store::Absent,
    Store::Empty,
    Store::NonEmpty,
    Store::NonEmptySidDir,
    Store::OneJunkRecord,
    Store::OneUnreadableRecord,
    Store::OnlyJunk,
    Store::UnreadableDir,
];

/// `CLAUDE_CODE_TASK_LIST_ID` and the directory it names.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Named {
    /// The variable is not set.
    Unset,
    /// Set, and `<store>/team-list/` holds task 9 (pending).
    SetWithList,
    /// Set, and no such directory.
    SetNoDir,
    /// Hand-written obligation cells only (W1-1F): set to `team-list` (which has no directory), and ANOTHER list `other-list/` holds
    /// task 9 (pending): a task of a list this session did not select.
    SetOtherList,
}
const NAMEDS: [Named; 3] = [Named::Unset, Named::SetWithList, Named::SetNoDir];

/// What the transcript says about tasks (all rows are conversation rows).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Trans {
    /// The transcript file does not exist.
    Missing,
    /// A transcript with no task activity.
    NoTasks,
    /// A TodoWrite list: id 1 pending, id 2 in_progress.
    TodoWrite,
    /// TaskCreate #1 and #2 (results seen), #2 then completed by a TaskUpdate.
    TaskCreate,
    /// A TaskCreate whose result never arrived (a provisional `toolu_` id).
    Unanswered,
    /// TaskCreate #1 (result seen), then a TodoWrite (ids 1 and x) that replaces the list.
    CreateThenTodo,
    /// A TodoWrite (ids 1 and x), then TaskCreate #1 (result seen).
    TodoThenCreate,
    /// Hand-written obligation cells only (W1-1F): a TaskCreate whose result is an error (`is_error`): the create failed, no task exists.
    FailedCreate,
}
const TRANS: [Trans; 7] =
    [Trans::Missing, Trans::NoTasks, Trans::TodoWrite, Trans::TaskCreate, Trans::Unanswered, Trans::CreateThenTodo, Trans::TodoThenCreate];

/// A task entry planted in the session's snapshot of the transcript (laid over the tail by the reader).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Snap {
    None,
    /// Task 7, pending, a plain entry.
    Plain,
    /// A `toolu_`-shaped id, pending.
    ToolUseId,
    /// Task 8, pending, carrying ghost-style flags a resolver may write (`provisional`, `ghost`).
    Flagged,
}
const SNAPS: [Snap; 4] = [Snap::None, Snap::Plain, Snap::ToolUseId, Snap::Flagged];

/// Extra rows appended after the transcript's own rows.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Rows {
    /// Conversation rows only.
    Conv,
    /// An `api-request-blob` replay: a TaskCreate (`toolu_blob`) with its result (Task #9), and a TodoWrite id 6.
    Blob,
    /// A row of an unknown type (`zzz-unknown`) holding a TodoWrite id 6.
    UnknownType,
    /// A row whose type is the empty string holding a TaskCreate `toolu_empty` (no result).
    EmptyType,
    /// A row without a `type` holding a TodoWrite id 6.
    NoType,
}
const ROWS: [Rows; 5] = [Rows::Conv, Rows::Blob, Rows::UnknownType, Rows::EmptyType, Rows::NoType];

/// The knobs a future resolver adds (`taskstate.named_list_scope`, `taskstate.store_empty_is_list`). They do not exist at the base, so
/// every cell carries an empty map and the key does not mention them; a resolver lane adds axes here and its extra cells are checked
/// against the golden cell with the same non-knob axes.
type Knobs = BTreeMap<&'static str, &'static str>;

#[derive(Clone, Debug)]
struct Cell {
    store: Store,
    named: Named,
    trans: Trans,
    snap: Snap,
    rows: Rows,
    knobs: Knobs,
}

impl Cell {
    fn key(&self) -> String {
        let knobs: String = self.knobs.iter().map(|(k, v)| format!("|{k}={v}")).collect();
        format!("store={:?}|named={:?}|trans={:?}|snap={:?}|rows={:?}{knobs}", self.store, self.named, self.trans, self.snap, self.rows)
    }
    /// The base golden cell this one is compared with (knobs left out).
    fn golden_key(&self) -> String {
        Cell { knobs: Knobs::new(), ..self.clone() }.key()
    }
}

fn matrix() -> Vec<Cell> {
    let mk = |store, named, trans, snap, rows| Cell { store, named, trans, snap, rows, knobs: Knobs::new() };
    let mut out = Vec::new();
    for s in STORES {
        for t in TRANS {
            for n in NAMEDS {
                out.push(mk(s, n, t, Snap::None, Rows::Conv));
            }
            for p in &SNAPS[1..] {
                out.push(mk(s, Named::Unset, t, *p, Rows::Conv));
            }
            for r in &ROWS[1..] {
                out.push(mk(s, Named::Unset, t, Snap::None, *r));
            }
        }
    }
    out
}

// ---- building a cell ---------------------------------------------------------------------------------------------------------

fn line(v: &Value) -> String {
    format!("{v}\n")
}

fn tool_use(id: &str, name: &str, input: Value) -> Value {
    json!({"type": "assistant", "timestamp": "2026-10-06T12:00:00.000Z", "message": {"id": format!("m-{id}"), "role": "assistant", "content": [{"type": "tool_use", "id": id, "name": name, "input": input}]}})
}

fn tool_result(id: &str, text: &str) -> Value {
    json!({"type": "user", "timestamp": "2026-10-06T12:00:01.000Z", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": id, "content": text}]}})
}

fn create(n: u32, subject: &str) -> Vec<Value> {
    vec![
        tool_use(&format!("c{n}"), "TaskCreate", json!({"subject": subject})),
        tool_result(&format!("c{n}"), &format!("Task #{n} created successfully: {subject}")),
    ]
}

fn todo(ids: &[(&str, &str, &str)]) -> Value {
    let todos: Vec<Value> = ids.iter().map(|(id, content, status)| json!({"id": id, "content": content, "status": status})).collect();
    tool_use(&format!("tw-{}", ids.len()), "TodoWrite", json!({ "todos": todos }))
}

/// The conversation rows of a transcript source, then the extra rows.
fn rows_of(trans: Trans, extra: Rows) -> Vec<Value> {
    let mut rows = vec![json!({"type": "user", "uuid": "u0", "timestamp": "2026-10-06T11:59:00.000Z", "message": {"role": "user", "content": "start"}})];
    match trans {
        Trans::Missing | Trans::NoTasks => {}
        Trans::TodoWrite => rows.push(todo(&[("1", "tw one", "pending"), ("2", "tw two", "in_progress")])),
        Trans::TaskCreate => {
            rows.extend(create(1, "tc one"));
            rows.extend(create(2, "tc two"));
            rows.push(tool_use("u2", "TaskUpdate", json!({"taskId": "2", "status": "completed"})));
            rows.push(tool_result("u2", "Updated task #2"));
        }
        Trans::Unanswered => rows.push(tool_use("toolu_unans", "TaskCreate", json!({"subject": "no result yet"}))),
        Trans::CreateThenTodo => {
            rows.extend(create(1, "tc one"));
            rows.push(todo(&[("1", "tw one", "pending"), ("x", "tw x", "pending")]));
        }
        Trans::TodoThenCreate => {
            rows.push(todo(&[("1", "tw one", "pending"), ("x", "tw x", "pending")]));
            rows.extend(create(1, "tc late"));
        }
        Trans::FailedCreate => {
            rows.push(tool_use("toolu_failed", "TaskCreate", json!({"subject": "a create that failed"})));
            rows.push(json!({"type": "user", "timestamp": "2026-10-06T12:00:01.000Z", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "toolu_failed", "is_error": true, "content": "Error: the task could not be created"}]}}));
        }
    }
    match extra {
        Rows::Conv => {}
        Rows::Blob => rows.push(json!({"type": "api-request-blob", "messages": [
            {"role": "assistant", "content": [{"type": "tool_use", "id": "toolu_blob", "name": "TaskCreate", "input": {"subject": "blob task"}}]},
            {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "toolu_blob", "content": "Task #9 created successfully: blob task"}]},
            {"role": "assistant", "content": [{"type": "tool_use", "id": "toolu_blobtw", "name": "TodoWrite", "input": {"todos": [{"id": "6", "content": "blob todo", "status": "pending"}]}}]}
        ]})),
        Rows::UnknownType => rows.push(json!({"type": "zzz-unknown", "message": {"role": "assistant", "content": [{"type": "tool_use", "id": "toolu_unk", "name": "TodoWrite", "input": {"todos": [{"id": "6", "content": "unknown-row todo", "status": "pending"}]}}]}})),
        Rows::EmptyType => rows.push(json!({"type": "", "message": {"role": "assistant", "content": [{"type": "tool_use", "id": "toolu_empty", "name": "TaskCreate", "input": {"subject": "empty-type row"}}]}})),
        Rows::NoType => rows.push(json!({"message": {"role": "assistant", "content": [{"type": "tool_use", "id": "toolu_notype", "name": "TodoWrite", "input": {"todos": [{"id": "6", "content": "no-type todo", "status": "pending"}]}}]}})),
    }
    rows
}

fn store_file(dir: &Path, name: &str, id: &str, status: &str) {
    std::fs::create_dir_all(dir).unwrap();
    std::fs::write(dir.join(name), json!({"id": id, "subject": format!("store {id}"), "status": status}).to_string()).unwrap();
}

#[cfg(unix)]
fn chmod(p: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(p, std::fs::Permissions::from_mode(mode)).unwrap();
}

/// The files of the cell under `root` (home, store, transcript). Returns the home directory and the transcript path.
fn build(cell: &Cell, root: &Path) -> (PathBuf, PathBuf) {
    let home = root.join("home");
    std::fs::create_dir_all(home.join(".anti-hall/logic")).unwrap();
    let tasks = home.join(".claude/tasks");
    let dir = tasks.join(format!("session-{SID8}"));
    match cell.store {
        Store::Absent => {}
        Store::Empty => std::fs::create_dir_all(&dir).unwrap(),
        Store::NonEmpty => {
            store_file(&dir, "1.json", "1", "pending");
            store_file(&dir, "2.json", "2", "completed");
            store_file(&dir, "3.json", "3", "in_progress");
        }
        Store::NonEmptySidDir => {
            let d = tasks.join(SID);
            store_file(&d, "1.json", "1", "pending");
            store_file(&d, "2.json", "2", "completed");
            store_file(&d, "3.json", "3", "in_progress");
        }
        Store::OneJunkRecord => {
            store_file(&dir, "1.json", "1", "pending");
            std::fs::write(dir.join("2.json"), "{not json").unwrap();
        }
        Store::OneUnreadableRecord => {
            store_file(&dir, "1.json", "1", "pending");
            store_file(&dir, "2.json", "2", "pending");
            #[cfg(unix)]
            chmod(&dir.join("2.json"), 0o000);
        }
        Store::OnlyJunk => {
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("1.json"), "{not json").unwrap();
            std::fs::write(dir.join("2.json"), json!({"id": "2", "status": 3}).to_string()).unwrap();
        }
        Store::UnreadableDir => {
            store_file(&dir, "1.json", "1", "pending");
            #[cfg(unix)]
            chmod(&dir, 0o000);
        }
        Store::DupIdWithJunk => {
            store_file(&dir, "a.json", "1", "pending");
            store_file(&dir, "b.json", "1", "completed");
            std::fs::write(dir.join("c.json"), "{not json").unwrap();
        }
        Store::CompletedWithJunk => {
            store_file(&dir, "1.json", "1", "completed");
            std::fs::write(dir.join("c.json"), "{not json").unwrap();
        }
        Store::CompletedOnly => store_file(&dir, "1.json", "1", "completed"),
    }
    if cell.named == Named::SetWithList {
        store_file(&tasks.join(NAMED_LIST), "9.json", "9", "pending");
    }
    if cell.named == Named::SetOtherList {
        store_file(&tasks.join("other-list"), "9.json", "9", "pending");
    }
    let t = root.join("t.jsonl");
    if cell.trans != Trans::Missing {
        std::fs::write(&t, rows_of(cell.trans, cell.rows).iter().map(line).collect::<String>()).unwrap();
    }
    (std::fs::canonicalize(&home).unwrap(), t)
}

/// Make the cell directories readable again so the root can be removed.
fn unlock(home: &Path) {
    #[cfg(unix)]
    if let Ok(rd) = std::fs::read_dir(home.join(".claude/tasks")) {
        for d in rd.flatten() {
            chmod(&d.path(), 0o755);
            if let Ok(files) = std::fs::read_dir(d.path()) {
                for f in files.flatten() {
                    chmod(&f.path(), 0o644);
                }
            }
        }
    }
}

/// The ids and the field set a snapshot entry of `kind` has (the shape of a rebuilt task).
fn snap_entry(kind: Snap) -> Option<Value> {
    let base = |id: &str| json!({"id": id, "content": format!("snapshot {id}"), "description": "", "status": "pending", "owner": "", "blockedBy": [], "priority": null, "subjectUpdated": false, "unknown": null, "blockUnknown": false, "sinceMs": null});
    match kind {
        Snap::None => None,
        Snap::Plain => Some(base("7")),
        Snap::ToolUseId => Some(base("toolu_snapghost")),
        Snap::Flagged => {
            let mut v = base("8");
            v["provisional"] = json!(true);
            v["ghost"] = json!(true);
            Some(v)
        }
    }
}

fn probe(home: &Path) {
    let js = format!(
        "function decide(p){{ var out = {{}}; if (p.mode === 'plant') {{ {JS_PLANT_CALL} }} else {{ {JS_READ_CALL} }} \
         ah.state.writeAtomic('.anti-hall/out-' + p.mode + '.json', JSON.stringify(out)); return 'allow'; }}"
    );
    std::fs::write(home.join(".anti-hall/logic/zz-oset.js"), js).unwrap();
}

fn env_of(cell: &Cell, home: &Path) -> RequestEnv {
    let mut pairs = vec![("HOME".to_string(), home.to_string_lossy().into_owned())];
    if cell.named != Named::Unset {
        pairs.push(("CLAUDE_CODE_TASK_LIST_ID".to_string(), NAMED_LIST.to_string()));
    }
    RequestEnv::from_pairs(pairs)
}

fn run_probe(mode: &str, home: &Path, t: &Path, env: &RequestEnv) -> Value {
    let payload = json!({"mode": mode, "t": t, "s": SID});
    let v = ah_engine::script::run_forced("zz-oset", &payload, &Value::Null, "PreToolUse", env);
    assert!(format!("{v:?}").contains("Allow"), "probe {mode} did not run: {v:?}");
    serde_json::from_str(&std::fs::read_to_string(home.join(format!(".anti-hall/out-{mode}.json"))).unwrap()).unwrap()
}

/// Plant the snapshot entry: the session's snapshot of the transcript, as the reader writes it (format, path, session, file fingerprint,
/// size, guard section), holding the one entry. Returns false when the cell has no snapshot (none asked for, or no transcript).
fn plant_snapshot(cell: &Cell, home: &Path, t: &Path, env: &RequestEnv) -> bool {
    let Some(entry) = snap_entry(cell.snap) else { return false };
    if !t.exists() {
        return false;
    }
    let payload = json!({"mode": "plant", "t": t, "s": SID, "entry": entry});
    let v = ah_engine::script::run_forced("zz-oset", &payload, &Value::Null, "PreToolUse", env);
    assert!(format!("{v:?}").contains("Allow"), "plant did not run: {v:?}");
    let out: Value = serde_json::from_str(&std::fs::read_to_string(home.join(".anti-hall/out-plant.json")).unwrap()).unwrap();
    assert_eq!(out["ok"], json!(true), "{}: the snapshot was written", cell.key());
    true
}

/// What one reader run observed for a cell.
#[derive(Clone, Debug, PartialEq)]
struct Observed {
    /// Every task the reader returns: (id, status).
    tasks: Vec<(String, Option<String>)>,
    open: BTreeSet<String>,
    unsure: bool,
    /// A readable task store answered.
    store: bool,
    /// The Rust ladder `store::session_has_open`.
    ladder: Option<bool>,
    /// The task-guard Stop verdict: "block", "allow" or "other".
    stop: String,
}

fn is_open(status: &str) -> bool {
    cfg_list("taskstate.open_statuses").contains(&status.to_lowercase().as_str())
}

/// THE READER UNDER TEST. Runs the base decision path of a cell: the JS reader `tk.tasks` through the script host, the Rust ladder and
/// the task-guard Stop. A resolver lane points this at its code (keeping the same observations).
fn read_cell(cell: &Cell, root: &Path) -> Observed {
    let (home, t) = build(cell, root);
    probe(&home);
    let env = env_of(cell, &home);
    plant_snapshot(cell, &home, &t, &env);
    let got = run_probe("read", &home, &t, &env);
    let tasks: Vec<(String, Option<String>)> =
        got["tasks"].as_array().unwrap().iter().map(|r| (r[0].as_str().unwrap().to_string(), r[1].as_str().map(str::to_string))).collect();
    let open = tasks.iter().filter(|(_, s)| s.as_deref().is_some_and(is_open)).map(|(i, _)| i.clone()).collect();
    let ladder = ladder_has_open(&home, &t);
    let payload = json!({"cwd": home, "hook_event_name": "Stop", "session_id": SID, "transcript_path": t});
    let verdict = format!("{:?}", ah_engine::script::run_forced("task-guard", &payload, &json!({}), "Stop", &env));
    let stop = if verdict.contains("block") || verdict.contains("Block") {
        "block"
    } else if verdict.contains("Allow") {
        "allow"
    } else {
        "other"
    };
    let obs = Observed { tasks, open, unsure: got["unsure"].as_bool().unwrap(), store: got["store"].as_bool().unwrap(), ladder, stop: stop.to_string() };
    unlock(&home);
    obs
}

// ---- the ghost proof ---------------------------------------------------------------------------------------------------------

/// Every task id a decoded row names: a task-tool input id (`taskId`, `id`, `task_id`), a tool-use id, a `tool_use_id`, a TodoWrite
/// item id, and every `#<digits>` of any string in the row ("Task #9 created", "Updated task #2").
fn mentioned_ids(v: &Value, out: &mut BTreeSet<String>) {
    let keys = cfg_list("taskstate.id_keys");
    match v {
        Value::Object(m) => {
            for (k, x) in m {
                if keys.contains(&k.as_str()) || k == "tool_use_id" {
                    match x {
                        Value::String(s) => {
                            out.insert(s.clone());
                        }
                        Value::Number(n) => {
                            out.insert(n.to_string());
                        }
                        _ => {}
                    }
                }
                mentioned_ids(x, out);
            }
        }
        Value::Array(a) => a.iter().for_each(|x| mentioned_ids(x, out)),
        Value::String(s) => {
            let mut rest = s.as_str();
            while let Some(at) = rest.find('#') {
                let digits: String = rest[at + 1..].chars().take_while(char::is_ascii_digit).collect();
                if !digits.is_empty() {
                    out.insert(digits);
                }
                rest = &rest[at + 1..];
            }
        }
        _ => {}
    }
}

/// The ids of `ids` PROVEN to be ghosts: each is named by at least one row, and every row that names it has a type in
/// `taskstate.skipped_row_types`. Rows are decoded (a row that does not decode proves nothing); store records and snapshot entries are not
/// rows, so an id they carry is never in `named_elsewhere` here and the caller passes only ids the rows are the sole source of.
fn proven_ghosts(row_lines: &[String], ids: &BTreeSet<String>) -> BTreeSet<String> {
    let excluded = cfg_list("taskstate.skipped_row_types");
    let mut in_excluded: BTreeSet<String> = BTreeSet::new();
    let mut elsewhere: BTreeSet<String> = BTreeSet::new();
    for l in row_lines {
        let Ok(row) = serde_json::from_str::<Value>(l) else { continue };
        let mut named = BTreeSet::new();
        mentioned_ids(&row, &mut named);
        let skipped = row.get("type").and_then(Value::as_str).is_some_and(|t| excluded.contains(&t));
        if skipped { &mut in_excluded } else { &mut elsewhere }.extend(named);
    }
    ids.iter().filter(|i| in_excluded.contains(*i) && !elsewhere.contains(*i)).cloned().collect()
}

// ---- the golden ---------------------------------------------------------------------------------------------------------------

fn obs_json(o: &Observed) -> Value {
    json!({"open": o.open, "tasks": o.tasks, "unsure": o.unsure, "store": o.store, "ladder": o.ladder, "stop": o.stop})
}

fn scratch(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("ah442-{tag}-{}", std::process::id()));
    std::fs::remove_dir_all(&d).ok();
    std::fs::create_dir_all(&d).unwrap();
    std::fs::canonicalize(&d).unwrap()
}

/// Run every cell and return key -> observation, in matrix order.
fn run_matrix() -> Vec<(Cell, Observed)> {
    let base = scratch("cells");
    let out = matrix()
        .into_iter()
        .enumerate()
        .map(|(i, cell)| {
            let root = base.join(i.to_string());
            std::fs::create_dir_all(&root).unwrap();
            let o = read_cell(&cell, &root);
            (cell, o)
        })
        .collect();
    std::fs::remove_dir_all(&base).ok();
    out
}

#[test]
fn the_reader_keeps_every_open_task_the_base_reader_keeps() {
    let t0 = std::time::Instant::now();
    let observed = run_matrix();
    if std::env::var("AH_REGEN_TASK_READER_GOLDEN").is_ok_and(|v| v == "1") {
        let cells: BTreeMap<String, Value> = observed.iter().map(|(c, o)| (c.key(), obs_json(o))).collect();
        let doc = json!({
            "about": "Open-task sets of the base task reader, one per matrix cell of tests/task_reader_open_set.rs. Regenerate only on the base commit named here.",
            "captured_on": std::env::var("AH_GOLDEN_BASE").unwrap_or_else(|_| "unset".into()),
            "cells": cells,
        });
        std::fs::write(GOLDEN, serde_json::to_string_pretty(&doc).unwrap() + "\n").unwrap();
        eprintln!("golden written: {} cells", cells.len());
        return;
    }
    let golden: Value = serde_json::from_str(&std::fs::read_to_string(GOLDEN).expect("the committed golden file")).unwrap();
    let cells = golden["cells"].as_object().expect("cells");
    let (mut checked, mut equal, mut extra_open, mut ghosts_removed) = (0usize, 0usize, 0usize, 0usize);
    let mut violations: Vec<String> = Vec::new();
    for (cell, got) in &observed {
        let g = cells.get(&cell.golden_key()).unwrap_or_else(|| panic!("no golden cell {}: regenerate on the base commit", cell.golden_key()));
        checked += 1;
        let golden_open: BTreeSet<String> = g["open"].as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect();
        let rows: Vec<String> = if cell.trans == Trans::Missing { Vec::new() } else { rows_of(cell.trans, cell.rows).iter().map(|v| v.to_string()).collect() };
        let ghosts = proven_ghosts(&rows, &golden_open);
        ghosts_removed += ghosts.len();
        let want: BTreeSet<String> = golden_open.difference(&ghosts).cloned().collect();
        let missing: Vec<&String> = want.difference(&got.open).collect();
        if !missing.is_empty() {
            violations.push(format!("{}: open task(s) {missing:?} kept by the base reader are missing (got {:?})", cell.key(), got.open));
        }
        if got.open == golden_open {
            equal += 1;
        } else if got.open.difference(&golden_open).next().is_some() {
            extra_open += 1;
        }
        // the Rust ladder: a base "open" answer must not turn into "nothing open"
        if !want.is_empty() && g["ladder"] == json!(true) && got.ladder == Some(false) {
            violations.push(format!("{}: the ladder said open at the base and now says none", cell.key()));
        }
        // the Stop: a base block on a list that still has open tasks must not turn into an allow
        if !want.is_empty() && g["stop"] == json!("block") && got.stop == "allow" {
            violations.push(format!("{}: task-guard blocked the Stop at the base and now allows it", cell.key()));
        }
    }
    eprintln!(
        "task reader open-set gate: {checked} cells, {equal} equal to the golden, {extra_open} with extra open tasks, {ghosts_removed} proven-ghost ids excused, {:.1}s",
        t0.elapsed().as_secs_f64()
    );
    assert!(violations.is_empty(), "{} violation(s):\n{}", violations.len(), violations.join("\n"));
    assert_eq!(checked, cells.len(), "the golden holds cells the matrix no longer generates");
}

/// The gate itself: the ghost proof decodes rows, so a raw substring is not a mention, a conversation mention saves an id, and only an id
/// named by excluded rows alone is excused.
#[test]
fn a_ghost_is_proven_only_from_decoded_rows_of_an_excluded_type() {
    let ids = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<BTreeSet<String>>();
    let blob = json!({"type": "api-request-blob", "messages": [{"role": "user", "content": [{"type": "tool_result", "tool_use_id": "toolu_b", "content": "Task #9 created successfully: x"}]}]}).to_string();
    let conv = json!({"type": "assistant", "message": {"content": [{"type": "text", "text": "the 19 tasks and a line of id 9 prose, no marker"}]}}).to_string();
    // "9" is in the blob only (the conversation row holds the digit inside "19" / "id 9": not a `#9` mention, not an id field)
    assert_eq!(proven_ghosts(&[blob.clone(), conv.clone()], &ids(&["9", "toolu_b", "1"])), ids(&["9", "toolu_b"]));
    // named in a conversation row too: not proven
    let conv9 = json!({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "c9", "content": "Task #9 created successfully: x"}]}})
        .to_string();
    assert_eq!(proven_ghosts(&[blob.clone(), conv9], &ids(&["9"])), ids(&[]));
    // an unknown type, an empty type and a missing type are not excluded
    for row in [json!({"type": "zzz", "x": "Task #9"}), json!({"type": "", "x": "Task #9"}), json!({"x": "Task #9"})] {
        assert_eq!(proven_ghosts(&[blob.clone(), row.to_string()], &ids(&["9"])), ids(&[]), "{row}");
    }
    // a row that does not decode proves nothing, and an id no row names is never a ghost
    assert_eq!(proven_ghosts(&["not json #9".into()], &ids(&["9"])), ids(&[]));
    assert_eq!(proven_ghosts(&[blob], &ids(&["7"])), ids(&[]));
}

/// The matrix covers the shapes the five failed review rounds hit.
#[test]
fn the_matrix_names_the_shapes_of_the_failed_rounds() {
    let m = matrix();
    let has = |f: &dyn Fn(&Cell) -> bool| m.iter().any(f);
    assert!(has(&|c| c.store == Store::OneUnreadableRecord && c.trans == Trans::TodoWrite), "an unreadable store record next to TodoWrite tasks");
    assert!(has(&|c| c.store == Store::NonEmpty && c.trans == Trans::TodoWrite), "colliding ids: TodoWrite 1 against store 1");
    assert!(has(&|c| c.named == Named::SetWithList && c.trans == Trans::TodoWrite), "a named list selected with TodoWrite tasks");
    assert!(has(&|c| c.snap == Snap::ToolUseId && c.rows == Rows::Conv), "a toolu_-shaped snapshot entry");
    assert!(has(&|c| c.rows == Rows::Blob), "api-request-blob rows");
    let keys: BTreeSet<String> = m.iter().map(Cell::key).collect();
    assert_eq!(keys.len(), m.len(), "cell keys are unique");
}

// ===============================================================================================================================
// ---- THE CONSUMERS AXIS (#448) -----------------------------------------------------------------------------------------------
//
// The golden above only runs task-guard. Every OTHER consumer of the task reader decides from the same list, and a reader change that
// passes the open-set property can still relax one of them (stage A: task-pair-guard threw away the whole task set and allowed the Stop
// when the reader carried transcript uncertainty). This section records each consumer's DECISION per cell and holds it to
//
//   for every case and consumer:   decision(reader under test)  is at least as BLOCKING as  decision(golden)     (block >= nudge >= allow)
//                                  ids named by a blocking decision  ⊇  ids named by the golden, minus ids PROVEN to be ghosts
//                                  count stated by the decision  >=  the golden's, minus the proven ghosts
//
// The fixtures are the cells above (`build`, `probe`, `plant_snapshot`: the adapter section is reused, nothing is regenerated), the two
// extra store shapes of the #445 round-2 review, and the pair-guard cells at the end of this section. The golden is
// `tests/fixtures/task-reader-consumer-decisions.json`; regenerate ONLY on the base commit named in it:
// `AH_REGEN_TASK_READER_CONSUMERS=1 AH_GOLDEN_BASE=<sha> cargo test --test task_reader_open_set the_consumers`.
// Consumers not driven, and why: tests/fixtures/reader-mutations/README.md.

use ah_engine::checks::Verdict;

const CONSUMERS_GOLDEN: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/task-reader-consumer-decisions.json");
/// The agent every matrix cell launches (live) for the pair-guard Stop; the pair-guard Post names it.
const AGENT: (&str, &str) = ("job", "worker-alpha");
/// Task ids the by-id spawn check is probed with (`#<id> ...` as an unnamed spawn's description).
const PRE_IDS: [&str; 7] = ["1", "2", "3", "6", "7", "8", "9"];
/// Every task id a cell can hold: the universe the tasklist-guard dedupe signal is decoded against.
const ID_UNIVERSE: [&str; 14] =
    ["1", "2", "3", "6", "7", "8", "9", "x", "toolu_snapghost", "toolu_unans", "toolu_blob", "toolu_empty", "toolu_notype", "toolu_unk"];

/// block > nudge > allow.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Kind {
    Allow,
    Nudge,
    Block,
}

impl Kind {
    fn name(self) -> &'static str {
        match self {
            Kind::Allow => "allow",
            Kind::Nudge => "nudge",
            Kind::Block => "block",
        }
    }
    fn parse(s: &str) -> Kind {
        match s {
            "allow" => Kind::Allow,
            "nudge" => Kind::Nudge,
            "block" => Kind::Block,
            other => panic!("unknown decision kind {other:?}"),
        }
    }
}

/// What one consumer decided.
#[derive(Clone, Debug, PartialEq)]
struct Decision {
    kind: Kind,
    /// The start of the message (digits and ids kept), for people reading a failure.
    reason: String,
    /// The task ids the decision names.
    ids: BTreeSet<String>,
    /// A number of tasks the decision states (open tasks, tasks in progress).
    count: Option<u64>,
    /// The ids could not be recovered (tasklist-guard only).
    undecoded: bool,
    /// Every message string the consumer produced (whole, not cut), for the hand-written obligation cells; not part of the golden.
    full: String,
}

/// One case: a cell, plus what the pair-guard needs on top of it.
struct Case {
    key: String,
    cell: Cell,
    /// The consumer groups this case runs.
    groups: Vec<&'static str>,
    /// Live launched agents `(description, name)` the pair-guard Stop sees.
    agents: Vec<(&'static str, &'static str)>,
    /// Extra files of the session store directory `(file name, content)`.
    store_files: Vec<(&'static str, String)>,
    /// Store files made unreadable (mode 000).
    unreadable: Vec<&'static str>,
    /// Extra conversation rows appended to the transcript.
    rows: Vec<Value>,
    pre_ids: Vec<&'static str>,
}

const ALL_GROUPS: [&str; 8] = ["ladder", "pair_stop", "pair_post", "pair_pre", "tasklist", "tracker", "hygiene", "compact"];
const PAIR_GROUPS: [&str; 3] = ["pair_stop", "pair_post", "pair_pre"];

fn plain_case(cell: Cell) -> Case {
    Case {
        key: cell.key(),
        cell,
        groups: ALL_GROUPS.to_vec(),
        agents: vec![AGENT],
        store_files: Vec::new(),
        unreadable: Vec::new(),
        rows: Vec::new(),
        pre_ids: PRE_IDS.to_vec(),
    }
}

fn store_rec(id: &str, status: &str, owner: Option<&str>) -> String {
    let mut v = json!({"id": id, "subject": format!("store {id}"), "status": status});
    if let Some(o) = owner {
        v["owner"] = json!(o);
    }
    v.to_string()
}

/// The pair-guard cells the matrix has no axis for: ownership and live agents.
fn pair_cases() -> Vec<Case> {
    let base = |store, trans| Cell { store, named: Named::Unset, trans, snap: Snap::None, rows: Rows::Conv, knobs: Knobs::new() };
    let pair = |key: &str, cell: Cell, agents: Vec<(&'static str, &'static str)>| Case {
        key: format!("pair|{key}"),
        cell,
        groups: PAIR_GROUPS.to_vec(),
        agents,
        store_files: Vec::new(),
        unreadable: Vec::new(),
        rows: Vec::new(),
        pre_ids: vec!["1", "2"],
    };
    let mut out = Vec::new();
    // two live named agents: worker-a owns open store task 1, worker-b owns none
    let mut c = pair("two_agents_one_owner", base(Store::Empty, Trans::NoTasks), vec![("job a", "worker-a"), ("job b", "worker-b")]);
    c.store_files = vec![("1.json", store_rec("1", "pending", Some("worker-a"))), ("2.json", store_rec("2", "pending", None))];
    out.push(c);
    // both agents own an open task: clean
    let mut c = pair("two_agents_two_owners", base(Store::Empty, Trans::NoTasks), vec![("job a", "worker-a"), ("job b", "worker-b")]);
    c.store_files = vec![("1.json", store_rec("1", "pending", Some("worker-a"))), ("2.json", store_rec("2", "in_progress", Some("worker-b")))];
    out.push(c);
    // a store task owned by an agent next to a malformed sibling record (not JSON / unreadable)
    let mut c = pair("owner_with_junk_sibling", base(Store::Empty, Trans::NoTasks), vec![("job a", "worker-a")]);
    c.store_files = vec![("1.json", store_rec("1", "pending", Some("worker-a"))), ("2.json", "{not json".to_string())];
    out.push(c);
    let mut c = pair("owner_with_unreadable_sibling", base(Store::Empty, Trans::NoTasks), vec![("job a", "worker-a")]);
    c.store_files = vec![("1.json", store_rec("1", "pending", Some("worker-a"))), ("2.json", store_rec("2", "pending", None))];
    c.unreadable = vec!["2.json"];
    out.push(c);
    let mut c = pair("owner_with_numeric_status_sibling", base(Store::Empty, Trans::NoTasks), vec![("job a", "worker-a")]);
    c.store_files = vec![("1.json", store_rec("1", "pending", Some("worker-a"))), ("2.json", json!({"id": "2", "status": 3}).to_string())];
    out.push(c);
    // a TodoWrite whose item has an uncertain status (a number) in the transcript, next to every kind of store
    for (tag, store) in [("absent", Store::Absent), ("nonempty", Store::NonEmpty), ("junk", Store::OneJunkRecord), ("unreadable_dir", Store::UnreadableDir)] {
        let mut c = pair(&format!("todowrite_status_123|store={tag}"), base(store, Trans::NoTasks), vec![("job a", "worker-a")]);
        c.rows = vec![todo_raw(json!([{"id": "1", "content": "odd status", "status": 123}, {"id": "2", "content": "fine", "status": "pending"}]))];
        out.push(c);
    }
    out
}

/// Cells with several tasks in progress, which the matrix has none of: tasklist-guard reads them as stalled (no live agent) and states
/// how many, and the tracker counts them.
fn stalled_cases() -> Vec<Case> {
    let base = |store, trans| Cell { store, named: Named::Unset, trans, snap: Snap::None, rows: Rows::Conv, knobs: Knobs::new() };
    let mk = |key: &str, cell: Cell| Case { key: format!("tasks|{key}"), pre_ids: vec!["1", "2", "3"], ..plain_case(cell) };
    let two =
        || vec![("1.json", store_rec("1", "in_progress", None)), ("2.json", store_rec("2", "in_progress", None)), ("3.json", store_rec("3", "pending", None))];
    let three_todo = || {
        todo_raw(
            json!([{"id": "1", "content": "a", "status": "in_progress"}, {"id": "2", "content": "b", "status": "in_progress"}, {"id": "3", "content": "c", "status": "in_progress"}]),
        )
    };
    let mut out = Vec::new();
    let mut c = mk("two_in_progress_store", base(Store::Empty, Trans::TaskCreate));
    c.store_files = two();
    out.push(c);
    let mut c = mk("two_in_progress_store_with_junk", base(Store::Empty, Trans::TaskCreate));
    c.store_files = two();
    c.store_files.push(("4.json", "{not json".to_string()));
    out.push(c);
    let mut c = mk("three_in_progress_todowrite_no_store", base(Store::Absent, Trans::NoTasks));
    c.rows = vec![three_todo()];
    out.push(c);
    let mut c = mk("three_in_progress_todowrite_junk_store", base(Store::OneJunkRecord, Trans::NoTasks));
    c.rows = vec![three_todo()];
    out.push(c);
    out
}

fn todo_raw(todos: Value) -> Value {
    tool_use("tw-raw", "TodoWrite", json!({ "todos": todos }))
}

fn cases() -> Vec<Case> {
    let mut out: Vec<Case> = matrix().into_iter().map(plain_case).collect();
    out.extend(extra_cells().into_iter().map(plain_case));
    out.extend(pair_cases());
    out.extend(stalled_cases());
    out
}

/// Shapes the golden matrix has no axis for (#445 round 2: duplicate ids inside the store, a completed task next to junk).
fn extra_cells() -> Vec<Cell> {
    let mk = |store, trans, snap| Cell { store, named: Named::Unset, trans, snap, rows: Rows::Conv, knobs: Knobs::new() };
    vec![mk(Store::DupIdWithJunk, Trans::TodoWrite, Snap::None), mk(Store::CompletedWithJunk, Trans::NoTasks, Snap::Plain)]
}

// ---- the consumer adapter: every call into a consumer of the reader goes through this part ---------------------------------------

struct Fx {
    home: PathBuf,
    t: PathBuf,
    proj: PathBuf,
    env: RequestEnv,
}

fn agent_rows(agents: &[(&str, &str)]) -> Vec<Value> {
    let ts = "2026-10-06T12:30:00.000Z";
    let mut out = Vec::new();
    for (i, (description, name)) in agents.iter().enumerate() {
        let agent = format!("a{:015x}", i + 1);
        let input = json!({"description": description, "name": name, "prompt": "p", "run_in_background": true});
        out.push(json!({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "tool_use", "id": format!("toolu_ag{i}"), "name": "Agent", "input": input}]}, "timestamp": ts}));
        let text = format!(
            "Async agent launched successfully. (internal metadata)\nagentId: {agent} (internal ID)\nThe agent is working in the background.\noutput_file: /tmp/x/{agent}.output\n"
        );
        out.push(json!({"type": "user", "message": {"role": "user", "content": [{"tool_use_id": format!("toolu_ag{i}"), "type": "tool_result", "content": [{"type": "text", "text": text}]}]}, "timestamp": ts}));
    }
    out
}

/// The agent tracker's proof that the agents are live (a fresh subagent transcript and a retained row each).
fn track_agents(home: &Path, agents: &[(&str, &str)]) {
    if agents.is_empty() {
        return;
    }
    let mut st = ah_engine::agents::State::default();
    for (i, (description, _)) in agents.iter().enumerate() {
        let id = format!("a{:015x}", i + 1);
        let rel = format!(".claude/projects/p/{SID}/subagents/agent-{id}.jsonl");
        std::fs::create_dir_all(home.join(&rel).parent().unwrap()).unwrap();
        std::fs::write(home.join(&rel), format!("{}\n", json!({"type": "assistant", "message": {"content": [{"type": "text", "text": "working"}]}}))).unwrap();
        let a = ah_engine::agents::Agent {
            id: id.clone(),
            kind: "subagent".into(),
            parent: SID.into(),
            name: (*description).into(),
            cwd: home.to_string_lossy().into_owned(),
            path: home.join(rel).to_string_lossy().into_owned(),
            ..Default::default()
        };
        st.agents.insert(id, a);
    }
    std::fs::create_dir_all(home.join(".anti-hall/agent-tracker")).unwrap();
    std::fs::write(home.join(".anti-hall/agent-tracker/state.json"), serde_json::to_string(&st).unwrap()).unwrap();
}

/// A fresh world for one consumer run: the cell's files, the case's extras, rows appended (before the snapshot is planted, so its
/// fingerprint matches), the project directory the cwd names, the tracker state of the live agents.
fn fixture(case: &Case, root: &Path, extra_rows: &[Value], agents: &[(&str, &str)]) -> Fx {
    std::fs::create_dir_all(root).unwrap();
    let (home, t) = build(&case.cell, root);
    let dir = home.join(".claude/tasks").join(format!("session-{SID8}"));
    for (name, body) in &case.store_files {
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(name), body).unwrap();
    }
    #[cfg(unix)]
    for n in &case.unreadable {
        chmod(&dir.join(n), 0o000);
    }
    let proj = root.join("proj");
    std::fs::create_dir_all(proj.join(".git")).unwrap();
    std::fs::create_dir_all(root.join("tmp")).unwrap(); // the guard's temp root: pinned disjoint from proj so the verdict does not depend on where the runner puts its scratch
    if t.exists() {
        use std::io::Write;
        let mut rows = case.rows.clone();
        rows.extend(extra_rows.iter().cloned());
        rows.extend(agent_rows(agents));
        let mut f = std::fs::OpenOptions::new().append(true).open(&t).unwrap();
        f.write_all(rows.iter().map(line).collect::<String>().as_bytes()).unwrap();
    }
    probe(&home);
    let mut pairs = vec![
        ("HOME".to_string(), home.to_string_lossy().into_owned()),
        ("ANTIHALL_PAIR_RULE".to_string(), "1".to_string()),
        ("TMPDIR".to_string(), root.join("tmp").to_string_lossy().into_owned()),
    ];
    if case.cell.named != Named::Unset {
        pairs.push(("CLAUDE_CODE_TASK_LIST_ID".to_string(), NAMED_LIST.to_string()));
    }
    let env = RequestEnv::from_pairs(pairs);
    plant_snapshot(&case.cell, &home, &t, &env);
    track_agents(&home, agents);
    Fx { home, t, proj, env }
}

fn flatten(v: &Value, out: &mut String) {
    match v {
        Value::String(s) => {
            out.push_str(s);
            out.push('\n');
        }
        Value::Array(a) => a.iter().for_each(|x| flatten(x, out)),
        Value::Object(m) => m.values().for_each(|x| flatten(x, out)),
        _ => {}
    }
}

/// Every `#<id>` of a text.
fn ids_in(text: &str) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    let mut rest = text;
    while let Some(at) = rest.find('#') {
        let id: String = rest[at + 1..].chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_').collect();
        if !id.is_empty() {
            out.insert(id);
        }
        rest = &rest[at + 1..];
    }
    out
}

/// The block-details files the guards saved (the whole list a visible line may cut).
fn saved_details(home: &Path) -> String {
    let mut out = String::new();
    for e in std::fs::read_dir(home.join(".anti-hall/block-details")).into_iter().flatten().flatten() {
        out.push_str(&std::fs::read_to_string(e.path()).unwrap_or_default());
        out.push('\n');
    }
    out
}

/// The message strings of a payload that may be JSON (a hook's `reason`, `additionalContext`, ...), else the raw text.
fn message_of(raw: &str) -> String {
    match serde_json::from_str::<Value>(raw.trim()) {
        Ok(j) => {
            let mut text = String::new();
            for key in ["reason", "additionalContext", "systemMessage"] {
                for v in [&j[key], &j["hookSpecificOutput"][key]] {
                    if let Some(s) = v.as_str() {
                        text.push_str(s);
                        text.push('\n');
                    }
                }
            }
            if text.is_empty() {
                flatten(&j, &mut text);
            }
            text
        }
        Err(_) => format!("{raw}\n"),
    }
}

/// A verdict as a decision. `text` is every message string it carries, flattened.
fn verdict_text(v: &Option<Option<Verdict>>) -> (Kind, String) {
    match v {
        Some(Some(Verdict::Allow)) | Some(None) => (Kind::Allow, String::new()),
        Some(Some(Verdict::Block(s))) => (Kind::Block, message_of(s)),
        Some(Some(Verdict::Advisory(s))) => (Kind::Nudge, message_of(s)),
        Some(Some(Verdict::Exact(x))) => {
            let text = format!("{}{}", message_of(&x.out), message_of(&x.err));
            let blocking = x.code == 2 || serde_json::from_str::<Value>(x.out.trim()).is_ok_and(|j| j["decision"] == json!("block"));
            let kind = if blocking {
                Kind::Block
            } else if text.trim().is_empty() {
                Kind::Allow
            } else {
                Kind::Nudge
            };
            (kind, text)
        }
        other => panic!("unexpected verdict shape {other:?}"),
    }
}

fn head_of(text: &str) -> String {
    text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("").chars().take(110).collect()
}

fn decision(v: &Option<Option<Verdict>>, home: &Path) -> Decision {
    let (kind, text) = verdict_text(v);
    let ids = if kind == Kind::Allow { BTreeSet::new() } else { ids_in(&format!("{text}\n{}", saved_details(home))) };
    Decision { kind, reason: head_of(&text), ids, count: None, undecoded: false, full: format!("{text}\n{}", saved_details(home)) }
}

fn hook(name: &str, payload: &Value, event: &str, fx: &Fx) -> Option<Option<Verdict>> {
    ah_engine::script::run_forced(name, payload, &Value::Null, event, &fx.env)
}

fn base_payload(fx: &Fx, event: &str) -> Value {
    json!({"hook_event_name": event, "session_id": SID, "cwd": fx.proj, "transcript_path": fx.t})
}

/// The Rust ladder.
fn consumer_ladder(case: &Case, root: &Path) -> Decision {
    let fx = fixture(case, root, &[], &[]);
    let r = ladder_has_open(&fx.home, &fx.t);
    unlock(&fx.home);
    Decision {
        kind: if r == Some(true) { Kind::Block } else { Kind::Allow },
        reason: format!("ladder {r:?}"),
        ids: BTreeSet::new(),
        count: None,
        undecoded: false,
        full: String::new(),
    }
}

/// task-pair-guard Stop: a live named agent that owns no open task blocks, but only when the list was read.
fn consumer_pair_stop(case: &Case, root: &Path) -> Decision {
    let fx = fixture(case, root, &[], &case.agents);
    let v = hook("task-pair-guard", &base_payload(&fx, "Stop"), "Stop", &fx);
    let d = decision(&v, &fx.home);
    unlock(&fx.home);
    d
}

/// task-pair-guard PostToolUse: a named spawn whose name owns no open task gets a nudge, but only when the list was read.
fn consumer_pair_post(case: &Case, root: &Path) -> Decision {
    let name = case.agents.first().map_or(AGENT.1, |a| a.1);
    let fx = fixture(case, root, &[], &[]);
    let mut p = base_payload(&fx, "PostToolUse");
    p["tool_name"] = json!("Agent");
    p["tool_input"] = json!({"description": "port the wake", "prompt": "do it", "name": name, "run_in_background": true});
    p["tool_response"] = json!({"status": "async_launched", "agentId": "a000000000000001"});
    let v = hook("task-pair-guard", &p, "PostToolUse", &fx);
    let d = decision(&v, &fx.home);
    unlock(&fx.home);
    d
}

/// task-pair-guard PreToolUse, the by-id proof: an unnamed spawn `#<id> ...` is allowed only on positive proof that task `id` is open.
fn consumer_pair_pre(case: &Case, root: &Path, id: &str) -> Decision {
    let fx = fixture(case, root, &[], &[]);
    let mut p = base_payload(&fx, "PreToolUse");
    p["tool_name"] = json!("Agent");
    p["tool_input"] = json!({"description": format!("#{id} do the thing"), "prompt": "do it", "run_in_background": true});
    let v = hook("task-pair-guard", &p, "PreToolUse", &fx);
    let mut d = decision(&v, &fx.home);
    d.reason = format!("by-id #{id}: {}", d.reason);
    unlock(&fx.home);
    d
}

/// The transcript rows that make a session non-trivial for tasklist-guard: more counted edits than its threshold.
fn edit_rows(proj: &Path) -> Vec<Value> {
    (0..4)
        .map(|i| tool_use(&format!("edit{i}"), "Edit", json!({"file_path": proj.join(format!("src/f{i}.rs")), "old_string": "a", "new_string": "b"})))
        .collect()
}

/// The ids the tasklist-guard dedupe signal was computed over, recovered from the hash the guard stored (its state file): the guard
/// itself is the only thing that can say which open ids it saw. `None`: no stored hash, or no subset of the id universe reproduces it.
fn decode_tasklist_ids(home: &Path, work: u64) -> Option<Option<BTreeSet<String>>> {
    let prefix = ah_engine::defaults::text("tasklist_guard.state_prefix");
    let ext = ah_engine::defaults::text("tasklist_guard.state_ext");
    let entries = std::fs::read_dir(home.join(".anti-hall")).ok()?;
    let file = entries.flatten().find(|e| {
        let n = e.file_name().to_string_lossy().into_owned();
        n.starts_with(&format!("{prefix}-")) && n.ends_with(ext)
    })?;
    let state: Value = serde_json::from_str(&std::fs::read_to_string(file.path()).ok()?).ok()?;
    let want = state["hash"].as_str()?.to_string();
    let (sep, ids_sep) = (ah_engine::defaults::text("tasklist_guard.signal_sep"), ah_engine::defaults::text("tasklist_guard.open_ids_sep"));
    let hash_len = ah_engine::defaults::num("tasklist_guard.open_hash_len") as usize;
    let bucket = (work / 3).min(ah_engine::defaults::num("tasklist_guard.work_bucket_max") as u64);
    let sha = |s: &str| ah_engine::checks::replykit::io::sha1_hex(s);
    for bits in 0..8u32 {
        let bit = |n: u32| if bits & (1 << n) != 0 { "1" } else { "0" };
        for mask in 0..(1u32 << ID_UNIVERSE.len()) {
            let mut ids: Vec<&str> = ID_UNIVERSE.iter().enumerate().filter(|(i, _)| mask & (1 << i) != 0).map(|(_, s)| *s).collect();
            ids.sort_unstable();
            let open_hash: String = sha(&ids.join(ids_sep)).chars().take(hash_len).collect();
            let signal = [bucket.to_string(), bit(0).into(), bit(1).into(), bit(2).into(), open_hash].join(sep);
            if sha(&signal) == want {
                return Some(Some(ids.into_iter().map(str::to_string).collect()));
            }
        }
    }
    Some(None)
}

/// tasklist-guard Stop: the guard's own verdict, and the open ids its dedupe signal was computed over.
fn consumer_tasklist(case: &Case, root: &Path) -> Decision {
    let proj_probe = root.join("proj");
    let rows = edit_rows(&proj_probe);
    let fx = fixture(case, root, &rows, &[]);
    let v = hook("tasklist-guard", &base_payload(&fx, "Stop"), "Stop", &fx);
    let mut d = decision(&v, &fx.home);
    d.ids = BTreeSet::new();
    if d.kind != Kind::Allow {
        match decode_tasklist_ids(&fx.home, rows.len() as u64) {
            Some(Some(ids)) => d.ids = ids,
            _ => d.undecoded = true,
        }
        // "N tasks in progress" of the stalled message
        d.count = count_after(&flatten_text(&v), " tasks are marked in progress");
    }
    unlock(&fx.home);
    d
}

fn flatten_text(v: &Option<Option<Verdict>>) -> String {
    verdict_text(v).1
}

/// The integer written just before `marker` ("2 tasks in progress").
fn count_after(text: &str, marker: &str) -> Option<u64> {
    let at = text.find(marker)?;
    let digits: String = text[..at].trim_end().chars().rev().take_while(char::is_ascii_digit).collect::<Vec<_>>().into_iter().rev().collect();
    digits.parse().ok()
}

/// task-tracker UserPromptSubmit: the open-tasks line and the dispatch line, from the lines of the note that state them.
fn consumer_tracker(case: &Case, root: &Path) -> Decision {
    let fx = fixture(case, root, &[], &[]);
    let mut p = base_payload(&fx, "UserPromptSubmit");
    p["prompt"] = json!("keep going");
    let v = hook("task-tracker", &p, "UserPromptSubmit", &fx);
    let (kind, text) = verdict_text(&v);
    let lines: Vec<&str> = text.lines().filter(|l| l.contains("open tasks:") || l.contains("DISPATCH NOW")).collect();
    let joined = lines.join("\n");
    let count = joined.find("open tasks:").and_then(|at| {
        let d: String = joined[at + "open tasks:".len()..].trim_start().chars().take_while(char::is_ascii_digit).collect();
        d.parse().ok()
    });
    let d = Decision {
        kind,
        reason: if joined.is_empty() { head_of(&text) } else { head_of(&joined) },
        ids: ids_in(&joined),
        count,
        undecoded: false,
        full: text.clone(),
    };
    unlock(&fx.home);
    d
}

/// tasklist-hygiene PostToolUse on a TaskCreate with the open-task budget lowered to 1: the breach states how many tasks are open (the
/// list is read from the transcript or the store; a list that cannot be read exactly says nothing).
fn consumer_hygiene(case: &Case, root: &Path) -> Decision {
    let fx = fixture(case, root, &[], &[]);
    std::fs::write(fx.home.join(".anti-hall/settings.json"), r#"{"handover":{"taskListBudget":1,"taskListEnforce":"advisory"}}"#).unwrap();
    let mut p = base_payload(&fx, "PostToolUse");
    p["tool_name"] = json!("TaskCreate");
    p["tool_input"] = json!({"subject": "brand new task", "description": ""});
    p["tool_response"] = json!({"id": "99"});
    let v = hook("tasklist-hygiene", &p, "PostToolUse", &fx);
    let mut d = decision(&v, &fx.home);
    let text = flatten_text(&v);
    d.count = count_after(&text, " open tasks (budget");
    unlock(&fx.home);
    d
}

/// compact-advice-guard Stop: a "safe to compact" declaration is refused while the task list holds finished tasks (or too many), and
/// says how many.
fn consumer_compact(case: &Case, root: &Path) -> Decision {
    let fx = fixture(case, root, &[], &[]);
    let mut p = base_payload(&fx, "Stop");
    p["last_assistant_message"] = json!("All the work is finished.\n\nSafe to compact.");
    let v = hook("compact-advice-guard", &p, "Stop", &fx);
    let mut d = decision(&v, &fx.home);
    d.ids = BTreeSet::new();
    // the visible line cuts the reasons; the saved details hold them whole
    d.count = count_after(&format!("{}\n{}", flatten_text(&v), saved_details(&fx.home)), " finished tasks are still");
    unlock(&fx.home);
    d
}

/// Every decision of a case, keyed by consumer.
fn run_case(case: &Case, base: &Path) -> BTreeMap<String, Decision> {
    let mut out = BTreeMap::new();
    let sub = |name: &str| base.join(name);
    for g in &case.groups {
        match *g {
            "ladder" => {
                out.insert("ladder".into(), consumer_ladder(case, &sub("ladder")));
            }
            "pair_stop" => {
                out.insert("pair_stop".into(), consumer_pair_stop(case, &sub("pair_stop")));
            }
            "pair_post" => {
                out.insert("pair_post".into(), consumer_pair_post(case, &sub("pair_post")));
            }
            "pair_pre" => {
                for id in &case.pre_ids {
                    out.insert(format!("pair_pre:{id}"), consumer_pair_pre(case, &sub(&format!("pair_pre{id}")), id));
                }
            }
            "tasklist" => {
                out.insert("tasklist_stop".into(), consumer_tasklist(case, &sub("tasklist")));
            }
            "tracker" => {
                out.insert("tracker_prompt".into(), consumer_tracker(case, &sub("tracker")));
            }
            "hygiene" => {
                out.insert("hygiene_post".into(), consumer_hygiene(case, &sub("hygiene")));
            }
            "compact" => {
                out.insert("compact_advice".into(), consumer_compact(case, &sub("compact")));
            }
            other => panic!("unknown consumer group {other}"),
        }
    }
    out
}

fn run_all_cases() -> Vec<(Case, BTreeMap<String, Decision>)> {
    let base = scratch("consumers");
    let out = cases()
        .into_iter()
        .enumerate()
        .map(|(i, case)| {
            let root = base.join(i.to_string());
            std::fs::create_dir_all(&root).unwrap();
            let d = run_case(&case, &root);
            (case, d)
        })
        .collect();
    std::fs::remove_dir_all(&base).ok();
    out
}

fn decision_json(d: &Decision) -> Value {
    json!({"kind": d.kind.name(), "reason": d.reason, "ids": d.ids, "count": d.count})
}

/// The ghost ids a case's golden open set excuses: the open ids of the task-guard golden cell that every mention proves to be a ghost.
fn excused_ghosts(case: &Case, task_guard_golden: &Value) -> BTreeSet<String> {
    let Some(g) = task_guard_golden["cells"].get(case.key.as_str()) else { return BTreeSet::new() };
    let open: BTreeSet<String> = g["open"].as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect();
    let rows: Vec<String> =
        if case.cell.trans == Trans::Missing { Vec::new() } else { rows_of(case.cell.trans, case.cell.rows).iter().map(|v| v.to_string()).collect() };
    proven_ghosts(&rows, &open)
}

/// The violations of `got` against `golden` for one case and consumer (empty: the decision is at least as blocking).
fn violations(case: &Case, consumer: &str, golden: &Value, got: &Decision, ghosts: &BTreeSet<String>, golden_open: &BTreeSet<String>) -> Vec<String> {
    let mut out = Vec::new();
    let gk = Kind::parse(golden["kind"].as_str().unwrap());
    let g_ids: BTreeSet<String> = golden["ids"].as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect();
    let g_count = golden["count"].as_u64();
    // every open task the golden had is a proven ghost: the decision may legitimately fall back
    let all_ghosts = !ghosts.is_empty() && golden_open.difference(ghosts).next().is_none();
    let at = format!("{} / {consumer}", case.key);
    if got.kind < gk {
        if !all_ghosts {
            out.push(format!("{at}: the base {} (\"{}\") became {} (\"{}\")", gk.name(), golden["reason"].as_str().unwrap_or(""), got.kind.name(), got.reason));
        }
        return out;
    }
    if gk == Kind::Block && got.kind == Kind::Block {
        let missing: Vec<&String> = g_ids.difference(ghosts).filter(|i| !got.ids.contains(*i)).collect();
        if !missing.is_empty() {
            out.push(format!("{at}: the block no longer names task(s) {missing:?} (names {:?})", got.ids));
        }
        if got.undecoded {
            out.push(format!("{at}: the open ids the guard computed over could not be recovered"));
        }
    }
    if let Some(c) = g_count {
        let floor = c.saturating_sub(ghosts.len() as u64);
        match got.count {
            Some(n) if n >= floor => {}
            other => out.push(format!("{at}: the decision states {other:?} task(s), the base stated {c}")),
        }
    }
    out
}

#[test]
fn the_consumers_of_the_task_reader_never_decide_less_than_the_base() {
    let t0 = std::time::Instant::now();
    let observed = run_all_cases();
    let total: usize = observed.iter().map(|(_, d)| d.len()).sum();
    if std::env::var("AH_CONSUMERS_DUMP").is_ok() {
        for (case, ds) in &observed {
            for (name, d) in ds {
                eprintln!(
                    "DUMP {} | {name} | {} | {:?} | {:?} | {:?}{}",
                    case.key,
                    d.kind.name(),
                    d.reason,
                    d.ids,
                    d.count,
                    if d.undecoded { " | UNDECODED" } else { "" }
                );
            }
        }
    }
    if std::env::var("AH_REGEN_TASK_READER_CONSUMERS").is_ok_and(|v| v == "1") {
        let mut cells = BTreeMap::new();
        for (case, ds) in &observed {
            for (name, d) in ds {
                assert!(!d.undecoded, "{} / {name}: the tasklist ids could not be decoded; widen ID_UNIVERSE", case.key);
            }
            cells.insert(case.key.clone(), ds.iter().map(|(k, d)| (k.clone(), decision_json(d))).collect::<BTreeMap<_, _>>());
        }
        let doc = json!({
            "about": "Decisions of every consumer of the task reader (task-pair-guard Stop/Post/Pre-by-id, tasklist-guard, task-tracker, the Rust ladder), one per case of tests/task_reader_open_set.rs. Regenerate only on the base commit named here.",
            "captured_on": std::env::var("AH_GOLDEN_BASE").unwrap_or_else(|_| "unset".into()),
            "cells": cells,
        });
        std::fs::write(CONSUMERS_GOLDEN, serde_json::to_string_pretty(&doc).unwrap() + "\n").unwrap();
        eprintln!("consumer golden written: {} cases, {total} decisions", observed.len());
        return;
    }
    let golden: Value = serde_json::from_str(&std::fs::read_to_string(CONSUMERS_GOLDEN).expect("the committed consumer golden")).unwrap();
    let task_guard_golden: Value = serde_json::from_str(&std::fs::read_to_string(GOLDEN).expect("the task-guard golden")).unwrap();
    let cells = golden["cells"].as_object().expect("cells");
    let mut found: Vec<String> = Vec::new();
    let (mut checked, mut equal, mut stricter) = (0usize, 0usize, 0usize);
    for (case, ds) in &observed {
        let g = cells.get(&case.key).unwrap_or_else(|| panic!("no golden case {}: regenerate on the base commit", case.key));
        let ghosts = excused_ghosts(case, &task_guard_golden);
        let golden_open: BTreeSet<String> = task_guard_golden["cells"]
            .get(case.key.as_str())
            .map(|c| c["open"].as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect())
            .unwrap_or_default();
        for (name, got) in ds {
            let gd = g.get(name).unwrap_or_else(|| panic!("no golden decision {} / {name}", case.key));
            checked += 1;
            found.extend(violations(case, name, gd, got, &ghosts, &golden_open));
            if got.kind.name() == gd["kind"].as_str().unwrap()
                && got.ids == gd["ids"].as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect()
            {
                equal += 1;
            } else if got.kind > Kind::parse(gd["kind"].as_str().unwrap()) {
                stricter += 1;
            }
        }
    }
    eprintln!(
        "task reader consumers gate: {} cases, {checked} decisions ({} consumers), {equal} equal to the golden, {stricter} stricter, {:.1}s",
        observed.len(),
        observed.iter().flat_map(|(_, d)| d.keys().map(|k| k.split(':').next().unwrap().to_string())).collect::<BTreeSet<_>>().len(),
        t0.elapsed().as_secs_f64()
    );
    assert!(found.is_empty(), "{} violation(s):\n{}", found.len(), found.join("\n"));
    let golden_total: usize = cells.values().map(|c| c.as_object().unwrap().len()).sum();
    assert_eq!(checked, golden_total, "the golden holds decisions the cases no longer produce");
}

// ===============================================================================================================================
// ---- HAND-WRITTEN OBLIGATIONS (W1-1F, rule 14 (b)-(e)) -----------------------------------------------------------------------
//
// The two goldens above are CAPTURED on the base `c2ebe24d`, so they record the base's defects as the expected answer and can only be
// held to a DIRECTION (never less blocking than the base). The cells below are the other half: each one is written by hand from the
// spec (GH 606 shapes 1-4, GH 599, the pair-guard contract) and asserts the EXACT answer, whatever any build says.
//
//   * ALLOW cells (`*|allow|*`, rule 14 (b)): the correct answer is allow; a reader that blocks them has a false positive.
//   * obligation cells (rule 14 (c)): the correct answer is a block (or an allow only a correct reader can prove), and a cell names the
//     task ids and the message words that show the block is for the right reason (the task id, the agent that owns no task, ...).
//   * XF cells (rule 14 (e)): cells the base gets wrong. Each is listed in `tests/fixtures/task-reader-expected-failures.toml` with the
//     defect and the lane that removes the entry. A listed cell that fails is expected; a listed cell that PASSES is STALE (the entry
//     must go); a cell that fails and is not listed is a NEW failure. A listed `case` that no cell has is refused.
//   * ratchet (rule 14 (d)): a cell, once merged, is never removed or weakened.
//
// Two groups, one per axis: `open|...` (the reader's open set, the Rust ladder and the task-guard Stop) and `oblig|...` (the consumers).

/// The expected-failure list.
const XF_LIST: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/task-reader-expected-failures.toml");

#[derive(serde::Deserialize, Debug)]
struct XfEntry {
    case: String,
    defect: String,
    lane: String,
    reason: String,
}

#[derive(serde::Deserialize, Debug)]
struct XfList {
    #[serde(default)]
    decision: Vec<XfEntry>,
}

/// Which lane removes the entries of a defect (plan rule 14 (e) owners).
const XF_OWNERS: [(&str, &str); 5] = [("XF-D1", "W1-4"), ("XF-D4", "W1-4"), ("XF-D2", "W1-5"), ("XF-D3", "W1-3"), ("XF-G", "W1-6")];

/// Load the list and refuse a malformed or mistyped entry: a `case` that is no cell of the obligation corpus, a defect nobody owns, a
/// lane that is not the defect's owner, a missing reason.
fn load_xf() -> XfList {
    let list: XfList =
        toml::from_str(&std::fs::read_to_string(XF_LIST).expect("the expected-failure list")).expect("task-reader-expected-failures.toml parses");
    let known = known_obligations();
    let mut seen = BTreeSet::new();
    for d in &list.decision {
        assert!(known.contains(&d.case), "expected-failure list: `{}` is not a cell of the obligation corpus (a mistyped entry)", d.case);
        assert!(seen.insert(d.case.clone()), "expected-failure list: `{}` is listed twice", d.case);
        let owner =
            XF_OWNERS.iter().find(|(def, _)| *def == d.defect).unwrap_or_else(|| panic!("expected-failure list: `{}`: unknown defect `{}`", d.case, d.defect));
        assert_eq!(owner.1, d.lane, "expected-failure list: `{}`: defect {} belongs to lane {}", d.case, d.defect, owner.1);
        assert!(!d.reason.trim().is_empty(), "expected-failure list: `{}` has no reason", d.case);
    }
    list
}

/// `compare_decisions` of `tests/no_node/expected.rs` (the same semantics, not shared: that file is the no_node binary's): a mismatching
/// cell that is not listed is a NEW failure, a listed cell of this axis that matches is STALE.
fn xf_problems(list: &XfList, prefix: &str, mismatched: &[(String, String)], checked: &[String]) -> Vec<String> {
    let mut problems = Vec::new();
    for (case, why) in mismatched {
        if !list.decision.iter().any(|d| &d.case == case) {
            problems.push(format!("NEW failure (not listed): `{case}`: {why}"));
        }
    }
    for d in &list.decision {
        if d.case.starts_with(prefix) && checked.contains(&d.case) && !mismatched.iter().any(|(c, _)| c == &d.case) {
            problems.push(format!(
                "STALE expected failure (the cell passes now, remove the entry and report `XF transferred`): `{}` ({} -> {})",
                d.case, d.defect, d.lane
            ));
        }
    }
    problems
}

fn known_obligations() -> BTreeSet<String> {
    open_obligations().into_iter().map(|o| o.name.to_string()).chain(consumer_obligations().into_iter().map(|(c, _)| c.key)).collect()
}

// ---- axis 1: the open set, the Rust ladder and the task-guard Stop ---------------------------------------------------------------

struct OpenOblig {
    name: &'static str,
    cell: Cell,
    /// The exact open set; `None`: the spec does not fix it.
    open: Option<&'static [&'static str]>,
    /// The task-guard Stop verdict: "block" or "allow".
    stop: &'static str,
    /// The Rust ladder, exactly; `None`: the spec does not fix it.
    ladder: Option<bool>,
}

fn open_obligations() -> Vec<OpenOblig> {
    let cell = |store, named, trans| Cell { store, named, trans, snap: Snap::None, rows: Rows::Conv, knobs: Knobs::new() };
    let o = |name, cell, open, stop, ladder| OpenOblig { name, cell, open, stop, ladder };
    vec![
        // ---- ALLOW (rule 14 (b)): nothing is open, so nothing may block
        o("open|allow|no_tasks_anywhere", cell(Store::Absent, Named::Unset, Trans::NoTasks), Some(&[]), "allow", Some(false)),
        o("open|allow|only_a_completed_store_task", cell(Store::CompletedOnly, Named::Unset, Trans::NoTasks), Some(&[]), "allow", Some(false)),
        o("open|allow|a_task_of_another_list_is_not_ours", cell(Store::Empty, Named::SetOtherList, Trans::NoTasks), Some(&[]), "allow", Some(false)),
        o("open|hard|transcript_create_one_open_one_completed", cell(Store::Absent, Named::Unset, Trans::TaskCreate), Some(&["1"]), "block", Some(true)),
        // ---- obligations that hold on the base (hard)
        o("open|hard|store_tasks_pending_and_in_progress", cell(Store::NonEmpty, Named::Unset, Trans::NoTasks), Some(&["1", "3"]), "block", Some(true)),
        o("open|hard|todowrite_without_a_store", cell(Store::Absent, Named::Unset, Trans::TodoWrite), Some(&["1", "2"]), "block", Some(true)),
        // ---- XF-D1: a record the store could not read or parse makes the store UNSURE: the transcript's tasks join the open set
        o(
            "open|d1|unreadable_record_keeps_todowrite_tasks",
            cell(Store::OneUnreadableRecord, Named::Unset, Trans::TodoWrite),
            Some(&["1", "2"]),
            "block",
            Some(true),
        ),
        o("open|d1|junk_record_keeps_todowrite_tasks", cell(Store::OneJunkRecord, Named::Unset, Trans::TodoWrite), Some(&["1", "2"]), "block", Some(true)),
        // ---- XF-D4: a store directory that cannot be listed may hold open work: the Stop must not allow (GH 606 shape 4)
        o("open|d4|unreadable_store_dir_is_not_allow", cell(Store::UnreadableDir, Named::Unset, Trans::NoTasks), None, "block", None),
        // ---- XF-D2: a pending TodoWrite task stays open when a store answers, also over a completed store task with the same id
        o(
            "open|d2|todowrite_pending_over_completed_store_task",
            cell(Store::CompletedOnly, Named::Unset, Trans::TodoWrite),
            Some(&["1", "2"]),
            "block",
            Some(true),
        ),
        // ---- XF-D3: the named list selected through the environment is read
        o("open|d3|named_list_pending_task", cell(Store::Empty, Named::SetWithList, Trans::NoTasks), Some(&["9"]), "block", Some(true)),
        // ---- XF-G: a TaskCreate whose result is an error made no task
        o("open|g|failed_create_is_not_a_task", cell(Store::Absent, Named::Unset, Trans::FailedCreate), Some(&[]), "allow", Some(false)),
    ]
}

#[test]
fn the_reader_meets_the_hand_written_open_set_obligations() {
    let list = load_xf();
    let base = scratch("open-oblig");
    let obligations = open_obligations();
    let mut mismatched: Vec<(String, String)> = Vec::new();
    for (i, ob) in obligations.iter().enumerate() {
        let root = base.join(i.to_string());
        std::fs::create_dir_all(&root).unwrap();
        let got = read_cell(&ob.cell, &root);
        if std::env::var("AH_OBL_DUMP").is_ok() {
            eprintln!("OBL-DUMP {} | open={:?} stop={} ladder={:?} unsure={} store={}", ob.name, got.open, got.stop, got.ladder, got.unsure, got.store);
        }
        let mut why = Vec::new();
        if let Some(want) = ob.open {
            let want: BTreeSet<String> = want.iter().map(|s| s.to_string()).collect();
            if got.open != want {
                why.push(format!("open set {:?}, wanted {want:?}", got.open));
            }
        }
        if got.stop != ob.stop {
            why.push(format!("task-guard Stop is `{}`, wanted `{}`", got.stop, ob.stop));
        }
        if let Some(l) = ob.ladder
            && got.ladder != Some(l)
        {
            why.push(format!("ladder is {:?}, wanted {:?}", got.ladder, Some(l)));
        }
        if !why.is_empty() {
            mismatched.push((ob.name.to_string(), why.join("; ")));
        }
    }
    std::fs::remove_dir_all(&base).ok();
    let checked: Vec<String> = obligations.iter().map(|o| o.name.to_string()).collect();
    eprintln!("open-set obligations: {} cells, {} failing as listed or not", checked.len(), mismatched.len());
    let problems = xf_problems(&list, "open|", &mismatched, &checked);
    assert!(problems.is_empty(), "{} problem(s):\n{}", problems.len(), problems.join("\n"));
}

// ---- axis 2: the consumers ---------------------------------------------------------------------------------------------------

/// What one consumer must answer in an obligation cell.
struct Want {
    /// `ladder`, `pair_stop`, `pair_post`, `pair_pre:<id>`, `tasklist_stop`, `tracker_prompt`, `hygiene_post`, `compact_advice`.
    consumer: &'static str,
    kind: Kind,
    /// The exact task ids the decision names; `None`: not fixed by the spec.
    ids: Option<&'static [&'static str]>,
    /// The exact count the decision states; `None`: not fixed.
    count: Option<u64>,
    /// Words the whole message must carry (the agent that owns no task, the reason a spawn cannot be paired).
    says: &'static [&'static str],
}

fn want(consumer: &'static str, kind: Kind) -> Want {
    Want { consumer, kind, ids: None, count: None, says: &[] }
}

impl Want {
    fn ids(mut self, ids: &'static [&'static str]) -> Self {
        self.ids = Some(ids);
        self
    }
    fn count(mut self, n: u64) -> Self {
        self.count = Some(n);
        self
    }
    fn says(mut self, words: &'static [&'static str]) -> Self {
        self.says = words;
        self
    }
}

/// An obligation case: the cell, the files and agents it needs, and the consumers it asks.
fn oblig(
    name: &str,
    cell: Cell,
    agents: Vec<(&'static str, &'static str)>,
    store_files: Vec<(&'static str, String)>,
    rows: Vec<Value>,
    wants: Vec<Want>,
) -> (Case, Vec<Want>) {
    let mut groups: Vec<&'static str> = Vec::new();
    let mut pre_ids: Vec<&'static str> = Vec::new();
    for w in &wants {
        let group = match w.consumer.split(':').next().unwrap() {
            "ladder" => "ladder",
            "pair_stop" => "pair_stop",
            "pair_post" => "pair_post",
            "pair_pre" => {
                pre_ids.push(w.consumer.split(':').nth(1).unwrap());
                "pair_pre"
            }
            "tasklist_stop" => "tasklist",
            "tracker_prompt" => "tracker",
            "hygiene_post" => "hygiene",
            "compact_advice" => "compact",
            other => panic!("unknown consumer {other}"),
        };
        if !groups.contains(&group) {
            groups.push(group);
        }
    }
    (Case { key: name.to_string(), cell, groups, agents, store_files, unreadable: Vec::new(), rows, pre_ids }, wants)
}

fn consumer_obligations() -> Vec<(Case, Vec<Want>)> {
    let cell = |store, named, trans| Cell { store, named, trans, snap: Snap::None, rows: Rows::Conv, knobs: Knobs::new() };
    let owned = |id: &str, status: &str, owner: &str| store_rec(id, status, Some(owner));
    let status_123 = || vec![todo_raw(json!([{"id": "1", "content": "odd status", "status": 123}, {"id": "2", "content": "fine", "status": "pending"}]))];
    vec![
        // ---- ALLOW (rule 14 (b))
        oblig(
            "oblig|allow|nothing_open_nothing_running",
            cell(Store::CompletedOnly, Named::Unset, Trans::NoTasks),
            vec![],
            vec![],
            vec![],
            vec![want("ladder", Kind::Allow), want("pair_stop", Kind::Allow), want("hygiene_post", Kind::Allow)],
        ),
        oblig(
            "oblig|allow|the_running_agent_owns_an_open_task",
            cell(Store::Empty, Named::Unset, Trans::NoTasks),
            vec![AGENT],
            vec![("1.json", owned("1", "pending", AGENT.1))],
            vec![],
            vec![
                want("ladder", Kind::Block),
                want("pair_stop", Kind::Allow),
                want("pair_post", Kind::Allow),
                want("pair_pre:1", Kind::Block).ids(&["1"]).says(&["no name"]),
            ],
        ),
        oblig(
            "oblig|allow|a_task_of_another_list_is_not_ours",
            cell(Store::Empty, Named::SetOtherList, Trans::NoTasks),
            vec![],
            vec![],
            vec![],
            vec![want("ladder", Kind::Allow), want("pair_stop", Kind::Allow), want("hygiene_post", Kind::Allow)],
        ),
        oblig(
            "oblig|allow|an_open_ownerless_task_proves_the_by_id_spawn",
            cell(Store::Empty, Named::Unset, Trans::NoTasks),
            vec![],
            vec![("1.json", store_rec("1", "pending", None))],
            vec![],
            vec![want("pair_pre:1", Kind::Allow).ids(&[])],
        ),
        // ---- obligations that hold on the base (hard): the block names the right task / agent
        oblig(
            "oblig|hard|an_agent_with_no_task_blocks_the_stop",
            cell(Store::Empty, Named::Unset, Trans::NoTasks),
            vec![("job b", "worker-b")],
            vec![("1.json", owned("1", "pending", "worker-a"))],
            vec![],
            vec![
                want("pair_stop", Kind::Block).says(&["worker-b", "owns no task"]),
                want("pair_post", Kind::Nudge).says(&["worker-b", "no open task names it"]),
                want("pair_pre:1", Kind::Block).ids(&["1"]).says(&["no name"]),
            ],
        ),
        // every consumer reads the same list: store tasks 1 (pending), 2 (completed), 3 (in progress); worker-alpha is running and owns none
        oblig(
            "oblig|hard|every_consumer_reads_the_store_list",
            cell(Store::NonEmpty, Named::Unset, Trans::NoTasks),
            vec![AGENT],
            vec![],
            vec![],
            vec![
                want("ladder", Kind::Block),
                want("pair_stop", Kind::Block).says(&["worker-alpha", "owns no task"]),
                want("pair_post", Kind::Nudge).says(&["worker-alpha", "no open task names it"]),
                want("pair_pre:1", Kind::Allow),
                want("pair_pre:2", Kind::Block),
                want("pair_pre:3", Kind::Allow),
                want("tasklist_stop", Kind::Block).ids(&["1", "3"]),
                want("tracker_prompt", Kind::Nudge).count(2),
                // 1 pending + 3 in progress + the task just created
                want("hygiene_post", Kind::Nudge).count(3),
                // task 2 is finished and still in the list
                want("compact_advice", Kind::Block).count(1),
            ],
        ),
        // The #445 stage A acceptance shape (GH 606 / W1-4, M5): a worker-owned pending task, one malformed store record and a TodoWrite
        // item with `status: 123`. The store-derived pairing facts (task 1 is owned by worker-a, worker-b owns none) must survive the
        // uncertain transcript: the base blocks and names them; stage A (369edde3) threw the whole set away and allowed.
        oblig(
            "oblig|hard|pairing_facts_survive_an_uncertain_transcript",
            cell(Store::Empty, Named::Unset, Trans::NoTasks),
            vec![("job b", "worker-b"), ("job a", "worker-a")],
            vec![("1.json", owned("1", "pending", "worker-a")), ("2.json", "{not json".to_string())],
            status_123(),
            vec![
                want("pair_stop", Kind::Block).says(&["worker-b", "owns no task"]),
                want("pair_post", Kind::Nudge).says(&["worker-b", "no open task names it"]),
                want("pair_pre:1", Kind::Block).ids(&["1"]).says(&["no name"]),
            ],
        ),
        // ---- XF-D1: an unreadable / malformed record makes the store UNSURE: the transcript's open tasks join (task 2 is a TodoWrite task)
        oblig(
            "oblig|d1|unreadable_record_keeps_the_todowrite_task",
            cell(Store::OneUnreadableRecord, Named::Unset, Trans::TodoWrite),
            vec![],
            vec![],
            vec![],
            vec![want("pair_pre:2", Kind::Allow), want("tracker_prompt", Kind::Nudge).count(2), want("tasklist_stop", Kind::Block).ids(&["1", "2"])],
        ),
        oblig(
            "oblig|d1|junk_record_keeps_the_todowrite_task",
            cell(Store::OneJunkRecord, Named::Unset, Trans::TodoWrite),
            vec![],
            vec![],
            vec![],
            vec![want("pair_pre:2", Kind::Allow), want("tracker_prompt", Kind::Nudge).count(2), want("tasklist_stop", Kind::Block).ids(&["1", "2"])],
        ),
        // ---- XF-D2: a pending TodoWrite task stays open next to a store that answers, also over a completed store task of the same id
        oblig(
            "oblig|d2|todowrite_pending_over_completed_store_task",
            cell(Store::CompletedOnly, Named::Unset, Trans::TodoWrite),
            vec![],
            vec![],
            vec![],
            vec![
                want("ladder", Kind::Block),
                want("pair_pre:1", Kind::Allow),
                want("pair_pre:2", Kind::Allow),
                want("tracker_prompt", Kind::Nudge).count(2),
                want("tasklist_stop", Kind::Block).ids(&["1", "2"]),
            ],
        ),
        // ---- XF-D3: the named list selected through the environment holds task 9, pending
        oblig(
            "oblig|d3|named_list_pending_task",
            cell(Store::Empty, Named::SetWithList, Trans::NoTasks),
            vec![],
            vec![],
            vec![],
            vec![
                want("ladder", Kind::Block),
                want("pair_pre:9", Kind::Allow),
                want("tracker_prompt", Kind::Nudge).count(1),
                want("tasklist_stop", Kind::Block).ids(&["9"]),
            ],
        ),
        // ---- XF-G: a TaskCreate whose result is an error made no task: nothing is open
        oblig(
            "oblig|g|failed_create_is_not_a_task",
            cell(Store::Absent, Named::Unset, Trans::FailedCreate),
            vec![],
            vec![],
            vec![],
            vec![want("ladder", Kind::Allow), want("pair_stop", Kind::Allow), want("hygiene_post", Kind::Allow)],
        ),
    ]
}

fn check_want(w: &Want, got: &Decision) -> Vec<String> {
    let mut why = Vec::new();
    if got.kind != w.kind {
        why.push(format!("{}: `{}` (\"{}\"), wanted `{}`", w.consumer, got.kind.name(), got.reason, w.kind.name()));
        return why;
    }
    if let Some(ids) = w.ids {
        let ids: BTreeSet<String> = ids.iter().map(|s| s.to_string()).collect();
        if got.ids != ids {
            why.push(format!("{}: names {:?}, wanted {ids:?}", w.consumer, got.ids));
        }
    }
    if let Some(n) = w.count
        && got.count != Some(n)
    {
        why.push(format!("{}: states {:?} task(s), wanted {n}", w.consumer, got.count));
    }
    for word in w.says {
        if !got.full.contains(word) {
            why.push(format!("{}: the message lacks \"{word}\" (\"{}\")", w.consumer, got.reason));
        }
    }
    why
}

#[test]
fn the_consumers_meet_the_hand_written_obligations() {
    let list = load_xf();
    let base = scratch("consumers-oblig");
    let obligations = consumer_obligations();
    let mut mismatched: Vec<(String, String)> = Vec::new();
    for (i, (case, wants)) in obligations.iter().enumerate() {
        let root = base.join(i.to_string());
        std::fs::create_dir_all(&root).unwrap();
        let got = run_case(case, &root);
        let mut why = Vec::new();
        for w in wants {
            let d = got.get(w.consumer).unwrap_or_else(|| panic!("{}: consumer {} was not run", case.key, w.consumer));
            if std::env::var("AH_OBL_DUMP").is_ok() {
                eprintln!("OBL-DUMP {} | {} | {} | {:?} | {:?} | {:?}", case.key, w.consumer, d.kind.name(), d.reason, d.ids, d.count);
            }
            why.extend(check_want(w, d));
        }
        if !why.is_empty() {
            mismatched.push((case.key.clone(), why.join("; ")));
        }
    }
    std::fs::remove_dir_all(&base).ok();
    let checked: Vec<String> = obligations.iter().map(|(c, _)| c.key.clone()).collect();
    eprintln!("consumer obligations: {} cells, {} failing as listed or not", checked.len(), mismatched.len());
    let problems = xf_problems(&list, "oblig|", &mismatched, &checked);
    assert!(problems.is_empty(), "{} problem(s):\n{}", problems.len(), problems.join("\n"));
}

/// The list itself: it is loaded by both tests above, and this one pins what it must be.
#[test]
fn the_expected_failure_list_is_well_formed() {
    let list = load_xf();
    assert!(!list.decision.is_empty(), "the list holds the staged cells (the empty-list assertion belongs to the last W1 code lane)");
    let owners: BTreeSet<&str> = list.decision.iter().map(|d| d.defect.as_str()).collect();
    assert!(owners.iter().all(|d| XF_OWNERS.iter().any(|(x, _)| x == d)));
}
