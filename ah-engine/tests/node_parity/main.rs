//! Node-versus-engine parity lanes. Each lane runs the REAL Node hook (the system under comparison) and the engine on the same
//! inputs and requires identical answers; no lane needs Node for anything but being the reference. They replace the
//! JavaScript runners that used to live under `parity/`. A lane is skipped where Node or the plugin hooks are missing (the
//! engine can be built outside the monorepo). The lanes run one at a time (each spawns many processes of its own).
//!
//! Set `AH_PARITY_DUMP=<dir>` to write each lane's corpus and summary there; `AH_PARITY_REAL_CMDS`, `AH_PARITY_REAL_EDITS`
//! and `AH_PARITY_REAL` add real commands and edits from local data to the guard corpora that took them.

#[macro_use]
mod jsjson;
mod api_guard;
mod b78;
mod b78_availability;
mod b78_handover;
mod b78_nudge;
mod b78_precompact;
mod b78_quota_detect;
mod coordinator_post;
mod ctxbudget;
mod edit_guard;
mod failure_nudge;
mod fx;
mod fx_dispatch_tier;
mod fx_lifecycle;
mod fx_task_guard;
mod fx_tasklines;
mod fx_tasklist_guard;
mod git_audit;
mod guard;
mod lab;
mod merge_gate;
mod session;
mod support;
mod verify_first;

use support::*;

#[test]
fn merge_gate_matches_node() {
    let _s = serial();
    let Some(hooks) = hooks_dir() else { return };
    guard::require(&merge_gate::opts(), &hooks, merge_gate::scenarios(), 1000);
}

#[test]
fn api_guard_matches_node() {
    let _s = serial();
    let Some(hooks) = hooks_dir() else { return };
    guard::require(&api_guard::opts(), &hooks, api_guard::scenarios(), 900);
}

#[test]
fn edit_guard_matches_node() {
    let _s = serial();
    let Some(hooks) = hooks_dir() else { return };
    guard::require(&edit_guard::opts(), &hooks, edit_guard::scenarios(), 1000);
}

#[test]
fn failure_nudge_matches_node() {
    let _s = serial();
    let Some(hooks) = hooks_dir() else { return };
    guard::require(&failure_nudge::opts(), &hooks, failure_nudge::scenarios(), 4000);
}

#[test]
fn git_audit_matches_node() {
    let _s = serial();
    let Some(hooks) = hooks_dir() else { return };
    guard::require(&git_audit::opts(), &hooks, git_audit::scenarios(), 1500);
}

#[test]
fn coordinator_post_matches_node() {
    let _s = serial();
    let Some(hooks) = hooks_dir() else { return };
    guard::require(&coordinator_post::opts(), &hooks, coordinator_post::scenarios(), 500);
}

#[test]
fn verify_first_matches_node() {
    let _s = serial();
    let Some(hooks) = hooks_dir() else { return };
    verify_first::run_lane(&hooks, None);
}

#[test]
fn codex_quota_detect_matches_node() {
    let _s = serial();
    let Some(hooks) = hooks_dir() else { return };
    b78::require("codex-quota-detect", "codex-quota-detect", "codex-quota-detect.js", &hooks, b78_quota_detect::scenarios(), 100);
}

#[test]
fn codex_availability_matches_node() {
    let _s = serial();
    let Some(hooks) = hooks_dir() else { return };
    b78::require("codex-availability", "codex-availability", "codex-availability.js", &hooks, b78_availability::scenarios(), 100);
}

#[test]
fn codex_nudge_matches_node() {
    let _s = serial();
    let Some(hooks) = hooks_dir() else { return };
    b78::require("codex-nudge", "codex-nudge", "codex-nudge.js", &hooks, b78_nudge::scenarios(), 100);
}

#[test]
fn handover_resume_matches_node() {
    let _s = serial();
    let Some(hooks) = hooks_dir() else { return };
    b78::require("handover-resume", "handover-resume", "handover-resume.js", &hooks, b78_handover::scenarios(), 100);
}

#[test]
fn precompact_snapshot_matches_node() {
    let _s = serial();
    let Some(hooks) = hooks_dir() else { return };
    b78::require("precompact-snapshot", "precompact-snapshot", "precompact-snapshot.js", &hooks, b78_precompact::scenarios(), 100);
}

#[test]
fn session_checks_match_node() {
    let _s = serial();
    let Some(hooks) = hooks_dir() else { return };
    let only = std::env::var("AH_PARITY_ONLY").ok();
    for (hook, _) in session::HOOKS {
        if only.as_ref().is_none_or(|o| hook.contains(o.as_str())) {
            session::require(hook, &hooks, 300);
        }
    }
}

#[test]
fn dispatch_tier_matches_node() {
    let _s = serial();
    let Some(hooks) = hooks_dir() else { return };
    fx::require(&fx_dispatch_tier::opts(), &hooks, fx_dispatch_tier::scenarios(), 150);
}

#[test]
fn task_lifecycle_log_matches_node() {
    let _s = serial();
    let Some(hooks) = hooks_dir() else { return };
    fx::require(&fx_lifecycle::opts(), &hooks, fx_lifecycle::scenarios(), 300);
}

#[test]
fn task_guard_matches_node() {
    let _s = serial();
    let Some(hooks) = hooks_dir() else { return };
    let (scenarios, _shared, must) = fx_task_guard::corpus();
    fx::require(&fx_task_guard::opts(must), &hooks, scenarios, 250);
}

#[test]
fn tasklist_guard_matches_node() {
    let _s = serial();
    let Some(hooks) = hooks_dir() else { return };
    let (scenarios, _shared) = fx_tasklist_guard::corpus();
    fx::require(&fx_tasklist_guard::opts(), &hooks, scenarios, 400);
}

#[test]
fn ctxbudget_checks_match_node() {
    let _s = serial();
    let Some(hooks) = hooks_dir() else { return };
    ctxbudget::require(&hooks);
}

// ---- the harness self-tests: a Node answer that is altered must be noticed ---------------------------------------------------------

fn guard_notices(opts: guard::Opts, scenarios: Vec<guard::Scenario>, keep: impl Fn(&str) -> bool, n: usize) {
    let Some(hooks) = hooks_dir() else { return };
    let subset: Vec<guard::Scenario> = scenarios.into_iter().filter(|s| keep(&s.id)).take(n).collect();
    assert!(!subset.is_empty(), "the self-test subset is empty");
    let mut opts = opts;
    opts.mutate = true;
    let rep = guard::run_guard(&opts, &hooks, &subset);
    assert!(rep.stats.mismatch > 0, "{}: altered Node answers were not noticed\n{}", opts.name, rep.summary);
}

#[test]
fn the_merge_gate_comparison_notices_a_changed_node_answer() {
    let _s = serial();
    guard_notices(merge_gate::opts(), merge_gate::scenarios(), |id| id.starts_with("ctx-"), 12);
}

#[test]
fn the_api_guard_comparison_notices_a_changed_node_answer() {
    let _s = serial();
    guard_notices(api_guard::opts(), api_guard::scenarios(), |id| id.starts_with("ctx-"), 12);
}

#[test]
fn the_edit_guard_comparison_notices_a_changed_node_answer() {
    let _s = serial();
    guard_notices(edit_guard::opts(), edit_guard::scenarios(), |id| id.starts_with("sw-"), 12);
}

#[test]
fn the_failure_nudge_comparison_notices_a_changed_node_answer() {
    let _s = serial();
    guard_notices(failure_nudge::opts(), failure_nudge::scenarios(), |id| id.starts_with("exp-") || id.starts_with("ctx-"), 40);
}

#[test]
fn the_git_audit_comparison_notices_a_changed_node_answer() {
    let _s = serial();
    guard_notices(git_audit::opts(), git_audit::scenarios(), |id| id.starts_with("u-recent-"), 30);
}

#[test]
fn the_coordinator_post_comparison_notices_a_changed_node_answer() {
    let _s = serial();
    guard_notices(coordinator_post::opts(), coordinator_post::scenarios(), |id| id.starts_with("default-"), 6);
}

fn b78_notices(name: &str, check: &str, hook_file: &str, scenarios: Vec<b78::Sc>, n: usize) {
    let Some(hooks) = hooks_dir() else { return };
    let subset: Vec<b78::Sc> = scenarios.into_iter().take(n).collect();
    let rep = b78::run_lane(name, check, hook_file, &hooks, &subset, true);
    assert!(rep.mismatch > 0, "{name}: altered Node answers were not noticed\n{}", rep.summary);
}

#[test]
fn the_codex_quota_detect_comparison_notices_a_changed_node_answer() {
    let _s = serial();
    b78_notices("codex-quota-detect", "codex-quota-detect", "codex-quota-detect.js", b78_quota_detect::scenarios(), 30);
}

#[test]
fn the_codex_availability_comparison_notices_a_changed_node_answer() {
    let _s = serial();
    b78_notices("codex-availability", "codex-availability", "codex-availability.js", b78_availability::scenarios(), 30);
}

#[test]
fn the_codex_nudge_comparison_notices_a_changed_node_answer() {
    let _s = serial();
    b78_notices("codex-nudge", "codex-nudge", "codex-nudge.js", b78_nudge::scenarios(), 30);
}

#[test]
fn the_handover_resume_comparison_notices_a_changed_node_answer() {
    let _s = serial();
    b78_notices("handover-resume", "handover-resume", "handover-resume.js", b78_handover::scenarios(), 30);
}

#[test]
fn the_precompact_snapshot_comparison_notices_a_changed_node_answer() {
    let _s = serial();
    b78_notices("precompact-snapshot", "precompact-snapshot", "precompact-snapshot.js", b78_precompact::scenarios(), 30);
}

#[test]
fn the_session_comparison_notices_a_changed_node_answer() {
    let _s = serial();
    let Some(hooks) = hooks_dir() else { return };
    let repo = repo_root().canonicalize().expect("the repository root");
    let rep = session::run_hook("devswarm-version", &hooks, &repo, Some(25));
    assert!(rep.stats.mismatch > 0, "altered Node answers were not noticed\n{}", rep.summary);
}

fn fx_notices(mut opts: fx::Opts, scenarios: Vec<fx::Scenario>, n: usize) {
    let Some(hooks) = hooks_dir() else { return };
    opts.mutate = true;
    let subset: Vec<fx::Scenario> = scenarios.into_iter().take(n).collect();
    let rep = fx::run_fx(&opts, &hooks, &subset);
    assert!(rep.stats.mismatch > 0, "{}: altered Node answers were not noticed\n{}", opts.name, rep.summary);
}

#[test]
fn the_dispatch_tier_comparison_notices_a_changed_node_answer() {
    let _s = serial();
    fx_notices(fx_dispatch_tier::opts(), fx_dispatch_tier::scenarios(), 40);
}

#[test]
fn the_task_lifecycle_log_comparison_notices_a_changed_node_answer() {
    let _s = serial();
    fx_notices(fx_lifecycle::opts(), fx_lifecycle::scenarios(), 40);
}

#[test]
fn the_task_guard_comparison_notices_a_changed_node_answer() {
    let _s = serial();
    let (scenarios, _shared, must) = fx_task_guard::corpus();
    fx_notices(fx_task_guard::opts(must), scenarios, 40);
}

#[test]
fn the_tasklist_guard_comparison_notices_a_changed_node_answer() {
    let _s = serial();
    let (scenarios, _shared) = fx_tasklist_guard::corpus();
    fx_notices(fx_tasklist_guard::opts(), scenarios, 60);
}

#[test]
fn the_verify_first_comparison_notices_a_changed_node_answer() {
    let _s = serial();
    let Some(hooks) = hooks_dir() else { return };
    let report = verify_first::run_lane(&hooks, Some(40));
    assert!(report.contains("MISMATCH=") && !report.contains("MISMATCH=0\n"), "altered Node answers were not noticed\n{report}");
}

#[test]
fn the_ctxbudget_comparison_notices_a_changed_node_answer() {
    let _s = serial();
    let Some(hooks) = hooks_dir() else { return };
    let (stats, summary) = ctxbudget::run_lane(&hooks, Some(60));
    assert!(stats.values().any(|s| s.mismatch > 0), "altered Node answers were not noticed\n{summary}");
}
