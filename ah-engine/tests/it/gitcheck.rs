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
        let rules = r#"{"version":1,"rules":[{"id":"git-guard","events":["PreToolUse"],"tools":["Bash"],"check":"git","action":"deny","options":{"plugin_root":"/plugin"}}]}"#;
        std::fs::write(dir.join("rules.json"), rules).unwrap();
        Env { dir }
    }

    fn cmd(&self) -> Command {
        let mut c = Command::new(BIN);
        c.env("HOME", self.dir.join("home"))
            // an external CARGO_TARGET_DIR cannot find the checkout by walking up from the executable
            .env("AH_ENGINE_PLUGIN_ROOT", std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall"))
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
        let payload =
            serde_json::json!({"hook_event_name": "PreToolUse", "tool_name": "Bash", "cwd": cwd, "session_id": "s", "tool_input": {"command": command}})
                .to_string();
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
fn a_push_is_checked_on_the_refs_it_publishes_not_on_head() {
    let e = Env::new("refs");
    let (work, _) = pushed_repo(&e);
    git_ok(&work, &["checkout", "-q", "-b", "feature"]);
    git_ok(&work, &["commit", "-q", "--allow-empty", "-m", CREDITED]);
    git_ok(&work, &["checkout", "-q", "main"]);
    let w = work.to_str().unwrap();
    let _ = e.hook("echo warm");
    for cmd in ["git push origin feature", "git push --all origin", "git push origin feature:main", "git push -u origin feature"] {
        let (out, err, code) = e.hook_in(cmd, w);
        assert_eq!(code, 2, "{cmd}: stdout={out} stderr={err}");
        assert!(err.contains("reword"), "{cmd}: {err}");
    }
    // the clean branch HEAD is on is allowed although another branch carries a credit
    assert_eq!(e.hook_in("git push origin main", w), (String::new(), String::new(), 0));
    assert_eq!(e.hook_in("git push", w), (String::new(), String::new(), 0));
    // a remote that was never fetched: HEAD:dev from a credited HEAD
    let other = e.dir.join("other.git");
    std::fs::create_dir_all(&other).unwrap();
    git_ok(&other, &["init", "-q", "--bare", "-b", "main"]);
    git_ok(&work, &["remote", "add", "newremote", other.to_str().unwrap()]);
    git_ok(&work, &["checkout", "-q", "feature"]);
    let (out, err, code) = e.hook_in("git push newremote HEAD:dev", w);
    assert_eq!(code, 2, "stdout={out} stderr={err}");
}

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
    assert!(err.contains("more than 50 commits"), "{err}");
}
