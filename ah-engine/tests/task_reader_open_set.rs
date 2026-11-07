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
    }
    if cell.named == Named::SetWithList {
        store_file(&tasks.join(NAMED_LIST), "9.json", "9", "pending");
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
