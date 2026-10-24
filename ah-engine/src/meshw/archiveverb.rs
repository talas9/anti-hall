//! `devswarm.js archive <id>`, the local archive and the DevSwarm app leg (`scripts/devswarm-lib/archive.js` `cmdArchive`,
//! `attemptAppArchive`, `hcArchiveCall`, `verifyAppArchived`, `appSideSnapshot`).
//!
//! Native, every case: an active or archived-only descriptor, a workspace the registry knows but no descriptor names, a prefix
//! or mesh label (`resolveArchiveId`), a workspace archived locally whose app builder is still open (`appOnlyArchive`),
//! `--force-cross-project`, every refusal Node words (the logged ones are logged), a descriptor without an owner key (backfilled),
//! a hash-bucket descriptor (re-homed first), an archived marker that is already there (the orphan self-heal), a worktree group or
//! an identity family to fold, and a capability cache that needs a probe. The local half is the reconcile port's op list (the hard
//! link into `archived/`, the recovery marker, the registry tombstone and the summary, the unlink of the active name LAST, the
//! marker cleared), applied under the workspace's lock. Then, still under the lock, the app leg: the app database decides whether
//! `hivecontrol workspace archive` is called at all (an exact, open, non-Primary builder); the call is repeated once on the app's
//! own flaky "could not confirm terminal" failure; the app database is read again to verify; the branch name is tried once when the
//! id was accepted without effect; the other builders are compared before and after.
//!
//! The Node witness is not run for `archive`: it would meet the real `hivecontrol`. The parity test runs both sides against a
//! recording stub instead.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an unreadable optional file is the same as an absent one (fail-open, as Node's try/catch)
// A failure that must be seen goes through `crate::discard` instead.
use crate::checks::guardkit::ojson::OVal;
use crate::checks::guardkit::text::{js_trim, slice_utf16};
use crate::defaults;
use crate::dsact::runner::System;
use crate::dssup::recon::{Op, Pre, Unit, UnitEnd};
use crate::meshw::actverbs::has_fresh_heartbeat;
use crate::meshw::appdb::{self, State};
use crate::meshw::args::Args;
use crate::meshw::common::{Inv, Obj, n, s};
use crate::meshw::extverbs::tpl;
use crate::meshw::hivecontrol::{self, Cap, Full};
use crate::meshw::ident::{self, R};
use crate::meshw::idlock::{self, is_safe_id};
use crate::meshw::lifeverbs::bad_id;
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
/// effect it found.
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

/// `x.y.z` of a version text as three numbers.
fn triplet(v: &str) -> Option<[u64; 3]> {
    let c = regex::Regex::new(text("devswarm_cli.hc_version_re")).ok()?.captures(v)?;
    Some([c[1].parse().ok()?, c[2].parse().ok()?, c[3].parse().ok()?])
}

/// `devswarmCaps.can('workspace.archive')`: from the cache; a cache that holds no entry for this build is filled by asking the
/// binary (`--version`, `--help`, read-only), and a verdict the cache still does not hold is read from what was probed.
fn capability(inv: &Inv) -> Cap {
    let (verb, min, note) = (text("devswarm_cli.hc_archive_verb"), text("devswarm_cli.hc_archive_min_version"), text("devswarm_cli.hc_archive_note"));
    let ask = || hivecontrol::cap_verb(&inv.env, &inv.home, verb, Some(min), Some(note));
    match ask() {
        Cap::Probe => {
            crate::dssup::recon::capprobe::ensure(&inv.home, inv.now, &inv.env, &System::configured(), verb);
            match ask() {
                Cap::Probe => cap_from_cache(inv, verb, min, note),
                other => other,
            }
        }
        other => other,
    }
}

/// The verdict of `can` over the probe the cache holds (what `ask` would answer once the dormant line is recorded).
fn cap_from_cache(inv: &Inv, verb: &str, min: &str, note: &str) -> Cap {
    let file = inv.home.join(text("mesh_write.dir_anti_hall")).join(text("mesh_write.dir_devswarm")).join(text("mesh_write.hivecontrol_cache_file"));
    let cached = std::fs::read(file).ok().and_then(|b| OVal::parse(&String::from_utf8_lossy(&b)));
    let Some(probe) = cached.as_ref().and_then(|c| c.get("probe")).filter(|p| p.get("present").is_some_and(OVal::truthy)) else { return Cap::Absent };
    let version = match probe.get("version") {
        Some(OVal::Str(v)) if !v.is_empty() => Some(v.as_str()),
        _ => None,
    };
    let too_old = matches!((triplet(min), version.and_then(triplet)), (Some(m), Some(h)) if h < m);
    if !too_old && probe.get("verbs").and_then(|v| v.get(verb)).is_some_and(OVal::truthy) {
        return Cap::Ok;
    }
    Cap::Dormant(hivecontrol::dormant_line(verb, Some(min), Some(note), version, too_old).0)
}

fn attempt(inv: &Inv, id: &str, wt: Option<&str>, desc_branch: Option<&str>) -> R<AppLeg> {
    let branch_gate = match builder_gate(inv, id)? {
        Err(reason) => return Ok(not_attempted(&reason)),
        Ok(b) => b,
    };
    match capability(inv) {
        Cap::Probe | Cap::Absent => return Ok(not_attempted(text("devswarm_cli.app_reason_absent"))),
        Cap::Dormant(reason) => return Ok(not_attempted(if reason.is_empty() { text("devswarm_cli.app_reason_dormant") } else { &reason })),
        Cap::Ok => {}
    }
    let wt = wt.filter(|w| !w.is_empty()).unwrap_or(inv.cwd.as_str());
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

// ---- app-only archive ---------------------------------------------------------------------------------------------------

/// `readJsonDescriptors(dir)`: every `*.json` of the directory that holds a JSON object, with the file's name as the default id.
fn read_json_descriptors(dir: &std::path::Path) -> Vec<OVal> {
    let suffix = text("mesh_write.json_suffix");
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut out = Vec::new();
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let Some(stem) = name.strip_suffix(suffix) else { continue };
        let Some(OVal::Obj(fields)) = std::fs::read(e.path()).ok().and_then(|b| OVal::parse(&String::from_utf8_lossy(&b))) else { continue };
        let mut o = Obj::default();
        o.put("id", s(stem));
        for (k, v) in fields {
            o.put(&k, v);
        }
        out.push(o.done());
    }
    out
}

/// A string field that is non-empty.
fn str_of(v: Option<&OVal>) -> Option<&str> {
    nonempty(v)
}

/// `descriptorPhysicalOwnerKey(desc)`: the persisted owner key, else the structural repo key (the persisted repo key, else the one
/// the worktree resolves to).
fn physical_owner_key(d: &OVal) -> Option<String> {
    str_of(d.get(text("mesh_write.field_owner_key"))).map(str::to_string).or_else(|| structural_repo_key(d))
}

/// `descriptorStructuralRepoKey(desc)`.
fn structural_repo_key(d: &OVal) -> Option<String> {
    if let Some(k) = str_of(d.get(text("mesh_write.field_repo_key"))) {
        return Some(k.to_string());
    }
    let wt = d.get(text("mesh_write.field_worktree_path")).filter(|w| w.truthy())?;
    ident::repo_key_for_worktree(&crate::meshw::simple::js_text(wt)).ok().flatten()
}

/// One workspace anti-hall archived whose app builder was never archived (`localArchivedAppLive`).
struct AppRow {
    id: String,
    app_id: String,
    branch: Option<String>,
    worktree: Option<String>,
    cmd: String,
}

/// `localArchivedAppLive(home, { env, now, repoKey })`: whether the app database could be read, and the rows.
fn local_archived_app_live(inv: &Inv, repo_key: Option<&str>) -> R<(bool, Vec<AppRow>)> {
    let Some(found) = appdb::builder_states(&inv.home, &inv.env, inv.now, false)? else { return Ok((false, Vec::new())) };
    let root = idlock::devswarm_root(&inv.home);
    let archived = read_json_descriptors(&root.join(text("mesh_write.dir_archived")));
    let active = read_json_descriptors(&root.join(text("mesh_write.dir_workspaces")));
    let wt_key = |d: &OVal| -> Option<String> {
        let w = d.get(text("mesh_write.field_worktree_path")).filter(|w| w.truthy()).map(crate::meshw::simple::js_text)?;
        Some(ident::canonical_worktree_real_path(&w).ok().flatten().unwrap_or(w))
    };
    let id_of = |d: &OVal| d.get("id").filter(|v| !matches!(v, OVal::Null)).map(crate::meshw::simple::js_text);
    let active_ids: Vec<String> = active.iter().filter_map(id_of).collect();
    let active_wts: Vec<String> = active.iter().filter_map(wt_key).collect();
    let mut rows: Vec<AppRow> = Vec::new();
    for d in &archived {
        let Some(id) = id_of(d).filter(|i| is_safe_id(i)) else { continue };
        let by = d.get("archivedBy").map(crate::meshw::simple::js_text);
        if by.as_deref().is_some_and(|b| defaults::list("devswarm_cli.act_app_sourced_markers").contains(&b)) || active_ids.contains(&id) {
            continue;
        }
        let wt = wt_key(d);
        if wt.as_ref().is_some_and(|w| active_wts.contains(w)) {
            continue;
        }
        if repo_key.is_some() && physical_owner_key(d).as_deref() != repo_key {
            continue;
        }
        // the exact id only: a worktree fallback could name a re-spawned LIVE builder
        let Some(w) = found.states.iter().find(|x| x.id == id) else { continue };
        let bt = w.builder_type.as_deref().unwrap_or_default();
        if w.archived == Some(true)
            || bt.to_lowercase() == text("devswarm_cli.app_builder_type_primary")
            || bt.is_empty()
            || rows.iter().any(|r| r.app_id == w.id)
        {
            continue;
        }
        let branch = w.branch.clone().filter(|b| !b.is_empty()).or_else(|| str_of(d.get("branch")).map(str::to_string));
        rows.push(AppRow {
            cmd: tpl("devswarm_cli.app_manual_command", &[("target", branch.as_deref().unwrap_or(&w.id))]),
            id,
            app_id: w.id.clone(),
            branch,
            worktree: wt,
        });
    }
    Ok((true, rows))
}

/// The `appArchive` object of a leg as the result carries it.
fn leg_value(leg: &AppLeg) -> OVal {
    OVal::Obj(leg.json.0.clone())
}

/// `appOnlyArchive(raw, ctx)`: `archive <branch|meshId|id-prefix|uuid>` for a workspace anti-hall already archived whose app
/// builder is still open archives the APP side only (verified, idempotent). `None` is "not this case": the normal path runs.
fn app_only_archive(inv: &Inv, raw: &str) -> R<Option<Answer>> {
    if raw.is_empty() {
        return Ok(None);
    }
    let root = idlock::devswarm_root(&inv.home);
    let json = text("mesh_write.json_suffix");
    if is_safe_id(raw) && std::fs::symlink_metadata(root.join(text("mesh_write.dir_workspaces")).join(format!("{raw}{json}"))).is_ok() {
        return Ok(None); // still active in anti-hall
    }
    let repo_key = ident::repo_key_for_worktree(&inv.cwd).ok().flatten();
    let (app_db, rows) = local_archived_app_live(inv, repo_key.as_deref())?;
    if !app_db {
        return Ok(None);
    }
    let long = is_safe_id(raw) && raw.len() >= defaults::num("devswarm_cli.act_prefix_min") as usize;
    let hit: Vec<&AppRow> = rows
        .iter()
        .filter(|r| {
            r.id == raw
                || r.app_id == raw
                || r.branch.as_deref() == Some(raw)
                || (long && (r.id.starts_with(raw) || r.app_id.starts_with(raw)))
                || r.worktree.as_deref().and_then(|w| ident::primary_workspace_id(w).ok()).as_deref() == Some(raw)
        })
        .collect();
    let action = || s(text("devswarm_cli.action_archive"));
    if hit.is_empty() {
        // already archived on both sides (idempotent): an archived descriptor and an app-archived builder
        let Some(found) = appdb::builder_states(&inv.home, &inv.env, inv.now, false)? else { return Ok(None) };
        let archived_ids: Vec<String> = read_json_descriptors(&root.join(text("mesh_write.dir_archived")))
            .iter()
            .filter_map(|d| d.get("id").filter(|v| !matches!(v, OVal::Null)).map(crate::meshw::simple::js_text))
            .collect();
        let Some(w) = found.states.iter().find(|x| {
            x.archived == Some(true) && archived_ids.contains(&x.id) && (x.id == raw || x.branch.as_deref() == Some(raw) || (long && x.id.starts_with(raw)))
        }) else {
            return Ok(None);
        };
        let mut app = Obj::default();
        app.put("attempted", OVal::Bool(false))
            .put("ok", OVal::Bool(true))
            .put("verified", OVal::Bool(true))
            .put("reason", s(text("devswarm_cli.act_reason_already_archived_app")));
        let mut o = Obj::default();
        o.put("ok", OVal::Bool(true))
            .put("action", action())
            .put("id", s(&w.id))
            .put("descriptorArchived", OVal::Bool(false))
            .put("alreadyArchived", OVal::Bool(true))
            .put("appArchive", app.done());
        return Ok(Some(answer(0, o.done())));
    }
    if hit.len() > 1 {
        let ids: Vec<&str> = hit.iter().map(|r| r.app_id.as_str()).collect();
        let mut o = Obj::default();
        o.put("ok", OVal::Bool(false))
            .put("action", action())
            .put("id", s(raw))
            .put("descriptorArchived", OVal::Bool(false))
            .put(
                "error",
                s(&tpl(
                    "devswarm_cli.act_msg_app_ambiguous",
                    &[("raw", &crate::meshw::actverbs::quote(raw)), ("n", &hit.len().to_string()), ("ids", &ids.join(text("devswarm_cli.msg_ids_join")))],
                )),
            )
            .put("candidates", OVal::Arr(ids.iter().map(|x| s(x)).collect()));
        return Ok(Some(answer(2, o.done())));
    }
    let r = hit[0];
    let leg = attempt(inv, &r.app_id, r.worktree.as_deref(), r.branch.as_deref())?;
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(true))
        .put("action", action())
        .put("id", s(&r.id))
        .put("descriptorArchived", OVal::Bool(false))
        .put("alreadyArchived", OVal::Bool(true))
        .put("appOnly", OVal::Bool(true))
        .put("appArchive", leg_value(&leg));
    if let Some((message, changed)) = &leg.side {
        o.put("warnings", OVal::Arr(vec![s(&tpl("devswarm_cli.msg_app_side_warning", &[("message", message), ("changed", &changed.stringify())]))]));
    }
    if !leg.ok {
        let cmd = leg.manual.clone().unwrap_or_else(|| r.cmd.clone());
        let tail = match leg.error.as_deref().filter(|e| !e.is_empty()) {
            Some(e) => tpl("devswarm_cli.act_msg_app_only_error", &[("error", e)]),
            None => String::new(),
        };
        o.put("partial", OVal::Bool(true)).put("manualStep", s(&tpl("devswarm_cli.act_msg_app_only_step", &[("cmd", &cmd), ("tail", &tail)])));
    }
    let code = if leg.ok { 0 } else { 2 };
    Ok(Some(answer(code, o.done())))
}

// ---- the verb -----------------------------------------------------------------------------------------------------------

/// What `readDescriptorPathState(p)` found.
struct DescState {
    exists: bool,
    desc: Option<OVal>,
    error: Option<String>,
}

/// `readDescriptorPathState(p)`: absent, a descriptor, or why it cannot be read.
fn descriptor_state(p: &std::path::Path) -> R<DescState> {
    let md = match std::fs::symlink_metadata(p) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(DescState { exists: false, desc: None, error: None }),
        Err(e) => return Ok(DescState { exists: true, desc: None, error: Some(crate::migrate::node_err(&e, text("devswarm_cli.act_sys_lstat"), p)) }),
    };
    let broken = |why: String| DescState { exists: true, desc: None, error: Some(why) };
    if !md.is_file() {
        return Ok(broken(text("devswarm_cli.act_msg_desc_not_file").to_string()));
    }
    let Some(bytes) = ident::read_bounded(p)? else { return Ok(broken(text("devswarm_cli.act_msg_desc_unreadable").to_string())) };
    Ok(match serde_json::from_slice::<serde_json::Value>(&bytes) {
        Err(e) => broken(e.to_string()),
        Ok(v) if !v.is_object() => broken(text("devswarm_cli.act_msg_desc_not_object").to_string()),
        Ok(_) => DescState { exists: true, desc: OVal::parse(&String::from_utf8_lossy(&bytes)), error: None },
    })
}

fn nonempty(v: Option<&OVal>) -> Option<&str> {
    match v {
        Some(OVal::Str(x)) if !x.is_empty() => Some(x.as_str()),
        _ => None,
    }
}

/// `{ ok: false, action: 'archive', id, descriptorArchived: false, error }`, exit 2.
fn arch_error(id: &str, error: &str) -> Answer {
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(false))
        .put("action", s(text("devswarm_cli.action_archive")))
        .put("id", s(id))
        .put("descriptorArchived", OVal::Bool(false))
        .put("error", s(error));
    answer(2, o.done())
}

/// `(device, inode)` of the file at `p` without following a link.
fn ino(p: &std::path::Path) -> Option<(u64, u64)> {
    std::fs::symlink_metadata(p).ok().map(|m| (m.dev(), m.ino()))
}

/// `archivedTombstoneIsOrphaned`: no live descriptor shares the archived file's inode. An unreadable directory or any entry that
/// cannot be examined reads as "not orphaned" (nothing is ever unlinked on an incomplete scan).
fn tombstone_is_orphaned(root: &std::path::Path, archived: (u64, u64)) -> bool {
    let dir = root.join(text("mesh_write.dir_workspaces"));
    let Ok(entries) = std::fs::read_dir(&dir) else { return false };
    for e in entries {
        let Ok(e) = e else { return false };
        let name = e.file_name().to_string_lossy().into_owned();
        if !name.ends_with(text("mesh_write.json_suffix")) {
            continue;
        }
        match ino(&dir.join(&name)) {
            None => return false,
            Some(i) if i == archived => return false,
            Some(_) => {}
        }
    }
    true
}

/// How `cmdArchive` was called.
pub(crate) struct Opts<'a> {
    /// The CLI flags (`--force-cross-project`): only the interactive verb passes them, never a sweep.
    pub args: Option<&'a Args>,
    /// `opts.revalidate(desc)`: a reason to skip, evaluated inside the lock right before the archive.
    #[allow(clippy::type_complexity)] // a skip-reason callback, named by its doc
    pub revalidate: Option<&'a dyn Fn(Option<&OVal>) -> Option<String>>,
}

/// A unit's ops applied to the real home (no lock: the caller holds the workspace's).
fn apply_unit(inv: &Inv, label: &str, ops: Vec<Op>) -> UnitEnd {
    let st = inv.settings();
    let env = crate::dssup::recon::apply::Env { home: &inv.home, now: inv.now, st: &st, log_dir: None };
    crate::dssup::recon::apply::unit(&env, &Unit { label: label.to_string(), lock: None, ops }, &crate::dssup::recon::Hooks::none())
}

/// The answer fields every app leg reports (`appArchive`, the side-effect warning, `manualStep`, `partial`); whether the leg was partial.
fn app_fields(o: &mut Obj, leg: &AppLeg, id: &str) -> bool {
    o.put("appArchive", leg_value(leg));
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
    partial
}

/// A resolved id with no local descriptor (a workspace that never registered, known to the app and to this project's registry):
/// only the app is asked to archive it and nothing local changes. `None` when the registry or the app does not know it.
fn app_only(inv: &Inv, raw: &str, id: &str) -> R<Option<Answer>> {
    let Some(key) = ident::resolve_context(&inv.cwd, true)?.repo_key else { return Ok(None) };
    let Ok(rows) = crate::dssup::recon::view::registry(&inv.home, &key) else { return Ok(None) };
    let wt_of = |key: &str| rows.iter().find(|r| r.row.id == key).and_then(|r| r.row.worktree_path.clone()).filter(|w| !w.is_empty());
    let (wt, from_label) = match wt_of(id) {
        Some(wt) => (wt, false),
        // a label-only row (a phantom, not yet filled by the sweep): its worktree is the workspace's; the app id's row is written below
        None => match wt_of(raw).filter(|w| ident::primary_workspace_id(w).ok().as_deref() == Some(raw)) {
            Some(wt) => (wt, true),
            None => return Ok(None),
        },
    };
    let leg = attempt(inv, id, Some(&wt), None)?;
    if !leg.attempted {
        return Ok(None);
    }
    if from_label && crate::dssup::recon::labelfill::write_row(inv, &key, id, &wt) {
        let st = inv.settings();
        let env = crate::dssup::recon::apply::Env { home: &inv.home, now: inv.now, st: &st, log_dir: None };
        let op = Op::Log {
            component: text("devswarm_recon.log_component_reconcile").into(),
            op: text("devswarm_recon.lf_op").into(),
            level: text("devswarm_recon.log_level_info").into(),
            msg: crate::dssup::recon::labelfill::filled_msg(id, raw, &wt),
            ctx: crate::dssup::recon::labelfill::filled_ctx(id, raw, &wt).to_string(),
        };
        crate::discard::harmless(
            match crate::dssup::recon::apply::unit(&env, &Unit { label: "log".into(), lock: None, ops: vec![op] }, &crate::dssup::recon::Hooks::none()) {
                UnitEnd::Failed(w) => Err(w),
                _ => Ok(()),
            },
        ); // keep: a log line that cannot be written never fails the archive
    }
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(leg.ok)).put("action", s(text("devswarm_cli.action_archive"))).put("id", s(raw)).put("descriptorArchived", OVal::Bool(false));
    let partial = app_fields(&mut o, &leg, id);
    o.put("note", s(text("devswarm_cli.aa_only_note")));
    Ok(Some(answer(if partial || !leg.ok { 2 } else { 0 }, o.done())))
}

/// `archive <id>`.
pub fn archive(inv: &Inv, a: &Args) -> R<Answer> {
    archive_with(inv, a, None)
}

/// [`archive`] with Node's `opts.revalidate`: the caller's check of the descriptor, run INSIDE the workspace's lock immediately before
/// the first write. A reason skips the archive (`{ ok: true, skipped: true, reason }`, nothing written).
#[allow(clippy::type_complexity)] // a skip-reason callback, named by its doc
pub fn archive_with(inv: &Inv, a: &Args, revalidate: Option<&dyn Fn(&OVal) -> Option<String>>) -> R<Answer> {
    let raw = a.positionals.get(1).map(String::as_str).unwrap_or("");
    // already archived in anti-hall but still live in the app: archive the app side only
    if let Some(only) = app_only_archive(inv, raw)? {
        return Ok(only);
    }
    if !is_safe_id(raw) {
        return Ok(bad_id());
    }
    // `resolveArchiveId`: a unique prefix or mesh label names the workspace; an ambiguous one archives nothing
    let (resolved, found) = crate::meshw::actverbs::resolve_archive_id_found(inv, raw, false)?;
    let id = match resolved {
        crate::meshw::actverbs::Resolved::Id(x) if found => x,
        crate::meshw::actverbs::Resolved::Id(x) => {
            if let Some(done) = app_only(inv, raw, &x)? {
                return Ok(done);
            }
            let mut o = Obj::default();
            o.put("action", s(text("devswarm_cli.action_archive"))).put("id", s(raw)).put("descriptorArchived", OVal::Bool(false));
            o.put("ok", OVal::Bool(false)).put("error", s(text("devswarm_cli.msg_bad_id")));
            return Ok(answer(2, o.done()));
        }
        crate::meshw::actverbs::Resolved::Ambiguous(template, ids) => {
            let msg = crate::checks::devswarm_role::text::fill_once(
                template,
                &[("id", &crate::meshw::actverbs::quote(raw)), ("n", &ids.len().to_string()), ("ids", &ids.join(text("devswarm_cli.msg_ids_join")))],
            );
            let mut o = Obj::default();
            o.put("action", s(text("devswarm_cli.action_archive"))).put("id", s(raw)).put("descriptorArchived", OVal::Bool(false));
            o.put("ok", OVal::Bool(false)).put("error", s(&msg)).put("candidates", OVal::Arr(ids.iter().map(|x| s(x)).collect()));
            return Ok(answer(2, o.done()));
        }
    };
    let adapt = |d: Option<&OVal>| d.and_then(|d| revalidate.and_then(|check| check(d)));
    cmd_archive(inv, &id, &Opts { args: Some(a), revalidate: revalidate.map(|_| &adapt as &dyn Fn(Option<&OVal>) -> Option<String>) })
}

/// `cmdArchive(id, ctx, opts)`, under the workspace's own lock.
pub(crate) fn cmd_archive(inv: &Inv, id: &str, opts: &Opts<'_>) -> R<Answer> {
    let Some(lock) = idlock::acquire(&inv.home, id) else {
        // `withIdLock`: a lock that stayed busy is a failed result, nothing archived
        let keys = defaults::list("devswarm_cli.key_lock_busy");
        let mut o = Obj::default();
        o.put("ok", OVal::Bool(false))
            .put(keys[0], OVal::Bool(true))
            .put(keys[1], s(id))
            .put("error", s(&tpl("devswarm_cli.msg_lock_busy", &[("id", &crate::meshw::actverbs::quote(id))])));
        return Ok(answer(2, o.done()));
    };
    let out = cmd_archive_locked(inv, id, opts);
    lock.release();
    out
}

fn cmd_archive_locked(inv: &Inv, id: &str, opts: &Opts<'_>) -> R<Answer> {
    let root = idlock::devswarm_root(&inv.home);
    let json = text("mesh_write.json_suffix");
    let active_path = root.join(text("mesh_write.dir_workspaces")).join(format!("{id}{json}"));
    // `checkedArchivedDir(home, { create: true })`
    let adir = root.join(text("mesh_write.dir_archived"));
    let mut adir_md = std::fs::symlink_metadata(&adir);
    if adir_md.as_ref().is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound) {
        if let Err(e) = std::fs::create_dir_all(&adir) {
            return Ok(arch_error(
                id,
                &tpl("devswarm_cli.act_msg_archived_dir", &[("error", &crate::migrate::node_err(&e, text("devswarm_cli.act_sys_mkdir"), &adir))]),
            ));
        }
        adir_md = std::fs::symlink_metadata(&adir);
    }
    match &adir_md {
        Err(e) => {
            return Ok(arch_error(
                id,
                &tpl("devswarm_cli.act_msg_archived_dir", &[("error", &crate::migrate::node_err(e, text("devswarm_cli.act_sys_lstat"), &adir))]),
            ));
        }
        Ok(m) if !m.is_dir() || m.file_type().is_symlink() => {
            return Ok(arch_error(id, &tpl("devswarm_cli.act_msg_archived_dir", &[("error", text("devswarm_cli.act_msg_archived_not_dir"))])));
        }
        Ok(_) => {}
    }
    let archived_path = adir.join(format!("{id}{json}"));
    let active = descriptor_state(&active_path)?;
    if let Some(err) = &active.error {
        return Ok(arch_error(id, &tpl("devswarm_cli.act_msg_desc_read_active", &[("error", err)])));
    }
    let mut desc = active.desc.clone();
    if !active.exists {
        let archived_state = descriptor_state(&archived_path)?;
        if let Some(err) = &archived_state.error {
            return Ok(arch_error(id, &tpl("devswarm_cli.act_msg_desc_read_archived", &[("error", err)])));
        }
        desc = archived_state.desc;
    }
    let current_repo_key = ident::resolve_context(&inv.cwd, true)?.repo_key;
    let hash = crate::meshw::send::hash_from_workspace_id(id);
    let current_owner = current_repo_key.clone().unwrap_or_else(|| hash.clone());
    let mut owner_key: Option<String> = Some(current_owner.clone());
    let mut cross_override = false;
    let q = |x: &str| crate::meshw::actverbs::quote(x);
    if let Some(d0) = desc.clone() {
        let mut d = d0;
        let same_id = matches!(d.get("id"), Some(OVal::Str(x)) if is_safe_id(x) && x == id);
        if !same_id || !d.get(text("mesh_write.field_worktree_path")).is_some_and(OVal::truthy) {
            return Ok(arch_error(id, &tpl("devswarm_cli.act_msg_desc_identity", &[("id", &q(id))])));
        }
        // ---- the id-derived authority gate: refuse FIRST, on the id's own registered project ----
        if let Some(registered) = crate::meshw::inbox::registered_repo_key(&d, id)?
            && current_repo_key.as_deref() != Some(registered.as_str())
        {
            let forced = opts.args.and_then(|a| a.one(text("devswarm_cli.flag_force_cross_project")));
            let provided = opts.args.is_some_and(|a| a.has(text("devswarm_cli.flag_force_cross_project")));
            if provided && forced == Some(id) {
                cross_override = true;
                log_override(inv, id, current_repo_key.as_deref(), &registered);
            } else {
                return Ok(mismatch_refusal(id, &registered, current_repo_key.as_deref(), provided, forced));
            }
        }
        if active.exists {
            let stored_pre = nonempty(d.get(text("mesh_write.field_owner_key")));
            if let (Some(cur), Some(stored)) = (current_repo_key.as_deref(), stored_pre)
                && stored == hash
                && hash != cur
            {
                // a descriptor stranded in the legacy hash bucket of a project that now resolves is re-homed first (the lock is held)
                let st = inv.settings();
                let ctx = crate::dssup::tick::Ctx { home: &inv.home, root: &inv.home, st: &st, now: inv.now, engine_pokes: true };
                let moved = crate::dssup::recon::rehome::across_stores_locked(&ctx, id, &hash, cur);
                if moved.rehomed
                    && let Some(re) = ident::read_descriptor(&inv.home, id)
                    && matches!(re.get("id"), Some(OVal::Str(x)) if x == id)
                {
                    d = re;
                }
            }
        }
        let stored_owner = nonempty(d.get(text("mesh_write.field_owner_key"))).map(str::to_string);
        let structural = structural_repo_key(&d);
        let fresh = d
            .get(text("mesh_write.field_worktree_path"))
            .filter(|w| w.truthy())
            .and_then(|w| ident::repo_key_for_worktree(&crate::meshw::simple::js_text(w)).ok().flatten());
        let legacy_per_id = active.exists && stored_owner.is_none() && structural.is_none() && current_repo_key.is_none();
        owner_key = stored_owner.clone().or(structural).or_else(|| legacy_per_id.then(|| current_owner.clone()));
        if owner_key.as_deref() != Some(current_owner.as_str()) && !cross_override {
            return Ok(arch_error(id, text("devswarm_cli.act_msg_not_this_project")));
        }
        // an override can only fire when the id HAS a resolvable registered key: fall back to it
        if cross_override && owner_key.is_none() {
            owner_key = crate::meshw::inbox::registered_repo_key(&d, id)?.or_else(|| Some(current_owner.clone()));
        }
        if active.exists && stored_owner.is_none() && !cross_override {
            // backfill the project identity the descriptor never recorded
            d.set(text("mesh_write.field_owner_key"), s(&current_owner));
            owner_key = Some(current_owner.clone());
            if let (Some(cur), Some(f)) = (current_repo_key.as_deref(), fresh.as_deref())
                && f == cur
            {
                d.set(text("mesh_write.field_repo_key"), s(cur));
            }
            if let Err(e) = crate::atomic::write(&active_path, d.stringify()) {
                return Ok(arch_error(
                    id,
                    &tpl("devswarm_cli.act_msg_desc_persist", &[("error", &crate::migrate::node_err(&e, text("devswarm_cli.act_sys_open"), &active_path))]),
                ));
            }
        }
        desc = Some(d);
    }
    // the safety condition is re-checked INSIDE the lock, right before any mutation
    if let Some(check) = opts.revalidate
        && let Some(why) = check(desc.as_ref())
    {
        let mut o = Obj::default();
        o.put("ok", OVal::Bool(true))
            .put("action", s(text("devswarm_cli.action_archive")))
            .put("id", s(id))
            .put("descriptorArchived", OVal::Bool(false))
            .put("skipped", OVal::Bool(true))
            .put("reason", s(&why));
        return Ok(answer(0, o.done()));
    }
    let owner = owner_key.clone().unwrap_or_else(|| current_owner.clone());
    // ---- 1. the archived name: a hard link of the active descriptor; a leftover one that is nobody's is replaced atomically ----
    if active.exists
        && let Some(arch) = ino(&archived_path)
        && ino(&active_path) != Some(arch)
    {
        let healed = tombstone_is_orphaned(&root, arch) && {
            let tmp = adir.join(format!("{id}{json}{}", text("devswarm_cli.act_heal_suffix")));
            crate::discard::harmless(std::fs::remove_file(&tmp)); // keep: clears a leftover of a crashed heal
            let ok = std::fs::hard_link(&active_path, &tmp).is_ok() && std::fs::rename(&tmp, &archived_path).is_ok();
            if !ok {
                crate::discard::harmless(std::fs::remove_file(&tmp)); // keep: never leave the temporary link behind
            }
            ok && ino(&active_path) == ino(&archived_path)
        };
        if !healed {
            return Ok(arch_error(id, &tpl("devswarm_cli.act_msg_link_failed", &[("error", text("devswarm_cli.act_msg_link_exists"))])));
        }
    }
    let (arel, drel) = (crate::dssup::recon::view::archived_rel(id), crate::dssup::recon::view::descriptor_rel(id));
    let intent_rel = crate::dssup::recon::view::ds(&format!("{}/{id}{json}", text("devswarm_cli.dir_recovery_intent")));
    let mut linked_here = false;
    let mut first_ops: Vec<Op> = Vec::new();
    if active.exists {
        let bytes = ident::read_bounded(&active_path)?.unwrap_or_default();
        let (dev_ino, link_pre) = (ino(&active_path), Pre::Digest(crate::dssup::recon::view::sha256_hex(&bytes)));
        linked_here = ino(&archived_path).is_none();
        first_ops.push(Op::Link { from: drel.clone(), to: arel.clone(), pre: link_pre, ino: dev_ino });
    }
    if let Some(d) = &desc {
        let mut intent = Obj::default();
        intent
            .put("id", s(id))
            .put("ownerKey", s(&owner))
            .put("op", s(text("devswarm_cli.recovery_op")))
            .put("descriptor", d.clone())
            .put("fingerprint", s(&crate::dssup::recon::view::sha256_hex(d.stringify().as_bytes())))
            .put("ts", n(inv.now as f64));
        first_ops.push(Op::Write { rel: intent_rel.clone(), bytes: intent.done().stringify().into_bytes(), pre: Pre::Any });
    }
    let rollback = |inv: &Inv| {
        // nothing archived: the hard link this call made goes, and the recovery marker with it
        if linked_here {
            crate::discard::harmless(std::fs::remove_file(inv.home.join(&arel))); // keep: the link is ours and only disk
        }
        crate::discard::harmless(std::fs::remove_file(inv.home.join(&intent_rel))); // keep: an absent marker is already clear
    };
    if !first_ops.is_empty() {
        match apply_unit(inv, &format!("archive:{id}:link"), first_ops) {
            UnitEnd::Applied => crate::meshw::mark_committed(),
            UnitEnd::Deferred(why) | UnitEnd::Failed(why) => {
                rollback(inv);
                return Ok(arch_error(id, &tpl("devswarm_cli.act_msg_link_failed", &[("error", &why)])));
            }
        }
    }
    // ---- 2. the worktree group (before this id's own tombstone, so the duplicates' unread lands in a drainable partition) ----
    let group = match desc.as_ref().and_then(|d| d.get(text("mesh_write.field_worktree_path"))).filter(|w| w.truthy()).map(crate::meshw::simple::js_text) {
        Some(wt) => {
            let st = inv.settings();
            let ctx = crate::dssup::tick::Ctx { home: &inv.home, root: &inv.home, st: &st, now: inv.now, engine_pokes: true };
            // fail-open: a group retire never breaks archive itself
            crate::dssup::recon::archived::retire_archived_worktree_group(&ctx, &System::configured(), &owner, id, &wt, &crate::dssup::recon::Hooks::none())
                .ok()
                .map(|r| r.result)
        }
        None => None,
    };
    // ---- 3. the tombstone: this id's registry row, then the summary ----
    let mine = crate::dssup::recon::view::registry(&inv.home, &owner)?.into_iter().find(|r| r.row.id == id);
    let mut tomb: Vec<Op> = Vec::new();
    if let Some(row) = mine {
        tomb.push(Op::Remove { store: owner.clone(), guard: Box::new(row) });
    }
    tomb.push(Op::Derive { store: owner.clone() });
    match apply_unit(inv, &format!("archive:{id}:tombstone"), tomb) {
        UnitEnd::Applied => crate::meshw::mark_committed(),
        UnitEnd::Deferred(why) | UnitEnd::Failed(why) => {
            rollback(inv);
            return Ok(arch_error(id, &tpl("devswarm_cli.act_msg_tombstone_failed", &[("error", &why)])));
        }
    }
    // ---- 4. the active name goes LAST, then the marker ----
    let mut last: Vec<Op> = Vec::new();
    if active.exists {
        last.push(Op::UnlinkLinked { rel: drel, other: arel.clone() });
    }
    last.push(Op::Unlink { rel: intent_rel.clone(), pre: Pre::Any });
    match apply_unit(inv, &format!("archive:{id}:unlink"), last) {
        UnitEnd::Applied => {}
        UnitEnd::Deferred(why) | UnitEnd::Failed(why) => {
            // the tombstone is durable and the marker stays for repair (doctor or the next run revives the row from it)
            let mut o = Obj::default();
            o.put("ok", OVal::Bool(false))
                .put("action", s(text("devswarm_cli.action_archive")))
                .put("id", s(id))
                .put("descriptorArchived", OVal::Bool(false))
                .put("recoveryIntent", OVal::Bool(true))
                .put("error", s(&tpl("devswarm_cli.act_msg_unlink_failed", &[("error", &why)])));
            return Ok(answer(2, o.done()));
        }
    }
    // ---- 5. the identity family (after this archive is fully durable) ----
    let family = match &desc {
        Some(d) => family_retire(inv, id, d),
        None => (Vec::new(), Vec::new()),
    };
    // ---- 6. the app side ----
    let wt = desc.as_ref().and_then(|d| str_of(d.get(text("mesh_write.field_worktree_path")))).map(str::to_string);
    let branch = desc.as_ref().and_then(|d| str_of(d.get("branch"))).map(str::to_string);
    let leg = match attempt(inv, id, wt.as_deref(), branch.as_deref()) {
        Ok(l) => l,
        Err(e) => return Ok(refusal_after_commit(&e.0)),
    };
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(true)).put("action", s(text("devswarm_cli.action_archive"))).put("id", s(id)).put("descriptorArchived", OVal::Bool(active.exists));
    let partial = app_fields(&mut o, &leg, id);
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
    // the group retire is reported only when it did something
    if let Some(g) = &group {
        let field = |k: &str| g.get(k).cloned().unwrap_or(serde_json::Value::Null);
        let as_oval = |v: serde_json::Value| OVal::parse(&v.to_string()).unwrap_or(OVal::Null);
        if field("retired").as_array().is_some_and(|a| !a.is_empty()) {
            o.put("retiredDuplicates", as_oval(field("retired")));
        }
        if field("forwarded").as_f64().is_some_and(|f| f != 0.0) {
            o.put("forwardedFromDuplicates", as_oval(field("forwarded")));
        }
        if field("left").as_array().is_some_and(|a| !a.is_empty()) {
            o.put("leftDuplicates", as_oval(field("left")));
        }
    }
    if !family.0.is_empty() {
        o.put("retiredFamilyDescriptors", OVal::Arr(family.0.iter().map(|x| s(x)).collect()));
    }
    if !family.1.is_empty() {
        o.put("leftFamilyDescriptors", OVal::Arr(family.1.iter().map(|(i, r)| OVal::Obj(vec![("id".into(), s(i)), ("reason".into(), s(r))])).collect()));
    }
    if cross_override {
        o.put("forceCrossProject", OVal::Bool(true)).put("warning", s(text("devswarm_cli.act_force_cross_warning")));
    }
    Ok(answer(if partial { 2 } else { 0 }, o.done()))
}

/// `retireIdentityFamilyDescriptors(home, id, desc)`: the twins retired and the ones left (with why), after this id's own archive.
/// Fail-open: a twin that cannot be retired now stays and is reported.
fn family_retire(inv: &Inv, id: &str, desc: &OVal) -> (Vec<String>, Vec<(String, String)>) {
    use crate::dssup::recon::{UnitEnd, archive::plan_retire_identity_family};
    let Ok(plan) = plan_retire_identity_family(&inv.home, id, desc, false, &std::collections::HashSet::new()) else { return (Vec::new(), Vec::new()) };
    let mut retired = Vec::new();
    let mut left = plan.left.clone();
    let st = inv.settings();
    let env = crate::dssup::recon::apply::Env { home: &inv.home, now: inv.now, st: &st, log_dir: None };
    for (unit, twin) in plan.units.iter().zip(plan.retired.iter()) {
        match crate::dssup::recon::apply::unit(&env, unit, &crate::dssup::recon::Hooks::none()) {
            UnitEnd::Applied => {
                crate::meshw::mark_committed();
                retired.push(twin.clone());
            }
            UnitEnd::Deferred(why) | UnitEnd::Failed(why) => left.push((twin.clone(), why)),
        }
    }
    (retired, left)
}

/// A failure after the archive is durable: Node's catch prints `{ ok: false, error }`.
fn refusal_after_commit(msg: &str) -> Answer {
    crate::meshw::mark_committed();
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(false)).put("error", s(msg));
    answer(2, o.done())
}

/// `projectContextMismatch(id, registeredKey, callerKey, tail)` of `archive`, with the cross-project hint appended
/// (`Object.assign({ action, descriptorArchived: false }, mismatch)`).
fn mismatch_refusal(id: &str, registered: &str, caller: Option<&str>, provided: bool, value: Option<&str>) -> Answer {
    let q = |x: &str| crate::meshw::actverbs::quote(x);
    let who = match caller {
        Some(c) => tpl("devswarm_cli.msg_ctx_other", &[("caller", &q(c))]),
        None => text("devswarm_cli.msg_ctx_none").to_string(),
    };
    let hint = if provided {
        tpl("devswarm_cli.act_msg_force_rejected", &[("value", &q(value.unwrap_or_default())), ("id", id)])
    } else {
        tpl("devswarm_cli.act_msg_force_hint", &[("id", id), ("warning", text("devswarm_cli.act_force_cross_warning"))])
    };
    let error = format!(
        "{}{who}{}{}{hint}",
        tpl("devswarm_cli.msg_ctx_head", &[("id", &q(id)), ("registered", &q(registered))]),
        text("devswarm_cli.msg_ctx_join"),
        text("devswarm_cli.act_msg_ctx_tail_archive")
    );
    let mut o = Obj::default();
    o.put("action", s(text("devswarm_cli.action_archive")))
        .put("descriptorArchived", OVal::Bool(false))
        .put("ok", OVal::Bool(false))
        .put("id", s(id))
        .put("reason", s(text("devswarm_cli.reason_ctx_mismatch")))
        .put("registeredRepoKey", s(registered))
        .put("callerRepoKey", caller.map_or(OVal::Null, s))
        .put("error", s(&error));
    if provided {
        o.put("forceCrossProjectRejected", s(value.unwrap_or_default()));
    }
    answer(2, o.done())
}

/// `logAuthorityOverride`: one audit line per accepted cross-project override, best effort.
fn log_override(inv: &Inv, id: &str, cwd_project: Option<&str>, target: &str) {
    let dir = match inv.env.get(text("devswarm_cli.env_log_dir")).filter(|d| !d.is_empty()) {
        Some(d) => std::path::PathBuf::from(d),
        None => inv.home.join(text("mesh_write.dir_anti_hall")).join(text("mesh_write.dir_logs")),
    };
    let mut e = Obj::default();
    e.put("ts", s(&crate::checks::agent_scan::iso_utc(inv.now as f64)))
        .put("verb", s(text("devswarm_cli.action_archive")))
        .put("id", s(id))
        .put("cwdProject", cwd_project.map_or(OVal::Null, s))
        .put("targetProject", s(target));
    crate::discard::harmless(std::fs::create_dir_all(&dir)); // keep: the audit write is best effort (Node's catch)
    let line = format!("{}\n", e.done().stringify());
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join(text("devswarm_cli.act_authority_log"))) {
        use std::io::Write;
        crate::discard::harmless(f.write_all(line.as_bytes())); // keep: as above
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::meshw::ident::fifo_kit::*;

    #[test]
    fn a_fifo_descriptor_is_not_a_regular_file_and_is_never_opened() {
        crate::defaults::init().unwrap();
        let dir = scratch("archive");
        let f = dir.join("d.json");
        fifo(&f);
        let state = within("descriptor_state", move || descriptor_state(&f).map(|s| (s.exists, s.error)).ok());
        assert_eq!(state, Some((true, Some(text("devswarm_cli.act_msg_desc_not_file").to_string()))));
        crate::discard::harmless(std::fs::remove_dir_all(dir)); // keep: cleanup of a scratch directory
    }
}
