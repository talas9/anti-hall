//! Host primitives for the DevSwarm mesh data a check script cannot read for itself (D88): the SQLite store, the app database,
//! git identity and the child transcript walk. Like the rest of `ahHost` they hold no rule, text, threshold or decision: a
//! script decides, these only extract what it asks for. Every answer that cannot be given exactly is `{"unsure":true}` (the
//! script then defers, D11); nothing here writes except the cross-invocation app cache a script asks to perform.
//!
//! | raw function | what it does |
//! |---|---|
//! | `meshIdent(cwd)` | `{top, own, key}`: the work tree around `cwd`, this Primary's partition id and its project key (each `null` when there is none) |
//! | `meshRepoKey(worktree)` | `{key}`: the project key of a work tree, `null` when it has none |
//! | `meshCanonicalId(worktree)` | `{id}`: the canonical mesh id of a work tree, `null` when it has none |
//! | `meshRegisteredKey(descriptorJson, id)` | `{key}`: the project an id is registered under |
//! | `meshMessageCount(key, id)` | `{state: "none"}` (no store file) or `{state: "ok", count}`: the messages a partition holds |
//! | `meshUnion(key, id, inbox, cursor, own, now)` | `{state: "none"}` or `{state: "ok", storeOnly: [row], age}`: the store rows no inbox line covers and the age in ms of the oldest unread row |
//! | `meshOwnReader(key, id, inbox, cursor, count, now)` | `{reader: false}`, `{reader: true, state: "none"}` or `{reader: true, state: "ok", own, unread?, total?}`: this hook's own reader row on a partition and, with `count`, its unread count and the partition's message count |
//! | `meshReaderNonce()` | `{nonce}`: the reader nonce of the hook that sent the request (`deriveReaderNonce`), `null` for a headless caller |
//! | `meshCountFor(key, id, inbox, cursor, now)` | `{state: "nd", unread, known}` (no key or no store: the inbox and its cursor alone) or `{state: "ok", unread, known, age}`: a child's own unread mail counted with its own reader (`countFor`); a store that exists but cannot be read is `{state: "nd", unread: 0, known: false, unknown: true, reason}` |
//! | `meshContextKey(cwd)` | `{key}`: the project key of the checkout around `cwd` (`resolveContext(cwd, {missingPath: 'ancestor'}).repoKey`), `null` when none |
//! | `meshAppArchived(id, worktree, cache)` | `{verdict: true \| false \| null, cache: n \| null}`: the app database's archive verdict; `cache` names a cache write owed |
//! | `meshPerformCache()` | perform every cache write the call's lookups owe |
//! | `meshSessionAlive(session)` | `{alive}`: a session record of this session names a live process |
//! | `meshChildBusy(id, worktree, session, now, freshMs)` | `{none: true}` (no transcript to read) or `{busy, waiting, question}` |
//! | `settingTouched(key)` | whether the setting described by defaults entry `key` has a value anywhere in its chain |
use super::host::{err, with_settings};
use crate::checks::git::util::Settings;
use crate::checks::guardkit::ojson::OVal;
use crate::defaults;
use crate::meshw::ident;
use crate::meshw::union::{UnionIn, union_unread};
use rquickjs::{Ctx, Function, Object};
use serde_json::{Value, json};
use std::cell::RefCell;
use std::path::Path;

thread_local! {
    /// The app-cache writes the lookups of this call owe.
    static OWED: RefCell<Vec<crate::meshw::appdb::CacheWrite>> = const { RefCell::new(Vec::new()) };
    /// The app database's builder states as this call first read them (with the handle of the cache write that read owes), so a
    /// gate that asks about hundreds of workspaces reads (and parses) the states once, not once per workspace.
    static APP: RefCell<Option<AppRead>> = const { RefCell::new(None) };
    /// Repository identity only; mailbox, reader and inbox state are never cached.
    static IDENT: RefCell<std::collections::HashMap<(String, bool), Result<ident::Ctx, ident::Defer>>> = RefCell::new(std::collections::HashMap::new());
}

/// One read of the app database's builder states, for the `cache` flag it was made with.
struct AppRead {
    cache: bool,
    found: Option<(Vec<crate::meshw::appdb::State>, Option<usize>)>,
}

/// A new script call starts: no cache write is owed yet.
pub(super) fn reset_call() {
    OWED.with(|o| o.borrow_mut().clear());
    APP.with(|a| *a.borrow_mut() = None);
    IDENT.with(|i| i.borrow_mut().clear());
}

/// Why an answer cannot be given exactly.
struct No;

fn unsure() -> String {
    json!({"unsure": true}).to_string()
}

fn answer(r: Result<Value, No>) -> String {
    r.map_or_else(|_| unsure(), |v| v.to_string())
}

fn devswarm_dir(home: &str) -> String {
    format!("{home}/{}", defaults::text("devswarm_role.pg_devswarm_dir"))
}

/// Sorted file names of a directory, `None` when it cannot be listed.
fn names(dir: &str) -> Option<Vec<String>> {
    let mut v: Vec<String> = std::fs::read_dir(dir).ok()?.filter_map(|e| e.ok()?.file_name().into_string().ok()).collect();
    v.sort();
    Some(v)
}

fn safe_id(id: &str) -> bool {
    let extra = defaults::text("devswarm_role.id_extra_chars");
    !id.is_empty() && id != "." && id != ".." && !id.contains("..") && id.chars().all(|c| c.is_ascii_alphanumeric() || extra.contains(c))
}

fn exists(p: &str) -> bool {
    std::fs::metadata(p).is_ok()
}

fn read_json(p: &str) -> Result<Option<OVal>, No> {
    let Some(bytes) = ident::read_bounded(Path::new(p)).map_err(|_| No)? else { return Ok(None) };
    let Ok(text) = String::from_utf8(bytes) else { return Err(No) };
    match OVal::parse(&text) {
        Some(v) => Ok(Some(v)),
        None if text.contains("\\u") => Err(No),
        None => Ok(None),
    }
}

fn context_of(cwd: &str, ancestor: bool) -> Result<ident::Ctx, ident::Defer> {
    IDENT.with(|i| i.borrow_mut().entry((cwd.to_string(), ancestor)).or_insert_with(|| ident::resolve_context(cwd, ancestor)).clone())
}

fn repo_key_of(cwd: &str) -> Result<Option<String>, ident::Defer> {
    if cwd.is_empty() {
        return Ok(None);
    }
    Ok(context_of(cwd, false)?.repo_key)
}

fn ident_of(cwd: &str) -> Result<Value, No> {
    let top = context_of(cwd, true).map_err(|_| No)?.worktree_root;
    let own = match &top {
        Some(top) => Some(ident::primary_workspace_id(top).map_err(|_| No)?),
        None => None,
    };
    let key = repo_key_of(cwd).map_err(|_| No)?;
    Ok(json!({"top": top, "own": own, "key": key}))
}

/// The store a partition's reads go through (`openStoreForUnread` with a repo key): `Ok(None)` is Node's null (no database
/// file and nothing that makes it another backend).
fn open_store(st: &Settings, key: &str) -> Result<Option<crate::mesh::MeshReader>, No> {
    if st.env.contains_key(defaults::text("mesh_write.env_store_backend")) {
        return Err(No);
    }
    let dir = crate::meshw::union::store_dir(Path::new(&st.home), key);
    let db = dir.join(defaults::text("mesh_write.store_file"));
    match std::fs::read_to_string(dir.join(defaults::text("mesh.backend_marker"))) {
        Ok(m) if m.trim().to_lowercase() == defaults::text("mesh.backend_sqlite") => {}
        Ok(_) => return Err(No),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let has_db = std::fs::metadata(&db).map(|m| m.len() > 0).unwrap_or(false);
            if !has_db && names(&dir.join(defaults::text("devswarm_role.pg_journal_dir")).to_string_lossy()).is_some_and(|v| !v.is_empty()) {
                return Err(No);
            }
        }
        Err(_) => return Err(No),
    }
    if !db.exists() {
        return if std::fs::symlink_metadata(&db).is_ok() { Err(No) } else { Ok(None) };
    }
    crate::mesh::MeshReader::open(&db).map(Some).map_err(|_| No)
}

/// The reader key of the hook that sent this request (`readerKey(deriveReaderNonce({ home }))`): its nearest harness ancestor,
/// walked from the request's sender (the daemon's socket peer) or, in a one-shot `check`, from this process, as the Node hook
/// walks from itself. A daemon request whose sender the socket did not name has no answer.
fn own_reader(st: &Settings) -> Result<Option<String>, No> {
    Ok(crate::meshw::cursors::reader_key(own_nonce(st)?.as_deref()))
}

/// [`own_reader`] for the gate-script tests: `None` when there is no reader key or it cannot be read.
#[cfg(test)]
pub(super) fn own_reader_key(st: &Settings) -> Option<String> {
    own_reader(st).ok().flatten()
}

/// The reader nonce of the hook that sent this request (`deriveReaderNonce({ home })`), walked as [`own_reader`] walks; `None` for
/// a headless caller (no harness ancestor).
fn own_nonce(st: &Settings) -> Result<Option<String>, No> {
    let start = match st.env.get(defaults::text("request_env.peer_pid_key")) {
        None => i64::from(std::process::id()),
        Some(v) => match v.parse::<i64>() {
            Ok(p) if p > 0 => p,
            _ => return Err(No),
        },
    };
    Ok(ident::reader_nonce_from(Path::new(&st.home), start))
}

/// A workspace's own unread mail as a child hook counts it (`openStoreForUnread`, then `countFor` with this hook's own reader, or
/// `readUnread` when there is no store): `{state: "nd", unread, known}` (no project key or no store: the inbox and its cursor file
/// alone) or `{state: "ok", unread, known, age}`. `known`: the inbox and its cursor file both read (`readUnread`'s `known`).
fn count_for(st: &Settings, key: Option<&str>, id: &str, inbox: Option<&str>, cursor: Option<&str>, now: f64) -> Result<Value, No> {
    let lines = match inbox {
        Some(p) => crate::meshw::union::non_empty_lines(p).map_err(|_| No)?,
        None => None,
    };
    let position = match (&lines, cursor) {
        (Some(_), Some(c)) => crate::meshw::union::cursor_position(c).map_err(|_| No)?,
        _ => None,
    };
    let known = lines.is_some() && position.is_some();
    // a store that exists but cannot be read is an UNKNOWN count, never "0 unread": Node's `countFor` answers `{unknown: true, reason}`
    let unknown = |reason_key: &str| Ok(json!({"state": "nd", "unread": 0, "known": false, "unknown": true, "reason": defaults::text(reason_key)}));
    let store = match key {
        Some(k) => match open_store(st, k) {
            Ok(s) => s,
            Err(No) => return unknown("mesh_write.unread_reason_cursors"),
        },
        None => None,
    };
    let Some(store) = store else {
        let u = union_unread(&UnionIn { inbox, cursor_file: cursor, id, store: None, store_base: 0.0, nd_base: position.unwrap_or(0.0), now: now as i64 })
            .map_err(|_| No)?;
        return Ok(json!({"state": "nd", "unread": if known { u.unread } else { 0 }, "known": known}));
    };
    let reader = own_reader(st)?;
    let Ok((sb, nb)) = floor_positions(&store, &st.home, id, cursor, reader.as_deref()) else { return unknown("mesh_write.unread_reason_cursors") };
    let Ok(u) = union_unread(&UnionIn { inbox, cursor_file: cursor, id, store: Some(&store), store_base: sb, nd_base: nb, now: now as i64 }) else {
        return unknown("mesh_write.unread_reason_union");
    };
    Ok(json!({"state": "ok", "unread": u.unread, "known": known, "age": u.oldest_unread_age_ms.filter(|a| a.is_finite())}))
}

/// `positions(store, { reader, partition, cursorPath, home })` as `(store base, nd base)`: the floor view, overlaid by `reader`'s
/// own rows where it holds any (`reader` None: the floor view alone).
fn floor_positions(store: &crate::mesh::MeshReader, home: &str, partition: &str, cursor_path: Option<&str>, reader: Option<&str>) -> Result<(f64, f64), No> {
    let rows = store.reader_cursors(partition).map_err(|_| No)?;
    let floor = defaults::text("mesh_write.floor_reader");
    let own_of = |ns: &str| reader.and_then(|r| rows.iter().find(|x| x["ns"] == ns && x["reader"] == r)).and_then(|x| x["value"].as_f64());
    let (own_store, own_nd) = (own_of(defaults::text("mesh_write.cursor_ns_store")), own_of(defaults::text("mesh_write.cursor_ns_nd")));
    let row_of = |ns: &str| rows.iter().find(|r| r["ns"] == ns && r["reader"] == floor).and_then(|r| r["value"].as_f64());
    let cursors = format!("{}/{}", devswarm_dir(home), defaults::text("devswarm_role.pg_dir_cursors"));
    // a cursor file that is a FIFO or device, or over the cap, has no exact answer here (a read could block the worker)
    let read_cursor = |p: &str| -> Result<f64, No> {
        ident::read_bounded(Path::new(p)).map_err(|_| No)?;
        Ok(crate::meshw::cursors::read_cursor(Path::new(p)))
    };
    let legacy_safe = safe_id(partition) && !partition.contains('#') && !partition.contains(".seen-");
    let store_floor = match row_of(defaults::text("mesh_write.cursor_ns_store")) {
        Some(v) => v,
        None => {
            let base_file = format!("{cursors}/{partition}{}", defaults::text("devswarm_role.pg_base_suffix"));
            let baseline = if legacy_safe && exists(&base_file) {
                read_cursor(&base_file)?
            } else {
                let json = read_cursor(&format!("{cursors}/{partition}.json"))?;
                let row = store.cursor(partition).map_err(|_| No)? as f64;
                json.max(row)
            };
            let mut min: Option<f64> = None;
            if legacy_safe {
                let prefix = format!("{partition}{}", defaults::text("devswarm_role.pg_inst_infix"));
                for n in names(&cursors).unwrap_or_default() {
                    let Some(short) = n.strip_prefix(&prefix).and_then(|x| x.strip_suffix(".json")) else { continue };
                    if short.len() == 6 && short.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
                        let v = read_cursor(&format!("{cursors}/{n}"))?;
                        min = Some(min.map_or(v, |m: f64| m.min(v)));
                    }
                }
            }
            min.map_or(baseline, |m| baseline.max(m))
        }
    };
    let cp: Option<String> = match cursor_path {
        Some(c) => Some(c.to_string()),
        None => match read_json(&format!("{}/{}/{partition}.json", devswarm_dir(home), defaults::text("devswarm_role.pg_dir_workspaces")))? {
            Some(d) => match d.get("cursorPath") {
                Some(OVal::Str(s)) if !s.is_empty() => Some(s.clone()),
                _ => None,
            },
            None => None,
        },
    };
    let nd_floor = match row_of(defaults::text("mesh_write.cursor_ns_nd")) {
        Some(v) => {
            let distinct = match &cp {
                None => 0.0,
                Some(c) => {
                    if ident::resolve_abs(c) == ident::resolve_abs(&format!("{cursors}/{partition}.json")) {
                        0.0
                    } else {
                        read_cursor(c)?
                    }
                }
            };
            v.max(distinct)
        }
        None => match cp.as_deref() {
            Some(c) => read_cursor(c)?,
            None => 0.0,
        },
    };
    Ok((own_store.unwrap_or(store_floor), own_nd.unwrap_or(nd_floor)))
}

fn message_count(st: &Settings, key: &str, id: &str) -> Result<Value, No> {
    Ok(match open_store(st, key)? {
        None => json!({"state": "none"}),
        Some(s) => json!({"state": "ok", "count": s.message_count(id).map_err(|_| No)?}),
    })
}

fn union_of(st: &Settings, key: &str, id: &str, inbox: Option<&str>, cursor: Option<&str>, own: bool, now: f64) -> Result<Value, No> {
    let Some(store) = open_store(st, key)? else { return Ok(json!({"state": "none"})) };
    let reader = if own { own_reader(st)? } else { None };
    let (sb, nb) = floor_positions(&store, &st.home, id, cursor, reader.as_deref())?;
    let u = union_unread(&UnionIn { inbox, cursor_file: cursor, id, store: Some(&store), store_base: sb, nd_base: nb, now: now as i64 }).map_err(|_| No)?;
    let age = u.oldest_unread_age_ms.filter(|a| a.is_finite());
    // the partition's identity family (`recipientFamilyIds`): the gate leaves its own sends out of the count, as peek does
    let family: Vec<String> = crate::meshw::tick::family_of(id, &ident::rows_of(&store.roster().map_err(|_| No)?)).into_iter().collect();
    Ok(
        json!({"state": "ok", "storeOnly": u.store_only_unread.iter().filter(|r| !crate::meshw::union::is_wake_row(r)).collect::<Vec<_>>(), "age": age, "family": family}),
    )
}

/// This hook's own reader on partition `id` (`ownReaderDelta` / `ownReaderLiveUnread`): `{reader: false}` when the hook has no
/// reader key (checked before the store is opened, as Node does), `{reader: true, state: "none"}` when the project has no
/// store, else `{reader: true, state: "ok", own}` with `own` the value of this reader's own `store` row (`null`: no row, or
/// not a finite number). With `count` and a row, also `unread` (`countFor` with this reader) and `total` (`messageCount`).
fn own_view(st: &Settings, key: &str, id: &str, inbox: Option<&str>, cursor: Option<&str>, count: bool, now: f64) -> Result<Value, No> {
    let Some(reader) = own_reader(st)? else { return Ok(json!({"reader": false})) };
    let Some(store) = open_store(st, key)? else { return Ok(json!({"reader": true, "state": "none"})) };
    let rows = store.reader_cursors(id).map_err(|_| No)?;
    let ns = defaults::text("mesh_write.cursor_ns_store");
    let own = rows.iter().find(|x| x["ns"] == ns && x["reader"] == reader.as_str()).and_then(|x| x["value"].as_f64()).filter(|v| v.is_finite());
    if !count {
        return Ok(json!({"reader": true, "state": "ok", "own": own}));
    }
    // `shared`: the ONE unread count `mesh inbox peek-primary` / `read-primary` / tick report (`union::unread_for` at this reader's
    // bases, own-family sends and wake rows left out), counted with or without an own row (no row: the floor bases, as peek reads);
    // `null` when it cannot be read. Only the gate's devswarm.parentGateSharedCount path reads it: `unread` and `total` (with a row)
    // and the no-row shape are the old answer unchanged, so the switch off computes exactly what it did before.
    let shared = shared_unread(st, &store, id, inbox, cursor, &reader, now).ok();
    let Some(value) = own else { return Ok(json!({"reader": true, "state": "ok", "own": null, "shared": shared})) };
    let (sb, nb) = floor_positions(&store, &st.home, id, cursor, Some(&reader))?;
    let u = union_unread(&UnionIn { inbox, cursor_file: cursor, id, store: Some(&store), store_base: sb, nd_base: nb, now: now as i64 }).map_err(|_| No)?;
    let total = store.message_count(id).map_err(|_| No)?;
    Ok(json!({"reader": true, "state": "ok", "own": value, "unread": u.unread, "total": total, "shared": shared}))
}

/// The unread count of partition `id` for `reader` exactly as `mesh inbox peek-primary` counts it (`union::unread_for` with the
/// partition's identity family from the store roster).
fn shared_unread(
    st: &Settings,
    store: &crate::mesh::MeshReader,
    id: &str,
    inbox: Option<&str>,
    cursor: Option<&str>,
    reader: &str,
    now: f64,
) -> Result<usize, No> {
    let rows = ident::rows_of(&store.roster().map_err(|_| No)?);
    let family = crate::meshw::tick::family_of(id, &rows);
    let c = crate::meshw::union::unread_for(store, Path::new(&st.home), id, inbox, cursor, Some(reader), &family, now as i64).map_err(|_| No)?;
    crate::meshw::tick::note_own_excluded(&c);
    Ok(c.unread)
}

fn app_archived(st: &Settings, id: &str, worktree: &str, cache: bool) -> Result<Value, No> {
    let now = crate::meshw::common::now_ms();
    APP.with(|a| {
        let mut a = a.borrow_mut();
        if a.as_ref().is_none_or(|r| r.cache != cache) {
            let found = crate::meshw::appdb::builder_states(Path::new(&st.home), &st.env, now, cache).map_err(|_| No)?;
            let found = found.map(|f| {
                let handle = f.cache.map(|c| {
                    OWED.with(|o| {
                        let mut o = o.borrow_mut();
                        o.push(c);
                        o.len() - 1
                    })
                });
                (f.states, handle)
            });
            *a = Some(AppRead { cache, found });
        }
        let Some((states, handle)) = a.as_ref().and_then(|r| r.found.as_ref()) else { return Ok(json!({"verdict": null, "cache": null})) };
        let verdict = crate::meshw::appdb::verdict_in(states, id, Some(worktree)).map_err(|_| No)?;
        Ok(json!({"verdict": verdict, "cache": handle}))
    })
}

fn child_busy(st: &Settings, id: &str, worktree: &str, session: &str, now: f64, fresh: f64) -> Result<Value, No> {
    let file = match crate::meshw::rostertail::transcript_file(Path::new(&st.home), id, worktree, session) {
        Ok(Some(f)) => f,
        Ok(None) => return Ok(json!({"none": true})),
        Err(_) => return Err(No),
    };
    let b = crate::meshw::rostertail::busy_state(&file, now, fresh).map_err(|_| No)?;
    Ok(json!({"busy": b.busy, "waiting": b.waiting, "question": b.question, "seen": b.seen}))
}

/// Whether the setting described by `entry` has a value anywhere Node looks: its environment variable, the settings file and its
/// plugin option.
fn touched(st: &Settings, entry: &defaults::Entry) -> bool {
    let e = &entry.value;
    let env_name = e.str_field("env");
    if !env_name.is_empty() && st.env.contains_key(env_name) {
        return true;
    }
    let option = e.str_field("option");
    if !option.is_empty() {
        let env_key = format!("{}{}", defaults::text("guardkit.plugin_option_prefix"), option.to_ascii_uppercase());
        if st.env.contains_key(&env_key) {
            return true;
        }
        if crate::checks::guardkit::settings::stored_options(st).is_some_and(|o| o.contains_key(option)) {
            return true;
        }
    }
    crate::checks::guardkit::settings::read_object(st, defaults::text("guardkit.settings_file"))
        .is_some_and(|o| o.get(e.str_field("section")).and_then(Value::as_object).is_some_and(|s| s.contains_key(e.str_field("key"))))
}

/// `meshAppBuilders()`: the app database's workspaces as JSON `[{id, archived, branch, label}]` (read straight from the database,
/// never from the cross-process cache, which holds neither branch nor title); `null` when there is no readable database.
fn app_builders(st: &Settings) -> Option<String> {
    let file = crate::meshw::ident::app_db_path(Path::new(&st.home), &st.env)?;
    let states = crate::meshw::appdb::read_states(&file).ok().flatten()?;
    let rows: Vec<Value> = states.iter().map(|s| json!({"id": s.id, "archived": s.archived, "branch": s.branch, "label": s.label})).collect();
    Some(Value::Array(rows).to_string())
}

pub(super) fn install<'js>(c: &Ctx<'js>, h: &Object<'js>) -> rquickjs::Result<()> {
    h.set("meshAppBuilders", Function::new(c.clone(), || -> rquickjs::Result<Option<String>> { with_settings(app_builders) })?)?;
    h.set("meshIdent", Function::new(c.clone(), |cwd: String| answer(ident_of(&cwd)))?)?;
    h.set("meshRepoKey", Function::new(c.clone(), |wt: String| answer(repo_key_of(&wt).map(|k| json!({"key": k})).map_err(|_| No)))?)?;
    h.set("meshCanonicalId", Function::new(c.clone(), |wt: String| answer(ident::canonical_mesh_id(&wt).map(|k| json!({"id": k})).map_err(|_| No)))?)?;
    h.set(
        "meshRegisteredKey",
        Function::new(c.clone(), |desc: String, id: String| {
            answer(OVal::parse(&desc).ok_or(No).and_then(|d| crate::meshw::inbox::registered_repo_key(&d, &id).map(|k| json!({"key": k})).map_err(|_| No)))
        })?,
    )?;
    h.set(
        "meshMessageCount",
        Function::new(c.clone(), |key: String, id: String| -> rquickjs::Result<String> { Ok(answer(with_settings(|st| message_count(st, &key, &id))?)) })?,
    )?;
    h.set(
        "meshUnion",
        Function::new(c.clone(), |key: String, id: String, inbox: Option<String>, cursor: Option<String>, own: bool, now: f64| -> rquickjs::Result<String> {
            Ok(answer(with_settings(|st| union_of(st, &key, &id, inbox.as_deref(), cursor.as_deref(), own, now))?))
        })?,
    )?;
    h.set(
        "meshOwnReader",
        Function::new(
            c.clone(),
            |key: String, id: String, inbox: Option<String>, cursor: Option<String>, count: bool, now: f64| -> rquickjs::Result<String> {
                Ok(answer(with_settings(|st| own_view(st, &key, &id, inbox.as_deref(), cursor.as_deref(), count, now))?))
            },
        )?,
    )?;
    h.set(
        "meshReaderNonce",
        Function::new(c.clone(), || -> rquickjs::Result<String> { Ok(answer(with_settings(|st| own_nonce(st).map(|n| json!({"nonce": n})))?)) })?,
    )?;
    h.set(
        "meshCountFor",
        Function::new(c.clone(), |key: Option<String>, id: String, inbox: Option<String>, cursor: Option<String>, now: f64| -> rquickjs::Result<String> {
            Ok(answer(with_settings(|st| count_for(st, key.as_deref(), &id, inbox.as_deref(), cursor.as_deref(), now))?))
        })?,
    )?;
    h.set("meshContextKey", Function::new(c.clone(), |cwd: String| answer(context_of(&cwd, true).map(|c| json!({"key": c.repo_key})).map_err(|_| No)))?)?;
    h.set(
        "meshAppArchived",
        Function::new(c.clone(), |id: String, wt: String, cache: bool| -> rquickjs::Result<String> {
            Ok(answer(with_settings(|st| app_archived(st, &id, &wt, cache))?))
        })?,
    )?;
    h.set(
        "meshPerformCache",
        Function::new(c.clone(), || {
            for w in OWED.with(|o| std::mem::take(&mut *o.borrow_mut())) {
                w.perform();
            }
        })?,
    )?;
    h.set(
        "meshSessionAlive",
        Function::new(c.clone(), |session: String| -> rquickjs::Result<String> {
            Ok(answer(with_settings(|st| crate::dssup::liveness::session_alive(Path::new(&st.home), &session).map(|a| json!({"alive": a})).map_err(|_| No))?))
        })?,
    )?;
    h.set(
        "meshChildBusy",
        Function::new(c.clone(), |id: String, wt: String, session: String, now: f64, fresh: f64| -> rquickjs::Result<String> {
            Ok(answer(with_settings(|st| child_busy(st, &id, &wt, &session, now, fresh))?))
        })?,
    )?;
    h.set(
        "settingTouched",
        Function::new(c.clone(), |key: String| -> rquickjs::Result<bool> {
            let e = defaults::get(&key).ok_or_else(|| err("settingTouched", defaults::render("script.msg_unknown_key", &[("key", &key)])))?;
            with_settings(|st| touched(st, e))
        })?,
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn one_script_call_reads_the_app_database_once_however_many_workspaces_it_asks_about() {
        defaults::init().unwrap();
        let t = crate::db::TempDir::new("host-mesh-app");
        let db = t.0.join("app.db");
        let c = rusqlite::Connection::open(&db).unwrap();
        c.execute_batch("CREATE TABLE builders (id TEXT PRIMARY KEY, isActive INTEGER, isHidden INTEGER, worktreePath TEXT);").unwrap();
        for i in 0..50 {
            c.execute("INSERT INTO builders VALUES (?1, 0, 1, ?2)", rusqlite::params![format!("old-{i}"), format!("/gone/{i}")]).unwrap();
        }
        c.execute("INSERT INTO builders VALUES ('live', 1, 0, '/live')", []).unwrap();
        drop(c);
        let mut env = HashMap::new();
        env.insert(defaults::text("mesh_write.env_app_db").to_string(), db.to_string_lossy().into_owned());
        let st = Settings { home: t.0.to_string_lossy().into_owned(), env };
        reset_call();
        let first = app_archived(&st, "old-1", "/gone/1", true).ok().unwrap();
        for i in 2..50 {
            let a = app_archived(&st, &format!("old-{i}"), &format!("/gone/{i}"), true).ok().unwrap();
            assert_eq!(a["verdict"], json!(true));
        }
        assert_eq!(first["verdict"], json!(true));
        assert_eq!(app_archived(&st, "live", "/live", true).ok().unwrap()["verdict"], json!(false));
        assert_eq!(OWED.with(|o| o.borrow().len()), 1, "the states are read once and one cache write is owed, not one per workspace");
        // a new call starts from the database again
        std::fs::remove_file(&db).unwrap();
        reset_call();
        assert_eq!(app_archived(&st, "old-1", "/gone/1", true).ok().unwrap()["verdict"], json!(null), "no database, no opinion");
    }
    /// Measurement, not a gate: the CPU of 700 `meshAppArchived` lookups in one call over a 700-row app database.
    #[test]
    #[ignore = "measurement: cargo test --release --lib -- --ignored --nocapture app_archived_cpu_for_700_workspaces"]
    fn app_archived_cpu_for_700_workspaces() {
        defaults::init().unwrap();
        let t = crate::db::TempDir::new("host-mesh-app-cpu");
        let db = t.0.join("app.db");
        let c = rusqlite::Connection::open(&db).unwrap();
        c.execute_batch("CREATE TABLE builders (id TEXT PRIMARY KEY, isActive INTEGER, isHidden INTEGER, worktreePath TEXT);").unwrap();
        for i in 0..700 {
            c.execute("INSERT INTO builders VALUES (?1, 0, 1, ?2)", rusqlite::params![format!("old-{i}"), format!("/gone/{i}")]).unwrap();
        }
        drop(c);
        let mut env = HashMap::new();
        env.insert(defaults::text("mesh_write.env_app_db").to_string(), db.to_string_lossy().into_owned());
        let st = Settings { home: t.0.to_string_lossy().into_owned(), env };
        for round in 0..3 {
            reset_call();
            let t0 = crate::limits::thread_cpu_us();
            for i in 0..700 {
                app_archived(&st, &format!("old-{i}"), &format!("/gone/{i}"), true).ok().unwrap();
            }
            eprintln!("APPCPU round {round}: {} ms for 700 lookups", (crate::limits::thread_cpu_us() - t0) / 1000);
        }
    }
}

#[cfg(test)]
mod shared_count_tests {
    use super::*;
    use crate::meshw::store::{CursorPut, MeshStore, RegistryRow};

    /// GH #384: cursor 6, total 8, the two rows past the cursor the Primary's own sends. The old gate projection
    /// (`messageCount - own`) reads 2 unread; the shared count `peek-primary` reports reads 0, so the gate must not block.
    /// One real inbound row after that is still unread and still blocks.
    #[test]
    fn a_cursor_behind_total_that_peek_counts_as_zero_is_zero_and_a_real_unread_still_counts() {
        let home = std::env::temp_dir().join(format!("ah-pg-shared-{}", std::process::id()));
        crate::discard::harmless(std::fs::remove_dir_all(&home)); // keep: an absent directory is the goal state
        std::fs::create_dir_all(&home).unwrap();
        let db = home.join("devswarm.db");
        let w = MeshStore::open(&db).unwrap();
        let row = RegistryRow {
            id: "primary-x".into(),
            worktree_path: Some("/wt/p".into()),
            session_id: Some("s-p".into()),
            inbox_path: None,
            cursor_path: None,
            nudge_command: None,
        };
        assert!(w.upsert_registry(&row, 1, |_, _| true).unwrap());
        for i in 0..6 {
            w.append_message_from("primary-x", 10 + i, Some(&format!("in-{i}")), "from a child", Some("child-a")).unwrap();
        }
        for i in 0..2 {
            w.append_message_from("primary-x", 20 + i, Some(&format!("own-{i}")), "my own send", Some("primary-x")).unwrap();
        }
        let ns = defaults::text("mesh_write.cursor_ns_store").to_string();
        let put = CursorPut { partition: "primary-x".into(), ns, reader: "r1".into(), value: 6, retired_line: None, updated_at: 1 };
        w.reader_cursor_txn(&[put]).unwrap();
        let st = Settings { home: home.to_string_lossy().into_owned(), env: std::collections::HashMap::new() };
        let r = crate::mesh::MeshReader::open(&db).unwrap();
        let total = r.message_count("primary-x").unwrap() as f64;
        assert_eq!((total - 6.0).max(0.0), 2.0, "the old projection reads cursor 6 / total 8 as 2 unread (the false block)");
        assert_eq!(shared_unread(&st, &r, "primary-x", None, None, "r1", 100.0).ok(), Some(0), "peek's count: own sends are not unread");
        w.append_message_from("primary-x", 30, Some("real"), "a real question", Some("child-a")).unwrap();
        let r = crate::mesh::MeshReader::open(&db).unwrap();
        assert_eq!(shared_unread(&st, &r, "primary-x", None, None, "r1", 100.0).ok(), Some(1), "a real unread still counts (and blocks)");
        crate::discard::harmless(std::fs::remove_dir_all(&home)); // keep: cleanup of a scratch directory
    }

    /// PR #428: a retired own reader row still reads from its own position (as peek-primary does), and the rows of another partition
    /// never reach this partition's count; each partition leaves out its OWN family's sends only.
    #[test]
    fn a_retired_reader_reads_its_own_position_and_partitions_count_apart() {
        let home = std::env::temp_dir().join(format!("ah-pg-parts-{}", std::process::id()));
        crate::discard::harmless(std::fs::remove_dir_all(&home)); // keep: an absent directory is the goal state
        std::fs::create_dir_all(&home).unwrap();
        let db = home.join("devswarm.db");
        let w = MeshStore::open(&db).unwrap();
        for (id, wt) in [("primary-x", "/wt/p"), ("child-b", "/wt/b")] {
            let row = RegistryRow {
                id: id.into(),
                worktree_path: Some(wt.into()),
                session_id: Some(format!("s-{id}")),
                inbox_path: None,
                cursor_path: None,
                nudge_command: None,
            };
            assert!(w.upsert_registry(&row, 1, |_, _| true).unwrap());
        }
        for i in 0..8 {
            w.append_message_from("primary-x", 10 + i, Some(&format!("p-{i}")), "from a child", Some("child-b")).unwrap();
        }
        for i in 0..3 {
            w.append_message_from("child-b", 40 + i, Some(&format!("b-{i}")), "from the primary", Some("primary-x")).unwrap();
        }
        w.append_message_from("child-b", 50, Some("b-own"), "child-b's own send", Some("child-b")).unwrap();
        let ns = defaults::text("mesh_write.cursor_ns_store").to_string();
        let put = |p: &str, r: &str, v: i64, retired: Option<i64>| CursorPut {
            partition: p.into(),
            ns: ns.clone(),
            reader: r.into(),
            value: v,
            retired_line: Some(retired),
            updated_at: 1,
        };
        // r1 retired at line 6 (its value 6 <= 6), a live reader r2 behind it at 4
        w.reader_cursor_txn(&[put("primary-x", "r1", 6, Some(6)), put("primary-x", "r2", 4, None), put("child-b", "r1", 1, None)]).unwrap();
        let st = Settings { home: home.to_string_lossy().into_owned(), env: std::collections::HashMap::new() };
        let r = crate::mesh::MeshReader::open(&db).unwrap();
        assert_eq!(shared_unread(&st, &r, "primary-x", None, None, "r1", 100.0).ok(), Some(2), "the retired reader's own position: 8 - 6");
        assert_eq!(shared_unread(&st, &r, "primary-x", None, None, "r2", 100.0).ok(), Some(4), "the live reader's own position: 8 - 4");
        assert_eq!(
            shared_unread(&st, &r, "child-b", None, None, "r1", 100.0).ok(),
            Some(2),
            "child-b: 4 rows, cursor 1, its own send left out, primary-x's 8 rows never counted"
        );
        crate::discard::harmless(std::fs::remove_dir_all(&home)); // keep: cleanup of a scratch directory
    }

    /// PR #428: the wake prefix alone is not provenance. A native-ingested row (no `mtype`) with the prefix is a wake prompt; a
    /// `mesh send` row (it has an `mtype`) with the same words is mail, in the union, in the shared count and in the SQL total.
    #[test]
    fn a_mesh_sent_message_with_the_wake_prefix_is_mail_and_a_native_wake_row_is_not() {
        use crate::meshw::store::mesh_message_row;
        let prefix = defaults::text("agent_tracker.wake_prefix");
        let body = format!("{prefix} resolve conflict?");
        assert!(crate::meshw::union::is_wake_row(&json!({"body": body, "mtype": null})));
        assert!(crate::meshw::union::is_wake_row(&json!({"body": body})));
        assert!(!crate::meshw::union::is_wake_row(&json!({"body": body, "mtype": defaults::text("mesh_write.mtype_direct")})));
        let home = std::env::temp_dir().join(format!("ah-pg-wake-{}", std::process::id()));
        crate::discard::harmless(std::fs::remove_dir_all(&home)); // keep: an absent directory is the goal state
        std::fs::create_dir_all(&home).unwrap();
        let db = home.join("devswarm.db");
        let w = MeshStore::open(&db).unwrap();
        let row = RegistryRow {
            id: "primary-x".into(),
            worktree_path: Some("/wt/p".into()),
            session_id: None,
            inbox_path: None,
            cursor_path: None,
            nudge_command: None,
        };
        assert!(w.upsert_registry(&row, 1, |_, _| true).unwrap());
        assert!(w.append_message_from("primary-x", 10, Some("native"), &body, Some("primary-x")).unwrap());
        let ns = defaults::text("mesh_write.cursor_ns_store").to_string();
        w.reader_cursor_txn(&[CursorPut { partition: "primary-x".into(), ns, reader: "r1".into(), value: 0, retired_line: None, updated_at: 1 }]).unwrap();
        let st = Settings { home: home.to_string_lossy().into_owned(), env: std::collections::HashMap::new() };
        let fam = std::collections::HashSet::new();
        let r = crate::mesh::MeshReader::open(&db).unwrap();
        assert_eq!(shared_unread(&st, &r, "primary-x", None, None, "r1", 100.0).ok(), Some(0), "a native wake row is not mail");
        assert_eq!(r.message_count_from_others("primary-x", &fam, prefix).unwrap(), 0);
        let m = mesh_message_row(Some("child-a"), Some("primary-x"), false, &body, 20, "normal", "child-q", true, None);
        assert!(w.append_mesh_row(&m).unwrap().inserted);
        let r = crate::mesh::MeshReader::open(&db).unwrap();
        assert_eq!(shared_unread(&st, &r, "primary-x", None, None, "r1", 100.0).ok(), Some(1), "a child's mesh send with the prefix is mail");
        assert_eq!(r.message_count_from_others("primary-x", &fam, prefix).unwrap(), 1);
        crate::discard::harmless(std::fs::remove_dir_all(&home)); // keep: cleanup of a scratch directory
    }
}
