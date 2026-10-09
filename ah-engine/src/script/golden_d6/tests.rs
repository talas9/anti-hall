//! Golden parity of the D88 batch-6 checks: every case of `tests/golden/<check>.jsonl` (frozen from the compiled port before it was
//! removed) through the plugin script, byte for byte, with the files the script wrote compared too.
use super::*;

/// Every case of a golden corpus through the script; mismatches are listed (up to `limit`) before the test fails.
fn golden_report(check: &str, limit: usize) {
    let cases = golden::load(check);
    assert!(cases.len() >= 20, "{check}: a golden corpus of real size");
    let (mut bad, mut shown) = (0, 0);
    for c in &cases {
        let l = golden::lay(c);
        let got = run_forced(check, &l.payload, &l.opts, &l.event, &l.env).unwrap_or_else(|| panic!("{check}: no shipped script"));
        let got = golden::verdict_json(&got, &l);
        let mut ok = got == c["expect"];
        if ok && c.get("watch").is_some() {
            ok = golden::watched_all_pub(c, &l) == c["writes"];
        }
        if !ok {
            bad += 1;
            if shown < limit {
                shown += 1;
                let mut p = c["payload"].to_string();
                p.truncate(300);
                let wrote =
                    if c.get("watch").is_some() { format!("\n  wrote ={}\n  files ={}", golden::watched_all_pub(c, &l), c["writes"]) } else { String::new() };
                eprintln!(
                    "MISMATCH {check} n={} {}\n  payload={p}\n  expect={}\n  got   ={}\n  errors={:?}{wrote}",
                    c["n"],
                    c["tag"],
                    c["expect"].to_string().chars().take(700).collect::<String>(),
                    got.to_string().chars().take(700).collect::<String>(),
                    crate::discard::captured()
                );
            }
        }
        crate::discard::harmless(std::fs::remove_dir_all(&l.home)); // keep: cleanup of a scratch directory
    }
    eprintln!("GOLDEN {check}: {} cases, {bad} mismatches", cases.len());
    assert_eq!(bad, 0, "{check}: {bad} of {} cases differ from the compiled port", cases.len());
}

#[test]
fn dispatch_tier_script_matches_the_compiled_port() {
    golden_report("dispatch-tier", 12);
}

#[test]
fn model_routing_script_matches_the_compiled_port() {
    golden_report("model-routing", 12);
}

#[test]
fn speculation_judge_script_matches_the_compiled_port() {
    golden_report("speculation-judge", 12);
}

#[test]
fn speculation_guard_script_matches_the_compiled_port() {
    golden_report("speculation-guard", 12);
}

#[test]
fn silent_agent_nudge_script_matches_the_compiled_port() {
    golden_report("silent-agent-nudge", 12);
}

#[test]
fn task_guard_script_matches_the_compiled_port() {
    golden_report("task-guard", 12);
}

#[test]
fn tasklist_guard_script_matches_the_compiled_port() {
    golden_report("tasklist-guard", 12);
}
