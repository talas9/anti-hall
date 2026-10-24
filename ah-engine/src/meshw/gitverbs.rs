//! `devswarm.js ready-check <sha>` (lane l8b), ported from `scripts/devswarm-lib/roster-diag.js` (`cmdReadyCheck`,
//! `globToRegExp`): a READ-ONLY readiness verdict for a child's "READY <sha>" claim.
//!
//! It runs `git` against the process's working directory exactly as Node does (`git -C <cwd> merge-base --is-ancestor <base> <sha>`
//! and one `git diff --raw --no-renames <base>...<sha>`), with Node's bound (a 4 s timeout, a 1 MiB output limit; a probe that
//! fails is "unknown", never a fact). Nothing is written.
//!
//! `--fetch` runs `git fetch --quiet` first, as Node does (best effort: whatever refs exist are what the checks read). A glob
//! is matched the way JavaScript's regular expression matches it, over UTF-16 units (`?` is one unit, so a character outside
//! the Basic Multilingual Plane takes two); `globToRegExp` escapes every metacharacter, so `new RegExp` cannot reject a glob and
//! no glob is ever set aside.
use crate::checks::guardkit::ojson::OVal;
use crate::checks::guardkit::text::{is_js_space, js_trim};
use crate::defaults;
use crate::dsact::runner::{RunSpec, Runner, System};
use crate::meshw::args::Args;
use crate::meshw::common::{Inv, Obj, n, s};
use crate::meshw::ident::R;
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

/// One element of `globToRegExp(glob)`'s pattern.
enum Tok {
    /// `.*`: any run of units that are no line terminator (`**`, and the `/` right after it).
    Any,
    /// `[^/]*`: any run of units but `/`.
    Star,
    /// `[^/]`: one unit but `/`.
    One,
    /// A unit that stands for itself.
    Lit(u16),
}

/// `globToRegExp(glob)` as tokens over UTF-16 units.
fn glob_tokens(glob: &str) -> Vec<Tok> {
    let units: Vec<u16> = glob.encode_utf16().collect();
    let (star, one, sep) = (u16::from(b'*'), u16::from(b'?'), u16::from(b'/'));
    let mut out = Vec::new();
    let mut i = 0;
    while i < units.len() {
        let c = units[i];
        if c == star {
            if units.get(i + 1) == Some(&star) {
                out.push(Tok::Any);
                i += 1;
                if units.get(i + 1) == Some(&sep) {
                    i += 1;
                }
            } else {
                out.push(Tok::Star);
            }
        } else if c == one {
            out.push(Tok::One);
        } else {
            out.push(Tok::Lit(c));
        }
        i += 1;
    }
    out
}

/// `re.test(path)` of the anchored pattern `^...$` (no flags): every token consumes whole units, `.` skips four line terminators.
fn glob_matches(toks: &[Tok], path: &str) -> bool {
    let text: Vec<u16> = path.encode_utf16().collect();
    let sep = u16::from(b'/');
    let terminators: Vec<u16> = defaults::text("devswarm_cli.ready_line_terminators").encode_utf16().collect();
    let n = text.len();
    let mut cur = vec![false; n + 1];
    cur[0] = true;
    for tok in toks {
        let mut next = vec![false; n + 1];
        match tok {
            Tok::Lit(u) => (0..n).filter(|&j| cur[j] && text[j] == *u).for_each(|j| next[j + 1] = true),
            Tok::One => (0..n).filter(|&j| cur[j] && text[j] != sep).for_each(|j| next[j + 1] = true),
            Tok::Star | Tok::Any => {
                let allowed = |u: u16| if matches!(tok, Tok::Star) { u != sep } else { !terminators.contains(&u) };
                let mut alive = false;
                for j in 0..=n {
                    if j > 0 {
                        alive = alive && allowed(text[j - 1]);
                    }
                    alive = alive || cur[j];
                    next[j] = alive;
                }
            }
        }
        cur = next;
    }
    cur[n]
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
        timeout_ms: defaults::num("devswarm_cli.ready_git_timeout_ms"),
        cap_bytes: defaults::num("devswarm_cli.ready_git_max_bytes"),
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
    let base = a.one(defaults::text("devswarm_cli.flag_base")).filter(|b| !b.is_empty()).unwrap_or(defaults::text("devswarm_cli.ready_default_base"));
    let allow_globs = csv_list(a, defaults::text("devswarm_cli.flag_allow"));
    let watch_dirs: Vec<String> =
        csv_list(a, defaults::text("devswarm_cli.flag_watch_deletions")).into_iter().map(|d| d.trim_end_matches('/').to_string()).collect();
    let allow: Vec<Vec<Tok>> = allow_globs.iter().map(|g| glob_tokens(g)).collect();
    let mut reasons: Vec<&str> = Vec::new();
    if a.has(defaults::text("devswarm_cli.flag_fetch")) {
        // best effort, as Node: the result is not read, the checks below work off whatever refs exist
        let fetched = git(runner, cwd, &[defaults::text("devswarm_cli.ready_fetch"), defaults::text("devswarm_cli.ready_quiet")]);
        if fetched.is_none_or(|p| p.status != 0) {
            crate::debug::violated("meshw", defaults::text("devswarm_cli.msg_ready_fetch_failed"));
        }
    }
    // ff: exit 0 = true, 1 = false, anything else (or no clean run) = unknown
    let ff = match git(runner, cwd, &[defaults::text("devswarm_cli.ready_merge_base"), defaults::text("devswarm_cli.ready_is_ancestor"), base, sha]) {
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
    if let Some(p) = git(
        runner,
        cwd,
        &[defaults::text("devswarm_cli.ready_diff"), defaults::text("devswarm_cli.ready_raw"), defaults::text("devswarm_cli.ready_no_renames"), &range],
    )
    .filter(|p| p.status == 0)
    {
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
        outside = list.iter().filter(|p| !allow.iter().any(|toks| glob_matches(toks, p))).cloned().collect();
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsact::runner::RunResult;
    use crate::meshw::args;
    use std::cell::RefCell;

    /// Answers `merge-base --is-ancestor` with 0 and `diff --raw` with the given lines; remembers every call.
    struct Fake {
        diff: String,
        calls: RefCell<Vec<Vec<String>>>,
    }

    impl Runner for Fake {
        fn run(&self, spec: &RunSpec) -> RunResult {
            self.calls.borrow_mut().push(spec.args.clone());
            let stdout = if spec.args.iter().any(|a| a == "diff") { self.diff.clone() } else { String::new() };
            RunResult { ok: true, status: Some(0), stdout, ..RunResult::default() }
        }
    }

    fn inv() -> Inv {
        Inv { home: "/".into(), write_home: "/".into(), env: Default::default(), cwd: "/repo".into(), now: 1, stdin: None, store_override: None }
    }

    fn check(diff: &str, argv: &[&str]) -> (String, Vec<Vec<String>>) {
        let fake = Fake { diff: diff.into(), calls: RefCell::new(Vec::new()) };
        let a = args::parse(&argv.iter().map(|x| (*x).to_string()).collect::<Vec<_>>());
        let ans = ready_check_with(&inv(), &a, &fake).expect("the verb answers");
        (ans.stdout, fake.calls.into_inner())
    }

    fn raw(path: &str) -> String {
        format!(":100644 100644 aaaa bbbb M\t{path}\n")
    }

    #[test]
    fn fetch_runs_git_fetch_first_like_node_instead_of_handing_over() {
        let (_, calls) = check(&raw("a.rs"), &["ready-check", "abc", "--fetch"]);
        assert_eq!(calls[0][2..], ["fetch".to_string(), "--quiet".to_string()], "{calls:?}");
        assert_eq!(calls.len(), 3, "the fetch, then the ancestry probe and the diff");
        let (_, calls) = check(&raw("a.rs"), &["ready-check", "abc"]);
        assert_eq!(calls.len(), 2);
    }

    #[test]
    fn globs_match_utf16_units_so_a_question_mark_is_half_an_emoji() {
        let emoji = raw("src/\u{1F600}.rs");
        let outside = |glob: &str| check(&emoji, &["ready-check", "abc", "--allow", glob]).0.contains("\"outside_allowed\":[\"src/\u{1F600}.rs\"]");
        assert!(outside("src/?.rs"), "one unit is not a whole emoji");
        assert!(!outside("src/??.rs"), "two units are");
        assert!(!outside("src/*.rs"));
        assert!(!outside("src/\u{1F600}.rs"), "a literal emoji matches itself");
        assert!(!outside("**"));
    }

    #[test]
    fn star_stops_at_a_slash_and_double_star_does_not() {
        let nested = raw("src/deep/x.rs");
        let outside = |glob: &str| check(&nested, &["ready-check", "abc", "--allow", glob]).0.contains("\"outside_allowed\":[\"src/deep/x.rs\"]");
        assert!(outside("src/*.rs"));
        assert!(!outside("src/**/*.rs"));
        assert!(!outside("src/**"));
        assert!(!outside("src/**x.rs"));
        assert!(outside("src/d?ep"), "a glob is anchored at both ends");
        assert!(!outside("src/d?ep/x.rs"));
    }
}
