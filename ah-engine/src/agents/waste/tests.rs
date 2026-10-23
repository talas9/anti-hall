//! The formula on the two reference scenarios: the 2026-10-23 incident pattern is waste, a productive lane is not.
use super::formula::{Input, Level, Params, level, read_heavy, score};

#[test]
fn incident_pattern_scores_hard() {
    let p = Params::load();
    // 1.5M tokens (the low end of the 1.5-7.7M range), no outcome, many re-reads, queued on a lock
    let i = Input { tokens: 1_500_000, outcome: 0, calls: 30, reread: 0.6, repeat: 0.3, poll: 0.2, wait: 0.5, failed: 0, readonly: 0.0 };
    let s = score(&i, &p, false);
    assert_eq!(level(s, &p), Level::Hard, "score {s}");
    // the same spend with only a couple of re-reads and no waiting is still waste: no outcome at all
    let quiet = Input { tokens: 1_500_000, outcome: 0, calls: 30, ..Input::default() };
    assert_eq!(level(score(&quiet, &p, false), &p), Level::Hard);
}

#[test]
fn productive_lane_is_not_waste() {
    let p = Params::load();
    // about 1M tokens, 3 commits (10 units each) and a few new files, few re-reads
    let i = Input { tokens: 1_000_000, outcome: 3 * 10 + 4, calls: 40, reread: 0.1, repeat: 0.05, poll: 0.05, wait: 0.0, failed: 1, readonly: 0.0 };
    let s = score(&i, &p, false);
    assert_eq!(level(s, &p), Level::Ok, "score {s}");
}

#[test]
fn small_spend_is_never_waste() {
    let p = Params::load();
    let i = Input { tokens: p.min_tokens - 1, outcome: 0, calls: 30, reread: 1.0, repeat: 1.0, poll: 1.0, wait: 1.0, failed: 9, readonly: 0.0 };
    assert_eq!(score(&i, &p, false), 0.0);
}

#[test]
fn read_heavy_roles_score_lower_and_a_commit_clears_the_middle() {
    let p = Params::load();
    let i = Input { tokens: 800_000, outcome: 0, calls: 30, reread: 0.5, ..Input::default() };
    assert!(score(&i, &p, true) < score(&i, &p, false));
    assert!(read_heavy("code-reviewer") && read_heavy("Explore") && !read_heavy("guard-sense"));
    let with_commit = Input { outcome: 10, ..i.clone() };
    assert!(score(&with_commit, &p, false) < score(&i, &p, false) / 5.0);
}

#[test]
fn read_only_investigation_scores_low_and_is_scaled_by_its_share() {
    let p = Params::load();
    // the 2026-10-23 eng-cpu lane: about 40 read-only calls, a big spend, no outcome
    let all = Input { tokens: 2_000_000, outcome: 0, calls: 40, reread: 0.3, readonly: 1.0, ..Input::default() };
    let none = Input { readonly: 0.0, ..all.clone() };
    let half = Input { readonly: 0.5, ..all.clone() };
    assert_ne!(level(score(&all, &p, false), &p), Level::Hard, "score {}", score(&all, &p, false));
    assert!(score(&all, &p, false) < score(&half, &p, false) && score(&half, &p, false) < score(&none, &p, false));
    assert_eq!(level(score(&none, &p, false), &p), Level::Hard);
}
