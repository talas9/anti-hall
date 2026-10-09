//! `devswarm.js ready-check <sha>` (lane l8b), ported from `scripts/devswarm-lib/roster-diag.js` (`cmdReadyCheck`,
//! `globToRegExp`): a READ-ONLY readiness verdict for a child's "READY <sha>" claim.
//!
//! It runs `git` against the process's working directory exactly as Node does (`git -C <cwd> merge-base --is-ancestor <base> <sha>`
//! and one `git diff --raw --no-renames <base>...<sha>`), with Node's bound (a 4 s timeout, a 1 MiB output limit; a probe that
//! fails is "unknown", never a fact). Nothing is written.
//!
//! Deferred (Node then runs the verb): `--fetch` (a network action, repeated by neither side), a path or glob outside the Basic
//! Multilingual Plane (JavaScript matches UTF-16 units, the engine scalar values, and the two disagree on `?`), a glob the
//! regular-expression engine rejects.
use crate::checks::guardkit::ojson::OVal;
use crate::checks::guardkit::text::{is_js_space, js_trim};
use crate::defaults;
use crate::dsact::runner::{RunSpec, Runner, System};
use crate::meshw::args::Args;
use crate::meshw::common::{Inv, Obj, n, s};
use crate::meshw::ident::{R, defer};
use crate::meshw::send::{Answer, Effect};

fn answer(code: i32, v: OVal) -> Answer {
    Answer { code, stdout: format!("{}\n", v.stringify()), effect: Effect::None }
}

/// `csvList(flags, name)`: every value split on commas, trimmed, without repeats.
pub fn csv_list(a: &Args, name: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for raw in a.many(name) {
        for part in raw.split(',') {
            let t = js_trim(part);
            if !t.is_empty() && !out.iter().any(|x| x == t) {
                out.push(t.to_string());
            }
        }
    }
    out
}

/// `globToRegExp(glob)`'s pattern as a Rust regular expression (`.` of JavaScript excludes the four line terminators).
fn glob_pattern(glob: &str) -> String {
    let dot = defaults::text("devswarm_cli.ready_any");
    let chars: Vec<char> = glob.chars().collect();
    let mut out = String::from("^");
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '*' {
            if chars.get(i + 1) == Some(&'*') {
                out.push_str(dot);
                out.push('*');
                i += 1;
                if chars.get(i + 1) == Some(&'/') {
                    i += 1;
                }
            } else {
                out.push_str("[^/]*");
            }
        } else if c == '?' {
            out.push_str("[^/]");
        } else {
            if defaults::text("devswarm_cli.ready_escape").contains(c) {
                out.push('\\');
            }
            out.push(c);
        }
        i += 1;
    }
    out.push('$');
    out
}

fn bmp_only(t: &str) -> bool {
    t.chars().all(|c| (c as u32) <= 0xFFFF)
}

/// The outcome of one `git` probe as Node's `spawnSync` result reads: `Some(status)` for a clean run, `None` for a spawn error,
/// a timeout, a signal or output past the buffer limit.
struct Probe {
    status: i32,
    stdout: String,
}

fn git(runner: &dyn Runner, cwd: &str, args: &[&str]) -> Option<Probe> {
    let mut a: Vec<String> = vec![defaults::text("devswarm_cli.ready_git_cwd_flag").to_string(), cwd.to_string()];
    a.extend(args.iter().map(|x| (*x).to_string()));
    let r = runner.run(&RunSpec {
        bin: Some(defaults::text("devswarm_cli.ready_git").to_string()),
        args: a,
        cwd: None,
        timeout_ms: defaults::num("devswarm_cli.ready_git_timeout_ms") as u64,
        cap_bytes: defaults::num("devswarm_cli.ready_git_max_bytes") as u64,
        scrub_env: vec![],
    });
    if r.missing || r.timed_out || r.truncated || r.error.is_some() {
        return None;
    }
    Some(Probe { status: r.status?, stdout: r.stdout })
}

/// `ready-check <sha> [--base REF] [--allow GLOBS] [--watch-deletions DIRS] [--fetch]`.
pub fn ready_check(inv: &Inv, a: &Args) -> R<Answer> {
    ready_check_with(inv, a, &System::configured())
}

/// [`ready_check`] with the runner given.
pub fn ready_check_with(inv: &Inv, a: &Args, runner: &dyn Runner) -> R<Answer> {
    let cwd = inv.cwd.as_str();
    let sha = a.positionals.get(1).map(String::as_str).unwrap_or("");
    if sha.is_empty() {
        let mut o = Obj::default();
        o.put("ok", OVal::Bool(false)).put("error", s(defaults::text("devswarm_cli.msg_ready_usage")));
        return Ok(answer(2, o.done()));
    }
    if a.has(defaults::text("devswarm_cli.flag_fetch")) {
        return defer("fetch");
    }
    let base = a.one(defaults::text("devswarm_cli.flag_base")).filter(|b| !b.is_empty()).unwrap_or(defaults::text("devswarm_cli.ready_default_base"));
    let allow_globs = csv_list(a, defaults::text("devswarm_cli.flag_allow"));
    let watch_dirs: Vec<String> =
        csv_list(a, defaults::text("devswarm_cli.flag_watch_deletions")).into_iter().map(|d| d.trim_end_matches('/').to_string()).collect();
    if !bmp_only(cwd) || !bmp_only(sha) || !bmp_only(base) || allow_globs.iter().any(|g| !bmp_only(g)) {
        return defer("astral");
    }
    let mut allow: Vec<regex::Regex> = Vec::new();
    for g in &allow_globs {
        match regex::Regex::new(&glob_pattern(g)) {
            Ok(r) => allow.push(r),
            Err(_) => return defer("glob"),
        }
    }
    let mut reasons: Vec<&str> = Vec::new();
    // ff: exit 0 = true, 1 = false, anything else (or no clean run) = unknown
    let ff = match git(runner, cwd, &["merge-base", "--is-ancestor", base, sha]) {
        Some(p) if p.status == 0 => Some(true),
        Some(p) if p.status == 1 => Some(false),
        _ => None,
    };
    match ff {
        Some(false) => reasons.push(defaults::text("devswarm_cli.ready_r_not_ff")),
        None => reasons.push(defaults::text("devswarm_cli.ready_r_ff_unknown")),
        Some(true) => {}
    }
    let range = format!("{base}...{sha}");
    let mut list: Vec<String> = Vec::new();
    let (mut gitlinks, mut diff_known) = (0u32, false);
    let mut deleted: Vec<String> = Vec::new();
    if let Some(p) = git(runner, cwd, &["diff", "--raw", "--no-renames", &range]).filter(|p| p.status == 0) {
        diff_known = true;
        for line in p.stdout.split('\n') {
            if line.is_empty() {
                continue;
            }
            let Some(tab) = line.find('\t') else { continue };
            let meta_text = js_trim(line.get(1..tab).unwrap_or(""));
            let meta = split_runs(meta_text);
            let path = js_trim(&line[tab + 1..]);
            if path.is_empty() {
                continue;
            }
            list.push(path.to_string());
            let (old_mode, new_mode) = (meta.first().copied().unwrap_or(""), meta.get(1).copied().unwrap_or(""));
            let status = meta.get(4).and_then(|x| x.chars().next());
            let gl = defaults::text("devswarm_cli.ready_gitlink_mode");
            if old_mode == gl || new_mode == gl {
                gitlinks += 1;
            }
            if status == Some('D') {
                deleted.push(path.to_string());
            }
        }
        if !list.iter().all(|p| bmp_only(p)) {
            return defer("astral");
        }
    } else {
        reasons.push(defaults::text("devswarm_cli.ready_r_diff_unknown"));
    }
    if gitlinks > 0 {
        reasons.push(defaults::text("devswarm_cli.ready_r_gitlinks"));
    }
    let mut deletions_under = 0u32;
    if diff_known && !watch_dirs.is_empty() {
        for p in &deleted {
            if watch_dirs.iter().any(|d| p == d || p.starts_with(&format!("{d}/"))) {
                deletions_under += 1;
            }
        }
        if deletions_under > 0 {
            reasons.push(defaults::text("devswarm_cli.ready_r_deletions"));
        }
    }
    let mut outside: Vec<String> = Vec::new();
    if diff_known && !allow.is_empty() {
        outside = list.iter().filter(|p| !allow.iter().any(|re| re.is_match(p))).cloned().collect();
        if !outside.is_empty() {
            reasons.push(defaults::text("devswarm_cli.ready_r_outside"));
        }
    }
    let blocks = defaults::list("devswarm_cli.ready_block_reasons");
    let verdict = if reasons.iter().any(|r| blocks.contains(r)) {
        defaults::text("devswarm_cli.ready_v_block")
    } else if !reasons.is_empty() {
        defaults::text("devswarm_cli.ready_v_review")
    } else {
        defaults::text("devswarm_cli.ready_v_ok")
    };
    let mut files = Obj::default();
    files.put("count", n(list.len() as f64)).put("list", OVal::Arr(list.iter().map(|x| s(x)).collect()));
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(true))
        .put("action", s(defaults::text("devswarm_cli.action_ready_check")))
        .put("sha", s(sha))
        .put("base", s(base))
        .put("cwd", s(cwd))
        .put("ff", ff.map_or(OVal::Null, OVal::Bool))
        .put("files", files.done())
        .put("gitlinks", n(f64::from(gitlinks)))
        .put("deletions_under", n(f64::from(deletions_under)))
        .put("outside_allowed", OVal::Arr(outside.iter().map(|x| s(x)).collect()))
        .put("verdict", s(verdict))
        .put("reasons", OVal::Arr(reasons.iter().map(|x| s(x)).collect()));
    Ok(answer(0, o.done()))
}

/// `text.split(/\s+/)` of a TRIMMED text: the words between runs of JavaScript whitespace (an empty text is one empty word).
fn split_runs(text: &str) -> Vec<&str> {
    if text.is_empty() {
        return vec![""];
    }
    text.split(is_js_space).filter(|w| !w.is_empty()).collect()
}
