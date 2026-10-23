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
//! The table is built the way `formatAppState` builds it, on JavaScript's own semantics: a field of the wrong type prints as
//! JavaScript prints it, and a read that throws in Node (a property of `null`, a call on a value without the method) answers
//! `{ ok: false, error }` with exit 2, which is what Node's `run()` does with the exception.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an unreadable optional file is the same as an absent one (fail-open, as Node's try/catch)
// A failure that must be seen goes through `crate::discard` instead.
use crate::checks::guardkit::ojson::{OVal, is_array_index_key};
use crate::checks::jsport::num::to_js_string;
use crate::checks::jsport::text::slice16_lossy;
use crate::defaults;
use crate::dsact::runner::{Runner, System};
use crate::dssup::appsync::{self, Opts};
use crate::dssup::tick::Ctx;
use crate::meshw::args::Args;
use crate::meshw::common::{Inv, Obj, n, s};
use crate::meshw::extverbs::tpl;
use crate::meshw::ident::R;
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

/// A JavaScript exception raised while formatting. Node's `run()` catches it and answers `{ ok: false, error: <message> }` with exit 2.
#[derive(Debug)]
pub(crate) struct Thrown(pub String);

type J<T> = Result<T, Thrown>;

/// `String(v)` for any JSON value: objects print as `[object Object]`, arrays join their elements with commas (`null` is empty).
pub(crate) fn js_string(v: &OVal) -> String {
    match v {
        OVal::Null => "null".to_string(),
        OVal::Bool(b) => b.to_string(),
        OVal::Num(x) => to_js_string(*x),
        OVal::Str(t) => t.clone(),
        OVal::Arr(a) => a.iter().map(|e| if matches!(e, OVal::Null) { String::new() } else { js_string(e) }).collect::<Vec<_>>().join(","),
        OVal::Obj(_) => defaults::text("devswarm_cli.app_js_object").to_string(),
    }
}

/// `Object.keys(o)` / `Object.entries(o)` order: the integer-like keys first in ascending order, then the others as inserted.
pub(crate) fn js_entries(kv: &[(String, OVal)]) -> Vec<(&String, &OVal)> {
    let mut ints: Vec<(u64, &String, &OVal)> = kv.iter().filter(|(k, _)| is_array_index_key(k)).filter_map(|(k, v)| Some((k.parse().ok()?, k, v))).collect();
    ints.sort_by_key(|(i, _, _)| *i);
    ints.into_iter().map(|(_, k, v)| (k, v)).chain(kv.iter().filter(|(k, _)| !is_array_index_key(k)).map(|(k, v)| (k, v))).collect()
}

/// `Object.entries(v)` of a value a script may hold: an object's entries, an array's indices, a string's UTF-16 units, nothing else.
fn entries_of(v: &OVal) -> Vec<(String, OVal)> {
    match v {
        OVal::Obj(kv) => js_entries(kv).into_iter().map(|(k, x)| (k.clone(), x.clone())).collect(),
        OVal::Arr(a) => a.iter().enumerate().map(|(i, x)| (i.to_string(), x.clone())).collect(),
        OVal::Str(t) => t.encode_utf16().enumerate().map(|(i, u)| (i.to_string(), OVal::Str(String::from_utf16_lossy(&[u])))).collect(),
        _ => Vec::new(),
    }
}

/// `v[key]` for a value that may be `undefined` (`None`) or `null`: those throw, a container answers its field, a scalar has none.
fn prop<'a>(v: Option<&'a OVal>, key: &str) -> J<Option<&'a OVal>> {
    match v {
        None => Err(Thrown(tpl("devswarm_cli.app_msg_js_read", &[("kind", "undefined"), ("prop", key)]))),
        Some(OVal::Null) => Err(Thrown(tpl("devswarm_cli.app_msg_js_read", &[("kind", "null"), ("prop", key)]))),
        Some(x) => Ok(x.get(key)),
    }
}

/// `v.length` truthiness: an array's or string's length is nonzero; a value without one reads `undefined`; `null` and `undefined` throw.
fn has_length(v: Option<&OVal>) -> J<bool> {
    match v {
        Some(OVal::Arr(a)) => Ok(!a.is_empty()),
        Some(OVal::Str(t)) => Ok(!t.is_empty()),
        other => prop(other, "length").map(|n| n.is_some_and(OVal::truthy)),
    }
}

/// `v.join(sep)` / `v.map(...)`: only an array has them.
fn items<'a>(v: Option<&'a OVal>, what: &str) -> J<&'a [OVal]> {
    match v {
        Some(OVal::Arr(a)) => Ok(a),
        _ => Err(Thrown(tpl("devswarm_cli.app_msg_js_not_function", &[("what", what)]))),
    }
}

/// The source expression of Node's `formatAppState` that a TypeError names.
fn expr(name: &str) -> &'static str {
    defaults::raw("devswarm_cli.app_js_exprs").str_field(name)
}

/// The exception of calling `v.<method>(...)` where `what` is the expression Node names: reading `method` off `undefined` or `null`
/// throws on the read, any other value lacks the method.
fn missing_method(v: Option<&OVal>, what: &str) -> Thrown {
    let method = what.rsplit('.').next().unwrap_or(what);
    match prop(v, method) {
        Err(t) => t,
        Ok(_) => Thrown(tpl("devswarm_cli.app_msg_js_not_function", &[("what", what)])),
    }
}

/// `for (const x of v)`: an array's elements or a string's characters; anything else is not iterable.
fn iterate(v: Option<&OVal>, what: &str) -> J<Vec<OVal>> {
    match v {
        Some(OVal::Arr(a)) => Ok(a.clone()),
        Some(OVal::Str(t)) => Ok(t.chars().map(|c| OVal::Str(c.to_string())).collect()),
        _ => Err(Thrown(tpl("devswarm_cli.app_msg_js_not_iterable", &[("what", what)]))),
    }
}

/// `'' + v` (`None` is `undefined`).
pub(crate) fn concat(v: Option<&OVal>) -> String {
    v.map_or_else(|| "undefined".to_string(), js_string)
}

/// `names.shortId(id)`: the first `app_short_id` characters, after the mesh prefix when the id carries one (GH #203). A cut through
/// a surrogate pair leaves a lone surrogate in JavaScript, which the UTF-8 write turns into U+FFFD.
pub fn short(id: &str) -> R<String> {
    Ok(short16(id))
}

fn short16(id: &str) -> String {
    let mut width = defaults::num("devswarm_cli.app_short_id") as usize;
    let prefix = defaults::text("devswarm_cli.app_short_id_mesh_prefix");
    if id.starts_with(prefix) {
        width += prefix.encode_utf16().count();
    }
    slice16_lossy(id, width)
}

/// `a || b` over two values, as the text `+` prints.
fn either(a: Option<&OVal>, b: Option<&OVal>) -> String {
    if truthy(a) { concat(a) } else { concat(b) }
}

/// `list.join(sep)` of a list read as `what`: `null` elements are empty.
fn list_join(v: Option<&OVal>, sep: &str, what: &str) -> J<String> {
    Ok(items(v, what)?.iter().map(|i| if matches!(i, OVal::Null) { String::new() } else { js_string(i) }).collect::<Vec<_>>().join(sep))
}

/// The people-and-ids list of `unknownToAntiHall` / `openButMarkedArchived`: `(label || id) (id8)` joined.
fn id_list(v: Option<&OVal>, what: &str) -> J<String> {
    let mut parts = Vec::new();
    for u in items(v, what)? {
        let label = prop(Some(u), "label")?;
        let id = u.get("id");
        parts.push(format!("{} ({})", either(label, id), short16(&concat(id))));
    }
    Ok(parts.join(defaults::text("devswarm_cli.app_join_semi")))
}

/// `formatAppState(r)`.
fn format_app_state(r: &OVal) -> J<String> {
    if !truthy(r.get("appDb")) {
        let reason = if truthy(r.get("reason")) { concat(r.get("reason")) } else { defaults::text("devswarm_cli.app_no_db").to_string() };
        return Ok(tpl("devswarm_cli.app_msg_unavailable", &[("reason", reason.as_str())]));
    }
    let mut l: Vec<String> = Vec::new();
    let version = if truthy(r.get("appVersion")) { concat(r.get("appVersion")) } else { defaults::text("devswarm_cli.app_version_unknown").to_string() };
    let counts = r.get("counts");
    let builders = concat(prop(counts, "builders")?);
    let active_n = concat(prop(counts, "active")?);
    let archived_n = concat(prop(counts, "archived")?);
    l.push(tpl(
        "devswarm_cli.app_msg_head",
        &[("version", version.as_str()), ("builders", builders.as_str()), ("active", active_n.as_str()), ("archived", archived_n.as_str())],
    ));
    let comma = defaults::text("devswarm_cli.app_join_comma");
    if has_length(r.get("missing"))? {
        l.push(tpl("devswarm_cli.app_msg_missing", &[("list", list_join(r.get("missing"), comma, expr("missing_join"))?.as_str())]));
    }
    if has_length(r.get("gated"))? {
        l.push(tpl("devswarm_cli.app_msg_gated", &[("list", list_join(r.get("gated"), comma, expr("gated_join"))?.as_str())]));
    }
    l.push(defaults::text("devswarm_cli.app_table_head").to_string());
    l.push(defaults::text("devswarm_cli.app_table_rule").to_string());
    let sessions = r.get("sessions");
    let dash = defaults::text("devswarm_cli.app_dash");
    for a in iterate(r.get("active"), expr("active"))? {
        let a = &a;
        // `(a.label || a.id).replace(...)`: only a string has `replace`
        let named = if prop(Some(a), "label")?.is_some_and(OVal::truthy) { a.get("label") } else { a.get("id") };
        let Some(OVal::Str(name)) = named else { return Err(missing_method(named, expr("replace"))) };
        let id8 = short16(&concat(a.get("id")));
        let mut title = tpl("devswarm_cli.app_title", &[("label", name.replace('|', "\\|").as_str()), ("id", id8.as_str())]);
        if truthy(a.get("isPinned")) {
            title.push_str(defaults::text("devswarm_cli.app_pinned"));
        }
        if truthy(a.get("focused")) {
            title.push_str(defaults::text("devswarm_cli.app_on_screen"));
        }
        let sess = if truthy(a.get("sessionId")) {
            let sid = concat(a.get("sessionId"));
            // `r.sessions[a.sessionId]` throws when there is no sessions object; `(entry || {}).corroborated`
            let entry = prop(sessions, &sid)?;
            let corroborated = entry.filter(|e| e.truthy()).is_some_and(|e| truthy(e.get("corroborated")));
            format!("{}{}", short16(&sid), if corroborated { "" } else { defaults::text("devswarm_cli.app_unverified") })
        } else {
            dash.to_string()
        };
        let rank = match a.get("rank") {
            None | Some(OVal::Null) => dash.to_string(),
            v => concat(v),
        };
        let or_dash = |k: &str| -> String { if truthy(a.get(k)) { concat(a.get(k)) } else { dash.to_string() } };
        l.push(tpl(
            "devswarm_cli.app_row",
            &[
                ("rank", rank.as_str()),
                ("title", title.as_str()),
                ("type", or_dash("builderType").as_str()),
                ("finish", or_dash("finish").as_str()),
                ("brief", or_dash("brief").as_str()),
                ("session", sess.as_str()),
            ],
        ));
    }
    let unknown = r.get("unknownToAntiHall");
    if has_length(unknown)? {
        l.push(tpl("devswarm_cli.app_msg_unknown", &[("list", id_list(unknown, expr("unknown_map"))?.as_str())]));
    }
    let stale = r.get("openButMarkedArchived");
    if has_length(stale)? {
        l.push(tpl("devswarm_cli.app_msg_stale", &[("list", id_list(stale, expr("stale_map"))?.as_str())]));
    }
    if truthy(r.get("wouldMark")) {
        l.push(tpl("devswarm_cli.app_msg_would_mark", &[("n", concat(r.get("wouldMark")).as_str())]));
    }
    let deletion = r.get("scheduledForDeletion");
    if has_length(deletion)? {
        l.push(tpl("devswarm_cli.app_msg_deletion", &[("list", list_join(deletion, comma, expr("deletion_join"))?.as_str())]));
    }
    match r.get("gaps").filter(|g| g.truthy()) {
        Some(g) => {
            for repo in iterate(g.get("repos"), expr("repos"))? {
                let repo = &repo;
                if !prop(Some(repo), "app")?.is_some_and(OVal::truthy) {
                    continue;
                }
                let reason = if truthy(repo.get("reason")) {
                    tpl("devswarm_cli.app_msg_gap_reason", &[("reason", concat(repo.get("reason")).as_str())])
                } else {
                    String::new()
                };
                l.push(tpl(
                    "devswarm_cli.app_msg_gap",
                    &[
                        ("name", either(repo.get("name"), repo.get("repositoryId")).as_str()),
                        ("app", concat(repo.get("app")).as_str()),
                        ("matched", concat(repo.get("matched")).as_str()),
                        ("archived", concat(repo.get("archivedTarget")).as_str()),
                        ("pre", concat(repo.get("preIngest")).as_str()),
                        ("gap", concat(repo.get("gap")).as_str()),
                        ("reason", reason.as_str()),
                    ],
                ));
                if let Some(by) = repo.get("byBranch").filter(|b| b.truthy()) {
                    for (b, v) in entries_of(by) {
                        let v = Some(&v);
                        l.push(tpl(
                            "devswarm_cli.app_msg_gap_branch",
                            &[
                                ("branch", b.as_str()),
                                ("n", concat(prop(v, "n")?).as_str()),
                                ("h1", concat(prop(v, "lt1h")?).as_str()),
                                ("d1", concat(prop(v, "lt1d")?).as_str()),
                                ("d7", concat(prop(v, "lt7d")?).as_str()),
                                ("older", concat(prop(v, "older")?).as_str()),
                            ],
                        ));
                    }
                }
            }
        }
        None => l.push(defaults::text("devswarm_cli.app_msg_no_gap_report").to_string()),
    }
    Ok(l.join("\n"))
}

/// The plugin root the loaded defaults came from. Every verb runs after the defaults loaded (its first `defaults::text` would
/// otherwise have failed), so the root is always there; the sync context carries it and nothing in the sync reads it.
fn plugin_root() -> std::path::PathBuf {
    defaults::root().unwrap_or_default()
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
    let root = plugin_root();
    let st = inv.settings();
    let ctx = ctx_of(inv, &root, &st);
    let pass = appsync::pass_with(&ctx, runner, Opts { dry: true, ..Opts::default() })?;
    let last: Option<OVal> = std::fs::read(state_file(inv)).ok().and_then(|b| OVal::parse(&String::from_utf8_lossy(&b)));
    // `last && last.gaps`: a falsy parse (`null`, `false`, `0`, `""`) is no record; a truthy non-object reads every field as absent
    let last_obj = last.as_ref().filter(|l| l.truthy());
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
        match format_app_state(&result) {
            Ok(text) => result.set("text", s(&text)),
            // the exception Node's `run()` catches
            Err(Thrown(error)) => {
                let mut o = Obj::default();
                o.put("ok", OVal::Bool(false)).put("error", s(&error));
                return Ok(answer(2, o.done().stringify()));
            }
        }
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
    let root = plugin_root();
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

#[cfg(test)]
mod short_tests {
    use super::short;

    #[test]
    fn a_mesh_id_keeps_its_hash_and_a_uuid_keeps_eight() {
        assert_eq!(short("primary-d7a18d81").unwrap(), "primary-d7a18d81");
        assert_eq!(short("primary-d7a18d81ffee").unwrap(), "primary-d7a18d81");
        assert_eq!(short("48f38c9e-8dc2-426a-adb2-f9401ab84e99").unwrap(), "48f38c9e");
        assert_eq!(short("abc").unwrap(), "abc");
    }
}

#[cfg(test)]
mod format_tests {
    use super::*;

    /// A state result as `cmdAppState` builds it, with the given fields replaced by JSON text.
    fn result(patch: &[(&str, &str)]) -> OVal {
        let mut r = OVal::parse(
            r#"{"appDb":true,"reason":null,"appVersion":"2.5.3","missing":[],"gated":[],"counts":{"builders":2,"active":1,"archived":1},
            "active":[],"sessions":{},"unknownToAntiHall":[],"openButMarkedArchived":[],"gaps":null,"scheduledForDeletion":[],"wouldMark":0}"#,
        )
        .unwrap();
        for (k, v) in patch {
            r.set(k, OVal::parse(v).unwrap());
        }
        r
    }

    fn text(patch: &[(&str, &str)]) -> String {
        format_app_state(&result(patch)).unwrap()
    }

    fn thrown(patch: &[(&str, &str)]) -> String {
        format_app_state(&result(patch)).unwrap_err().0
    }

    /// JavaScript throws on a property of `null` or a call of a method the value lacks; Node's `run()` answers that as `{ok:false,error}`.
    #[test]
    fn a_read_that_throws_in_javascript_is_a_refusal_with_its_message() {
        assert_eq!(thrown(&[("counts", "null")]), "Cannot read properties of null (reading 'builders')");
        assert_eq!(thrown(&[("unknownToAntiHall", r#""x""#)]), "r.unknownToAntiHall.map is not a function");
        assert_eq!(thrown(&[("active", "5")]), "r.active is not iterable");
        assert_eq!(thrown(&[("active", r#"[null]"#)]), "Cannot read properties of null (reading 'label')");
        assert_eq!(thrown(&[("active", r#"[{"id":5}]"#)]), "(a.label || a.id).replace is not a function");
        assert_eq!(thrown(&[("active", r#"[{"label":"a","id":"b","sessionId":"s"}]"#), ("sessions", "null")]), "Cannot read properties of null (reading 's')");
        assert_eq!(thrown(&[("gaps", r#"{"repos":[{"app":1,"byBranch":{"b":null}}]}"#)]), "Cannot read properties of null (reading 'n')");
    }

    /// Values of another type print the way JavaScript's `+` prints them.
    #[test]
    fn a_field_of_another_type_prints_like_javascript() {
        let t = text(&[("missing", r#"["a",null,3,[1,[2]],{"x":1}]"#), ("scheduledForDeletion", r#"{"length":0}"#), ("wouldMark", r#"[7,8]"#)]);
        assert!(t.contains("a, , 3, 1,2, [object Object]"), "{t}");
        assert!(t.contains("next sync marks 7,8 descriptor(s)"), "{t}");
        assert!(!t.contains("pending app deletion"), "an object has no length: nothing to list");
        let t = text(&[("counts", r#"{"builders":1.50}"#)]);
        assert!(t.contains("1.5 builders, undefined open, undefined archived"), "{t}");
    }

    /// `String(id).slice(0, 8)` through a surrogate pair leaves a lone surrogate, which the write turns into U+FFFD.
    #[test]
    fn a_cut_through_a_surrogate_pair_prints_the_replacement_character() {
        let t = text(&[("active", "[{\"id\":\"1234567\u{1d4b3}x\",\"label\":\"L|M\",\"sessionId\":\"__proto__\",\"rank\":0,\"isPinned\":true}]")]);
        assert!(t.contains("L\\|M (1234567\u{fffd}) [pinned]"), "{t}");
        assert!(t.contains("__proto_ (unverified)"), "an id that names a special object key is an ordinary key: {t}");
    }

    /// `Object.entries` lists integer-like keys first, ascending; a branch map that is an array lists its indices.
    #[test]
    fn the_gap_report_lists_branches_in_javascript_key_order() {
        let gaps = r#"{"repos":[{"app":3,"name":"r","matched":1,"archivedTarget":0,"preIngest":0,"gap":2,
            "byBranch":{"feat":{"n":1},"10":{"n":2},"9":{"n":3}}},{"app":0},"skipped",{"app":1,"byBranch":[{"n":4}]},{"app":2,"byBranch":5}]}"#;
        let t = text(&[("gaps", gaps)]);
        let order: Vec<usize> = ["gap → 9:", "gap → 10:", "gap → feat:"].iter().map(|k| t.find(k).unwrap_or_else(|| panic!("{k} in {t}"))).collect();
        assert!(order.windows(2).all(|w| w[0] < w[1]), "{t}");
        assert!(t.contains("gap → 0: 4"), "an array lists its indices: {t}");
    }
}
