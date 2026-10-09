//! `devswarm.js send` (direct `--to`, `--to-primary`, `--broadcast`), ported from `scripts/devswarm.js` `run()` /
//! `runArmed` and `scripts/devswarm-lib/send.js` `cmdSend`.
//!
//! The engine answers only the successful path it can reproduce exactly; every refusal Node would print, and every branch
//! that needs evidence the engine does not read (session liveness for a stale twin or a partitioned group, a fold
//! redirect, a re-home, Jev triage, plan activity, the first sender-alias write, the self-heal installer), is a
//! [`Defer`]: Node runs the verb instead, before the engine wrote anything. So a deferred verb never runs twice.
//!
//! The summary refresh (`deriveSummary`) runs right after the append, as in Node (`meshw::summary`); a store whose
//! summary the engine cannot reproduce defers before anything is written.
use crate::checks::guardkit::ojson::OVal;
use crate::defaults;
use crate::meshw::args::Args;
use crate::meshw::common::{self, Inv, Obj, n, s, s_or_null};
use crate::meshw::ident::{self, Defer, R, Row, defer};
use crate::meshw::store::{self, MeshStore};

/// What a verb wrote to the store, for the shadow comparison.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Effect {
    /// Nothing.
    None,
    /// The message row with this hash.
    Row(String),
    /// The broadcast cursor of this id.
    BroadcastCursor(String),
}

/// A verb's answer: the exit code and the exact stdout line Node prints.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Answer {
    /// `process.exit(code)`.
    pub code: i32,
    /// What `main()` writes to fd 1 (with the trailing newline).
    pub stdout: String,
    /// What it wrote.
    pub effect: Effect,
}

/// `meshCandidateRows(store, meshId)`.
pub fn mesh_candidates(rows: &[Row], mesh_id: Option<&str>) -> R<Vec<Row>> {
    let Some(mesh_id) = mesh_id.filter(|m| !m.is_empty()) else { return Ok(Vec::new()) };
    let mut out = Vec::new();
    for d in rows {
        let Some(wp) = d.worktree_path.as_deref() else { continue };
        let canon = match ident::canonical_mesh_id(wp)? {
            Some(c) => Some(c),
            None => ident::raw_path_mesh_id(wp)?,
        };
        if canon.as_deref() == Some(mesh_id) {
            out.push(d.clone());
        }
    }
    Ok(out)
}

/// `resolveMeshTarget(store, meshId)` where it does not need liveness: no candidate, or exactly one (which
/// `pickFreshestLive` returns whether or not it is live). Two or more defer.
pub fn resolve_mesh_target(rows: &[Row], mesh_id: Option<&str>) -> R<Option<Row>> {
    let c = mesh_candidates(rows, mesh_id)?;
    match c.len() {
        0 => Ok(None),
        1 => Ok(c.into_iter().next()),
        _ => defer("mesh-group"),
    }
}

/// `resolveSendTarget(store, arg, home, { rerouteStaleTwin: true })` where it needs no liveness and no redirect.
fn resolve_send_target(rows: &[Row], arg: &str) -> R<Row> {
    let by_mesh = resolve_mesh_target(rows, Some(arg))?;
    if arg.is_empty() {
        return by_mesh.map_or_else(|| defer("unregistered-recipient"), Ok);
    }
    let id_matches: Vec<&Row> = rows.iter().filter(|d| !d.id.is_empty() && d.id == arg).collect();
    match id_matches.len() {
        1 => {
            let row = id_matches[0];
            let same_row = by_mesh.as_ref().is_some_and(|b| b.id == row.id);
            let own = match row.worktree_path.as_deref() {
                Some(p) => ident::canonical_mesh_id(p)?,
                None => None,
            };
            let same_group = own.as_deref() == Some(arg);
            if let Some(b) = &by_mesh {
                if !same_row && !same_group {
                    return defer("ambiguous-recipient");
                }
                if same_group && !same_row {
                    return Ok(b.clone());
                }
            }
            // staleTwinSuccessor: proven inert only when the row has no session, a synthetic one, or its own id as session
            let sid = row.session_id.as_deref().unwrap_or("");
            if sid.is_empty() || sid.starts_with(defaults::text("mesh_write.synthetic_session_prefix")) || sid == row.id {
                return Ok(row.clone());
            }
            defer("stale-twin")
        }
        0 => by_mesh.map_or_else(|| defer("unregistered-recipient"), Ok),
        _ => defer("ambiguous-recipient"),
    }
}

/// Run `send` with `a` (argv already parsed; `a.positionals[0] == "send"`).
pub fn run(inv: &Inv, a: &Args) -> R<Answer> {
    if a.is_help() {
        return defer("help");
    }
    common::seat_check(inv)?;
    if a.has(defaults::text("mesh_write.flag_cc_primary")) {
        return defer("cc-primary");
    }
    let tos = a.many(defaults::text("mesh_write.flag_to"));
    if tos.len() > 1 || tos.iter().any(|t| t.contains(',') || t.trim() != *t) {
        return defer("multi-recipient");
    }
    let heal = common::self_heal(inv)?;
    let mut out = cmd_send(inv, a)?;
    for (k, v) in heal {
        out.put(&k, v);
    }
    let ok = matches!(out.0.iter().find(|(k, _)| k == "ok").map(|(_, v)| v), Some(OVal::Bool(true)));
    let effect = match out.0.iter().find(|(k, _)| k == "hash").map(|(_, v)| v) {
        Some(OVal::Str(h)) => Effect::Row(h.clone()),
        _ => Effect::None,
    };
    let res = out.done();
    let quiet = a.has(defaults::text("mesh_write.flag_quiet")) && !inv_has_json(a);
    let line = if quiet { quiet_line(&res) } else { res.stringify() };
    Ok(Answer { code: if ok { 0 } else { 2 }, stdout: format!("{line}\n"), effect })
}

fn inv_has_json(a: &Args) -> bool {
    a.has(defaults::text("mesh_write.flag_json"))
}

/// `sendQuietLine(result)` for one recipient.
fn quiet_line(r: &OVal) -> String {
    let get = |k: &str| r.get(k).map(OVal::stringify).unwrap_or_else(|| defaults::text("mesh_write.js_undefined").to_string());
    if r.get("ok").is_some_and(OVal::truthy) {
        let to = if matches!(r.get("type"), Some(OVal::Str(t)) if t == defaults::text("mesh_write.mtype_broadcast")) {
            defaults::text("mesh_write.quiet_broadcast").to_string()
        } else {
            match r.get("to") {
                Some(OVal::Str(t)) => t.clone(),
                Some(OVal::Null) | None => defaults::text("mesh_write.quiet_unknown").to_string(),
                Some(v) => v.stringify(),
            }
        };
        return defaults::render("mesh_write.quiet_ok", &[("seq", &get("seq")), ("to", &to), ("bytes", &get("bytes"))]);
    }
    let why = match (r.get("error"), r.get("reason")) {
        (Some(OVal::Str(e)), _) if !e.is_empty() => e.clone(),
        (_, Some(OVal::Str(x))) if !x.is_empty() => x.clone(),
        _ => defaults::text("mesh_write.quiet_failed").to_string(),
    };
    defaults::render("mesh_write.quiet_fail", &[("why", &why)])
}

/// `cmdSend(flags, ctx)`: the successful path, else [`Defer`].
pub(crate) fn cmd_send(inv: &Inv, a: &Args) -> R<Obj> {
    let home = &inv.home;
    let cwd = ident::project_cwd_for(home, &inv.env, &inv.cwd)?;
    let Some(repo_key) = ident::repo_key_for_worktree(&cwd)? else { return defer("no-project") };
    // registrySnapshot opens the store as a writer; the engine opens it once, below, and refuses what Node would create
    let st = common::open_store(inv, &repo_key)?;
    let rows = ident::rows_of(&st.reader().roster().map_err(|e| Defer(format!("registry:{e}")))?);
    let from_d = ident::sender_identity_detailed(&inv.env, &cwd, &rows, home)?;
    if from_d.kind == defaults::text("mesh_write.kind_child") {
        // writeAlias(home, meshId, child, worktree): a no-op only when the alias already says so
        let label = from_d.mesh_id.clone().unwrap_or_default();
        let have = common::read_aliases(home).into_iter().any(|(k, v)| k == label && v == from_d.identity);
        if !have {
            return defer("sender-alias");
        }
    }
    let from = from_d.identity.clone();
    if let Some(ff) = a.one(defaults::text("mesh_write.flag_from"))
        && ff != from
        && Some(ff) != from_d.mesh_id.as_deref()
    {
        return defer("from-mismatch");
    }
    let to_flag = a.one(defaults::text("mesh_write.flag_to"));
    let broadcast = a.has(defaults::text("mesh_write.flag_broadcast"))
        || a.one(defaults::text("mesh_write.flag_type")) == Some(defaults::text("mesh_write.mtype_broadcast"));
    let to_primary = a.has(defaults::text("mesh_write.flag_to_primary"));
    let modes = usize::from(to_flag.is_some()) + usize::from(broadcast) + usize::from(to_primary);
    if modes != 1 {
        return defer("target-mode");
    }
    if !broadcast
        && let Some(t) = to_flag
        && common::jev_pending_answer(inv, &from, t)
    {
        return defer("jev-answer");
    }
    let question = a.has(defaults::text("mesh_write.flag_question"));
    let answers = a.has(defaults::text("mesh_write.flag_answers"));
    if broadcast && (question || answers) {
        return defer("broadcast-question");
    }
    let m_flag = a.one(defaults::text("mesh_write.flag_message"));
    let m_file = a.one(defaults::text("mesh_write.flag_message_file"));
    let m_stdin = a.has(defaults::text("mesh_write.flag_message_stdin"));
    if usize::from(m_flag.is_some()) + usize::from(m_file.is_some()) + usize::from(m_stdin) != 1 {
        return defer("message-source");
    }
    let message = if let Some(f) = m_file {
        match std::fs::read(f) {
            Ok(b) => String::from_utf8_lossy(&b).into_owned(),
            Err(_) => return defer("message-file"),
        }
    } else if m_stdin {
        match &inv.stdin {
            Some(sv) => sv.clone(),
            None => return defer("message-stdin"),
        }
    } else {
        m_flag.unwrap_or_default().to_string()
    };
    if message.is_empty() {
        return defer("empty-message");
    }
    let urgency = a.one(defaults::text("mesh_write.flag_urgency")).unwrap_or(defaults::text("mesh_write.urgency_default")).to_string();
    if !defaults::list("mesh_write.allowed_urgency").contains(&urgency.as_str()) {
        return defer("urgency");
    }
    let mut primary_mesh: Option<String> = None;
    if to_primary {
        let c = ident::resolve_context(&cwd, false)?;
        let Some(common_dir) = c.common_dir else { return defer("no-primary-worktree") };
        primary_mesh = Some(ident::primary_workspace_id(&ident::dirname(&common_dir))?);
    }
    if !broadcast {
        let self_target = if to_primary { primary_mesh.clone() } else { to_flag.map(str::to_string) };
        if self_target.as_deref() == Some(from.as_str()) || (from_d.mesh_id.is_some() && self_target == from_d.mesh_id) {
            return defer("self-address");
        }
    }
    let now = inv.now;
    if let Some(pm) = &primary_mesh {
        rehome_is_noop(inv, pm)?;
    }
    // target resolution (direct)
    let target: Option<Row> = if broadcast {
        None
    } else if let Some(pm) = &primary_mesh {
        match resolve_mesh_target(&rows, Some(pm))? {
            Some(t) => Some(t),
            None => return defer("primary-unregistered"),
        }
    } else {
        Some(resolve_send_target(&rows, to_flag.unwrap_or_default())?)
    };
    let candidates = match &target {
        Some(t) => {
            let mesh_for_count = match t.worktree_path.as_deref() {
                Some(p) => match ident::canonical_mesh_id(p)? {
                    Some(c) => Some(c),
                    None => ident::raw_path_mesh_id(p)?,
                },
                None => None,
            };
            Some(mesh_candidates(&rows, mesh_for_count.as_deref())?.len())
        }
        None => None,
    };
    if !broadcast && !question && common::jev_maybe_enabled(inv) {
        return defer("jev-triage");
    }
    if common::sender_has_plan(inv, &from)? {
        return defer("plan-activity");
    }
    let partition = target.as_ref().map(|t| t.id.clone());
    // the summary refresh after the write must be one the engine can do (else Node runs the whole verb)
    crate::meshw::summary::check(&st, inv, partition.as_deref())?;
    // ---- commit: everything below writes, nothing below defers ----
    let to_out: Option<String> = if broadcast {
        None
    } else if to_primary {
        primary_mesh.clone()
    } else {
        to_flag.map(str::to_string)
    };
    let ctx = AppendCtx {
        inv,
        st: &st,
        from: &from,
        kind: &from_d.kind,
        to_out: to_out.as_deref(),
        partition: partition.as_deref(),
        broadcast,
        message: &message,
        urgency: &urgency,
        now,
        question,
        answers,
        candidates,
        repo_key: &repo_key,
        cwd: &cwd,
    };
    if broadcast {
        return do_append(&ctx);
    }
    let pid = partition.clone().unwrap_or_default();
    let attempts = defaults::num("mesh_write.send_lock_attempts").max(1);
    for attempt in 0..attempts {
        if let Some(lock) = crate::meshw::idlock::acquire(&inv.write_home, &pid) {
            let still = st.reader().roster().map(|r| ident::rows_of(&r).iter().any(|x| x.id == pid)).unwrap_or(false);
            let r = if still { do_append(&ctx) } else { defer("recipient-moved") };
            lock.release();
            return r;
        }
        if attempt + 1 < attempts {
            let base = defaults::num("mesh_write.send_lock_retry_base_ms");
            let backoff = base * (1u64 << attempt.min(defaults::num("mesh_write.send_lock_max_shift"))) + store::jitter_ms(base);
            std::thread::sleep(std::time::Duration::from_millis(backoff));
        }
    }
    defer("lock-busy")
}

/// `maybeRehomeToCwdProject(home, primaryMeshId, ctx)` does nothing (else defer).
pub(crate) fn rehome_is_noop(inv: &Inv, id: &str) -> R<()> {
    let Some(repo_key) = ident::resolve_context(&inv.cwd, true)?.repo_key else { return Ok(()) };
    let hash_key = hash_from_workspace_id(id);
    if hash_key == repo_key {
        return Ok(());
    }
    let owner = ident::read_descriptor(&inv.home, id).and_then(|d| match d.get(defaults::text("mesh_write.field_owner_key")) {
        Some(OVal::Str(sv)) if !sv.is_empty() => Some(sv.clone()),
        _ => None,
    });
    if owner.as_deref() != Some(hash_key.as_str()) {
        return Ok(());
    }
    defer("rehome")
}

/// `hashFromWorkspaceId(id)`.
pub fn hash_from_workspace_id(id: &str) -> String {
    let p = defaults::text("mesh_write.primary_prefix");
    let hex_len = defaults::num("mesh_write.mesh_id_hex") as usize;
    if let Some(rest) = id.strip_prefix(p)
        && rest.len() == hex_len
        && rest.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return rest.to_ascii_lowercase();
    }
    let d = ring::digest::digest(&ring::digest::SHA256, id.as_bytes());
    store::hex(d.as_ref())[..hex_len].to_string()
}

struct AppendCtx<'a> {
    inv: &'a Inv,
    st: &'a MeshStore,
    from: &'a str,
    kind: &'a str,
    to_out: Option<&'a str>,
    partition: Option<&'a str>,
    broadcast: bool,
    message: &'a str,
    urgency: &'a str,
    now: i64,
    question: bool,
    answers: bool,
    candidates: Option<usize>,
    repo_key: &'a str,
    cwd: &'a str,
}

/// `doAppend()`: append, read it back, build the result, write the receipt. A failed INSERT wrote nothing (SQLite
/// statements are atomic), so it defers and Node reports it.
fn do_append(c: &AppendCtx<'_>) -> R<Obj> {
    let mtype = if c.broadcast { defaults::text("mesh_write.mtype_broadcast") } else { defaults::text("mesh_write.mtype_direct") };
    let to_field = if c.broadcast { None } else { c.partition };
    let ts = c.now.to_string();
    let hash = store::mesh_message_hash(Some(c.from), to_field, mtype, c.urgency, c.message, &ts, c.question);
    let nonce = ident::reader_nonce(&c.inv.home);
    let row = store::mesh_message_row(Some(c.from), to_field, c.broadcast, c.message, c.now, c.urgency, &hash, c.question, nonce.as_deref());
    let (inserted, seq) = match c.st.append_mesh_row(&row) {
        Ok(r) => (r.inserted, r.seq),
        Err(e) => return Err(Defer(format!("append:{e}"))),
    };
    crate::meshw::mark_committed();
    // deriveSummary(s, {home, env, now}), in the same call as the append (the wake watcher reads it)
    if let Some(why) = crate::meshw::summary::derive_after_write(c.st, c.inv, c.repo_key) {
        crate::meshw::log_summary_failure(defaults::text("mesh_write.verb_send"), &why);
    }
    let verify_partition = if c.broadcast { defaults::text("mesh_write.broadcast_partition").to_string() } else { c.partition.unwrap_or_default().to_string() };
    let mut verified = false;
    let mut verify_error: Option<String> = None;
    {
        let mut last: Option<String> = None;
        let mut any = false;
        let r = c.st.reader().for_each_message(&verify_partition, 0, |m| {
            let h = m["hash"].as_str().map(str::to_string);
            if h.as_deref() == Some(hash.as_str()) {
                any = true;
            }
            last = h;
            true
        });
        match r {
            Ok(()) => verified = last.as_deref() == Some(hash.as_str()) || any,
            Err(e) => verify_error = Some(e.to_string()),
        }
    }
    let ok = verified || verify_error.is_some();
    let bytes = c.message.len() as f64;
    let mut out = Obj::default();
    out.put("ok", OVal::Bool(ok))
        .put("action", s(defaults::text("mesh_write.action_send")))
        .put("from", s(c.from))
        .put("identity", Obj(vec![("id".into(), s(c.from)), ("kind".into(), s(c.kind))]).done())
        .put("to", s_or_null(c.to_out))
        .put("type", s(mtype))
        .put("urgency", s(c.urgency))
        .put("sent", OVal::Bool(inserted))
        .put("seq", seq.map_or(OVal::Null, |x| n(x as f64)))
        .put("bytes", n(bytes))
        .put("hash", s(&hash))
        .put("needsReply", OVal::Bool(c.question))
        .put("answers", OVal::Bool(c.answers))
        .put("toId", s_or_null(if c.broadcast { None } else { c.partition }));
    if let Some(k) = c.candidates {
        out.put("candidates", n(k as f64));
    }
    out.put("verified", OVal::Bool(verified));
    // the receipt (writeSendReceipt), written before verifyError/reason are added, exactly as Node orders it
    let receipt = Obj(vec![
        ("ts".into(), n(c.now as f64)),
        ("from".into(), s(c.from)),
        ("to".into(), s_or_null(c.to_out)),
        ("toId".into(), s_or_null(if c.broadcast { None } else { c.partition })),
        ("type".into(), s(mtype)),
        ("urgency".into(), s(c.urgency)),
        ("hash".into(), s(&hash)),
        ("bytes".into(), n(bytes)),
        ("ok".into(), OVal::Bool(ok)),
        ("sent".into(), OVal::Bool(inserted)),
        ("needsReply".into(), OVal::Bool(c.question)),
        ("verified".into(), OVal::Bool(verified)),
        ("repoKey".into(), s(c.repo_key)),
        ("cwd".into(), s(c.cwd)),
    ])
    .done();
    common::write_send_receipt(&c.inv.write_home, c.now, &hash, &receipt);
    if let Some(e) = verify_error {
        out.put("verifyError", s(&e));
    }
    if !verified && out.0.iter().all(|(k, _)| k != "verifyError") {
        out.put("reason", s(defaults::text("mesh_write.reason_not_verified")));
        out.put(
            "error",
            s(&defaults::render(
                "mesh_write.msg_not_verified",
                &[("hash", &hash), ("partition", &serde_json::to_string(&verify_partition).unwrap_or_default())],
            )),
        );
    }
    Ok(out)
}
