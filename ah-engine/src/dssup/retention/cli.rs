//! `devswarm.js retention status | run [--dry-run] [--store X]` (lane l8c): the command-line face of the retention duty,
//! `status` and `run` of `companion/lib/devswarm-retention.js`.
//!
//! * `status` is a read: the settings, the phase, the stores by size and the archive size.
//! * `run --dry-run` plans every store (or the one named) read only, each plan agreed with Node's own planner exactly as the
//!   first-run report phase does ([`super::dry`]), and prints what `run` would do.
//! * `run` acts only under the duty's own bar ([`super::one_store`]): the engine's plan and Node's read-only planner must agree
//!   on the exact rows, and a second plan must equal the first. It acts on ONE store (the one named, or the only one) with no
//!   legacy journal to fold; anything else (several stores, a journal, a disabled setting, a lock held, a witness that
//!   disagrees or cannot run) is Node's, decided before the first write. After the first write nothing defers any more: the
//!   caller reports a committed failure instead of running Node.
//!
//! `restore` puts the bodies of tombstoned rows back from a month's archive ([`restore`]), under the same lock, and holds them for a week.
use super::apply::{Pruned, Settings};
use super::{Ended, Store, cap, dry, read_settings, read_state, sqlite_stores, write_state};
use crate::checks::guardkit::nodelock;
use crate::checks::guardkit::ojson::OVal;
use crate::defaults;
use crate::dsact::runner::Runner;
use crate::dssup::tick::Ctx;
use crate::meshw::ident::Defer;
use serde_json::Value;

fn n(x: f64) -> OVal {
    OVal::Num(x)
}

fn s(x: &str) -> OVal {
    OVal::Str(x.to_string())
}

/// `a.0 ? ... : ...` for a field of a state entry: a truthy value as it is, else null.
fn truthy_or_null(v: Option<&OVal>) -> OVal {
    v.filter(|x| x.truthy()).cloned().unwrap_or(OVal::Null)
}

/// `retention status`.
pub fn status(ctx: &Ctx) -> Result<OVal, Defer> {
    let st = settings_of(ctx);
    let state = read_state(ctx.home);
    let mut stores: Vec<Store> = sqlite_stores(ctx.home);
    stores.sort_by_key(|x| std::cmp::Reverse(x.bytes));
    let max = st.max_bytes();
    let files = cap::list(ctx.home);
    let archive_bytes: u64 = files.iter().map(|f| f.bytes).sum();
    let report = dry::report_path(ctx.home);
    let mut rows = Vec::new();
    for x in &stores {
        let mut o = vec![
            ("hash".to_string(), s(&x.hash)),
            ("mb".to_string(), n(dry::mb1(x.bytes as f64))),
            ("overLimit".to_string(), OVal::Bool(x.bytes as f64 > max)),
        ];
        if let Some(e) = state.get(defaults::text("devswarm_sup.rt_state_stores")).and_then(|m| m.get(&x.hash)).filter(|e| e.truthy()) {
            o.push(("lastRunAt".to_string(), truthy_or_null(e.get("lastRunAt"))));
            o.push(("overLimitProtected".to_string(), OVal::Bool(e.get("overLimitProtected").is_some_and(OVal::truthy))));
        }
        rows.push(OVal::Obj(o));
    }
    Ok(OVal::Obj(vec![
        ("ok".into(), OVal::Bool(true)),
        ("action".into(), s(defaults::text("devswarm_cli.ret_action_status"))),
        ("settings".into(), dry::settings_json(&st)),
        ("phase".into(), state.get(defaults::text("devswarm_sup.rt_state_phase")).cloned().unwrap_or(OVal::Null)),
        ("dryRunCompletedAt".into(), truthy_or_null(state.get(defaults::text("devswarm_sup.rt_dry_completed_key")))),
        ("dryRunReport".into(), if report.exists() { s(&report.to_string_lossy()) } else { OVal::Null }),
        ("stores".into(), OVal::Arr(rows)),
        ("archive".into(), OVal::Obj(vec![("files".into(), n(files.len() as f64)), ("mb".into(), n(dry::mb1(archive_bytes as f64)))])),
        ("log".into(), s(&ctx.home.join(defaults::text("devswarm_sup.rt_log_file")).to_string_lossy())),
    ]))
}

fn settings_of(ctx: &Ctx) -> Settings {
    read_settings(ctx)
}

/// The summary of a store the engine pruned (`summarize(r)` of a real run).
fn real_summary(r: &Pruned, legacy: OVal) -> OVal {
    let names = defaults::list("devswarm_sup.rt_protected_names");
    let protected = OVal::Obj(names.iter().zip(r.protected).map(|(k, v)| ((*k).to_string(), n(v as f64))).collect());
    OVal::Obj(vec![
        ("ok".into(), OVal::Bool(r.ok)),
        ("hash".into(), s(&r.hash)),
        ("skipped".into(), OVal::Null),
        ("error".into(), r.error.as_deref().map_or(OVal::Null, s)),
        ("dryRun".into(), OVal::Bool(false)),
        ("mbBefore".into(), n(dry::mb1(r.bytes_before as f64))),
        ("mbAfter".into(), n(dry::mb1(r.bytes_after as f64))),
        ("rows".into(), n(r.total_rows as f64)),
        ("alreadyTombstoned".into(), n(r.already_tombstoned as f64)),
        ("ageCandidates".into(), n(r.age_candidates as f64)),
        ("sizeCandidates".into(), n(r.size_candidates as f64)),
        ("candidateMB".into(), n(dry::mb1(r.candidate_bytes as f64))),
        ("tombstoned".into(), n(r.tombstoned as f64)),
        ("overLimit".into(), OVal::Bool(r.over_limit)),
        ("overLimitProtected".into(), OVal::Bool(r.over_limit_protected)),
        ("vacuum".into(), r.vacuum.clone().unwrap_or(OVal::Null)),
        ("budgetExhausted".into(), OVal::Bool(r.budget_exhausted)),
        ("protected".into(), protected),
        ("legacy".into(), legacy),
    ])
}

/// `legacy: r.legacy ? { eligible, reason, files: r.legacy.files.length } : null` of `summarize`, from the fold's own record
/// (`held` is the owner-gated fold that did not run: not eligible, and the record says why).
fn legacy_summary(v: &Value) -> OVal {
    let (eligible, reason, files) = if v.is_null() {
        (false, Some(defaults::text("devswarm_cli.ret_reason_no_journal").to_string()), 0)
    } else if let Some(why) = v.get("held").and_then(Value::as_str) {
        (false, Some(why.to_string()), 0)
    } else {
        (v["eligible"].as_bool().unwrap_or(false), v["reason"].as_str().map(str::to_string), v["files"].as_array().map_or(0, Vec::len))
    };
    OVal::Obj(vec![
        ("eligible".into(), OVal::Bool(eligible)),
        ("reason".into(), reason.map_or(OVal::Null, |r| OVal::Str(r))),
        ("files".into(), n(files as f64)),
    ])
}

/// What `pruneStore` answers before it opens anything: `disabled`, `not-a-sqlite-store` (a journal-backed store) or `no-store` (no
/// database file); `None` when the store is for pruning.
fn skipped_why(ctx: &Ctx, s_: &Settings, hash: &str) -> Option<&'static str> {
    if !s_.enabled() {
        return Some(defaults::text("devswarm_cli.ret_skip_disabled"));
    }
    let dir = super::plan::store_dir(ctx.home, hash);
    let marker = std::fs::read_to_string(dir.join(defaults::text("devswarm_sup.rt_backend_marker"))).map(|m| m.trim().to_lowercase()).unwrap_or_default();
    if marker == defaults::text("devswarm_sup.rt_backend_journal") {
        return Some(defaults::text("devswarm_cli.ret_skip_not_sqlite"));
    }
    if std::fs::metadata(super::plan::db_path(ctx.home, hash)).map_or(0, |m| m.len()) == 0 {
        return Some(defaults::text("devswarm_cli.ret_skip_no_store"));
    }
    None
}

/// `retention run [--dry-run] [--store X]`: `(ok, result)`, exactly `run` of `devswarm-retention.js` (the lock busy is its own
/// `{ok: false, error}` answer).
pub fn run(ctx: &Ctx, runner: &dyn Runner, dry_run: bool, store: Option<&str>) -> Result<(bool, OVal), Defer> {
    let st_settings = settings_of(ctx);
    let Some(held) = nodelock::acquire(&super::lock_path(ctx.home), super::lock_params()) else {
        let msg = defaults::text("devswarm_cli.ret_msg_lock_busy");
        return Ok((false, OVal::Obj(vec![("ok".into(), OVal::Bool(false)), ("error".into(), s(msg))])));
    };
    let out = locked(ctx, runner, &st_settings, dry_run, store);
    held.release();
    Ok(out)
}

fn locked(ctx: &Ctx, runner: &dyn Runner, s_: &Settings, dry_run: bool, store: Option<&str>) -> (bool, OVal) {
    let mut state = read_state(ctx.home);
    let targets: Vec<String> = match store {
        Some(x) => vec![x.to_string()],
        None => sqlite_stores(ctx.home).iter().map(|y| y.hash.clone()).collect(),
    };
    let mut rows = Vec::new();
    for hash in &targets {
        let bytes = super::apply::store_bytes(ctx.home, hash);
        if let Some(why) = skipped_why(ctx, s_, hash) {
            let legacy = if dry_run { dry::legacy_of(ctx, hash) } else { super::legacy_fold(ctx, hash) };
            rows.push(dry::skipped_summary(hash, bytes, dry_run, Some(why), legacy));
            continue;
        }
        if dry_run {
            rows.push(dry::summary(ctx, runner, &state, s_, hash));
            continue;
        }
        let pruned = match super::one_store(ctx, runner, &mut state, s_, hash, false, true) {
            Ended::Pruned(r) => r,
            // the two plans disagreed: the store moved while it was read; nothing was written, the row says so
            Ended::Held(why) => {
                let mut row = dry::skipped_summary(hash, bytes, false, None, Value::Null);
                if let OVal::Obj(v) = &mut row {
                    for (k, x) in v.iter_mut() {
                        match k.as_str() {
                            "ok" => *x = OVal::Bool(false),
                            "error" => *x = s(&why),
                            _ => {}
                        }
                    }
                }
                rows.push(row);
                continue;
            }
            Ended::DryRun(_) => continue, // one_store answers a dry run only when asked for one
        };
        let legacy = super::legacy_fold(ctx, hash);
        super::record_store(&mut state, hash, &pruned, ctx.now);
        rows.push(real_summary(&pruned, legacy_summary(&legacy)));
    }
    let ok = rows.iter().all(|r| !matches!(r.get("ok"), Some(OVal::Bool(false))));
    let plan = cap::plan(ctx.home, s_);
    if dry_run {
        return (ok, result(true, s_, rows, plan.oval(true)));
    }
    let cap_val = if plan.removed.is_empty() {
        plan.oval(false)
    } else {
        // archive files over the cap are evicted only when the owner-gated switch is on; off, the answer says they were held
        let v = super::archive_cap(ctx, runner, s_);
        let done: Vec<(String, u64)> = v["removed"]
            .as_array()
            .map(|a| a.iter().filter_map(|x| Some((x["file"].as_str()?.to_string(), x["bytes"].as_u64()?))).collect())
            .unwrap_or_default();
        if v.get("held").is_none() && done == plan.removed { plan.oval(false) } else { OVal::parse(&v.to_string()).unwrap_or(OVal::Null) }
    };
    write_state(ctx.home, &state);
    (ok, result(false, s_, rows, cap_val))
}

fn result(dry_run: bool, s_: &Settings, stores: Vec<OVal>, cap: OVal) -> OVal {
    let ok = stores.iter().all(|r| !matches!(r.get("ok"), Some(OVal::Bool(false))));
    OVal::Obj(vec![
        ("ok".into(), OVal::Bool(ok)),
        ("action".into(), s(defaults::text("devswarm_cli.ret_action_run"))),
        ("dryRun".into(), OVal::Bool(dry_run)),
        ("settings".into(), dry::settings_json(s_)),
        ("stores".into(), OVal::Arr(stores)),
        ("archiveCap".into(), cap),
    ])
}

/// Node's JSON for a value the engine builds (for comparing in tests).
pub fn json_of(v: &OVal) -> Value {
    serde_json::from_str(&v.stringify()).unwrap_or(Value::Null)
}

/// `retention restore --store X --month yyyy-mm` (`restore` of `devswarm-retention.js`): the bodies an archive month holds are written
/// back into the rows the pruning tombstoned (only a row whose id and hash match and whose body is still empty), and those ids are
/// protected from the next pruning for [`restore_hold_days`](defaults) days.
pub fn restore(ctx: &Ctx, hash: &str, month: &str) -> Result<(bool, OVal), Defer> {
    let t = |k: &str| defaults::text(k);
    let fail = |msg: &str| Ok((false, OVal::Obj(vec![("ok".into(), OVal::Bool(false)), ("error".into(), s(msg))])));
    let safe = (1..=defaults::num("devswarm_cli.ret_store_name_max") as usize).contains(&hash.len())
        && hash.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
        && !hash.starts_with('.');
    if !safe {
        return fail(t("devswarm_cli.ret_msg_bad_store"));
    }
    let ym = month.len() == 7 && month.as_bytes()[4] == b'-' && month.bytes().enumerate().all(|(i, b)| i == 4 || b.is_ascii_digit());
    if !ym {
        return fail(t("devswarm_cli.ret_msg_bad_month"));
    }
    let rel = format!("{hash}/{month}{}", t("devswarm_sup.rt_archive_ext"));
    let file = super::apply::archive_root(ctx.home).join(&rel);
    if !file.exists() {
        return fail(&defaults::render("devswarm_cli.ret_msg_no_archive", &[("file", &rel)]));
    }
    if super::apply::store_bytes(ctx.home, hash) == 0 || std::fs::metadata(super::plan::db_path(ctx.home, hash)).map_or(0, |m| m.len()) == 0 {
        return fail(&defaults::render("devswarm_cli.ret_msg_no_store", &[("hash", &hash)]));
    }
    // Node's `readArchiveFile` throws on an archive it cannot read or inflate; the answer here is the refusal with the reason
    let raw = match std::fs::read(&file) {
        Ok(r) => r,
        Err(e) => return fail(&defaults::render("devswarm_cli.ret_msg_archive_unreadable", &[("file", &rel), ("why", &e)])),
    };
    let text = match super::gz::decompress(&raw) {
        Ok(x) => x,
        Err(Defer(why)) => return fail(&defaults::render("devswarm_cli.ret_msg_archive_unreadable", &[("file", &rel), ("why", &why)])),
    };
    let mut by_id: Vec<(i64, OVal)> = Vec::new();
    let mut lines = 0u64;
    for line in String::from_utf8_lossy(&text).split('\n') {
        if line.trim().is_empty() {
            continue;
        }
        let Some(r @ OVal::Obj(_)) = OVal::parse(line) else { continue }; // a torn line is skipped
        lines += 1;
        let id = match r.get("id") {
            Some(OVal::Num(x)) if x.is_finite() && x.fract() == 0.0 => *x as i64,
            Some(OVal::Str(x)) if x.trim().parse::<i64>().is_ok() => x.trim().parse::<i64>().unwrap_or_default(),
            _ => continue,
        };
        match by_id.iter_mut().find(|(i, _)| *i == id) {
            Some(slot) => slot.1 = r,
            None => by_id.push((id, r)),
        }
    }
    let Some(held) = nodelock::acquire(&super::lock_path(ctx.home), super::lock_params()) else { return fail(t("devswarm_cli.ret_msg_lock_busy")) };
    let out = restore_locked(ctx, hash, month, lines, &by_id);
    held.release();
    out
}

fn restore_locked(ctx: &Ctx, hash: &str, month: &str, lines: u64, by_id: &[(i64, OVal)]) -> Result<(bool, OVal), Defer> {
    // Node opens the store inside its `try`: a store that will not open is the result's `error`, nothing restored
    let opened = super::apply::open_rw(ctx.home, hash);
    let mut error: Option<String> = None;
    let (mut restored, mut already, mut missing, mut mismatched) = (0u64, 0u64, 0u64, 0u64);
    let (mut min_id, mut max_id) = (i64::MAX, i64::MIN);
    let text_of = |v: Option<&OVal>| match v {
        None | Some(OVal::Null) => None,
        Some(OVal::Str(x)) => Some(x.clone()),
        Some(o) => Some(o.stringify()),
    };
    let work = (|| -> rusqlite::Result<()> {
        let Ok(c) = &opened else { return Ok(()) };
        c.execute_batch("BEGIN IMMEDIATE;")?;
        let r = (|| -> rusqlite::Result<()> {
            for (id, r) in by_id {
                let cur: Option<(Option<String>, i64)> = c
                    .query_row(crate::sql::RT_RESTORE_GET, [id], |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, i64>(1)?)))
                    .map(Some)
                    .or_else(|e| if matches!(e, rusqlite::Error::QueryReturnedNoRows) { Ok(None) } else { Err(e) })?;
                let Some((cur_hash, tomb)) = cur else {
                    missing += 1;
                    continue;
                };
                if cur_hash != text_of(r.get("hash")) {
                    mismatched += 1;
                    continue;
                }
                if tomb != 1 {
                    already += 1;
                    continue;
                }
                c.execute(crate::sql::RT_RESTORE_SET, rusqlite::params![text_of(r.get("body")).unwrap_or_default(), id])?;
                restored += 1;
                min_id = min_id.min(*id);
                max_id = max_id.max(*id);
            }
            Ok(())
        })();
        match r {
            Ok(()) => c.execute_batch("COMMIT;"),
            Err(e) => {
                crate::discard::harmless(c.execute_batch("ROLLBACK;")); // keep: the original error is the one reported
                Err(e)
            }
        }
    })();
    let mut res = vec![
        ("ok".to_string(), OVal::Bool(true)),
        ("action".into(), s(defaults::text("devswarm_cli.ret_action_restore"))),
        ("store".into(), s(hash)),
        ("month".into(), s(month)),
        ("archiveLines".into(), n(lines as f64)),
        ("unique".into(), n(by_id.len() as f64)),
    ];
    if let Err(Defer(why)) = &opened {
        error = Some(why.clone());
    }
    if let Err(e) = work {
        error = Some(e.to_string());
    }
    let mut hold_until = None;
    if error.is_none() && restored > 0 {
        let now = ctx.now as f64;
        let mut st = read_state(ctx.home);
        let mut list: Vec<OVal> = match st.get("holds").and_then(|h| h.get(hash)) {
            Some(OVal::Arr(a)) => a
                .iter()
                .filter(|h| matches!(h, OVal::Obj(_)) && matches!(h.get("until"), Some(OVal::Num(u)) if *u > now))
                .cloned()
                .collect(),
            _ => Vec::new(),
        };
        let until = now + defaults::num("devswarm_cli.ret_restore_hold_days") as f64 * defaults::num("devswarm_sup.rt_day_ms") as f64;
        list.push(OVal::Obj(vec![("minId".into(), n(min_id as f64)), ("maxId".into(), n(max_id as f64)), ("until".into(), n(until)), ("month".into(), s(month))]));
        if let Some(holds) = super::apply::obj_mut(&mut st, "holds") {
            holds.set(hash, OVal::Arr(list));
        }
        write_state(ctx.home, &st);
        hold_until = Some(until);
    }
    super::apply::log_event(
        ctx.home,
        &[
            ("event", s(defaults::text("devswarm_cli.ret_event_restore"))),
            ("store", s(hash)),
            ("month", s(month)),
            ("restored", n(restored as f64)),
            ("alreadyPresent", n(already as f64)),
            ("missing", n(missing as f64)),
            ("mismatched", n(mismatched as f64)),
        ],
    );
    for (k, v) in [("restored", restored), ("alreadyPresent", already), ("missing", missing), ("mismatched", mismatched)] {
        res.push((k.into(), n(v as f64)));
    }
    if let Some(u) = hold_until {
        res.push(("holdUntil".into(), n(u)));
    }
    if let Some(e) = error {
        res[0].1 = OVal::Bool(false);
        res.push(("error".into(), s(&e)));
    }
    let ok = matches!(res[0].1, OVal::Bool(true));
    Ok((ok, OVal::Obj(res)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::meshw::common::Inv;

    fn scratch(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("ah-ret-{tag}-{}", std::process::id()));
        crate::discard::harmless(std::fs::remove_dir_all(&d)); // keep: a stale directory of an earlier run of this test
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// `retention restore` puts the archived body back into a tombstoned row, leaves a present or mismatched row alone, and holds the ids.
    #[test]
    fn restore_writes_back_only_a_tombstone_with_the_same_hash_and_holds_it() {
        let home = scratch("restore");
        let hash = "abc123";
        let db = super::super::plan::db_path(&home, hash);
        std::fs::create_dir_all(db.parent().unwrap()).unwrap();
        let c = rusqlite::Connection::open(&db).unwrap();
        c.execute_batch(
            "CREATE TABLE messages (id INTEGER PRIMARY KEY, hash TEXT, body TEXT);
             INSERT INTO messages VALUES (1,'h1',NULL),(2,'h2','kept'),(3,'h3',NULL),(5,'h5',NULL);",
        )
        .unwrap();
        drop(c);
        let adir = super::super::apply::archive_root(&home).join(hash);
        std::fs::create_dir_all(&adir).unwrap();
        let lines = "{\"id\":1,\"hash\":\"h1\",\"body\":\"one\"}\n{\"id\":2,\"hash\":\"h2\",\"body\":\"two\"}\n{\"id\":3,\"hash\":\"WRONG\",\"body\":\"three\"}\n{\"id\":4,\"hash\":\"h4\",\"body\":\"four\"}\ntorn{\n";
        std::fs::write(adir.join("2026-09.ndjson.gz"), super::super::gz::compress(lines.as_bytes()).unwrap()).unwrap();
        let inv = Inv { home: home.clone(), write_home: home.clone(), env: Default::default(), cwd: "/".into(), now: 1_000_000, stdin: None, store_override: None };
        let st = inv.settings();
        let root = std::path::PathBuf::from("/");
        let ctx = Ctx { home: &home, root: &root, st: &st, now: 1_000_000, engine_pokes: false };
        let (ok, v) = restore(&ctx, hash, "2026-09").unwrap();
        assert!(ok, "{}", v.stringify());
        let n = |k: &str| match v.get(k) {
            Some(OVal::Num(x)) => *x as i64,
            other => panic!("{k}: {other:?}"),
        };
        assert_eq!((n("archiveLines"), n("unique"), n("restored"), n("alreadyPresent"), n("missing"), n("mismatched")), (4, 4, 1, 1, 1, 1));
        let c = rusqlite::Connection::open(&db).unwrap();
        let body = |id: i64| c.query_row("SELECT body FROM messages WHERE id=?1", [id], |r| r.get::<_, Option<String>>(0)).unwrap();
        assert_eq!((body(1), body(2), body(3)), (Some("one".into()), Some("kept".into()), None));
        let state = read_state(&home);
        assert!(matches!(state.get("holds").and_then(|h| h.get(hash)), Some(OVal::Arr(a)) if a.len() == 1));
        // refusals keep Node's words
        assert_eq!(restore(&ctx, "../x", "2026-09").unwrap().1.get("error"), Some(&s("bad --store")));
        assert_eq!(restore(&ctx, hash, "2026-9").unwrap().1.get("error"), Some(&s("--month must be yyyy-mm")));
        assert_eq!(restore(&ctx, hash, "2026-08").unwrap().1.get("error"), Some(&s("no archive abc123/2026-08.ndjson.gz")));
        crate::discard::harmless(std::fs::remove_dir_all(home)); // keep: cleanup of a scratch directory
    }
}
