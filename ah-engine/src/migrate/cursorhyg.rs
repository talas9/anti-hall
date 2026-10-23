//! The `cursor-hygiene` post-update stage: `gcInstanceCursors(null, home, ...)` of `devswarm-lib/cursors.js`.
//!
//! Since the mesh redesign (Phase 3) Node runs this pass REPORT-ONLY (`const dryRun = true`): the legacy `cursors/<id>#inst-<short>.json`
//! and `#nd-<short>.json` files are inert but they are the one-time import's source and the rollback path of an older build, so
//! nothing is removed, evicted or journaled; `deleted` and `evicted` count what the pre-Phase-3 pass WOULD have removed. This port
//! is the same read-only walk: it never deletes, moves or writes a file (the answer's `deleted`/`evicted` are counts, not actions).
//! The only write of the stage is its one-time completion marker, stamped by the stage table like every other stage's.
use super::Ctx;
use super::poststages::Tally;
use crate::defaults;
use crate::meshw::cursors;
use crate::meshw::idlock::devswarm_root;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// One instance cursor file.
struct Inst {
    value: f64,
    mtime_ms: f64,
    path: PathBuf,
}

/// `fs.statSync(p).mtimeMs` (0 when the file cannot be stat-ed).
fn mtime_ms(p: &Path) -> f64 {
    let Some(d) = std::fs::metadata(p).ok().and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()) else { return 0.0 };
    d.as_secs() as f64 * 1000.0 + f64::from(d.subsec_nanos()) / 1e6
}

/// `parseInstCursorName` / `parseNdCursorName`: `<id><sep><6 hex>.json` split on the LAST separator, the id a legacy-safe one.
fn parse_name(name: &str, sep: &str) -> Option<String> {
    let base = name.strip_suffix(defaults::text("mesh_write.json_suffix"))?;
    let i = base.rfind(sep).filter(|i| *i > 0)?;
    let (id, nonce) = (base.get(..i)?, base.get(i + sep.len()..)?);
    let short_len = defaults::num("mesh_write.legacy_cursor_short_len") as usize;
    if nonce.len() != short_len || !nonce.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) || !cursors::legacy_safe(id) {
        return None;
    }
    Some(id.to_string())
}

/// `gcInstanceCursors` with `dryRun = true`: the counts of the walk.
pub(crate) fn run(ctx: &Ctx) -> Tally {
    let home = Path::new(&ctx.home);
    let mut t = Tally::default();
    let dir = devswarm_root(home).join(defaults::text("mesh_write.dir_cursors"));
    let Ok(rd) = std::fs::read_dir(&dir) else { return t }; // no cursors dir yet
    // libuv's scandir sorts the names; so does Node's readdirSync
    let mut names: Vec<String> = rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    let now = crate::meshw::common::now_ms() as f64;
    let stale_ms = defaults::num("update_post.cursor_gc_stale_ms") as f64;
    let budget = defaults::num("update_post.cursor_gc_budget") as f64;
    let (inst_sep, nd_sep) = (defaults::text("update_post.legacy_inst_sep"), defaults::text("update_post.legacy_nd_sep"));
    // grouped per (namespace, id), in first-seen order; the two namespaces count in different index spaces and never mix
    let mut order: Vec<(bool, String)> = Vec::new();
    let mut groups: HashMap<(bool, String), Vec<Inst>> = HashMap::new();
    for n in &names {
        if t.get("scanned") >= budget {
            break;
        }
        let (is_inst, id) = match parse_name(n, inst_sep) {
            Some(id) => (true, id),
            None => match parse_name(n, nd_sep) {
                Some(id) => (false, id),
                None => continue, // not ours: never touched
            },
        };
        *t.n.entry("scanned").or_insert(0.0) += 1.0;
        let p = dir.join(n);
        let key = (is_inst, id);
        if !groups.contains_key(&key) {
            order.push(key.clone());
        }
        groups.entry(key).or_default().push(Inst { value: cursors::read_cursor(&p), mtime_ms: mtime_ms(&p), path: p });
    }
    for key in order {
        let (is_inst, id) = &key;
        let Some(files) = groups.get(&key) else { continue };
        // the baseline is read without the seeding side effect; the descriptor-cursor namespace has none
        let baseline = if *is_inst {
            let bp = dir.join(format!("{id}{}", defaults::text("update_post.legacy_base_suffix")));
            if bp.exists() { cursors::read_cursor(&bp) } else { cursors::read_cursor(&cursors::primary_cursor_path(home, id)) }
        } else {
            0.0
        };
        let mut remaining: Vec<&Inst> = files.iter().collect();
        for f in files {
            // candidacy is staleness, always: a fresh file is a live reader's position
            if now - f.mtime_ms <= stale_ms {
                *t.n.entry("kept").or_insert(0.0) += 1.0;
                continue;
            }
            let others: Vec<&Inst> = remaining.iter().copied().filter(|r| r.path != f.path).collect();
            let min_others = others.iter().map(|r| r.value).reduce(f64::min);
            let floor_now = match min_others {
                Some(m) => baseline.max(f.value.min(m)),
                None => baseline.max(f.value),
            };
            let floor_after = min_others.map_or(baseline, |m| baseline.max(m));
            remaining = others;
            *t.n.entry(if floor_after > floor_now { "evicted" } else { "deleted" }).or_insert(0.0) += 1.0;
        }
    }
    t
}
