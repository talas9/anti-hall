//! The polling tick: which repos are due, the conditional calls, the rate budget and backoff, the edges.
//!
//! One tick is one short process (the scheduled `gh_poll` job): it loads the state file, notices pushes by stat, polls the
//! repos that are due while the budget and the holds allow, writes the state and the edge file, and exits. Everything it
//! learns is in the state file, so the next tick, `ah-engine gh status` and the statusline segment need no network.
use super::api::{Fail, Resp, Runner};
use super::cfg::Cfg;
use super::{parse, repos};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::path::Path;

/// The last rate-limit headers seen.
#[derive(Serialize, Deserialize, Default, Clone, Debug)]
#[serde(default)]
pub struct Rate {
    /// The hourly limit, 0 until a response reported it.
    pub limit: u64,
    /// Requests left in the window.
    pub remaining: u64,
    /// Requests used in the window, as GitHub counts them.
    pub used: u64,
    /// When the window resets (epoch ms).
    pub reset_ms: u64,
    /// When this was read.
    pub seen_ms: u64,
    /// The largest `X-Poll-Interval` seen, in ms (a floor on the cadence).
    pub poll_interval_ms: u64,
}

/// What answers cost: by kind of answer (`s200`, `s304`, `other`), the count, the summed `used` delta, and how many were free.
#[derive(Serialize, Deserialize, Default, Clone, Debug)]
#[serde(default)]
pub struct Cost {
    /// Answers measured.
    pub n: u64,
    /// The sum of the `X-Ratelimit-Used` increase from the call before.
    pub sum: u64,
    /// Answers after which the counter had not moved.
    pub zero: u64,
    /// The largest single increase.
    pub max: u64,
}

/// A cached answer: its ETag and the summary it parsed to (kept, so a 304 needs no body).
#[derive(Serialize, Deserialize, Default, Clone, Debug)]
#[serde(default)]
pub struct Cached {
    /// The ETag as the server sent it.
    pub etag: String,
    /// The parsed summary.
    pub val: Value,
    /// When it was last used (epoch ms), for the cap.
    pub used_ms: u64,
}

/// The state of one followed repo.
#[derive(Serialize, Deserialize, Default, Clone, Debug)]
#[serde(default)]
pub struct Repo {
    /// The repo root.
    pub root: String,
    /// `owner/repo`, empty when the remote is not on GitHub.
    pub slug: String,
    /// `github`, `not_github` or `no_remote`.
    pub kind: String,
    /// The current branch, or the detached word.
    pub branch: String,
    /// The head commit.
    pub sha: String,
    /// The git dir.
    pub gitdir: String,
    /// The common git dir.
    pub commondir: String,
    /// Signature of HEAD and the branch ref.
    pub sig_local: String,
    /// Signature of the remote-tracking ref and packed-refs.
    pub sig_remote: String,
    /// When a push or a checkout was last noticed.
    pub pushed_ms: u64,
    /// The next time the repo is polled.
    pub next_poll_ms: u64,
    /// The last complete poll.
    pub last_poll_ms: u64,
    /// The repo is left alone until then (no access, no such repo).
    pub err_until_ms: u64,
    /// The HTTP status that put it there.
    pub err_status: u64,
    /// The pull request summary, `Null` when none.
    pub pr: Value,
    /// Its mergeability.
    pub detail: Value,
    /// `none`, `approved` or `changes_requested`.
    pub review: String,
    /// The check runs of `sha`.
    pub checks: Value,
    /// The workflow runs of `sha`.
    pub runs: Value,
    /// The required check contexts of the base branch.
    pub required: Vec<String>,
    /// When the rules were last read.
    pub rules_ms: u64,
    /// The status derived at the last complete poll; edges compare against it.
    pub status: Value,
    /// A complete poll of this branch has happened (edges need a baseline).
    pub known: bool,
}

/// Everything GitHub realtime remembers between ticks.
#[derive(Serialize, Deserialize, Default, Clone, Debug)]
#[serde(default)]
pub struct State {
    /// `ok`, `missing`, `logged_out`, `offline` or `disabled`.
    pub gh: String,
    /// No call is made before this time.
    pub hold_until_ms: u64,
    /// Why: `backoff`, `budget`, `logged_out`, `offline`, `missing`.
    pub hold_reason: String,
    /// Consecutive backoffs (the next wait doubles with it).
    pub backoff_n: u32,
    /// The last failure, for `gh status` only (never printed elsewhere).
    pub last_error: String,
    /// The last rate-limit headers.
    pub rate: Rate,
    /// The start of the budget window.
    pub window_start_ms: u64,
    /// Calls counted in the window.
    pub window_calls: u64,
    /// Calls made since the state was first written.
    pub calls_total: u64,
    /// What each kind of answer cost.
    pub measure: BTreeMap<String, Cost>,
    /// ETags and their summaries, by API path.
    pub etags: BTreeMap<String, Cached>,
    /// The followed repos, by root.
    pub repos: BTreeMap<String, Repo>,
    /// Directory to repo root (and when it was resolved); an empty root means not in a repo.
    pub cwd_root: BTreeMap<String, (String, u64)>,
    /// Edge key to the time it was recorded, for the cooldown.
    pub edge_seen: BTreeMap<String, u64>,
    /// The next edge number.
    pub next_seq: u64,
    /// When the last tick ran.
    pub ticked_ms: u64,
}

/// What one tick did.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Report {
    /// Repos polled.
    pub polled: usize,
    /// API calls made (304s included).
    pub calls: u64,
    /// Edges recorded.
    pub edges: usize,
}

/// Read the state file; an absent or unreadable one is an empty state.
pub fn load(cfg: &Cfg) -> State {
    std::fs::read_to_string(repos::file(cfg, "state")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

fn save(cfg: &Cfg, st: &State) {
    let dir = repos::dir(cfg);
    if let Err(e) = std::fs::create_dir_all(&dir) {
        crate::discard::note("ghrt_state_dir", &e.to_string());
        return;
    }
    match serde_json::to_string(st) {
        Ok(t) => crate::discard::logged("ghrt_state_write", crate::atomic::write(repos::file(cfg, "state"), t)),
        Err(e) => crate::discard::note("ghrt_state_encode", &e.to_string()),
    }
}

struct Ctx<'a> {
    cfg: &'a Cfg,
    run: &'a dyn Runner,
    now: u64,
}

/// A fetch's outcome: a summary (fresh or from the cache), or the pass must stop.
enum Got {
    Val(Value),
    Stop,
}

fn clean(s: &str) -> String {
    s.chars().filter(|c| !matches!(c, '"' | '\'' | '$' | '`' | '\\' | ';' | '&' | '|' | '<' | '>' | '(' | ')' | '{' | '}' | '\n' | '\r')).collect()
}

fn short(sha: &str) -> &str {
    sha.get(..7).unwrap_or(sha)
}

impl Ctx<'_> {
    fn hold(&self, st: &mut State, until: u64, reason: &str) {
        if until > st.hold_until_ms || st.hold_reason.is_empty() {
            st.hold_until_ms = until;
            st.hold_reason = reason.to_string();
        }
    }

    /// The budget: calls in the window against the share of the hourly limit, and the remaining count the API reports.
    fn allow(&self, st: &mut State) -> bool {
        let (cfg, now) = (self.cfg, self.now);
        let window = cfg.int("github_rt.window_ms");
        if now.saturating_sub(st.window_start_ms) >= window {
            st.window_start_ms = now;
            st.window_calls = 0;
        }
        let limit = if st.rate.limit > 0 { st.rate.limit } else { cfg.int("github_rt.assumed_limit") };
        let cap = (limit * cfg.int("github_rt.budget_pct") / 100).max(1);
        if st.window_calls >= cap {
            self.hold(st, st.window_start_ms + window, "budget");
            return false;
        }
        if st.rate.seen_ms > 0 && st.rate.remaining < cfg.int("github_rt.min_remaining") && now < st.rate.reset_ms {
            self.hold(st, st.rate.reset_ms, "budget");
            return false;
        }
        true
    }

    fn note_rate(&self, st: &mut State, r: &Resp, prev_used: &mut Option<(u64, u64)>) {
        let cfg = self.cfg;
        let (limit, remaining, used, reset) = (r.num_header(cfg, "limit"), r.num_header(cfg, "remaining"), r.num_header(cfg, "used"), r.num_header(cfg, "reset"));
        if let (Some(l), Some(rem)) = (limit, remaining) {
            st.rate.limit = l;
            st.rate.remaining = rem;
            st.rate.seen_ms = self.now;
        }
        if let Some(u) = used {
            st.rate.used = u;
        }
        if let Some(s) = reset {
            st.rate.reset_ms = s * 1000;
        }
        if let Some(p) = r.num_header(cfg, "poll_interval") {
            st.rate.poll_interval_ms = p * 1000;
        }
        // cost of this answer: the increase of the used counter since the call before it in the same tick and window
        if let (Some(u), Some(reset)) = (used, reset) {
            if let Some((pu, pr)) = *prev_used
                && pr == reset
                && u >= pu
            {
                let class = match r.status {
                    200 => "s200",
                    304 => "s304",
                    _ => "other",
                };
                let c = st.measure.entry(class.to_string()).or_default();
                c.n += 1;
                c.sum += u - pu;
                c.zero += u64::from(u == pu);
                c.max = c.max.max(u - pu);
            }
            *prev_used = Some((u, reset));
        }
    }

    /// A 403/429/5xx: set the hold. Returns true when it was a rate limit or a server fault (the pass stops).
    fn rate_limited(&self, st: &mut State, r: &Resp) -> bool {
        let cfg = self.cfg;
        let body = r.body.to_ascii_lowercase();
        let secondary = cfg.list_field("github_rt.patterns", "secondary").iter().any(|p| body.contains(&p.to_ascii_lowercase()));
        let retry = r.num_header(cfg, "retry_after");
        let max = cfg.int("github_rt.backoff_max_ms");
        let backoff = |st: &State| (cfg.int("github_rt.backoff_ms") << st.backoff_n.min(20)).min(max);
        if r.status == 429 || r.status >= 500 || secondary || retry.is_some() {
            let wait = retry.map_or_else(|| backoff(st), |s| (s * 1000).min(max));
            st.backoff_n = st.backoff_n.saturating_add(1);
            self.hold(st, self.now + wait, "backoff");
            return true;
        }
        if r.status == 403 && r.num_header(cfg, "remaining") == Some(0) {
            let until = st.rate.reset_ms.max(self.now + cfg.int("github_rt.backoff_ms"));
            self.hold(st, until, "budget");
            return true;
        }
        false
    }

    fn failed(&self, st: &mut State, f: &Fail) {
        let cfg = self.cfg;
        let (kind, wait) = match f {
            Fail::Missing => ("missing", cfg.int("github_rt.auth_retry_ms")),
            Fail::Timeout => ("offline", cfg.int("github_rt.offline_retry_ms")),
            Fail::NoResponse(text) => {
                let t = text.to_ascii_lowercase();
                let any = |k: &str| cfg.list_field("github_rt.patterns", k).iter().any(|p| t.contains(&p.to_ascii_lowercase()));
                if any("unauth") {
                    ("logged_out", cfg.int("github_rt.auth_retry_ms"))
                } else {
                    ("offline", cfg.int("github_rt.offline_retry_ms"))
                }
            }
        };
        st.gh = kind.to_string();
        st.last_error = match f {
            Fail::NoResponse(t) => t.lines().next().unwrap_or("").chars().take(200).collect(),
            _ => kind.to_string(),
        };
        self.hold(st, self.now + wait, kind);
    }

    /// One conditional GET. `soft`: a 403/404 means "not available" (an empty summary), not an error of the repo.
    fn fetch(&self, st: &mut State, repo: &mut Repo, path: &str, soft: bool, prev_used: &mut Option<(u64, u64)>, parse: &dyn Fn(&Value) -> Value) -> Got {
        if !self.allow(st) {
            return Got::Stop;
        }
        let etag = st.etags.get(path).map(|c| c.etag.clone());
        let r = match self.run.call(path, etag.as_deref()) {
            Ok(r) => r,
            Err(f) => {
                self.failed(st, &f);
                return Got::Stop;
            }
        };
        st.gh = String::from("ok");
        st.last_error.clear();
        st.calls_total += 1;
        if r.status != 304 || self.cfg.int("github_rt.count_304") == 1 {
            st.window_calls += 1;
        }
        self.note_rate(st, &r, prev_used);
        match r.status {
            200..=299 => {
                st.backoff_n = 0;
                let val = parse(&r.json());
                let tag = r.headers.get(&self.cfg.txt("github_rt.headers", "etag")).cloned().unwrap_or_default();
                if tag.is_empty() {
                    st.etags.remove(path);
                } else {
                    st.etags.insert(path.to_string(), Cached { etag: tag, val: val.clone(), used_ms: self.now });
                }
                Got::Val(val)
            }
            304 => {
                st.backoff_n = 0;
                match st.etags.get_mut(path) {
                    Some(c) => {
                        c.used_ms = self.now;
                        Got::Val(c.val.clone())
                    }
                    None => Got::Stop, // a 304 for an ETag we no longer hold: nothing sent, so nothing can have matched
                }
            }
            401 => {
                self.failed(st, &Fail::NoResponse(self.cfg.list_field("github_rt.patterns", "unauth").first().cloned().unwrap_or_default()));
                Got::Stop
            }
            _ if self.rate_limited(st, &r) => Got::Stop,
            403 | 404 if soft => Got::Val(Value::Null),
            code => {
                repo.err_status = u64::from(code);
                repo.err_until_ms = self.now + self.cfg.int("github_rt.poll_error_ms");
                Got::Stop
            }
        }
    }

    fn path(&self, key: &str, repo: &Repo, extra: &[(&str, &str)]) -> String {
        let (owner, name) = repo.slug.split_once('/').unwrap_or(("", ""));
        let mut p = self.cfg.txt("github_rt.endpoints", key).replace("{owner}", owner).replace("{repo}", name).replace("{branch}", &repo.branch).replace("{sha}", &repo.sha);
        for (k, v) in extra {
            p = p.replace(&format!("{{{k}}}"), v);
        }
        p
    }

    /// One pass over a repo. Returns false when it stopped early (a hold or an error), in which case nothing is compared.
    fn poll_repo(&self, st: &mut State, repo: &mut Repo, prev_used: &mut Option<(u64, u64)>) -> bool {
        let cfg = self.cfg;
        let detached = repo.branch == cfg.txt("github_rt.git", "detached_word") || repo.branch.is_empty();
        if !detached {
            let p = self.path("pulls", repo, &[]);
            let Got::Val(pr) = self.fetch(st, repo, &p, false, prev_used, &|b| parse::pulls(b)) else { return false };
            repo.pr = pr;
        } else {
            repo.pr = Value::Null;
        }
        let open = repo.pr.get("state").and_then(Value::as_str) == Some("open");
        let number = repo.pr.get("number").and_then(Value::as_u64).unwrap_or(0).to_string();
        if open {
            let p = self.path("pull", repo, &[("number", &number)]);
            let Got::Val(d) = self.fetch(st, repo, &p, false, prev_used, &|b| parse::pull(b)) else { return false };
            repo.detail = d;
            let p = self.path("reviews", repo, &[("number", &number)]);
            let Got::Val(rv) = self.fetch(st, repo, &p, false, prev_used, &|b| json!(parse::reviews(cfg, b))) else { return false };
            repo.review = rv.as_str().unwrap_or("none").to_string();
            if self.now.saturating_sub(repo.rules_ms) >= cfg.int("github_rt.rules_ms") || repo.rules_ms == 0 {
                let base = repo.pr.get("base").and_then(Value::as_str).unwrap_or("").to_string();
                let p = self.path("rules", repo, &[("base", &base)]);
                let Got::Val(rq) = self.fetch(st, repo, &p, true, prev_used, &|b| parse::rules(b)) else { return false };
                repo.required = rq.as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
                repo.rules_ms = self.now;
            }
        } else {
            repo.detail = Value::Null;
            repo.review = String::from("none");
            repo.required.clear();
            repo.rules_ms = 0;
        }
        if repo.sha.is_empty() {
            return true;
        }
        let sha = repo.sha.clone();
        let p = self.path("checks", repo, &[]);
        let Got::Val(ck) = self.fetch(st, repo, &p, true, prev_used, &|b| parse::runs(cfg, b, "check_runs", &sha)) else { return false };
        repo.checks = ck;
        let p = self.path("runs", repo, &[]);
        let sha = repo.sha.clone();
        let Got::Val(wf) = self.fetch(st, repo, &p, true, prev_used, &|b| parse::runs(cfg, b, "workflow_runs", &sha)) else { return false };
        repo.runs = wf;
        true
    }

    fn cadence(&self, st: &State, status: &Value) -> u64 {
        let cfg = self.cfg;
        let still_running = status["running"].as_u64().unwrap_or(0) > 0;
        let base = match (status["checks"].as_str().unwrap_or(""), status["pr"].as_str().unwrap_or("")) {
            ("running", _) => "poll_running_ms",
            _ if still_running => "poll_running_ms",
            (_, "open") => "poll_idle_ms",
            (_, "none") => "poll_nopr_ms",
            _ => "poll_done_ms",
        };
        cfg.int(&format!("github_rt.{base}")).max(st.rate.poll_interval_ms)
    }
}

fn edge_text(cfg: &Cfg, kind: &str, repo: &Repo, status: &Value) -> (String, Vec<String>) {
    let jobs: Vec<String> = status["jobs"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
    let list = if jobs.is_empty() { cfg.word("no_jobs", &[]) } else { jobs.iter().take(5).cloned().collect::<Vec<_>>().join(&cfg.txt("github_rt.words", "job_sep")) };
    let number = status["number"].as_u64().unwrap_or(0).to_string();
    let text = cfg.word(kind, &[("slug", &repo.slug), ("branch", &repo.branch), ("number", &number), ("sha", short(&repo.sha)), ("jobs", &list)]);
    (text, jobs)
}

fn read_edges(cfg: &Cfg) -> Vec<Value> {
    std::fs::read_to_string(repos::file(cfg, "edges")).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| v.get("edges").and_then(Value::as_array).cloned()).unwrap_or_default()
}

/// The edges recorded so far, oldest first.
pub fn edges(cfg: &Cfg) -> Vec<Value> {
    read_edges(cfg)
}

fn write_edges(cfg: &Cfg, all: &[Value]) {
    let dir = repos::dir(cfg);
    if let Err(e) = std::fs::create_dir_all(&dir) {
        crate::discard::note("ghrt_edges_dir", &e.to_string());
        return;
    }
    crate::discard::logged("ghrt_edges_write", crate::atomic::write(repos::file(cfg, "edges"), json!({"edges": all}).to_string()));
}

fn notify(cfg: &Cfg, kind: &str, text: &str) {
    let argv = cfg.strs("github_rt.notify_argv");
    if argv.is_empty() || !cfg.strs("github_rt.notify_kinds").iter().any(|k| k == kind) {
        return;
    }
    let title = clean(&cfg.word("title", &[]));
    let text = clean(text);
    let fill = |a: &String| a.replace("{title}", &title).replace("{text}", &text);
    let Some((prog, rest)) = argv.split_first() else { return };
    let mut cmd = std::process::Command::new(prog);
    cmd.args(rest.iter().map(fill));
    let poll = crate::defaults::millis("client.fallback_poll_ms");
    crate::discard::logged("ghrt_notify", crate::proc::run(cmd, "notify", std::time::Duration::from_millis(cfg.int("github_rt.call_timeout_ms")), poll).map_err(crate::proc::Error::into_io));
}

/// Resolve the recent directories into followed repos, creating and dropping records.
fn refresh_repos(cfg: &Cfg, st: &mut State, now: u64) {
    let mut roots: Vec<String> = Vec::new();
    let recent = repos::recent(cfg, now);
    let resolve_again = cfg.int("github_rt.poll_done_ms");
    for (cwd, _) in &recent {
        let cached = st.cwd_root.get(cwd).filter(|(root, at)| !root.is_empty() || now.saturating_sub(*at) < resolve_again).cloned();
        let root = match cached {
            Some((r, _)) => r,
            None => {
                let r = repos::git(cfg, "toplevel", cwd).unwrap_or_default();
                st.cwd_root.insert(cwd.clone(), (r.clone(), now));
                r
            }
        };
        if !root.is_empty() && !roots.contains(&root) {
            roots.push(root);
        }
        if roots.len() >= cfg.int("github_rt.max_repos") as usize {
            break;
        }
    }
    let live: Vec<&String> = recent.iter().map(|(c, _)| c).collect();
    st.cwd_root.retain(|c, _| live.contains(&c));
    st.repos.retain(|r, _| roots.contains(r));
    for root in roots {
        st.repos.entry(root.clone()).or_insert_with(|| Repo { root, next_poll_ms: 0, ..Repo::default() });
    }
}

/// Look at the repo's git files; true when a push or a checkout was noticed.
fn refresh_git(cfg: &Cfg, repo: &mut Repo, now: u64) -> bool {
    let first = repo.gitdir.is_empty();
    if !first {
        let (l, r) = repos::signature(cfg, &repo.gitdir, &repo.commondir, &repo.branch);
        if l == repo.sig_local && r == repo.sig_remote {
            return false;
        }
    }
    let Some(info) = repos::info(cfg, &repo.root) else {
        repo.kind = String::from("no_remote");
        return false;
    };
    let branch_changed = info.branch != repo.branch;
    let url = repos::git(cfg, "remote", &repo.root).unwrap_or_default();
    match repos::slug_of(cfg, &url) {
        Some((o, r)) => {
            repo.slug = format!("{o}/{r}");
            repo.kind = String::from("github");
        }
        None => {
            repo.slug.clear();
            repo.kind = String::from(if url.is_empty() { "no_remote" } else { "not_github" });
        }
    }
    let (l, r) = repos::signature(cfg, &info.gitdir, &info.commondir, &info.branch);
    let remote_changed = !first && r != repo.sig_remote;
    if branch_changed {
        for f in [&mut repo.pr, &mut repo.detail, &mut repo.checks, &mut repo.runs, &mut repo.status] {
            *f = Value::Null;
        }
        repo.review = String::from("none");
        repo.required.clear();
        repo.rules_ms = 0;
        repo.known = false;
    }
    repo.branch = info.branch;
    repo.sha = info.sha;
    repo.gitdir = info.gitdir;
    repo.commondir = info.commondir;
    repo.sig_local = l;
    repo.sig_remote = r;
    if remote_changed {
        repo.pushed_ms = now;
    }
    let pushed = first || branch_changed || remote_changed;
    if pushed {
        repo.next_poll_ms = now;
        repo.err_until_ms = 0;
    }
    pushed
}

/// One tick. `force` polls every followed repo whatever its cadence (`ah-engine gh poll --force`).
pub fn tick(cfg: &Cfg, run: &dyn Runner, now: u64, force: bool) -> Report {
    let mut st = load(cfg);
    let mut report = Report::default();
    if !cfg.flag("github_rt.enabled") {
        st.gh = String::from("disabled");
        st.ticked_ms = now;
        save(cfg, &st);
        return report;
    }
    if st.gh == "disabled" {
        st.gh = String::from("ok");
    }
    let ctx = Ctx { cfg, run, now };
    refresh_repos(cfg, &mut st, now);
    let mut order: Vec<String> = st.repos.keys().cloned().collect();
    for root in &order {
        if let Some(repo) = st.repos.get_mut(root) {
            refresh_git(cfg, repo, now);
        }
    }
    order.sort_by_key(|r| st.repos.get(r).map_or(0, |x| x.next_poll_ms));
    let calls_before = st.calls_total;
    let mut prev_used: Option<(u64, u64)> = None;
    let mut new_edges: Vec<Value> = Vec::new();
    if now >= st.hold_until_ms {
        st.hold_until_ms = 0;
        st.hold_reason.clear();
    }
    for root in order {
        let Some(mut repo) = st.repos.remove(&root) else { continue };
        let due = force || now >= repo.next_poll_ms;
        let blocked = repo.err_until_ms > now;
        if due && !blocked && st.hold_until_ms <= now {
            if repo.kind == "github" {
                if ctx.poll_repo(&mut st, &mut repo, &mut prev_used) {
                    report.polled += 1;
                    let status = parse::status(cfg, &serde_json::to_value(&repo).unwrap_or(Value::Null), now);
                    let prev = repo.known.then(|| repo.status.clone());
                    for e in parse::edges(prev.as_ref(), &status) {
                        let key = format!("{}|{}|{}|{}", e.kind, repo.root, repo.branch, e.subject);
                        let cool = cfg.int("github_rt.edge_cooldown_ms");
                        if st.edge_seen.get(&key).is_some_and(|t| now.saturating_sub(*t) < cool) {
                            continue;
                        }
                        st.edge_seen.insert(key, now);
                        let (text, jobs) = edge_text(cfg, e.kind, &repo, &status);
                        st.next_seq += 1;
                        new_edges.push(json!({"seq": st.next_seq, "ts": now, "kind": e.kind, "root": repo.root, "slug": repo.slug, "branch": repo.branch, "sha": repo.sha, "number": status["number"], "text": text, "jobs": jobs, "advisory": cfg.strs("github_rt.advisory_kinds").iter().any(|k| k == e.kind)}));
                    }
                    repo.next_poll_ms = now + ctx.cadence(&st, &status);
                    repo.last_poll_ms = now;
                    repo.err_status = 0;
                    repo.status = status;
                    repo.known = true;
                }
            } else {
                refresh_remote_kind(cfg, &mut repo, now);
            }
        }
        st.repos.insert(root, repo);
    }
    st.edge_seen.retain(|_, t| now.saturating_sub(*t) < cfg.int("github_rt.edge_cooldown_ms").max(1));
    let cap = cfg.int("github_rt.etag_cap") as usize;
    while st.etags.len() > cap {
        let Some(old) = st.etags.iter().min_by_key(|(_, c)| c.used_ms).map(|(k, _)| k.clone()) else { break };
        st.etags.remove(&old);
    }
    st.ticked_ms = now;
    report.calls = st.calls_total - calls_before;
    report.edges = new_edges.len();
    save(cfg, &st);
    if !new_edges.is_empty() {
        let mut all = read_edges(cfg);
        for e in &new_edges {
            notify(cfg, e["kind"].as_str().unwrap_or(""), e["text"].as_str().unwrap_or(""));
        }
        all.extend(new_edges);
        let keep = cfg.int("github_rt.max_edges") as usize;
        let skip = all.len().saturating_sub(keep);
        write_edges(cfg, &all[skip..]);
    }
    report
}

/// A repo whose remote is not on GitHub, or has none: look at the remote again now and then, never call GitHub for it.
fn refresh_remote_kind(cfg: &Cfg, repo: &mut Repo, now: u64) {
    let url = repos::git(cfg, "remote", &repo.root).unwrap_or_default();
    if let Some((o, r)) = repos::slug_of(cfg, &url) {
        repo.slug = format!("{o}/{r}");
        repo.kind = String::from("github");
        repo.next_poll_ms = now;
    } else {
        repo.next_poll_ms = now + cfg.int("github_rt.poll_done_ms");
    }
}

/// True when `path` lies inside `root`.
pub fn inside(root: &str, path: &str) -> bool {
    let (r, p) = (Path::new(root), Path::new(path));
    p.starts_with(r)
}
