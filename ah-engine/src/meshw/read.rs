//! `devswarm.js mesh read` (consuming and `--peek`), `mesh history` and `roster --ack`, ported from
//! `scripts/devswarm-lib/roster-diag.js` `cmdMeshRead`.
//!
//! A consuming read advances the caller's broadcast cursor to the head of the broadcast partition (`advanceBroadcastCursor`,
//! one statement); a peek writes nothing. Every refusal Node prints (no project, a bad `--seq`, `--last` or `--since`, a filter
//! on a consuming read) is answered here, exit 2.
//! A consuming read refreshes the summary after the cursor moves, as Node does (`meshw::summary`).
use crate::checks::guardkit::ojson::OVal;
use crate::defaults;
use crate::meshw::args::{Args, FlagVal};
use crate::meshw::common::{self, Inv, Obj, n, s, s_or_null};
use crate::meshw::ident::{self, Defer, R};
use crate::meshw::readprimary::store_err;
use crate::meshw::send::{Answer, Effect, resolve_mesh_target};

/// `Number(x)` for a flag value.
fn js_number(x: &str) -> f64 {
    crate::checks::guardkit::text::js_number_of_str(x)
}

/// `{ok:false, ...}` with exit 2: the refusals `cmdMeshRead` returns.
fn refusal(fields: &[(&str, OVal)]) -> Answer {
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(false));
    for (k, v) in fields {
        o.put(k, v.clone());
    }
    Answer { code: 2, stdout: format!("{}\n", o.done().stringify()), effect: Effect::None }
}

/// `JSON.stringify(String(x))`.
fn quoted(x: &str) -> String {
    OVal::Str(x.to_string()).stringify()
}

/// The `--since` of a peek: a duration (`30m`, `2h`, `1d`) before now, else a date. `None` when it is neither.
fn since_ts(raw: Option<&str>, now: f64) -> Option<f64> {
    if let Some(d) = crate::meshw::simple::parse_since_duration(raw) {
        return Some(now - d);
    }
    let text = raw?;
    match crate::checks::guardkit::jsval::date_parse(text) {
        crate::checks::guardkit::jsval::DateParse::Ms(ms) if ms.is_finite() => Some(ms),
        // a date alone is UTC midnight, as `Date.parse` reads the date-only ISO form
        _ => crate::dispatch::inject::iso_ms(&format!("{text}T00:00:00Z")).filter(|_| text.len() == 10),
    }
}

/// Run `mesh read`, `mesh history` or `roster --ack`. (`help` never reaches here: `verb_of` classifies a help request first.)
pub fn run(inv: &Inv, a: &Args, history: bool) -> R<Answer> {
    match run_inner(inv, a, history) {
        Err(Defer(reason)) if crate::meshw::readprimary::is_store_failure(&reason) && !crate::meshw::committed() => {
            // the store itself failed: Node throws, and `run()` prints the exception as `{ok:false, error}`, exit 2
            Ok(crate::meshw::readprimary::failure(&defaults::render("mesh_write.msg_store_failure", &[("reason", &reason)])))
        }
        other => other,
    }
}

fn run_inner(inv: &Inv, a: &Args, history: bool) -> R<Answer> {
    let mut a = a.clone();
    if history {
        a.flags.insert(defaults::text("mesh_write.flag_seq").into(), vec![FlagVal::S(defaults::text("mesh_write.history_seq").into())]);
        a.flags.insert(defaults::text("mesh_write.flag_peek").into(), vec![FlagVal::True]);
    }
    let home = &inv.home;
    let cwd = ident::project_cwd_for(home, &inv.env, &inv.cwd)?;
    let Some(repo_key) = ident::repo_key_for_worktree(&cwd)? else { return Ok(refusal(&[("reason", s(defaults::text("mesh_write.reason_no_project")))])) };
    let from = ident::caller_identity_for(&inv.env, &cwd, &inv.home)?.identity;
    let st = common::open_store(inv, &repo_key)?;
    let rows = ident::rows_of(&st.reader().roster().map_err(|e| store_err("registry", e))?);
    let own = resolve_mesh_target(inv, Some(st.reader()), &rows, Some(&from))?;
    let cursor_key = own.map(|r| r.id).unwrap_or_else(|| from.clone());
    let cursor = st.reader().broadcast_cursor(&cursor_key).map_err(|e| store_err("cursor", e))? as f64;
    let flag_seq = defaults::text("mesh_write.flag_seq");
    let has_seq = a.has(flag_seq);
    let seq_raw = a.one(flag_seq);
    let mut since_seq = cursor;
    let mut explicit = false;
    if has_seq && seq_raw.is_none() {
        return Ok(refusal(&[("error", s(defaults::text("mesh_write.msg_seq_bare"))), ("reason", s(defaults::text("mesh_write.reason_bad_seq")))]));
    }
    if let Some(raw) = seq_raw {
        let v = js_number(raw);
        if !v.is_finite() || v < 0.0 {
            let msg = defaults::render("mesh_write.msg_seq_invalid", &[("got", &quoted(raw))]);
            return Ok(refusal(&[("error", s(&msg)), ("reason", s(defaults::text("mesh_write.reason_bad_seq")))]));
        }
        since_seq = v.floor();
        explicit = true;
    }
    let peek = a.has(defaults::text("mesh_write.flag_peek")) || explicit;
    let has_last = a.has(defaults::text("mesh_write.flag_last"));
    let has_since = a.has(defaults::text("mesh_write.flag_since"));
    if (has_last || has_since) && !peek {
        return Ok(refusal(&[
            ("reason", s(defaults::text("mesh_write.reason_filter_requires_peek"))),
            ("error", s(defaults::text("mesh_write.msg_filter_requires_peek"))),
            ("hint", s(defaults::text("mesh_write.hint_filter_requires_peek"))),
        ]));
    }
    let mut last_n: Option<f64> = None;
    if has_last {
        let raw = a.one(defaults::text("mesh_write.flag_last"));
        let v = raw.map_or(f64::NAN, js_number);
        if raw.is_none() || !v.is_finite() || v < 1.0 {
            let msg = defaults::render("mesh_write.msg_last_invalid", &[("got", &quoted(raw.unwrap_or_default()))]);
            return Ok(refusal(&[("error", s(&msg)), ("reason", s(defaults::text("mesh_write.reason_bad_last")))]));
        }
        last_n = Some(v.floor());
    }
    let mut sin_ts: Option<f64> = None;
    if has_since {
        let raw = a.one(defaults::text("mesh_write.flag_since"));
        match since_ts(raw, inv.now as f64) {
            Some(ts) => sin_ts = Some(ts),
            None => {
                let msg = defaults::render("mesh_write.msg_since_invalid", &[("got", &quoted(raw.unwrap_or_default()))]);
                return Ok(refusal(&[("error", s(&msg)), ("reason", s(defaults::text("mesh_write.reason_bad_since")))]));
            }
        }
    }
    if !peek {
        common::seat_check(inv)?;
    }
    let aliases = common::read_aliases(home, &inv.env);
    let mut unseen: Vec<serde_json::Value> = Vec::new();
    st.reader()
        .for_each_message(defaults::text("mesh_write.broadcast_partition"), 0, |m| {
            if !m["isHeartbeat"].as_bool().unwrap_or(false) && m["storeSeq"].as_f64().is_some_and(|q| q > since_seq) {
                unseen.push(m);
            }
            true
        })
        .map_err(|e| store_err("broadcasts", e))?;
    let unseen_count = unseen.len();
    if let Some(ts) = sin_ts {
        unseen.retain(|r| r["ts"].as_f64().is_some_and(|t| t.is_finite() && t >= ts));
    }
    if let Some(k) = last_n {
        let k = k as usize;
        if unseen.len() > k {
            unseen.drain(..unseen.len() - k);
        }
    }
    let broadcasts: Vec<OVal> = unseen
        .iter()
        .map(|r| {
            let sender = r["sender"].as_str();
            let alias = sender.and_then(|sv| aliases.iter().find(|(k, _)| k == sv).map(|(_, v)| v.clone()));
            let mut b = Obj::default();
            b.put(
                "from",
                match &alias {
                    Some(to) => s(to),
                    None => s_or_null(sender),
                },
            )
            .put("message", s(r["body"].as_str().unwrap_or("")))
            .put("text", s(r["body"].as_str().unwrap_or("")))
            .put("kind", s(defaults::text("mesh_write.mtype_broadcast")))
            .put("timestamp", n(r["ts"].as_f64().unwrap_or(f64::NAN)))
            .put("urgency", s_or_null(r["urgency"].as_str()))
            .put("seq", r["storeSeq"].as_f64().map_or(OVal::Null, n));
            if alias.is_some() {
                b.put("fromLabel", s_or_null(sender));
            }
            crate::meshw::senders::put_from(&mut b, sender);
            b.done()
        })
        .collect();
    let new_cursor = if peek {
        cursor
    } else {
        crate::meshw::summary::check(&st, inv, None)?;
        let c = ack_listed(&st, &cursor_key, &unseen)?.map_or(cursor, |c| c as f64);
        if let Some(why) = crate::meshw::summary::derive_after_write(&st, inv, &repo_key) {
            crate::meshw::log_summary_failure(defaults::text("mesh_write.verb_read"), &why);
        }
        c
    };
    let mut out = Obj::default();
    out.put("ok", OVal::Bool(true))
        .put("action", s(defaults::text(if history { "mesh_write.action_mesh_history" } else { "mesh_write.action_mesh_read" })))
        .put("from", s(&from))
        .put("acked", OVal::Bool(!peek))
        .put("newCursor", n(new_cursor))
        .put("count", n(broadcasts.len() as f64))
        .put("broadcasts", OVal::Arr(broadcasts.clone()))
        .put("messages", OVal::Arr(broadcasts.clone()));
    if peek {
        out.put("peek", OVal::Bool(true));
    } else {
        out.put("hint", s(defaults::text("mesh_write.msg_mesh_read_hint")));
    }
    if explicit {
        out.put("since", n(since_seq));
    }
    if let Some(k) = last_n {
        out.put("last", n(k));
    }
    if let Some(ts) = sin_ts {
        out.put("sinceTs", n(ts));
    }
    if broadcasts.len() != unseen_count {
        out.put("filteredOut", n((unseen_count - broadcasts.len()) as f64));
    }
    let effect = if peek { Effect::None } else { Effect::BroadcastCursor(cursor_key) };
    Ok(Answer { code: 0, stdout: format!("{}\n", out.done().stringify()), effect })
}
/// Review P1-3 (contract §6): `mesh read` acks exactly through the last broadcast it listed, never the live head it would sample
/// after the scan (a broadcast landing in between would be acked unseen). The new cursor, `None` when it did not move.
fn ack_listed(st: &crate::meshw::store::MeshStore, key: &str, listed: &[serde_json::Value]) -> R<Option<i64>> {
    let Some(target) = listed.iter().filter_map(|r| r["storeSeq"].as_f64()).filter(|q| q.is_finite()).map(|q| q as i64).max() else {
        return Ok(None);
    };
    ack_broadcasts(st, key, target)
}

/// GH #845 (contract §6): the unread broadcasts a drain verb lists beside the direct mail, with the exact boundary an ack may move
/// the broadcast cursor through. A read never samples the live head to ack.
pub(crate) struct UnreadBroadcasts {
    /// The OLDEST `mesh_wake.inbox_broadcast_cap` unread non-heartbeat broadcasts of others, in seq order, each with `addressed`;
    /// past the cap, the unread rows that wake this reader (up to `mesh_wake.inbox_broadcast_eligible_cap`).
    pub rows: Vec<OVal>,
    /// More unread broadcasts wait past the cap (they stay unread for the next drain).
    pub more: bool,
    /// The cursor when the read was made.
    pub from: i64,
    /// The seq of the last broadcast listed before the first one held back: the delivered boundary (rows listed past a held-back
    /// row stay unread and are listed again). `None` when nothing was listed (no ack op).
    pub target: Option<i64>,
    /// How many unread broadcasts wake this reader (the summary's `broadcastWakePending`, listed or not), and the highest seq of
    /// them (`broadcastWakeSeq`): the Codex tick wakes on these (review P1-4).
    pub wake_pending: usize,
    /// See `wake_pending`.
    pub wake_seq: Option<i64>,
}

/// The unread broadcasts of reader `reader` (its broadcast-cursor key, a registry id), read only.
pub(crate) fn unread_broadcasts(r: &crate::mesh::MeshReader, inv: &Inv, reader: &str) -> R<UnreadBroadcasts> {
    scan_broadcasts(r, inv, reader, true)
}

/// Review P1-4: how many unread broadcasts wake reader `reader`, and the highest seq of them, without listing any (the Codex tick).
pub(crate) fn broadcast_wake(r: &crate::mesh::MeshReader, inv: &Inv, reader: &str) -> R<(usize, Option<i64>)> {
    let u = scan_broadcasts(r, inv, reader, false)?;
    Ok((u.wake_pending, u.wake_seq))
}

fn scan_broadcasts(r: &crate::mesh::MeshReader, inv: &Inv, reader: &str, list: bool) -> R<UnreadBroadcasts> {
    let bpart = defaults::text("mesh_write.broadcast_partition");
    let cursor = r.broadcast_cursor(reader).map_err(|e| store_err("cursor", e))? as i64;
    let extras = r.extras_of(bpart, cursor).map_err(|e| store_err("broadcasts", e))?;
    let roster = ident::rows_of(&r.roster().map_err(|e| store_err("registry", e))?);
    let roster_ids: Vec<&str> = roster.iter().map(|r| r.id.as_str()).collect();
    // review P2-6: the reader's whole identity family is "own", exactly as the summary counts it
    let family = crate::meshw::tick::family_of(reader, &roster);
    let mode = crate::meshw::wakepolicy::Mode::load();
    let aliases = common::read_aliases(&inv.home, &inv.env);
    let cap = defaults::num("mesh_wake.inbox_broadcast_cap") as usize;
    let mut rows: Vec<OVal> = Vec::new();
    let mut more = false;
    let mut target: Option<i64> = None;
    let extra_cap = defaults::num("mesh_wake.inbox_broadcast_eligible_cap") as usize;
    let mut extra = 0usize;
    let mut contiguous = true;
    let (mut wake_pending, mut wake_seq) = (0usize, None::<i64>);
    r.for_each_message(bpart, 0, |m| {
        let Some(q) = m["storeSeq"].as_f64().filter(|q| q.is_finite() && *q as i64 > cursor).map(|q| q as i64) else { return true };
        let sender = m["sender"].as_str();
        if m["isHeartbeat"].as_bool().unwrap_or(false) || sender.is_some_and(|x| family.contains(x)) {
            // passed over with the listed rows when an ack moves through them
            return true;
        }
        let body = m["body"].as_str().unwrap_or("");
        let needs_reply = m["needsReply"].as_bool().unwrap_or(false);
        let (kind, stored) = extras.get(&q).map_or((None, None), |(k, a)| (k.as_deref(), a.as_deref()));
        let stored = crate::meshw::wakepolicy::decode(stored);
        let legacy = || {
            let b = crate::meshw::wakepolicy::Bc { sender, urgency: m["urgency"].as_str(), question: needs_reply, heartbeat: false, body };
            crate::meshw::wakepolicy::resolve(&b, &roster_ids).unwrap_or_else(|e| crate::meshw::wakepolicy::Audience::Ids(e.ids))
        };
        let addressed = mode.wakes(stored.as_ref(), kind, reader, legacy, true);
        let wakes = mode.wakes(stored.as_ref(), kind, reader, legacy, false);
        if wakes {
            wake_pending += 1;
            wake_seq = Some(q);
        }
        // review P1-1: past the cap only the rows that wake this reader are still listed (the watcher woke for them), up to
        // their own cap; the ack target stops at the last row before the first one held back, so nothing is acked unseen
        if rows.len() >= cap {
            more = true;
            contiguous = false;
            if !wakes || extra >= extra_cap {
                return true;
            }
            extra += 1;
        }
        if !list {
            return true;
        }
        let alias = sender.and_then(|sv| aliases.iter().find(|(k, _)| k == sv).map(|(_, v)| v.clone()));
        let mut b = Obj::default();
        b.put("from", alias.as_deref().map_or_else(|| s_or_null(sender), s))
            .put("message", s(body))
            .put("kind", s(defaults::text("mesh_write.mtype_broadcast")))
            .put("timestamp", n(m["ts"].as_f64().unwrap_or(f64::NAN)))
            .put("urgency", s_or_null(m["urgency"].as_str()))
            .put("seq", n(q as f64))
            .put("needsReply", OVal::Bool(needs_reply))
            .put("addressed", OVal::Bool(addressed));
        if alias.is_some() {
            b.put("fromLabel", s_or_null(sender));
        }
        crate::meshw::senders::put_from(&mut b, sender);
        rows.push(b.done());
        if contiguous {
            target = Some(q);
        }
        true
    })
    .map_err(|e| store_err("broadcasts", e))?;
    Ok(UnreadBroadcasts { rows, more, from: cursor, target, wake_pending, wake_seq })
}

/// Review P2-8: [`unread_broadcasts`] for a drain verb whose direct mail must not fail with it. A broadcast read that fails lists
/// none (so nothing is acked), says why in the result (`mesh_wake.key_broadcasts_error`) and is counted (`mesh_broadcast_read_failed`).
pub(crate) fn unread_broadcasts_or_note(r: &crate::mesh::MeshReader, inv: &Inv, reader: &str, o: &mut Obj) -> Option<UnreadBroadcasts> {
    match unread_broadcasts(r, inv, reader) {
        Ok(u) => Some(u),
        Err(ident::Defer(reason)) => {
            crate::metrics::bump_shared("mesh_broadcast_read_failed", &[]);
            o.put(defaults::text("mesh_wake.key_broadcasts_error"), s(&reason));
            None
        }
    }
}

/// Review P2-13: read-primary carries a broadcast that does not address the reader as a preview (`mesh_wake.read_primary_preview_chars`
/// characters, `preview: true`), so a busy room does not fill every Primary read with full bodies; addressed rows stay whole.
pub(crate) fn preview_unaddressed(u: &mut UnreadBroadcasts) {
    let max = defaults::num("mesh_wake.read_primary_preview_chars") as usize;
    for row in &mut u.rows {
        if matches!(row.get("addressed"), Some(OVal::Bool(true))) {
            continue;
        }
        if let Some(OVal::Str(body)) = row.get("message")
            && body.chars().count() > max
        {
            let cut: String = body.chars().take(max).collect();
            row.set("message", s(&cut));
            row.set("preview", OVal::Bool(true));
        }
    }
}

/// Put the unread broadcasts into a drain verb's result: `broadcasts`, `broadcastsMore` when the cap held some back, and (for
/// `inbox read`, whose ack is a separate call) `broadcastAckTarget`. Nothing is added when there are none, so a reader with no
/// broadcasts sees the result it always did.
pub(crate) fn put_broadcasts(o: &mut Obj, u: &UnreadBroadcasts, with_target: bool) {
    if u.rows.is_empty() {
        return;
    }
    o.put(defaults::text("mesh_wake.key_broadcasts"), OVal::Arr(u.rows.clone()));
    if u.more {
        o.put(defaults::text("mesh_wake.key_broadcasts_more"), OVal::Bool(true));
    }
    if with_target && let Some(t) = u.target {
        o.put(defaults::text("mesh_wake.key_broadcast_ack_target"), n(t as f64));
    }
}

/// The read-receipt op that acks what [`unread_broadcasts`] listed (contract §6), `None` when nothing was listed.
pub(crate) fn broadcast_op(reader: &str, u: &UnreadBroadcasts) -> Option<OVal> {
    let t = u.target?;
    let mut op = Obj::default();
    op.put("k", s(defaults::text("mesh_write.op_broadcast")))
        .put("opv", n(defaults::num("mesh_write.op_broadcast_version") as f64))
        .put("reader", s(reader))
        .put("from", n(u.from as f64))
        .put("target", n(t as f64))
        .put("delivered", n(u.rows.len() as f64));
    Some(op.done())
}

/// Move reader `reader`'s broadcast cursor through `target` (the delivered boundary): never back, never past the live head. The
/// new cursor, or `None` when it did not move.
pub(crate) fn ack_broadcasts(st: &crate::meshw::store::MeshStore, reader: &str, target: i64) -> R<Option<i64>> {
    let now = st.reader().broadcast_cursor(reader).map_err(|e| store_err("cursor", e))? as i64;
    if target <= now {
        return Ok(None);
    }
    let to = st.raise_broadcast_cursor(reader, target, common::now_ms()).map_err(|e| store_err("advance", e))?;
    crate::meshw::mark_committed();
    Ok((to > now).then_some(to))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::meshw::store::{MeshStore, mesh_message_hash, mesh_message_row};

    fn scratch(tag: &str) -> (std::path::PathBuf, MeshStore, Inv) {
        let d = crate::testtmp::child("test-bcdrain", format!("{tag}-{}", std::process::id()));
        crate::discard::harmless(std::fs::remove_dir_all(&d)); // keep: a leftover from an earlier run
        std::fs::create_dir_all(&d).unwrap();
        let st = MeshStore::open(&d.join("devswarm.db")).unwrap();
        let inv = Inv {
            home: d.clone(),
            write_home: d.clone(),
            env: std::collections::HashMap::new(),
            cwd: "/".into(),
            now: 1_795_000_000_000,
            stdin: None,
            store_override: None,
        };
        (d, st, inv)
    }

    fn broadcast(st: &MeshStore, from: &str, body: &str, ts: i64) {
        let h = mesh_message_hash(Some(from), None, defaults::text("mesh_write.mtype_broadcast"), "normal", body, &ts.to_string(), false);
        st.append_mesh_row(&mesh_message_row(Some(from), None, true, body, ts, "normal", &h, false, None)).unwrap();
    }

    /// GH #845 (Codex P0-2): a broadcast that lands between `inbox read` and `inbox ack` is never acked unseen: the ack moves only
    /// through the boundary the read listed.
    #[test]
    fn an_arrival_between_read_and_ack_stays_unread() {
        let (_d, st, inv) = scratch("race");
        broadcast(&st, "w-b", "first", 1);
        broadcast(&st, "w-b", "second", 2);
        let u = unread_broadcasts(st.reader(), &inv, "w-a").unwrap();
        assert_eq!(u.rows.len(), 2);
        let target = u.target.unwrap();
        broadcast(&st, "w-b", "arrived during the read", 3);
        assert_eq!(ack_broadcasts(&st, "w-a", target).unwrap(), Some(target));
        let again = unread_broadcasts(st.reader(), &inv, "w-a").unwrap();
        assert_eq!(again.rows.len(), 1, "the arrival is still unread");
        assert_eq!(again.rows[0].get("message"), Some(&OVal::Str("arrived during the read".into())));
    }

    /// The cap lists the OLDEST unread and the ack stops at the last listed: the rest wait for the next drain (`more`).
    #[test]
    fn the_cap_keeps_the_rest_unread_and_the_cursor_never_goes_back() {
        let (_d, st, inv) = scratch("cap");
        let cap = defaults::num("mesh_wake.inbox_broadcast_cap") as i64;
        for i in 0..cap + 3 {
            broadcast(&st, "w-b", &format!("m{i}"), i + 1);
        }
        broadcast(&st, "w-a", "my own", cap + 10);
        let u = unread_broadcasts(st.reader(), &inv, "w-a").unwrap();
        assert!(u.more);
        assert_eq!(u.rows.len() as i64, cap);
        ack_broadcasts(&st, "w-a", u.target.unwrap()).unwrap();
        let rest = unread_broadcasts(st.reader(), &inv, "w-a").unwrap();
        assert_eq!(rest.rows.len(), 3, "the own broadcast is not listed");
        assert_eq!(ack_broadcasts(&st, "w-a", 1).unwrap(), None, "an older target never moves the cursor back");
        assert_eq!(ack_broadcasts(&st, "w-a", i64::MAX).unwrap().map(|c| c <= st.broadcast_head().unwrap()), Some(true), "never past the head");
    }

    fn broadcast_to(st: &MeshStore, from: &str, body: &str, ts: i64, audience: &str) {
        let h = mesh_message_hash(Some(from), None, defaults::text("mesh_write.mtype_broadcast"), "normal", body, &ts.to_string(), false);
        st.append_mesh_row_with(&mesh_message_row(Some(from), None, true, body, ts, "normal", &h, false, None), None, Some(audience), None).unwrap();
    }

    /// Review P1-1: a backlog past the cap of broadcasts that do not address the reader, then one that does. The watcher wakes
    /// for the addressed row, so the drain must list it (past the cap), while the ack still stops at the last contiguous row.
    #[test]
    fn an_addressed_row_past_the_cap_is_listed_and_not_acked_past_the_gap() {
        let (_d, st, inv) = scratch("cap-addressed");
        let cap = defaults::num("mesh_wake.inbox_broadcast_cap") as i64;
        for i in 0..cap + 10 {
            broadcast_to(&st, "w-b", &format!("fyi {i}"), i + 1, defaults::text("mesh_wake.audience_none"));
        }
        broadcast_to(&st, "w-b", "@w-a please look", cap + 20, r#"["w-a"]"#);
        let u = unread_broadcasts(st.reader(), &inv, "w-a").unwrap();
        assert!(u.more, "unaddressed rows wait past the cap");
        let last = u.rows.last().unwrap();
        assert_eq!(last.get("message"), Some(&OVal::Str("@w-a please look".into())), "the addressed row is listed past the cap");
        assert_eq!(last.get("addressed"), Some(&OVal::Bool(true)));
        assert_eq!(u.rows.len() as i64, cap + 1);
        let target = u.target.unwrap();
        assert!(target < cap + 1 + 1, "the ack target stays at the last contiguous listed row, got {target}");
        ack_broadcasts(&st, "w-a", target).unwrap();
        let rest = unread_broadcasts(st.reader(), &inv, "w-a").unwrap();
        assert_eq!(rest.rows.len(), 11, "the 10 unaddressed rows past the gap and the addressed row are still unread");
        ack_broadcasts(&st, "w-a", rest.target.unwrap()).unwrap();
        assert!(unread_broadcasts(st.reader(), &inv, "w-a").unwrap().rows.is_empty());
    }

    /// Review P1-3: `mesh read` acks through the last row it listed; a broadcast that lands after its scan stays unread.
    #[test]
    fn mesh_read_acks_only_what_it_listed() {
        let (_d, st, _inv) = scratch("legacy-read");
        assert_eq!(ack_listed(&st, "w-a", &[]).unwrap(), None, "nothing listed, nothing acked");
        broadcast(&st, "w-b", "one", 1);
        broadcast(&st, "w-b", "two", 2);
        let mut listed = Vec::new();
        st.reader()
            .for_each_message(defaults::text("mesh_write.broadcast_partition"), 0, |m| {
                listed.push(m);
                true
            })
            .unwrap();
        broadcast(&st, "w-b", "landed after the scan", 3);
        let to = ack_listed(&st, "w-a", &listed).unwrap().unwrap();
        assert!(to < st.broadcast_head().unwrap(), "the cursor stops before the late arrival");
        assert_eq!(st.reader().broadcast_cursor("w-a").unwrap() as i64, to);
    }

    /// Review P1-4: the wake count a tick reads matches who the broadcast addresses: the addressee, not a bystander; a legacy row
    /// (no stored audience) is resolved from its text.
    #[test]
    fn the_broadcast_wake_count_follows_the_audience() {
        let (_d, st, inv) = scratch("wake-count");
        broadcast_to(&st, "w-b", "for a", 1, r#"["w-a"]"#);
        broadcast_to(&st, "w-b", "fyi", 2, defaults::text("mesh_wake.audience_none"));
        broadcast(&st, "w-b", "legacy fyi", 3);
        let (pending, seq) = broadcast_wake(st.reader(), &inv, "w-a").unwrap();
        assert_eq!(pending, 1);
        assert!(seq.is_some());
        assert_eq!(broadcast_wake(st.reader(), &inv, "w-c").unwrap(), (0, None), "a bystander is not woken");
    }

    /// Review P2-6: a broadcast from the reader's identity family (a row cross-linked to it) is its own, never listed or counted.
    #[test]
    fn the_readers_identity_family_is_never_listed() {
        let (_d, st, inv) = scratch("family");
        let twin = crate::meshw::store::RegistryRow {
            id: "w-a2".into(),
            worktree_path: None,
            session_id: Some("w-a".into()),
            inbox_path: None,
            cursor_path: None,
            nudge_command: None,
        };
        st.upsert_registry(&twin, 1, |a, b| a == b).unwrap();
        broadcast_to(&st, "w-a2", "from my own twin", 1, defaults::text("mesh_wake.audience_all"));
        broadcast_to(&st, "w-b", "from someone else", 2, defaults::text("mesh_wake.audience_all"));
        let u = unread_broadcasts(st.reader(), &inv, "w-a").unwrap();
        assert_eq!(u.rows.len(), 1, "{:?}", u.rows);
        assert_eq!(u.wake_pending, 1);
    }

    /// Review P2-7: the cursor write itself never lowers the cursor and never passes the head, whatever target it is handed.
    #[test]
    fn the_cursor_write_is_max_guarded_and_head_capped() {
        let (_d, st, _inv) = scratch("raise");
        for i in 0..3 {
            broadcast(&st, "w-b", &format!("m{i}"), i + 1);
        }
        let head = st.broadcast_head().unwrap();
        assert_eq!(st.raise_broadcast_cursor("w-a", head, 1).unwrap(), head);
        assert_eq!(st.raise_broadcast_cursor("w-a", 1, 2).unwrap(), head, "a lower target leaves it");
        assert_eq!(st.raise_broadcast_cursor("w-a", head + 100, 3).unwrap(), head, "never past the head");
    }

    /// Review P2-8: a broadcast read that fails lists none and says why, instead of failing the drain.
    #[test]
    fn a_failed_broadcast_read_is_noted_not_fatal() {
        let (_d, st, inv) = scratch("soft");
        st.reader().conn().execute_batch("DROP TABLE broadcast_cursors").unwrap();
        let mut o = Obj::default();
        assert!(unread_broadcasts_or_note(st.reader(), &inv, "w-a", &mut o).is_none());
        assert!(o.done().get(defaults::text("mesh_wake.key_broadcasts_error")).is_some());
    }

    /// Review P2-13: an unaddressed body past the preview length is cut and marked; an addressed one is kept whole.
    #[test]
    fn read_primary_previews_only_unaddressed_bodies() {
        let (_d, st, inv) = scratch("preview");
        let long = "x".repeat(defaults::num("mesh_wake.read_primary_preview_chars") as usize + 40);
        broadcast_to(&st, "w-b", &long, 1, defaults::text("mesh_wake.audience_none"));
        broadcast_to(&st, "w-b", &long, 2, r#"["w-a"]"#);
        let mut u = unread_broadcasts(st.reader(), &inv, "w-a").unwrap();
        preview_unaddressed(&mut u);
        let len = |i: usize| match u.rows[i].get("message") {
            Some(OVal::Str(b)) => b.chars().count(),
            _ => 0,
        };
        assert_eq!(len(0), defaults::num("mesh_wake.read_primary_preview_chars") as usize);
        assert_eq!(u.rows[0].get("preview"), Some(&OVal::Bool(true)));
        assert_eq!(len(1), long.len(), "the addressed row is whole");
    }

    /// The receipt op carries exactly the delivered boundary, and none is made when nothing was listed.
    #[test]
    fn the_receipt_op_names_the_delivered_boundary() {
        let (_d, st, inv) = scratch("op");
        assert!(broadcast_op("w-a", &unread_broadcasts(st.reader(), &inv, "w-a").unwrap()).is_none());
        broadcast(&st, "w-b", "hello", 1);
        let u = unread_broadcasts(st.reader(), &inv, "w-a").unwrap();
        let op = broadcast_op("w-a", &u).unwrap();
        assert_eq!(op.get("k"), Some(&OVal::Str(defaults::text("mesh_write.op_broadcast").into())));
        assert_eq!(op.get("target"), Some(&n(u.target.unwrap() as f64)));
    }
}
