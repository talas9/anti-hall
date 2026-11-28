//! GH #845 phase 1 (contract: `MESH-P1-CONTRACT.md` §2-§3): who a broadcast wakes.
//!
//! The audience is resolved ONCE, at send time, against the roster ([`resolve`]) and stored on the row (`wake_audience`): mentions
//! narrow it (even for a question or an urgent send), a question or an urgent broadcast from an allowed role widens an unmentioned
//! broadcast to `all`, anything else wakes no one. A legacy row (no stored audience) is resolved the same way when it is read.
//! Whether the stored audience is obeyed is `mesh_wake.addressed_mode` (off: every broadcast of others wakes, the rule before #845);
//! a Primary reader keeps the old rule unless `mesh_wake.primary_reader` says `addressed`. An explicit ack row wakes no one while
//! `mesh_chat.ack_suppression` is on.
use crate::checks::guardkit::jsre;
use crate::defaults;

/// The stored audience of a broadcast.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Audience {
    /// Every reader.
    All,
    /// No reader.
    Nobody,
    /// These registry ids (sorted, deduped).
    Ids(Vec<String>),
    /// GH #845 phase 2a: a room message: the room, its members when it was sent (who may read it) and the members it wakes.
    Room(Room),
}

/// The stored audience of a room message (`mesh_room.toml`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Room {
    /// The room name.
    pub room: String,
    /// Its members (registry ids, sorted) when the message was sent.
    pub members: Vec<String>,
    /// The members it wakes (sorted).
    pub wake: Vec<String>,
}

/// GH #845 phase 2a: the audience of a message to room `room` whose members are `members`: `base` is what [`resolve`] made of the
/// body; mentions (`Ids`) narrow the wake to the mentioned members, anything else wakes every member; the sender never wakes.
pub fn room_audience(room: &str, members: &[String], base: &Audience, sender: &str) -> Room {
    let mut m: Vec<String> = members.to_vec();
    m.sort();
    m.dedup();
    let mut wake: Vec<String> = match base {
        Audience::Ids(v) => m.iter().filter(|x| v.contains(x)).cloned().collect(),
        _ => m.clone(),
    };
    wake.retain(|x| x != sender);
    Room { room: room.to_string(), members: m, wake }
}

/// GH #845 phase 2a: whether a room message (`stored`) is hidden from `reader`: a reader that was not a member when it was sent,
/// while `mesh_room.hide_nonmembers` is on. Any other row is never hidden.
pub fn hidden(stored: Option<&Audience>, reader: &str) -> bool {
    matches!(stored, Some(Audience::Room(r)) if defaults::num("mesh_room.hide_nonmembers") == 1 && !r.members.iter().any(|x| x == reader))
}

/// The room a stored audience names, if it is a room message.
pub fn room_of(stored: Option<&Audience>) -> Option<&str> {
    match stored {
        Some(Audience::Room(r)) => Some(r.room.as_str()),
        _ => None,
    }
}

/// A `--question` broadcast whose mention prefixes several workspaces: refused at send (the token and the ids it matched).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ambiguous {
    /// The mention token, lower-cased.
    pub token: String,
    /// The registry ids it prefixes.
    pub ids: Vec<String>,
}

/// The broadcast fields the audience rule reads.
#[derive(Debug, Clone, Copy, Default)]
pub struct Bc<'a> {
    /// The sender's mesh id.
    pub sender: Option<&'a str>,
    /// The urgency word.
    pub urgency: Option<&'a str>,
    /// `--question` (needs_reply).
    pub question: bool,
    /// A heartbeat row (never wakes).
    pub heartbeat: bool,
    /// The message body.
    pub body: &'a str,
    /// The sender's stored kind (`sender_kind`), which alone grants a declared identity's rank.
    pub kind: Option<&'a str>,
}

/// True when `id` is a Primary's mesh id.
pub fn is_primary(id: &str) -> bool {
    id.starts_with(defaults::text("mesh_write.primary_prefix"))
}

/// The sender role the rule reads: `mesh_wake.role_primary` for a Primary, `mesh_wake.role_child` for anyone else.
pub fn role_of(sender: Option<&str>) -> &'static str {
    if sender.is_some_and(is_primary) { defaults::text("mesh_wake.role_primary") } else { defaults::text("mesh_wake.role_child") }
}

/// Resolve the audience of broadcast `b` against the registry ids `roster` (contract §2). `Err` only for a question whose mention
/// is ambiguous.
pub fn resolve(b: &Bc<'_>, roster: &[&str]) -> Result<Audience, Ambiguous> {
    if b.heartbeat {
        return Ok(Audience::Nobody);
    }
    let role = role_of(b.sender);
    let all_roles = defaults::list("mesh_wake.mention_all_roles");
    // an owner/admin relay (`[@admin] …`, sent through the Primary) is addressed to every recipient of the room, like @all
    let all_tokens: Vec<&str> = defaults::list("mesh_wake.mention_all").into_iter().chain(defaults::list("mesh_wake.mention_admin")).collect();
    let primary_tokens = defaults::list("mesh_wake.mention_primary");
    let min = defaults::num("mesh_wake.mention_min_prefix") as usize;
    let mut ids: Vec<String> = Vec::new();
    let mut at_all = false;
    if let Some(re) = jsre::config_re("mesh_wake.mention_re", true) {
        for c in re.captures_iter(b.body) {
            let Some(t) = c.get(1).map(|m| m.as_str().to_lowercase()) else { continue };
            if all_tokens.iter().any(|a| a.eq_ignore_ascii_case(&t)) {
                at_all = true;
                continue;
            }
            let hits: Vec<&str> = if primary_tokens.iter().any(|a| a.eq_ignore_ascii_case(&t)) {
                roster.iter().copied().filter(|id| is_primary(id)).collect()
            } else {
                let exact: Vec<&str> = roster.iter().copied().filter(|id| id.eq_ignore_ascii_case(&t)).collect();
                if !exact.is_empty() {
                    exact
                } else if t.chars().count() >= min {
                    let pre: Vec<&str> = roster.iter().copied().filter(|id| id.to_lowercase().starts_with(&t)).collect();
                    if pre.len() > 1 {
                        if b.question {
                            return Err(Ambiguous { token: t, ids: pre.iter().map(|x| x.to_string()).collect() });
                        }
                        // an ambiguous mention on a plain broadcast addresses every workspace it names (never fewer)
                    }
                    pre
                } else {
                    Vec::new()
                }
            };
            ids.extend(hits.into_iter().map(str::to_string));
        }
    }
    // GH #845 (owner 2026-11-28): a sender ranked at or above `mesh_identity.privileged_rank` (admin, ah-engine, the Primary) has the
    // Primary's wake privilege, whatever its role
    let privileged = crate::meshw::senders::privileged_rank(crate::meshw::senders::rank_of(b.sender, b.kind));
    let all_allowed = at_all && (privileged || all_roles.contains(&role));
    if all_allowed {
        return Ok(Audience::All);
    }
    ids.retain(|id| Some(id.as_str()) != b.sender);
    ids.sort();
    ids.dedup();
    if !ids.is_empty() {
        return Ok(Audience::Ids(ids));
    }
    let urgent = b.urgency.is_some_and(|u| defaults::list("mesh_wake.broadcast_wake_urgency").contains(&u))
        && (privileged || defaults::list("mesh_wake.broadcast_wake_roles").contains(&role));
    Ok(if b.question || urgent { Audience::All } else { Audience::Nobody })
}

/// The `wake_audience` column text of `a`.
pub fn encode(a: &Audience) -> String {
    match a {
        Audience::All => defaults::text("mesh_wake.audience_all").to_string(),
        Audience::Nobody => defaults::text("mesh_wake.audience_none").to_string(),
        Audience::Ids(v) => serde_json::to_string(v).unwrap_or_default(),
        Audience::Room(r) => {
            let mut o = serde_json::Map::new();
            o.insert(defaults::text("mesh_room.audience_room").into(), serde_json::Value::String(r.room.clone()));
            o.insert(defaults::text("mesh_room.audience_members").into(), serde_json::json!(r.members));
            o.insert(defaults::text("mesh_room.audience_wake").into(), serde_json::json!(r.wake));
            serde_json::Value::Object(o).to_string()
        }
    }
}

/// The audience a stored `wake_audience` text names; `None` for a legacy NULL or a text no writer makes (read as legacy).
pub fn decode(t: Option<&str>) -> Option<Audience> {
    let t = t?;
    if t == defaults::text("mesh_wake.audience_all") {
        return Some(Audience::All);
    }
    if t == defaults::text("mesh_wake.audience_none") {
        return Some(Audience::Nobody);
    }
    if t.starts_with('{') {
        let v: serde_json::Value = serde_json::from_str(t).ok()?;
        let list = |k: &str| -> Option<Vec<String>> { v.get(defaults::text(k))?.as_array()?.iter().map(|x| x.as_str().map(str::to_string)).collect() };
        let room = v.get(defaults::text("mesh_room.audience_room"))?.as_str()?.to_string();
        return Some(Audience::Room(Room { room, members: list("mesh_room.audience_members")?, wake: list("mesh_room.audience_wake")? }));
    }
    serde_json::from_str::<Vec<String>>(t).ok().map(Audience::Ids)
}

/// The reader-side switches, read once per projection.
pub struct Mode {
    addressed: bool,
    primary_all: bool,
    ack_suppressed: bool,
    ack_kind: &'static str,
}

impl Mode {
    /// The switches as the plugin configures them.
    pub fn load() -> Mode {
        Mode {
            addressed: defaults::text("mesh_wake.addressed_mode") == defaults::text("mesh_wake.mode_on"),
            primary_all: defaults::text("mesh_wake.primary_reader") != defaults::text("mesh_wake.primary_reader_addressed"),
            ack_suppressed: defaults::num("mesh_chat.ack_suppression") == 1,
            ack_kind: defaults::text("mesh_chat.kind_ack"),
        }
    }

    /// Contract §3: whether a broadcast of others (heartbeats and own sends already left out by the caller) with stored audience
    /// `stored` and chat kind `kind` wakes `reader`; `legacy` resolves a row with no stored audience. `force_addressed` asks the
    /// addressed verdict whatever the mode (the drain verbs' `addressed` flag).
    pub fn wakes(&self, stored: Option<&Audience>, kind: Option<&str>, reader: &str, legacy: impl FnOnce() -> Audience, force_addressed: bool) -> bool {
        if self.ack_suppressed && kind == Some(self.ack_kind) {
            return false;
        }
        // GH #845 phase 2a: a room message wakes the members it names and no one else; the legacy switches below cover plain broadcasts
        if let Some(Audience::Room(r)) = stored {
            return r.wake.iter().any(|x| x == reader);
        }
        if !force_addressed && (!self.addressed || (self.primary_all && is_primary(reader))) {
            return true;
        }
        let owned;
        let a = match stored {
            Some(a) => a,
            None => {
                owned = legacy();
                &owned
            }
        };
        match a {
            Audience::All => true,
            Audience::Nobody => false,
            Audience::Ids(v) => v.iter().any(|x| x == reader),
            Audience::Room(r) => r.wake.iter().any(|x| x == reader),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "87604f72-ef93-41b7-8bff-a4888b33af36";
    const A2: &str = "87604f99-0000-41b7-8bff-a4888b33af36";
    const B: &str = "41a0fa40-89d5-43c1-b9b4-e57687a3c098";

    fn pm() -> String {
        format!("{}63f9261d", defaults::text("mesh_write.primary_prefix"))
    }

    fn roster(pm: &str) -> Vec<String> {
        vec![A.into(), A2.into(), B.into(), pm.into()]
    }

    fn aud(sender: &str, urgency: &str, question: bool, body: &str) -> Result<Audience, Ambiguous> {
        let p = pm();
        let r = roster(&p);
        let refs: Vec<&str> = r.iter().map(String::as_str).collect();
        resolve(&Bc { sender: Some(sender), urgency: Some(urgency), question, heartbeat: false, body, kind: None }, &refs)
    }

    #[test]
    fn a_plain_broadcast_has_no_audience() {
        assert_eq!(aud(&pm(), "normal", false, "Primary: HOLD LIFTED. Merge green PRs now."), Ok(Audience::Nobody));
        assert_eq!(aud(B, "normal", false, "[@admin] who can read this? RE @admin"), Ok(Audience::Nobody), "@admin addresses no one");
        assert_eq!(aud(B, "normal", false, "mail ops87604f72@example.com"), Ok(Audience::Nobody), "an e-mail address is no mention");
    }

    #[test]
    fn mentions_narrow_even_a_question_or_an_urgent_send() {
        assert_eq!(aud(B, "normal", false, "RE @87604f72-ef93: overlap"), Ok(Audience::Ids(vec![A.into()])));
        assert_eq!(aud(&pm(), "urgent", true, &format!("@{B} stop and answer")), Ok(Audience::Ids(vec![B.into()])));
        assert_eq!(aud(B, "normal", false, "@876 hi"), Ok(Audience::Nobody), "a prefix under the minimum addresses no one");
    }

    #[test]
    fn an_ambiguous_prefix_refuses_a_question_and_addresses_all_matches_otherwise() {
        let e = aud(B, "normal", true, "@87604f can you check?").unwrap_err();
        assert_eq!(e.ids.len(), 2);
        assert_eq!(aud(B, "normal", false, "@87604f fyi"), Ok(Audience::Ids(vec![A.into(), A2.into()])));
    }

    #[test]
    fn an_unmentioned_question_or_privileged_urgency_or_at_all_reaches_everyone() {
        assert_eq!(aud(B, "normal", true, "anyone holding the sim?"), Ok(Audience::All));
        assert_eq!(aud(&pm(), "high", false, "PRIMARY -> ALL: report presence"), Ok(Audience::All));
        assert_eq!(aud(B, "urgent", false, "I need the sim"), Ok(Audience::Nobody), "a child's urgency wakes no one");
        assert_eq!(aud(&pm(), "normal", false, "@all merge now"), Ok(Audience::All));
        assert_eq!(aud(&pm(), "normal", false, "[@admin] who can read this?"), Ok(Audience::All), "an owner relay through the Primary reaches its room");
        assert_eq!(aud(B, "normal", false, "@all look at my PR"), Ok(Audience::Nobody));
    }

    #[test]
    fn the_sender_is_never_in_its_own_audience_and_primary_resolves() {
        assert_eq!(aud(B, "normal", false, &format!("@{B} note to self, @primary decide")), Ok(Audience::Ids(vec![pm()])));
    }

    #[test]
    fn a_heartbeat_wakes_no_one_even_with_a_mention() {
        let p = pm();
        let r = roster(&p);
        let refs: Vec<&str> = r.iter().map(String::as_str).collect();
        let b = Bc { sender: Some(B), urgency: Some("urgent"), question: false, heartbeat: true, body: &format!("@{A} wip"), kind: None };
        assert_eq!(resolve(&b, &refs), Ok(Audience::Nobody));
    }

    #[test]
    fn the_column_text_round_trips() {
        for a in [Audience::All, Audience::Nobody, Audience::Ids(vec![A.into(), B.into()])] {
            assert_eq!(decode(Some(&encode(&a))), Some(a));
        }
        assert_eq!(decode(None), None);
        assert_eq!(decode(Some("garbage")), None);
    }

    #[test]
    fn the_reader_rule_follows_the_switches() {
        let off = Mode { addressed: false, primary_all: true, ack_suppressed: false, ack_kind: "ack" };
        let on = Mode { addressed: true, primary_all: true, ack_suppressed: true, ack_kind: "ack" };
        let none = Audience::Nobody;
        let to_a = Audience::Ids(vec![A.into()]);
        assert!(off.wakes(Some(&none), None, A, || Audience::Nobody, false), "mode off: every broadcast wakes, as before #845");
        assert!(!on.wakes(Some(&none), None, A, || Audience::All, false));
        assert!(on.wakes(Some(&to_a), None, A, || Audience::Nobody, false));
        assert!(!on.wakes(Some(&to_a), None, B, || Audience::All, false));
        assert!(on.wakes(Some(&none), None, &pm(), || Audience::Nobody, false), "a Primary reader keeps the old rule by default");
        assert!(on.wakes(None, None, A, || Audience::All, false), "a legacy row is resolved on read");
        assert!(!on.wakes(Some(&Audience::All), Some("ack"), A, || Audience::All, false), "an explicit ack wakes no one");
        assert!(!off.wakes(Some(&none), None, A, || Audience::Nobody, true), "the drain's addressed flag ignores the mode");
    }

    fn room(members: &[&str], wake: &[&str]) -> Audience {
        Audience::Room(Room { room: "lab".into(), members: members.iter().map(|x| x.to_string()).collect(), wake: wake.iter().map(|x| x.to_string()).collect() })
    }

    /// GH #845 phase 2a: a room message wakes only the members it names, whatever the legacy switches say: a Primary reader that is
    /// not a member is not woken (the `primary_reader` legacy rule covers plain broadcasts only), nor is any reader with the mode off.
    #[test]
    fn a_room_message_wakes_only_its_members_even_a_primary_reader_or_with_the_mode_off() {
        let off = Mode { addressed: false, primary_all: true, ack_suppressed: false, ack_kind: "ack" };
        let on = Mode { addressed: true, primary_all: true, ack_suppressed: true, ack_kind: "ack" };
        let r = room(&[A, B], &[A]);
        for m in [&off, &on] {
            assert!(m.wakes(Some(&r), None, A, || Audience::All, false));
            assert!(!m.wakes(Some(&r), None, B, || Audience::All, false), "a member the mentions left out is not woken");
            assert!(!m.wakes(Some(&r), None, &pm(), || Audience::All, false), "a Primary that is not a member is not woken");
            assert!(!m.wakes(Some(&r), None, A2, || Audience::All, false), "a non-member is not woken");
        }
    }

    #[test]
    fn mentions_narrow_a_room_wake_to_mentioned_members_and_the_sender_never_wakes() {
        let members: Vec<String> = vec![B.into(), A.into(), pm()];
        let all = room_audience("lab", &members, &Audience::Nobody, B);
        assert_eq!(all.wake, { let mut v = vec![A.to_string(), pm()]; v.sort(); v }, "no mention: every member but the sender");
        let narrowed = room_audience("lab", &members, &Audience::Ids(vec![A.into(), A2.into()]), B);
        assert_eq!(narrowed.wake, vec![A.to_string()], "a mentioned non-member (A2) is not added");
        assert_eq!(room_audience("lab", &members, &Audience::All, B).wake.len(), 2);
        assert_eq!(all.members.len(), 3);
    }

    #[test]
    fn a_room_audience_round_trips_and_hides_from_non_members() {
        let r = room(&[A, B], &[B]);
        assert_eq!(decode(Some(&encode(&r))), Some(r.clone()));
        assert!(!hidden(Some(&r), A));
        assert!(hidden(Some(&r), A2), "a reader that was not a member does not see it");
        assert!(!hidden(Some(&Audience::Nobody), A2), "a plain broadcast is never hidden");
        assert_eq!(room_of(Some(&r)), Some("lab"));
    }
}
