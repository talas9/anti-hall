//! A child that ran `inbox read` on its backlog and never acked the read receipt is NOT draining-and-fine: the cursor only moves on the ack, so the
//! mail stays unread. The Primary's row stays flagged, relabelled "read, not acked" with the receipt the child must ack, so a child looping on re-reads
//! is never hidden. A read before the mail, one that delivered nothing, an acked one, or one older than the window carries no such label. Real
//! dispatcher, real store, the layout a Primary's turn meets.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use super::archived_children::{CHILD, Env, NOW_MS};

const NUDGE: &str = "devswarm-parent-inbox: 1 active workspace(s) need attention";
const LABEL: &str = "read, not acked";
const OLD_BODY: &str = "CHILD NOT DRAINING: these are message(s) YOU sent";

/// One receipt: (name, created_at, rows delivered, acked).
type Rcpt<'a> = (&'a str, u64, u32, bool);

fn receipt(e: &Env, r: &Rcpt) {
    let (name, created_at, delivered, acked) = *r;
    e.put(
        &format!("read-receipts/{CHILD}/{name}.json"),
        serde_json::json!({
            "v": 1, "receiptId": name, "id": CHILD, "reader": "h:1:1", "createdAt": created_at,
            "ops": [{"k": "own", "partition": CHILD, "target": 3, "delivered": delivered}],
            "hashes": [], "ackedAt": if acked { serde_json::json!(created_at + 5000) } else { serde_json::Value::Null }
        }),
    );
}

/// A turn of a Primary whose one child holds 3 unread messages; `receipts` are laid out relative to the clock (`now - age`), at the pinned
/// 2030 clock or at the real one.
fn turn_with(name: &str, real: bool, receipts: &[(&str, u64, u32, bool)]) -> String {
    let e = Env::new(name);
    let now = if real { e.real_clock() } else { NOW_MS };
    e.settings(true);
    let wt = e.worktree(true);
    e.summary(&wt, 3, "normal", false);
    for (n, age_ms, del, acked) in receipts {
        receipt(&e, &(*n, now - age_ms, *del, *acked));
    }
    e.turn()
}

#[test]
fn a_recent_read_without_ack_stays_flagged_and_names_the_receipt() {
    let out = turn_with("unacked", false, &[("rmx0001", 0, 1, false)]);
    assert!(out.contains(NUDGE), "the row stays flagged, got: {out}");
    assert!(out.contains(LABEL) && out.contains("ack-primary") && out.contains("--receipt rmx0001"), "relabelled with the receipt, got: {out}");
    assert!(!out.contains(OLD_BODY) && !out.contains("NOT DRAINING >20m"), "not called not-draining, got: {out}");
}

#[test]
fn a_child_looping_on_reads_stays_flagged_with_its_newest_receipt() {
    let out = turn_with("loop", false, &[("rmx0001", 600_000, 1, false), ("rmx0002", 300_000, 1, false), ("rmx0003", 1000, 1, false)]);
    assert!(out.contains(NUDGE) && out.contains("--receipt rmx0003"), "flagged, newest receipt named, got: {out}");
}

#[test]
fn an_acked_read_carries_no_read_not_acked_label() {
    let out = turn_with("acked", false, &[("rmx0001", 0, 1, true)]);
    assert!(out.contains(NUDGE) && !out.contains(LABEL), "got: {out}");
}

#[test]
fn no_receipt_still_nags_as_not_draining() {
    let out = turn_with("none", false, &[]);
    assert!(out.contains(NUDGE) && !out.contains(LABEL) && out.contains(OLD_BODY), "got: {out}");
}

#[test]
fn a_read_that_delivered_nothing_is_not_labelled() {
    let out = turn_with("empty", false, &[("rmx0001", 0, 0, false)]);
    assert!(out.contains(NUDGE) && !out.contains(LABEL), "got: {out}");
}

#[test]
fn a_read_made_before_the_oldest_unread_mail_is_not_labelled() {
    let out = turn_with("old", false, &[("rmx0001", 90 * 86_400_000, 2, false)]);
    assert!(out.contains(NUDGE) && !out.contains(LABEL), "got: {out}");
}

#[test]
fn a_read_older_than_the_window_is_not_labelled_but_a_fresh_one_is() {
    // the real clock: the mail is 40 days old, so a read two hours ago is after it yet outside the 20-minute window
    let stale = turn_with("window-old", true, &[("rmx0001", 2 * 3_600_000, 1, false)]);
    assert!(stale.contains(NUDGE) && !stale.contains(LABEL), "got: {stale}");
    let fresh = turn_with("window-new", true, &[("rmx0001", 60_000, 1, false)]);
    assert!(fresh.contains(NUDGE) && fresh.contains(LABEL) && fresh.contains("--receipt rmx0001"), "got: {fresh}");
}
