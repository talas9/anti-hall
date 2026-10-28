//! The `child-sender-labels` post-update stage: the classification half of `repairChildSenderLabelsAllStores` of
//! `devswarm-lib/repair.js`.
//!
//! A CHILD worktree's old `primary-<hash>` sender label is aliased to the child's registry id and its unread mail forwarded before
//! the label row is tombstoned. That repair (the alias file, the forward into the child's partition, the tombstone, the
//! descriptor move) is Node's. This port walks every store exactly as Node does, READ-ONLY, and answers the stage itself only
//! when nothing needs repairing; the moment it meets something to repair (a child label with a resolvable child row; a sender
//! label to alias outside the preview) it returns `None` before anything is written and the stage's Node function does the whole
//! run. It never writes, moves or deletes anything. A path only git can place is the same deferral.
use super::Ctx;
use super::poststages::{Tally, jv, row_id, swallowed};
use super::readercur as rc;
use crate::defaults;
use crate::meshw::common::read_aliases;
use crate::meshw::ident::{self, Env, R};
use std::collections::{HashMap, HashSet};
use std::path::Path;

fn text(key: &str) -> &'static str {
    defaults::text(key)
}

/// A `primary-<8 hex>` sender label (`/^primary-[0-9a-f]{8}$/`).
fn is_label(s: &str) -> bool {
    let n = defaults::num("mesh_write.mesh_id_hex") as usize;
    s.strip_prefix(text("mesh_write.primary_prefix")).is_some_and(|h| h.len() == n && h.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
}

/// What one store's walk found.
enum Walk {
    /// Nothing to repair here (the counts are in the tally).
    Clean,
    /// Node must do the run.
    Node,
}

/// `canonicalWorktreeRealPath(p) ? canonicalMeshId(p) : rawPathMeshId(p)` and the canonical path itself.
fn label_of(wt: &str) -> R<(Option<String>, Option<String>)> {
    let canon = ident::canonical_worktree_real_path(wt)?;
    let label = if canon.is_some() { ident::canonical_mesh_id(wt)? } else { ident::raw_path_mesh_id(wt)? };
    Ok((canon, label))
}

/// `isPrimaryCheckout(ctx.worktreeRoot, ctx.mainWorktree, home, env)` of `identityContext(wt)`: false without a root.
fn primary_checkout(wt: &str, home: &Path, env: &Env) -> R<bool> {
    let c = ident::resolve_context(wt, false)?;
    match c.worktree_root.as_deref() {
        Some(root) => ident::is_primary_checkout(root, c.main_worktree.as_deref(), home, env),
        None => Ok(false),
    }
}

fn walk(ctx: &Ctx, h: &rc::Handle, dry: bool, env: &Env, t: &mut Tally) -> R<Walk> {
    let home = Path::new(&ctx.home);
    let registry = match h.rd().roster() {
        Ok(r) => r,
        Err(e) => {
            t.n.entry("errors").and_modify(|v| *v += 1.0).or_insert(1.0);
            swallowed(ctx, "child-sender-labels", "registry", &e.to_string());
            return Ok(Walk::Clean);
        }
    };
    let aliases: HashSet<String> = read_aliases(home).into_iter().map(|(k, _)| k).collect();
    let wt_of = |d: &serde_json::Value| jv(d, "worktreePath").as_str().filter(|w| !w.is_empty()).map(str::to_string);
    let primary_prefix = text("mesh_write.primary_prefix");
    for r in &registry {
        let (Some(id), Some(wt)) = (row_id(r), wt_of(r)) else { continue };
        if !id.starts_with(primary_prefix) {
            continue;
        }
        let (canon, label) = label_of(&wt)?;
        if label.as_deref() != Some(id.as_str()) {
            continue; // not this worktree's own label
        }
        let probe = canon.clone().unwrap_or_else(|| wt.clone());
        let app = ident::builder_for_worktree(home, env, &probe)?;
        let is_child = match app.as_ref().and_then(|a| a.builder_type.as_deref()).filter(|b| !b.is_empty()) {
            Some(bt) => bt != text("mesh_write.builder_type_primary"),
            None => match &canon {
                Some(c) => !primary_checkout(c, home, env)?,
                None => false, // unprovable: untouched
            },
        };
        if !is_child {
            continue; // the Primary checkout, or unprovable
        }
        *t.n.entry("labels").or_insert(0.0) += 1.0;
        let mut kids: Vec<String> = Vec::new();
        for d in &registry {
            let (Some(did), Some(dwt)) = (row_id(d), wt_of(d)) else { continue };
            if did.starts_with(primary_prefix) {
                continue;
            }
            let same = match &canon {
                Some(c) => ident::canonical_worktree_real_path(&dwt)?.as_deref() == Some(c.as_str()),
                None => ident::resolve(&ctx.cwd, &dwt) == ident::resolve(&ctx.cwd, &wt),
            };
            if same && !kids.contains(&did) {
                kids.push(did);
            }
        }
        let child = match &app {
            Some(a) if kids.contains(&a.id) => Some(a.id.clone()),
            _ if kids.len() == 1 => kids.first().cloned(),
            _ => None,
        };
        if child.is_some() {
            return Ok(Walk::Node); // aliasing, forwarding and retiring a label are Node's
        }
        // an ambiguous or missing child row is reported, never guessed: nothing to do
    }
    // sender labels with NO registry row: alias them too (Node), here only counted in the preview
    let reg_ids: HashSet<String> = registry.iter().filter_map(row_id).collect();
    let mut parts: Vec<String> = vec![text("mesh_write.broadcast_partition").to_string()];
    parts.extend(registry.iter().filter_map(row_id).filter(|i| !i.is_empty()));
    let mut labels: HashSet<String> = HashSet::new();
    for part in &parts {
        // an unreadable partition reads as no rows, as Node's `try { listMessages } catch { [] }`
        crate::discard::harmless(h.rd().for_each_message(part, 0, |m| {
            if let Some(s) = jv(&m, "sender").as_str().filter(|s| is_label(s) && !reg_ids.contains(*s) && !aliases.contains(*s)) {
                labels.insert(s.to_string());
            }
            true
        })); // keep: Node's `try { rows = s.listMessages(part) || [] } catch (_) { rows = [] }`
    }
    if labels.is_empty() {
        return Ok(Walk::Clean);
    }
    let mut order: Vec<String> = Vec::new();
    let mut by_label: HashMap<String, Vec<&serde_json::Value>> = HashMap::new();
    for d in &registry {
        let (Some(did), Some(dwt)) = (row_id(d), wt_of(d)) else { continue };
        if did.starts_with(primary_prefix) {
            continue;
        }
        let key = match ident::canonical_mesh_id(&dwt)? {
            Some(k) => Some(k),
            None => ident::raw_path_mesh_id(&dwt)?,
        };
        let Some(key) = key.filter(|k| labels.contains(k)) else { continue };
        if !by_label.contains_key(&key) {
            order.push(key.clone());
        }
        by_label.entry(key).or_default().push(d);
    }
    for label in order {
        let Some(rows) = by_label.get(&label) else { continue };
        let Some(first) = rows.first().and_then(|d| wt_of(d)) else { continue };
        let Some(wt) = ident::canonical_worktree_real_path(&first)? else { continue }; // unprovable: never guessed
        if primary_checkout(&wt, home, env)? {
            continue;
        }
        let mut ids: Vec<String> = Vec::new();
        for d in rows {
            if let Some(i) = row_id(d)
                && !ids.contains(&i)
            {
                ids.push(i);
            }
        }
        if ids.len() != 1 {
            continue;
        }
        if !dry {
            return Ok(Walk::Node); // the alias file is Node's to write
        }
        *t.n.entry("labels").or_insert(0.0) += 1.0;
        *t.n.entry("pending").or_insert(0.0) += 1.0;
    }
    Ok(Walk::Clean)
}

/// `repairChildSenderLabelsAllStores(home, { env, cwd })`; `None`: Node does it.
pub(crate) fn run(ctx: &Ctx, hashes: &[String], dry: bool) -> Option<Tally> {
    let home = Path::new(&ctx.home);
    let env: Env = ctx.env.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    let mut t = Tally::default();
    for hash in hashes {
        let h = match rc::open(home, hash, dry) {
            Ok(h) => h,
            Err(e) => {
                *t.n.entry("errors").or_insert(0.0) += 1.0;
                swallowed(ctx, "child-sender-labels", hash, &e);
                continue;
            }
        };
        *t.n.entry("stores").or_insert(0.0) += 1.0;
        match walk(ctx, &h, dry, &env, &mut t) {
            Ok(Walk::Clean) => {}
            Ok(Walk::Node) | Err(_) => return None,
        }
    }
    // applied: the remaining work is reported through `left`; a preview keeps its pending count (and its marker unstamped)
    t.pending_rows = if dry { t.n.get("pending").copied().unwrap_or(0.0) } else { 0.0 };
    if !dry {
        t.n.insert("pending", 0.0);
    }
    Some(t)
}
