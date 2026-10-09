//! The non-acting Node witness for the native supervisor duties (owner rule: the engine decides and acts, Node only watches).
//!
//! For a duty the engine ran natively, the witness runs Node's OWN function for the same duty in a scratch HOME against a
//! scratch MIRROR of the inputs (names, sizes and modification times, never contents, so a large directory costs nothing and
//! no user data is copied), then compares what Node would have done with what the engine did. The live tree is never given
//! to Node. One JSON line per comparison goes to `devswarm_sup.witness_file` (`match: false` lines are the mismatches), and
//! each duty is sampled at most every `devswarm_sup.witness_every_ms`, so the cost of watching stays bounded.
//!
//! The mirror is taken BEFORE the engine acts (the engine's own removals change the live tree) and compared after.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this module is a deliberate keep, for these reasons:
// - the witness is advisory: a mirror or log write that fails only loses a comparison, never changes what the engine did
// - an unreadable state file is the absent one (the duty is due)
use super::tick::{Ctx, node};
use crate::defaults;
use crate::dsact::runner::Runner;
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

/// A comparison waiting for the engine's duty to finish.
pub struct Job {
    /// The duty.
    pub duty: String,
    /// The scratch HOME the mirror lives in (removed by [`finish`]).
    pub scratch: PathBuf,
    /// What was mirrored, for the duty's comparison (names of files the mirror holds, or the sizes).
    pub facts: Value,
    /// Node reads the LIVE home (read-only, with every write blocked by its own wrapper) instead of the scratch one: for a
    /// duty whose inputs are too many to mirror and whose Node function writes nothing but what the wrapper drops.
    pub live: bool,
}

fn witness_dir(home: &Path) -> PathBuf {
    home.join(defaults::text("devswarm_sup.witness_dir"))
}

fn state_path(home: &Path) -> PathBuf {
    home.join(defaults::text("devswarm_sup.witness_state"))
}

/// Whether the witness is switched on (`devswarm_sup.witness`).
pub fn enabled(ctx: &Ctx) -> bool {
    super::setting(ctx.st, "devswarm_sup.set_witness").as_str().is_some_and(|m| m != defaults::text("devswarm_sup.witness_off"))
}

/// Whether `duty` is due for a comparison, stamping the time when it is (so a crash never repeats it in a loop).
pub fn due(ctx: &Ctx, duty: &str) -> bool {
    if !enabled(ctx) {
        return false;
    }
    let p = state_path(ctx.home);
    let mut state: serde_json::Map<String, Value> = std::fs::read_to_string(&p).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    let last = state.get(duty).and_then(Value::as_i64).unwrap_or(0);
    if last != 0 && ctx.now >= last && ctx.now - last < defaults::num("devswarm_sup.witness_every_ms") as i64 {
        return false;
    }
    state.insert(duty.to_string(), json!(ctx.now));
    if let Some(d) = p.parent() {
        crate::discard::harmless(std::fs::create_dir_all(d)); // keep: the witness is advisory
    }
    crate::discard::harmless(crate::atomic::write(&p, Value::Object(state).to_string())); // keep: a lost stamp only repeats a comparison
    true
}

/// A fresh scratch HOME for one comparison.
pub fn scratch(ctx: &Ctx, duty: &str) -> Option<PathBuf> {
    let dir = witness_dir(ctx.home).join(format!("{duty}-{}-{}", ctx.now, std::process::id()));
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

/// Copy the shape of `src` (names, sizes, modification times, one level of sub-directories) into `dst` as empty or sparse
/// files, taking at most `cap` files, oldest first. Returns the relative names mirrored, or `None` when `src` held more
/// than `cap` (the comparison is then skipped, never partial).
pub fn mirror_dir(src: &Path, dst: &Path, cap: usize, mut keep: impl FnMut(&str, &std::fs::Metadata) -> bool) -> Option<BTreeSet<String>> {
    let mut found: Vec<(String, std::fs::Metadata)> = Vec::new();
    let mut stack = vec![(src.to_path_buf(), 0u64)];
    while let Some((d, depth)) = stack.pop() {
        for e in std::fs::read_dir(&d).ok().into_iter().flatten().flatten() {
            let Ok(md) = std::fs::metadata(e.path()) else { continue };
            if md.is_dir() {
                // the sweep never follows a link to a directory, so neither does the mirror
                if depth < defaults::num("devswarm_sup.hk_max_depth") && !std::fs::symlink_metadata(e.path()).is_ok_and(|l| l.file_type().is_symlink()) {
                    stack.push((e.path(), depth + 1));
                }
            } else {
                let rel = e.path().strip_prefix(src).map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
                if keep(&rel, &md) {
                    found.push((rel, md));
                }
            }
        }
    }
    if found.len() > cap {
        return None;
    }
    let mut names = BTreeSet::new();
    for (rel, md) in found {
        let to = dst.join(&rel);
        if let Some(parent) = to.parent() {
            crate::discard::harmless(std::fs::create_dir_all(parent)); // keep: a failed copy shows up as a mismatch
        }
        let ok = std::fs::File::create(&to).and_then(|f| {
            f.set_len(md.len())?;
            f.set_modified(std::time::UNIX_EPOCH + std::time::Duration::new(md.mtime().max(0) as u64, md.mtime_nsec().max(0) as u32))
        });
        if ok.is_ok() {
            names.insert(rel);
        }
    }
    Some(names)
}

fn append(ctx: &Ctx, rec: &Value) {
    crate::dsact::exec::append_line(&ctx.home.join(defaults::text("devswarm_sup.witness_file")), rec);
}

/// Run Node's function for the duty on the mirror and compare it with what the engine did. Appends the record and returns it.
/// The scratch tree is removed afterwards (it only ever holds the empty mirror).
pub fn finish(job: Job, ctx: &Ctx, runner: &dyn Runner, engine: &Value) -> Value {
    let sctx = Ctx { home: if job.live { ctx.home } else { &job.scratch }, ..ctx.clone() };
    let d = defaults::raw(&format!("devswarm_sup.duty.{}", job.duty));
    let snippet = d.str_field("witness_snippet");
    let args = witness_args(&job, ctx);
    let argv: Vec<&str> = args.iter().map(String::as_str).collect();
    let timeout = d.get("witness_timeout_ms").or_else(|| d.get("timeout_ms")).and_then(crate::defaults::V::as_integer).unwrap_or(0).max(1) as u64;
    let r = node(runner, &sctx, snippet, &argv, timeout);
    let mut rec = if r.ok {
        let theirs = super::tick::parse(&r.stdout);
        let (agree, detail) = compare(&job, engine, &theirs);
        json!({"duty": job.duty, "match": agree, "engine": engine_view(&job, engine), "node": theirs, "detail": detail})
    } else {
        json!({"duty": job.duty, "match": Value::Null, "error": r.error.unwrap_or_else(|| super::tick::cut(&r.stderr))})
    };
    rec["ts"] = json!(ctx.now);
    append(ctx, &rec);
    crate::discard::harmless(std::fs::remove_dir_all(&job.scratch)); // keep: this is the engine's own scratch mirror (empty and sparse files it created)
    rec
}

fn witness_args(job: &Job, ctx: &Ctx) -> Vec<String> {
    match job.duty.as_str() {
        "housekeeping" => vec![job.facts["days"][0].to_string(), job.facts["days"][1].to_string(), ctx.now.to_string()],
        "log_rotate" => vec![job.facts["threshold"].to_string()],
        "verdicts" => vec![job.facts["spec"].as_str().unwrap_or_default().to_string()],
        _ => vec![ctx.now.to_string()],
    }
}

/// `path` relative to `prefix` (a directory), else the path itself.
fn rel(path: &str, prefix: &str) -> String {
    path.strip_prefix(prefix).unwrap_or(path).trim_start_matches('/').to_string()
}

/// The paths (relative to the DevSwarm state directory) the engine's housekeeping removed.
fn removed_by_engine(job: &Job, engine: &Value) -> BTreeSet<String> {
    let live = job.facts["live"].as_str().unwrap_or_default();
    let mut out = BTreeSet::new();
    if let Some(results) = engine["detail"]["results"].as_object() {
        for rows in results.values().filter_map(Value::as_array) {
            for r in rows {
                if r["status"] == defaults::text("devswarm_sup.hk_status_fixed") {
                    out.insert(rel(r["file"].as_str().unwrap_or_default(), live));
                }
            }
        }
    }
    out
}

/// The paths Node's run on the mirror removed, relative to the mirror's state directory.
fn removed_by_node(job: &Job, theirs: &Value) -> BTreeSet<String> {
    let scratch = job.facts["scratch"].as_str().unwrap_or_default();
    theirs
        .as_array()
        .into_iter()
        .flatten()
        .filter(|r| r[0] == defaults::text("devswarm_sup.hk_status_fixed"))
        .filter_map(|r| r[1].as_str())
        .map(|f| rel(f, scratch))
        .collect()
}

fn engine_view(job: &Job, engine: &Value) -> Value {
    match job.duty.as_str() {
        "verdicts" => job.facts["written"].clone(),
        "housekeeping" => json!(removed_by_engine(job, engine)),
        "log_rotate" => engine["detail"]["supervisor"].clone(),
        _ => engine.clone(),
    }
}

fn compare(job: &Job, engine: &Value, theirs: &Value) -> (bool, Value) {
    match job.duty.as_str() {
        "log_rotate" => {
            let e = &engine["detail"]["supervisor"];
            let same = e["rotated"] == theirs["rotated"] && e["size"] == theirs["size"];
            (same, json!({"rotated": [e["rotated"], theirs["rotated"]]}))
        }
        "housekeeping" => {
            let (mine, node_set) = (removed_by_engine(job, engine), removed_by_node(job, theirs));
            let only_engine: Vec<&String> = mine.difference(&node_set).collect();
            let only_node: Vec<&String> = node_set.difference(&mine).collect();
            (only_engine.is_empty() && only_node.is_empty(), json!({"onlyEngine": only_engine, "onlyNode": only_node}))
        }
        "verdicts" => {
            // byte for byte: the text the engine wrote against the text Node's own computation gives, per workspace
            let mut wrong = Vec::new();
            for (id, mine) in job.facts["written"].as_object().into_iter().flatten() {
                if theirs.get(id) != Some(mine) {
                    wrong.push(json!({"id": id, "engine": mine, "node": theirs.get(id)}));
                }
            }
            (wrong.is_empty(), json!({"differs": wrong}))
        }
        _ => (false, Value::Null),
    }
}

/// The witness for the native liveness sweep, prepared AFTER the engine wrote its verdicts: the previous verdict text of each
/// workspace (what Node's own computation would have read) goes to a spec file; Node then recomputes every verdict read-only
/// against the live data (its file wrapper serves the old text and drops every write) and the two texts are compared.
pub fn prepare_verdicts(ctx: &Ctx, out: &super::liveness::Outcome, t: super::liveness::Thresholds) -> Option<Job> {
    if !due(ctx, "verdicts") {
        return None;
    }
    let scratch = scratch(ctx, "verdicts")?;
    let cap = defaults::num("devswarm_sup.lv_witness_max_ids") as usize;
    let mut items = Vec::new();
    let mut written = serde_json::Map::new();
    for ((id, prev), (wid, text)) in out.prev.iter().zip(out.written.iter()).take(cap) {
        items.push(json!({"id": id, "prev": prev}));
        written.insert(wid.clone(), Value::String(text.clone()));
    }
    let spec = scratch.join(defaults::text("devswarm_sup.lv_spec_file"));
    let body = json!({"now": ctx.now, "idleMs": t.idle_ms, "nudgeWindowMs": t.nudge_window_ms, "items": items});
    if std::fs::write(&spec, body.to_string()).is_err() {
        crate::discard::harmless(std::fs::remove_dir_all(&scratch)); // keep: our own empty scratch
        return None;
    }
    Some(Job { duty: "verdicts".to_string(), scratch, facts: json!({"spec": spec.to_string_lossy(), "written": Value::Object(written)}), live: true })
}

/// The witness mirror of the supervisor log, taken before the rotation: a sparse file of the same size at Node's path in a
/// scratch HOME, so Node's `rotateSupervisorLogIfNeeded` judges the same size against the same threshold.
pub fn prepare_log_rotate(ctx: &Ctx) -> Option<Job> {
    let scratch = scratch(ctx, "log_rotate")?;
    let live = super::node_logs(ctx.home)[0].clone();
    let threshold = super::setting(ctx.st, "devswarm_sup.set_log_rotate_bytes").as_u64()?;
    if let Ok(md) = std::fs::metadata(&live) {
        let to = super::node_logs(&scratch)[0].clone();
        crate::discard::harmless(std::fs::create_dir_all(to.parent()?)); // keep: a failed mirror shows up as a mismatch
        crate::discard::harmless(std::fs::File::create(&to).and_then(|f| f.set_len(md.len()))); // keep: same
    }
    Some(Job { duty: "log_rotate".to_string(), scratch, facts: json!({"threshold": threshold}), live: false })
}
