//! The app-database verbs of `devswarm.js` (lane l8b): `app-state` and `app-sync`, ported from `scripts/devswarm-lib/repair.js`
//! (`cmdAppState`, `formatAppState`, `syncAppState`) on top of the engine's own app sync ([`crate::dssup::appsync`]).
//!
//! * `app-state [--json]` is read-only: one fresh snapshot of the DevSwarm desktop app's database, the state document computed (not
//!   written), the last supervisor sync's gap report from `app-state.json`. Without `--json` it prints the table `formatAppState`
//!   builds, else the JSON result.
//! * `app-sync [--dry-run]` is the supervisor's sync step on demand: archived markers, the names cache and `app-state.json`. The
//!   same rule as the supervisor's native duty holds, made stricter for a verb the user sees: Node's own dry run must name the same
//!   markers BEFORE the first write; a disagreement, a Node that cannot run, or a marker retirement to do (Node's function is the
//!   actor there) hands the whole verb to Node with nothing written.
//!
//! Deferred BEFORE the first write (Node then runs the verb): whatever the app sync itself defers (a shape JavaScript would order
//! or evaluate differently), an object key JavaScript orders first, a gap report the formatter cannot print exactly.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an unreadable optional file is the same as an absent one (fail-open, as Node's try/catch)
// A failure that must be seen goes through `crate::discard` instead.
use crate::checks::guardkit::ojson::{OVal, is_array_index_key};
use crate::checks::jsport::num::to_js_string;
use crate::checks::guardkit::text::slice_utf16;
use crate::defaults;
use crate::dsact::runner::{Runner, System};
use crate::dssup::appsync::{self, Opts};
use crate::dssup::tick::Ctx;
use crate::meshw::args::Args;
use crate::meshw::common::{Inv, Obj, n, s};
use crate::meshw::extverbs::tpl;
use crate::meshw::ident::{R, defer};
use crate::meshw::idlock::devswarm_root;
use crate::meshw::send::{Answer, Effect};
use std::collections::BTreeMap;
use std::path::Path;

fn answer(code: i32, text: String) -> Answer {
    Answer { code, stdout: format!("{text}\n"), effect: Effect::None }
}

fn truthy(v: Option<&OVal>) -> bool {
    v.is_some_and(OVal::truthy)
}

/// `'' + v` for the scalars JavaScript prints the same everywhere; `None` (absent) is `undefined`. Containers defer.
fn concat(v: Option<&OVal>) -> R<String> {
    Ok(match v {
        None => "undefined".to_string(),
        Some(OVal::Null) => "null".to_string(),
        Some(OVal::Bool(b)) => b.to_string(),
        Some(OVal::Num(x)) => to_js_string(*x),
        Some(OVal::Str(t)) => t.clone(),
        Some(_) => return defer("concat-container"),
    })
}

/// `String(id).slice(0, 8)`.
fn short(id: &str) -> R<String> {
    slice_utf16(id, defaults::num("devswarm_cli.app_short_id") as usize).ok_or_else(|| crate::meshw::ident::Defer("surrogate-cut".into()))
}

/// `a || b` over two strings-or-scalars, as the text `+` prints.
fn either(a: Option<&OVal>, b: Option<&OVal>) -> R<String> {
    if truthy(a) { concat(a) } else { concat(b) }
}

fn list_join(v: Option<&OVal>, sep: &str) -> R<String> {
    let Some(OVal::Arr(items)) = v else { return defer("list-shape") };
    let mut parts = Vec::new();
    for i in items {
        parts.push(match i {
            OVal::Str(t) => t.clone(),
            OVal::Num(x) => to_js_string(*x),
            // `join` prints null and undefined as empty
            OVal::Null => String::new(),
            _ => return defer("join-element"),
        });
    }
    Ok(parts.join(sep))
}

/// The people-and-ids list of `unknownToAntiHall` / `openButMarkedArchived`: `(label || id) (id8)` joined.
fn id_list(v: Option<&OVal>) -> R<String> {
    let Some(OVal::Arr(items)) = v else { return defer("list-shape") };
    let mut parts = Vec::new();
    for u in items {
        let id = match u.get("id") {
            Some(OVal::Str(t)) => t.clone(),
            _ => return defer("id-shape"),
        };
        parts.push(format!("{} ({})", either(u.get("label"), u.get("id"))?, short(&id)?));
    }
    Ok(parts.join(defaults::text("devswarm_cli.app_join_semi")))
}

/// `formatAppState(r)`.
fn format_app_state(r: &OVal) -> R<String> {
    if !truthy(r.get("appDb")) {
        let reason = if truthy(r.get("reason")) { concat(r.get("reason"))? } else { defaults::text("devswarm_cli.app_no_db").to_string() };
        return Ok(tpl("devswarm_cli.app_msg_unavailable", &[("reason", reason.as_str())]));
    }
    let Some(counts) = r.get("counts").filter(|c| matches!(c, OVal::Obj(_))) else { return defer("counts-shape") };
    let mut l: Vec<String> = Vec::new();
    let version = if truthy(r.get("appVersion")) { concat(r.get("appVersion"))? } else { defaults::text("devswarm_cli.app_version_unknown").to_string() };
    l.push(tpl(
        "devswarm_cli.app_msg_head",
        &[
            ("version", version.as_str()),
            ("builders", concat(counts.get("builders"))?.as_str()),
            ("active", concat(counts.get("active"))?.as_str()),
            ("archived", concat(counts.get("archived"))?.as_str()),
        ],
    ));
    let nonempty = |v: Option<&OVal>| -> R<bool> {
        match v {
            Some(OVal::Arr(a)) => Ok(!a.is_empty()),
            _ => defer("list-shape"),
        }
    };
    if nonempty(r.get("missing"))? {
        l.push(tpl("devswarm_cli.app_msg_missing", &[("list", list_join(r.get("missing"), defaults::text("devswarm_cli.app_join_comma"))?.as_str())]));
    }
    if nonempty(r.get("gated"))? {
        l.push(tpl("devswarm_cli.app_msg_gated", &[("list", list_join(r.get("gated"), defaults::text("devswarm_cli.app_join_comma"))?.as_str())]));
    }
    l.push(defaults::text("devswarm_cli.app_table_head").to_string());
    l.push(defaults::text("devswarm_cli.app_table_rule").to_string());
    let sessions = r.get("sessions");
    let Some(OVal::Arr(active)) = r.get("active") else { return defer("list-shape") };
    let dash = defaults::text("devswarm_cli.app_dash");
    for a in active {
        let id = match a.get("id") {
            Some(OVal::Str(t)) => t.clone(),
            _ => return defer("id-shape"),
        };
        let label = either(a.get("label"), a.get("id"))?.replace('|', "\\|");
        let mut title = tpl("devswarm_cli.app_title", &[("label", label.as_str()), ("id", short(&id)?.as_str())]);
        if truthy(a.get("isPinned")) {
            title.push_str(defaults::text("devswarm_cli.app_pinned"));
        }
        if truthy(a.get("focused")) {
            title.push_str(defaults::text("devswarm_cli.app_on_screen"));
        }
        let sess = match a.get("sessionId") {
            Some(OVal::Str(sid)) if !sid.is_empty() => {
                if sid == defaults::text("devswarm_cli.app_proto_key") {
                    return defer("proto-key");
                }
                let corroborated = truthy(sessions.and_then(|m| m.get(sid)).and_then(|e| e.get("corroborated")));
                format!("{}{}", short(sid)?, if corroborated { "" } else { defaults::text("devswarm_cli.app_unverified") })
            }
            Some(v) if !v.truthy() => dash.to_string(),
            None => dash.to_string(),
            _ => return defer("session-shape"),
        };
        let rank = match a.get("rank") {
            None | Some(OVal::Null) => dash.to_string(),
            v => concat(v)?,
        };
        let or_dash = |k: &str| -> R<String> { if truthy(a.get(k)) { concat(a.get(k)) } else { Ok(dash.to_string()) } };
        l.push(tpl(
            "devswarm_cli.app_row",
            &[
                ("rank", rank.as_str()),
                ("title", title.as_str()),
                ("type", or_dash("builderType")?.as_str()),
                ("finish", or_dash("finish")?.as_str()),
                ("brief", or_dash("brief")?.as_str()),
                ("session", sess.as_str()),
            ],
        ));
    }
    let unknown = r.get("unknownToAntiHall");
    if nonempty(unknown)? {
        l.push(tpl("devswarm_cli.app_msg_unknown", &[("list", id_list(unknown)?.as_str())]));
    }
    let stale = r.get("openButMarkedArchived");
    if nonempty(stale)? {
        l.push(tpl("devswarm_cli.app_msg_stale", &[("list", id_list(stale)?.as_str())]));
    }
    if truthy(r.get("wouldMark")) {
        l.push(tpl("devswarm_cli.app_msg_would_mark", &[("n", concat(r.get("wouldMark"))?.as_str())]));
    }
    if nonempty(r.get("scheduledForDeletion"))? {
        l.push(tpl(
            "devswarm_cli.app_msg_deletion",
            &[("list", list_join(r.get("scheduledForDeletion"), defaults::text("devswarm_cli.app_join_comma"))?.as_str())],
        ));
    }
    match r.get("gaps").filter(|g| g.truthy()) {
        Some(g) => {
            let Some(OVal::Arr(repos)) = g.get("repos") else { return defer("gaps-shape") };
            for repo in repos {
                if !matches!(repo, OVal::Obj(_)) {
                    return defer("gaps-shape");
                }
                if !truthy(repo.get("app")) {
                    continue;
                }
                let reason = if truthy(repo.get("reason")) {
                    tpl("devswarm_cli.app_msg_gap_reason", &[("reason", concat(repo.get("reason"))?.as_str())])
                } else {
                    String::new()
                };
                l.push(tpl(
                    "devswarm_cli.app_msg_gap",
                    &[
                        ("name", either(repo.get("name"), repo.get("repositoryId"))?.as_str()),
                        ("app", concat(repo.get("app"))?.as_str()),
                        ("matched", concat(repo.get("matched"))?.as_str()),
                        ("archived", concat(repo.get("archivedTarget"))?.as_str()),
                        ("pre", concat(repo.get("preIngest"))?.as_str()),
                        ("gap", concat(repo.get("gap"))?.as_str()),
                        ("reason", reason.as_str()),
                    ],
                ));
                match repo.get("byBranch") {
                    None | Some(OVal::Null) => {}
                    Some(OVal::Obj(by)) => {
                        // an integer-like key is listed first by JavaScript
                        if by.iter().any(|(k, _)| is_array_index_key(k)) {
                            return defer("branch-key-order");
                        }
                        for (b, v) in by {
                            l.push(tpl(
                                "devswarm_cli.app_msg_gap_branch",
                                &[
                                    ("branch", b.as_str()),
                                    ("n", concat(v.get("n"))?.as_str()),
                                    ("h1", concat(v.get("lt1h"))?.as_str()),
                                    ("d1", concat(v.get("lt1d"))?.as_str()),
                                    ("d7", concat(v.get("lt7d"))?.as_str()),
                                    ("older", concat(v.get("older"))?.as_str()),
                                ],
                            ));
                        }
                    }
                    Some(_) => return defer("gaps-shape"),
                }
            }
        }
        None => l.push(defaults::text("devswarm_cli.app_msg_no_gap_report").to_string()),
    }
    Ok(l.join("\n"))
}

fn ctx_of<'a>(inv: &'a Inv, root: &'a Path, st: &'a crate::checks::git::util::Settings) -> Ctx<'a> {
    Ctx { home: &inv.home, root, st, now: inv.now, engine_pokes: false }
}

fn state_file(inv: &Inv) -> std::path::PathBuf {
    devswarm_root(&inv.home).join(defaults::text("devswarm_sup.as_state_file"))
}

/// `app-state [--json]`.
pub fn app_state(inv: &Inv, a: &Args) -> R<Answer> {
    app_state_with(inv, a, &System::configured())
}

/// [`app_state`] with the runner given (a dry pass starts no process).
pub fn app_state_with(inv: &Inv, a: &Args, runner: &dyn Runner) -> R<Answer> {
    let Some(root) = defaults::root() else { return defer("no-plugin-root") };
    let st = inv.settings();
    let ctx = ctx_of(inv, &root, &st);
    let pass = appsync::pass_with(&ctx, runner, Opts { dry: true, ..Opts::default() })?;
    let last: Option<OVal> = std::fs::read(state_file(inv)).ok().and_then(|b| OVal::parse(&String::from_utf8_lossy(&b)));
    let last_obj = match &last {
        Some(l @ OVal::Obj(_)) => Some(l),
        None | Some(OVal::Null) => None,
        // a scalar or an array: `last.gaps` and friends are property reads of a non-object
        Some(_) => return defer("last-shape"),
    };
    let stv = pass.state.as_ref();
    let field = |k: &str, empty: OVal| -> OVal { stv.and_then(|v| v.get(k)).cloned().unwrap_or(empty) };
    let or_null = |v: Option<&OVal>| -> OVal { v.filter(|x| x.truthy()).cloned().unwrap_or(OVal::Null) };
    let gaps = last_obj
        .and_then(|l| l.get("gaps"))
        .filter(|g| g.truthy())
        .cloned()
        .or_else(|| stv.and_then(|v| v.get("gaps")).filter(|g| g.truthy()).cloned())
        .unwrap_or(OVal::Null);
    let app_db = pass.record["appDb"].as_bool().unwrap_or(false);
    let reason = pass.record["reason"].as_str().filter(|r| !r.is_empty()).map_or(OVal::Null, s);
    let would_mark = pass.record["archived"]["pending"].as_u64().unwrap_or(0);
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(true))
        .put("action", s(defaults::text("devswarm_cli.action_app_state")))
        .put("appDb", OVal::Bool(app_db))
        .put("reason", reason)
        .put("appVersion", field("appVersion", OVal::Null))
        .put("missing", field("missing", OVal::Arr(vec![])))
        .put("gated", field("gated", OVal::Arr(vec![])))
        .put("counts", field("counts", OVal::Null))
        .put("focused", field("focused", OVal::Null))
        .put("active", field("active", OVal::Arr(vec![])))
        .put("sessions", field("sessions", OVal::Obj(vec![])))
        .put("unknownToAntiHall", field("unknownToAntiHall", OVal::Arr(vec![])))
        .put("openButMarkedArchived", field("openButMarkedArchived", OVal::Arr(vec![])))
        .put("gaps", gaps)
        .put("scheduledForDeletion", field("scheduledForDeletion", OVal::Arr(vec![])))
        .put("wouldMark", n(would_mark as f64));
    let last_sync = match last_obj {
        Some(l) => {
            let mut ls = Obj::default();
            // `undefined` fields are left out by JSON.stringify
            for k in ["at", "ok"] {
                if let Some(v) = l.get(k) {
                    ls.put(k, v.clone());
                }
            }
            ls.put("gaps", or_null(l.get("gaps"))).put("archived", or_null(l.get("archived"))).put("names", or_null(l.get("names")));
            ls.done()
        }
        None => OVal::Null,
    };
    o.put("lastSync", last_sync);
    let no_json_flag = !a.has(defaults::text("devswarm_cli.flag_json"));
    let mut result = o.done();
    if no_json_flag {
        let text = format_app_state(&result)?;
        result.set("text", s(&text));
    }
    // main() prints the table only when `--json` is not among the words and the result carries it
    let printed = if !a.raw.iter().any(|w| w == defaults::text("devswarm_cli.json_word")) {
        match result.get("text") {
            Some(OVal::Str(t)) if !t.is_empty() => t.clone(),
            _ => result.stringify(),
        }
    } else {
        result.stringify()
    };
    Ok(answer(0, printed))
}

/// The files `app-sync` may write, as `path -> bytes` (markers, the names cache, `app-state.json`), so what the pass changed is
/// known exactly.
fn watched(inv: &Inv) -> BTreeMap<String, Vec<u8>> {
    let root = devswarm_root(&inv.write_home);
    let mut out = BTreeMap::new();
    for dir in [defaults::text("devswarm_sup.as_dir_archived"), defaults::text("devswarm_sup.as_dir_names")] {
        for e in std::fs::read_dir(root.join(dir)).into_iter().flatten().flatten() {
            if e.file_type().is_ok_and(|t| t.is_file())
                && let Ok(b) = std::fs::read(e.path())
            {
                out.insert(format!("{dir}/{}", e.file_name().to_string_lossy()), b);
            }
        }
    }
    if let Ok(b) = std::fs::read(root.join(defaults::text("devswarm_sup.as_state_file"))) {
        out.insert(defaults::text("devswarm_sup.as_state_file").to_string(), b);
    }
    out
}

/// `app-sync [--dry-run]`.
pub fn app_sync(inv: &Inv, a: &Args) -> R<Answer> {
    app_sync_with(inv, a, &System::configured())
}

/// [`app_sync`] with the runner given.
pub fn app_sync_with(inv: &Inv, a: &Args, runner: &dyn Runner) -> R<Answer> {
    let Some(root) = defaults::root() else { return defer("no-plugin-root") };
    let st = inv.settings();
    let ctx = ctx_of(inv, &root, &st);
    let env_dry = inv.env.get(defaults::text("devswarm_sup.as_env_dry")).is_some_and(|v| v == defaults::text("devswarm_sup.as_env_dry_on"));
    let dry = a.has(defaults::text("devswarm_cli.flag_dry_run")) || env_dry;
    let strict = Opts { dry, cooldown: Some(0.0), strict: true };
    // everything the engine could defer on is found out before anything is written
    appsync::pass_with(&ctx, runner, Opts { dry: true, ..strict })?;
    let before = if dry { BTreeMap::new() } else { watched(inv) };
    let p = appsync::pass_with(&ctx, runner, strict)?;
    if !dry {
        crate::meshw::mark_committed();
        let after = watched(inv);
        let base = format!("{}/{}", defaults::text("mesh_write.dir_anti_hall"), defaults::text("mesh_write.dir_devswarm"));
        for (k, v) in &after {
            if before.get(k) != Some(v) {
                crate::meshw::note_written(&format!("{base}/{k}"), v);
            }
        }
    }
    let rec = &p.record;
    let mut o = Obj::default();
    o.put("action", s(defaults::text("devswarm_cli.action_app_sync")))
        .put("ok", OVal::Bool(true))
        .put("dryRun", OVal::Bool(dry))
        .put("appDb", OVal::Bool(rec["appDb"].as_bool().unwrap_or(false)));
    let elapsed = if defaults::env_var("mesh_now").is_some() { 0.0 } else { (crate::meshw::common::now_ms() - inv.now).max(0) as f64 };
    if rec["appDb"].as_bool() != Some(true) {
        o.put("reason", s(rec["reason"].as_str().unwrap_or_default())).put("elapsedMs", n(elapsed));
        return Ok(answer(0, o.done().stringify()));
    }
    let count = |v: &serde_json::Value, k: &str| n(v[k].as_u64().unwrap_or(0) as f64);
    let mut archived = Obj::default();
    for k in ["marked", "pending", "deletedInApp", "errors"] {
        archived.put(k, count(&rec["archived"], k));
    }
    let retired = p.retired.clone().unwrap_or(OVal::Null);
    let mut names = Obj::default();
    for k in ["checked", "refreshed"] {
        names.put(k, count(&rec["names"], k));
    }
    o.put("archived", archived.done()).put("retiredMarkers", retired).put("names", names.done());
    if rec["gapsScanned"].as_bool() == Some(true) {
        o.put("gapsScanned", OVal::Bool(true));
    }
    o.put("unknownToAntiHall", count(rec, "unknownToAntiHall"));
    o.put("gapTotal", rec["gapTotal"].as_f64().map_or(OVal::Null, n));
    o.put("missing", count(rec, "schemaMissing")).put("elapsedMs", n(elapsed));
    Ok(answer(0, o.done().stringify()))
}
