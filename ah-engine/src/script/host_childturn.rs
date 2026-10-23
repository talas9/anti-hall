//! Host primitives of the `devswarm-child-turn` check for a child that runs inside a git checkout (D88). The child's prompt hook
//! registers the child on every turn: it merges the child's descriptor (`workspaces/<id>.json`), pre-creates its cursor and
//! inbox, upserts the registry row of the project's store and refreshes the summary projection, all under the workspace's lock.
//! The script (`engine/logic/devswarm-child-turn.js`) holds every decision and text; these functions hold no rule, threshold
//! or message, they only extract what it asks for and perform the one registration it has decided on.
//!
//! | raw function | what it does |
//! |---|---|
//! | `ctPrepare(cwd, id, session)` | reads everything the registration depends on and answers `{ok: true}`, or `{unsure: true}` when Node would do something the engine does not (a second registry row of the worktree, a phantom descriptor to retire, a row at another worktree, a missing or foreign store, a summary it cannot reproduce); writes nothing |
//! | `ctRegister(cwd, id, session)` | performs the registration `ctPrepare` planned: lock, descriptor, cursor and inbox, registry row, summary |
//! | `ctArchived(id, top, session)` | `{archived}`: the archive marker or the DevSwarm app's own verdict names this workspace |
//! | `ctIngest(key)` | the project's ingest daemon as `daemonHealth` reads it: `{status: healthy \| stale \| failed, liveLock, beatTs, fault}` |
//! | `ctReaders(key, id)` | `{declared}`: some reader other than the floor holds a cursor of the partition (whose view of the unread count a hook can only tell from its own process ancestry) |
//! | `ctFindPlan(id, root)` | `{plan}`: the step plan of the workspace (by the worktree's key, then by id), `null` for none |
use super::host::with_settings;
use crate::checks::git::util::Settings;
use crate::checks::guardkit::ojson::OVal;
use crate::defaults;
use crate::meshw::common::{self, Inv};
use crate::meshw::ident::{self, R, defer};
use crate::meshw::idlock;
use crate::meshw::store::{MeshStore, RegistryRow};
use crate::meshw::{pull, summary};
use rquickjs::{Ctx, Function, Object};
use serde_json::{Value, json};
use std::cell::RefCell;
use std::path::{Path, PathBuf};

/// A registration read and planned, waiting for [`register`] to perform it.
struct Plan {
    id: String,
    desc: OVal,
    row: RegistryRow,
    /// The project key of the worktree and the store it names (none: the hook registers no row).
    store: Option<(String, Store)>,
}

/// The project's store as the plan found it.
enum Store {
    /// A store Node opened before.
    Open(MeshStore),
    /// A project that has none yet: the registration creates it (the `BACKEND` marker, then the file with Node's tables).
    New,
}

thread_local! {
    /// The plan of this call (a script call runs on one thread).
    static PLANNED: RefCell<Vec<Plan>> = const { RefCell::new(Vec::new()) };
}

/// A new script call starts: no plan is held.
pub(super) fn reset_call() {
    PLANNED.with(|p| p.borrow_mut().clear());
}

fn answer(r: R<Value>) -> String {
    r.map_or_else(|d| json!({"unsure": true, "why": d.0}).to_string(), |v| v.to_string())
}

fn inv_of(st: &Settings, cwd: &str) -> Inv {
    let home = PathBuf::from(&st.home);
    Inv { home: home.clone(), env: st.env.clone(), cwd: cwd.to_string(), now: common::now_ms(), stdin: None, write_home: home, store_override: None }
}

fn json_suffix() -> &'static str {
    defaults::text("mesh_write.json_suffix")
}

/// The descriptor the hook merges over: `{}` for none, unreadable or a scalar; a shape JavaScript would read differently defers.
fn read_base(target: &Path) -> R<OVal> {
    let empty = || OVal::Obj(Vec::new());
    match std::fs::symlink_metadata(target) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(empty()),
        Err(_) => return defer("descriptor-io"),
        Ok(m) if !m.is_file() => return defer("descriptor-kind"),
        Ok(_) => {}
    }
    let Ok(bytes) = std::fs::read(target) else { return Ok(empty()) };
    let text = String::from_utf8_lossy(&bytes);
    match OVal::parse(&text) {
        Some(v @ OVal::Obj(_)) => {
            if let OVal::Obj(fields) = &v
                && fields.iter().any(|(k, _)| k == defaults::text("devswarm_prompt.proto_key"))
            {
                return defer("descriptor-keys");
            }
            Ok(v)
        }
        Some(OVal::Arr(_)) => defer("descriptor-shape"),
        Some(_) => Ok(empty()),
        None if text.contains(defaults::text("devswarm_prompt.escape_marker")) => defer("descriptor-escapes"),
        None => Ok(empty()),
    }
}

fn path_field(desc: &OVal, key: &str, dflt: String) -> R<OVal> {
    match desc.get(key) {
        None | Some(OVal::Null) => Ok(OVal::Str(dflt)),
        Some(v @ OVal::Str(_)) => Ok(v.clone()),
        Some(_) => defer("descriptor-path-type"),
    }
}

/// A truncated-id phantom descriptor that shares this worktree: Node archives it (a fold and an archive the engine leaves to Node).
fn phantom_present(ws_dir: &Path, keep_id: &str, top: &str) -> R<bool> {
    let Ok(rd) = std::fs::read_dir(ws_dir) else { return Ok(false) };
    let truncated = regex::RegexBuilder::new(defaults::text("devswarm_prompt.uuid_truncated_re"))
        .case_insensitive(true)
        .build()
        .map_err(|_| ident::Defer("regex".into()))?;
    let full =
        regex::RegexBuilder::new(defaults::text("devswarm_prompt.uuid_full_re")).case_insensitive(true).build().map_err(|_| ident::Defer("regex".into()))?;
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let Some(cand) = name.strip_suffix(json_suffix()) else { continue };
        if cand == keep_id || !idlock::is_safe_id(cand) || !truncated.is_match(cand) || full.is_match(cand) {
            continue;
        }
        let Some(OVal::Obj(fields)) = std::fs::read(e.path()).ok().and_then(|b| OVal::parse(&String::from_utf8_lossy(&b))) else { continue };
        let d = OVal::Obj(fields);
        if matches!(d.get(defaults::text("mesh_write.field_worktree_path")), Some(OVal::Str(w)) if w == top) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Whether the project has no store at all, the case where Node's `resolveStoreBackend` writes the marker and creates the file: no
/// backend forced, no marker, no database, no journal. A store that exists in any other state is left to `open_store` (and to Node).
fn store_is_new(inv: &Inv, key: &str) -> R<bool> {
    if inv.env.get(defaults::text("mesh_write.env_store_backend")).is_some_and(|v| !v.trim().is_empty()) {
        return Ok(false);
    }
    let dir = crate::meshw::union::store_dir(&inv.home, key);
    if dir.join(defaults::text("mesh.backend_marker")).exists() {
        return Ok(false);
    }
    let has_db = std::fs::metadata(dir.join(defaults::text("mesh_write.store_file"))).map(|m| m.len() > 0).unwrap_or(false);
    let has_journal = std::fs::read_dir(dir.join(defaults::text("devswarm_role.pg_journal_dir"))).is_ok_and(|mut d| d.next().is_some());
    if has_db || has_journal {
        return defer("store-backend");
    }
    Ok(true)
}

/// `writeBackendMarker(dir, 'sqlite')`: a temporary file, then a rename.
fn write_marker(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let marker = dir.join(defaults::text("mesh.backend_marker"));
    let tmp =
        dir.join(format!("{}.{}.{}{}", defaults::text("mesh.backend_marker"), std::process::id(), common::now_ms(), defaults::text("mesh_write.tmp_suffix")));
    let style = crate::atomic::Style { leave_temp_on_rename_failure: true, ..crate::atomic::Style::default() }; // Node leaves the temp file after a failed rename
    crate::atomic::stage(&tmp, defaults::text("mesh.backend_sqlite"), style)?;
    crate::atomic::replace(&tmp, marker, style)
}

fn plan(inv: &Inv, id: &str, session: &str) -> R<Plan> {
    let ctx = ident::resolve_context(&inv.cwd, true)?;
    let Some(top) = ctx.toplevel else { return defer("no-checkout") };
    let ws_dir = idlock::devswarm_root(&inv.home).join(defaults::text("mesh_write.dir_workspaces"));
    let mut desc = read_base(&ws_dir.join(format!("{id}{}", json_suffix())))?;
    desc.set("id", common::s(id));
    desc.set(defaults::text("mesh_write.field_worktree_path"), common::s(&top));
    desc.set(defaults::text("mesh_write.field_session_id"), common::s(session));
    let repo_id = inv.env.get(defaults::text("devswarm_prompt.repo_env")).filter(|r| !r.is_empty());
    desc.set("repoId", repo_id.map_or(OVal::Null, |r| common::s(r)));
    let inbox = path_field(&desc, defaults::text("mesh_write.field_inbox_path"), pull::inbox_default(&inv.home, id))?;
    desc.set(defaults::text("mesh_write.field_inbox_path"), inbox);
    let cursor = path_field(&desc, defaults::text("mesh_write.field_cursor_path"), pull::cursor_default(&inv.home, id))?;
    desc.set(defaults::text("mesh_write.field_cursor_path"), cursor);
    if desc.get("nudgeCommand").is_none() {
        desc.set("nudgeCommand", OVal::Null);
    }
    let row = RegistryRow {
        id: id.to_string(),
        worktree_path: pull::text_or_null(&desc, defaults::text("mesh_write.field_worktree_path"))?,
        session_id: pull::text_or_null(&desc, defaults::text("mesh_write.field_session_id"))?,
        inbox_path: pull::text_or_null(&desc, defaults::text("mesh_write.field_inbox_path"))?,
        cursor_path: pull::text_or_null(&desc, defaults::text("mesh_write.field_cursor_path"))?,
        nudge_command: match desc.get("nudgeCommand") {
            None | Some(OVal::Null) => None,
            Some(v) => Some(v.stringify()),
        },
    };
    let mut store = None;
    if let Some(key) = ident::repo_key_for_worktree(&top)? {
        if store_is_new(inv, &key)? {
            // no rows to collide with or to fold: nothing to check before the registration creates the store
            if phantom_present(&ws_dir, id, &top)? {
                return defer("phantom-descriptor");
            }
            return Ok(Plan { id: id.to_string(), desc, row, store: Some((key, Store::New)) });
        }
        let s = common::open_store(inv, &key)?;
        summary::check(&s, inv, None)?;
        let reader = crate::meshw::tick::open_reader(inv, &key)?.ok_or_else(|| ident::Defer("no-store".into()))?;
        let rows = ident::rows_of(&reader.roster().map_err(|e| ident::Defer(format!("registry:{e}")))?);
        if rows.iter().find(|r| r.id == id).and_then(|r| r.worktree_path.as_deref()).is_some_and(|have| have != top) {
            return defer("registry-collision");
        }
        if crate::meshw::lifeverbs::has_duplicate_rows(inv, &key, id, Some(&top))? {
            return defer("duplicate-registry-rows");
        }
        store = Some((key, Store::Open(s)));
    }
    if phantom_present(&ws_dir, id, &top)? {
        return defer("phantom-descriptor");
    }
    Ok(Plan { id: id.to_string(), desc, row, store })
}

/// Perform a planned registration under the workspace's lock. `Err` only before the first write.
fn perform(inv: &Inv, p: Plan) -> R<()> {
    let Some(lock) = idlock::acquire(&inv.home, &p.id) else { return defer("lock-busy") };
    // the cursor and the inbox first, the descriptor last (it is what makes the child discoverable)
    pull::precreate(&p.desc);
    // a descriptor that cannot be written ends the registration, as in Node (the turn goes on without a row)
    let written = pull::write_descriptor(inv, &p.id, &p.desc).is_ok();
    if written && let Some((key, sel)) = &p.store {
        let created: Option<MeshStore> = match sel {
            Store::Open(_) => None,
            Store::New => {
                let dir = crate::meshw::union::store_dir(&inv.home, key);
                let made = write_marker(&dir)
                    .map_err(|e| e.to_string())
                    .and_then(|()| MeshStore::open(&dir.join(defaults::text("mesh_write.store_file"))).map_err(|e| e.to_string()));
                // Node's registerStoreDescriptor swallows a store it cannot create; the next turn retries
                made.map_err(|e| crate::discard::note("childturn.store_create", &e)).ok()
            }
        };
        let store = match sel {
            Store::Open(s) => Some(s),
            Store::New => created.as_ref(),
        };
        if let Some(store) = store {
            match store.upsert_registry(&p.row, inv.now, |a, b| a == b) {
                Ok(_) => {
                    if let Some(why) = summary::derive_after_write(store, inv, key) {
                        crate::meshw::log_summary_failure(defaults::text("devswarm_prompt.log_verb"), &why);
                    }
                }
                // Node's registerStoreDescriptor swallows it and the next turn retries
                Err(e) => crate::discard::note("childturn.registry_upsert", &e.to_string()),
            }
        }
    }
    lock.release();
    Ok(())
}

fn json_of(path: &Path) -> Option<OVal> {
    OVal::parse(&String::from_utf8_lossy(&std::fs::read(path).ok()?))
}

fn finite(v: Option<&OVal>) -> Option<f64> {
    match v {
        Some(OVal::Num(n)) if n.is_finite() => Some(*n),
        _ => None,
    }
}

fn alive(pid: f64) -> bool {
    if !(pid.is_finite() && pid > 0.0 && pid <= f64::from(i32::MAX)) || pid.fract() != 0.0 {
        return false;
    }
    // SAFETY: signal 0 only probes for the process.
    let rc = unsafe { libc::kill(pid as i32, 0) };
    rc == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

fn text_of(v: Option<&OVal>) -> Value {
    match v {
        Some(OVal::Str(t)) => json!(t),
        _ => Value::Null,
    }
}

/// `daemonHealth(home, repoKey)` (companion/lib/ingest-health.js) with the monitor fault `doctor-repair.js` `monitorFaultFor` reads
/// from the same heartbeat: the status, whether the project lock is held by a live process, the heartbeat's time and the fault.
fn ingest_detail(inv: &Inv, key: &str) -> R<Value> {
    let root = idlock::devswarm_root(&inv.home);
    let json_suffix = json_suffix();
    let beat =
        json_of(&root.join(defaults::text("mesh_write.dir_heartbeats")).join(format!("{}{key}{json_suffix}", defaults::text("mesh_write.ingest_beat_prefix"))));
    let beat_ts = beat.as_ref().and_then(|b| finite(b.get("ts")));
    let beat_pid = beat.as_ref().and_then(|b| finite(b.get("pid")));
    let now = inv.now as f64;
    let fresh = beat_ts.is_some_and(|t| now - t <= defaults::num("mesh_write.ingest_beat_stale_ms") as f64);
    let lock = json_of(&root.join(defaults::text("mesh_write.dir_locks")).join(format!(
        "{}{key}{}",
        defaults::text("mesh_write.ingest_lock_prefix"),
        defaults::text("mesh_write.lock_suffix")
    )));
    let lock_pid = lock.as_ref().and_then(|l| finite(l.get("pid")));
    let live_lock = lock_pid.is_some_and(alive);
    let healthy = fresh && live_lock && beat_pid.is_some() && beat_pid == lock_pid;
    let mut fault = Value::Null;
    if healthy
        && let Some(b) = &beat
        && let Some(consecutive) = finite(b.get("consecutiveMonitorFailures"))
    {
        let last_ok = finite(b.get("lastMonitorOkMs"));
        let started = finite(b.get("startedAtMs"));
        let min = crate::checks::guardkit::settings::get_number(&inv.settings(), defaults::raw("mesh_write.setting_monitor_no_ok_fail_min"));
        let window = if min.is_finite() && min > 0.0 { min * defaults::num("mesh_write.ms_per_minute") as f64 } else { return defer("monitor-window") };
        let ok_stale = last_ok.is_some_and(|l| now - l > window);
        let no_ok_since_start = last_ok.is_none() && started.is_some_and(|s| now - s > window);
        if consecutive >= defaults::num("mesh_write.monitor_failure_threshold") as f64 || ok_stale || no_ok_since_start {
            fault = json!({
                "consecutive": consecutive, "code": text_of(b.get("lastMonitorErrorCode")), "error": text_of(b.get("lastMonitorError")),
                "lastOkMs": last_ok, "okStale": ok_stale, "noOkSinceStart": no_ok_since_start, "startedAtMs": started, "heartbeatTs": beat_ts,
            });
        }
    }
    let status = if !fault.is_null() {
        "failed"
    } else if healthy {
        "healthy"
    } else {
        "stale"
    };
    Ok(json!({"status": status, "liveLock": live_lock, "beatTs": beat_ts, "fault": fault}))
}

fn archived(inv: &Inv, id: &str, top: &str, session: &str) -> R<bool> {
    let t = crate::dssup::recon::sweep::Target { id: id.to_string(), worktree: top.to_string(), session: Some(session.to_string()) };
    if crate::dssup::recon::sweep::marker_archived(&inv.home, &t)? {
        return Ok(true);
    }
    let (verdict, _) = crate::meshw::appdb::archived_verdict(&inv.home, &inv.env, inv.now, id, Some(top), false)?;
    Ok(verdict == Some(true))
}

/// Whether a reader of this partition other than the floor has a cursor row: only then does the unread count depend on which reader asks.
fn readers_declared(inv: &Inv, key: &str, id: &str) -> R<bool> {
    let Some(reader) = crate::meshw::tick::open_reader(inv, key)? else { return Ok(false) };
    let rows = reader.reader_cursors(id).map_err(|e| ident::Defer(format!("reader-cursors:{e}")))?;
    let floor = defaults::text("mesh_write.floor_reader");
    Ok(rows.iter().any(|r| r.get("reader").and_then(Value::as_str) != Some(floor)))
}

fn find_plan(inv: &Inv, id: &str, root: &str) -> R<Value> {
    Ok(match crate::meshw::plan::find_for(inv, id, Some(root).filter(|r| !r.is_empty()))? {
        Some(f) => json!({"plan": f.plan.stringify()}),
        None => json!({"plan": null}),
    })
}

pub(super) fn install<'js>(c: &Ctx<'js>, h: &Object<'js>) -> rquickjs::Result<()> {
    h.set(
        "ctPrepare",
        Function::new(c.clone(), |cwd: String, id: String, session: String| -> rquickjs::Result<String> {
            with_settings(|st| {
                let inv = inv_of(st, &cwd);
                answer(plan(&inv, &id, &session).map(|p| {
                    PLANNED.with(|slot| *slot.borrow_mut() = vec![p]);
                    json!({"ok": true})
                }))
            })
        })?,
    )?;
    h.set(
        "ctRegister",
        Function::new(c.clone(), |cwd: String, id: String, session: String| -> rquickjs::Result<String> {
            with_settings(|st| {
                let inv = inv_of(st, &cwd);
                let planned = PLANNED.with(|slot| slot.borrow_mut().pop()).filter(|p| p.id == id);
                answer(planned.map_or_else(|| plan(&inv, &id, &session), Ok).and_then(|p| perform(&inv, p)).map(|()| json!({"ok": true})))
            })
        })?,
    )?;
    h.set(
        "ctArchived",
        Function::new(c.clone(), |id: String, top: String, session: String| -> rquickjs::Result<String> {
            with_settings(|st| answer(archived(&inv_of(st, &top), &id, &top, &session).map(|a| json!({"archived": a}))))
        })?,
    )?;
    h.set(
        "ctIngest",
        Function::new(c.clone(), |key: String| -> rquickjs::Result<String> { with_settings(|st| answer(ingest_detail(&inv_of(st, ""), &key))) })?,
    )?;
    h.set(
        "ctReaders",
        Function::new(c.clone(), |key: String, id: String| -> rquickjs::Result<String> {
            with_settings(|st| answer(readers_declared(&inv_of(st, ""), &key, &id).map(|d| json!({"declared": d}))))
        })?,
    )?;
    h.set(
        "ctFindPlan",
        Function::new(c.clone(), |id: String, root: String| -> rquickjs::Result<String> {
            with_settings(|st| answer(find_plan(&inv_of(st, &root), &id, &root)))
        })?,
    )?;
    Ok(())
}
