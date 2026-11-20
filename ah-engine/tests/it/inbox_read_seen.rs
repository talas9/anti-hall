//! A child that ran `inbox read` on its backlog after the oldest unread mail arrived is draining; only the ack of its read receipt is
//! missing, so the cursor never moved and the Primary kept being told "CHILD NOT DRAINING" about a child that had replied. A read made
//! before the mail, one that delivered nothing, or none at all still nags. Real dispatcher, real store, the layout a Primary's turn meets.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use super::archived_children::{CHILD, Env, NOW_MS};

const NUDGE: &str = "devswarm-parent-inbox: 1 active workspace(s) need attention";
const URGENT: &str = "CHILD NOT DRAINING: STOP and poke it NOW";

fn receipt(e: &Env, name: &str, created_at: u64, delivered: u32, acked: bool) {
    e.put(
        &format!("read-receipts/{CHILD}/{name}.json"),
        serde_json::json!({
            "v": 1, "receiptId": name, "id": CHILD, "reader": "h:1:1", "createdAt": created_at,
            "ops": [{"k": "own", "partition": CHILD, "target": 3, "delivered": delivered}],
            "hashes": [], "ackedAt": if acked { serde_json::json!(created_at + 5000) } else { serde_json::Value::Null }
        }),
    );
}

fn turn_with(name: &str, receipts: &[(&str, u64, u32)]) -> String {
    let e = Env::new(name);
    e.settings(true);
    let wt = e.worktree(true);
    e.summary(&wt, 3, "normal", false);
    for (n, at, del) in receipts {
        receipt(&e, n, *at, *del, false);
    }
    e.turn()
}

fn nagged(out: &str) -> bool {
    out.contains(NUDGE) || out.contains(URGENT) || out.contains("NOT DRAINING")
}

#[test]
fn a_child_that_read_the_backlog_but_never_acked_is_not_flagged() {
    let out = turn_with("seen", &[("rmx0001", NOW_MS, 1)]);
    assert!(!nagged(&out), "a read after the oldest unread mail means the child is draining, got: {out}");
}

#[test]
fn no_receipt_still_nags() {
    let out = turn_with("none", &[]);
    assert!(out.contains(NUDGE), "got: {out}");
}

#[test]
fn a_read_that_delivered_nothing_still_nags() {
    let out = turn_with("empty", &[("rmx0001", NOW_MS, 0)]);
    assert!(out.contains(NUDGE), "got: {out}");
}

#[test]
fn a_read_made_before_the_oldest_unread_mail_still_nags() {
    let out = turn_with("old", &[("rmx0001", 1_000_000, 2)]);
    assert!(out.contains(NUDGE), "got: {out}");
}

/// The live misfire: the liveness verdict says notDraining (oldest unread past 20 minutes); a fresh read of the backlog clears the
/// "NOT DRAINING" label, and without that read the same verdict still raises it.
fn turn_with_verdict(name: &str, receipts: &[(&str, u64, u32)]) -> String {
    let e = Env::new(name);
    e.settings(true);
    let wt = e.worktree(true);
    e.summary(&wt, 3, "normal", false);
    e.put(&format!("liveness/{CHILD}.json"), serde_json::json!({"id": CHILD, "status": "active", "notDraining": true}));
    for (n, at, del) in receipts {
        receipt(&e, n, *at, *del, false);
    }
    e.turn()
}

#[test]
fn a_not_draining_verdict_is_cleared_by_a_fresh_read_and_kept_without_one() {
    let read = turn_with_verdict("verdict-read", &[("rmx0001", NOW_MS, 1)]);
    assert!(!read.contains("NOT DRAINING"), "a fresh read clears the not-draining label, got: {read}");
    let none = turn_with_verdict("verdict-none", &[]);
    assert!(none.contains("NOT DRAINING"), "no read: the verdict still flags the child, got: {none}");
}
