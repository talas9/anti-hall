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
    let all_allowed = at_all && all_roles.contains(&role);
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
        && defaults::list("mesh_wake.broadcast_wake_roles").contains(&role);
    Ok(if b.question || urgent { Audience::All } else { Audience::Nobody })
}

/// The `wake_audience` column text of `a`.
pub fn encode(a: &Audience) -> String {
    match a {
        Audience::All => defaults::text("mesh_wake.audience_all").to_string(),
        Audience::Nobody => defaults::text("mesh_wake.audience_none").to_string(),
        Audience::Ids(v) => serde_json::to_string(v).unwrap_or_default(),
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
        resolve(&Bc { sender: Some(sender), urgency: Some(urgency), question, heartbeat: false, body }, &refs)
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
        let b = Bc { sender: Some(B), urgency: Some("urgent"), question: false, heartbeat: true, body: &format!("@{A} wip") };
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
}
