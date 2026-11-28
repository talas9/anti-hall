//! Regression for #933: the claim-check Stop guards flagged text that was not the agent's own claim
//! (a relayed hypothesis, an instruction), using the shipped scripts and config.
#![allow(clippy::unwrap_used, clippy::expect_used)]
use ah_engine::{checks::Verdict, reqenv::RequestEnv, script};
use serde_json::json;

#[path = "common/testtmp.rs"]
mod testtmp;

fn blocked(guard: &str, text: &str, n: usize) -> bool {
    let home = testtmp::path(format!("ah-relayed-{}-{n}-{guard}", std::process::id()));
    std::fs::create_dir_all(&home).unwrap();
    let tp = home.join("transcript.jsonl");
    let user = json!({"type":"user","message":{"role":"user","content":"Status?"}});
    let assistant = json!({"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":text}]}});
    std::fs::write(&tp, format!("{user}\n{assistant}\n")).unwrap();
    let env = RequestEnv::from_pairs([("HOME", home.to_str().unwrap())]);
    let got = script::run_forced(guard, &json!({"session_id":"relayed","last_assistant_message":text,"transcript_path":tp}), &json!({}), "Stop", &env)
        .expect("shipped script")
        .expect("script verdict");
    // keep: scratch test directory only
    std::fs::remove_dir_all(home).unwrap();
    match &got {
        Verdict::Block(_) => true,
        Verdict::Exact(e) => serde_json::from_str::<serde_json::Value>(&e.out).is_ok_and(|v| v["decision"] == "block"),
        _ => false,
    }
}

#[test]
fn speculation_guard_ignores_relayed_and_ruled_out_hypotheses() {
    let cases = [
        "It will report: the failing test name, the stack trace, the likely code at fault.",
        "That rules out the 'not enabled for this account' idea as the likely cause.",
        "It will report: ... the likely code at fault.",
        "That rules out the account theory as the most likely cause.",
    ];
    for (i, t) in cases.iter().enumerate() {
        assert!(!blocked("speculation-guard", t, i), "{t}");
    }
}

#[test]
fn speculation_guard_still_fires_on_own_unverified_claims() {
    let cases = [
        "The bug is likely in the parser.",
        "The likely cause is the cache.",
        "The agent will report back soon. The bug is likely in the parser.",
        "That rules out DNS. It is probably the cache.",
    ];
    for (i, t) in cases.iter().enumerate() {
        assert!(blocked("speculation-guard", t, 10 + i), "{t}");
    }
}

#[test]
fn claim_evidence_ignores_instructions_to_make_sure() {
    let cases = [
        "Draft #860 now conflicts with develop. Merge develop into it (no force push), push, and make sure CI passes.",
        "Rebase, then make sure that the tests pass.",
        "Please ensure CI is green before you hand it back.",
        "Check that the build is green and report.",
        "Then verify that CI is green and report back.",
    ];
    for (i, t) in cases.iter().enumerate() {
        assert!(!blocked("claim-evidence-guard", t, 20 + i), "{t}");
    }
}

#[test]
fn claim_evidence_still_fires_on_real_claims() {
    let cases = ["CI passes.", "Pushed, and CI passes now.", "I made sure CI passes.", "All tests pass.",
        "I can confirm that CI passes.",
        "I see that the build is green.",
        "I can verify that the tests pass.",
        "We checked and CI is green.",
        "This ensures CI passes.",
    ];
    for (i, t) in cases.iter().enumerate() {
        assert!(blocked("claim-evidence-guard", t, 30 + i), "{t}");
    }
}

/// #972 wave 2 (item 4): numbers a reply attributes to another agent, with an explicit not-verified marker in the same paragraph or in
/// the heading that governs it, are reported, not claimed.
#[test]
fn claim_evidence_ignores_attributed_results_marked_unverified_in_scope() {
    let cases = [
        "Lane-reported results; I haven't re-run them yet.\n\n- tests pass: 410/410\n- gates 14/14",
        "## Lane-reported results; I have not re-run them yet\n\nAll 410 tests pass and clippy is clean.",
        "The numbers above are lane-busy's report: tests passing 86/86 on the branch. I haven't verified them.",
        "**Lane results (I have not re-run them):**\n\ntests pass, 272/272.",
    ];
    for (i, t) in cases.iter().enumerate() {
        assert!(!blocked("claim-evidence-guard", t, 40 + i), "{t}");
    }
}

/// The true positives stay: a bare relayed result, attribution without a not-verified marker, and a marker in ANOTHER paragraph.
#[test]
fn claim_evidence_still_fires_on_attributed_results_without_a_scoped_marker() {
    let cases = [
        "lane-busy is done: all tests pass and it is ready to merge.",
        "Lane-reported results:\n\n- tests pass: 410/410",
        "I haven't re-run the lane's numbers.\n\nAll tests pass on the branch.",
    ];
    for (i, t) in cases.iter().enumerate() {
        assert!(blocked("claim-evidence-guard", t, 50 + i), "{t}");
    }
}

/// "is live" after a local engine deploy: an `ah-engine version` or `status` call this turn backs it; any other command does not.
#[test]
fn claim_evidence_accepts_an_engine_version_or_status_call_for_live() {
    let run = |cmd: &str, n: usize| -> bool {
        let text = "The new engine build is live.";
        let home = testtmp::path(format!("ah-relayed-live-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&home).unwrap();
        let tp = home.join("transcript.jsonl");
        let user = json!({"type":"user","message":{"role":"user","content":"Status?"}});
        let call = json!({"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"tu1","name":"Bash","input":{"command":cmd}}]}});
        let res = json!({"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu1","content":"ah-engine 0.3.31 running pid 4242"}]}});
        let assistant = json!({"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":text}]}});
        std::fs::write(&tp, format!("{user}\n{call}\n{res}\n{assistant}\n")).unwrap();
        let env = RequestEnv::from_pairs([("HOME", home.to_str().unwrap())]);
        let got = script::run_forced("claim-evidence-guard", &json!({"session_id":"relayed-live","last_assistant_message":text,"transcript_path":tp}), &json!({}), "Stop", &env)
            .expect("shipped script")
            .expect("script verdict");
        // keep: scratch test directory only
        std::fs::remove_dir_all(home).unwrap();
        match &got {
            Verdict::Block(_) => true,
            Verdict::Exact(e) => serde_json::from_str::<serde_json::Value>(&e.out).is_ok_and(|v| v["decision"] == "block"),
            _ => false,
        }
    };
    assert!(!run("~/.anti-hall/ah-engine/bin/ah-engine version", 1), "a version call backs 'is live'");
    assert!(!run("\"$HOME/.anti-hall/ah-engine/bin/ah-engine\" status --json", 2), "a status call backs 'is live'");
    assert!(run("ls -la", 3), "an unrelated command does not back 'is live' (true positive)");
}
