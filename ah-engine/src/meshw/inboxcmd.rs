//! `devswarm.js inbox count|read|peek-primary|ack|pull <id>`, ported from `scripts/devswarm-lib/inbox-cmd.js` `cmdInbox`.
//!
//! These verbs read the same union the tick and `read-primary` count through ([`union`], [`tick`]); only the output and the
//! effects differ. Each verb answers the single-partition, registered case and defers every other shape BEFORE anything is
//! written (a descriptor that does not exist, a flag the engine does not read, a mesh group, a retired redirect, a store that
//! needs a re-home). A deferral is a visible error (`exit_unable`): there is no Node to hand the verb to.
use crate::checks::guardkit::ojson::OVal;
use crate::defaults;
use crate::meshw::args::Args;
use crate::meshw::common::{self, Inv, Obj, n, s};
use crate::meshw::ident::R;
use crate::meshw::idlock::is_safe_id;
use crate::meshw::send::{Answer, Effect, resolve_mesh_target, retired_redirect_exists};
use crate::meshw::{cursors, ident};
use crate::meshw::{tick, union};

/// Where a count, read or ack lands: the descriptor it works on, or the refusal Node prints for an id nothing resolves.
pub(crate) enum Found {
    Go { id: String, desc: OVal, resolved_from: Option<String>, redirected_from: Option<String> },
    Out(Answer),
}

/// The descriptor of `raw` for `inbox <sub>`, as Node finds it: the dispatcher's canonical id, then (for an id with no descriptor of
/// its own) the mesh label of a registered row, else the refusal `unregistered-workspace` / `no-inbox-path`. Anything else Node
/// resolves (a prefix, a fold-retired redirect, an ambiguous label, a descriptor without an inbox path) is left to it.
pub(crate) fn locate(inv: &Inv, sub: &str, raw: &str, ack_as_owner: bool, dispatcher: bool) -> R<Found> {
    let has_inbox = |d: &OVal| union::path_field(d, defaults::text("mesh_write.field_inbox_path")).map(|p| p.is_some());
    if let Some(desc) = ident::read_descriptor(&inv.home, raw) {
        // a descriptor with no inbox path is no inbox: Node goes on to the redirect / label / refusal steps below
        if has_inbox(&desc)? {
            return Ok(Found::Go { id: raw.to_string(), desc, resolved_from: None, redirected_from: None });
        }
    }
    // the dispatcher resolves the target of count / read / ack to a canonical id first (`resolveTargetId`); a tick addresses its own id
    let id = if dispatcher {
        let action = format!("{}{sub}", defaults::text("mesh_write.act_inbox_prefix"));
        match crate::meshw::actverbs::resolve_target_id(inv, raw, &action)? {
            Ok(id) => id,
            Err(refused) => return Ok(Found::Out(refused)),
        }
    } else {
        raw.to_string()
    };
    if let Some(desc) = ident::read_descriptor(&inv.home, &id) {
        if has_inbox(&desc)? {
            return Ok(Found::Go { id, desc, resolved_from: None, redirected_from: None });
        }
    }
    // the store the probes below read: the caller's project, else the id's legacy bucket (Node's `openStore` creates it); one that
    // cannot be opened ends in the `store-unavailable` refusal
    let caller_key = ident::resolve_context(&inv.cwd, true)?.repo_key;
    let repo_key = caller_key.clone().unwrap_or_else(|| crate::meshw::send::hash_from_workspace_id(&id));
    let reader = match tick::probe_reader_creating(inv, &repo_key) {
        tick::Probe::Open(r) => r,
        failed => {
            let code = match failed {
                tick::Probe::Unreadable(c) => c,
                _ => defaults::text("mesh_write.store_unknown_code").to_string(),
            };
            let q = OVal::Str(id.clone()).stringify();
            let mut o = Obj::default();
            o.put("ok", OVal::Bool(false))
                .put("id", s(&id))
                .put("reason", s(defaults::text("mesh_write.reason_store_unavailable")))
                .put("error", s(&defaults::render("mesh_write.msg_store_unopened_code", &[("id", &q), ("code", &code)])))
                .put("repoKey", caller_key.as_deref().map_or(OVal::Null, s))
                .put("storePath", OVal::Str(union::store_dir(&inv.home, &repo_key).to_string_lossy().into_owned()))
                .put("cwd", s(&inv.cwd))
                .put("meshPartitionIds", OVal::Arr(vec![s(&id)]))
                .put("known", OVal::Bool(false))
                .put("storeUnavailable", OVal::Bool(true))
                .put("storeUnavailableReason", s(&code))
                .put("meshGroupUnresolved", OVal::Bool(false))
                .put("meshGroupError", OVal::Null)
                .put("totalsPartial", OVal::Bool(true));
            return Ok(Found::Out(Answer { code: 2, stdout: format!("{}\n", o.done().stringify()), effect: Effect::None }));
        }
    };
    let rows = ident::rows_of(&reader.roster().or_else(|e| ident::refuse_text("mesh_write.msg_registry_unreadable", &[("why", &e.to_string())]))?);
    // a fold-retired id: its mail is its survivor's, unless the id was registered again since or the survivor has no inbox
    // (then Node leaves the redirect alone and goes on to the label / refusal steps)
    let retired = if retired_redirect_exists(inv, &id) {
        crate::meshw::readprimary::read_retired_redirect(inv, &id).and_then(|survivor| {
            let re_registered = rows.iter().any(|r| r.id == id);
            let d = ident::read_descriptor(&inv.home, &survivor)?;
            (survivor != id && !re_registered && has_inbox(&d).unwrap_or(false)).then_some((survivor, d))
        })
    } else {
        None
    };
    if let Some((survivor, survivor_desc)) = retired {
        if sub == defaults::text("mesh_write.verb_ack") {
            let q = |t: &str| OVal::Str(t.to_string()).stringify();
            if ack_as_owner && crate::meshw::actverbs::has_fresh_heartbeat(inv, &survivor) {
                // the override's purpose is a retired target with no live owner
                let err = defaults::render("mesh_write.msg_redirect_live_log", &[("id", &id), ("survivor", &survivor)]);
                cursors::log_cursor_write(
                    &inv.home,
                    &cursors::LogRec {
                        id: &survivor,
                        caller_id: Some(&id),
                        ns: defaults::text("mesh_write.log_ns_plain_store"),
                        from: None,
                        to: None,
                        delivered: None,
                        nonce: None,
                        gate: defaults::text("mesh_write.gate_redirect_live"),
                        verb: defaults::text("mesh_write.verb_log_ack"),
                        cwd: None,
                        ok: false,
                        err: Some(&err),
                        repo_key: Some(&repo_key),
                    },
                );
                let mut o = Obj::default();
                o.put("ok", OVal::Bool(false))
                    .put("action", s(sub))
                    .put("id", s(&id))
                    .put("reason", s(defaults::text("mesh_write.reason_redirect_live")))
                    .put("redirectedTo", s(&survivor))
                    .put("error", s(&defaults::render("mesh_write.msg_redirect_live", &[("id", &q(&id)), ("survivor", &q(&survivor))])));
                return Ok(Found::Out(Answer { code: 2, stdout: format!("{}\n", o.done().stringify()), effect: Effect::None }));
            }
            if !ack_as_owner {
                let caller = ident::caller_identity_detailed(&inv.env, &inv.cwd)?;
                let own_entry = resolve_mesh_target(inv, Some(&reader), &rows, Some(caller.identity.as_str()))?;
                let owns = caller.identity == survivor
                    || own_entry.as_ref().is_some_and(|e| e.id == survivor)
                    || ident::declared_self_id(&inv.env, &inv.cwd, &rows)?.as_deref() == Some(survivor.as_str());
                if !owns {
                    let mut o = Obj::default();
                    o.put("ok", OVal::Bool(false))
                        .put("action", s(sub))
                        .put("id", s(&survivor))
                        .put("reason", s(defaults::text("mesh_write.reason_redirect_unresolvable")))
                        .put("error", s(&defaults::render("mesh_write.msg_redirect_unresolvable", &[("id", &q(&id)), ("survivor", &q(&survivor))])))
                        .put("redirected", OVal::Bool(true))
                        .put("redirectedFrom", s(&id));
                    return Ok(Found::Out(Answer { code: 2, stdout: format!("{}\n", o.done().stringify()), effect: Effect::None }));
                }
            }
        }
        return Ok(Found::Go { id: survivor, desc: survivor_desc, resolved_from: None, redirected_from: Some(id) });
    }
    let exact = rows.iter().any(|r| r.id == id);
    if !exact {
        // a mesh label of a registered row addresses that row
        if let Some(target) = resolve_mesh_target(inv, Some(&reader), &rows, Some(id.as_str()))? {
            if target.id != id {
                if let Some(desc) = ident::read_descriptor(&inv.home, &target.id)
                    && has_inbox(&desc)?
                {
                    return Ok(Found::Go { id: target.id, desc, resolved_from: Some(id), redirected_from: None });
                }
            }
            // a label whose row has no inbox: Node reports the literal id's refusal below
        }
    }
    let has_messages = reader
        .message_count(&id)
        .or_else(|e| ident::refuse_text("mesh_write.msg_store_read_error", &[("id", &OVal::Str(id.clone()).stringify()), ("why", &e.to_string())]))?
        > 0;
    let reason = if exact || has_messages { defaults::text("mesh_write.reason_no_inbox_path") } else { defaults::text("mesh_write.reason_unregistered") };
    let q = OVal::Str(id.clone()).stringify();
    let error = defaults::render(if exact || has_messages { "mesh_write.msg_no_inbox_path" } else { "mesh_write.msg_unregistered" }, &[("id", &q)]);
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(false))
        .put("id", s(&id))
        .put("reason", s(reason))
        .put("error", s(&error))
        .put("repoKey", caller_key.as_deref().map_or(OVal::Null, s))
        .put("storePath", OVal::Str(union::store_dir(&inv.home, &repo_key).to_string_lossy().into_owned()))
        .put("cwd", s(&inv.cwd))
        .put("meshPartitionIds", OVal::Arr(vec![s(&id)]))
        .put("known", OVal::Bool(false))
        .put("storeUnavailable", OVal::Bool(false))
        .put("storeUnavailableReason", OVal::Null)
        .put("meshGroupUnresolved", OVal::Bool(false))
        .put("meshGroupError", OVal::Null)
        .put("totalsPartial", OVal::Bool(true));
    Ok(Found::Out(Answer { code: 2, stdout: format!("{}\n", o.done().stringify()), effect: Effect::None }))
}

/// What a read cut short: the rows withheld and the cap that withheld them (Node's `truncated`, `truncatedCount`, `limit`).
pub(crate) struct Truncation {
    pub count: usize,
    pub limit: usize,
}

impl Truncation {
    /// The `truncated*` fields, in Node's order; `hint` is the verb's text with {count} and {limit}.
    pub(crate) fn put(&self, o: &mut Obj, hint: &str) {
        let text = defaults::fill(hint, &[("count", &self.count), ("limit", &self.limit)]);
        o.put("truncated", OVal::Bool(true)).put("truncatedCount", n(self.count as f64)).put("limit", n(self.limit as f64)).put("truncatedHint", s(&text));
    }
}

/// The per-call cap on store rows (`--limit N`: a finite positive number, floored, at least 1; anything else is ignored). The rows
/// past it are withheld, the counts keep the real totals, and nothing past the cap is ever acked.
pub(crate) fn limit_of(a: &Args) -> usize {
    a.one(defaults::text("mesh_write.flag_limit"))
        .map(crate::checks::guardkit::text::js_number_of_str)
        .filter(|x| x.is_finite() && *x > 0.0)
        .map_or(defaults::num("mesh_write.inbox_read_limit") as usize, |x| x.floor().max(1.0) as usize)
}

/// The cut a count made, when it made one.
fn truncation(c: &tick::Counted) -> Option<Truncation> {
    (c.truncated > 0).then_some(Truncation { count: c.truncated, limit: c.limit })
}

/// A sibling partition's row as `read` lists it: `partitionId` first, then the row's own fields.
fn sibling_row(pid: &str, r: &serde_json::Value) -> OVal {
    let OVal::Obj(fields) = crate::meshw::readprimary::store_row(r) else { return OVal::Null };
    let mut o = Obj::default();
    o.put("partitionId", s(pid));
    for (k, v) in fields {
        o.put(&k, v);
    }
    o.done()
}

/// `inbox <verb> <id>`'s id as the dispatcher reads it (`positionals[2]`; further words and flags the verb does not read are
/// ignored, as in Node): a missing or unsafe id is the dispatcher's refusal (exit 2).
fn plain_id(a: &Args) -> Result<&str, Answer> {
    match a.positionals.get(2).map(String::as_str).filter(|i| is_safe_id(i)) {
        Some(id) => Ok(id),
        None => {
            let mut o = Obj::default();
            o.put("ok", OVal::Bool(false)).put("error", s(defaults::text("devswarm_cli.msg_bad_id")));
            Err(Answer { code: 2, stdout: format!("{}\n", o.done().stringify()), effect: Effect::None })
        }
    }
}

/// `inboxWindowRejection` for `inbox <sub> <id>`: `--since` / `--tail` on a verb that acks or reports on a contiguous prefix is
/// refused (printed, exit 2) before anything is read.
fn window(inv: &Inv, a: &Args, sub: &str) -> R<Option<Answer>> {
    let Some(id) = a.positionals.get(2).map(String::as_str).filter(|i| is_safe_id(i)) else { return Ok(None) };
    crate::meshw::readprimary::window_refusal(inv, a, id, sub)
}

/// `inbox count <id>`: the unread count of a single registered partition, read only.
pub fn run_count(inv: &Inv, a: &Args) -> R<Answer> {
    if let Some(refused) = window(inv, a, defaults::text("mesh_write.verb_count"))? {
        return Ok(refused);
    }
    let raw = match plain_id(a) {
        Ok(r) => r,
        Err(refusal) => return Ok(refusal),
    };
    let (id, desc, resolved_from, redirected_from) = match locate(inv, defaults::text("mesh_write.verb_count"), raw, false, true)? {
        Found::Go { id, desc, resolved_from, redirected_from } => (id, desc, resolved_from, redirected_from),
        Found::Out(refused) => return Ok(refused),
    };
    let id = id.as_str();
    let counted = tick::count_mail(inv, id, &desc, limit_of(a))?;
    let result = tick::count_obj(inv, id, &counted, defaults::text("mesh_write.verb_count"), resolved_from.as_deref(), redirected_from.as_deref()).done();
    tick::emit_known_warning(defaults::text("mesh_write.verb_count"), &result);
    Ok(Answer { code: 0, stdout: format!("{}\n", result.stringify()), effect: Effect::None })
}

/// `inbox read <id>`: the unread rows of both channels, read only (nothing is acked, and the result says so).
pub fn run_read(inv: &Inv, a: &Args) -> R<Answer> {
    if let Some(refused) = window(inv, a, defaults::text("mesh_write.verb_read"))? {
        return Ok(refused);
    }
    let raw = match plain_id(a) {
        Ok(r) => r,
        Err(refusal) => return Ok(refusal),
    };
    let (id, desc, resolved_from, redirected_from) = match locate(inv, defaults::text("mesh_write.verb_read"), raw, false, true)? {
        Found::Go { id, desc, resolved_from, redirected_from } => (id, desc, resolved_from, redirected_from),
        Found::Out(refused) => return Ok(refused),
    };
    let id = id.as_str();
    let c = tick::count_mail(inv, id, &desc, limit_of(a))?;
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(true)).put("action", s(defaults::text("mesh_write.action_read"))).put("id", s(id));
    if let Some(f) = &resolved_from {
        o.put("resolvedFrom", s(f));
    }
    if let Some(f) = &redirected_from {
        o.put("redirected", OVal::Bool(true)).put("redirectedFrom", s(f));
    }
    o.put("repoKey", c.repo_key.as_deref().map_or(OVal::Null, s))
        .put("storePath", OVal::Str(union::store_dir(&inv.home, &c.store_key).to_string_lossy().into_owned()))
        .put("cwd", s(&inv.cwd))
        .put("meshPartitionIds", OVal::Arr(c.mesh_ids.iter().map(|x| s(x)).collect()))
        .put("lines", OVal::Arr(c.nd_lines.iter().map(|l| s(l)).collect()))
        .put(
            "meshMessages",
            OVal::Arr(
                c.store_rows
                    .iter()
                    .map(crate::meshw::readprimary::store_row)
                    .chain(c.siblings.iter().flat_map(|sib| sib.delivered.iter().take(sib.kept).map(|r| sibling_row(&sib.id, r))))
                    .collect(),
            ),
        )
        .put("unreadTotal", n(c.unread as f64))
        .put("unreadNdjson", n(c.nd_unread as f64))
        .put("unreadStore", n(c.store_unread as f64))
        .put("cursorNdjson", n(c.nd_cursor))
        .put("cursorStore", n(c.store_cursor))
        .put("total", n(c.total as f64));
    tick::put_known_block(&mut o, &c);
    if c.gap_withheld > 0 {
        o.put("meshGapWithheld", OVal::Bool(true)).put("meshGapWithheldCount", n(c.gap_withheld as f64));
    }
    if let Some(t) = truncation(&c) {
        t.put(&mut o, defaults::text("mesh_write.truncated_hint"));
    }
    if c.unread > 0 {
        o.put("cursorAdvanced", OVal::Bool(false)).put(
            "ackHint",
            OVal::Str(defaults::render("mesh_write.read_ack_hint", &[("total", &c.unread), ("nd", &c.nd_unread), ("store", &c.store_unread), ("id", &id)])),
        );
    }
    o.put("count", n(c.unread as f64)).put("cursor", n(c.nd_cursor)).put("storeCursor", n(c.store_cursor));
    let result = o.done();
    tick::emit_known_warning(defaults::text("mesh_write.action_read"), &result);
    Ok(Answer { code: 0, stdout: format!("{}\n", result.stringify()), effect: Effect::None })
}

/// `inbox ack <id>`: consume everything this read saw, on both channels, and say where the cursors stand.
///
/// The NDJSON side moves to the position the read snapshot ended at (never the live file's tail), the store side to the highest
/// store position that was delivered, and only a caller that owns the id moves the store side (a caller whose identity resolves to
/// a DIFFERENT registered row is refused, which is Node's). Every refusal and every move the engine does not apply is decided
/// before the first write.
pub fn run_ack(inv: &Inv, a: &Args) -> R<Answer> {
    if let Some(refused) = window(inv, a, defaults::text("mesh_write.verb_ack"))? {
        return Ok(refused);
    }
    let id = match plain_id(a) {
        Ok(r) => r,
        Err(refusal) => return Ok(refusal),
    };
    // `!!flags['ack-as-owner']`: passed at all, with or without a value
    let ack_as_owner = a.has(defaults::text("mesh_write.flag_ack_as_owner"));
    common::seat_check(inv)?;
    let (id, desc, resolved_from, redirected_from) = match locate(inv, defaults::text("mesh_write.verb_ack"), id, ack_as_owner, true)? {
        Found::Go { id, desc, resolved_from, redirected_from } => (id, desc, resolved_from, redirected_from),
        Found::Out(refused) => return Ok(refused),
    };
    let id = id.as_str();
    // `locate` only returns a descriptor with an inbox path
    let inbox = union::path_field(&desc, defaults::text("mesh_write.field_inbox_path"))?.unwrap_or_default();
    let c = tick::count_mail(inv, id, &desc, limit_of(a))?;
    let q = |t: &str| OVal::Str(t.to_string()).stringify();
    let refuse = |o: Obj| Ok(Answer { code: 2, stdout: format!("{}\n", o.done().stringify()), effect: Effect::None });
    // the id-derived authority gate: `ack` advances a cursor, so only a positive cross-project mismatch refuses (any other store
    // failure keeps the ack of the NDJSON side, whose mail is readable from anywhere)
    if let Some(u) = c.unavail.as_ref().filter(|u| u.reason == defaults::text("mesh_write.reason_ctx_mismatch")) {
        let mut o = Obj::default();
        o.put("action", s(defaults::text("mesh_write.verb_ack"))).put("acked", n(0.0)).put("cursor", OVal::Null);
        let tail = defaults::render("mesh_write.msg_ctx_mismatch_ack_tail", &[("id", &id)]);
        let error = format!(
            "{}{}{} — {tail}",
            defaults::render("mesh_write.msg_ctx_mismatch_head", &[("id", &q(id)), ("registered", &q(u.registered.as_deref().unwrap_or_default()))]),
            match u.caller.as_deref() {
                Some(cl) => defaults::render("mesh_write.msg_ctx_mismatch_other", &[("caller", &q(cl))]),
                None => defaults::text("mesh_write.msg_ctx_mismatch_none").to_string(),
            },
            ""
        );
        o.put("ok", OVal::Bool(false))
            .put("id", s(id))
            .put("reason", s(defaults::text("mesh_write.reason_ctx_mismatch")))
            .put("registeredRepoKey", u.registered.as_deref().map_or(OVal::Null, s))
            .put("callerRepoKey", u.caller.as_deref().map_or(OVal::Null, s))
            .put("error", s(&error));
        return refuse(o);
    }
    let Some(cursor_file) = union::path_field(&desc, defaults::text("mesh_write.field_cursor_path"))? else {
        let mut o = Obj::default();
        o.put("ok", OVal::Bool(false)).put("error", s(&defaults::render("mesh_write.msg_no_cursor_path", &[("id", &q(id))])));
        return refuse(o);
    };
    let trunc = truncation(&c);
    // `--to N`: the NDJSON position alone moves to N (a number, held to the inbox's line count); the store side is left as it is
    let to_raw = a.one(defaults::text("mesh_write.flag_to"));
    let explicit = match to_raw {
        None => None,
        Some(raw) => {
            let x = crate::checks::guardkit::text::js_number_of_str(raw);
            if !x.is_finite() {
                let mut o = Obj::default();
                o.put("ok", OVal::Bool(false)).put("error", s(defaults::text("mesh_write.msg_ack_to_not_number")));
                return Ok(Answer { code: 2, stdout: format!("{}\n", o.done().stringify()), effect: Effect::None });
            }
            Some(x)
        }
    };
    // a store the count could not use is not written either: the NDJSON position alone moves
    let st = if c.unavail.is_none() { Some(common::open_store(inv, &c.store_key)?) } else { None };
    let rows = match &st {
        Some(st) => ident::rows_of(&st.reader().roster().or_else(|e| ident::refuse_text("mesh_write.msg_registry_unreadable", &[("why", &e.to_string())]))?),
        None => Vec::new(),
    };
    // the ownership gate: a caller that is a DIFFERENT registered row is refused (Node's); one that resolves to nothing acks the
    // NDJSON side and leaves the store side alone
    let mut owns_store = st.is_some();
    if !ack_as_owner && st.is_some() {
        let caller = ident::caller_identity_detailed(&inv.env, &inv.cwd)?;
        let own_entry = resolve_mesh_target(inv, None, &rows, Some(caller.identity.as_str()))?;
        let owns = caller.identity == id
            || own_entry.as_ref().is_some_and(|e| e.id == id)
            || ident::declared_self_id(&inv.env, &inv.cwd, &rows)?.as_deref() == Some(id);
        if !owns && own_entry.is_some() {
            // refused whole, before either cursor moves
            let cause = defaults::text(if caller.kind == defaults::text("mesh_write.kind_unresolvable") {
                "mesh_write.cause_unresolvable"
            } else {
                "mesh_write.cause_mismatch"
            });
            let q = |t: &str| OVal::Str(t.to_string()).stringify();
            let error = defaults::render("mesh_write.msg_ack_refused", &[("cause", &cause), ("caller", &q(&caller.identity)), ("id", &q(id)), ("rawid", &id)]);
            let mut who = Obj::default();
            who.put("id", s(&caller.identity)).put("kind", s(&caller.kind));
            let mut o = Obj::default();
            o.put("ok", OVal::Bool(false))
                .put("action", s(defaults::text("mesh_write.verb_ack")))
                .put("reason", s(cause))
                .put("error", s(&error))
                .put("id", s(id))
                .put("callerIdentity", s(&caller.identity))
                .put("identity", who.done());
            return Ok(Answer { code: 2, stdout: format!("{}\n", o.done().stringify()), effect: Effect::None });
        }
        owns_store = owns;
    }
    // each sibling of the mesh group is judged now: a live one is not this caller's to ack
    let mut skipped_gate: Vec<bool> = Vec::new();
    if let Some(st) = st.as_ref().filter(|_| owns_store && explicit.is_none()) {
        crate::meshw::summary::check(st, inv, None)?;
        for sib in &c.siblings {
            skipped_gate.push(crate::meshw::meshgroup::ack_gate(inv, &rows, id, &sib.id).unwrap_or(true));
        }
    }
    let mut live_skipped: Vec<OVal> = Vec::new();
    // ---- writes ----
    let reader = cursors::reader_key(tick::reader_nonce_cached(&inv.home).as_deref());
    let nonce = reader.as_deref().map(cursors::short_nonce);
    let mut procs = cursors::Procs::default();
    // `ackFor` imports a partition's legacy cursor files into floor rows the first time it moves it
    if let Some(st) = &st {
        let mut targets: Vec<&str> = vec![id];
        if owns_store && explicit.is_none() {
            targets.extend(c.siblings.iter().zip(&skipped_gate).filter(|(_, g)| !**g).map(|(sib, _)| sib.id.as_str()));
        }
        for partition in targets {
            if cursors::rows_of(st, partition).is_ok_and(|rows| cursors::needs_import(&rows)) {
                let mut cx = crate::migrate::readercur::Cx::new(&inv.home.to_string_lossy());
                if let Ok(h) = crate::migrate::readercur::open(&inv.home, &c.store_key, false) {
                    crate::discard::harmless(crate::migrate::readercur::import_legacy(&mut cx, &h, partition, Some(&cursor_file), false)); // keep: a failed import is reported by the move that follows
                }
            }
        }
    }
    // the NDJSON side: the position the read ended at, never past the inbox as it is now
    let lines_now = union::non_empty_lines(&inbox)?.map_or(0, |l| l.len()) as f64;
    let nd_to = explicit.unwrap_or(c.nd_target).max(0.0).floor().min(lines_now);
    let nd_cursor_now = if let Some(st) = &st {
        let nd = cursors::ack_for(st, &inv.home, id, defaults::text("mesh_write.cursor_ns_nd"), reader.as_deref(), nd_to, &mut procs);
        if nd.ok {
            crate::meshw::mark_committed();
        }
        cursors::log_cursor_write(
            &inv.home,
            &cursors::LogRec {
                id,
                caller_id: Some(id),
                ns: defaults::text("mesh_write.log_ns_nd"),
                from: nd.from,
                to: if nd.ok { nd.own.map(|x| x as f64) } else { Some(nd_to) },
                delivered: None,
                nonce: nonce.clone(),
                gate: defaults::text("mesh_write.gate_min_floor"),
                verb: defaults::text(if explicit.is_some() { "mesh_write.verb_log_ack_to" } else { "mesh_write.verb_log_ack_all" }),
                cwd: None, // absent for the CLI: Node's `ctx.cwd` is unset there
                ok: nd.ok,
                err: if nd.ok { None } else { nd.error.as_deref() },
                repo_key: Some(&c.store_key),
            },
        );
        if !nd.ok {
            // `commitNdAck` throws on a failed ack and the dispatcher reports it: nothing was acked, the mail is still unread
            let mut o = Obj::default();
            o.put("ok", OVal::Bool(false)).put("error", s(nd.error.as_deref().unwrap_or(defaults::text("mesh_write.err_nd_ack_failed"))));
            return refuse(o);
        }
        // the legacy projection of the NDJSON floor: the descriptor's cursor file, upward only, best effort
        if let Some(fl) = nd.floor.filter(|f| *f > 0)
            && cursors::read_cursor(std::path::Path::new(&cursor_file)) < fl as f64
        {
            crate::discard::harmless(cursors::ack_to(std::path::Path::new(&cursor_file), fl as f64)); // keep: the projection is best-effort in Node
        }
        nd.own.map_or(0.0, |x| x as f64)
    } else {
        // no store handle: the descriptor's cursor file is advanced directly (monotone), the position a store-less count reads
        let path = std::path::Path::new(&cursor_file);
        let target = nd_to.max(cursors::read_cursor(path));
        crate::meshw::mark_committed();
        match cursors::ack_to(path, target) {
            Ok(()) => target,
            Err(e) => {
                let mut o = Obj::default();
                o.put("ok", OVal::Bool(false)).put("error", s(&e.to_string()));
                return refuse(o);
            }
        }
    };
    let mut failures: Vec<OVal> = Vec::new();
    if let Some(st) = st.as_ref().filter(|_| owns_store && explicit.is_none()) {
        let max_index = c.store_rows.iter().filter_map(|r| r["index"].as_f64()).fold(None, |m: Option<f64>, i| Some(m.map_or(i, |x| x.max(i))));
        let to = max_index.map_or(c.store_cursor, |m| c.store_cursor.max(m));
        let r = cursors::ack_for(st, &inv.home, id, defaults::text("mesh_write.ns_store"), reader.as_deref(), to, &mut procs);
        cursors::log_cursor_write(
            &inv.home,
            &cursors::LogRec {
                id,
                caller_id: Some(id),
                ns: defaults::text("mesh_write.log_ns_store"),
                from: r.from,
                to: if r.ok { r.own.map(|x| x as f64) } else { Some(to) },
                delivered: Some(c.store_rows.len() as f64),
                nonce: nonce.clone(),
                gate: defaults::text("mesh_write.gate_owner"),
                verb: defaults::text("mesh_write.verb_log_ack"),
                cwd: None, // absent for the CLI: Node's `ctx.cwd` is unset there
                ok: r.ok,
                err: if r.ok { None } else { r.error.as_deref() },
                repo_key: Some(&c.store_key),
            },
        );
        if let Some(e) = &r.error {
            let mut f = Obj::default();
            f.put("partitionId", s(id)).put("channel", s(defaults::text("mesh_write.channel_store_cursor"))).put("error", s(e));
            failures.push(f.done());
        }
        // the siblings of the mesh group: each moves to where this read left it, never past a row it withheld
        for (sib, gated) in c.siblings.iter().zip(&skipped_gate) {
            if *gated {
                live_skipped.push(s(&sib.id));
                continue;
            }
            let target = sib.cursor + sib.physical;
            let r = cursors::ack_for(st, &inv.home, &sib.id, defaults::text("mesh_write.ns_store"), reader.as_deref(), target, &mut procs);
            cursors::log_cursor_write(
                &inv.home,
                &cursors::LogRec {
                    id: &sib.id,
                    caller_id: Some(id),
                    ns: defaults::text("mesh_write.log_ns_store"),
                    from: r.from,
                    to: if r.ok { r.own.map(|x| x as f64) } else { Some(target) },
                    delivered: Some(sib.kept as f64),
                    nonce: nonce.clone(),
                    gate: defaults::text("mesh_write.gate_sibling"),
                    verb: defaults::text("mesh_write.verb_log_ack"),
                    cwd: None,
                    ok: r.ok,
                    err: if r.ok { None } else { r.error.as_deref() },
                    repo_key: Some(&c.store_key),
                },
            );
            if let Some(e) = &r.error {
                let mut f = Obj::default();
                f.put("partitionId", s(&sib.id)).put("channel", s(defaults::text("mesh_write.channel_sibling_store"))).put("error", s(e));
                failures.push(f.done());
            }
        }
        if let Some(why) = crate::meshw::summary::derive_after_write(st, inv, &c.store_key) {
            crate::meshw::log_summary_failure(defaults::text("mesh_write.verb_ack"), &why);
        }
    }
    let mut out = Obj::default();
    out.put("ok", OVal::Bool(true))
        .put("action", s(defaults::text("mesh_write.verb_ack")))
        .put("id", s(id))
        .put("cursor", n(nd_cursor_now))
        .put("total", n(union::non_empty_lines(&inbox)?.map_or(0, |l| l.len()) as f64));
    // how the store side and the mesh group read (`readSideKnown`, `storeUnavailableOut`), without the fields a count adds around them
    let mut known = Obj::default();
    tick::put_known_block(&mut known, &c);
    for (k, v) in known.0.into_iter().filter(|(k, _)| !matches!(k.as_str(), "meshGroupUnresolved" | "meshGroupError" | "totalsPartial")) {
        out.put(&k, v);
    }
    if let Some(f) = &resolved_from {
        out.put("resolvedFrom", s(f));
    }
    if let Some(f) = &redirected_from {
        out.put("redirected", OVal::Bool(true)).put("redirectedFrom", s(f));
    }
    if !failures.is_empty() {
        out.put("cursorWriteFailures", OVal::Arr(failures)).put("cursorPersisted", OVal::Bool(false));
    }
    if !live_skipped.is_empty() {
        out.put("liveSiblingsSkipped", OVal::Arr(live_skipped));
    }
    if let Some(e) = &c.mesh_error {
        out.put("meshGroupUnresolved", OVal::Bool(true)).put("meshGroupError", s(e)).put("totalsPartial", OVal::Bool(true));
    }
    if c.gap_withheld > 0 {
        out.put("meshGapWithheld", OVal::Bool(true)).put("meshGapWithheldCount", n(c.gap_withheld as f64));
    }
    if let Some(t) = &trunc {
        t.put(&mut out, defaults::text("mesh_write.truncated_hint_ack"));
    }
    let result = out.done();
    tick::emit_known_warning(defaults::text("mesh_write.verb_ack"), &result);
    Ok(Answer { code: 0, stdout: format!("{}\n", result.stringify()), effect: Effect::None })
}

/// `maybePromoteUnclaimed`, before the ensure: a row stamped `unclaimed:` is promoted by the session the caller proves it owns (its
/// `--session`, or `CLAUDE_CODE_SESSION_ID`). Where Node would not promote (the caller is a reconcile sweep, its session is no real
/// one, it does not own the row) or the promotion cannot be made, the row is left as it is and the pull goes on, as Node's does.
/// Returns the descriptor as it is afterwards and the session it was promoted to.
pub(crate) fn promote_preface(inv: &Inv, a: &Args, id: &str, mut found: Option<OVal>) -> (Option<OVal>, Option<String>) {
    let mut promoted_to: Option<String> = None;
    let Some(d) = found.clone() else { return (found, promoted_to) };
    let marker = format!("{}{id}", defaults::text("mesh_write.synthetic_session_prefix"));
    let desc_sid = crate::meshw::pull::field_str(&d, defaults::text("mesh_write.field_session_id"));
    if desc_sid.as_deref() != Some(marker.as_str()) {
        return (found, promoted_to);
    }
    let session = a.one(defaults::text("mesh_write.flag_session")).filter(|v| !v.is_empty());
    // with no session to prove (no flag, no environment) Node promotes nothing and pulls the row as it is
    let env_sid = inv.env.get(defaults::text("mesh_write.env_session_id")).map(String::as_str).filter(|v| !v.is_empty());
    if session.is_none() && env_sid.is_none() {
        return (found, promoted_to);
    }
    // Node's ensure runs first and upserts the registry row from the descriptor, so by the time it looks the registry names the
    // descriptor's own session
    if let Ok(opened) = tick::open_partition(inv, id, &d)
        && let Ok(Some(true)) = crate::meshw::readprimary::promote(inv, a, &d, desc_sid.as_deref(), desc_sid.as_deref(), &marker, &opened.repo_key)
    {
        promoted_to = session.or(env_sid).map(|t| crate::checks::guardkit::text::js_trim(t).to_string());
    }
    found = ident::read_descriptor(&inv.home, id);
    (found, promoted_to)
}

/// `inbox pull <id>`: drain the native queue of a workspace into its durable inbox (the pull a `--child` tick runs first), and
/// say what was imported. A pull that did not succeed prints its result and exits 2, and is logged like Node's `logVerbOutcome`.
pub fn run_pull(inv: &Inv, a: &Args) -> R<Answer> {
    // `pull` is the one inbox verb wrapped in `withSelfHeal`: its result carries the heal's fields, a refusal included
    let heal = crate::meshw::pull::heal_first(inv);
    let with_heal = |mut o: OVal| {
        for (k, v) in &heal {
            if o.get(k).is_none() {
                o.set(k, v.clone());
            }
        }
        o
    };
    if let Some(mut refused) = window(inv, a, defaults::text("mesh_write.verb_pull"))? {
        if let Some(o) = OVal::parse(refused.stdout.trim_end()) {
            refused.stdout = format!("{}\n", with_heal(o).stringify());
        }
        return Ok(refused);
    }
    let id = match plain_id(a) {
        Ok(r) => r,
        Err(refusal) => return Ok(refusal),
    };
    let session = a.one(defaults::text("mesh_write.flag_session")).filter(|v| !v.is_empty());
    crate::meshw::clog::ready(inv)?;
    let (found, promoted_to) = promote_preface(inv, a, id, ident::read_descriptor(&inv.home, id));
    let repo_key = ident::resolve_context(&inv.cwd, true)?.repo_key;
    let args = crate::meshw::pull::PullArgs { session, worktree_flag: a.one(defaults::text("devswarm_cli.flag_worktree")), rows_left_by_fold: false };
    let plan = match crate::meshw::pull::prepare_ex(inv, id, found.as_ref(), &args)? {
        crate::meshw::pull::Prepared::Plan(p) => *p,
        crate::meshw::pull::Prepared::Refused(result) => return Ok(pull_answer(inv, id, repo_key.as_deref(), with_heal(result), 2)),
    };
    // the count is not printed, so nothing here depends on it: the plan only settles the lock and the native count
    let plan = plan.finish(inv, 0, true)?;
    let out = crate::meshw::pull::execute(inv, plan)?;
    if let Some(refusal) = out.refusal {
        return Ok(pull_answer(inv, id, repo_key.as_deref(), with_heal(refusal), 2));
    }
    let r = out.res;
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(r.ok))
        .put("action", s(defaults::text("mesh_write.verb_pull")))
        .put("id", s(id))
        .put("imported", n(r.imported as f64))
        .put("duplicate", n(r.duplicate as f64))
        .put("nativeCount", n(r.native_count))
        .put("locked", OVal::Bool(r.locked))
        .put("lost", n(r.lost));
    if let Some(to) = &promoted_to {
        o.put("sessionPromoted", s(to));
    }
    if let Some(alias) = &out.alias_of {
        o.put("redirectedFrom", s(alias));
    }
    if promoted_to.is_some() {
        let mut p = Obj::default();
        p.put("promoted", OVal::Bool(true));
        o.put("promotion", p.done());
    }
    if r.native_timeout {
        o.put("nativeTimeout", OVal::Bool(true));
    }
    if let Some(e) = &r.error {
        o.put("error", s(e));
    }
    let result = with_heal(o.done());
    Ok(pull_answer(inv, id, repo_key.as_deref(), result, if r.ok { 0 } else { 2 }))
}

/// A pull's answer, and its entry in the central log when it did not succeed (`logVerbOutcome`).
fn pull_answer(inv: &Inv, id: &str, repo_key: Option<&str>, result: OVal, code: i32) -> Answer {
    if code != 0 {
        let msg = ["error", "reason"]
            .iter()
            .find_map(|k| crate::meshw::pull::field_str(&result, k))
            .unwrap_or_else(|| defaults::text("mesh_write.msg_verb_not_ok").to_string());
        crate::meshw::clog::refusal(
            inv,
            defaults::text("mesh_write.log_op_inbox_pull"),
            repo_key,
            Some(id),
            &msg,
            crate::meshw::pull::field_str(&result, "reason").as_deref(),
        );
    }
    Answer { code, stdout: format!("{}\n", result.stringify()), effect: Effect::None }
}
