//! Label-only registry rows get their app id.
//!
//! A spawn that could not find the app's id for a new workspace yet (see `meshw::spawnverb`), and every spawn before that was
//! fixed, left a registry row keyed by the `primary-<hash>` label of the worktree and no row under the workspace's own id. The
//! roster shows such a row as a phantom and `archive` has no workspace to act on. The app database names the real id
//! (`builders.id` for that worktree path); this pass adds the registry row under it. The roster's ghost fold and the registration
//! fold then retire the label row into it with the existing loss-free path, so nothing is deleted here.
//!
//! Idempotent (a row that already exists under the app id is left alone), fail-open per row, never writes the app database, never
//! touches the Primary's own label row (the app's record of its worktree is a primary builder, which is never picked) and never
//! guesses (no builder, an archived one, or several live ones for the path: the row stays as it is).
use super::sweep::log_line;
use super::view;
use crate::defaults;
use crate::dssup::tick::Ctx;
use crate::meshw::idlock;
use crate::meshw::store::RegistryRow;
use serde_json::json;
use std::collections::HashSet;
use std::path::Path;

/// Whether `row` is a label-only row: keyed by the `primary-<hash>` label its own worktree derives to.
fn label_worktree(row: &RegistryRow) -> Option<&str> {
    let wt = row.worktree_path.as_deref().filter(|w| !w.is_empty())?;
    let derived = crate::meshw::ident::primary_workspace_id(wt).ok()?;
    (row.id.starts_with(defaults::text("devswarm_recon.primary_id_prefix")) && derived == row.id).then_some(wt)
}

/// Fill in the app id of every label-only row of the store `repo_key`; returns the rows filled.
pub fn fill(ctx: &Ctx, repo_key: &str) -> usize {
    if repo_key.is_empty() {
        return 0;
    }
    let home = ctx.home;
    let Ok(rows) = view::registry(home, repo_key) else { return 0 };
    let labels: Vec<(&RegistryRow, &str)> = rows.iter().filter_map(|r| label_worktree(&r.row).map(|w| (&r.row, w))).collect();
    if labels.is_empty() {
        return 0;
    }
    let Some(file) = crate::meshw::ident::app_db_path(home, &ctx.st.env) else { return 0 };
    let Some(app) = crate::devswarm_rt::sources::read_app(Path::new(&file)) else { return 0 };
    let present: HashSet<&str> = rows.iter().map(|r| r.row.id.as_str()).collect();
    let inv = super::survivor::inv_of(ctx);
    let mut filled = 0;
    for (label, wt) in labels {
        let Some(b) = crate::meshw::appid::pick(&app.builders, wt) else { continue };
        if present.contains(b.id.as_str()) {
            continue;
        }
        let done = write_row(&inv, repo_key, &b.id, wt);
        if done {
            filled += 1;
            log_line(
                ctx,
                defaults::text("devswarm_recon.log_component_reconcile"),
                defaults::text("devswarm_recon.lf_op"),
                defaults::text("devswarm_recon.log_level_info"),
                &filled_msg(&b.id, &label.id, wt),
                &filled_ctx(&b.id, &label.id, wt),
            );
        }
    }
    filled
}

/// The log message of a filled row.
pub(crate) fn filled_msg(id: &str, label: &str, wt: &str) -> String {
    defaults::render("devswarm_recon.lf_msg", &[("id", &id), ("label", &label), ("worktree", &wt)])
}

/// The log context of a filled row.
pub(crate) fn filled_ctx(id: &str, label: &str, wt: &str) -> serde_json::Value {
    json!({"id": id, "label": label, "worktreePath": wt})
}

/// Write the registry row `id` (the app id) for the worktree `wt` of the store `repo_key`: under the id's own lock, idempotent (an
/// existing row is left alone), no deletion, no app database write. Whether this call wrote it.
pub(crate) fn write_row(inv: &crate::meshw::common::Inv, repo_key: &str, id: &str, wt: &str) -> bool {
    let Some(held) = idlock::acquire(&inv.home, id) else { return false };
    let done = (|| -> Option<()> {
        let st = crate::meshw::common::open_store(inv, repo_key).ok()?;
        if st.registry_row(id).ok()?.is_some() {
            return None;
        }
        let row = RegistryRow { id: id.to_string(), worktree_path: Some(wt.to_string()), ..RegistryRow::default() };
        st.upsert_registry(&row, inv.now, |_, _| true).ok()?;
        if let Some(why) = crate::meshw::summary::derive_after_write(&st, inv, repo_key) {
            crate::discard::note("dssup_labelfill_derive", &why);
        }
        Some(())
    })();
    held.release();
    done.is_some()
}
