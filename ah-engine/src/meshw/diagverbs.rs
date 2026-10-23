//! `devswarm.js diagnose` and `healthcheck` (`scripts/devswarm-lib/roster-diag.js` `computeDiagnosis`, `cmdDiagnose`,
//! `cmdHealthcheck`, `diagnoseHumanLine`, `healthcheckHumanLine`; `identity.js` `groupRegistryByMeshId`, `isRoutingLiveRow`;
//! `companion/lib/devswarm-liveness-select.js` `pickFreshestLive`).
//!
//! Both verbs read: the registry of the project of the cwd, the summary projection (unread counts, stale partitions), each row's
//! descriptor, the archive markers and the app database, the heartbeats and the session records. Nothing is written.
//!
//! The classification is the one Node makes: the rows are grouped by the canonical mesh id of their worktree; a group of two or
//! more rows is partitioned, and its kind follows from how many of its rows are live (`live`: two or more, `mixed`: exactly one,
//! `dead`: none); the partition `send --to <meshId>` lands in is the freshest live row (session reference integrity, drain
//! evidence of the cursors, a heartbeat written by the session itself, then recency). An unreadable registry reads as no rows
//! and is reported as `storeUnavailable`, as Node reports it.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an unreadable optional file is the same as an absent one (fail-open, as Node's try/catch)
use crate::checks::guardkit::ojson::OVal;
use crate::defaults;
use crate::meshw::args::Args;
use crate::meshw::common::{Inv, Obj, n, s, s_or_null};
use crate::meshw::extverbs::tpl;
use crate::meshw::ident::{self, R, Row};
use crate::meshw::idlock::devswarm_root;
use crate::meshw::rosterrows::Verdicts;
use crate::meshw::send::{Answer, Effect};
use std::collections::HashSet;

fn text(k: &str) -> &'static str {
    defaults::text(k)
}

fn answer(code: i32, stdout: String) -> Answer {
    Answer { code, stdout: format!("{stdout}\n"), effect: Effect::None }
}

/// What `computeDiagnosis` hands the two verbs.
struct Diagnosis {
    rows: Vec<OVal>,
    mesh_targets: Vec<OVal>,
    splits: Vec<String>,
    dead_splits: Vec<String>,
    mixed_splits: Vec<String>,
    orphans: Vec<OVal>,
    stale: Vec<OVal>,
    phantoms: f64,
    unread_total: f64,
    /// `storeUnavailable`: the registry could not be read (Node's `readAll` fail-open reads it as no rows and says so).
    unavailable: bool,
}

fn strings(v: &[String]) -> OVal {
    OVal::Arr(v.iter().map(|x| s(x)).collect())
}

/// `isRealSid`: a non-empty session that is neither the id nor a synthetic marker.
fn is_real_sid(v: Option<&str>, id: &str) -> bool {
    v.is_some_and(|x| !js_blank(x) && x != id && !x.starts_with(text("mesh_write.synthetic_session_prefix")))
}

fn js_blank(x: &str) -> bool {
    crate::checks::guardkit::text::js_trim(x).is_empty()
}

fn num_of(v: Option<&OVal>) -> Option<f64> {
    match v {
        Some(OVal::Num(x)) if x.is_finite() => Some(*x),
        _ => None,
    }
}

/// `sessionAuthoredHeartbeat(home, id)`: the heartbeat record names a session.
fn session_authored_heartbeat(inv: &Inv, id: &str) -> bool {
    let p = devswarm_root(&inv.home).join(text("mesh_write.dir_heartbeats")).join(format!("{id}{}", text("mesh_write.json_suffix")));
    let Some(v) = std::fs::read(p).ok().and_then(|b| OVal::parse(&String::from_utf8_lossy(&b))) else { return false };
    if !matches!(v, OVal::Obj(_) | OVal::Arr(_)) {
        return false;
    }
    match v.get(text("mesh_write.field_session_id")) {
        None | Some(OVal::Null) => false,
        Some(OVal::Str(x)) => !x.is_empty(),
        Some(_) => true,
    }
}

/// `pickFreshestLive(candidates, { storeHandle, home, isLive })`.
pub(crate) fn pick_freshest<'a>(inv: &Inv, rd: &crate::mesh::MeshReader, cands: &'a [Row], live: &dyn Fn(&Row) -> R<bool>) -> R<Option<&'a Row>> {
    let group: HashSet<&str> = cands.iter().map(|d| d.id.as_str()).collect();
    // cursorEvidence(store, id): (has a cursor row, cursor value, unread by the count)
    let evidence = |id: &str| -> (bool, f64, Option<bool>) {
        let value = rd.cursor(id).map_or(-1.0, |v| v as f64);
        let exists = rd.has_cursor_row(id).unwrap_or(false);
        let unread = rd.message_count(id).ok().map(|t| t as f64 > if value > 0.0 { value } else { 0.0 });
        (exists, value, unread)
    };
    let mut any_drain = false;
    let mut flags: Vec<bool> = Vec::new();
    for d in cands {
        let l = live(d)?;
        flags.push(l);
        if l && !any_drain {
            let (exists, value, _) = evidence(&d.id);
            any_drain = exists || value > 0.0;
        }
    }
    let mut best: Option<(&Row, [f64; 5])> = None;
    for (d, l) in cands.iter().zip(&flags) {
        if !l {
            continue;
        }
        let sid = d.session_id.as_deref().unwrap_or_default();
        let alias = !sid.is_empty() && sid != d.id && group.contains(sid);
        let mut b_ok = true;
        if any_drain {
            let (exists, value, unread) = evidence(&d.id);
            let good = exists || value > 0.0;
            let bad = !exists && value <= 0.0 && unread == Some(true);
            if !good && bad {
                b_ok = false;
            }
        }
        let credit = session_authored_heartbeat(inv, &d.id);
        let updated = d.updated_at.filter(|u| u.is_finite()).unwrap_or(-1.0);
        let tie = rd.cursor(&d.id).map_or(-1.0, |v| v as f64);
        let score = [f64::from(u8::from(!alias)), f64::from(u8::from(b_ok)), f64::from(u8::from(credit)), updated, tie];
        match &best {
            None => best = Some((d, score)),
            Some((_, bs)) => {
                let mut ord = std::cmp::Ordering::Equal;
                for (x, y) in score.iter().zip(bs.iter()) {
                    if x > y {
                        ord = std::cmp::Ordering::Greater;
                        break;
                    }
                    if x < y {
                        ord = std::cmp::Ordering::Less;
                        break;
                    }
                }
                if ord == std::cmp::Ordering::Greater {
                    best = Some((d, score));
                }
            }
        }
    }
    if let Some((d, _)) = best {
        return Ok(Some(d));
    }
    // pickDeterministicFallback: the newest row, the smaller id on a tie
    let mut winner: Option<&Row> = None;
    for d in cands {
        let u = |r: &Row| r.updated_at.filter(|x| x.is_finite()).unwrap_or(-1.0);
        winner = match winner {
            None => Some(d),
            Some(w) if u(d) > u(w) => Some(d),
            Some(w) if u(d) < u(w) => Some(w),
            Some(w) => Some(if d.id < w.id { d } else { w }),
        };
    }
    Ok(winner)
}

fn diagnose_store(inv: &Inv, repo_key: &str) -> R<Diagnosis> {
    let reader = crate::meshw::tick::open_reader_creating(inv, repo_key)?;
    // roster-diag.js:855-877 `listRegistry()` swallows a read error to no rows; `pickStoreReadErrorScope` then marks the store unavailable
    let roster = match reader.roster() {
        Ok(r) => r,
        Err(e) => {
            crate::debug::violated("meshw", &defaults::render("mesh_write.msg_registry_unreadable", &[("error", &e)]));
            return Ok(Diagnosis {
                rows: Vec::new(),
                mesh_targets: Vec::new(),
                splits: Vec::new(),
                dead_splits: Vec::new(),
                mixed_splits: Vec::new(),
                orphans: Vec::new(),
                stale: Vec::new(),
                phantoms: 0.0,
                unread_total: 0.0,
                unavailable: true,
            });
        }
    };
    let rows = ident::rows_of(&roster);
    let st = crate::meshw::common::open_store(inv, repo_key)?;
    let sum = crate::meshw::summary::compute(&st, inv, None)?;
    let workspaces = sum.get("workspaces");
    // an index-like id sorts first in a JS object; every use of `workspaces` below is a lookup by id or an order-free sum
    let v = Verdicts::new(inv, repo_key);
    let ws_of = |id: &str| workspaces.and_then(|w| w.get(id));
    let mut out_rows: Vec<OVal> = Vec::new();
    let mut phantoms = 0.0;
    for d in &rows {
        if d.id.is_empty() {
            continue;
        }
        let desc = ident::read_descriptor(&inv.home, &d.id);
        let reg_sid = d.session_id.as_deref().filter(|x| !x.is_empty());
        let desc_sid = match desc.as_ref().and_then(|x| x.get(text("mesh_write.field_session_id"))) {
            None | Some(OVal::Null) => None,
            Some(OVal::Str(x)) => Some(x.clone()),
            // roster-diag.js:996 `String(desc.sessionId)`: an array or object reads as its JS text
            Some(x) => Some(crate::dssup::ingest::import::js_string(x)),
        };
        let sid: Option<String> =
            if !is_real_sid(reg_sid, &d.id) && is_real_sid(desc_sid.as_deref(), &d.id) { desc_sid.clone() } else { reg_sid.map(str::to_string) };
        let wt = d.worktree_path.as_deref().filter(|x| !x.is_empty());
        let archived = v.archived(&d.id, wt)?;
        let live_sid = sid.as_deref().filter(|x| !x.is_empty());
        let live = if archived { false } else { v.live(&d.id, wt, live_sid)? };
        if !live {
            phantoms += 1.0;
        }
        let unread = num_of(ws_of(&d.id).and_then(|w| w.get("unread"))).unwrap_or(0.0);
        let mut o = Obj::default();
        o.put("id", s(&d.id))
            .put("worktreePath", s_or_null(wt))
            .put("sessionId", s_or_null(sid.as_deref()))
            .put("live", OVal::Bool(live))
            .put("unread", n(unread))
            .put("archivedInApp", OVal::Bool(archived));
        if let Some(ds) = &desc_sid
            && Some(ds.as_str()) != reg_sid
        {
            o.put("descriptorSessionId", s(ds));
        }
        out_rows.push(o.done());
    }
    // groupRegistryByMeshId
    struct Group {
        mesh: String,
        ids: Vec<String>,
        n_rows: usize,
        live_rows: usize,
    }
    let mut groups: Vec<Group> = Vec::new();
    for d in &rows {
        let Some(wt) = d.worktree_path.as_deref().filter(|x| !x.is_empty()) else { continue };
        let Some(mesh) = ident::canonical_mesh_id(wt)? else { continue };
        let archived = v.archived(&d.id, Some(wt))?;
        let sid = d.session_id.as_deref().filter(|x| !x.is_empty());
        let routing_live = !archived && (v.live(&d.id, Some(wt), sid)? || ident::read_descriptor(&inv.home, &d.id).is_some());
        let at = match groups.iter().position(|g| g.mesh == mesh) {
            Some(i) => i,
            None => {
                groups.push(Group { mesh: mesh.clone(), ids: Vec::new(), n_rows: 0, live_rows: 0 });
                groups.len() - 1
            }
        };
        groups[at].ids.push(d.id.clone());
        groups[at].n_rows += 1;
        if routing_live {
            groups[at].live_rows += 1;
        }
    }
    let (mut splits, mut dead, mut mixed) = (Vec::new(), Vec::new(), Vec::new());
    let mut targets: Vec<OVal> = Vec::new();
    let strict = |d: &Row| -> R<bool> {
        let wt = d.worktree_path.as_deref().filter(|x| !x.is_empty());
        if v.archived(&d.id, wt)? {
            return Ok(false);
        }
        v.live(&d.id, wt, d.session_id.as_deref().filter(|x| !x.is_empty()))
    };
    for g in &groups {
        let cands = crate::meshw::send::mesh_candidates(&rows, Some(&g.mesh))?;
        let target = match cands.len() {
            0 => None,
            1 => Some(&cands[0]),
            _ => pick_freshest(inv, st.reader(), &cands, &strict)?,
        };
        let (mut live_split, mut dead_split, mut mixed_split) = (false, false, false);
        let mut kind = OVal::Null;
        if g.n_rows >= 2 {
            if g.live_rows >= 2 {
                kind = s("live");
                live_split = true;
            } else if g.live_rows == 1 {
                kind = s("mixed");
                mixed_split = true;
            } else {
                kind = s("dead");
                dead_split = true;
            }
        }
        if live_split {
            splits.push(g.mesh.clone());
        }
        if dead_split {
            dead.push(g.mesh.clone());
        }
        if mixed_split {
            mixed.push(g.mesh.clone());
        }
        let mut o = Obj::default();
        o.put("meshId", s(&g.mesh))
            .put("resolvesTo", target.map_or(OVal::Null, |t| s(&t.id)))
            .put("ids", strings(&g.ids))
            .put("liveRows", n(g.live_rows as f64))
            .put("split", OVal::Bool(live_split))
            .put("deadSplit", OVal::Bool(dead_split))
            .put("mixedSplit", OVal::Bool(mixed_split))
            .put("kind", kind);
        targets.push(o.done());
    }
    let mut unread_total = 0.0;
    if let Some(OVal::Obj(w)) = workspaces {
        for (_, e) in w {
            if let Some(x) = num_of(e.get("directUnread")) {
                unread_total += x;
            }
        }
    }
    let list = |k: &str| match sum.get(k) {
        Some(OVal::Arr(a)) => a.clone(),
        _ => Vec::new(),
    };
    Ok(Diagnosis {
        rows: out_rows,
        mesh_targets: targets,
        splits,
        dead_splits: dead,
        mixed_splits: mixed,
        orphans: list("orphans"),
        stale: list("staleRegistryPartitions"),
        phantoms,
        unread_total,
        unavailable: false,
    })
}

/// The project of the cwd and its diagnosis; the `no-project` answer when the cwd is in none.
fn load(inv: &Inv) -> R<Result<(String, Diagnosis), ()>> {
    let Some(repo_key) = ident::repo_key_for_worktree(&inv.cwd)? else { return Ok(Err(())) };
    let d = diagnose_store(inv, &repo_key)?;
    Ok(Ok((repo_key, d)))
}

fn no_project(a: &Args, human_key: &str) -> Answer {
    if wants_json(a) {
        let mut o = Obj::default();
        o.put("ok", OVal::Bool(false)).put("reason", s(text("devswarm_cli.diag_reason_no_project")));
        answer(2, o.done().stringify())
    } else {
        answer(2, text(human_key).to_string())
    }
}

fn wants_json(a: &Args) -> bool {
    a.raw.iter().any(|x| x == text("devswarm_cli.json_word"))
}

fn unavailable_reason(unavailable: bool) -> OVal {
    if unavailable { s(text("devswarm_cli.diag_unavailable_reason")) } else { OVal::Null }
}

fn unavailable_scope(unavailable: bool) -> OVal {
    if unavailable { s(text("devswarm_cli.diag_unavailable_scope")) } else { OVal::Null }
}

fn unavailable_msg(key: &str) -> String {
    tpl(key, &[("scope", text("devswarm_cli.diag_unavailable_scope")), ("reason", text("devswarm_cli.diag_unavailable_reason"))])
}

fn dead_msg(count: usize) -> String {
    tpl("devswarm_cli.diag_warn_dead", &[("n", &count.to_string())])
}

fn mixed_msg(count: usize) -> String {
    tpl("devswarm_cli.diag_warn_mixed", &[("n", &count.to_string())])
}

/// `diagnose [--json]`.
pub fn diagnose(inv: &Inv, a: &Args) -> R<Answer> {
    let (repo_key, d) = match load(inv)? {
        Ok(x) => x,
        Err(()) => return Ok(no_project(a, "devswarm_cli.diag_line_no_project")),
    };
    let danger = d.dead_splits.len() + d.mixed_splits.len();
    let degraded = d.unavailable || danger > 0 || !d.splits.is_empty();
    let mut warning: Option<String> = None;
    if d.unavailable {
        warning = Some(unavailable_msg("devswarm_cli.diag_warn_unreadable"));
    }
    if !d.dead_splits.is_empty() {
        let m = dead_msg(d.dead_splits.len());
        warning = Some(match warning {
            Some(w) => format!("{w}{}{m}", text("devswarm_cli.diag_warn_join")),
            None => m,
        });
    }
    if !d.mixed_splits.is_empty() {
        let m = mixed_msg(d.mixed_splits.len());
        warning = Some(match warning {
            Some(w) => format!("{w}{}{m}", text("devswarm_cli.diag_warn_join")),
            None => m,
        });
    }
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(true))
        .put("action", s(text("devswarm_cli.verb_diagnose")))
        .put("repoKey", s(&repo_key))
        .put("known", OVal::Bool(!d.unavailable))
        .put("storeUnavailable", OVal::Bool(d.unavailable))
        .put("storeUnavailableReason", unavailable_reason(d.unavailable))
        .put("storeUnavailableScope", unavailable_scope(d.unavailable))
        .put("count", n(d.rows.len() as f64))
        .put("registry", OVal::Arr(d.rows.clone()))
        .put("meshTargets", OVal::Arr(d.mesh_targets.clone()))
        .put("splits", strings(&d.splits))
        .put("deadSplits", strings(&d.dead_splits))
        .put("mixedSplits", strings(&d.mixed_splits))
        .put("orphans", OVal::Arr(d.orphans.clone()))
        .put("heldPartitions", OVal::Arr(Vec::new()))
        .put("staleRegistryPartitions", OVal::Arr(d.stale.clone()))
        .put("degraded", OVal::Bool(degraded))
        .put("warning", s_or_null(warning.as_deref()));
    let result = o.done();
    if wants_json(a) {
        return Ok(answer(0, result.stringify()));
    }
    let parts = [
        ("registry", d.rows.len()),
        ("splits", d.splits.len()),
        ("deadSplits", d.dead_splits.len()),
        ("mixedSplits", d.mixed_splits.len()),
        ("orphans", d.orphans.len()),
        ("held", 0),
        ("stale", d.stale.len()),
    ];
    let parts: Vec<String> = parts.iter().map(|(k, c)| format!("{k}={c}")).collect();
    let status = if degraded { text("devswarm_cli.diag_status_degraded") } else { text("devswarm_cli.diag_status_ok") };
    let tail = warning.map_or(String::new(), |w| tpl("devswarm_cli.diag_line_warning", &[("warning", &w)]));
    let line = tpl(
        "devswarm_cli.diag_line",
        &[("status", status), ("scope", &tpl("devswarm_cli.diag_scope", &[("key", &repo_key)])), ("parts", &parts.join(" ")), ("warning", &tail)],
    );
    Ok(answer(0, line))
}

/// `healthcheck [--json]`.
pub fn healthcheck(inv: &Inv, a: &Args) -> R<Answer> {
    let (repo_key, d) = match load(inv)? {
        Ok(x) => x,
        Err(()) => return Ok(no_project(a, "devswarm_cli.health_line_no_project")),
    };
    let orphans = d.orphans.len();
    let degraded = d.unavailable || orphans > 0 || !d.stale.is_empty() || !d.splits.is_empty() || !d.dead_splits.is_empty() || !d.mixed_splits.is_empty();
    let mut counts = Obj::default();
    counts
        .put("orphansWithUnread", n(orphans as f64))
        .put("orphans", n(orphans as f64))
        .put("stale", n(d.stale.len() as f64))
        .put("splits", n(d.splits.len() as f64))
        .put("deadSplits", n(d.dead_splits.len() as f64))
        .put("mixedSplits", n(d.mixed_splits.len() as f64))
        .put("phantoms", n(d.phantoms))
        .put("unreadTotal", n(d.unread_total));
    let mut detail = Obj::default();
    detail
        .put("orphans", OVal::Arr(d.orphans.clone()))
        .put("staleRegistryPartitions", OVal::Arr(d.stale.clone()))
        .put("splits", strings(&d.splits))
        .put("deadSplits", strings(&d.dead_splits))
        .put("mixedSplits", strings(&d.mixed_splits));
    let status = if d.unavailable {
        text("devswarm_cli.health_status_unavailable")
    } else if degraded {
        text("devswarm_cli.diag_status_degraded")
    } else {
        text("devswarm_cli.diag_status_ok")
    };
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(!degraded))
        .put("action", s(text("devswarm_cli.verb_healthcheck")))
        .put("repoKey", s(&repo_key))
        .put("status", s(status))
        .put("known", OVal::Bool(!d.unavailable))
        .put("storeUnavailable", OVal::Bool(d.unavailable))
        .put("storeUnavailableReason", unavailable_reason(d.unavailable))
        .put("storeUnavailableScope", unavailable_scope(d.unavailable))
        .put("counts", counts.done())
        .put("detail", detail.done());
    let code = if degraded { 2 } else { 0 };
    if wants_json(a) {
        return Ok(answer(code, o.done().stringify()));
    }
    let parts = [
        ("orphansWithUnread", orphans as f64),
        ("stale", d.stale.len() as f64),
        ("splits", d.splits.len() as f64),
        ("deadSplits", d.dead_splits.len() as f64),
        ("mixedSplits", d.mixed_splits.len() as f64),
        ("phantoms", d.phantoms),
        ("unread", d.unread_total),
    ];
    let parts: Vec<String> = parts.iter().map(|(k, c)| format!("{k}={}", crate::checks::jsport::num::to_js_string(*c))).collect();
    let mut warning = String::new();
    if d.unavailable {
        warning += &tpl("devswarm_cli.diag_line_warning", &[("warning", &unavailable_msg("devswarm_cli.health_warn_unreadable"))]);
    }
    if !d.dead_splits.is_empty() {
        warning += &tpl("devswarm_cli.diag_line_warning", &[("warning", &dead_msg(d.dead_splits.len()))]);
    }
    if !d.mixed_splits.is_empty() {
        warning += &tpl("devswarm_cli.diag_line_warning", &[("warning", &mixed_msg(d.mixed_splits.len()))]);
    }
    let line = tpl(
        "devswarm_cli.health_line",
        &[("status", status), ("scope", &tpl("devswarm_cli.diag_scope", &[("key", &repo_key)])), ("parts", &parts.join(" ")), ("warning", &warning)],
    );
    Ok(answer(code, line))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::meshw::store::{MeshStore, RegistryRow};

    fn repo_inv(tag: &str) -> (Inv, String) {
        defaults::init().unwrap();
        let home = std::env::temp_dir().join(format!("ah-diag-{tag}-{}", std::process::id()));
        crate::discard::harmless(std::fs::remove_dir_all(&home)); // keep: a stale directory of an earlier run of this test
        let repo = home.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let st = std::process::Command::new("git").current_dir(&repo).args(["init", "-q", "-b", "main"]).env("GIT_CONFIG_NOSYSTEM", "1").status().unwrap();
        assert!(st.success());
        let cwd = repo.canonicalize().unwrap().to_string_lossy().into_owned();
        let mut env = std::collections::HashMap::new();
        env.insert(defaults::text("mesh_write.env_app_db").to_string(), defaults::text("mesh_write.app_db_off").to_string());
        let inv = Inv { home: home.clone(), write_home: home, env, cwd: cwd.clone(), now: 1_700_000_000_000, stdin: None, store_override: None };
        (inv, cwd)
    }

    fn store_dir(inv: &Inv, cwd: &str) -> std::path::PathBuf {
        let key = ident::repo_key_for_worktree(cwd).unwrap().unwrap();
        let dir = crate::meshw::union::store_dir(&inv.home, &key);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(defaults::text("mesh.backend_marker")), defaults::text("mesh.backend_sqlite")).unwrap();
        dir
    }

    fn json_args(verb: &str) -> Args {
        crate::meshw::args::parse(&[verb.to_string(), "--json".to_string()])
    }

    #[test]
    fn an_index_like_id_and_a_session_of_another_type_are_read_as_javascript_reads_them() {
        let (inv, cwd) = repo_inv("types");
        let dir = store_dir(&inv, &cwd);
        let st = MeshStore::open(&dir.join(defaults::text("mesh_write.store_file"))).unwrap();
        for id in ["w1", "5"] {
            let row = RegistryRow { id: id.into(), worktree_path: Some(cwd.clone()), session_id: None, inbox_path: None, cursor_path: None, nudge_command: None };
            st.upsert_registry(&row, 1, |a, b| a == b).unwrap();
        }
        drop(st);
        let ws = crate::meshw::idlock::devswarm_root(&inv.home).join(defaults::text("mesh_write.dir_workspaces"));
        std::fs::create_dir_all(&ws).unwrap();
        std::fs::write(ws.join("w1.json"), r#"{"id":"w1","sessionId":[1,2]}"#).unwrap();
        let ans = diagnose(&inv, &json_args("diagnose")).unwrap();
        let v = OVal::parse(ans.stdout.trim()).unwrap();
        let Some(OVal::Arr(rows)) = v.get("registry") else { panic!("{}", ans.stdout) };
        assert_eq!(rows.len(), 2, "{}", ans.stdout);
        let w1 = rows.iter().find(|r| matches!(r.get("id"), Some(OVal::Str(i)) if i == "w1")).unwrap();
        assert_eq!(w1.get("descriptorSessionId"), Some(&OVal::Str("1,2".into())), "an array session reads as its JavaScript text");
        assert_eq!(v.get("storeUnavailable"), Some(&OVal::Bool(false)));
    }

    #[test]
    fn an_unreadable_registry_is_reported_as_unavailable_as_node_reports_it() {
        let (inv, cwd) = repo_inv("unavailable");
        let dir = store_dir(&inv, &cwd);
        // a valid database without a registry table: it opens, the read fails
        rusqlite::Connection::open(dir.join(defaults::text("mesh_write.store_file"))).unwrap().execute_batch("CREATE TABLE unrelated (x)").unwrap();
        let ans = diagnose(&inv, &json_args("diagnose")).unwrap();
        let v = OVal::parse(ans.stdout.trim()).unwrap();
        assert_eq!(v.get("storeUnavailable"), Some(&OVal::Bool(true)), "{}", ans.stdout);
        assert_eq!(v.get("known"), Some(&OVal::Bool(false)));
        assert_eq!(v.get("storeUnavailableReason"), Some(&OVal::Str("EUNKNOWN".into())));
        assert_eq!(v.get("storeUnavailableScope"), Some(&OVal::Str("registry".into())));
        assert_eq!(v.get("degraded"), Some(&OVal::Bool(true)));
        assert_eq!(v.get("warning"), Some(&OVal::Str("registry unreadable (EUNKNOWN) — counts below are unknown, not verified-zero".into())));
        let h = healthcheck(&inv, &json_args("healthcheck")).unwrap();
        assert_eq!(h.code, 2);
        let hv = OVal::parse(h.stdout.trim()).unwrap();
        assert_eq!(hv.get("status"), Some(&OVal::Str("store-unavailable".into())));
        assert_eq!(hv.get("ok"), Some(&OVal::Bool(false)));
        let text = healthcheck(&inv, &crate::meshw::args::parse(&["healthcheck".to_string()])).unwrap();
        assert!(text.stdout.contains(" — warning: registry unreadable (EUNKNOWN) — counts above are unknown, not verified-zero"), "{}", text.stdout);
    }
}
