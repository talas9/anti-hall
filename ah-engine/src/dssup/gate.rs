//! Input gates for supervisor duties: a duty named in `devswarm_sup.gate_duties` is not run again while the stat data of the inputs
//! it reads (`devswarm_sup.gate_inputs`) is the same as at its last run, for at most `devswarm_sup.gate_max_unchanged_ms`.
//!
//! A duty is only ever armed by a quiet run (see [`quiet`]): while a workspace is stale or a notice is parked, the
//! next tick has real work (nudge windows, retries) whatever the files say, so the duty keeps running every tick.
//!
//! The gate only ever DELAYS a duty, by at most that bound: a tick that does run recomputes everything from fresh inputs, so a
//! skipped tick can never cause a wrong action, only a later one. The inputs are file and directory stat data (name, size,
//! modification time, inode; a database's `-shm` index is left out, it changes whenever anyone opens the database). Outputs of the
//! duties are not inputs. The memory is per process: after a restart every duty runs once.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this module is a deliberate keep, for these reasons:
// - an unreadable input is the same as an absent one: it changes the signature the way its appearance would
use super::tick::Ctx;
use crate::defaults;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::os::unix::fs::MetadataExt;
use std::path::Path;
use std::sync::{LazyLock, Mutex};

/// Per home and duty: the signature taken before its last run and when that run was (the home is part of the key: two homes
/// with the same, possibly empty, inputs must not share a memory).
static LAST: LazyLock<Mutex<HashMap<String, (u64, i64)>>> = LazyLock::new(Default::default);

fn last() -> std::sync::MutexGuard<'static, HashMap<String, (u64, i64)>> {
    LAST.lock().unwrap_or_else(|e| e.into_inner())
}

/// How long `duty` may go unrun while its inputs are unchanged; 0 when it is not gated.
fn key(home: &Path, duty: &str) -> String {
    format!("{}\u{0}{duty}", home.display())
}

fn max_unchanged_ms(duty: &str) -> i64 {
    if !defaults::list("devswarm_sup.gate_duties").contains(&duty) {
        return 0;
    }
    defaults::raw("devswarm_sup.gate_max_unchanged_ms").get(duty).and_then(defaults::V::as_integer).unwrap_or(0).max(0)
}

fn stat<H: Hasher>(h: &mut H, name: &str, md: Option<std::fs::Metadata>) {
    name.hash(h);
    match md {
        Some(m) => (m.mtime(), m.mtime_nsec(), m.len(), m.ino()).hash(h),
        None => 0u8.hash(h),
    }
}

fn ignored(name: &str) -> bool {
    defaults::list("devswarm_sup.gate_ignore_suffixes").iter().any(|s| name.ends_with(s))
}

/// The stat data of a directory's entries, in name order.
fn dir_entries<H: Hasher>(h: &mut H, dir: &Path, depth: u32) {
    let mut rows: Vec<(String, Option<std::fs::Metadata>)> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| e.file_name().into_string().ok().map(|n| (n, e.metadata().ok())))
        .filter(|(n, _)| !ignored(n))
        .collect();
    rows.sort_by(|a, b| a.0.cmp(&b.0));
    for (name, md) in rows {
        let is_dir = md.as_ref().is_some_and(std::fs::Metadata::is_dir);
        if is_dir {
            // a directory's own modification time moves when an ignored file (a -shm) appears in it: its name and its contents count
            name.hash(h);
            if depth > 0 {
                dir_entries(h, &dir.join(&name), depth - 1);
            }
        } else {
            stat(h, &name, md);
        }
    }
}

/// The signature of `duty`'s inputs now, `None` when the duty is not gated.
pub fn signature(duty: &str, ctx: &Ctx) -> Option<u64> {
    if max_unchanged_ms(duty) == 0 {
        return None;
    }
    let mut h = std::collections::hash_map::DefaultHasher::new();
    // what the duty is told besides the files: who pokes, the settings in force (a config reload) and the environment's own
    // anti-hall switches. A change of any of them runs the duty at once.
    (ctx.engine_pokes, defaults::generation()).hash(&mut h);
    let mut env: Vec<(&String, &String)> = ctx.st.env.iter().filter(|(k, _)| k.starts_with(defaults::text("devswarm_sup.gate_env_prefix"))).collect();
    env.sort();
    env.hash(&mut h);
    for spec in defaults::raw("devswarm_sup.gate_inputs").get(duty)?.strings() {
        spec.hash(&mut h);
        let (kind, rel) = spec.split_once(':').unwrap_or((spec, ""));
        let sub = defaults::list("devswarm_sup.gate_subdir_depth");
        let depth = u32::from(sub.contains(&kind));
        match kind {
            "appdb" => {
                if let Some(db) = crate::meshw::ident::app_db_path(ctx.home, &ctx.st.env) {
                    let sfxs = ["", "-wal"];
                    for sfx in sfxs {
                        let p = format!("{db}{sfx}");
                        stat(&mut h, &p, std::fs::metadata(&p).ok());
                    }
                }
            }
            "ds-dir" | "ds-tree" => dir_entries(&mut h, &super::root(ctx.home).join(rel), depth),
            "home-dir" | "home-tree" => dir_entries(&mut h, &ctx.home.join(rel), depth),
            "home-file" => {
                let p = ctx.home.join(rel);
                stat(&mut h, rel, std::fs::metadata(&p).ok());
            }
            other => other.hash(&mut h), // an unknown kind never matches anything: the duty is gated on nothing
        }
    }
    Some(h.finish())
}

/// Why `duty` is not run this tick, or `None` when it is. `sig` is its signature now ([`signature`]).
pub fn skip(home: &Path, duty: &str, sig: Option<u64>, now: i64) -> Option<String> {
    let sig = sig?;
    let max = max_unchanged_ms(duty);
    let (prev, at) = *last().get(&key(home, duty))?;
    (prev == sig && now - at < max).then(|| defaults::render("devswarm_sup.msg_gate_unchanged", &[("age", &((now - at) / 1000)), ("max", &(max / 1000))]))
}

/// Whether the record of a run left nothing that the next tick would have to act on: the duty ran, and for the liveness sweep no
/// workspace is stale, no forced parent notice was due and no notice is parked. Workspaces handed to Node (tail work, deferrals) do
/// not disarm the gate: on a real machine some are always there, and Node's work on them is a function of the files above and of
/// the clock, so the bound is what limits its delay.
pub fn quiet(duty: &str, rec: &serde_json::Value) -> bool {
    if rec.get("outcome").and_then(serde_json::Value::as_str) != Some("ran") {
        return false;
    }
    if duty != "verdicts" {
        return true;
    }
    let d = rec.get("detail").unwrap_or(&serde_json::Value::Null);
    let n = |k: &str| d.get(k).and_then(serde_json::Value::as_u64).unwrap_or(1);
    let len = |k: &str| d.get(k).and_then(serde_json::Value::as_array).map_or(1, Vec::len);
    n("stale") == 0 && len("forced") == 0 && d.get("drain").and_then(serde_json::Value::as_bool) == Some(false)
}

/// Remember that `duty` ran at `now` with the inputs of `sig` (taken before the run).
pub fn remember(home: &Path, duty: &str, sig: Option<u64>, now: i64) {
    if let Some(sig) = sig {
        last().insert(key(home, duty), (sig, now));
    }
}

/// Forget every memory (tests).
pub fn reset() {
    last().clear();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::checks::git::util::Settings;

    fn ctx_for<'a>(home: &'a Path, st: &'a Settings) -> Ctx<'a> {
        Ctx { home, root: home, st, now: 0, engine_pokes: true }
    }

    fn settings() -> Settings {
        Settings { home: String::new(), env: Default::default() }
    }

    #[test]
    fn a_duty_runs_when_an_input_changes_and_otherwise_waits_for_its_bound() {
        crate::defaults::init().unwrap();
        reset();
        let d = crate::db::TempDir::new("sup-gate");
        let home = d.0.join("home");
        let ws = super::super::root(&home).join("workspaces");
        std::fs::create_dir_all(&ws).unwrap();
        std::fs::write(ws.join("a.json"), "{}").unwrap();
        let st = settings();
        let ctx = ctx_for(&home, &st);
        let max = max_unchanged_ms("app_sync");
        assert!(max > 0, "app_sync is gated by the shipped settings");
        let sig = signature("app_sync", &ctx);
        assert!(sig.is_some());
        assert_eq!(skip(&home, "app_sync", sig, 1_000), None, "never run yet: due");
        remember(&home, "app_sync", sig, 1_000);
        assert!(skip(&home, "app_sync", signature("app_sync", &ctx), 2_000).is_some(), "nothing changed, inside the bound: skipped");
        assert_eq!(skip(&home, "app_sync", signature("app_sync", &ctx), 1_000 + max), None, "the bound passed: due though nothing changed");
        std::fs::write(ws.join("b.json"), "{}").unwrap();
        assert_eq!(skip(&home, "app_sync", signature("app_sync", &ctx), 2_000), None, "a new descriptor: due at once");
        remember(&home, "app_sync", signature("app_sync", &ctx), 2_000);
        std::fs::write(ws.join("a.json"), "{\"x\":1}").unwrap();
        assert_eq!(skip(&home, "app_sync", signature("app_sync", &ctx), 3_000), None, "a changed descriptor: due at once");
    }

    #[test]
    fn the_shared_memory_index_of_a_database_is_not_an_input() {
        crate::defaults::init().unwrap();
        reset();
        let d = crate::db::TempDir::new("sup-gate-shm");
        let home = d.0.join("home");
        let store = super::super::root(&home).join("store").join("k1");
        std::fs::create_dir_all(&store).unwrap();
        std::fs::write(store.join("devswarm.db"), "x").unwrap();
        let st = settings();
        let ctx = ctx_for(&home, &st);
        let before = signature("retention", &ctx).unwrap();
        std::fs::write(store.join("devswarm.db-shm"), "touched by a reader's open").unwrap();
        assert_eq!(signature("retention", &ctx).unwrap(), before, "a reader opening the store must not wake the gate");
        std::fs::write(store.join("devswarm.db-wal"), "a commit").unwrap();
        assert_ne!(signature("retention", &ctx).unwrap(), before, "a commit (the -wal) does");
    }

    #[test]
    fn who_pokes_and_the_environment_switches_are_part_of_the_signature() {
        crate::defaults::init().unwrap();
        let d = crate::db::TempDir::new("sup-gate-env");
        let home = d.0.join("home");
        std::fs::create_dir_all(&home).unwrap();
        let st = settings();
        let a = signature("app_sync", &ctx_for(&home, &st)).unwrap();
        let mut ctx = ctx_for(&home, &st);
        ctx.engine_pokes = false;
        assert_ne!(signature("app_sync", &ctx).unwrap(), a, "the duty is told who pokes");
        let mut st2 = settings();
        st2.env.insert("ANTIHALL_DEVSWARM_SUP_WITNESS".into(), "off".into());
        assert_ne!(signature("app_sync", &ctx_for(&home, &st2)).unwrap(), a, "a switch in the environment");
        st2.env.insert("UNRELATED".into(), "x".into());
        let b = signature("app_sync", &ctx_for(&home, &st2)).unwrap();
        st2.env.insert("UNRELATED".into(), "y".into());
        assert_eq!(signature("app_sync", &ctx_for(&home, &st2)).unwrap(), b, "other variables are not inputs");
    }

    #[test]
    fn a_duty_that_is_not_gated_never_skips() {
        crate::defaults::init().unwrap();
        reset();
        assert_eq!(max_unchanged_ms("log_rotate"), 0);
        let home = Path::new("/h");
        remember(home, "log_rotate", Some(7), 1);
        assert_eq!(skip(home, "log_rotate", Some(7), 2), None);
    }
}
