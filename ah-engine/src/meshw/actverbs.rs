//! The DevSwarm CLI verbs of lane l8c that act on the per-project store: `done`, `relay` and `archive-request` (and the
//! read-only refusals of `primary` and `nudge`), ported from `scripts/devswarm-lib/misc-verbs.js` (`cmdDone`, `cmdNudge`),
//! `send.js` (`cmdRelay`), `archive.js` (`cmdArchiveRequest`, `resolveArchiveId`) and `register.js` (`cmdPrimary`).
//!
//! The rules are those of the other store verbs ([`crate::meshw::send`], [`crate::meshw::wsverbs`]):
//!
//! * the engine answers the successful path it can reproduce byte for byte; every refusal that Node logs to the central log
//!   (`logVerbOutcome`) is a [`Defer`] decided BEFORE the first write, so Node prints and logs it;
//! * a verb defers (before writing) when its answer needs evidence the engine does not read: session liveness, an
//!   unresolved mesh group, a plan the engine cannot treat like JavaScript, a sender alias that has to be written;
//! * once the first row is written nothing defers any more (`mark_committed`): a late failure is a committed failure and
//!   Node never repeats the write.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an unreadable optional file is the same as an absent one (fail-open, as Node's try/catch)
// A failure that must be seen goes through `crate::discard` instead.
use crate::checks::guardkit::ojson::OVal;
use crate::checks::guardkit::text::js_trim;
use crate::defaults;
use crate::dsact::runner::{RunSpec, Runner, System};
use crate::meshw::args::Args;
use crate::meshw::common::{self, Inv, Obj, n, s};
use crate::meshw::ident::{self, R, Row, defer};
use crate::meshw::idlock::{self, devswarm_root, is_safe_id};
use crate::meshw::plan;
use crate::meshw::send::{Answer, Effect, resolve_mesh_target};
use crate::meshw::store::{self, MeshStore};
use crate::meshw::wsverbs;

fn answer(code: i32, v: OVal) -> Answer {
    Answer { code, stdout: format!("{}\n", v.stringify()), effect: Effect::None }
}

/// `{ ok: false, ... }` the way a verb prints a refusal Node does not log.
fn refusal(fields: &[(&str, OVal)]) -> Answer {
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(false));
    for (k, v) in fields {
        o.put(k, v.clone());
    }
    answer(2, o.done())
}

fn quote(x: &str) -> String {
    serde_json::to_string(x).unwrap_or_default()
}

/// The project's registry rows through an open store.
fn rows_of(st: &MeshStore) -> R<Vec<Row>> {
    Ok(ident::rows_of(&st.reader().roster().map_err(|e| ident::Defer(format!("registry:{e}")))?))
}

/// `git -C <dir> rev-parse HEAD`: the trimmed answer of a clean run, else none (Node: a failure is "no head").
fn git_head(runner: &dyn Runner, dir: &str) -> Option<String> {
    let r = runner.run(&RunSpec {
        bin: Some(defaults::text("devswarm_cli.ready_git").to_string()),
        args: vec![
            defaults::text("devswarm_cli.ready_git_cwd_flag").to_string(),
            dir.to_string(),
            defaults::text("devswarm_cli.done_rev_parse").to_string(),
            defaults::text("devswarm_cli.done_head").to_string(),
        ],
        cwd: None,
        timeout_ms: defaults::num("devswarm_cli.done_git_timeout_ms"),
        cap_bytes: defaults::num("devswarm_cli.ready_git_max_bytes"),
        scrub_env: vec![],
    });
    if r.missing || r.timed_out || r.truncated || r.error.is_some() || r.status != Some(0) {
        return None;
    }
    let t = js_trim(&r.stdout);
    (!t.is_empty()).then(|| t.to_string())
}

/// `/^primary-[0-9a-f]{8}$/`.
fn is_primary_label(id: &str) -> bool {
    let hex = defaults::num("mesh_write.mesh_id_hex") as usize;
    id.strip_prefix(defaults::text("mesh_write.primary_prefix"))
        .is_some_and(|rest| rest.len() == hex && rest.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
}

/// Whether the child's sender alias is already on file (writing it is Node's).
fn alias_on_file(inv: &Inv, who: &ident::Caller) -> bool {
    if who.kind != defaults::text("mesh_write.kind_child") {
        return true;
    }
    let label = who.mesh_id.clone().unwrap_or_default();
    common::read_aliases(&inv.home).into_iter().any(|(k, v)| k == label && v == who.identity)
}

// ---- done ---------------------------------------------------------------------------------------------------------------

/// A refusal of `done` that Node logs (`logVerbOutcome('done', r.id, r, ctx)`): printed (exit 2) and written to the central log.
/// Decided before anything else is written; when Node would not write the log at all the call is Node's.
fn done_refusal(inv: &Inv, id: Option<&str>, reason: &str, error: Option<&str>, extra: &[(&str, OVal)]) -> R<Answer> {
    crate::meshw::clog::ready(inv)?;
    let mut f: Vec<(&str, OVal)> = vec![("action", s(defaults::text("devswarm_cli.action_done"))), ("reason", s(reason))];
    f.extend(extra.iter().cloned());
    if let Some(e) = error {
        f.push(("error", s(e)));
    }
    let msg = error.unwrap_or(reason);
    let repo_key = ident::resolve_context(&inv.cwd, true)?.repo_key;
    crate::meshw::clog::refusal(inv, defaults::text("devswarm_cli.action_done"), repo_key.as_deref(), id, msg, Some(reason));
    crate::meshw::mark_committed();
    Ok(refusal(&f))
}

/// `done [<id>] [--summary TEXT]`.
pub fn done(inv: &Inv, a: &Args) -> R<Answer> {
    done_with(inv, a, &System::configured())
}

/// [`done`] with the git runner given.
pub fn done_with(inv: &Inv, a: &Args, runner: &dyn Runner) -> R<Answer> {
    let cwd = inv.cwd.as_str();
    let id_arg = a.positionals.get(1).map(String::as_str);
    // the refusals below are logged by Node (`logVerbOutcome('done', ...)`): the engine writes the same log line
    let Some(repo_key) = ident::repo_key_for_worktree(cwd)? else {
        return done_refusal(inv, None, defaults::text("devswarm_cli.reason_no_project"), None, &[]);
    };
    let caller_ic = ident::resolve_context(cwd, true)?;
    let Some(wt_root) = caller_ic.worktree_root.clone() else { return defer("no-worktree") };
    if ident::is_primary_checkout(&wt_root, caller_ic.main_worktree.as_deref(), &inv.home, &inv.env)? {
        return done_refusal(
            inv,
            None,
            defaults::text("devswarm_cli.reason_done_primary_checkout"),
            Some(defaults::text("devswarm_cli.msg_done_primary_checkout")),
            &[],
        );
    }
    let st = common::open_store(inv, &repo_key)?;
    let rows = rows_of(&st)?;
    let who = ident::sender_identity_detailed(&inv.env, cwd, &rows, &inv.home)?;
    let id = who.identity.clone();
    if let Some(x) = id_arg
        && x != id
        && Some(x) != who.mesh_id.as_deref()
    {
        let msg = defaults::render("devswarm_cli.msg_done_not_own", &[("id_arg", &quote(x)), ("identity", &quote(&id))]);
        return done_refusal(inv, Some(x), defaults::text("devswarm_cli.reason_done_not_own"), Some(&msg), &[("id", s(x)), ("identity", s(&id))]);
    }
    if !is_safe_id(&id) {
        return done_refusal(inv, None, defaults::text("devswarm_cli.reason_done_no_identity"), Some(defaults::text("devswarm_cli.msg_done_no_identity")), &[]);
    }
    if is_primary_label(&id) {
        return defer("primary-label");
    }
    if !alias_on_file(inv, &who) {
        return defer("sender-alias");
    }
    // the gate summarizes the registered rows: an id nobody registered would be written and then refused
    if !rows.iter().any(|r| r.id == id) {
        return defer("not-registered");
    }
    let head = git_head(runner, &wt_root);
    // the plan the report closes, found before anything is written; a log due for rotation is Node's
    let found = plan::find_for(inv, &id, Some(&wt_root))?;
    if found.is_some() && plan::log_needs_rotation(inv) {
        return defer("supervision-log-rotation");
    }
    // the Primary's partition (`resolveMeshTarget`): more than one candidate needs liveness ranking
    let primary_mesh = match caller_ic.main_worktree.as_deref() {
        Some(m) => Some(ident::primary_workspace_id(m)?),
        None => None,
    };
    let target = match &primary_mesh {
        Some(pm) => resolve_mesh_target(&rows, Some(pm))?,
        None => None,
    };
    if target.is_some() {
        crate::meshw::summary::check(&st, inv, target.as_ref().map(|t| t.id.as_str()))?;
    }
    // ---- commit: the gate row is the first write ----
    let by = match &head {
        Some(h) => format!("{}{h}", defaults::text("devswarm_cli.done_set_by_prefix")),
        None => defaults::text("devswarm_cli.done_set_by").to_string(),
    };
    let gate_name = defaults::text("devswarm_cli.done_gate").to_string();
    let (g_ok, g) = wsverbs::gate_core(inv, &id, std::slice::from_ref(&gate_name), &[], &by)?;
    if !g_ok {
        // the gate refused (before any write) or the project's summary does not track the id (after the rows): either way
        // Node prints and logs a failure, which the engine does not
        return defer("gate-refused");
    }
    let mut out = Obj::default();
    out.put("ok", OVal::Bool(true)).put("action", s(defaults::text("devswarm_cli.action_done"))).put("id", s(&id)).put("gateSet", OVal::Bool(true));
    if let Some(gates) = g.get("gates") {
        out.put("gates", gates.clone());
    }
    out.put("messaged", OVal::Bool(false)).put("head", head.as_deref().map_or(OVal::Null, s));
    let now = inv.now as f64;
    // supervision metrics: once per plan, best effort
    if let Some(f) = &found {
        let key = f.key.clone();
        let mut first_done = false;
        let mut plan_after: Option<OVal> = None;
        let upd = plan::update_with(inv, &key, |cur| {
            let Some(mut p) = cur else { return Ok(((), None)) };
            if plan::steps_of(&p).is_empty() {
                return Ok(((), None));
            }
            p.set("done_reported_at", n(now));
            first_done = !matches!(p.get("done_at"), Some(OVal::Num(x)) if x.is_finite());
            if first_done {
                p.set("done_at", n(now));
            }
            plan_after = Some(p.clone());
            Ok(((), Some(p)))
        });
        if let Ok(Some(((), Some(text)))) = upd {
            crate::meshw::set_written(&plan::plan_rel(&key), text.as_bytes());
            if first_done && let Some(p) = &plan_after {
                record_done(inv, &id, &key, p, now);
            }
        }
    }
    if primary_mesh.is_none() {
        out.put("messageReason", s(defaults::text("devswarm_cli.done_reason_no_primary")));
        return Ok(answer(0, out.done()));
    }
    let Some(target) = target else {
        out.put("messageReason", s(defaults::text("devswarm_cli.done_reason_unregistered")));
        return Ok(answer(0, out.done()));
    };
    let dest = target.id.clone();
    let summary_text = a.one(defaults::text("mesh_write.flag_summary")).filter(|t| !t.is_empty());
    let message = format!(
        "{} {id}{}{}{}",
        defaults::text("devswarm_cli.done_marker"),
        defaults::text("devswarm_cli.done_msg_reports"),
        summary_text.map(|t| format!("{}{t}", defaults::text("devswarm_cli.done_msg_colon"))).unwrap_or_default(),
        defaults::text("devswarm_cli.done_msg_tail")
    );
    let Some(lock) = idlock::acquire(&inv.write_home, &dest) else {
        out.put("messageReason", s(&format!("{}{}", defaults::text("devswarm_cli.done_reason_prefix"), defaults::text("devswarm_cli.done_status_busy"))));
        return Ok(answer(0, out.done()));
    };
    let present = rows_of(&st).map(|r| r.iter().any(|x| x.id == dest)).unwrap_or(false);
    if !present {
        lock.release();
        out.put("messageReason", s(&format!("{}{}", defaults::text("devswarm_cli.done_reason_prefix"), defaults::text("devswarm_cli.done_status_gone"))));
        return Ok(answer(0, out.done()));
    }
    let hash =
        format!("{}{id}:{}", defaults::text("devswarm_cli.done_hash_prefix"), head.as_deref().unwrap_or(defaults::text("devswarm_cli.done_hash_nohead")));
    let nonce = ident::reader_nonce(&inv.home);
    let row =
        store::mesh_message_row(Some(&id), Some(&dest), false, &message, inv.now, defaults::text("mesh_write.urgency_default"), &hash, false, nonce.as_deref());
    let appended = st.append_mesh_row(&row);
    lock.release();
    let appended = appended.map_err(|e| ident::Defer(format!("done-append:{e}")))?;
    if let Some(why) = crate::meshw::summary::derive_after_write(&st, inv, &repo_key) {
        crate::meshw::log_summary_failure(defaults::text("devswarm_cli.verb_done"), &why);
    }
    wsverbs::note_summary(inv, &repo_key);
    out.put("messaged", OVal::Bool(true))
        .put("duplicate", OVal::Bool(!appended.inserted))
        .put("to", s(&dest))
        .put("kind", s(defaults::text("devswarm_cli.done_kind")));
    Ok(Answer { code: 0, stdout: format!("{}\n", out.done().stringify()), effect: Effect::Row(hash) })
}

/// The `done` supervision event of a plan's first report (`supervisionMetrics.record(home, 'done', ...)`), best effort.
fn record_done(inv: &Inv, id: &str, key: &str, p: &OVal, now: f64) {
    let created = match p.get("created_at") {
        Some(OVal::Num(x)) if x.is_finite() => Some(*x),
        _ => None,
    };
    let mut f: Vec<(String, OVal)> = vec![
        ("id".into(), s(id)),
        ("key".into(), s(key)),
        ("durationMs".into(), created.map_or(OVal::Null, |c| n(now - c))),
        ("stepsDone".into(), n(plan::steps_done(p) as f64)),
        ("stepsPlanned".into(), n(plan::steps_of(p).len() as f64)),
    ];
    if let Some(from) = p.get("respawn").and_then(|r| r.get("from"))
        && from.truthy()
    {
        f.push(("respawnOf".into(), from.clone()));
    }
    f.push(("tokensTotal".into(), tokens_total(inv, key)));
    if plan::record(inv, defaults::text("devswarm_cli.done_event"), &f, now).is_some() {
        plan::note_log(inv);
    }
}

/// `readState(home, key).total` rounded, else null (`devswarm-token-usage.js`).
fn tokens_total(inv: &Inv, key: &str) -> OVal {
    if !is_safe_id(key) {
        return OVal::Null;
    }
    let p = devswarm_root(&inv.home).join(defaults::text("devswarm_cli.done_tokens_dir")).join(format!("{key}{}", defaults::text("mesh_write.json_suffix")));
    let Some(OVal::Obj(o)) = std::fs::read(&p).ok().and_then(|b| OVal::parse(&String::from_utf8_lossy(&b))) else { return OVal::Null };
    match o.iter().find(|(k, _)| k == "total").map(|(_, v)| v) {
        Some(OVal::Num(t)) if t.is_finite() => n((t + 0.5).floor()),
        _ => OVal::Null,
    }
}

// ---- primary ------------------------------------------------------------------------------------------------------------

/// Whether the caller is outside the project's Primary checkout (`seatVerdict(...).state === 'n/a'`): no worktree, or a child.
/// Any other state needs the handover scan, the session transcripts or the seat holder's liveness: Node's.
pub(crate) fn seat_not_applicable(inv: &Inv) -> R<bool> {
    let c = ident::resolve_context(&inv.cwd, true)?;
    let Some(wt) = c.worktree_root.clone() else { return Ok(true) };
    Ok(!ident::is_primary_checkout(&wt, c.main_worktree.as_deref(), &inv.home, &inv.env)?)
}

/// `primary [status|takeover] [--session S]`: the answers outside a Primary checkout, which touch nothing.
pub fn primary(inv: &Inv, a: &Args) -> R<Answer> {
    let sid = a
        .one(defaults::text("devswarm_cli.flag_session"))
        .filter(|x| !x.is_empty())
        .map(str::to_string)
        .or_else(|| inv.env.get(defaults::text("mesh_write.env_session_id")).filter(|x| !x.is_empty()).cloned());
    if !seat_not_applicable(inv)? {
        return defer("primary-seat");
    }
    let sub = a.positionals.get(1).map(String::as_str);
    if sub.is_none() || sub == Some(defaults::text("devswarm_cli.sub_status")) {
        let mut o = Obj::default();
        o.put("ok", OVal::Bool(true))
            .put("action", s(defaults::text("devswarm_cli.action_primary_status")))
            .put("session", sid.as_deref().map_or(OVal::Null, s))
            .put("state", s(defaults::text("devswarm_cli.seat_state_na")));
        return Ok(answer(0, o.done()));
    }
    if sub != Some(defaults::text("devswarm_cli.sub_takeover")) {
        let shown = quote(sub.unwrap_or_default());
        return Ok(refusal(&[("error", s(&defaults::render("devswarm_cli.msg_primary_unknown_sub", &[("sub", &shown)])))]));
    }
    Ok(refusal(&[
        ("action", s(defaults::text("devswarm_cli.action_primary_takeover"))),
        ("reason", s(defaults::text("devswarm_cli.reason_not_primary_checkout"))),
        ("error", s(defaults::text("devswarm_cli.msg_primary_takeover_na"))),
    ]))
}

// ---- relay --------------------------------------------------------------------------------------------------------------

/// `relay <seq> --to ID [--note-file P]`: forward a message of the caller's own inbox, verbatim, to `--to`.
/// A read receipt (`r...`), and every refusal Node logs, are Node's.
pub fn relay(inv: &Inv, a: &Args) -> R<Answer> {
    common::seat_check(inv)?;
    let heal = common::self_heal(inv)?;
    let cwd = inv.cwd.as_str();
    let Some(repo_key) = ident::repo_key_for_worktree(cwd)? else { return defer("no-project") };
    let Some(to_flag) = a.one(defaults::text("mesh_write.flag_to")).filter(|x| !x.is_empty()) else { return defer("no-recipient") };
    let Some(seq_arg) = a.positionals.get(1).filter(|x| !x.is_empty()) else { return defer("no-seq") };
    let note = match a.one(defaults::text("devswarm_cli.flag_note_file")) {
        Some(f) => match std::fs::read(f) {
            Ok(b) => Some(String::from_utf8_lossy(&b).into_owned()),
            Err(_) => return defer("note-file"),
        },
        None => None,
    };
    let st = common::open_store(inv, &repo_key)?;
    let rows = rows_of(&st)?;
    let from = ident::sender_identity_detailed(&inv.env, cwd, &rows, &inv.home)?;
    if !alias_on_file(inv, &from) {
        return defer("sender-alias");
    }
    let caller = from.identity.clone();
    if is_receipt_id(seq_arg) {
        return defer("receipt");
    }
    let num = crate::checks::guardkit::text::js_number_of_str(seq_arg);
    if !num.is_finite() || num < 0.0 {
        return defer("bad-seq");
    }
    let seq = num.floor();
    let mut found: Option<serde_json::Value> = None;
    st.reader()
        .for_each_message(&caller, 0, |m| {
            if m["storeSeq"].as_f64() == Some(seq) {
                found = Some(m);
                return false;
            }
            true
        })
        .map_err(|e| ident::Defer(format!("relay-read:{e}")))?;
    let Some(row) = found else { return defer("message-not-found") };
    let body = row["body"].as_str().unwrap_or_default().to_string();
    if body.is_empty() {
        return defer("empty-body");
    }
    let source_bytes = body.len();
    let sender_text = match row["sender"].as_str() {
        Some(x) => x.to_string(),
        None => defaults::text("devswarm_cli.relay_null").to_string(),
    };
    let store_seq = crate::checks::jsport::num::to_js_string(row["storeSeq"].as_f64().unwrap_or(f64::NAN));
    let header = format!(
        "{}{sender_text}{}{store_seq}{}{source_bytes}{}",
        defaults::text("devswarm_cli.relay_head_from"),
        defaults::text("devswarm_cli.relay_head_seq"),
        defaults::text("devswarm_cli.relay_head_comma"),
        defaults::text("devswarm_cli.relay_head_end")
    );
    let note_suffix = match &note {
        Some(nt) if !nt.is_empty() => format!("{}{nt}", defaults::text("devswarm_cli.relay_note_join")),
        _ => String::new(),
    };
    let relayed = format!("{header}{body}{note_suffix}");
    let expected = header.len() + source_bytes + note_suffix.len();
    let mut send_args = Args { positionals: vec![defaults::text("mesh_write.verb_send").to_string()], ..Args::default() };
    send_args.flags.insert(defaults::text("mesh_write.flag_to").to_string(), vec![crate::meshw::args::FlagVal::S(to_flag.to_string())]);
    send_args.flags.insert(defaults::text("mesh_write.flag_message").to_string(), vec![crate::meshw::args::FlagVal::S(relayed)]);
    let send_res = crate::meshw::send::cmd_send(inv, &send_args)?;
    let send_ok = matches!(send_res.0.iter().find(|(k, _)| k == "ok").map(|(_, v)| v), Some(OVal::Bool(true)));
    let bytes = match send_res.0.iter().find(|(k, _)| k == "bytes").map(|(_, v)| v) {
        Some(OVal::Num(b)) => Some(*b),
        _ => None,
    };
    let effect = match send_res.0.iter().find(|(k, _)| k == "hash").map(|(_, v)| v) {
        Some(OVal::Str(h)) => Effect::Row(h.clone()),
        _ => Effect::None,
    };
    // the send wrote; a failed read-back or a short copy is a failure Node logs, which cannot be repeated now
    if !send_ok || bytes != Some(expected as f64) {
        return defer("relay-send-failed");
    }
    let mut out = Obj::default();
    out.put("ok", OVal::Bool(true))
        .put("action", s(defaults::text("devswarm_cli.action_relay")))
        .put("from", s(&caller))
        .put("to", s(to_flag))
        .put("seq", row["storeSeq"].as_f64().map_or(OVal::Null, n))
        .put("sourceBytes", n(source_bytes as f64))
        .put("relayedBytes", bytes.map_or(OVal::Null, n))
        .put("expectedBytes", n(expected as f64))
        .put("send", send_res.done());
    for (k, v) in heal {
        out.put(&k, v);
    }
    Ok(Answer { code: 0, stdout: format!("{}\n", out.done().stringify()), effect })
}

/// `/^r[a-z0-9]+$/i`.
fn is_receipt_id(x: &str) -> bool {
    let mut it = x.chars();
    matches!(it.next(), Some('r' | 'R')) && x.len() > 1 && it.all(|c| c.is_ascii_alphanumeric())
}

// ---- archive-request ----------------------------------------------------------------------------------------------------

/// `lstat` succeeds on the path (a descriptor "exists" for the id resolver whatever it is).
fn lstat_exists(p: &std::path::Path) -> bool {
    std::fs::symlink_metadata(p).is_ok()
}

/// `hasFreshHeartbeat(id, home, { now })`: the heartbeat record's `ts` (else the file's mtime) is positive, not in the future,
/// and at most the freshness window old.
pub(crate) fn has_fresh_heartbeat(inv: &Inv, id: &str) -> bool {
    let p = devswarm_root(&inv.home).join(defaults::text("mesh_write.dir_heartbeats")).join(format!("{id}{}", defaults::text("mesh_write.json_suffix")));
    let ts = match std::fs::read(&p).ok().and_then(|b| OVal::parse(&String::from_utf8_lossy(&b))) {
        Some(v) if matches!(v.get("ts"), Some(OVal::Num(x)) if x.is_finite()) => match v.get("ts") {
            Some(OVal::Num(x)) => Some(*x),
            _ => None,
        },
        _ => std::fs::metadata(&p)
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs_f64() * 1000.0),
    };
    let now = inv.now as f64;
    match ts {
        Some(t) if t.is_finite() && t > 0.0 && t <= now => now - t <= defaults::num("devswarm_sup.lv_heartbeat_fresh_ms") as f64,
        _ => false,
    }
}

/// What `resolveArchiveId` settles on: the id to post to, or the refusal Node prints for an ambiguous prefix.
pub(crate) enum Resolved {
    Id(String),
    /// The message template and the candidate ids.
    Ambiguous(&'static str, Vec<String>),
}

impl Resolved {
    /// The refusal of `action` for an ambiguous id (see [`ambiguous_for`]).
    pub(crate) fn refusal(action: &str, id_first: bool, raw: &str, template: &str, ids: &[String]) -> Answer {
        let list = ids.iter().map(String::as_str).collect::<Vec<_>>();
        ambiguous_for(action, id_first, raw, template, &list)
    }
}

/// `resolveArchiveId(raw, ctx)` for a safe id: an exact descriptor (active or archived) wins; else a unique prefix of the
/// project's workspaces; else a unique registry row of that mesh label; else the id as given.
pub(crate) fn resolve_archive_id(inv: &Inv, raw: &str) -> R<Resolved> {
    let root = devswarm_root(&inv.home);
    let file = format!("{raw}{}", defaults::text("mesh_write.json_suffix"));
    if lstat_exists(&root.join(defaults::text("mesh_write.dir_workspaces")).join(&file)) {
        return Ok(Resolved::Id(raw.to_string()));
    }
    let adir = root.join(defaults::text("mesh_write.dir_archived"));
    // checkedArchivedDir: a directory that is not a plain directory is an error Node reports as "not found"
    if std::fs::symlink_metadata(&adir).is_ok_and(|m| m.is_dir() && !m.file_type().is_symlink()) && lstat_exists(&adir.join(&file)) {
        return Ok(Resolved::Id(raw.to_string()));
    }
    let Some(worktree) = ident::resolve_caller_worktree(&inv.cwd)? else { return defer("no-worktree") };
    let Some(repo_key) = ident::repo_key_for_worktree(&worktree)? else { return defer("no-project") };
    let st = common::open_store(inv, &repo_key)?;
    let sum = crate::meshw::summary::compute(&st, inv, None)?;
    let Some(OVal::Obj(all)) = sum.get("workspaces") else { return defer("summary-shape") };
    if all.iter().any(|(k, _)| crate::checks::guardkit::ojson::is_array_index_key(k)) {
        return defer("integer-keys");
    }
    let cands: Vec<&String> = all.iter().map(|(k, _)| k).filter(|k| is_safe_id(k) && k.starts_with(raw)).collect();
    match cands.len() {
        1 => return Ok(Resolved::Id(cands[0].clone())),
        0 => {}
        _ => {
            return Ok(Resolved::Ambiguous(defaults::text("devswarm_cli.msg_ambig_prefix"), cands.into_iter().cloned().collect()));
        }
    }
    let rows = rows_of(&st)?;
    let mut mesh: Vec<String> = mesh_rows(&rows, raw)?.into_iter().filter(|r| r.id != raw && is_safe_id(&r.id)).map(|r| r.id).collect();
    mesh.sort();
    match mesh.len() {
        0 => Ok(Resolved::Id(raw.to_string())),
        1 => Ok(Resolved::Id(mesh.remove(0))),
        _ => {
            Ok(Resolved::Ambiguous(defaults::text("devswarm_cli.msg_ambig_mesh"), mesh))
        }
    }
}

fn mesh_rows(rows: &[Row], mesh_id: &str) -> R<Vec<Row>> {
    crate::meshw::send::mesh_candidates(rows, Some(mesh_id))
}

/// The refusal for an ambiguous prefix or mesh label: `{ action, ok:false, error, candidates, id }`.
/// The refusal of `verb` for an ambiguous id. `id_first` is the shape `Object.assign({ action, id }, resolved)` prints
/// (`unarchive`): `action, id, ok, error, candidates`; else `action, ok, error, candidates, id` (`archive-request`).
fn ambiguous_for(action: &str, id_first: bool, raw: &str, template: &str, ids: &[&str]) -> Answer {
    let msg = crate::checks::devswarm_role::text::fill_once(
        template,
        &[("id", &quote(raw)), ("n", &ids.len().to_string()), ("ids", &ids.join(defaults::text("devswarm_cli.msg_ids_join")))],
    );
    let mut o = Obj::default();
    o.put("action", s(action));
    if id_first {
        o.put("id", s(raw));
    }
    o.put("ok", OVal::Bool(false)).put("error", s(&msg)).put("candidates", OVal::Arr(ids.iter().map(|x| s(x)).collect()));
    if !id_first {
        o.put("id", s(raw));
    }
    answer(2, o.done())
}

/// `archive-request <childId> [--reason TEXT]`: post the archive request into the child's own partition.
pub fn archive_request(inv: &Inv, a: &Args) -> R<Answer> {
    let id = a.positionals.get(1).map(String::as_str).unwrap_or("");
    if !is_safe_id(id) {
        return Ok(refusal(&[("error", s(defaults::text("devswarm_cli.msg_bad_id")))]));
    }
    let raw_id = id;
    let id = match resolve_archive_id(inv, id)? {
        Resolved::Id(x) => x,
        Resolved::Ambiguous(tpl, ids) => return Ok(Resolved::refusal(defaults::text("devswarm_cli.action_archive_request"), false, raw_id, tpl, &ids)),
    };
    let heal = common::self_heal(inv)?;
    let cwd = inv.cwd.as_str();
    let Some(repo_key) = ident::repo_key_for_worktree(cwd)? else { return defer("no-project") };
    // a registered target with no live session is archived directly instead: Node's
    if ident::read_descriptor(&inv.home, &id).is_some() && !has_fresh_heartbeat(inv, &id) {
        return defer("target-liveness");
    }
    let reason = a.one(defaults::text("devswarm_cli.flag_reason")).filter(|r| !r.is_empty());
    let message = match reason {
        Some(r) => format!("{} {r} — {}", defaults::text("devswarm_cli.archive_marker"), defaults::text("devswarm_cli.archive_tail")),
        None => format!("{} — {}", defaults::text("devswarm_cli.archive_marker"), defaults::text("devswarm_cli.archive_tail")),
    };
    let st = common::open_store(inv, &repo_key)?;
    let rows = rows_of(&st)?;
    let who = ident::sender_identity_detailed(&inv.env, cwd, &rows, &inv.home)?;
    if !alias_on_file(inv, &who) {
        return defer("sender-alias");
    }
    let from = who.identity;
    crate::meshw::summary::check(&st, inv, Some(&id))?;
    let Some(lock) = idlock::acquire(&inv.write_home, &id) else { return defer("lock-busy") };
    let hash = store::mesh_message_hash(
        Some(&from),
        Some(&id),
        defaults::text("mesh_write.mtype_direct"),
        defaults::text("devswarm_cli.archive_urgency"),
        &message,
        &inv.now.to_string(),
        false,
    );
    let nonce = ident::reader_nonce(&inv.home);
    let row = store::mesh_message_row(
        Some(&from),
        Some(&id),
        false,
        &message,
        inv.now,
        defaults::text("devswarm_cli.archive_urgency"),
        &hash,
        false,
        nonce.as_deref(),
    );
    let appended = st.append_mesh_row(&row);
    lock.release();
    let appended = appended.map_err(|e| ident::Defer(format!("archive-request-append:{e}")))?;
    crate::meshw::mark_committed();
    if let Some(why) = crate::meshw::summary::derive_after_write(&st, inv, &repo_key) {
        crate::meshw::log_summary_failure(defaults::text("devswarm_cli.verb_archive_request"), &why);
    }
    wsverbs::note_summary(inv, &repo_key);
    let mut out = Obj::default();
    out.put("ok", OVal::Bool(true))
        .put("action", s(defaults::text("devswarm_cli.action_archive_request")))
        .put("id", s(&id))
        .put("childId", s(&id))
        .put("posted", OVal::Bool(true))
        .put("sent", OVal::Bool(appended.inserted))
        .put("seq", appended.seq.map_or(OVal::Null, |x| n(x as f64)))
        .put("reason", reason.map_or(OVal::Null, s))
        .put("reminder", s(defaults::text("devswarm_cli.archive_reminder")));
    for (k, v) in heal {
        out.put(&k, v);
    }
    Ok(Answer { code: 0, stdout: format!("{}\n", out.done().stringify()), effect: Effect::Row(hash) })
}

// ---- nudge --------------------------------------------------------------------------------------------------------------

/// `nudge <id>`: the engine answers only the refusal for an id nothing is registered under. A workspace with a descriptor
/// would have its nudge command fired (or be escalated), which only Node does.
pub fn nudge(inv: &Inv, a: &Args) -> R<Answer> {
    let id = a.positionals.get(1).map(String::as_str).unwrap_or("");
    if !is_safe_id(id) {
        return Ok(refusal(&[("error", s(defaults::text("devswarm_cli.msg_bad_id")))]));
    }
    if ident::read_descriptor(&inv.home, id).is_some() {
        return defer("descriptor");
    }
    // a mesh label or registry id `send` would resolve may lead to a descriptor under another name
    if let Some(repo_key) = ident::repo_key_for_worktree(&inv.cwd)? {
        let st = common::open_store(inv, &repo_key)?;
        let rows = rows_of(&st)?;
        if rows.iter().any(|r| r.id == id) || !crate::meshw::send::mesh_candidates(&rows, Some(id))?.is_empty() {
            return defer("resolvable-target");
        }
    }
    Ok(refusal(&[("error", s(&defaults::render("devswarm_cli.msg_nudge_no_descriptor", &[("id", &quote(id))])))]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_receipt_id_is_an_r_and_alphanumerics() {
        assert!(is_receipt_id("r123abc"));
        assert!(is_receipt_id("R9"));
        assert!(!is_receipt_id("r"));
        assert!(!is_receipt_id("12"));
        assert!(!is_receipt_id("r1-2"));
    }

    #[test]
    fn a_primary_label_is_primary_and_eight_lower_hex() {
        defaults::init().unwrap();
        assert!(is_primary_label("primary-0123abcd"));
        assert!(!is_primary_label("primary-0123ABCD"));
        assert!(!is_primary_label("primary-0123abc"));
        assert!(!is_primary_label("child-1"));
    }
}
