//! Regression for #933: the claim-check Stop guards flagged text that was not the agent's own claim
//! (a relayed hypothesis, an instruction), using the shipped scripts and config.
#![allow(clippy::unwrap_used, clippy::expect_used)]
use ah_engine::{checks::Verdict, reqenv::RequestEnv, script};
use serde_json::json;

fn blocked(guard: &str, text: &str, n: usize) -> bool {
    let home = std::env::temp_dir().join(format!("ah-relayed-{}-{n}-{guard}", std::process::id()));
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
    ];
    for (i, t) in cases.iter().enumerate() {
        assert!(!blocked("claim-evidence-guard", t, 20 + i), "{t}");
    }
}

#[test]
fn claim_evidence_still_fires_on_real_claims() {
    let cases = ["CI passes.", "Pushed, and CI passes now.", "I made sure CI passes.", "All tests pass."];
    for (i, t) in cases.iter().enumerate() {
        assert!(blocked("claim-evidence-guard", t, 30 + i), "{t}");
    }
}
