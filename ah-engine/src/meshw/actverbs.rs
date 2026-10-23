//! The DevSwarm CLI verbs of lane l8c that act on the per-project store: `done`, `relay` and `archive-request` (and the
//! read-only refusals of `primary` and `nudge`), ported from `scripts/devswarm-lib/misc-verbs.js` (`cmdDone`, `cmdNudge`),
//! `send.js` (`cmdRelay`), `archive.js` (`cmdArchiveRequest`, `resolveArchiveId`) and `register.js` (`cmdPrimary`).
//!
//! The rules are those of the other store verbs ([`crate::meshw::send`], [`crate::meshw::wsverbs`]):
//!
//! * the engine answers every case, the refusals included: a refusal Node logs to the central log (`logVerbOutcome`) is printed
//!   (exit 2) and written to that log by the engine;
//! * a failure that Node raises as an exception (a store that cannot be opened, a file that cannot be written) is printed the way
//!   `run()`'s catch prints it (`{ ok: false, error }`, exit 2) and logged;
//! * once the first row is written nothing is repeated (`mark_committed`): a late failure is a committed failure and Node never
//!   repeats the write.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an unreadable optional file is the same as an absent one (fail-open, as Node's try/catch)
// A failure that must be seen goes through `crate::discard` instead.
use crate::checks::guardkit::ojson::OVal;
use crate::checks::guardkit::text::js_trim;
use crate::defaults;
use crate::dsact::runner::{RunSpec, Runner, System};
use crate::meshw::args::Args;
use crate::meshw::common::{self, Inv, Obj, n, s};
use crate::meshw::ident::{self, R, Row};
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

pub(crate) fn quote(x: &str) -> String {
    serde_json::to_string(x).unwrap_or_default()
}

/// The project's registry rows through an open store: `registrySnapshot` is fail-open, a store that cannot be read has no rows.
fn rows_of(st: &MeshStore) -> Vec<Row> {
    ident::rows_of(&st.reader().roster().unwrap_or_default()) // keep: Node's registrySnapshot answers [] on any store error
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

// ---- done ---------------------------------------------------------------------------------------------------------------

/// `String(x)` of a parsed value (see [`crate::meshw::simple::js_text`]).
use crate::meshw::simple::js_text;

/// A failed `done` as Node prints it (`{ ok: false, ... }`, exit 2) and logs it (`logVerbOutcome('done', r.id, r, ctx)`): the
/// message is the result's `error`, else its `reason`. `fields` are the result's keys in order; `id` is the result's `id`.
fn done_fail(inv: &Inv, id: Option<&str>, fields: Vec<(String, OVal)>) -> R<Answer> {
    let get = |k: &str| fields.iter().find(|(x, _)| x == k).map(|(_, v)| v.clone());
    let reason = get("reason").filter(|v| !matches!(v, OVal::Null)).map(|v| js_text(&v));
    let msg = match get("error") {
        Some(e) if !matches!(e, OVal::Null) => js_text(&e),
        _ => reason.clone().unwrap_or_else(|| defaults::text("devswarm_cli.act_msg_verb_failed").to_string()),
    };
    let repo_key = ident::resolve_context(&inv.cwd, true)?.repo_key;
    crate::meshw::clog::refusal(inv, defaults::text("devswarm_cli.action_done"), repo_key.as_deref(), id, &msg, reason.as_deref());
    crate::meshw::mark_committed();
    Ok(answer(2, OVal::Obj(fields)))
}

/// A refusal of `done` that Node logs: `{ ok: false, action: 'done', reason, ...extra, error? }`.
fn done_refusal(inv: &Inv, id: Option<&str>, reason: &str, error: Option<&str>, extra: &[(&str, OVal)]) -> R<Answer> {
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(false)).put("action", s(defaults::text("devswarm_cli.action_done"))).put("reason", s(reason));
    for (k, v) in extra {
        o.put(k, v.clone());
    }
    if let Some(e) = error {
        o.put("error", s(e));
    }
    done_fail(inv, id, o.0)
}

/// `childLabelRefusal(id, flags, ctx)` (`identity.js`): a `primary-<hash>` label of a CHILD worktree is not an identity anyone
/// owns, so a verb that would write under it is refused with the child's real id (or a retired label's survivor). `None` when the
/// id is no such label, or on any failure (Node: fail-open).
pub(crate) fn child_label_refusal(inv: &Inv, id: &str, rows: &[Row], worktree_flag: Option<&str>) -> Option<Vec<(String, OVal)>> {
    if !is_primary_label(id) {
        return None;
    }
    let cwd = inv.cwd.as_str();
    let registry: &[Row] = if ident::repo_key_for_worktree(cwd).ok().flatten().is_some() { rows } else { &[] };
    let canonical = |p: &str| ident::canonical_worktree_real_path(p).ok().flatten();
    let row = registry.iter().find(|r| r.id == id);
    let wt = if let Some(w) = row.and_then(|r| r.worktree_path.as_deref()).filter(|w| !w.is_empty()) {
        canonical(w)
    } else if let Some(f) = worktree_flag.filter(|f| !f.is_empty() && ident::canonical_mesh_id(f).ok().flatten().as_deref() == Some(id)) {
        canonical(f)
    } else if ident::caller_identity_detailed(&inv.env, cwd).is_ok_and(|c| c.identity == id) {
        ident::resolve_caller_worktree(cwd).ok().flatten()
    } else {
        None
    };
    // a label already folded away is never re-minted, even with no row or worktree left to check
    let retired_to = crate::meshw::readprimary::read_retired_redirect(inv, id).filter(|r| r != id);
    let refusal = |resolved_to: Option<&str>, worktree: Option<&str>, error: String| -> Vec<(String, OVal)> {
        let mut o = Obj::default();
        o.put("ok", OVal::Bool(false))
            .put("reason", s(defaults::text("devswarm_cli.act_reason_child_label")))
            .put("id", s(id))
            .put("resolvedTo", resolved_to.map_or(OVal::Null, s))
            .put("worktree", worktree.map_or(OVal::Null, s))
            .put("error", s(&error));
        o.0
    };
    let Some(wt) = wt else {
        let to = retired_to?;
        return Some(refusal(Some(&to), None, defaults::render("devswarm_cli.act_msg_child_label_retired", &[("id", &quote(id)), ("to", &quote(&to))])));
    };
    let ic = ident::resolve_context(&wt, false).ok()?;
    if ic.worktree_root.as_deref().is_some_and(|root| ident::is_primary_checkout(root, ic.main_worktree.as_deref(), &inv.home, &inv.env).unwrap_or(false)) {
        return None;
    }
    let mut kids: Vec<&str> = Vec::new();
    for r in registry.iter().filter(|r| !r.id.starts_with(defaults::text("mesh_write.primary_prefix"))) {
        if r.worktree_path.as_deref().filter(|w| !w.is_empty()).and_then(canonical).as_deref() == Some(wt.as_str()) && !kids.contains(&r.id.as_str()) {
            kids.push(&r.id);
        }
    }
    let app = ident::builder_for_worktree(&inv.home, &inv.env, &wt).ok().flatten();
    let child = app
        .as_ref()
        .filter(|a| kids.contains(&a.id.as_str()))
        .map(|a| a.id.clone())
        .or_else(|| (kids.len() == 1).then(|| kids[0].to_string()))
        .or(retired_to);
    if child.is_none() {
        // no registered child id: the label is still the only identity that worktree has (legacy children) - allowed, except from
        // the Primary checkout, which never registers a child's label
        let caller = ident::resolve_context(cwd, true).ok()?;
        let from_primary = caller.worktree_root.as_deref().is_some_and(|root| {
            root != wt && ident::is_primary_checkout(root, caller.main_worktree.as_deref(), &inv.home, &inv.env).unwrap_or(false)
        });
        if !from_primary {
            return None;
        }
    }
    let use_id = match &child {
        Some(c) => defaults::render("devswarm_cli.act_msg_child_label_use", &[("child", &quote(c))]),
        None => defaults::text("devswarm_cli.act_msg_child_label_unregistered").to_string(),
    };
    let error = defaults::render("devswarm_cli.act_msg_child_label_child", &[("id", &quote(id)), ("wt", &wt), ("use", &use_id)]);
    Some(refusal(child.as_deref(), Some(&wt), error))
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
    // a caller with no resolvable checkout is not the Primary checkout (`isPrimaryCheckout(null, ...)` is false)
    let wt_root = caller_ic.worktree_root.clone();
    if let Some(root) = &wt_root
        && ident::is_primary_checkout(root, caller_ic.main_worktree.as_deref(), &inv.home, &inv.env)?
    {
        return done_refusal(
            inv,
            None,
            defaults::text("devswarm_cli.reason_done_primary_checkout"),
            Some(defaults::text("devswarm_cli.msg_done_primary_checkout")),
            &[],
        );
    }
    let st = common::open_store(inv, &repo_key)?;
    let rows = rows_of(&st);
    let who = ident::sender_identity_detailed(&inv.env, cwd, &rows, &inv.home)?;
    common::ensure_alias(inv, &who, cwd);
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
    if let Some(refusal) = child_label_refusal(inv, &id, &rows, a.one(defaults::text("devswarm_cli.flag_worktree"))) {
        // Object.assign({ action: 'done' }, labelRefusal)
        let mut o = Obj::default();
        o.put("action", s(defaults::text("devswarm_cli.action_done")));
        for (k, v) in refusal {
            o.put(&k, v);
        }
        return done_fail(inv, Some(&id), o.0);
    }
    let head = git_head(runner, wt_root.as_deref().unwrap_or(cwd));
    // the plan the report closes, found before anything is written
    let found = plan::find_for(inv, &id, wt_root.as_deref())?;
    // the Primary's partition (`resolveMeshTarget`): more than one candidate needs liveness ranking
    let primary_mesh = match caller_ic.main_worktree.as_deref() {
        Some(m) => Some(ident::primary_workspace_id(m)?),
        None => None,
    };
    let target = match &primary_mesh {
        Some(pm) => resolve_mesh_target(inv, None, &rows, Some(pm))?,
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
        // the gate refused (before any write) or the project's summary does not track the id (after the rows):
        // Object.assign({}, g, { ok: false, action: 'done', id, gateSet: false, error: g.error || '<not registered>' })
        let mut o = Obj(match g {
            OVal::Obj(fields) => fields,
            _ => Vec::new(),
        });
        o.put("ok", OVal::Bool(false))
            .put("action", s(defaults::text("devswarm_cli.action_done")))
            .put("id", s(&id))
            .put("gateSet", OVal::Bool(false));
        if !o.0.iter().any(|(k, v)| k == "error" && v.truthy()) {
            o.put("error", s(&defaults::render("devswarm_cli.act_msg_done_unregistered", &[("id", &quote(&id))])));
        }
        return done_fail(inv, Some(&id), o.0);
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
    let present = rows_of(&st).iter().any(|x| x.id == dest);
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
    let appended = match appended {
        Ok(a) => a,
        Err(e) => {
            // a store error inside the message step is the done report's `messageReason: 'error'` (the gate stays set)
            out.put("messageReason", s(defaults::text("devswarm_cli.act_done_reason_error"))).put("messageError", s(&e.to_string()));
            return Ok(answer(0, out.done()));
        }
    };
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
    // `record` rotates a log past its limit before it appends (rolled-up days first)
    crate::dssup::suplog::rotate_if_needed(&inv.home);
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
    let sub = a.positionals.get(1).map(String::as_str);
    if !seat_not_applicable(inv)? {
        return primary_seat(inv, sub, sid.as_deref());
    }
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

/// `primary status|takeover` inside the project's Primary checkout (`cmdPrimary` over `seatVerdict`): the verdict of the seat, and the
/// takeover of it through `register-primary --force`.
fn primary_seat(inv: &Inv, sub: Option<&str>, sid: Option<&str>) -> R<Answer> {
    let t = |k: &str| defaults::text(k);
    let verdict = crate::script::host_seat::seat_verdict(inv, sid.unwrap_or_default(), inv.now as f64)?;
    let field = |k: &str| verdict.get(k).and_then(serde_json::Value::as_str).unwrap_or_default().to_string();
    let state = field("state");
    let ov = |k: &str| verdict.get(k).and_then(|v| OVal::parse(&v.to_string())).unwrap_or(OVal::Null);
    if sub.is_none() || sub == Some(t("devswarm_cli.sub_status")) {
        // Object.assign({ ok, action, session }, v): the verdict's own key order (state first, then the base)
        let mut o = Obj::default();
        o.put("ok", OVal::Bool(true)).put("action", s(t("devswarm_cli.action_primary_status"))).put("session", sid.map_or(OVal::Null, s));
        for k in ["state", "reason", "descriptorPath", "evidence", "id", "worktree", "holder", "handover", "stale"] {
            if verdict.get(k).is_some() {
                o.put(k, ov(k));
            }
        }
        return Ok(answer(0, o.done()));
    }
    if sub != Some(t("devswarm_cli.sub_takeover")) {
        let shown = quote(sub.unwrap_or_default());
        return Ok(refusal(&[("error", s(&defaults::render("devswarm_cli.msg_primary_unknown_sub", &[("sub", &shown)])))]));
    }
    let action = s(t("devswarm_cli.action_primary_takeover"));
    let Some(sid) = sid else {
        return Ok(refusal(&[
            ("action", action),
            ("reason", s(t("devswarm_cli.reason_no_session"))),
            ("error", s(t("devswarm_cli.msg_primary_takeover_no_session"))),
        ]));
    };
    let id = field("id");
    if state == t("devswarm_cli.seat_state_own") {
        let mut o = Obj::default();
        o.put("ok", OVal::Bool(true)).put("action", action).put("id", s(&id)).put("already", OVal::Bool(true)).put("session", s(sid));
        return Ok(answer(0, o.done()));
    }
    let wt = field("worktree");
    let desc_file = idlock::devswarm_root(&inv.home).join(t("mesh_write.dir_workspaces")).join(format!("{id}{}", t("mesh_write.json_suffix")));
    let cursor = ident::read_bounded(&desc_file)?
        .and_then(|b| OVal::parse(&String::from_utf8_lossy(&b)))
        .and_then(|d| match d.get(t("mesh_write.field_cursor_path")) {
            Some(OVal::Str(c)) if !c.is_empty() => Some(c.clone()),
            _ => None,
        });
    let mut reg = Args { positionals: vec![t("devswarm_cli.verb_register_primary").to_string()], ..Args::default() };
    let mut put = |k: &str, v: crate::meshw::args::FlagVal| {
        reg.flags.insert(t(k).to_string(), vec![v]);
    };
    put("devswarm_cli.flag_worktree", crate::meshw::args::FlagVal::S(wt.clone()));
    put("devswarm_cli.flag_session", crate::meshw::args::FlagVal::S(sid.to_string()));
    put("devswarm_cli.flag_force", crate::meshw::args::FlagVal::True);
    if let Some(c) = cursor {
        put("devswarm_cli.flag_reg_cursor", crate::meshw::args::FlagVal::S(c));
    }
    let reg_inv = Inv { cwd: wt, ..inv.clone() };
    let done = crate::meshw::lifeverbs::register_primary(&reg_inv, &reg)?;
    let r = OVal::parse(done.stdout.trim()).unwrap_or(OVal::Null);
    if !matches!(r.get("ok"), Some(OVal::Bool(true))) {
        // Object.assign({ action }, r): the action first, then the registration's own fields
        let mut o = Obj::default();
        o.put("action", action);
        if let OVal::Obj(fields) = &r {
            for (k, v) in fields {
                o.put(k, v.clone());
            }
        } else {
            o.put("ok", OVal::Bool(false));
        }
        return Ok(answer(2, o.done()));
    }
    let conflict = state == t("devswarm_cli.seat_state_conflict");
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(true))
        .put("action", action)
        .put("id", s(&id))
        .put("from", ov("holder"))
        .put("to", s(sid))
        .put("demoted", if conflict { ov("holder") } else { OVal::Null });
    Ok(answer(0, o.done()))
}

// ---- relay --------------------------------------------------------------------------------------------------------------

/// `readReadReceipt(home, id, receiptId)` (`cursors.js`): the receipt file's JSON object when it holds `ops`. Only a lowercase
/// receipt id of a safe workspace id reads anything.
fn read_receipt(inv: &Inv, id: &str, rid: &str) -> Option<OVal> {
    let prefix = defaults::text("mesh_write.receipt_id_prefix");
    if !is_safe_id(id) || !rid.strip_prefix(prefix).is_some_and(|rest| !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())) {
        return None;
    }
    let file = devswarm_root(&inv.home)
        .join(defaults::text("mesh_write.dir_read_receipts"))
        .join(id)
        .join(format!("{rid}{}", defaults::text("mesh_write.json_suffix")));
    let rec = OVal::parse(&String::from_utf8_lossy(&ident::read_or_skip(&file, defaults::text("mesh_write.site_receipt"))?))?;
    (matches!(rec, OVal::Obj(_)) && matches!(rec.get("ops"), Some(OVal::Arr(_)))).then_some(rec)
}

/// `fs.readFileSync(path, 'utf8')`: the text, or Node's message for the error.
fn read_text_file(path: &str) -> Result<String, String> {
    match std::fs::read(path) {
        Ok(b) => Ok(String::from_utf8_lossy(&b).into_owned()),
        Err(e) => {
            let table = defaults::raw("devswarm_cli.send_fs_errors");
            Err(match e.raw_os_error().and_then(|c| table.get(&c.to_string())).and_then(|v| v.as_str()) {
                Some(t) => t.replace("{path}", &format!("'{path}'")),
                None => e.to_string(),
            })
        }
    }
}

/// A failed `relay` as Node prints and logs it: `{ ok: false, action: 'relay', ...fields }` plus the self-heal fields, exit 2, and
/// the central-log line `logVerbOutcome('relay', one(flags, 'to'), r, ctx)`.
fn relay_fail(inv: &Inv, to: Option<&str>, fields: Obj, heal: &[(String, OVal)], effect: Effect) -> R<Answer> {
    let get = |k: &str| fields.0.iter().find(|(x, _)| x == k).map(|(_, v)| v.clone());
    let reason = get("reason").filter(|v| !matches!(v, OVal::Null)).map(|v| js_text(&v));
    let msg = match get("error") {
        Some(e) if !matches!(e, OVal::Null) => js_text(&e),
        _ => reason.clone().unwrap_or_else(|| defaults::text("devswarm_cli.act_msg_verb_failed").to_string()),
    };
    let repo_key = ident::resolve_context(&inv.cwd, true)?.repo_key;
    crate::meshw::clog::refusal(inv, defaults::text("devswarm_cli.verb_relay"), repo_key.as_deref(), to, &msg, reason.as_deref());
    crate::meshw::mark_committed();
    let mut out = Obj(fields.0);
    for (k, v) in heal {
        out.put(k, v.clone());
    }
    Ok(Answer { code: 2, stdout: format!("{}\n", out.done().stringify()), effect })
}

/// `relay <seq|receipt> --to ID [--note-file P]`: forward a message of the caller's own inbox, verbatim, to `--to`.
pub fn relay(inv: &Inv, a: &Args) -> R<Answer> {
    common::seat_check(inv)?;
    let heal = common::self_heal(inv)?;
    let cwd = inv.cwd.as_str();
    let to_raw = a.one(defaults::text("mesh_write.flag_to"));
    let action = || s(defaults::text("devswarm_cli.action_relay"));
    // `{ ok: false, action: 'relay', ...fields }`
    let refuse = |fields: &[(&str, OVal)]| -> R<Answer> {
        let mut o = Obj::default();
        o.put("ok", OVal::Bool(false)).put("action", action());
        for (k, v) in fields {
            o.put(k, v.clone());
        }
        relay_fail(inv, to_raw, o, &heal, Effect::None)
    };
    let Some(repo_key) = ident::repo_key_for_worktree(cwd)? else {
        return refuse(&[
            ("reason", s(defaults::text("devswarm_cli.reason_no_project"))),
            ("error", s(defaults::text("devswarm_cli.act_msg_relay_no_project"))),
        ]);
    };
    let Some(to_flag) = to_raw.filter(|x| !x.is_empty()) else { return refuse(&[("error", s(defaults::text("devswarm_cli.act_msg_relay_no_to")))]) };
    let Some(seq_arg) = a.positionals.get(1).map(String::as_str).filter(|x| !x.is_empty()) else {
        return refuse(&[("error", s(defaults::text("devswarm_cli.act_msg_relay_no_seq")))]);
    };
    let note = match a.one(defaults::text("devswarm_cli.flag_note_file")) {
        Some(f) => match read_text_file(f) {
            Ok(t) => Some(t),
            Err(why) => {
                return refuse(&[("error", s(&defaults::render("devswarm_cli.act_msg_relay_note_file", &[("file", &quote(f)), ("why", &why)])))]);
            }
        },
        None => None,
    };
    let st = common::open_store(inv, &repo_key)?;
    let rows = rows_of(&st);
    let from = ident::sender_identity_detailed(&inv.env, cwd, &rows, &inv.home)?;
    common::ensure_alias(inv, &from, cwd);
    let caller = from.identity.clone();
    let is_receipt = is_receipt_id(seq_arg);
    let mut seq: Option<f64> = None;
    let mut source_hash: Option<String> = None;
    let mut by_receipt = false;
    if is_receipt {
        let Some(found) = read_receipt(inv, &caller, seq_arg) else {
            return refuse(&[
                ("reason", s(defaults::text("devswarm_cli.act_reason_unknown_receipt"))),
                (
                    "error",
                    s(&defaults::render("devswarm_cli.act_msg_relay_unknown_receipt", &[("rid", &quote(seq_arg)), ("id", &quote(&caller)), ("caller", &caller)])),
                ),
            ]);
        };
        let hashes: Vec<&OVal> = match found.get("hashes") {
            Some(OVal::Arr(h)) => h.iter().filter(|x| x.truthy()).collect(),
            _ => Vec::new(),
        };
        if hashes.len() != 1 {
            return refuse(&[
                ("reason", s(defaults::text("devswarm_cli.act_reason_ambiguous_receipt"))),
                (
                    "error",
                    s(&defaults::render(
                        "devswarm_cli.act_msg_relay_ambiguous_receipt",
                        &[("rid", &quote(seq_arg)), ("n", &hashes.len()), ("caller", &caller)],
                    )),
                ),
                ("count", n(hashes.len() as f64)),
            ]);
        }
        // a hash that is no string equals no stored hash (`r.hash === sourceHash`)
        source_hash = match hashes[0] {
            OVal::Str(h) => Some(h.clone()),
            _ => None,
        };
        by_receipt = true;
    } else {
        let num = crate::checks::guardkit::text::js_number_of_str(seq_arg);
        if !num.is_finite() || num < 0.0 {
            return refuse(&[("error", s(&defaults::render("devswarm_cli.act_msg_relay_bad_seq", &[("got", &quote(seq_arg))])))]);
        }
        seq = Some(num.floor());
    }
    let mut found: Option<serde_json::Value> = None;
    let read = st.reader().for_each_message(&caller, 0, |m| {
        let hit = if by_receipt {
            source_hash.as_deref().is_some_and(|h| m["hash"].as_str() == Some(h))
        } else {
            seq.is_some_and(|q| m["storeSeq"].as_f64() == Some(q))
        };
        if hit {
            found = Some(m);
            return false;
        }
        true
    });
    if let Err(e) = read {
        return thrown(inv, defaults::text("devswarm_cli.verb_relay"), &e.to_string());
    }
    let Some(row) = found else {
        let what = match by_receipt {
            true => defaults::render("devswarm_cli.act_msg_relay_not_found_receipt", &[("rid", &quote(seq_arg)), ("id", &quote(&caller))]),
            false => defaults::render(
                "devswarm_cli.act_msg_relay_not_found_seq",
                &[("seq", &crate::checks::jsport::num::to_js_string(seq.unwrap_or(f64::NAN))), ("id", &quote(&caller))],
            ),
        };
        return refuse(&[("reason", s(defaults::text("devswarm_cli.act_reason_message_not_found"))), ("error", s(&what))]);
    };
    let body = row["body"].as_str().unwrap_or_default().to_string();
    let source_bytes = body.len();
    let store_seq = crate::checks::jsport::num::to_js_string(row["storeSeq"].as_f64().unwrap_or(f64::NAN));
    if body.is_empty() {
        return refuse(&[
            ("reason", s(defaults::text("devswarm_cli.act_reason_empty_body"))),
            ("error", s(&defaults::render("devswarm_cli.act_msg_relay_empty_body", &[("seq", &store_seq)]))),
        ]);
    }
    let sender_text = match row["sender"].as_str() {
        Some(x) => x.to_string(),
        None => defaults::text("devswarm_cli.relay_null").to_string(),
    };
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
    let field = |k: &str| send_res.0.iter().find(|(x, _)| x == k).map(|(_, v)| v.clone());
    let send_ok = matches!(field("ok"), Some(OVal::Bool(true)));
    let bytes = match field("bytes") {
        Some(OVal::Num(b)) => Some(b),
        _ => None,
    };
    let effect = match field("hash") {
        Some(OVal::Str(h)) => Effect::Row(h),
        _ => Effect::None,
    };
    let (send_reason, send_error) = (field("reason"), field("error"));
    let mut out = Obj::default();
    out.put("ok", OVal::Bool(send_ok))
        .put("action", action())
        .put("from", s(&caller))
        .put("to", s(to_flag))
        .put("seq", row["storeSeq"].as_f64().map_or(OVal::Null, n))
        .put("sourceBytes", n(source_bytes as f64));
    if let Some(b) = bytes {
        out.put("relayedBytes", n(b));
    }
    out.put("expectedBytes", n(expected as f64));
    if is_receipt {
        out.put("receiptId", s(seq_arg));
    }
    out.put("send", send_res.done());
    if !send_ok {
        // the send itself failed: its reason (else the relay's own) and its error, worded as a relay failure
        let why = match send_reason {
            Some(r) if r.truthy() => js_text(&r),
            _ => defaults::text("devswarm_cli.act_reason_relay_send_failed").to_string(),
        };
        let detail = match send_error {
            Some(e) if e.truthy() => js_text(&e),
            _ => defaults::text("devswarm_cli.act_msg_relay_send_unknown").to_string(),
        };
        out.put("ok", OVal::Bool(false)).put("reason", s(&why)).put("error", s(&defaults::render("devswarm_cli.act_msg_relay_send_failed", &[("why", &detail)])));
        return relay_fail(inv, to_raw, out, &heal, effect);
    }
    if bytes != Some(expected as f64) {
        let got = bytes.map_or_else(|| defaults::text("devswarm_cli.act_js_undefined").to_string(), crate::checks::jsport::num::to_js_string);
        out.put("ok", OVal::Bool(false))
            .put("reason", s(defaults::text("devswarm_cli.act_reason_byte_mismatch")))
            .put(
                "error",
                s(&defaults::render(
                    "devswarm_cli.act_msg_relay_mismatch",
                    &[("got", &got), ("expected", &expected), ("source", &source_bytes)],
                )),
            );
        return relay_fail(inv, to_raw, out, &heal, effect);
    }
    for (k, v) in heal {
        out.put(&k, v);
    }
    Ok(Answer { code: 0, stdout: format!("{}\n", out.done().stringify()), effect })
}

/// A store failure Node raises as an exception: `run()`'s catch prints `{ ok: false, error }` (exit 2) and logs it.
fn thrown(inv: &Inv, op: &str, msg: &str) -> R<Answer> {
    let repo_key = ident::resolve_context(&inv.cwd, true)?.repo_key;
    crate::meshw::clog::refusal(inv, op, repo_key.as_deref(), None, msg, None);
    crate::meshw::mark_committed();
    Ok(refusal_plain(msg))
}

/// `{ ok: false, error }`, exit 2.
fn refusal_plain(msg: &str) -> Answer {
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(false)).put("error", s(msg));
    answer(2, o.done())
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

/// `descriptorIdsForMesh(home, meshId, only)` (Node `send.js`): the ids of the descriptors in `dirs` whose worktree derives to
/// `mesh` (`canonicalMeshId`, else `rawPathMeshId`), sorted; a descriptor keyed by the mesh id itself is the label, not an id.
/// A `worktreePath` that is truthy but not a string is read through `String(..)`, as Node's `canonicalMeshId` does.
fn descriptor_ids_for_mesh(home: &std::path::Path, mesh: &str, dirs: &[&str]) -> R<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    let suffix = defaults::text("mesh_write.json_suffix");
    for dir in dirs {
        let dir = devswarm_root(home).join(defaults::text(dir));
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            let Some(id) = name.strip_suffix(suffix) else { continue };
            if !is_safe_id(id) || id == mesh || out.iter().any(|x| x == id) {
                continue;
            }
            // readDescriptorPathState: a regular file (lstat) holding a JSON object
            let p = dir.join(&name);
            if !std::fs::symlink_metadata(&p).is_ok_and(|m| m.is_file()) {
                continue;
            }
            let Some(d @ OVal::Obj(_)) = std::fs::read(&p).ok().and_then(|b| OVal::parse(&String::from_utf8_lossy(&b))) else { continue };
            let wt = match d.get("worktreePath") {
                Some(v) if v.truthy() => js_text(v),
                _ => continue,
            };
            let derived = match ident::canonical_mesh_id(&wt)? {
                Some(c) if !c.is_empty() => Some(c),
                _ => ident::raw_path_mesh_id(&wt)?,
            };
            if derived.as_deref() == Some(mesh) {
                out.push(id.to_string());
            }
        }
    }
    out.sort();
    Ok(out)
}

/// `resolveTargetId(raw, ctx, action)` (Node 35345b83): the one canonical id of the workspace a verb targets (nudge, gate,
/// plan, scope, wake-directive, correct, archive-ignore/unignore), through [`resolve_archive_id`]. An id nothing resolves stays
/// as given; an ambiguous one is refused with the candidates (`Object.assign({ action, id }, resolved)`, exit 2).
pub(crate) fn resolve_target_id(inv: &Inv, raw: &str, action: &str) -> R<Result<String, Answer>> {
    Ok(match resolve_archive_id(inv, raw, false)? {
        Resolved::Id(x) => Ok(x),
        Resolved::Ambiguous(tpl, ids) => Err(Resolved::refusal(action, true, raw, tpl, &ids)),
    })
}

/// `resolveArchiveId(raw, ctx, { unarchive })` for a safe id: an exact descriptor (active or archived) wins; else a unique
/// prefix of the project's workspaces; else, when `unarchiving` and no workspace matched, a unique archived descriptor by
/// prefix or mesh label; else a unique registry row (or live descriptor) of that mesh label; else the id as given.
pub(crate) fn resolve_archive_id(inv: &Inv, raw: &str, unarchiving: bool) -> R<Resolved> {
    Ok(resolve_archive_id_found(inv, raw, unarchiving)?.0)
}

/// [`resolve_archive_id`] and whether the reference resolved to something (`false`: Node's `invalid or missing workspace id`,
/// which the verbs that need a workspace refuse and the ones that echo the id as given go on with).
pub(crate) fn resolve_archive_id_found(inv: &Inv, raw: &str, unarchiving: bool) -> R<(Resolved, bool)> {
    let root = devswarm_root(&inv.home);
    let file = format!("{raw}{}", defaults::text("mesh_write.json_suffix"));
    if lstat_exists(&root.join(defaults::text("mesh_write.dir_workspaces")).join(&file)) {
        note_ref("mesh_write.ref_outcome_exact");
        return Ok((Resolved::Id(raw.to_string()), true));
    }
    let adir = root.join(defaults::text("mesh_write.dir_archived"));
    // checkedArchivedDir: a directory that is not a plain directory is an error Node reports as "not found"
    if std::fs::symlink_metadata(&adir).is_ok_and(|m| m.is_dir() && !m.file_type().is_symlink()) && lstat_exists(&adir.join(&file)) {
        note_ref("mesh_write.ref_outcome_exact");
        return Ok((Resolved::Id(raw.to_string()), true));
    }
    // the candidate pool: the project's own workspaces, in `Object.keys` order (integer-like names first, ascending)
    let worktree = ident::resolve_caller_worktree(&inv.cwd)?;
    let repo_key = match &worktree {
        Some(w) => ident::repo_key_for_worktree(w)?,
        None => ident::resolve_context(&inv.cwd, true)?.repo_key,
    };
    // outside a project Node reads the default bucket (`hashFromWorkspaceId(undefined)`), creating its store where it is absent
    let repo_key = match repo_key {
        Some(k) => k,
        None => {
            let k = crate::meshw::send::hash_from_workspace_id("");
            common::init_new_store(inv, &k)?;
            k
        }
    };
    let st = common::open_store(inv, &repo_key)?;
    let sum = crate::meshw::summary::compute(&st, inv, None)?;
    // `Object.keys(sum.workspaces || {})`: the summary always builds an object
    let names: Vec<&String> = match sum.get("workspaces") {
        Some(OVal::Obj(all)) => js_key_order(all),
        _ => Vec::new(),
    };
    let cands: Vec<&String> = names.into_iter().filter(|k| is_safe_id(k) && k.starts_with(raw)).collect();
    if unarchiving && cands.is_empty() {
        // unarchive targets archived descriptors, which the active pool and the (tombstoned) registry rows cannot name:
        // prefix and mesh label are resolved against the archived-descriptor directory instead
        let mut hits: Vec<String> = match std::fs::read_dir(&adir) {
            Ok(entries) => entries
                .flatten()
                .filter_map(|e| e.file_name().to_string_lossy().strip_suffix(defaults::text("mesh_write.json_suffix")).map(str::to_string))
                .filter(|n| is_safe_id(n) && n.starts_with(raw))
                .collect(),
            Err(_) => Vec::new(),
        };
        for id in descriptor_ids_for_mesh(&inv.home, raw, &["mesh_write.dir_archived"])? {
            if !hits.contains(&id) {
                hits.push(id);
            }
        }
        hits.sort();
        match hits.len() {
            0 => {}
            1 => {
                note_ref("mesh_write.ref_outcome_prefix");
                return Ok((Resolved::Id(hits.remove(0)), true));
            }
            _ => {
                note_ref("mesh_write.ref_outcome_ambiguous");
                return Ok((Resolved::Ambiguous(defaults::text("devswarm_cli.msg_ambig_archived"), hits), true));
            }
        }
    }
    // an exact id outranks a longer id that merely starts with it
    if cands.iter().any(|k| k.as_str() == raw) {
        note_ref("mesh_write.ref_outcome_exact");
        return Ok((Resolved::Id(raw.to_string()), true));
    }
    match cands.len() {
        1 => {
            note_ref("mesh_write.ref_outcome_prefix");
            return Ok((Resolved::Id(cands[0].clone()), true));
        }
        0 => {}
        _ => {
            note_ref("mesh_write.ref_outcome_ambiguous");
            return Ok((Resolved::Ambiguous(defaults::text("devswarm_cli.msg_ambig_prefix"), cands.into_iter().cloned().collect()), true));
        }
    }
    let rows = rows_of(&st);
    let mut mesh: Vec<String> = mesh_rows(&rows, raw)?.into_iter().filter(|r| r.id != raw && is_safe_id(&r.id)).map(|r| r.id).collect();
    // a live descriptor whose worktree derives to this mesh label (no registry row yet, or any more) is the same workspace
    for id in descriptor_ids_for_mesh(&inv.home, raw, &["mesh_write.dir_workspaces"])? {
        if !mesh.contains(&id) {
            mesh.push(id);
        }
    }
    mesh.sort();
    match mesh.len() {
        0 => {
            // a label-only row (a spawn that never got the app's id): the app database names the workspace by its worktree path
            if let Some(uuid) = label_app_id(inv, &rows, raw) {
                note_ref("mesh_write.ref_outcome_mesh");
                return Ok((Resolved::Id(uuid), false));
            }
            note_ref("mesh_write.ref_outcome_none");
            Ok((Resolved::Id(raw.to_string()), false))
        }
        1 => {
            note_ref("mesh_write.ref_outcome_mesh");
            Ok((Resolved::Id(mesh.remove(0)), true))
        }
        _ => {
            note_ref("mesh_write.ref_outcome_ambiguous");
            Ok((Resolved::Ambiguous(defaults::text("devswarm_cli.msg_ambig_mesh"), mesh), true))
        }
    }
}

/// [`js_key_order`] for the tests of other modules.
#[cfg(test)]
pub(crate) fn js_key_order_for_tests(fields: &[(String, OVal)]) -> Vec<&str> {
    js_key_order(fields).into_iter().map(String::as_str).collect()
}

/// The keys of an object in JavaScript's order: integer-like names ascending, then the others as inserted.
fn js_key_order(fields: &[(String, OVal)]) -> Vec<&String> {
    let mut idx: Vec<(u64, &String)> = fields
        .iter()
        .filter(|(k, _)| crate::checks::guardkit::ojson::is_array_index_key(k))
        .filter_map(|(k, _)| k.parse::<u64>().ok().map(|n| (n, k)))
        .collect();
    idx.sort_by_key(|(n, _)| *n);
    idx.into_iter().map(|(_, k)| k).chain(fields.iter().map(|(k, _)| k).filter(|k| !crate::checks::guardkit::ojson::is_array_index_key(k))).collect()
}

/// The app's id of the workspace a label-only registry row stands for: the row `label` (keyed by the `primary-<hash>` its own
/// worktree derives to) names the worktree, and the app database (read-only) names the one live non-primary builder there.
fn label_app_id(inv: &Inv, rows: &[Row], label: &str) -> Option<String> {
    let wt = rows.iter().find(|r| r.id == label)?.worktree_path.as_deref().filter(|w| !w.is_empty())?;
    if ident::primary_workspace_id(wt).ok()? != label {
        return None;
    }
    match crate::meshw::appid::lookup(&inv.home, &inv.env, wt) {
        crate::meshw::appid::Lookup::Found(uuid) => Some(uuid),
        _ => None,
    }
}

/// Count how a workspace reference resolved (`mesh_ref_resolved`, labelled by outcome).
pub(crate) fn note_ref(outcome_key: &str) {
    crate::metrics::bump("mesh_ref_resolved", &[("outcome", defaults::text(outcome_key))]);
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

/// `{ ok: false, ...fields }` with the self-heal fields, exit 2: a result Node's dispatcher does not log.
fn plain_refusal(fields: &[(&str, OVal)], heal: &[(String, OVal)]) -> Answer {
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(false));
    for (k, v) in fields {
        o.put(k, v.clone());
    }
    for (k, v) in heal {
        o.put(k, v.clone());
    }
    answer(2, o.done())
}

/// The summary file of a project (`readSummaryForHash`): `workspaces[id].archive_ready === true`.
fn archive_ready(inv: &Inv, repo_key: &str, id: &str) -> bool {
    let file = devswarm_root(&inv.home).join(defaults::text("mesh_write.dir_summaries")).join(format!("{repo_key}{}", defaults::text("mesh_write.json_suffix")));
    std::fs::read(file)
        .ok()
        .and_then(|b| OVal::parse(&String::from_utf8_lossy(&b)))
        .and_then(|sum| sum.get("workspaces").and_then(|w| w.get(id)).and_then(|w| w.get("archive_ready")).cloned())
        .is_some_and(|v| v == OVal::Bool(true))
}

/// `archive-request <childId> [--reason TEXT]`: post the archive request into the child's own partition.
pub fn archive_request(inv: &Inv, a: &Args) -> R<Answer> {
    let id = a.positionals.get(1).map(String::as_str).unwrap_or("");
    if !is_safe_id(id) {
        return Ok(refusal(&[("error", s(defaults::text("devswarm_cli.msg_bad_id")))]));
    }
    let raw_id = id;
    let id = match resolve_archive_id(inv, id, false)? {
        Resolved::Id(x) => x,
        Resolved::Ambiguous(tpl, ids) => return Ok(Resolved::refusal(defaults::text("devswarm_cli.action_archive_request"), false, raw_id, tpl, &ids)),
    };
    let heal = common::self_heal(inv)?;
    let cwd = inv.cwd.as_str();
    let Some(repo_key) = ident::repo_key_for_worktree(cwd)? else {
        return Ok(plain_refusal(&[("reason", s(defaults::text("devswarm_cli.reason_no_project")))], &heal));
    };
    let reason = a.one(defaults::text("devswarm_cli.flag_reason")).filter(|r| !r.is_empty());
    // a message posted to a target with no live session can never be read: a registered target that is not live and is
    // archive-ready is archived directly instead (any failure to decide reads as live: the message path)
    if let Some(d) = ident::read_descriptor(&inv.home, &id) {
        let text_of = |k: &str| match d.get(k) {
            Some(OVal::Str(x)) if !x.is_empty() => Some(x.clone()),
            _ => None,
        };
        let (wt, session) = (text_of("worktreePath"), text_of("sessionId"));
        let live = crate::meshw::rosterrows::Verdicts::new(inv, &repo_key).live(&id, wt.as_deref(), session.as_deref()).unwrap_or(true);
        if !live && archive_ready(inv, &repo_key, &id) {
            let revalidate = |desc: Option<&OVal>| -> Option<String> {
                // re-checked inside the archive's lock: a target that heartbeats or commits in between is skipped, not archived
                let pick = |k: &str| desc.and_then(|x| x.get(k)).filter(|v| v.truthy()).and_then(|v| if let OVal::Str(t) = v { Some(t.clone()) } else { None }).or_else(|| text_of(k));
                let (w, sid) = (pick("worktreePath"), pick("sessionId"));
                let live_now = crate::meshw::rosterrows::Verdicts::new(inv, &repo_key).live(&id, w.as_deref(), sid.as_deref()).unwrap_or(true);
                live_now.then(|| defaults::text("devswarm_cli.act_reason_became_live").to_string())
            };
            let archived = crate::meshw::archiveverb::cmd_archive(inv, &id, &crate::meshw::archiveverb::Opts { args: None, revalidate: Some(&revalidate) })?;
            let result = OVal::parse(archived.stdout.trim()).unwrap_or(OVal::Null);
            let ok = matches!(result.get("ok"), Some(OVal::Bool(true)));
            let mut o = Obj(match result {
                OVal::Obj(fields) => fields,
                _ => Vec::new(),
            });
            o.put("action", s(defaults::text("devswarm_cli.action_archive_request")))
                .put("id", s(&id))
                .put("childId", s(&id))
                .put("posted", OVal::Bool(false))
                .put("autoArchived", OVal::Bool(ok))
                .put("reason", reason.map_or(OVal::Null, s))
                .put("note", s(defaults::text("devswarm_cli.act_msg_archive_request_direct")));
            for (k, v) in heal {
                o.put(&k, v);
            }
            return Ok(Answer { code: if ok { 0 } else { 2 }, stdout: format!("{}\n", o.done().stringify()), effect: archived.effect });
        }
    }
    let message = match reason {
        Some(r) => format!("{} {r} — {}", defaults::text("devswarm_cli.archive_marker"), defaults::text("devswarm_cli.archive_tail")),
        None => format!("{} — {}", defaults::text("devswarm_cli.archive_marker"), defaults::text("devswarm_cli.archive_tail")),
    };
    let st = common::open_store(inv, &repo_key)?;
    let rows = rows_of(&st);
    let who = ident::sender_identity_detailed(&inv.env, cwd, &rows, &inv.home)?;
    common::ensure_alias(inv, &who, cwd);
    let from = who.identity;
    crate::meshw::summary::check(&st, inv, Some(&id))?;
    let Some(lock) = idlock::acquire(&inv.write_home, &id) else {
        // `withIdLock`: a lock that stayed busy is a failed result, nothing posted
        let keys = defaults::list("devswarm_cli.key_lock_busy");
        return Ok(plain_refusal(
            &[
                (keys[0], OVal::Bool(true)),
                (keys[1], s(&id)),
                ("error", s(&defaults::render("devswarm_cli.msg_lock_busy", &[("id", &quote(&id))]))),
            ],
            &heal,
        ));
    };
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
    let appended = match appended {
        Ok(x) => x,
        Err(e) => return thrown(inv, defaults::text("devswarm_cli.verb_archive_request"), &e.to_string()),
    };
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

/// `defaultFireCommand(argv)`: run a descriptor-supplied argv verbatim, detached, nothing captured. A missing or empty argv, or
/// one that holds anything but strings, runs nothing; a command that cannot start is not an error (best effort, as Node's).
fn fire_command(inv: &Inv, argv: Option<&OVal>) {
    use std::os::unix::process::CommandExt;
    let Some(OVal::Arr(items)) = argv else { return };
    let words: Vec<&str> = items.iter().filter_map(|x| if let OVal::Str(t) = x { Some(t.as_str()) } else { None }).collect();
    if words.is_empty() || words.len() != items.len() {
        return;
    }
    let mut cmd = std::process::Command::new(words[0]);
    cmd.args(&words[1..])
        .env_clear()
        .envs(&inv.env)
        .current_dir(&inv.cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .process_group(0);
    if let Ok(mut child) = cmd.spawn() {
        // reaped off to the side so the poke never waits for it and never leaves a zombie behind
        crate::discard::harmless(std::thread::Builder::new().name(defaults::text("devswarm_cli.act_reap_thread").to_string()).spawn(move || {
            crate::discard::harmless(child.wait()); // keep: the poke is one-way, its exit means nothing here
        }));
    }
}

/// `pokeOrEscalate(descriptor, verdict, { home, now })` (`recovery.js`) for one workspace: a poke while the budget lasts, else the
/// terminal escalation with its notice to the parent. The result is Node's `result` object.
fn poke_or_escalate(inv: &Inv, id: &str, desc: &OVal) -> OVal {
    use crate::dssup::verdict;
    let now = inv.now;
    // a previously undeliverable escalation notice is retried first
    if let Some(intent) = verdict::read_undelivered(&inv.home, id) {
        verdict::deliver(&inv.home, &inv.env, &intent, now);
    }
    let prev: Option<serde_json::Value> =
        verdict::path(&inv.home, id).and_then(|p| std::fs::read_to_string(p).ok()).and_then(|t| serde_json::from_str(&t).ok()).filter(serde_json::Value::is_object);
    let finite = |k: &str| prev.as_ref().and_then(|p| p.get(k)).and_then(serde_json::Value::as_f64).filter(|x| x.is_finite());
    let attempts = finite("nudgeAttempts").unwrap_or(0.0);
    let cooldown_elapsed = finite("nudgedAt").is_none_or(|t| now as f64 - t >= defaults::num("devswarm_cli.act_nudge_cooldown_ms") as f64);
    let mut out = Obj::default();
    if desc.get("nudgeCommand").is_some_and(OVal::truthy) && attempts < defaults::num("devswarm_cli.act_nudge_max_attempts") as f64 && cooldown_elapsed {
        fire_command(inv, desc.get("nudgeCommand"));
        verdict::mirror_poke(&inv.home, id, attempts as u64 + 1, now);
        out.put("action", s(defaults::text("devswarm_cli.act_nudge_word_nudged")))
            .put("attempt", n(attempts + 1.0))
            .put("nudgeError", OVal::Null);
        return out.done();
    }
    // the budget is spent (or there is no command): escalate, never kill
    let was_escalated = prev.as_ref().and_then(|p| p.get("status")).and_then(serde_json::Value::as_str) == Some(defaults::text("devswarm_sup.status_escalated"));
    let last_error = prev.as_ref().and_then(|p| p.get("lastNudgeError")).and_then(|v| v.as_str().filter(|t| !t.is_empty())).map(str::to_string);
    verdict::mirror_escalate(&inv.home, id, now);
    fire_command(inv, desc.get("escalateCommand"));
    if !was_escalated
        && let Some(OVal::Str(wt)) = desc.get("worktreePath").filter(|w| w.truthy())
    {
        // only on the transition into escalated; a notice that cannot be built (the parent is the child itself) is simply none
        crate::discard::harmless(verdict::notify_parent(&inv.home, &inv.env, wt, id, finite("staleSince"), now)); // keep: Node's notify is fail-open
    }
    out.put("action", s(defaults::text("devswarm_cli.act_nudge_word_escalate"))).put("reason", s(defaults::text("devswarm_sup.reason_exhausted")));
    if let Some(e) = last_error {
        out.put("lastNudgeError", s(&e)).put("message", s(&defaults::render("devswarm_cli.act_msg_nudge_dead", &[("error", &e)])));
    }
    out.done()
}

/// `nudge <id>`: poke a stale workspace (or escalate it), through its descriptor's own commands.
pub fn nudge(inv: &Inv, a: &Args) -> R<Answer> {
    let given = a.positionals.get(1).map(String::as_str).unwrap_or("");
    if !is_safe_id(given) {
        return Ok(refusal(&[("error", s(defaults::text("devswarm_cli.msg_bad_id")))]));
    }
    // the canonical id first (Node echoes the id as given and adds `resolvedId`)
    let id = match resolve_target_id(inv, given, defaults::text("devswarm_cli.action_nudge"))? {
        Ok(x) => x,
        Err(refused) => return Ok(refused),
    };
    let mut desc = ident::read_descriptor(&inv.home, &id);
    if desc.is_none() && let Some(repo_key) = ident::repo_key_for_worktree(&inv.cwd)? {
        // `id` may be a mesh label or a registry id without a descriptor of its own: resolve it exactly as `send` does
        let st = common::open_store(inv, &repo_key)?;
        let rows = rows_of(&st);
        let target = match crate::meshw::send::resolve_send_target(inv, Some(st.reader()), &rows, &id)? {
            crate::meshw::send::Resolved::Row(t) | crate::meshw::send::Resolved::Rerouted(t, ..) | crate::meshw::send::Resolved::Redirected(t, _) => Some(t.id),
            crate::meshw::send::Resolved::Unregistered
            | crate::meshw::send::Resolved::AmbiguousPrefix(_)
            | crate::meshw::send::Resolved::AmbiguousRows(_) => None,
        };
        desc = target.and_then(|t| ident::read_descriptor(&inv.home, &t));
    }
    let mut o = Obj::default();
    let ok = match &desc {
        None => {
            o.put("ok", OVal::Bool(false)).put("error", s(&defaults::render("devswarm_cli.msg_nudge_no_descriptor", &[("id", &quote(&id))])));
            false
        }
        Some(d) => {
            let result = poke_or_escalate(inv, &id, d);
            o.put("ok", OVal::Bool(true)).put("action", s(defaults::text("devswarm_cli.action_nudge"))).put("id", s(&id)).put("result", result);
            true
        }
    };
    if id != given {
        if o.0.iter().any(|(k, _)| k == "id") {
            o.put("id", s(given));
        }
        o.put("resolvedId", s(&id));
    }
    Ok(answer(if ok { 0 } else { 2 }, o.done()))
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
