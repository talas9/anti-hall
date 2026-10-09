//! Slice S3: the drain of one workspace's native queue as `reconcile` runs it (`inbox pull <id>` with the workspace as the working
//! directory), natively, witnessed against Node.
//!
//! The pull itself is [`crate::meshw::pull`] (the one `inbox tick --child` runs): the ensure, the delivery-log replay and the
//! destructive read with its raw capture. What is new here is the ORDER the witness needs, because the read cannot be agreed
//! before it happens (design section 2):
//!
//! 1. **stage** (real home, under the workspace's pull lock): plan the pull with the engine's own planner, which hands every state
//!    it does not reproduce to Node before anything is touched; then the non-destructive count and, only for a count above zero,
//!    the ONE destructive read, whose raw bytes are appended and fsynced to the delivery log the moment it returns. From here on
//!    the batch is durable: a crash, a mismatch or a refusal leaves it PENDING in the log and Node's next pull replays it
//!    (replay is idempotent by the content hash). A batch the engine would not close exactly like Node (a shortfall, a date form
//!    it does not reproduce, a log write that failed) is left pending for the same reason.
//! 2. **witness** ([`super::gate`]): the log, the descriptor, the inbox, the cursor and the store are mirrored twice. Node's own
//!    `inbox pull` runs on one mirror against a recording `hivecontrol` that answers `0` (so it replays what the log holds and
//!    reads nothing), the engine's [`apply_pull`] on the other, and the two post-states are compared byte for byte.
//! 3. **apply**: only on equality the same [`apply_pull`] runs on the real home, under the workspace lock, with the pull lock the
//!    stage took still held. The inbox gets the rows, the store gets its feed, the log gets the closing record.
//!
//! Every deferral hands that one workspace to Node's own `inbox pull` subprocess (the spawn `reconcile` makes today).
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this module is a deliberate keep, for these reasons:
// - an unreadable optional file is the absent one (Node's try/catch)
// - releasing a lock that is already gone is fine
use super::apply::Env;
use super::gate::{self, Job};
use super::view::descriptor_rel;
use super::{Hooks, Op, Unit, UnitEnd};
use crate::checks::guardkit::nodelock;
use crate::checks::guardkit::ojson::OVal;
use crate::defaults;
use crate::dsact::runner::Runner;
use crate::dssup::ingest::wal;
use crate::dssup::tick::Ctx;
use crate::meshw::common::Inv;
use crate::meshw::ident::{self, read_descriptor};
use crate::meshw::idlock::devswarm_root;
use crate::meshw::pull;
use serde_json::{Value, json};
use std::path::Path;

/// A workspace whose native queue was read and captured on the real home, waiting for its witnessed apply. It holds the
/// workspace's pull lock until [`drain`] ends.
pub struct Staged {
    /// The workspace id.
    pub id: String,
    /// The git root the pull stands in.
    pub cwd: String,
    /// What `reconcile` records for this workspace when the apply succeeds: the shape of `inbox pull`'s own answer.
    pub result: Value,
    held: Option<nodelock::Held>,
    files: Vec<String>,
}

/// How a staging ended.
pub enum Stage {
    /// Captured (or nothing waits) and ready for the witnessed apply.
    Ready(Box<Staged>),
    /// The engine does not answer this workspace; the text says why. Nothing durable is lost: a captured batch is pending in the
    /// delivery log and Node's pull replays it.
    Node(String),
}

/// The environment the drain runs in: the invoker's, minus the identity of the invoking session (a sweep drain speaks for no
/// session), plus the marker that tells the pull so.
pub fn sweep_env(base: &ident::Env, home: &Path) -> ident::Env {
    let mut env = base.clone();
    for k in defaults::list("devswarm_recon.env_strip") {
        env.remove(k);
    }
    env.insert(defaults::text("devswarm_recon.env_sweep_flag").to_string(), "1".to_string());
    env.insert("HOME".to_string(), home.to_string_lossy().into_owned());
    env
}

fn inv_for(home: &Path, base: &ident::Env, now: i64, cwd: &str) -> Inv {
    Inv { home: home.to_path_buf(), env: sweep_env(base, home), cwd: cwd.to_string(), now, stdin: None, write_home: home.to_path_buf(), store_override: None }
}

/// The path relative to `home` when it lies inside the DevSwarm state directory (the only place a mirror can stand in for), in
/// either spelling of the home.
fn inside_state_dir(home: &Path, p: &str) -> Option<String> {
    let root = devswarm_root(home);
    let canon = std::fs::canonicalize(&root).ok();
    for r in std::iter::once(root).chain(canon) {
        if let Ok(rest) = Path::new(p).strip_prefix(&r) {
            let rel = Path::new(defaults::text("mesh_write.dir_anti_hall")).join(defaults::text("mesh_write.dir_devswarm")).join(rest);
            return Some(rel.to_string_lossy().into_owned());
        }
    }
    None
}

fn rel_of(home: &Path, p: &Path) -> Option<String> {
    inside_state_dir(home, &p.to_string_lossy())
}

/// Stage one workspace. `cwd` is the git root the sweep stands in; `at` is called at the durable boundaries of the read (the
/// crash tests kill the process there).
pub fn stage(ctx: &Ctx, id: &str, cwd: &str, at: &dyn Fn(&str)) -> Stage {
    let node = |why: &str| Stage::Node(why.to_string());
    let inv = inv_for(ctx.home, &ctx.st.env, ctx.now, cwd);
    let Some(desc) = read_descriptor(ctx.home, id) else { return node("no-descriptor") };
    let mut plan = match pull::prepare(&inv, id, Some(&desc)) {
        Ok(p) => p,
        Err(d) => return Stage::Node(d.0),
    };
    // a mirror can stand in only for paths inside the state directory
    let ensured = plan.ensured().clone();
    let field = |k: &str| match ensured.get(defaults::text(k)) {
        Some(OVal::Str(t)) => Some(t.clone()),
        _ => None,
    };
    let (Some(inbox), Some(cursor)) = (field("mesh_write.field_inbox_path"), field("mesh_write.field_cursor_path")) else { return node("descriptor-paths") };
    let (Some(inbox_rel), Some(cursor_rel)) = (inside_state_dir(ctx.home, &inbox), inside_state_dir(ctx.home, &cursor)) else { return node("path-outside-state-dir") };
    let Some(wal_rel) = rel_of(ctx.home, plan.wal_path()) else { return node("path-outside-state-dir") };
    let Some(lock) = nodelock::acquire_stale_unless_live(&plan.lock_file().to_string_lossy(), pull::lock_params()) else { return node("pull-lock-held") };
    let held = Some(lock);
    let release = |h: Option<nodelock::Held>| {
        if let Some(h) = h {
            h.release();
        }
    };
    if let Err(d) = plan.check_wal(&inv) {
        release(held);
        return Stage::Node(d.0);
    }
    let worktree = field("mesh_write.field_worktree_path").unwrap_or_else(|| cwd.to_string());
    let result = |native: f64, imported: usize, duplicate: usize| {
        json!({"ok": true, "imported": imported, "duplicate": duplicate, "nativeCount": native as i64, "locked": true, "lost": 0})
    };
    let (outcome, files) = (pull::capture_fresh(&inv, &plan, &worktree, at), vec![descriptor_rel(id), wal_rel, inbox_rel, cursor_rel]);
    let ready = |held: Option<nodelock::Held>, result: Value| Stage::Ready(Box::new(Staged { id: id.to_string(), cwd: cwd.to_string(), result, held, files }));
    match outcome {
        pull::Fresh::Blocked => {
            release(held);
            node("wal-blocked")
        }
        pull::Fresh::CountFailed => {
            release(held);
            node("count-failed")
        }
        pull::Fresh::Empty => ready(held, result(0.0, 0, 0)),
        pull::Fresh::Read { native, ok, entry, wal_error, raw } => {
            // the batch is in the log (or could not be); whatever is refused below stays pending for Node's replay
            let why = if !ok {
                Some("read-failed")
            } else if wal_error {
                Some("wal-write-failed")
            } else if entry.is_none() {
                Some("empty-read")
            } else if pull::store_feed_left(&inv, &plan, &raw) {
                Some("fresh-date")
            } else {
                None
            };
            if let Some(why) = why {
                release(held);
                return node(why);
            }
            let mut raws: Vec<&str> = plan.pending().iter().map(|b| b.raw.as_str()).collect();
            raws.push(&raw);
            let (imported, duplicate, _) = pull::preview(&plan, &raws);
            if ((imported + duplicate) as f64) < native {
                release(held);
                return node("shortfall");
            }
            ready(held, result(native, imported, duplicate))
        }
    }
}

/// The ensure and the replay of the delivery log on the home `env` names, the way `inbox pull` does them after the read. Applied
/// to a mirror by the witness and then to the real home. On the real home the caller holds the pull lock; `at` is called at the
/// durable boundaries of the replay.
pub fn apply_pull(env: &Env, id: &str, cwd: &str, at: &dyn Fn(&str)) -> Result<(), String> {
    let inv = Inv {
        home: env.home.to_path_buf(),
        env: sweep_env(&env.st.env, env.home),
        cwd: cwd.to_string(),
        now: env.now,
        stdin: None,
        write_home: env.home.to_path_buf(),
        store_override: None,
    };
    let desc = read_descriptor(env.home, id).ok_or_else(|| "no-descriptor".to_string())?;
    let mut plan = pull::prepare(&inv, id, Some(&desc)).map_err(|d| d.0)?;
    plan.check_wal(&inv).map_err(|d| d.0)?;
    // the ensure runs under the workspace lock, released before the replay (the store feed takes the partition's lock itself)
    let Some(id_lock) = crate::meshw::idlock::acquire(env.home, id) else { return Err(defaults::text("devswarm_recon.why_lock_busy").to_string()) };
    let ensured = pull::ensure_locked(&inv, &plan);
    id_lock.release();
    if !ensured {
        return Err(defaults::text("devswarm_recon.why_ensure_failed").to_string());
    }
    pull::replay_pending(&inv, &plan, at).map_err(|()| defaults::text("devswarm_recon.why_replay_failed").to_string())?;
    // never a destructive read into a log that cannot be appended and fsynced (Node probes the log here, before its count)
    if wal::preflight(plan.wal_path()).is_some() {
        return Err(defaults::text("devswarm_recon.why_wal_blocked").to_string());
    }
    wal::maybe_rotate(plan.wal_path(), inv.now);
    Ok(())
}

/// One line in the witness log for a workspace the engine did not drain itself, so the proof window can see how often and why.
pub fn note_handback(ctx: &Ctx, id: &str, why: &str) {
    let rec = json!({"ts": ctx.now, "job": defaults::text("devswarm_recon.job_handback"), "id": id, "why": why});
    crate::dsact::exec::append_line(&ctx.home.join(defaults::text("devswarm_recon.witness_file")), &rec);
}

/// Witness and apply the staged workspaces of one project in one gate job. For each, in order: its recorded result, or the reason
/// it goes to Node. Every staged workspace's pull lock is released when this returns.
pub fn drain(ctx: &Ctx, runner: &dyn Runner, repo_key: &str, staged: Vec<Staged>, hooks: &Hooks) -> Vec<Result<Value, String>> {
    if staged.is_empty() {
        return Vec::new();
    }
    let mut files: Vec<String> = Vec::new();
    let mut rebase: Vec<String> = Vec::new();
    let (mut units, mut calls) = (Vec::new(), Vec::new());
    let stub = defaults::text("devswarm_recon.stub_hivecontrol");
    for s in &staged {
        files.extend(s.files.iter().cloned());
        rebase.push(descriptor_rel(&s.id));
        units.push(Unit { label: format!("pull:{}", s.id), lock: None, ops: vec![Op::Pull { id: s.id.clone(), cwd: s.cwd.clone() }] });
        calls.push(json!({"fn": "pull", "args": {"id": s.id, "cwd": s.cwd, "stub": stub}}));
    }
    // what Node's self-heal reads to call the daemon healthy (a stale one would make it spawn the installer), and the app cache
    let root = devswarm_root(ctx.home);
    let lock = root.join(defaults::text("mesh_write.dir_locks")).join(format!("{}{repo_key}{}", defaults::text("mesh_write.ingest_lock_prefix"), defaults::text("mesh_write.lock_suffix")));
    let cache = root.join(defaults::text("mesh_write.app_cache_dir")).join(defaults::text("mesh_write.app_cache_file"));
    files.extend([lock, cache].iter().filter_map(|p| rel_of(ctx.home, p)));
    let mut scope = super::side::scope_for(&files);
    scope.stores.push(repo_key.to_string());
    for d in defaults::list("devswarm_recon.summary_dirs") {
        scope.dirs.push(super::view::ds(d));
    }
    scope.rebase = rebase;
    let n = calls.len();
    let job = Job { label: defaults::text("devswarm_recon.job_pull").into(), scope, units, calls, expect: vec![None; n] };
    let out = gate::run(ctx, runner, &job, hooks);
    let mut results = Vec::new();
    for (s, end) in staged.into_iter().zip(out.ends) {
        results.push(match end {
            UnitEnd::Applied => Ok(s.result.clone()),
            UnitEnd::Deferred(why) | UnitEnd::Failed(why) => Err(why),
        });
        if let Some(h) = s.held {
            h.release();
        }
    }
    results
}
