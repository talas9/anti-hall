//! The active-workspace probe and the start-up sampling of the reconcile sweep (`reconcileSweepIfDue` of
//! `companion/devswarm-supervisor.js`, after each project's reconcile and fold).
//!
//! * **The probe** (`fetchActiveWorkspaceRecords`): one bounded, read-only `hivecontrol workspace list all` per project. An answer
//!   is admitted only when the call exited 0, parsed as a list and carried at least one record (an empty list would read as "this
//!   project has no live workspaces" and archive every row, so it is refused). `workspace list all` is global, so each record is
//!   attributed to the repository its own worktree belongs to; a record no repository claims joins a project only through a
//!   record of the same `repositoryId` under the DevSwarm repos root, and is otherwise dropped (counted, logged at most
//!   `devswarm_recon.drop_log_max` times). The snapshot is written once per sweep, and only when some project reported records.
//! * **The repository-unknown streak** of the listing (scope `list`): `Repository not found` is terminal for a project with no
//!   live row, so after `suppress_after` sweeps in a row the probe is skipped until the periodic recheck.
//! * **The start-up sampling** (`devswarm.startupSampling`): data capture only, at most `devswarm.pausedProbeMax` `workspace
//!   info` probes of workspaces whose persisted verdict reads stale or not draining.
use super::*;
use crate::dsact::runner::{RunResult, RunSpec};
use std::collections::{HashMap, HashSet};

/// One record of the listing.
#[derive(Debug, Clone)]
struct Rec {
    id: String,
    worktree: Option<String>,
    repository_id: Option<String>,
    label: Option<String>,
    branch: Option<String>,
}

impl Rec {
    fn json(&self) -> OVal {
        let opt = |o: &Option<String>| o.as_deref().map_or(OVal::Null, |t| OVal::Str(t.to_string()));
        OVal::Obj(vec![
            ("id".into(), OVal::Str(self.id.clone())),
            ("worktreePath".into(), opt(&self.worktree)),
            ("repositoryId".into(), opt(&self.repository_id)),
            ("label".into(), opt(&self.label)),
            ("branch".into(), opt(&self.branch)),
        ])
    }
}

/// Why the probe has no usable answer, with the diagnostics a failed call supplies.
#[derive(Debug, Clone, Default)]
struct Fail {
    reason: String,
    raw_keys: Vec<String>,
    error: Option<String>,
    status: Option<i32>,
    signal: Option<String>,
    stderr: Option<String>,
}

/// The probe's answer for one project.
#[derive(Debug, Clone)]
enum Active {
    Ok(Vec<Rec>),
    Fail(Fail),
}

fn opt_text(v: Option<&OVal>) -> Option<String> {
    match v {
        Some(OVal::Str(t)) if !t.is_empty() => Some(t.clone()),
        _ => None,
    }
}

/// What one `hivecontrol workspace list all` came to.
pub(super) enum Listing {
    /// A clean exit 0: its stdout.
    Out(String),
    /// Not run: the build positively lacks `workspace list` and the capability cache already says so (`gatedRun`'s refusal text).
    Refused(String),
    /// Run and failed.
    Failed(RunResult),
}

/// The one bounded, read-only listing every part of the sweep shares, behind the capability gate (`hcRun`): a build the cache records
/// as lacking `workspace list` is not asked. A missing or stale cache is filled first by the capability probe; no binary goes through to
/// the call, which then fails like any other.
pub(super) fn list_all(ctx: &Ctx, runner: &dyn Runner, cwd: &str) -> Listing {
    let env = pull::sweep_env(&ctx.st.env, ctx.home);
    let verb = defaults::text("mesh_write.hivecontrol_list_verb");
    let mut cap = crate::meshw::hivecontrol::cap_verb(&env, ctx.home, verb, None, None);
    // no current entry for this build: probe it (read-only --version / --help) and write the cache, as Node's `probe` does
    if cap == crate::meshw::hivecontrol::Cap::Probe && crate::dssup::recon::capprobe::fill(ctx, &env, runner) {
        cap = crate::meshw::hivecontrol::cap_verb(&env, ctx.home, verb, None, None);
    }
    if let crate::meshw::hivecontrol::Cap::Dormant(reason) = cap {
        return Listing::Refused(defaults::render(
            "devswarm_recon.msg_capability_dormant",
            &[("name", &format!("{}{verb}", defaults::text("devswarm_cli.hc_cap_prefix"))), ("reason", &reason)],
        ));
    }
    let spec = RunSpec {
        bin: None,
        args: defaults::list("devswarm_recon.list_all_args").iter().map(|a| (*a).to_string()).collect(),
        cwd: Some(cwd.to_string()),
        timeout_ms: defaults::num("devswarm_recon.list_timeout_ms"),
        scrub_env: defaults::list("devswarm_recon.env_strip").iter().map(|a| (*a).to_string()).collect(),
        ..RunSpec::default()
    };
    let res = runner.run(&spec);
    if res.ok && res.status == Some(0) { Listing::Out(res.stdout) } else { Listing::Failed(res) }
}

/// `fetchActiveWorkspaceRecords(ctx)`.
fn fetch(ctx: &Ctx, runner: &dyn Runner, cwd: &str) -> Active {
    let cap = defaults::num("devswarm_recon.probe_stderr_max") as usize;
    let stdout = match list_all(ctx, runner, cwd) {
        Listing::Out(o) => o,
        Listing::Refused(why) => {
            return Active::Fail(Fail { reason: defaults::text("devswarm_recon.reason_unavailable").to_string(), error: Some(why), ..Fail::default() });
        }
        Listing::Failed(res) => {
            return Active::Fail(Fail {
                reason: defaults::text("devswarm_recon.reason_unavailable").to_string(),
                error: Some(res.error.filter(|e| !e.is_empty()).unwrap_or_else(|| defaults::text("devswarm_recon.word_no_output").to_string())),
                status: res.status,
                signal: None,
                stderr: Some(crate::checks::jsport::text::slice16_lossy(&res.stderr, cap)),
                ..Fail::default()
            });
        }
    };
    let shape = |keys: Vec<String>| Active::Fail(Fail { reason: defaults::text("devswarm_recon.reason_shape").to_string(), raw_keys: keys, ..Fail::default() });
    let Some(parsed) = OVal::parse(&stdout) else { return shape(Vec::new()) };
    let list: &[OVal] = match &parsed {
        OVal::Arr(a) => a,
        OVal::Obj(o) => match parsed.get(defaults::text("mesh_write.roster_children_key")) {
            Some(OVal::Arr(a)) => a,
            _ => return shape(o.iter().map(|(k, _)| k.clone()).collect()),
        },
        _ => return shape(Vec::new()),
    };
    let mut records = Vec::new();
    for e in list {
        if !matches!(e, OVal::Obj(_)) {
            continue;
        }
        let id = match e.get("id") {
            None | Some(OVal::Null) => continue,
            Some(v) => crate::dssup::ingest::import::js_string(v),
        };
        if id.is_empty() {
            continue;
        }
        records.push(Rec {
            id,
            worktree: opt_text(e.get("worktreePath")),
            repository_id: opt_text(e.get("repositoryId")),
            label: opt_text(e.get("label")),
            branch: opt_text(e.get("branch")),
        });
    }
    if records.is_empty() {
        return Active::Fail(Fail { reason: defaults::text("devswarm_recon.reason_empty").to_string(), ..Fail::default() });
    }
    Active::Ok(records)
}

/// `isRepoUnknownText(...texts)`: some line of some text is the `Repository not found` line.
fn is_repo_unknown(texts: &[Option<&str>]) -> bool {
    let (Some(line_re), Ok(ansi)) = (re("devswarm_recon.re_repo_unknown_line"), regex::Regex::new(defaults::text("devswarm_recon.ansi_re"))) else {
        return false;
    };
    texts.iter().flatten().any(|t| ansi.replace_all(t, "").split('\n').any(|l| line_re.is_match(js_trim(l.trim_end_matches('\r')))))
}

/// `isUnderDevswarmReposRoot(p)`.
fn under_repos_root(p: &str) -> bool {
    let cwd = std::env::current_dir().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default();
    let resolved = ident::resolve(&cwd, p);
    let normalized = ident::realpath(&resolved).unwrap_or(resolved);
    crate::checks::guardkit::jsre::compile(defaults::text("wake_watch.repos_root_re"), false).is_match(&normalized)
}

/// What the probe of one sweep collected.
#[derive(Default)]
pub(super) struct Acc {
    by_repo: Vec<(String, OVal)>,
    kept: u64,
    dropped: u64,
    dropped_keys: HashSet<String>,
    failure: Option<Value>,
    /// `resolveRepoKeyCached`: a worktree's repository key, resolved once per sweep.
    keys: HashMap<String, Option<String>>,
}

impl Acc {
    fn key_of(&mut self, wt: &str) -> Option<String> {
        self.keys.entry(wt.to_string()).or_insert_with(|| ident::repo_key_for_worktree(wt).ok().flatten()).clone()
    }
}

fn log_supervisor(ctx: &Ctx, op: &str, msg: &str, context: &Value) {
    log_line(ctx, defaults::text("devswarm_recon.log_component_supervisor"), op, defaults::text("devswarm_recon.log_level_info"), msg, context);
}

/// Whether `t`'s repository has no live row: every descriptor of it is archived, held or archive-ignored (`repoTerminal`).
fn repo_terminal(acc: &mut Acc, inv: &Inv, held: &HashSet<String>, descs: &[Descriptor], repo_key: &str) -> bool {
    !descs.iter().any(|x| {
        acc.key_of(&x.worktree).as_deref() == Some(repo_key)
            && !row_terminal(inv, &Target { id: x.id.clone(), worktree: x.worktree.clone(), session: None }, held).unwrap_or(false)
    })
}

/// The probe of one project: the repository-unknown streak, the listing, its attribution to this project. Returns the project's
/// `active` record (`{ok, reason, records}`, `null` when the probe was suppressed).
pub(super) fn probe_project(ctx: &Ctx, runner: &dyn Runner, descs: &[Descriptor], p: &Project, acc: &mut Acc) -> Value {
    let home = ctx.home;
    let inv = Inv {
        home: home.to_path_buf(),
        env: pull::sweep_env(&ctx.st.env, home),
        cwd: p.worktree.clone(),
        now: ctx.now,
        stdin: None,
        write_home: home.to_path_buf(),
        store_override: None,
    };
    let held = crate::meshw::summary::held_ids(&inv).unwrap_or_default();
    let scope = defaults::text("devswarm_recon.scope_list");
    let job = defaults::text("devswarm_recon.job_repo_unknown");
    if side::repo_unknown_suppressed(home, &p.repo_key, scope, ctx.now) && repo_terminal(acc, &inv, &held, descs, &p.repo_key) {
        return Value::Null;
    }
    let mut active = fetch(ctx, runner, &p.worktree);
    match &active {
        Active::Ok(_) => {
            apply_side(ctx, runner, job, side::plan_repo_unknown_clear(home, &p.repo_key, scope), &[]);
        }
        Active::Fail(f) if !is_repo_unknown(&[f.error.as_deref(), f.stderr.as_deref()]) => {
            apply_side(ctx, runner, job, side::plan_repo_unknown_clear(home, &p.repo_key, scope), &[]); // a different error resets the streak
        }
        Active::Fail(f) => {
            if repo_terminal(acc, &inv, &held, descs, &p.repo_key) {
                let reason = f.error.clone().filter(|e| !e.is_empty()).or_else(|| f.stderr.clone()).unwrap_or_default();
                let rec = side::plan_repo_unknown_record(home, &p.repo_key, scope, &reason, ctx.now)
                    .ok()
                    .and_then(|planned| apply_side(ctx, runner, job, planned, &[]))
                    .unwrap_or(json!({"first": false, "suppressed": false, "engaged": false}));
                if rec["engaged"] == json!(true) {
                    log_supervisor(
                        ctx,
                        defaults::text("devswarm_recon.log_op_repo_unknown"),
                        &defaults::render("devswarm_recon.msg_repo_unknown_list", &[("n", &defaults::num("devswarm_recon.suppress_after"))]),
                        &json!({"repoKey": p.repo_key, "worktreePath": p.worktree}),
                    );
                }
                if rec["suppressed"] == json!(true) {
                    active = Active::Fail(Fail { reason: defaults::text("devswarm_recon.reason_repo_unknown").to_string(), ..Fail::default() });
                }
            }
        }
    }
    match &active {
        Active::Ok(recs) => {
            // `workspace list all` is global: keep the records this project's own worktrees own
            let keys: Vec<Option<String>> = recs.iter().map(|r| r.worktree.as_deref().and_then(|w| acc.key_of(w))).collect();
            let direct: Vec<usize> = (0..recs.len()).filter(|i| keys[*i].as_deref() == Some(p.repo_key.as_str())).collect();
            let attributed: HashSet<&str> = direct.iter().filter_map(|i| recs[*i].repository_id.as_deref()).collect();
            let siblings: Vec<usize> = if attributed.is_empty() {
                Vec::new()
            } else {
                (0..recs.len())
                    .filter(|i| {
                        !direct.contains(i)
                            && keys[*i].is_none()
                            && recs[*i].repository_id.as_deref().is_some_and(|r| attributed.contains(r))
                            && recs[*i].worktree.as_deref().is_some_and(under_repos_root)
                    })
                    .collect()
            };
            let scoped: Vec<usize> = direct.iter().chain(siblings.iter()).copied().collect();
            if !scoped.is_empty() {
                acc.kept += scoped.len() as u64;
                let arr = OVal::Arr(scoped.iter().map(|i| recs[*i].json()).collect());
                match acc.by_repo.iter_mut().find(|(k, _)| *k == p.repo_key) {
                    Some(slot) => slot.1 = arr,
                    None => acc.by_repo.push((p.repo_key.clone(), arr)),
                }
            }
            // genuinely dropped: unattributable and no same-repository sibling applied; one count (and one log line, up to the cap) per worktree
            for i in 0..recs.len() {
                if scoped.contains(&i) || keys[i].is_some() {
                    continue;
                }
                let r = &recs[i];
                let key = r.worktree.clone().unwrap_or_else(|| format!("id:{}", r.id));
                if !acc.dropped_keys.insert(key) {
                    continue;
                }
                acc.dropped += 1;
                if acc.dropped_keys.len() as u64 <= defaults::num("devswarm_recon.drop_log_max") {
                    log_supervisor(
                        ctx,
                        defaults::text("devswarm_recon.log_op_active_drop"),
                        defaults::text("devswarm_recon.msg_active_drop"),
                        &json!({"repoKeyTarget": p.repo_key, "recordId": r.id, "worktreePath": r.worktree, "reason": defaults::text("devswarm_recon.reason_unattributable")}),
                    );
                }
            }
            json!({"ok": true, "reason": null, "records": recs.len()})
        }
        Active::Fail(f) => {
            if f.reason != defaults::text("devswarm_recon.reason_repo_unknown") && acc.failure.is_none() {
                acc.failure = Some(json!({
                    "repoKey": p.repo_key, "reason": f.reason, "rawKeys": f.raw_keys, "error": f.error,
                    "status": f.status, "signal": f.signal, "stderr": f.stderr,
                }));
            }
            json!({"ok": false, "reason": f.reason, "records": 0})
        }
    }
}

/// After the last project: the snapshot (only when some project reported records, an empty write would stamp a fresh `fetchedAt` on
/// a list asserting nothing is live), the first failure's log line, and the sweep's `activeProbe` / `activeScope`.
pub(super) fn finish(ctx: &Ctx, runner: &dyn Runner, acc: Acc) -> (Value, Value) {
    if !acc.by_repo.is_empty() {
        let floor = side::active_floor_pct(ctx.st);
        match side::plan_active_cache(ctx.home, &acc.by_repo, ctx.now, floor) {
            Ok(planned) => {
                apply_side(ctx, runner, defaults::text("devswarm_recon.job_active_cache"), planned, &[]);
            }
            Err(Defer(why)) => {
                crate::dssup::tick::held("dssup:reconcile:active_cache", &why);
            }
        }
    }
    if let Some(f) = &acc.failure {
        log_supervisor(ctx, defaults::text("devswarm_recon.log_op_active_probe"), defaults::text("devswarm_recon.msg_active_probe"), f);
    }
    (
        json!({"repoKeys": acc.by_repo.iter().map(|(k, _)| k.clone()).collect::<Vec<_>>(), "failure": acc.failure}),
        json!({"kept": acc.kept, "dropped": acc.dropped}),
    )
}

/// The start-up sampling pass over every descriptor (`devswarm.startupSampling`, default on): `{ran, probed, captured}` or `null`
/// when it is switched off or planned nothing.
pub(super) fn sampling(ctx: &Ctx, runner: &dyn Runner, descs: &[Descriptor]) -> Value {
    if !crate::dssup::setting(ctx.st, "devswarm_recon.set_startup_sampling").as_bool().unwrap_or(true) {
        return Value::Null;
    }
    let max = crate::dssup::setting(ctx.st, "devswarm_recon.set_paused_probe_max").as_f64().unwrap_or(0.0).max(1.0) as usize;
    let ids: Vec<String> = descs.iter().map(|d| d.id.clone()).collect();
    let probes: Vec<(String, side::Probe)> =
        side::sampling_candidates(ctx.home, &ids, max).into_iter().map(|id| (id.clone(), side::probe(runner, &id))).collect();
    match side::plan_sampling(ctx.home, &ids, max, &probes, ctx.now) {
        Ok(planned) => {
            let expect = planned.expect.clone();
            let files = side::sampling_scope(&ids).files;
            apply_side(ctx, runner, defaults::text("devswarm_recon.job_sampling"), planned, &files).map_or(Value::Null, |_| expect)
        }
        Err(Defer(why)) => {
            crate::dssup::tick::held("dssup:reconcile:sampling", &why);
            Value::Null
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::checks::git::util::Settings;
    use crate::dsact::runner::RunResult;
    use std::cell::RefCell;

    /// A runner that answers every call with `answer` and counts the listings (the capability probe's `--version` / `--help` calls
    /// are answered too, but not counted).
    struct Listing {
        answer: RunResult,
        calls: RefCell<usize>,
    }

    impl Runner for Listing {
        fn run(&self, spec: &RunSpec) -> RunResult {
            if spec.args.iter().map(String::as_str).eq(defaults::list("devswarm_recon.list_all_args")) {
                *self.calls.borrow_mut() += 1;
            }
            self.answer.clone()
        }
    }

    fn listing(stdout: &str) -> Listing {
        Listing { answer: RunResult { ok: true, status: Some(0), stdout: stdout.into(), ..RunResult::default() }, calls: RefCell::new(0) }
    }

    fn failing(stderr: &str) -> Listing {
        Listing {
            answer: RunResult { ok: false, status: Some(1), stderr: stderr.into(), error: Some(stderr.into()), ..RunResult::default() },
            calls: RefCell::new(0),
        }
    }

    struct Fix {
        _dir: crate::db::TempDir,
        home: std::path::PathBuf,
        st: Settings,
        repo: String,
        key: String,
    }

    fn fix(tag: &str) -> Fix {
        crate::defaults::init().unwrap();
        let dir = crate::db::TempDir::new(tag);
        let home = dir.0.join("home");
        let repo = dir.0.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        assert!(std::process::Command::new("git").args(["init", "-q"]).current_dir(&repo).status().unwrap().success());
        let repo = std::fs::canonicalize(&repo).unwrap().to_string_lossy().into_owned();
        let key = ident::repo_key_for_worktree(&repo).unwrap().unwrap();
        let mut env = std::collections::HashMap::new();
        env.insert("HOME".to_string(), home.to_string_lossy().into_owned());
        let st = Settings { home: home.to_string_lossy().into_owned(), env };
        Fix { _dir: dir, home, st, repo, key }
    }

    impl Fix {
        fn ctx(&self, now: i64) -> Ctx<'_> {
            Ctx { home: &self.home, root: &self.home, st: &self.st, now, engine_pokes: true }
        }
        fn project(&self) -> Project {
            Project { repo_key: self.key.clone(), worktree: self.repo.clone() }
        }
    }

    #[test]
    fn dssup_recon_probe_scopes_the_global_listing_to_the_project_and_writes_the_snapshot() {
        let f = fix("probe-scope");
        let json = format!(
            r#"[{{"id":"w1","worktreePath":"{}","repositoryId":"R1","label":"mine"}},
                {{"id":"sib","worktreePath":"/no/such/.devswarm/repos/1/h/s","repositoryId":"R1"}},
                {{"id":"foreign","worktreePath":"/no/such/other","repositoryId":"R2"}},
                {{"id":"bare"}}]"#,
            f.repo
        );
        let runner = listing(&json);
        let ctx = f.ctx(1_760_000_000_000);
        let mut acc = Acc::default();
        let rec = probe_project(&ctx, &runner, &[], &f.project(), &mut acc);
        assert_eq!(rec, json!({"ok": true, "reason": null, "records": 4}));
        // the project owns its own record and the sibling of the same repository; the other two are dropped, counted once each
        assert_eq!((acc.kept, acc.dropped), (2, 2));
        let (probe, scope) = finish(&ctx, &runner, acc);
        assert_eq!(scope, json!({"kept": 2, "dropped": 2}));
        assert_eq!(probe["repoKeys"], json!([f.key]));
        let text = std::fs::read_to_string(f.home.join(side::active_rel())).unwrap();
        let snap: Value = serde_json::from_str(&text).unwrap();
        let ids: Vec<&str> = snap["byRepoKey"][&f.key].as_array().unwrap().iter().filter_map(|r| r["id"].as_str()).collect();
        assert_eq!(ids, ["w1", "sib"]);
        assert_eq!(snap["recordCount"], 2);
    }

    #[test]
    fn dssup_recon_probe_refuses_an_empty_or_failed_listing_and_writes_nothing() {
        let f = fix("probe-empty");
        let ctx = f.ctx(1_760_000_000_000);
        for runner in [listing("[]"), listing("not json"), failing("hivecontrol exited 3")] {
            let mut acc = Acc::default();
            let rec = probe_project(&ctx, &runner, &[], &f.project(), &mut acc);
            assert_eq!(rec["ok"], false);
            assert!(acc.failure.is_some());
            let (probe, _) = finish(&ctx, &runner, acc);
            assert!(probe["failure"].is_object());
        }
        assert!(!f.home.join(side::active_rel()).exists());
    }

    #[test]
    fn dssup_recon_probe_suppresses_a_repository_hivecontrol_does_not_know() {
        let f = fix("probe-unknown");
        let runner = failing("Repository not found.");
        // no descriptor of the project: it has no live row, so the streak counts
        for sweep in 0..3 {
            let ctx = f.ctx(1_760_000_000_000 + sweep);
            let mut acc = Acc::default();
            probe_project(&ctx, &runner, &[], &f.project(), &mut acc);
        }
        assert_eq!(*runner.calls.borrow(), 3);
        // the third failure engaged the suppression: the next sweep makes no call and reports no answer
        let ctx = f.ctx(1_760_000_000_100);
        let mut acc = Acc::default();
        assert_eq!(probe_project(&ctx, &runner, &[], &f.project(), &mut acc), Value::Null);
        assert_eq!(*runner.calls.borrow(), 3);
    }

    #[test]
    fn dssup_recon_probe_sampling_is_off_when_the_setting_says_so() {
        let mut f = fix("probe-sampling-off");
        f.st.env.insert("ANTIHALL_DEVSWARM_STARTUP_SAMPLING".to_string(), "0".to_string());
        let runner = listing("{}");
        assert_eq!(sampling(&f.ctx(1), &runner, &[]), Value::Null);
        assert_eq!(*runner.calls.borrow(), 0);
    }

    #[test]
    fn dssup_recon_duty_record_carries_node_fields_and_dedupes_repeated_failures() {
        use super::super::{Hooks, duty};
        let f = fix("duty-record");
        // a project with one registered workspace, and a hivecontrol that fails every listing
        let ws = devswarm_root(&f.home).join("workspaces");
        std::fs::create_dir_all(&ws).unwrap();
        let desc = json!({"id": "w1", "worktreePath": f.repo, "sessionId": "s1", "inboxPath": null, "cursorPath": null, "nudgeCommand": null});
        std::fs::write(ws.join("w1.json"), desc.to_string()).unwrap();
        let runner = failing("hivecontrol exited 3");
        let ctx = f.ctx(1_760_000_000_000);
        let first = duty(&ctx, &runner, &Hooks::none());
        let d = &first["detail"];
        assert_eq!(d["ran"], true);
        assert_eq!(d["projects"], 1);
        assert_eq!(d["skipped"], 0);
        let r = &d["results"][0];
        assert_eq!(r["repoKey"], f.key);
        for k in ["ok", "count", "imported", "lost", "skipped", "repoUnknown", "fold", "active"] {
            assert!(r.get(k).is_some() || r.get("held").is_some(), "{k} missing in {r}");
        }
        assert_eq!(r["active"]["ok"], false);
        assert_eq!(d["activeScope"], json!({"kept": 0, "dropped": 0}));
        // the failed listing is a failure of the pass, listed in full the first time and only counted the second
        let list = d["failures"].as_array().expect("failures listed in full the first time");
        assert!(list.iter().any(|x| x["error"].as_str().is_some_and(|e| e.starts_with("active-probe: "))), "{list:?}");
        let second = duty(&f.ctx(1_760_000_000_500), &runner, &Hooks::none());
        assert_eq!(second["detail"]["failures"]["unchanged"], list.len());
        // nothing to reconcile: the pass says so and does not touch the cool-down file
        let empty = fix("duty-empty");
        let rec = duty(&empty.ctx(1), &runner, &Hooks::none());
        assert_eq!(rec["detail"]["ran"], false);
        assert_eq!(rec["detail"]["reason"], "no-descriptors");
    }
}
