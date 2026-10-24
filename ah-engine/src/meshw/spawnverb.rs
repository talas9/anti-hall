//! `spawn <branch> [create options]` (also `ah-engine devswarm create <branch> ...`): the create path of
//! `scripts/devswarm-lib/spawn.js` `cmdSpawn`, run by the engine.
//!
//! In order, as Node runs it: the option checks (an option with no value, or handed the next option), the source freshness check
//! (when the source is the default branch: fetch origin and fast-forward a local branch that is strictly behind, refuse when it
//! cannot be updated unless `--from-local`), the fetch of submodule commits the source pins and the local module clone lacks,
//! `hivecontrol workspace create` behind the capability gate (with its timeout), the loss-free repair of a submodule worktree the
//! create left behind, the registry seed of the new worktree, the title follow-up, the step plan of a numbered brief, the
//! launch-evidence poll, the note about a source branch that already has a workspace, the timings in the central log and the
//! wake-path warning. Every step after the create is best effort and never fails the verb, as in Node.
//!
//! The first git write (a fetch) marks the commit point: from there no step defers.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an unreadable optional file or a failed git query is the absent value (fail-open, as Node's try/catch)
// - a best-effort step after the create never fails the verb (Node: `catch (_) { ... }`)
// A failure that must be seen goes through `crate::discard` instead.
use crate::checks::guardkit::jsre;
use crate::checks::guardkit::ojson::OVal;
use crate::checks::guardkit::text::{is_js_space, js_trim};
use crate::checks::jsport::num::{JsNum, parse_js_number};
use crate::defaults;
use crate::dsact::runner::{RunSpec, Runner, System};
use crate::meshw::common::{self, Inv, Obj, n, s, s_or_null};
use crate::meshw::hivecontrol::{self, Cap};
use crate::meshw::ident::{self, R};
use crate::meshw::idlock::devswarm_root;
use crate::meshw::send::{Answer, Effect};
use crate::meshw::{plan, planverbs};
use std::path::{Path, PathBuf};

fn t(key: &str) -> &'static str {
    defaults::text(key)
}

fn tl(key: &str) -> Vec<&'static str> {
    defaults::list(key)
}

fn tnum(key: &str) -> u64 {
    defaults::num(key)
}

fn tpl(key: &str, args: &[(&str, &str)]) -> String {
    crate::meshw::extverbs::tpl(key, args)
}

fn setting(inv: &Inv, key: &str) -> serde_json::Value {
    crate::dsact::settings::resolve(&inv.settings(), defaults::raw(key))
}

fn answer(code: i32, v: OVal) -> Answer {
    Answer { code, stdout: format!("{}\n", v.stringify()), effect: Effect::None }
}

fn re(key: &str, ci: bool) -> regex::Regex {
    jsre::compile(t(key), ci)
}

/// `Date.now()`: the pinned clock of a test run, else the wall clock.
fn clock(inv: &Inv) -> i64 {
    if defaults::env_var("mesh_now").is_some() { inv.now } else { common::now_ms() }
}

fn strs(v: &[String]) -> OVal {
    OVal::Arr(v.iter().map(|x| s(x)).collect())
}

/// The `i`-th configured text, empty when the list is shorter than expected (a short config list must not panic the verb).
fn nth<'a>(v: &[&'a str], i: usize) -> &'a str {
    v.get(i).copied().unwrap_or("")
}

/// Capture group `i` of a match, empty when the group did not take part.
fn cap<'a>(c: &regex::Captures<'a>, i: usize) -> &'a str {
    c.get(i).map_or("", |m| m.as_str())
}

// ---- argv ----------------------------------------------------------------------------------------------------------------

/// `hasSpawnFlag(rest, short, long)`.
fn has_flag(rest: &[&str], pair: &[&str]) -> bool {
    let (short, long) = (nth(pair, 0), nth(pair, 1));
    rest.iter().any(|a| *a == short || *a == long || a.starts_with(&format!("{long}=")))
}

/// `extractFlagValue(rest, short, long)`: the first match's value.
fn flag_value(rest: &[&str], pair: &[&str]) -> Option<String> {
    let (short, long) = (nth(pair, 0), nth(pair, 1));
    for (i, a) in rest.iter().enumerate() {
        if *a == short || *a == long {
            return rest.get(i + 1).map(|v| (*v).to_string());
        }
        if let Some(v) = a.strip_prefix(&format!("{long}=")) {
            return Some(v.to_string());
        }
    }
    None
}

/// `deriveTitleFromBrief(brief)`: the first non-empty line without one leading markdown marker, white space collapsed.
fn derive_title(brief: Option<&str>) -> Option<String> {
    let brief = brief?;
    let line = brief.split('\n').map(|l| js_trim(l.strip_suffix('\r').unwrap_or(l))).find(|l| !l.is_empty())?;
    let stripped = re("devswarm_cli.sp_title_marker_re", false).replace(line, "");
    let mut out = String::new();
    let mut space = false;
    for c in js_trim(&stripped).chars() {
        if is_js_space(c) {
            space = true;
            continue;
        }
        if space && !out.is_empty() {
            out.push(' ');
        }
        space = false;
        out.push(c);
    }
    (!out.is_empty()).then_some(out)
}

// ---- git -----------------------------------------------------------------------------------------------------------------

/// One git run as Node's `spawnSync` result reads.
struct G {
    status: Option<i32>,
    stdout: String,
    stderr: String,
    error: Option<String>,
}

impl G {
    /// `r && !r.error && r.status === 0`.
    fn ok(&self) -> bool {
        self.error.is_none() && self.status == Some(0)
    }

    /// `out(r)`: the trimmed stdout of a clean run.
    fn out(&self) -> Option<String> {
        self.ok().then(|| js_trim(&self.stdout).to_string())
    }
}

fn git_in(runner: &dyn Runner, dir: &str, args: &[&str], timeout_ms: u64) -> G {
    let mut a: Vec<String> = vec![t("devswarm_cli.sp_git_cwd_flag").to_string(), dir.to_string()];
    a.extend(args.iter().map(|x| (*x).to_string()));
    let r = runner.run(&RunSpec {
        bin: Some(t("devswarm_cli.sp_git").to_string()),
        args: a,
        cwd: None,
        timeout_ms,
        cap_bytes: tnum("devswarm_cli.sp_git_out_cap_bytes"),
        scrub_env: vec![],
    });
    let error = if r.timed_out || r.truncated || r.missing { Some(r.error.clone().unwrap_or_default()) } else { r.error.clone() };
    G { status: r.status, stdout: r.stdout, stderr: r.stderr, error }
}

fn with<'a>(head: &[&'a str], tail: &[&'a str]) -> Vec<&'a str> {
    head.iter().chain(tail.iter()).copied().collect()
}

/// `gitTruth.defaultBranchRef(cwd)`: `origin/<default>` from origin/HEAD, or `None`.
fn default_branch_ref(runner: &dyn Runner, cwd: &str) -> Option<String> {
    let r = git_in(runner, cwd, &tl("devswarm_cli.sp_git_default_ref"), tnum("devswarm_cli.sp_git_timeout_ms"));
    if !r.ok() {
        return None;
    }
    re("devswarm_cli.sp_default_ref_re", false).captures(js_trim(&r.stdout)).map(|c| cap(&c, 1).to_string())
}

/// The repository's common git dir (shared by its worktrees), or `None`.
fn common_dir(cwd: &str) -> Option<String> {
    ident::resolve_context(cwd, false).ok()?.common_dir
}

fn mtime_ms(p: &Path) -> Option<f64> {
    std::fs::metadata(p).ok().map(|m| crate::dssup::liveness::mtime_ms(&m))
}

/// `remoteRefAgeSec(cwd, remoteRef, now)`: seconds since the remote-tracking ref itself last moved (its reflog, else the loose ref).
fn remote_ref_age_sec(cwd: &str, remote_ref: &str, now: i64) -> Option<i64> {
    let common = common_dir(cwd)?;
    let newest = tl("devswarm_cli.sp_reflog_dirs")
        .iter()
        .filter_map(|d| {
            let mut p = PathBuf::from(&common).join(d);
            p.extend(remote_ref.split('/'));
            mtime_ms(&p)
        })
        .fold(None, |acc: Option<f64>, m| Some(acc.map_or(m, |a| a.max(m))))?;
    Some(((now as f64 - newest) / 1000.0).floor().max(0.0) as i64)
}

// ---- source freshness ----------------------------------------------------------------------------------------------------

/// The source check's result: the object `sourceCheck` prints, and the refusal (its error) when the create must not run.
struct SourceCheck {
    obj: OVal,
    refused: Option<String>,
}

fn status_obj(status: &str, fields: Vec<(&str, OVal)>) -> SourceCheck {
    let mut o = Obj::default();
    o.put("status", s(status));
    for (k, v) in fields {
        o.put(k, v);
    }
    SourceCheck { obj: o.done(), refused: None }
}

/// `spawnSourceFreshness(rest, ctx)`.
fn source_freshness(inv: &Inv, runner: &dyn Runner, rest: &[&str]) -> SourceCheck {
    let cwd = inv.cwd.as_str();
    let from_local = rest.contains(&t("devswarm_cli.sp_from_local_flag"));
    let skipped = t("devswarm_cli.sp_status_skipped");
    if setting(inv, "devswarm_cli.sp_set_from_origin").as_bool() == Some(false) {
        return status_obj(skipped, vec![("reason", s(t("devswarm_cli.sp_reason_setting_off")))]);
    }
    let Some(remote_ref) = default_branch_ref(runner, cwd) else {
        return status_obj(skipped, vec![("warning", s(t("devswarm_cli.sp_warn_no_default")))]);
    };
    let def = remote_ref.strip_prefix(t("devswarm_cli.sp_origin_prefix")).unwrap_or(&remote_ref).to_string();
    let git = |args: &[&str], timeout: u64| git_in(runner, cwd, args, timeout);
    let quick = tnum("devswarm_cli.sp_git_timeout_ms");
    let source: Option<String> = match flag_value(rest, &tl("devswarm_cli.sp_flag_source")).filter(|v| !v.is_empty()) {
        Some(v) => Some(v),
        None if inv.env.get(t("devswarm_cli.sp_env_repo_id")).is_some_and(|v| !v.is_empty()) => git(&tl("devswarm_cli.sp_git_current_branch"), quick).out(),
        None => Some(
            tl("devswarm_cli.sp_env_default_sources")
                .iter()
                .find_map(|k| inv.env.get(*k).filter(|v| !v.is_empty()).cloned())
                .unwrap_or_else(|| t("devswarm_cli.sp_fallback_source").to_string()),
        ),
    };
    if source.as_deref() != Some(def.as_str()) {
        let quoted = source.as_deref().map_or_else(|| OVal::Null.stringify(), |x| s(x).stringify());
        return status_obj(skipped, vec![("reason", s(&tpl("devswarm_cli.sp_reason_not_default", &[("source", &quoted), ("def", &def)])))]);
    }
    let source = s(&def);
    let ttl = setting(inv, "devswarm_cli.sp_set_fetch_ttl").as_i64().filter(|v| *v >= 0).unwrap_or(0);
    let mut fetch_note = t("devswarm_cli.sp_fetch_ran").to_string();
    if ttl > 0
        && let Some(age) = remote_ref_age_sec(cwd, &remote_ref, clock(inv))
        && age < ttl
    {
        fetch_note = tpl("devswarm_cli.sp_fetch_skipped", &[("age", &age.to_string())]);
    }
    let mut submodule_fetch: Option<&str> = None;
    let long = tnum("devswarm_cli.sp_fetch_timeout_ms");
    if fetch_note == t("devswarm_cli.sp_fetch_ran") {
        let origin = t("devswarm_cli.sp_origin");
        if !git(&with(&tl("devswarm_cli.sp_git_fetch"), &[origin, &def]), long).ok() {
            if !git(&with(&tl("devswarm_cli.sp_git_fetch_plain"), &[origin, &def]), long).ok() {
                return status_obj(
                    t("devswarm_cli.sp_status_fetch_failed"),
                    vec![
                        ("source", source),
                        ("fetch", s(&fetch_note)),
                        ("warning", s(&tpl("devswarm_cli.sp_warn_fetch_failed", &[("remote", &remote_ref), ("def", &def)]))),
                    ],
                );
            }
            submodule_fetch = Some(t("devswarm_cli.sp_submodule_fetch_failed"));
        }
    }
    let head = |extra: Vec<(&'static str, OVal)>| -> Vec<(&'static str, OVal)> {
        let mut v = vec![("source", s(&def)), ("fetch", s(&fetch_note))];
        if let Some(sf) = submodule_fetch {
            v.push(("submoduleFetch", s(sf)));
        }
        v.extend(extra);
        v
    };
    let commit = t("devswarm_cli.sp_commit_suffix");
    let local_ref = format!("{}{def}{commit}", t("devswarm_cli.sp_heads_prefix"));
    let remote_full = format!("{}{remote_ref}{commit}", t("devswarm_cli.sp_remotes_prefix"));
    let local = git(&with(&tl("devswarm_cli.sp_git_verify"), &[&local_ref]), quick).out();
    let remote = git(&with(&tl("devswarm_cli.sp_git_verify"), &[&remote_full]), quick).out();
    let (Some(local), Some(remote)) = (local, remote) else {
        return status_obj(skipped, head(vec![("warning", s(&tpl("devswarm_cli.sp_warn_unresolved", &[("def", &def), ("remote", &remote_ref)])))]));
    };
    if local == remote {
        return status_obj(t("devswarm_cli.sp_status_up_to_date"), head(vec![("sha", s(&local))]));
    }
    let counts = git(&with(&tl("devswarm_cli.sp_git_counts"), &[&format!("{local}...{remote}")]), quick).out().unwrap_or_default();
    let mut parts = counts.split(is_js_space).filter(|p| !p.is_empty()).map(js_parse_int);
    let (Some(Some(ahead)), Some(Some(behind))) = (parts.next(), parts.next()) else {
        return status_obj(skipped, head(vec![("warning", s(&tpl("devswarm_cli.sp_warn_compare", &[("def", &def), ("remote", &remote_ref)])))]));
    };
    if behind == 0 {
        return status_obj(t("devswarm_cli.sp_status_ahead"), head(vec![("sha", s(&local)), ("ahead", n(ahead as f64))]));
    }
    let refuse = |why: String| -> SourceCheck {
        if from_local {
            status_obj(
                t("devswarm_cli.sp_status_from_local"),
                head(vec![
                    ("sha", s(&local)),
                    ("ahead", n(ahead as f64)),
                    ("behind", n(behind as f64)),
                    ("warning", s(&tpl("devswarm_cli.sp_from_local_warning", &[("why", &why)]))),
                ]),
            )
        } else {
            let error = tpl("devswarm_cli.sp_refuse_error", &[("why", &why), ("def", &def)]);
            let mut sc = status_obj(
                t("devswarm_cli.sp_status_refused"),
                head(vec![("ahead", n(ahead as f64)), ("behind", n(behind as f64)), ("refuse", OVal::Bool(true)), ("error", s(&error))]),
            );
            sc.refused = Some(error);
            sc
        }
    };
    let words = tl("devswarm_cli.sp_commit_words");
    let plural = |k: i64| if k == 1 { nth(&words, 0) } else { nth(&words, 1) };
    // a submodule's stale default branch says so (it is named by its path in the superproject)
    let submodule = ident::resolve_context(cwd, false).ok().and_then(|c| {
        let sub = c.kind.starts_with(defaults::text("mesh_write.kind_submodule_prefix"));
        match (sub, c.worktree_root, c.toplevel) {
            (true, Some(root), Some(top)) => top.strip_prefix(&format!("{root}/")).map(str::to_string).filter(|r| !r.is_empty()),
            _ => None,
        }
    });
    let lead = submodule.as_deref().map_or(String::new(), |p| tpl("devswarm_cli.sp_submodule_prefix", &[("path", p)]));
    let stale = format!(
        "{lead}{}",
        tpl("devswarm_cli.sp_stale_line", &[("def", &def), ("behind", &behind.to_string()), ("commits", plural(behind)), ("remote", &remote_ref)])
    );
    if ahead > 0 {
        return refuse(format!(
            "{stale}{}",
            tpl("devswarm_cli.sp_ahead_suffix", &[("ahead", &ahead.to_string()), ("commits", plural(ahead)), ("remote", &remote_ref)])
        ));
    }
    let Some(listing) = git(&tl("devswarm_cli.sp_git_worktrees"), quick).out() else {
        return refuse(format!("{stale}{}", t("devswarm_cli.sp_no_worktree_list")));
    };
    let mut checked_out: Option<String> = None;
    let mut wt: Option<String> = None;
    let branch_line = format!("{}{def}", t("devswarm_cli.sp_wt_line_branch"));
    for line in listing.split('\n') {
        if let Some(p) = line.strip_prefix(t("devswarm_cli.sp_wt_line_worktree")) {
            wt = Some(p.to_string());
        } else if line == branch_line {
            checked_out = wt.clone();
            break;
        }
    }
    let r = match checked_out.filter(|c| !c.is_empty()) {
        Some(at) => {
            let dirty = git_in(runner, &at, &tl("devswarm_cli.sp_git_status"), quick).out();
            if dirty.as_deref() != Some("") {
                let mod_dir = re("devswarm_cli.sp_moddir_re", false).captures(&at).map(|c| cap(&c, 1).to_string());
                if submodule.is_some() || mod_dir.is_some() {
                    let line = match (&submodule, mod_dir) {
                        (Some(_), _) | (None, None) => stale.clone(),
                        (None, Some(m)) => {
                            let name = re("devswarm_cli.sp_modules_split_re", false).split(&m).collect::<Vec<_>>().join("/").replace('\\', "/");
                            format!("{}{stale}", tpl("devswarm_cli.sp_submodule_prefix", &[("path", &name)]))
                        }
                    };
                    return refuse(format!("{line}{}", t("devswarm_cli.sp_submodule_dirty")));
                }
                return refuse(format!("{stale}{}", tpl("devswarm_cli.sp_checked_out_dirty", &[("def", &def), ("at", &at)])));
            }
            git_in(runner, &at, &with(&tl("devswarm_cli.sp_git_ff"), &[&format!("{}{remote_ref}", t("devswarm_cli.sp_remotes_prefix"))]), long)
        }
        None => {
            let msg = tpl("devswarm_cli.sp_update_ref_msg", &[("remote", &remote_ref)]);
            let head_ref = format!("{}{def}", t("devswarm_cli.sp_heads_prefix"));
            git(&with(&tl("devswarm_cli.sp_git_update_ref"), &[&msg, &head_ref, &remote, &local]), quick)
        }
    };
    if !r.ok() {
        let raw = if !r.stderr.is_empty() {
            r.stderr.clone()
        } else {
            r.error.clone().filter(|e| !e.is_empty()).unwrap_or_else(|| t("devswarm_cli.sp_unknown").to_string())
        };
        let detail = js_trim(&raw).split('\n').next().unwrap_or_default().to_string();
        return refuse(format!("{stale}{}", tpl("devswarm_cli.sp_ff_failed", &[("detail", &detail)])));
    }
    status_obj(t("devswarm_cli.sp_status_ff"), head(vec![("from", s(&local)), ("sha", s(&remote)), ("behind", n(behind as f64))]))
}

/// `parseInt(x, 10)`: the leading decimal digits (after an optional sign), or `None` for NaN.
fn js_parse_int(x: &str) -> Option<i64> {
    let (neg, body) = match x.strip_prefix('-') {
        Some(b) => (true, b),
        None => (false, x.strip_prefix('+').unwrap_or(x)),
    };
    let digits: String = body.chars().take_while(char::is_ascii_digit).collect();
    let v: i64 = digits.parse().ok()?;
    Some(if neg { -v } else { v })
}

// ---- submodules ----------------------------------------------------------------------------------------------------------

/// `submodulePathsFor(cwd)`: the `path = ...` of every submodule `.gitmodules` declares, `None` when there is none.
fn submodule_paths(cwd: &str) -> Option<Vec<String>> {
    let text = std::fs::read_to_string(Path::new(cwd).join(t("devswarm_cli.sp_gitmodules"))).ok()?;
    let paths: Vec<String> =
        jsre::compile_multiline(t("devswarm_cli.sp_gitmodules_path_re"), false).captures_iter(&text).map(|c| cap(&c, 1).to_string()).collect();
    (!paths.is_empty()).then_some(paths)
}

/// `submoduleGitDir(common, wt, S)`: the submodule's own git dir, keyed by its name (usually its path).
fn submodule_git_dir(common: &str, wt: &str, sub: &str) -> PathBuf {
    let modules = PathBuf::from(common).join(t("devswarm_cli.sp_modules_dir"));
    if let Ok(text) = std::fs::read_to_string(Path::new(wt).join(t("devswarm_cli.sp_gitmodules"))) {
        let path_re = jsre::compile_multiline(t("devswarm_cli.sp_gitmodules_path_re"), false);
        for c in re("devswarm_cli.sp_gitmodules_section_re", false).captures_iter(&text) {
            if path_re.captures(cap(&c, 2)).is_some_and(|p| cap(&p, 1) == sub) {
                let cand = modules.join(cap(&c, 1));
                if cand.exists() {
                    return cand;
                }
            }
        }
    }
    modules.join(sub)
}

fn last_line(raw: &str) -> String {
    js_trim(raw).split('\n').next_back().unwrap_or_default().to_string()
}

/// `fetchMissingSubmoduleCommit(modGit, sha)`: `Ok(fetched)` when the commit is (now) present, else the errors.
fn fetch_missing_commit(runner: &dyn Runner, mod_git: &str, sha: &str) -> Result<bool, String> {
    let long = tnum("devswarm_cli.sp_fetch_timeout_ms");
    let have_args: Vec<String> = tl("devswarm_cli.sp_git_have_commit").iter().map(|a| a.replace("{sha}", sha)).collect();
    let have = || git_in(runner, mod_git, &have_args.iter().map(String::as_str).collect::<Vec<_>>(), long).status == Some(0);
    if have() {
        return Ok(false);
    }
    let texts = tl("devswarm_cli.sp_fetch_failed_texts");
    let mut errs: Vec<String> = Vec::new();
    let why = |g: &G, fallback: &str| -> String {
        let raw = if !g.stderr.is_empty() { g.stderr.clone() } else { g.error.clone().filter(|e| !e.is_empty()).unwrap_or_else(|| fallback.to_string()) };
        last_line(&raw)
    };
    let f1 = git_in(runner, mod_git, &tl("devswarm_cli.sp_git_fetch_origin"), long);
    if f1.status != Some(0) {
        errs.push(why(&f1, nth(&texts, 0)));
    }
    if have() {
        return Ok(true);
    }
    let f2 = git_in(runner, mod_git, &with(&tl("devswarm_cli.sp_git_fetch_origin"), &[sha]), long);
    if f2.status != Some(0) {
        errs.push(why(&f2, nth(&texts, 1)));
    }
    if have() {
        return Ok(true);
    }
    let joined = errs.into_iter().filter(|e| !e.is_empty()).collect::<Vec<_>>().join("; ");
    Err(if joined.is_empty() { nth(&texts, 2).to_string() } else { joined })
}

/// `preflightSubmoduleCommits(cwd, rest)`: `(fetched [(path, sha)], failed [(path, sha, error)])`.
type Preflight = (Vec<(String, String)>, Vec<(String, String, String)>);

fn preflight_submodules(runner: &dyn Runner, cwd: &str, rest: &[&str]) -> Preflight {
    let mut out: Preflight = (Vec::new(), Vec::new());
    let Some(paths) = submodule_paths(cwd) else { return out };
    let Some(common) = common_dir(cwd) else { return out };
    let refs: Vec<String> = match flag_value(rest, &tl("devswarm_cli.sp_flag_source")).filter(|v| !v.is_empty()) {
        Some(src) => vec![src.clone(), format!("{}{src}", t("devswarm_cli.sp_origin_prefix"))],
        None => vec![t("devswarm_cli.sp_head_ref").to_string()],
    };
    let sha_re = re("devswarm_cli.sp_sha_re", false);
    let long = tnum("devswarm_cli.sp_fetch_timeout_ms");
    for sub in &paths {
        let sha = refs.iter().find_map(|r| {
            let g = git_in(runner, cwd, &with(&tl("devswarm_cli.sp_git_branch_exists"), &[&format!("{r}:{sub}")]), long);
            let v = js_trim(&g.stdout).to_string();
            (g.status == Some(0) && sha_re.is_match(&v)).then_some(v)
        });
        let Some(sha) = sha else { continue };
        let mod_git = submodule_git_dir(&common, cwd, sub);
        if !mod_git.exists() {
            continue;
        }
        match fetch_missing_commit(runner, &mod_git.to_string_lossy(), &sha) {
            Err(e) => out.1.push((sub.clone(), sha, e)),
            Ok(true) => out.0.push((sub.clone(), sha)),
            Ok(false) => {}
        }
    }
    out
}

/// A submodule worktree the create failed to make.
#[derive(Clone)]
struct Failure {
    path: Option<String>,
    error: String,
    repair_error: Option<String>,
}

impl Failure {
    fn json(&self) -> OVal {
        let mut o = Obj::default();
        o.put("path", s_or_null(self.path.as_deref())).put("error", s(&self.error));
        if let Some(r) = &self.repair_error {
            o.put("repairError", s(r));
        }
        o.done()
    }
}

/// The byte index `units` UTF-16 code units before `idx` (JavaScript's `slice` counts those).
fn back_utf16(text: &str, idx: usize, units: usize) -> usize {
    let mut left = units;
    for (i, c) in text.get(..idx).unwrap_or("").char_indices().rev() {
        let w = c.len_utf16();
        if w > left {
            return i + c.len_utf8();
        }
        left -= w;
        if left == 0 {
            return i;
        }
    }
    0
}

/// `/git worktree add\b[^\n]*?(?=\\n|\n|$)/g` over `text`: each echoed command up to the first literal `\n`, newline or the end.
fn echoes(text: &str) -> Vec<&str> {
    let head = t("devswarm_cli.sp_echo_head");
    let mut out = Vec::new();
    let mut from = 0usize;
    while let Some(p) = text.get(from..).unwrap_or("").find(head) {
        let start = from + p;
        let after = start + head.len();
        if text.get(after..).unwrap_or("").chars().next().is_some_and(|c| c.is_ascii_alphanumeric() || c == '_') {
            from = after;
            continue;
        }
        let rest = text.get(after..).unwrap_or("");
        let stop = [rest.find("\\n"), rest.find('\n')].into_iter().flatten().min().unwrap_or(rest.len());
        out.push(text.get(start..after + stop).unwrap_or(""));
        from = after + stop;
        if from >= text.len() {
            break;
        }
    }
    out
}

/// `parseSubmoduleWorktreeFailures(res, cwd)`: the failed submodule worktree adds the create output names.
fn parse_failures(raw: &str, stderr: &str, cwd: &str) -> Vec<Failure> {
    let mut out: Vec<Failure> = Vec::new();
    let text = [raw, stderr].iter().filter(|x| !x.is_empty()).copied().collect::<Vec<_>>().join("\n");
    if text.is_empty() {
        return out;
    }
    let paths = submodule_paths(cwd);
    let known = |p: &str| paths.as_ref().is_some_and(|ps| ps.iter().any(|sp| p == sp || p.ends_with(&format!("/{sp}"))));
    let mentions_worktree = re("devswarm_cli.sp_fail_worktree_word_re", true).is_match(&text);
    let keys = tl("devswarm_cli.sp_fail_key_prefixes");
    let mut seen: Vec<String> = Vec::new();
    for c in re("devswarm_cli.sp_fail_exists_re", false).captures_iter(&text) {
        let p = cap(&c, 1).to_string();
        if !(known(&p) || mentions_worktree) {
            continue;
        }
        let key = format!("{}{p}", nth(&keys, 0));
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        out.push(Failure { path: Some(p), error: t("devswarm_cli.sp_fail_already_exists").to_string(), repair_error: None });
    }
    let exists_line = re("devswarm_cli.sp_fail_exists_line_re", false);
    let worktree_word = re("devswarm_cli.sp_fail_worktree_word_re", true);
    let echo_path = re("devswarm_cli.sp_fail_echo_path_re", false);
    let fatal = t("devswarm_cli.sp_fail_fatal_word");
    for c in re("devswarm_cli.sp_fail_generic_re", false).captures_iter(&text) {
        let whole = c.get(0).map_or("", |m| m.as_str());
        if exists_line.is_match(whole) {
            continue;
        }
        let line = js_trim(cap(&c, 1)).to_string();
        let mentions_path = paths.as_ref().is_some_and(|ps| ps.iter().any(|sp| line.contains(sp.as_str())));
        let idx = c.get(0).map_or(0, |m| m.start());
        let before = text.get(back_utf16(&text, idx, tnum("devswarm_cli.sp_fail_lookback") as usize)..idx).unwrap_or("");
        let echo = echoes(before).last().copied();
        let after_echo = echo.and_then(|e| before.rfind(e).map(|at| before.get(at + e.len()..).unwrap_or(""))).unwrap_or("");
        let tied = echo.is_some() && !after_echo.contains(fatal);
        if !(worktree_word.is_match(&line) || mentions_path || tied) {
            continue;
        }
        let mut fail_path = None;
        if tied && let Some(pm) = echo.and_then(|e| echo_path.captures(e)) {
            let p = cap(&pm, 1);
            let p = p.strip_prefix(['\'', '"']).unwrap_or(p);
            fail_path = Some(p.strip_suffix(['\'', '"']).unwrap_or(p).to_string());
        }
        let key = format!("{}{line}", nth(&keys, 1));
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        out.push(Failure { path: fail_path, error: line, repair_error: None });
    }
    out
}

/// One repaired submodule worktree (its JSON).
type Repaired = OVal;

/// `realpath(dirname(x)) + '/' + basename(x)`, else `x`.
fn real_parent(x: &str) -> String {
    match ident::realpath(&ident::dirname(x)) {
        Some(d) => format!("{d}/{}", ident::basename(x)),
        None => x.to_string(),
    }
}

/// `repairSubmoduleWorktrees(failures, text, branch, cwd)` for one failure: the repaired record, `Ok(None)` when it is not the
/// shape the repair handles (the failure stays as reported), or the error (any moved-aside directory is put back first).
fn repair_one(runner: &dyn Runner, f: &Failure, text: &str, branch: &str, sub_paths: Option<&[String]>, now: i64) -> Result<Option<Repaired>, String> {
    let Some(p) = f.path.as_deref() else { return Ok(None) };
    let sub = match sub_paths {
        Some(ps) if p.starts_with('/') => ps.iter().find(|sp| p.ends_with(&format!("/{sp}"))),
        _ => None,
    };
    let missing_object = re("devswarm_cli.sp_missing_object_re", true).is_match(&f.error);
    let Some(sub) = sub else { return Ok(None) };
    if f.error != t("devswarm_cli.sp_fail_already_exists") && !missing_object {
        return Ok(None);
    }
    let wt = p.get(..p.len().saturating_sub(sub.len() + 1)).unwrap_or("");
    let Some(common) = common_dir(wt) else { return Ok(None) };
    let mod_git = submodule_git_dir(&common, wt, sub);
    let mod_git_s = mod_git.to_string_lossy().to_string();
    let link = Path::new(p).join(t("devswarm_cli.sp_git_dir_name"));
    if !mod_git.exists() || link.exists() {
        return Ok(None);
    }
    let long = tnum("devswarm_cli.sp_repair_timeout_ms");
    let mut b = branch.to_string();
    let mut sha: Option<String> = None;
    let pat = t("devswarm_cli.sp_echo_add_re").replace("{path}", &regex::escape(p));
    if let Some(cm) = regex::Regex::new(&pat).ok().and_then(|r| r.captures(text).map(|c| (cap(&c, 1).to_string(), cap(&c, 2).to_string()))) {
        b = cm.0;
        sha = Some(cm.1);
    }
    if b.is_empty() {
        return Ok(None);
    }
    if sha.is_none() {
        let g = git_in(
            runner,
            wt,
            &with(tl("devswarm_cli.sp_git_branch_exists").get(..1).unwrap_or(&[]), &[&format!("{}:{sub}", t("devswarm_cli.sp_head_ref"))]),
            long,
        );
        let v = js_trim(&g.stdout).to_string();
        if g.status == Some(0) && re("devswarm_cli.sp_sha_re", false).is_match(&v) {
            sha = Some(v);
        }
    }
    if missing_object && let Some(sh) = &sha {
        fetch_missing_commit(runner, &mod_git_s, sh).map_err(|e| tpl("devswarm_cli.sp_err_pinned_missing", &[("sha", sh), ("error", &e)]))?;
    }
    let meta = std::fs::symlink_metadata(p).ok();
    if meta.as_ref().is_some_and(|m| !m.is_dir()) {
        return Ok(None);
    }
    let mut aside: Option<String> = None;
    if meta.is_some() {
        let empty = std::fs::read_dir(p).map(|mut r| r.next().is_none()).map_err(|e| e.to_string())?;
        if empty {
            std::fs::remove_dir(p).map_err(|e| e.to_string())?;
        } else {
            let mut k = 0u32;
            let base = format!("{p}{}{}-{}", t("devswarm_cli.sp_aside_infix"), std::process::id(), to_base36(now.max(0) as u64));
            let mut cand = base.clone();
            while Path::new(&cand).exists() {
                k += 1;
                cand = format!("{base}-{k}");
            }
            std::fs::rename(p, &cand).map_err(|e| e.to_string())?;
            aside = Some(cand);
        }
    }
    let result = (|| -> Result<Repaired, String> {
        let wl = git_in(runner, &mod_git_s, &tl("devswarm_cli.sp_git_worktrees"), long);
        let listing = if wl.status == Some(0) { wl.stdout.clone() } else { String::new() };
        let real_p = real_parent(p);
        let prefix = t("devswarm_cli.sp_wt_line_worktree");
        let blocks: Vec<(String, &str)> =
            listing.split("\n\n").map(|blk| (blk.split('\n').next().unwrap_or_default().get(prefix.len()..).unwrap_or_default().to_string(), blk)).collect();
        if blocks.iter().any(|(d, _)| d == p || *d == real_p) {
            git_in(runner, &mod_git_s, &tl("devswarm_cli.sp_git_wt_prune"), long);
        }
        let bl = format!("{}{b}", t("devswarm_cli.sp_wt_line_branch"));
        let other = blocks.iter().find(|(_, blk)| blk.contains(&format!("{bl}\n")) || blk.ends_with(&bl));
        if let Some((d, _)) = other
            && d != p
            && *d != real_p
            && Path::new(d).exists()
        {
            return Err(tpl("devswarm_cli.sp_err_branch_elsewhere", &[("branch", &b)]));
        }
        let head_ref = format!("{}{b}", t("devswarm_cli.sp_heads_prefix"));
        let exists = git_in(runner, &mod_git_s, &with(&tl("devswarm_cli.sp_git_branch_exists"), &[&head_ref]), long).status == Some(0);
        let add = tl("devswarm_cli.sp_git_wt_add");
        let new_b = t("devswarm_cli.sp_git_new_branch");
        let args: Vec<&str> = match (&sha, exists) {
            (_, true) => with(&add, &[p, &b]),
            (Some(sh), false) => with(&add, &[new_b, &b, p, sh]),
            (None, false) => with(&add, &[new_b, &b, p]),
        };
        let added = git_in(runner, &mod_git_s, &args, long);
        if added.status != Some(0) || !link.exists() {
            let raw = if added.stderr.is_empty() { t("devswarm_cli.sp_err_add_failed").to_string() } else { added.stderr.clone() };
            return Err(last_line(&raw));
        }
        let mut moved: Vec<String> = Vec::new();
        let mut identical: Vec<String> = Vec::new();
        let mut conflicts: Vec<OVal> = Vec::new();
        let mut warnings: Vec<String> = Vec::new();
        let mut leftover: Option<String> = None;
        if let Some(a) = aside.take() {
            let names: Vec<String> = std::fs::read_dir(&a).map_err(|e| e.to_string())?.flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect();
            for e in names {
                let src = Path::new(&a).join(&e);
                let dest = Path::new(p).join(&e);
                if std::fs::symlink_metadata(&dest).is_err() {
                    std::fs::rename(&src, &dest).map_err(|x| x.to_string())?;
                    moved.push(e);
                    continue;
                }
                let same = match (std::fs::symlink_metadata(&src), std::fs::symlink_metadata(&dest)) {
                    (Ok(x), Ok(y)) if x.is_file() && y.is_file() => {
                        std::fs::read(&src).ok().is_some_and(|bx| std::fs::read(&dest).ok().is_some_and(|by| bx == by))
                    }
                    _ => false,
                };
                if same {
                    // the aside copy is one this verb moved aside and is byte-identical to the checked-out one: nothing is lost
                    std::fs::remove_file(&src).map_err(|x| x.to_string())?;
                    identical.push(e);
                    continue;
                }
                let (dest_s, src_s) = (dest.to_string_lossy().to_string(), src.to_string_lossy().to_string());
                let mut c = Obj::default();
                c.put("file", s(&e))
                    .put("inPlace", s(&dest_s))
                    .put("kept", s(&src_s))
                    .put("note", s(&tpl("devswarm_cli.sp_conflict_note", &[("in_place", &dest_s), ("kept", &src_s)])));
                conflicts.push(c.done());
            }
            if std::fs::remove_dir(&a).is_err() {
                let names: Vec<String> =
                    std::fs::read_dir(&a).map(|r| r.flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect()).unwrap_or_default();
                let secret = re("devswarm_cli.sp_secret_like_re", true);
                let like: Vec<String> = names.into_iter().filter(|nm| secret.is_match(nm)).collect();
                if !like.is_empty() {
                    warnings.push(tpl("devswarm_cli.sp_secret_warning", &[("leftover", &a), ("names", &like.join(", "))]));
                }
                leftover = Some(a);
            }
        }
        let mut o = Obj::default();
        o.put("path", s(p)).put("branch", s(&b)).put("sha", s_or_null(sha.as_deref())).put("reusedBranch", OVal::Bool(exists)).put("movedBack", strs(&moved));
        if !identical.is_empty() {
            o.put("identical", strs(&identical));
        }
        if !conflicts.is_empty() {
            o.put("conflicts", OVal::Arr(conflicts));
        }
        if let Some(l) = leftover {
            o.put("leftoverAside", s(&l));
        }
        if !warnings.is_empty() {
            o.put("warnings", strs(&warnings));
        }
        Ok(o.done())
    })();
    if result.is_err()
        && let Some(a) = &aside
        && !Path::new(p).exists()
    {
        // put the moved-aside directory back so nothing is lost
        crate::discard::logged("spawn_repair_restore", std::fs::rename(a, p));
    }
    result.map(Some)
}

fn to_base36(mut v: u64) -> String {
    let digits = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    loop {
        out.push(digits.get((v % 36) as usize).copied().unwrap_or(b'0'));
        v /= 36;
        if v == 0 {
            break;
        }
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

/// `repairSubmoduleWorktrees(...)`: `(repaired, remaining)`.
fn repair(runner: &dyn Runner, failures: Vec<Failure>, text: &str, branch: &str, cwd: &str, now: i64) -> (Vec<Repaired>, Vec<Failure>) {
    let sub_paths = submodule_paths(cwd);
    let (mut repaired, mut remaining) = (Vec::new(), Vec::new());
    for f in failures {
        match repair_one(runner, &f, text, branch, sub_paths.as_deref(), now) {
            Ok(Some(r)) => repaired.push(r),
            Ok(None) => remaining.push(f),
            Err(e) => remaining.push(Failure { repair_error: Some(e), ..f }),
        }
    }
    (repaired, remaining)
}

// ---- the capability gate -------------------------------------------------------------------------------------------------

/// `gatedRun(run)` for `workspace <verb>`: the call, or Node's dormant answer when the build lacks the verb.
fn gated_call(inv: &Inv, runner: &dyn Runner, verb: &str, args: &[&str], timeout: std::time::Duration) -> hivecontrol::Full {
    let mut cap = hivecontrol::cap_verb(&inv.env, &inv.home, verb, None, None);
    if cap == Cap::Probe {
        crate::dssup::recon::capprobe::ensure(&inv.home, clock(inv), &inv.env, runner, verb);
        cap = hivecontrol::cap_verb(&inv.env, &inv.home, verb, None, None);
    }
    if let Cap::Dormant(reason) = cap {
        let name = format!("{}{verb}", defaults::text("devswarm_cli.hc_cap_prefix"));
        let error = defaults::render("devswarm_recon.msg_capability_dormant", &[("name", &name), ("reason", &reason)]);
        return hivecontrol::Full { call: hivecontrol::Call { error, ..hivecontrol::Call::default() }, ..hivecontrol::Full::default() };
    }
    hivecontrol::call_full(args, &inv.env, Some(&inv.cwd), timeout)
}

// ---- after the create ----------------------------------------------------------------------------------------------------

/// `resolveCreatedWorktreePath(res)`: the `path`/`worktreePath` of the create answer, top level or under `workspace`.
fn created_path(raw: &str) -> Option<String> {
    let v = OVal::parse(raw)?;
    let keys = tl("devswarm_cli.sp_result_paths");
    if !matches!(v, OVal::Obj(_)) {
        return None;
    }
    // `parsed.path || parsed.worktreePath || (nested && (nested.path || nested.worktreePath))`: the first truthy one, then a string check
    let top = keys.get(1..).unwrap_or(&[]).iter().find_map(|k| v.get(k).filter(|x| x.truthy()).cloned());
    let found = match top {
        Some(x) => Some(x),
        None => v
            .get(nth(&keys, 0))
            .filter(|n| matches!(n, OVal::Obj(_)))
            .and_then(|nested| keys.get(1..).unwrap_or(&[]).iter().find_map(|k| nested.get(k).filter(|x| x.truthy()).cloned())),
    };
    match found {
        Some(OVal::Str(p)) if !p.is_empty() => Some(p),
        _ => None,
    }
}

/// The registry seed of the new worktree (`upsertRegistry` + `deriveSummary`); `false` when it could not be written.
fn seed_registry(inv: &Inv, mesh_id: &str, wt: &str, now: i64) -> bool {
    let Ok(Some(repo_key)) = ident::resolve_context(&inv.cwd, true).map(|c| c.repo_key) else { return false };
    if common::open_store(inv, &repo_key).is_err() && common::init_new_store(inv, &repo_key).is_err() {
        return false;
    }
    let Ok(st) = common::open_store(inv, &repo_key) else { return false };
    let row = crate::meshw::store::RegistryRow { id: mesh_id.to_string(), worktree_path: Some(wt.to_string()), ..Default::default() };
    let same = |a: &str, b: &str| a == b || ident::realpath(a).is_some_and(|x| ident::realpath(b).is_some_and(|y| x == y));
    if st.upsert_registry(&row, now, same).is_err() {
        return false;
    }
    let mut at = inv.clone();
    at.now = now;
    if let Some(why) = crate::meshw::summary::derive_after_write(&st, &at, &repo_key) {
        crate::meshw::log_summary_failure(t("devswarm_cli.sp_log_op"), &why);
    }
    true
}

/// The plan a numbered brief becomes (`planInfo`), or `None` without `-p` or with plan tracking off.
fn write_plan(inv: &Inv, runner: &dyn Runner, rest: &[&str], wt: Option<&str>, mesh_id: Option<&str>, now: i64) -> Option<OVal> {
    let brief = flag_value(rest, &tl("devswarm_cli.sp_flag_prompt"))?;
    if !crate::dsact::settings::resolve(&inv.settings(), defaults::raw("devswarm_cli.sp_set_plan_tracking")).as_bool().unwrap_or(true) {
        return None;
    }
    let reasons = tl("devswarm_cli.sp_plan_reasons");
    let failed = |e: String| {
        let mut o = Obj::default();
        o.put("written", OVal::Bool(false)).put("reason", s(nth(&reasons, 2))).put("error", s(&e));
        o.done()
    };
    let steps = match planverbs::parse_steps(&brief) {
        Ok(v) => v,
        Err(ident::Defer(d)) => return Some(failed(d)),
    };
    let key = wt.and_then(|w| plan::key_for_worktree(w).ok().flatten());
    match (steps.is_empty(), key, wt) {
        (false, Some(key), Some(wt)) => {
            let head = git_in(runner, wt, &tl("devswarm_cli.sp_git_head"), tnum("devswarm_cli.sp_base_timeout_ms"));
            let base = head.ok().then(|| js_trim(&head.stdout).to_string()).filter(|x| !x.is_empty());
            let scope = re_scope(&brief);
            let p =
                planverbs::new_plan(&key, mesh_id.unwrap_or_default(), Some(wt), &steps, &scope, base.as_deref(), t("devswarm_cli.sp_plan_source"), now as f64);
            let scope_globs = p.get("scope_globs").cloned().unwrap_or(OVal::Arr(Vec::new()));
            let written = plan::update_with(inv, &key, |_| Ok(((), Some(p.clone()))));
            match written {
                Ok(Some((_, Some(text)))) => {
                    crate::meshw::note_written(&plan::plan_rel(&key), text.as_bytes());
                    // Node rotates the supervision log before it appends (best effort)
                    crate::dssup::suplog::rotate_if_needed(&inv.home);
                    let fields = vec![
                        ("id".to_string(), s_or_null(mesh_id)),
                        ("key".to_string(), s(&key)),
                        ("source".to_string(), s(t("devswarm_cli.sp_plan_source"))),
                        ("steps".to_string(), n(steps.len() as f64)),
                    ];
                    if plan::record(inv, defaults::text("devswarm_cli.plan_event_plan"), &fields, now as f64).is_some() {
                        plan::note_log(inv);
                    }
                    let mut o = Obj::default();
                    o.put("written", OVal::Bool(true)).put("key", s(&key)).put("steps", n(steps.len() as f64)).put("scope", scope_globs);
                    Some(o.done())
                }
                Ok(_) => Some(failed(t("devswarm_cli.sp_plan_busy").to_string())),
                Err(ident::Defer(d)) => Some(failed(d)),
            }
        }
        (empty, _, _) => {
            let mut o = Obj::default();
            o.put("written", OVal::Bool(false))
                .put("reason", s(if empty { nth(&reasons, 1) } else { nth(&reasons, 0) }))
                .put("hint", s(t("devswarm_cli.sp_plan_hint")));
            if setting(inv, "devswarm_cli.sp_set_plan_required").as_bool() == Some(true) {
                o.put("required", OVal::Bool(true));
            }
            Some(o.done())
        }
    }
}

/// `parseScope(text)`: the globs of the first `scope:` line.
fn re_scope(brief: &str) -> Vec<String> {
    jsre::compile_multiline(t("devswarm_cli.sp_scope_re"), true).captures(brief).map(|c| planverbs::split_globs(cap(&c, 1))).unwrap_or_default()
}

/// The launch-evidence poll (`checkSpawnLaunch`): `{launched, evidence, waitedMs, windowMs[, launchWindowClamped, launchWindowRequestedMs]}`.
struct Launch {
    launched: bool,
    evidence: Option<&'static str>,
    waited: i64,
    window: i64,
    requested: Option<i64>,
}

fn launch_window(inv: &Inv) -> (i64, i64) {
    let dflt = tnum("devswarm_cli.sp_launch_wait_ms") as i64;
    let requested = match inv.env.get(t("devswarm_cli.sp_env_launch_wait")).map(|r| js_trim(r).to_string()) {
        None => dflt,
        Some(r) if r.is_empty() => dflt,
        Some(r) => match parse_js_number(&r) {
            JsNum::Val(v) if v.is_finite() && v >= 0.0 => v.floor() as i64,
            _ => dflt,
        },
    };
    (requested, requested.min(tnum("devswarm_cli.sp_launch_wait_max_ms") as i64))
}

fn check_launch(inv: &Inv, mesh_id: &str, since: i64) -> Launch {
    let (requested, window) = launch_window(inv);
    let ev = tl("devswarm_cli.sp_evidence");
    let started = clock(inv);
    let wall = std::time::Instant::now();
    let store = ident::resolve_context(&inv.cwd, true).ok().and_then(|c| c.repo_key).and_then(|k| common::open_store(inv, &k).ok());
    let desc_path =
        devswarm_root(&inv.home).join(defaults::text("mesh_write.dir_workspaces")).join(format!("{mesh_id}{}", defaults::text("mesh_write.json_suffix")));
    let evidence_now = || -> Option<&'static str> {
        if crate::dssup::liveness::heartbeat_ts(&inv.home, mesh_id).is_some_and(|ts| ts.is_finite() && ts >= since as f64) {
            return Some(nth(&ev, 0));
        }
        if let Some(st) = &store
            && let Ok(rows) = st.reader().roster()
            && let Some(row) = rows.iter().find(|r| match &r["id"] {
                serde_json::Value::String(x) => x == mesh_id,
                serde_json::Value::Number(x) => x.to_string() == mesh_id,
                _ => false,
            })
            && row["updatedAt"].as_f64().is_some_and(|u| u.is_finite() && u >= since as f64)
        {
            let set = |k: &str| match &row[k] {
                serde_json::Value::Null => false,
                serde_json::Value::String(x) => !x.is_empty(),
                _ => true,
            };
            if set("sessionId") {
                return Some(nth(&ev, 1));
            }
            if set("inboxPath") {
                return Some(nth(&ev, 2));
            }
        }
        if ident::read_descriptor(&inv.home, mesh_id).is_some() && mtime_ms(&desc_path).is_some_and(|m| m >= since as f64) {
            return Some(nth(&ev, 3));
        }
        None
    };
    let step = std::time::Duration::from_millis(tnum("devswarm_cli.sp_launch_step_ms"));
    let limit = std::time::Duration::from_millis(window.max(0) as u64);
    let found = loop {
        if let Some(e) = evidence_now() {
            break Some(e);
        }
        let spent = wall.elapsed();
        if spent >= limit {
            break None;
        }
        std::thread::sleep(step.min(limit - spent));
    };
    Launch { launched: found.is_some(), evidence: found, waited: clock(inv) - started, window, requested: (requested > window).then_some(requested) }
}

/// `sourceWorkspaceNote(rest, ctx)`: the note when the named source branch (not the default one) already has a workspace in the app.
fn source_note(inv: &Inv, runner: &dyn Runner, rest: &[&str]) -> Option<String> {
    let source = flag_value(rest, &tl("devswarm_cli.sp_flag_source")).filter(|v| !v.is_empty())?;
    let remote_ref = default_branch_ref(runner, &inv.cwd)?;
    if remote_ref.strip_prefix(t("devswarm_cli.sp_origin_prefix")) == Some(source.as_str()) {
        return None;
    }
    let file = ident::app_db_path(&inv.home, &inv.env)?;
    if !std::fs::metadata(&file).is_ok_and(|m| m.is_file()) {
        return None;
    }
    let conn = crate::meshw::appdb::open(&file)?;
    let norm = |p: &str| -> String {
        let r = ident::resolve_abs(p);
        ident::realpath(&r).unwrap_or(r)
    };
    let text_of = |v: rusqlite::types::Value| -> Option<String> {
        match v {
            rusqlite::types::Value::Text(x) => Some(x),
            rusqlite::types::Value::Integer(i) => Some(i.to_string()),
            rusqlite::types::Value::Real(f) => Some(crate::checks::jsport::num::to_js_string(f)),
            _ => None,
        }
    };
    let repos: Vec<(String, Option<String>)> = {
        let mut st = conn.prepare(t("devswarm_cli.sp_appdb_repos")).ok()?;
        let rows = st.query_map([], |r| Ok((r.get::<_, rusqlite::types::Value>(0)?, r.get::<_, rusqlite::types::Value>(1)?))).ok()?;
        rows.flatten().filter_map(|(id, p)| Some((text_of(id)?, text_of(p).filter(|x| !x.is_empty()).map(|x| norm(&x))))).collect()
    };
    let builders: Vec<(Option<String>, Option<String>, Option<String>)> = {
        let mut st = conn.prepare(t("devswarm_cli.sp_appdb_builders")).ok()?;
        let rows = st
            .query_map([], |r| Ok((r.get::<_, rusqlite::types::Value>(0)?, r.get::<_, rusqlite::types::Value>(1)?, r.get::<_, rusqlite::types::Value>(2)?)))
            .ok()?;
        rows.flatten().map(|(b, rid, w)| (text_of(b), text_of(rid), text_of(w).filter(|x| !x.is_empty()).map(|x| norm(&x)))).collect()
    };
    let cwd = norm(&inv.cwd);
    let repo_id = match repos.iter().find(|(_, p)| p.as_deref() == Some(cwd.as_str())) {
        Some((id, _)) => id.clone(),
        None => builders.iter().find(|(_, rid, w)| w.as_deref() == Some(cwd.as_str()) && rid.is_some()).and_then(|(_, rid, _)| rid.clone())?,
    };
    let held = builders.iter().any(|(b, rid, _)| b.as_deref() == Some(source.as_str()) && rid.as_deref() == Some(repo_id.as_str()));
    held.then(|| tpl("devswarm_cli.sp_source_note", &[("source", &source)]))
}

/// The wake-path warning after a spawn (`noWakePathLine(wakeCoverage(...))`): only a Claude Primary with no recent mailbox tick.
fn wake_warning(inv: &Inv, now: i64) -> Option<String> {
    if inv.env.get(defaults::text("mesh_write.env_source_branch")).is_some_and(|v| !js_trim(v).is_empty()) {
        return None;
    }
    let agent = inv.env.get(defaults::text("devswarm_role.agent_env")).map(|v| js_trim(v).to_lowercase()).unwrap_or_default();
    if agent != defaults::text("devswarm_role.claude_agent") {
        return None;
    }
    let root = ident::resolve_context(&inv.cwd, true).ok()?.worktree_root?;
    let id = ident::mesh_id_for_real_path(&root);
    let charset = t("devswarm_cli.sp_id_charset");
    if id.is_empty() || !id.chars().all(|c| charset.contains(c)) {
        return None;
    }
    let home = &inv.home;
    let dir = devswarm_root(home);
    let suffix = defaults::text("mesh_write.json_suffix");
    // the live-children read is unknown when a descriptor exists but this checkout belongs to no project
    let descriptors: Vec<(String, String)> = std::fs::read_dir(dir.join(defaults::text("mesh_write.dir_workspaces")))
        .map(|rd| {
            rd.flatten()
                .filter_map(|e| {
                    let d = OVal::parse(&std::fs::read_to_string(e.path()).ok()?)?;
                    match (d.get("id"), d.get("worktreePath"), d.get("sessionId")) {
                        (Some(OVal::Str(i)), Some(OVal::Str(w)), Some(OVal::Str(sid)))
                            if !w.is_empty() && !sid.is_empty() && crate::meshw::idlock::is_safe_id(i) =>
                        {
                            Some((i.clone(), w.clone()))
                        }
                        _ => None,
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    if !descriptors.is_empty() && ident::repo_key_for_worktree(&inv.cwd).ok().flatten().is_none() {
        return None;
    }
    let tick =
        OVal::parse(&std::fs::read_to_string(dir.join(defaults::text("devswarm_parent.dir_wake_tick")).join(format!("{id}{suffix}"))).unwrap_or_default());
    let age = match tick.as_ref().and_then(|v| v.get("ts")) {
        Some(OVal::Num(ts)) if ts.is_finite() => Some(((now as f64 - ts) / defaults::num("devswarm_prompt.ms_per_minute") as f64).floor().max(0.0) as i64),
        _ => None,
    };
    let warn = crate::dsact::settings::resolve(&inv.settings(), defaults::raw("devswarm_parent.set_cron_warn")).as_i64().unwrap_or_default();
    if age.is_some_and(|a| a <= warn) {
        return None;
    }
    let wanted = crate::dsact::settings::resolve(&inv.settings(), defaults::raw("wake_watch.set_enabled")).as_bool() != Some(false);
    let lock_live = |wid: &str| -> bool {
        let p = dir.join(defaults::text("devswarm_parent.dir_locks")).join(format!(
            "{}{wid}{}",
            defaults::text("devswarm_parent.watch_lock_prefix"),
            defaults::text("devswarm_parent.watch_lock_suffix")
        ));
        let Some(lock) = std::fs::read_to_string(p).ok().and_then(|x| OVal::parse(&x)) else { return false };
        let fresh = matches!(lock.get("ts"), Some(OVal::Num(ts)) if ts.is_finite() && (now as f64 - ts) <= defaults::num("wake_watch.lock_stale_ms") as f64);
        let alive = match lock.get("pid") {
            Some(OVal::Num(pid)) if pid.is_finite() && pid.fract() == 0.0 => crate::dssup::liveness::pid_is_alive(*pid, None) != Some(false),
            _ => true,
        };
        fresh && alive
    };
    let watcher_live = lock_live(&id) || {
        let forms = |p: &str| -> Vec<String> {
            let r = ident::resolve_abs(p);
            let mut v = vec![r.clone()];
            v.extend(ident::realpath(&r));
            v
        };
        match descriptors.iter().find(|(i, _)| *i == id) {
            None => false,
            Some((_, own_wt)) => {
                let own = forms(own_wt);
                descriptors.iter().any(|(i, w)| *i != id && forms(w).iter().any(|f| own.contains(f)) && lock_live(i))
            }
        }
    };
    let cron = crate::checks::devswarm_role::settings::wake_cron(&inv.settings());
    let cron_part = defaults::render("devswarm_parent.wake_cron_part", &[("cron", &cron), ("cli", &t("devswarm_cli.sp_wake_cli")), ("id", &id)]);
    if wanted && !watcher_live {
        let mon = defaults::render("devswarm_parent.wake_monitor", &[("watcher", &t("devswarm_cli.sp_wake_watcher"))]);
        return Some(defaults::render("devswarm_parent.wake_both", &[("mon", &mon), ("cron", &cron_part)]));
    }
    Some(defaults::render("devswarm_parent.wake_tick", &[("cron", &cron_part)]))
}

// ---- the verb ------------------------------------------------------------------------------------------------------------

fn timings_obj(fields: &[(&str, i64)]) -> OVal {
    let mut o = Obj::default();
    for (k, v) in fields {
        o.put(k, n(*v as f64));
    }
    o.done()
}

/// `spawn <branch> [create options]` past the option checks: the create path (see the module header).
pub fn create(inv: &Inv, rest: &[&str], branch: &str) -> R<Answer> {
    create_with(inv, rest, branch, &System::configured())
}

/// [`create`] with the runner of the git and probe commands given.
pub fn create_with(inv: &Inv, rest: &[&str], branch: &str, runner: &dyn Runner) -> R<Answer> {
    // from here the verb may fetch and fast-forward: nothing defers any more
    crate::meshw::mark_committed();
    let wall_start = clock(inv);
    let fetch_start = clock(inv);
    let sc = source_freshness(inv, runner, rest);
    let source_ms = clock(inv) - fetch_start;
    let action = s(defaults::text("devswarm_cli.action_spawn"));
    if let Some(error) = sc.refused {
        let timings = timings_obj(&[("sourceCheckMs", source_ms), ("totalMs", clock(inv) - wall_start)]);
        let mut o = Obj::default();
        o.put("ok", OVal::Bool(false))
            .put("action", action)
            .put("branch", s(branch))
            .put("created", OVal::Bool(false))
            .put("error", s(&error))
            .put("sourceCheck", sc.obj)
            .put("timings", timings);
        return Ok(answer(2, o.done()));
    }
    let strip = t("devswarm_cli.sp_from_local_flag");
    let mut args: Vec<&str> = defaults::list("devswarm_act.argv_create");
    args.extend(rest.iter().copied().filter(|a| *a != strip));
    let started_at = clock(inv);
    let timeout_ms =
        crate::dsact::settings::resolve(&inv.settings(), defaults::raw("devswarm_act.set_create_timeout_ms")).as_i64().filter(|v| *v > 0).unwrap_or(0) as u64;
    let pre_start = clock(inv);
    let preflight = preflight_submodules(runner, &inv.cwd, rest);
    let preflight_ms = clock(inv) - pre_start;
    let create_start = clock(inv);
    let res = gated_call(inv, runner, nth(&defaults::list("devswarm_act.argv_create"), 1), &args, std::time::Duration::from_millis(timeout_ms));
    let create_ms = clock(inv) - create_start;
    if !res.call.ok {
        let error = if res.call.timed_out {
            tpl("devswarm_cli.sp_timeout_error", &[("ms", &timeout_ms.to_string()), ("branch", branch)])
        } else if res.call.error.is_empty() {
            t("devswarm_cli.sp_create_failed").to_string()
        } else {
            res.call.error.clone()
        };
        let timings =
            timings_obj(&[("sourceCheckMs", source_ms), ("submodulePreflightMs", preflight_ms), ("createMs", create_ms), ("totalMs", clock(inv) - wall_start)]);
        let mut o = Obj::default();
        o.put("ok", OVal::Bool(false)).put("error", s(&error)).put("branch", s(branch)).put("sourceCheck", sc.obj).put("timings", timings);
        return Ok(answer(2, o.done()));
    }
    let raw = res.call.raw.clone();
    let parsed = parse_failures(&raw, &res.stderr, &inv.cwd);
    let text = [raw.as_str(), res.stderr.as_str()].iter().filter(|x| !x.is_empty()).copied().collect::<Vec<_>>().join("\n");
    let (repaired, failures) = repair(runner, parsed, &text, branch, &inv.cwd, clock(inv));
    let title = if has_flag(rest, &tl("devswarm_cli.sp_flag_title")) {
        flag_value(rest, &tl("devswarm_cli.sp_flag_title"))
    } else {
        derive_title(flag_value(rest, &tl("devswarm_cli.sp_flag_prompt")).as_deref())
    };
    let mut registered = false;
    let mut titled = false;
    let worktree = created_path(&raw);
    let mut mesh_id: Option<String> = None;
    let mut registry_id: Option<String> = None;
    let mut registry_pending: Option<String> = None;
    if let Some(wt) = &worktree
        && let Ok(id) = ident::primary_workspace_id(wt)
    {
        mesh_id = Some(id.clone());
        // never register under the label alone: the row is keyed by the app's own id for the worktree; when the app has not named
        // it yet, the label row stands in as PENDING and the reconcile sweep fills the id in later (`recon::labelfill`)
        let lookup = crate::meshw::appid::lookup_with_retry(&inv.home, &inv.env, wt);
        let seed_id = match &lookup {
            crate::meshw::appid::Lookup::Found(uuid) => uuid.clone(),
            _ => id.clone(),
        };
        registered = seed_registry(inv, &seed_id, wt, clock(inv));
        match lookup {
            crate::meshw::appid::Lookup::Found(uuid) => registry_id = Some(uuid),
            crate::meshw::appid::Lookup::Missing => {
                let note = tpl("devswarm_cli.sp_uuid_pending_note", &[("label", &id), ("worktree", wt)]);
                crate::discard::note("spawn_uuid_pending", &note);
                registry_pending = Some(note);
            }
            crate::meshw::appid::Lookup::NoApp => {}
        }
        if registered && let Some(title) = title.as_deref().filter(|x| !x.is_empty()) {
            let mut targs: Vec<&str> = tl("devswarm_cli.sp_hc_update_title");
            targs.extend([branch, title]);
            let verb = nth(&targs, 1);
            titled = gated_call(inv, runner, verb, &targs, defaults::millis("devswarm_cli.hc_unbounded_ms")).call.ok;
            if titled {
                crate::dssup::appsync::state::write_name(&inv.home, &id, title, clock(inv));
                if let Some(uuid) = &registry_id {
                    crate::dssup::appsync::state::write_name(&inv.home, uuid, title, clock(inv));
                }
            }
        }
    }
    let plan_info = write_plan(inv, runner, rest, worktree.as_deref(), mesh_id.as_deref(), clock(inv));
    let launch = match &mesh_id {
        Some(id) => check_launch(inv, id, started_at),
        None => {
            let (_, window) = launch_window(inv);
            Launch { launched: false, evidence: None, waited: 0, window, requested: None }
        }
    };
    let note = source_note(inv, runner, rest);
    let total_ms = clock(inv) - wall_start;
    let timings = timings_obj(&[("sourceCheckMs", source_ms), ("submodulePreflightMs", preflight_ms), ("createMs", create_ms), ("totalMs", total_ms)]);
    let mut ctx: Vec<(&str, OVal)> = vec![("branch", s(branch)), ("sourceCheckStatus", sc.obj.get("status").cloned().unwrap_or(OVal::Null))];
    if let Some(f) = sc.obj.get("fetch") {
        ctx.push(("fetch", f.clone()));
    }
    ctx.push(("timings", timings.clone()));
    ctx.push(("submoduleFailureCount", n(failures.len() as f64)));
    crate::meshw::clog::event(inv, t("devswarm_cli.sp_log_op"), t("devswarm_cli.sp_log_msg"), ctx);
    let wake = wake_warning(inv, clock(inv));

    let mut warnings: Vec<String> = Vec::new();
    if let Some(x) = &note {
        warnings.push(x.clone());
    }
    if !preflight.1.is_empty() {
        let list = preflight
            .1
            .iter()
            .map(|(p, sha, e)| format!("{p}@{}: {e}", sha.chars().take(tnum("devswarm_cli.sp_short_sha") as usize).collect::<String>()))
            .collect::<Vec<_>>()
            .join("; ");
        warnings.push(tpl("devswarm_cli.sp_warn_preflight", &[("count", &preflight.1.len().to_string()), ("list", &list)]));
    }
    if !repaired.is_empty() {
        warnings.push(tpl("devswarm_cli.sp_warn_repaired", &[("count", &repaired.len().to_string())]));
    }
    for r in &repaired {
        if let Some(OVal::Arr(ws)) = r.get("warnings") {
            warnings.extend(ws.iter().filter_map(|w| if let OVal::Str(x) = w { Some(x.clone()) } else { None }));
        }
    }
    if !failures.is_empty() {
        let list = failures
            .iter()
            .map(|f| format!("{}: {}", f.path.as_deref().unwrap_or("?"), f.repair_error.as_deref().unwrap_or(&f.error)))
            .collect::<Vec<_>>()
            .join("; ");
        warnings.push(tpl("devswarm_cli.sp_warn_failures", &[("count", &failures.len().to_string()), ("list", &list)]));
    }
    let any_warning = !failures.is_empty() || !repaired.is_empty() || !preflight.1.is_empty() || note.is_some();
    let mut warnings_out = any_warning.then_some(warnings);
    if let Some(w) = wake {
        warnings_out.get_or_insert_with(Vec::new).push(w);
    }

    let mut o = Obj::default();
    o.put("ok", OVal::Bool(true))
        .put("action", action)
        .put("branch", s(branch))
        .put("created", OVal::Bool(true))
        .put("worktreePath", s_or_null(worktree.as_deref()))
        .put("meshId", s_or_null(mesh_id.as_deref()))
        .put("registered", OVal::Bool(registered))
        .put("titled", OVal::Bool(titled))
        .put("sourceCheck", sc.obj);
    if let Some(uuid) = &registry_id {
        o.put(t("devswarm_cli.sp_field_registry_id"), s(uuid));
    }
    if let Some(note) = &registry_pending {
        o.put(t("devswarm_cli.sp_field_registry_pending"), OVal::Bool(true)).put(t("devswarm_cli.sp_field_registry_note"), s(note));
    }
    if !failures.is_empty() {
        o.put("submoduleFailures", OVal::Arr(failures.iter().map(Failure::json).collect()));
    }
    if !repaired.is_empty() {
        o.put("submoduleRepaired", OVal::Arr(repaired.clone()));
    }
    if !failures.is_empty() || !repaired.is_empty() {
        let sha = match repaired.first().and_then(|r| r.get("sha")) {
            Some(OVal::Str(x)) if !x.is_empty() => format!(" ({x})"),
            _ => String::new(),
        };
        o.put("submoduleHint", s(&tpl("devswarm_cli.sp_submodule_hint", &[("sha", &sha)])));
    }
    if !preflight.0.is_empty() || !preflight.1.is_empty() {
        let mut p = Obj::default();
        let fetched = preflight.0.iter().map(|(path, sha)| {
            let mut x = Obj::default();
            x.put("path", s(path)).put("sha", s(sha));
            x.done()
        });
        let failed = preflight.1.iter().map(|(path, sha, e)| {
            let mut x = Obj::default();
            x.put("path", s(path)).put("sha", s(sha)).put("error", s(e));
            x.done()
        });
        p.put("fetched", OVal::Arr(fetched.collect())).put("failed", OVal::Arr(failed.collect()));
        o.put("submodulePreflight", p.done());
    }
    if let Some(w) = &warnings_out {
        o.put("warnings", strs(w));
    }
    let unknown = s(t("devswarm_cli.sp_launch_unknown"));
    o.put("launched", if launch.launched { OVal::Bool(true) } else { unknown })
        .put("launchEvidence", s_or_null(launch.evidence))
        .put("launchCheckedMs", n(launch.waited as f64))
        .put("launchWindowMs", n(launch.window as f64));
    if let Some(req) = launch.requested {
        o.put("launchWindowClamped", OVal::Bool(true)).put("launchWindowRequestedMs", n(req as f64));
    }
    if !launch.launched {
        let note = if failures.is_empty() {
            String::new()
        } else {
            let what = failures.first().map(|f| f.path.clone().unwrap_or_else(|| f.error.clone())).unwrap_or_default();
            tpl("devswarm_cli.sp_launch_submodule_note", &[("what", &what)])
        };
        let target = mesh_id.clone().unwrap_or_else(|| branch.to_string());
        let mesh = mesh_id.clone().unwrap_or_else(|| t("devswarm_cli.sp_launch_mesh_placeholder").to_string());
        o.put(
            "launchHint",
            s(&tpl("devswarm_cli.sp_launch_hint", &[("target", &target), ("waited", &launch.waited.to_string()), ("mesh", &mesh), ("note", &note)])),
        );
    }
    o.put("timings", timings);
    if let Some(p) = plan_info {
        o.put("plan", p);
    }
    o.put("raw", s(&raw));
    Ok(answer(0, o.done()))
}
