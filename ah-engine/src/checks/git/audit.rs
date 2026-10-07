//! Built-in `check = "git-audit"`: the PostToolUse `--audit` pass of the Node git-guard.
//!
//! The PreToolUse scan only sees the command line; a self-credit trailer can still land from outside it (a repository
//! `commit-msg` hook, a commit template, a cherry-picked message, an editor). After a command that ran a commit-creating git
//! verb, this reads the commits HEAD points at that were committed in the last `git_audit.window_s` seconds and advises the
//! agent to reword any that carry a self-credit trailer before pushing. It never writes and never blocks.
//!
//! Differences from the Node hook (deliberate): a payload without an absolute `cwd` defers (Node would use its own process
//! directory, which the engine cannot see). The scan, the tokenizer, the alias resolution and the credit patterns are the
//! ones the PreToolUse check uses.
//!
//! Mirrors `hooks/git-guard.js` `commitRepoDirs`, `auditRecentCommits` and the `--audit` branch of `main`.
use super::Ctx;
use super::aliases::alias_creates_commit;
use super::gitcmd::{git_subcommand, has_self_credit};
use super::payloads::{extract_eval_payload, extract_shell_c_payload};
use super::tables::tables;
use super::tokenize::{effective_verb, is_shell_verb, split_segments, tokenize};
use super::util::{Settings, resolve, run_capture};
use crate::checks::guardkit::text::{js_number_of_str, js_trim};
use crate::checks::{Check, Verdict};
use crate::defaults;
use crate::reqenv::RequestEnv;
use crate::rules::Subject;
use serde_json::Value;
use std::collections::HashMap;

/// The repository directories of every commit-creating git segment in `cmd`, honouring a preceding literal `cd <dir>` and
/// `git -C <dir>`, and following eval and `sh -c` payloads.
///
/// Mirrors `git-guard.js` `commitRepoDirs`.
fn commit_repo_dirs(ctx: &mut Ctx, cmd: &str, base: &str, depth: usize, out: &mut Vec<String>) {
    let mut cd_dir = base.to_string();
    for seg in split_segments(cmd) {
        let tokens = tokenize(&seg);
        if tokens.is_empty() {
            continue;
        }
        let Some(ev) = effective_verb(&tokens) else { continue };
        if ev.verb == defaults::text("git_audit.cd_verb") {
            if let Some(dt) = ev.args.iter().find(|t| !t.text.starts_with('-')) {
                cd_dir = resolve(&cd_dir, &dt.text, &ctx.proc_cwd);
            }
            continue;
        }
        let is_eval = ev.verb == defaults::text("git_audit.eval_verb");
        if depth < defaults::num("git_audit.max_depth") as usize && (is_eval || is_shell_verb(&ev.verb)) {
            let payload = if is_eval { extract_eval_payload(&seg) } else { extract_shell_c_payload(&seg) };
            if !payload.is_empty() {
                commit_repo_dirs(ctx, &payload, &cd_dir, depth + 1, out);
            }
            continue;
        }
        if ev.verb != defaults::text("git_audit.git_verb") {
            continue;
        }
        let (sub, rest) = git_subcommand(&ev.args);
        let creates =
            sub.as_deref().is_some_and(|s| tables().commit_creating.has(s)) || alias_creates_commit(ctx, &ev.args, sub.as_deref(), &rest, Some(&cd_dir));
        if !creates {
            continue;
        }
        let mut dir = cd_dir.clone();
        let with_value = defaults::list("git_audit.opts_with_value");
        let mut k = 0usize;
        while k < ev.args.len() {
            let t = ev.args[k].text.as_str();
            if t == defaults::text("git_audit.dir_opt") && k + 1 < ev.args.len() {
                dir = resolve(&dir, &ev.args[k + 1].text, &ctx.proc_cwd);
                k += 2;
                continue;
            }
            if with_value.contains(&t) {
                k += 2;
                continue;
            }
            if t.starts_with('-') {
                k += 1;
                continue;
            }
            break; // reached the subcommand
        }
        if !out.contains(&dir) {
            out.push(dir);
        }
    }
}

/// The short hashes of the recent commits (one entry per hit, with the directory when more than one repository is involved).
///
/// Mirrors `git-guard.js` `auditRecentCommits`.
fn audit_recent_commits(ctx: &mut Ctx, cmd: &str, cwd: &str) -> Vec<String> {
    let mut dirs = Vec::new();
    commit_repo_dirs(ctx, cmd, cwd, 0, &mut dirs);
    let now_s = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as f64).unwrap_or(0.0);
    let window = defaults::num("git_audit.window_s") as f64;
    let (rs, us) = (defaults::text("git_audit.record_sep"), defaults::text("git_audit.field_sep"));
    let mut hits = Vec::new();
    for dir in &dirs {
        let argv: Vec<String> = defaults::list("git_audit.argv_log")
            .into_iter()
            .map(|a| a.replace("{dir}", dir).replace("{n}", &defaults::num("git_audit.commits").to_string()))
            .collect();
        let Some(out) = run_capture(&tables().git_binary, &argv, None, &ctx.settings.env, &HashMap::new(), defaults::millis("git_audit.timeout_ms")) else {
            continue;
        };
        if out.is_empty() || out.len() as u64 > defaults::num("git_audit.max_buffer") {
            continue;
        }
        for rec in out.split(rs) {
            let rec = rec.strip_prefix('\n').unwrap_or(rec);
            let mut f = rec.split(us);
            let (sha, ct, body) = (f.next().unwrap_or(""), f.next(), f.next());
            let Some(body) = body.filter(|b| !sha.is_empty() && !b.is_empty()) else { continue };
            // `Number(ct) < now - window`: a NaN never compares true, so an unreadable time does not skip the commit
            if js_number_of_str(ct.unwrap_or("")) < now_s - window {
                continue;
            }
            if has_self_credit(ctx, body) {
                let sha = js_trim(sha);
                hits.push(if dirs.len() > 1 { format!("{sha} ({dir})") } else { sha.to_string() });
            }
        }
    }
    hits
}

/// The audit's decision for one Bash command. Runs on a large-stack thread (the tokenizer recurses); a panic defers.
pub fn audit_bash(cmd: &str, cwd: Option<&str>, env: &RequestEnv) -> Verdict {
    let settings = Settings::from_env(env);
    if !settings.enabled(&tables().setting_git_guard) || settings.is_skipped(&tables().guard_name) || cmd.is_empty() {
        return Verdict::Allow;
    }
    // Node falls back to its own process directory without a cwd (or resolves a relative one against it).
    let Some(cwd) = cwd.filter(|c| c.starts_with('/')) else { return Verdict::Defer };
    let r = std::thread::scope(|sc| {
        std::thread::Builder::new()
            .stack_size(tables().stack_bytes)
            .spawn_scoped(sc, || {
                let mut ctx = Ctx::new(settings, cwd, "");
                ctx.raw_cmd = cmd.to_string();
                audit_recent_commits(&mut ctx, cmd, cwd)
            })
            .map(|h| h.join())
    });
    match r {
        Ok(Ok(hits)) if hits.is_empty() => Verdict::Allow,
        Ok(Ok(hits)) => {
            let window_min = defaults::num("git_audit.window_s") / 60;
            let text = defaults::render("git_audit.msg", &[("window_min", &window_min), ("hits", &hits.join(", "))]);
            Verdict::Advisory(crate::checks::guardkit::msg::advisory_json(defaults::text("git_audit.event"), &text))
        }
        _ => Verdict::Defer,
    }
}

/// The registered `git-audit` check.
pub struct GitAudit;

impl Check for GitAudit {
    fn name(&self) -> &'static str {
        "git-audit"
    }

    fn summary(&self) -> &'static str {
        defaults::text("git_audit.summary")
    }

    fn run(&self, s: &Subject<'_>, _opts: &Value) -> Option<Verdict> {
        (s.tool == Some("Bash")).then_some(Verdict::Defer)
    }

    fn run_env(&self, s: &Subject<'_>, _payload: &Value, _opts: &Value, env: &RequestEnv) -> Option<Verdict> {
        if s.tool != Some("Bash") {
            return None;
        }
        let cmd = s.tool_input.get("command").and_then(Value::as_str)?;
        Some(audit_bash(cmd, s.cwd, env))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    /// A repository with one commit of message `msg`, committed `age` seconds ago.
    fn repo(tag: &str, msg: &str, age: u64) -> String {
        let d = std::env::temp_dir().join(format!("ah-audit-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        let dir = d.to_string_lossy().to_string();
        let git = |args: &[&str], date: Option<String>| {
            let mut c = Command::new("git");
            c.args(args).current_dir(&d).env("GIT_CONFIG_GLOBAL", "/dev/null").env("GIT_CONFIG_NOSYSTEM", "1");
            for (k, v) in [("GIT_AUTHOR_NAME", "T"), ("GIT_AUTHOR_EMAIL", "t@e.x"), ("GIT_COMMITTER_NAME", "T"), ("GIT_COMMITTER_EMAIL", "t@e.x")] {
                c.env(k, v);
            }
            if let Some(dt) = date {
                c.env("GIT_AUTHOR_DATE", &dt).env("GIT_COMMITTER_DATE", &dt);
            }
            assert!(c.output().unwrap().status.success(), "git {args:?}");
        };
        git(&["init", "-q", "-b", "main"], None);
        std::fs::write(d.join("f"), "x").unwrap();
        git(&["add", "-A"], None);
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
        git(&["-c", "commit.gpgsign=false", "commit", "-q", "-m", msg], Some(format!("@{} +0000", now - age)));
        dir
    }

    fn env(home: &str) -> RequestEnv {
        let path = std::env::var("PATH").unwrap_or_default();
        RequestEnv::from_pairs([("HOME", home), ("PATH", path.as_str()), ("GIT_CONFIG_GLOBAL", "/dev/null"), ("GIT_CONFIG_NOSYSTEM", "1")])
    }

    fn credit() -> String {
        ["feat: x\n\nCo-Authored", "By: Claude <noreply@anthropic.com>"].join("-")
    }

    #[test]
    fn a_recent_commit_with_a_credit_trailer_is_flagged_after_a_commit_command() {
        let dir = repo("hit", &credit(), 30);
        let v = audit_bash("git commit -m x", Some(&dir), &env(&dir));
        let Verdict::Advisory(j) = v else { panic!("{v:?}") };
        assert!(j.starts_with("{\"hookSpecificOutput\":{\"hookEventName\":\"PostToolUse\",\"additionalContext\":\"anti-hall git-guard (audit): recent commit(s) on HEAD (committed in the last 15 min) "), "{j}");
        assert!(j.contains("BEFORE pushing."), "{j}");
        // a command that creates no commit, or a commit that is old or clean, says nothing
        assert_eq!(audit_bash("git status", Some(&dir), &env(&dir)), Verdict::Allow);
        let old = repo("old", &credit(), 3000);
        assert_eq!(audit_bash("git commit -m x", Some(&old), &env(&old)), Verdict::Allow);
        let clean = repo("clean", "feat: fine", 30);
        assert_eq!(audit_bash("git commit -m x", Some(&clean), &env(&clean)), Verdict::Allow);
    }

    #[test]
    fn the_repository_follows_cd_dash_c_and_wrappers_and_names_each_when_there_are_several() {
        let a = repo("dirA", &credit(), 30);
        let b = repo("dirB", "feat: fine", 30);
        let e = env(&a);
        for cmd in [
            format!("git -C {a} commit -m x"),
            format!("cd {a} && git commit -m x"),
            format!("bash -c 'cd {a} && git commit'"),
            format!("eval \"git -C {a} commit\""),
        ] {
            assert!(matches!(audit_bash(&cmd, Some(&b), &e), Verdict::Advisory(_)), "{cmd}");
        }
        assert_eq!(audit_bash(&format!("cd {a} && git status"), Some(&b), &e), Verdict::Allow);
        let Verdict::Advisory(j) = audit_bash(&format!("git -C {a} commit; git -C {b} commit"), Some(&b), &e) else { panic!("two repositories") };
        assert!(j.contains(&format!(" ({a})")), "with several repositories each hit names its directory: {j}");
    }

    #[test]
    fn switches_skip_and_a_missing_cwd_are_handled_as_node_does() {
        let dir = repo("sw", &credit(), 30);
        assert_eq!(audit_bash("git commit", None, &env(&dir)), Verdict::Defer, "no cwd: Node would use its own directory");
        assert_eq!(audit_bash("git commit", Some("relative"), &env(&dir)), Verdict::Defer);
        assert_eq!(audit_bash("", None, &env(&dir)), Verdict::Allow);
        std::fs::create_dir_all(format!("{dir}/.anti-hall")).unwrap();
        std::fs::write(format!("{dir}/.anti-hall/settings.json"), r#"{"safety":{"gitGuard":false}}"#).unwrap();
        assert_eq!(audit_bash("git commit", Some(&dir), &env(&dir)), Verdict::Allow);
    }
}
