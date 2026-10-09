//! The liveness sweep, native: `computeLiveness` + `writeVerdict` of `companion/lib/liveness.js` for every workspace
//! descriptor, as `sweepOnce` of `companion/devswarm-supervisor.js` calls them.
//!
//! What the engine decides and writes itself: the verdict file (`liveness/<id>.json`, Node's key order and number text), the
//! `cleared` line of the recovery log when a sticky `escalated` workspace turns out to have a live session, and whether a
//! parked escalation notice needs delivering.
//!
//! What stays Node's, per workspace, because it either writes through machinery the engine does not reproduce or cannot be
//! proven identical:
//! * a verdict that is `stale` (suppressors, poke or escalate, the forced parent notice for an urgent mesh unread): the engine
//!   never produces a `stale` verdict, so it can never nominate a workspace for a poke Node would not; Node recomputes it;
//! * a workspace Jev has a pending blocker or question for, or one with a step plan (straying signals, the Jev label);
//! * anything the engine defers on (a store it will not read exactly like Node, a descriptor field of an unexpected type,
//!   a partition whose `reader_cursors` floor rows are missing).
//!
//! Those are handed to Node's own `sweepOnce` restricted to them, with the engine's verdict supplied for the first group so
//! Node does not compute or write it twice.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this module is a deliberate keep, for these reasons:
// - an unreadable or unparsable optional file is the absent one (Node's `try { JSON.parse(...) } catch (_) {}`)
// - a verdict that cannot be written is lost, never the sweep (Node: the caller fails open per workspace)
use super::tick::Ctx;
use crate::checks::guardkit::ojson::OVal;
use crate::checks::guardkit::text::js_number_of_str;
use crate::defaults;
use crate::dsact::runner::{RunSpec, Runner};
use crate::mesh::MeshReader;
use crate::meshw::common::Inv;
use crate::meshw::ident::{self, Defer, R, defer};
use crate::meshw::idlock::{devswarm_root, is_safe_id};
use crate::meshw::union;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

/// The thresholds one sweep runs with (Node's `resolveThresholdsFromEnv`, the two that `computeLiveness` takes).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Thresholds {
    /// `idleThresholdMs`.
    pub idle_ms: f64,
    /// `nudgeWindowMs`.
    pub nudge_window_ms: f64,
    /// `heartbeatFreshMs`.
    pub fresh_ms: f64,
    /// `neverLaunchedDeadlineMs`.
    pub never_launched_ms: f64,
}

impl Thresholds {
    /// Read them (environment, `settings.json`, shipped defaults).
    pub fn read(ctx: &Ctx) -> Thresholds {
        let sec = |key: &str| super::setting(ctx.st, key).as_f64().unwrap_or(0.0);
        let unit = defaults::num("devswarm_sup.lv_ms_per_sec") as f64;
        Thresholds {
            idle_ms: sec("devswarm_sup.set_idle_sec") * unit,
            nudge_window_ms: sec("devswarm_sup.set_nudge_window_sec") * unit,
            fresh_ms: defaults::num("devswarm_sup.lv_heartbeat_fresh_ms") as f64,
            never_launched_ms: defaults::num("devswarm_sup.lv_never_launched_ms") as f64,
        }
    }
}

/// One descriptor that `readDescriptors` accepts: an object with a truthy `worktreePath` and `sessionId` and a safe `id`.
#[derive(Debug, Clone)]
pub struct Desc {
    /// The `id` field (the key of every file the sweep reads and writes).
    pub id: String,
    /// The parsed descriptor.
    pub raw: OVal,
}

/// `readDescriptors(home)`: the accepted descriptors in directory order (sorted by name, as libuv lists a directory).
pub fn read_descriptors(home: &Path) -> Vec<Desc> {
    let dir = devswarm_root(home).join(defaults::text("mesh_write.dir_workspaces"));
    let suffix = defaults::text("mesh_write.json_suffix");
    let mut names: Vec<String> =
        std::fs::read_dir(&dir).into_iter().flatten().flatten().filter_map(|e| e.file_name().into_string().ok()).filter(|n| n.ends_with(suffix)).collect();
    names.sort();
    let mut out = Vec::new();
    for n in names {
        let Ok(bytes) = std::fs::read(dir.join(&n)) else { continue };
        let Some(raw) = OVal::parse(&String::from_utf8_lossy(&bytes)) else { continue };
        let truthy = |k: &str| raw.get(defaults::text(k)).is_some_and(OVal::truthy);
        if !(matches!(raw, OVal::Obj(_)) && truthy("mesh_write.field_worktree_path") && truthy("mesh_write.field_session_id")) {
            continue;
        }
        if let Some(OVal::Str(id)) = raw.get(defaults::text("mesh_write.field_id"))
            && is_safe_id(id)
        {
            out.push(Desc { id: id.clone(), raw });
        }
    }
    out
}

fn text_field(d: &Desc, key: &str) -> R<String> {
    match d.raw.get(defaults::text(key)) {
        Some(OVal::Str(s)) => Ok(s.clone()),
        _ => defer("descriptor-field-type"),
    }
}

fn finite(v: Option<&OVal>) -> Option<f64> {
    match v {
        Some(OVal::Num(x)) if x.is_finite() => Some(*x),
        _ => None,
    }
}

pub(crate) fn mtime_ms(md: &std::fs::Metadata) -> f64 {
    md.mtime() as f64 * 1000.0 + md.mtime_nsec() as f64 / 1e6
}

fn path_of(home: &Path, dir_key: &str, id: &str) -> PathBuf {
    devswarm_root(home).join(defaults::text(dir_key)).join(format!("{id}{}", defaults::text("mesh_write.json_suffix")))
}

/// `heartbeatTs(id)`: the record's finite `ts`, else the file's modification time, else `None`.
pub(crate) fn heartbeat_ts(home: &Path, id: &str) -> Option<f64> {
    let p = path_of(home, "mesh_write.dir_heartbeats", id);
    if let Some(j) = std::fs::read(&p).ok().and_then(|b| OVal::parse(&String::from_utf8_lossy(&b)))
        && let Some(t) = finite(j.get(defaults::text("devswarm_sup.lv_field_ts")))
    {
        return Some(t);
    }
    std::fs::metadata(&p).ok().map(|m| mtime_ms(&m))
}

/// `isFreshBeat(ts, now, freshMs)`.
pub(crate) fn is_fresh(ts: Option<f64>, now: f64, fresh_ms: f64) -> bool {
    ts.is_some_and(|t| t.is_finite() && t > 0.0 && t <= now && now - t <= fresh_ms)
}

/// `encodeWorktreePath(worktreePath)`: every `/`, `\`, `:` and `.` becomes `-`.
fn encode_worktree(wt: &str) -> String {
    let from = defaults::text("devswarm_sup.lv_encode_chars");
    let to = defaults::text("devswarm_sup.lv_encode_to");
    wt.chars().map(|c| if from.contains(c) { to.to_string() } else { c.to_string() }).collect()
}

/// `transcriptMtime(projectDirFor(wt), sessionId)`.
pub(crate) fn transcript_mtime(home: &Path, wt: &str, session: &str) -> R<Option<f64>> {
    if session.is_empty() {
        return Ok(None);
    }
    if session.contains('/') || session.contains('\\') || session.contains("..") {
        return defer("session-path");
    }
    let dir = home.join(defaults::text("mesh_write.claude_dir")).join(defaults::text("devswarm_sup.lv_projects_dir")).join(encode_worktree(wt));
    Ok(std::fs::metadata(dir.join(format!("{session}{}", defaults::text("devswarm_sup.lv_transcript_ext")))).ok().map(|m| mtime_ms(&m)))
}

/// `descriptorRegistrationTs(id)`: the modification time of `workspaces/<id>.json`.
pub(crate) fn registration_ts(home: &Path, id: &str) -> Option<f64> {
    std::fs::metadata(path_of(home, "mesh_write.dir_workspaces", id)).ok().map(|m| mtime_ms(&m)).filter(|t| t.is_finite())
}

/// `worktreeActivityMtime(wt)`: the last commit time in ms (`git -C wt log -1 --format=%ct`), `None` when git cannot say.
fn worktree_activity(runner: &dyn Runner, wt: &str) -> Option<f64> {
    let wt_owned = wt.to_string();
    let args: Vec<String> = defaults::list("devswarm_sup.lv_git_args").iter().map(|a| a.replace("{worktree}", &wt_owned)).collect();
    let r = runner.run(&RunSpec {
        bin: Some(defaults::text("devswarm_sup.lv_git_bin").to_string()),
        args,
        timeout_ms: defaults::num("devswarm_sup.lv_git_timeout_ms"),
        ..RunSpec::default()
    });
    if !r.ok || r.timed_out || r.status != Some(0) {
        return None;
    }
    // parseInt(String(stdout).trim(), 10): the leading integer, else NaN
    let t = r.stdout.trim_start_matches(|c: char| c.is_whitespace()).trim_end();
    let digits: String = t.chars().enumerate().take_while(|(i, c)| c.is_ascii_digit() || (*i == 0 && (*c == '-' || *c == '+'))).map(|(_, c)| c).collect();
    let secs: f64 = digits.parse().ok()?;
    let ct = secs * defaults::num("devswarm_sup.lv_ms_per_sec") as f64;
    (ct.is_finite() && ct > 0.0).then_some(ct)
}

/// `Number(rec.pid)` for the JSON value of a session record.
fn js_pid(v: Option<&OVal>) -> R<f64> {
    match v {
        None => Ok(f64::NAN),
        Some(OVal::Null) => Ok(0.0),
        Some(OVal::Num(n)) => Ok(*n),
        Some(OVal::Bool(b)) => Ok(f64::from(u8::from(*b))),
        Some(OVal::Str(s)) => Ok(js_number_of_str(s)),
        Some(_) => defer("session-pid-type"),
    }
}

/// `pidIsAlive(pid, kill, { sinceMs })`: `Some(true)` alive, `Some(false)` gone or reused, `None` unknown.
fn pid_is_alive(pid: f64, since_ms: Option<f64>) -> Option<bool> {
    if !pid.is_finite() || pid.fract() != 0.0 || pid <= 0.0 || pid > f64::from(i32::MAX) {
        return None;
    }
    // SAFETY: signal 0 only probes for the process.
    let rc = unsafe { libc::kill(pid as i32, 0) };
    if rc == 0 {
        if let Some(since) = since_ms
            && let Some(start) = ident::process_start_ms(pid as i64)
            && start > since
        {
            return Some(false); // a newer process under a recycled pid
        }
        return Some(true);
    }
    match std::io::Error::last_os_error().raw_os_error() {
        Some(libc::ESRCH) => Some(false),
        Some(libc::EPERM) => Some(true),
        _ => None,
    }
}

/// `isSessionAliveRow({ sessionId })`: a `~/.claude/sessions/*.json` record of this session names a live process.
pub(crate) fn session_alive(home: &Path, session: &str) -> R<bool> {
    if session.is_empty() {
        return Ok(false);
    }
    let dir = home.join(defaults::text("mesh_write.claude_dir")).join(defaults::text("mesh_write.sessions_dir"));
    let Ok(rd) = std::fs::read_dir(&dir) else { return Ok(false) };
    let mut names: Vec<String> =
        rd.flatten().filter_map(|e| e.file_name().into_string().ok()).filter(|n| n.ends_with(defaults::text("mesh_write.json_suffix"))).collect();
    names.sort();
    let mut verdict: Option<bool> = None;
    for n in names {
        let file = dir.join(&n);
        let Some(rec) = std::fs::read(&file).ok().and_then(|b| OVal::parse(&String::from_utf8_lossy(&b))) else { continue };
        if !matches!(rec, OVal::Obj(_)) {
            continue;
        }
        let sid = match rec.get(defaults::text("mesh_write.field_session_id")) {
            None | Some(OVal::Null) => continue,
            Some(OVal::Str(s)) => s.clone(),
            Some(OVal::Num(x)) => crate::checks::jsport::num::to_js_string(*x),
            Some(OVal::Bool(b)) => b.to_string(),
            Some(_) => return defer("session-record-type"),
        };
        if sid != session {
            continue;
        }
        let since = std::fs::metadata(&file).ok().map(|m| mtime_ms(&m)).filter(|t| t.is_finite());
        match pid_is_alive(js_pid(rec.get(defaults::text("devswarm_sup.lv_field_pid")))?, since) {
            Some(true) => return Ok(true),
            Some(false) => verdict = Some(false),
            None => {}
        }
    }
    Ok(verdict == Some(true))
}

/// The mailbox facts `unionPendingFor` reports.
#[derive(Debug, Clone, PartialEq)]
pub struct Pending {
    /// Anything unread (or UNKNOWN).
    pub pending: bool,
    /// Anything unread that did not come from the workspace's own Primary.
    pub inbound: bool,
    /// The oldest unread row is older than the not-draining limit.
    pub not_draining: bool,
    /// Age in ms of the oldest unread row.
    pub oldest: Option<f64>,
}

/// `unionPendingFor(descriptor, home, { now, selfId })`.
fn pending_for(inv: &Inv, d: &Desc, self_id: Option<&str>) -> R<Pending> {
    let inbox = union::path_field(&d.raw, defaults::text("mesh_write.field_inbox_path"))?;
    let cursor = union::path_field(&d.raw, defaults::text("mesh_write.field_cursor_path"))?;
    let Some(reader) = crate::meshw::heartbeat::open_reader(inv, &d.raw)? else {
        // no store handle: the NDJSON-only backlog (`unreadBacklog`), never a reader base
        let lines = crate::meshw::heartbeat::known_backlog(inbox.as_deref(), cursor.as_deref())?;
        let p = lines > 0;
        return Ok(Pending { pending: p, inbound: p, not_draining: false, oldest: None });
    };
    let reader: MeshReader = reader;
    let (store_base, nd_base) = union::floor_bases(&reader, &inv.home, &d.id, cursor.as_deref())?;
    let u = union::union_unread(&union::UnionIn {
        inbox: inbox.as_deref(),
        cursor_file: cursor.as_deref(),
        id: &d.id,
        store: Some(&reader),
        store_base,
        nd_base,
        now: inv.now,
    })?;
    let pending = u.unread > 0;
    let not_draining = pending && u.oldest_unread_age_ms.is_some_and(|a| a > defaults::num("mesh_write.not_draining_age_ms") as f64);
    let mut inbound = u.nd_unread_lines.len();
    for row in &u.store_only_unread {
        let own = self_id.is_some_and(|s| row["sender"].as_str() == Some(s));
        if !own {
            inbound += 1;
        }
    }
    Ok(Pending { pending, inbound: inbound > 0, not_draining, oldest: u.oldest_unread_age_ms })
}

/// `resolveSelfId(worktreePath)`: the Primary partition id of the descriptor's project, when it is a safe id.
fn self_id(wt: &str) -> R<Option<String>> {
    let c = ident::resolve_context(wt, false)?;
    let parent = c.main_worktree.unwrap_or_else(|| wt.to_string());
    let id = ident::primary_workspace_id(&parent)?;
    Ok(is_safe_id(&id).then_some(id))
}

/// A verdict as Node writes it: the eight fields in Node's order; `None` is a field JavaScript leaves `undefined`, which
/// `JSON.stringify` omits.
fn verdict_obj(values: [Option<OVal>; 8]) -> OVal {
    let keys = defaults::list("devswarm_sup.lv_keys");
    OVal::Obj(keys.iter().zip(values).filter_map(|(k, v)| v.map(|v| ((*k).to_string(), v))).collect())
}

fn num_or_null(x: Option<f64>) -> OVal {
    x.map_or(OVal::Null, OVal::Num)
}

/// What the engine decided for one workspace.
#[derive(Debug, Clone)]
pub struct Computed {
    /// The verdict, as `JSON.stringify` writes it.
    pub verdict: OVal,
    /// Its `status`.
    pub status: String,
    /// The recovery-log line `computeLiveness` appends before returning (a sticky escalation cleared by a live session).
    pub cleared: bool,
}

/// The inputs `compute` needs besides the descriptor.
pub struct Env<'a> {
    /// The invocation context (home, environment, clock).
    pub inv: &'a Inv,
    /// The thresholds.
    pub t: Thresholds,
    /// Runs git.
    pub runner: &'a dyn Runner,
}

/// `computeLiveness({ descriptor, now, ... })`. Pure: reads files, runs one git, writes nothing (the caller commits).
pub fn compute(e: &Env, d: &Desc) -> R<Computed> {
    let home = e.inv.home.as_path();
    let now = e.inv.now as f64;
    let wt = text_field(d, "mesh_write.field_worktree_path")?;
    let session = text_field(d, "mesh_write.field_session_id")?;
    let prev = std::fs::read(path_of(home, "devswarm_sup.liveness_dir", &d.id)).ok().and_then(|b| OVal::parse(&String::from_utf8_lossy(&b)));
    let pf = |k: &str| prev.as_ref().and_then(|p| p.get(k));
    let k = |i: usize| defaults::list("devswarm_sup.lv_keys")[i];
    let nudge_attempts = finite(pf(k(3))).unwrap_or(0.0);
    let nudged_at = finite(pf(k(4)));
    let prior_stale = finite(pf(k(2)));
    let prior_outbound = finite(pf(k(1)));
    let done =
        |status: &str, v: [Option<OVal>; 8], cleared: bool| -> R<Computed> { Ok(Computed { verdict: verdict_obj(v), status: status.to_string(), cleared }) };
    let st = |s: &str| Some(OVal::Str(s.to_string()));

    // a fresh heartbeat is proof of life
    let beat = heartbeat_ts(home, &d.id);
    if is_fresh(beat, now, e.t.fresh_ms) {
        let beat = beat.unwrap_or(0.0);
        let hb = pending_for(e.inv, d, None)?;
        let outbound = beat.max(prior_outbound.unwrap_or(0.0));
        return done(
            defaults::text("devswarm_sup.lv_status_alive"),
            [
                st(defaults::text("devswarm_sup.lv_status_alive")),
                Some(OVal::Num(if outbound != 0.0 { outbound } else { beat })),
                Some(OVal::Null),
                Some(OVal::Num(0.0)),
                Some(OVal::Null),
                Some(OVal::Bool(hb.pending)),
                Some(OVal::Bool(hb.not_draining)),
                Some(num_or_null(hb.oldest)),
            ],
            false,
        );
    }

    let prev_status = match pf(k(0)) {
        Some(OVal::Str(s)) => Some(s.as_str()),
        _ => None,
    };
    let mut cleared = false;
    if prev_status == Some(defaults::text("devswarm_sup.status_escalated")) {
        if session_alive(home, &session)? {
            cleared = true;
        } else {
            // sticky: the previous verdict again, with its own mailbox fields
            let carried = |i: usize| pf(k(i)).cloned();
            let oldest = match pf(k(7)) {
                None | Some(OVal::Null) => OVal::Null,
                Some(v) => v.clone(),
            };
            return done(
                defaults::text("devswarm_sup.status_escalated"),
                [
                    st(defaults::text("devswarm_sup.status_escalated")),
                    Some(num_or_null(prior_outbound)),
                    Some(num_or_null(prior_stale)),
                    Some(OVal::Num(nudge_attempts)),
                    Some(num_or_null(nudged_at)),
                    carried(5),
                    carried(6),
                    Some(oldest),
                ],
                false,
            );
        }
    }

    let t_mtime = transcript_mtime(home, &wt, &session)?;
    let w_mtime = worktree_activity(e.runner, &wt);
    let last_outbound = {
        let m = t_mtime.unwrap_or(0.0).max(w_mtime.unwrap_or(0.0));
        (m != 0.0).then_some(m)
    };
    let me = self_id(&wt)?;
    let u = pending_for(e.inv, d, me.as_deref())?;
    let alive = |outbound: Option<f64>, stale_since: Option<f64>, attempts: f64, nudged: Option<f64>, status: &str, u: &Pending| -> R<Computed> {
        done(
            status,
            [
                st(status),
                Some(num_or_null(outbound)),
                Some(num_or_null(stale_since)),
                Some(OVal::Num(attempts)),
                Some(num_or_null(nudged)),
                Some(OVal::Bool(u.pending)),
                Some(OVal::Bool(u.not_draining)),
                Some(num_or_null(u.oldest)),
            ],
            cleared,
        )
    };

    if prev_status == Some(defaults::text("devswarm_sup.status_nudged")) {
        let advanced = matches!((nudged_at, last_outbound), (Some(n), Some(l)) if l > n);
        if advanced {
            return alive(last_outbound, None, 0.0, None, defaults::text("devswarm_sup.lv_status_alive"), &u);
        }
        if nudged_at.is_some_and(|n| now - n < e.t.nudge_window_ms) {
            return alive(prior_outbound, prior_stale, nudge_attempts, nudged_at, defaults::text("devswarm_sup.status_nudged"), &u);
        }
    }

    let both_idle = matches!((t_mtime, w_mtime), (Some(t), Some(w)) if now - t > e.t.idle_ms && now - w > e.t.idle_ms);
    let reg = if t_mtime.is_none() { registration_ts(home, &d.id) } else { None };
    let never_launched_dead = reg.is_some_and(|r| r > 0.0 && r <= now && now - r > e.t.never_launched_ms);
    if (both_idle || never_launched_dead) && u.inbound {
        // Node decides a stale workspace: suppressors, poke, escalate, the forced parent notice
        return defer("stale");
    }
    alive(last_outbound, None, 0.0, None, defaults::text("devswarm_sup.lv_status_alive"), &u)
}

/// Write a verdict the way `writeVerdict` does (a temporary file, then a rename). `false` when it could not be written.
pub fn write_verdict(home: &Path, id: &str, c: &Computed) -> bool {
    let p = path_of(home, "devswarm_sup.liveness_dir", id);
    if let Some(dir) = p.parent() {
        crate::discard::harmless(std::fs::create_dir_all(dir)); // keep: the write below reports the failure
    }
    crate::atomic::write(&p, c.verdict.stringify()).is_ok()
}

/// Whether Node's per-workspace tail work could do anything for a workspace the engine computed: Jev holds a pending blocker
/// or question for it (the blocker label), or it has a step plan (straying signals).
pub fn needs_tail(inv: &Inv, id: &str) -> bool {
    let pending = inv
        .home
        .join(defaults::text("mesh_write.dir_anti_hall"))
        .join(defaults::text("mesh_write.dir_state"))
        .join(defaults::text("mesh_write.jev_pending_file"));
    if let Some(OVal::Obj(o)) = std::fs::read(&pending).ok().and_then(|b| OVal::parse(&String::from_utf8_lossy(&b))) {
        let suffix = format!("{}{id}", defaults::text("devswarm_sup.lv_jev_key_sep"));
        if o.iter().any(|(k, _)| k.ends_with(&suffix)) {
            return true;
        }
    }
    !matches!(crate::meshw::plan::find(inv, id), Ok(None))
}

/// Whether any undelivered escalation notice is parked (`drainEscalationIntents` would attempt one).
pub fn parked_notices(home: &Path) -> bool {
    let dir = devswarm_root(home).join(defaults::text("devswarm_sup.lv_escalation_dir"));
    let Ok(rd) = std::fs::read_dir(&dir) else { return false };
    rd.flatten().filter_map(|e| e.file_name().into_string().ok()).filter(|n| n.ends_with(defaults::text("mesh_write.json_suffix"))).any(|n| {
        let Some(it) = std::fs::read(dir.join(&n)).ok().and_then(|b| OVal::parse(&String::from_utf8_lossy(&b))) else { return false };
        it.get(defaults::text("devswarm_sup.lv_field_parent")).is_some_and(OVal::truthy)
            && it.get(defaults::text("devswarm_sup.lv_field_row")).is_some_and(OVal::truthy)
            && !it.get(defaults::text("devswarm_sup.lv_field_delivered")).is_some_and(OVal::truthy)
    })
}

/// What one sweep did.
#[derive(Debug, Clone, Default)]
pub struct Outcome {
    /// Workspaces whose verdict the engine computed and wrote.
    pub native: Vec<String>,
    /// Of those, the ones Node still has tail work for.
    pub tail: Vec<String>,
    /// Workspaces Node computes in full, with the reason.
    pub full: Vec<(String, String)>,
    /// A parked escalation notice needs delivering.
    pub drain: bool,
    /// The verdicts the engine wrote (id, bytes), for the witness.
    pub written: Vec<(String, String)>,
    /// The previous verdict text of each native workspace (what Node's own compute would have read), for the witness.
    pub prev: Vec<(String, Option<String>)>,
}

/// The native part of one sweep. `dry` computes and reports without writing anything.
pub fn sweep(inv: &Inv, t: Thresholds, runner: &dyn Runner, dry: bool) -> Outcome {
    let e = Env { inv, t, runner };
    let mut out = Outcome::default();
    for d in read_descriptors(&inv.home) {
        let prev_text = std::fs::read_to_string(path_of(&inv.home, "devswarm_sup.liveness_dir", &d.id)).ok();
        match compute(&e, &d) {
            Ok(c) => {
                if !dry {
                    if c.cleared {
                        super::verdict::append_log(
                            &inv.home,
                            inv.now,
                            &[
                                ("id", d.id.as_str().into()),
                                ("action", defaults::text("devswarm_sup.lv_log_cleared_action").into()),
                                ("reason", defaults::text("devswarm_sup.lv_log_cleared_reason").into()),
                            ],
                        );
                    }
                    write_verdict(&inv.home, &d.id, &c);
                }
                out.prev.push((d.id.clone(), prev_text));
                out.written.push((d.id.clone(), c.verdict.stringify()));
                if needs_tail(inv, &d.id) {
                    out.tail.push(d.id.clone());
                }
                out.native.push(d.id);
            }
            Err(Defer(why)) => out.full.push((d.id, why)),
        }
    }
    out.drain = parked_notices(&inv.home);
    out
}

// ---- the duty (tick) ---------------------------------------------------------------------------------------------------------

use serde_json::{Value, json};

fn inv_of(ctx: &Ctx) -> Inv {
    Inv {
        home: ctx.home.to_path_buf(),
        env: ctx.st.env.clone(),
        cwd: ctx.home.to_string_lossy().into_owned(),
        now: ctx.now,
        stdin: None,
        write_home: ctx.home.to_path_buf(),
        store_override: None,
    }
}

/// The record of the `verdicts` duty and, when a comparison is due, the witness job (finished after the sweep lock is released).
pub fn duty(ctx: &Ctx, runner: &dyn Runner) -> (Value, Option<super::witness::Job>) {
    let d = defaults::raw("devswarm_sup.duty.verdicts");
    let dry = super::setting(ctx.st, "devswarm_sup.set_dry_run_verdicts").as_bool().unwrap_or(false);
    let t = Thresholds::read(ctx);
    let inv = inv_of(ctx);
    let out = sweep(&inv, t, runner, dry);
    let mut detail = json!({
        "native": out.native.len(),
        "tail": out.tail,
        "full": out.full.iter().map(|(id, why)| json!({"id": id, "why": why})).collect::<Vec<_>>(),
        "drain": out.drain,
        "dryRun": dry,
    });
    if !dry && (!out.tail.is_empty() || !out.full.is_empty() || out.drain) {
        let spec = json!({"tail": out.tail, "full": out.full.iter().map(|(id, _)| id).collect::<Vec<_>>()}).to_string();
        let owner = if ctx.engine_pokes { defaults::text("devswarm_sup.owner_engine") } else { defaults::text("devswarm_sup.owner_node") };
        let timeout = d.get("timeout_ms").and_then(crate::defaults::V::as_integer).unwrap_or(0).max(1) as u64;
        let r = super::tick::node(runner, ctx, d.str_field("tail_snippet"), &[owner, &spec], timeout);
        detail["node"] = if r.ok {
            super::tick::parse(&r.stdout)
        } else {
            json!({"error": r.error.clone().unwrap_or_else(|| super::tick::cut(&r.stderr)), "status": r.status, "timedOut": r.timed_out})
        };
    }
    let job = if dry || out.written.is_empty() { None } else { super::witness::prepare_verdicts(ctx, &out, t) };
    (json!({"duty": "verdicts", "outcome": if dry { "dry-run" } else { "ran" }, "detail": detail}), job)
}
