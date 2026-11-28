//! GH #845 phase 2a: named mesh rooms (`mesh room create|join|leave|list`; settings in `mesh_room.toml`).
//!
//! A room lives in the project's mesh store (`mesh_rooms`, `mesh_room_members`; engine only). Its members are registry ids, the
//! keys every broadcast reader (the summary, the drain verbs, the Codex `inbox tick`) reads under. `mesh send --room <name>` stores
//! ONE broadcast row whose audience names the room, its members and the members it wakes ([`crate::meshw::wakepolicy::Room`]), so
//! the wake rule is decided once, at send time, and every reader on both ports obeys it.
use crate::checks::guardkit::ojson::OVal;
use crate::defaults;
use crate::mesh::MeshReader;
use crate::meshw::args::Args;
use crate::meshw::common::{self, Inv, Obj, s};
use crate::meshw::ident::{self, R};
use crate::meshw::readprimary::store_err;
use crate::meshw::send::{Answer, Effect, resolve_mesh_target};
use crate::meshw::store::{MeshStore, retry_busy};
use crate::sql;
use rusqlite::params;

/// The members of room `name` (sorted registry ids); `None` when there is no such room (or the store predates rooms).
pub fn members_of(r: &MeshReader, name: &str) -> Option<Vec<String>> {
    let c = r.conn();
    let exists = c.prepare_cached(sql::MESH_ROOM_EXISTS).ok()?.exists(params![name]).ok()?;
    if !exists {
        return None;
    }
    let mut st = c.prepare_cached(sql::MESH_ROOM_MEMBERS).ok()?;
    let rows = st.query_map(params![name], |row| row.get::<_, String>(0)).ok()?;
    Some(rows.filter_map(Result::ok).collect())
}

/// Every room name, sorted (none on a store that predates rooms).
pub fn names(r: &MeshReader) -> Vec<String> {
    let Ok(mut st) = r.conn().prepare_cached(sql::MESH_ROOMS) else { return Vec::new() };
    st.query_map([], |row| row.get::<_, String>(0)).map(|rows| rows.filter_map(Result::ok).collect()).unwrap_or_default()
}

/// Whether `name` is a valid room name (`mesh_room.name_re`, matched against the whole name).
pub fn valid_name(name: &str) -> bool {
    crate::checks::guardkit::jsre::config_re("mesh_room.name_re", false).is_some_and(|re| re.is_match(name))
}

/// Create room `name` (`true`: it was created).
pub fn create(st: &MeshStore, name: &str, by: Option<&str>, now: i64) -> rusqlite::Result<bool> {
    retry_busy(|| st.reader().conn().prepare_cached(sql::MESHW_ROOM_CREATE)?.execute(params![name, by, now])).map(|n| n > 0)
}

/// Subscribe `member` to room `name` (`true`: it was not a member).
pub fn join(st: &MeshStore, name: &str, member: &str, now: i64) -> rusqlite::Result<bool> {
    retry_busy(|| st.reader().conn().prepare_cached(sql::MESHW_ROOM_JOIN)?.execute(params![name, member, now])).map(|n| n > 0)
}

/// Unsubscribe `member` from room `name` (`true`: it was a member).
pub fn leave(st: &MeshStore, name: &str, member: &str) -> rusqlite::Result<bool> {
    retry_busy(|| st.reader().conn().prepare_cached(sql::MESHW_ROOM_LEAVE)?.execute(params![name, member])).map(|n| n > 0)
}

fn answer(code: i32, o: Obj) -> Answer {
    Answer { code, stdout: format!("{}\n", o.done().stringify()), effect: Effect::None }
}

fn refuse(op: &str, msg: &str, reason: Option<&str>) -> Answer {
    crate::metrics::bump_shared("mesh_room_ops", &[("op", op), ("outcome", defaults::text("mesh_room.outcome_refused"))]);
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(false)).put("action", s(defaults::text("mesh_room.action")));
    if let Some(r) = reason {
        o.put("reason", s(r));
    }
    o.put("error", s(msg));
    answer(2, o)
}

fn room_obj(name: &str, members: &[String], me: Option<&str>) -> OVal {
    let mut o = Obj::default();
    o.put(defaults::text("mesh_room.key_room"), s(name))
        .put(defaults::text("mesh_room.key_members"), OVal::Arr(members.iter().map(|m| s(m)).collect()))
        .put(defaults::text("mesh_room.key_member"), OVal::Bool(me.is_some_and(|m| members.iter().any(|x| x == m))));
    o.done()
}

/// `mesh room <create|join|leave|list> [<name>]`.
pub fn run(inv: &Inv, a: &Args) -> R<Answer> {
    let op = a.positionals.get(1).map_or("", String::as_str);
    let name = a.positionals.get(2).map(String::as_str);
    if defaults::num("mesh_room.enabled") != 1 {
        return Ok(refuse(op, defaults::text("mesh_room.msg_disabled"), None));
    }
    let subs = ["mesh_room.sub_create", "mesh_room.sub_join", "mesh_room.sub_leave", "mesh_room.sub_list"].map(defaults::text);
    let list = op == subs[3];
    if !subs.contains(&op) || (!list && name.is_none()) {
        return Ok(refuse(op, defaults::text("mesh_room.msg_usage"), None));
    }
    if let Some(n) = name.filter(|_| !list)
        && !valid_name(n)
    {
        let msg = defaults::render("mesh_room.msg_bad_name", &[("name", &OVal::Str(n.to_string()).stringify())]);
        return Ok(refuse(op, &msg, Some(defaults::text("mesh_room.reason_bad_name"))));
    }
    let cwd = ident::project_cwd_for(&inv.home, &inv.env, &inv.cwd)?;
    let Some(repo_key) = ident::repo_key_for_worktree(&cwd)? else {
        return Ok(refuse(op, defaults::text("devswarm_cli.msg_send_no_project"), Some(defaults::text("devswarm_cli.reason_no_project"))));
    };
    let st = common::open_store(inv, &repo_key)?;
    let rows = ident::rows_of(&st.reader().roster().map_err(|e| store_err("registry", e))?);
    // the caller's registry id: the key its broadcast reads run under (none for a caller the registry does not hold)
    let from = ident::caller_identity_for(&inv.env, &cwd, &inv.home).ok().map(|c| c.identity);
    // (the same key `mesh read` acks under: the registry row the identity resolves to, else the identity when the registry holds it)
    let me: Option<String> = match &from {
        Some(f) if rows.iter().any(|r| &r.id == f) => Some(f.clone()),
        Some(f) => resolve_mesh_target(inv, Some(st.reader()), &rows, Some(f)).ok().flatten().map(|r| r.id),
        None => None,
    };
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(true)).put("action", s(defaults::text("mesh_room.action"))).put("op", s(op));
    if list {
        let rooms: Vec<OVal> = names(st.reader()).iter().map(|n| room_obj(n, &members_of(st.reader(), n).unwrap_or_default(), me.as_deref())).collect();
        o.put(defaults::text("mesh_room.key_rooms"), OVal::Arr(rooms));
        return Ok(answer(0, o));
    }
    let name = name.unwrap_or_default();
    let werr = |e: rusqlite::Error| store_err("room", e);
    let changed = if op == subs[0] {
        let created = create(&st, name, from.as_deref(), inv.now).map_err(werr)?;
        crate::meshw::mark_committed();
        let joined = match (&me, defaults::num("mesh_room.creator_joins") == 1) {
            (Some(m), true) => join(&st, name, m, inv.now).map_err(werr)?,
            _ => false,
        };
        created || joined
    } else {
        if members_of(st.reader(), name).is_none() {
            let msg = defaults::render("mesh_room.msg_no_room", &[("name", &name)]);
            return Ok(refuse(op, &msg, Some(defaults::text("mesh_room.reason_no_room"))));
        }
        let Some(m) = me.as_deref() else { return Ok(refuse(op, defaults::text("mesh_room.msg_no_member"), None)) };
        let r = if op == subs[1] { join(&st, name, m, inv.now) } else { leave(&st, name, m) }.map_err(werr)?;
        crate::meshw::mark_committed();
        r
    };
    let outcome = if changed { "mesh_room.outcome_changed" } else { "mesh_room.outcome_unchanged" };
    crate::metrics::bump_shared("mesh_room_ops", &[("op", op), ("outcome", defaults::text(outcome))]);
    crate::health::log_event("mesh_room", op, &format!("{name} {} {}", me.as_deref().unwrap_or("-"), defaults::text(outcome)));
    o.put(defaults::text("mesh_room.key_changed"), OVal::Bool(changed));
    let members = members_of(st.reader(), name).unwrap_or_default();
    if let OVal::Obj(fields) = room_obj(name, &members, me.as_deref()) {
        for (k, v) in fields {
            o.put(&k, v);
        }
    }
    Ok(answer(0, o))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> MeshStore {
        crate::defaults::init().unwrap();
        let d = crate::testtmp::child("test-rooms", format!("{tag}-{}", std::process::id()));
        crate::discard::harmless(std::fs::remove_dir_all(&d)); // keep: a leftover from an earlier run
        std::fs::create_dir_all(&d).unwrap();
        MeshStore::open(&d.join("devswarm.db")).unwrap()
    }

    #[test]
    fn create_join_leave_are_idempotent_and_members_are_sorted() {
        let st = scratch("ops");
        assert_eq!(members_of(st.reader(), "lab"), None);
        assert!(create(&st, "lab", Some("w-a"), 1).unwrap());
        assert!(!create(&st, "lab", Some("w-b"), 2).unwrap(), "an existing room is kept");
        assert!(join(&st, "lab", "w-b", 3).unwrap());
        assert!(join(&st, "lab", "w-a", 3).unwrap());
        assert!(!join(&st, "lab", "w-a", 4).unwrap());
        assert_eq!(members_of(st.reader(), "lab"), Some(vec!["w-a".to_string(), "w-b".to_string()]));
        assert!(leave(&st, "lab", "w-a").unwrap());
        assert!(!leave(&st, "lab", "w-a").unwrap());
        assert_eq!(members_of(st.reader(), "lab"), Some(vec!["w-b".to_string()]), "the room stays when a member leaves");
        assert_eq!(names(st.reader()), vec!["lab".to_string()]);
    }

    #[test]
    fn room_names_follow_the_pattern() {
        crate::defaults::init().unwrap();
        assert!(valid_name("lab") && valid_name("ui-team.2"));
        assert!(!valid_name("Lab") && !valid_name("-x") && !valid_name("a b") && !valid_name(""));
    }
}
