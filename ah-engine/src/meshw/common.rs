//! What every ported verb needs around its store write, each piece mirroring the Node code that runs at that point of
//! `devswarm.js run()`: the invocation context, the Primary-seat guard, the send-time self-heal probe, the store backend
//! check, the Jev-triage and plan-activity side channels (the engine defers when they would act), and the small files
//! the verbs read or write (sender aliases, send receipts).
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an unreadable optional file is the same as an absent one (fail-open, as Node's try/catch)
// - text that does not parse or decode is the absent value (Node Number()/JSON.parse catch parity)
// A failure that must be seen goes through `crate::discard` instead.
use crate::checks::git::util::Settings;
use crate::checks::guardkit::ojson::OVal;
use crate::defaults;
use crate::meshw::ident::{self, Env, R};
use crate::meshw::idlock::devswarm_root;
use crate::meshw::store::MeshStore;
use std::path::{Path, PathBuf};

/// One verb invocation: Node's `ctx` (`home`, `env`, `cwd`, `now`) plus the stdin body when the front door read it.
#[derive(Debug, Clone)]
pub struct Inv {
    /// `os.homedir()`.
    pub home: PathBuf,
    /// `process.env`.
    pub env: Env,
    /// `process.cwd()`.
    pub cwd: String,
    /// `Date.now()` at the start (the shadow replays Node's).
    pub now: i64,
    /// `fs.readFileSync(0)` when `--message-stdin` is used and the front door already read it.
    pub stdin: Option<String>,
    /// Where the verb's own side files go (the real home, or a scratch home in shadow mode).
    pub write_home: PathBuf,
    /// The store file to open instead of the per-repo one (a scratch copy in shadow mode).
    pub store_override: Option<PathBuf>,
}

impl Inv {
    /// The guardkit settings view of this invocation.
    pub fn settings(&self) -> Settings {
        Settings { home: self.home.to_string_lossy().to_string(), env: self.env.clone() }
    }

    fn env(&self, key: &str) -> Option<&str> {
        self.env.get(defaults::text(key)).map(String::as_str)
    }
}

/// `Date.now()`.
pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn read_json(p: &Path) -> Option<OVal> {
    OVal::parse(&String::from_utf8_lossy(&std::fs::read(p).ok()?))
}

fn num_of(v: Option<&OVal>) -> Option<f64> {
    match v {
        Some(OVal::Num(n)) if n.is_finite() => Some(*n),
        _ => None,
    }
}

/// `seatRefusal(ctx)`: `Ok(())` when Node would not refuse. A refusal is the verb's own answer (exit 2, `primary-seat-conflict`),
/// carried by [`ident::refuse`]: only a LIVE holder of the Primary seat that is not this session blocks (any other verdict of
/// Node's `seatVerdict` - closed, unknown, corrupt, none, own - does not).
pub fn seat_check(inv: &Inv) -> R<()> {
    match seat_refusal(inv)? {
        None => Ok(()),
        Some(refusal) => ident::refuse(&refusal.done().stringify()),
    }
}

/// `seatRefusal(ctx)` as the refusal's fields (`ok`, `reason`, `holder`, `id`, `error`), `None` when Node would not refuse.
pub fn seat_refusal(inv: &Inv) -> R<Option<Obj>> {
    let Some(sid) = inv.env("mesh_write.env_session_id").filter(|s| !s.is_empty()) else { return Ok(None) };
    // primaryCheckout: resolveContext WITHOUT the memo, `missingPath: 'ancestor'`
    let c = ident::resolve_context(&inv.cwd, true)?;
    let Some(wt) = c.worktree_root.clone() else { return Ok(None) };
    let b = ident::builder_for_worktree(&inv.home, &inv.env, &wt)?;
    let bt = b.as_ref().and_then(|b| b.builder_type.as_deref()).map(str::trim).unwrap_or("");
    let is_primary = if !bt.is_empty() {
        bt == defaults::text("mesh_write.builder_type_primary")
    } else {
        c.main_worktree.as_deref().map(|m| ident::realpath(m).unwrap_or_else(|| m.to_string())).as_deref() == Some(wt.as_str())
    };
    if !is_primary {
        return Ok(None);
    }
    let id = ident::mesh_id_for_real_path(&wt);
    let desc = read_json(
        &devswarm_root(&inv.home).join(defaults::text("mesh_write.dir_workspaces")).join(format!("{id}{}", defaults::text("mesh_write.json_suffix"))),
    );
    let Some(desc @ OVal::Obj(_)) = desc else { return Ok(None) };
    // `desc.sessionId && !String(desc.sessionId).startsWith('unclaimed:') ? String(desc.sessionId) : ''`
    let holder = match desc.get(defaults::text("mesh_write.field_session_id")) {
        Some(v) if v.truthy() => ident::js_to_string(v),
        _ => String::new(),
    };
    if holder.is_empty() || holder.starts_with(defaults::text("mesh_write.unclaimed_prefix")) || holder == sid {
        return Ok(None);
    }
    // holderLiveness: only a session record naming the holder with a live process is a conflict; every other outcome is "closed" or
    // "unknown", which Node does not refuse on
    if crate::dssup::liveness::session_state(&inv.home, &holder)? != Some(true) {
        return Ok(None);
    }
    // a session with its OWN registered identity on this worktree (a declared builder row recording this very session) acts as itself
    if let Some(rk) = ident::repo_key_for_worktree(&inv.cwd)?
        && let Some(reader) = crate::meshw::tick::open_reader(inv, &rk)?
        && let Ok(roster) = reader.roster()
    {
        let rows = ident::rows_of(&roster);
        if let Some(me) = ident::declared_self_id(&inv.env, &inv.cwd, &rows)?
            && rows.iter().any(|r| r.id == me && r.session_id.as_deref() == Some(sid))
        {
            return Ok(None);
        }
    }
    let cli = crate::checks::devswarm_role::text::engine_cli(&inv.home.to_string_lossy());
    let error = defaults::render("devswarm_role.seat_notice_conflict", &[("holder", &holder), ("id", &id), ("cli", &cli)]);
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(false))
        .put("reason", s(defaults::text("mesh_write.reason_seat_conflict")))
        .put("holder", s(&holder))
        .put("id", s(&id))
        .put("error", s(&error));
    Ok(Some(o))
}

/// `selfHeal(ctx)`'s outcome as the fields `withSelfHeal` adds to a result, in Node's order. No worktree, a healthy daemon, or a
/// stale one all answer from the disk. What Node does next for a stale daemon (spawn the Node ingest installer, behind the
/// launchd-disabled probe and the cooldown mark) belongs to the retired Node ingest unit: the engine drains ingest itself, so a
/// stale daemon ends in `daemonWarning: stale` (what Node answers when the engine owns ingest, or the project is not registered),
/// with the cooldown of an earlier attempt reported as Node reports it.
pub fn self_heal(inv: &Inv) -> R<Vec<(String, OVal)>> {
    let c = ident::resolve_context(&inv.cwd, true)?;
    // `.toplevel` of the caller's context: the nearest checkout
    let Some(top) = c.toplevel.clone() else {
        return Ok(vec![(defaults::text("mesh_write.heal_warning").into(), OVal::Str(defaults::text("mesh_write.heal_no_worktree").into()))]);
    };
    let repo_key = ident::repo_key_for_worktree(&top)?;
    if daemon_healthy(inv, repo_key.as_deref())? {
        return Ok(vec![(defaults::text("mesh_write.heal_healthy").into(), OVal::Bool(true))]);
    }
    let stale = || vec![(defaults::text("mesh_write.heal_warning").to_string(), OVal::Str(defaults::text("mesh_write.heal_stale").into()))];
    let Some(key) = repo_key.filter(|_| crate::checks::spawnctx::devswarm_active(&inv.settings())) else { return Ok(stale()) };
    // the engine owns the ingest of the projects while its marker says so: no installer is started in front of it
    if engine_owns_ingest(inv) {
        return Ok(stale());
    }
    // one attempt per cooldown window
    let attempt_file = self_heal_file(inv, &key);
    let last = read_json(&attempt_file).and_then(|o| num_of(o.get("lastAttemptAt")));
    let cooldown = defaults::num("mesh_write.self_heal_cooldown_ms") as f64;
    if let Some(l) = last.filter(|l| (inv.now as f64 - l) < cooldown) {
        let mut v = stale();
        v.push((defaults::text("mesh_write.heal_cooldown_key").to_string(), OVal::Bool(true)));
        v.push((defaults::text("mesh_write.heal_retry_key").to_string(), OVal::Num((cooldown - (inv.now as f64 - l)).max(0.0))));
        return Ok(v);
    }
    // only a project a registered workspace descriptor names qualifies for an automatic heal
    if !project_registered(inv, &key) {
        return Ok(stale());
    }
    let mut v = stale();
    v.push((defaults::text("mesh_write.heal_attempted_key").to_string(), OVal::Bool(true)));
    Ok(v)
}

/// The self-heal cooldown file of a project.
fn self_heal_file(inv: &Inv, repo_key: &str) -> PathBuf {
    devswarm_root(&inv.home).join(defaults::text("mesh_write.self_heal_dir")).join(format!(
        "{}{repo_key}{}",
        defaults::text("mesh_write.self_heal_file_prefix"),
        defaults::text("mesh_write.json_suffix")
    ))
}

/// `markSelfHealAttempt`: record this attempt (a staged write renamed into place), once per heal that reported
/// `daemonHealAttempted`. Best effort: a failed write only means a later call may try again sooner.
pub fn self_heal_mark(inv: &Inv, fields: &[(String, OVal)]) {
    if !fields.iter().any(|(k, v)| k == defaults::text("mesh_write.heal_attempted_key") && matches!(v, OVal::Bool(true))) {
        return;
    }
    let Ok(c) = ident::resolve_context(&inv.cwd, true) else { return };
    let Some(top) = c.toplevel else { return };
    let Ok(Some(key)) = ident::repo_key_for_worktree(&top) else { return };
    let file = self_heal_file(inv, &key);
    let mut tmp = file.as_os_str().to_os_string();
    tmp.push(defaults::text("mesh_write.tmp_suffix"));
    let tmp = PathBuf::from(tmp);
    let go = || -> std::io::Result<()> {
        if let Some(d) = file.parent() {
            std::fs::create_dir_all(d)?;
        }
        std::fs::write(&tmp, format!("{{\"lastAttemptAt\":{}}}", inv.now))?;
        std::fs::rename(&tmp, &file)
    };
    crate::discard::harmless(go()); // keep: Node's markSelfHealAttempt swallows a failed write
}

/// `ingest-health.js` `engineOwnsIngest`: the owner marker names the engine and is still within its validity.
fn engine_owns_ingest(inv: &Inv) -> bool {
    let Some(m) = read_json(&devswarm_root(&inv.home).join(defaults::text("mesh_write.ingest_owner_file"))) else { return false };
    let (ts, valid) = (num_of(m.get("ts")), num_of(m.get("validForMs")));
    matches!(m.get("owner"), Some(OVal::Str(o)) if o == defaults::text("mesh_write.ingest_owner_engine"))
        && matches!((ts, valid), (Some(t), Some(v)) if inv.now as f64 - t <= v)
}

/// `ingest-health.js` `projectRegistered`: a registered workspace descriptor carries the project's key.
fn project_registered(inv: &Inv, repo_key: &str) -> bool {
    let dir = devswarm_root(&inv.home).join(defaults::text("mesh_write.dir_workspaces"));
    let Ok(rd) = std::fs::read_dir(dir) else { return false };
    rd.flatten()
        .filter(|e| e.file_name().to_string_lossy().ends_with(defaults::text("mesh_write.json_suffix")))
        .any(|e| read_json(&e.path()).is_some_and(|d| matches!(d.get(defaults::text("mesh_write.field_repo_key")), Some(OVal::Str(k)) if k == repo_key)))
}

fn pid_alive(pid: f64) -> bool {
    if !(pid.is_finite() && pid > 0.0 && pid <= f64::from(i32::MAX)) || pid.fract() != 0.0 {
        return false;
    }
    // SAFETY: signal 0 only probes for the process.
    let rc = unsafe { libc::kill(pid as i32, 0) };
    rc == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// `ingest-health.js` `daemonHealth(home, repoKey).status === 'healthy'`.
pub(crate) fn daemon_healthy(inv: &Inv, repo_key: Option<&str>) -> R<bool> {
    let Some(rk) = repo_key else { return Ok(false) };
    let root = devswarm_root(&inv.home);
    let beat = read_json(&root.join(defaults::text("mesh_write.dir_heartbeats")).join(format!(
        "{}{rk}{}",
        defaults::text("mesh_write.ingest_beat_prefix"),
        defaults::text("mesh_write.json_suffix")
    )));
    let ts = beat.as_ref().and_then(|b| num_of(b.get("ts")));
    let fresh = ts.is_some_and(|t| (inv.now as f64 - t) <= defaults::num("mesh_write.ingest_beat_stale_ms") as f64);
    let beat_pid = beat.as_ref().and_then(|b| num_of(b.get("pid")));
    let lock = read_json(&root.join(defaults::text("mesh_write.dir_locks")).join(format!(
        "{}{rk}{}",
        defaults::text("mesh_write.ingest_lock_prefix"),
        defaults::text("mesh_write.lock_suffix")
    )));
    let lock_pid = lock.as_ref().and_then(|l| num_of(l.get("pid")));
    let live_lock = lock_pid.is_some_and(pid_alive);
    let same = beat_pid.is_some() && lock_pid.is_some() && beat_pid == lock_pid;
    if !(fresh && live_lock && same) {
        return Ok(false);
    }
    // monitorFaultFor: a heartbeat without the numeric failure count is "unknown", never a fault
    let Some(b) = beat else { return Ok(true) };
    let Some(consecutive) = num_of(b.get("consecutiveMonitorFailures")) else { return Ok(true) };
    let last_ok = num_of(b.get("lastMonitorOkMs"));
    let started = num_of(b.get("startedAtMs"));
    let window = || -> R<f64> {
        let entry = defaults::raw("mesh_write.setting_monitor_no_ok_fail_min");
        let mut min = crate::checks::guardkit::settings::get_number(&inv.settings(), entry);
        if !(min.is_finite() && min > 0.0) {
            // `monitorNoOkWindowMs`: a setting that is no positive number reads as the default window
            min = entry.get("default").and_then(crate::defaults::V::as_integer).unwrap_or(0) as f64;
        }
        Ok(min * defaults::num("mesh_write.ms_per_minute") as f64)
    };
    let now = inv.now as f64;
    let ok_stale = match last_ok {
        Some(l) => now - l > window()?,
        None => false,
    };
    let no_ok_since_start = match (last_ok, started) {
        (None, Some(s)) => now - s > window()?,
        _ => false,
    };
    Ok(!(consecutive >= defaults::num("mesh_write.monitor_failure_threshold") as f64 || ok_stale || no_ok_since_start))
}

/// The backend `resolveStoreBackend(dir)` settles on: a forced `ANTIHALL_DEVSWARM_STORE_BACKEND` wins outright; else the store
/// directory's `BACKEND` marker (only `sqlite` and `journal` count); else whichever physical form already holds data (a non-empty
/// database before a non-empty journal directory), else sqlite, which is then pinned by writing the marker. `true` is sqlite.
fn resolve_backend(inv: &Inv, dir: &Path) -> bool {
    let sqlite = defaults::text("mesh.backend_sqlite");
    let journal = defaults::text("mesh_write.backend_journal");
    let forced = inv.env("mesh_write.env_store_backend").map(|s| s.trim().to_lowercase()).unwrap_or_default();
    if forced == sqlite || forced == journal {
        return forced == sqlite;
    }
    let marker = std::fs::read_to_string(dir.join(defaults::text("mesh.backend_marker"))).map(|s| s.trim().to_lowercase()).unwrap_or_default();
    if marker == sqlite || marker == journal {
        return marker == sqlite;
    }
    let has_db = std::fs::metadata(dir.join(defaults::text("mesh_write.store_file"))).is_ok_and(|m| m.len() > 0);
    let has_journal = std::fs::read_dir(dir.join(defaults::text("devswarm_role.pg_journal_dir"))).is_ok_and(|mut r| r.next().is_some());
    let chosen_sqlite = has_db || !has_journal;
    pin_backend(dir, if chosen_sqlite { sqlite } else { journal });
    chosen_sqlite
}

/// `writeBackendMarker(dir, backend)`: best effort, as Node's (a failure only means the next open infers again).
fn pin_backend(dir: &Path, backend: &str) {
    if std::fs::create_dir_all(dir).is_ok() {
        let marker = dir.join(defaults::text("mesh.backend_marker"));
        let tmp = marker.with_extension(format!("{}.{}.tmp", std::process::id(), now_ms()));
        if std::fs::write(&tmp, backend).is_ok() {
            crate::discard::harmless(std::fs::rename(&tmp, &marker)); // keep: best-effort like Node's, the next open infers again
        }
    }
}

/// The refusal of a project whose store is on the legacy journal backend (see `reason_legacy_journal_store`).
fn legacy_journal<T>(repo_key: &str) -> R<T> {
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(false))
        .put("reason", s(defaults::text("mesh_write.reason_legacy_journal_store")))
        .put("error", s(&defaults::render("mesh_write.msg_legacy_journal_store", &[("repo_key", &repo_key)])));
    ident::refuse(&o.done().stringify())
}

/// The store a verb writes, settled the way `openStore` settles it ([`resolve_backend`]): a sqlite store is opened (created when the
/// project has none, and then pinned to sqlite); a store on the legacy journal backend, which only a Node older than 22.5 wrote, is
/// the verb's own refusal (`legacy-journal-store`, exit 2), never a hand-over.
pub fn open_store(inv: &Inv, repo_key: &str) -> R<MeshStore> {
    let dir = devswarm_root(&inv.home).join(defaults::text("mesh_write.dir_store")).join(repo_key);
    if !resolve_backend(inv, &dir) {
        return legacy_journal(repo_key);
    }
    std::fs::create_dir_all(&dir).or_else(|e| ident::unavailable("mesh_write.what_store_dir", &e))?;
    let db = inv.store_override.clone().unwrap_or_else(|| dir.join(defaults::text("mesh_write.store_file")));
    MeshStore::open(&db).or_else(|e| ident::unavailable("mesh_write.what_store", &e))
}

/// The first creation of a project's store (`resolveStoreBackend` on a fresh directory): the directory and the sqlite marker, so that
/// [`open_store`] then opens (creating) the database. A directory on the legacy journal backend is the same refusal as [`open_store`]'s.
pub fn init_new_store(inv: &Inv, repo_key: &str) -> R<()> {
    let dir = devswarm_root(&inv.home).join(defaults::text("mesh_write.dir_store")).join(repo_key);
    if !resolve_backend(inv, &dir) {
        return legacy_journal(repo_key);
    }
    std::fs::create_dir_all(&dir).or_else(|e| ident::unavailable("mesh_write.what_store_dir", &e))?;
    if !dir.join(defaults::text("mesh.backend_marker")).exists() {
        pin_backend(&dir, defaults::text("mesh.backend_sqlite"));
    }
    Ok(())
}

/// Jev triage might label an arrival (`jev-triage.js` `loadTriageConfig(home).enabled` can be true): Node then appends
/// to the arrival queue; the engine does the same (`jev_enqueue_arrival` decides exactly).
pub fn jev_maybe_enabled(inv: &Inv) -> bool {
    let env_jev = inv.env("mesh_write.env_jev");
    if env_jev == Some(defaults::text("mesh_write.env_off_value")) {
        return false;
    }
    if env_jev == Some(defaults::text("mesh_write.env_on_value")) {
        return true;
    }
    let ah = inv.home.join(defaults::text("mesh_write.dir_anti_hall"));
    let mut enabled = None;
    if let Some(OVal::Obj(o)) = read_json(&ah.join(defaults::text("mesh_write.jev_file"))) {
        enabled = o.iter().rev().find(|(k, _)| k == defaults::text("mesh_write.field_enabled")).map(|(_, v)| v.clone());
    }
    match read_json(&ah.join(defaults::text("mesh_write.settings_file"))) {
        Some(OVal::Obj(o)) => {
            if let Some((_, OVal::Obj(j))) = o.iter().rev().find(|(k, _)| k == defaults::text("mesh_write.settings_jev_section"))
                && let Some((_, v)) = j.iter().rev().find(|(k, _)| k == defaults::text("mesh_write.field_enabled"))
            {
                enabled = Some(v.clone());
            }
        }
        Some(_) => {}
        // a settings file that exists but does not parse: Node's settings.js reads it as {} (fail-open); a JSON form
        // serde rejects but JavaScript accepts would differ, so defer by answering "maybe"
        None if ah.join(defaults::text("mesh_write.settings_file")).exists() => return true,
        None => {}
    }
    matches!(enabled, Some(OVal::Bool(true)))
}

/// `jev-triage.js` `recordAnswered({home, from, to})` would act (a pending labeled message from `to` to `from`).
pub fn jev_pending_answer(inv: &Inv, from: &str, to: &str) -> bool {
    let p = inv
        .home
        .join(defaults::text("mesh_write.dir_anti_hall"))
        .join(defaults::text("mesh_write.dir_state"))
        .join(defaults::text("mesh_write.jev_pending_file"));
    match read_json(&p) {
        Some(o @ OVal::Obj(_)) => o.get(&format!("{from}\u{1}{to}")).is_some_and(OVal::truthy),
        _ => false,
    }
}

/// `jev-triage.js` `recordAnswered({home, from, to})`: `from` is about to answer `to`. When `to` earlier sent `from` a labeled
/// message with no answer recorded, the pair is dropped from the pending map, the time-to-answer is logged to the triage log and a
/// joinable outcome row goes to the Jev decision log. Best effort and silent, as Node's (a failure never touches the send).
pub fn jev_record_answered(inv: &Inv, from: &str, to: &str) {
    let ah = inv.home.join(defaults::text("mesh_write.dir_anti_hall"));
    let pending_path = ah.join(defaults::text("mesh_write.dir_state")).join(defaults::text("mesh_write.jev_pending_file"));
    let Some(OVal::Obj(mut all)) = read_json(&pending_path) else { return };
    let key = format!("{from}\u{1}{to}");
    let Some(pending) = all.iter().rev().find(|(k, _)| *k == key).map(|(_, v)| v.clone()) else { return };
    if !pending.truthy() {
        return;
    }
    let ts = pending.get("ts");
    let ts_num = match ts {
        Some(OVal::Num(x)) => *x,
        Some(OVal::Str(t)) => crate::checks::guardkit::text::js_number_of_str(t),
        Some(OVal::Bool(b)) => f64::from(u8::from(*b)),
        Some(OVal::Null) => 0.0,
        _ => f64::NAN,
    };
    let latency = inv.now as f64 - ts_num;
    all.retain(|(k, _)| *k != key);
    if let Some(dir) = pending_path.parent() {
        crate::discard::harmless(std::fs::create_dir_all(dir)); // keep: best-effort, Node's writePending swallows it
    }
    let tmp = format!("{}.tmp.{}", pending_path.display(), std::process::id());
    if std::fs::write(&tmp, OVal::Obj(all).stringify()).is_ok() {
        crate::discard::harmless(std::fs::rename(&tmp, &pending_path)); // keep: best-effort, as Node's
    }
    let num_or_null = |x: f64| if x.is_finite() { OVal::Num(x) } else { OVal::Null };
    let mut row = vec![
        ("ts".to_string(), OVal::Str(crate::checks::jsport::date::to_iso(inv.now as f64).unwrap_or_default())),
        ("type".to_string(), OVal::Str(defaults::text("mesh_write.jev_answered_type").to_string())),
    ];
    for field in ["urgency", "kind"] {
        if let Some(v) = pending.get(field) {
            row.push((field.to_string(), v.clone()));
        }
    }
    row.push(("latencyMs".to_string(), num_or_null(latency)));
    let log = ah.join(defaults::text("mesh_write.dir_logs")).join(defaults::text("mesh_write.jev_triage_log_file"));
    let env = crate::jev::settings::Env::from_pairs(inv.env.clone());
    let keep = crate::jev::settings::JevSettings::resolve(&inv.home, crate::jev::settings::Sources::load(&inv.home, env.clone())).log_rotated_files;
    let line = OVal::Obj(row).stringify();
    if let Some(dir) = log.parent() {
        crate::discard::harmless(std::fs::create_dir_all(dir)); // keep: the triage log is advisory
    }
    rotate_if_over(&log, defaults::num("mesh_write.jev_triage_log_max_bytes"), keep);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&log) {
        use std::io::Write;
        crate::discard::harmless(f.write_all(format!("{line}\n").as_bytes())); // keep: the triage log is advisory
    }
    let ts_text = match ts {
        Some(v) => ident::js_to_string(v),
        None => defaults::text("mesh_write.js_undefined").to_string(),
    };
    let digest = ring::digest::digest(&ring::digest::SHA256, format!("{key}\u{1}{ts_text}").as_bytes());
    let h: String = crate::meshw::store::hex(digest.as_ref()).chars().take(defaults::num("mesh_write.jev_outcome_hash_len") as usize).collect();
    if let Some(lane) = crate::jev::shared::lane(&inv.home, &env) {
        lane.record_outcome(
            defaults::text("mesh_write.jev_outcome_id"),
            &h,
            defaults::text("mesh_write.jev_outcome_value"),
            Some(defaults::text("mesh_write.jev_outcome_source")),
            crate::jev::shared::project_for(Some(&inv.cwd)).as_deref(),
        );
    }
}

/// `shiftRotated(p, keep)` once `p` is over `max` bytes: `p.(keep-1)` onto `p.keep`, ..., `p` onto `p.1`.
pub(crate) fn rotate_if_over(p: &Path, max: u64, keep: u64) {
    if std::fs::metadata(p).map_or(true, |m| m.len() <= max) {
        return;
    }
    let gen_path = |n: u64| PathBuf::from(format!("{}.{n}", p.display()));
    for i in (1..keep.max(1)).rev() {
        crate::discard::harmless(std::fs::rename(gen_path(i), gen_path(i + 1))); // keep: a gap in the chain is fine
    }
    crate::discard::harmless(std::fs::rename(p, gen_path(1))); // keep: on failure the row lands in the oversized file
}

/// A freshly sent direct message is queued for Jev arrival labelling; the scheduled job
/// `jev_arrival` drains the queue, so the send never waits for Jev. Disabled or already-labelled texts write nothing.
pub fn jev_enqueue_arrival(inv: &Inv, text: &str) {
    crate::jev::arrival::enqueue(&inv.home, text, &crate::jev::arrival::Limits::shipped());
}

/// A sent message is child activity: refresh the sender's plan progress clock (`planLib.noteActivity`) when the sender has a plan.
/// Best effort like Node's `try/catch`: any failure, deferral included, is dropped and never changes the send result.
pub fn note_sender_activity(inv: &Inv, from: &str, text: &str, now: f64) {
    let run = || -> R<()> {
        let Some(found) = crate::meshw::plan::find(inv, from)? else { return Ok(()) };
        crate::meshw::plan::update_with(inv, &found.key, |cur| {
            let Some(mut plan) = cur else { return Ok(((), None)) };
            let refreshed = crate::meshw::plan::note_activity(&mut plan, text, now);
            Ok(((), refreshed.then_some(plan)))
        })?;
        Ok(())
    };
    crate::discard::harmless(run()); // keep: Node's planLib update here is `catch (_) { /* best-effort */ }`
}

/// `planRefFor` + `findPlan`: whether the sender has a plan file (Node then records plan activity; the engine defers).
pub fn sender_has_plan(inv: &Inv, from: &str) -> R<bool> {
    let mut wt: Option<String> = ident::read_descriptor(&inv.home, from).and_then(|d| match d.get(defaults::text("mesh_write.field_worktree_path")) {
        Some(OVal::Str(s)) if !s.is_empty() => Some(s.clone()),
        _ => None,
    });
    if wt.is_none() && inv.env.get(defaults::text("mesh_write.env_builder_id")).map(String::as_str) == Some(from) {
        wt = ident::resolve_context(&inv.cwd, true)?.worktree_root;
    }
    let mut keys: Vec<String> = Vec::new();
    if let Some(w) = wt.filter(|w| !w.is_empty()) {
        let c = ident::resolve_context(&w, false)?;
        if let Some(root) = c.worktree_root {
            let k = ident::mesh_id_for_real_path(&root);
            if crate::meshw::idlock::is_safe_id(&k) {
                keys.push(k);
            }
        }
    }
    if crate::meshw::idlock::is_safe_id(from) && !keys.iter().any(|k| k == from) {
        keys.push(from.to_string());
    }
    let dir = devswarm_root(&inv.home).join(defaults::text("mesh_write.dir_plans"));
    Ok(keys.iter().any(|k| dir.join(format!("{k}{}", defaults::text("mesh_write.json_suffix"))).exists()))
}

/// `devswarm-sender-alias.js` `readAliases(home)`: label -> the id it now stands for.
pub fn read_aliases(home: &Path) -> Vec<(String, String)> {
    let Some(j) = read_json(&devswarm_root(home).join(defaults::text("mesh_write.alias_file"))) else { return Vec::new() };
    let Some(OVal::Obj(a)) = j.get(defaults::text("mesh_write.alias_key")) else { return Vec::new() };
    let mut out: Vec<(String, String)> = Vec::new();
    for (k, v) in a {
        // String(v.to): a missing `to` (or a non-object entry) is the text "undefined", which is a safe id
        let to = match v.get("to") {
            Some(OVal::Str(s)) => s.clone(),
            Some(n @ OVal::Num(_)) => n.stringify(),
            Some(OVal::Bool(b)) => b.to_string(),
            Some(OVal::Null) => defaults::text("mesh_write.js_null").to_string(),
            None => defaults::text("mesh_write.js_undefined").to_string(),
            Some(_) => continue,
        };
        if crate::meshw::idlock::is_safe_id(k) && v.truthy() && crate::meshw::idlock::is_safe_id(&to) && &to != k {
            out.retain(|(x, _)| x != k);
            out.push((k.clone(), to));
        }
    }
    out
}

/// The sender alias of a child caller (`senderIdentityDetailed` -> `writeAlias(home, label, child, worktree)`): the worktree label the
/// child's registered id replaces, written to the alias map when it does not already say so. Best effort (Node: `catch (_) {}`); a
/// caller that is not a child needs none. `cwd` names the worktree recorded with the alias.
pub fn ensure_alias(inv: &Inv, who: &ident::Caller, cwd: &str) {
    if who.kind != defaults::text("mesh_write.kind_child") {
        return;
    }
    let Some(label) = who.mesh_id.as_deref() else { return };
    if read_aliases(&inv.home).into_iter().any(|(k, v)| k == label && v == who.identity) {
        return;
    }
    let worktree = ident::resolve_caller_worktree(cwd).ok().flatten();
    write_alias(inv, label, &who.identity, worktree.as_deref());
}

/// `writeAlias(home, label, to, worktree)`: `{version: 1, aliases: {label: {to, worktree, at}}}`, pretty-printed with a final newline,
/// through a temp file and a rename. `false` when nothing was written (an unsafe or equal pair, the same alias on file, an error).
pub fn write_alias(inv: &Inv, label: &str, to: &str, worktree: Option<&str>) -> bool {
    use crate::meshw::idlock::is_safe_id;
    if !is_safe_id(label) || !is_safe_id(to) || label == to {
        return false;
    }
    let file = devswarm_root(&inv.home).join(defaults::text("mesh_write.alias_file"));
    let key = defaults::text("mesh_write.alias_key");
    // absent or corrupt: start fresh (corrupt content is replaced, never merged)
    let mut aliases: Vec<(String, OVal)> = match read_json(&file).and_then(|j| j.get(key).cloned()) {
        Some(OVal::Obj(a)) => a,
        _ => Vec::new(),
    };
    if let Some((_, cur)) = aliases.iter().find(|(k, _)| k == label)
        && matches!(cur.get("to"), Some(OVal::Str(t)) if t == to)
    {
        return false;
    }
    let now = if defaults::env_var("mesh_now").is_some() { inv.now } else { now_ms() };
    let entry = OVal::Obj(vec![
        ("to".into(), OVal::Str(to.to_string())),
        ("worktree".into(), worktree.map_or(OVal::Null, |w| OVal::Str(w.to_string()))),
        ("at".into(), OVal::Num(now as f64)),
    ]);
    match aliases.iter_mut().find(|(k, _)| k == label) {
        Some(slot) => slot.1 = entry,
        None => aliases.push((label.to_string(), entry)),
    }
    let doc = OVal::Obj(vec![("version".into(), OVal::Num(1.0)), (key.to_string(), OVal::Obj(aliases))]);
    if let Some(d) = file.parent()
        && std::fs::create_dir_all(d).is_err()
    {
        return false;
    }
    crate::atomic::write(&file, format!("{}\n", doc.stringify_pretty())).is_ok()
}

/// Write the send receipt (`writeSendReceipt`): `<devswarm>/send-receipts/<UTC day>/<hash>.json`, tmp then rename.
pub fn write_send_receipt(home: &Path, ts: i64, hash: &str, entry: &OVal) {
    let day = utc_day(ts);
    let dir = devswarm_root(home).join(defaults::text("mesh_write.dir_send_receipts")).join(day);
    let name: String = hash.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' }).collect();
    let file = dir.join(format!("{name}{}", defaults::text("mesh_write.json_suffix")));
    let tmp = file.with_file_name(format!("{name}{}{}", defaults::text("mesh_write.json_suffix"), defaults::text("mesh_write.tmp_suffix")));
    let r = std::fs::create_dir_all(&dir).and_then(|()| std::fs::write(&tmp, format!("{}\n", entry.stringify()))).and_then(|()| std::fs::rename(&tmp, &file));
    crate::discard::harmless(r); // keep: Node's writeSendReceipt never throws and its result is ignored
}

/// `new Date(ts).toISOString().slice(0, 10)`.
pub fn utc_day(ts: i64) -> String {
    let (y, m, d) = crate::checks::jsport::date::civil_from_days(ts.div_euclid(86_400_000));
    format!("{y:04}-{m:02}-{d:02}")
}

/// An ordered JSON object builder.
#[derive(Debug, Default)]
pub struct Obj(pub Vec<(String, OVal)>);

impl Obj {
    /// Set `key: value` (`obj[key] = value`): an existing key keeps its place.
    pub fn put(&mut self, k: &str, v: OVal) -> &mut Self {
        match self.0.iter_mut().find(|(x, _)| x == k) {
            Some(slot) => slot.1 = v,
            None => self.0.push((k.to_string(), v)),
        }
        self
    }
    /// The value.
    pub fn done(self) -> OVal {
        OVal::Obj(self.0)
    }
}

/// `OVal` of an optional string (`null` when absent).
pub fn s_or_null(v: Option<&str>) -> OVal {
    v.map_or(OVal::Null, |s| OVal::Str(s.to_string()))
}

/// `OVal` of a string.
pub fn s(v: &str) -> OVal {
    OVal::Str(v.to_string())
}

/// `OVal` of a number.
pub fn n(v: f64) -> OVal {
    OVal::Num(v)
}

/// Whether a path exists (fail-open false).
pub fn exists(p: &Path) -> bool {
    p.exists()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ah-common-{tag}-{}", std::process::id()));
        crate::discard::harmless(std::fs::remove_dir_all(&d)); // keep: a stale directory of an earlier run of this test
        std::fs::create_dir_all(&d).unwrap();
        d.canonicalize().unwrap()
    }

    fn git_init(dir: &Path) {
        std::fs::create_dir_all(dir).unwrap();
        let st = std::process::Command::new("git").current_dir(dir).args(["init", "-q", "-b", "main"]).env("GIT_CONFIG_NOSYSTEM", "1").status().unwrap();
        assert!(st.success());
    }

    fn inv_in(home: &Path, cwd: &Path, env: &[(&str, &str)]) -> Inv {
        Inv {
            home: home.to_path_buf(),
            write_home: home.to_path_buf(),
            env: env.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
            cwd: cwd.to_string_lossy().into_owned(),
            now: 1_000_000_000,
            stdin: None,
            store_override: None,
        }
    }

    /// A Primary checkout whose descriptor records `holder`, and a harness session record naming it with process `pid`.
    fn primary_seat(tag: &str, holder: &str, pid: u32) -> (PathBuf, PathBuf, String) {
        let home = scratch(tag);
        let wt = home.join("repo");
        git_init(&wt);
        let wt = wt.canonicalize().unwrap();
        let id = ident::mesh_id_for_real_path(&wt.to_string_lossy());
        let dir = devswarm_root(&home).join(defaults::text("mesh_write.dir_workspaces"));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(format!("{id}.json")), serde_json::json!({"id": id, "sessionId": holder}).to_string()).unwrap();
        let sessions = home.join(defaults::text("mesh_write.claude_dir")).join(defaults::text("mesh_write.sessions_dir"));
        std::fs::create_dir_all(&sessions).unwrap();
        std::fs::write(sessions.join("rec.json"), serde_json::json!({"sessionId": holder, "pid": pid}).to_string()).unwrap();
        (home, wt, id)
    }

    /// 2026-10-23: a live holder of the Primary seat made every send/ack from another session a hand-over to Node (exit 69). It is
    /// Node's own refusal: exit 2, `primary-seat-conflict`, the holder and the Primary id.
    #[test]
    fn another_sessions_live_seat_is_the_verbs_own_refusal() {
        let (home, wt, id) = primary_seat("seat-live", "holder-1", std::process::id());
        let me = [(defaults::text("mesh_write.env_session_id"), "me-2")];
        let inv = inv_in(&home, &wt, &me);
        let o = seat_refusal(&inv).unwrap().expect("a live holder blocks");
        let v = o.done();
        assert_eq!(v.get("ok"), Some(&OVal::Bool(false)));
        assert_eq!(v.get("reason"), Some(&OVal::Str("primary-seat-conflict".into())));
        assert_eq!(v.get("holder"), Some(&OVal::Str("holder-1".into())));
        assert_eq!(v.get("id"), Some(&OVal::Str(id)));
        let err = seat_check(&inv).unwrap_err();
        assert!(ident::refusal_body(&err).is_some_and(|b| b.contains("primary-seat-conflict")), "{err:?}");
        // the holder itself, a dead holder and a holder with no session record are not refused
        let own = [(defaults::text("mesh_write.env_session_id"), "holder-1")];
        assert!(seat_refusal(&inv_in(&home, &wt, &own)).unwrap().is_none());
        std::fs::remove_file(home.join(defaults::text("mesh_write.claude_dir")).join(defaults::text("mesh_write.sessions_dir")).join("rec.json")).unwrap();
        assert!(seat_refusal(&inv).unwrap().is_none(), "no record naming the holder is not a live one");
        crate::discard::harmless(std::fs::remove_dir_all(home)); // keep: cleanup of a scratch directory
    }

    #[test]
    fn a_dead_holder_is_not_a_conflict() {
        let (home, wt, _) = primary_seat("seat-dead", "holder-1", 999_999_999);
        let me = [(defaults::text("mesh_write.env_session_id"), "me-2")];
        assert!(seat_refusal(&inv_in(&home, &wt, &me)).unwrap().is_none());
        crate::discard::harmless(std::fs::remove_dir_all(home)); // keep: cleanup of a scratch directory
    }

    /// The backend settles as Node settles it: a database with no marker is sqlite (and the marker is written), a journal-only
    /// directory is the legacy journal (a refusal, not a hand-over), a forced backend wins.
    #[test]
    fn the_store_backend_is_settled_from_the_marker_then_the_disk() {
        let home = scratch("backend");
        let mk = |key: &str| devswarm_root(&home).join(defaults::text("mesh_write.dir_store")).join(key);
        let inv = inv_in(&home, &home, &[]);
        // no store at all: a new sqlite store, pinned
        assert!(open_store(&inv, "fresh").is_ok());
        assert_eq!(std::fs::read_to_string(mk("fresh").join("BACKEND")).unwrap().trim(), "sqlite");
        // a database with no marker (an older store): sqlite, and pinned from now on
        std::fs::create_dir_all(mk("olddb")).unwrap();
        std::fs::write(mk("olddb").join(defaults::text("mesh_write.store_file")), b"x").unwrap();
        assert!(resolve_backend(&inv, &mk("olddb")));
        assert_eq!(std::fs::read_to_string(mk("olddb").join("BACKEND")).unwrap().trim(), "sqlite");
        // a journal directory with data and no database: the legacy journal, refused with its own reason
        std::fs::create_dir_all(mk("jnl").join("journal")).unwrap();
        std::fs::write(mk("jnl").join("journal").join("a.ndjson"), b"{}\n").unwrap();
        let err = open_store(&inv, "jnl").map(|_| ()).unwrap_err();
        assert!(ident::refusal_body(&err).is_some_and(|b| b.contains("legacy-journal-store")), "{err:?}");
        // a marker of another word is not a backend: the disk decides
        std::fs::create_dir_all(mk("odd")).unwrap();
        std::fs::write(mk("odd").join("BACKEND"), "postgres").unwrap();
        assert!(resolve_backend(&inv, &mk("odd")));
        // a forced backend wins over the marker
        let forced = inv_in(&home, &home, &[(defaults::text("mesh_write.env_store_backend"), "journal")]);
        assert!(!resolve_backend(&forced, &mk("fresh")));
        crate::discard::harmless(std::fs::remove_dir_all(home)); // keep: cleanup of a scratch directory
    }

    /// A stale daemon ends in `stale`; a recent installer attempt is reported as a cooldown with its remaining time.
    #[test]
    fn a_stale_daemon_with_a_recent_attempt_reports_the_cooldown() {
        let home = scratch("heal");
        let repo = home.join("repo");
        git_init(&repo);
        let repo = repo.canonicalize().unwrap();
        let key = ident::repo_key_for_worktree(&repo.to_string_lossy()).unwrap().unwrap();
        let env = [(defaults::text("spawn_ctx.devswarm_repo_env"), "x")];
        let inv = inv_in(&home, &repo, &env);
        let stale = self_heal(&inv).unwrap();
        assert_eq!(stale, vec![("daemonWarning".to_string(), OVal::Str("stale".into()))]);
        let dir = devswarm_root(&home).join(defaults::text("mesh_write.self_heal_dir"));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(format!("ingest-{key}.json")), serde_json::json!({"lastAttemptAt": inv.now - 10_000}).to_string()).unwrap();
        let cooling = self_heal(&inv).unwrap();
        assert_eq!(cooling.len(), 3);
        assert_eq!(cooling[1], ("daemonHealCooldown".to_string(), OVal::Bool(true)));
        assert_eq!(cooling[2], ("retryAfterMs".to_string(), OVal::Num(50_000.0)));
        // an engine that owns ingest ends it quietly
        std::fs::write(
            devswarm_root(&home).join("ingest-owner.json"),
            serde_json::json!({"owner": "engine", "ts": inv.now - 1000, "validForMs": 3_600_000}).to_string(),
        )
        .unwrap();
        assert_eq!(self_heal(&inv).unwrap(), stale);
        crate::discard::harmless(std::fs::remove_dir_all(home)); // keep: cleanup of a scratch directory
    }

    /// `monitorNoOkWindowMs`: a setting that is no positive number reads as the default window, not as a hand-over.
    #[test]
    fn a_nonsense_monitor_window_reads_as_the_default() {
        let home = scratch("window");
        let ah = home.join(defaults::text("mesh_write.dir_anti_hall"));
        std::fs::create_dir_all(&ah).unwrap();
        std::fs::write(ah.join(defaults::text("mesh_write.settings_file")), r#"{"devswarm": {"monitorNoOkFailMin": -5}}"#).unwrap();
        let root = devswarm_root(&home);
        let beat = root.join(defaults::text("mesh_write.dir_heartbeats"));
        let locks = root.join(defaults::text("mesh_write.dir_locks"));
        std::fs::create_dir_all(&beat).unwrap();
        std::fs::create_dir_all(&locks).unwrap();
        let inv = inv_in(&home, &home, &[]);
        let pid = f64::from(std::process::id());
        let rk = "repo-abc123";
        let now = inv.now as f64;
        std::fs::write(
            beat.join(format!("{}{rk}.json", defaults::text("mesh_write.ingest_beat_prefix"))),
            serde_json::json!({"ts": now, "pid": pid, "consecutiveMonitorFailures": 0, "lastMonitorOkMs": now - 5.0 * 60_000.0}).to_string(),
        )
        .unwrap();
        std::fs::write(locks.join(format!("{}{rk}.lock", defaults::text("mesh_write.ingest_lock_prefix"))), serde_json::json!({"pid": pid}).to_string())
            .unwrap();
        assert!(daemon_healthy(&inv, Some(rk)).unwrap(), "5 minutes since the last good poll is inside the 10 minute default");
        crate::discard::harmless(std::fs::remove_dir_all(home)); // keep: cleanup of a scratch directory
    }
}
