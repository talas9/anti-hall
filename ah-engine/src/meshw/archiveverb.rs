//! `devswarm.js archive <id>`, the local archive and the DevSwarm app leg (`scripts/devswarm-lib/archive.js` `cmdArchive`,
//! `attemptAppArchive`, `hcArchiveCall`, `verifyAppArchived`, `appSideSnapshot`).
//!
//! Native: the id of an ACTIVE descriptor of the caller's own project whose store holds no other row of the same worktree and
//! no unread mail for it, and whose identity family has no twin to retire. The local half is the reconcile port's op list
//! (the hard link into `archived/`, the recovery marker, the registry tombstone and the summary, the unlink of the active name
//! LAST, the marker cleared), applied under the workspace's lock. Then, still under the lock, the app leg: the app database
//! decides whether `hivecontrol workspace archive` is called at all (an exact, open, non-Primary builder); the call is repeated
//! once on the app's own flaky "could not confirm terminal" failure; the app database is read again to verify; the branch name
//! is tried once when the id was accepted without effect; the other builders are compared before and after.
//!
//! Everything that is not that case is Node's, decided before the first write (exit 75, nothing written): an archived-only or
//! app-only id, a prefix or mesh label, `--force-cross-project`, every refusal (Node words them and some log them), a
//! descriptor without an owner key (Node backfills it first), a hash-bucket descriptor (the re-home), an archived marker that
//! is already there (the self-heal), a worktree group or an identity family to fold, a partition with unread mail (the summary
//! after the tombstone would hold an orphan the engine cannot classify) and a capability cache that needs a probe. The app leg
//! is evaluated once before the first write for exactly that reason; after the first write nothing defers any more.
//!
//! The Node witness is not run for `archive`: it would meet the real `hivecontrol`. The parity test runs both sides against a
//! recording stub instead.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an unreadable optional file is the same as an absent one (fail-open, as Node's try/catch)
// A failure that must be seen goes through `crate::discard` instead.
use crate::checks::guardkit::ojson::OVal;
use crate::checks::guardkit::text::{js_trim, slice_utf16};
use crate::defaults;
use crate::dssup::recon::{Op, Pre, Unit};
use crate::meshw::actverbs::has_fresh_heartbeat;
use crate::meshw::appdb::{self, State};
use crate::meshw::args::Args;
use crate::meshw::common::{Inv, Obj, n, s};
use crate::meshw::extverbs::tpl;
use crate::meshw::hivecontrol::{self, Cap, Full};
use crate::meshw::ident::{self, R, defer};
use crate::meshw::idlock::{self, is_safe_id};
use crate::meshw::lifeverbs::{apply_units, bad_id};
use crate::meshw::send::{Answer, Effect};
use std::os::unix::fs::MetadataExt;

fn answer(code: i32, v: OVal) -> Answer {
    Answer { code, stdout: format!("{}\n", v.stringify()), effect: Effect::None }
}

fn text(k: &str) -> &'static str {
    defaults::text(k)
}

// ---- the app leg ------------------------------------------------------------------------------------------------------

/// `appBuilderGate`: the builder's branch (null when it has none), or why nothing is archived in the app.
fn builder_gate(inv: &Inv, id: &str) -> R<Result<Option<String>, String>> {
    let primary_label = regex::Regex::new(text("devswarm_cli.app_primary_label_re")).is_ok_and(|re| re.is_match(id));
    if primary_label {
        return Ok(Err(text("devswarm_cli.app_reason_primary_label").to_string()));
    }
    let Some(found) = appdb::builder_states(&inv.home, &inv.env, inv.now, false)? else {
        return Ok(Err(text("devswarm_cli.app_reason_unreadable").to_string()));
    };
    let Some(b) = found.states.iter().find(|st| st.id == id) else { return Ok(Err(text("devswarm_cli.app_reason_no_builder").to_string())) };
    let bt = js_trim(b.builder_type.as_deref().unwrap_or_default()).to_lowercase();
    if bt.is_empty() {
        return Ok(Err(text("devswarm_cli.app_reason_type_unknown").to_string()));
    }
    if bt == text("devswarm_cli.app_builder_type_primary") {
        return Ok(Err(text("devswarm_cli.app_reason_primary").to_string()));
    }
    if b.archived == Some(true) {
        return Ok(Err(text("devswarm_cli.app_reason_archived").to_string()));
    }
    Ok(Ok(b.branch.clone().filter(|x| !x.is_empty())))
}

/// One builder as `appSideSnapshot` keeps it: its state and branch.
#[derive(Debug, Clone)]
struct Seen {
    id: String,
    st: &'static str,
    branch: Option<String>,
}

/// `appSideSnapshot(id)`: the target and every builder sharing its branch name or worktree; `None` when the app database
/// cannot be read or holds no such builder.
struct Side {
    target: String,
    rows: Vec<Seen>,
}

fn state_word(w: &State) -> &'static str {
    if w.archived == Some(true) {
        defaults::text("devswarm_cli.app_state_archived")
    } else if w.active {
        defaults::text("devswarm_cli.app_state_open")
    } else {
        defaults::text("devswarm_cli.app_state_closed")
    }
}

fn side_snapshot(inv: &Inv, id: &str) -> R<Option<Side>> {
    let Some(found) = appdb::builder_states(&inv.home, &inv.env, inv.now, false)? else { return Ok(None) };
    let Some(t) = found.states.iter().find(|w| w.id == id) else { return Ok(None) };
    let mut rows: Vec<Seen> = Vec::new();
    for w in &found.states {
        let same_branch = t.branch.as_deref().is_some_and(|b| !b.is_empty() && w.branch.as_deref() == Some(b));
        let same_wt = t.worktree.as_deref().is_some_and(|p| !p.is_empty() && w.worktree.as_deref() == Some(p));
        if w.id == t.id || same_branch || same_wt {
            rows.push(Seen { id: w.id.clone(), st: state_word(w), branch: w.branch.clone() });
        }
    }
    Ok(Some(Side { target: t.id.clone(), rows }))
}

/// What one `hcArchiveCall` came to.
struct Call {
    ok: bool,
    error: String,
    archived_true: bool,
    retried: bool,
}

/// The name Node's `spawnSync` error carries for a call that could not run.
fn spawn_code(kind: std::io::ErrorKind) -> &'static str {
    match kind {
        std::io::ErrorKind::NotFound => text("devswarm_cli.hc_code_notfound"),
        std::io::ErrorKind::PermissionDenied => text("devswarm_cli.hc_code_denied"),
        _ => text("devswarm_cli.hc_code_other"),
    }
}

fn signal_name(sig: i32) -> String {
    let want = sig.to_string();
    for pair in defaults::list("devswarm_cli.hc_signal_names") {
        if let Some((num, name)) = pair.split_once('=')
            && num == want
        {
            return name.to_string();
        }
    }
    tpl("devswarm_cli.hc_signal_fallback", &[("n", &want)])
}

/// The `error` `defaultRun` reports for a call that did not succeed.
fn failure_text(f: &Full, target: &str) -> String {
    let bin = text("mesh_write.hivecontrol_bin");
    let spawn = |code: &str| tpl("devswarm_cli.hc_err_spawn", &[("bin", bin), ("code", code)]);
    if let Some(kind) = f.spawn_failed {
        return spawn(spawn_code(kind));
    }
    if f.overflow {
        return spawn(text("devswarm_cli.hc_code_buffer"));
    }
    if f.call.timed_out {
        return spawn(text("devswarm_cli.hc_code_timeout"));
    }
    let args = format!("{} {target}", defaults::list("devswarm_cli.hc_archive_args").join(" "));
    let detail = match js_trim(&f.stderr) {
        "" => String::new(),
        e => tpl("devswarm_cli.hc_err_detail", &[("stderr", e)]),
    };
    if let Some(sig) = f.signal {
        return tpl("devswarm_cli.hc_err_signal", &[("bin", bin), ("args", &args), ("signal", &signal_name(sig)), ("detail", &detail)]);
    }
    match f.code {
        Some(c) => tpl("devswarm_cli.hc_err_exited", &[("bin", bin), ("args", &args), ("status", &c.to_string()), ("detail", &detail)]),
        None => text("devswarm_cli.hc_err_unknown").to_string(),
    }
}

/// `hcArchiveCall(ident)`: one `workspace archive <ident>` in `cwd`, repeated once on the app's flaky terminal check.
fn archive_call(inv: &Inv, target: &str, cwd: &str) -> Call {
    let once = || -> Call {
        let mut args: Vec<&str> = defaults::list("devswarm_cli.hc_archive_args");
        args.push(target);
        let f = hivecontrol::call_full(&args, &inv.env, Some(cwd), defaults::millis("devswarm_cli.app_archive_timeout_ms"));
        if f.call.ok {
            let body = OVal::parse(&f.call.raw);
            if matches!(body.as_ref().and_then(|b| b.get("archived")), Some(OVal::Bool(false))) {
                let shown = js_trim(&f.call.raw);
                let cut = slice_utf16(shown, defaults::num("devswarm_cli.app_err_raw_chars") as usize)
                    .unwrap_or_else(|| shown.chars().take(defaults::num("devswarm_cli.app_err_raw_chars") as usize - 1).collect());
                return Call { ok: false, error: tpl("devswarm_cli.app_err_archived_false", &[("raw", &cut)]), archived_true: false, retried: false };
            }
            let archived_true = matches!(body.as_ref().and_then(|b| b.get("archived")), Some(OVal::Bool(true)));
            return Call { ok: true, error: String::new(), archived_true, retried: false };
        }
        Call { ok: false, error: failure_text(&f, target), archived_true: false, retried: false }
    };
    let first = once();
    if first.ok || !regex::Regex::new(text("devswarm_cli.app_archive_retry_re")).is_ok_and(|re| re.is_match(&first.error)) {
        return first;
    }
    Call { retried: true, ..once() }
}

/// `verifyAppArchived`: `Ok(())` verified, else why not.
fn verify(inv: &Inv, id: &str, resp: &Call) -> R<Result<(), String>> {
    let states = appdb::builder_states(&inv.home, &inv.env, inv.now, false)?;
    if let Some(b) = states.as_ref().and_then(|f| f.states.iter().find(|st| st.id == id)) {
        return Ok(if b.archived == Some(true) { Ok(()) } else { Err(text("devswarm_cli.app_why_still_open").to_string()) });
    }
    if resp.archived_true {
        return Ok(Ok(()));
    }
    Ok(Err(text("devswarm_cli.app_why_unconfirmed").to_string()))
}

/// `attemptAppArchive(id, desc, ctx)`: the `appArchive` object, whether it is ok, whether it was attempted and the side
/// effect it found. With `dry` nothing is spawned: only the reads that can defer are done.
struct AppLeg {
    json: Obj,
    ok: bool,
    attempted: bool,
    retried: bool,
    reason: Option<String>,
    error: Option<String>,
    manual: Option<String>,
    side: Option<(String, OVal)>,
}

fn not_attempted(reason: &str) -> AppLeg {
    let mut o = Obj::default();
    o.put("attempted", OVal::Bool(false)).put("reason", s(reason));
    AppLeg { json: o, ok: false, attempted: false, retried: false, reason: Some(reason.to_string()), error: None, manual: None, side: None }
}

fn attempt(inv: &Inv, id: &str, wt: &str, desc_branch: Option<&str>, dry: bool) -> R<AppLeg> {
    let branch_gate = match builder_gate(inv, id)? {
        Err(reason) => return Ok(not_attempted(&reason)),
        Ok(b) => b,
    };
    match hivecontrol::cap_verb(
        &inv.env,
        &inv.home,
        text("devswarm_cli.hc_archive_verb"),
        Some(text("devswarm_cli.hc_archive_min_version")),
        Some(text("devswarm_cli.hc_archive_note")),
    ) {
        Cap::Probe => return defer("capability-probe"),
        Cap::Absent => return Ok(not_attempted(text("devswarm_cli.app_reason_absent"))),
        Cap::Dormant(reason) => return Ok(not_attempted(if reason.is_empty() { text("devswarm_cli.app_reason_dormant") } else { &reason })),
        Cap::Ok => {}
    }
    if dry {
        return Ok(not_attempted(text("devswarm_cli.app_reason_dormant")));
    }
    let before = side_snapshot(inv, id)?;
    let branch = branch_gate.or_else(|| desc_branch.filter(|b| !b.is_empty()).map(str::to_string));
    // BRANCH FALLBACK GATE: a branch name may belong to a different (re-spawned, open) builder, so it is used only when exactly
    // one non-archived builder holds it and that builder is the target itself.
    let (branch_ok, branch_why) = match (&branch, &before) {
        (None, _) => (false, Some(text("devswarm_cli.app_why_no_branch").to_string())),
        (Some(_), None) => (false, Some(text("devswarm_cli.app_why_db").to_string())),
        (Some(b), Some(side)) => {
            let holders: Vec<&Seen> =
                side.rows.iter().filter(|r| r.branch.as_deref() == Some(b.as_str()) && r.st != text("devswarm_cli.app_state_archived")).collect();
            if holders.len() == 1 && holders[0].id == side.target {
                (true, None)
            } else {
                (false, Some(tpl("devswarm_cli.app_why_shared", &[("n", &holders.len().to_string())])))
            }
        }
    };
    let first = archive_call(inv, id, wt);
    let mut v = if first.ok { Some(verify(inv, id, &first)?) } else { None };
    let mut leg = if first.ok && matches!(v, Some(Ok(()))) {
        let mut o = Obj::default();
        o.put("attempted", OVal::Bool(true)).put("ok", OVal::Bool(true)).put("verified", OVal::Bool(true)).put("via", s(text("devswarm_cli.app_via_id")));
        if first.retried {
            o.put("retried", OVal::Bool(true));
        }
        Some(AppLeg { json: o, ok: true, attempted: true, retried: first.retried, reason: None, error: None, manual: None, side: None })
    } else {
        None
    };
    let mut second: Option<Call> = None;
    if leg.is_none()
        && first.ok
        && branch_ok
        && let Some(b) = &branch
    {
        let c = archive_call(inv, b, wt);
        if c.ok {
            v = Some(verify(inv, id, &c)?);
            if matches!(v, Some(Ok(()))) {
                let retried = first.retried || c.retried;
                let mut o = Obj::default();
                o.put("attempted", OVal::Bool(true))
                    .put("ok", OVal::Bool(true))
                    .put("verified", OVal::Bool(true))
                    .put("via", s(text("devswarm_cli.app_via_branch")))
                    .put("retried", OVal::Bool(retried));
                leg = Some(AppLeg { json: o, ok: true, attempted: true, retried, reason: None, error: None, manual: None, side: None });
            }
        }
        second = Some(c);
    }
    let mut leg = match leg {
        Some(l) => l,
        None => {
            let base = if !first.ok {
                first.error.clone()
            } else {
                let why = match &v {
                    Some(Err(w)) if !w.is_empty() => w.clone(),
                    _ => text("devswarm_cli.app_why_unverified").to_string(),
                };
                let head = match &second {
                    Some(c) if !c.ok => c.error.clone(),
                    _ => tpl("devswarm_cli.app_err_exit0", &[("why", &why)]),
                };
                let skipped = match (&branch_why, branch_ok) {
                    (Some(w), false) => format!(" {}", tpl("devswarm_cli.app_err_branch_skipped", &[("why", w)])),
                    _ => String::new(),
                };
                format!("{head}{skipped}")
            };
            let retried = first.retried || second.as_ref().is_some_and(|c| c.retried);
            let target = if branch_ok { branch.clone().unwrap_or_else(|| id.to_string()) } else { id.to_string() };
            let manual = tpl("devswarm_cli.app_manual_command", &[("target", &target)]);
            let mut o = Obj::default();
            o.put("attempted", OVal::Bool(true)).put("ok", OVal::Bool(false)).put("verified", OVal::Bool(false));
            if retried {
                o.put("retried", OVal::Bool(true));
            }
            o.put("error", s(&base)).put("manualCommand", s(&manual));
            AppLeg { json: o, ok: false, attempted: true, retried, reason: None, error: Some(base), manual: Some(manual), side: None }
        }
    };
    // `done(res)`: the other builders, compared with how they were
    if let Some(b) = &before
        && let Some(after) = side_snapshot(inv, id)?
    {
        let mut changed: Vec<OVal> = Vec::new();
        for r in &b.rows {
            let now = after.rows.iter().find(|x| x.id == r.id);
            if r.id != b.target && now.is_none_or(|x| x.st != r.st) {
                let mut c = Obj::default();
                c.put("id", s(&r.id)).put("before", s(r.st)).put("after", s(now.map_or(text("devswarm_cli.app_state_gone"), |x| x.st)));
                changed.push(c.done());
            }
        }
        if !changed.is_empty() {
            let message = tpl("devswarm_cli.app_side_effect", &[("id", id)]);
            let list = OVal::Arr(changed);
            let mut e = Obj::default();
            e.put("message", s(&message)).put("changed", list.clone());
            leg.json.put("sideEffect", e.done());
            leg.side = Some((message, list));
        }
    }
    Ok(leg)
}

// ---- the verb -----------------------------------------------------------------------------------------------------------

/// A regular file's bytes, its parsed JSON object and its `(device, inode)`; anything else is Node's.
fn read_object(p: &std::path::Path) -> R<(Vec<u8>, OVal, (u64, u64))> {
    let md = std::fs::symlink_metadata(p).map_err(|_| ident::Defer("descriptor-io".into()))?;
    if !md.is_file() {
        return defer("descriptor-not-file");
    }
    let bytes = std::fs::read(p).map_err(|_| ident::Defer("descriptor-io".into()))?;
    let v = OVal::parse(&String::from_utf8_lossy(&bytes));
    match v {
        Some(d @ OVal::Obj(_)) => {
            if matches!(&d, OVal::Obj(f) if f.iter().any(|(k, _)| k == "__proto__")) {
                return defer("descriptor-keys");
            }
            Ok((bytes, d, (md.dev(), md.ino())))
        }
        _ => defer("descriptor-shape"),
    }
}

fn nonempty(v: Option<&OVal>) -> Option<&str> {
    match v {
        Some(OVal::Str(x)) if !x.is_empty() => Some(x.as_str()),
        _ => None,
    }
}

/// `archive <id>`.
pub fn archive(inv: &Inv, a: &Args) -> R<Answer> {
    let id = a.positionals.get(1).map(String::as_str).unwrap_or("");
    if id.is_empty() {
        return Ok(bad_id());
    }
    if !is_safe_id(id) {
        return defer("unsafe-id");
    }
    if a.has(text("devswarm_cli.flag_force_cross_project")) {
        return defer("force-cross-project");
    }
    let root = idlock::devswarm_root(&inv.home);
    let json = text("mesh_write.json_suffix");
    let active = root.join(text("mesh_write.dir_workspaces")).join(format!("{id}{json}"));
    match std::fs::symlink_metadata(&active) {
        Ok(_) => {}
        Err(_) => return defer("not-an-active-id"),
    }
    let (bytes, desc, ino) = read_object(&active)?;
    if nonempty(desc.get("id")) != Some(id) {
        return defer("descriptor-identity");
    }
    let Some(wt) = nonempty(desc.get(text("mesh_write.field_worktree_path"))).map(str::to_string) else { return defer("descriptor-identity") };
    // the project of the caller's cwd and the proof that the descriptor is its own
    let ctx = ident::resolve_context(&inv.cwd, true)?;
    if ctx.kind.starts_with(text("mesh_write.kind_submodule_prefix")) {
        return defer("submodule");
    }
    let hash = crate::meshw::send::hash_from_workspace_id(id);
    let current_owner = ctx.repo_key.clone().unwrap_or_else(|| hash.clone());
    if let Some(reg) = crate::meshw::inbox::registered_repo_key(&desc, id)?
        && ctx.repo_key.as_deref() != Some(reg.as_str())
    {
        return defer("project-context-mismatch");
    }
    let Some(stored) = nonempty(desc.get(text("mesh_write.field_owner_key"))).map(str::to_string) else { return defer("owner-key-backfill") };
    if ctx.repo_key.is_some() && stored == hash && hash != current_owner {
        return defer("rehome");
    }
    if stored != current_owner {
        return defer("not-this-project");
    }
    // the archived directory is a real directory and holds no marker of this id yet
    let adir = root.join(text("mesh_write.dir_archived"));
    if !std::fs::symlink_metadata(&adir).is_ok_and(|m| m.is_dir() && !m.file_type().is_symlink()) {
        return defer("archived-dir");
    }
    if std::fs::symlink_metadata(adir.join(format!("{id}{json}"))).is_ok() {
        return defer("archived-marker-exists");
    }
    // the store: this id's row, no other row of the same worktree, no unread mail for it
    let rows = crate::dssup::recon::view::registry(&inv.home, &stored)?;
    if let Some(keep) = ident::canonical_worktree_real_path(&wt)? {
        for r in rows.iter().filter(|r| r.row.id != id) {
            if let Some(w) = r.row.worktree_path.as_deref().filter(|w| !w.is_empty())
                && ident::canonical_worktree_real_path(w)?.as_deref() == Some(keep.as_str())
            {
                return defer("worktree-group");
            }
        }
    }
    let mine = rows.iter().find(|r| r.row.id == id).cloned();
    let store = crate::meshw::common::open_store(inv, &stored)?;
    let sum = crate::meshw::summary::compute(&store, inv, None)?;
    let unread = match sum.get("workspaces").and_then(|w| w.get(id)).and_then(|w| w.get("unread")) {
        Some(OVal::Num(u)) => *u,
        _ if mine.is_none() => 0.0,
        _ => return defer("summary-shape"),
    };
    if unread > 0.0 {
        return defer("unread-partition");
    }
    let family = crate::dssup::recon::archive::plan_retire_identity_family(&inv.home, id, &desc, false, &std::collections::HashSet::new())?;
    if !family.retired.is_empty() || !family.left.is_empty() {
        return defer("identity-family");
    }
    let branch = nonempty(desc.get("branch")).map(str::to_string);
    // the app leg is evaluated once before the first write: whatever it cannot decide is Node's
    attempt(inv, id, &wt, branch.as_deref(), true)?;
    // ---- the writes, under the workspace's lock ----
    let Some(lock) = idlock::acquire(&inv.home, id) else { return defer("lock-busy") };
    let intent_rel = crate::dssup::recon::view::ds(&format!("{}/{id}{json}", text("devswarm_cli.dir_recovery_intent")));
    let (arel, drel) = (crate::dssup::recon::view::archived_rel(id), crate::dssup::recon::view::descriptor_rel(id));
    let mut intent = Obj::default();
    intent
        .put("id", s(id))
        .put("ownerKey", s(&stored))
        .put("op", s(text("devswarm_cli.recovery_op")))
        .put("descriptor", desc.clone())
        .put("fingerprint", s(&crate::dssup::recon::view::sha256_hex(desc.stringify().as_bytes())))
        .put("ts", n(inv.now as f64));
    let mut ops = vec![
        Op::Link { from: drel.clone(), to: arel.clone(), pre: Pre::Digest(crate::dssup::recon::view::sha256_hex(&bytes)), ino: Some(ino) },
        Op::Write { rel: intent_rel.clone(), bytes: intent.done().stringify().into_bytes(), pre: Pre::Any },
    ];
    if let Some(row) = mine {
        ops.push(Op::Remove { store: stored.clone(), guard: Box::new(row) });
    }
    ops.push(Op::Derive { store: stored.clone() });
    ops.push(Op::UnlinkLinked { rel: drel, other: arel });
    ops.push(Op::Unlink { rel: intent_rel, pre: Pre::Any });
    let applied = apply_units(inv, &[Unit { label: format!("archive:{id}"), lock: None, ops }]);
    if let Err(e) = applied {
        lock.release();
        return Err(e);
    }
    // the local archive is durable; the app leg and the warnings follow, still under the lock
    let leg = attempt(inv, id, &wt, branch.as_deref(), false);
    let leg = match leg {
        Ok(l) => l,
        Err(e) => {
            lock.release();
            return Err(ident::Defer(format!("committed:{}", e.0)));
        }
    };
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(true)).put("action", s(text("devswarm_cli.action_archive"))).put("id", s(id)).put("descriptorArchived", OVal::Bool(true));
    o.put("appArchive", OVal::Obj(leg.json.0.clone()));
    if let Some((message, changed)) = &leg.side {
        o.put("warnings", OVal::Arr(vec![s(&tpl("devswarm_cli.msg_app_side_warning", &[("message", message), ("changed", &changed.stringify())]))]));
    }
    let mut partial = false;
    if leg.ok {
        let retry = if leg.retried { text("devswarm_cli.msg_app_retry_note") } else { "" };
        o.put("manualStep", s(&tpl("devswarm_cli.msg_app_step_ok", &[("retry", retry)])));
    } else {
        if leg.attempted {
            partial = true;
            o.put("partial", OVal::Bool(true));
        }
        let cmd = leg.manual.clone().unwrap_or_else(|| tpl("devswarm_cli.app_manual_command", &[("target", id)]));
        let tail = if leg.attempted {
            let e = leg.error.clone().filter(|e| !e.is_empty()).unwrap_or_else(|| text("devswarm_cli.msg_app_error_unknown").to_string());
            tpl("devswarm_cli.msg_app_tail_attempted", &[("error", &e)])
        } else {
            match leg.reason.as_deref().filter(|r| !r.is_empty()) {
                Some(r) => tpl("devswarm_cli.msg_app_tail_skipped", &[("reason", r)]),
                None => String::new(),
            }
        };
        o.put("manualStep", s(&tpl("devswarm_cli.msg_app_step_fail", &[("cmd", &cmd), ("id", id), ("tail", &tail)])));
    }
    // a child that still beats may register again
    if has_fresh_heartbeat(inv, id) {
        let gone = match appdb::builder_states(&inv.home, &inv.env, inv.now, false) {
            Ok(Some(f)) => !f.states.iter().any(|st| st.id == id),
            _ => false,
        };
        if !gone {
            o.put("warning", s(&tpl("devswarm_cli.msg_live_child_warning", &[("id", id)])));
        }
    }
    lock.release();
    Ok(answer(if partial { 2 } else { 0 }, o.done()))
}
