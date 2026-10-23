//! `devswarm.js send` (direct `--to`, `--to-primary`, `--broadcast`), ported from `scripts/devswarm.js` `run()` /
//! `runArmed` and `scripts/devswarm-lib/send.js` `cmdSend`.
//!
//! The engine answers only the successful path it can reproduce exactly; every refusal Node would print, and every branch
//! that needs evidence the engine does not read (session liveness for a stale twin or a partitioned group, a fold
//! redirect, a re-home, Jev triage, plan activity, the first sender-alias write, the self-heal installer), is a
//! [`Defer`]: Node runs the verb instead, before the engine wrote anything. So a deferred verb never runs twice.
//!
//! The summary refresh (`deriveSummary`) runs right after the append, as in Node (`meshw::summary`); a store whose
//! summary the engine cannot reproduce defers before anything is written.
use crate::checks::guardkit::ojson::OVal;
use crate::defaults;
use crate::meshw::actverbs::note_ref;
use crate::meshw::args::Args;
use crate::meshw::common::{self, Inv, Obj, n, s, s_or_null};
use crate::meshw::ident::{self, Defer, R, Row};
use crate::meshw::store::{self, MeshStore};

/// What a verb wrote to the store, for the shadow comparison.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Effect {
    /// Nothing.
    None,
    /// The message row with this hash.
    Row(String),
    /// The broadcast cursor of this id.
    BroadcastCursor(String),
}

/// A verb's answer: the exit code and the exact stdout line Node prints.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Answer {
    /// `process.exit(code)`.
    pub code: i32,
    /// What `main()` writes to fd 1 (with the trailing newline).
    pub stdout: String,
    /// What it wrote.
    pub effect: Effect,
}

/// `meshCandidateRows(store, meshId)`.
pub fn mesh_candidates(rows: &[Row], mesh_id: Option<&str>) -> R<Vec<Row>> {
    let Some(mesh_id) = mesh_id.filter(|m| !m.is_empty()) else { return Ok(Vec::new()) };
    let mut out = Vec::new();
    for d in rows {
        let Some(wp) = d.worktree_path.as_deref() else { continue };
        let canon = match ident::canonical_mesh_id(wp)? {
            Some(c) => Some(c),
            None => ident::raw_path_mesh_id(wp)?,
        };
        if canon.as_deref() == Some(mesh_id) {
            out.push(d.clone());
        }
    }
    Ok(out)
}

/// `resolveMeshTarget(store, meshId, home, { isLive: isRoutingLiveRowStrict })`: no candidate is `None`; one is that row (whether or
/// not it is live); several go through `pickFreshestLive` (`liveness-select.js`). `reader` supplies the drain evidence (cursor rows);
/// without it those signals are neutral, as in Node without a store handle.
pub fn resolve_mesh_target(inv: &Inv, reader: Option<&crate::mesh::MeshReader>, rows: &[Row], mesh_id: Option<&str>) -> R<Option<Row>> {
    let c = mesh_candidates(rows, mesh_id)?;
    match c.len() {
        0 => Ok(None),
        1 => Ok(c.into_iter().next()),
        _ => pick_freshest_live(inv, reader, c).map(Some),
    }
}

/// A row's drain evidence: `(has a cursor row, cursor value, has unread)`; unknown parts are `None` / -1.
fn cursor_evidence(reader: Option<&crate::mesh::MeshReader>, id: &str) -> (Option<bool>, f64, Option<bool>) {
    let Some(r) = reader else { return (None, -1.0, None) };
    let value = r.cursor(id).map_or(-1.0, |v| v as f64);
    let exists = r.has_cursor_row(id).ok();
    let unread = r.message_count(id).ok().map(|t| t as f64 > value.max(0.0));
    (exists, value, unread)
}

/// `pickFreshestLive(candidates, { storeHandle, home, isLive })`: among the live rows the highest `(not an alias of a group sibling,
/// not the only un-drained row, session-authored heartbeat, updatedAt, cursor)` wins, the first on a tie; with none live, the freshest
/// `updatedAt`, then the lowest id.
fn pick_freshest_live(inv: &Inv, reader: Option<&crate::mesh::MeshReader>, list: Vec<Row>) -> R<Row> {
    let now = inv.now as f64;
    let mut live = Vec::new();
    for d in &list {
        live.push(crate::meshw::rosterrows::routing_live_strict(inv, now, &d.id, d.worktree_path.as_deref(), d.session_id.as_deref())?);
    }
    let group: std::collections::HashSet<&str> = list.iter().map(|d| d.id.as_str()).collect();
    let any_drain = list.iter().zip(&live).any(|(d, l)| {
        let (exists, value, _) = cursor_evidence(reader, &d.id);
        *l && (exists == Some(true) || value > 0.0)
    });
    let mut best: Option<(usize, [f64; 5])> = None;
    for (i, d) in list.iter().enumerate() {
        if !live[i] {
            continue;
        }
        let sid = d.session_id.as_deref().unwrap_or("");
        let alias = !sid.is_empty() && sid != d.id && group.contains(sid);
        let (exists, value, unread) = cursor_evidence(reader, &d.id);
        let drain_bad = any_drain && exists == Some(false) && value <= 0.0 && unread == Some(true);
        let credit = crate::meshw::rosterrows::session_authored_heartbeat(inv, &d.id) == Some(true);
        let score = [f64::from(!alias), f64::from(!drain_bad), f64::from(credit), d.updated_at.filter(|u| u.is_finite()).unwrap_or(-1.0), if reader.is_some() { value } else { -1.0 }];
        if best.as_ref().is_none_or(|(_, b)| score.partial_cmp(b) == Some(std::cmp::Ordering::Greater)) {
            best = Some((i, score));
        }
    }
    if let Some((i, _)) = best {
        return Ok(list[i].clone());
    }
    let at = |d: &Row| d.updated_at.filter(|u| u.is_finite()).unwrap_or(-1.0);
    let mut win = &list[0];
    for d in &list[1..] {
        if at(d) > at(win) || (at(d) == at(win) && d.id < win.id) {
            win = d;
        }
    }
    Ok(win.clone())
}

/// A worktree label row nobody reads: a `primary-<hash>` id with no session (or a synthetic one) and no reader of its partition. A
/// spawn pre-registers the child's worktree under such a label and the child later registers under its own id; a message sent to the
/// label in between waits in a partition no session reads until reconcile folds the label into the child (SkyCrew 2026-10-22: four
/// minutes of silence behind "verified").
fn label_without_reader(row: &Row, readers: usize) -> bool {
    let session = row.session_id.as_deref().unwrap_or("");
    row.id.starts_with(defaults::text("mesh_write.primary_prefix")) && readers == 0 && (session.is_empty() || session.starts_with(defaults::text("mesh_write.synthetic_session_prefix")))
}

/// What `resolveReadArgToId` made of a read verb's id argument.
pub(crate) enum ReadArg {
    /// The argument itself (a registry row, or nothing resolves it).
    Same,
    /// A registry row's id the argument named (a mesh label or prefix).
    To(String),
    /// Several rows: the candidate ids.
    Ambiguous(Vec<String>),
}

/// `resolveReadArgToId(ctx, home, arg)` over the project's registry rows: an exact row wins; else the address resolves as `send --to`
/// does (without the stale-twin reroute).
pub(crate) fn resolve_read_arg(inv: &Inv, reader: &crate::mesh::MeshReader, rows: &[Row], arg: &str) -> R<ReadArg> {
    if rows.iter().any(|r| r.id == arg) {
        return Ok(ReadArg::Same);
    }
    Ok(match resolve_send_target(inv, Some(reader), rows, arg)? {
        Resolved::Unregistered => ReadArg::Same,
        Resolved::Row(t) if t.id == arg => ReadArg::Same,
        Resolved::Row(t) | Resolved::Rerouted(t, ..) => ReadArg::To(t.id),
        Resolved::Redirected(t, _) => ReadArg::To(t.id),
        Resolved::AmbiguousPrefix(ids) | Resolved::AmbiguousRows(ids) => ReadArg::Ambiguous(ids),
    })
}

/// What `--to` named.
enum Resolved {
    /// The recipient's registry row.
    Row(Row),
    /// The addressed row is stale and a live row of the same session took its place: the row to deliver to, the id addressed and why.
    Rerouted(Row, String, &'static str),
    /// The address was retired by a fold and a registry row of the survivor took its place: the row and the id addressed.
    Redirected(Row, String),
    /// No row by mesh id, id or id prefix.
    Unregistered,
    /// The exact id and the mesh label name different rows, or several rows share the id: the ids (Node's non-prefix `ambiguous`).
    AmbiguousRows(Vec<String>),
    /// Several rows share the id prefix: the full ids, sorted.
    AmbiguousPrefix(Vec<String>),
}

impl Resolved {
    fn from_row(r: Option<Row>) -> Self {
        r.map_or(Resolved::Unregistered, Resolved::Row)
    }
}

/// `resolveSendTarget(store, arg, home, { rerouteStaleTwin: true })` where it needs no liveness and no redirect: `None` is the
/// unregistered recipient (no row by mesh id or by id, and no retired-redirect to follow).
fn resolve_send_target(inv: &Inv, reader: Option<&crate::mesh::MeshReader>, rows: &[Row], arg: &str) -> R<Resolved> {
    let by_mesh = resolve_mesh_target(inv, reader, rows, Some(arg))?;
    if arg.is_empty() {
        return Ok(Resolved::from_row(by_mesh));
    }
    let id_matches: Vec<&Row> = rows.iter().filter(|d| !d.id.is_empty() && d.id == arg).collect();
    match id_matches.len() {
        1 => {
            let row = id_matches[0];
            let same_row = by_mesh.as_ref().is_some_and(|b| b.id == row.id);
            let own = match row.worktree_path.as_deref() {
                Some(p) => ident::canonical_mesh_id(p)?,
                None => None,
            };
            let same_group = own.as_deref() == Some(arg);
            if let Some(b) = &by_mesh {
                if !same_row && !same_group {
                    return Ok(Resolved::AmbiguousRows(vec![row.id.clone(), b.id.clone()]));
                }
                if same_group && !same_row {
                    note_ref("mesh_write.ref_outcome_mesh");
                    return Ok(Resolved::Row(b.clone()));
                }
            }
            // staleTwinSuccessor: proven inert only when the row has no session, a synthetic one, or its own id as session
            let sid = row.session_id.as_deref().unwrap_or("");
            if sid.is_empty() || sid.starts_with(defaults::text("mesh_write.synthetic_session_prefix")) || sid == row.id {
                note_ref("mesh_write.ref_outcome_exact");
                return Ok(Resolved::Row(row.clone()));
            }
            // staleTwinSuccessor: the row is delivered to as addressed unless it is stale (not live, or its session runs in another
            // checkout) AND another live row of the same session proves a successor; only that reroute is Node's
            let sid = sid.to_string();
            let now = inv.now as f64;
            let live = crate::meshw::rosterrows::routing_live_strict(inv, now, &row.id, row.worktree_path.as_deref(), row.session_id.as_deref())?;
            let coherent = match row.worktree_path.as_deref() {
                Some(w) if !w.is_empty() => crate::dssup::liveness::session_worktree_coherent(&inv.home, &sid, w)?,
                _ => None,
            };
            if live && coherent != Some(false) {
                note_ref("mesh_write.ref_outcome_exact");
                return Ok(Resolved::Row(row.clone()));
            }
            // positive proof only: a live row of the same session whose checkout the session really runs in
            let mut others: Vec<Row> = Vec::new();
            for d in rows.iter().filter(|d| d.id != row.id && d.session_id.as_deref() == Some(sid.as_str())) {
                let Some(w) = d.worktree_path.as_deref().filter(|w| !w.is_empty()) else { continue };
                if crate::meshw::rosterrows::routing_live_strict(inv, now, &d.id, Some(w), d.session_id.as_deref())?
                    && crate::dssup::liveness::session_worktree_coherent(&inv.home, &sid, w)? == Some(true)
                {
                    others.push(d.clone());
                }
            }
            if others.is_empty() {
                note_ref("mesh_write.ref_outcome_exact");
                return Ok(Resolved::Row(row.clone()));
            }
            let pick = if others.len() == 1 { others.remove(0) } else { pick_freshest_live(inv, reader, others)? };
            let why = defaults::text(if live { "mesh_write.reroute_incoherent" } else { "mesh_write.reroute_not_live" });
            note_ref("mesh_write.ref_outcome_exact");
            Ok(Resolved::Rerouted(pick, row.id.clone(), why))
        }
        0 => {
            if by_mesh.is_some() {
                note_ref("mesh_write.ref_outcome_mesh");
                return Ok(Resolved::from_row(by_mesh));
            }
            // a descriptor id (the app uuid) whose worktree derives to a registered mesh label routes to that row
            if let Some(mesh) = descriptor_mesh_id(&inv.home, arg)?.filter(|m| m != arg)
                && let Some(row) = resolve_mesh_target(inv, reader, rows, Some(&mesh))?
            {
                note_ref("mesh_write.ref_outcome_mesh");
                return Ok(Resolved::Row(row));
            }
            // one hop through a fold-time redirect, looked up in the registry directly (never by recursing: a cyclic file cannot loop)
            if let Some(to) = crate::meshw::readprimary::read_retired_redirect(inv, arg)
                && let Some(survivor) = rows.iter().find(|d| d.id == to)
            {
                return Ok(Resolved::Redirected(survivor.clone(), arg.to_string()));
            }
            // GH #203: the roster shows only a short id, so a unique id prefix is the recipient. The pool is the registry
            // ids AND the live descriptor ids (Node's union), sorted and deduplicated.
            let mut pool: std::collections::BTreeSet<String> =
                rows.iter().filter(|d| !d.id.is_empty() && d.id.starts_with(arg)).map(|d| d.id.clone()).collect();
            pool.extend(descriptor_prefix_ids(&inv.home, arg));
            let ids: Vec<String> = pool.into_iter().collect();
            match ids.as_slice() {
                [] => {
                    note_ref("mesh_write.ref_outcome_none");
                    Ok(Resolved::Unregistered)
                }
                // the full `arg` was tried above (alias included): recursing on it would loop
                [only] if only == arg => {
                    note_ref("mesh_write.ref_outcome_none");
                    Ok(Resolved::Unregistered)
                }
                [only] => {
                    note_ref("mesh_write.ref_outcome_prefix");
                    resolve_send_target(inv, reader, rows, only)
                }
                _ => {
                    note_ref("mesh_write.ref_outcome_ambiguous");
                    Ok(Resolved::AmbiguousPrefix(ids))
                }
            }
        }
        _ => Ok(Resolved::AmbiguousRows(id_matches.iter().map(|d| d.id.clone()).collect())),
    }
}

/// The ids of the live descriptors (`workspaces/<id>.json`) starting with `prefix` (safe ids only), as Node's prefix pool lists them.
fn descriptor_prefix_ids(home: &std::path::Path, prefix: &str) -> Vec<String> {
    if !crate::meshw::idlock::is_safe_id(prefix) {
        return Vec::new();
    }
    let dir = crate::meshw::idlock::devswarm_root(home).join(defaults::text("mesh_write.dir_workspaces"));
    let suffix = defaults::text("mesh_write.json_suffix");
    let Ok(rd) = std::fs::read_dir(dir) else { return Vec::new() };
    rd.flatten()
        .filter_map(|e| e.file_name().to_string_lossy().strip_suffix(suffix).map(str::to_string))
        .filter(|id| id.starts_with(prefix) && crate::meshw::idlock::is_safe_id(id))
        .collect()
}

/// `descriptorMeshId(home, id)` (Node `send.js`): the mesh label the worktree of the descriptor `id` (live, else archived) derives
/// to; `None` for an unsafe id, no descriptor, or none with a worktree. A truthy non-string `worktreePath` is coerced as `String(x)` (Node's canonicalMeshId/rawPathMeshId both do).
fn descriptor_mesh_id(home: &std::path::Path, id: &str) -> R<Option<String>> {
    if !crate::meshw::idlock::is_safe_id(id) {
        return Ok(None);
    }
    let file = format!("{id}{}", defaults::text("mesh_write.json_suffix"));
    for dir in ["mesh_write.dir_workspaces", "mesh_write.dir_archived"] {
        let p = crate::meshw::idlock::devswarm_root(home).join(defaults::text(dir)).join(&file);
        // readDescriptorPathState: a regular file (lstat) holding a JSON object
        if !std::fs::symlink_metadata(&p).is_ok_and(|m| m.is_file()) {
            continue;
        }
        let Some(d @ OVal::Obj(_)) = std::fs::read(&p).ok().and_then(|b| OVal::parse(&String::from_utf8_lossy(&b))) else { continue };
        let wt = match d.get("worktreePath") {
            Some(OVal::Str(w)) if !w.is_empty() => w.clone(),
            None | Some(OVal::Null | OVal::Str(_) | OVal::Bool(false)) => continue,
            Some(OVal::Num(x)) if *x == 0.0 || x.is_nan() => continue,
            // a truthy non-string path is coerced the way Node's `String(worktreePath)` does
            Some(other) => ident::js_to_string(other),
        };
        return Ok(match ident::canonical_mesh_id(&wt)? {
            Some(c) if !c.is_empty() => Some(c),
            _ => ident::raw_path_mesh_id(&wt)?,
        });
    }
    Ok(None)
}

/// A fold-time retired-redirect file exists for `id` (its content is not read: any file at all is left to Node).
pub(crate) fn retired_redirect_exists(inv: &Inv, id: &str) -> bool {
    crate::meshw::idlock::is_safe_id(id)
        && crate::meshw::idlock::devswarm_root(&inv.home)
            .join(defaults::text("devswarm_cli.rr_dir_retired"))
            .join(format!("{id}{}", defaults::text("mesh_write.json_suffix")))
            .exists()
}

/// `csvList(flags, 'to')`: every `--to` value split on commas, trimmed, empties dropped, duplicates dropped.
fn csv_list(values: &[&str]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for raw in values {
        for part in raw.split(',') {
            let t = crate::checks::guardkit::text::js_trim(part);
            if !t.is_empty() && !out.iter().any(|x| x == t) {
                out.push(t.to_string());
            }
        }
    }
    out
}

/// Whether a result is `ok: true`.
fn is_ok(out: &Obj) -> bool {
    matches!(out.0.iter().find(|(k, _)| k == "ok").map(|(_, v)| v), Some(OVal::Bool(true)))
}

/// The text field `k` of a result.
fn text_of(out: &Obj, k: &str) -> Option<String> {
    match out.0.iter().find(|(x, _)| x == k).map(|(_, v)| v) {
        Some(OVal::Str(t)) => Some(t.clone()),
        _ => None,
    }
}

/// `withSelfHeal`'s additions to a result: the heal fields, and `possiblyStaleRegistry` on a refused address while the
/// ingest daemon reads stale.
fn apply_heal(out: &mut Obj, heal: &[(String, OVal)]) {
    for (k, v) in heal {
        out.put(k, v.clone());
    }
    let stale =
        heal.iter().any(|(k, v)| k == defaults::text("mesh_write.heal_warning") && matches!(v, OVal::Str(x) if x == defaults::text("mesh_write.heal_stale")));
    let reason = text_of(out, "reason");
    if !is_ok(out)
        && stale
        && reason.as_deref().is_some_and(|r| {
            r == defaults::text("devswarm_cli.reason_primary_unregistered") || r == defaults::text("devswarm_cli.reason_unregistered_recipient")
        })
    {
        out.put(defaults::text("devswarm_cli.key_possibly_stale"), OVal::Bool(true));
    }
}

/// Run `send` with `a` (argv already parsed; `a.positionals[0] == "send"`).
pub fn run(inv: &Inv, a: &Args) -> R<Answer> {
    // a help request never reaches here: `simple::classify` takes it first (`is_help` is its test), so `send --help` is `simple`'s
    common::seat_check(inv)?;
    // several recipients (devswarm.sendMultiRecipient, on unless set false): `--to a,b` or a repeated `--to`, deduped
    let to_key = defaults::text("mesh_write.flag_to");
    let mut norm = a.clone();
    let mut recipients: Vec<String> = Vec::new();
    if crate::checks::guardkit::settings::get_bool(&inv.settings(), defaults::raw("mesh_write.setting_send_multi")) && !a.many(to_key).is_empty() {
        recipients = csv_list(&a.many(to_key));
        if recipients.len() == 1 {
            norm.flags.insert(to_key.to_string(), vec![crate::meshw::args::FlagVal::S(recipients[0].clone())]);
        }
    }
    if recipients.len() > 1 {
        return run_multi(inv, a, &recipients);
    }
    let a = &norm;
    let heal = common::self_heal(inv)?;
    let to = a.one(to_key);
    if !a.has(defaults::text("mesh_write.flag_cc_primary")) {
        let out = finish_send(inv, defaults::text("mesh_write.action_send"), to, cmd_send_mode(inv, a, false)?, &heal)?;
        return Ok(answer_of(a, out));
    }
    // --cc-primary: the copy to the Primary is written after the send, so both are settled before the first write
    let direct = to.is_some();
    let ccargs = cc_args(a);
    let planned = cmd_send_mode(inv, a, true)?;
    let copy = direct && is_ok(&planned);
    if copy {
        cmd_send_mode(inv, &ccargs, true)?;
    }
    crate::meshw::clog::ready(inv)?;
    let mut out = finish_send(inv, defaults::text("mesh_write.action_send"), to, cmd_send_mode(inv, a, false)?, &heal)?;
    let was_direct = matches!(out.0.iter().find(|(k, _)| k == "type").map(|(_, v)| v), Some(OVal::Str(t)) if t == defaults::text("mesh_write.mtype_direct"));
    if copy && is_ok(&out) && was_direct {
        let c = finish_send(
            inv,
            defaults::text("devswarm_cli.op_send_cc"),
            Some(defaults::text("devswarm_cli.send_cc_target")),
            cmd_send_mode(inv, &ccargs, false)?,
            &heal,
        )?;
        out.put(defaults::text("devswarm_cli.key_cc_primary"), c.done());
    }
    Ok(answer_of(a, out))
}

/// The flags of the copy to the Primary: the same message, `--to-primary` in place of the recipient.
fn cc_args(a: &Args) -> Args {
    let mut c = a.clone();
    c.flags.remove(defaults::text("mesh_write.flag_to"));
    c.flags.remove(defaults::text("mesh_write.flag_broadcast"));
    c.flags.insert(defaults::text("mesh_write.flag_to_primary").to_string(), vec![crate::meshw::args::FlagVal::True]);
    c
}

/// A finished send as the verb prints it: the heal fields, then the central-log entry of a result that is not ok (`op` and
/// `to` as `logVerbOutcome` names them). Before the first write a log Node would not write is a deferral.
fn finish_send(inv: &Inv, op: &str, to: Option<&str>, mut out: Obj, heal: &[(String, OVal)]) -> R<Obj> {
    apply_heal(&mut out, heal);
    if !is_ok(&out) {
        if !crate::meshw::COMMITTED.load(std::sync::atomic::Ordering::SeqCst) {
            crate::meshw::clog::ready(inv)?;
        }
        log_failed(inv, op, to, &out);
        crate::meshw::mark_committed();
    }
    Ok(out)
}

/// The printed answer of a single send result.
fn answer_of(a: &Args, out: Obj) -> Answer {
    let ok = is_ok(&out);
    let effect = match out.0.iter().find(|(k, _)| k == "hash").map(|(_, v)| v) {
        Some(OVal::Str(h)) => Effect::Row(h.clone()),
        _ => Effect::None,
    };
    let res = out.done();
    let quiet = a.has(defaults::text("mesh_write.flag_quiet")) && !inv_has_json(a);
    let line = if quiet { quiet_line(&res) } else { res.stringify() };
    Answer { code: if ok { 0 } else { 2 }, stdout: format!("{line}\n"), effect }
}

/// `cmdSendMulti`: the same body to each recipient; every one is attempted and reported. Every recipient is settled (no
/// deferral possible) before the first write.
fn run_multi(inv: &Inv, a: &Args, recipients: &[String]) -> R<Answer> {
    let refused_multi = |key: &str| -> R<Answer> {
        let o = refused(&[("action", s(defaults::text("mesh_write.action_send"))), ("error", s(defaults::text(key)))]);
        Ok(answer_of(a, o))
    };
    if a.has(defaults::text("mesh_write.flag_broadcast"))
        || a.one(defaults::text("mesh_write.flag_type")) == Some(defaults::text("mesh_write.mtype_broadcast"))
        || a.has(defaults::text("mesh_write.flag_to_primary"))
    {
        return refused_multi("devswarm_cli.msg_send_multi_combine");
    }
    if a.has(defaults::text("mesh_write.flag_cc_primary")) {
        return refused_multi("devswarm_cli.msg_send_multi_cc");
    }
    // the body is resolved once so every recipient gets identical bytes
    let mut inv2 = inv.clone();
    let mut per = a.clone();
    let m_file = a.one(defaults::text("mesh_write.flag_message_file"));
    let m_stdin = a.has(defaults::text("mesh_write.flag_message_stdin"));
    let sources = usize::from(a.one(defaults::text("mesh_write.flag_message")).is_some()) + usize::from(m_file.is_some()) + usize::from(m_stdin);
    if sources == 1 && (m_file.is_some() || m_stdin) {
        let body = if let Some(f) = m_file {
            match read_message_file(f) {
                Ok(b) => b,
                Err(why) => {
                    let msg = defaults::render("devswarm_cli.msg_send_file_unreadable", &[("file", &quote(f)), ("why", &why)]);
                    return refused_multi_text(a, &msg);
                }
            }
        } else {
            match &inv.stdin {
                Some(sv) => sv.clone(),
                None => {
                    let msg = defaults::render("devswarm_cli.msg_send_multi_stdin_unreadable", &[("why", &defaults::text("devswarm_cli.send_stdin_unavailable_why"))]);
                    return refused_multi_text(a, &msg);
                }
            }
        };
        inv2.stdin = Some(body);
        per.flags.remove(defaults::text("mesh_write.flag_message_file"));
        per.flags.insert(defaults::text("mesh_write.flag_message_stdin").to_string(), vec![crate::meshw::args::FlagVal::True]);
    }
    let heal = common::self_heal(inv)?;
    let mut args_for: Vec<Args> = Vec::new();
    for to in recipients {
        let mut x = per.clone();
        x.flags.insert(defaults::text("mesh_write.flag_to").to_string(), vec![crate::meshw::args::FlagVal::S(to.clone())]);
        args_for.push(x);
    }
    // settle every recipient first: a deferral here wrote nothing
    crate::meshw::clog::ready(inv)?;
    for x in &args_for {
        cmd_send_mode(&inv2, x, true)?;
    }
    let mut rows: Vec<OVal> = Vec::new();
    let mut failed = 0usize;
    for (to, x) in recipients.iter().zip(&args_for) {
        let r = finish_send(&inv2, defaults::text("mesh_write.action_send"), Some(to), cmd_send_mode(&inv2, x, false)?, &heal)?;
        let ok = is_ok(&r);
        let mut row = Obj::default();
        row.put("to", s(to)).put("ok", OVal::Bool(ok));
        if let Some((_, v)) = r.0.iter().find(|(k, _)| k == "seq") {
            row.put("seq", v.clone());
        }
        if let Some((_, v)) = r.0.iter().find(|(k, _)| k == "bytes") {
            row.put("bytes", v.clone());
        }
        if let Some((_, v)) = r.0.iter().find(|(k, _)| k == "toId") {
            row.put("toId", v.clone());
        }
        if !ok {
            failed += 1;
            let why =
                text_of(&r, "error").or_else(|| text_of(&r, "reason")).unwrap_or_else(|| defaults::text("devswarm_cli.msg_send_multi_row_failed").to_string());
            row.put("error", s(&why));
            if let Some(rs) = text_of(&r, "reason") {
                row.put("reason", s(&rs));
            }
        }
        rows.push(row.done());
    }
    let total = rows.len();
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(failed == 0))
        .put("action", s(defaults::text("mesh_write.action_send")))
        .put("type", s(defaults::text("devswarm_cli.send_multi_type")))
        .put("recipients", OVal::Arr(rows))
        .put("sent", n((total - failed) as f64))
        .put("failed", n(failed as f64));
    if failed > 0 {
        o.put("error", s(&defaults::render("devswarm_cli.msg_send_multi_failed", &[("failed", &failed), ("total", &total)])));
    }
    Ok(answer_of(a, o))
}

fn refused_multi_text(a: &Args, msg: &str) -> R<Answer> {
    Ok(answer_of(a, refused(&[("action", s(defaults::text("mesh_write.action_send"))), ("error", s(msg))])))
}

/// `fs.readFileSync(path, 'utf8')`: the text, or `Err(message)` with JavaScript's message for the failure (an error number the
/// table lists is worded as libuv words it, any other by the operating system's own text).
fn read_message_file(path: &str) -> Result<String, String> {
    match std::fs::read(path) {
        Ok(b) => Ok(String::from_utf8_lossy(&b).into_owned()),
        Err(e) => {
            let table = defaults::raw("devswarm_cli.send_fs_errors");
            let tpl = e.raw_os_error().and_then(|c| table.get(&c.to_string())).and_then(|v| v.as_str());
            let quoted = format!("'{path}'");
            Err(match tpl {
                Some(t) => t.replace("{path}", &quoted),
                None => {
                    let text = e.to_string();
                    let message = text.split(" (os error").next().unwrap_or(&text).to_string();
                    defaults::render("devswarm_cli.send_fs_error_other", &[("message", &message), ("path", &quoted)])
                }
            })
        }
    }
}

/// `logVerbOutcome(op, id, r, ctx)` for a result that is not ok.
fn log_failed(inv: &Inv, op: &str, to: Option<&str>, out: &Obj) {
    let text = |k: &str| match out.0.iter().find(|(x, _)| x == k).map(|(_, v)| v) {
        Some(OVal::Str(t)) => Some(t.clone()),
        _ => None,
    };
    let msg = text("error").or_else(|| text("reason")).unwrap_or_else(|| defaults::text("devswarm_cli.msg_log_not_ok").to_string());
    let repo_key = ident::resolve_context(&inv.cwd, true).ok().and_then(|c| c.repo_key);
    crate::meshw::clog::refusal(inv, op, repo_key.as_deref(), to, &msg, text("reason").as_deref());
}

fn inv_has_json(a: &Args) -> bool {
    a.has(defaults::text("mesh_write.flag_json"))
}

/// `sendQuietLine(result)` for one recipient.
fn quiet_line(r: &OVal) -> String {
    if let Some(OVal::Arr(rows)) = r.get("recipients") {
        return rows
            .iter()
            .map(|row| {
                let get = |k: &str| row.get(k).map(OVal::stringify).unwrap_or_else(|| defaults::text("mesh_write.js_undefined").to_string());
                let to = match row.get("to") {
                    Some(OVal::Str(t)) => t.clone(),
                    Some(v) => v.stringify(),
                    None => defaults::text("mesh_write.js_undefined").to_string(),
                };
                if row.get("ok").is_some_and(OVal::truthy) {
                    defaults::render("mesh_write.quiet_ok", &[("seq", &get("seq")), ("to", &to), ("bytes", &get("bytes"))])
                } else {
                    let why = match row.get("error") {
                        Some(OVal::Str(e)) if !e.is_empty() => e.clone(),
                        _ => defaults::text("mesh_write.quiet_failed").to_string(),
                    };
                    defaults::render("mesh_write.quiet_fail_to", &[("to", &to), ("why", &why)])
                }
            })
            .collect::<Vec<_>>()
            .join("\n");
    }
    let get = |k: &str| r.get(k).map(OVal::stringify).unwrap_or_else(|| defaults::text("mesh_write.js_undefined").to_string());
    if r.get("ok").is_some_and(OVal::truthy) {
        let to = if matches!(r.get("type"), Some(OVal::Str(t)) if t == defaults::text("mesh_write.mtype_broadcast")) {
            defaults::text("mesh_write.quiet_broadcast").to_string()
        } else {
            match r.get("to") {
                Some(OVal::Str(t)) => t.clone(),
                Some(OVal::Null) | None => defaults::text("mesh_write.quiet_unknown").to_string(),
                Some(v) => v.stringify(),
            }
        };
        return defaults::render("mesh_write.quiet_ok", &[("seq", &get("seq")), ("to", &to), ("bytes", &get("bytes"))]);
    }
    let why = match (r.get("error"), r.get("reason")) {
        (Some(OVal::Str(e)), _) if !e.is_empty() => e.clone(),
        (_, Some(OVal::Str(x))) if !x.is_empty() => x.clone(),
        _ => defaults::text("mesh_write.quiet_failed").to_string(),
    };
    defaults::render("mesh_write.quiet_fail", &[("why", &why)])
}

/// A refusal `cmdSend` returns: `{ ok: false, ...fields }` in Node's key order. The caller logs it and prints it (exit 2).
fn refused(fields: &[(&str, OVal)]) -> Obj {
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(false));
    for (k, v) in fields {
        o.put(k, v.clone());
    }
    o
}

/// `JSON.stringify(text)` of a string, as Node's refusal texts quote their values.
fn quote(text: &str) -> String {
    serde_json::to_string(text).unwrap_or_default()
}

/// `cmdSend(flags, ctx)`: the successful path or a refusal Node logs, else [`Defer`].
pub(crate) fn cmd_send(inv: &Inv, a: &Args) -> R<Obj> {
    cmd_send_mode(inv, a, false)
}

/// `cmdSend` with `plan` set: everything up to the first write is decided (a deferral or a refusal is returned as it would
/// be), and a send that would be written returns `{ ok: true }` without writing anything.
pub(crate) fn cmd_send_mode(inv: &Inv, a: &Args, plan: bool) -> R<Obj> {
    let home = &inv.home;
    let cwd = ident::project_cwd_for(home, &inv.env, &inv.cwd)?;
    let Some(repo_key) = ident::repo_key_for_worktree(&cwd)? else {
        return Ok(refused(&[
            ("action", s(defaults::text("mesh_write.action_send"))),
            ("reason", s(defaults::text("devswarm_cli.reason_no_project"))),
            ("error", s(defaults::text("devswarm_cli.msg_send_no_project"))),
        ]));
    };
    // registrySnapshot opens the store as a writer; the engine opens it once, below, and refuses what Node would create
    let st = common::open_store(inv, &repo_key)?;
    let rows = ident::rows_of(&st.reader().roster().map_err(|e| Defer(format!("registry:{e}")))?);
    let from_d = ident::sender_identity_detailed(&inv.env, &cwd, &rows, home)?;
    // writeAlias(home, meshId, child, worktree): a no-op when the alias already says so
    common::ensure_alias(inv, &from_d, &cwd);
    let from = from_d.identity.clone();
    if let Some(ff) = a.one(defaults::text("mesh_write.flag_from"))
        && ff != from
        && Some(ff) != from_d.mesh_id.as_deref()
    {
        let msg = defaults::render("devswarm_cli.msg_send_from_mismatch", &[("from_flag", &quote(ff)), ("from", &quote(&from))]);
        return Ok(refused(&[("error", s(&msg))]));
    }
    let to_flag = a.one(defaults::text("mesh_write.flag_to"));
    let broadcast = a.has(defaults::text("mesh_write.flag_broadcast"))
        || a.one(defaults::text("mesh_write.flag_type")) == Some(defaults::text("mesh_write.mtype_broadcast"));
    let to_primary = a.has(defaults::text("mesh_write.flag_to_primary"));
    let modes = usize::from(to_flag.is_some()) + usize::from(broadcast) + usize::from(to_primary);
    if modes != 1 {
        let key = if modes > 1 { "devswarm_cli.msg_send_target_many" } else { "devswarm_cli.msg_send_target_none" };
        return Ok(refused(&[("error", s(defaults::text(key)))]));
    }
    // JEV outcome tracking (best-effort, direct sends only): a plan pass writes nothing, the real pass records it
    if !plan
        && !broadcast
        && let Some(t) = to_flag
    {
        common::jev_record_answered(inv, &from, t);
    }
    let question = a.has(defaults::text("mesh_write.flag_question"));
    let answers = a.has(defaults::text("mesh_write.flag_answers"));
    if broadcast && question {
        return Ok(refused(&[("error", s(defaults::text("devswarm_cli.msg_send_question_broadcast")))]));
    }
    if broadcast && answers {
        return Ok(refused(&[("error", s(defaults::text("devswarm_cli.msg_send_answers_broadcast")))]));
    }
    let m_flag = a.one(defaults::text("mesh_write.flag_message"));
    let m_file = a.one(defaults::text("mesh_write.flag_message_file"));
    let m_stdin = a.has(defaults::text("mesh_write.flag_message_stdin"));
    let sources = usize::from(m_flag.is_some()) + usize::from(m_file.is_some()) + usize::from(m_stdin);
    if sources != 1 {
        let key = if sources > 1 { "devswarm_cli.msg_send_source_many" } else { "devswarm_cli.msg_send_source_none" };
        return Ok(refused(&[("error", s(defaults::text(key)))]));
    }
    let message = if let Some(f) = m_file {
        match read_message_file(f) {
            Ok(b) => b,
            Err(why) => {
                let msg = defaults::render("devswarm_cli.msg_send_file_unreadable", &[("file", &quote(f)), ("why", &why)]);
                return Ok(refused(&[("error", s(&msg))]));
            }
        }
    } else if m_stdin {
        match &inv.stdin {
            Some(sv) => sv.clone(),
            None => {
                let msg = defaults::render("devswarm_cli.msg_send_stdin_unreadable", &[("why", &defaults::text("devswarm_cli.send_stdin_unavailable_why"))]);
                return Ok(refused(&[("error", s(&msg))]));
            }
        }
    } else {
        m_flag.unwrap_or_default().to_string()
    };
    if message.is_empty() {
        return Ok(refused(&[("error", s(defaults::text("devswarm_cli.msg_send_empty")))]));
    }
    let urgency = a.one(defaults::text("mesh_write.flag_urgency")).unwrap_or(defaults::text("mesh_write.urgency_default")).to_string();
    let allowed = defaults::list("mesh_write.allowed_urgency");
    if !allowed.contains(&urgency.as_str()) {
        let msg = defaults::render("devswarm_cli.msg_send_urgency", &[("allowed", &allowed.join("|"))]);
        return Ok(refused(&[("error", s(&msg)), ("allowed", OVal::Arr(allowed.iter().map(|w| s(w)).collect()))]));
    }
    let mut primary_mesh: Option<String> = None;
    if to_primary {
        let c = ident::resolve_context(&cwd, false)?;
        let Some(common_dir) = c.common_dir else {
            return Ok(refused(&[
                ("reason", s(defaults::text("devswarm_cli.reason_send_no_primary_worktree"))),
                ("error", s(defaults::text("devswarm_cli.msg_send_no_primary_worktree"))),
            ]));
        };
        primary_mesh = Some(ident::primary_workspace_id(&ident::dirname(&common_dir))?);
    }
    if !broadcast {
        let self_target = if to_primary { primary_mesh.clone() } else { to_flag.map(str::to_string) };
        if self_target.as_deref() == Some(from.as_str()) || (from_d.mesh_id.is_some() && self_target == from_d.mesh_id) {
            let suffix = if to_primary { defaults::text("devswarm_cli.send_self_primary_suffix") } else { "" };
            return Ok(refused(&[("error", s(&defaults::render("devswarm_cli.msg_send_self", &[("suffix", &suffix)])))]));
        }
    }
    let now = inv.now;
    // P1-1/P1-2 RE-HOME (send path): a Primary stranded in the legacy hash bucket is migrated before it is resolved
    let mut rehomed = false;
    if let Some(pm) = &primary_mesh {
        rehomed = maybe_rehome_to_cwd_project(inv, pm)?;
        if plan {
            REHOMED_IN_PLAN.store(rehomed, std::sync::atomic::Ordering::SeqCst);
        } else {
            rehomed |= REHOMED_IN_PLAN.swap(false, std::sync::atomic::Ordering::SeqCst);
        }
    }
    // target resolution (direct)
    let mut reroute: Option<(String, &'static str)> = None;
    let mut redirect: Option<String> = None;
    let target: Option<Row> = if broadcast {
        None
    } else if let Some(pm) = &primary_mesh {
        match resolve_mesh_target(inv, Some(&st.reader()), &rows, Some(pm))? {
            Some(t) => Some(t),
            None => {
                return Ok(refused(&[
                    ("reason", s(defaults::text("devswarm_cli.reason_primary_unregistered"))),
                    ("error", s(defaults::text("devswarm_cli.msg_send_primary_unregistered"))),
                ]));
            }
        }
    } else {
        match resolve_send_target(inv, Some(&st.reader()), &rows, to_flag.unwrap_or_default())? {
            Resolved::Row(t) => Some(t),
            Resolved::Rerouted(t, from, why) => {
                reroute = Some((from, why));
                Some(t)
            }
            Resolved::Redirected(t, from) => {
                redirect = Some(from);
                Some(t)
            }
            Resolved::AmbiguousRows(ids) => {
                let list = ids.join(defaults::text("devswarm_cli.send_prefix_candidates_sep"));
                let msg = defaults::render("devswarm_cli.msg_send_rows_ambiguous", &[("to", &quote(to_flag.unwrap_or_default())), ("candidates", &list)]);
                return Ok(refused(&[("reason", s(defaults::text("devswarm_cli.reason_ambiguous_recipient"))), ("error", s(&msg))]));
            }
            Resolved::AmbiguousPrefix(ids) => {
                let list = ids.join(defaults::text("devswarm_cli.send_prefix_candidates_sep"));
                let msg = defaults::render("devswarm_cli.msg_send_prefix_ambiguous", &[("to", &quote(to_flag.unwrap_or_default())), ("candidates", &list)]);
                return Ok(refused(&[("reason", s(defaults::text("devswarm_cli.reason_ambiguous_recipient"))), ("error", s(&msg))]));
            }
            Resolved::Unregistered => {
                let msg = defaults::render("devswarm_cli.msg_send_unregistered", &[("to", &quote(to_flag.unwrap_or_default()))]);
                return Ok(refused(&[("reason", s(defaults::text("devswarm_cli.reason_unregistered_recipient"))), ("error", s(&msg))]));
            }
        }
    };
    let candidates = match &target {
        Some(t) => {
            let mesh_for_count = match t.worktree_path.as_deref() {
                Some(p) => match ident::canonical_mesh_id(p)? {
                    Some(c) => Some(c),
                    None => ident::raw_path_mesh_id(p)?,
                },
                None => None,
            };
            Some(mesh_candidates(&rows, mesh_for_count.as_deref())?.len())
        }
        None => None,
    };
    let partition = target.as_ref().map(|t| t.id.clone());
    let no_reader = !broadcast
        && target.as_ref().is_some_and(|t| label_without_reader(t, st.reader().reader_cursors(&t.id).map_or(1, |r| r.len())));
    // the summary refresh after the write must be one the engine can do (else Node runs the whole verb)
    crate::meshw::summary::check(&st, inv, partition.as_deref())?;
    if plan {
        let mut o = Obj::default();
        o.put("ok", OVal::Bool(true));
        return Ok(o);
    }
    // ---- commit: everything below writes ----
    let to_out: Option<String> = if broadcast {
        None
    } else if to_primary {
        primary_mesh.clone()
    } else {
        to_flag.map(str::to_string)
    };
    let ctx = AppendCtx {
        inv,
        st: &st,
        from: &from,
        kind: &from_d.kind,
        to_out: to_out.as_deref(),
        partition: partition.as_deref(),
        broadcast,
        message: &message,
        urgency: &urgency,
        now,
        question,
        answers,
        candidates,
        no_reader,
        reroute: reroute.as_ref().map(|(f, w)| (f.as_str(), *w)),
        redirect: redirect.as_deref(),
        rehomed,
        repo_key: &repo_key,
        cwd: &cwd,
    };
    if broadcast {
        return do_append(&ctx);
    }
    let pid = partition.clone().unwrap_or_default();
    let attempts = defaults::num("mesh_write.send_lock_attempts").max(1);
    for attempt in 0..attempts {
        if let Some(lock) = crate::meshw::idlock::acquire(&inv.write_home, &pid) {
            let still = st.reader().roster().map(|r| ident::rows_of(&r).iter().any(|x| x.id == pid)).unwrap_or(false);
            let r = if still {
                do_append(&ctx)
            } else {
                let msg = defaults::render("devswarm_cli.msg_send_moved", &[("id", &quote(&pid))]);
                Ok(refused(&[("reason", s(defaults::text("devswarm_cli.reason_unregistered_recipient"))), ("error", s(&msg))]))
            };
            lock.release();
            return r;
        }
        if attempt + 1 < attempts {
            let base = defaults::num("mesh_write.send_lock_retry_base_ms");
            let backoff = base * (1u64 << attempt.min(defaults::num("mesh_write.send_lock_max_shift"))) + store::jitter_ms(base);
            std::thread::sleep(std::time::Duration::from_millis(backoff));
        }
    }
    // every attempt found the lock held: `{ ok: false, lockBusy: true, id, error, retriedAttempts }`
    let keys = defaults::list("devswarm_cli.key_lock_busy");
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(false))
        .put(keys[0], OVal::Bool(true))
        .put(keys[1], s(&pid))
        .put("error", s(&defaults::render("devswarm_cli.msg_lock_busy", &[("id", &quote(&pid))])))
        .put(keys[2], n(attempts as f64));
    Ok(o)
}

/// Set by a plan pass that re-homed the Primary, taken by the real pass that reports it (`rehomedFromHashBucket`): a send with
/// `--cc-primary` settles the copy in a plan pass before the first write, and the re-home is done there, once.
static REHOMED_IN_PLAN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// `maybeRehomeToCwdProject(home, id, ctx)`: when the current checkout resolves a project key AND the descriptor's persisted owner key
/// is the legacy hash bucket (the split-brain marker), and the id is not registered to another project (the foreign-strand
/// guard), re-home the id into the caller's project under the id's lock. `true` when a re-home moved the registry row.
pub(crate) fn maybe_rehome_to_cwd_project(inv: &Inv, id: &str) -> R<bool> {
    let Some(repo_key) = ident::resolve_context(&inv.cwd, true)?.repo_key else { return Ok(false) };
    let hash_key = hash_from_workspace_id(id);
    if hash_key.is_empty() || hash_key == repo_key {
        return Ok(false);
    }
    let Some(desc) = ident::read_descriptor(&inv.home, id) else { return Ok(false) };
    let owner = match desc.get(defaults::text("mesh_write.field_owner_key")) {
        Some(OVal::Str(sv)) if !sv.is_empty() => Some(sv.as_str()),
        _ => None,
    };
    if owner != Some(hash_key.as_str()) {
        return Ok(false);
    }
    if let Some(registered) = crate::meshw::inbox::registered_repo_key(&desc, id)?
        && registered != repo_key
    {
        return Ok(false);
    }
    let st = inv.settings();
    let ctx = crate::dssup::tick::Ctx { home: &inv.home, root: std::path::Path::new(""), st: &st, now: inv.now, engine_pokes: false };
    let moved = crate::dssup::recon::rehome::core(&ctx, id, &repo_key);
    if moved.rehomed {
        crate::meshw::mark_committed();
    }
    Ok(moved.rehomed)
}

/// The re-home the read, gate and tick verbs run before they open the store (see [`maybe_rehome_to_cwd_project`]); what happened is
/// not reported by them.
pub(crate) fn rehome_is_noop(inv: &Inv, id: &str) -> R<()> {
    maybe_rehome_to_cwd_project(inv, id).map(|_| ())
}

/// `hashFromWorkspaceId(id)`.
pub fn hash_from_workspace_id(id: &str) -> String {
    let p = defaults::text("mesh_write.primary_prefix");
    let hex_len = defaults::num("mesh_write.mesh_id_hex") as usize;
    if let Some(rest) = id.strip_prefix(p)
        && rest.len() == hex_len
        && rest.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return rest.to_ascii_lowercase();
    }
    let d = ring::digest::digest(&ring::digest::SHA256, id.as_bytes());
    store::hex(d.as_ref())[..hex_len].to_string()
}

struct AppendCtx<'a> {
    inv: &'a Inv,
    st: &'a MeshStore,
    from: &'a str,
    kind: &'a str,
    to_out: Option<&'a str>,
    partition: Option<&'a str>,
    broadcast: bool,
    message: &'a str,
    urgency: &'a str,
    now: i64,
    question: bool,
    answers: bool,
    candidates: Option<usize>,
    /// The recipient is a label row no session reads yet (see [`label_without_reader`]).
    no_reader: bool,
    /// The row addressed and why delivery went to its live twin (`reroutedFrom`, `rerouteReason`).
    reroute: Option<(&'a str, &'static str)>,
    /// The id addressed when a fold-time retired-redirect led to the row (`redirected`, `redirectedFrom`).
    redirect: Option<&'a str>,
    /// The Primary was re-homed out of the hash bucket by this send (`rehomedFromHashBucket`).
    rehomed: bool,
    repo_key: &'a str,
    cwd: &'a str,
}

/// `doAppend()`: append, read it back, build the result, write the receipt. A failed INSERT wrote nothing (SQLite
/// statements are atomic), so it defers and Node reports it.
fn do_append(c: &AppendCtx<'_>) -> R<Obj> {
    let mtype = if c.broadcast { defaults::text("mesh_write.mtype_broadcast") } else { defaults::text("mesh_write.mtype_direct") };
    let to_field = if c.broadcast { None } else { c.partition };
    let ts = c.now.to_string();
    let hash = store::mesh_message_hash(Some(c.from), to_field, mtype, c.urgency, c.message, &ts, c.question);
    let nonce = ident::reader_nonce(&c.inv.home);
    let row = store::mesh_message_row(Some(c.from), to_field, c.broadcast, c.message, c.now, c.urgency, &hash, c.question, nonce.as_deref());
    let (inserted, seq) = match c.st.append_mesh_row(&row) {
        Ok(r) => (r.inserted, r.seq),
        Err(e) => return Err(Defer(format!("append:{e}"))),
    };
    crate::meshw::mark_committed();
    // deriveSummary(s, {home, env, now}), in the same call as the append (the wake watcher reads it)
    if let Some(why) = crate::meshw::summary::derive_after_write(c.st, c.inv, c.repo_key) {
        crate::meshw::log_summary_failure(defaults::text("mesh_write.verb_send"), &why);
    }
    let verify_partition = if c.broadcast { defaults::text("mesh_write.broadcast_partition").to_string() } else { c.partition.unwrap_or_default().to_string() };
    let mut verified = false;
    let mut verify_error: Option<String> = None;
    {
        let mut last: Option<String> = None;
        let mut any = false;
        let r = c.st.reader().for_each_message(&verify_partition, 0, |m| {
            let h = m["hash"].as_str().map(str::to_string);
            if h.as_deref() == Some(hash.as_str()) {
                any = true;
            }
            last = h;
            true
        });
        match r {
            Ok(()) => verified = last.as_deref() == Some(hash.as_str()) || any,
            Err(e) => verify_error = Some(e.to_string()),
        }
    }
    let ok = verified || verify_error.is_some();
    let bytes = c.message.len() as f64;
    let mut out = Obj::default();
    out.put("ok", OVal::Bool(ok))
        .put("action", s(defaults::text("mesh_write.action_send")))
        .put("from", s(c.from))
        .put("identity", Obj(vec![("id".into(), s(c.from)), ("kind".into(), s(c.kind))]).done())
        .put("to", s_or_null(c.to_out))
        .put("type", s(mtype))
        .put("urgency", s(c.urgency))
        .put("sent", OVal::Bool(inserted))
        .put("seq", seq.map_or(OVal::Null, |x| n(x as f64)));
    if let Some(from) = c.redirect {
        out.put("redirected", OVal::Bool(true)).put("redirectedFrom", s(from));
    }
    if let Some((from, why)) = c.reroute {
        out.put("rerouted", OVal::Bool(true)).put("reroutedFrom", s(from)).put("rerouteReason", s(why));
    }
    out.put("bytes", n(bytes))
        .put("hash", s(&hash));
    if c.rehomed {
        out.put("rehomedFromHashBucket", OVal::Bool(true));
    }
    out.put("needsReply", OVal::Bool(c.question))
        .put("answers", OVal::Bool(c.answers))
        .put("toId", s_or_null(if c.broadcast { None } else { c.partition }));
    if let Some(k) = c.candidates {
        out.put("candidates", n(k as f64));
    }
    out.put("verified", OVal::Bool(verified));
    if c.no_reader {
        out.put("noReader", OVal::Bool(true));
        out.put("warning", s(&defaults::render("mesh_write.msg_send_label_no_reader", &[("to", &c.partition.unwrap_or_default())])));
    }
    // the receipt (writeSendReceipt), written before verifyError/reason are added, exactly as Node orders it
    let receipt = Obj(vec![
        ("ts".into(), n(c.now as f64)),
        ("from".into(), s(c.from)),
        ("to".into(), s_or_null(c.to_out)),
        ("toId".into(), s_or_null(if c.broadcast { None } else { c.partition })),
        ("type".into(), s(mtype)),
        ("urgency".into(), s(c.urgency)),
        ("hash".into(), s(&hash)),
        ("bytes".into(), n(bytes)),
        ("ok".into(), OVal::Bool(ok)),
        ("sent".into(), OVal::Bool(inserted)),
        ("needsReply".into(), OVal::Bool(c.question)),
        ("verified".into(), OVal::Bool(verified)),
        ("repoKey".into(), s(c.repo_key)),
        ("cwd".into(), s(c.cwd)),
    ])
    .done();
    common::write_send_receipt(&c.inv.write_home, c.now, &hash, &receipt);
    // LABEL AT ARRIVAL: a freshly inserted un-flagged direct message is queued for Jev triage in Node (see `jev_arrival_skipped`)
    if inserted && !c.broadcast && !c.question && common::jev_maybe_enabled(c.inv) {
        common::jev_arrival_skipped();
    }
    // a sent message is child activity: refresh the sender's plan progress clock (fresh text only), best effort
    if inserted {
        common::note_sender_activity(c.inv, c.from, c.message, c.now as f64);
    }
    if let Some(e) = verify_error {
        out.put("verifyError", s(&e));
    }
    if !verified && out.0.iter().all(|(k, _)| k != "verifyError") {
        out.put("reason", s(defaults::text("mesh_write.reason_not_verified")));
        out.put(
            "error",
            s(&defaults::render(
                "mesh_write.msg_not_verified",
                &[("hash", &hash), ("partition", &serde_json::to_string(&verify_partition).unwrap_or_default())],
            )),
        );
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// #203: a live descriptor id by prefix is found (the engine then hands the send to Node's alias step); other prefixes are not.
    #[test]
    fn a_live_descriptor_id_prefix_is_found() {
        let home = std::env::temp_dir().join(format!("ah-descprefix-{}", std::process::id()));
        let dir = crate::meshw::idlock::devswarm_root(&home).join(defaults::text("mesh_write.dir_workspaces"));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::File::create(dir.join(format!("c5dbd3c3-1e53{}", defaults::text("mesh_write.json_suffix")))).unwrap();
        assert_eq!(descriptor_prefix_ids(&home, "c5dbd3c3"), vec!["c5dbd3c3-1e53".to_string()]);
        assert_eq!(descriptor_prefix_ids(&home, "c5dbd3c3-1e53").len(), 1);
        assert!(descriptor_prefix_ids(&home, "deadbeef").is_empty());
        assert!(descriptor_prefix_ids(&home, "../x").is_empty());
        std::fs::remove_dir_all(&home).ok();
    }
}

#[cfg(test)]
mod label_tests {
    use super::*;

    fn row(id: &str, session: Option<&str>) -> Row {
        Row { id: id.into(), worktree_path: Some("/w".into()), session_id: session.map(str::to_string), updated_at: None }
    }

    /// SkyCrew 2026-10-22: a send to the spawn's worktree label (`primary-da4fa4d6`) was "verified" into a partition no session read.
    #[test]
    fn a_worktree_label_nobody_reads_is_flagged_and_a_live_reader_is_not() {
        assert!(label_without_reader(&row("primary-da4fa4d6", None), 0), "a pre-registered label with no session and no reader");
        assert!(label_without_reader(&row("primary-da4fa4d6", Some("unclaimed:x")), 0), "a synthetic session is no session");
        assert!(!label_without_reader(&row("primary-da4fa4d6", Some("485e7152")), 0), "a Primary with a session reads its partition");
        assert!(!label_without_reader(&row("primary-da4fa4d6", None), 2), "a partition with a reader row is read");
        assert!(!label_without_reader(&row("65a53880-1438", None), 0), "a child's own id is not a label");
    }

    fn scratch_inv(tag: &str) -> Inv {
        let home = std::env::temp_dir().join(format!("ah-pick-{tag}-{}", std::process::id()));
        crate::discard::harmless(std::fs::remove_dir_all(&home)); // keep: a stale directory of an earlier run of this test
        std::fs::create_dir_all(&home).unwrap();
        Inv { home: home.clone(), write_home: home, env: Default::default(), cwd: "/".into(), now: 1_000_000, stdin: None, store_override: None }
    }

    fn crow(id: &str, session: Option<&str>, updated: f64) -> Row {
        Row { id: id.into(), worktree_path: Some("/w".into()), session_id: session.map(str::to_string), updated_at: Some(updated) }
    }

    fn beat(inv: &Inv, id: &str, session: Option<&str>) {
        let dir = crate::meshw::idlock::devswarm_root(&inv.home).join(defaults::text("mesh_write.dir_heartbeats"));
        std::fs::create_dir_all(&dir).unwrap();
        let body = serde_json::json!({"ts": inv.now, "sessionId": session});
        std::fs::write(dir.join(format!("{id}{}", defaults::text("mesh_write.json_suffix"))), body.to_string()).unwrap();
    }

    /// 2026-10-23: a send to a worktree carrying two registry rows deferred (exit 69); Node routes it to the freshest live row.
    #[test]
    fn two_rows_of_one_worktree_route_to_the_freshest_live_one() {
        let inv = scratch_inv("fresh");
        let rows = vec![crow("a-old", Some("s-a"), 10.0), crow("b-new", Some("s-b"), 20.0)];
        assert_eq!(pick_freshest_live(&inv, None, rows).unwrap().id, "b-new", "both live: the newer updatedAt wins");
        let rows = vec![crow("a-sessionless", None, 99.0), crow("b-live", Some("s-b"), 1.0)];
        assert_eq!(pick_freshest_live(&inv, None, rows).unwrap().id, "b-live", "a row without a session is never the target while another is live");
    }

    #[test]
    fn a_session_authored_heartbeat_outranks_recency_and_an_alias_loses() {
        let inv = scratch_inv("credit");
        beat(&inv, "b-beat", Some("s-b"));
        let rows = vec![crow("a-fresh", Some("s-a"), 500.0), crow("b-beat", Some("s-b"), 10.0)];
        assert_eq!(pick_freshest_live(&inv, None, rows).unwrap().id, "b-beat");
        let rows = vec![crow("x-alias", Some("y-real"), 900.0), crow("y-real", Some("s-y"), 5.0)];
        assert_eq!(pick_freshest_live(&inv, None, rows).unwrap().id, "y-real", "a row whose session is a sibling's id is an alias");
    }

    #[test]
    fn with_no_live_row_the_freshest_then_the_lowest_id_wins() {
        let inv = scratch_inv("none");
        let rows = vec![crow("b", None, 5.0), crow("a", None, 5.0), crow("c", None, 1.0)];
        assert_eq!(pick_freshest_live(&inv, None, rows).unwrap().id, "a");
        let rows = vec![crow("b", None, 5.0), crow("c", None, 9.0)];
        assert_eq!(pick_freshest_live(&inv, None, rows).unwrap().id, "c");
    }

    fn init_repo(dir: &std::path::Path) -> String {
        std::fs::create_dir_all(dir).unwrap();
        let st = std::process::Command::new("git").current_dir(dir).args(["init", "-q", "-b", "main"]).env("GIT_CONFIG_NOSYSTEM", "1").status().unwrap();
        assert!(st.success());
        dir.canonicalize().unwrap().to_string_lossy().into_owned()
    }

    /// Node's `staleTwinSuccessor`: the addressed row's session runs in ANOTHER checkout and a live row of that session sits there, so
    /// the mail goes to that row and the answer says so. The same row, with its session in its own checkout, is delivered to as addressed.
    #[test]
    fn a_row_whose_session_runs_elsewhere_is_rerouted_to_its_live_twin() {
        let inv = scratch_inv("twin");
        let (w1, w2) = (init_repo(&inv.home.join("w1")), init_repo(&inv.home.join("w2")));
        let sessions = inv.home.join(".claude").join("sessions");
        std::fs::create_dir_all(&sessions).unwrap();
        let record = |cwd: &str| serde_json::json!({"sessionId": "S", "pid": std::process::id(), "cwd": cwd}).to_string();
        let row = |id: &str, w: &str, upd: f64| Row { id: id.into(), worktree_path: Some(w.into()), session_id: Some("S".into()), updated_at: Some(upd) };
        let rows = vec![row("a-old", &w1, 1.0), row("b-new", &w2, 2.0)];
        std::fs::write(sessions.join("s.json"), record(&w2)).unwrap();
        match resolve_send_target(&inv, None, &rows, "a-old").unwrap() {
            Resolved::Rerouted(t, from, why) => assert_eq!((t.id.as_str(), from.as_str(), why), ("b-new", "a-old", "session-worktree-incoherent")),
            _ => panic!("expected a reroute"),
        }
        // the session runs in the addressed row's own checkout: delivered as addressed
        std::fs::write(sessions.join("s.json"), record(&w1)).unwrap();
        assert!(matches!(resolve_send_target(&inv, None, &rows, "a-old").unwrap(), Resolved::Row(t) if t.id == "a-old"));
    }
    // ---- the cases that used to hand the send to Node (2026-10-23, #171): each is answered here, as Node answers it ----

    /// Two rows of one id, or an exact id that is another row's mesh label: Node refuses as ambiguous and names the candidates.
    #[test]
    fn rows_sharing_an_id_are_an_ambiguous_recipient_not_a_deferral() {
        let inv = scratch_inv("ambig");
        let rows = vec![crow("dup", Some("s-1"), 1.0), crow("dup", Some("s-2"), 2.0)];
        match resolve_send_target(&inv, None, &rows, "dup").unwrap() {
            Resolved::AmbiguousRows(ids) => assert_eq!(ids, vec!["dup".to_string(), "dup".to_string()]),
            _ => panic!("expected an ambiguous recipient"),
        }
    }

    fn write_retired(inv: &Inv, id: &str, to: &str) {
        let dir = crate::meshw::idlock::devswarm_root(&inv.home).join(defaults::text("devswarm_cli.rr_dir_retired"));
        std::fs::create_dir_all(&dir).unwrap();
        let body = serde_json::json!({ defaults::text("devswarm_cli.rr_field_retired_to"): to });
        std::fs::write(dir.join(format!("{id}{}", defaults::text("mesh_write.json_suffix"))), body.to_string()).unwrap();
    }

    /// A fold-time retired-redirect is followed one hop to the registry row of the survivor; a redirect to nothing falls through.
    #[test]
    fn a_retired_id_is_redirected_to_its_survivor_row() {
        let inv = scratch_inv("redirect");
        write_retired(&inv, "gone-1", "live-1");
        let rows = vec![crow("live-1", Some("s-1"), 1.0)];
        match resolve_send_target(&inv, None, &rows, "gone-1").unwrap() {
            Resolved::Redirected(t, from) => assert_eq!((t.id.as_str(), from.as_str()), ("live-1", "gone-1")),
            _ => panic!("expected a redirect"),
        }
        write_retired(&inv, "gone-2", "no-such-row");
        assert!(matches!(resolve_send_target(&inv, None, &rows, "gone-2").unwrap(), Resolved::Unregistered));
    }

    /// A truthy non-string `worktreePath` is `String()`-coerced by Node, not an error.
    #[test]
    fn a_descriptor_worktree_of_another_type_is_coerced_not_deferred() {
        let inv = scratch_inv("wtshape");
        let dir = crate::meshw::idlock::devswarm_root(&inv.home).join(defaults::text("mesh_write.dir_workspaces"));
        std::fs::create_dir_all(&dir).unwrap();
        for (id, body) in [("d-num", r#"{"worktreePath": 5}"#), ("d-arr", r#"{"worktreePath": ["/a", "/b"]}"#), ("d-obj", r#"{"worktreePath": {"x": 1}}"#), ("d-true", r#"{"worktreePath": true}"#)] {
            std::fs::write(dir.join(format!("{id}{}", defaults::text("mesh_write.json_suffix"))), body).unwrap();
            assert!(descriptor_mesh_id(&inv.home, id).is_ok(), "{id}");
        }
    }

    /// An unreadable message file is a refusal worded as Node words it; an operating system error outside the table is worded too.
    #[test]
    fn an_unreadable_message_file_is_always_a_worded_refusal() {
        let inv = scratch_inv("msgfile");
        let dir = inv.home.to_string_lossy().into_owned();
        assert!(read_message_file(&dir).unwrap_err().starts_with("EISDIR"), "a directory");
        assert!(read_message_file(&format!("{dir}/absent")).unwrap_err().starts_with("ENOENT"));
        let file = format!("{dir}/f");
        std::fs::write(&file, "x").unwrap();
        assert!(read_message_file(&format!("{file}/below")).unwrap_err().starts_with("ENOTDIR"));
        let (a, b) = (format!("{dir}/loop-a"), format!("{dir}/loop-b"));
        std::os::unix::fs::symlink(&b, &a).unwrap();
        std::os::unix::fs::symlink(&a, &b).unwrap();
        let why = read_message_file(&a).unwrap_err();
        assert!(why.ends_with(&format!(", open '{a}'")) && !why.contains("os error"), "{why}");
    }
}
