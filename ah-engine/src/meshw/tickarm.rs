//! The parts of `cmdInboxTick` (`scripts/devswarm-lib/inbox-cmd.js`) around the count: the id-mismatch warning, the Primary
//! anchor refresh, the `watcherArmed` decision with its re-arm cue, the delivery-log health, and the interval roster.
//!
//! Every one of these is fail-open in Node (`try { ... } catch (_) {}`): a check that cannot be answered leaves the tick's own
//! result as it was, it never fails the tick. The same holds here: where a helper of another module cannot answer, the answer
//! is Node's catch value (no anchor refresh, not skipped, no alert, no roster).
// Discard triage (E3): every `.ok()` / `harmless` / `unwrap_or*` in this file is a deliberate keep, for these reasons:
// - an unreadable optional file is the same as an absent one (Node's try/catch around readFileSync)
// - the re-arm cue is a measurement only (Node: `try { ... } catch (_) {}` around the append)
// - text that does not parse is the absent value (Node's JSON.parse catch parity)
use crate::checks::guardkit::ojson::OVal;
use crate::defaults;
use crate::dssup::ingest::wal;
use crate::meshw::common::{Inv, Obj, n, s};
use crate::meshw::ident;
use crate::meshw::idlock::{devswarm_root, is_safe_id};
use crate::wakew::who::Proc;
use std::path::{Path, PathBuf};

/// `isChildWorkspaceCorroborated(env, home, cwd)` of `hooks/lib/devswarm-role.js`: the child marker in the environment AND
/// on-disk evidence (a registered descriptor of the builder id, or the cwd under the DevSwarm repos layout).
fn child_corroborated(inv: &Inv) -> bool {
    if !inv.env.get(defaults::text("mesh_write.env_source_branch")).is_some_and(|v| !crate::checks::guardkit::text::js_trim(v).is_empty()) {
        return false;
    }
    if let Some(bid) = inv.env.get(defaults::text("mesh_write.env_builder_id")).filter(|b| {
        !crate::checks::guardkit::text::js_trim(b).is_empty()
            && !b.contains("..")
            && b.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
    }) {
        let desc =
            devswarm_root(&inv.home).join(defaults::text("mesh_write.dir_workspaces")).join(format!("{bid}{}", defaults::text("mesh_write.json_suffix")));
        match std::fs::metadata(&desc) {
            Ok(m) if m.is_file() => return true,
            // a descriptor this process cannot see may exist: corroborated (fail toward gating)
            Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => return true,
            _ => {}
        }
    }
    if !std::fs::metadata(&inv.cwd).is_ok_and(|m| m.is_dir()) {
        return false;
    }
    let repos = inv.home.join(defaults::text("mesh_write.child_repos_dir"));
    let repos_real = ident::realpath(&repos.to_string_lossy()).unwrap_or_else(|| ident::resolve_abs(&repos.to_string_lossy()));
    let cwd_real = ident::realpath(&inv.cwd).unwrap_or_else(|| ident::resolve_abs(&inv.cwd));
    format!("{cwd_real}/").starts_with(&format!("{repos_real}/"))
}

/// `warnIdMismatch(id, ctx)`: a corroborated child workspace addressing an id other than its own builder id gets one stderr
/// warning and `idMismatch: true` in the result; it is never refused.
pub(crate) fn warn_id_mismatch(inv: &Inv, id: &str) -> bool {
    if !child_corroborated(inv) {
        return false;
    }
    let Some(env_id) = inv.env.get(defaults::text("mesh_write.env_builder_id")).filter(|b| is_safe_id(b)) else { return false };
    if !is_safe_id(id) || id == env_id {
        return false;
    }
    eprintln!("{}", defaults::render("mesh_write.id_mismatch_warning", &[("id", &id), ("env_id", &env_id.as_str())]));
    true
}

/// `refreshAnchorSession(ctx)`: after a /clear the running session is a new one but the Primary anchor kept the old id; on the
/// running session's own tick the anchor is registered again under the caller's session (only on the Primary checkout, only for an
/// existing anchor, only when the caller's session is positively running, and through `register-primary`, whose live-holder guard
/// refuses while the recorded session is still alive). `None` when nothing applies or anything fails (Node's catch).
pub(crate) fn refresh_anchor_session(inv: &Inv) -> Option<OVal> {
    let sid = inv.env.get(defaults::text("mesh_write.env_session_id")).filter(|v| !v.is_empty())?;
    let c = ident::resolve_context(&inv.cwd, true).ok()?;
    let wt = c.worktree_root.clone()?;
    if !ident::is_primary_checkout(&wt, c.main_worktree.as_deref(), &inv.home, &inv.env).ok()? {
        return None;
    }
    let id = ident::mesh_id_for_real_path(&wt);
    let recorded = |desc: &OVal| -> Option<String> {
        match desc.get(defaults::text("mesh_write.field_session_id")) {
            Some(OVal::Str(x)) if !x.is_empty() => Some(x.clone()),
            Some(OVal::Num(x)) if *x != 0.0 && !x.is_nan() => Some(crate::checks::jsport::num::to_js_string(*x)),
            Some(OVal::Bool(true)) => Some("true".to_string()),
            Some(OVal::Arr(_) | OVal::Obj(_)) => Some(String::from("[object]")),
            _ => None,
        }
    };
    let pre = ident::read_descriptor(&inv.home, &id)?;
    let held = recorded(&pre)?;
    if held == *sid {
        return None;
    }
    if !crate::dssup::liveness::session_alive(&inv.home, sid).ok()? {
        return None;
    }
    let mut a = crate::meshw::args::Args { positionals: vec![defaults::text("devswarm_cli.verb_register_primary").to_string()], ..Default::default() };
    a.flags.insert(defaults::text("devswarm_cli.flag_worktree").to_string(), vec![crate::meshw::args::FlagVal::S(wt.clone())]);
    if let Some(OVal::Str(cp)) = pre.get(defaults::text("mesh_write.field_cursor_path"))
        && !cp.is_empty()
    {
        a.flags.insert(defaults::text("devswarm_cli.flag_reg_cursor").to_string(), vec![crate::meshw::args::FlagVal::S(cp.clone())]);
    }
    let mut at = inv.clone();
    at.cwd = wt;
    let r = crate::meshw::lifeverbs::register_primary(&at, &a);
    let mut o = Obj::default();
    match r {
        Ok(ans) => {
            let body = OVal::parse(ans.stdout.trim()).unwrap_or(OVal::Null);
            if matches!(body.get("ok"), Some(OVal::Bool(true))) {
                o.put("refreshed", OVal::Bool(true)).put("id", s(&id)).put("from", s(&held)).put("to", s(sid));
            } else {
                let why = ["reason", "error"].iter().find_map(|k| match body.get(k) {
                    Some(OVal::Str(t)) if !t.is_empty() => Some(t.clone()),
                    _ => None,
                });
                o.put("refreshed", OVal::Bool(false)).put("reason", s(&why.unwrap_or_else(|| defaults::text("mesh_write.anchor_reason_unknown").to_string())));
            }
        }
        // the registration could not be answered here: Node's catch (`return null`)
        Err(_) => return None,
    }
    Some(o.done())
}

/// What `watcherArmed` reads in the tick's result.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Armed {
    /// A live wake-watch lock covers the workspace.
    Yes,
    /// None does: the re-arm cue.
    No,
    /// A deliberate no-arm decision, rendered as its word (`archived-skip`, `idle-skip`, `limit-skip`).
    Skip(&'static str),
}

impl Armed {
    /// The JSON value of `watcherArmed`.
    pub(crate) fn json(self) -> OVal {
        match self {
            Armed::Yes => OVal::Bool(true),
            Armed::No => OVal::Bool(false),
            Armed::Skip(w) => s(w),
        }
    }
}

fn proc_of(inv: &Inv, cwd: &str) -> Proc {
    let env: std::collections::BTreeMap<String, String> = inv.env.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    Proc { home: inv.home.clone(), cwd: cwd.to_string(), env: inv.env.clone(), st: inv.settings(), root: crate::ops::plugin_root(&env).unwrap_or_default() }
}

/// The skip decisions after a lock check that read "not armed" (`cmdInboxTick`): a `--child` whose own workspace is archived; a
/// Primary with no live child (`devswarm.wakeWatchIdleSkip`); either caller while limit conservation is active. Each is a
/// deliberate no-arm decision with its own re-arm-cue bucket, never the lapse `false`.
pub(crate) fn decide(inv: &Inv, id: &str, child: bool, lock_armed: bool) -> Armed {
    if lock_armed {
        return Armed::Yes;
    }
    if !is_safe_id(id) {
        return Armed::No;
    }
    if child && crate::wakew::arch::own_child_archived(&proc_of(inv, &inv.cwd), id) {
        return Armed::Skip(defaults::text("mesh_write.armed_archived_skip"));
    }
    if !child
        && let Some(OVal::Obj(_)) = ident::read_descriptor(&inv.home, id)
        && let Some(OVal::Str(scope)) = ident::read_descriptor(&inv.home, id).as_ref().and_then(|d| d.get(defaults::text("mesh_write.field_worktree_path")).cloned())
        && !scope.is_empty()
        // an answer that depends on a source the wake watcher does not read leaves the tick re-arming, as Node does on any doubt
        && matches!(crate::wakew::arch::idle_skip(&proc_of(inv, &scope)), Ok(crate::wakew::arch::IdleSkip::Applies))
    {
        return Armed::Skip(defaults::text("mesh_write.armed_idle_skip"));
    }
    let env: std::collections::BTreeMap<String, String> = inv.env.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    if crate::ops::codex::conserving_active(&inv.home.to_string_lossy(), &env) {
        return Armed::Skip(defaults::text("mesh_write.armed_limit_skip"));
    }
    Armed::No
}

/// `recordRearmCue(home, id, trigger)`: one line per decision, capped, fail-open.
pub(crate) fn record_rearm_cue(inv: &Inv, id: &str, armed: Armed) {
    let trigger = match armed {
        Armed::Yes => return,
        Armed::No => defaults::text("mesh_write.rearm_trigger_tick"),
        Armed::Skip(w) if w == defaults::text("mesh_write.armed_archived_skip") => defaults::text("mesh_write.rearm_trigger_archived"),
        Armed::Skip(w) if w == defaults::text("mesh_write.armed_idle_skip") => defaults::text("mesh_write.rearm_trigger_idle"),
        Armed::Skip(_) => defaults::text("mesh_write.rearm_trigger_limit"),
    };
    let file = devswarm_root(&inv.home).join(defaults::text("mesh_write.file_rearm_cues"));
    let mut lines: Vec<String> =
        std::fs::read(&file).map(|b| String::from_utf8_lossy(&b).split('\n').filter(|l| !l.is_empty()).map(str::to_string).collect()).unwrap_or_default();
    let mut rec = Obj::default();
    rec.put("ts", n(inv.now as f64)).put("id", s(id)).put("trigger", s(trigger));
    lines.push(rec.done().stringify());
    let cap = defaults::num("mesh_write.rearm_cues_cap") as usize;
    if lines.len() > cap {
        lines.drain(..lines.len() - cap);
    }
    let go = || -> std::io::Result<()> {
        if let Some(d) = file.parent() {
            std::fs::create_dir_all(d)?;
        }
        std::fs::write(&file, lines.join("\n") + "\n")
    };
    crate::discard::harmless(go()); // keep: a measurement only, never breaks the tick (Node's catch)
}

// ---- the delivery-log health -----------------------------------------------------------------------------------------------

/// The code Node's `e.code` names for an I/O error.
fn errno_code(e: &std::io::Error) -> String {
    match e.raw_os_error() {
        Some(libc::EACCES) => "EACCES".to_string(),
        Some(libc::EISDIR) => "EISDIR".to_string(),
        Some(libc::ENOTDIR) => "ENOTDIR".to_string(),
        Some(libc::EIO) => "EIO".to_string(),
        Some(libc::ELOOP) => "ELOOP".to_string(),
        Some(libc::EPERM) => "EPERM".to_string(),
        _ => defaults::text("mesh_write.wal_unknown_code").to_string(),
    }
}

/// One health row that alerts: `{file, pending, oldestTs, pendingBytes, spilled, alert: true, reason}`.
fn alert_row(file: &Path, pending: Option<usize>, oldest: Option<i64>, bytes: Option<usize>, spilled: usize, reason: &str) -> OVal {
    let mut o = Obj::default();
    o.put("file", s(&file.to_string_lossy()))
        .put("pending", pending.map_or(OVal::Null, |p| n(p as f64)))
        .put("oldestTs", oldest.map_or(OVal::Null, |t| n(t as f64)))
        .put("pendingBytes", bytes.map_or(OVal::Null, |b| n(b as f64)))
        .put("spilled", n(spilled as f64))
        .put("alert", OVal::Bool(true))
        .put("reason", s(reason));
    o.done()
}

/// `devswarm-read-wal.js` `health(fs, home, now)` filtered to the rows that alert (`h.alert`): the tick carries them as `walAlerts`.
pub(crate) fn wal_alerts(inv: &Inv) -> Vec<OVal> {
    let root = devswarm_root(&inv.home);
    let dir = root.join(defaults::text("mesh_write.dir_wal"));
    let suffix = defaults::text("mesh_write.wal_suffix");
    let mut names: Vec<String> =
        std::fs::read_dir(&dir).map(|rd| rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default();
    names.sort();
    let mut out: Vec<(PathBuf, Option<OVal>)> = Vec::new();
    for name in names.iter().filter(|n| n.ends_with(suffix)) {
        let file = dir.join(name);
        let open = match wal::pending(&file) {
            Ok(o) => o,
            Err(e) => {
                let reason = defaults::render("mesh_write.wal_reason_unreadable", &[("code", &errno_code(&e))]);
                out.push((file.clone(), Some(alert_row(&file, None, None, None, wal::spilled(&file), &reason))));
                continue;
            }
        };
        let spilled = wal::spilled(&file);
        if open.is_empty() && spilled == 0 {
            continue;
        }
        let oldest = open.iter().filter_map(|b| b.ts).min();
        let bytes: usize = open.iter().map(|b| b.raw.encode_utf16().count()).sum();
        let mut reasons: Vec<String> = Vec::new();
        if spilled > 0 {
            reasons.push(defaults::render("mesh_write.wal_reason_spilled", &[("n", &spilled)]));
        }
        if let Some(t) = oldest
            && inv.now - t > defaults::num("mesh_write.wal_alert_ms") as i64
        {
            reasons.push(defaults::render("mesh_write.wal_reason_old", &[("minutes", &((inv.now - t) as f64 / 60000.0).round())]));
        }
        if bytes as u64 > defaults::num("mesh_write.wal_alert_bytes") {
            reasons.push(defaults::render("mesh_write.wal_reason_bytes", &[("bytes", &bytes)]));
        }
        let row = (!reasons.is_empty()).then(|| alert_row(&file, Some(open.len()), oldest, Some(bytes), spilled, &reasons.join("; ")));
        out.push((file, row));
    }
    // last-resort files (the log AND its spill failed mid-operation) that name a log of this home
    let tmp = defaults::list("mesh_write.env_tmpdir")
        .iter()
        .find_map(|k| inv.env.get(*k).filter(|v| !v.is_empty()))
        .map_or_else(|| PathBuf::from(defaults::text("mesh_write.default_tmpdir")), PathBuf::from);
    let prefix = defaults::text("mesh_write.wal_lastresort_prefix");
    let json = defaults::text("mesh_write.json_suffix");
    let mut tmp_names: Vec<String> = std::fs::read_dir(&tmp)
        .map(|rd| rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n.starts_with(prefix) && n.ends_with(json)).collect())
        .unwrap_or_default();
    tmp_names.sort();
    let dir_abs = PathBuf::from(ident::resolve_abs(&dir.to_string_lossy()));
    for name in &tmp_names {
        let Some(rec) = std::fs::read(tmp.join(name)).ok().and_then(|b| OVal::parse(&String::from_utf8_lossy(&b))) else { continue };
        let Some(OVal::Str(w)) = rec.get("wal") else { continue };
        let wal_file = PathBuf::from(w);
        if wal_file.parent() != Some(dir_abs.as_path()) || out.iter().any(|(f, _)| ident::resolve_abs(&f.to_string_lossy()) == *w) {
            continue;
        }
        let reason = defaults::render("mesh_write.wal_reason_last_resort", &[("dir", &tmp.display())]);
        out.push((wal_file.clone(), Some(alert_row(&wal_file, Some(0), None, Some(0), wal::spilled(&wal_file), &reason))));
    }
    // spill directories whose log does not exist at all (the log directory is not writable)
    let spill_root = root.join(defaults::text("mesh_write.dir_wal_spill"));
    let mut spill_names: Vec<String> =
        std::fs::read_dir(&spill_root).map(|rd| rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default();
    spill_names.sort();
    for name in spill_names {
        let file = dir.join(format!("{name}{suffix}"));
        if out.iter().any(|(f, _)| *f == file) {
            continue;
        }
        let spilled = wal::spilled(&file);
        if spilled > 0 {
            let reason = defaults::render("mesh_write.wal_reason_spilled", &[("n", &spilled)]);
            out.push((file.clone(), Some(alert_row(&file, Some(0), None, Some(0), spilled, &reason))));
        }
    }
    out.into_iter().filter_map(|(_, row)| row).collect()
}

// ---- the interval roster ---------------------------------------------------------------------------------------------------

/// `devswarm.tickRosterEvery`: the Nth-tick interval (an integer above zero), else 0.
pub(crate) fn roster_every(inv: &Inv) -> i64 {
    let v = crate::checks::guardkit::settings::get_number(&inv.settings(), defaults::raw("mesh_write.set_tick_roster"));
    if v.is_finite() && v.fract() == 0.0 && v > 0.0 { v as i64 } else { 0 }
}

/// The roster block a quiet Primary tick appends on its Nth tick: only on positive proof of a live child (the id's own worktree
/// has one and the roster shows a live row other than this workspace). `None` on any failure (Node's catch: the tick line alone).
pub(crate) fn roster_text(inv: &Inv, id: &str) -> Option<String> {
    let desc = ident::read_descriptor(&inv.home, id)?;
    let Some(OVal::Str(scope)) = desc.get(defaults::text("mesh_write.field_worktree_path")) else { return None };
    if scope.is_empty() || !matches!(crate::wakew::arch::idle_skip(&proc_of(inv, scope)), Ok(crate::wakew::arch::IdleSkip::NotApplicable)) {
        return None;
    }
    let repo_key = ident::repo_key_for_worktree(&inv.cwd).ok()??;
    let st = crate::meshw::common::open_store(inv, &repo_key).ok()?;
    let sum = crate::meshw::summary::compute(&st, inv, None).ok()?;
    let main = ident::resolve_context(&inv.cwd, false).ok()?.main_worktree;
    let built = crate::meshw::rosterrows::build(inv, &repo_key, &st, &sum, main.as_deref()).ok()?;
    let others = built
        .rows
        .iter()
        .filter(|r| !crate::meshw::rosterrows::is_archived_row(r) && r.0.iter().any(|(k, v)| k == "id" && !matches!(v, OVal::Str(x) if x == id)))
        .count();
    if others == 0 {
        return None;
    }
    crate::meshw::rosterrows::human_text(inv, &built.rows, false, inv.now as f64).ok()
}
