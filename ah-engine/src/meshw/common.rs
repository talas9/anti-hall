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
use crate::meshw::ident::{self, Defer, Env, R, defer};
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

/// `seatRefusal(ctx)`: `Ok(())` when Node would not refuse. A live seat held by another session needs Node's liveness
/// evidence (session files, app terminals, heartbeats), so any other holder defers.
pub fn seat_check(inv: &Inv) -> R<()> {
    let Some(sid) = inv.env("mesh_write.env_session_id").filter(|s| !s.is_empty()) else { return Ok(()) };
    // primaryCheckout: resolveContext WITHOUT the superproject cache, so a nested checkout always needs git -> defer
    let c = ident::resolve_context(&inv.cwd, true)?;
    let Some(wt) = c.worktree_root.clone() else { return Ok(()) };
    let b = ident::builder_for_worktree(&inv.home, &inv.env, &wt)?;
    let bt = b.as_ref().and_then(|b| b.builder_type.as_deref()).map(str::trim).unwrap_or("");
    let is_primary = if !bt.is_empty() {
        bt == defaults::text("mesh_write.builder_type_primary")
    } else {
        c.main_worktree.as_deref().map(|m| ident::realpath(m).unwrap_or_else(|| m.to_string())).as_deref() == Some(wt.as_str())
    };
    if !is_primary {
        return Ok(());
    }
    let id = ident::mesh_id_for_real_path(&wt);
    let desc = read_json(
        &devswarm_root(&inv.home).join(defaults::text("mesh_write.dir_workspaces")).join(format!("{id}{}", defaults::text("mesh_write.json_suffix"))),
    );
    let Some(desc @ OVal::Obj(_)) = desc else { return Ok(()) };
    let holder = match desc.get(defaults::text("mesh_write.field_session_id")) {
        Some(OVal::Str(s)) if !s.is_empty() && !s.starts_with(defaults::text("mesh_write.unclaimed_prefix")) => s.clone(),
        Some(v @ (OVal::Num(_) | OVal::Bool(true))) if v.truthy() => return defer("seat-holder"),
        _ => String::new(),
    };
    if holder.is_empty() || holder == sid {
        return Ok(());
    }
    defer("seat-holder")
}

/// `selfHeal(ctx)`'s outcome as the fields `withSelfHeal` adds to a result, in Node's order. Only the outcomes that read
/// and spawn nothing are reproduced: no worktree, a healthy daemon, or a stale one that Node would not try to heal.
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
    if !crate::checks::spawnctx::devswarm_active(&inv.settings()) || repo_key.is_none() {
        return Ok(vec![(defaults::text("mesh_write.heal_warning").into(), OVal::Str(defaults::text("mesh_write.heal_stale").into()))]);
    }
    defer("self-heal")
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
fn daemon_healthy(inv: &Inv, repo_key: Option<&str>) -> R<bool> {
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
        let min = crate::checks::guardkit::settings::get_number(&inv.settings(), defaults::raw("mesh_write.setting_monitor_no_ok_fail_min"));
        if !(min.is_finite() && min > 0.0) {
            return defer("monitor-window");
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

/// The store a verb writes, settled the way `openStore` settles it: only a store whose `BACKEND` marker says sqlite (or
/// an explicit sqlite override) is opened; a journal store, or a store with no marker yet (Node would write one), defers.
pub fn open_store(inv: &Inv, repo_key: &str) -> R<MeshStore> {
    let dir = devswarm_root(&inv.home).join(defaults::text("mesh_write.dir_store")).join(repo_key);
    let forced = inv.env("mesh_write.env_store_backend").map(|s| s.trim().to_lowercase()).unwrap_or_default();
    let sqlite = defaults::text("mesh.backend_sqlite");
    if forced != sqlite {
        if !forced.is_empty() && forced == defaults::text("mesh_write.backend_journal") {
            return defer("journal-backend");
        }
        let marker = std::fs::read_to_string(dir.join(defaults::text("mesh.backend_marker"))).map(|s| s.trim().to_lowercase()).unwrap_or_default();
        if marker != sqlite {
            return defer("store-backend");
        }
    }
    let db = inv.store_override.clone().unwrap_or_else(|| dir.join(defaults::text("mesh_write.store_file")));
    MeshStore::open(&db).map_err(|e| Defer(format!("store-open:{e}")))
}

/// Jev triage might label an arrival (`jev-triage.js` `loadTriageConfig(home).enabled` can be true): Node then appends
/// to the arrival queue and may spawn a worker, which the engine does not; the send defers.
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

/// `defer` re-export for the verbs.
pub fn later<T>(code: &str) -> R<T> {
    defer(code)
}
