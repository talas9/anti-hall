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
    let shapes = [
        ("credited branch not at HEAD", format!("git {P} origin main")),
        ("bare push", format!("git {P}")),
        ("matching refspec", format!("git {P} origin :")),
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
    // a credited commit only a custom ref holds (published by a mirror or a refs/* refspec) counts too
    git_ok(&work, &["branch", "-q", "-D", "other"]);
    let sha = git_ok(&work, &["commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", CREDITED]);
    git_ok(&work, &["update-ref", "refs/custom/x", &sha]);
    let (out, err, code) = e.hook_in(&format!("git {P} origin main"), w);
    if code != 2 || !err.contains("AI credit") {
        missed.push(format!("custom ref: code={code} stdout={out} stderr={err}"));
    }
    assert!(missed.is_empty(), "{missed:#?}");
    // nothing credited left unpushed: every shape is allowed again
    git_ok(&work, &["update-ref", "-d", "refs/custom/x"]);
    git_ok(&work, &["commit", "-q", "--allow-empty", "-m", "feat: ordinary"]);
    for (name, cmd) in &shapes {
        assert_eq!(e.hook_in(cmd, w), (String::new(), String::new(), 0), "{name}: {cmd}");
    }
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
    let mut ch = e.cmd().env("PATH", e.dir.join("no-git-here")).arg("hook").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    ch.stdin.take().unwrap().write_all(payload.as_bytes()).unwrap();
    let o = ch.wait_with_output().unwrap();
    let out = String::from_utf8_lossy(&o.stdout).to_string();
    assert_eq!(o.status.code(), Some(0), "stdout={out} stderr={}", String::from_utf8_lossy(&o.stderr));
    assert!(out.contains("not checked"), "advisory: {out}");
}
