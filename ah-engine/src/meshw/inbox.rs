//! `devswarm.js inbox ack-primary <id> --receipt <rid> [--ack-as-owner]`, ported from `scripts/devswarm-lib/inbox-cmd.js`
//! `cmdInboxAckPrimary` and `cursors.js` `applyReadAckOps`.
//!
//! The ack applies the cursor moves a read receipt (written by `inbox read-primary`, which stays in Node) recorded, after
//! the receipt, the reader and the ownership checks pass. It writes: the caller's `reader_cursors` rows and the floor
//! (one transaction per op), the legacy shared cursor file and the `cursors` row, the cursor-write journal, the summary
//! projection, the receipt's `ackedAt`, and a transient drain marker the parent gate honours while the ack runs.
//!
//! Every refusal Node prints (a missing, unknown, expired, foreign or mismatched receipt, a foreign project, a caller that does
//! not own the id, a store that cannot be opened) is answered here with Node's text, exit 2, and logged as Node logs it. A receipt
//! that holds a move no cursor can take is Node's thrown exception (`{ok:false, error}`). After the first cursor commit nothing
//! fails the verb: a later failure is reported in the result (`cursorWriteFailures`) exactly as Node reports it.
use crate::checks::guardkit::ojson::OVal;
use crate::defaults;
use crate::meshw::args::Args;
use crate::meshw::common::{self, Inv, Obj, n, s};
use crate::meshw::cursors::{self, LogRec, Procs};
use crate::meshw::ident::{self, R};
use crate::meshw::idlock::{devswarm_root, is_safe_id};
use crate::meshw::readprimary::store_err;
use crate::meshw::send::{Answer, Effect, mesh_candidates, rehome_is_noop, resolve_mesh_target};
use crate::meshw::union;
use std::path::{Path, PathBuf};

/// A receipt op the engine applies: a move of the caller's own partition cursor, or of a sibling partition of its mesh group.
enum AckOp {
    Own {
        partition: String,
        target: f64,
        delivered: Option<f64>,
    },
    /// `not_ackable` is decided again at ack time (`revalidate`): a sibling that is live must not have its cursor moved by this caller.
    Sibling {
        partition: String,
        ack_target: f64,
        seen_target: f64,
        delivered: Option<f64>,
        not_ackable: bool,
    },
    /// A move of the caller's NDJSON position (`commitNdAck`).
    Nd(NdOp),
}

impl AckOp {
    fn partition(&self) -> &str {
        match self {
            AckOp::Own { partition, .. } | AckOp::Sibling { partition, .. } => partition,
            AckOp::Nd(o) => &o.partition,
        }
    }
}

/// A move of the caller's NDJSON position (`commitNdAck`): the target is held to the inbox's line count, and the descriptor's cursor
/// file follows the floor.
struct NdOp {
    partition: String,
    target: f64,
    cursor_path: Option<String>,
    inbox_path: Option<String>,
}

/// `readReceiptDir(home, id)`.
fn receipt_dir(home: &Path, id: &str) -> PathBuf {
    devswarm_root(home).join(defaults::text("mesh_write.dir_read_receipts")).join(id)
}

fn receipt_id_ok(rid: &str) -> bool {
    let p = defaults::text("mesh_write.receipt_id_prefix");
    rid.strip_prefix(p).is_some_and(|rest| !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()))
}

/// `readReadReceipt(home, id, rid, { dirId })`: the receipt and the directory it came from; the family's canonical
/// directory is tried first, the literal id's second.
fn read_receipt(home: &Path, id: &str, rid: &str, dir_id: &str) -> Option<(OVal, String)> {
    if !is_safe_id(id) || !receipt_id_ok(rid) {
        return None;
    }
    let mut dirs = Vec::new();
    if dir_id != id && is_safe_id(dir_id) {
        dirs.push(dir_id);
    }
    dirs.push(id);
    for d in dirs {
        let file = receipt_dir(home, d).join(format!("{rid}{}", defaults::text("mesh_write.json_suffix")));
        let Some(bytes) = ident::read_or_skip(&file, defaults::text("mesh_write.site_receipt")) else { continue };
        if let Some(rec @ OVal::Obj(_)) = OVal::parse(&String::from_utf8_lossy(&bytes))
            && matches!(rec.get("ops"), Some(OVal::Arr(_)))
        {
            return Some((rec, d.to_string()));
        }
    }
    None
}

/// `descriptorRegisteredRepoKey(desc, id)`: the project the id is registered
/// under, from its worktree when that still resolves, else the key the descriptor persisted (never the legacy hash bucket).
pub(crate) fn registered_repo_key(desc: &OVal, id: &str) -> R<Option<String>> {
    let text = |k: &str| match desc.get(k) {
        Some(OVal::Str(x)) if !x.is_empty() => Some(x.clone()),
        _ => None,
    };
    if let Some(wt) = text(defaults::text("mesh_write.field_worktree_path"))
        && let Some(fresh) = ident::repo_key_for_worktree(&wt)?
    {
        return Ok(Some(fresh));
    }
    let persisted = text(defaults::text("mesh_write.field_repo_key")).or_else(|| text(defaults::text("mesh_write.field_owner_key")));
    Ok(persisted.filter(|p| *p != crate::meshw::send::hash_from_workspace_id(id)))
}

/// A receipt that names something no cursor move can use (a partition that is no string, a target that is no number): Node's
/// `applyReadAckOps` throws there and `run()` prints the exception, `{ok:false, error}`.
struct CorruptReceipt(String);

fn corrupt(what: &str, key: &str) -> CorruptReceipt {
    CorruptReceipt(defaults::render("mesh_write.msg_receipt_corrupt", &[("what", &what), ("key", &key)]))
}

/// The ops of a receipt: the `own`, `sibling` and `nd` moves to apply. An unknown kind is skipped, as Node skips it.
fn own_ops(rec: &OVal, id: &str) -> Result<Vec<AckOp>, CorruptReceipt> {
    // (`readReadReceipt` only returns a receipt whose `ops` is an array, and a fresh one is built with one)
    let Some(OVal::Arr(ops)) = rec.get("ops") else { return Ok(Vec::new()) };
    let mut out = Vec::new();
    for op in ops {
        if !matches!(op, OVal::Obj(_) | OVal::Arr(_)) {
            continue;
        }
        // `op.partition != null ? op.partition : id`
        let partition_or_id = |key: &str| -> Result<String, CorruptReceipt> {
            match op.get(key) {
                None | Some(OVal::Null) => Ok(id.to_string()),
                Some(OVal::Str(p)) => Ok(p.clone()),
                Some(_) => Err(corrupt("partition", key)),
            }
        };
        let finite = |key: &str| -> Result<f64, CorruptReceipt> {
            match op.get(key) {
                Some(OVal::Num(t)) if t.is_finite() => Ok(*t),
                _ => Err(corrupt("target", key)),
            }
        };
        let delivered = match op.get("delivered") {
            Some(OVal::Num(d)) if d.is_finite() => Some(*d),
            _ => None,
        };
        match op.get("k") {
            Some(OVal::Str(k)) if k == defaults::text("mesh_write.op_own") => {
                out.push(AckOp::Own { partition: partition_or_id("partition")?, target: finite("target")?, delivered });
            }
            Some(OVal::Str(k)) if k == defaults::text("mesh_write.op_sibling") => {
                let partition = match op.get("partition") {
                    Some(OVal::Str(p)) if is_safe_id(p) => p.clone(),
                    _ => return Err(corrupt("partition", "partition")),
                };
                // `op.seenTarget > 0` is false for anything that is not a positive number
                let seen_target = match op.get("seenTarget") {
                    Some(OVal::Num(t)) if t.is_finite() => *t,
                    _ => 0.0,
                };
                out.push(AckOp::Sibling {
                    partition,
                    ack_target: finite("ackTarget")?,
                    seen_target,
                    delivered,
                    not_ackable: op.get("notAckable").is_some_and(OVal::truthy),
                });
            }
            Some(OVal::Str(k)) if k == defaults::text("mesh_write.op_nd") => {
                let path = |key: &str| -> Result<Option<String>, CorruptReceipt> {
                    match op.get(key) {
                        None | Some(OVal::Null) => Ok(None),
                        Some(OVal::Str(t)) if t.is_empty() => Ok(None),
                        Some(OVal::Str(t)) => Ok(Some(t.clone())),
                        Some(_) => Err(corrupt("path", key)),
                    }
                };
                // `commitNdAck` clamps with `Math.max(0, Math.floor(Number(target) || 0))`; a cursor path is optional (the legacy
                // projection into the descriptor's cursor file is skipped without one)
                let target = match op.get("target") {
                    Some(OVal::Num(t)) if t.is_finite() => *t,
                    _ => return Err(corrupt("target", "target")),
                };
                out.push(AckOp::Nd(NdOp {
                    partition: partition_or_id("partition")?,
                    target,
                    cursor_path: path("cursorPath")?,
                    inbox_path: path("inboxPath")?,
                }));
            }
            _ => {}
        }
    }
    Ok(out)
}

/// `markDrainStart(home, id, { sessionId, count: 0, now })` (best effort: a failed write only means the gate is not
/// silenced this turn).
fn mark_drain(inv: &Inv, id: &str) {
    let dir = devswarm_root(&inv.home).join(defaults::text("mesh_write.dir_drain"));
    let p = dir.join(format!("{id}{}", defaults::text("mesh_write.json_suffix")));
    let mut m = Obj::default();
    m.put("startedAt", n(inv.now as f64))
        .put("sessionId", inv.env.get(defaults::text("mesh_write.env_session_id")).filter(|x| !x.is_empty()).map_or(OVal::Null, |x| OVal::Str(x.clone())))
        .put("pid", n(f64::from(std::process::id())))
        .put("count", n(0.0));
    let write = || -> std::io::Result<()> {
        std::fs::create_dir_all(&dir)?;
        let mut tmp = p.as_os_str().to_os_string();
        tmp.push(format!(".{}.{}{}", std::process::id(), common::now_ms(), defaults::text("mesh_write.tmp_suffix")));
        let tmp = PathBuf::from(tmp);
        std::fs::write(&tmp, m.done().stringify())?;
        std::fs::rename(&tmp, &p)
    };
    crate::discard::harmless(write()); // keep: the marker is advisory (Node returns false)
}

/// `clearDrainMarker(home, id)`.
fn clear_drain(inv: &Inv, id: &str) {
    let p = devswarm_root(&inv.home).join(defaults::text("mesh_write.dir_drain")).join(format!("{id}{}", defaults::text("mesh_write.json_suffix")));
    crate::discard::harmless(std::fs::remove_file(p)); // keep: an absent marker is already cleared
}

/// What an ack has settled before it writes anything: the receipt (read from disk, or the one a read-primary is about to
/// file), the moves it records and the store they go to.
pub(crate) struct AckPlan {
    st: crate::meshw::store::MeshStore,
    id: String,
    rid: String,
    rec: OVal,
    found_dir: String,
    ops: Vec<AckOp>,
    /// Partitions with no floor rows yet: `ackFor` imports their legacy cursor files first, inside the same move.
    imports: Vec<String>,
    reader: Option<String>,
    repo_key: String,
    /// Whether this is `ack-primary` on a receipt (drain marker, `ackedAt` stamp, re-judged siblings) or the legacy same-call ack of
    /// `read-primary --legacy-ack-now` (none of those; the verb in the cursor log is `read-primary`).
    via_receipt: bool,
}

/// What an ack settled before its first write: the moves to make, or Node's refusal (the object it prints, exit 2).
pub(crate) enum AckStep {
    Go(Box<AckPlan>),
    Refuse(OVal),
}

/// `refuse(reason, error)` of `cmdInboxAckPrimary`: `{ok:false, reason, error, action, id}`.
fn refuse(id: &str, reason: &str, error: &str) -> AckStep {
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(false))
        .put("reason", s(reason))
        .put("error", s(error))
        .put("action", s(defaults::text("mesh_write.action_ack_primary")))
        .put("id", s(id));
    AckStep::Refuse(o.done())
}

/// The refusal for a store that could not be settled (`Object.assign({}, base, { ok: false, reason, error })`).
fn refuse_store(id: &str, reason: &str, error: &str) -> AckStep {
    let mut o = Obj::default();
    o.put("action", s(defaults::text("mesh_write.action_ack_primary")))
        .put("id", s(id))
        .put("ok", OVal::Bool(false))
        .put("reason", s(reason))
        .put("error", s(error));
    AckStep::Refuse(o.done())
}

/// `{ok:false, error}`: what `run()` prints for an exception a verb throws.
fn thrown(error: &str) -> AckStep {
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(false)).put("error", s(error));
    AckStep::Refuse(o.done())
}

/// `ownershipRefusalCause(kind, ownEntry)`.
fn ownership_cause(kind: &str, caller_registered: bool) -> &'static str {
    if kind == defaults::text("mesh_write.kind_unresolvable") {
        defaults::text("devswarm_cli.cause_unresolvable_caller")
    } else if !caller_registered {
        defaults::text("devswarm_cli.cause_caller_not_registered")
    } else {
        defaults::text("devswarm_cli.cause_ownership_mismatch")
    }
}

/// `cwdInsideRegisteredWorktree(cwd, worktreePath)`: the real path of `cwd` (its nearest existing ancestor, for a deleted one) equals
/// or lies under the real path of the registered worktree or that path's git toplevel. Fail-closed.
fn cwd_inside_registered_worktree(cwd: &str, wt: &str) -> bool {
    if cwd.is_empty() || wt.is_empty() {
        return false;
    }
    let mut at = PathBuf::from(cwd);
    let cwd_real = loop {
        if let Ok(r) = std::fs::canonicalize(&at) {
            break r;
        }
        if !at.pop() {
            return false;
        }
    };
    let Ok(root) = std::fs::canonicalize(wt) else { return false };
    let mut roots = vec![root];
    if let Ok(c) = ident::resolve_context(wt, false)
        && let Some(top) = c.toplevel
    {
        roots.push(PathBuf::from(top));
    }
    roots.iter().any(|r| cwd_real.starts_with(r))
}

/// The project key `resolveWorkspaceStoreForRead` opens the store under for `id`: the caller's project, checked against the one the id
/// is registered under (a disagreement is Node's `project-context-mismatch` refusal); with no project at all, the legacy per-id bucket.
fn settle_store_key(inv: &Inv, id: &str, desc: Option<&OVal>) -> R<Result<String, AckStep>> {
    let mut caller_key = ident::resolve_context(&inv.cwd, true)?.repo_key;
    let registered = match desc {
        Some(d) => registered_repo_key(d, id)?,
        None => None,
    };
    if let (Some(_), None, Some(OVal::Str(wt))) = (&registered, &caller_key, desc.and_then(|d| d.get(defaults::text("mesh_write.field_worktree_path"))))
        && cwd_inside_registered_worktree(&inv.cwd, wt)
    {
        caller_key.clone_from(&registered);
    }
    if let Some(reg) = &registered
        && Some(reg) != caller_key.as_ref()
    {
        let quoted = |x: &str| OVal::Str(x.to_string()).stringify();
        let context = match &caller_key {
            Some(c) => defaults::render("mesh_write.msg_context_different", &[("caller", &quoted(c))]),
            None => defaults::text("mesh_write.msg_context_unresolved").to_string(),
        };
        let msg = defaults::render("mesh_write.msg_project_mismatch", &[("id", &quoted(id)), ("registered", &quoted(reg)), ("context", &context)]);
        return Ok(Err(refuse_store(id, defaults::text("mesh_write.reason_project_mismatch"), &msg)));
    }
    Ok(Ok(caller_key.unwrap_or_else(|| crate::meshw::send::hash_from_workspace_id(id))))
}

/// Run `inbox ack-primary` (argv already parsed; `positionals` start with `inbox`, `ack-primary`).
pub fn run(inv: &Inv, a: &Args) -> R<Answer> {
    // (`help` never reaches here: `verb_of` classifies a help request first)
    common::seat_check(inv)?;
    let Some(id) = a.positionals.get(2).map(String::as_str).filter(|i| is_safe_id(i)) else {
        return Ok(crate::meshw::readprimary::failure(defaults::text("devswarm_cli.msg_bad_id")));
    };
    // inboxWindowRejection: a window flag on an acking verb is Node's refusal
    if let Some(refused) = crate::meshw::readprimary::window_refusal(inv, a, id, defaults::text("mesh_write.verb_ack_primary"))? {
        return Ok(refused);
    }
    let step = match a.one(defaults::text("mesh_write.flag_receipt")).filter(|r| !r.is_empty()) {
        None => refuse(id, defaults::text("mesh_write.reason_missing_receipt"), defaults::text("mesh_write.msg_missing_receipt")),
        Some(rid) => match plan_ack(inv, id, rid, a.has(defaults::text("mesh_write.flag_ack_as_owner")), None, true) {
            Err(ident::Defer(reason)) if crate::meshw::readprimary::is_store_failure(&reason) && !crate::meshw::committed() => {
                thrown(&defaults::render("mesh_write.msg_store_failure", &[("reason", &reason)]))
            }
            other => other?,
        },
    };
    match step {
        AckStep::Go(plan) => {
            // ---- commit: everything below writes, nothing below defers ----
            let out = apply_ack(inv, *plan);
            Ok(Answer { code: 0, stdout: format!("{}\n", out.done().stringify()), effect: Effect::None })
        }
        AckStep::Refuse(o) => {
            // `logVerbOutcome('inbox-ack-primary', id, r, ctx)`: one error entry for an unsuccessful result
            let text = |k: &str| match o.get(k) {
                Some(OVal::Str(t)) => Some(t.clone()),
                _ => None,
            };
            let msg = text("error").or_else(|| text("reason")).unwrap_or_else(|| defaults::text("mesh_write.msg_verb_not_ok").to_string());
            let repo_key = ident::resolve_context(&inv.cwd, true).ok().and_then(|c| c.repo_key);
            crate::meshw::clog::ready(inv)?;
            crate::meshw::clog::refusal(
                inv,
                &format!("{}{}", defaults::text("devswarm_cli.window_op_prefix"), defaults::text("mesh_write.verb_ack_primary")),
                repo_key.as_deref(),
                Some(id),
                &msg,
                text("reason").as_deref(),
            );
            crate::meshw::mark_committed();
            Ok(Answer { code: 2, stdout: format!("{}\n", o.stringify()), effect: Effect::None })
        }
    }
}

/// Everything `cmdInboxAckPrimary` checks before its first write; each refusal Node prints is an [`AckStep::Refuse`]. `fresh` is
/// the receipt a `read-primary --ack-after-print` is about to file (not on disk yet).
pub(crate) fn plan_ack(inv: &Inv, id: &str, rid: &str, ack_as_owner: bool, fresh: Option<OVal>, via_receipt: bool) -> R<AckStep> {
    let home = &inv.home;
    // resolveWorkspaceStoreForRead: the caller's project, the id's registered project, the re-home trigger
    let desc = ident::read_descriptor(home, id);
    let repo_key = match settle_store_key(inv, id, desc.as_ref())? {
        Ok(k) => k,
        Err(refusal) => return Ok(refusal),
    };
    rehome_is_noop(inv, id)?;
    let st = common::open_store(inv, &repo_key)?;
    let rows = ident::rows_of(&st.reader().roster().map_err(|e| store_err("registry", e))?);
    // canonicalReceiptId: the lowest id of the worktree's identity family, else the literal id (any failure is Node's catch)
    let dir_id = (|| -> R<String> {
        if let Some(d) = &desc
            && let Some(OVal::Str(wt)) = d.get(defaults::text("mesh_write.field_worktree_path")).filter(|w| w.truthy())
            && let Some(mesh) = ident::canonical_mesh_id(wt)?
        {
            let mut ids: Vec<String> = mesh_candidates(&rows, Some(mesh.as_str()))?.into_iter().map(|r| r.id).collect();
            ids.sort();
            ids.dedup();
            if ids.len() > 1 && ids.iter().any(|x| x == id) {
                return Ok(ids.remove(0));
            }
        }
        Ok(id.to_string())
    })()
    .unwrap_or_else(|_| id.to_string());
    let Some((rec, found_dir)) = (match fresh {
        Some(rec) => Some((rec, id.to_string())),
        None => read_receipt(home, id, rid, &dir_id),
    }) else {
        let msg = defaults::render(
            "mesh_write.msg_unknown_receipt",
            &[("rid", &OVal::Str(rid.to_string()).stringify()), ("id", &OVal::Str(id.to_string()).stringify()), ("bare", &id)],
        );
        return Ok(refuse(id, defaults::text("mesh_write.reason_unknown_receipt"), &msg));
    };
    let rec_id = rec.get("id").map_or_else(|| defaults::text("mesh_write.js_undefined").to_string(), crate::dssup::ingest::import::js_string);
    if rec_id != id {
        // not the exact literal id the receipt was issued to: still ackable when both are one identity family (same worktree)
        let same_family = (|| -> R<bool> {
            let Some(rd) = ident::read_descriptor(home, &rec_id) else { return Ok(false) };
            let Some(OVal::Str(wt)) = rd.get(defaults::text("mesh_write.field_worktree_path")).filter(|w| w.truthy()) else { return Ok(false) };
            let g = crate::meshw::meshgroup::resolve(&rows, &rec_id, Some(wt))?;
            Ok(g.active && g.ids.iter().any(|x| x == id))
        })()
        .unwrap_or(false);
        if !same_family {
            let shown = rec.get("id").map_or_else(|| defaults::text("mesh_write.js_undefined").to_string(), OVal::stringify);
            return Ok(refuse(
                id,
                defaults::text("mesh_write.reason_receipt_owner"),
                &defaults::render("mesh_write.msg_receipt_belongs", &[("owner", &shown)]),
            ));
        }
    }
    let reader = cursors::reader_key(ident::reader_nonce(home).as_deref());
    // `(rec.reader || null) !== (reader || null)`: a truthy reader that is no string never matches
    let reader_matches = match rec.get("reader") {
        None | Some(OVal::Null | OVal::Bool(false)) => reader.is_none(),
        Some(OVal::Str(r)) if r.is_empty() => reader.is_none(),
        Some(OVal::Str(r)) => reader.as_deref() == Some(r.as_str()),
        Some(v) if !v.truthy() => reader.is_none(),
        Some(_) => false,
    };
    if !reader_matches {
        return Ok(refuse(id, defaults::text("mesh_write.reason_receipt_owner"), &defaults::render("mesh_write.msg_receipt_other_reader", &[("id", &id)])));
    }
    match rec.get("createdAt") {
        Some(OVal::Num(c)) if c.is_finite() && (inv.now as f64) - c <= defaults::num("mesh_write.receipt_ttl_ms") as f64 => {}
        _ => {
            let hours = (defaults::num("mesh_write.receipt_ttl_ms") as f64 / 3_600_000.0).round();
            return Ok(refuse(
                id,
                defaults::text("mesh_write.reason_receipt_expired"),
                &defaults::render("mesh_write.msg_receipt_expired", &[("hours", &hours), ("id", &id)]),
            ));
        }
    }
    if !ack_as_owner {
        let caller = ident::caller_identity_detailed(&inv.env, &inv.cwd)?;
        let own_entry = resolve_mesh_target(inv, None, &rows, Some(caller.identity.as_str()))?;
        let owns = caller.identity == id
            || own_entry.as_ref().is_some_and(|e| e.id == id)
            || ident::declared_self_id(&inv.env, &inv.cwd, &rows)?.as_deref() == Some(id);
        if !owns {
            let msg = defaults::render("mesh_write.msg_ack_not_owner", &[("id", &OVal::Str(id.to_string()).stringify())]);
            return Ok(refuse(id, ownership_cause(&caller.kind, own_entry.is_some()), &msg));
        }
    }
    let mut ops = match own_ops(&rec, id) {
        Ok(o) => o,
        Err(CorruptReceipt(msg)) => return Ok(thrown(&msg)),
    };
    let mut imports: Vec<String> = Vec::new();
    for op in &mut ops {
        // a sibling is re-judged now (`revalidate`): the receipt's verdict was the one at read time
        if let AckOp::Sibling { partition, not_ackable, .. } = op {
            if via_receipt {
                *not_ackable = crate::meshw::meshgroup::ack_gate(inv, &rows, id, partition)?;
            }
            if *not_ackable {
                continue;
            }
        }
        let cur = cursors::rows_of(&st, op.partition()).map_err(|e| store_err("cursor-rows", e))?;
        if cursors::needs_import(&cur) {
            // `ackFor` imports the partition's legacy cursor files the first time it moves it. The dry run only has to be possible;
            // a case it cannot settle is carried out by the real import below, whose failure is reported in the result
            let h = crate::migrate::readercur::Handle::Ro(
                crate::mesh::MeshReader::open(&union::store_dir(home, &repo_key).join(defaults::text("mesh_write.store_file")))
                    .map_err(|e| store_err("store-open", e))?,
            );
            let mut cx = crate::migrate::readercur::Cx::new(&home.to_string_lossy());
            crate::migrate::readercur::import_legacy(&mut cx, &h, op.partition(), None, true).map_err(|e| store_err("cursor-import", e))?;
            if !imports.iter().any(|p| p == op.partition()) {
                imports.push(op.partition().to_string());
            }
        }
    }
    // the summary refresh after the write
    crate::meshw::summary::check(&st, inv, None)?;
    Ok(AckStep::Go(Box::new(AckPlan { st, id: id.to_string(), rid: rid.to_string(), rec, found_dir, ops, imports, reader, repo_key, via_receipt })))
}

/// `commitNdAck` for one `nd` op of a receipt: the NDJSON position moves to the target (never past the inbox's line count), the
/// descriptor's cursor file follows the floor, and a failure is reported in the result.
#[allow(clippy::too_many_arguments)]
fn apply_nd(
    inv: &Inv,
    st: &crate::meshw::store::MeshStore,
    id: &str,
    reader: Option<&str>,
    nonce: Option<String>,
    repo_key: &str,
    op: &NdOp,
    verb: &str,
    procs: &mut Procs,
    failures: &mut Vec<OVal>,
) {
    let mut to = op.target.max(0.0).floor();
    if let Some(inbox) = &op.inbox_path {
        let lines = crate::meshw::union::non_empty_lines(inbox).ok().flatten().map_or(0, |l| l.len());
        to = to.min(lines as f64);
    }
    let r = cursors::ack_for_at(st, &inv.home, &op.partition, defaults::text("mesh_write.cursor_ns_nd"), reader, to, procs, inv.now);
    if r.ok {
        crate::meshw::mark_committed();
    }
    cursors::log_cursor_write(
        &inv.home,
        &LogRec {
            id: &op.partition,
            caller_id: Some(id),
            ns: defaults::text("mesh_write.log_ns_nd"),
            from: r.from,
            to: if r.ok { r.own.map(|x| x as f64) } else { Some(to) },
            delivered: None,
            nonce,
            gate: defaults::text("mesh_write.gate_min_floor"),
            verb,
            cwd: None,
            ok: r.ok,
            err: if r.ok { None } else { r.error.as_deref() },
            repo_key: Some(repo_key),
        },
    );
    if !r.ok {
        let mut f = Obj::default();
        f.put("partitionId", s(&op.partition))
            .put("channel", s(defaults::text("mesh_write.channel_ndjson_cursor")))
            .put("error", s(r.error.as_deref().unwrap_or(defaults::text("mesh_write.err_nd_ack_failed"))));
        failures.push(f.done());
        return;
    }
    // the legacy projection of the floor into the descriptor's cursor file: upward only, best effort
    if let (Some(fl), Some(cp)) = (r.floor.filter(|f| *f > 0), &op.cursor_path)
        && cursors::read_cursor(Path::new(cp)) < fl as f64
    {
        crate::discard::harmless(cursors::ack_to(Path::new(cp), fl as f64)); // keep: the projection is best-effort in Node
    }
}

/// The writes of `cmdInboxAckPrimary` and its result: nothing defers from here, a failure is reported in the result.
pub(crate) fn apply_ack(inv: &Inv, plan: AckPlan) -> Obj {
    let AckPlan { st, id, rid, rec, found_dir, ops, imports, reader, repo_key, via_receipt } = plan;
    let verb = if via_receipt { defaults::text("mesh_write.verb_ack_primary") } else { defaults::text("mesh_write.verb_read_primary") };
    let (id, rid, home) = (id.as_str(), rid.as_str(), &inv.home);
    // (the legacy same-call ack marks the drain too: `cmdInboxMessages` wraps any acking read in the marker)
    mark_drain(inv, id);
    let mut procs = Procs::default();
    let mut failures: Vec<OVal> = Vec::new();
    let mut acked: Option<f64> = None;
    let ns = defaults::text("mesh_write.ns_store");
    let nonce = reader.as_deref().map(cursors::short_nonce);
    // `ackFor` imports a partition's legacy cursor files into floor rows the first time it moves it
    let mut import_failed: Vec<String> = Vec::new();
    for partition in &imports {
        let done = (|| -> Result<(), String> {
            let h = crate::migrate::readercur::Handle::Rw(
                crate::meshw::store::MeshStore::open(&union::store_dir(home, &repo_key).join(defaults::text("mesh_write.store_file")))
                    .map_err(|e| e.to_string())?,
            );
            let mut cx = crate::migrate::readercur::Cx::new(&home.to_string_lossy());
            crate::migrate::readercur::import_legacy(&mut cx, &h, partition, None, false).map(|_| ())
        })();
        if let Err(e) = done {
            import_failed.push(partition.clone());
            failures.push(failure(partition, defaults::text("mesh_write.channel_store_cursor"), &e));
        }
    }
    for op in &ops {
        if import_failed.iter().any(|p| p == op.partition()) {
            continue;
        }
        match op {
            AckOp::Own { partition, target, delivered } => {
                let r = cursors::ack_for(&st, home, partition, ns, reader.as_deref(), *target, &mut procs);
                if r.ok {
                    crate::meshw::mark_committed();
                }
                log_move(home, id, partition, &r, *target, *delivered, nonce.clone(), defaults::text("mesh_write.gate_owner"), &repo_key, verb);
                if let Some(e) = &r.error {
                    failures.push(failure(partition, defaults::text("mesh_write.channel_store_cursor"), e));
                }
                // `Number.isFinite(committed.instance) ? committed.instance : Math.max(committed.floor || 0, op.target)`
                acked = Some(match (reader.is_some(), r.own) {
                    (true, Some(own)) if r.ok => own as f64,
                    _ => (r.floor.unwrap_or(0) as f64).max(*target),
                });
            }
            AckOp::Sibling { partition, ack_target, seen_target, delivered, not_ackable } => {
                if *not_ackable {
                    // a live sibling is not this caller's to ack: only the caller-scoped watermark moves, so the next read starts after it
                    if *seen_target > 0.0
                        && !with_watermark_lock(inv, id, partition, || crate::meshw::meshgroup::write_seen_cursor(inv, id, partition, *seen_target))
                    {
                        failures.push(failure(
                            partition,
                            defaults::text("mesh_write.channel_sibling_seen"),
                            defaults::text("mesh_write.msg_seen_watermark_failed"),
                        ));
                    }
                    continue;
                }
                let r = cursors::ack_for(&st, home, partition, ns, reader.as_deref(), *ack_target, &mut procs);
                if r.ok {
                    crate::meshw::mark_committed();
                }
                log_move(home, id, partition, &r, *ack_target, *delivered, nonce.clone(), defaults::text("mesh_write.gate_sibling"), &repo_key, verb);
                if let Some(e) = &r.error {
                    failures.push(failure(partition, defaults::text("mesh_write.channel_sibling_store"), e));
                    continue;
                }
                // the watermark this ack covers is no longer needed
                with_watermark_lock(inv, id, partition, || {
                    if *ack_target >= crate::meshw::meshgroup::seen_cursor(inv, id, partition) {
                        crate::meshw::meshgroup::remove_seen_cursor(inv, id, partition);
                    }
                    true
                });
            }
            AckOp::Nd(o) => apply_nd(inv, &st, id, reader.as_deref(), nonce.clone(), &repo_key, o, verb, &mut procs, &mut failures),
        }
    }
    if let Some(why) = crate::meshw::summary::derive_after_write(&st, inv, &repo_key) {
        crate::meshw::log_summary_failure(verb, &why);
    }
    clear_drain(inv, id);
    let already = !matches!(rec.get("ackedAt"), None | Some(OVal::Null));
    if via_receipt && failures.is_empty() && !already {
        let mut stamped = rec.clone();
        stamped.set("ackedAt", n(inv.now as f64));
        let file = receipt_dir(home, &found_dir).join(format!("{rid}{}", defaults::text("mesh_write.json_suffix")));
        let mut tmp = file.as_os_str().to_os_string();
        tmp.push(defaults::text("mesh_write.tmp_suffix"));
        let tmp = PathBuf::from(tmp);
        let write = || -> std::io::Result<()> {
            std::fs::write(&tmp, stamped.stringify())?;
            std::fs::rename(&tmp, &file)
        };
        crate::discard::harmless(write()); // keep: the cursors moved; the ackedAt stamp is informational (Node's catch)
    }
    let mut out = Obj::default();
    out.put("ok", OVal::Bool(true)).put("action", s(defaults::text("mesh_write.action_ack_primary"))).put("id", s(id)).put("readReceiptId", s(rid));
    if let Some(x) = acked {
        out.put("acked", n(x));
    }
    out.put("alreadyAcked", OVal::Bool(already)).put(
        "messages",
        match rec.get("hashes") {
            Some(OVal::Arr(h)) => n(h.len() as f64),
            _ => OVal::Null,
        },
    );
    if !failures.is_empty() {
        out.put("cursorWriteFailures", OVal::Arr(failures)).put("cursorPersisted", OVal::Bool(false));
    }
    out
}

/// One `cursorWriteFailures` entry.
fn failure(partition: &str, channel: &str, error: &str) -> OVal {
    let mut f = Obj::default();
    f.put("partitionId", s(partition)).put("channel", s(channel)).put("error", s(error));
    f.done()
}

/// The cursor-write journal line of one move.
#[allow(clippy::too_many_arguments)]
fn log_move(
    home: &Path,
    caller: &str,
    partition: &str,
    r: &cursors::Acked,
    target: f64,
    delivered: Option<f64>,
    nonce: Option<String>,
    gate: &str,
    repo_key: &str,
    verb: &str,
) {
    cursors::log_cursor_write(
        home,
        &LogRec {
            id: partition,
            caller_id: Some(caller),
            ns: defaults::text("mesh_write.log_ns_store"),
            from: r.from,
            to: if r.ok { r.own.map(|x| x as f64) } else { Some(target) },
            delivered,
            nonce,
            gate,
            verb,
            cwd: None,
            ok: r.ok,
            err: r.error.as_deref(),
            repo_key: Some(repo_key),
        },
    );
}

/// `withWatermarkLock(caller, sibling, home, fn)`: `fn` under the lock of the watermark file; contended or unlockable, it runs unlocked
/// (a watermark is never dropped for want of a lock).
fn with_watermark_lock(inv: &Inv, caller: &str, sibling: &str, f: impl FnOnce() -> bool) -> bool {
    let sep = defaults::text("devswarm_recon.seen_sep");
    let safe = |x: &str| is_safe_id(x) && !x.contains(sep);
    if !(safe(caller) && safe(sibling)) {
        return f();
    }
    match crate::meshw::idlock::acquire(&inv.home, &format!("{caller}{sep}{sibling}")) {
        Some(lock) => {
            let out = f();
            lock.release();
            out
        }
        None => f(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::meshw::ident::fifo_kit::*;

    #[test]
    fn a_fifo_receipt_is_no_receipt_and_does_not_block() {
        let home = scratch("receipt");
        let dir = receipt_dir(&home, "w1");
        std::fs::create_dir_all(&dir).unwrap();
        let rid = format!("{}abc", defaults::text("mesh_write.receipt_id_prefix"));
        fifo(&dir.join(format!("{rid}{}", defaults::text("mesh_write.json_suffix"))));
        let h = home.clone();
        assert!(within("read_receipt", move || read_receipt(&h, "w1", &rid, "w1").is_none()));
        crate::discard::harmless(std::fs::remove_dir_all(home)); // keep: cleanup of a scratch directory
    }
}
