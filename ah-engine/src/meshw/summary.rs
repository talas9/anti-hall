//! The summary projection a mesh write refreshes: `companion/lib/devswarm-store.js` `computeSummary` + `deriveSummary`
//! (the atomic write of `<devswarm>/summaries/<repoKey>.json`), ported for the verbs the engine answers.
//!
//! Node's `send` and consuming `mesh read` refresh this file in the same call that writes the store; the wake watcher, the
//! parent-inbox hook and the Stop gates read it. So the engine refreshes it too, byte for byte.
//!
//! Nothing here hands a case to Node (there is no Node): a store read that fails reads as Node's `readAll` fail-open does
//! (no rows, a zero count, logged with the site), a settings file JavaScript reads but the engine cannot parse falls to
//! the next layer (logged), and [`check`] has nothing left to refuse. After its write a verb calls [`derive_after_write`],
//! which logs a failure instead of returning it (the write is done and must not be repeated).
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - a file that is missing or does not parse is Node's fail-open default (`try { JSON.parse(...) } catch { ... }`)
// - text that does not decode as UTF-8 is read lossily, as Node's `readFileSync(p, 'utf8')` does
// A failure that must be seen goes through `crate::discard` instead.
use crate::checks::git::util::Settings;
use crate::checks::guardkit::ojson::OVal;
use crate::checks::guardkit::text::{js_string_of, js_trim};
use crate::defaults;
use crate::meshw::common::{Inv, n, s, s_or_null};
use crate::meshw::ident::{self, Defer, R};
use crate::meshw::idlock::{devswarm_root, is_safe_id};
use crate::meshw::store::MeshStore;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

/// One registry row as `listRegistry` returns it.
#[derive(Debug, Clone)]
struct Reg {
    /// `d.id` as JSON (normally a string).
    raw_id: OVal,
    /// `String(d.id)`.
    id: String,
    /// `typeof d.id === 'string'`.
    id_is_str: bool,
    worktree_path: Option<String>,
    session_id: Option<String>,
    inbox_path: Option<String>,
    cursor_path: Option<String>,
    nudge: OVal,
}

/// One message as `listMessages` returns it (the fields the projection reads).
#[derive(Debug, Clone)]
struct Msg {
    store_seq: Option<f64>,
    ts: f64,
    body: String,
    sender: Option<String>,
    mtype: Option<String>,
    urgency: Option<String>,
    is_heartbeat: bool,
}

/// A store read that failed: Node's `readAll` swallows it to an empty result (devswarm-store.js, "fail-open contract"), so
/// the projection carries on from the default and the failure is logged with the site (`mesh_summary_read_failed`).
fn soft<T: Default>(what: &str, e: impl std::fmt::Display) -> T {
    crate::metrics::bump("mesh_summary_read_failed", &[("site", what)]);
    crate::debug::violated("meshw", &defaults::render("mesh_write.msg_summary_read_failed", &[("site", &what), ("error", &e)]));
    T::default()
}

/// A JavaScript number as JSON: NaN and the infinities are `null`.
fn num(f: f64) -> OVal {
    if f.is_finite() { n(f) } else { OVal::Null }
}

fn opt_num(f: Option<f64>) -> OVal {
    f.map_or(OVal::Null, num)
}

fn sv(v: &Value) -> Option<String> {
    v.as_str().map(str::to_string)
}

/// `Number(x)` read back from the reader's JSON (`null` there is NaN).
fn fv(v: &Value) -> f64 {
    v.as_f64().unwrap_or(f64::NAN)
}

/// serde JSON (sorted keys) as an ordered value; only scalars and arrays reach here.
fn oval_of(v: &Value) -> OVal {
    match v {
        Value::Null => OVal::Null,
        Value::Bool(b) => OVal::Bool(*b),
        Value::Number(x) => OVal::Num(x.as_f64().unwrap_or(f64::NAN)),
        Value::String(t) => OVal::Str(t.clone()),
        Value::Array(a) => OVal::Arr(a.iter().map(oval_of).collect()),
        Value::Object(o) => OVal::Obj(o.iter().map(|(k, x)| (k.clone(), oval_of(x))).collect()),
    }
}

fn registry(st: &MeshStore) -> R<Vec<Reg>> {
    let rows = st.reader().roster().unwrap_or_else(|e| soft("registry", e));
    let nudges: HashMap<String, Option<String>> = st.reader().registry_nudges().unwrap_or_else(|e| soft("registry", e)).into_iter().collect();
    let mut out = Vec::new();
    for r in rows {
        let (raw_id, id, id_is_str) = match &r["id"] {
            Value::String(t) => (OVal::Str(t.clone()), t.clone(), true),
            Value::Null => (OVal::Null, defaults::text("mesh_write.js_null").to_string(), false),
            other => (oval_of(other), other.to_string(), false),
        };
        // deserializeCmd: JSON.parse(raw), else the raw text
        let nudge = match nudges.get(&id) {
            Some(Some(raw)) => OVal::parse(raw).unwrap_or_else(|| OVal::Str(raw.clone())),
            Some(None) => OVal::Null,
            None => oval_of(&r["nudgeCommand"]),
        };
        out.push(Reg {
            raw_id,
            id,
            id_is_str,
            worktree_path: sv(&r["worktreePath"]),
            session_id: sv(&r["sessionId"]),
            inbox_path: sv(&r["inboxPath"]),
            cursor_path: sv(&r["cursorPath"]),
            nudge,
        });
    }
    Ok(out)
}

fn messages(st: &MeshStore, id: &str, since: f64) -> R<Vec<Msg>> {
    let since = if since.is_finite() && since > 0.0 { since.floor() as u64 } else { 0 };
    let mut out = Vec::new();
    st.reader()
        .for_each_message(id, since, |m| {
            out.push(Msg {
                store_seq: m["storeSeq"].as_f64(),
                ts: fv(&m["ts"]),
                body: sv(&m["body"]).unwrap_or_default(),
                sender: sv(&m["sender"]),
                mtype: sv(&m["mtype"]),
                urgency: sv(&m["urgency"]),
                is_heartbeat: m["isHeartbeat"].as_bool().unwrap_or(false),
            });
            true
        })
        .unwrap_or_else(|e| soft("messages", e));
    Ok(out)
}

fn read_text(p: &Path) -> Option<String> {
    std::fs::read(p).ok().map(|b| String::from_utf8_lossy(&b).into_owned())
}

fn read_json(p: &Path) -> Option<OVal> {
    OVal::parse(&read_text(p)?)
}

/// `devswarm-inbox-cursor.js` `readCursor(p)`: a bare integer, or a JSON object's `line`; 0 when unreadable or invalid.
fn read_cursor(p: &Path) -> f64 {
    let Some(raw) = read_text(p) else { return 0.0 };
    let raw = js_trim(&raw);
    let c = if !raw.is_empty() && raw.bytes().all(|b| b.is_ascii_digit()) {
        raw.parse::<f64>().unwrap_or(f64::NAN)
    } else {
        match OVal::parse(raw) {
            Some(o) => match o.get(defaults::text("mesh_write.cursor_line_field")) {
                Some(OVal::Num(x)) => *x,
                Some(OVal::Str(t)) => crate::checks::guardkit::text::js_number_of_str(t),
                Some(OVal::Bool(b)) => f64::from(u8::from(*b)),
                Some(OVal::Null) => 0.0,
                _ => f64::NAN,
            },
            None => f64::NAN,
        }
    };
    if c.is_finite() && c >= 0.0 { c.floor() } else { 0.0 }
}

/// The `unreadBacklog` / `readUnread` facts `ndjsonHasUnread` uses: `(known, total lines)`.
fn ndjson_backlog(inbox: Option<&str>, cursor: Option<&str>) -> (bool, f64) {
    let count = |t: &str| t.split('\n').filter(|l| !js_trim(l).is_empty()).count() as f64;
    let Some(inbox) = inbox else { return (false, 0.0) };
    let Some(all) = read_text(Path::new(inbox)) else { return (false, 0.0) };
    let total = count(&all);
    let Some(cp) = cursor else { return (false, total) };
    let Some(raw) = read_text(Path::new(cp)) else { return (false, total) };
    let raw = js_trim(&raw);
    let c = if !raw.is_empty() && raw.bytes().all(|b| b.is_ascii_digit()) {
        raw.parse::<f64>().unwrap_or(f64::NAN)
    } else {
        // Number(JSON.parse(raw).line): a parse failure is "cursor-unreadable" (unknown)
        match OVal::parse(raw) {
            Some(o) => match o.get(defaults::text("mesh_write.cursor_line_field")) {
                Some(OVal::Num(x)) => *x,
                Some(OVal::Str(t)) => crate::checks::guardkit::text::js_number_of_str(t),
                Some(OVal::Bool(b)) => f64::from(u8::from(*b)),
                Some(OVal::Null) => 0.0,
                _ => f64::NAN,
            },
            None => return (false, total),
        }
    };
    (c.is_finite() && c >= 0.0, total)
}

/// Paths and file reads of the legacy cursor files.
struct Cursors {
    dir: PathBuf,
    names: Option<Vec<String>>,
}

impl Cursors {
    fn new(home: &Path) -> Cursors {
        Cursors { dir: devswarm_root(home).join(defaults::text("mesh_write.dir_cursors")), names: None }
    }

    fn legacy_safe(id: &str) -> bool {
        is_safe_id(id) && !defaults::list("mesh_write.legacy_cursor_forbidden").iter().any(|x| id.contains(x))
    }

    fn file(&self, name: &str) -> PathBuf {
        self.dir.join(format!("{name}{}", defaults::text("mesh_write.json_suffix")))
    }

    /// `listLegacy(home, id, sep)`: the values of `<id><sep><6 hex>.json`.
    fn list(&mut self, id: &str, sep: &str) -> Vec<f64> {
        if !Self::legacy_safe(id) {
            return Vec::new();
        }
        if self.names.is_none() {
            let names =
                std::fs::read_dir(&self.dir).map(|it| it.flatten().filter_map(|e| e.file_name().to_str().map(str::to_string)).collect()).unwrap_or_default();
            self.names = Some(names);
        }
        let prefix = format!("{id}{sep}");
        let suffix = defaults::text("mesh_write.json_suffix");
        let len = defaults::num("mesh_write.legacy_cursor_short_len") as usize;
        let mut out = Vec::new();
        for name in self.names.as_deref().unwrap_or_default() {
            let Some(short) = name.strip_prefix(&prefix).and_then(|r| r.strip_suffix(suffix)) else { continue };
            if short.len() == len && short.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
                out.push(read_cursor(&self.dir.join(name)));
            }
        }
        out
    }

    /// `legacyStoreFloor(store, home, id)`.
    fn legacy_store_floor(&mut self, st: &MeshStore, id: &str) -> f64 {
        let base_name = format!("{id}{}", defaults::text("mesh_write.cursor_base_suffix"));
        let baseline = if Self::legacy_safe(id) && self.file(&base_name).exists() {
            read_cursor(&self.file(&base_name))
        } else {
            // legacySharedCursor: max(cursors/<id>.json, the cursors table row)
            let json = read_cursor(&self.file(id));
            let row = st.reader().cursor(id).unwrap_or_else(|e| soft("cursor", e)) as f64;
            json.max(row)
        };
        let files = self.list(id, defaults::text("mesh_write.cursor_inst_sep"));
        match files.iter().copied().reduce(f64::min) {
            None => baseline,
            Some(min) => baseline.max(min),
        }
    }
}

/// `floorCursor(store, id, home)` (a failed read is 0): the store-namespace floor of one partition.
pub(crate) fn store_floor(st: &MeshStore, home: &Path, id: &str) -> f64 {
    let mut cur = Cursors::new(home);
    floor_of(st, &mut cur, home, &home.to_string_lossy(), id, false)
}

/// `floorOf(store, partition, ns)`: the `#floor` reader-cursor row, else the legacy floor.
fn floor_of(st: &MeshStore, cur: &mut Cursors, home: &Path, cwd: &str, id: &str, nd: bool) -> f64 {
    let rows = st.reader().reader_cursors(id).unwrap_or_else(|e| soft("reader-cursors", e));
    let ns = defaults::text(if nd { "mesh_write.cursor_ns_nd" } else { "mesh_write.cursor_ns_store" });
    let floor = defaults::text("mesh_write.cursor_floor_reader");
    let row = rows.iter().find(|r| r["ns"].as_str() == Some(ns) && r["reader"].as_str() == Some(floor));
    let v = if !nd {
        match row {
            Some(r) => stored_position(&r["value"]),
            None => cur.legacy_store_floor(st, id),
        }
    } else {
        // the descriptor's cursorPath (descriptorCursorPath), and distinctNdFloor when a #floor row exists
        let cp = if is_safe_id(id) {
            match read_json(
                &devswarm_root(home).join(defaults::text("mesh_write.dir_workspaces")).join(format!("{id}{}", defaults::text("mesh_write.json_suffix"))),
            ) {
                Some(d @ OVal::Obj(_)) => match d.get(defaults::text("mesh_write.field_cursor_path")) {
                    Some(OVal::Str(p)) if !p.is_empty() => Some(p.clone()),
                    _ => None,
                },
                _ => None,
            }
        } else {
            None
        };
        match row {
            Some(r) => {
                let distinct = match &cp {
                    None => 0.0,
                    // `path.resolve(cursorPath)`: a relative path is the process's, so the caller's, directory
                    Some(p) => {
                        let abs = ident::resolve(cwd, p);
                        let primary = cur.file(id);
                        if abs == ident::resolve_abs(&primary.to_string_lossy()) { 0.0 } else { read_cursor(Path::new(&abs)) }
                    }
                };
                stored_position(&r["value"]).max(distinct)
            }
            None => cp.map_or(0.0, |p| read_cursor(Path::new(&ident::resolve(cwd, &p)))),
        }
    };
    v
}

/// A `reader_cursors` value as the store returns it: a finite non-negative number floored, else 0.
fn stored_position(v: &Value) -> f64 {
    v.as_f64().filter(|x| x.is_finite() && *x >= 0.0).map_or(0.0, f64::floor)
}

/// `archiveCompleteIds(home)`: `archived/<id>.json` present and `workspaces/<id>.json` absent.
pub(crate) fn archive_complete_ids(home: &Path) -> HashSet<String> {
    let root = devswarm_root(home);
    let dir = root.join(defaults::text("mesh_write.dir_archived"));
    let mut out = HashSet::new();
    match std::fs::symlink_metadata(&dir) {
        Ok(m) if m.is_dir() => {}
        _ => return out,
    }
    let Ok(it) = std::fs::read_dir(&dir) else { return out };
    let suffix = defaults::text("mesh_write.json_suffix");
    let ws = root.join(defaults::text("mesh_write.dir_workspaces"));
    for e in it.flatten() {
        let Some(name) = e.file_name().to_str().map(str::to_string) else { continue };
        let Some(id) = name.strip_suffix(suffix) else { continue };
        if !is_safe_id(id) {
            continue;
        }
        if !ws.join(&name).exists() {
            out.insert(id.to_string());
        }
    }
    out
}

/// `crossLinkedIdentity(a, b)` on (id, sessionId) pairs.
pub(crate) fn cross_linked(a_id: &str, a_sess: Option<&str>, b_id: &str, b_sess: Option<&str>) -> bool {
    if a_id.is_empty() || b_id.is_empty() || a_id == b_id {
        return false;
    }
    a_sess.is_some_and(|x| !x.is_empty() && x == b_id) || b_sess.is_some_and(|x| !x.is_empty() && x == a_id)
}

/// `recipientFamilyIds(recipientId, rows)`.
fn recipient_family(rid: &str, rows: &[Reg]) -> HashSet<String> {
    let mut out = HashSet::new();
    if rid.is_empty() {
        return out;
    }
    out.insert(rid.to_string());
    let me = rows.iter().find(|r| r.id == rid);
    let my_sess = me.and_then(|r| r.session_id.as_deref());
    for c in rows {
        if matches!(c.raw_id, OVal::Null) {
            continue;
        }
        if cross_linked(rid, my_sess, &c.id, c.session_id.as_deref()) {
            out.insert(c.id.clone());
        }
    }
    out
}

/// `pickAttributionRow(rows)`: a real session first, then a branch-slug id, then the smallest id.
fn pick_attribution<'a>(rows: &[&'a Reg]) -> Option<&'a Reg> {
    let score = |r: &Reg| {
        let live = r.session_id.as_deref().is_some_and(|x| !x.is_empty() && !x.starts_with(defaults::text("mesh_write.synthetic_session_prefix")));
        let slug = r.worktree_path.as_deref().is_some_and(|wt| {
            let base = ident::basename(wt.trim_end_matches(['/', '\\']));
            !base.is_empty() && r.id.starts_with(&format!("{base}-"))
        });
        (u8::from(live), u8::from(slug))
    };
    let mut best: Option<&Reg> = None;
    for &r in rows {
        if matches!(r.raw_id, OVal::Null) {
            continue;
        }
        match best {
            None => best = Some(r),
            Some(b) => {
                let (sr, sb) = (score(r), score(b));
                if sr > sb || (sr == sb && r.id < b.id) {
                    best = Some(r);
                }
            }
        }
    }
    best
}

/// Per-projection caches of `resolveSenderRegistryId`'s inputs.
struct Resolver<'a> {
    rows: &'a [Reg],
    aliases: Vec<(String, String)>,
    pwid: HashMap<String, Option<String>>,
}

impl<'a> Resolver<'a> {
    /// `primaryWorkspaceId(worktreePath)` (a throw is null).
    fn pwid(&mut self, wt: &str) -> R<Option<String>> {
        if let Some(v) = self.pwid.get(wt) {
            return Ok(v.clone());
        }
        let v = Some(ident::primary_workspace_id(wt)?);
        self.pwid.insert(wt.to_string(), v.clone());
        Ok(v)
    }

    /// `resolveSenderRegistryId(store, registry, meshId, home, recipientId)`: the registry id, `None` to drop.
    fn resolve(&mut self, sender: Option<&str>, recipient: &str) -> R<Option<OVal>> {
        let Some(mesh) = sender.filter(|x| !x.is_empty()) else { return Ok(None) };
        if let Some((_, to)) = self.aliases.iter().find(|(k, _)| k == mesh)
            && to != recipient
            && self.rows.iter().any(|d| d.id == *to)
        {
            return Ok(Some(s(to)));
        }
        let rows = self.rows;
        let mut candidates: Vec<&Reg> = Vec::new();
        for d in rows {
            let Some(wt) = d.worktree_path.as_deref() else { continue };
            if self.pwid(wt)?.as_deref() == Some(mesh) {
                candidates.push(d);
            }
        }
        if candidates.is_empty() {
            return Ok(None);
        }
        let excluded = recipient_family(recipient, rows);
        let eligible: Vec<&Reg> = if excluded.is_empty() {
            candidates
        } else {
            candidates.into_iter().filter(|d| !matches!(d.raw_id, OVal::Null) && !excluded.contains(&d.id)).collect()
        };
        if eligible.is_empty() {
            return Ok(Some(s(mesh)));
        }
        if let Some(d) = eligible.iter().find(|d| !matches!(d.raw_id, OVal::Null) && d.id == mesh) {
            return Ok(Some(d.raw_id.clone()));
        }
        let linked: Vec<&Reg> = eligible.iter().copied().filter(|d| cross_linked(mesh, None, &d.id, d.session_id.as_deref())).collect();
        let pick = pick_attribution(if linked.is_empty() { &eligible } else { &linked });
        Ok(Some(pick.map_or_else(|| s(mesh), |r| r.raw_id.clone())))
    }
}

/// One pending question before the collapse.
struct Q {
    from: OVal,
    ts: f64,
    seq: Option<f64>,
}

/// `String(q.from)` for the per-sender grouping.
fn js_string_of_oval(v: &OVal) -> String {
    match v {
        OVal::Str(t) => t.clone(),
        other => other.stringify(),
    }
}

/// `collapsePendingQuestionsBySender(list)`, as JSON entries.
fn collapse(list: Vec<Q>) -> Vec<OVal> {
    struct G {
        best: usize,
        count: usize,
        min_ts: Option<f64>,
    }
    let eff = |q: &Q| if q.ts.is_finite() { q.ts } else { f64::INFINITY };
    let seq_of = |q: &Q| q.seq.filter(|x| x.is_finite()).unwrap_or(f64::NEG_INFINITY);
    let mut order: Vec<String> = Vec::new();
    let mut groups: HashMap<String, G> = HashMap::new();
    for (i, q) in list.iter().enumerate() {
        let key = js_string_of_oval(&q.from);
        match groups.get_mut(&key) {
            None => {
                order.push(key.clone());
                groups.insert(key, G { best: i, count: 1, min_ts: q.ts.is_finite().then_some(q.ts) });
            }
            Some(g) => {
                g.count += 1;
                if q.ts.is_finite() {
                    g.min_ts = Some(g.min_ts.map_or(q.ts, |m| m.min(q.ts)));
                }
                let (a, b) = (eff(q), eff(&list[g.best]));
                if a > b || (a == b && seq_of(q) > seq_of(&list[g.best])) {
                    g.best = i;
                }
            }
        }
    }
    order
        .iter()
        .map(|k| {
            let g = &groups[k];
            let q = &list[g.best];
            let mut e = vec![("from".to_string(), q.from.clone()), ("ts".to_string(), num(q.ts)), ("seq".to_string(), opt_num(q.seq))];
            if g.count > 1 {
                e.push(("occurrences".into(), n(g.count as f64)));
                e.push(("firstTs".into(), opt_num(g.min_ts)));
                e.push(("lastTs".into(), num(q.ts)));
            }
            OVal::Obj(e)
        })
        .collect()
}

/// `maxUrgencyOf(rows)`.
fn max_urgency<'a>(rows: impl Iterator<Item = &'a Msg>) -> OVal {
    let ranks = defaults::list("mesh_write.urgency_rank");
    let mut best: Option<(usize, &str)> = None;
    for r in rows {
        let Some(u) = r.urgency.as_deref() else { continue };
        let Some(rank) = ranks.iter().position(|x| *x == u) else { continue };
        if best.is_none_or(|(b, _)| rank > b) {
            best = Some((rank, u));
        }
    }
    best.map_or(OVal::Null, |(_, u)| s(u))
}

/// The shipped names of one csv setting (its variable, settings key, plugin option and defaults), each a literal key so the
/// key scanner sees every one of them.
struct CsvKeys {
    env: &'static str,
    key: &'static str,
    option: &'static str,
    option_default: &'static str,
    default: &'static str,
}

/// `requiredGatesFrom`'s setting.
fn required_gates_keys() -> CsvKeys {
    CsvKeys {
        env: defaults::text("mesh_write.required_gates_env"),
        key: defaults::text("mesh_write.required_gates_key"),
        option: defaults::text("mesh_write.required_gates_option"),
        option_default: defaults::text("mesh_write.required_gates_option_default"),
        default: defaults::text("mesh_write.required_gates_default"),
    }
}

/// `heldPartitionIdsFrom`'s setting.
fn held_partitions_keys() -> CsvKeys {
    CsvKeys {
        env: defaults::text("mesh_write.held_partitions_env"),
        key: defaults::text("mesh_write.held_partitions_key"),
        option: defaults::text("mesh_write.held_partitions_option"),
        option_default: defaults::text("mesh_write.held_partitions_option_default"),
        default: defaults::text("mesh_write.held_partitions_default"),
    }
}

/// A `csv`/`string` setting as `hooks/lib/settings.js` `getWithEnv(section, key, undefined, env)` resolves it: the
/// environment variable, then `settings.json`, then the plugin option (ignored when it equals `option_default`), then the
/// schema default. A settings file the engine cannot parse the way JavaScript would reads as having no `devswarm` section.
fn csv_setting(inv: &Inv, k: &CsvKeys) -> R<String> {
    // coerceValue for csv/string: a string, number or boolean, trimmed; empty is undefined
    let coerce = |v: &Value| -> Option<String> {
        let t = match v {
            Value::String(x) => js_trim(x).to_string(),
            Value::Number(_) | Value::Bool(_) => js_string_of(v)?,
            _ => return None,
        };
        (!t.is_empty()).then_some(t)
    };
    if let Some(v) = inv.env.get(k.env).and_then(|x| coerce(&Value::String(x.clone()))) {
        return Ok(v);
    }
    let home = inv.home.to_string_lossy().to_string();
    // a settings file JavaScript reads but serde cannot parse (a number past the f64 range, nesting past the limit): the engine
    // reads it as having no `devswarm` section, so the setting falls to the plugin option and the default, and says so
    let unreadable = crate::checks::guardkit::settings::unreadable_settings_file(&home);
    if unreadable {
        crate::metrics::bump("mesh_summary_settings_unreadable", &[("key", k.key)]);
        crate::debug::violated("meshw", &defaults::render("mesh_write.msg_summary_settings_unreadable", &[("key", &k.key)]));
    }
    let st = Settings { home: home.clone(), env: inv.env.clone() };
    let section = defaults::text("mesh_write.settings_devswarm_section");
    if let Some(v) = crate::checks::guardkit::settings::read_object(&st, defaults::text("guardkit.settings_file"))
        .filter(|_| !unreadable)
        .and_then(|o| o.get(section).and_then(Value::as_object).and_then(|sct| sct.get(k.key)).and_then(coerce))
    {
        return Ok(v);
    }
    let option = k.option;
    if !option.is_empty() {
        let dflt = k.option_default;
        let env_name = format!("{}{}", defaults::text("guardkit.plugin_option_prefix"), option.to_ascii_uppercase());
        if let Some(raw) = inv.env.get(&env_name) {
            if raw != dflt
                && let Some(v) = coerce(&Value::String(raw.clone()))
            {
                return Ok(v);
            }
        } else if let Some(stored) = crate::checks::guardkit::settings::stored_options(&st)
            && let Some(raw) = stored.get(option)
            && js_string_of(raw).as_deref() != Some(dflt)
            && let Some(v) = coerce(raw)
        {
            return Ok(v);
        }
    }
    Ok(k.default.to_string())
}

/// Split a csv setting the way `requiredGatesFrom` / `heldPartitionIdsFrom` do.
fn csv_parts(v: &str) -> Vec<String> {
    if js_trim(v).is_empty() {
        return Vec::new();
    }
    v.split(defaults::text("mesh_write.csv_separator")).map(|p| js_trim(p).to_string()).filter(|p| !p.is_empty()).collect()
}

/// `heldPartitionIdsFrom(env)`: the partition ids the owner holds (the `devswarm.heldPartitions` setting).
pub(crate) fn held_ids(inv: &Inv) -> R<HashSet<String>> {
    Ok(csv_parts(&csv_setting(inv, &held_partitions_keys())?).into_iter().collect())
}

/// `jev-triage.js` `hashMessage(text)`.
pub(crate) fn jev_hash(text: &str) -> String {
    let d = ring::digest::digest(&ring::digest::SHA256, text.as_bytes());
    crate::meshw::store::hex(d.as_ref())[..defaults::num("mesh_write.jev_hash_hex") as usize].to_string()
}

/// `computeSummary(store, {home, env, now})`. `_touched` (the partition a caller is about to write) is no longer read: a write
/// that leaves an orphan is classified by the same rules as any other, after the write.
pub fn compute(st: &MeshStore, inv: &Inv, _touched: Option<&str>) -> R<OVal> {
    let home = inv.home.as_path();
    let now = inv.now as f64;
    let mut required = csv_parts(&csv_setting(inv, &required_gates_keys())?);
    if required.is_empty() {
        required = defaults::list("mesh_write.required_gates_fallback").iter().map(|x| x.to_string()).collect();
    }
    let held: HashSet<String> = csv_parts(&csv_setting(inv, &held_partitions_keys())?).into_iter().collect();
    let recent_cap = defaults::num("mesh_write.summary_recent_cap") as usize;
    let pq_cap = defaults::num("mesh_write.summary_pending_questions_cap") as usize;
    let bpart = defaults::text("mesh_write.broadcast_partition");
    let broadcast_all = messages(st, bpart, 0.0)?;
    let rows = registry(st)?;
    let archived = archive_complete_ids(home);
    let registry_ids: HashSet<String> = rows.iter().map(|d| d.id.clone()).filter(|id| !archived.contains(id)).collect();
    let aliases = crate::meshw::common::read_aliases(home);
    let mut resolver = Resolver { rows: &rows, aliases: aliases.clone(), pwid: HashMap::new() };
    let mut cur = Cursors::new(home);
    let marker = defaults::text("mesh_write.archive_request_marker");
    let direct = defaults::text("mesh_write.mtype_direct");
    let jev_cache: Option<OVal> = read_json(
        &home.join(defaults::text("mesh_write.dir_anti_hall")).join(defaults::text("mesh_write.dir_cache")).join(defaults::text("mesh_write.jev_cache_file")),
    );
    let jev_kind = defaults::text("mesh_write.jev_question_kind");
    let mut archived_rows: Vec<OVal> = Vec::new();
    let mut workspaces: Vec<(String, OVal)> = Vec::new();
    for d in &rows {
        if !d.id_is_str || !is_safe_id(&d.id) || d.id == bpart {
            continue;
        }
        if archived.contains(&d.id) {
            archived_rows.push(OVal::Obj(vec![
                ("id".into(), d.raw_id.clone()),
                ("worktreePath".into(), s_or_null(d.worktree_path.as_deref())),
                ("sessionId".into(), s_or_null(d.session_id.as_deref())),
            ]));
            continue;
        }
        let total = st.reader().message_count(&d.id).unwrap_or_else(|e| soft("count", e)) as f64;
        let floor = floor_of(st, &mut cur, home, &inv.cwd, &d.id, false);
        // #181: the roster counts from the least-advanced LIVE reader of the partition (computed now, never the stored floor a dead
        // reader can hold back), so no live reader's unread is hidden; a partition with no live reader row falls back to the floor
        let owner = crate::meshw::union::live_base_of(&st.reader().reader_cursors(&d.id).unwrap_or_else(|e| soft("reader-cursors", e)));
        if owner.is_none() {
            crate::metrics::bump("mesh_summary_owner_fallback", &[]);
        }
        let cursor = owner.as_ref().and_then(|o| o.store).unwrap_or(floor);
        let mut unread = (total - cursor).max(0.0);
        // unread rows the recipient's own family sent, when the union already counted them (the store-only path counts them below)
        let mut own_unread: Option<usize> = None;
        let family = recipient_family(&d.id, &rows);
        if d.inbox_path.is_some() || d.cursor_path.is_some() {
            let nd_floor = match owner.as_ref().and_then(|o| o.nd) {
                Some(v) => v,
                None => floor_of(st, &mut cur, home, &inv.cwd, &d.id, true),
            };
            let (known, lines) = ndjson_backlog(d.inbox_path.as_deref(), d.cursor_path.as_deref());
            if known && lines > nd_floor {
                // the NDJSON side has unread lines: the summary counts the loss-free union at the floors (reader-cursors
                // `countFor` with no reader), which `unionUnreadFor` reports when it is known
                let u = crate::meshw::union::unread_at(
                    st.reader(),
                    &d.id,
                    d.inbox_path.as_deref(),
                    d.cursor_path.as_deref(),
                    (cursor, nd_floor),
                    &family,
                    inv.now,
                )?;
                crate::meshw::tick::note_own_excluded(&u);
                unread = u.union.unread as f64;
                own_unread = Some(u.own_excluded);
            }
        }
        let (gate_vals, gate_by) = {
            let mut vals = OVal::Obj(Vec::new());
            let mut by = OVal::Obj(Vec::new());
            for (name, v, set_by) in st.reader().gate_rows(&d.id).unwrap_or_else(|e| soft("gates", e)) {
                vals.set(&name, OVal::Bool(v));
                by.set(&name, s_or_null(set_by.as_deref()));
            }
            (vals, by)
        };
        let gate_true = |g: &str| matches!(gate_vals.get(g), Some(OVal::Bool(true)));
        let archive_ready = !required.is_empty() && required.iter().all(|g| gate_true(g));
        let unread_rows = if unread > 0.0 { messages(st, &d.id, cursor)? } else { Vec::new() };
        let urgency_max = max_urgency(unread_rows.iter());
        let mut oldest_ts: Option<f64> = None;
        let mut oldest_sender: Option<String> = None;
        for r in &unread_rows {
            if r.ts.is_finite() && oldest_ts.is_none_or(|o| r.ts < o) {
                oldest_ts = Some(r.ts);
                oldest_sender = r.sender.clone();
            }
        }
        let is_req = |r: &Msg| r.mtype.as_deref() == Some(direct) && r.body.contains(marker);
        let archive_requested = unread_rows.iter().any(is_req);
        let archive_request_only = !unread_rows.is_empty() && unread_rows.iter().all(is_req);
        let needs = st.reader().needs_reply(&d.id).unwrap_or_else(|e| soft("needs-reply", e));
        let mut resolved = Vec::new();
        for r in &needs {
            let ts = match &r["ts"] {
                Value::Number(x) => x.as_f64().unwrap_or(f64::NAN),
                _ => f64::NAN,
            };
            if let Some(from) = resolver.resolve(r["sender"].as_str(), &d.id)? {
                resolved.push(Q { from, ts, seq: r["storeSeq"].as_f64() });
            }
        }
        let collapsed = collapse(resolved);
        let kept: Vec<OVal> = collapsed.iter().take(pq_cap).cloned().collect();
        let dropped = collapsed.len() - kept.len();
        let mut previews: Option<OVal> = None;
        if !kept.is_empty() {
            let mut p = OVal::Obj(Vec::new());
            for e in &kept {
                if let Some(OVal::Num(q)) = e.get("seq")
                    && q.is_finite()
                {
                    let m = st.reader().needs_reply_previews(&d.id, &[*q as i64]).unwrap_or_else(|e| soft("previews", e));
                    if let Some(Value::String(b)) = m.values().next() {
                        p.set(&crate::checks::jsport::num::to_js_string(*q), s(b));
                    }
                }
            }
            if matches!(&p, OVal::Obj(v) if !v.is_empty()) {
                previews = Some(p);
            }
        }
        // jevQuestionCandidates: unread un-flagged directs whose body jev-triage already labelled a question
        let mut jev_candidates: Vec<OVal> = Vec::new();
        {
            let flagged: HashSet<u64> = needs.iter().filter_map(|r| r["storeSeq"].as_f64()).map(f64::to_bits).collect();
            let cand: Vec<&Msg> = unread_rows
                .iter()
                .filter(|r| r.mtype.as_deref() == Some(direct) && !r.store_seq.is_some_and(|q| flagged.contains(&q.to_bits())) && !r.body.is_empty())
                .collect();
            // a row whose storeSeq is null matches a null in the flagged set (Set.has(null)); none is flagged with a null seq
            // unless such a needs-reply row exists
            let null_flagged = needs.iter().any(|r| r["storeSeq"].is_null());
            let cand: Vec<&Msg> = cand.into_iter().filter(|r| !(r.store_seq.is_none() && null_flagged)).collect();
            if !cand.is_empty() {
                let mut found = Vec::new();
                for r in cand {
                    let label = jev_cache.as_ref().and_then(|c| c.get(&jev_hash(&r.body)));
                    let is_q = matches!(label.and_then(|l| l.get(defaults::text("mesh_write.field_kind"))), Some(OVal::Str(k)) if k == jev_kind)
                        && label.is_some_and(OVal::truthy);
                    if !is_q {
                        continue;
                    }
                    if let Some(from) = resolver.resolve(r.sender.as_deref(), &d.id)? {
                        found.push(Q { from, ts: r.ts, seq: r.store_seq });
                    }
                }
                jev_candidates = collapse(found);
            }
        }
        let bc_cursor = st.reader().broadcast_cursor(&d.id).unwrap_or_else(|e| soft("broadcast-cursor", e)) as f64;
        // directUnread: the unread direct mail without what the recipient's own identity family sent
        let own_unread = own_unread.unwrap_or_else(|| unread_rows.iter().filter(|r| r.sender.as_ref().is_some_and(|x| family.contains(x))).count());
        let direct_unread = (unread - own_unread as f64).max(0.0);
        // directTotalFromOthers: the partition total without the rows its own identity family sent (wake-watch wakes on others' mail)
        let direct_from_others =
            if family.is_empty() { total } else { st.reader().message_count_from_others(&d.id, &family).unwrap_or_else(|e| soft("count", e)) as f64 };
        let unread_bc: Vec<&Msg> = broadcast_all.iter().filter(|r| !r.is_heartbeat && r.store_seq.is_some_and(|q| q.is_finite() && q > bc_cursor)).collect();
        let bc_from_others = unread_bc.iter().filter(|r| !(!family.is_empty() && r.sender.as_ref().is_some_and(|x| family.contains(x)))).count();
        let mut working_on = OVal::Null;
        for r in &broadcast_all {
            if r.is_heartbeat && r.sender.as_deref() == Some(d.id.as_str()) {
                working_on = s(&r.body);
            }
        }
        let mut w = vec![
            ("id".to_string(), d.raw_id.clone()),
            ("worktreePath".into(), s_or_null(d.worktree_path.as_deref())),
            ("sessionId".into(), s_or_null(d.session_id.as_deref())),
            ("inboxPath".into(), s_or_null(d.inbox_path.as_deref())),
            ("cursorPath".into(), s_or_null(d.cursor_path.as_deref())),
            ("nudgeCommand".into(), d.nudge.clone()),
            ("total".into(), num(total)),
            ("cursor".into(), num(cursor)),
            ("unread".into(), num(unread)),
            ("directTotalFromOthers".into(), num(direct_from_others)),
            ("directUnread".into(), num(direct_unread)),
            ("oldestDirectUnreadTs".into(), opt_num(oldest_ts)),
            ("oldestDirectUnreadSender".into(), s_or_null(oldest_sender.as_deref())),
            ("broadcastUnread".into(), n(unread_bc.len() as f64)),
            ("broadcastUnreadFromOthers".into(), n(bc_from_others as f64)),
            ("urgencyMax".into(), urgency_max),
            ("broadcastUrgencyMax".into(), max_urgency(unread_bc.iter().copied())),
            ("working_on".into(), working_on),
            ("gates".into(), gate_vals.clone()),
            ("archive_ready".into(), OVal::Bool(archive_ready)),
            ("archive_requested".into(), OVal::Bool(archive_requested)),
            ("archive_request_only_unread".into(), OVal::Bool(archive_request_only)),
            ("pendingQuestions".into(), OVal::Arr(kept.clone())),
        ];
        // push state from the freshest heartbeat file
        let beat = read_json(&devswarm_root(home).join(defaults::text("mesh_write.dir_heartbeats")).join(format!(
            "{}{}",
            d.id,
            defaults::text("mesh_write.json_suffix")
        )));
        if let Some(b @ OVal::Obj(_)) = &beat
            && let Some(OVal::Bool(nu)) = b.get("noUpstream")
        {
            w.push(("noUpstream".into(), OVal::Bool(*nu)));
            let up = match b.get("unpushed") {
                Some(OVal::Null) => OVal::Null,
                Some(OVal::Num(x)) if x.is_finite() => n(*x),
                _ => OVal::Null,
            };
            w.push(("unpushed".into(), up));
        }
        let mv = defaults::text("mesh_write.gate_merged_verified");
        if let Some(v) = gate_vals.get(mv) {
            w.push(("mergedVerified".into(), v.clone()));
            let pre = defaults::text("mesh_write.merged_setby_prefix");
            if let Some(OVal::Str(by)) = gate_by.get(mv)
                && by.starts_with(pre)
                && by.len() > pre.len()
            {
                w.push(("mergedVerifiedHead".into(), s(&by[pre.len()..])));
            }
        }
        let done = defaults::text("mesh_write.gate_done");
        if gate_true(done) {
            let pre = defaults::text("mesh_write.done_setby_prefix");
            if let Some(OVal::Str(by)) = gate_by.get(done)
                && by.starts_with(pre)
                && by.len() > pre.len()
            {
                w.push(("doneHead".into(), s(&by[pre.len()..])));
            }
        }
        if let Some(p) = previews {
            w.push(("pendingQuestionPreviews".into(), p));
        }
        if dropped > 0 {
            w.push((
                "pendingQuestionsTruncated".into(),
                OVal::Obj(vec![("cap".into(), n(pq_cap as f64)), ("kept".into(), n(kept.len() as f64)), ("dropped".into(), n(dropped as f64))]),
            ));
        }
        if !jev_candidates.is_empty() {
            w.push(("jevQuestionCandidates".into(), OVal::Arr(jev_candidates)));
        }
        let entry = OVal::Obj(w);
        match workspaces.iter_mut().find(|(k, _)| *k == d.id) {
            Some(slot) => slot.1 = entry,
            None => workspaces.push((d.id.clone(), entry)),
        }
    }
    // recent[]: consecutive identical (from, rawFrom, summary, urgency) runs collapse
    struct Run {
        from: Option<String>,
        raw: Option<String>,
        summary: String,
        urgency: Option<String>,
        count: usize,
        raw_ts: f64,
        max_ts: Option<f64>,
        min_ts: Option<f64>,
    }
    let mut runs: Vec<Run> = Vec::new();
    for r in &broadcast_all {
        let raw = r.sender.clone();
        let from = match &raw {
            Some(x) => aliases.iter().find(|(k, _)| k == x).map(|(_, to)| to.clone()).or_else(|| raw.clone()),
            None => None,
        };
        if let Some(last) = runs.last_mut()
            && last.from == from
            && last.raw == raw
            && last.summary == r.body
            && last.urgency == r.urgency
        {
            last.count += 1;
            if r.ts.is_finite() {
                last.max_ts = Some(last.max_ts.map_or(r.ts, |m| m.max(r.ts)));
                last.min_ts = Some(last.min_ts.map_or(r.ts, |m| m.min(r.ts)));
            }
            continue;
        }
        runs.push(Run {
            from,
            raw,
            summary: r.body.clone(),
            urgency: r.urgency.clone(),
            count: 1,
            raw_ts: r.ts,
            max_ts: r.ts.is_finite().then_some(r.ts),
            min_ts: r.ts.is_finite().then_some(r.ts),
        });
    }
    let skip = runs.len().saturating_sub(recent_cap);
    let recent: Vec<OVal> = runs[skip..]
        .iter()
        .map(|run| {
            let ts = if run.count > 1 && run.max_ts.is_some() { run.max_ts.unwrap_or(run.raw_ts) } else { run.raw_ts };
            let mut e = vec![
                ("from".to_string(), s_or_null(run.from.as_deref())),
                ("summary".into(), s(&run.summary)),
                ("ts".into(), num(ts)),
                ("urgency".into(), s_or_null(run.urgency.as_deref())),
            ];
            if run.raw != run.from {
                e.push(("fromLabel".into(), s_or_null(run.raw.as_deref())));
            }
            if run.count > 1 {
                e.push(("occurrences".into(), n(run.count as f64)));
                e.push(("firstTs".into(), opt_num(run.min_ts)));
                e.push(("lastTs".into(), num(ts)));
            }
            OVal::Obj(e)
        })
        .collect();
    // orphans: a partition with unread mail and no live registry row, sorted the way `computeSummary` does (archived-stranded,
    // forwarded-drained, owner-held, plain). The archive gate's liveness proof and the forwarded-drained proof stay with Node.
    let candidates: Vec<String> = st.reader().workspace_ids();
    let (mut orphans, mut stranded, mut held_out): (Vec<OVal>, Vec<OVal>, Vec<OVal>) = (Vec::new(), Vec::new(), Vec::new());
    let mut sorter = crate::meshw::orphan::Classifier::new(home, rows.iter().filter_map(|r| r.worktree_path.clone()).filter(|w| !w.is_empty()).collect());
    for id in &candidates {
        if id == bpart || registry_ids.contains(id) || !is_safe_id(id) {
            continue;
        }
        let total = st.reader().message_count(id).unwrap_or_else(|e| soft("count", e)) as f64;
        let floor = floor_of(st, &mut cur, home, &inv.cwd, id, false);
        let unread = (total - floor).max(0.0);
        if unread <= 0.0 {
            continue;
        }
        let entry = OVal::Obj(vec![("id".into(), s(id)), ("messageCount".into(), n(total)), ("unread".into(), n(unread))]);
        if sorter.classify(id)? == crate::meshw::orphan::Class::Stranded {
            stranded.push(entry);
        } else if held.contains(id) {
            held_out.push(entry);
        } else {
            orphans.push(entry);
        }
    }
    let mut stale: Vec<OVal> = Vec::new();
    for d in &rows {
        if d.id == bpart || !is_safe_id(&d.id) || archived.contains(&d.id) {
            continue;
        }
        let Some(wt) = d.worktree_path.as_deref() else { continue };
        if Path::new(&ident::worktree_real_path(wt)?).exists() {
            continue;
        }
        let total = st.reader().message_count(&d.id).unwrap_or_else(|e| soft("count", e)) as f64;
        let floor = floor_of(st, &mut cur, home, &inv.cwd, &d.id, false);
        let unread = (total - floor).max(0.0);
        if unread > 0.0 {
            stale.push(OVal::Obj(vec![("id".into(), s(&d.id)), ("worktreePath".into(), s(wt)), ("unread".into(), num(unread))]));
        }
    }
    let mut out = vec![
        ("generatedAt".to_string(), num(now)),
        ("requiredGates".into(), OVal::Arr(required.iter().map(|g| s(g)).collect())),
        ("workspaces".into(), OVal::Obj(workspaces)),
        ("recent".into(), OVal::Arr(recent)),
        ("archivedRegistryRows".into(), OVal::Arr(archived_rows)),
    ];
    for (key, list) in [("orphans", orphans), ("archivedStranded", stranded), ("heldPartitions", held_out)] {
        if !list.is_empty() {
            out.push((key.into(), OVal::Arr(list)));
        }
    }
    if !stale.is_empty() {
        out.push(("staleRegistryPartitions".into(), OVal::Arr(stale)));
    }
    Ok(OVal::Obj(out))
}

/// Kept for the verbs that call it before their write: nothing is refused any more, because a projection that fails after
/// the write is logged by [`derive_after_write`] and the next derive refreshes the file (see the module header).
pub fn check(_st: &MeshStore, _inv: &Inv, _touched: Option<&str>) -> R<()> {
    Ok(())
}

static TMP_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// `writeSummaryAtomicForHash(home, hash, summary)`: a unique temp file, then a rename.
fn write_atomic(home: &Path, hash: &str, summary: &OVal) -> std::io::Result<()> {
    let dir = devswarm_root(home).join(defaults::text("mesh_write.dir_summaries"));
    std::fs::create_dir_all(&dir)?;
    let p = dir.join(format!("{hash}{}", defaults::text("mesh_write.json_suffix")));
    let c = TMP_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = PathBuf::from(format!("{}.{}.{c}{}", p.to_string_lossy(), std::process::id(), defaults::text("mesh_write.tmp_suffix")));
    let r = std::fs::write(&tmp, summary.stringify()).and_then(|()| std::fs::rename(&tmp, &p));
    if r.is_err() {
        crate::discard::harmless(std::fs::remove_file(&tmp)); // keep: never leak the staged temp; the write error is returned
    }
    r
}

/// `deriveSummary(store, {home, env, now})` after the verb's write. It never fails the verb (the write is done and
/// must not be repeated by Node): a projection the engine cannot reproduce, an error or a panic is returned as text
/// for the caller to log, and the next Node derive (ingest daemon, hooks, any Node verb) refreshes the file.
pub fn derive_after_write(st: &MeshStore, inv: &Inv, repo_key: &str) -> Option<String> {
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| match compute(st, inv, None) {
        Ok(sum) => write_atomic(&inv.write_home, repo_key, &sum).err().map(|e| format!("summary-write:{e}")),
        Err(Defer(d)) => Some(d),
    }));
    r.unwrap_or_else(|_| Some("summary-panic".to_string()))
}

/// `deriveSummary(store, {home, env, now})` where the caller also prints from the projection: the summary, and the write
/// failure (as text) when the refresh could not be written. The projection itself failing is an `Err` (the caller decides).
pub fn derive_value(st: &MeshStore, inv: &Inv, repo_key: &str) -> R<(OVal, Option<String>)> {
    let sum = compute(st, inv, None)?;
    let failed = write_atomic(&inv.write_home, repo_key, &sum).err().map(|e| format!("summary-write:{e}"));
    Ok((sum, failed))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collapse_keeps_one_entry_per_sender_with_the_newest_ts() {
        let q = |f: &str, ts: f64, seq: f64| Q { from: s(f), ts, seq: Some(seq) };
        let out = collapse(vec![q("a", 5.0, 1.0), q("b", 1.0, 2.0), q("a", 9.0, 3.0), q("a", 2.0, 4.0)]);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].stringify(), r#"{"from":"a","ts":9,"seq":3,"occurrences":3,"firstTs":2,"lastTs":9}"#);
        assert_eq!(out[1].stringify(), r#"{"from":"b","ts":1,"seq":2}"#);
    }

    #[test]
    fn a_non_finite_ts_outranks_every_finite_one() {
        let out = collapse(vec![Q { from: s("a"), ts: 5.0, seq: Some(1.0) }, Q { from: s("a"), ts: f64::NAN, seq: Some(2.0) }]);
        assert_eq!(out[0].stringify(), r#"{"from":"a","ts":null,"seq":2,"occurrences":2,"firstTs":5,"lastTs":null}"#);
    }

    #[test]
    fn csv_parts_trims_and_drops_empties() {
        assert_eq!(csv_parts(" a, ,b ,"), vec!["a".to_string(), "b".to_string()]);
        assert!(csv_parts("  ").is_empty());
    }

    #[test]
    fn cross_link_needs_a_session_naming_the_other_id() {
        assert!(cross_linked("x", Some("y"), "y", None));
        assert!(cross_linked("x", None, "y", Some("x")));
        assert!(!cross_linked("x", Some("x"), "x", None));
        assert!(!cross_linked("x", None, "y", None));
    }

    /// A scratch store holding workspace "X" with three directs from "other", `#floor` at 1 and the given store reader rows
    /// `(reader, position, retired_line)`; the summary row of X.
    fn summary_row_of_x(tag: &str, readers: &[(&str, i64, Option<i64>)]) -> (i64, i64) {
        use crate::meshw::store::{CursorPut, RegistryRow};
        let dir = std::env::temp_dir().join(format!("ah-summary-owner-{}-{tag}", std::process::id()));
        crate::discard::harmless(std::fs::remove_dir_all(&dir)); // keep: cleanup that raced; an absent directory is the goal state
        std::fs::create_dir_all(&dir).unwrap();
        let st = MeshStore::open(&dir.join(defaults::text("mesh_write.store_file"))).unwrap();
        let row =
            RegistryRow { id: "X".into(), worktree_path: Some("/w/x".into()), session_id: None, inbox_path: None, cursor_path: None, nudge_command: None };
        st.upsert_registry(&row, 1, |a, b| a == b).unwrap();
        for i in 0..3 {
            st.append_message_from("X", 1_700_000_000_000 + i, Some(&format!("h{i}")), "m", Some("other")).unwrap();
        }
        let put = |ns: &str, reader: &str, value: i64, retired_line: Option<i64>| CursorPut {
            partition: "X".into(),
            ns: ns.into(),
            reader: reader.into(),
            value,
            retired_line: retired_line.map(Some),
            updated_at: 1,
        };
        let mut puts = vec![put("store", "#floor", 1, None), put("nd", "#floor", 0, None)];
        puts.extend(readers.iter().map(|(r, v, line)| put("store", r, *v, *line)));
        st.reader_cursor_txn(&puts).unwrap();
        let inv = Inv {
            home: dir.clone(),
            env: HashMap::new(),
            cwd: dir.to_string_lossy().into_owned(),
            now: 1_700_000_100_000,
            stdin: None,
            write_home: dir.clone(),
            store_override: None,
        };
        let sum = compute(&st, &inv, None).unwrap();
        let w = sum.get("workspaces").and_then(|w| w.get("X")).expect("X is in the summary").clone();
        let num = |k: &str| match w.get(k) {
            Some(OVal::Num(x)) => *x as i64,
            _ => panic!("{k} is no number"),
        };
        let got = (num("unread"), num("cursor"));
        crate::discard::harmless(std::fs::remove_dir_all(dir)); // keep: test cleanup; an absent directory is the goal state
        got
    }

    #[test]
    fn the_roster_counts_from_the_least_advanced_live_reader_never_a_dead_ones_floor() {
        // #181: 3 messages, stored `#floor` 1 held by a RETIRED reader, the live reader X read all 3: no phantom unread
        assert_eq!(summary_row_of_x("dead", &[("h:1:1", 3, None), ("h:2:2", 1, Some(1))]), (0, 3));
        // two LIVE readers at 3 and 1: the lagging one's 2 unread are not hidden
        assert_eq!(summary_row_of_x("live", &[("h:1:1", 3, None), ("h:2:2", 1, None)]), (2, 1));
        // no reader row: the floor is the fallback
        assert_eq!(summary_row_of_x("floor", &[]), (2, 1));
    }

    fn scratch(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("ah-summary-{tag}-{}", std::process::id()));
        crate::discard::harmless(std::fs::remove_dir_all(&dir)); // keep: cleanup that raced; an absent directory is the goal state
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn inv_in(dir: &std::path::Path) -> Inv {
        Inv { home: dir.to_path_buf(), env: HashMap::new(), cwd: dir.to_string_lossy().into_owned(), now: 1, stdin: None, write_home: dir.to_path_buf(), store_override: None }
    }

    #[test]
    fn a_stored_position_is_a_finite_non_negative_whole_number_else_zero() {
        assert_eq!(stored_position(&serde_json::json!(4.7)), 4.0);
        assert_eq!(stored_position(&serde_json::json!(-3)), 0.0);
        assert_eq!(stored_position(&serde_json::json!("7")), 0.0);
        assert_eq!(stored_position(&serde_json::Value::Null), 0.0);
    }

    #[test]
    fn a_relative_descriptor_cursor_path_is_read_from_the_callers_directory() {
        use crate::meshw::store::RegistryRow;
        defaults::init().unwrap();
        let dir = scratch("relcursor");
        let st = MeshStore::open(&dir.join(defaults::text("mesh_write.store_file"))).unwrap();
        let row = RegistryRow { id: "X".into(), worktree_path: Some("/w/x".into()), session_id: None, inbox_path: None, cursor_path: None, nudge_command: None };
        st.upsert_registry(&row, 1, |a, b| a == b).unwrap();
        let ws = devswarm_root(&dir).join(defaults::text("mesh_write.dir_workspaces"));
        std::fs::create_dir_all(&ws).unwrap();
        std::fs::write(ws.join("X.json"), r#"{"id":"X","cursorPath":"rel/cur.txt"}"#).unwrap();
        let cwd = dir.join("callers");
        std::fs::create_dir_all(cwd.join("rel")).unwrap();
        std::fs::write(cwd.join("rel").join("cur.txt"), "2").unwrap();
        let mut cur = Cursors::new(&dir);
        assert_eq!(floor_of(&st, &mut cur, &dir, &cwd.to_string_lossy(), "X", true), 2.0);
        // from another directory the same relative path names nothing: an unreadable cursor is 0
        assert_eq!(floor_of(&st, &mut cur, &dir, &dir.to_string_lossy(), "X", true), 0.0);
    }

    #[test]
    fn a_settings_file_javascript_reads_but_serde_cannot_falls_to_the_default() {
        defaults::init().unwrap();
        let dir = scratch("settings");
        let ah = dir.join(defaults::text("mesh_write.dir_anti_hall"));
        std::fs::create_dir_all(&ah).unwrap();
        // a number past the f64 range: JavaScript reads Infinity, serde refuses
        std::fs::write(ah.join("settings.json"), r#"{"devswarm":{"requiredGates":"only-this"},"big":1e999}"#).unwrap();
        let got = csv_setting(&inv_in(&dir), &required_gates_keys()).unwrap();
        assert_eq!(got, required_gates_keys().default, "the engine reads the file as holding no devswarm section and says so");
    }

    #[test]
    fn check_refuses_nothing_and_a_failed_read_is_the_default() {
        defaults::init().unwrap();
        let dir = scratch("check");
        let st = MeshStore::open(&dir.join(defaults::text("mesh_write.store_file"))).unwrap();
        assert!(check(&st, &inv_in(&dir), Some("anything")).is_ok(), "an orphan-to-be is classified after the write, not refused before it");
        let v: Vec<u8> = soft("test", "boom");
        assert!(v.is_empty());
    }
}
