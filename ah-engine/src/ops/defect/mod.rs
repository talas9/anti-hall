//! `ah-engine defect`: file, list, show and rule defect reports and query the bug history. Port of `scripts/defect.js`.
//!
//! The command-line grammar is the Node tool's (`--flag value` or a bare `--flag`, anything else positional) and unknown flags
//! are refused before anything is written. The store and the history are in [`store`] and [`history`].
pub(crate) mod history;
pub(crate) mod store;

use super::js::{Defer, len16};
use super::{env_snapshot, err, home, out, plugin_root};
use crate::checks::git::util::posix_basename;
use crate::checks::jsport::ident;
use crate::checks::jsport::json::{self, J};
use crate::cli::Parsed;
use crate::defaults;
use crate::reqenv::RequestEnv;
use crate::setup::jsfmt::{parse_int, pretty};
use std::collections::BTreeMap;
use store::head16;

/// A flag's value: a word, or the bare flag.
#[derive(Clone, PartialEq, Eq)]
enum Flag {
    Bare,
    Word(String),
}

#[derive(Default)]
struct Args {
    positional: Vec<String>,
    flags: Vec<(String, Flag)>,
}

impl Args {
    fn get(&self, k: &str) -> Option<&Flag> {
        self.flags.iter().find(|(n, _)| n == k).map(|(_, v)| v)
    }

    /// `typeof f[k] === 'string'`
    fn string(&self, k: &str) -> Option<&str> {
        match self.get(k) {
            Some(Flag::Word(s)) => Some(s),
            _ => None,
        }
    }

    /// `String(f[k])` for a flag that is set: the bare flag reads as `true`.
    fn text(&self, k: &str) -> Option<String> {
        match self.get(k) {
            Some(Flag::Bare) => Some(defaults::text("defect.true_word").to_string()),
            Some(Flag::Word(s)) => Some(s.clone()),
            None => None,
        }
    }

    /// `!!f[k]`
    fn truthy(&self, k: &str) -> bool {
        match self.get(k) {
            Some(Flag::Bare) => true,
            Some(Flag::Word(s)) => !s.is_empty(),
            None => false,
        }
    }
}

fn parse_args(argv: &[String]) -> Args {
    let mut a = Args::default();
    let mut i = 0;
    while i < argv.len() {
        if let Some(key) = argv[i].strip_prefix("--") {
            let value = match argv.get(i + 1) {
                Some(next) if !next.starts_with("--") => {
                    i += 1;
                    Flag::Word(next.clone())
                }
                _ => Flag::Bare,
            };
            match a.flags.iter_mut().find(|(n, _)| n == key) {
                Some(slot) => slot.1 = value,
                None => a.flags.push((key.to_string(), value)),
            }
        } else {
            a.positional.push(argv[i].clone());
        }
        i += 1;
    }
    a
}

// ---- flag validation --------------------------------------------------------------------------------------------------

/// The closed set of flags each subcommand accepts: `(command, flags)` in the shipped order.
fn valid_flags() -> Vec<(&'static str, Vec<&'static str>)> {
    defaults::list("defect.valid_flags")
        .into_iter()
        .map(|l| {
            let mut w = l.split_whitespace();
            (w.next().unwrap_or(""), w.collect())
        })
        .collect()
}

/// `checkFlags(cmd, flags)`: one message per flag the command does not accept, `None` when all are valid.
fn check_flags(cmd: &str, a: &Args) -> Option<Vec<String>> {
    let table = valid_flags();
    let valid = table.iter().find(|(c, _)| *c == cmd).map(|(_, f)| f.clone()).unwrap_or_default();
    let unknown: Vec<&str> = a.flags.iter().map(|(k, _)| k.as_str()).filter(|k| !valid.contains(k)).collect();
    if unknown.is_empty() {
        return None;
    }
    Some(
        unknown
            .iter()
            .map(|k| {
                let others: Vec<&str> = table.iter().filter(|(c, f)| *c != cmd && f.contains(k)).map(|(c, _)| *c).collect();
                if others.is_empty() {
                    defaults::render("defect.flag_not_valid", &[("k", k), ("cmd", &cmd)])
                } else {
                    defaults::render("defect.flag_valid_for", &[("k", k), ("others", &others.join(defaults::text("defect.others_sep"))), ("cmd", &cmd)])
                }
            })
            .collect(),
    )
}

// ---- helpers ----------------------------------------------------------------------------------------------------------

struct Run {
    env: BTreeMap<String, String>,
    home: String,
    cwd: String,
}

impl Run {
    fn new() -> Run {
        let env = env_snapshot();
        let home = home(&env);
        let cwd = std::env::current_dir().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default();
        Run { env, home, cwd }
    }
}

fn print_result(v: &J, as_json: bool) {
    out(&((if as_json { json::stringify(v) } else { pretty(v) }) + "\n"));
}

fn read_file_field(path: Option<&str>) -> Option<String> {
    let p = path.filter(|p| !p.is_empty())?;
    std::fs::read(p).ok().map(|b| String::from_utf8_lossy(&b).into_owned())
}

/// `readVersion()`
fn read_version(run: &Run) -> String {
    let unknown = defaults::text("defect.unknown_word").to_string();
    let Some(root) = plugin_root(&run.env) else { return unknown };
    let path = std::path::Path::new(&root).join(defaults::text("migrate.plugin_manifest"));
    let Some(pkg) = std::fs::read_to_string(path).ok().and_then(|t| json::parse(&t, defaults::num("setup.json_max_depth") as usize).ok()) else {
        return unknown;
    };
    match pkg.get("version") {
        Some(J::Str(s)) if !s.is_empty() => s.clone(),
        Some(J::Num(n)) if *n != 0.0 && !n.is_nan() => crate::checks::jsport::num::to_js_string(*n),
        Some(J::Bool(true)) => defaults::text("defect.true_word").to_string(),
        _ => unknown,
    }
}

/// `clampIdentity(s)`
fn clamp_identity(s: &str) -> Result<String, Defer> {
    head16(s, defaults::num("defect.identity_cap") as usize)
}

/// `warnIdentityTruncated(raw, label)`
fn warn_identity_truncated(raw: &str, label: &str) {
    let cap = defaults::num("defect.identity_cap") as usize;
    let n = len16(raw);
    if n > cap {
        err(&(defaults::render("defect.warn_identity", &[("label", &label), ("n", &n), ("cap", &cap)]) + "\n"));
    }
}

/// `defaultProj(env)`: `defects.defaultProj` through the settings chain.
fn default_proj() -> String {
    super::settings::effective_text(defaults::text("defect.proj_section"), defaults::text("defect.proj_key"), "").unwrap_or_default()
}

/// The common git directory of the outermost superproject of `cwd`, asked of git itself (bounded calls): the answer for a
/// layout the file resolver is unsure of (a `.git` file with unusual line ends, a linked worktree of a submodule).
fn git_common_dir(run: &Run, cwd: &str) -> Option<String> {
    let env = RequestEnv::from_pairs(run.env.clone());
    let scrub = defaults::list("codex_handover.git_scrub_env");
    let timeout = defaults::millis("codex_handover.identity_git_timeout_ms");
    let git = |root: &str, key: &str| -> Option<String> {
        let argv: Vec<String> = defaults::list(key).iter().map(|a| a.replace("{root}", root)).collect();
        let out = crate::checks::jsport::gitrun::git_scrubbed(root, &argv.iter().map(String::as_str).collect::<Vec<_>>(), timeout, &env, &scrub)?;
        let t = crate::checks::guardkit::text::js_trim(&out).to_string();
        (!t.is_empty()).then_some(t)
    };
    let mut root = cwd.to_string();
    for _ in 0..defaults::num("codex_handover.max_submodule_hops") {
        match git(&root, "codex_handover.argv_super") {
            Some(up) if up != root => root = up,
            _ => break,
        }
    }
    let common = git(&root, "opcli.defect_argv_common")?;
    let abs = crate::checks::git::util::resolve(&root, &common, "/");
    std::fs::canonicalize(&abs).ok().map(|p| p.to_string_lossy().into_owned())
}

/// `repoKeyForWorktree(cwd)`: `<sanitized repo name>-<6 hex of the common dir>`, `None` outside a repository.
fn repo_key(run: &Run, cwd: &str) -> Result<Option<String>, Defer> {
    let ctx = ident::resolve_context(cwd, false, &RequestEnv::from_pairs(run.env.clone()));
    let common = if ctx.unsure { git_common_dir(run, cwd) } else { ctx.worktree_root.as_deref().and_then(ident::common_dir) };
    let Some(common) = common else { return Ok(None) };
    let parent = crate::checks::git::util::posix_dirname(&common);
    let base = sanitize_repo_name(&posix_basename(&parent));
    let d = ring::digest::digest(&ring::digest::SHA256, common.as_bytes());
    let suffix: String = d.as_ref().iter().take(defaults::num("defect.repo_hash_hex") as usize / 2).map(|b| format!("{b:02x}")).collect();
    Ok(Some(format!("{base}-{suffix}")))
}

/// `sanitizeRepoName(name)`
fn sanitize_repo_name(name: &str) -> String {
    let lower = name.to_lowercase();
    let mut slug = String::new();
    let mut in_run = false;
    for c in lower.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' {
            slug.push(c);
            in_run = false;
        } else if !in_run {
            slug.push('-');
            in_run = true;
        }
    }
    let mut collapsed = String::new();
    for c in slug.chars() {
        if !(c == '-' && collapsed.ends_with('-')) {
            collapsed.push(c);
        }
    }
    let cut: String = collapsed.chars().take(defaults::num("defect.repo_name_cap") as usize).collect();
    let trimmed = cut.trim_matches('-');
    if trimmed.is_empty() { defaults::text("defect.repo_word").to_string() } else { trimmed.to_string() }
}

/// `reporterIdentity(flags, env, cwd)`
fn reporter_identity(run: &Run, a: &Args) -> Result<String, Defer> {
    if let Some(p) = a.string("proj").filter(|p| !p.is_empty()) {
        warn_identity_truncated(p, defaults::text("defect.label_proj_flag"));
        return clamp_identity(p);
    }
    let proj = default_proj();
    if !proj.is_empty() {
        warn_identity_truncated(&proj, defaults::text("defect.label_proj_setting"));
        return clamp_identity(&proj);
    }
    if let Some(k) = repo_key(run, &run.cwd)? {
        return Ok(k);
    }
    Ok(defaults::text("defect.no_repo").to_string())
}

/// `mineIdentities(flags, env, cwd)`
fn mine_identities(run: &Run, a: &Args) -> Result<Vec<String>, Defer> {
    let mut ids = vec![posix_basename(&run.cwd)];
    if let Some(k) = repo_key(run, &run.cwd)? {
        ids.push(k);
    }
    if let Some(p) = a.string("proj").filter(|p| !p.is_empty()) {
        ids.push(clamp_identity(p)?);
    }
    let proj = default_proj();
    if !proj.is_empty() {
        ids.push(clamp_identity(&proj)?);
    }
    Ok(ids)
}

/// `warnTruncated(result)`
fn warn_truncated(result: &J) {
    let Some(J::Obj(t)) = result.get(defaults::text("defect.key_truncated")) else { return };
    let parts: Vec<String> = t
        .iter()
        .map(|(k, info)| {
            let n = |f: &str| match info.get(f) {
                Some(J::Num(x)) => crate::checks::jsport::num::to_js_string(*x),
                _ => String::new(),
            };
            let marked = if matches!(info.get("marked"), Some(J::Bool(true))) { defaults::text("defect.marker_written") } else { "" };
            defaults::render("defect.trunc_part", &[("k", k), ("len", &n("originalLength")), ("cap", &n("cap")), ("marked", &marked)])
        })
        .collect();
    err(&(defaults::render("defect.warn_truncated", &[("parts", &parts.join(defaults::text("defect.list_sep")))]) + "\n"));
}

fn outcome_of(result: &J) -> &str {
    match result.get("outcome") {
        Some(J::Str(s)) => s,
        _ => "",
    }
}

fn top_flag(a: &Args) -> usize {
    let n = a.string("top").and_then(parse_int).unwrap_or(f64::NAN);
    if n > 0.0 { n as usize } else { defaults::num("defect.default_top") as usize }
}

// ---- subcommands ------------------------------------------------------------------------------------------------------

fn cmd_report(run: &Run, a: &Args) -> Result<i32, Defer> {
    let pick = |k: &str, file_k: &str| -> String {
        if a.truthy(k) {
            return a.text(k).unwrap_or_default();
        }
        read_file_field(a.string(file_k)).filter(|s| !s.is_empty()).unwrap_or_default()
    };
    let sym = pick("sym", "sym-file");
    let repro = pick("repro", "repro-file");
    let claimed = if a.truthy("claimed") { a.text("claimed").unwrap_or_default() } else { String::new() };
    let observed = if a.truthy("observed") { a.text("observed").unwrap_or_default() } else { String::new() };
    let proj = reporter_identity(run, a)?;
    let env_id = |k: &str| run.env.get(defaults::env_name(k)).filter(|v| !v.is_empty()).cloned();
    let sid = if a.truthy("sid") {
        a.text("sid").unwrap_or_default()
    } else {
        env_id("claude_session_id").or_else(|| env_id("antihall_session_id")).unwrap_or_else(|| defaults::text("defect.unknown_word").to_string())
    };
    let v = if a.truthy("v") { a.text("v").unwrap_or_default() } else { read_version(run) };
    let input = store::ReportInput {
        class: a.text("class"),
        sev: a.text("sev"),
        sym,
        repro,
        claimed,
        observed,
        proj,
        sid,
        v,
        component: a.string("component").map(str::to_string),
        cause: a.string("cause").map(str::to_string),
        regression_of: a.string("regression-of").map(str::to_string),
    };
    let mut result = store::report(&input, &run.home)?;
    let outcome = outcome_of(&result).to_string();
    let ok = outcome == defaults::text("defect.out_recorded") || outcome == defaults::text("defect.out_occurrence_appended");
    if ok
        && let Some(J::Str(fp)) = result.get("fp").cloned()
        && let Some(shown) = store::show_defect(&fp, &run.home)
    {
        if let Some(s) = shown.get("status") {
            result.set("status", s.clone());
        }
        result.set("staleBuild", J::Bool(matches!(shown.get("staleBuild"), Some(J::Bool(true)))));
    }
    print_result(&result, a.get("json").is_some());
    warn_truncated(&result);
    Ok(i32::from(!ok))
}

fn cmd_list(run: &Run, a: &Args) -> Result<i32, Defer> {
    let mut defects = match store::list_defects(&run.home) {
        J::Arr(v) => v,
        _ => Vec::new(),
    };
    let status_of = |d: &J| match d.get("status") {
        Some(J::Str(s)) => s.clone(),
        _ => String::new(),
    };
    if a.truthy("mine") {
        let ids = mine_identities(run, a)?;
        defects.retain(|d| matches!(d.get("proj"), Some(J::Str(p)) if ids.contains(p)));
    }
    if a.truthy("open") {
        defects.retain(|d| status_of(d) == defaults::text("defect.status_open"));
    }
    if a.truthy("unfinished") {
        defects.retain(|d| store::is_unfinished(&status_of(d)));
    }
    print_result(&J::Arr(defects), a.get("json").is_some());
    Ok(0)
}

fn cmd_show(run: &Run, a: &Args) -> Result<i32, Defer> {
    let Some(fp) = a.positional.first() else {
        err(&(defaults::text("defect.usage_show").to_string() + "\n"));
        return Ok(1);
    };
    let as_json = a.get("json").is_some();
    match store::show_defect(fp, &run.home) {
        None => {
            print_result(&J::Obj(vec![("outcome".into(), J::Str(defaults::text("defect.out_not_found").into())), ("fp".into(), J::Str(fp.clone()))]), as_json);
            Ok(1)
        }
        Some(J::Obj(members)) => {
            let mut o = vec![("outcome".to_string(), J::Str(defaults::text("defect.out_found").into()))];
            for (k, v) in members {
                match o.iter_mut().find(|(n, _)| *n == k) {
                    Some(slot) => slot.1 = v,
                    None => o.push((k, v)),
                }
            }
            print_result(&J::Obj(o), as_json);
            Ok(0)
        }
        Some(_) => Ok(1),
    }
}

fn cmd_rule(run: &Run, a: &Args) -> Result<i32, Defer> {
    let Some(fp) = a.positional.first() else {
        err(&(defaults::text("defect.usage_rule").to_string() + "\n"));
        return Ok(1);
    };
    let input = store::RuleInput {
        status: a.text("status"),
        note: if a.truthy("note") { a.text("note").unwrap_or_default() } else { String::new() },
        fixed_in: a.text("fixed-in"),
        commit: a.text("commit"),
        superseded_by: a.text("superseded-by"),
        component: a.string("component").map(str::to_string),
        cause: a.string("cause").map(str::to_string),
        regression_of: a.string("regression-of").map(str::to_string),
    };
    let result = store::rule(fp, &input, &run.home)?;
    print_result(&result, a.get("json").is_some());
    warn_truncated(&result);
    Ok(i32::from(outcome_of(&result) != defaults::text("defect.out_ruled")))
}

fn cmd_archive(run: &Run, a: &Args) -> Result<i32, Defer> {
    let r = store::archive_sweep(crate::checks::jsport::date::now_ms(), &run.home)?;
    print_result(&r, a.get("json").is_some());
    Ok(0)
}

fn cmd_backfill(run: &Run, a: &Args) -> Result<i32, Defer> {
    let repo = a.string("repo").map_or_else(|| run.cwd.clone(), str::to_string);
    let res = match history::backfill(&repo, a.truthy("dry-run"), &run.home) {
        Ok(r) => r,
        Err(Err(defer)) => return Err(defer),
        Err(Ok(fail)) => {
            err(&(defaults::render("defect.backfill_failed", &[("repo", &repo), ("msg", &fail.0)]) + "\n"));
            return Ok(1);
        }
    };
    let n = |v: usize| J::Num(v as f64);
    let o = J::Obj(vec![
        ("repo".into(), J::Str(res.repo.clone())),
        ("dryRun".into(), J::Bool(res.dry_run)),
        ("scanned".into(), n(res.scanned)),
        ("imported".into(), n(res.imported)),
        ("existing".into(), n(res.existing)),
        ("failed".into(), n(res.failed)),
        ("dir".into(), J::Str(store::history_dir(&run.home).to_string_lossy().into_owned())),
    ]);
    print_result(&o, a.get("json").is_some());
    Ok(i32::from(res.failed > 0))
}

fn cmd_recurring(run: &Run, a: &Args) -> Result<i32, Defer> {
    if let Some(since) = a.string("since").filter(|s| !history::since_is_readable(s)) {
        err(&(defaults::render("opcli.defect_since_unread", &[("since", &since)]) + "\n"));
        return Ok(defaults::num("opcli.fail_exit") as i32);
    }
    let records = history::load_all_records(&run.home)?;
    let rep = history::recurring(&records, a.string("since"))?;
    if a.get("json").is_some() {
        out(&(json::stringify(&rep.json) + "\n"));
    } else {
        out(&history::format_recurring(&rep, top_flag(a))?);
    }
    Ok(0)
}

fn cmd_similar(run: &Run, a: &Args) -> Result<i32, Defer> {
    let text = a.positional.join(" ");
    if text.is_empty() && a.string("component").is_none() {
        err(&(defaults::text("defect.usage_similar").to_string() + "\n"));
        return Ok(1);
    }
    let records = history::load_all_records(&run.home)?;
    let list = history::similar(&records, &text, a.string("component"), top_flag(a))?;
    if a.get("json").is_some() {
        out(&(json::stringify(&history::similar_json(&list)) + "\n"));
    } else {
        out(&history::format_similar(&list)?);
    }
    Ok(0)
}

/// `defect <verb> [flags]`
pub fn run(p: &Parsed) -> i32 {
    let plan = crate::ops::shadow::begin(defaults::text("ops.verb_defect"), defaults::text("ops.script_defect"), &p.raw, None);
    let code = run_inner(p);
    crate::ops::shadow::end(plan, code);
    code
}

fn run_inner(p: &Parsed) -> i32 {
    let cmd = p.raw.first().map(String::as_str).unwrap_or("");
    let a = parse_args(p.raw.get(1..).unwrap_or(&[]));
    if valid_flags().iter().any(|(c, _)| *c == cmd)
        && let Some(errors) = check_flags(cmd, &a)
    {
        for e in &errors {
            err(&(defaults::render("defect.err_line", &[("e", e)]) + "\n"));
        }
        let list: Vec<String> = valid_flags().iter().find(|(c, _)| *c == cmd).map(|(_, f)| f.iter().map(|x| format!("--{x}")).collect()).unwrap_or_default();
        err(&(defaults::render("defect.valid_flags_line", &[("cmd", &cmd), ("list", &list.join(defaults::text("defect.list_sep")))]) + "\n"));
        return 1;
    }
    let run = Run::new();
    // the command's own process: its local time zone is the one the user's dates mean
    let _zone = crate::checks::jsport::date::ZoneGuard::new(&RequestEnv::from_pairs(run.env.clone()));
    let r = match cmd {
        "report" => cmd_report(&run, &a),
        "list" => cmd_list(&run, &a),
        "show" => cmd_show(&run, &a),
        "rule" => cmd_rule(&run, &a),
        "archive" => cmd_archive(&run, &a),
        "backfill" => cmd_backfill(&run, &a),
        "recurring" => cmd_recurring(&run, &a),
        "similar" => cmd_similar(&run, &a),
        _ => {
            err(&(defaults::text("defect.usage").to_string() + "\n"));
            Ok(1)
        }
    };
    match r {
        Ok(code) => code,
        // every input is answered natively; a helper's error shape that still surfaces is an internal fault, reported as one
        Err(Defer) => {
            err(&(defaults::text("opcli.defect_internal").to_string() + "\n"));
            defaults::num("opcli.fail_exit") as i32
        }
    }
}
