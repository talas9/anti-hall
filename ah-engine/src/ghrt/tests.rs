//! Tests of GitHub realtime: a stub GitHub (200, 304 by ETag, 403, 429, Retry-After, rate headers) behind the runner, real
//! git repositories in a scratch directory, and the shell stub `gh` for the real command runner.
use super::api::{Fail, GhRunner, Resp, Runner};
use super::cfg::Cfg;
use super::poll::{self, State};
use super::{repos, segment, status_json};
use serde_json::{Value, json};
use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, VecDeque};
use std::path::{Path, PathBuf};
use std::process::Command;

const T0: u64 = 1_000_000_000_000;
const ACME: &str = "https://github.com/acme/widgets.git";

fn kind_of(path: &str) -> &'static str {
    if path.contains("/pulls?") {
        "pulls"
    } else if path.contains("/reviews") {
        "reviews"
    } else if path.contains("/pulls/") {
        "pull"
    } else if path.contains("/check-runs") {
        "checks"
    } else if path.contains("/actions/runs") {
        "runs"
    } else if path.contains("/rules/") {
        "rules"
    } else {
        "other"
    }
}

/// A fake GitHub: one sticky answer per endpoint kind (a 200 with an ETag answers 304 to a request that carries it), a queue
/// of one-off replies, rate-limit headers and a `used` counter that rises by one per non-304 answer.
struct Stub {
    sticky: RefCell<BTreeMap<&'static str, (u16, String, String)>>,
    once: RefCell<BTreeMap<&'static str, VecDeque<Result<Resp, Fail>>>>,
    log: RefCell<Vec<(String, Option<String>)>>,
    used: Cell<u64>,
    headers: Cell<bool>,
    remaining: Cell<Option<u64>>,
}

impl Stub {
    fn new() -> Stub {
        Stub {
            sticky: RefCell::default(),
            once: RefCell::default(),
            log: RefCell::default(),
            used: Cell::new(0),
            headers: Cell::new(true),
            remaining: Cell::new(None),
        }
    }

    fn set(&self, kind: &'static str, status: u16, etag: &str, body: Value) {
        self.sticky.borrow_mut().insert(kind, (status, etag.to_string(), body.to_string()));
    }

    fn queue(&self, kind: &'static str, r: Result<Resp, Fail>) {
        self.once.borrow_mut().entry(kind).or_default().push_back(r);
    }

    fn calls(&self) -> usize {
        self.log.borrow().len()
    }

    fn calls_to(&self, kind: &str) -> usize {
        self.log.borrow().iter().filter(|(p, _)| kind_of(p) == kind).count()
    }

    fn rate(&self, h: &mut BTreeMap<String, String>) {
        if self.headers.get() {
            h.insert("x-ratelimit-limit".into(), "5000".into());
            h.insert("x-ratelimit-remaining".into(), self.remaining.get().unwrap_or(5000u64.saturating_sub(self.used.get())).to_string());
            h.insert("x-ratelimit-used".into(), self.used.get().to_string());
            h.insert("x-ratelimit-reset".into(), (T0 / 1000 + 3600).to_string());
        }
    }
}

impl Runner for Stub {
    fn call(&self, path: &str, etag: Option<&str>) -> Result<Resp, Fail> {
        self.log.borrow_mut().push((path.to_string(), etag.map(String::from)));
        let kind = kind_of(path);
        if let Some(r) = self.once.borrow_mut().get_mut(kind).and_then(VecDeque::pop_front) {
            return r.map(|mut r| {
                self.used.set(self.used.get() + 1);
                let mut h = BTreeMap::new();
                self.rate(&mut h);
                for (k, v) in h {
                    r.headers.entry(k).or_insert(v);
                }
                r
            });
        }
        let (status, tag, body) = self.sticky.borrow().get(kind).cloned().unwrap_or((404, String::new(), json!({"message": "Not Found"}).to_string()));
        let mut headers = BTreeMap::new();
        if !tag.is_empty() {
            headers.insert("etag".to_string(), tag.clone());
        }
        if status == 200 && etag == Some(tag.as_str()) && !tag.is_empty() {
            self.rate(&mut headers);
            return Ok(Resp { status: 304, headers, body: String::new() });
        }
        self.used.set(self.used.get() + 1);
        self.rate(&mut headers);
        Ok(Resp { status, headers, body })
    }
}

fn reply(status: u16, headers: &[(&str, &str)], body: &str) -> Result<Resp, Fail> {
    Ok(Resp { status, headers: headers.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(), body: body.to_string() })
}

fn git(dir: &Path, args: &[&str]) {
    let o =
        Command::new("git").arg("-C").arg(dir).args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"]).args(args).output().unwrap();
    assert!(o.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&o.stderr));
}

struct Fx {
    dir: PathBuf,
    cfg: Cfg,
}

impl Fx {
    fn new(name: &str) -> Fx {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("target").join("ghrt-test").join(format!("{name}-{}", std::process::id()));
        if dir.exists() {
            std::fs::remove_dir_all(&dir).unwrap();
        }
        std::fs::create_dir_all(&dir).unwrap();
        let cfg = Cfg::shipped().in_dir(&dir.join("state"));
        Fx { dir, cfg }
    }

    /// A git repository with one commit, optionally an origin; its directory is noted as a session's cwd.
    fn repo(&self, name: &str, origin: Option<&str>) -> PathBuf {
        let r = self.dir.join(name);
        std::fs::create_dir_all(&r).unwrap();
        git(&r, &["init", "-q", "-b", "main"]);
        git(&r, &["commit", "-q", "--allow-empty", "-m", "first"]);
        if let Some(u) = origin {
            git(&r, &["remote", "add", "origin", u]);
        }
        self.note(&r, T0);
        r
    }

    fn note(&self, dir: &Path, now: u64) {
        let state = repos::dir(&self.cfg);
        assert!(repos::note(&state, "cwds.json", &dir.to_string_lossy(), now, 0, 24 * 3_600_000, 100));
    }

    fn tick(&self, run: &dyn Runner, now: u64) -> poll::Report {
        poll::tick(&self.cfg, run, now, false)
    }

    fn state(&self) -> State {
        poll::load(&self.cfg)
    }

    fn repo_state(&self, name: &str) -> poll::Repo {
        self.state().repos.values().find(|r| r.root.ends_with(name)).cloned().unwrap_or_else(|| panic!("repo {name} not followed"))
    }
}

impl Drop for Fx {
    fn drop(&mut self) {
        crate::discard::harmless(std::fs::remove_dir_all(&self.dir)); // keep: scratch of a finished test
    }
}

/// An open pull request #7 whose checks are running.
fn open_pr(s: &Stub) {
    s.set("pulls", 200, "\"p1\"", json!([{"number": 7, "state": "open", "base": {"ref": "main"}, "title": "t"}]));
    s.set("pull", 200, "\"d1\"", json!({"mergeable_state": "clean", "mergeable": true}));
    s.set("reviews", 200, "\"v1\"", json!([]));
    s.set("checks", 200, "\"c1\"", json!({"check_runs": [{"name": "build", "status": "in_progress", "conclusion": null}]}));
    s.set("runs", 200, "\"w1\"", json!({"workflow_runs": []}));
}

fn edge_kinds(fx: &Fx) -> Vec<String> {
    poll::edges(&fx.cfg).iter().map(|e| e["kind"].as_str().unwrap_or("").to_string()).collect()
}

#[test]
fn follows_a_repo_without_devswarm_and_turns_a_changed_etag_into_a_red_edge() {
    // no DevSwarm anywhere: the only inputs are a hook's cwd, git and gh
    let fx = Fx::new("flow");
    fx.repo("r1", Some(ACME));
    let s = Stub::new();
    open_pr(&s);
    let r = fx.tick(&s, T0 + 1000);
    assert_eq!((r.polled, r.calls, r.edges), (1, 6, 0), "first sight: pulls, pull, reviews, rules, checks, runs; no edge without a baseline");
    let repo = fx.repo_state("r1");
    assert_eq!(
        (repo.slug.as_str(), repo.status["checks"].as_str(), repo.status["pr"].as_str(), repo.status["number"].as_u64()),
        ("acme/widgets", Some("running"), Some("open"), Some(7))
    );
    assert!(s.log.borrow().iter().all(|(_, e)| e.is_none()), "no ETag is known yet");

    s.set("checks", 200, "\"c2\"", json!({"check_runs": [{"name": "build", "status": "completed", "conclusion": "success"}, {"name": "test", "status": "completed", "conclusion": "failure"}]}));
    let before = s.calls();
    let r = fx.tick(&s, T0 + 1000 + 30_001);
    assert_eq!((r.polled, r.calls, r.edges), (1, 5, 1), "the rules are read once per rules_ms; the rest is conditional");
    assert!(
        s.log.borrow()[before..].iter().filter(|(p, _)| kind_of(p) == "pulls").all(|(_, e)| e.as_deref() == Some("\"p1\"")),
        "the ETag of the first answer is sent back"
    );
    let edges = poll::edges(&fx.cfg);
    assert_eq!((edges[0]["kind"].as_str(), edges[0]["slug"].as_str(), edges[0]["number"].as_u64()), (Some("ci_red"), Some("acme/widgets"), Some(7)));
    assert!(edges[0]["text"].as_str().unwrap_or("").contains("test"), "names the failing job: {}", edges[0]["text"]);
    assert_eq!(edges[0]["jobs"], json!(["test"]));
}

#[test]
fn a_304_costs_nothing_and_the_cost_of_each_kind_of_answer_is_measured() {
    let fx = Fx::new("measure");
    fx.repo("r1", Some(ACME));
    let s = Stub::new();
    open_pr(&s);
    fx.tick(&s, T0 + 1000);
    for i in 1..=3u64 {
        let r = poll::tick(&fx.cfg, &s, T0 + 1000 + i * 31_000, true);
        assert_eq!(r.calls, 5, "tick {i}: conditional calls only (the rules wait for their interval)");
    }
    let st = fx.state();
    let (c304, c200) = (&st.measure["s304"], &st.measure["s200"]);
    assert_eq!((c304.n, c304.sum, c304.zero), (12, 0, 12), "every 304 left the used counter where it was");
    assert_eq!(c200.sum, c200.n, "every 200 cost exactly one");
    assert_eq!(st.window_calls, 6, "only the 200s (and the 404) were counted in the budget");
    let v = status_json(&fx.cfg, T0 + 100_000);
    assert_eq!(v["measure"]["s304"]["free"], 12);
}

#[test]
fn counting_304s_exhausts_the_budget_and_not_counting_them_does_not() {
    let run = |count: u64| {
        let fx = Fx::new(&format!("count{count}"));
        fx.repo("r1", Some(ACME));
        let s = Stub::new();
        s.headers.set(false);
        open_pr(&s);
        let cfg = Cfg::shipped()
            .in_dir(&fx.dir.join("state"))
            .with("github_rt.assumed_limit", json!(200))
            .with("github_rt.budget_pct", json!(10))
            .with("github_rt.count_304", json!(count));
        poll::tick(&cfg, &s, T0 + 1000, false);
        for i in 1..=4u64 {
            poll::tick(&cfg, &s, T0 + 1000 + i * 31_000, true);
        }
        poll::load(&cfg)
    };
    let free = run(0);
    assert!(free.hold_reason.is_empty(), "304s are free: {}", free.hold_reason);
    let counted = run(1);
    assert_eq!(counted.hold_reason, "budget", "the same traffic counted in full runs the 20-call budget out");
}

#[test]
fn the_budget_stops_the_calls_and_resumes_when_the_window_turns() {
    let fx = Fx::new("budget");
    fx.repo("r1", Some(ACME));
    let s = Stub::new();
    s.headers.set(false);
    open_pr(&s);
    let cfg = Cfg::shipped().in_dir(&fx.dir.join("state")).with("github_rt.assumed_limit", json!(100)).with("github_rt.budget_pct", json!(5));
    let r = poll::tick(&cfg, &s, T0 + 1000, false);
    let st = poll::load(&cfg);
    assert_eq!((r.calls, r.polled, st.hold_reason.as_str()), (5, 0, "budget"), "5% of 100 is five calls; the pass stops half way and compares nothing");
    assert_eq!(st.hold_until_ms, st.window_start_ms + cfg.int("github_rt.window_ms"));
    let r = poll::tick(&cfg, &s, T0 + 60_000, false);
    assert_eq!(r.calls, 0, "no call while the hold lasts");
    let r = poll::tick(&cfg, &s, T0 + 1000 + cfg.int("github_rt.window_ms") + 1, false);
    assert!(r.calls > 0 && r.polled == 1, "the next window continues: {r:?}");
}

#[test]
fn few_remaining_requests_hold_the_polling_until_the_limit_resets() {
    let fx = Fx::new("remaining");
    fx.repo("r1", Some(ACME));
    let s = Stub::new();
    open_pr(&s);
    s.remaining.set(Some(50));
    fx.tick(&s, T0 + 1000);
    let st = fx.state();
    assert_eq!(
        (st.hold_reason.as_str(), st.hold_until_ms),
        ("budget", (T0 / 1000 + 3600) * 1000),
        "below min_remaining: nothing until the reset time the API gave"
    );
}

#[test]
fn a_secondary_limit_honours_retry_after_and_caps_it() {
    let fx = Fx::new("retry");
    fx.repo("r1", Some(ACME));
    let s = Stub::new();
    open_pr(&s);
    s.queue("pulls", reply(403, &[("retry-after", "90")], r#"{"message":"You have exceeded a secondary rate limit."}"#));
    let r = fx.tick(&s, T0 + 1000);
    let st = fx.state();
    assert_eq!((r.calls, st.hold_reason.as_str(), st.hold_until_ms), (1, "backoff", T0 + 1000 + 90_000));
    assert_eq!(fx.tick(&s, T0 + 50_000).calls, 0, "held");
    assert!(fx.tick(&s, T0 + 1000 + 90_001).calls > 0, "released after Retry-After");
    assert_eq!(fx.state().backoff_n, 0, "a good answer resets the backoff");

    s.queue("pulls", reply(429, &[("retry-after", "99999")], "{}"));
    poll::tick(&fx.cfg, &s, T0 + 1_000_000, true);
    assert_eq!(fx.state().hold_until_ms, T0 + 1_000_000 + fx.cfg.int("github_rt.backoff_max_ms"), "a huge Retry-After is capped");
}

#[test]
fn without_retry_after_the_backoff_doubles_up_to_its_maximum() {
    let fx = Fx::new("double");
    fx.repo("r1", Some(ACME));
    let s = Stub::new();
    open_pr(&s);
    let base = fx.cfg.int("github_rt.backoff_ms");
    let mut now = T0 + 1000;
    for n in 0..3u32 {
        s.queue("pulls", reply(429, &[], "{}"));
        poll::tick(&fx.cfg, &s, now, true);
        assert_eq!(fx.state().hold_until_ms, now + (base << n), "wait {n}");
        now = fx.state().hold_until_ms + 1;
    }
    let st = fx.state();
    assert_eq!(st.backoff_n, 3);
    let small = Cfg::shipped().in_dir(&fx.dir.join("state")).with("github_rt.backoff_max_ms", json!(100_000));
    s.queue("pulls", reply(500, &[], "{}"));
    poll::tick(&small, &s, now, true);
    assert_eq!(poll::load(&small).hold_until_ms, now + 100_000, "5xx backs off too, and the maximum applies");
}

#[test]
fn an_exhausted_primary_limit_waits_for_the_reset() {
    let fx = Fx::new("primary");
    fx.repo("r1", Some(ACME));
    let s = Stub::new();
    open_pr(&s);
    let reset = (T0 / 1000 + 1800).to_string();
    s.queue(
        "pulls",
        reply(403, &[("x-ratelimit-remaining", "0"), ("x-ratelimit-reset", &reset), ("x-ratelimit-limit", "5000")], r#"{"message":"API rate limit exceeded"}"#),
    );
    fx.tick(&s, T0 + 1000);
    let st = fx.state();
    assert_eq!((st.hold_reason.as_str(), st.hold_until_ms), ("budget", (T0 / 1000 + 1800) * 1000));
}

#[test]
fn a_repo_that_answers_403_or_404_is_left_alone_for_a_while_and_others_are_not_held() {
    let fx = Fx::new("noaccess");
    fx.repo("r1", Some(ACME));
    fx.repo("r2", Some("https://github.com/acme/other.git"));
    let s = Stub::new();
    open_pr(&s);
    s.queue("pulls", reply(404, &[], r#"{"message":"Not Found"}"#));
    let r = fx.tick(&s, T0 + 1000);
    assert_eq!(r.polled, 1, "the other repo was still polled");
    let errored: Vec<_> = fx.state().repos.values().filter(|r| r.err_status == 404).cloned().collect();
    assert_eq!(errored.len(), 1);
    assert!(errored[0].err_until_ms > T0 + 1000 && fx.state().hold_until_ms == 0);
    let calls = s.calls();
    poll::tick(&fx.cfg, &s, T0 + 2000, true);
    let again = s.log.borrow()[calls..].iter().filter(|(p, _)| p.contains("widgets") || p.contains("other")).count();
    assert!(again > 0 && s.log.borrow()[calls..].iter().filter(|(p, _)| p.contains(&errored[0].slug)).count() == 0, "the errored repo is skipped");
}

#[test]
fn a_branch_without_a_pull_request_polls_only_its_commit() {
    let fx = Fx::new("nopr");
    fx.repo("r1", Some(ACME));
    let s = Stub::new();
    s.set("pulls", 200, "\"p\"", json!([]));
    s.set("checks", 200, "\"c\"", json!({"check_runs": [{"name": "build", "status": "completed", "conclusion": "success"}]}));
    s.set("runs", 200, "\"w\"", json!({"workflow_runs": []}));
    let r = fx.tick(&s, T0 + 1000);
    assert_eq!((r.calls, s.calls_to("pull"), s.calls_to("reviews"), s.calls_to("rules")), (3, 0, 0, 0));
    let repo = fx.repo_state("r1");
    assert_eq!((repo.status["pr"].as_str(), repo.status["checks"].as_str()), (Some("none"), Some("green")));
    assert_eq!(repo.next_poll_ms, T0 + 1000 + fx.cfg.int("github_rt.poll_nopr_ms"));
}

#[test]
fn a_detached_head_asks_for_no_pull_request_but_still_reads_the_commit_checks() {
    let fx = Fx::new("detached");
    let r = fx.repo("r1", Some(ACME));
    git(&r, &["checkout", "-q", "--detach"]);
    let s = Stub::new();
    open_pr(&s);
    let rep = fx.tick(&s, T0 + 1000);
    assert_eq!((rep.polled, s.calls_to("pulls"), s.calls_to("checks")), (1, 0, 1));
    assert_eq!(fx.repo_state("r1").status["pr"], "none");
}

#[test]
fn a_remote_that_is_not_github_or_missing_is_never_asked_about() {
    let fx = Fx::new("nongh");
    fx.repo("lab", Some("https://gitlab.com/acme/widgets.git"));
    fx.repo("bare", None);
    let s = Stub::new();
    open_pr(&s);
    let r = fx.tick(&s, T0 + 1000);
    assert_eq!((r.polled, r.calls, s.calls()), (0, 0, 0));
    let st = fx.state();
    let kinds: Vec<&str> = st.repos.values().map(|r| r.kind.as_str()).collect();
    assert!(kinds.contains(&"not_github") && kinds.contains(&"no_remote"), "{kinds:?}");
    let v = status_json(&fx.cfg, T0 + 2000);
    assert_eq!(v["repos"].as_array().map(Vec::len), Some(2), "they are listed, with their kind");
}

#[test]
fn several_repos_are_followed_at_once_and_capped_to_the_most_recent() {
    let fx = Fx::new("multi");
    let a = fx.repo("a", Some("https://github.com/acme/a.git"));
    let b = fx.repo("b", Some("git@github.com:acme/b.git"));
    let c = fx.repo("c", Some("https://github.com/acme/c.git"));
    fx.note(&a, T0 + 10);
    fx.note(&b, T0 + 20);
    fx.note(&c, T0 + 30);
    let s = Stub::new();
    open_pr(&s);
    let cfg = Cfg::shipped().in_dir(&fx.dir.join("state")).with("github_rt.max_repos", json!(2));
    let r = poll::tick(&cfg, &s, T0 + 1000, false);
    assert_eq!(r.polled, 2);
    let slugs: Vec<String> = poll::load(&cfg).repos.values().map(|r| r.slug.clone()).collect();
    assert_eq!(slugs, ["acme/b", "acme/c"], "the two most recently active, in root order");
    // a session that stays away drops its repo
    let long_after = T0 + cfg.int("github_rt.cwd_ttl_ms") + 25;
    poll::tick(&cfg, &s, long_after, false);
    assert_eq!(poll::load(&cfg).repos.len(), 1, "only the directory seen within the ttl is left");
}

#[test]
fn a_push_polls_at_once_and_a_local_commit_does_not() {
    let fx = Fx::new("push");
    let r = fx.repo("r1", Some(ACME));
    let s = Stub::new();
    open_pr(&s);
    fx.tick(&s, T0 + 1000);
    let n = s.calls();
    assert_eq!(fx.tick(&s, T0 + 2000).polled, 0, "not due");
    git(&r, &["commit", "-q", "--allow-empty", "-m", "second"]);
    assert_eq!(fx.tick(&s, T0 + 3000).polled, 0, "a local commit alone is not a push");
    assert_eq!(s.calls(), n);
    assert_ne!(fx.repo_state("r1").sha, "");
    git(&r, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
    s.set("checks", 200, "\"c-new\"", json!({"check_runs": []}));
    let rep = fx.tick(&s, T0 + 4000);
    assert_eq!(rep.polled, 1, "the remote-tracking ref moved: poll now");
    let repo = fx.repo_state("r1");
    assert_eq!(repo.status["checks"], "running", "no checks yet for a fresh push reads as running for the watch window");
    assert_eq!(repo.next_poll_ms, T0 + 4000 + fx.cfg.int("github_rt.poll_running_ms"));
}

#[test]
fn a_checkout_of_another_branch_starts_a_fresh_baseline() {
    let fx = Fx::new("checkout");
    let r = fx.repo("r1", Some(ACME));
    let s = Stub::new();
    open_pr(&s);
    fx.tick(&s, T0 + 1000);
    git(&r, &["checkout", "-q", "-b", "feature"]);
    s.set("checks", 200, "\"cf\"", json!({"check_runs": [{"name": "build", "status": "completed", "conclusion": "failure"}]}));
    let rep = fx.tick(&s, T0 + 2000);
    assert_eq!((rep.polled, rep.edges), (1, 0), "another branch is polled at once, and its first sight raises no edge");
    assert_eq!(fx.repo_state("r1").branch, "feature");
}

#[test]
fn gh_missing_logged_out_or_offline_is_a_quiet_state_that_recovers() {
    for (name, fail, want) in [
        ("missing", Fail::Missing, "missing"),
        ("logged_out", Fail::NoResponse("To use GitHub CLI, run: gh auth login".into()), "logged_out"),
        ("offline", Fail::NoResponse("error connecting to api.github.com".into()), "offline"),
        ("timeout", Fail::Timeout, "offline"),
    ] {
        let fx = Fx::new(name);
        fx.repo("r1", Some(ACME));
        let s = Stub::new();
        open_pr(&s);
        s.queue("pulls", Err(fail));
        let r = fx.tick(&s, T0 + 1000);
        let st = fx.state();
        assert_eq!((r.calls, r.edges, st.gh.as_str(), st.hold_reason.as_str()), (0, 0, want, want), "{name}");
        assert_eq!(fx.tick(&s, T0 + 2000).calls, 0, "{name}: no further call while it is held");
        assert_eq!(s.calls(), 1, "{name}: one failed call, no spam");
        let v = status_json(&fx.cfg, T0 + 2000);
        assert_eq!(v["gh"], want);
        assert_eq!(segment(&fx.cfg, &fx.dir.to_string_lossy(), T0 + 2000), "", "{name}: nothing in the statusline");
        let later = st.hold_until_ms + 1;
        assert_eq!(fx.tick(&s, later).polled, 1, "{name}: recovers");
        assert_eq!(fx.state().gh, "ok");
    }
}

#[test]
fn off_means_no_call_and_no_state_but_off() {
    let fx = Fx::new("off");
    fx.repo("r1", Some(ACME));
    let s = Stub::new();
    open_pr(&s);
    let cfg = Cfg::shipped().in_dir(&fx.dir.join("state")).with("github_rt.enabled", json!(false));
    poll::tick(&cfg, &s, T0 + 1000, false);
    assert_eq!((s.calls(), poll::load(&cfg).gh.as_str()), (0, "disabled"));
}

#[test]
fn the_same_edge_is_recorded_once_per_cooldown_and_the_log_is_capped() {
    let fx = Fx::new("cooldown");
    fx.repo("r1", Some(ACME));
    let s = Stub::new();
    open_pr(&s);
    fx.tick(&s, T0 + 1000);
    let red = json!({"check_runs": [{"name": "t", "status": "completed", "conclusion": "failure"}]});
    let run = json!({"check_runs": [{"name": "t", "status": "in_progress", "conclusion": null}]});
    let mut now = T0 + 1000;
    for (i, b) in [red.clone(), run.clone(), red.clone()].into_iter().enumerate() {
        now += 31_000;
        s.set("checks", 200, &format!("\"x{i}\""), b);
        poll::tick(&fx.cfg, &s, now, true);
    }
    assert_eq!(edge_kinds(&fx), ["ci_red"], "red, running, red again on the same commit inside the cooldown: one edge");
    let cfg = Cfg::shipped().in_dir(&fx.dir.join("state")).with("github_rt.edge_cooldown_ms", json!(0)).with("github_rt.max_edges", json!(5));
    for i in 0..8 {
        for (j, b) in [run.clone(), red.clone()].into_iter().enumerate() {
            now += 31_000;
            s.set("checks", 200, &format!("\"y{i}{j}\""), b);
            poll::tick(&cfg, &s, now, true);
        }
    }
    assert_eq!(poll::edges(&cfg).len(), 5, "only the newest five are kept");
}

#[test]
fn merged_review_and_conflict_edges_come_from_the_pull_request() {
    let fx = Fx::new("pred");
    fx.repo("r1", Some(ACME));
    let s = Stub::new();
    open_pr(&s);
    fx.tick(&s, T0 + 1000);
    s.set("reviews", 200, "\"v2\"", json!([{"user": {"login": "x"}, "state": "CHANGES_REQUESTED"}]));
    s.set("pull", 200, "\"d2\"", json!({"mergeable_state": "dirty", "mergeable": false}));
    fx.tick(&s, T0 + 40_000);
    s.set("pulls", 200, "\"p2\"", json!([{"number": 7, "state": "closed", "merged_at": "2026-10-08T00:00:00Z", "base": {"ref": "main"}}]));
    fx.tick(&s, T0 + 80_000);
    let mut kinds = edge_kinds(&fx);
    kinds.sort();
    assert_eq!(kinds, ["changes_requested", "conflict", "pr_merged"]);
    let v = status_json(&fx.cfg, T0 + 90_000);
    assert_eq!(v["repos"][0]["status"]["pr"], "merged");
}

#[test]
fn required_checks_come_from_the_branch_rules_and_are_reported_missing() {
    let fx = Fx::new("required");
    fx.repo("r1", Some(ACME));
    let s = Stub::new();
    open_pr(&s);
    s.set(
        "rules",
        200,
        "\"r\"",
        json!([{"type": "required_status_checks", "parameters": {"required_status_checks": [{"context": "build"}, {"context": "e2e"}]}}]),
    );
    fx.tick(&s, T0 + 1000);
    let st = fx.repo_state("r1").status;
    assert_eq!((st["required"].clone(), st["required_missing"].clone()), (json!(["build", "e2e"]), json!(["e2e"])));
    assert!(s.log.borrow().iter().any(|(p, _)| p.ends_with("/rules/branches/main")), "the rules of the base branch");
}

#[test]
fn the_statusline_segment_shows_the_repo_of_the_directory_and_goes_quiet_when_stale() {
    let fx = Fx::new("segment");
    let r = fx.repo("r1", Some(ACME));
    let s = Stub::new();
    open_pr(&s);
    s.set("reviews", 200, "\"v2\"", json!([{"user": {"login": "x"}, "state": "APPROVED"}]));
    fx.tick(&s, T0 + 1000);
    let sub = r.join("src");
    std::fs::create_dir_all(&sub).unwrap();
    assert_eq!(segment(&fx.cfg, &sub.to_string_lossy(), T0 + 2000), "CI running PR #7 approved");
    assert_eq!(segment(&fx.cfg, "/elsewhere", T0 + 2000), "", "a directory outside every followed repo");
    assert_eq!(segment(&fx.cfg, &sub.to_string_lossy(), T0 + 1000 + fx.cfg.int("github_rt.stale_ms") + 1), "", "old data is not shown");
}

#[test]
fn shipped_defaults_are_inside_their_own_bounds() {
    let c = Cfg::shipped();
    assert!(c.int("github_rt.budget_pct") <= 90 && c.int("github_rt.budget_pct") >= 1);
    assert!(c.int("github_rt.poll_running_ms") < c.int("github_rt.poll_idle_ms") && c.int("github_rt.poll_idle_ms") < c.int("github_rt.poll_nopr_ms"));
    assert!(c.strs("github_rt.notify_kinds").is_empty(), "owner notifications are opt-in");
    assert!(c.flag("github_rt.enabled"));
}

// ---- the real command runner against a shell stub `gh` -----------------------------------------------------------

fn runner_in(dir: &Path) -> GhRunner {
    let stub = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/stub-gh");
    let argv = json!(["sh", stub.to_string_lossy(), dir.to_string_lossy(), "api", "-i"]);
    GhRunner::new(&Cfg::shipped().with_field("github_rt.gh", "argv", argv))
}

#[test]
fn the_command_runner_reads_the_status_line_whatever_the_exit_code() {
    let fx = Fx::new("shell");
    let d = fx.dir.join("scenario");
    std::fs::create_dir_all(&d).unwrap();
    let put = |ep: &str, text: &str| std::fs::write(d.join(ep.replace(['/', '?', '&', '=', ':'], "_")), text).unwrap();
    put("repos/a/b/ok", "HTTP/2.0 200 OK\r\nEtag: W/\"e1\"\r\nX-Ratelimit-Used: 5\r\n\r\n{\"n\":1}");
    put("repos/a/b/same", "HTTP/2.0 304 Not Modified\r\nEtag: \"e1\"\r\nX-Ratelimit-Used: 5\r\n\r\n");
    put("repos/a/b/slow", "HTTP/2.0 429 Too Many Requests\r\nRetry-After: 30\r\n\r\n{\"message\":\"slow down\"}");
    let r = runner_in(&d);
    let ok = r.call("repos/a/b/ok", None).unwrap();
    assert_eq!((ok.status, ok.json()["n"].as_u64(), ok.headers["etag"].as_str()), (200, Some(1), "W/\"e1\""));
    let same = r.call("repos/a/b/same", Some("W/\"e1\"")).unwrap();
    assert_eq!((same.status, same.body.as_str()), (304, ""), "a 304 exits 1 and is still an answer");
    let slow = r.call("repos/a/b/slow", None).unwrap();
    assert_eq!((slow.status, slow.headers["retry-after"].as_str()), (429, "30"));
    match r.call("repos/a/b/none", None) {
        Err(Fail::NoResponse(t)) => assert!(t.contains("gh auth login"), "{t}"),
        other => panic!("{other:?}"),
    }
    let log = std::fs::read_to_string(d.join("calls.log")).unwrap();
    assert!(log.contains("If-None-Match: W/\"e1\"") && log.contains("Accept: application/vnd.github+json"), "{log}");
    let missing = GhRunner::new(&Cfg::shipped().with_field("github_rt.gh", "argv", json!(["/nonexistent/gh-for-ghrt-test", "api", "-i"])));
    assert_eq!(missing.call("repos/a/b/ok", None), Err(Fail::Missing));
}

#[test]
fn a_whole_tick_through_the_shell_stub_ends_in_an_edge() {
    let fx = Fx::new("shelltick");
    fx.repo("r1", Some(ACME));
    let d = fx.dir.join("scenario");
    std::fs::create_dir_all(&d).unwrap();
    let sha = String::from_utf8(Command::new("git").arg("-C").arg(fx.dir.join("r1")).args(["rev-parse", "HEAD"]).output().unwrap().stdout).unwrap();
    let put = |ep: &str, etag: &str, body: &str| {
        std::fs::write(d.join(ep.replace(['/', '?', '&', '=', ':'], "_")), format!("HTTP/2.0 200 OK\r\nEtag: {etag}\r\nX-Ratelimit-Limit: 5000\r\nX-Ratelimit-Remaining: 4000\r\nX-Ratelimit-Used: 1000\r\nX-Ratelimit-Reset: 4000000000\r\n\r\n{body}")).unwrap()
    };
    put("repos/acme/widgets/pulls?state=all&sort=updated&direction=desc&per_page=5&head=acme:main", "\"p\"", "[]");
    let checks = format!("repos/acme/widgets/commits/{}/check-runs?per_page=100", sha.trim());
    let runs = format!("repos/acme/widgets/actions/runs?head_sha={}&per_page=30", sha.trim());
    put(&checks, "\"c1\"", r#"{"check_runs":[{"name":"b","status":"in_progress","conclusion":null}]}"#);
    put(&runs, "\"w\"", r#"{"workflow_runs":[]}"#);
    let stub = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/stub-gh");
    let cfg = Cfg::shipped().in_dir(&fx.dir.join("state")).with_field(
        "github_rt.gh",
        "argv",
        json!(["sh", stub.to_string_lossy(), d.to_string_lossy(), "api", "-i"]),
    );
    let run = GhRunner::new(&cfg);
    assert_eq!(poll::tick(&cfg, &run, T0 + 1000, false).polled, 1);
    put(&checks, "\"c2\"", r#"{"check_runs":[{"name":"b","status":"completed","conclusion":"failure"}]}"#);
    let rep = poll::tick(&cfg, &run, T0 + 40_000, false);
    assert_eq!(rep.edges, 1);
    assert_eq!(poll::edges(&cfg)[0]["kind"], "ci_red");
    assert_eq!(poll::load(&cfg).rate.limit, 5000);
}

#[test]
fn an_owner_notification_runs_only_for_a_listed_kind_with_shell_metacharacters_removed() {
    let fx = Fx::new("notify");
    fx.repo("r1", Some(ACME));
    let s = Stub::new();
    open_pr(&s);
    let out = fx.dir.join("notified.txt");
    let argv = json!(["sh", "-c", format!("echo \"{{title}}|{{text}}\" >> {}", out.display())]);
    let cfg = Cfg::shipped().in_dir(&fx.dir.join("state")).with("github_rt.notify_kinds", json!(["ci_red"])).with("github_rt.notify_argv", argv);
    poll::tick(&cfg, &s, T0 + 1000, false);
    s.set("checks", 200, "\"c2\"", json!({"check_runs": [{"name": "te$(st);x", "status": "completed", "conclusion": "failure"}]}));
    poll::tick(&cfg, &s, T0 + 40_000, false);
    let text = std::fs::read_to_string(&out).unwrap();
    assert!(text.starts_with("anti-hall|CI failed on acme/widgets@main") && !text.contains('$') && !text.contains(';'), "{text}");
    s.set("pulls", 200, "\"p2\"", json!([{"number": 7, "state": "closed", "merged_at": "x", "base": {"ref": "main"}}]));
    poll::tick(&cfg, &s, T0 + 80_000, false);
    assert_eq!(std::fs::read_to_string(&out).unwrap().lines().count(), 1, "pr_merged is not in notify_kinds");
}

// ---- the advisory (plugin script gh-rt-advisory.js) ---------------------------------------------------------------

fn edge(seq: u64, kind: &str, root: &str, advisory: bool, ts: u64, text: &str) -> Value {
    json!({"seq": seq, "ts": ts, "kind": kind, "root": root, "text": text, "advisory": advisory})
}

fn write_edges(home: &Path, edges: &[Value]) {
    let d = home.join(".anti-hall/ah-engine/ghrt");
    std::fs::create_dir_all(&d).unwrap();
    std::fs::write(d.join("edges.json"), json!({"edges": edges}).to_string()).unwrap();
}

fn advise(home: &Path, sid: &str, cwd: &str) -> crate::checks::Verdict {
    let env = crate::reqenv::RequestEnv::from_pairs(vec![("HOME".to_string(), home.to_string_lossy().into_owned())]);
    let payload = json!({"hook_event_name": "UserPromptSubmit", "session_id": sid, "cwd": cwd, "prompt": "hi"});
    crate::script::run_forced("gh-rt-advisory", &payload, &Value::Null, "UserPromptSubmit", &env).expect("the shipped script").expect("a verdict")
}

fn text_of(v: &crate::checks::Verdict) -> String {
    match v {
        crate::checks::Verdict::Advisory(t) => {
            serde_json::from_str::<Value>(t).unwrap()["hookSpecificOutput"]["additionalContext"].as_str().unwrap().to_string()
        }
        other => format!("{other:?}"),
    }
}

#[test]
fn an_edge_is_told_to_each_session_once_and_only_for_its_repo() {
    use crate::checks::Verdict::Allow;
    let fx = Fx::new("advice");
    let far = 9_999_999_999_999;
    write_edges(&fx.dir, &[edge(1, "ci_red", "/work/r1", true, far, "CI failed on acme/widgets@main (abc1234): test")]);
    let first = advise(&fx.dir, "s1", "/work/r1/src");
    let t = text_of(&first);
    assert!(t.starts_with("GitHub:\nCI failed on acme/widgets@main"), "{t}");
    assert_eq!(advise(&fx.dir, "s1", "/work/r1/src"), Allow, "the same session is not told twice");
    assert!(text_of(&advise(&fx.dir, "s2", "/work/r1")).contains("CI failed"), "another session in the same repo is told");
    assert_eq!(advise(&fx.dir, "s3", "/work/other"), Allow, "a session in another repo is not");
    assert_eq!(advise(&fx.dir, "s4", "/work/r10"), Allow, "a sibling directory with the same prefix is not the repo");
    assert!(text_of(&advise(&fx.dir, "s3", "/work/r1")).contains("CI failed"), "its cursor did not move while it was elsewhere");
    write_edges(
        &fx.dir,
        &[edge(1, "ci_red", "/work/r1", true, far, "old"), edge(2, "ci_green", "/work/r1", true, far, "CI passed on acme/widgets@main (abc1234)")],
    );
    let t = text_of(&advise(&fx.dir, "s1", "/work/r1"));
    assert!(t.contains("CI passed") && !t.contains("old"), "only what is new: {t}");
}

#[test]
fn old_and_unlisted_edges_are_not_told_and_the_count_per_prompt_is_capped() {
    use crate::checks::Verdict::Allow;
    let fx = Fx::new("advice2");
    let far = 9_999_999_999_999;
    write_edges(&fx.dir, &[edge(1, "ci_red", "/r", true, 1, "too old"), edge(2, "approved", "/r", false, far, "not an advisory kind")]);
    assert_eq!(advise(&fx.dir, "s1", "/r"), Allow);
    let many: Vec<Value> = (3..=8).map(|i| edge(i, "ci_red", "/r", true, far, &format!("edge {i}"))).collect();
    write_edges(&fx.dir, &many);
    let t = text_of(&advise(&fx.dir, "s1", "/r"));
    assert_eq!(
        t.lines().skip(1).collect::<Vec<_>>(),
        ["edge 6", "edge 7", "edge 8"],
        "the newest {} only: {t}",
        fx.cfg.int("github_rt.advisory_max_per_prompt")
    );
    assert_eq!(advise(&fx.dir, "s1", "/r"), Allow);
}

#[test]
fn a_missing_corrupt_or_unwritable_state_says_nothing() {
    use crate::checks::Verdict::Allow;
    let fx = Fx::new("advice3");
    assert_eq!(advise(&fx.dir, "s1", "/r"), Allow, "no edge file");
    let d = fx.dir.join(".anti-hall/ah-engine/ghrt");
    std::fs::create_dir_all(&d).unwrap();
    std::fs::write(d.join("edges.json"), "{not json").unwrap();
    assert_eq!(advise(&fx.dir, "s1", "/r"), Allow, "corrupt");
    write_edges(&fx.dir, &[edge(1, "ci_red", "/r", true, 9_999_999_999_999, "x")]);
    std::fs::write(d.join("cursor"), "a file where the cursor directory should be").unwrap();
    assert_eq!(advise(&fx.dir, "s1", "/r"), Allow, "a cursor that cannot be written means no advisory, never a repeat at every prompt");
}
