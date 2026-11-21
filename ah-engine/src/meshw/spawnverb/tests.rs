//! #931: the configured spawn source that does not exist, and the loud nothing-created answer.

use super::*;
use crate::dsact::runner::RunResult;
use std::cell::RefCell;

/// A repository whose default branch is `main`: `exists` lists the branches that resolve locally, `remote` what `ls-remote` answers
/// (0 found, 2 absent, anything else an unreachable remote). Every git call is remembered.
struct Repo {
    exists: Vec<&'static str>,
    remote: i32,
    calls: RefCell<Vec<Vec<String>>>,
}

impl Runner for Repo {
    fn run(&self, spec: &RunSpec) -> RunResult {
        self.calls.borrow_mut().push(spec.args.clone());
        let has = |w: &str| spec.args.iter().any(|a| a == w);
        let (status, stdout) = if has("symbolic-ref") {
            (0, "refs/remotes/origin/main\n".to_string())
        } else if has("ls-remote") {
            (self.remote, String::new())
        } else if has("rev-parse") {
            let hit = spec
                .args
                .iter()
                .any(|a| self.exists.iter().any(|b| a == &format!("refs/heads/{b}^{{commit}}") || a == &format!("refs/remotes/origin/{b}^{{commit}}")));
            let named = spec.args.iter().any(|a| a.starts_with("refs/"));
            // the default branch's own refs always resolve; a named other branch resolves only when listed
            let main = spec.args.iter().any(|a| a.contains("/main^{commit}") || a.contains("origin/main^{commit}"));
            if !named || main || hit { (0, "abc\n".to_string()) } else { (1, String::new()) }
        } else {
            (0, String::new())
        };
        RunResult { ok: status == 0, status: Some(status), stdout, ..RunResult::default() }
    }
}

fn run(configured: Option<&str>, rest: &[&str], repo: &Repo, extra_env: &[(&str, &str)]) -> (i32, OVal) {
    let mut env: crate::meshw::ident::Env = Default::default();
    if let Some(c) = configured {
        env.insert("ANTIHALL_DEVSWARM_SPAWN_SOURCE".into(), c.into());
    }
    for (k, v) in extra_env {
        env.insert((*k).into(), (*v).into());
    }
    let home = std::env::temp_dir().join(format!("ah-spawn-fallback-{}-{}", std::process::id(), repo.calls.borrow().len()));
    std::fs::create_dir_all(&home).unwrap();
    let inv = Inv { home: home.clone(), write_home: home, env, cwd: "/".into(), now: 1, stdin: None, store_override: None };
    let ans = create_with(&inv, rest, "feat-x", repo).expect("the verb answers");
    (ans.code, OVal::parse(ans.stdout.trim()).expect("one JSON object"))
}

fn repo(exists: Vec<&'static str>, remote: i32) -> Repo {
    Repo { exists, remote, calls: RefCell::new(Vec::new()) }
}

fn str_at<'a>(v: &'a OVal, path: &[&str]) -> Option<&'a str> {
    let mut cur = v;
    for k in path {
        cur = cur.get(k)?;
    }
    if let OVal::Str(x) = cur { Some(x.as_str()) } else { None }
}

/// #931: `devswarm.spawnSource = "dev"` in a repo with no `dev` made every spawn without -s fail. The configured source that does
/// not exist here falls back to the repository's default branch, and the result says so.
#[test]
fn a_configured_source_that_does_not_exist_falls_back_to_the_default_branch() {
    let r = repo(vec![], 2);
    let (_, out) = run(Some("dev"), &["-p", "go"], &r, &[]);
    assert_eq!(str_at(&out, &["sourceFallback", "configured"]), Some("dev"), "{}", out.stringify());
    assert_eq!(str_at(&out, &["sourceFallback", "used"]), Some("main"), "{}", out.stringify());
    assert_eq!(str_at(&out, &["sourceCheck", "source"]), Some("main"), "the check ran against the default branch: {}", out.stringify());
}

/// A configured source that exists (locally or as a remote-tracking ref) is passed as before: no fallback.
#[test]
fn a_configured_source_that_exists_is_still_used() {
    for r in [repo(vec!["dev"], 2), repo(vec![], 0)] {
        let (_, out) = run(Some("dev"), &["-p", "go"], &r, &[]);
        assert!(out.get("sourceFallback").is_none(), "{}", out.stringify());
        assert_eq!(str_at(&out, &["sourceCheck", "status"]), Some("skipped"), "{}", out.stringify());
        assert!(str_at(&out, &["sourceCheck", "reason"]).is_some_and(|x| x.contains("\"dev\"")), "{}", out.stringify());
    }
}

/// An unreachable remote proves nothing: the configured source stands (the failure, if any, stays loud).
#[test]
fn an_unreachable_remote_keeps_the_configured_source() {
    let r = repo(vec![], 128);
    let (_, out) = run(Some("dev"), &["-p", "go"], &r, &[]);
    assert!(out.get("sourceFallback").is_none(), "{}", out.stringify());
}

/// An explicit `-s <missing>` is what the user asked for: it is never replaced, and no existence probe runs for it.
#[test]
fn an_explicit_missing_source_is_never_replaced() {
    let r = repo(vec![], 2);
    let (code, out) = run(Some("dev"), &["-s", "nope", "-p", "go"], &r, &[]);
    assert!(out.get("sourceFallback").is_none(), "{}", out.stringify());
    assert_eq!(code, 2);
    assert_eq!(out.get("ok"), Some(&OVal::Bool(false)));
    assert!(!r.calls.borrow().iter().any(|c| c.iter().any(|a| a == "ls-remote")));
}

/// The setting turns the fallback off: the configured source is passed as before.
#[test]
fn the_setting_turns_the_fallback_off() {
    let r = repo(vec![], 2);
    let (_, out) = run(Some("dev"), &["-p", "go"], &r, &[("ANTIHALL_DEVSWARM_SPAWN_SOURCE_FALLBACK", "false")]);
    assert!(out.get("sourceFallback").is_none(), "{}", out.stringify());
}

/// Every nothing-created outcome is unmistakable: ok:false, created:false, exit 2, and the error opens with the verdict and the
/// exact retry command.
#[test]
fn a_failed_create_says_nothing_was_created_and_gives_the_retry() {
    let r = repo(vec![], 2);
    let (code, out) = run(Some("dev"), &["-p", "go"], &r, &[]);
    assert_eq!(code, 2);
    assert_eq!(out.get("ok"), Some(&OVal::Bool(false)));
    assert_eq!(out.get("created"), Some(&OVal::Bool(false)), "{}", out.stringify());
    let error = str_at(&out, &["error"]).unwrap_or_default();
    assert!(error.starts_with("NOTHING CREATED"), "{error}");
    assert!(error.contains("ah-engine mesh spawn feat-x -p go -s main"), "{error}");
    assert_eq!(str_at(&out, &["retry"]), Some("ah-engine mesh spawn feat-x -p go -s main"));
}
