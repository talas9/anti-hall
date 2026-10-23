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
use crate::meshw::ident::{self, R};
use crate::meshw::idlock;
use crate::meshw::store::{MeshStore, RegistryRow};
use crate::meshw::{pull, summary};
use rquickjs::{Ctx, Function, Object};
use serde_json::{Value, json};
use std::cell::RefCell;
use std::path::{Path, PathBuf};

/// A registration read and planned, waiting for [`perform`] to carry it out.
struct Plan {
    /// The id the caller asked with (the builder id of the environment).
    asked: String,
    /// The id the descriptor is registered under (a cut-short builder id recovered from the session id).
    id: String,
    /// The checkout the descriptor names.
    top: String,
    /// The descriptor as it is written: the object's own fields only.
    desc: OVal,
    /// The object a `__proto__` field of the old descriptor named: JavaScript makes it the merged object's prototype, so a field
    /// the old descriptor lacked reads through to it, while only own fields are written.
    proto: Option<OVal>,
    /// The registry row; `None` when a path field holds a value no database column takes (Node's insert throws, the store leg ends).
    row: Option<RegistryRow>,
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

/// What reading the registration produced.
enum Planned {
    /// Register this.
    Go(Box<Plan>),
    /// Node registers nothing this turn (no checkout, a cut-short id nothing recovers): the turn goes on.
    Nothing,
    /// The registration is left for this turn and the cause logged: an input the engine refuses to rewrite (the old descriptor is a
    /// FIFO or over the read cap, or holds a lone-surrogate escape its strings cannot carry).
    Skip(String),
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

/// A pattern of the shipped settings; one that does not compile (a broken override) matches nothing, and says so.
fn pattern(key: &'static str, nocase: bool) -> Option<regex::Regex> {
    match regex::RegexBuilder::new(defaults::text(key)).case_insensitive(nocase).build() {
        Ok(re) => Some(re),
        Err(e) => {
            crate::discard::note("childturn.pattern", &format!("{key}: {e}"));
            None
        }
    }
}

/// A cut-short UUID: the shape a builder id has when whatever set the environment sliced it.
fn is_truncated(id: &str) -> bool {
    let (t, f) = (pattern("devswarm_prompt.uuid_truncated_re", true), pattern("devswarm_prompt.uuid_full_re", true));
    t.is_some_and(|t| t.is_match(id)) && !f.is_some_and(|f| f.is_match(id))
}

fn is_full_uuid(id: &str) -> bool {
    pattern("devswarm_prompt.uuid_full_re", true).is_some_and(|f| f.is_match(id))
}

/// The text with every lone surrogate `\uXXXX` escape replaced by U+FFFD, `None` when it held none. JavaScript's `JSON.parse` takes such
/// an escape, a Rust string cannot hold it.
pub(super) fn without_lone_surrogates(text: &str) -> Option<String> {
    let b = text.as_bytes();
    let hex4 = |i: usize| b.get(i..i + 4).filter(|h| h.iter().all(u8::is_ascii_hexdigit)).and_then(|h| u32::from_str_radix(std::str::from_utf8(h).ok()?, 16).ok());
    let (mut out, mut i, mut hit) = (String::with_capacity(text.len()), 0, false);
    while i < b.len() {
        if b[i] != b'\\' {
            let n = text[i..].chars().next().map_or(1, char::len_utf8);
            out.push_str(&text[i..i + n]);
            i += n;
            continue;
        }
        if b.get(i + 1) == Some(&b'u')
            && let Some(c) = hex4(i + 2)
        {
            let low_next = b.get(i + 6) == Some(&b'\\') && b.get(i + 7) == Some(&b'u') && hex4(i + 8).is_some_and(|d| (0xDC00..0xE000).contains(&d));
            if (0xD800..0xDC00).contains(&c) && low_next {
                out.push_str(&text[i..i + 12]);
                i += 12;
                continue;
            }
            if (0xD800..0xE000).contains(&c) {
                out.push_str("\\uFFFD");
                hit = true;
                i += 6;
                continue;
            }
            out.push_str(&text[i..i + 6]);
            i += 6;
            continue;
        }
        let n = text[i + 1..].chars().next().map_or(0, char::len_utf8);
        out.push_str(&text[i..i + 1 + n]);
        i += 1 + n;
    }
    hit.then_some(out)
}

/// The descriptor the hook merges over (`registerChildDescriptor`: `JSON.parse(readFileSync)` in a try, `{}` for anything that does not
/// read or is not an object): the object's own fields, and the object a `__proto__` field names. An array merges as its indices.
fn read_base(target: &Path) -> Result<(OVal, Option<OVal>), String> {
    let empty = || (OVal::Obj(Vec::new()), None);
    let bytes = match ident::read_bounded(target) {
        Ok(Some(b)) => b,
        Ok(None) => return Ok(empty()),
        Err(d) => return Err(format!("{}{}", defaults::text("devswarm_prompt.skip_descriptor_unreadable"), d.0)),
    };
    let text = String::from_utf8_lossy(&bytes);
    match OVal::parse(&text) {
        Some(OVal::Obj(mut fields)) => {
            let key = defaults::text("devswarm_prompt.proto_key");
            let proto = fields.iter().position(|(k, _)| k == key).map(|i| fields.remove(i).1).filter(|v| matches!(v, OVal::Obj(_)));
            Ok((OVal::Obj(fields), proto))
        }
        Some(OVal::Arr(items)) => Ok((OVal::Obj(items.into_iter().enumerate().map(|(i, v)| (i.to_string(), v)).collect()), None)),
        Some(_) => Ok(empty()),
        None if without_lone_surrogates(&text).is_some_and(|t| OVal::parse(&t).is_some()) => Err(defaults::text("devswarm_prompt.skip_descriptor_surrogate").to_string()),
        None => Ok(empty()),
    }
}

/// `obj[key]` as the merged object reads it: its own field, else the prototype's.
fn effective<'a>(desc: &'a OVal, proto: Option<&'a OVal>, key: &str) -> Option<&'a OVal> {
    desc.get(key).or_else(|| proto.and_then(|p| p.get(key)))
}

/// What a database column takes of a descriptor field: text as it is, a number as its text (the column's affinity), nothing for
/// null or absent; `Err` for a value the driver cannot bind (a boolean, an array, an object).
fn column_text(v: Option<&OVal>) -> Result<Option<String>, ()> {
    match v {
        None | Some(OVal::Null) => Ok(None),
        Some(OVal::Str(t)) => Ok(Some(t.clone())),
        Some(OVal::Num(n)) => Ok(Some(crate::checks::jsport::num::to_js_string(*n))),
        Some(_) => Err(()),
    }
}

/// Which of a project's stores the registration meets: the one `resolveStoreBackend` settles on.
enum Backend {
    /// A sqlite store, or none yet (the registration creates it).
    Sqlite { fresh: bool },
    /// A journal-backed store: a backend only a Node older than 22.5 writes, which the engine neither reads nor writes.
    Journal,
}

/// `resolveStoreBackend(dir)`: a forced backend, else the `BACKEND` marker, else what the directory holds (the database wins over the
/// journal) and the marker written for it.
fn settle_backend(inv: &Inv, key: &str) -> Backend {
    let forced = inv.env.get(defaults::text("mesh_write.env_store_backend")).map(|v| v.trim().to_lowercase()).unwrap_or_default();
    if forced == defaults::text("mesh_write.backend_journal") {
        return Backend::Journal;
    }
    if forced == defaults::text("mesh.backend_sqlite") {
        return Backend::Sqlite { fresh: false };
    }
    let dir = crate::meshw::union::store_dir(&inv.home, key);
    let marker = std::fs::read_to_string(dir.join(defaults::text("mesh.backend_marker"))).map(|m| m.trim().to_lowercase()).unwrap_or_default();
    if marker == defaults::text("mesh_write.backend_journal") {
        return Backend::Journal;
    }
    if marker == defaults::text("mesh.backend_sqlite") {
        return Backend::Sqlite { fresh: false };
    }
    let has_db = std::fs::metadata(dir.join(defaults::text("mesh_write.store_file"))).map(|m| m.len() > 0).unwrap_or(false);
    let has_journal = std::fs::read_dir(dir.join(defaults::text("devswarm_role.pg_journal_dir"))).is_ok_and(|mut d| d.next().is_some());
    if !has_db && has_journal {
        return Backend::Journal;
    }
    if has_db && let Err(e) = write_marker(&dir) {
        crate::discard::note("childturn.marker", &e.to_string()); // Node's marker write is best effort too
    }
    Backend::Sqlite { fresh: !has_db }
}

/// `writeBackendMarker(dir, 'sqlite')`: a temporary file, then a rename.
fn write_marker(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let marker = dir.join(defaults::text("mesh.backend_marker"));
    let tmp = dir.join(format!("{}.{}.{}{}", defaults::text("mesh.backend_marker"), std::process::id(), common::now_ms(), defaults::text("mesh_write.tmp_suffix")));
    let style = crate::atomic::Style { leave_temp_on_rename_failure: true, ..crate::atomic::Style::default() }; // Node leaves the temp file after a failed rename
    crate::atomic::stage(&tmp, defaults::text("mesh.backend_sqlite"), style)?;
    crate::atomic::replace(&tmp, marker, style)
}

fn plan(inv: &Inv, asked: &str, session: &str) -> R<Planned> {
    // a cut-short builder id is never trusted as a file name: the session id names the workspace when it is the full UUID the id is a prefix of
    let mut id = asked.to_string();
    if is_truncated(asked) {
        if is_full_uuid(session) && session != asked && session.starts_with(asked) {
            id = session.to_string();
        } else {
            return Ok(Planned::Nothing);
        }
    }
    let ctx = ident::resolve_context(&inv.cwd, true)?;
    let Some(top) = ctx.toplevel else { return Ok(Planned::Nothing) };
    let ws_dir = idlock::devswarm_root(&inv.home).join(defaults::text("mesh_write.dir_workspaces"));
    let (mut desc, proto) = match read_base(&ws_dir.join(format!("{id}{json_suffix}", json_suffix = json_suffix()))) {
        Ok(base) => base,
        Err(why) => return Ok(Planned::Skip(why)),
    };
    desc.set("id", common::s(&id));
    desc.set(defaults::text("mesh_write.field_worktree_path"), common::s(&top));
    desc.set(defaults::text("mesh_write.field_session_id"), common::s(session));
    let repo_id = inv.env.get(defaults::text("devswarm_prompt.repo_env")).filter(|r| !r.is_empty());
    desc.set("repoId", repo_id.map_or(OVal::Null, |r| common::s(r)));
    for (field, dflt) in [
        (defaults::text("mesh_write.field_inbox_path"), pull::inbox_default(&inv.home, &id)),
        (defaults::text("mesh_write.field_cursor_path"), pull::cursor_default(&inv.home, &id)),
    ] {
        if matches!(effective(&desc, proto.as_ref(), field), None | Some(OVal::Null)) {
            desc.set(field, OVal::Str(dflt));
        }
    }
    if effective(&desc, proto.as_ref(), "nudgeCommand").is_none() {
        desc.set("nudgeCommand", OVal::Null);
    }
    let field = |k: &str| effective(&desc, proto.as_ref(), k);
    let row = (|| -> Result<RegistryRow, ()> {
        Ok(RegistryRow {
            id: id.clone(),
            worktree_path: column_text(field(defaults::text("mesh_write.field_worktree_path")))?,
            session_id: column_text(field(defaults::text("mesh_write.field_session_id")))?,
            inbox_path: column_text(field(defaults::text("mesh_write.field_inbox_path")))?,
            cursor_path: column_text(field(defaults::text("mesh_write.field_cursor_path")))?,
            nudge_command: match field("nudgeCommand") {
                None | Some(OVal::Null) => None,
                Some(v) => Some(v.stringify()),
            },
        })
    })()
    .ok();
    // the project's store, as `registerStoreDescriptor` reaches it: a failure to open one ends the store leg, never the turn
    let mut store = None;
    if let Some(key) = ident::repo_key_for_worktree(&top)? {
        match settle_backend(inv, &key) {
            Backend::Journal => crate::discard::note("childturn.journal_store", &key),
            Backend::Sqlite { fresh: true } => store = Some((key, Store::New)),
            Backend::Sqlite { fresh: false } => match common::open_store(inv, &key) {
                Ok(s) => store = Some((key, Store::Open(s))),
                Err(d) => crate::discard::note("childturn.store_open", &d.0),
            },
        }
    }
    Ok(Planned::Go(Box::new(Plan { asked: asked.to_string(), id, top, desc, proto, row, store })))
}

/// `registerStoreDescriptor`'s same-worktree test for the registry's id-collision guard (`sameRegistryWorktree`): the paths are equal,
/// resolve to the same directory, or one is the key-bearing root the other resolves to.
fn same_registry_worktree(existing: &str, incoming: &str) -> bool {
    if existing == incoming {
        return true;
    }
    let real = |p: &str| ident::realpath(p).unwrap_or_else(|| ident::resolve_abs(p));
    let (ra, rb) = (real(existing), real(incoming));
    if ra == rb {
        return true;
    }
    let root = |p: &str| ident::resolve_context(p, false).ok().and_then(|c| c.worktree_root);
    let (xa, xb) = (root(existing), root(incoming));
    xa.as_deref().is_some_and(|x| x == rb) || xb.as_deref().is_some_and(|x| x == ra) || (xa.is_some() && xa == xb)
}

/// Perform a planned registration (`registerChildDescriptor`, `registerStoreDescriptor`, then the retirement of the checkout's phantoms).
/// Every step is best effort, as in Node: the turn goes on whatever fails.
fn perform(inv: &Inv, p: Plan) {
    // the lock only orders this write against the archive and retire paths: a lock that stays busy does not stop the descriptor, it
    // ends the store leg (retried next turn)
    let lock = idlock::acquire(&inv.home, &p.id);
    // the cursor and the inbox first, the descriptor last (it is what makes the child discoverable)
    let mut pre = p.desc.clone();
    for k in [defaults::text("mesh_write.field_inbox_path"), defaults::text("mesh_write.field_cursor_path")] {
        if let Some(v) = effective(&p.desc, p.proto.as_ref(), k) {
            pre.set(k, v.clone());
        }
    }
    pull::precreate(&pre);
    // a descriptor that cannot be written ends the registration, as in Node (the turn goes on without a row)
    let written = pull::write_descriptor(inv, &p.id, &p.desc).is_ok();
    let mut stored = false;
    if written && lock.is_none() {
        crate::discard::note("childturn.lock_busy", &p.id);
    }
    if written && lock.is_some() && let (Some((key, sel)), Some(row)) = (&p.store, &p.row) {
        let created: Option<MeshStore> = match sel {
            Store::Open(_) => None,
            Store::New => {
                let dir = crate::meshw::union::store_dir(&inv.home, key);
                let made = write_marker(&dir).map_err(|e| e.to_string()).and_then(|()| MeshStore::open(&dir.join(defaults::text("mesh_write.store_file"))).map_err(|e| e.to_string()));
                // Node's registerStoreDescriptor swallows a store it cannot create; the next turn retries
                made.map_err(|e| crate::discard::note("childturn.store_create", &e)).ok()
            }
        };
        let store = match sel {
            Store::Open(s) => Some(s),
            Store::New => created.as_ref(),
        };
        if let Some(store) = store {
            // a row of this id at another worktree is left alone (the registry's collision guard, which warns)
            match store.upsert_registry(row, inv.now, same_registry_worktree) {
                Ok(_) => {
                    stored = true;
                    if let Some(why) = summary::derive_after_write(store, inv, key) {
                        crate::meshw::log_summary_failure(defaults::text("devswarm_prompt.log_verb"), &why);
                    }
                }
                // Node's registerStoreDescriptor swallows it and the next turn retries
                Err(e) => crate::discard::note("childturn.registry_upsert", &e.to_string()),
            }
        }
    }
    if let Some(l) = lock {
        l.release();
    }
    if stored {
        retire_duplicates(inv, &p.id, &p.top);
    }
    if written && let Some((key, _)) = &p.store {
        retire_phantoms(inv, key, &p.id, &p.top);
    }
}

/// `retireWorktreeDuplicates`: another registry row of this physical worktree (a spawn's seed row, a legacy registration) is folded
/// into this id, its unread mail forwarded first. Best effort, as Node's catch.
fn retire_duplicates(inv: &Inv, id: &str, top: &str) {
    let st = inv.settings();
    // the plugin root named Node's functions for the old witness; the native gate does not read it
    let ctx = crate::dssup::tick::Ctx { home: &inv.home, root: &inv.home, st: &st, now: inv.now, engine_pokes: false };
    let runner = crate::dsact::runner::System::configured();
    let hooks = crate::dssup::recon::Hooks { at: &|_| {} };
    if let Err(d) = crate::dssup::recon::dup::retire_worktree_duplicates(&ctx, &runner, top, id, top, &hooks) {
        crate::discard::note("childturn.retire_duplicates", &d.0);
    }
}

/// `retirePhantomWorktreeDuplicates`: a descriptor of this checkout whose id is a cut-short UUID (the shape of the truncation
/// incident, the one proof a descriptor is a phantom) is archived once its unread mail has been forwarded to this id. Its row was
/// folded by [`retire_duplicates`]; mail still waiting there leaves the phantom in place for the next turn.
fn retire_phantoms(inv: &Inv, key: &str, keep: &str, top: &str) {
    let root = idlock::devswarm_root(&inv.home);
    let ws_dir = root.join(defaults::text("mesh_write.dir_workspaces"));
    let Ok(rd) = std::fs::read_dir(&ws_dir) else { return };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let Some(cand) = name.strip_suffix(json_suffix()) else { continue };
        if cand == keep || !idlock::is_safe_id(cand) || !is_truncated(cand) {
            continue;
        }
        let Ok(Some(bytes)) = ident::read_bounded(&e.path()) else { continue };
        let Some(desc @ OVal::Obj(_)) = OVal::parse(&String::from_utf8_lossy(&bytes)) else { continue };
        let named = match desc.get("id") {
            Some(OVal::Str(i)) => i.clone(),
            Some(OVal::Num(n)) => crate::checks::jsport::num::to_js_string(*n),
            _ => continue,
        };
        if named != cand || !matches!(desc.get(defaults::text("mesh_write.field_worktree_path")), Some(OVal::Str(w)) if w == top) {
            continue;
        }
        if let Err(why) = archive_phantom(inv, key, cand, &e.path(), &bytes, &desc) {
            crate::discard::note("childturn.phantom_kept", &format!("{cand}: {why}"));
        }
    }
}

/// `cmdArchive(candId, { appArchive: false })` for a phantom, once nothing is left to forward: the descriptor is linked into
/// `archived/`, the registry row tombstoned, the summary refreshed, and the active name unlinked last.
fn archive_phantom(inv: &Inv, key: &str, cand: &str, active: &Path, bytes: &[u8], desc: &OVal) -> Result<(), String> {
    use crate::dssup::recon::{Op, Pre, Unit, view};
    use std::os::unix::fs::MetadataExt;
    let root = idlock::devswarm_root(&inv.home);
    let adir = root.join(defaults::text("mesh_write.dir_archived"));
    std::fs::create_dir_all(&adir).map_err(|e| e.to_string())?;
    if std::fs::symlink_metadata(adir.join(format!("{cand}{}", json_suffix()))).is_ok() {
        return Err(defaults::text("devswarm_prompt.skip_phantom_marker").to_string());
    }
    let rows = view::registry(&inv.home, key).map_err(|d| d.0)?;
    let mine = rows.iter().find(|r| r.row.id == cand).cloned();
    if mine.is_some() {
        let store = common::open_store(inv, key).map_err(|d| d.0)?;
        let sum = summary::compute(&store, inv, None).map_err(|d| d.0)?;
        if !matches!(sum.get("workspaces").and_then(|w| w.get(cand)).and_then(|w| w.get("unread")), Some(OVal::Num(u)) if *u <= 0.0) {
            return Err(defaults::text("devswarm_prompt.skip_phantom_unread").to_string());
        }
    }
    let ino = std::fs::metadata(active).map(|m| (m.dev(), m.ino())).map_err(|e| e.to_string())?;
    let Some(lock) = idlock::acquire(&inv.home, cand) else { return Err(defaults::text("devswarm_prompt.skip_phantom_lock").to_string()) };
    let (arel, drel) = (view::archived_rel(cand), view::descriptor_rel(cand));
    let intent_rel = view::ds(&format!("{}/{cand}{}", defaults::text("devswarm_cli.dir_recovery_intent"), json_suffix()));
    let mut intent = crate::meshw::common::Obj::default();
    intent
        .put("id", common::s(cand))
        .put("ownerKey", common::s(key))
        .put("op", common::s(defaults::text("devswarm_cli.recovery_op")))
        .put("descriptor", desc.clone())
        .put("fingerprint", common::s(&view::sha256_hex(desc.stringify().as_bytes())))
        .put("ts", common::n(inv.now as f64));
    let mut ops = vec![
        Op::Link { from: drel.clone(), to: arel.clone(), pre: Pre::Digest(view::sha256_hex(bytes)), ino: Some(ino) },
        Op::Write { rel: intent_rel.clone(), bytes: intent.done().stringify().into_bytes(), pre: Pre::Any },
    ];
    if let Some(row) = mine {
        ops.push(Op::Remove { store: key.to_string(), guard: Box::new(row) });
    }
    ops.push(Op::Derive { store: key.to_string() });
    ops.push(Op::UnlinkLinked { rel: drel, other: arel });
    ops.push(Op::Unlink { rel: intent_rel, pre: Pre::Any });
    let applied = crate::meshw::lifeverbs::apply_units(inv, &[Unit { label: format!("archive:{cand}"), lock: None, ops }]);
    lock.release();
    applied.map_err(|d| d.0)
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
    let beat = json_of(&root.join(defaults::text("mesh_write.dir_heartbeats")).join(format!("{}{key}{json_suffix}", defaults::text("mesh_write.ingest_beat_prefix"))));
    let beat_ts = beat.as_ref().and_then(|b| finite(b.get("ts")));
    let beat_pid = beat.as_ref().and_then(|b| finite(b.get("pid")));
    let now = inv.now as f64;
    let fresh = beat_ts.is_some_and(|t| now - t <= defaults::num("mesh_write.ingest_beat_stale_ms") as f64);
    let lock = json_of(&root.join(defaults::text("mesh_write.dir_locks")).join(format!("{}{key}{}", defaults::text("mesh_write.ingest_lock_prefix"), defaults::text("mesh_write.lock_suffix"))));
    let lock_pid = lock.as_ref().and_then(|l| finite(l.get("pid")));
    let live_lock = lock_pid.is_some_and(alive);
    let healthy = fresh && live_lock && beat_pid.is_some() && beat_pid == lock_pid;
    let mut fault = Value::Null;
    if healthy && let Some(b) = &beat && let Some(consecutive) = finite(b.get("consecutiveMonitorFailures")) {
        let last_ok = finite(b.get("lastMonitorOkMs"));
        let started = finite(b.get("startedAtMs"));
        let min = crate::checks::guardkit::settings::get_number(&inv.settings(), defaults::raw("mesh_write.setting_monitor_no_ok_fail_min"));
        // a setting that is no positive number reads as the shipped default (`monitorNoOkWindowMs`)
        let min = if min.is_finite() && min > 0.0 { min } else { defaults::raw("mesh_write.setting_monitor_no_ok_fail_min").get("default").and_then(|d| d.as_integer()).unwrap_or(0) as f64 };
        let window = min * defaults::num("mesh_write.ms_per_minute") as f64;
        let ok_stale = last_ok.is_some_and(|l| now - l > window);
        let no_ok_since_start = last_ok.is_none() && started.is_some_and(|s| now - s > window);
        if consecutive >= defaults::num("mesh_write.monitor_failure_threshold") as f64 || ok_stale || no_ok_since_start {
            fault = json!({
                "consecutive": consecutive, "code": text_of(b.get("lastMonitorErrorCode")), "error": text_of(b.get("lastMonitorError")),
                "lastOkMs": last_ok, "okStale": ok_stale, "noOkSinceStart": no_ok_since_start, "startedAtMs": started, "heartbeatTs": beat_ts,
            });
        }
    }
    let status = if !fault.is_null() { "failed" } else if healthy { "healthy" } else { "stale" };
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
    let rows = match reader.reader_cursors(id) {
        Ok(rows) => rows,
        // cursors that cannot be read: the own-reader correction cannot be made, the same outcome as a declared reader (the line is left out)
        Err(e) => {
            crate::discard::note("childturn.reader_cursors", &e.to_string());
            return Ok(true);
        }
    };
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
                answer(plan(&inv, &id, &session).map(|planned| match planned {
                    Planned::Go(p) => {
                        PLANNED.with(|slot| *slot.borrow_mut() = vec![*p]);
                        json!({"ok": true})
                    }
                    Planned::Nothing => json!({"ok": true}),
                    Planned::Skip(why) => json!({"unsure": true, "why": why}),
                }))
            })
        })?,
    )?;
    h.set(
        "ctRegister",
        Function::new(c.clone(), |cwd: String, id: String, session: String| -> rquickjs::Result<String> {
            with_settings(|st| {
                let inv = inv_of(st, &cwd);
                let planned = PLANNED.with(|slot| slot.borrow_mut().pop()).filter(|p| p.asked == id);
                let planned = match planned {
                    Some(p) => Ok(Planned::Go(Box::new(p))),
                    None => plan(&inv, &id, &session),
                };
                answer(planned.map(|planned| match planned {
                    Planned::Go(p) => {
                        perform(&inv, *p);
                        json!({"ok": true})
                    }
                    Planned::Nothing => json!({"ok": true}),
                    Planned::Skip(why) => json!({"unsure": true, "why": why}),
                }))
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::meshw::idlock::devswarm_root;

    /// A scratch home and a git checkout, as the hook meets them.
    struct Fx {
        inv: Inv,
        repo: String,
    }

    fn fx(tag: &str) -> Fx {
        let base = std::env::temp_dir().join(format!("ah-ct-{tag}-{}", std::process::id()));
        crate::discard::harmless(std::fs::remove_dir_all(&base)); // keep: a stale directory of an earlier run of this test
        let (home, repo) = (base.join("home"), base.join("repo"));
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&repo).unwrap();
        assert!(std::process::Command::new("git").current_dir(&repo).args(["init", "-q", "-b", "main"]).status().unwrap().success());
        let repo = repo.canonicalize().unwrap().to_string_lossy().into_owned();
        let inv = Inv { home: home.clone(), write_home: home, env: Default::default(), cwd: repo.clone(), now: 1_700_000_000_000, stdin: None, store_override: None };
        Fx { inv, repo }
    }

    const ID: &str = "child-1";
    const CUT: &str = "abcdef01-abcd-abcd-abcd-abc";
    const FULL: &str = "abcdef01-abcd-abcd-abcd-abcdef012345";

    fn descriptor_file(fx: &Fx, id: &str) -> PathBuf {
        devswarm_root(&fx.inv.home).join(defaults::text("mesh_write.dir_workspaces")).join(format!("{id}{}", json_suffix()))
    }

    fn seed_descriptor(fx: &Fx, id: &str, text: &str) {
        let f = descriptor_file(fx, id);
        std::fs::create_dir_all(f.parent().unwrap()).unwrap();
        std::fs::write(f, text).unwrap();
    }

    fn written(fx: &Fx, id: &str) -> OVal {
        OVal::parse(&std::fs::read_to_string(descriptor_file(fx, id)).unwrap()).unwrap()
    }

    fn go(p: Planned) -> Plan {
        match p {
            Planned::Go(p) => *p,
            Planned::Nothing => panic!("planned nothing"),
            Planned::Skip(why) => panic!("skipped: {why}"),
        }
    }

    fn registry(fx: &Fx) -> Vec<ident::Row> {
        let key = ident::repo_key_for_worktree(&fx.repo).unwrap().unwrap();
        let store = MeshStore::open(&crate::meshw::union::store_dir(&fx.inv.home, &key).join(defaults::text("mesh_write.store_file"))).unwrap();
        ident::rows_of(&store.reader().roster().unwrap())
    }

    /// 2026-10-23 (SkyCrew, `child-turn-defer: prepare:registry-collision`): a registry row of the id at another worktree stopped the
    /// registration for good. Node writes the descriptor, and the registry's collision guard leaves the row alone.
    #[test]
    fn a_registry_row_at_another_worktree_does_not_stop_the_registration() {
        let fx = fx("collision");
        let key = ident::repo_key_for_worktree(&fx.repo).unwrap().unwrap();
        let dir = crate::meshw::union::store_dir(&fx.inv.home, &key);
        write_marker(&dir).unwrap();
        let store = MeshStore::open(&dir.join(defaults::text("mesh_write.store_file"))).unwrap();
        let other = RegistryRow { id: ID.into(), worktree_path: Some("/elsewhere".into()), session_id: Some("s0".into()), inbox_path: None, cursor_path: None, nudge_command: None };
        assert!(store.upsert_registry(&other, 1, |_, _| true).unwrap());
        drop(store);
        perform(&fx.inv, go(plan(&fx.inv, ID, "s1").unwrap()));
        assert!(matches!(written(&fx, ID).get("worktreePath"), Some(OVal::Str(w)) if *w == fx.repo), "the descriptor is written");
        let rows = registry(&fx);
        assert_eq!(rows.iter().find(|r| r.id == ID).and_then(|r| r.worktree_path.as_deref()), Some("/elsewhere"), "the row stays where it was");
    }

    #[test]
    fn a_new_project_gets_its_store_and_a_row() {
        let fx = fx("fresh");
        perform(&fx.inv, go(plan(&fx.inv, ID, "s1").unwrap()));
        let rows = registry(&fx);
        let row = rows.iter().find(|r| r.id == ID).expect("a row");
        assert_eq!((row.worktree_path.as_deref(), row.session_id.as_deref()), (Some(fx.repo.as_str()), Some("s1")));
    }

    /// `Object.assign({}, JSON.parse(...))` sets the prototype for a `__proto__` field: the old descriptor's own fields merge, the
    /// prototype's fields read through but are not written.
    #[test]
    fn a_proto_field_of_the_old_descriptor_merges_as_javascript_does() {
        let fx = fx("proto");
        seed_descriptor(&fx, ID, r#"{"keep":1,"__proto__":{"inboxPath":"/x/in.ndjson"}}"#);
        let p = go(plan(&fx.inv, ID, "s1").unwrap());
        assert_eq!(p.row.as_ref().and_then(|r| r.inbox_path.as_deref()), Some("/x/in.ndjson"), "the row reads the inherited path");
        perform(&fx.inv, p);
        let d = written(&fx, ID);
        assert!(d.get("inboxPath").is_none() && d.get("__proto__").is_none(), "only own fields are written: {}", d.stringify());
        assert!(matches!(d.get("keep"), Some(OVal::Num(n)) if *n == 1.0));
    }

    #[test]
    fn an_array_descriptor_merges_by_index() {
        let fx = fx("array");
        seed_descriptor(&fx, ID, r#"["a","b"]"#);
        perform(&fx.inv, go(plan(&fx.inv, ID, "s1").unwrap()));
        let d = written(&fx, ID);
        assert!(matches!(d.get("0"), Some(OVal::Str(a)) if a == "a") && matches!(d.get("1"), Some(OVal::Str(b)) if b == "b"), "{}", d.stringify());
        assert!(matches!(d.get("id"), Some(OVal::Str(i)) if i == ID));
    }

    #[test]
    fn a_non_string_path_is_kept_and_binds_as_node_binds_it() {
        let fx = fx("pathtype");
        seed_descriptor(&fx, ID, r#"{"inboxPath":5,"cursorPath":["c"]}"#);
        let p = go(plan(&fx.inv, ID, "s1").unwrap());
        assert!(p.row.is_none(), "an array cannot be bound to a column: the store leg ends, the descriptor does not");
        perform(&fx.inv, p);
        assert!(matches!(written(&fx, ID).get("inboxPath"), Some(OVal::Num(n)) if *n == 5.0));
        let seeded = self::fx("pathnum");
        seed_descriptor(&seeded, ID, r#"{"inboxPath":5}"#);
        let p = go(plan(&seeded.inv, ID, "s1").unwrap());
        assert_eq!(p.row.as_ref().and_then(|r| r.inbox_path.as_deref()), Some("5"), "a number binds as its text");
    }

    #[test]
    fn an_unreadable_old_descriptor_is_an_empty_one() {
        let fx = fx("junk");
        seed_descriptor(&fx, ID, "{oops");
        perform(&fx.inv, go(plan(&fx.inv, ID, "s1").unwrap()));
        assert!(matches!(written(&fx, ID).get("sessionId"), Some(OVal::Str(s)) if s == "s1"));
        let dir = fx.inv.home.join("d");
        std::fs::create_dir_all(&dir).unwrap();
        assert!(matches!(read_base(&dir), Ok((OVal::Obj(f), None)) if f.is_empty()), "a directory reads as nothing, as readFileSync's catch");
    }

    #[test]
    fn a_descriptor_no_read_may_touch_is_left_for_the_turn_with_its_cause() {
        let fx = fx("fifo");
        let f = descriptor_file(&fx, ID);
        std::fs::create_dir_all(f.parent().unwrap()).unwrap();
        crate::meshw::ident::fifo_kit::fifo(&f);
        let Planned::Skip(why) = crate::meshw::ident::fifo_kit::within("plan over a FIFO", move || plan(&fx.inv, ID, "s1").unwrap()) else { panic!("a FIFO is no descriptor to merge") };
        assert!(why.starts_with(defaults::text("devswarm_prompt.skip_descriptor_unreadable")), "{why}");
        let fx = self::fx("surrogate");
        seed_descriptor(&fx, ID, r#"{"note":"\ud800"}"#);
        let Planned::Skip(why) = plan(&fx.inv, ID, "s1").unwrap() else { panic!("a lone surrogate escape cannot be carried") };
        assert_eq!(why, defaults::text("devswarm_prompt.skip_descriptor_surrogate"));
        seed_descriptor(&fx, ID, r#"{"note":"😀"}"#);
        assert!(matches!(plan(&fx.inv, ID, "s1").unwrap(), Planned::Go(_)), "a surrogate pair is an ordinary character");
    }

    /// `registerChildDescriptor`: a cut-short builder id registers under the session id it is a prefix of, else not at all.
    #[test]
    fn a_cut_short_builder_id_is_recovered_from_the_session_or_skipped() {
        let fx = fx("cut");
        assert_eq!(go(plan(&fx.inv, CUT, FULL).unwrap()).id, FULL);
        assert!(matches!(plan(&fx.inv, CUT, "s1").unwrap(), Planned::Nothing));
        assert!(matches!(plan(&fx.inv, CUT, "ffffffff-abcd-abcd-abcd-abcdef012345").unwrap(), Planned::Nothing));
    }

    #[test]
    fn a_directory_outside_any_checkout_registers_nothing() {
        let mut fx = fx("nogit");
        fx.inv.cwd = fx.inv.home.to_string_lossy().into_owned();
        assert!(matches!(plan(&fx.inv, ID, "s1").unwrap(), Planned::Nothing));
    }

    /// `resolveStoreBackend`: a store with a database and no marker is sqlite and gets its marker; a journal-backed one is not written.
    #[test]
    fn the_store_backend_is_settled_from_the_marker_or_the_disk() {
        let fx = fx("backend");
        let key = ident::repo_key_for_worktree(&fx.repo).unwrap().unwrap();
        let dir = crate::meshw::union::store_dir(&fx.inv.home, &key);
        std::fs::create_dir_all(&dir).unwrap();
        drop(MeshStore::open(&dir.join(defaults::text("mesh_write.store_file"))).unwrap());
        let p = go(plan(&fx.inv, ID, "s1").unwrap());
        assert!(matches!(p.store, Some((_, Store::Open(_)))));
        assert_eq!(std::fs::read_to_string(dir.join(defaults::text("mesh.backend_marker"))).unwrap().trim(), defaults::text("mesh.backend_sqlite"));
        let journal = self::fx("journal");
        let jdir = crate::meshw::union::store_dir(&journal.inv.home, &ident::repo_key_for_worktree(&journal.repo).unwrap().unwrap());
        std::fs::create_dir_all(&jdir).unwrap();
        std::fs::write(jdir.join(defaults::text("mesh.backend_marker")), defaults::text("mesh_write.backend_journal")).unwrap();
        let p = go(plan(&journal.inv, ID, "s1").unwrap());
        assert!(p.store.is_none(), "the engine neither reads nor writes a journal store");
        perform(&journal.inv, p);
        assert!(descriptor_file(&journal, ID).exists(), "the descriptor is written all the same");
    }

    /// A lock that stays busy does not stop the descriptor; it ends the store leg.
    #[test]
    fn a_busy_workspace_lock_writes_the_descriptor_and_leaves_the_row_for_the_next_turn() {
        let fx = fx("lock");
        let held = idlock::acquire(&fx.inv.home, ID).expect("the lock is free");
        let p = go(plan(&fx.inv, ID, "s1").unwrap());
        perform(&fx.inv, p);
        held.release();
        assert!(descriptor_file(&fx, ID).exists());
        let key = ident::repo_key_for_worktree(&fx.repo).unwrap().unwrap();
        let db = crate::meshw::union::store_dir(&fx.inv.home, &key).join(defaults::text("mesh_write.store_file"));
        assert!(!db.exists(), "no store was created while the lock was busy");
    }

    /// `retirePhantomWorktreeDuplicates`: a descriptor of this checkout with a cut-short id is archived, a distinct live one is not.
    #[test]
    fn a_truncated_id_phantom_of_the_checkout_is_archived_and_a_live_sibling_is_kept() {
        let fx = fx("phantom");
        let desc = |id: &str| format!(r#"{{"id":"{id}","worktreePath":"{}","sessionId":null}}"#, fx.repo);
        seed_descriptor(&fx, CUT, &desc(CUT));
        seed_descriptor(&fx, "sibling-live", &desc("sibling-live"));
        perform(&fx.inv, go(plan(&fx.inv, ID, "s1").unwrap()));
        assert!(!descriptor_file(&fx, CUT).exists(), "the phantom is gone from workspaces/");
        let archived = devswarm_root(&fx.inv.home).join(defaults::text("mesh_write.dir_archived")).join(format!("{CUT}{}", json_suffix()));
        assert!(archived.exists(), "and kept in archived/");
        assert!(descriptor_file(&fx, "sibling-live").exists() && descriptor_file(&fx, ID).exists());
    }
}
