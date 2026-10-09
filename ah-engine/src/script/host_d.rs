//! Host primitives of D88 batch 6 (generic, no rules): facts a check script cannot read for itself because the reading is
//! bounded, shared or exact in a way only the engine can be. Like the rest of `ahHost` they hold no rule, text, threshold or
//! decision: a script decides, these only extract what it asks for.
//!
//! | raw function | what it does |
//! |---|---|
//! | `transcriptTasks(path, variant, window, wide)` | the task list of a transcript tail, rebuilt exactly as the Node hooks rebuild it: see [`transcript_tasks`] |
//! | `agentScan(path, tailBytes, ignoreUnansweredStops)` | every agent a transcript tail shows launched, with its times, output file, the ids with terminal evidence and the teammates with a message not yet answered: see [`agent_scan`] |
//! | `jevRecordOutcome(id, hash, outcome, source, projectFrom)` | report a later observed result against a Jev decision by hash: see [`jev_record_outcome`] |
//! | `jevEnabled()` | whether the Jev master switch is on for this request (an integration can still be off) |
//! | `jevCacheHas(hash)` | whether the shared Jev answer cache holds an answer under `hash` (`null` when the file is one only JavaScript reads) |
//! | `pluginVersions(root)` | the version of the plugin at `root` and the one the host registered: see [`plugin_versions`] |
//! | `homeGuard()` | the home directory state files may live under: `{status: "ok" \| "guarded" \| "unknown", home}`: see [`home_guard`] |
//! | `projectRoot(cwd)` | the project root of a working directory as the handover finder resolves it, or `null`: see [`project_root`] |
//! | `repoRoot(cwd)` | the git work tree around an absolute directory (the directory itself when there is none), or `null`: see [`repo_root`] |
//! | `dateParse(text)` | what V8's `Date.parse` makes of a text under the request's time zone: `{ms}`, `{nan}` or `{unsure}`: see [`date_parse`] |
//! | `readEnd(path, bytes)` | the last `bytes` bytes of a file as text, no line handling: see [`read_end`] |
//! | `isExecutable(path)` | a regular file this process may execute |
//! | `uid()` | the process's user id (`process.getuid()`) |
//! | `cores()` | the CPU count as Node's `os.availableParallelism()` reads it, or `null` when the engine cannot read it the same way |
use super::host::with_settings;
use crate::checks::agent_scan::{self, Opts};
use crate::checks::taskstate::{
    Task, Variant,
    backfill::backfill,
    parse::reconstruct,
    scanview,
    tail::{lines_of, read_tail},
};
use crate::defaults;
use rquickjs::{Ctx, Function, Object};
use serde_json::{Value, json};

/// A task as JSON: `status` is `null` when unknown, `blockedOn` is absent when it was never set (and `null` when it was set to
/// `null`), `sinceMs` is a number, `null` (unknown) or the string `"unsure"` (a time only JavaScript could read).
fn task_json(t: &Task) -> Value {
    use crate::checks::taskstate::Since;
    let mut o = serde_json::Map::new();
    o.insert("id".into(), json!(t.id));
    o.insert("content".into(), json!(t.content));
    o.insert("description".into(), json!(t.description));
    o.insert("status".into(), json!(t.status));
    o.insert("owner".into(), json!(t.owner));
    o.insert("blockedBy".into(), json!(t.blocked_by));
    if let Some(b) = &t.blocked_on {
        o.insert("blockedOn".into(), b.clone());
    }
    o.insert("priority".into(), json!(t.priority));
    o.insert("subjectUpdated".into(), json!(t.subject_updated));
    o.insert(
        "unknown".into(),
        t.unknown.map_or(Value::Null, |u| json!({"status": u.status, "owner": u.owner, "blockedBy": u.blocked_by, "blockedOn": u.blocked_on})),
    );
    o.insert("blockUnknown".into(), json!(t.block_unknown));
    o.insert(
        "sinceMs".into(),
        match t.since {
            Since::Unknown => Value::Null,
            Since::Ms(ms) => json!(ms),
            Since::Unsure => json!("unsure"),
        },
    );
    Value::Object(o)
}

/// `transcriptTasks(path, variant, window, wide)`: JSON text.
///
/// `variant` is `guard` (`task-guard.js` `parseTasksFromFile`), `state` (`lib/task-state.js` `reconstructTasks`) or `scan` (the
/// task part of `tasklist-guard.js` `scanTranscript`). `window` is the tail read in bytes; a cut tail is completed from before the
/// window the way `lib/task-subject-backfill.js` does (a bounded, exact scan; where Node's clock would decide, the answer is
/// `unsure`). `wide` is only read by `scan`: the widened window searched for task activity when a cut tail holds none.
///
/// - `guard` and `state`: `{"tasks":[...], "windowReset":bool, "firstCreated":number|null, "truncated":bool}` in the order a
///   JavaScript `Map` would hold them, or `{"tasks":[],"unreadable":true}` when the file cannot be read;
/// - `scan`: `{"sawTaskActivity", "taskStoreReset", "inProgressCount", "openTaskIds":[...]}`, or `{"quiet":true}` when the Node
///   hook would end silently (a JSON `null` entry makes it throw), or `{"unreadable":true}` when the file cannot be read;
/// - any variant: `{"unsure":true}` when a record or value only JavaScript could read exactly was met.
pub fn transcript_tasks(path: &str, variant: &str, window: f64, wide: f64) -> String {
    let unsure = || json!({"unsure": true}).to_string();
    let window = if window.is_finite() && window > 0.0 { window as u64 } else { defaults::num("taskstate.tail_bytes") };
    if variant == "scan" {
        if std::fs::metadata(path).is_err() {
            return json!({"unreadable": true}).to_string();
        }
        let wide = if wide.is_finite() && wide > 0.0 { wide as u64 } else { window };
        return match scanview::scan_tasks(path, window, wide) {
            Err(_) => unsure(),
            Ok(None) => json!({"quiet": true}).to_string(),
            Ok(Some(s)) => json!({
                "sawTaskActivity": s.saw_task_activity,
                "taskStoreReset": s.task_store_reset,
                "inProgressCount": s.in_progress_count,
                "openTaskIds": s.open_task_ids,
            })
            .to_string(),
        };
    }
    let v = if variant == "state" { Variant::State } else { Variant::Guard };
    let Some((data, truncated)) = read_tail(path, window) else { return json!({"tasks": [], "unreadable": true}).to_string() };
    let lines = lines_of(&data, truncated);
    let Ok(mut facts) = reconstruct(&lines, v) else { return unsure() };
    if truncated && backfill(&mut facts, path, window).is_err() {
        return unsure();
    }
    json!({
        "tasks": facts.tasks.values().map(task_json).collect::<Vec<_>>(),
        "windowReset": facts.window_reset,
        "firstCreated": if facts.first_created.is_finite() { json!(facts.first_created) } else { Value::Null },
        "truncated": truncated,
    })
    .to_string()
}

/// One launched agent as JSON (`NaN` times are `null`).
pub fn rec_json(id: &str, r: &agent_scan::Rec) -> Value {
    json!({
        "id": id,
        "adopted": r.adopted,
        "outputFile": r.output_file,
        "description": r.description,
        "launchedAtMs": r.launched_at_ms,
        "toolUseId": r.tool_use_id,
        "resumedAtMs": r.resumed_at_ms,
        "teammate": r.teammate,
        "lastSeenMs": r.last_seen_ms,
        "pendingMessage": r.pending_message,
        "taskType": r.task_type,
        "spawnInput": r.spawn_input,
    })
}

/// `agentScan(path, tailBytes, ignoreUnansweredStops)`: JSON text. `{"launched":[...], "terminal":[ids], "pending":[...]}`: every
/// launched, adopted and live teammate agent in launch order; the ids whose terminal evidence stands; the teammates sent a message
/// they have not reported on since (`{"name","agentId","sentAtMs","lastIdleMs","lastSeenMs","live"}`, a time that is unknown is
/// `null`). With `ignoreUnansweredStops` a `TaskStop` call with no result yet is not counted as stopping. `null` when the transcript
/// cannot be read, `{"unsure":true}` when it holds something only JavaScript could read (or a relative path).
pub fn agent_scan(path: &str, tail: f64, ignore_unanswered_stops: bool) -> String {
    let tail = if tail.is_finite() && tail > 0.0 { tail as u64 } else { defaults::num("agent_scan.tail_bytes") };
    let opts = Opts { now_ms: super::host::now_ms(), ignore_unanswered_stops };
    match agent_scan::scan_transcript(path, tail, &opts) {
        Err(_) => json!({"unsure": true}).to_string(),
        Ok(None) => "null".into(),
        Ok(Some(scan)) => {
            let launched: Vec<Value> = scan.launched.iter().map(|(id, r)| rec_json(id, r)).collect();
            let mut terminal: Vec<&String> = scan.terminal.iter().collect();
            terminal.sort();
            let fin = |x: f64| if x.is_finite() { json!(x) } else { Value::Null };
            let pending: Vec<Value> = scan
                .pending
                .iter()
                .map(|(name, p)| json!({"name": name, "agentId": p.agent_id, "sentAtMs": fin(p.sent_at_ms), "lastIdleMs": fin(p.last_idle_ms), "lastSeenMs": fin(p.last_seen_ms), "live": p.live}))
                .collect();
            json!({"launched": launched, "terminal": terminal, "pending": pending}).to_string()
        }
    }
}

/// `jevRecordOutcome(id, hash, outcome, source, projectFrom)`: a row in the Jev decision log joining a later observed result to
/// the decision with that hash. Nothing is written for an empty id, hash or outcome. `projectFrom` is a working directory the
/// project label is taken from (the current one when empty).
fn jev_record_outcome(id: &str, hash: &str, outcome: &str, source: Option<String>, project_from: Option<String>) -> rquickjs::Result<()> {
    let (home, env) = with_settings(|st| (st.home.clone(), crate::jev::Env::from_pairs(st.env.clone())))?;
    let project = crate::jev::shared::project_for(project_from.as_deref());
    crate::jev::shared::lane(std::path::Path::new(&home), &env).record_outcome(id, hash, outcome, source.as_deref(), project.as_deref());
    Ok(())
}

/// `jevCacheHas(hash)`: whether the shared Jev answer cache (`cache/jev-assist.json`) stores a truthy entry under `hash`.
fn jev_cache_has(hash: &str) -> rquickjs::Result<Option<bool>> {
    let home = with_settings(|st| st.home.clone())?;
    Ok(crate::jev::cache::FileCache::for_home(std::path::Path::new(&home)).contains(hash))
}

/// `jevEnabled()`: the Jev master switch for this request, through the same settings chain the lane reads.
fn jev_enabled() -> rquickjs::Result<bool> {
    let (home, env) = with_settings(|st| (st.home.clone(), crate::jev::Env::from_pairs(st.env.clone())))?;
    let home = std::path::Path::new(&home);
    Ok(crate::jev::JevSettings::resolve(home, crate::jev::settings::Sources::load(home, env)).enabled)
}

/// `pluginVersions(root)`: JSON `{"running": string|null, "registered": string|null, "unsure": bool}`. `running` is the `version`
/// of the plugin manifest under `root` (null when absent, unreadable, not JSON or without a string version); `registered` is
/// the version the host's plugin registry names for anti-hall, found the way `update.js` finds it (null when none). `unsure` is
/// set when the manifest or the registry holds text only JavaScript could read.
fn plugin_versions(root: &str) -> rquickjs::Result<String> {
    use crate::checks::guardkit::paths::join;
    use crate::checks::session::jval::{J, Parsed, parse};
    let (home, env) = with_settings(|st| (st.home.clone(), crate::reqenv::RequestEnv::from_pairs(st.env.clone())))?;
    let mut unsure = false;
    let registered = match crate::checks::session::version_alert::harness_version(&env, &home) {
        Ok(v) => v,
        Err(()) => {
            unsure = true;
            None
        }
    };
    let mut running = None;
    if !root.is_empty()
        && let Ok(bytes) = std::fs::read(join(root, defaults::text("session.plugin_json")))
    {
        let text = crate::checks::guardkit::text::lossy_owned(bytes);
        match parse(text.strip_prefix('\u{feff}').unwrap_or(&text)) {
            Parsed::Ok(v) => running = v.get("version").and_then(J::as_str).map(str::to_string),
            Parsed::Bad => {}
            Parsed::Unsure => unsure = true,
        }
    }
    Ok(json!({"running": running, "registered": registered, "unsure": unsure}).to_string())
}

/// `os.availableParallelism()` where the engine reads it the way libuv does: `sysconf(_SC_NPROCESSORS_ONLN)` on macOS, the
/// affinity mask on Linux (only when no CPU quota lowers Rust's answer below it, since libuv versions differ on quotas). `None`
/// when it cannot be read exactly like that.
fn cores() -> Option<f64> {
    let rust = std::thread::available_parallelism().ok()?.get() as f64;
    if cfg!(target_os = "macos") {
        return Some(rust);
    }
    #[cfg(target_os = "linux")]
    {
        // SAFETY: `set` is a zeroed cpu_set_t owned by this frame; sched_getaffinity writes at most its size.
        let affinity = unsafe {
            let mut set: libc::cpu_set_t = std::mem::zeroed();
            if libc::sched_getaffinity(0, std::mem::size_of::<libc::cpu_set_t>(), &mut set) != 0 {
                return None;
            }
            libc::CPU_COUNT(&set) as f64
        };
        if affinity == rust {
            return Some(rust);
        }
    }
    None
}

/// `homeGuard()`: JSON `{status, home}` for the request's home directory, as `companion/lib/test-home-guard.js` `resolveHome` decides
/// it. `ok` (an absolute home): state files live under `home`; `guarded` (a test run whose home is the real user home): Node's
/// `resolveHome` throws and its callers catch it, so no state is read or written; `unknown` (no usable `HOME`): Node would ask the
/// system or resolve against its own working directory, which the engine cannot see.
fn home_guard() -> rquickjs::Result<String> {
    use crate::checks::spawnctx::{Home, state_home};
    let env = with_settings(|st| st.env.clone())?;
    Ok(match state_home(&env) {
        Home::Ok(h) => json!({"status": "ok", "home": h}),
        Home::Guarded => json!({"status": "guarded"}),
        Home::Unknown => json!({"status": "unknown"}),
    }
    .to_string())
}

/// `projectRoot(cwd)`: the outermost superproject's work tree around an absolute `cwd` (`sessionProjectRoot` of
/// `hooks/lib/handover-find.js`), `cwd` itself when no checkout encloses it or it is gone; `null` when the answer would depend on
/// the Node process's own working directory, on git, or on a `core.worktree` setting.
fn project_root(cwd: &str) -> rquickjs::Result<Option<String>> {
    let home = with_settings(|st| st.home.clone())?;
    Ok(crate::checks::taskkit::root::session_project_root(cwd, &home))
}

/// `repoRoot(cwd)`: the git work tree around an absolute directory, or `cwd` itself when there is none, when the directory does not exist,
/// when it lies inside the git directory, or when the work tree found is the home directory; `null` for a relative `cwd` (Node would
/// resolve it against its own directory) or a request with no home. Facts only: which file a check writes there is the script's.
fn repo_root(cwd: &str) -> rquickjs::Result<Option<String>> {
    let home = with_settings(|st| st.home.clone())?;
    Ok(crate::checks::taskkit::root::repo_root(cwd, &home))
}

/// `dateParse(text)`: what V8's `Date.parse` makes of `text` under the request's time zone, as JSON: `{"ms": n}`, `{"nan": true}`, or
/// `{"unsure": true}` for a string whose V8 reading the engine does not reproduce (or a zone-less one when the request's `TZ` is not
/// the engine's own). Facts only: what a date means to a rule is the script's.
fn date_parse(text: &str) -> rquickjs::Result<String> {
    use crate::checks::jsport::date::{Parsed, ZoneGuard, parse};
    let env = with_settings(|st| crate::reqenv::RequestEnv::from_pairs(st.env.clone()))?;
    let _zone = ZoneGuard::new(&env);
    Ok(match parse(text) {
        Parsed::Ms(ms) => json!({"ms": ms}),
        Parsed::Nan => json!({"nan": true}),
        Parsed::Unknown => json!({"unsure": true}),
    }
    .to_string())
}

/// `readEnd(path, bytes)`: the last `bytes` bytes of a file (all of it when smaller; at most `script.tail_max_bytes`) as text, the bytes
/// that are not UTF-8 replaced; no line handling at all. `null` when the file cannot be read.
fn read_end(path: &str, bytes: f64) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    let cap = defaults::num("script.tail_max_bytes");
    let want = if bytes.is_finite() && bytes > 0.0 { (bytes as u64).min(cap) } else { cap };
    let mut f = std::fs::File::open(path).ok()?;
    let size = f.metadata().ok()?.len();
    let len = size.min(want);
    f.seek(SeekFrom::Start(size - len)).ok()?;
    let mut buf = vec![0u8; len as usize];
    f.read_exact(&mut buf).ok()?;
    Some(crate::checks::guardkit::text::lossy_owned(buf))
}

/// Add the batch-6 functions to `ahHost`.
pub fn install<'a>(c: &Ctx<'a>, h: &Object<'a>) -> rquickjs::Result<()> {
    h.set("transcriptTasks", Function::new(c.clone(), |p: String, v: String, w: f64, wide: f64| transcript_tasks(&p, &v, w, wide))?)?;
    h.set("agentScan", Function::new(c.clone(), |p: String, t: f64, ignore: Option<bool>| agent_scan(&p, t, ignore.unwrap_or(false)))?)?;
    h.set(
        "jevRecordOutcome",
        Function::new(c.clone(), |id: String, hash: String, outcome: String, source: Option<String>, project: Option<String>| {
            jev_record_outcome(&id, &hash, &outcome, source, project)
        })?,
    )?;
    // documented with the batch-5 host API (ah.state.readText / remove / sweep) but never installed
    h.set(
        "stateRead",
        Function::new(c.clone(), |rel: String| -> rquickjs::Result<Option<String>> {
            let home = with_settings(|st| st.home.clone())?;
            super::host::state_read(&home, &rel)
        })?,
    )?;
    h.set(
        "stateRemove",
        Function::new(c.clone(), |rel: String| -> rquickjs::Result<bool> {
            let home = with_settings(|st| st.home.clone())?;
            super::host::state_remove(&home, &rel)
        })?,
    )?;
    h.set(
        "stateSweep",
        Function::new(c.clone(), |dir: String, prefix: String, age: f64, max: f64| -> rquickjs::Result<f64> {
            let home = with_settings(|st| st.home.clone())?;
            super::host::state_sweep(&home, &dir, &prefix, age, max)
        })?,
    )?;
    h.set("jevEnabled", Function::new(c.clone(), jev_enabled)?)?;
    h.set("jevCacheHas", Function::new(c.clone(), |hash: String| jev_cache_has(&hash))?)?;
    h.set("pluginVersions", Function::new(c.clone(), |root: String| plugin_versions(&root))?)?;
    h.set("cores", Function::new(c.clone(), cores)?)?;
    // the engine's one clock (`ah.clock.now()`): documented with the batch-5 host API, which shaped it but never installed it
    h.set("now", Function::new(c.clone(), super::host::now_ms)?)?;
    h.set("homeGuard", Function::new(c.clone(), home_guard)?)?;
    h.set("projectRoot", Function::new(c.clone(), |cwd: String| project_root(&cwd))?)?;
    h.set("repoRoot", Function::new(c.clone(), |cwd: String| repo_root(&cwd))?)?;
    h.set("dateParse", Function::new(c.clone(), |text: String| date_parse(&text))?)?;
    h.set("readEnd", Function::new(c.clone(), |path: String, bytes: f64| read_end(&path, bytes))?)?;
    h.set(
        "isExecutable",
        Function::new(c.clone(), |path: String| crate::checks::jsport::fsx::is_file(&path) && crate::checks::jsport::fsx::is_executable(&path))?,
    )?;
    h.set("uid", Function::new(c.clone(), || f64::from(crate::checks::jsport::home::uid()))?)?;
    Ok(())
}
