//! `pickSurvivor` (`scripts/devswarm-lib/identity.js`): the partition a live session actually drains, among the rows of one canonical
//! group. It is `pickFreshestLive` (`companion/lib/devswarm-liveness-select.js`) with the STRICT routing liveness: a row is a candidate
//! only when the DevSwarm app does not call it archived and its heartbeat or harness session says it is live (no descriptor fallback,
//! so a dead store-only row with a lingering descriptor never wins). Among the live rows: session-reference integrity, drain
//! activity, a session-authored heartbeat, then recency; with no live row, the freshest `updated_at` and then the lowest id.
//!
//! The ranking is the one `diagnose` uses for `send --to <meshId>` (`meshw::diagverbs::pick_freshest`), so the fold and the router can
//! never disagree about which partition is authoritative.
use super::RegRow;
use super::fold::Cx;
use crate::meshw::common::Inv;
use crate::meshw::ident::{R, Row};
use crate::meshw::rosterrows::Verdicts;

/// An invocation context for the liveness readers of one run.
pub(super) fn inv_of(ctx: &crate::dssup::tick::Ctx) -> Inv {
    Inv {
        home: ctx.home.to_path_buf(),
        env: ctx.st.env.clone(),
        cwd: ctx.home.to_string_lossy().into_owned(),
        now: ctx.now,
        stdin: None,
        write_home: ctx.home.to_path_buf(),
        store_override: None,
    }
}

fn row_of(r: &RegRow) -> Row {
    Row { id: r.row.id.clone(), worktree_path: r.row.worktree_path.clone(), session_id: r.row.session_id.clone(), updated_at: r.updated_at.map(|u| u as f64) }
}

/// `pickSurvivor(s, { rows }, home)`: the id of the surviving row; `None` for no rows. A liveness reader that cannot answer reads
/// the row as not live (an undetermined row never wins a selection), as `isRoutingLiveRowStrict` does.
pub(super) fn pick(cx: &Cx, rows: &[RegRow]) -> R<Option<String>> {
    pick_in(cx.inv, cx.store, cx.rd, rows)
}

/// [`pick`] for a caller that has no fold context: the invocation, the store the rows belong to, and its reader.
pub(super) fn pick_in(inv: &Inv, store: &str, rd: &crate::mesh::MeshReader, rows: &[RegRow]) -> R<Option<String>> {
    let cands: Vec<Row> = rows.iter().map(row_of).collect();
    let verdicts = Verdicts::new(inv, store);
    let strict = |d: &Row| -> R<bool> {
        let wt = d.worktree_path.as_deref().filter(|x| !x.is_empty());
        if verdicts.archived(&d.id, wt).unwrap_or(false) {
            return Ok(false);
        }
        Ok(verdicts.live(&d.id, wt, d.session_id.as_deref().filter(|x| !x.is_empty())).unwrap_or(false))
    };
    Ok(crate::meshw::diagverbs::pick_freshest(inv, rd, &cands, &strict)?.map(|r| r.id.clone()))
}
