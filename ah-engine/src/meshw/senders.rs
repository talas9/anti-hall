//! GH #845 (owner, 2026-11-28): mesh senders that are not workspaces. The owner writes as `admin` (a human) and anti-hall's own
//! messages go out as `ah-engine` (a proxy acting on the owner's behalf); neither is ever stamped as the Primary. Every sender has a
//! kind and a numeric rank (`mesh_identity.*`): a declared identity's from its config entry, a Primary's and a child's from
//! `rank_primary` / `rank_child`. The rank drives wake privilege (a sender at or above `privileged_rank` may wake every reader, as the
//! Primary may), precedence when instructions conflict (the higher rank wins) and display.
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
    /// Its kind (`human`, `human-proxy`, ...).
    pub kind: &'static str,
    /// Its rank.
    pub rank: i64,
    /// The identity it acts for, if it is a proxy.
    pub on_behalf_of: Option<&'static str>,
}

fn entry(id: &'static str, v: &'static V) -> Declared {
    let display = v.str_field("display");
    let on_behalf_of = v.str_field("on_behalf_of");
    Declared {
        id,
        display: if display.is_empty() { id } else { display },
        kind: v.str_field("kind"),
        rank: v.get("rank").and_then(V::as_integer).unwrap_or_else(|| defaults::num("mesh_identity.rank_child") as i64),
        on_behalf_of: (!on_behalf_of.is_empty()).then_some(on_behalf_of),
    }
}

/// The declared identity named `id` (exact), if any.
pub fn declared(id: &str) -> Option<Declared> {
    defaults::raw("mesh_identity.identities").as_table()?.iter().find(|(k, _)| *k == id).map(|(k, v)| entry(k, v))
}

/// Every declared identity's id, in config order.
pub fn names() -> Vec<&'static str> {
    defaults::raw("mesh_identity.identities").as_table().map(|t| t.iter().map(|(k, _)| *k).collect()).unwrap_or_default()
}

/// The identity a send declares: `--as <id>`, else the `mesh_identity.sender_env` variable; `None` when neither is set.
pub fn requested<'a>(env: &'a crate::meshw::ident::Env, a: &'a Args) -> Option<&'a str> {
    a.one(defaults::text("mesh_identity.flag_as"))
        .or_else(|| env.get(defaults::text("mesh_identity.sender_env")).map(String::as_str))
        .map(str::trim)
        .filter(|v| !v.is_empty())
}

/// The rank of `sender`: a declared identity's, else the Primary's or a child's.
pub fn rank_of(sender: Option<&str>) -> i64 {
    match sender {
        Some(s) => match declared(s) {
            Some(d) => d.rank,
            None if crate::meshw::wakepolicy::is_primary(s) => defaults::num("mesh_identity.rank_primary") as i64,
            None => defaults::num("mesh_identity.rank_child") as i64,
        },
        None => defaults::num("mesh_identity.rank_child") as i64,
    }
}

/// The kind of `sender`: a declared identity's, else `mesh_identity.kind_agent`.
pub fn kind_of(sender: Option<&str>) -> &'static str {
    sender.and_then(declared).map_or(defaults::text("mesh_identity.kind_agent"), |d| d.kind)
}

/// Whether `sender` may wake every reader (an `@all`, a question or an urgent broadcast), as the Primary may.
pub fn privileged(sender: Option<&str>) -> bool {
    rank_of(sender) >= defaults::num("mesh_identity.privileged_rank") as i64
}

/// Add who sent a listed row (`fromKind`, `fromRank`, `fromDisplay`, `onBehalfOf`) when its sender is a declared identity; a
/// workspace's row is left as it was.
pub fn put_from(o: &mut Obj, sender: Option<&str>) {
    let Some(d) = sender.and_then(declared) else { return };
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

    /// The shipped model: admin (human) > ah-engine (proxy for admin) > Primary > child; admin and ah-engine are privileged.
    #[test]
    fn the_shipped_ranks_order_admin_engine_primary_child() {
        defaults::init().unwrap();
        let admin = declared("admin").expect("admin is declared");
        let engine = declared("ah-engine").expect("ah-engine is declared");
        let primary = format!("{}x", defaults::text("mesh_write.primary_prefix"));
        assert_eq!(admin.kind, "human");
        assert_eq!((engine.kind, engine.on_behalf_of), ("human-proxy", Some("admin")));
        assert!(admin.rank > engine.rank && engine.rank > rank_of(Some(&primary)) && rank_of(Some(&primary)) > rank_of(Some("child-1")));
        assert!(privileged(Some("admin")) && privileged(Some("ah-engine")) && privileged(Some(&primary)));
        assert!(!privileged(Some("child-1")));
        assert_eq!(kind_of(Some("child-1")), defaults::text("mesh_identity.kind_agent"));
        assert!(declared("primary").is_none(), "no identity is the Primary");
    }
}
