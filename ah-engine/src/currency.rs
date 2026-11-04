//! Engine currency (issue #541): the engine reports when it lags the source checkout it was built from.
//!
//! Report only. [`check`] compares the commit in the engine's build version with the tip of a branch of a git checkout, and the
//! git blob ids of the engine's own defaults and logic files at that tip with the blob ids of the files the running engine reads.
//! Everything it reads from the checkout comes out of git objects (a ref and a tree), never the working tree, and nothing is
//! fetched: the engine has no network code. The scheduler job (`engine_currency`, `engine_currency.toml`) calls [`run_job`]; the
//! daemon's `status` shows [`last`]. The last result lives in memory only. Every limit, list, text and git argument is a
//! defaults entry of `engine_currency.toml`.
use crate::checks::git::util::Settings;
use crate::checks::guardkit::settings as sw;
use crate::defaults;
use crate::reqenv::RequestEnv;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::Instant;

/// One comparison: what was read on each side and the verdict.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Report {
    /// One of the `engine_currency.result_*` labels.
    pub result: &'static str,
    /// Why the comparison could not be made (an `engine_currency.reason_*` text); empty otherwise.
    pub reason: String,
    /// The commit in the engine's build version (empty when it carries none).
    pub live_sha: String,
    /// The commit the branch tip of the checkout points at (empty when unread).
    pub dev_head: String,
    /// A short digest of the live files' (path, blob id) list (empty when unread).
    pub files_live_hash: String,
    /// A short digest of the branch tip's (path, blob id) list (empty when unread).
    pub files_dev_hash: String,
}

impl Report {
    fn unreadable(reason: &str, mut so_far: Report) -> Report {
        so_far.result = defaults::text("engine_currency.result_unreadable");
        so_far.reason = defaults::text(reason).to_string();
        so_far
    }

    /// The `currency` field of `status --json`.
    pub fn to_json(&self, checked_at_ms: u64) -> Value {
        json!({
            "result": self.result,
            "reason": self.reason,
            "live_sha": self.live_sha,
            "dev_head": self.dev_head,
            "files_live_hash": self.files_live_hash,
            "files_dev_hash": self.files_dev_hash,
            "checked_at_ms": checked_at_ms,
        })
    }
}

type Blobs = Vec<(String, String)>;

/// The commit in a build version (`0.2.1+d7e7b094`, `0.2.1+branch.d7e7b094-dirty`), or `None` when it carries none.
pub fn build_sha(version: &str) -> Option<String> {
    let re = regex::Regex::new(defaults::text("engine_currency.sha_re")).ok()?;
    re.captures(version).and_then(|c| c.get(1)).map(|m| m.as_str().to_string())
}

/// Run git with `args` (placeholders already replaced) and return its stdout when it exited 0 in time.
fn git(args: &[String], cwd: &Path) -> Option<String> {
    let mut cmd = Command::new(defaults::text("engine_currency.git_program"));
    cmd.args(args).current_dir(cwd);
    let out = crate::proc::run(
        cmd,
        defaults::text("engine_currency.git_program"),
        defaults::millis("engine_currency.git_timeout_ms"),
        defaults::millis("engine_currency.poll_ms"),
    )
    .ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

/// The arguments of the defaults entry `key`, each with its `{name}` placeholders replaced, then `extra` appended.
fn args_of(key: &str, fill: &[(&str, &str)], extra: &[String]) -> Vec<String> {
    let mut v: Vec<String> =
        defaults::list(key).into_iter().map(|a| fill.iter().fold(a.to_string(), |acc, (name, value)| acc.replace(&format!("{{{name}}}"), value))).collect();
    v.extend(extra.iter().cloned());
    v
}

/// The commit the first resolving ref of `engine_currency.refs` points at.
fn branch_tip(checkout: &Path) -> Option<String> {
    let branch = defaults::text("engine_currency.branch");
    let dir = checkout.to_string_lossy();
    defaults::list("engine_currency.refs").into_iter().find_map(|r| {
        let r = r.replace("{branch}", branch);
        let args = args_of("engine_currency.rev_parse_args", &[("checkout", &dir), ("ref", &r)], &[]);
        git(&args, checkout).map(|o| o.trim().to_string()).filter(|s| !s.is_empty())
    })
}

/// The (path, blob id) list of `engine_currency.hash_paths` at commit `sha`, sorted.
fn tree_blobs(checkout: &Path, sha: &str) -> Option<Blobs> {
    let dir = checkout.to_string_lossy();
    let paths: Vec<String> = defaults::list("engine_currency.hash_paths").into_iter().map(str::to_string).collect();
    let out = git(&args_of("engine_currency.ls_tree_args", &[("checkout", &dir), ("sha", sha)], &paths), checkout)?;
    let mut rows: Blobs = out
        .lines()
        .filter_map(|l| {
            let (meta, path) = l.split_once('\t')?;
            let blob = meta.split_whitespace().nth(2)?;
            Some((path.to_string(), blob.to_string()))
        })
        .collect();
    rows.sort();
    (!rows.is_empty()).then_some(rows)
}

/// Every regular file under `dir` (symbolic links are skipped), as paths relative to `root`, at most `left` more of them.
fn walk(root: &Path, dir: &Path, left: &mut usize, out: &mut Vec<String>) -> Option<()> {
    let skip = defaults::list("engine_currency.skip_names");
    for entry in std::fs::read_dir(dir).ok()? {
        let entry = entry.ok()?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if skip.contains(&name.as_str()) {
            continue;
        }
        let kind = entry.file_type().ok()?;
        if kind.is_dir() {
            walk(root, &entry.path(), left, out)?;
        } else if kind.is_file() {
            *left = left.checked_sub(1)?;
            out.push(entry.path().strip_prefix(root).ok()?.to_string_lossy().replace('\\', "/"));
        }
    }
    Some(())
}

/// The (path, blob id) list of the files of `engine_currency.hash_paths` under the live tree `live`, sorted.
fn live_blobs(checkout: &Path, live: &Path) -> Option<Blobs> {
    let mut left = defaults::num("engine_currency.max_files") as usize;
    let mut rels = Vec::new();
    for p in defaults::list("engine_currency.hash_paths") {
        walk(live, &live.join(p), &mut left, &mut rels)?;
    }
    rels.sort();
    if rels.is_empty() {
        return None;
    }
    let absolute: Vec<String> = rels.iter().map(|r| live.join(r).to_string_lossy().into_owned()).collect();
    let dir = checkout.to_string_lossy();
    let out = git(&args_of("engine_currency.hash_object_args", &[("checkout", &dir)], &absolute), checkout)?;
    let ids: Vec<&str> = out.lines().collect();
    (ids.len() == rels.len()).then(|| rels.into_iter().zip(ids.into_iter().map(str::to_string)).collect())
}

/// The first `engine_currency.hash_chars` characters of the SHA-256 of the list.
fn digest(rows: &Blobs) -> String {
    let text: String = rows.iter().map(|(p, b)| format!("{p}\t{b}\n")).collect();
    let full = crate::dssup::recon::view::sha256_hex(text.as_bytes());
    full.chars().take(defaults::num("engine_currency.hash_chars") as usize).collect()
}

/// Compare the engine whose build version is `build` and whose plugin tree is `live_root` with `checkout`.
pub fn check(checkout: &Path, build: &str, live_root: Option<&Path>) -> Report {
    let mut r = Report {
        result: defaults::text("engine_currency.result_ok"),
        reason: String::new(),
        live_sha: String::new(),
        dev_head: String::new(),
        files_live_hash: String::new(),
        files_dev_hash: String::new(),
    };
    let Some(live_sha) = build_sha(build) else { return Report::unreadable("engine_currency.reason_no_sha", r) };
    r.live_sha = live_sha;
    if !checkout.is_dir() {
        return Report::unreadable("engine_currency.reason_no_checkout", r);
    }
    let Some(dev_head) = branch_tip(checkout) else { return Report::unreadable("engine_currency.reason_no_ref", r) };
    r.dev_head = dev_head;
    let behind = !r.dev_head.starts_with(&r.live_sha);
    let dev = tree_blobs(checkout, &r.dev_head);
    r.files_dev_hash = dev.as_ref().map(digest).unwrap_or_default();
    let Some(live_root) = live_root else {
        return if behind {
            r.result = defaults::text("engine_currency.result_behind");
            r
        } else {
            Report::unreadable("engine_currency.reason_no_root", r)
        };
    };
    let live = live_blobs(checkout, live_root);
    r.files_live_hash = live.as_ref().map(digest).unwrap_or_default();
    if behind {
        r.result = defaults::text("engine_currency.result_behind");
        return r;
    }
    match (dev, live) {
        (None, _) => Report::unreadable("engine_currency.reason_no_tree", r),
        (_, None) => Report::unreadable("engine_currency.reason_no_files", r),
        (Some(d), Some(l)) if d == l => r,
        _ => {
            r.result = defaults::text("engine_currency.result_files_differ");
            r
        }
    }
}

struct Last {
    report: Report,
    at_ms: u64,
}

static LAST: Mutex<Option<Last>> = Mutex::new(None);
/// The key and time of the line last logged, so the same result is logged at most once per `engine_currency.log_interval_ms`.
static LOGGED: Mutex<Option<(String, Instant)>> = Mutex::new(None);

fn set_last(v: Option<Last>) {
    *LAST.lock().unwrap_or_else(|e| e.into_inner()) = v;
}

/// The last result as the `currency` field of `status --json`; `None` before the first check and while the job is off.
pub fn last() -> Option<Value> {
    LAST.lock().unwrap_or_else(|e| e.into_inner()).as_ref().map(|l| l.report.to_json(l.at_ms))
}

fn log_once(r: &Report) {
    let key = format!("{}|{}|{}|{}|{}", r.result, r.live_sha, r.dev_head, r.files_live_hash, r.reason);
    {
        let mut g = LOGGED.lock().unwrap_or_else(|e| e.into_inner());
        let window = defaults::millis("engine_currency.log_interval_ms");
        if g.as_ref().is_some_and(|(k, t)| *k == key && t.elapsed() < window) {
            return;
        }
        *g = Some((key, Instant::now()));
    }
    let files = format!("{}/{}", r.files_live_hash, r.files_dev_hash);
    let fill = [("live", r.live_sha.as_str()), ("dev", r.dev_head.as_str()), ("files", files.as_str()), ("reason", r.reason.as_str())];
    let msg_key = if r.result == defaults::text("engine_currency.result_behind") {
        "engine_currency.msg_behind"
    } else if r.result == defaults::text("engine_currency.result_files_differ") {
        "engine_currency.msg_files_differ"
    } else if r.result == defaults::text("engine_currency.result_unreadable") {
        "engine_currency.msg_unreadable"
    } else {
        return; // ok is counted, not logged
    };
    let detail = fill.iter().fold(defaults::text(msg_key).to_string(), |acc, (name, value)| acc.replace(&format!("{{{name}}}"), value));
    emit(r.result, &detail);
}

#[cfg(not(test))]
fn emit(code: &str, detail: &str) {
    crate::health::log_event(defaults::text("engine_currency.log_kind"), code, detail);
}

#[cfg(test)]
fn emit(code: &str, detail: &str) {
    tests::LINES.lock().unwrap_or_else(|e| e.into_inner()).push((code.to_string(), detail.to_string()));
}

/// The settings view of the job: the home, plus the two switches' environment names when the daemon's own environment sets them.
fn settings_for(home: &str) -> Settings {
    let mut pairs = vec![("HOME".to_string(), home.to_string())];
    for key in ["engine_currency.switch", "engine_currency.source_checkout"] {
        let name = defaults::raw(key).str_field("env");
        if let Some(v) = std::env::var(name).ok().filter(|_| !name.is_empty()) {
            pairs.push((name.to_string(), v));
        }
    }
    Settings::from_env(&RequestEnv::from_pairs(pairs))
}

/// The live tree root: the engine's plugin root (the directory that holds `engine/defaults`) without `engine_currency.live_suffix`.
fn live_tree(defaults_root: Option<PathBuf>) -> Option<PathBuf> {
    let root = defaults_root?;
    let text = root.to_string_lossy().into_owned();
    let stripped = text.trim_end_matches('/').strip_suffix(defaults::text("engine_currency.live_suffix"))?;
    Some(PathBuf::from(stripped.trim_end_matches('/')))
}

/// The scheduled job. `count` is told the result label of every check made. Does nothing (and shows no status field) while the
/// switch is off or no checkout is set; otherwise returns the report as JSON.
pub fn run_job(home: &str, count: &dyn Fn(&str)) -> Result<String, String> {
    let st = settings_for(home);
    let checkout = sw::get_string(&st, defaults::raw("engine_currency.source_checkout"));
    if !sw::get_bool(&st, defaults::raw("engine_currency.switch")) || checkout.is_empty() {
        set_last(None);
        return Ok(String::new());
    }
    let report = check(Path::new(&checkout), crate::build_version(), live_tree(defaults::root()).as_deref());
    count(report.result);
    log_once(&report);
    let at_ms = crate::health::now_ms();
    let body = report.to_json(at_ms).to_string();
    set_last(Some(Last { report, at_ms }));
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(super) static LINES: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());

    fn sh(dir: &Path, args: &[&str]) -> String {
        let o = Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@example.invalid")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@example.invalid")
            .output()
            .expect("git runs");
        assert!(o.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&o.stderr));
        String::from_utf8_lossy(&o.stdout).trim().to_string()
    }

    fn scratch(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ah-currency-{tag}-{}", std::process::id()));
        std::fs::remove_dir_all(&d).ok(); // harmless: the scratch dir of this test process
        std::fs::create_dir_all(&d).expect("scratch dir");
        d
    }

    /// A repository with the two compared directories committed on `dev`, and a live tree holding the same files.
    fn fixture(tag: &str) -> (PathBuf, PathBuf, String) {
        let base = scratch(tag);
        let repo = base.join("repo");
        let live = base.join("live");
        for root in [&repo, &live] {
            for (rel, body) in [("plugins/anti-hall/engine/defaults/a.toml", "a = 1\n"), ("plugins/anti-hall/engine/logic/x.js", "x\n")] {
                let p = root.join(rel);
                std::fs::create_dir_all(p.parent().expect("parent")).expect("dirs");
                std::fs::write(p, body).expect("file");
            }
        }
        sh(&repo, &["init", "-q", "-b", "dev"]);
        sh(&repo, &["add", "-A"]);
        sh(&repo, &["commit", "-q", "-m", "one"]);
        let head = sh(&repo, &["rev-parse", "HEAD"]);
        (repo, live, head)
    }

    fn lines() -> Vec<(String, String)> {
        LINES.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    #[test]
    fn engine_currency_build_sha_takes_the_commit_with_or_without_a_branch_and_dirty_mark() {
        assert_eq!(build_sha("0.2.1+d7e7b094").as_deref(), Some("d7e7b094"));
        assert_eq!(build_sha("0.2.1+engine-proto.d7e7b094-dirty").as_deref(), Some("d7e7b094"));
        assert_eq!(build_sha("0.2.1"), None);
    }

    #[test]
    fn engine_currency_equal_commit_and_files_is_ok() {
        let (repo, live, head) = fixture("ok");
        let r = check(&repo, &format!("0.2.1+{}", head.get(..8).expect("sha")), Some(&live));
        assert_eq!((r.result, r.reason.as_str()), ("ok", ""), "{r:?}");
        assert_eq!(r.dev_head, head);
        assert_eq!(r.files_live_hash, r.files_dev_hash);
        assert!(!r.files_live_hash.is_empty());
    }

    #[test]
    fn engine_currency_an_engine_behind_the_branch_tip_is_behind_and_names_both_commits() {
        let (repo, live, head) = fixture("behind");
        let r = check(&repo, "0.2.1+0123abc", Some(&live));
        assert_eq!(r.result, "behind", "{r:?}");
        assert_eq!((r.live_sha.as_str(), r.dev_head.as_str()), ("0123abc", head.as_str()));
    }

    #[test]
    fn engine_currency_the_remote_tracking_ref_wins_over_a_stale_local_branch() {
        let (repo, live, head) = fixture("refs");
        // a stale local dev branch and a newer origin/dev: the deploy builds from origin/dev
        std::fs::write(repo.join("plugins/anti-hall/engine/logic/x.js"), "y\n").expect("edit");
        sh(&repo, &["commit", "-q", "-am", "two"]);
        let newer = sh(&repo, &["rev-parse", "HEAD"]);
        sh(&repo, &["update-ref", "refs/remotes/origin/dev", &newer]);
        sh(&repo, &["update-ref", "refs/heads/dev", &head]);
        let r = check(&repo, &format!("0.2.1+{}", head.get(..8).expect("sha")), Some(&live));
        assert_eq!((r.result, r.dev_head.as_str()), ("behind", newer.as_str()), "{r:?}");
    }

    #[test]
    fn engine_currency_the_same_commit_with_an_edited_live_file_is_files_differ() {
        let (repo, live, head) = fixture("differ");
        std::fs::write(live.join("plugins/anti-hall/engine/logic/x.js"), "edited\n").expect("edit");
        let r = check(&repo, &format!("0.2.1+{}", head.get(..8).expect("sha")), Some(&live));
        assert_eq!(r.result, "files_differ", "{r:?}");
        assert_ne!(r.files_live_hash, r.files_dev_hash);
    }

    #[test]
    fn engine_currency_a_missing_checkout_ref_or_commit_is_unreadable() {
        let (repo, live, head) = fixture("unread");
        let build = format!("0.2.1+{}", head.get(..8).expect("sha"));
        let gone = repo.join("nowhere");
        assert_eq!(check(&gone, &build, Some(&live)).result, "unreadable");
        assert_eq!(check(&repo, "0.2.1", Some(&live)).reason, defaults::text("engine_currency.reason_no_sha"));
        sh(&repo, &["branch", "-m", "dev", "other"]);
        let r = check(&repo, &build, Some(&live));
        assert_eq!((r.result, r.reason.as_str()), ("unreadable", defaults::text("engine_currency.reason_no_ref")));
        assert_eq!(check(&repo, &build, None).result, "unreadable", "no live root and no difference is not a verdict");
    }

    #[test]
    fn engine_currency_the_live_tree_is_the_plugin_root_without_its_suffix() {
        let root = PathBuf::from("/x/plugins/anti-hall/");
        assert_eq!(live_tree(Some(root)), Some(PathBuf::from("/x")));
        assert_eq!(live_tree(Some(PathBuf::from("/x/engine"))), None);
        assert_eq!(live_tree(None), None);
    }

    #[test]
    fn engine_currency_the_job_is_silent_until_a_checkout_is_set_then_counts_and_logs_once() {
        let (repo, _live, _head) = fixture("job");
        let home = scratch("job-home");
        std::fs::create_dir_all(home.join(".anti-hall")).expect("settings dir");
        let counted = Mutex::new(Vec::<String>::new());
        let count = |r: &str| counted.lock().expect("lock").push(r.to_string());
        // no checkout: nothing checked, nothing counted, no status field
        assert_eq!(run_job(&home.to_string_lossy(), &count), Ok(String::new()));
        assert!(counted.lock().expect("lock").is_empty() && last().is_none());
        // a checkout: the build of this test binary is not the fixture's commit, so the engine is behind
        std::fs::write(home.join(".anti-hall/settings.json"), json!({"diagnostics": {"engineCurrencyCheckout": repo}}).to_string()).expect("settings");
        let before = lines().len();
        let body = run_job(&home.to_string_lossy(), &count).expect("runs");
        let v: Value = serde_json::from_str(&body).expect("json");
        assert!(matches!(v["result"].as_str(), Some("behind" | "unreadable")), "{v}");
        assert_eq!(counted.lock().expect("lock").len(), 1);
        assert_eq!(last().expect("status field")["result"], v["result"]);
        run_job(&home.to_string_lossy(), &count).expect("runs again");
        assert_eq!(lines().len(), before + 1, "the same result is logged once per interval: {:?}", lines());
        // the kill switch: off, nothing is checked and the status field goes
        std::fs::write(home.join(".anti-hall/settings.json"), json!({"diagnostics": {"engineCurrency": false, "engineCurrencyCheckout": repo}}).to_string())
            .expect("settings");
        assert_eq!(run_job(&home.to_string_lossy(), &count), Ok(String::new()));
        assert!(last().is_none());
        assert_eq!(counted.lock().expect("lock").len(), 2);
    }
}
