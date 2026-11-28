//! #931: the configured spawn source that does not exist, and the loud nothing-created answer.

use super::*;
use crate::dsact::runner::RunResult;
use std::cell::RefCell;

/// A repository whose default branch is `main`: `exists` lists the branches that resolve locally, `remote` what `ls-remote` answers
/// (0 found, 2 absent, anything else an unreachable remote). Every git call is remembered.
struct Repo {
    exists: Vec<&'static str>,
    remote: i32,
    /// What `ls-remote` prints (`<sha>\t<ref>` lines).
    ls_out: String,
    /// origin/HEAD resolves.
    head_ok: bool,
    calls: RefCell<Vec<Vec<String>>>,
}

impl Runner for Repo {
    fn run(&self, spec: &RunSpec) -> RunResult {
        self.calls.borrow_mut().push(spec.args.clone());
        let has = |w: &str| spec.args.iter().any(|a| a == w);
        let (status, stdout) = if has("symbolic-ref") {
            if self.head_ok { (0, "refs/remotes/origin/main\n".to_string()) } else { (1, String::new()) }
        } else if has("ls-remote") {
            (self.remote, self.ls_out.clone())
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
    let ls_out = if remote == 0 { "abc\trefs/heads/dev\n".to_string() } else { String::new() };
    Repo { exists, remote, ls_out, head_ok: true, calls: RefCell::new(Vec::new()) }
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

/// The nothing-created answer: ok:false, created:false, exit 2, an error that opens with the verdict and a retry that is the exact command.
#[test]
fn the_nothing_created_answer_says_so_and_gives_the_retry() {
    let ans = nothing_created(s("spawn"), "feat-x", &["-p", "go", "a b", "-s", "main"], "boom", OVal::Null, OVal::Null, None, None);
    let out = OVal::parse(ans.stdout.trim()).unwrap();
    assert_eq!(ans.code, 2);
    assert_eq!(out.get("ok"), Some(&OVal::Bool(false)));
    assert_eq!(out.get("created"), Some(&OVal::Bool(false)));
    assert!(str_at(&out, &["error"]).unwrap_or_default().starts_with("NOTHING CREATED"), "{}", out.stringify());
    assert_eq!(str_at(&out, &["retry"]), Some("ah-engine mesh spawn feat-x -p go 'a b' -s main"));
}

/// Only a CLI that exited with a non-zero code, no signal, no overflow and no timeout is proof that nothing was created.
#[test]
fn only_a_clean_nonzero_exit_proves_nothing_was_created() {
    use crate::meshw::hivecontrol::{Call, Full};
    let exited = |code: i32| Full { call: Call { ok: false, error: "exited".into(), ..Call::default() }, code: Some(code), ..Full::default() };
    assert!(proved_nothing_created(&exited(1)));
    assert!(!proved_nothing_created(&exited(0)), "an overflow after exit 0 proves nothing");
    assert!(!proved_nothing_created(&Full { overflow: true, ..exited(1) }));
    assert!(!proved_nothing_created(&Full { signal: Some(9), code: None, ..exited(1) }));
    assert!(!proved_nothing_created(&Full { spawn_failed: Some(std::io::ErrorKind::NotFound), code: None, ..exited(1) }));
    assert!(!proved_nothing_created(&Full { call: Call { timed_out: true, ..exited(1).call }, ..exited(1) }));
}

/// A create that failed without a proven non-zero exit (here: the CLI could not be started) keeps the old, non-claiming shape.
#[test]
fn a_failure_without_proof_does_not_claim_nothing_was_created() {
    let r = repo(vec![], 2);
    let (code, out) = run(Some("dev"), &["-p", "go"], &r, &[]);
    assert_eq!(code, 2);
    assert_eq!(out.get("ok"), Some(&OVal::Bool(false)));
    assert!(out.get("created").is_none() && out.get("retry").is_none(), "{}", out.stringify());
    assert!(!str_at(&out, &["error"]).unwrap_or_default().contains("NOTHING CREATED"));
}

/// A configured source that is absent while the default branch is unknown creates nothing: no base is guessed.
#[test]
fn an_absent_source_with_an_unknown_default_creates_nothing() {
    let mut r = repo(vec![], 2);
    r.head_ok = false;
    let (code, out) = run(Some("dev"), &["-p", "go"], &r, &[]);
    assert_eq!(code, 2);
    assert_eq!(out.get("created"), Some(&OVal::Bool(false)), "{}", out.stringify());
    let error = str_at(&out, &["error"]).unwrap_or_default();
    assert!(error.starts_with("NOTHING CREATED") && error.contains("default branch is unknown"), "{error}");
    assert_eq!(str_at(&out, &["retry"]), Some("ah-engine mesh spawn feat-x -p go -s <branch>"));
    assert!(out.get("timings").and_then(|t| t.get("createMs")).is_none(), "no create was attempted: {}", out.stringify());
    assert!(!r.calls.borrow().iter().any(|c| c.iter().any(|a| a == "fetch")));
}

/// `ls-remote` matches ref TAILS: a branch that only exists as `refs/heads/feature/refs/heads/dev` is not `dev`.
#[test]
fn a_tail_only_ls_remote_match_is_not_the_branch() {
    let mut r = repo(vec![], 0);
    r.ls_out = "abc\trefs/heads/feature/refs/heads/dev\n".to_string();
    let (_, out) = run(Some("dev"), &["-p", "go"], &r, &[]);
    assert_eq!(str_at(&out, &["sourceFallback", "used"]), Some("main"), "{}", out.stringify());
}

/// A submodule repo whose `worktree list` shows the branch checked out at `other`, and whose `worktree add` creates the `.git` link.
struct Busy {
    other: String,
    calls: RefCell<Vec<Vec<String>>>,
}

impl Runner for Busy {
    fn run(&self, spec: &RunSpec) -> RunResult {
        self.calls.borrow_mut().push(spec.args.clone());
        let has = |w: &str| spec.args.iter().any(|a| a == w);
        let stdout = if has("list") {
            format!("worktree {}\nHEAD {}\nbranch refs/heads/feat-x\n", self.other, "1".repeat(40))
        } else if has("add") {
            // the path follows the add options: the first argument after `add` that is absolute
            let at = spec.args.iter().position(|a| a == "add").unwrap();
            let p = spec.args[at + 1..].iter().find(|a| a.starts_with('/')).unwrap();
            std::fs::create_dir_all(p).unwrap();
            std::fs::write(Path::new(p).join(".git"), "gitdir: x\n").unwrap();
            String::new()
        } else {
            String::new()
        };
        let status = if has("--verify") { 1 } else { 0 };
        RunResult { ok: status == 0, status: Some(status), stdout, ..RunResult::default() }
    }
}

/// #844 item 5: the worktreeInclude copy made the submodule path non-empty ("already exists") AND the branch is checked out in
/// another worktree. The repair adds the submodule worktree detached at the pinned commit, moves the pre-copied file back, and says so.
#[test]
fn a_submodule_whose_branch_is_checked_out_elsewhere_is_repaired_detached_at_the_pin() {
    defaults::init().unwrap();
    let base = crate::testtmp::path(format!("ah-spawn-busy-{}", std::process::id()));
    crate::discard::harmless(std::fs::remove_dir_all(&base)); // keep: a stale directory of an earlier run
    let wt = base.join("wt");
    std::fs::create_dir_all(&wt).unwrap();
    assert!(std::process::Command::new("git").current_dir(&wt).args(["init", "-q", "-b", "main"]).status().unwrap().success());
    let wt = wt.canonicalize().unwrap().to_string_lossy().into_owned();
    std::fs::create_dir_all(format!("{wt}/.git/modules/app")).unwrap();
    let p = format!("{wt}/app");
    std::fs::create_dir_all(&p).unwrap();
    std::fs::write(format!("{p}/.env"), "K=1\n").unwrap();
    let other = base.join("old");
    std::fs::create_dir_all(&other).unwrap();
    let runner = Busy { other: other.to_string_lossy().into_owned(), calls: RefCell::new(Vec::new()) };
    let pin = "a".repeat(40);
    let text = format!("git worktree add -b feat-x {p} {pin}\nfatal: '{p}' already exists\n");
    let f = Failure { path: Some(p.clone()), error: t("devswarm_cli.sp_fail_already_exists").to_string(), repair_error: None };
    let got = repair_one(&runner, &f, &text, "feat-x", Some(&["app".to_string()]), 1).expect("repaired").expect("a handled shape");
    let add = runner.calls.borrow().iter().find(|c| c.iter().any(|a| a == "add")).cloned().unwrap();
    assert!(add.iter().any(|a| a == "--detach") && add.iter().any(|a| a == &pin) && !add.iter().any(|a| a == "-b"), "{add:?}");
    assert_eq!(got.get("detached"), Some(&OVal::Bool(true)), "{}", got.stringify());
    assert!(str_at(&got, &["note"]).is_some_and(|n| n.contains("feat-x")), "{}", got.stringify());
    assert_eq!(std::fs::read_to_string(format!("{p}/.env")).unwrap(), "K=1\n", "the pre-copied file is moved back");
    crate::discard::harmless(std::fs::remove_dir_all(&base)); // keep: cleanup
}
