//! The read-only half of the app sync: the names cache (the one file it writes besides `app-state.json`), the message-gap
//! cross-check against the stores, and the `app-state.json` document itself (`refreshNamesFromApp`, `messageGaps` and the state
//! built by `syncAppState` in `scripts/devswarm-lib/repair.js`). Everything is built as ordered JSON so the file's bytes are
//! Node's. A shape JavaScript would order or evaluate differently (an integer-like object key, `__proto__`, an id the locale
//! collation might order differently from bytes) is a [`Defer`](crate::meshw::ident::Defer): the app sync is then Node's.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this module is a deliberate keep, for these reasons:
// - an unreadable names file reads as "no cached name" (Node: `readName` is fail-open)
// - a store that cannot be opened is reported as `store-unreadable`, as Node does
use super::plan::{Desc, safe_id};
use super::snap::{self, Snap, Ws};
use crate::checks::guardkit::ojson::OVal;
use crate::defaults;
use crate::meshw::ident::{self, R, defer};
use crate::meshw::idlock::devswarm_root;
use std::path::{Path, PathBuf};

fn n(x: f64) -> OVal {
    OVal::Num(x)
}

fn s(x: &str) -> OVal {
    OVal::Str(x.to_string())
}

fn opt_s(x: Option<&str>) -> OVal {
    x.map_or(OVal::Null, s)
}

fn obj(v: Vec<(&str, OVal)>) -> OVal {
    OVal::Obj(v.into_iter().map(|(k, x)| (k.to_string(), x)).collect())
}

fn name_file(home: &Path, id: &str) -> PathBuf {
    devswarm_root(home).join(defaults::text("devswarm_sup.as_dir_names")).join(format!("{id}{}", defaults::text("devswarm_sup.as_json_ext")))
}

/// `readName(home, id)`: the cached title, if any.
fn read_name(home: &Path, id: &str) -> Option<String> {
    let bytes = std::fs::read(name_file(home, id)).ok()?;
    match OVal::parse(&String::from_utf8_lossy(&bytes))?.get("name") {
        Some(OVal::Str(t)) if !t.is_empty() => Some(t.clone()),
        _ => None,
    }
}

/// `refreshNamesFromApp`: the app's own title for each workspace is written to the names cache when it differs. Returns
/// `(checked, refreshed)`.
pub fn refresh_names(home: &Path, snap: &Snap, rows: &[Desc], now: i64) -> R<(u64, u64)> {
    let (mut checked, mut refreshed) = (0, 0);
    for d in rows {
        if !safe_id(&d.id) {
            continue;
        }
        let Some(ws) = snap.workspace_for(Some(&d.id), d.worktree()?.as_deref())? else { continue };
        let Some(label) = ws.label.as_deref().filter(|l| !l.is_empty()) else { continue };
        checked += 1;
        let cached = read_name(home, &d.id);
        if cached.as_deref() == Some(label) {
            continue;
        }
        // an app label that is still the raw branch name never overwrites a different cached name (the spawn-title race)
        if cached.is_some() && ws.branch_name.as_deref().is_some_and(|b| !b.is_empty()) && ws.branch_name.as_deref() == Some(label) {
            continue;
        }
        let p = name_file(home, &d.id);
        if let Some(dir) = p.parent() {
            crate::discard::harmless(std::fs::create_dir_all(dir)); // keep: the write below reports the failure
        }
        let text = obj(vec![("name", s(label)), ("updatedAt", n(now as f64))]).stringify();
        if crate::atomic::write(&p, text).is_ok() {
            refreshed += 1;
        }
    }
    Ok((checked, refreshed))
}

fn index_like(k: &str) -> bool {
    !k.is_empty() && k.bytes().all(|b| b.is_ascii_digit()) && (k == "0" || !k.starts_with('0')) && k.parse::<u64>().is_ok_and(|v| v < u32::MAX as u64)
}

/// The age bucket of `messageGaps` as an index into the branch counters (3 = under an hour ... 6 = older).
fn bucket(age: f64) -> usize {
    let limits = [defaults::num("devswarm_sup.as_age_1h"), defaults::num("devswarm_sup.as_age_1d"), defaults::num("devswarm_sup.as_age_7d")];
    3 + limits.iter().take_while(|l| age >= **l as f64).count()
}

fn store_ts_set(db: &Path) -> Result<std::collections::HashSet<u64>, ()> {
    let c =
        rusqlite::Connection::open_with_flags(db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX).map_err(|_| ())?;
    let mut st = c.prepare(crate::sql::AS_NATIVE_TS).map_err(|_| ())?;
    let mut rows = st.query(rusqlite::params![defaults::text("devswarm_sup.as_native_like")]).map_err(|_| ())?;
    let mut out = std::collections::HashSet::new();
    while let Some(r) = rows.next().map_err(|_| ())? {
        let v = r.get_ref(0).map_err(|_| ())?;
        let f = match v {
            rusqlite::types::ValueRef::Integer(i) => i as f64,
            rusqlite::types::ValueRef::Real(f) => f,
            _ => return Err(()),
        };
        // timestamps are whole milliseconds; anything else cannot equal a parsed date
        if f.fract() == 0.0 && f >= 0.0 {
            out.insert(f as u64);
        }
    }
    Ok(out)
}

/// `messageGaps(home, env, snap, now)`: `Ok(None)` is Node's null.
pub fn message_gaps(home: &Path, file: &str, snap: &Snap, now: i64) -> R<Option<OVal>> {
    let t = now as f64;
    let settle = defaults::num("devswarm_sup.as_settle_ms") as f64;
    let Some(by_repo) = snap::message_timestamps(file, t - settle)? else { return Ok(None) };
    let mut repos = Vec::new();
    for repo in &snap.repositories {
        let rows: &[snap::AppMsg] = by_repo.iter().find(|(k, _)| *k == repo.id).map_or(&[], |(_, v)| v.as_slice());
        let mut r: Vec<(String, OVal)> = vec![
            ("repositoryId".into(), s(&repo.id)),
            ("name".into(), opt_s(repo.name.as_deref())),
            ("repoKey".into(), OVal::Null),
            ("app".into(), n(rows.len() as f64)),
            ("matched".into(), n(0.0)),
            ("archivedTarget".into(), n(0.0)),
            ("preIngest".into(), n(0.0)),
            ("gap".into(), n(0.0)),
            ("byBranch".into(), OVal::Obj(Vec::new())),
        ];
        let set = |r: &mut Vec<(String, OVal)>, k: &str, v: OVal| match r.iter_mut().find(|(x, _)| x == k) {
            Some(slot) => slot.1 = v,
            None => r.push((k.to_string(), v)),
        };
        if rows.is_empty() {
            repos.push(OVal::Obj(r));
            continue;
        }
        let key = match repo.path.as_deref().filter(|p| !p.is_empty()) {
            Some(p) if Path::new(p).exists() => ident::repo_key_for_worktree(p)?,
            _ => None,
        };
        set(&mut r, "repoKey", opt_s(key.as_deref()));
        let db = key.as_ref().map(|k| super::super::retention::plan::db_path(home, k));
        let Some(db) = db.filter(|d| d.exists()) else {
            set(&mut r, "reason", s(defaults::text("devswarm_sup.as_reason_no_store")));
            repos.push(OVal::Obj(r));
            continue;
        };
        let Ok(ts) = store_ts_set(&db) else {
            set(&mut r, "reason", s(defaults::text("devswarm_sup.as_reason_unreadable")));
            repos.push(OVal::Obj(r));
            continue;
        };
        let ingest_start = ts.iter().copied().min().map_or(f64::INFINITY, |m| m as f64);
        let live: Vec<&str> = snap
            .workspaces
            .iter()
            .filter(|w| w.repository_id.as_deref() == Some(repo.id.as_str()) && !w.archived)
            .filter_map(|w| w.branch_name.as_deref().filter(|b| !b.is_empty()))
            .collect();
        let (mut matched, mut archived_target, mut pre, mut gap) = (0.0, 0.0, 0.0, 0.0);
        // branch -> [n, oldest, newest, lt1h, lt1d, lt7d, older], in first-seen order
        let mut by_branch: Vec<(String, [f64; 7])> = Vec::new();
        for m in rows {
            if let Some(c) = m.created_at
                && c.fract() == 0.0
                && c >= 0.0
                && ts.contains(&(c as u64))
            {
                matched += 1.0;
                continue;
            }
            if !m.to_branch.as_deref().is_some_and(|b| live.contains(&b)) {
                archived_target += 1.0;
                continue;
            }
            if m.created_at.is_none_or(|c| c < ingest_start) {
                pre += 1.0;
                continue;
            }
            gap += 1.0;
            let c = m.created_at.unwrap_or(0.0);
            let branch = m.to_branch.clone().unwrap_or_default();
            if index_like(&branch) || branch == defaults::text("devswarm_sup.as_proto_key") {
                return defer("gap-branch-key");
            }
            let i = match by_branch.iter().position(|(k, _)| *k == branch) {
                Some(i) => i,
                None => {
                    by_branch.push((branch, [0.0, f64::NAN, f64::NAN, 0.0, 0.0, 0.0, 0.0]));
                    by_branch.len() - 1
                }
            };
            let b = &mut by_branch[i].1;
            b[0] += 1.0;
            b[1] = if b[1].is_nan() { c } else { b[1].min(c) };
            b[2] = if b[2].is_nan() { c } else { b[2].max(c) };
            b[bucket(t - c)] += 1.0;
        }
        set(&mut r, "matched", n(matched));
        set(&mut r, "archivedTarget", n(archived_target));
        set(&mut r, "preIngest", n(pre));
        set(&mut r, "gap", n(gap));
        let bb = by_branch
            .into_iter()
            .map(|(k, b)| {
                (
                    k,
                    obj(vec![
                        ("n", n(b[0])),
                        ("oldest", n(b[1])),
                        ("newest", n(b[2])),
                        ("lt1h", n(b[3])),
                        ("lt1d", n(b[4])),
                        ("lt7d", n(b[5])),
                        ("older", n(b[6])),
                    ]),
                )
            })
            .collect();
        set(&mut r, "byBranch", OVal::Obj(bb));
        r.push(("ingestStart".into(), if ingest_start.is_finite() { n(ingest_start) } else { OVal::Null }));
        repos.push(OVal::Obj(r));
    }
    Ok(Some(obj(vec![("at", n(t)), ("repos", OVal::Arr(repos))])))
}

/// The `gaps` value kept from the previous `app-state.json` when it is still fresh, else `None` (scan again). `Err` for a shape
/// the engine will not carry over.
pub fn previous_gaps(prev: &Option<OVal>, now: i64, cooldown: Option<f64>) -> R<Option<OVal>> {
    let Some(g) = prev.as_ref().and_then(|p| p.get("gaps")).filter(|g| g.truthy()) else { return Ok(None) };
    let at = match g.get("at") {
        Some(OVal::Num(a)) if a.is_finite() => *a,
        _ => return Ok(None),
    };
    let cooldown = cooldown.unwrap_or_else(|| defaults::num("devswarm_sup.as_gap_cooldown_ms") as f64);
    if now as f64 - at >= cooldown || (now as f64) < at {
        return Ok(None);
    }
    // the total below reads `gaps.repos[i].gap`; a shape that would make JavaScript throw is Node's
    match g.get("repos") {
        Some(OVal::Arr(rs)) if rs.iter().all(|r| matches!(r.get("gap"), Some(OVal::Num(_)))) => Ok(Some(g.clone())),
        _ => defer("gaps-shape"),
    }
}

/// `gaps.repos.reduce((n, r) => n + r.gap, 0)`.
pub fn gap_total(g: &OVal) -> f64 {
    match g.get("repos") {
        Some(OVal::Arr(rs)) => rs.iter().map(|r| if let Some(OVal::Num(x)) = r.get("gap") { *x } else { 0.0 }).sum(),
        _ => 0.0,
    }
}

fn repo_cmp(a: &Ws, b: &Ws) -> R<std::cmp::Ordering> {
    let (x, y) = (a.repository_id.as_deref().unwrap_or(""), b.repository_id.as_deref().unwrap_or(""));
    let plain = |t: &str| t.bytes().all(|c| c.is_ascii_digit() || c.is_ascii_lowercase() || c == b'-');
    if !plain(x) || !plain(y) {
        return defer("locale-compare");
    }
    Ok(x.as_bytes().cmp(y.as_bytes()))
}

/// What the state document needs besides the snapshot.
pub struct Inputs<'a> {
    /// The home directory.
    pub home: &'a Path,
    /// The clock.
    pub now: i64,
    /// Descriptors of `workspaces/`.
    pub descs: &'a [Desc],
    /// Markers of `archived/`.
    pub archived: &'a [Desc],
    /// `archived` summary of the mark step.
    pub archived_summary: OVal,
    /// `retiredMarkers` summary.
    pub retired_summary: OVal,
    /// `names` summary.
    pub names_summary: OVal,
    /// The gaps value.
    pub gaps: OVal,
}

/// The `app-state.json` document of a successful sync and the numbers `appDbSyncIfDue` reports from it.
pub struct Built {
    /// The document.
    pub state: OVal,
    /// Workspaces the app has open that anti-hall has no descriptor for.
    pub unknown: usize,
}

/// `JSON.stringify` order of an object keyed by session ids: an integer-like key would be ordered first by JavaScript.
fn guard_keys(keys: &[String]) -> R<()> {
    if keys.iter().any(|k| index_like(k) || k == defaults::text("devswarm_sup.as_proto_key")) { defer("object-key-order") } else { Ok(()) }
}

/// Build the state document.
pub fn build(snap: &Snap, inp: &Inputs) -> R<Built> {
    let now = inp.now as f64;
    let primary = defaults::text("devswarm_sup.as_primary_type");
    let ai = defaults::text("devswarm_sup.as_ai_type");
    let known: std::collections::HashSet<&str> = inp.descs.iter().chain(inp.archived.iter()).map(|d| d.id.as_str()).collect();
    let archived_ids: std::collections::HashSet<&str> = inp.archived.iter().map(|d| d.id.as_str()).collect();
    let mut known_wt = std::collections::HashSet::new();
    for d in inp.descs.iter().chain(inp.archived.iter()) {
        if let Some(k) = super::plan::wt_key(d.worktree()?.as_deref())? {
            known_wt.insert(k);
        }
    }
    let focused = snap.focused(now);
    let mut sessions: Vec<(String, OVal)> = Vec::new();
    let mut session_keys: Vec<String> = Vec::new();
    let mut active: Vec<(&Ws, OVal)> = Vec::new();
    let mut unknown: Vec<OVal> = Vec::new();
    let mut open_marked: Vec<OVal> = Vec::new();
    for w in &snap.workspaces {
        if !w.active {
            continue;
        }
        let cur = w.terminals.iter().filter(|t| t.terminal_type.as_deref() == Some(ai) && t.is_active == Some(true) && t.session_id.is_some()).fold(
            None::<&snap::Term>,
            |best, t| match best {
                // `sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0]`: the newest, the first of equals
                Some(b) if b.created_at.unwrap_or(0.0) >= t.created_at.unwrap_or(0.0) => Some(b),
                _ => Some(t),
            },
        );
        if let Some(c) = cur {
            let sid = c.session_id.clone().unwrap_or_default();
            let wt = w.worktree_path_raw.as_deref().filter(|p| !p.is_empty()).or(w.worktree_path.as_deref()).unwrap_or("");
            let corroborated = snap::transcript_cwd_matches(inp.home, &sid, wt)? == Some(true);
            let v = obj(vec![
                ("builderId", s(&w.id)),
                ("worktreePath", opt_s(w.worktree_path.as_deref())),
                ("builderType", opt_s(w.builder_type.as_deref())),
                ("corroborated", OVal::Bool(corroborated)),
            ]);
            match sessions.iter_mut().find(|(k, _)| *k == sid) {
                Some(slot) => slot.1 = v,
                None => {
                    session_keys.push(sid.clone());
                    sessions.push((sid, v));
                }
            }
        }
        let brief = snap.brief_status(w, now);
        let entry = obj(vec![
            ("id", s(&w.id)),
            ("label", opt_s(w.label.as_deref())),
            ("builderType", opt_s(w.builder_type.as_deref())),
            ("repositoryId", opt_s(w.repository_id.as_deref())),
            ("rank", w.rank.map_or(OVal::Null, n)),
            ("isPinned", w.is_pinned.map_or(OVal::Null, OVal::Bool)),
            ("focused", OVal::Bool(focused == Some(w.id.as_str()))),
            ("finish", snap::finish_signal(w).map_or(OVal::Null, OVal::Str)),
            ("brief", opt_s(brief)),
            ("sessionId", opt_s(cur.and_then(|c| c.session_id.as_deref()))),
            ("panelStatus", opt_s(cur.and_then(|c| c.panel_status.as_deref()))),
            ("scrollbackMtimeMs", w.scrollback.map_or(OVal::Null, |(m, _)| n(m))),
        ]);
        active.push((w, entry));
        let wt_key = super::plan::wt_key(w.worktree_path.as_deref())?;
        if w.builder_type.as_deref() != Some(primary) && !known.contains(w.id.as_str()) && !wt_key.as_ref().is_some_and(|k| known_wt.contains(k)) {
            unknown.push(obj(vec![("id", s(&w.id)), ("label", opt_s(w.label.as_deref()))]));
        }
        if archived_ids.contains(w.id.as_str()) {
            let marker = inp.archived.iter().find(|d| d.id == w.id);
            let local = marker.is_some_and(|m| !super::plan::app_sourced(m)) && w.builder_type.as_deref() != Some(primary);
            let cmd = if local {
                OVal::Str(format!("{}{}", defaults::text("devswarm_sup.as_archive_cmd"), w.branch_name.as_deref().filter(|b| !b.is_empty()).unwrap_or(&w.id)))
            } else {
                OVal::Null
            };
            open_marked.push(obj(vec![
                ("id", s(&w.id)),
                ("label", opt_s(w.label.as_deref())),
                ("repositoryId", opt_s(w.repository_id.as_deref())),
                ("worktreePath", opt_s(wt_key.as_deref())),
                ("localArchive", OVal::Bool(local)),
                ("cmd", cmd),
            ]));
        }
    }
    guard_keys(&session_keys)?;
    // `active.sort(repositoryId, then rank)`: stable, a missing rank last
    let mut err: Option<ident::Defer> = None;
    active.sort_by(|(a, _), (b, _)| match repo_cmp(a, b) {
        Ok(std::cmp::Ordering::Equal) => match (a.rank, b.rank) {
            (None, None) => std::cmp::Ordering::Equal,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (Some(_), None) => std::cmp::Ordering::Less,
            (Some(x), Some(y)) => x.partial_cmp(&y).unwrap_or(std::cmp::Ordering::Equal),
        },
        Ok(o) => o,
        Err(e) => {
            err = Some(e);
            std::cmp::Ordering::Equal
        }
    });
    if let Some(e) = err {
        return Err(e);
    }
    let sched = {
        let d = inp.home.join(defaults::text("devswarm_sup.as_scheduled_dir"));
        std::fs::read_dir(d).map(|rd| rd.flatten().filter_map(|e| e.file_name().into_string().ok()).filter(|n| !n.starts_with('.')).collect::<Vec<_>>()).ok()
    };
    let sched = match sched {
        Some(mut v) => {
            v.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
            v
        }
        None => Vec::new(),
    };
    let counts = obj(vec![
        ("builders", n(snap.workspaces.len() as f64)),
        ("active", n(active.len() as f64)),
        ("archived", n(snap.workspaces.iter().filter(|w| w.archived).count() as f64)),
    ]);
    let unknown_n = unknown.len();
    let state = obj(vec![
        ("v", n(1.0)),
        ("at", n(now)),
        ("ok", OVal::Bool(true)),
        ("appVersion", opt_s(snap.app_version.as_deref())),
        ("missing", OVal::Arr(snap.missing.iter().map(|m| s(m)).collect())),
        ("gated", OVal::Arr(Vec::new())),
        ("counts", counts),
        ("focused", opt_s(focused)),
        ("active", OVal::Arr(active.into_iter().map(|(_, e)| e).collect())),
        ("sessions", OVal::Obj(sessions)),
        ("unknownToAntiHall", OVal::Arr(unknown)),
        ("openButMarkedArchived", OVal::Arr(open_marked)),
        ("scheduledForDeletion", OVal::Arr(sched.iter().map(|m| s(m)).collect())),
        ("archived", inp.archived_summary.clone()),
        ("retiredMarkers", inp.retired_summary.clone()),
        ("names", inp.names_summary.clone()),
        ("gaps", inp.gaps.clone()),
    ]);
    Ok(Built { state, unknown: unknown_n })
}
