//! GH #845 phase 1: which unread broadcast wakes which reader. A broadcast wakes a reader only when it addresses it: an `@mention`
//! of the reader (its id or an id prefix), an `@all` from a sender whose role may wake everyone, a question (`needs_reply`), or an
//! urgency in `mesh_wake.broadcast_wake_urgency` from a sender role in `mesh_wake.broadcast_wake_roles` (phase 1 has no admin role,
//! so the owner's word reaches the workspaces through the Primary). An ack-only broadcast never wakes. Every other broadcast stays
//! readable but wakes no one. A Primary reader keeps the old rule (every broadcast of others) unless `mesh_wake.primary_reader` says
//! `addressed`.
//!
//! The summary projection ([`crate::meshw::summary`]) parses each unread broadcast once per call ([`Policy::parse`]) and asks
//! [`Policy::wakes`] per reader; the replay test calls the same two functions, so it measures the shipped rule.
use crate::checks::guardkit::jsre;
use crate::defaults;
use regex::Regex;

/// The fields of one broadcast row the rule reads.
#[derive(Debug, Clone, Copy, Default)]
pub struct Bc<'a> {
    pub sender: Option<&'a str>,
    pub urgency: Option<&'a str>,
    pub needs_reply: bool,
    pub chat_kind: Option<&'a str>,
    pub body: &'a str,
}

/// One broadcast, parsed once: what it addresses.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Parsed {
    /// It never wakes anyone (an ack-only reply).
    pub silent: bool,
    /// It wakes every reader (a question, or an urgent broadcast from a role that may wake everyone, or an allowed `@all`).
    pub all: bool,
    /// It mentions the Primary (`@primary`).
    pub primary: bool,
    /// The other mention tokens, lower-cased.
    pub tokens: Vec<String>,
}

/// The rule, loaded from the plugin's `mesh_wake` table once per projection.
pub struct Policy {
    re: Option<Regex>,
    urgency: Vec<&'static str>,
    roles: Vec<&'static str>,
    all_tokens: Vec<&'static str>,
    all_roles: Vec<&'static str>,
    primary_tokens: Vec<&'static str>,
    min_prefix: usize,
    primary_reader_all: bool,
    ack_kind: &'static str,
}

/// True when `id` is a Primary's mesh id.
fn is_primary(id: &str) -> bool {
    id.starts_with(defaults::text("mesh_write.primary_prefix"))
}

/// The role of a sender for the rule: `mesh_wake.role_primary` for a Primary, `mesh_wake.role_child` for anyone else.
pub fn role_of(sender: Option<&str>) -> &'static str {
    if sender.is_some_and(is_primary) { defaults::text("mesh_wake.role_primary") } else { defaults::text("mesh_wake.role_child") }
}

impl Policy {
    /// The rule as the plugin configures it. A mention pattern that does not compile matches nothing (counted and noted).
    pub fn load() -> Policy {
        Policy {
            re: jsre::config_re("mesh_wake.mention_re", true),
            urgency: defaults::list("mesh_wake.broadcast_wake_urgency"),
            roles: defaults::list("mesh_wake.broadcast_wake_roles"),
            all_tokens: defaults::list("mesh_wake.mention_all"),
            all_roles: defaults::list("mesh_wake.mention_all_roles"),
            primary_tokens: defaults::list("mesh_wake.mention_primary"),
            min_prefix: defaults::num("mesh_wake.mention_min_prefix") as usize,
            primary_reader_all: defaults::text("mesh_wake.primary_reader") != defaults::text("mesh_wake.primary_reader_addressed"),
            ack_kind: defaults::text("mesh_chat.kind_ack"),
        }
    }

    /// What broadcast `b` addresses.
    pub fn parse(&self, b: &Bc<'_>) -> Parsed {
        if b.chat_kind == Some(self.ack_kind) {
            return Parsed { silent: true, ..Parsed::default() };
        }
        let role = role_of(b.sender);
        let mut p = Parsed {
            all: b.needs_reply || (b.urgency.is_some_and(|u| self.urgency.contains(&u)) && self.roles.contains(&role)),
            ..Parsed::default()
        };
        let Some(re) = &self.re else { return p };
        for c in re.captures_iter(b.body) {
            let Some(t) = c.get(1).map(|m| m.as_str().to_lowercase()) else { continue };
            if self.all_tokens.iter().any(|a| a.eq_ignore_ascii_case(&t)) {
                if self.all_roles.contains(&role) {
                    p.all = true;
                }
            } else if self.primary_tokens.iter().any(|a| a.eq_ignore_ascii_case(&t)) {
                p.primary = true;
            } else if !p.tokens.contains(&t) {
                p.tokens.push(t);
            }
        }
        p
    }

    /// Whether a parsed broadcast wakes `reader` (a registry id). The caller has already left out the reader's own broadcasts.
    pub fn wakes(&self, p: &Parsed, reader: &str) -> bool {
        if p.silent {
            return false;
        }
        let primary = is_primary(reader);
        if (primary && (self.primary_reader_all || p.primary)) || p.all {
            return true;
        }
        let r = reader.to_lowercase();
        p.tokens.iter().any(|t| *t == r || (t.len() >= self.min_prefix && r.starts_with(t.as_str())))
    }
}

/// Whether a message is ack-only (GH #845, `mesh_chat`): not a question, not an answer (`--answers`), and a trimmed body no longer
/// than `mesh_chat.ack_max_chars` that `mesh_chat.ack_re` matches. A pattern that does not compile classifies nothing as an ack.
pub fn is_ack(body: &str, question: bool, answers: bool) -> bool {
    if question || answers {
        return false;
    }
    let t = body.trim();
    if t.is_empty() || t.chars().count() > defaults::num("mesh_chat.ack_max_chars") as usize {
        return false;
    }
    jsre::config_re("mesh_chat.ack_re", true).is_some_and(|re| re.is_match(t))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_acknowledgements_are_acks_and_real_replies_are_not() {
        for ack in ["here", "here (Primary) 👋", "ok", "OK thanks", "present", "👍", "noted.", "got it", "thanks!"] {
            assert!(is_ack(ack, false, false), "{ack:?} is an ack");
        }
        for real in [
            "done: merged #979 at 7fbd672d",
            "ok, but the build fails on the eSIM goldens",
            "here? can you check my PR",
            "hereby I claim lib/widgets",
            "SUITE DONE #978",
            "okay so the root cause is the cursor offset in sql.rs",
            "",
        ] {
            assert!(!is_ack(real, false, false), "{real:?} is not an ack");
        }
        assert!(!is_ack("ok", true, false), "a question is never an ack");
        assert!(!is_ack("here", false, true), "an answer is never an ack");
    }

    const CHILD_A: &str = "87604f72-ef93-41b7-8bff-a4888b33af36";
    const CHILD_B: &str = "41a0fa40-89d5-43c1-b9b4-e57687a3c098";

    fn primary() -> String {
        format!("{}63f9261d", defaults::text("mesh_write.primary_prefix"))
    }

    fn bc<'a>(sender: &'a str, urgency: &'a str, body: &'a str) -> Bc<'a> {
        Bc { sender: Some(sender), urgency: Some(urgency), body, ..Bc::default() }
    }

    fn wakes(b: &Bc<'_>, reader: &str) -> bool {
        let p = Policy::load();
        p.wakes(&p.parse(b), reader)
    }

    #[test]
    fn a_plain_broadcast_wakes_no_child() {
        let pm = primary();
        assert!(!wakes(&bc(&pm, "normal", "Primary: HOLD LIFTED. Merge green PRs now."), CHILD_A));
        assert!(!wakes(&bc(CHILD_B, "normal", "sim free: done with :8765"), CHILD_A));
    }

    #[test]
    fn a_mention_wakes_only_the_mentioned_child_by_id_or_prefix() {
        let b = bc(CHILD_B, "normal", "RE @87604f72: your PR overlaps mine");
        assert!(wakes(&b, CHILD_A));
        assert!(!wakes(&b, "6063161e-55e4-4b8c-adbc-905e60228f9e"));
        let full = format!("@{CHILD_A} please rebase");
        assert!(wakes(&bc(CHILD_B, "normal", &full), CHILD_A));
        // a prefix shorter than mesh_wake.mention_min_prefix addresses no one
        assert!(!wakes(&bc(CHILD_B, "normal", "@876 hi"), CHILD_A));
        // an e-mail address is not a mention
        assert!(!wakes(&bc(CHILD_B, "normal", "mail ops87604f72@example.com"), CHILD_A));
    }

    #[test]
    fn the_admin_body_convention_wakes_no_child() {
        let pm = primary();
        assert!(!wakes(&bc(&pm, "normal", "[@admin] who can read this?"), CHILD_A));
        assert!(!wakes(&bc(CHILD_B, "normal", "RE @admin 'who can read this?': I can"), CHILD_A));
    }

    #[test]
    fn needs_reply_wakes_every_child() {
        let pm = primary();
        let b = Bc { needs_reply: true, ..bc(&pm, "normal", "can you see this?") };
        assert!(wakes(&b, CHILD_A));
        let from_child = Bc { needs_reply: true, ..bc(CHILD_B, "normal", "anyone holding the sim?") };
        assert!(wakes(&from_child, CHILD_A));
    }

    #[test]
    fn urgency_wakes_all_only_from_an_allowed_role() {
        let pm = primary();
        assert!(wakes(&bc(&pm, "high", "PRIMARY -> ALL: report presence"), CHILD_A));
        assert!(wakes(&bc(&pm, "urgent", "stop merging"), CHILD_A));
        assert!(!wakes(&bc(CHILD_B, "urgent", "I need the sim"), CHILD_A), "a child's urgency wakes no one");
        assert!(!wakes(&bc(&pm, "low", "fyi"), CHILD_A));
    }

    #[test]
    fn at_all_wakes_everyone_only_from_an_allowed_role() {
        let pm = primary();
        assert!(wakes(&bc(&pm, "normal", "@all merge now"), CHILD_A));
        assert!(!wakes(&bc(CHILD_B, "normal", "@all look at my PR"), CHILD_A));
    }

    #[test]
    fn an_ack_never_wakes() {
        let pm = primary();
        let ack = Bc { chat_kind: Some(defaults::text("mesh_chat.kind_ack")), needs_reply: false, ..bc(&pm, "high", "@all ok") };
        assert!(!wakes(&ack, CHILD_A));
        assert!(!wakes(&ack, &pm));
    }

    /// GH #845 replay (run by hand, never in CI): the last 24 h of a COPY of a store (read-only open of `AH_MESH_REPLAY_DB`), wake
    /// lines per reader before (every broadcast of others, every direct of others) and after (this rule; acks out), with the
    /// watcher's 2 s poll folding what lands in one tick into one line. A reader counts only inside its active window (its first to
    /// last own row in the 24 h, heartbeats included), so an archived workspace stops accruing.
    #[test]
    #[ignore = "reads a store copy named by AH_MESH_REPLAY_DB"]
    fn replay_wakes_per_reader_before_and_after() {
        let Ok(db) = std::env::var("AH_MESH_REPLAY_DB") else { return };
        let c = rusqlite::Connection::open_with_flags(&db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let end: i64 = c.query_row("SELECT MAX(ts) FROM messages", [], |r| r.get(0)).unwrap();
        let start = end - 86_400_000;
        type Row = (i64, String, Option<String>, Option<String>, Option<String>, bool, bool, String);
        let mut q = c
            .prepare(
                "SELECT ts, workspace_id, sender, mtype, urgency, COALESCE(is_heartbeat,0)=1, COALESCE(needs_reply,0)=1, COALESCE(body,'') \
                 FROM messages WHERE ts > ?1 ORDER BY id",
            )
            .unwrap();
        let rows: Vec<Row> = q
            .query_map([start], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        let mut win: std::collections::BTreeMap<String, (i64, i64)> = Default::default();
        for (ts, _, sender, ..) in &rows {
            if let Some(s) = sender {
                let w = win.entry(s.clone()).or_insert((*ts, *ts));
                w.0 = w.0.min(*ts);
                w.1 = w.1.max(*ts);
            }
        }
        let p = Policy::load();
        let bpart = defaults::text("mesh_write.broadcast_partition");
        let direct = defaults::text("mesh_write.mtype_direct");
        // reader -> (before bc, after bc, before direct, after direct) as sets of 2 s ticks
        type Ticks = std::collections::BTreeSet<i64>;
        let mut out: std::collections::BTreeMap<String, [Ticks; 4]> = Default::default();
        let (mut n_bc, mut n_all, mut n_direct, mut n_ack) = (0, 0, 0, 0);
        for (ts, ws, sender, mtype, urgency, hb, nr, body) in &rows {
            let tick = ts / 2000;
            if ws == bpart && !hb {
                n_bc += 1;
                let parsed = p.parse(&Bc { sender: sender.as_deref(), urgency: urgency.as_deref(), needs_reply: *nr, chat_kind: None, body });
                n_all += usize::from(parsed.all);
                for (reader, (a, b)) in &win {
                    if sender.as_deref() == Some(reader.as_str()) || ts < a || ts > b {
                        continue;
                    }
                    let e = out.entry(reader.clone()).or_default();
                    e[0].insert(tick);
                    if p.wakes(&parsed, reader) {
                        e[1].insert(tick);
                    }
                }
            } else if mtype.as_deref() == Some(direct) && sender.as_deref() != Some(ws.as_str()) && win.contains_key(ws) {
                n_direct += 1;
                let ack = is_ack(body, *nr, false);
                n_ack += usize::from(ack);
                let e = out.entry(ws.clone()).or_default();
                e[2].insert(tick);
                if !ack {
                    e[3].insert(tick);
                }
            }
        }
        let prefix = defaults::text("mesh_write.primary_prefix");
        println!("replay {db}: 24 h ending {end}; {n_bc} non-heartbeat broadcasts ({n_all} wake-all), {n_direct} directs ({n_ack} acks)");
        println!("{:<40} {:>9} {:>9} {:>10} {:>10}", "reader", "bc_before", "bc_after", "dir_before", "dir_after");
        let mut tot = [0usize; 4];
        let mut tot_child = [0usize; 4];
        for (r, e) in &out {
            let v = [e[0].len(), e[1].len(), e[2].len(), e[3].len()];
            for i in 0..4 {
                tot[i] += v[i];
                if !r.starts_with(prefix) {
                    tot_child[i] += v[i];
                }
            }
            println!("{:<40} {:>9} {:>9} {:>10} {:>10}", r, v[0], v[1], v[2], v[3]);
        }
        println!("{:<40} {:>9} {:>9} {:>10} {:>10}", "TOTAL children", tot_child[0], tot_child[1], tot_child[2], tot_child[3]);
        println!("{:<40} {:>9} {:>9} {:>10} {:>10}", "TOTAL all readers", tot[0], tot[1], tot[2], tot[3]);
    }

    #[test]
    fn the_primary_reader_follows_its_configured_mode() {
        let pm = primary();
        let plain = bc(CHILD_B, "normal", "PRESENT L1 Friends | doing: port");
        let addressed = defaults::text("mesh_wake.primary_reader") == defaults::text("mesh_wake.primary_reader_addressed");
        assert_eq!(wakes(&plain, &pm), !addressed);
        assert!(wakes(&bc(CHILD_B, "normal", "@primary need a decision"), &pm), "an @primary mention always wakes the Primary");
    }
}
