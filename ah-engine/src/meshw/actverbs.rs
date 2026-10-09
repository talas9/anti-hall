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
use crate::meshw::send::{Answer, Effect, mesh_candidates, resolve_mesh_target};
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
        timeout_ms: defaults::num("devswarm_cli.done_git_timeout_ms") as u64,
        cap_bytes: defaults::num("devswarm_cli.ready_git_max_bytes") as u64,
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

/// `done [<id>] [--summary TEXT]`.
pub fn done(inv: &Inv, a: &Args) -> R<Answer> {
    done_with(inv, a, &System::configured())
}

/// [`done`] with the git runner given.
pub fn done_with(inv: &Inv, a: &Args, runner: &dyn Runner) -> R<Answer> {
    let cwd = inv.cwd.as_str();
    let id_arg = a.positionals.get(1).map(String::as_str);
    // every refusal below is logged by Node (`logVerbOutcome('done', ...)`): the engine leaves them to it
    let Some(repo_key) = ident::repo_key_for_worktree(cwd)? else { return defer("no-project") };
    let caller_ic = ident::resolve_context(cwd, true)?;
    let Some(wt_root) = caller_ic.worktree_root.clone() else { return defer("no-worktree") };
    if ident::is_primary_checkout(&wt_root, caller_ic.main_worktree.as_deref(), &inv.home, &inv.env)? {
        return defer("primary-checkout");
    }
    let st = common::open_store(inv, &repo_key)?;
    let rows = rows_of(&st)?;
    let who = ident::sender_identity_detailed(&inv.env, cwd, &rows, &inv.home)?;
    let id = who.identity.clone();
    if let Some(x) = id_arg
        && x != id
        && Some(x) != who.mesh_id.as_deref()
    {
        return defer("not-own-workspace");
    }
    if !is_safe_id(&id) {
        return defer("no-identity");
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
    let Some(pm) = primary_mesh else {
        out.put("messageReason", s(defaults::text("devswarm_cli.done_reason_no_primary")));
        return Ok(answer(0, out.done()));
    };
    let _ = pm;
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
    if let Some(line) = plan::record(inv, defaults::text("devswarm_cli.done_event"), &f, now) {
        crate::meshw::note_written(&plan::log_rel(), line.as_bytes());
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
fn seat_not_applicable(inv: &Inv) -> R<bool> {
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
