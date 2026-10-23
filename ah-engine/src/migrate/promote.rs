//! The `promote-unclaimed` post-update stage: `promoteUnclaimedRegistrySessions` of `devswarm-lib/identity.js`.
//!
//! FORWARD MIGRATION for the persisted `unclaimed:<id>` session shape. Rows an older build stamped with the synthetic marker are
//! promoted ONLY when an independent, positive source names the real session (a heartbeat file whose own `sessionId` is a real
//! one); every other row is LEFT EXACTLY AS IT IS, never guessed and never deleted. A promotion rewrites one field of the
//! descriptor and of the registry row (write-through, so the two cannot diverge); a registry that already holds a real value is
//! copied onto the descriptor instead, and the other way round. Idempotent: a re-run finds no marker left on a promoted row.
//!
//! Anything the engine cannot do exactly as Node does (a store it cannot open, a summary it cannot project, a project key only
//! git can tell) is a deferral, found BEFORE the first write of the row: the stage then runs as Node's function.
use super::Ctx;
use super::poststages::Tally;
use crate::checks::guardkit::ojson::OVal;
use crate::checks::jsport::num::to_js_string;
use crate::defaults;
use crate::dssup::liveness::read_descriptors;
use crate::meshw::common::{self, Inv};
use crate::meshw::ident::{self, Defer, R, defer};
use crate::meshw::idlock::{devswarm_root, is_safe_id};
use crate::meshw::send::hash_from_workspace_id;
use crate::meshw::store::RegistryRow;
use std::path::Path;

/// `String(v)` of a JSON value.
fn js_str(v: &OVal) -> String {
    match v {
        OVal::Str(s) => s.clone(),
        OVal::Num(n) => to_js_string(*n),
        OVal::Bool(b) => b.to_string(),
        OVal::Null => "null".to_string(),
        _ => v.stringify(),
    }
}

fn marker_of(id: &str) -> String {
    format!("{}{id}", defaults::text("mesh_write.unclaimed_prefix"))
}

/// `storeOwnerKeyFor(id, ctx)`: the project key of this process's working directory, else the key of the workspace id.
fn store_owner_key(inv: &Inv, id: &str) -> R<String> {
    if inv.cwd.is_empty() {
        return defer("relative-path");
    }
    Ok(ident::resolve_context(&inv.cwd, true)?.repo_key.unwrap_or_else(|| hash_from_workspace_id(id)))
}

/// `currentRegistrySessionId(home, id, ctx)`: the registry's own session id for `id`, read fresh.
fn current_registry_sid(inv: &Inv, id: &str) -> R<Option<String>> {
    let st = common::open_store(inv, &store_owner_key(inv, id)?)?;
    let roster = st.reader().roster().map_err(|e| Defer(format!("registry:{e}")))?;
    Ok(roster.iter().find(|r| r.get("id").and_then(|v| v.as_str()) == Some(id)).and_then(|r| r.get("sessionId")?.as_str()).map(str::to_string))
}

/// `upsertStoreRegistry(home, desc, ctx, { allowPathChange: true })` then the summary refresh; the store and the summary are
/// checked before the descriptor is written, so a failure here is a deferral.
struct Upsert {
    key: String,
    store: crate::meshw::store::MeshStore,
    row: RegistryRow,
}

fn prepare_upsert(inv: &Inv, id: &str, desc: &OVal) -> R<Upsert> {
    let key = match desc.get("ownerKey") {
        Some(OVal::Str(k)) if !k.is_empty() => k.clone(),
        _ => store_owner_key(inv, id)?,
    };
    let store = common::open_store(inv, &key)?;
    crate::meshw::summary::check(&store, inv, None)?;
    let row = RegistryRow {
        id: id.to_string(),
        worktree_path: crate::meshw::pull::text_or_null(desc, "worktreePath")?,
        session_id: crate::meshw::pull::text_or_null(desc, "sessionId")?,
        inbox_path: crate::meshw::pull::text_or_null(desc, "inboxPath")?,
        cursor_path: crate::meshw::pull::text_or_null(desc, "cursorPath")?,
        nudge_command: match desc.get("nudgeCommand") {
            None | Some(OVal::Null) => None,
            Some(v) => Some(v.stringify()),
        },
    };
    Ok(Upsert { key, store, row })
}

impl Upsert {
    fn apply(&self, inv: &Inv) -> bool {
        if self.store.upsert_registry(&self.row, inv.now, |_, _| true).is_err() {
            return false;
        }
        if let Some(why) = crate::meshw::summary::derive_after_write(&self.store, inv, &self.key) {
            crate::meshw::log_summary_failure(defaults::text("update_post.promote_verb"), &why);
        }
        true
    }
}

fn with_session(desc: &OVal, sid: &str) -> OVal {
    let mut next = desc.clone();
    next.set("sessionId", OVal::Str(sid.to_string()));
    next
}

/// `promoteUnclaimedSession(home, id, sessionId, ctx)` -> promoted?
fn promote_session(inv: &Inv, id: &str, session_id: &str) -> R<bool> {
    if session_id.is_empty() || !is_safe_id(id) {
        return Ok(false);
    }
    let marker = marker_of(id);
    let Some(desc) = ident::read_descriptor(&inv.home, id) else { return Ok(false) };
    let desc_sid = desc.get("sessionId").filter(|v| !matches!(v, OVal::Null)).map(js_str);
    let registry_sid = current_registry_sid(inv, id)?;
    if desc_sid.as_deref() != Some(marker.as_str()) {
        // already promoted (an already-real descriptor is authoritative and never overwritten); repair the registry to match it
        // only when it is still stuck on the marker
        if let Some(ds) = desc_sid.as_deref().filter(|s| !s.is_empty())
            && registry_sid.as_deref() == Some(marker.as_str())
        {
            let up = prepare_upsert(inv, id, &with_session(&desc, ds))?;
            up.apply(inv);
        }
        return Ok(false);
    }
    if let Some(rs) = registry_sid.as_deref().filter(|r| !r.is_empty() && *r != marker) {
        // the registry already holds a real value while the descriptor still carries the marker: copy that value down
        crate::discard::harmless(crate::meshw::pull::write_descriptor(inv, id, &with_session(&desc, rs))); // keep: Node retries next call (`catch (_) {}`)
        return Ok(false);
    }
    let next = with_session(&desc, session_id);
    let up = prepare_upsert(inv, id, &next)?;
    crate::meshw::clog::ready(inv)?;
    if crate::meshw::pull::write_descriptor(inv, id, &next).is_err() {
        return Ok(false);
    }
    up.apply(inv);
    let msg = defaults::render("update_post.promote_event_msg", &[("id", &id), ("marker", &marker)]);
    crate::meshw::clog::event(
        inv,
        defaults::text("update_post.promote_event_op"),
        &msg,
        vec![("id", OVal::Str(id.to_string())), ("to", OVal::Str(session_id.to_string()))],
    );
    Ok(true)
}

/// The real session id a heartbeat file records for `id`, if any: not empty, not the id itself, not another marker.
fn beat_session(home: &Path, id: &str) -> Option<String> {
    let p = devswarm_root(home).join(defaults::text("mesh_write.dir_heartbeats")).join(format!("{id}{}", defaults::text("mesh_write.json_suffix")));
    let beat = OVal::parse(&String::from_utf8_lossy(&std::fs::read(p).ok()?))?;
    let raw = match beat.get("sessionId") {
        None | Some(OVal::Null) => String::new(),
        Some(v) => crate::checks::guardkit::text::js_trim(&js_str(v)).to_string(),
    };
    (!raw.is_empty() && raw != id && !raw.starts_with(defaults::text("mesh_write.unclaimed_prefix"))).then_some(raw)
}

/// `promoteUnclaimedRegistrySessions(home, { cwd, env })`; `None` when Node must run the stage.
pub(crate) fn promote_unclaimed(ctx: &Ctx) -> Option<Tally> {
    let home = Path::new(&ctx.home);
    let inv = Inv {
        home: home.to_path_buf(),
        env: ctx.env.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
        cwd: ctx.cwd.clone(),
        now: common::now_ms(),
        stdin: None,
        write_home: home.to_path_buf(),
        store_override: None,
    };
    let mut t = Tally::default();
    for d in read_descriptors(home) {
        let sid = d.raw.get("sessionId").map(js_str).unwrap_or_default();
        if sid != marker_of(&d.id) {
            continue; // not unclaimed (or already promoted)
        }
        let Some(real) = beat_session(home, &d.id) else {
            *t.n.entry("left").or_insert(0.0) += 1.0;
            continue;
        };
        match promote_session(&inv, &d.id, &real) {
            Ok(true) => *t.n.entry("promoted").or_insert(0.0) += 1.0,
            Ok(false) => *t.n.entry("left").or_insert(0.0) += 1.0,
            Err(_) => return None,
        }
    }
    t.ok = Some(true);
    Some(t)
}
