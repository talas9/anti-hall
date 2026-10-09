//! Slice S4: `cmdReconcile` (one project's reconcile), `distinctRepoKeys` and the reconcile sweep's duty
//! (`reconcileSweepIfDue` of `companion/devswarm-supervisor.js`), over the slices below it.
//!
//! * **[`cmd_reconcile`]** drains every workspace registered in one project's store once, in Node's order: re-home stranded
//!   descriptors (handed to Node when there is any), heal the registry ([`super::heal`]), list the rows, put the ids a prior
//!   budget-exhausted run left first (the resume marker), then per row: skip a pruned or archived worktree, a suppressed
//!   repository-unknown row, a path git cannot resolve; defer to the next run when the wall-clock budget is spent; otherwise
//!   drain it ([`super::pull`]: native, witnessed) or, for a workspace the engine does not answer, run Node's own `inbox pull`
//!   subprocess (the spawn `reconcile` makes today), with Node's one retry after a native timeout. Then the display names, the
//!   resume marker and Node's result object.
//! * A project the engine cannot answer as a whole (a stranded descriptor, a registry row that must move to another store, a
//!   store it cannot read like Node) is [`ProjectEnd::Node`]: nothing was written for it that Node's own run would not also
//!   write, and Node's `cmdReconcile` handles it.
//! * **[`duty`]**: the sweep. The engine reads the descriptors, picks the projects ([`distinct_repo_keys`], at most
//!   `devswarm_recon.max_projects_per_tick`), persists the cool-down first, reconciles each project natively, then runs Node's
//!   own `reconcileSweepIfDue` for everything after the reconcile (the mesh fold, the active-workspace probe and its cache, the
//!   start-up sampling and the log line) with the engine's results handed in as the reconcile step's answer. A project whose
//!   reconcile was handed back is reconciled by Node inside that same call.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this module is a deliberate keep, for these reasons:
// - an unreadable optional file is the absent one (Node's try/catch, fail-open)
// - a scratch file that cannot be removed only costs disk
use super::apply::{self, Env};
use super::gate::{self, Job, Verdict};
use super::pull::{self, Stage, Staged};
use super::view::{self, descriptor_of};
use super::{Hooks, Op, Unit, UnitEnd, heal, side};
use crate::checks::guardkit::ojson::OVal;
use crate::checks::guardkit::text::js_trim;
use crate::defaults;
use crate::dsact::runner::Runner;
use crate::dssup::appsync::{plan, snap, state};
use crate::dssup::tick::{Ctx, node, parse};
use crate::meshw::common::Inv;
use crate::meshw::ident::{self, Defer, R, defer};
use crate::meshw::idlock::{devswarm_root, is_safe_id};
use regex::RegexBuilder;
use serde_json::{Map, Value, json};
use std::path::Path;

/// The clock and the limits of one reconcile (Node's `ctx.reconcileNow`, `ctx.reconcileBudgetMs`, the retry backoff), injectable so
/// a test can make a budget exact.
pub struct Opts<'a> {
    /// The total wall-clock budget; `None` reads the environment and the shipped default. `0` is unlimited.
    pub budget_ms: Option<u64>,
    /// The clock, epoch ms.
    pub clock: &'a dyn Fn() -> i64,
    /// The pause before the one retry after a native timeout; `None` is the shipped default.
    pub backoff_ms: Option<u64>,
}

impl Opts<'static> {
    /// The real clock and the configured limits.
    pub fn real() -> Opts<'static> {
        Opts { budget_ms: None, clock: &|| crate::health::now_ms() as i64, backoff_ms: None }
    }
}

/// How one project's reconcile ended.
#[derive(Debug, Clone, PartialEq)]
pub enum ProjectEnd {
    /// Node's `cmdReconcile` result object.
    Result(Value),
    /// The engine did not answer this project; the text says why. Node's `cmdReconcile` does.
    Node(String),
}

// ---- JavaScript value helpers --------------------------------------------------------------------------------------------------

fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// `String(v)` for the values a child's JSON can hold.
fn js_str(v: &Value) -> String {
    match v {
        Value::Null => "null".to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => crate::checks::guardkit::ojson::js_number_text(n.as_f64().unwrap_or(0.0)),
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().map(|x| if x.is_null() { String::new() } else { js_str(x) }).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

/// A JavaScript number as JSON: a whole number prints without a fraction.
fn num(f: f64) -> Value {
    if f.fract() == 0.0 && f.abs() < 9e15 { json!(f as i64) } else { json!(f) }
}

/// `x || 0`.
fn or_zero(v: Option<&Value>) -> Value {
    if truthy(v) { v.cloned().unwrap_or(json!(0)) } else { json!(0) }
}

/// The case-insensitive pattern a defaults key holds; one that does not compile matches nothing (a text then reads as no match).
fn re(key: &str) -> Option<regex::Regex> {
    RegexBuilder::new(defaults::text(key)).case_insensitive(true).build().ok()
}

fn re_match(key: &str, text: &str) -> bool {
    re(key).is_some_and(|r| r.is_match(text))
}

// ---- reading the state the sweep decides from ---------------------------------------------------------------------------------

/// One descriptor the supervisor reads: its id and the two fields it needs.
#[derive(Debug, Clone)]
pub struct Descriptor {
    /// `d.id` (a path-safe string).
    pub id: String,
    /// `d.worktreePath` (truthy).
    pub worktree: String,
}

/// `readDescriptors(home)` of the supervisor: every `workspaces/*.json` that parses and names a worktree, a session and a
/// path-safe id, in directory order. A truthy value of a type the engine does not model is a deferral.
pub fn read_descriptors(home: &Path) -> R<Vec<Descriptor>> {
    let dir = devswarm_root(home).join(defaults::text("mesh_write.dir_workspaces"));
    let Some(mut names) = crate::checks::jsport::fsx::read_dir_names(&dir.to_string_lossy()) else { return Ok(Vec::new()) };
    names.sort_by(|a, b| a.0.cmp(&b.0));
    let suffix = defaults::text("mesh_write.json_suffix");
    let mut out = Vec::new();
    for (name, _) in names {
        if !name.ends_with(suffix) {
            continue;
        }
        let Some(d) = std::fs::read(dir.join(&name)).ok().and_then(|b| OVal::parse(&String::from_utf8_lossy(&b))) else { continue };
        let OVal::Obj(_) = d else { continue };
        let field = |k: &str| match d.get(k) {
            None | Some(OVal::Null) => Ok(None),
            Some(OVal::Str(s)) => Ok((!s.is_empty()).then(|| s.clone())),
            Some(v) if !v.truthy() => Ok(None),
            Some(_) => defer("descriptor-field-type"),
        };
        let (wt, sid) = (field(defaults::text("mesh_write.field_worktree_path"))?, field(defaults::text("mesh_write.field_session_id"))?);
        let id = match d.get(defaults::text("mesh_write.field_id")) {
            Some(OVal::Str(s)) if is_safe_id(s) => s.clone(),
            _ => continue,
        };
        if let (Some(worktree), Some(_)) = (wt, sid) {
            out.push(Descriptor { id, worktree });
        }
    }
    Ok(out)
}

/// A project and one worktree that represents it.
#[derive(Debug, Clone, PartialEq)]
pub struct Project {
    /// The project's key.
    pub repo_key: String,
    /// The representative worktree (the cwd of the project's reconcile).
    pub worktree: String,
}

/// `distinctRepoKeys(descriptors)`: one representative worktree per distinct repo key. Two passes, each descriptor once: first the
/// worktrees that exist (the first to resolve wins), then, for a key no existing worktree gave, the ones that do not.
pub fn distinct_repo_keys(descs: &[Descriptor]) -> R<Vec<Project>> {
    let mut seen: Vec<Project> = Vec::new();
    for pass in [true, false] {
        for d in descs {
            if Path::new(&d.worktree).exists() != pass {
                continue;
            }
            let Some(key) = ident::repo_key_for_worktree(&d.worktree)? else { continue };
            if seen.iter().any(|p| p.repo_key == key) {
                continue;
            }
            seen.push(Project { repo_key: key, worktree: d.worktree.clone() });
        }
    }
    Ok(seen)
}

// ---- the row classification -----------------------------------------------------------------------------------------------------

/// A registry row of the project being reconciled.
#[derive(Debug, Clone)]
struct Target {
    id: String,
    worktree: String,
    session: Option<String>,
}

fn has_archived_counterpart(home: &Path, id: &str) -> bool {
    is_safe_id(id)
        && devswarm_root(home).join(defaults::text("mesh_write.dir_archived")).join(format!("{id}{}", defaults::text("mesh_write.json_suffix"))).exists()
}

/// `String(v)` of a marker's `sessionId`, `None` for null/undefined/empty (`realSid`).
fn real_sid(v: Option<&OVal>) -> R<Option<String>> {
    match v {
        None | Some(OVal::Null) => Ok(None),
        Some(OVal::Str(s)) => Ok((!s.is_empty()).then(|| s.clone())),
        Some(OVal::Num(n)) => Ok(Some(crate::checks::guardkit::ojson::js_number_text(*n))),
        Some(OVal::Bool(b)) => Ok(Some(b.to_string())),
        Some(_) => defer("session-field-type"),
    }
}

fn same_path(a: &str, b: &str) -> bool {
    let real = |p: &str| std::fs::canonicalize(p).map_or_else(|_| p.to_string(), |c| c.to_string_lossy().into_owned());
    !a.is_empty() && !b.is_empty() && real(a) == real(b)
}

/// `isArchivedWorkspace(home, id, worktreePath, {sessionId})`: anti-hall's own archived marker, matched to this worktree and not
/// superseded by a live descriptor of another session.
fn marker_archived(home: &Path, t: &Target) -> R<bool> {
    if !is_safe_id(&t.id) {
        return Ok(false);
    }
    let root = devswarm_root(home);
    let Some(marker) =
        std::fs::read(root.join(defaults::text("mesh_write.dir_archived")).join(format!("{}{}", t.id, defaults::text("mesh_write.json_suffix"))))
            .ok()
            .and_then(|b| OVal::parse(&String::from_utf8_lossy(&b)))
    else {
        return Ok(false);
    };
    let OVal::Obj(_) = marker else { return Ok(false) };
    if !t.worktree.is_empty()
        && let Some(OVal::Str(w)) = marker.get(defaults::text("mesh_write.field_worktree_path"))
        && !w.is_empty()
        && !same_path(w, &t.worktree)
    {
        return Ok(false);
    }
    let sid_key = defaults::text("mesh_write.field_session_id");
    if let Some(marker_sid) = real_sid(marker.get(sid_key))? {
        let live = match &t.session {
            Some(s) if !s.is_empty() => Some(s.clone()),
            _ => match ident::read_descriptor(home, &t.id) {
                Some(d) => real_sid(d.get(sid_key))?,
                None => None,
            },
        };
        if live.is_some_and(|l| l != marker_sid) {
            return Ok(false);
        }
    }
    Ok(true)
}

/// `reconcileRowArchived`: the marker, or the DevSwarm app's own database (which is ground truth when it has a record).
fn row_archived(inv: &Inv, t: &Target) -> R<bool> {
    if marker_archived(&inv.home, t)? {
        return Ok(true);
    }
    let (verdict, _cache) = crate::meshw::appdb::archived_verdict(&inv.home, &inv.env, inv.now, &t.id, Some(&t.worktree), false)?;
    Ok(verdict == Some(true))
}

/// `repoUnknown.rowTerminal`: archived, held by the owner, or archive-ignored.
fn row_terminal(inv: &Inv, t: &Target, held: &std::collections::HashSet<String>) -> R<bool> {
    if row_archived(inv, t)? || held.contains(&t.id) {
        return Ok(true);
    }
    Ok(devswarm_root(&inv.home)
        .join(defaults::text("devswarm_recon.dir_archive_ignore"))
        .join(format!("{}{}", t.id, defaults::text("mesh_write.json_suffix")))
        .exists())
}

/// The git root `git -C <path> rev-parse --show-toplevel` names, bounded; `None` when git fails or prints nothing.
fn git_root(path: &str) -> Option<String> {
    use std::io::Read;
    let args: Vec<String> = defaults::list("devswarm_recon.git_root_args").iter().map(|a| a.replace("{path}", path)).collect();
    let mut child = std::process::Command::new(defaults::text("devswarm_recon.git_bin"))
        .args(&args)
        .current_dir(path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    let end = std::time::Instant::now() + defaults::millis("devswarm_recon.git_timeout_ms");
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) if std::time::Instant::now() < end => std::thread::sleep(defaults::millis("devswarm_recon.git_poll_ms")),
            _ => {
                crate::discard::harmless(child.kill()); // keep: already gone is fine
                crate::discard::harmless(child.wait()); // keep: reaping
                return None;
            }
        }
    };
    let mut out = String::new();
    child.stdout.take()?.read_to_string(&mut out).ok()?;
    let t = js_trim(&out);
    (status.success() && !t.is_empty()).then(|| t.to_string())
}

/// `rehomeStrandedProjectDescriptors` would move something: a descriptor stranded in the legacy hash bucket whose own worktree
/// belongs to this project. Detection only.
fn stranded_exists(home: &Path, repo_key: &str) -> R<bool> {
    let dir = devswarm_root(home).join(defaults::text("mesh_write.dir_workspaces"));
    let Some(names) = crate::checks::jsport::fsx::read_dir_names(&dir.to_string_lossy()) else { return Ok(false) };
    let suffix = defaults::text("mesh_write.json_suffix");
    for (name, _) in names {
        let Some(id) = name.strip_suffix(suffix) else { continue };
        if !is_safe_id(id) {
            continue;
        }
        let Some(d) = ident::read_descriptor(home, id) else { continue };
        let wt = match d.get(defaults::text("mesh_write.field_worktree_path")) {
            Some(OVal::Str(w)) if !w.is_empty() => w.clone(),
            None | Some(OVal::Null) => continue,
            Some(v) if !v.truthy() => continue,
            Some(_) => return defer("descriptor-field-type"),
        };
        if !matches!(d.get(defaults::text("mesh_write.field_id")), Some(OVal::Str(i)) if i == id) {
            if d.get(defaults::text("mesh_write.field_id")).is_some_and(|v| !matches!(v, OVal::Str(_))) {
                return defer("descriptor-field-type");
            }
            continue;
        }
        if !Path::new(&wt).exists() && has_archived_counterpart(home, id) {
            continue;
        }
        let stored = match d.get(defaults::text("mesh_write.field_owner_key")) {
            Some(OVal::Str(k)) if !k.is_empty() => Some(k.clone()),
            _ => None,
        };
        let hash = crate::meshw::send::hash_from_workspace_id(id);
        if stored.as_deref() != Some(hash.as_str()) || hash == repo_key {
            continue;
        }
        if ident::repo_key_for_worktree(&wt)?.as_deref() == Some(repo_key) {
            return Ok(true);
        }
    }
    Ok(false)
}

// ---- Node's `inbox pull` for a workspace the engine does not answer ------------------------------------------------------------

/// What Node's `defaultSpawnReconcile` returned.
#[derive(Debug, Clone, Default)]
struct NodeRun {
    stdout: Option<String>,
    stderr: String,
    status: Option<i64>,
    signal: Option<String>,
    err_code: Option<String>,
    err_msg: Option<String>,
    worktree_missing: bool,
}

fn run_node_pull(ctx: &Ctx, runner: &dyn Runner, id: &str, worktree: &str) -> NodeRun {
    let r = node(runner, ctx, defaults::text("devswarm_recon.node_pull_snippet"), &[id, worktree], defaults::num("devswarm_recon.node_pull_timeout_ms"));
    if !r.ok {
        return NodeRun { err_msg: Some(r.error.clone().unwrap_or_else(|| crate::dssup::tick::cut(&r.stderr))), ..NodeRun::default() };
    }
    let v = parse(&r.stdout);
    let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
    NodeRun {
        stdout: s("stdout"),
        stderr: s("stderr").unwrap_or_default(),
        status: v.get("status").and_then(Value::as_i64),
        signal: s("signal"),
        err_code: v.pointer("/error/code").and_then(Value::as_str).map(str::to_string),
        err_msg: v.pointer("/error/message").and_then(Value::as_str).map(str::to_string),
        worktree_missing: v.get("worktreeMissing").and_then(Value::as_bool).unwrap_or(false),
    }
}

fn parsed_of(r: &NodeRun) -> Option<Value> {
    if r.err_msg.is_some() || r.err_code.is_some() {
        return None;
    }
    r.stdout.as_deref().and_then(|t| serde_json::from_str::<Value>(t).ok())
}

/// `isNativeTimeoutRun(r, parsed)`: the pull's own native-timeout marker with no loss and no import, or the spawn killed on its
/// timeout with nothing parseable.
fn is_native_timeout(parsed: Option<&Value>, r: Option<&NodeRun>) -> bool {
    match parsed {
        Some(p) => p.get("ok") == Some(&json!(false)) && p.get("nativeTimeout") == Some(&json!(true)) && !truthy(p.get("lost")) && !truthy(p.get("imported")),
        None => r.is_some_and(|r| r.err_code.as_deref() == Some(defaults::text("devswarm_recon.code_timeout"))),
    }
}

// ---- cmdReconcile -------------------------------------------------------------------------------------------------------------

enum Slot {
    /// A row decided without a pull: its result.
    Done(Value),
    /// A row to drain: the engine's staged pull (an index into the staged list) or Node's.
    Pull { t: Target, root: String, staged: Option<usize> },
}

fn base_row(t: &Target) -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("id".into(), json!(t.id));
    m.insert("worktreePath".into(), json!(t.worktree));
    m.insert("imported".into(), json!(0));
    m.insert("duplicate".into(), json!(0));
    m.insert("nativeCount".into(), json!(0));
    m.insert("lost".into(), json!(0));
    m.insert("locked".into(), json!(false));
    m.insert("hivecontrolMissing".into(), json!(false));
    m
}

fn skip_row(t: &Target, reason_key: &str, extra: &[(&str, Value)]) -> Value {
    let mut m = base_row(t);
    m.insert("ok".into(), json!(true));
    m.insert("worktreeMissing".into(), json!(false));
    m.insert("archivedDuplicate".into(), json!(false));
    m.insert("skipped".into(), json!(true));
    m.insert("skipReason".into(), json!(defaults::text(reason_key)));
    m.insert("error".into(), Value::Null);
    for (k, v) in extra {
        m.insert((*k).to_string(), v.clone());
    }
    Value::Object(m)
}

fn budget_of(ctx: &Ctx, o: &Opts) -> u64 {
    if let Some(b) = o.budget_ms {
        return b;
    }
    ctx.st
        .env
        .get(defaults::text("devswarm_recon.budget_env"))
        .and_then(|v| v.trim().parse::<f64>().ok())
        .filter(|n| n.is_finite() && *n >= 0.0)
        .map_or(defaults::num("devswarm_recon.budget_ms"), |n| n as u64)
}

/// A planned side-file change, witnessed and applied; `None` when the witness did not agree (nothing was written).
fn apply_side(ctx: &Ctx, runner: &dyn Runner, label: &str, p: side::Planned, extra: &[String]) -> Option<Value> {
    if p.unit.ops.is_empty() {
        return Some(p.expect);
    }
    let mut files: Vec<String> = extra.to_vec();
    files.extend(side::touched(&p.unit));
    let job = Job {
        label: label.to_string(),
        scope: side::scope_for(&files),
        calls: vec![p.call.clone()],
        expect: vec![Some(p.expect.clone())],
        units: vec![p.unit],
    };
    let out = gate::run(ctx, runner, &job, &Hooks::none());
    (out.verdict == Verdict::Agreed && out.ends.iter().all(|e| *e == UnitEnd::Applied)).then_some(p.expect)
}

/// One line of the central log, written by the engine (not a state change the witness could compare).
fn log_line(ctx: &Ctx, component: &str, op: &str, level: &str, msg: &str, context: &Value) {
    let env = Env { home: ctx.home, now: ctx.now, st: ctx.st, log_dir: None };
    let u = Unit {
        label: "log".into(),
        lock: None,
        ops: vec![Op::Log { component: component.into(), op: op.into(), level: level.into(), msg: msg.into(), ctx: context.to_string() }],
    };
    crate::discard::harmless(match apply::unit(&env, &u, &Hooks::none()) {
        UnitEnd::Failed(w) => Err(w),
        _ => Ok(()),
    }); // keep: a log line that cannot be written never fails the sweep
}

/// `cmdReconcile(flags, ctx)` for the project `cwd` stands in.
pub fn cmd_reconcile(ctx: &Ctx, runner: &dyn Runner, cwd: &str, o: &Opts, hooks: &Hooks) -> ProjectEnd {
    match reconcile(ctx, runner, cwd, o, hooks) {
        Ok(end) => end,
        Err(Defer(why)) => ProjectEnd::Node(why),
    }
}

fn reconcile(ctx: &Ctx, runner: &dyn Runner, cwd: &str, o: &Opts, hooks: &Hooks) -> R<ProjectEnd> {
    let home = ctx.home;
    let Some(repo_key) = ident::repo_key_for_worktree(cwd)? else { return Ok(ProjectEnd::Result(json!({"ok": false, "reason": "no-project"}))) };
    // GH1: a stranded child of this project is Node's to re-home before the listing
    if stranded_exists(home, &repo_key)? {
        return defer("rehome-stranded");
    }
    // Claim 3 self-heal pre-pass
    let healed = heal::run(ctx, runner, &repo_key, hooks)?;
    if !healed.deferred.is_empty() {
        return defer("heal-deferred");
    }
    let rows = view::registry(home, &repo_key)?;
    let mut targets: Vec<Target> = rows
        .iter()
        .map(descriptor_of)
        .filter(|d| d.worktree_path.as_deref().is_some_and(|w| !w.is_empty()) && is_safe_id(&d.id))
        .map(|d| Target { id: d.id, worktree: d.worktree_path.unwrap_or_default(), session: d.session_id })
        .collect();
    // resume rotation
    let resume = side::read_resume(home, &repo_key);
    if !resume.is_empty() {
        let mut first = Vec::new();
        for id in &resume {
            if let Some(i) = targets.iter().position(|t| t.id == *id) {
                first.push(targets.remove(i));
            }
        }
        first.extend(targets);
        targets = first;
    }
    let budget = budget_of(ctx, o);
    let started = (o.clock)();
    let over = || budget > 0 && ((o.clock)() - started) >= budget as i64;
    let inv = Inv {
        home: home.to_path_buf(),
        env: pull::sweep_env(&ctx.st.env, home),
        cwd: cwd.to_string(),
        now: ctx.now,
        stdin: None,
        write_home: home.to_path_buf(),
        store_override: None,
    };
    let held = crate::meshw::summary::held_ids(&inv)?;
    let scope_of = |t: &Target| format!("{}{}", defaults::text("devswarm_recon.scope_pull_prefix"), t.id);
    let suppressed = |t: &Target| -> R<bool> { Ok(side::repo_unknown_suppressed(home, &repo_key, &scope_of(t), ctx.now) && row_terminal(&inv, t, &held)?) };
    let (mut skipped_missing, mut skipped_not_git, mut processed, mut repo_unknown_skipped) = (0u64, 0u64, 0u64, 0u64);
    let mut deferred_ids: Vec<String> = Vec::new();
    let mut slots: Vec<Slot> = Vec::new();
    let mut staged: Vec<Staged> = Vec::new();
    for t in &targets {
        if !Path::new(&t.worktree).exists() {
            skipped_missing += 1;
            let counterpart = has_archived_counterpart(home, &t.id);
            let archived = counterpart || row_archived(&inv, t)?;
            let mut row = base_row(t);
            row.insert("ok".into(), json!(archived));
            row.insert("worktreeMissing".into(), json!(true));
            row.insert("archivedDuplicate".into(), json!(counterpart));
            row.insert("skipped".into(), json!(archived));
            row.insert("skipReason".into(), if archived { json!(defaults::text("devswarm_recon.msg_skip_pruned")) } else { Value::Null });
            row.insert(
                "error".into(),
                if archived { Value::Null } else { json!(defaults::render("devswarm_recon.msg_err_worktree_missing", &[("path", &t.worktree)])) },
            );
            slots.push(Slot::Done(Value::Object(row)));
            continue;
        }
        if row_archived(&inv, t)? {
            let mut row = skip_row(t, "devswarm_recon.msg_skip_archived", &[]);
            row["archivedDuplicate"] = json!(has_archived_counterpart(home, &t.id));
            slots.push(Slot::Done(row));
            continue;
        }
        if suppressed(t)? {
            repo_unknown_skipped += 1;
            slots.push(Slot::Done(skip_row(t, "devswarm_recon.msg_skip_repo_unknown", &[("repoUnknown", json!(true))])));
            continue;
        }
        if over() {
            deferred_ids.push(t.id.clone());
            continue;
        }
        let Some(root) = git_root(&t.worktree) else {
            skipped_not_git += 1;
            let mut row = base_row(t);
            row.insert("ok".into(), json!(false));
            row.insert("worktreeMissing".into(), json!(false));
            row.insert("notGitRoot".into(), json!(true));
            row.insert("archivedDuplicate".into(), json!(has_archived_counterpart(home, &t.id)));
            row.insert("skipped".into(), json!(false));
            row.insert("skipReason".into(), Value::Null);
            row.insert("error".into(), json!(defaults::render("devswarm_recon.msg_err_not_git_root", &[("path", &t.worktree)])));
            slots.push(Slot::Done(Value::Object(row)));
            continue;
        };
        if over() {
            deferred_ids.push(t.id.clone());
            continue;
        }
        processed += 1;
        let at = |n: &str| (hooks.at)(&format!("pull:{}:{n}", t.id));
        match pull::stage(ctx, &t.id, &root, &at) {
            Stage::Ready(s) => {
                staged.push(*s);
                slots.push(Slot::Pull { t: t.clone(), root, staged: Some(staged.len() - 1) });
            }
            Stage::Node(why) => {
                pull::note_handback(ctx, &t.id, &why);
                slots.push(Slot::Pull { t: t.clone(), root, staged: None });
            }
        }
    }
    // the witnessed apply of every captured drain
    let mut drained: Vec<Option<Result<Value, String>>> = pull::drain(ctx, runner, &repo_key, staged, hooks).into_iter().map(Some).collect();
    let backoff = o.backoff_ms.unwrap_or_else(|| defaults::num("devswarm_recon.timeout_retry_backoff_ms"));
    let mut results: Vec<Value> = Vec::new();
    let unknown_re = re("devswarm_recon.re_repo_unknown_line");
    let ansi = regex::Regex::new(defaults::text("devswarm_recon.ansi_re")).map_err(|e| Defer(e.to_string()))?;
    let is_unknown_text = |texts: &[Option<String>]| {
        texts.iter().flatten().any(|t| ansi.replace_all(t, "").split(['\n']).any(|l| unknown_re.as_ref().is_some_and(|r| r.is_match(js_trim(l.trim_end_matches('\r'))))))
    };
    for slot in slots {
        let (t, root, staged_ix) = match slot {
            Slot::Done(v) => {
                results.push(v);
                continue;
            }
            Slot::Pull { t, root, staged } => (t, root, staged),
        };
        // the answer: the engine's recorded result, or Node's own pull
        let mut parsed: Option<Value> = None;
        let mut run: Option<NodeRun> = None;
        if let Some(i) = staged_ix {
            match drained[i].take() {
                Some(Ok(v)) => parsed = Some(v),
                Some(Err(why)) => pull::note_handback(ctx, &t.id, &why),
                None => {}
            }
        }
        if parsed.is_none() {
            let mut r = run_node_pull(ctx, runner, &t.id, &root);
            let mut p = parsed_of(&r);
            if is_native_timeout(p.as_ref(), Some(&r)) && !over() {
                std::thread::sleep(std::time::Duration::from_millis(backoff));
                r = run_node_pull(ctx, runner, &t.id, &root);
                p = parsed_of(&r);
            }
            parsed = p;
            run = Some(r);
        }
        let pv = |k: &str| parsed.as_ref().and_then(|p| p.get(k));
        let native_timeout = is_native_timeout(parsed.as_ref(), run.as_ref());
        // repository-unknown bookkeeping
        let scope = scope_of(&t);
        // a success, or a different error, ends the streak of the repository-unknown error
        if parsed.as_ref().is_some_and(|p| truthy(p.get("ok"))) || !is_unknown_text(&[pv("error").map(js_str), pv("reason").map(js_str), run.as_ref().map(|r| r.stderr.clone())]) {
            apply_side(ctx, runner, defaults::text("devswarm_recon.job_repo_unknown"), side::plan_repo_unknown_clear(home, &repo_key, &scope), &[]);
        } else if row_terminal(&inv, &t, &held)? {
            let reason = match pv("error").filter(|v| truthy(Some(v))).or_else(|| pv("reason").filter(|v| truthy(Some(v)))) {
                Some(v) => js_str(v),
                None => run.as_ref().map(|r| r.stderr.clone()).unwrap_or_default(),
            };
            let planned = side::plan_repo_unknown_record(home, &repo_key, &scope, &reason, ctx.now)?;
            let rec = apply_side(ctx, runner, defaults::text("devswarm_recon.job_repo_unknown"), planned, &[])
                .unwrap_or(json!({"first": false, "suppressed": false, "engaged": false}));
            if rec["engaged"] == json!(true) {
                log_line(
                    ctx,
                    defaults::text("devswarm_recon.log_component_reconcile"),
                    defaults::text("devswarm_recon.log_op_repo_unknown"),
                    defaults::text("devswarm_recon.log_level_info"),
                    &defaults::render("devswarm_recon.msg_repo_unknown_log", &[("n", &defaults::num("devswarm_recon.suppress_after"))]),
                    &json!({"repoKey": repo_key, "id": t.id, "worktreePath": t.worktree}),
                );
            }
            if rec["suppressed"] == json!(true) {
                repo_unknown_skipped += 1;
                results.push(skip_row(&t, "devswarm_recon.msg_skip_repo_unknown", &[("repoUnknown", json!(true))]));
                continue;
            }
        }
        // the row, in Node's shape
        let err_text = parsed.as_ref().and_then(|p| p.get("error")).map(js_str).unwrap_or_default();
        let ok = parsed.as_ref().is_some_and(|p| truthy(p.get("ok")));
        let not_ok = parsed.as_ref().is_some_and(|p| p.get("ok") == Some(&json!(false)));
        let locked = not_ok && pv("locked") == Some(&json!(false)) && re_match("devswarm_recon.re_locked", &err_text);
        let hc_missing = not_ok && re_match("devswarm_recon.re_hc_missing", &err_text);
        let wt_missing = run.as_ref().is_some_and(|r| r.worktree_missing);
        let error: Value = if truthy(pv("error")) {
            pv("error").cloned().unwrap_or(Value::Null)
        } else if truthy(pv("reason")) {
            pv("reason").cloned().unwrap_or(Value::Null)
        } else if let Some(m) = run.as_ref().and_then(|r| r.err_msg.clone().or_else(|| r.err_code.clone())) {
            json!(m)
        } else if let Some(r) = run.as_ref().filter(|r| parsed.is_none() && (r.status.is_some() || r.signal.is_some() || !js_trim(&r.stderr).is_empty())) {
            let mut text = defaults::text("devswarm_recon.msg_err_exited").to_string();
            if let Some(c) = r.status {
                text.push_str(&defaults::render("devswarm_recon.msg_err_code", &[("code", &c)]));
            }
            if let Some(s) = &r.signal {
                text.push_str(&defaults::render("devswarm_recon.msg_err_signal", &[("signal", s)]));
            }
            if !js_trim(&r.stderr).is_empty() {
                text.push_str(&defaults::render("devswarm_recon.msg_err_stderr", &[("stderr", &js_trim(&r.stderr))]));
            }
            json!(text)
        } else if parsed.is_some() {
            Value::Null
        } else {
            json!(defaults::text("devswarm_recon.msg_err_unparseable"))
        };
        let mut row = Map::new();
        row.insert("id".into(), json!(t.id));
        row.insert("worktreePath".into(), json!(t.worktree));
        row.insert("ok".into(), json!(ok));
        row.insert("imported".into(), or_zero(pv("imported")));
        row.insert("duplicate".into(), or_zero(pv("duplicate")));
        row.insert("nativeCount".into(), or_zero(pv("nativeCount")));
        row.insert("lost".into(), or_zero(pv("lost")));
        row.insert("locked".into(), json!(locked));
        row.insert("hivecontrolMissing".into(), json!(hc_missing));
        row.insert("worktreeMissing".into(), json!(wt_missing));
        row.insert("nativeTimeout".into(), json!(native_timeout));
        row.insert("archivedDuplicate".into(), json!(wt_missing && has_archived_counterpart(home, &t.id)));
        row.insert("skipped".into(), json!(false));
        row.insert("skipReason".into(), Value::Null);
        row.insert("error".into(), error);
        results.push(Value::Object(row));
    }
    let sum = |k: &str| results.iter().map(|r| r.get(k).and_then(Value::as_f64).unwrap_or(0.0)).sum::<f64>();
    let flag = |r: &Value, k: &str| r.get(k) == Some(&json!(true));
    let rejected =
        results.iter().filter(|r| !flag(r, "ok") && re_match("devswarm_recon.re_rejected", &r.get("error").map(js_str).unwrap_or_default())).count();
    let all_ok = results.iter().all(|r| defaults::list("devswarm_recon.benign_flags").iter().any(|k| flag(r, k)));
    let native_timeouts = results.iter().filter(|r| flag(r, "nativeTimeout")).count();
    // names: the app's titles (a native read), then the ones still missing from hivecontrol's list (Node's own call)
    let descs: Vec<plan::Desc> = targets
        .iter()
        .map(|t| plan::Desc {
            id: t.id.clone(),
            body: OVal::Obj(vec![(defaults::text("mesh_write.field_worktree_path").to_string(), OVal::Str(t.worktree.clone()))]),
        })
        .collect();
    let refreshed = match ident::app_db_path(home, &ctx.st.env) {
        Some(f) => match snap::read(&f)? {
            Some(s) => state::refresh_names(home, &s, &descs, ctx.now)?.1,
            None => 0,
        },
        None => 0,
    };
    let missing: Vec<&str> = targets.iter().filter(|t| state::read_name(home, &t.id).is_none()).map(|t| t.id.as_str()).collect();
    let mut backfilled = 0u64;
    if !missing.is_empty() {
        let ids = json!(missing).to_string();
        let r = node(
            runner,
            ctx,
            defaults::text("devswarm_recon.node_names_snippet"),
            &[cwd, &ids, &ctx.now.to_string()],
            defaults::num("devswarm_recon.node_names_timeout_ms"),
        );
        if r.ok {
            backfilled = parse(&r.stdout).get("backfilled").and_then(Value::as_u64).unwrap_or(0);
        }
    }
    // the resume marker: what is still deferred goes first next time, and a drained sweep leaves no marker
    let marker = view::exists(home, &side::resume_rel());
    if !deferred_ids.is_empty() || marker {
        apply_side(ctx, runner, defaults::text("devswarm_recon.job_resume"), side::plan_resume(home, &repo_key, &deferred_ids, ctx.now), &[]);
    }
    let mut out = Map::new();
    out.insert("ok".into(), json!(all_ok));
    out.insert("action".into(), json!("reconcile"));
    out.insert("repoKey".into(), json!(repo_key));
    out.insert("count".into(), json!(results.len()));
    out.insert("imported".into(), num(sum("imported")));
    out.insert("lost".into(), num(sum("lost")));
    out.insert("rejected".into(), json!(rejected));
    out.insert("results".into(), Value::Array(results));
    out.insert("budgetMs".into(), json!(budget));
    out.insert("processed".into(), json!(processed));
    out.insert("skippedMissingWorktree".into(), json!(skipped_missing));
    out.insert("skippedNotGitRoot".into(), json!(skipped_not_git));
    out.insert("deferred".into(), json!(deferred_ids.len()));
    out.insert("repoUnknown".into(), json!(repo_unknown_skipped));
    out.insert("namesRefreshed".into(), json!(refreshed));
    out.insert("elapsedMs".into(), json!((o.clock)() - started));
    if native_timeouts > 0 {
        out.insert("nativeTimeouts".into(), json!(native_timeouts));
    }
    out.insert("healed".into(), healed.result);
    if backfilled > 0 {
        out.insert("namesBackfilled".into(), json!(backfilled));
    }
    let out = Value::Object(out);
    // `run()` logs a result that is not ok
    if !all_ok {
        let msg = out.get("error").or_else(|| out.get("reason")).map(js_str).unwrap_or_else(|| defaults::text("devswarm_cli.msg_log_not_ok").to_string());
        crate::meshw::clog::refusal(&inv, defaults::text("devswarm_recon.action_reconcile"), Some(&repo_key), None, &msg, None);
    }
    Ok(ProjectEnd::Result(out))
}

// ---- the sweep duty -------------------------------------------------------------------------------------------------------------

/// Who runs the reconcile duty: `node` (the default, Node's `reconcileSweepIfDue` whole) or `engine` (the engine reconciles each
/// project natively and Node does the rest of the sweep).
pub fn engine_mode() -> bool {
    mode_is_engine(&crate::dswire::effective_text("devswarm_sup.reconcile_mode"))
}

/// Whether the `devswarm_sup.reconcile_mode` word means the engine; anything but the engine word is Node.
pub fn mode_is_engine(word: &str) -> bool {
    defaults::list("devswarm_sup.reconcile_mode_words").get(1).is_some_and(|e| word.trim().eq_ignore_ascii_case(e))
}

/// The duty's record. `fallback` runs Node's whole `reconcileSweepIfDue` (the duty as Node has it) and is what the engine does
/// whenever it cannot start the sweep itself.
pub fn duty(ctx: &Ctx, runner: &dyn Runner, hooks: &Hooks, fallback: &dyn Fn() -> Value) -> Value {
    let (descs, projects) = match read_descriptors(ctx.home).and_then(|d| distinct_repo_keys(&d).map(|p| (d, p))) {
        Ok(x) => x,
        Err(_) => return fallback(),
    };
    let cap = defaults::num("devswarm_recon.max_projects_per_tick") as usize;
    let mut pre = Map::new();
    if !descs.is_empty() && !projects.is_empty() {
        // persisted BEFORE the work, so a slow or crashed sweep still honours the cool-down
        if apply_side(ctx, runner, defaults::text("devswarm_recon.job_sweep_state"), side::plan_sweep_state(ctx.home, ctx.now), &[]).is_none() {
            return fallback();
        }
        for p in projects.iter().take(cap) {
            match cmd_reconcile(ctx, runner, &p.worktree, &Opts::real(), hooks) {
                ProjectEnd::Result(v) => {
                    pre.insert(p.worktree.clone(), v);
                }
                ProjectEnd::Node(why) => {
                    let rec = json!({"ts": ctx.now, "job": defaults::text("devswarm_recon.job_project_handback"), "repoKey": p.repo_key, "why": why});
                    crate::dsact::exec::append_line(&ctx.home.join(defaults::text("devswarm_recon.witness_file")), &rec);
                }
            }
        }
    }
    let scratch = ctx.home.join(defaults::text("devswarm_sup.witness_dir")).join(format!(
        "{}{}-{}.json",
        defaults::text("devswarm_recon.pre_file_prefix"),
        ctx.now,
        std::process::id()
    ));
    if let Some(d) = scratch.parent() {
        crate::discard::harmless(std::fs::create_dir_all(d)); // keep: the write below reports the failure
    }
    if std::fs::write(&scratch, Value::Object(pre.clone()).to_string()).is_err() {
        return fallback();
    }
    let timeout = defaults::raw("devswarm_sup.duty.reconcile").get("timeout_ms").and_then(crate::defaults::V::as_integer).unwrap_or(0).max(1) as u64;
    let r = node(runner, ctx, defaults::text("devswarm_recon.node_tail_snippet"), &[&scratch.to_string_lossy()], timeout);
    crate::discard::harmless(std::fs::remove_file(&scratch)); // keep: the engine's own scratch file
    if r.ok {
        json!({"duty": "reconcile", "outcome": "ran", "detail": parse(&r.stdout), "engineProjects": pre.len()})
    } else {
        let why = r.error.clone().unwrap_or_else(|| crate::dssup::tick::cut(&r.stderr));
        json!({"duty": "reconcile", "outcome": "failed", "error": why, "status": r.status, "timedOut": r.timed_out})
    }
}
