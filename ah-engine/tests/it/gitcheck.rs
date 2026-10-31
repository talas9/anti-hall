//! End-to-end for the built-in `check = "git"`: real binary, real daemon, isolated HOME + engine dir.
//! A block must reach the host the way the Node guard does it: exit code 2 with the reason on stderr.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests
use crate::common;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const BIN: &str = env!("CARGO_BIN_EXE_ah-engine");
const P: &str = "pu\x73h";

struct Env {
    dir: PathBuf,
}

impl Env {
    fn new(tag: &str) -> Env {
        let dir = PathBuf::from("/tmp").join(format!("ah-gc-{}-{}", tag, std::process::id()));
        ah_engine::discard::harmless(std::fs::remove_dir_all(&dir));
        std::fs::create_dir_all(dir.join("home")).unwrap();
        let rules = r#"{"version":1,"rules":[{"id":"git-guard","events":["PreToolUse"],"tools":["Bash"],"check":"git","action":"deny","options":{"plugin_root":"/plugin"}},{"id":"git-guard:audit","events":["PostToolUse"],"tools":["Bash"],"check":"git-audit","action":"deny"}]}"#;
        std::fs::write(dir.join("rules.json"), rules).unwrap();
        Env { dir }
    }

    /// Runs against a copy of the plugin's engine files with `git.<key>` set to `value` in both default sets (the in-process
    /// check reads the plugin files, not the user layer). Call before the first hook starts the daemon.
    fn set_git(&self, key: &str, value: i64) {
        let plugin = self.dir.join("plugin");
        copy_tree(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall/engine"), &plugin.join("engine"));
        for d in ["engine/defaults", "engine/defaults.pristine"] {
            let f = plugin.join(d).join("git.toml");
            let text = std::fs::read_to_string(&f).unwrap();
            let at = text.find(&format!("[git.{key}]")).unwrap();
            let v = at + text[at..].find("\nvalue = ").unwrap() + "\nvalue = ".len();
            let end = v + text[v..].find('\n').unwrap();
            std::fs::write(&f, format!("{}{value}{}", &text[..v], &text[end..])).unwrap();
        }
    }

    fn cmd(&self) -> Command {
        let mut c = Command::new(BIN);
        c.env("HOME", self.dir.join("home"))
            // an external CARGO_TARGET_DIR cannot find the checkout by walking up from the executable
            .env(
                "AH_ENGINE_PLUGIN_ROOT",
                if self.dir.join("plugin").exists() {
                    self.dir.join("plugin")
                } else {
                    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall")
                },
            )
            .env("AH_ENGINE_DIR", self.dir.join("eng"))
            .env("AH_ENGINE_RULES", self.dir.join("rules.json"))
            .env("AH_ENGINE_VERSION", "0.1.0")
            .env_remove("AH_ENGINE_NOSPAWN");
        c
    }

    /// (stdout, stderr, exit code) of one `engine hook` call; retried once so a cold start cannot hide the answer.
    fn hook(&self, command: &str) -> (String, String, i32) {
        self.hook_in(command, "/tmp")
    }

    fn hook_in(&self, command: &str, cwd: &str) -> (String, String, i32) {
        self.hook_ev("PreToolUse", command, cwd)
    }

    fn hook_ev(&self, event: &str, command: &str, cwd: &str) -> (String, String, i32) {
        let payload =
            serde_json::json!({"hook_event_name": event, "tool_name": "Bash", "cwd": cwd, "session_id": "s", "tool_input": {"command": command}}).to_string();
        let mut last = (String::new(), String::new(), 0);
        for _ in 0..2 {
            let mut ch = self.cmd().arg("hook").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
            ch.stdin.take().unwrap().write_all(payload.as_bytes()).unwrap();
            let o = ch.wait_with_output().unwrap();
            last =
                (String::from_utf8_lossy(&o.stdout).trim().to_string(), String::from_utf8_lossy(&o.stderr).trim().to_string(), o.status.code().unwrap_or(-1));
            // a cold start with no fallback hands a guard event over (dispatch.defer_exit), it is not the engine's answer
            if last.2 == 2 || (self.up() && last.2 != ah_engine::defaults::num("dispatch.defer_exit") as i32) {
                break;
            }
            let t = Instant::now();
            while t.elapsed() < Duration::from_secs(3) && !self.up() {
                std::thread::sleep(Duration::from_millis(20));
            }
        }
        last
    }

    fn up(&self) -> bool {
        self.cmd().args(["ctl", "ping"]).output().is_ok_and(|o| o.status.success())
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        common::reap(&self.dir.join("eng"), || {
            ah_engine::discard::harmless(self.cmd().args(["ctl", "stop"]).output());
        });
        ah_engine::discard::harmless(std::fs::remove_dir_all(&self.dir));
    }
}

fn copy_tree(from: &std::path::Path, to: &std::path::Path) {
    std::fs::create_dir_all(to).unwrap();
    for e in std::fs::read_dir(from).unwrap().flatten() {
        let (p, q) = (e.path(), to.join(e.file_name()));
        if p.is_dir() {
            copy_tree(&p, &q);
        } else {
            std::fs::copy(&p, &q).unwrap();
        }
    }
}

#[test]
fn a_block_is_exit_2_with_the_reason_on_stderr() {
    let e = Env::new("block");
    let (out, err, code) = e.hook(&format!("git {P} --force origin main"));
    assert_eq!(code, 2, "stdout={out} stderr={err}");
    assert!(out.is_empty(), "{out}");
    assert!(err.starts_with("\u{26d4} git safety: a force push was stopped."), "{err}");
    // served by the resident daemon on the next call
    assert!(e.up());
    let (_, err2, code2) = e.hook(&format!("git {P} -f"));
    assert_eq!(code2, 2, "{err2}");
}

#[test]
fn benign_commands_and_other_tools_are_silent_exit_0() {
    let e = Env::new("allow");
    let _ = e.hook("echo warm");
    assert_eq!(e.hook("git status"), (String::new(), String::new(), 0));
    assert_eq!(e.hook(&format!("git commit -m \"never git {P} --force\"")), (String::new(), String::new(), 0));
}

#[test]
fn the_override_hint_names_the_configured_plugin_root() {
    let e = Env::new("root");
    let (_, err, code) = e.hook(&format!("git {P} --delete origin b"));
    assert_eq!(code, 2, "{err}");
    // The inline guard is brief; the remedy is the current deliberate contract.
    assert!(err.contains("Do instead: get the owner’s approval for this exact deletion."), "{err}");
    assert_eq!(err.lines().count(), 2);
}

// ---- GH #457: credit trailers that used to reach a commit ----

const TRAILER_KEY: &str = "Claude-Session";
const SESSION_URL: &str = "https://claude.ai/code/session_x";

#[test]
fn a_commit_message_built_from_a_shell_variable_is_refused_and_told_to_be_literal() {
    let e = Env::new("var");
    let _ = e.hook("echo warm");
    for cmd in [
        "git commit -q -m \"subj\\n\\n$T\"".to_string(),
        "git commit -q -m \"subj $(printf x)\"".to_string(),
        "git commit -q -m \"subj `printf x`\"".to_string(),
        "git commit -q --message=\"subj ${T}\"".to_string(),
    ] {
        let (out, err, code) = e.hook(&cmd);
        assert_eq!(code, 2, "{cmd}: stdout={out} stderr={err}");
        assert!(err.contains("literal"), "{cmd}: {err}");
    }
    // literal text, a single-quoted dollar and the standard heredoc substitution stay allowed
    for cmd in [
        "git commit -q -m 'cost $5 $T'".to_string(),
        "git commit -q -m \"costs \\$5\"".to_string(),
        "git commit -q -m \"$(cat <<'EOF'\nfix: a thing\n\nbody\nEOF\n)\"".to_string(),
    ] {
        assert_eq!(e.hook(&cmd), (String::new(), String::new(), 0), "{cmd}");
    }
}

#[test]
fn a_claude_session_trailer_or_session_url_in_a_commit_message_is_blocked() {
    let e = Env::new("sess");
    let _ = e.hook("echo warm");
    for msg in [format!("subj\\n\\n{TRAILER_KEY}: {SESSION_URL}"), format!("subj\\n\\n{SESSION_URL}")] {
        let cmd = format!("git commit -q -m \"{msg}\"");
        let (out, err, code) = e.hook(&cmd);
        assert_eq!(code, 2, "{cmd}: stdout={out} stderr={err}");
    }
    let (_, err, code) = e.hook(&format!("gh pr create --title t --body \"x {SESSION_URL}\""));
    assert_eq!(code, 2, "{err}");
    // talking about the key in a sentence is not a trailer
    assert_eq!(e.hook("git commit -q -m \"docs: explain the session key\""), (String::new(), String::new(), 0));
}

fn git_ok(dir: &std::path::Path, args: &[&str]) -> String {
    let o = Command::new("git")
        .args(["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false"])
        .args(args)
        .current_dir(dir)
        .output()
        .unwrap();
    assert!(o.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&o.stderr));
    String::from_utf8_lossy(&o.stdout).trim().to_string()
}

#[test]
fn a_push_with_an_unpushed_credited_commit_is_blocked_with_the_sha_and_the_fix() {
    let e = Env::new("push");
    let origin = e.dir.join("origin.git");
    let work = e.dir.join("work");
    std::fs::create_dir_all(&origin).unwrap();
    std::fs::create_dir_all(&work).unwrap();
    git_ok(&origin, &["init", "-q", "--bare", "-b", "main"]);
    git_ok(&work, &["init", "-q", "-b", "main"]);
    git_ok(&work, &["remote", "add", "origin", origin.to_str().unwrap()]);
    git_ok(&work, &["commit", "-q", "--allow-empty", "-m", "base"]);
    git_ok(&work, &["push", "-q", "-u", "origin", "main"]);
    let w = work.to_str().unwrap();
    let _ = e.hook("echo warm");
    // nothing unpushed: allowed
    assert_eq!(e.hook_in("git push", w), (String::new(), String::new(), 0));
    git_ok(&work, &["commit", "-q", "--allow-empty", "-m", "clean\n\nbody"]);
    assert_eq!(e.hook_in("git push", w), (String::new(), String::new(), 0));
    git_ok(
        &work,
        &["commit", "-q", "--allow-empty", "-m", &format!("credited\n\nCo-Authored-By: Claude Opus <noreply@anthropic.com>\n{TRAILER_KEY}: {SESSION_URL}")],
    );
    let sha = git_ok(&work, &["rev-parse", "--short", "HEAD"]);
    let (out, err, code) = e.hook_in("git push", w);
    assert_eq!(code, 2, "stdout={out} stderr={err}");
    assert!(err.contains(&sha), "the block names the sha {sha}: {err}");
    assert!(err.contains("reword"), "the block names the fix: {err}");
    assert_eq!(git_ok(&work, &["log", "--format=%s", "-1"]), "credited", "history is never rewritten");
}

// ---- PR #469 review: every expansion is read, pushed refs are resolved, the cap never allows unread, prose is not a trailer ----

#[test]
fn an_allowed_expansion_does_not_hide_a_later_one_in_the_message() {
    let e = Env::new("later");
    let _ = e.hook("echo warm");
    for cmd in [
        "git commit -q -m \"$(:)$T\"".to_string(),
        "git commit -q -m \"$(:) $(printf x)\"".to_string(),
        "git commit -q -m \"$(cat <<'EOF'\nfix: x\nEOF\n)$T\"".to_string(),
        "git commit -q -m \"$(cat <<'EOF'\nfix: x\nEOF\n)\" -m \"$T\"".to_string(),
        // an unquoted heredoc delimiter expands its body: the variable is part of the message
        "git commit -q -m \"$(cat <<EOF\nfix: x\n\n$T\nEOF\n)\"".to_string(),
    ] {
        let (out, err, code) = e.hook(&cmd);
        assert_eq!(code, 2, "{cmd}: stdout={out} stderr={err}");
        assert!(err.contains("literal"), "{cmd}: {err}");
    }
    for cmd in [
        "git commit -q -m \"$(cat <<EOF\nfix: x\n\nbody\nEOF\n)\"".to_string(),
        "git commit -q -m \"$(cat <<'EOF'\nfix: x\nEOF\n)\" -m 'plain'".to_string(),
        "git commit -q -m 'docs: reject Claude-Session: trailers'".to_string(),
    ] {
        assert_eq!(e.hook(&cmd), (String::new(), String::new(), 0), "{cmd}");
    }
}

/// A repository with a pushed `main` and a bare origin; returns (work dir, origin dir).
fn pushed_repo(e: &Env) -> (std::path::PathBuf, std::path::PathBuf) {
    let origin = e.dir.join("origin.git");
    let work = e.dir.join("work");
    std::fs::create_dir_all(&origin).unwrap();
    std::fs::create_dir_all(&work).unwrap();
    git_ok(&origin, &["init", "-q", "--bare", "-b", "main"]);
    git_ok(&work, &["init", "-q", "-b", "main"]);
    git_ok(&work, &["remote", "add", "origin", origin.to_str().unwrap()]);
    git_ok(&work, &["commit", "-q", "--allow-empty", "-m", "base"]);
    git_ok(&work, &["push", "-q", "-u", "origin", "main"]);
    (work, origin)
}

const CREDITED: &str = "credited\n\nCo-Authored-By: Claude Opus <noreply@anthropic.com>";

#[test]
fn a_push_over_the_commit_cap_is_refused_naming_the_cap() {
    let e = Env::new("cap");
    let (work, _) = pushed_repo(&e);
    git_ok(&work, &["commit", "-q", "--allow-empty", "-m", CREDITED]);
    for i in 0..50 {
        git_ok(&work, &["commit", "-q", "--allow-empty", "-m", &format!("clean {i}")]);
    }
    let w = work.to_str().unwrap();
    let _ = e.hook("echo warm");
    let (out, err, code) = e.hook_in("git push origin main", w);
    assert_eq!(code, 2, "stdout={out} stderr={err}");
    assert!(err.contains("more than 50 local commits"), "{err}");
}

/// GH #506: a repository with a pushed `main`, 60 unpushed commits on a side branch (more than the cap) and a linked worktree on
/// its own branch `feat` holding `n` unpushed commits (the last one credited when `credited`). Returns (work dir, worktree dir).
fn big_repo_with_worktree(e: &Env, n: usize, credited: bool) -> (std::path::PathBuf, std::path::PathBuf) {
    let (work, _) = pushed_repo(e);
    git_ok(&work, &["checkout", "-q", "-b", "big"]);
    for i in 0..60 {
        git_ok(&work, &["commit", "-q", "--allow-empty", "-m", &format!("big {i}")]);
    }
    git_ok(&work, &["checkout", "-q", "main"]);
    let wt = e.dir.join("wt");
    git_ok(&work, &["worktree", "add", "-q", "-b", "feat", wt.to_str().unwrap(), "main"]);
    for i in 0..n {
        let msg = if credited && i + 1 == n { CREDITED.to_string() } else { format!("feat {i}") };
        git_ok(&wt, &["commit", "-q", "--allow-empty", "-m", &msg]);
    }
    (work, wt)
}

#[test]
fn a_push_of_four_commits_is_allowed_while_the_repository_holds_sixty_unpushed_elsewhere() {
    let e = Env::new("scoped_ok");
    let (work, wt) = big_repo_with_worktree(&e, 4, false);
    let _ = e.hook("echo warm");
    let w = wt.to_str().unwrap();
    for cmd in [
        "git push origin feat".to_string(),
        "git push origin HEAD:refs/heads/feat".to_string(),
        "git push".to_string(),
        format!("git {P} --recei git-receive-pack origin feat"),
        format!("git {P} --recu=check -qu origin feat"),
        format!("git {P} -o ci.skip origin feat"),
    ] {
        assert_eq!(e.hook_in(&cmd, w), (String::new(), String::new(), 0), "{cmd}");
    }
    let cmd = format!("git -C {w} push origin feat");
    assert_eq!(e.hook_in(&cmd, work.to_str().unwrap()), (String::new(), String::new(), 0), "{cmd}");
}

/// GH #506 review: a push option is resolved against the whole option table the way git does it (exact, else a unique prefix),
/// so an abbreviated value option cannot turn the remote name into a revision; an ambiguous or unknown one reads every commit.
#[test]
fn an_abbreviated_or_ambiguous_push_option_never_narrows_the_scan_past_a_credited_head() {
    let e = Env::new("abbrev");
    let (work, _) = pushed_repo(&e);
    // origin/HEAD resolves (as in a clone), so a misread `origin` would be a valid, empty revision range
    git_ok(&work, &["remote", "set-head", "origin", "main"]);
    git_ok(&work, &["commit", "-q", "--allow-empty", "-m", CREDITED]);
    let w = work.to_str().unwrap();
    let _ = e.hook("echo warm");
    let shapes = [
        format!("git {P} --recei git-receive-pack origin"),
        format!("git {P} --recei=git-receive-pack origin"),
        format!("git {P} --re git-receive-pack origin"),
        format!("git {P} --recurse-submodules check origin"),
        format!("git {P} --rec check origin"),
        format!("git {P} --no-ver origin"),
        format!("git {P} --bogus-opt origin"),
        format!("git {P} -qo opt origin"),
        format!("git {P} -o opt origin"),
        format!("git {P} -x origin"),
    ];
    let mut missed = Vec::new();
    for cmd in &shapes {
        let (out, err, code) = e.hook_in(cmd, w);
        if code != 2 || !err.contains("AI credit") {
            missed.push(format!("{cmd}: code={code} stdout={out} stderr={err}"));
        }
    }
    assert!(missed.is_empty(), "{missed:#?}");
}

#[test]
fn a_credited_commit_among_the_pushed_ones_still_blocks_when_the_repository_holds_sixty_elsewhere() {
    let e = Env::new("scoped_credit");
    let (_, wt) = big_repo_with_worktree(&e, 4, true);
    let _ = e.hook("echo warm");
    let (out, err, code) = e.hook_in("git push origin feat", wt.to_str().unwrap());
    assert_eq!(code, 2, "stdout={out} stderr={err}");
    assert!(err.contains("AI credit"), "{err}");
    // a push shape whose commits the guard cannot narrow (every branch) stays refused over the cap
    let e = Env::new("scoped_all");
    let (_, wt) = big_repo_with_worktree(&e, 4, false);
    let _ = e.hook("echo warm");
    let (out, err, code) = e.hook_in("git push --all origin", wt.to_str().unwrap());
    assert_eq!(code, 2, "stdout={out} stderr={err}");
    assert!(err.contains("more than 50 local commits"), "{err}");
}

#[test]
fn a_push_of_more_than_the_cap_is_refused_naming_the_repository_and_the_count() {
    let e = Env::new("scoped_over");
    let (_, wt) = big_repo_with_worktree(&e, 51, false);
    let _ = e.hook("echo warm");
    let w = wt.to_str().unwrap();
    let (out, err, code) = e.hook_in("git push origin feat", w);
    assert_eq!(code, 2, "stdout={out} stderr={err}");
    assert!(err.contains("more than 50 local commits"), "{err}");
    assert!(err.contains(w), "the refusal names the repository {w}: {err}");
    assert!(err.contains("51"), "the refusal names the count: {err}");
    let m = String::from_utf8_lossy(&e.cmd().args(["metrics", "--json"]).output().unwrap().stdout).to_string();
    assert!(m.contains("push_over_cap"), "the refusal is counted by reason: {m}");
}

/// GH #506: the session directory (the hook payload's cwd) is the main checkout with 60 unpushed commits, the push runs in the
/// linked worktree named by the command: its own HEAD and branch are read, so a credit there still blocks and a clean one passes.
#[test]
fn a_push_into_a_worktree_named_by_the_command_reads_that_worktrees_commits() {
    let e = Env::new("scoped_wt");
    let (work, wt) = big_repo_with_worktree(&e, 4, true);
    let _ = e.hook("echo warm");
    let (m, w) = (work.to_str().unwrap(), wt.to_str().unwrap());
    for cmd in [format!("cd {w} && git push"), format!("git -C {w} push origin feat"), format!("cd {w} && git push origin HEAD")] {
        let (out, err, code) = e.hook_in(&cmd, m);
        assert_eq!(code, 2, "{cmd}: stdout={out} stderr={err}");
        assert!(err.contains("AI credit"), "{cmd}: {err}");
    }
    let e = Env::new("scoped_wt_ok");
    let (work, wt) = big_repo_with_worktree(&e, 4, false);
    let _ = e.hook("echo warm");
    let (m, w) = (work.to_str().unwrap(), wt.to_str().unwrap());
    for cmd in [format!("cd {w} && git push"), format!("git -C {w} push --signed=if-asked origin feat")] {
        assert_eq!(e.hook_in(&cmd, m), (String::new(), String::new(), 0), "{cmd}");
    }
}

/// Runs `script` with bash in `dir` (scratch HOME, fixed identity), the way the agent's Bash tool would.
fn bash_in(e: &Env, dir: &std::path::Path, script: &str) {
    let o = Command::new("bash")
        .args(["-c", script])
        .current_dir(dir)
        .env("HOME", e.dir.join("home"))
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@example.com")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@example.com")
        .output()
        .unwrap();
    assert!(o.status.success(), "bash {script}: {}", String::from_utf8_lossy(&o.stderr));
}

const CO: &str = "Co-Authored-By: Claude Opus <noreply@anthropic.com>";

/// Layer (a): each commit-message form the PreToolUse text scan cannot resolve (Codex re-review of PR #469 at 503630f1) is
/// caught after the call from what git stored, never from the shell text.
#[test]
fn a_credit_git_stored_is_blocked_after_the_call_whatever_shell_form_wrote_it() {
    let e = Env::new("audit");
    let (work, _) = pushed_repo(&e);
    std::fs::write(work.join("m.txt"), format!("credited\n\n{CO}\n")).unwrap();
    let w = work.to_str().unwrap();
    let _ = e.hook("echo warm");
    let cases = [
        ("heredoc + here-string", format!("cat >/dev/null <<'EOF'\nx\nEOF\nT=\"credited\n\n{CO}\"; git commit -q --allow-empty -F - <<<\"$T\"")),
        ("positional params", format!("set -- credited \"{CO}\"; git commit -q --allow-empty -m \"$1\" -m \"$2\"")),
        ("abbreviated --mess", format!("T=\"{CO}\"; git commit -q --allow-empty -m credited --mess=\"$T\"")),
        ("-F $MSGFILE", "MSGFILE=m.txt; git commit -q --allow-empty -F \"$MSGFILE\"".to_string()),
        ("ANSI-C escapes", "git commit -q --allow-empty -m $'credited\\n\\n\\x43o-Authored-By: Claude \\103pus <noreply@anthropic.com>'".to_string()),
    ];
    let mut missed = Vec::new();
    for (name, cmd) in cases {
        bash_in(&e, &work, &cmd);
        let (out, err, code) = e.hook_ev("PostToolUse", &cmd, w);
        let details = std::fs::read_to_string(e.dir.join("home/.anti-hall/block-details/git-guard-session.md")).unwrap_or_default();
        if !(code == 2 && err.contains("AI credit") && (err.contains("amend") || details.contains("amend"))) {
            missed.push(format!("{name}: code={code} stdout={out} stderr={err}"));
        }
        // the agent fixes it: an amend without the credit clears the block on the next call
        bash_in(&e, &work, "git commit -q --amend --allow-empty -m clean");
        if e.hook_ev("PostToolUse", "git log -1", w) != (String::new(), String::new(), 0) {
            missed.push(format!("{name}: still blocked after the amend"));
        }
    }
    assert!(missed.is_empty(), "{missed:#?}");
    // the off switch (guards.gitCommitAudit) lets a credited commit through this layer
    bash_in(&e, &work, &format!("git commit -q --allow-empty -m 'credited' -m '{CO}'"));
    std::fs::create_dir_all(e.dir.join("home/.anti-hall")).unwrap();
    std::fs::write(e.dir.join("home/.anti-hall/settings.json"), r#"{"guards":{"gitCommitAudit":false}}"#).unwrap();
    let t = Instant::now();
    let mut off = e.hook_ev("PostToolUse", "git log -1", w);
    while off.2 == 2 && t.elapsed() < Duration::from_secs(5) {
        std::thread::sleep(Duration::from_millis(200));
        off = e.hook_ev("PostToolUse", "git log -1", w);
    }
    assert_eq!(off, (String::new(), String::new(), 0), "off switch");
    std::fs::remove_file(e.dir.join("home/.anti-hall/settings.json")).unwrap();
    bash_in(&e, &work, "git commit -q --amend --allow-empty -m clean");
    // an ordinary commit, and a command outside any repository, stay silent
    bash_in(&e, &work, "git commit -q --allow-empty -m 'feat: ordinary'");
    assert_eq!(e.hook_ev("PostToolUse", "git commit -q --allow-empty -m 'feat: ordinary'", w), (String::new(), String::new(), 0));
    assert_eq!(e.hook_ev("PostToolUse", "ls", "/tmp"), (String::new(), String::new(), 0));
}

/// Layer (b): the cap applies to a destination with no tracking refs too (Codex P1 of PR #469 at 503630f1).
#[test]
fn an_untracked_destination_over_the_cap_is_refused() {
    let e = Env::new("untrackedcap");
    let (work, _) = pushed_repo(&e);
    let other = e.dir.join("other.git");
    std::fs::create_dir_all(&other).unwrap();
    git_ok(&other, &["init", "-q", "--bare", "-b", "main"]);
    git_ok(&work, &["remote", "add", "newremote", other.to_str().unwrap()]);
    git_ok(&work, &["checkout", "-q", "-b", "big"]);
    git_ok(&work, &["commit", "-q", "--allow-empty", "-m", CREDITED]);
    for i in 0..51 {
        git_ok(&work, &["commit", "-q", "--allow-empty", "-m", &format!("clean {i}")]);
    }
    let w = work.to_str().unwrap();
    let _ = e.hook("echo warm");
    let (out, err, code) = e.hook_in("git push newremote big", w);
    assert_eq!(code, 2, "stdout={out} stderr={err}");
    assert!(err.contains("more than 50 local commits"), "{err}");
}

/// Layer (a): a credited commit pushed in the same Bash call is reached by a remote, and is still blocked once, with the
/// publish named (Codex P1 of PR #469 at 375cf8fe).
#[test]
fn a_credit_committed_and_pushed_in_one_call_is_still_blocked() {
    let e = Env::new("commitpush");
    let (work, _) = pushed_repo(&e);
    std::fs::write(work.join("m.txt"), format!("credited\n\n{CO}\n")).unwrap();
    let w = work.to_str().unwrap();
    let _ = e.hook("echo warm");
    let cmd = format!("F=m.txt; git commit -q --allow-empty -F \"$F\" && git {P} -q origin main");
    bash_in(&e, &work, &cmd);
    let (out, err, code) = e.hook_ev("PostToolUse", &cmd, w);
    assert_eq!(code, 2, "stdout={out} stderr={err}");
    assert!(err.contains("already on a remote"), "{err}");
    // reported once: the agent cannot clear it itself, so later calls are not blocked again
    assert_eq!(e.hook_ev("PostToolUse", "git log -1", w), (String::new(), String::new(), 0), "reported once");
}

// ---- PR #469 simplification: a push is denied while ANY local commit no remote has carries a credit, whatever the push resolves to ----

/// A clean `main` (HEAD) next to a credited branch no remote has: every push shape is refused, however git would resolve it.
#[test]
fn any_unpushed_credited_commit_refuses_every_push_shape() {
    let e = Env::new("anyunpushed");
    let (work, origin) = pushed_repo(&e);
    git_ok(&work, &["branch", "other"]);
    git_ok(&work, &["checkout", "-q", "other"]);
    git_ok(&work, &["commit", "-q", "--allow-empty", "-m", CREDITED]);
    git_ok(&work, &["checkout", "-q", "main"]);
    let w = work.to_str().unwrap();
    let o = origin.to_str().unwrap();
    let _ = e.hook("echo warm");
    // GH #506: a push narrowed to its own commits (`origin main`, a bare push from main) no longer counts the credited `other`;
    // every shape that names `other` or that the guard cannot narrow still does
    let shapes = [
        ("credited branch named", format!("git {P} origin other")),
        ("credited branch onto another", format!("git {P} origin other:main")),
        ("credited branch as a new upstream", format!("git {P} -u origin other:refs/heads/fresh")),
        ("every branch", format!("git {P} --all origin")),
        ("matching refspec", format!("git {P} origin :")),
        ("glob refspec", format!("git {P} origin 'refs/heads/*'")),
        ("mirror with an empty value", format!("git -c remote.origin.mirror= {P} origin")),
        ("pushInsteadOf", format!("git -c url.{o}.{P}InsteadOf=nowhere {P} nowhere main")),
        ("include.path via --config-env", format!("git --config-env=include.path=INC {P} origin")),
        ("configured refspec", format!("git -c remote.origin.{P}=refs/heads/other:refs/heads/other {P} origin")),
    ];
    let mut missed = Vec::new();
    for (name, cmd) in &shapes {
        let (out, err, code) = e.hook_in(cmd, w);
        if code != 2 || !err.contains("AI credit") {
            missed.push(format!("{name}: {cmd}: code={code} stdout={out} stderr={err}"));
        }
    }
    for cmd in [format!("git {P} origin main"), format!("git {P}"), format!("git {P} origin HEAD~0:main")] {
        assert_eq!(e.hook_in(&cmd, w), (String::new(), String::new(), 0), "narrowed push of main: {cmd}");
    }
    // a credited commit only a custom ref holds (published by a mirror or a refs/* refspec) counts for a push that may send it
    git_ok(&work, &["branch", "-q", "-D", "other"]);
    let sha = git_ok(&work, &["commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", CREDITED]);
    git_ok(&work, &["update-ref", "refs/custom/x", &sha]);
    for cmd in [format!("git {P} --mirror origin"), format!("git -c remote.origin.mirror=true {P} origin")] {
        let (out, err, code) = e.hook_in(&cmd, w);
        if code != 2 || !err.contains("AI credit") {
            missed.push(format!("custom ref: {cmd}: code={code} stdout={out} stderr={err}"));
        }
    }
    // a mirror or push refspec in the repository's own configuration widens a bare push: it is read whole
    git_ok(&work, &["config", "remote.origin.mirror", "true"]);
    let (out, err, code) = e.hook_in(&format!("git {P} origin"), w);
    if code != 2 || !err.contains("AI credit") {
        missed.push(format!("configured mirror: code={code} stdout={out} stderr={err}"));
    }
    git_ok(&work, &["config", "--unset", "remote.origin.mirror"]);
    // the off switch guards.gitPushCreditScope reads every unpushed commit again
    std::fs::create_dir_all(e.dir.join("home/.anti-hall")).unwrap();
    std::fs::write(e.dir.join("home/.anti-hall/settings.json"), r#"{"guards":{"gitPushCreditScope":false}}"#).unwrap();
    let t = Instant::now();
    let mut off = e.hook_in(&format!("git {P} origin main"), w);
    while off.2 != 2 && t.elapsed() < Duration::from_secs(5) {
        std::thread::sleep(Duration::from_millis(200));
        off = e.hook_in(&format!("git {P} origin main"), w);
    }
    if off.2 != 2 || !off.1.contains("AI credit") {
        missed.push(format!("scope off: {off:?}"));
    }
    std::fs::remove_file(e.dir.join("home/.anti-hall/settings.json")).unwrap();
    assert!(missed.is_empty(), "{missed:#?}");
    // nothing credited left unpushed: every shape is allowed again
    git_ok(&work, &["update-ref", "-d", "refs/custom/x"]);
    git_ok(&work, &["commit", "-q", "--allow-empty", "-m", "feat: ordinary"]);
    for (name, cmd) in &shapes {
        assert_eq!(e.hook_in(cmd, w), (String::new(), String::new(), 0), "{name}: {cmd}");
    }
}

/// GH #506 review (P1): git itself reads the configuration, so every spelling it accepts of a mirror (or another setting that makes
/// a bare push send more than HEAD) widens the push, and a clean `main` does not hide a credited branch.
#[test]
fn every_spelling_git_accepts_of_a_widening_push_config_refuses_a_bare_push() {
    let e = Env::new("scope_cfg");
    let (work, _) = pushed_repo(&e);
    git_ok(&work, &["branch", "credited"]);
    git_ok(&work, &["checkout", "-q", "credited"]);
    git_ok(&work, &["commit", "-q", "--allow-empty", "-m", CREDITED]);
    git_ok(&work, &["checkout", "-q", "main"]);
    let w = work.to_str().unwrap();
    let cfg = work.join(".git/config");
    let base = std::fs::read_to_string(&cfg).unwrap();
    let inc = e.dir.join("extra.gitconfig");
    std::fs::write(&inc, "[remote \"origin\"]\n\tmirror\n").unwrap();
    let inc = inc.to_str().unwrap().to_string();
    let _ = e.hook("echo warm");
    let r = |s: &str| s.to_string();
    let blocked: Vec<(&str, String, String)> = vec![
        ("bare mirror", r("[remote \"origin\"]\n\tmirror\n"), r("git push origin")),
        ("mirror = true", r("[remote \"origin\"]\n\tmirror = true\n"), r("git push origin")),
        ("mirror = yes", r("[remote \"origin\"]\n\tmirror = yes\n"), r("git push origin")),
        ("mirror = on", r("[remote \"origin\"]\n\tmirror = on\n"), r("git push origin")),
        ("mirror = 1", r("[remote \"origin\"]\n\tmirror = 1\n"), r("git push origin")),
        ("mirror = TRUE", r("[remote \"origin\"]\n\tmirror = TRUE\n"), r("git push origin")),
        ("mixed-case names", r("[REMOTE \"origin\"]\n\tMiRrOr\n"), r("git push origin")),
        ("bare mirror, bare push", r("[remote \"origin\"]\n\tmirror\n"), r("git push")),
        ("included file", format!("[include]\n\tpath = {inc}\n"), r("git push origin")),
        ("includeIf", format!("[includeIf \"onbranch:main\"]\n\tpath = {inc}\n"), r("git push origin")),
        ("unreadable boolean", r("[remote \"origin\"]\n\tmirror = banana\n"), r("git push origin")),
        ("glob push refspec", r("[remote \"origin\"]\n\tpush = +refs/*:refs/*\n"), r("git push origin")),
        ("push.default matching", r("[push]\n\tdefault = matching\n"), r("git push origin")),
        ("push.followTags bare", r("[push]\n\tfollowTags\n"), r("git push origin")),
        ("-c bare mirror", String::new(), r("git -c remote.origin.mirror push origin")),
        ("--mirror", String::new(), r("git push --mirror origin")),
        ("--all", String::new(), r("git push --all origin")),
        ("--tags", String::new(), r("git push --tags origin")),
    ];
    let mut missed = Vec::new();
    for (name, add, cmd) in &blocked {
        std::fs::write(&cfg, format!("{base}{add}")).unwrap();
        let (out, err, code) = e.hook_in(cmd, w);
        if code != 2 || !err.contains("AI credit") {
            missed.push(format!("{name}: {cmd}: code={code} stdout={out} stderr={err}"));
        }
    }
    // settings that leave a bare push on HEAD stay narrowed: the clean `main` is allowed
    for (name, add) in [
        ("no extra config", ""),
        ("mirror = false", "[remote \"origin\"]\n\tmirror = false\n"),
        ("push.default current", "[push]\n\tdefault = current\n"),
        ("push.followTags = false", "[push]\n\tfollowTags = false\n"),
    ] {
        std::fs::write(&cfg, format!("{base}{add}")).unwrap();
        let got = e.hook_in("git push origin", w);
        if got != (String::new(), String::new(), 0) {
            missed.push(format!("{name} must allow: {got:?}"));
        }
    }
    std::fs::write(&cfg, &base).unwrap();
    assert!(missed.is_empty(), "{missed:#?}");
}

/// Layer 1 cannot read a message built from a file or an expansion; a push in the same call is refused before anything runs.
#[test]
fn a_commit_layer_one_cannot_read_and_a_push_in_the_same_call_are_refused() {
    let e = Env::new("samecall");
    let (work, _) = pushed_repo(&e);
    std::fs::write(work.join("m.txt"), format!("credited\n\n{CO}\n")).unwrap();
    let w = work.to_str().unwrap();
    let _ = e.hook("echo warm");
    let mut missed = Vec::new();
    for cmd in [
        format!("F=m.txt; git commit -q --allow-empty -F \"$F\" && git {P} -q origin main"),
        format!("printf x > c.txt; git commit -q --allow-empty -F c.txt && git {P}"),
        format!("git commit -q --amend --no-edit && git {P}"),
        format!("git commit -q --allow-empty -F - <<<\"x\" ; git {P}"),
        format!("bash -c 'git commit -q --allow-empty -C HEAD' && git {P}"),
    ] {
        let (out, err, code) = e.hook_in(&cmd, w);
        if code != 2 || !err.contains("separate") {
            missed.push(format!("{cmd}: code={code} stdout={out} stderr={err}"));
        }
    }
    assert!(missed.is_empty(), "{missed:#?}");
    assert_eq!(git_ok(&work, &["log", "--format=%s", "-1"]), "base", "nothing ran");
    for cmd in [
        format!("git commit -q --allow-empty -m 'feat: plain' && git {P} origin main"),
        format!("git commit -q --allow-empty -F - <<'EOF' && git {P}\nfeat: plain\nEOF"),
        format!("git pull -q && git {P}"),
    ] {
        assert_eq!(e.hook_in(&cmd, w), (String::new(), String::new(), 0), "{cmd}");
    }
}

/// Two calls: the commit is caught after the call by the audit, and every push is refused while it stays unpushed.
#[test]
fn a_credited_commit_from_an_earlier_call_blocks_the_push_until_it_is_reworded() {
    let e = Env::new("twocalls");
    let (work, _) = pushed_repo(&e);
    std::fs::write(work.join("m.txt"), format!("credited\n\n{CO}\n")).unwrap();
    let w = work.to_str().unwrap();
    let _ = e.hook("echo warm");
    let cmd = "F=m.txt; git commit -q --allow-empty -F \"$F\"";
    assert_eq!(e.hook_in(cmd, w), (String::new(), String::new(), 0), "a commit alone is left to the audit");
    bash_in(&e, &work, cmd);
    let (_, err, code) = e.hook_ev("PostToolUse", cmd, w);
    assert!(code == 2 && err.contains("AI credit"), "audit: {err}");
    let (_, err, code) = e.hook_in(&format!("git {P} origin main"), w);
    assert!(code == 2 && err.contains("AI credit"), "push: {err}");
    bash_in(&e, &work, "git commit -q --amend --allow-empty -m 'feat: clean'");
    assert_eq!(e.hook_in(&format!("git {P} origin main"), w), (String::new(), String::new(), 0), "reworded");
}

/// A fast-forward of credited history a remote already has writes no commit: the audit stays silent (P2 of PR #469).
#[test]
fn a_fast_forward_of_public_credited_history_does_not_trigger_the_audit() {
    let e = Env::new("ffaudit");
    let (work, origin) = pushed_repo(&e);
    // the credited history was written in another clone: this one's reflog only records the fast-forward to it
    let elsewhere = e.dir.join("elsewhere");
    git_ok(&e.dir, &["clone", "-q", origin.to_str().unwrap(), elsewhere.to_str().unwrap()]);
    git_ok(&elsewhere, &["checkout", "-q", "-b", "old"]);
    git_ok(&elsewhere, &["commit", "-q", "--allow-empty", "-m", CREDITED]);
    git_ok(&elsewhere, &["push", "-q", "origin", "old"]);
    git_ok(&work, &["fetch", "-q", "origin"]);
    let w = work.to_str().unwrap();
    let _ = e.hook("echo warm");
    bash_in(&e, &work, "git merge -q origin/old");
    assert_eq!(e.hook_ev("PostToolUse", "git merge -q origin/old", w), (String::new(), String::new(), 0), "ff merge");
    bash_in(&e, &work, "git checkout -q -b re HEAD~1 && git rebase -q origin/old");
    assert_eq!(e.hook_ev("PostToolUse", "git rebase -q origin/old", w), (String::new(), String::new(), 0), "no-op rebase");
}

/// git itself unavailable: the push is let through with an advisory that says it was not checked.
#[test]
fn a_push_fails_open_with_an_advisory_when_git_is_unavailable() {
    let e = Env::new("nogit");
    let (work, _) = pushed_repo(&e);
    git_ok(&work, &["commit", "-q", "--allow-empty", "-m", CREDITED]);
    let w = work.to_str().unwrap();
    let _ = e.hook("echo warm");
    let payload = serde_json::json!({"hook_event_name": "PreToolUse", "tool_name": "Bash", "cwd": w, "session_id": "s", "tool_input": {"command": format!("git {P} origin main")}}).to_string();
    let mut ch =
        e.cmd().env("PATH", e.dir.join("no-git-here")).arg("hook").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    ch.stdin.take().unwrap().write_all(payload.as_bytes()).unwrap();
    let o = ch.wait_with_output().unwrap();
    let out = String::from_utf8_lossy(&o.stdout).to_string();
    assert_eq!(o.status.code(), Some(0), "stdout={out} stderr={}", String::from_utf8_lossy(&o.stderr));
    assert!(out.contains("not checked"), "advisory: {out}");
}

// ---- PR #469 follow-up: -e, unexpandable repo paths, failing git, submodules, annotated tags, the block names the branch ----

/// `-e` (alone or in a short-flag cluster) opens an editor on the -m text: the stored message is unread, so a push in the
/// same call is refused.
#[test]
fn an_edited_message_and_a_push_in_the_same_call_are_refused() {
    let e = Env::new("edit");
    let (work, _) = pushed_repo(&e);
    let w = work.to_str().unwrap();
    let _ = e.hook("echo warm");
    let mut missed = Vec::new();
    for cmd in [
        format!("git commit -q --allow-empty -m clean -e && git {P}"),
        format!("git commit -q --allow-empty -ae -m clean && git {P}"),
        format!("git commit -q --allow-empty -em clean && git {P}"),
        format!("git commit -q --allow-empty --edit -m clean && git {P}"),
    ] {
        let (out, err, code) = e.hook_in(&cmd, w);
        if code != 2 || !err.contains("separate") {
            missed.push(format!("{cmd}: code={code} stdout={out} stderr={err}"));
        }
    }
    assert!(missed.is_empty(), "{missed:#?}");
    for cmd in [format!("git commit -q --allow-empty -m clean --no-edit && git {P}"), format!("git commit -q --allow-empty -am 'feat: edits' && git {P}")] {
        assert_eq!(e.hook_in(&cmd, w), (String::new(), String::new(), 0), "{cmd}");
    }
}

/// A repository path the shell expands at run time cannot be checked before the call: the push is refused and told to use a
/// literal path.
#[test]
fn a_push_to_an_unexpandable_repo_path_is_refused_and_told_to_be_literal() {
    let e = Env::new("dynrepo");
    let (work, _) = pushed_repo(&e);
    git_ok(&work, &["commit", "-q", "--allow-empty", "-m", CREDITED]);
    let w = work.to_str().unwrap();
    let _ = e.hook("echo warm");
    let mut missed = Vec::new();
    for cmd in [
        format!("repo={w}; git -C \"$repo\" {P}"),
        format!("git -C `pwd` {P}"),
        format!("git --git-dir=$D/.git {P}"),
        format!("git --work-tree ~other/x {P}"),
        format!("GIT_DIR=$D/.git git {P}"),
    ] {
        let (out, err, code) = e.hook_in(&cmd, w);
        if code != 2 || !err.contains("literal") {
            missed.push(format!("{cmd}: code={code} stdout={out} stderr={err}"));
        }
    }
    assert!(missed.is_empty(), "{missed:#?}");
    // the same text quoted, or not at command position, is no push
    for cmd in [format!("git commit -q --allow-empty -m 'docs: git -C $(pwd) {P}'"), format!("echo 'git -C `pwd` {P}'")] {
        assert_eq!(e.hook_in(&cmd, w), (String::new(), String::new(), 0), "{cmd}");
    }
}

/// A git query that fails (not a repository) lets the push through with the not-checked advisory, never silently.
#[test]
fn a_push_whose_git_query_fails_gets_the_not_checked_advisory() {
    let e = Env::new("failq");
    let _ = e.hook("echo warm");
    let plain = e.dir.join("plain");
    std::fs::create_dir_all(&plain).unwrap();
    let (out, err, code) = e.hook_in(&format!("git {P} origin main"), plain.to_str().unwrap());
    assert_eq!(code, 0, "stdout={out} stderr={err}");
    assert!(out.contains("not checked"), "a failing git query is an advisory, not a clean pass: {out}");
}

/// A credited commit no remote has inside a submodule is published by a recursing push: the parent's push is refused.
#[test]
fn a_credited_unpushed_commit_in_a_submodule_refuses_the_push() {
    let e = Env::new("submod");
    let (work, _) = pushed_repo(&e);
    let sub_origin = e.dir.join("sub.git");
    let seed = e.dir.join("seed");
    std::fs::create_dir_all(&sub_origin).unwrap();
    std::fs::create_dir_all(&seed).unwrap();
    git_ok(&sub_origin, &["init", "-q", "--bare", "-b", "main"]);
    git_ok(&seed, &["init", "-q", "-b", "main"]);
    git_ok(&seed, &["commit", "-q", "--allow-empty", "-m", "sub base"]);
    git_ok(&seed, &["push", "-q", sub_origin.to_str().unwrap(), "main"]);
    git_ok(&work, &["-c", "protocol.file.allow=always", "submodule", "add", "-q", sub_origin.to_str().unwrap(), "sub"]);
    git_ok(&work, &["commit", "-q", "-m", "add sub"]);
    git_ok(&work, &["push", "-q", "origin", "main"]);
    let w = work.to_str().unwrap();
    let _ = e.hook("echo warm");
    assert_eq!(e.hook_in(&format!("git {P} origin main"), w), (String::new(), String::new(), 0), "clean submodule");
    git_ok(&work.join("sub"), &["commit", "-q", "--allow-empty", "-m", CREDITED]);
    let sha = git_ok(&work.join("sub"), &["rev-parse", "--short", "HEAD"]);
    let (out, err, code) = e.hook_in(&format!("git {P} --recurse-submodules=on-demand origin main"), w);
    assert_eq!(code, 2, "stdout={out} stderr={err}");
    assert!(err.contains("AI credit") && err.contains(&sha), "{err}");
}

/// A local annotated tag whose message carries a credit is published by a tag push: the push is refused, naming the tag.
#[test]
fn a_credited_annotated_tag_message_refuses_the_push() {
    let e = Env::new("tagmsg");
    let (work, _) = pushed_repo(&e);
    // in scope only on a commit no remote has (a tag on an already-public commit is public: round 6)
    git_ok(&work, &["commit", "-q", "--allow-empty", "-m", "release prep"]);
    git_ok(&work, &["tag", "-a", "rel-credit-1", "-m", CREDITED]);
    let w = work.to_str().unwrap();
    let _ = e.hook("echo warm");
    let (out, err, code) = e.hook_in(&format!("git {P} origin rel-credit-1"), w);
    assert_eq!(code, 2, "stdout={out} stderr={err}");
    assert!(err.contains("rel-credit-1"), "the block names the tag: {err}");
    git_ok(&work, &["tag", "-d", "rel-credit-1"]);
    git_ok(&work, &["tag", "-a", "rel-clean-1", "-m", "release 1"]);
    assert_eq!(e.hook_in(&format!("git {P} origin rel-clean-1"), w), (String::new(), String::new(), 0), "clean tag");
}

/// An old credited commit on a branch other than HEAD, pushed by name: the block names that branch and the sha, and never suggests a rebase or a force push.
#[test]
fn the_push_block_names_the_branch_and_never_suggests_a_rebase() {
    let e = Env::new("branchname");
    let (work, _) = pushed_repo(&e);
    git_ok(&work, &["checkout", "-q", "-b", "feat-credit-x"]);
    git_ok(&work, &["commit", "-q", "--allow-empty", "-m", CREDITED]);
    let sha = git_ok(&work, &["rev-parse", "--short", "HEAD"]);
    git_ok(&work, &["checkout", "-q", "main"]);
    let w = work.to_str().unwrap();
    let _ = e.hook("echo warm");
    let (out, err, code) = e.hook_in(&format!("git {P} origin feat-credit-x"), w);
    assert_eq!(code, 2, "stdout={out} stderr={err}");
    assert!(err.contains("feat-credit-x") && err.contains(&sha), "branch and sha named: {err}");
    assert!(err.contains("switch to it") && err.contains("amend") && err.contains("owner"), "the plain fix: {err}");
    assert!(!err.contains("rebase -i") && !err.contains("rebase the"), "never a rebase: {err}");
}

// ---- PR #469 round 6: a fetched (public) credited tag never blocks; a pruned tracking ref blocks once, then advises ----

/// A credited annotated tag fetched from the remote on a public commit does not block an unrelated clean push; one on an
/// unpushed commit does, naming the tag.
#[test]
fn only_annotated_tags_on_unpushed_commits_are_scanned() {
    let e = Env::new("fetchedtag");
    let (work, origin) = pushed_repo(&e);
    let elsewhere = e.dir.join("elsewhere");
    git_ok(&e.dir, &["clone", "-q", origin.to_str().unwrap(), elsewhere.to_str().unwrap()]);
    git_ok(&elsewhere, &["tag", "-a", "pub-credit-1", "-m", CREDITED]);
    git_ok(&elsewhere, &[P, "-q", "origin", "pub-credit-1"]);
    git_ok(&work, &["fetch", "-q", "--tags", "origin"]);
    git_ok(&work, &["commit", "-q", "--allow-empty", "-m", "feat: clean"]);
    let w = work.to_str().unwrap();
    let _ = e.hook("echo warm");
    assert_eq!(e.hook_in(&format!("git {P} origin main"), w), (String::new(), String::new(), 0), "fetched public tag");
    git_ok(&work, &["tag", "-a", "loc-credit-2", "-m", CREDITED]);
    let (out, err, code) = e.hook_in(&format!("git {P} origin main"), w);
    assert_eq!(code, 2, "stdout={out} stderr={err}");
    assert!(err.contains("loc-credit-2") && !err.contains("pub-credit-1"), "names the local tag only: {err}");
}

/// A public credited commit whose remote-tracking ref was pruned looks unpushed: the push is blocked once (naming the sha and
/// "already public"), the identical retry gets an advisory, and a new credited commit still blocks. The acknowledgement is OFF by
/// default (git.push_ack_max_shas = 0), so this test turns it on explicitly.
#[test]
fn a_pruned_tracking_ref_blocks_once_then_advises_on_the_identical_retry() {
    let e = Env::new("pruned");
    e.set_git("push_ack_max_shas", 20);
    let (work, _) = pushed_repo(&e);
    git_ok(&work, &["checkout", "-q", "-b", "old"]);
    git_ok(&work, &["commit", "-q", "--allow-empty", "-m", CREDITED]);
    git_ok(&work, &[P, "-q", "origin", "old"]);
    let sha = git_ok(&work, &["rev-parse", "--short", "HEAD"]);
    git_ok(&work, &["update-ref", "-d", "refs/remotes/origin/old"]);
    git_ok(&work, &["checkout", "-q", "main"]);
    git_ok(&work, &["commit", "-q", "--allow-empty", "-m", "feat: clean"]);
    let w = work.to_str().unwrap();
    // GH #506: the push names `old` (which would send the pruned commit again) and `main` (where the new credit lands)
    let cmd = format!("git {P} origin old main");
    let _ = e.hook("echo warm");
    let (out, err, code) = e.hook_in(&cmd, w);
    assert_eq!(code, 2, "stdout={out} stderr={err}");
    assert!(err.contains(&sha) && err.contains("old") && err.contains("already public"), "first push blocks: {err}");
    let (out, err, code) = e.hook_in(&cmd, w);
    assert_eq!(code, 0, "the identical retry is let through: stdout={out} stderr={err}");
    assert!(out.contains(&sha) && out.contains("AI credit"), "with an advisory naming the sha: {out}");
    let m = String::from_utf8_lossy(&e.cmd().args(["metrics", "--json"]).output().unwrap().stdout).to_string();
    assert!(m.contains("git_push_ack_downgraded"), "the downgrade is counted: {m}");
    git_ok(&work, &["commit", "-q", "--allow-empty", "-m", CREDITED]);
    let new_sha = git_ok(&work, &["rev-parse", "--short", "HEAD"]);
    let (out, err, code) = e.hook_in(&cmd, w);
    assert_eq!(code, 2, "a new credited commit still blocks: stdout={out} stderr={err}");
    assert!(err.contains(&new_sha) && !err.contains(&sha), "only the new sha: {err}");
}

/// The acknowledgement is OFF by default (git.push_ack_max_shas = 0): a push blocked for a credited commit is blocked again on the
/// identical retry, so an agent retrying a blocked push never gets a credit line through.
#[test]
fn by_default_an_identical_retry_of_a_credit_blocked_push_is_blocked_again() {
    let e = Env::new("ackoff");
    let (work, _) = pushed_repo(&e);
    git_ok(&work, &["commit", "-q", "--allow-empty", "-m", CREDITED]);
    let sha = git_ok(&work, &["rev-parse", "--short", "HEAD"]);
    let w = work.to_str().unwrap();
    let cmd = format!("git {P} origin main");
    let _ = e.hook("echo warm");
    for n in 1..=3 {
        let (out, err, code) = e.hook_in(&cmd, w);
        assert_eq!(code, 2, "try {n} still blocks: stdout={out} stderr={err}");
        assert!(err.contains(&sha) && err.contains("already public or other: tell the owner"), "try {n}: {err}");
    }
}

// ---- PR #469 round 8: a script run by path, a continued or editor merge with a push in the same call ----

/// A script run by a literal path is scanned like a commit message: a credit line on any line denies and names the file and
/// line; a commit whose message layer 1 cannot read plus a push in the script is refused; a clean script runs; a missing,
/// oversized or non-literal one is let through with an advisory.
#[test]
fn a_script_run_by_path_is_scanned_for_credit_lines() {
    let e = Env::new("script");
    let (work, _) = pushed_repo(&e);
    let w = work.to_str().unwrap();
    std::fs::create_dir_all(work.join("sub")).unwrap();
    let credited = format!("#!/bin/sh\ngit commit -q --allow-empty -m \"x\\n\\n{CO}\"\ngit {P} -q origin main\n");
    std::fs::write(work.join("publish.sh"), &credited).unwrap();
    std::fs::write(work.join("sub/publish.sh"), &credited).unwrap();
    std::fs::write(work.join("m.txt"), "feat: from a file\n").unwrap();
    std::fs::write(work.join("unread.sh"), format!("#!/bin/sh\ngit commit -q --allow-empty -F m.txt\ngit {P} -q origin main\n")).unwrap();
    std::fs::write(work.join("clean.sh"), format!("#!/bin/sh\ngit commit -q --allow-empty -m 'feat: plain'\ngit {P} -q origin main\n")).unwrap();
    std::fs::write(work.join("big.sh"), format!("#!/bin/sh\n{}git {P}\n", "# padding line\n".repeat(40_000))).unwrap();
    let _ = e.hook("echo warm");
    let mut missed = Vec::new();
    for (cmd, cwd) in [
        ("bash publish.sh".to_string(), w),
        ("sh publish.sh".to_string(), w),
        ("zsh publish.sh".to_string(), w),
        ("./publish.sh".to_string(), w),
        ("source publish.sh".to_string(), w),
        (". ./publish.sh".to_string(), w),
        ("bash sub/publish.sh".to_string(), w),
        (format!("cd {w} && bash publish.sh"), "/tmp"),
    ] {
        let (out, err, code) = e.hook_in(&cmd, cwd);
        if code != 2 || !err.contains("publish.sh") || !err.contains("line 2") {
            missed.push(format!("{cmd}: code={code} stdout={out} stderr={err}"));
        }
    }
    let (out, err, code) = e.hook_in("bash unread.sh", w);
    if code != 2 || !err.contains("separate") {
        missed.push(format!("unread: code={code} stdout={out} stderr={err}"));
    }
    assert!(missed.is_empty(), "{missed:#?}");
    assert_eq!(e.hook_in("bash clean.sh", w), (String::new(), String::new(), 0), "clean script");
    for cmd in ["bash nope.sh", "bash big.sh", "S=publish.sh; bash \"$S\""] {
        let (out, err, code) = e.hook_in(cmd, w);
        assert!(code == 0 && out.contains("not checked"), "{cmd}: advisory, not a block: code={code} stdout={out} stderr={err}");
    }
}

/// An inert mention of credit text (a comment line, a grep of a pattern, a script that never commits or pushes) is no credit
/// line: only a script that commits, tags, merges or pushes AND carries the text where it can reach a message is refused.
#[test]
fn an_inert_credit_mention_in_a_script_is_allowed_and_a_credited_message_literal_is_still_denied() {
    let e = Env::new("inert");
    let (work, _) = pushed_repo(&e);
    let w = work.to_str().unwrap();
    std::fs::write(
        work.join("comment.sh"),
        format!("#!/bin/sh\n# Generated with Claude Code\n  # {CO}\ngit commit -q --allow-empty -m 'feat: plain'\ngit {P} -q origin main\n"),
    )
    .unwrap();
    std::fs::write(work.join("grep.sh"), format!("#!/bin/sh\ngit log -1 --format=%B | grep -q 'Generated with Claude' && exit 1\ngit commit -q --allow-empty -m 'feat: plain'\ngit {P} -q origin main\n")).unwrap();
    std::fs::write(work.join("nogit.sh"), format!("#!/bin/sh\necho \"{CO}\" > notes.txt\n")).unwrap();
    std::fs::write(work.join("literal.sh"), format!("#!/bin/sh\n# plain header\ngit commit -q --allow-empty -m \"x\\n\\n{CO}\"\ngit {P} -q origin main\n"))
        .unwrap();
    let _ = e.hook("echo warm");
    for f in ["comment.sh", "grep.sh", "nogit.sh"] {
        assert_eq!(e.hook_in(&format!("bash {f}"), w), (String::new(), String::new(), 0), "{f} is inert");
    }
    let (out, err, code) = e.hook_in("bash literal.sh", w);
    assert!(code == 2 && err.contains("literal.sh") && err.contains("line 3"), "credited literal: code={code} stdout={out} stderr={err}");
}

/// PR #469 round 10 (P2-1): a script run by path that publishes a body with a gh command (no git command) is scanned like the
/// direct command: a credited --body/--notes/--body-file is denied, a clean one runs.
#[test]
fn a_gh_publishing_command_in_a_script_run_by_path_is_scanned_for_credit() {
    let e = Env::new("ghscript");
    let (work, _) = pushed_repo(&e);
    let w = work.to_str().unwrap();
    std::fs::write(work.join("credit.md"), format!("body\n\n{CO}\n")).unwrap();
    std::fs::write(work.join("clean.md"), "body only\n").unwrap();
    let cases = [
        ("pr_create.sh", format!("#!/bin/sh\ngh pr create --title t --body \"fix\\n\\n{CO}\"\n"), true),
        ("issue_create.sh", format!("#!/bin/sh\ngh issue create --title t --body \"x {CO}\"\n"), true),
        ("release.sh", format!("#!/bin/sh\ngh release create v1 --notes \"x {CO}\"\n"), true),
        ("pr_edit.sh", format!("#!/bin/sh\ngh pr edit 1 --body \"x {CO}\"\n"), true),
        ("pr_comment.sh", format!("#!/bin/sh\ngh pr comment 1 --body \"x {CO}\"\n"), true),
        ("issue_comment.sh", format!("#!/bin/sh\ngh issue comment 1 --body \"x {CO}\"\n"), true),
        ("bodyfile.sh", "#!/bin/sh\ngh pr create --title t --body-file credit.md\n".to_string(), true),
        ("notesfile.sh", "#!/bin/sh\ngh release create v1 --notes-file credit.md\n".to_string(), true),
        ("clean_create.sh", "#!/bin/sh\ngh pr create --title t --body \"plain body\"\n".to_string(), false),
        ("clean_file.sh", "#!/bin/sh\ngh pr create --title t --body-file clean.md\n".to_string(), false),
    ];
    for (f, body, _) in &cases {
        std::fs::write(work.join(f), body).unwrap();
    }
    let _ = e.hook("echo warm");
    let mut bad = Vec::new();
    for (f, _, deny) in &cases {
        let (out, err, code) = e.hook_in(&format!("bash {f}"), w);
        if *deny != (code == 2 && err.contains(f)) {
            bad.push(format!("{f}: deny={deny} code={code} stdout={out} stderr={err}"));
        }
    }
    assert!(bad.is_empty(), "{bad:#?}");
}

/// PR #469 round 10 (P2-2): a line starting with grep is inert only when it is a plain grep; a grep that pipes, takes a
/// here-string, a process substitution, a redirection, a command substitution or continues with && / ; is live.
#[test]
fn a_grep_line_that_pipes_into_a_commit_is_live_and_a_plain_grep_check_is_inert() {
    let e = Env::new("griplive");
    let (work, _) = pushed_repo(&e);
    let w = work.to_str().unwrap();
    let credit_line = format!("grep -v '^$' <<< $'subject\\n{CO}' | git commit -q --allow-empty -F -");
    std::fs::write(work.join("pipe.sh"), format!("#!/bin/bash\n{credit_line}\n")).unwrap();
    std::fs::write(work.join("semi.sh"), format!("#!/bin/bash\ngrep -q x f ; git commit -q --allow-empty -m \"x\\n\\n{CO}\"\n")).unwrap();
    std::fs::write(
        work.join("harmless.sh"),
        format!("#!/bin/sh\ngrep -n \"{CO}\" notes.txt\ngit commit -q --allow-empty -m 'feat: plain'\ngit {P} -q origin main\n"),
    )
    .unwrap();
    let _ = e.hook("echo warm");
    for f in ["pipe.sh", "semi.sh"] {
        let (out, err, code) = e.hook_in(&format!("bash {f}"), w);
        assert!(code == 2 && err.contains(f), "{f} must be denied: code={code} stdout={out} stderr={err}");
    }
    assert_eq!(e.hook_in("bash harmless.sh", w), (String::new(), String::new(), 0), "harmless grep line is inert");
}

/// `link/..` is resolved by the kernel, so with link -> /other/sub, `bash link/../publish.sh` runs /other/publish.sh: that
/// file is the one scanned, not /repo/publish.sh.
#[test]
fn a_script_path_through_a_symlink_and_dotdot_scans_the_file_that_runs() {
    let e = Env::new("symdd");
    let (work, _) = pushed_repo(&e);
    let w = work.to_str().unwrap();
    let other = e.dir.join("other");
    std::fs::create_dir_all(other.join("sub")).unwrap();
    std::os::unix::fs::symlink(other.join("sub"), work.join("link")).unwrap();
    std::fs::write(other.join("publish.sh"), format!("#!/bin/sh\ngit commit -q --allow-empty -m \"x\\n\\n{CO}\"\ngit {P} -q origin main\n")).unwrap();
    std::fs::write(work.join("publish.sh"), "#!/bin/sh\ngit commit -q --allow-empty -m 'feat: plain'\n").unwrap();
    let _ = e.hook("echo warm");
    let (out, err, code) = e.hook_in("bash link/../publish.sh", w);
    assert!(code == 2 && err.contains("publish.sh") && err.contains("line 2"), "symlink + dotdot: code={code} stdout={out} stderr={err}");
}

/// A continued merge, rebase, cherry-pick or revert, a merge without -m and a revert without --no-edit take a message layer 1
/// cannot read (a prepared MERGE_MSG): a push in the same call is refused; alone, or with a literal message, they run.
#[test]
fn a_continued_or_prepared_merge_message_and_a_push_in_the_same_call_are_refused() {
    let e = Env::new("contmerge");
    let (work, _) = pushed_repo(&e);
    let w = work.to_str().unwrap();
    let _ = e.hook("echo warm");
    let mut missed = Vec::new();
    for cmd in [
        format!("git merge --continue && git {P}"),
        format!("git rebase --continue && git {P}"),
        format!("git cherry-pick --continue && git {P}"),
        format!("git revert --continue && git {P}"),
        format!("git merge origin/x && git {P}"),
        format!("git revert HEAD && git {P}"),
    ] {
        let (out, err, code) = e.hook_in(&cmd, w);
        if code != 2 || !err.contains("separate") {
            missed.push(format!("{cmd}: code={code} stdout={out} stderr={err}"));
        }
    }
    assert!(missed.is_empty(), "{missed:#?}");
    for cmd in [
        "git merge --continue".to_string(),
        format!("git merge x -m \"plain\" && git {P}"),
        format!("git revert --no-edit HEAD && git {P}"),
        format!("git merge --ff-only origin/main && git {P}"),
        format!("git merge --abort && git {P}"),
    ] {
        assert_eq!(e.hook_in(&cmd, w), (String::new(), String::new(), 0), "{cmd}");
    }
}

/// GH #506 / PR #524 review (P1): the narrowed scan reads git configuration and HEAD before the call has run anything, so an
/// earlier part of the same Bash call that changes what the push publishes must keep the repository-wide scan. The repository is a
/// clean `main` and another branch `credited`; every command below is judged on real hook input and must be refused with the credit.
#[test]
fn an_earlier_part_of_the_same_call_that_changes_what_the_push_publishes_keeps_the_wide_scan() {
    let e = Env::new("scope_chain");
    let (work, _) = pushed_repo(&e);
    git_ok(&work, &["branch", "credited"]);
    git_ok(&work, &["checkout", "-q", "credited"]);
    git_ok(&work, &["commit", "-q", "--allow-empty", "-m", CREDITED]);
    git_ok(&work, &["checkout", "-q", "main"]);
    let w = work.to_str().unwrap();
    let _ = e.hook("echo warm");
    let mut cmds: Vec<String> = Vec::new();
    for sep in ["&&", ";", "||"] {
        cmds.push(format!("git config remote.origin.mirror true {sep} git {P} origin"));
        cmds.push(format!("git config remote.origin.{P} credited {sep} git {P} origin"));
        cmds.push(format!("git switch credited {sep} git {P} origin HEAD:refs/heads/x"));
    }
    cmds.extend([
        format!("git -c remote.origin.mirror=true {P} origin"),
        format!("sh -c 'git config remote.origin.mirror true; git {P} origin'"),
        format!("f() {{ git config remote.origin.mirror true; git {P} origin; }}; f"),
        format!("f() {{ git config remote.origin.mirror true; git {P} origin; }} && f"),
        format!("git switch credited; git {P} origin HEAD:x"),
        format!("git switch credited & git {P} origin HEAD:x"),
        format!("git switch credited | cat; git {P} origin HEAD:x"),
        format!("$(git switch credited) && git {P} origin HEAD:x"),
        format!("`git switch credited` && git {P} origin HEAD:x"),
        format!("eval 'git switch credited' && git {P} origin HEAD:x"),
        format!("source ./setup.sh && git {P} origin HEAD:x"),
        format!("alias g='git switch credited' && g && git {P} origin HEAD:x"),
        format!("git checkout credited && git {P} origin HEAD:x && git {P} origin main"),
        format!("GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=remote.origin.mirror GIT_CONFIG_VALUE_0=true git {P} origin"),
        format!("GIT_DIR={w}/.git git {P} origin HEAD:x"),
        format!("git -c remote.origin.{P}=credited {P} origin"),
        format!("cd {w} && git config remote.origin.mirror true && git {P} origin"),
        format!("cd - && git {P} origin HEAD:x"),
    ]);
    let mut missed = Vec::new();
    for cmd in &cmds {
        let (out, err, code) = e.hook_in(cmd, w);
        if code != 2 || !err.contains("AI credit") {
            missed.push(format!("{cmd}: code={code} stdout={out} stderr={err}"));
        }
    }
    assert!(missed.is_empty(), "{missed:#?}");
    let m = String::from_utf8_lossy(&e.cmd().args(["metrics", "--json"]).output().unwrap().stdout).to_string();
    assert!(m.contains("git_push_narrow_unproven"), "the wide reads are counted: {m}");
}

/// GH #506 / PR #524 review: the common case still narrows. The repository holds 60 unpushed commits on other branches (more than
/// the cap); a plain push of `main`, alone or after `cd <path> &&`, is judged only on the commits it sends.
#[test]
fn a_plain_push_alone_or_after_a_cd_still_narrows_with_sixty_unpushed_commits_elsewhere() {
    let e = Env::new("scope_plain");
    let (work, origin) = pushed_repo(&e);
    git_ok(&work, &["checkout", "-q", "-b", "big"]);
    for i in 0..60 {
        git_ok(&work, &["commit", "-q", "--allow-empty", "-m", &format!("big {i}")]);
    }
    git_ok(&work, &["checkout", "-q", "main"]);
    let w = work.to_str().unwrap();
    let o = origin.to_str().unwrap().to_string(); // the session directory: a repository other than the one pushed from
    let _ = e.hook("echo warm");
    for (cmd, cwd) in [
        (format!("git {P} origin main"), w.to_string()),
        (format!("cd {w} && git {P} origin main"), o.clone()),
        (format!("cd {w} && git {P} origin"), o.clone()),
    ] {
        assert_eq!(e.hook_in(&cmd, &cwd), (String::new(), String::new(), 0), "{cmd}");
    }
    // the same call with a second git command is read whole: 60 commits is over the cap
    let (_, err, code) = e.hook_in(&format!("git status && git {P} origin main"), w);
    assert_eq!(code, 2, "{err}");
    assert!(err.contains("more than 50 local commits"), "{err}");
}
