//! Tests of this module.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test module: a panic is the failure report

use super::*;

fn sleeper() -> Command {
    let mut c = Command::new("sh");
    c.arg("-c").arg("sleep 20; echo late");
    c
}

#[test]
fn a_child_never_outlives_the_overall_deadline_and_nothing_starts_after_it() {
    // its own limit is 15 s; the run's deadline is 300 ms away
    set_end(Some(Instant::now() + Duration::from_millis(300)));
    let t = Instant::now();
    assert!(run_with_input(sleeper(), b"", Duration::from_secs(15), 1024).is_none());
    assert!(t.elapsed() < Duration::from_secs(5), "cut at the deadline, not at the step limit: {:?}", t.elapsed());
    // past the deadline: not even spawned
    set_end(Some(Instant::now() - Duration::from_millis(1)));
    let t = Instant::now();
    assert!(run_with_input(Command::new("true"), b"", Duration::from_secs(15), 1024).is_none(), "nothing starts after the deadline");
    assert!(t.elapsed() < Duration::from_secs(2));
    // no deadline armed: the step's own limit is all there is
    set_end(None);
    assert!(run_with_input(Command::new("true"), b"", Duration::from_secs(15), 1024).is_some_and(|r| r.ok));
}
