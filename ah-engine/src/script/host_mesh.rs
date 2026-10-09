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
    static OWED: RefCell<Vec<crate::meshw::appdb::CacheWrite>> = RefCell::new(Vec::new());
}

/// A new script call starts: no cache write is owed yet.
pub(super) fn reset_call() {
    OWED.with(|o| o.borrow_mut().clear());
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
    let Ok(bytes) = std::fs::read(p) else { return Ok(None) };
    let Ok(text) = String::from_utf8(bytes) else { return Err(No) };
    match OVal::parse(&text) {
        Some(v) => Ok(Some(v)),
        None if text.contains("\\u") => Err(No),
        None => Ok(None),
    }
}

fn ident_of(cwd: &str) -> Result<Value, No> {
    let top = ident::resolve_context(cwd, true).map_err(|_| No)?.worktree_root;
    let own = match &top {
        Some(top) => Some(ident::primary_workspace_id(top).map_err(|_| No)?),
        None => None,
    };
    let key = ident::repo_key_for_worktree(cwd).map_err(|_| No)?;
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

/// `positions(store, { reader: null, partition, cursorPath, home })` (the floor view) as `(store base, nd base)`.
fn floor_positions(store: &crate::mesh::MeshReader, home: &str, partition: &str, cursor_path: Option<&str>, own: bool) -> Result<(f64, f64), No> {
    let rows = store.reader_cursors(partition).map_err(|_| No)?;
    let floor = defaults::text("mesh_write.floor_reader");
    if own && rows.iter().any(|r| r["reader"].as_str() != Some(floor)) {
        return Err(No); // this reader's own view: its key comes from the hook's process ancestry
    }
    let row_of = |ns: &str| rows.iter().find(|r| r["ns"] == ns && r["reader"] == floor).and_then(|r| r["value"].as_f64());
    let cursors = format!("{}/{}", devswarm_dir(home), defaults::text("devswarm_role.pg_dir_cursors"));
    let read_cursor = |p: &str| crate::meshw::cursors::read_cursor(Path::new(p));
    let legacy_safe = safe_id(partition) && !partition.contains('#') && !partition.contains(".seen-");
    let store_floor = match row_of(defaults::text("mesh_write.cursor_ns_store")) {
        Some(v) => v,
        None => {
            let base_file = format!("{cursors}/{partition}{}", defaults::text("devswarm_role.pg_base_suffix"));
            let baseline = if legacy_safe && exists(&base_file) {
                read_cursor(&base_file)
            } else {
                let json = read_cursor(&format!("{cursors}/{partition}.json"));
                let row = store.cursor(partition).map_err(|_| No)? as f64;
                json.max(row)
            };
            let mut min: Option<f64> = None;
            if legacy_safe {
                let prefix = format!("{partition}{}", defaults::text("devswarm_role.pg_inst_infix"));
                for n in names(&cursors).unwrap_or_default() {
                    let Some(short) = n.strip_prefix(&prefix).and_then(|x| x.strip_suffix(".json")) else { continue };
                    if short.len() == 6 && short.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
                        let v = read_cursor(&format!("{cursors}/{n}"));
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
                        read_cursor(c)
                    }
                }
            };
            v.max(distinct)
        }
        None => cp.as_deref().map_or(0.0, read_cursor),
    };
    Ok((store_floor, nd_floor))
}

fn message_count(st: &Settings, key: &str, id: &str) -> Result<Value, No> {
    Ok(match open_store(st, key)? {
        None => json!({"state": "none"}),
        Some(s) => json!({"state": "ok", "count": s.message_count(id).map_err(|_| No)?}),
    })
}

fn union_of(st: &Settings, key: &str, id: &str, inbox: Option<&str>, cursor: Option<&str>, own: bool, now: f64) -> Result<Value, No> {
    let Some(store) = open_store(st, key)? else { return Ok(json!({"state": "none"})) };
    let (sb, nb) = floor_positions(&store, &st.home, id, cursor, own)?;
    let u = union_unread(&UnionIn { inbox, cursor_file: cursor, id, store: Some(&store), store_base: sb, nd_base: nb, now: now as i64 }).map_err(|_| No)?;
    let age = u.oldest_unread_age_ms.filter(|a| a.is_finite());
    Ok(json!({"state": "ok", "storeOnly": u.store_only_unread, "age": age}))
}

fn app_archived(st: &Settings, id: &str, worktree: &str, cache: bool) -> Result<Value, No> {
    let now = crate::meshw::common::now_ms();
    let (verdict, owed) = crate::meshw::appdb::archived_verdict(Path::new(&st.home), &st.env, now, id, Some(worktree), cache).map_err(|_| No)?;
    let handle = owed.map(|c| {
        OWED.with(|o| {
            let mut o = o.borrow_mut();
            o.push(c);
            o.len() - 1
        })
    });
    Ok(json!({"verdict": verdict, "cache": handle}))
}

fn child_busy(st: &Settings, id: &str, worktree: &str, session: &str, now: f64, fresh: f64) -> Result<Value, No> {
    let file = match crate::meshw::rostertail::transcript_file(Path::new(&st.home), id, worktree, session) {
        Ok(Some(f)) => f,
        Ok(None) => return Ok(json!({"none": true})),
        Err(_) => return Err(No),
    };
    let b = crate::meshw::rostertail::busy_state(&file, now, fresh).map_err(|_| No)?;
    Ok(json!({"busy": b.busy, "waiting": b.waiting, "question": b.question}))
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

pub(super) fn install<'js>(c: &Ctx<'js>, h: &Object<'js>) -> rquickjs::Result<()> {
    h.set("meshIdent", Function::new(c.clone(), |cwd: String| answer(ident_of(&cwd)))?)?;
    h.set("meshRepoKey", Function::new(c.clone(), |wt: String| answer(ident::repo_key_for_worktree(&wt).map(|k| json!({"key": k})).map_err(|_| No)))?)?;
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
