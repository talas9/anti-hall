//! #969 R1 parity: the prefilter never answers allow where the full check would have said anything. Held over the git guard's
//! golden corpus (its recorded answers), every Bash PreToolUse case of every other golden corpus (the git check run on it), the
//! capacity-hold corpus (every must-hold shape stays with the full check, every passed one is run) and the shapes the git guard
//! reads behind wrappers, runners, aliases, functions, nested shells and redirections.
use super::*;
use crate::checks::Verdict;
use serde_json::json;

/// Whether the git check, run on `command` from `cwd`, said nothing (a quiet allow).
fn git_quiet(command: &str, cwd: &str) -> bool {
    let p = json!({"session_id": "s-prefilter", "cwd": cwd, "hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": command}});
    let opts = json!({ "plugin_root": "/nonexistent-plugin" });
    let env = crate::reqenv::RequestEnv::default();
    matches!(crate::script::run_forced("git", &p, &opts, "PreToolUse", &env), Some(Some(Verdict::Allow)))
}

#[test]
fn plain_reads_of_listed_commands_skip_the_git_check() {
    for c in [
        "ls -la",
        "cat README.md | head -5",
        "/usr/bin/grep -rn foo src && wc -l Cargo.toml",
        "cd ah-engine && ls src; pwd",
        "rg -n 'fn main' src | sort | uniq -c",
        "ps -o pid,command -p 123",
        "jq .version plugin.json",
        "git status",
        "cd /x && git log --oneline -5 2>/dev/null | head -3",
        "git -C /x diff --stat HEAD~1 2>&1 | tail -5",
        "ls $HOME/x 2>/dev/null; echo done",
        "git --no-pager show HEAD:README.md",
        "gh pr view 12 --json title -q .title",
        "gh run list --limit 5",
        "echo commit",
        "N=5; ls | head -$N",
    ] {
        assert!(read_only_for("git", c), "{c}: a plain read of listed commands");
        assert!(git_quiet(c, "/"), "{c}: the git check says nothing here either");
    }
}

#[test]
fn every_shape_the_git_guard_reads_runs_the_check() {
    for c in [
        "git push --force origin main",
        "git -c core.pager=x log",
        "git -C /x -c core.pager=x log",
        "git log --output=/tmp/x",
        "git config alias.x '!sh'",
        "git fetch --upload-pack=x",
        "git grep -O x",
        "git status > out.txt",
        "git status 2>out.txt",
        "git branch -D x",
        "git st",
        "git -C /x push",
        "git --git-dir=/x status",
        "git",
        "ls 2>/dev/null; rm -rf ~/.claude/plugins/x",
        "ls 2>/dev/null|xargs rm",
        "ls 2>/dev/null&&cp a b",
        "ls ${X:-$(git push -f)}",
        "ls ${X//a/b}",
        "cat $(echo x)",
        "echo \"x; git tag -m 'Generated with Claude'\"",
        "echo 'git log' ; ls",
        "grep -n git src/x.rs",
        "git log | grep git",
        "echo x; git commit -m y",
        "git status; git tag v1",
        "ah-engine status | sort -o /tmp/x/out",
        "GIT_PAGER=x; git log",
        "PATH=/x; ls",
        "HOME=/x; ls ~",
        "gh api repos/x/y",
        "gh pr create --title x --body y",
        "gh pr comment 1 --body y",
        "echo 'gh pr create'; ls",
        "gh -R x/y pr merge 1",
        "\\git push -f",
        "g\"i\"t push -f",
        "gh pr create --body x",
        "ls; git push -f",
        "ls && sh -c 'git push -f'",
        "bash -c 'ls'",
        "eval ls",
        "env -S 'git push -f'",
        "xargs git push -f",
        "find . -exec git push -f \\;",
        "alias ls='git push -f'; ls",
        "f(){ git push -f; }; f",
        "f() { ls; }; f",
        "echo x > ~/.claude/plugins/anti-hall/bin/ah-hook",
        "echo x >> out.txt",
        "cat <<EOF\nx\nEOF",
        "ls $(git push -f)",
        "ls `git push -f`",
        "cp a b",
        "mv a b",
        "tee x",
        "sed -i s/a/b/ x",
        "awk 'BEGIN{system(\"git push -f\")}'",
        "grep \"exec 'git push -f'\" x",
        "grep push x",
        "./run.sh",
        "bash x.sh",
        "source x.sh",
        "zzalias920 status",
        "FOO=1 ls",
        "PATH=/tmp/evil ls",
        "ls; x[1]=2",
        "rg --pre 'git push -f' p",
        "rg --pre=/tmp/x p",
        "sort --compress-program=/tmp/x f",
        "/tmp/bin/ls",
        "./ls",
        "ls & rm -rf x",
        "ls | xargs rm",
        "sudo ls",
        "nice ls",
        "timeout 5 ls",
        "",
        "   ",
    ] {
        assert!(!read_only_for("git", c), "{c:?} must run the git check");
    }
    // a check with no positive list is never skipped
    assert!(!read_only_for("command", "ls"));
    assert!(!read_only_for("no-such-check", "ls"));
}

#[test]
fn the_git_golden_corpus_agrees_with_the_prefilter() {
    let cases = crate::script::golden::load("git");
    let (mut passed, mut total) = (0, 0);
    for case in &cases {
        let p = case.get("payload").unwrap_or(&Value::Null);
        if case.get("event").and_then(Value::as_str) != Some("PreToolUse") || p.get("tool_name").and_then(Value::as_str) != Some("Bash") {
            continue;
        }
        let Some(cmd) = p.get("tool_input").and_then(|i| i.get("command")).and_then(Value::as_str) else { continue };
        total += 1;
        if read_only_for("git", cmd) {
            passed += 1;
            let v = case.get("expect").and_then(|e| e.get("v")).and_then(Value::as_str);
            assert_eq!(v, Some("allow"), "case {:?}: the prefilter passes {cmd:?} but the git guard answered {v:?}", case.get("n"));
        }
    }
    assert!(total > 500, "the corpus was read: {total} Bash cases");
    eprintln!("git golden: {passed} of {total} Bash cases prefiltered");
}

#[test]
fn every_bash_case_of_the_other_goldens_agrees_with_the_git_check() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden");
    let (mut passed, mut total) = (0, 0);
    let mut names: Vec<String> = std::fs::read_dir(&dir)
        .unwrap()
        .flatten()
        .filter_map(|e| e.file_name().to_str().and_then(|n| n.strip_suffix(".jsonl")).map(str::to_string))
        .filter(|n| n != "git")
        .collect();
    names.sort();
    for name in names {
        for case in crate::script::golden::load(&name) {
            let p = case.get("payload").unwrap_or(&Value::Null);
            if case.get("event").and_then(Value::as_str) != Some("PreToolUse") || p.get("tool_name").and_then(Value::as_str) != Some("Bash") {
                continue;
            }
            let Some(cmd) = p.get("tool_input").and_then(|i| i.get("command")).and_then(Value::as_str) else { continue };
            total += 1;
            if !read_only_for("git", cmd) {
                continue;
            }
            passed += 1;
            let l = crate::script::golden::lay(&case);
            let got = crate::script::golden::run_case("git", &l, 1);
            assert!(matches!(got, Some(Some(Verdict::Allow))), "{name} {:?}: the prefilter passes {cmd:?}, the git check said {got:?}", case.get("n"));
        }
    }
    assert!(total > 200, "the corpora were read: {total} Bash cases");
    eprintln!("other goldens: {passed} of {total} Bash cases prefiltered");
}

#[test]
fn the_capacity_corpus_holds_stay_with_the_check_and_its_passes_agree() {
    let text = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/capacity_hold_corpus.txt")).unwrap();
    let (mut passed, mut total) = (0, 0);
    for line in text.lines() {
        let Some((kind, cmd)) = line.split_once(' ') else { continue };
        if !matches!(kind, "H" | "P" | "R") {
            continue;
        }
        let cmd = cmd.replace("\\n", "\n");
        total += 1;
        if !read_only_for("git", &cmd) {
            continue;
        }
        assert_ne!(kind, "H", "{cmd:?} is a must-hold shape: the prefilter must never pass it");
        passed += 1;
        assert!(git_quiet(&cmd, "/"), "{cmd:?}: the prefilter passes it, the git check spoke");
    }
    assert!(total > 400, "the corpus was read: {total} cases");
    eprintln!("capacity corpus: {passed} of {total} prefiltered");
}

#[test]
fn a_shadow_disagreement_latches_the_prefilter_off_until_the_marker_goes() {
    let p = json!({"tool_name": "Bash", "tool_input": {"command": "ls -la"}});
    crate::discard::harmless(std::fs::remove_file(latch_path())); // keep: an absent latch is the goal state
    reset_latch_for_test();
    assert_ne!(decide("git", "PreToolUse", &p), Pre::Run, "armed: a plain read is prefiltered");
    assert_eq!(decide("git", "PostToolUse", &p), Pre::Run, "only the listed events");
    assert_eq!(decide("command", "PreToolUse", &p), Pre::Run, "only the listed checks");
    shadow_result("git", false, "ls -la");
    assert_ne!(decide("git", "PreToolUse", &p), Pre::Run, "an agreeing shadow run keeps it armed");
    shadow_result("git", true, "ls -la");
    assert_eq!(decide("git", "PreToolUse", &p), Pre::Run, "a disagreement latches it off at once");
    assert!(latch_path().exists(), "the latch is persisted");
    reset_latch_for_test();
    assert_eq!(decide("git", "PreToolUse", &p), Pre::Run, "a restart reads the latch back");
    std::fs::remove_file(latch_path()).unwrap();
    reset_latch_for_test();
    assert_ne!(decide("git", "PreToolUse", &p), Pre::Run, "deleting the marker re-arms it");
}

#[test]
fn the_shadow_sample_runs_the_full_check_at_its_rate() {
    crate::discard::harmless(std::fs::remove_file(latch_path())); // keep: an absent latch is the goal state
    reset_latch_for_test();
    let p = json!({"tool_name": "Bash", "tool_input": {"command": "ls"}});
    let shadows = (0..1000).filter(|_| decide("git", "PreToolUse", &p) == Pre::Shadow).count() as u64;
    assert_eq!(shadows, defaults::num("prefilter.shadow_permille"));
}

#[test]
fn a_prefiltered_entry_answers_allow_through_the_dispatcher_and_a_force_push_still_blocks() {
    use crate::dispatch::native::{Answer, Meta, evaluate};
    crate::discard::harmless(std::fs::remove_file(latch_path())); // keep: an absent latch is the goal state
    reset_latch_for_test();
    let meta = Meta {
        host: "claude".into(),
        event: "PreToolUse".into(),
        tool: None,
        root: Some("/nonexistent-plugin".into()),
        env: Default::default(),
        only: Some(vec!["git-guard".into()]),
        plan: vec![],
        cfg: String::new(),
        payload_sha1: None,
        deadline_ms: None,
        load_permille: None,
        notice: None,
    };
    let run = |cmd: &str| {
        let p = json!({"session_id": "s", "cwd": "/", "hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": cmd}});
        evaluate(&meta, &p, &|_| false, &|_, _, _| {})
    };
    let got = run("ls -la");
    assert!(matches!(&got[..], [(id, Answer::Decided(r, _))] if id == "git-guard" && *r == HookResult::quiet("git-guard")), "{got:?}");
    let got = run("git push --force origin main");
    assert!(matches!(&got[..], [(_, Answer::Decided(r, _))] if r.code == Some(2)), "{got:?}");
}

#[test]
fn both_hosts_run_the_git_check_on_bash_pretooluse() {
    // the prefilter is keyed by check name, so it covers the claude and the codex table alike
    for host in ["claude", "codex"] {
        let rows = defaults::raw(&format!("dispatch.hooks_{host}_PreToolUse"));
        let has = rows.as_array().is_some_and(|a| a.iter().any(|r| r.get("check").and_then(defaults::V::as_str) == Some("git")));
        assert!(has, "{host}: the git check runs on PreToolUse");
    }
}

use crate::dispatch::combine::HookResult;


/// Measurement over a recorded corpus of real Bash calls (a JSON array of command strings named by `AH_PREFILTER_CORPUS`, at most
/// `AH_PREFILTER_SAMPLE` of them): the share the prefilter passes, a git-check run on every passed one (each must be a quiet allow:
/// real-traffic parity), and the git entry's thread CPU per call with and without the prefilter. Ignored by default.
#[test]
#[ignore = "measurement: needs AH_PREFILTER_CORPUS"]
fn measure_prefilter_over_a_recorded_corpus() {
    let Ok(path) = std::env::var("AH_PREFILTER_CORPUS") else { return };
    let all: Vec<String> = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let cap: usize = std::env::var("AH_PREFILTER_SAMPLE").ok().and_then(|s| s.parse().ok()).unwrap_or(all.len());
    let step = (all.len() / cap.max(1)).max(1);
    let sample: Vec<&String> = all.iter().step_by(step).take(cap).collect();
    let (mut passed, mut disagree) = (0usize, Vec::new());
    let (mut cpu_full, mut cpu_pre) = (0u64, 0u64);
    let mut by_lead: std::collections::BTreeMap<String, (u64, u64)> = Default::default();
    let mut reasons: std::collections::BTreeMap<&str, usize> = Default::default();
    let mut leads_off: std::collections::BTreeMap<String, usize> = Default::default();
    for c in &sample {
        let t0 = crate::limits::thread_cpu_us();
        let why = why_not("git", c);
        let pass = why.is_none();
        *reasons.entry(why.unwrap_or("pass")).or_insert(0usize) += 1;
        if let Some(w) = why.filter(|w| *w == "lead" || *w == "cmd") {
            let lead = c.split([';', '&', '|']).flat_map(|el| el.split_whitespace().next()).find(|l| !["cd", "ls", "cat", "grep", "head", "tail", "echo", "wc", "git"].contains(l)).unwrap_or("").to_string();
            *leads_off.entry(format!("{w}:{lead}")).or_insert(0usize) += 1;
        }
        let t1 = crate::limits::thread_cpu_us();
        let quiet = git_quiet(c, "/");
        let t2 = crate::limits::thread_cpu_us();
        cpu_full += t2 - t1;
        let lead = c.split_whitespace().next().unwrap_or("").to_string();
        let lead = if lead == "git" { format!("git {}", c.split_whitespace().nth(1).unwrap_or("")) } else { lead };
        let e = by_lead.entry(lead).or_insert((0u64, 0u64));
        e.0 += 1;
        e.1 += t2 - t1;
        cpu_pre += (t1 - t0) + if pass { 0 } else { t2 - t1 };
        if pass {
            passed += 1;
            if !quiet {
                disagree.push((*c).clone());
            }
        }
    }
    let n = sample.len().max(1) as u64;
    eprintln!(
        "corpus: {} calls, prefiltered {} ({:.1}%), disagreements {}, git entry CPU/call: full {} us, with prefilter {} us",
        sample.len(),
        passed,
        100.0 * passed as f64 / n as f64,
        disagree.len(),
        cpu_full / n,
        cpu_pre / n
    );
    eprintln!("reasons: {reasons:?}");
    let mut off: Vec<_> = leads_off.into_iter().collect();
    off.sort_by_key(|(_, n)| std::cmp::Reverse(*n));
    eprintln!("unlisted leads: {:?}", &off[..off.len().min(40)]);
    let mut top: Vec<_> = by_lead.into_iter().collect();
    top.sort_by_key(|(_, (_, us))| std::cmp::Reverse(*us));
    for (lead, (calls, us)) in top.iter().take(25) {
        eprintln!("lead {lead:<28} calls {calls:>5} cpu {:>8} ms  per-call {:>6} us", us / 1000, us / calls.max(&1));
    }
    assert!(disagree.is_empty(), "the prefilter passed calls the git check spoke on: {disagree:?}");
}

