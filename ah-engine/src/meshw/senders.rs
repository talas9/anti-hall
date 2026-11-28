//! GH #845 (owner, 2026-11-28): mesh senders that are not workspaces. The owner writes as `admin` (a human) and anti-hall's own
//! messages go out as `ah-engine` (a proxy acting on the owner's behalf); neither is ever stamped as the Primary, and nothing
//! impersonates either: `admin` is selectable only by a caller that is not an agent (the owner's room, a plain shell), and
//! `ah-engine` is never selectable from the CLI at all, only by the engine's own call sites. Every row stores its `sender_kind`;
//! a row's kind and rank are read from that stored kind, never from the sender's name. A Primary's and a child's rank come from
//! `rank_primary` / `rank_child`. The rank drives wake privilege (`privileged_rank`), precedence when instructions conflict (the
//! higher rank wins) and display.
use crate::defaults::{self, V};
use crate::meshw::args::Args;
use crate::meshw::common::Obj;

/// A declared (non-workspace) sender, as `mesh_identity.identities` configures it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Declared {
    /// The sender id stored on its messages (the config key).
    pub id: &'static str,
    /// The name shown for it.
    pub display: &'static str,
    /// Its kind (`human`, `human-proxy`, ...), stored on its rows as `sender_kind`.
    pub kind: &'static str,
    /// Its rank.
    pub rank: i64,
    /// The identity it acts for, if it is a proxy.
    pub on_behalf_of: Option<&'static str>,
    /// Whether a CLI caller may declare it (`--as` / the sender variable).
    pub cli: bool,
}

fn field(name: &str) -> &'static str {
    defaults::raw("mesh_identity.identity_fields").str_field(name)
}

fn entry(id: &'static str, v: &'static V) -> Declared {
    let display = v.str_field(field("display"));
    let on_behalf_of = v.str_field(field("on_behalf_of"));
    Declared {
        id,
        display: if display.is_empty() { id } else { display },
        kind: v.str_field(field("kind")),
        rank: v.get(field("rank")).and_then(V::as_integer).unwrap_or_else(|| defaults::num("mesh_identity.rank_child") as i64),
        on_behalf_of: (!on_behalf_of.is_empty()).then_some(on_behalf_of),
        cli: v.get(field("cli")).and_then(V::as_bool).unwrap_or(false),
    }
}

fn all() -> Vec<Declared> {
    defaults::raw("mesh_identity.identities").as_table().map(|t| t.iter().map(|(k, v)| entry(k, v)).collect()).unwrap_or_default()
}

/// The declared identity named `id` (exact), if any.
pub fn declared(id: &str) -> Option<Declared> {
    all().into_iter().find(|d| d.id == id)
}

/// The declared identity whose stored kind is `kind`, if any.
pub fn by_kind(kind: &str) -> Option<Declared> {
    all().into_iter().find(|d| d.kind == kind)
}

/// Whether the caller's environment is an agent's (`mesh_identity.agent_env_markers`, or a DevSwarm builder id other than the
/// identity it asks for): an agent never sends as a declared identity.
fn is_agent(env: &crate::meshw::ident::Env, asked: &str) -> bool {
    defaults::list("mesh_identity.agent_env_markers").iter().any(|k| env.contains_key(*k))
        || env.get(defaults::text("mesh_identity.agent_env_builder")).is_some_and(|b| !b.is_empty() && b != asked)
}

/// The identity a CLI send declares: `--as <id>`, else the `mesh_identity.sender_env` variable. `Ok(None)` when neither is set;
/// `Err(text)` (the refusal) when the caller is an agent, or the id is not declared or not selectable from the CLI.
pub fn cli_declared(env: &crate::meshw::ident::Env, a: &Args) -> Result<Option<Declared>, String> {
    let Some(asked) = a
        .one(defaults::text("mesh_identity.flag_as"))
        .or_else(|| env.get(defaults::text("mesh_identity.sender_env")).map(String::as_str))
        .map(str::trim)
        .filter(|v| !v.is_empty())
    else {
        return Ok(None);
    };
    if is_agent(env, asked) {
        return Err(defaults::render("mesh_identity.msg_agent_refused", &[("name", &asked)]));
    }
    match declared(asked).filter(|d| d.cli) {
        Some(d) => Ok(Some(d)),
        None => {
            let known: Vec<&str> = all().into_iter().filter(|d| d.cli).map(|d| d.id).collect();
            Err(defaults::render("mesh_identity.msg_unknown_sender", &[("name", &asked), ("known", &known.join(", "))]))
        }
    }
}

/// The rank of a sender: its stored kind's declared rank when the row carries one, else the Primary's or a child's (by its id).
/// The sender's name alone never grants a declared rank.
pub fn rank_of(sender: Option<&str>, stored_kind: Option<&str>) -> i64 {
    if let Some(d) = stored_kind.and_then(by_kind) {
        return d.rank;
    }
    if sender.is_some_and(crate::meshw::wakepolicy::is_primary) {
        defaults::num("mesh_identity.rank_primary") as i64
    } else {
        defaults::num("mesh_identity.rank_child") as i64
    }
}

/// Whether a sender of this rank may wake every reader (an `@all`, a question or an urgent broadcast), as the Primary may.
pub fn privileged_rank(rank: i64) -> bool {
    rank >= defaults::num("mesh_identity.privileged_rank") as i64
}

/// The `sender_kind` a send stores: the declared identity's kind, else `mesh_identity.kind_agent`.
pub fn stored_kind(declared: Option<Declared>) -> &'static str {
    declared.map_or(defaults::text("mesh_identity.kind_agent"), |d| d.kind)
}

/// Add who sent a listed row (`fromKind`, `fromRank`, `fromDisplay`, `onBehalfOf`) from the kind the row stores (`senderKind` of
/// the store read); a workspace's row is left as it was.
pub fn put_from(o: &mut Obj, row: &serde_json::Value) {
    let Some(d) = row[defaults::text("mesh_identity.row_kind_field")].as_str().and_then(by_kind) else { return };
    o.put(defaults::text("mesh_identity.key_from_kind"), crate::meshw::common::s(d.kind))
        .put(defaults::text("mesh_identity.key_from_rank"), crate::meshw::common::n(d.rank as f64));
    if d.display != d.id {
        o.put(defaults::text("mesh_identity.key_from_display"), crate::meshw::common::s(d.display));
    }
    if let Some(p) = d.on_behalf_of {
        o.put(defaults::text("mesh_identity.key_on_behalf_of"), crate::meshw::common::s(p));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(words: &[&str]) -> Args {
        crate::meshw::args::parse(&words.iter().map(|w| w.to_string()).collect::<Vec<_>>())
    }

    /// The shipped model: admin (human) > ah-engine (proxy for admin) > Primary > child, ranks read from the stored kind.
    #[test]
    fn the_shipped_ranks_order_admin_engine_primary_child() {
        defaults::init().unwrap();
        let admin = declared("admin").expect("admin is declared");
        let engine = declared("ah-engine").expect("ah-engine is declared");
        let primary = format!("{}x", defaults::text("mesh_write.primary_prefix"));
        assert_eq!(admin.kind, "human");
        assert_eq!((engine.kind, engine.on_behalf_of), ("human-proxy", Some("admin")));
        let (a, e, p, c) =
            (rank_of(Some("admin"), Some(admin.kind)), rank_of(None, Some(engine.kind)), rank_of(Some(&primary), None), rank_of(Some("child-1"), None));
        assert!(a > e && e > p && p > c);
        assert_eq!(rank_of(Some("admin"), None), c, "the name alone grants nothing");
        assert!(privileged_rank(a) && privileged_rank(e) && privileged_rank(p) && !privileged_rank(c));
        assert!(declared("primary").is_none(), "no identity is the Primary");
    }

    /// An agent never declares an identity; a plain caller may declare admin but never ah-engine.
    #[test]
    fn only_a_non_agent_caller_declares_admin_and_nobody_declares_the_engine_from_the_cli() {
        defaults::init().unwrap();
        let flag = format!("--{}", defaults::text("mesh_identity.flag_as"));
        let plain = crate::meshw::ident::Env::default();
        assert_eq!(cli_declared(&plain, &args(&["send", &flag, "admin"])).unwrap().map(|d| d.id), Some("admin"));
        assert!(cli_declared(&plain, &args(&["send", &flag, "ah-engine"])).is_err(), "ah-engine is not selectable from the CLI");
        for marker in defaults::list("mesh_identity.agent_env_markers") {
            let mut env = plain.clone();
            env.insert(marker.to_string(), String::new());
            assert!(cli_declared(&env, &args(&["send", &flag, "admin"])).is_err(), "{marker} marks an agent");
        }
        let mut builder = plain.clone();
        builder.insert(defaults::text("mesh_identity.agent_env_builder").to_string(), "child-1".into());
        assert!(cli_declared(&builder, &args(&["send", &flag, "admin"])).is_err(), "a child builder is an agent");
        let mut via_env = plain.clone();
        via_env.insert(defaults::text("mesh_identity.sender_env").to_string(), "admin".into());
        assert_eq!(cli_declared(&via_env, &args(&["send"])).unwrap().map(|d| d.id), Some("admin"));
    }
}
