//! W6: command delegation permits safe JSON reads, lightweight gh bookkeeping and pushes.
//! It still rejects computed filesystem writes and sensitive gh mutations.
//! The independent git safety check owns force-push rejection.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use serde_json::json;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

fn plugin() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall")
}

fn git(dir: &Path, args: &[&str]) {
    let o = Command::new("git").arg("-C").arg(dir).args(["-c", "user.name=t", "-c", "user.email=t@example.invalid"]).args(args).output().unwrap();
    assert!(o.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&o.stderr));
}

/// (exit code, stderr) of `ah-engine check command` for one Bash command run as the main thread from `cwd`.
fn verdict(dir: &Path, home: &Path, cwd: &Path, command: &str) -> (i32, String) {
    verdict_on(dir, home, cwd, command, false)
}

/// Same, on a Codex payload (`turn_id` + `model`) when `codex` is set.
fn verdict_on(dir: &Path, home: &Path, cwd: &Path, command: &str, codex: bool) -> (i32, String) {
    let mut payload = json!({"hook_event_name": "PreToolUse", "tool_name": "Bash", "session_id": "w6", "cwd": cwd, "tool_input": {"command": command}});
    if codex {
        payload["turn_id"] = json!("t1");
        payload["model"] = json!("gpt-5");
    }
    let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
    c.args(["check", "command"])
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("HOME", home)
        .env("AH_ENGINE_DIR", dir.join("state"))
        .env("AH_ENGINE_NOSPAWN", "1")
        // This decision test launches git helpers; cold CI scheduling is not a script deadline test.
        .env("AH_ENGINE_SCRIPT_TIME_MS", "2000")
        .env("ANTIHALL_TEST_ISOLATION", "1")
        .env("AH_ENGINE_PLUGIN_ROOT", plugin())
        .env("CLAUDE_PLUGIN_ROOT", plugin())
        .current_dir(dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if !codex {
        c.env("CLAUDE_CODE_ENTRYPOINT", "cli"); // a Codex main thread carries no entrypoint (coordinator-detect.js isCoordinator)
    }
    let mut ch = c.spawn().unwrap();
    ch.stdin.take().unwrap().write_all(payload.to_string().as_bytes()).unwrap();
    let o = ch.wait_with_output().unwrap();
    let mut err = String::from_utf8_lossy(&o.stderr).into_owned();
    if !err.is_empty() {
        // Detailed justifications live beside the bounded hook brief.
        err.push_str(&std::fs::read_to_string(home.join(".anti-hall/block-details/command-guard-w6.md")).unwrap_or_default());
    }
    (o.status.code().unwrap_or(-1), err)
}

#[test]
fn single_small_state_changing_commands_are_allowed_and_the_real_cases_still_block() {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("w6-cmd-{}", std::process::id()));
    ah_engine::discard::harmless(std::fs::remove_dir_all(&dir));
    std::fs::create_dir_all(dir.join("home")).unwrap();
    let home = dir.join("home").canonicalize().unwrap();
    let (bare, main, wt2) = (home.join("remote.git"), home.join("main"), home.join("wt2"));
    assert!(Command::new("git").args(["init", "-q", "--bare"]).arg(&bare).status().unwrap().success());
    assert!(Command::new("git").args(["init", "-q", "-b", "base"]).arg(&main).status().unwrap().success());
    git(&main, &["commit", "-q", "--allow-empty", "-m", "x"]);
    git(&main, &["remote", "add", "origin", bare.to_str().unwrap()]);
    git(&main, &["branch", "main"]); // a local main exists: it still must not be carved out
    git(&main, &["worktree", "add", "-q", "-b", "feat2", wt2.to_str().unwrap()]);
    let skip = home.join("skip.json");
    std::fs::write(&skip, "{}").unwrap();

    let allowed = |c: &str| {
        let (code, err) = verdict(&dir, &home, &main, c);
        assert_eq!((code, err.as_str()), (0, ""), "should be allowed: {c}");
    };
    let blocked = |c: &str| {
        let (code, err) = verdict(&dir, &home, &main, c);
        assert!(code == 2 && err.contains("⛔ command check:"), "should be blocked: {c} -> {code} {err}");
    };
    allowed(&format!(r#"node -e 'const j=require("{}");console.log(j["git-guard"], j.plugins["anti-hall@anti-hall"])'"#, skip.display()));

    // #256 / #263 (owner decision): filing and tending issues, labels and pull requests (command.gh_light_writes) and `cargo clean` are
    // bookkeeping, not floods, whatever the body. Merge, release, repo settings, secrets and gh api writes stay blocked, for a stated reason.
    allowed(r#"gh issue create --repo o/r --title "x (y)" --body-file /tmp/f.md"#);
    allowed(&format!("cd {} && gh issue create --repo o/r --title x --body-file /tmp/f.md 2>&1 | tail -1", main.display()));
    allowed("gh issue comment 5 --repo o/r --body-file /tmp/f.md");
    allowed("cargo clean");
    blocked("cargo build");
    blocked("cargo clean && cargo build");
    // Push is no longer a heavy delegation verb (command.git_heavy_subs).
    // The independent git safety check, covered by gitcheck, owns force-push rejection.
    allowed("git push -u origin feat2");
    allowed("git push origin feat2");
    allowed("git push -u origin main");
    allowed("git push -u origin no-such-branch");
    allowed("git push --force origin feat2");
    allowed("git push origin +feat2");
    blocked(r#"node -e 'require("fs")["writeFileSync"]("/tmp/x","y")'"#);
    blocked(r#"node -e 'require("fs")["write"+"FileSync"]("/tmp/x","y")'"#);
    blocked("gh issue delete 5");

    // #263: every light pair passes (inline body, global -R flag, tail, per-segment chain); on both hosts
    for codex in [false, true] {
        let ok = |c: &str| {
            let (code, err) = verdict_on(&dir, &home, &main, c, codex);
            assert_eq!((code, err.as_str()), (0, ""), "codex={codex} should be allowed: {c}");
        };
        let no = |c: &str, why: Option<&str>| {
            let (code, err) = verdict_on(&dir, &home, &main, c, codex);
            assert!(code == 2 && err.contains("⛔ command check:"), "codex={codex} should be blocked: {c} -> {code} {err}");
            if let Some(w) = why {
                assert!(err.contains(w) && (w == "flood" || !err.contains("flood")), "codex={codex} wrong reason for {c}: {err}");
            }
        };
        for c in [
            r#"gh issue create --repo o/r --title "x" --body "inline body with (parens) and 'quotes'""#,
            "gh issue comment 5 -R o/r --body hi",
            "gh issue edit 5 --add-label bug",
            "gh issue close 5 --comment done",
            "gh issue reopen 5",
            "gh label create bug --color ff0000",
            "gh label edit bug --description x",
            r#"gh pr create --repo o/r --title "x" --body "inline""#,
            "gh pr comment 5 --body hi",
            "gh pr edit 5 --title y",
            "gh -R o/r issue create --title x --body y",
            "gh --repo o/r pr comment 5 --body y",
            "gh issue create --title x --body y | tail -1",
            "ls && gh issue create --title x --body y",
        ] {
            ok(c);
        }
        let reason = Some("hard to undo or sensitive");
        for c in [
            "gh pr merge 5 --squash",
            "gh -R o/r pr merge 5",
            "gh release create v1 --notes x",
            "gh release upload v1 a.zip",
            "gh repo edit --visibility private",
            "gh repo delete o/r --yes",
            "gh secret set TOKEN --body x",
            "gh secret delete TOKEN",
            "gh api -X POST repos/o/r/issues",
            "gh api --method PUT repos/o/r/x",
            "gh api -X PATCH repos/o/r/x",
            "gh api -X DELETE repos/o/r/x",
            "ls && gh pr merge 5",
            "gh issue create --title x --body y && gh pr merge 5",
        ] {
            no(c, reason);
        }
        no("gh issue delete 5", None);
        // gcloud / kubectl are unchanged: their reads pass, their writes keep the flood reason
        ok("kubectl get pods");
        no("kubectl apply -f x.yaml", Some("flood"));
        no("gcloud run deploy svc", Some("flood"));
    }

    // #263: the owner's config.toml adds to / removes from the shipped lists (effective = shipped - remove + add), no shipped-file edit.
    let cfg = dir.join("state").join("config.toml");
    std::fs::create_dir_all(cfg.parent().unwrap()).unwrap();
    // add: another binary's allow, and a block that overrides a shipped allow (block wins)
    std::fs::write(&cfg, "[command]\nremote_allow_add = [\"kubectl apply\"]\nremote_block_add = [\"gh pr comment\"]\n").unwrap();
    allowed("kubectl apply -f x.yaml");
    blocked("gh pr comment 5 --body hi");
    allowed("gh issue create --title x --body y"); // the shipped allows stay
    // remove: a shipped allow falls back to the default rule; a shipped block stops blocking (default rule: gh release view is a read)
    std::fs::write(&cfg, "[command]\nremote_allow_remove = [\"gh pr create\"]\nremote_block_remove = [\"gh secret\"]\n").unwrap();
    blocked(r#"gh pr create --title x --body y"#);
    allowed("gh issue create --title x --body y");
    allowed("gh secret list");
    // both together
    std::fs::write(&cfg, "[command]\nremote_allow_add = [\"gh pr create\"]\nremote_allow_remove = [\"gh pr create\", \"gh issue create\"]\n").unwrap();
    allowed("gh pr create --title x --body y"); // removed then added back
    blocked("gh issue create --title x --body y");
    ah_engine::discard::harmless(std::fs::remove_dir_all(&dir));
}
