//! Host primitives for the Primary seat of the SessionStart `devswarm-child-role` check: who holds the seat of a Primary checkout
//! (`seatVerdict` of `companion/lib/primary-seat.js`) and the adoption, or first registration, of it (`adoptPrimarySeat` of
//! `scripts/devswarm-lib/register.js`). Like the rest of `ahHost` these hold no text and no decision about what to say: the script
//! words the notices. Every answer that cannot be given exactly is `{"unsure":true}` with its cause under `why`.
//!
//! | raw function | what it does |
//! |---|---|
//! | `meshSeat(cwd, session, now)` | the seat verdict `{state, id, worktree, holder, handover, stale, reason?, descriptorPath?, evidence?}` (read-only) |
//! | `meshAdoptSeat(cwd, session, now, realDevswarm)` | `{verdict, adopted}`: the seat taken over from a closed holder (or registered for the first time under real DevSwarm) through `register-primary` |
//! | `fileExec(rel)` | marks a file under the script write root executable (a stable launcher) |
use super::host::with_settings;
use super::host_parentinbox::{project_dir, sessions_for};
use crate::checks::guardkit::ojson::OVal;
use crate::defaults;
use crate::dssup::liveness;
use crate::meshw::args::{Args, FlagVal};
use crate::meshw::common::Inv;
use crate::meshw::ident::{self, R};
use crate::meshw::{idlock, lifeverbs};
use rquickjs::{Ctx, Function, Object};
use serde_json::{Value, json};
use std::path::Path;

fn set(v: &mut Value, k: &str, x: Value) {
    if let Some(o) = v.as_object_mut() {
        o.insert(k.to_string(), x);
    }
}

fn field<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or_default()
}

fn unsure(why: &str) -> String {
    json!({"unsure": true, "why": why}).to_string()
}

fn inv_of(st: &crate::checks::git::util::Settings, cwd: &str, session: &str, now: f64) -> Inv {
    let home = std::path::PathBuf::from(&st.home);
    let mut env = st.env.clone();
    env.insert(defaults::text("mesh_write.env_session_id").to_string(), session.to_string());
    Inv { home: home.clone(), env, cwd: cwd.to_string(), now: now as i64, stdin: None, write_home: home, store_override: None }
}

/// The newest `HANDOVER*.md` under `<worktree>/<handovers dir>/<date>/<session>/`, across sessions: `{path, sessionId, mtimeMs}`.
fn newest_handover(worktree: &str) -> Option<Value> {
    let root = Path::new(worktree).join(defaults::text("codex_handover.handovers_dir"));
    let re = regex::Regex::new(defaults::text("devswarm_role.seat_handover_re")).ok()?;
    let dirs = |p: &Path| -> Vec<String> {
        std::fs::read_dir(p)
            .map(|rd| rd.flatten().filter(|e| e.file_type().is_ok_and(|t| t.is_dir())).filter_map(|e| e.file_name().into_string().ok()).collect())
            .unwrap_or_default()
    };
    let mut best: Option<(String, String, f64)> = None;
    for date in dirs(&root) {
        for sid in dirs(&root.join(&date)) {
            let dir = root.join(&date).join(&sid);
            let Ok(rd) = std::fs::read_dir(&dir) else { continue };
            for f in rd.flatten().filter_map(|e| e.file_name().into_string().ok()) {
                if !re.is_match(&f) {
                    continue;
                }
                let p = dir.join(&f);
                let Ok(md) = std::fs::metadata(&p) else { continue };
                let m = liveness::mtime_ms(&md);
                if md.is_file() && best.as_ref().is_none_or(|b| m > b.2) {
                    best = Some((p.to_string_lossy().into_owned(), sid.clone(), m));
                }
            }
        }
    }
    best.map(|(path, sid, m)| json!({"path": path, "sessionId": sid, "mtimeMs": m}))
}

/// `staleResume`: another session of the worktree was active after the current session's own last activity.
fn stale_resume(home: &Path, worktree: &str, cur: &str, handover: Option<&Value>) -> R<Value> {
    if cur.is_empty() {
        return Ok(Value::Null);
    }
    let list = sessions_for(home, worktree)?;
    // a pattern that does not compile (a broken override) matches no id
    let sid_re = regex::Regex::new(defaults::text("devswarm_parent.drift_sid_re")).ok();
    let mine = match list.iter().find(|s| s.id == cur) {
        Some(s) => Some(s.last_ms),
        None if sid_re.as_ref().is_some_and(|re| re.is_match(cur)) => {
            let file = project_dir(home, worktree).join(format!("{cur}{}", defaults::text("devswarm_sup.lv_transcript_ext")));
            std::fs::metadata(file).ok().map(|m| liveness::mtime_ms(&m)).filter(|m| m.is_finite())
        }
        None => None,
    };
    let Some(mine) = mine else { return Ok(Value::Null) };
    let mut best: Option<(String, f64)> = None;
    for x in &list {
        if x.id == cur || x.last_ms.partial_cmp(&mine) != Some(std::cmp::Ordering::Greater) {
            continue;
        }
        if best.as_ref().is_none_or(|b| x.last_ms > b.1) {
            best = Some((x.id.clone(), x.last_ms));
        }
    }
    if let Some(h) = handover {
        let hsid = field(h, "sessionId");
        if hsid != cur {
            let mut until = h.get("mtimeMs").and_then(Value::as_f64).unwrap_or(0.0);
            if let Some(w) = list.iter().find(|s| s.id == hsid)
                && w.last_ms > until
            {
                until = w.last_ms;
            }
            if until > mine && best.as_ref().is_none_or(|b| until > b.1) {
                best = Some((hsid.to_string(), until));
            }
        }
    }
    Ok(best.map_or(Value::Null, |(sid, until)| json!({"sessionId": sid, "activeUntilMs": until})))
}

/// `holderLiveness`: `(live, evidence)` of the session the anchor records; `live` is `None` when it cannot be established. The
/// DevSwarm app's active terminals are consulted only when the sessions directory is unreadable, and are not read here (`appTerminals`
/// stays `null`: the script counts it).
fn holder_liveness(home: &Path, holder: &str, id: &str, now: f64) -> R<(Option<bool>, Value)> {
    let mut ev = json!({});
    let state = liveness::session_state(home, holder)?;
    set(&mut ev, "sessionFile", state.map_or(Value::Null, Value::Bool));
    if state.is_some() {
        return Ok((state, ev));
    }
    let dir = home.join(defaults::text("mesh_write.claude_dir")).join(defaults::text("mesh_write.sessions_dir"));
    let readable = std::fs::read_dir(dir).is_ok();
    set(&mut ev, "sessionsDir", json!(readable));
    if readable {
        return Ok((Some(false), ev));
    }
    set(&mut ev, "appTerminals", Value::Null);
    let age = liveness::heartbeat_ts(home, id).map(|ts| now - ts);
    set(&mut ev, "heartbeatAgeMs", age.map_or(Value::Null, |a| json!(a)));
    if age.is_some_and(|a| a > defaults::num("devswarm_role.seat_heartbeat_stale_ms") as f64) {
        return Ok((Some(false), ev));
    }
    Ok((None, ev))
}

fn na() -> Value {
    json!({"state": defaults::text("devswarm_cli.seat_state_na")})
}

/// The text of a JSON number or string field as JavaScript spells it; `None` for absent, null, `false`, `0` and `""`.
fn js_text(v: Option<&OVal>) -> Option<String> {
    match v {
        None | Some(OVal::Null) | Some(OVal::Bool(false)) => None,
        Some(OVal::Str(s)) if s.is_empty() => None,
        Some(OVal::Str(s)) => Some(s.clone()),
        Some(OVal::Num(n)) if *n == 0.0 || n.is_nan() => None,
        Some(OVal::Num(n)) => Some(crate::checks::jsport::num::to_js_string(*n)),
        // a truthy boolean, array or object reads as its `String()`
        Some(x @ (OVal::Bool(true) | OVal::Arr(_) | OVal::Obj(_))) => Some(super::host_parentinbox::js_text(x)),
    }
}

/// `seatVerdict`.
pub(crate) fn seat_verdict(inv: &Inv, session: &str, now: f64) -> R<Value> {
    let home = &inv.home;
    let c = ident::resolve_context(&inv.cwd, true)?;
    let Some(wt) = c.worktree_root.clone() else { return Ok(na()) };
    if !ident::is_primary_checkout(&wt, c.main_worktree.as_deref(), home, &inv.env)? {
        return Ok(na());
    }
    let id = ident::primary_workspace_id(&wt)?;
    let desc_file =
        idlock::devswarm_root(home).join(defaults::text("mesh_write.dir_workspaces")).join(format!("{id}{}", defaults::text("mesh_write.json_suffix")));
    let desc = match ident::read_bounded(&desc_file)? {
        Some(b) => OVal::parse(&String::from_utf8_lossy(&b)),
        None => None,
    };
    let desc = desc.filter(|d| matches!(d, OVal::Obj(_)));
    // a descriptor that exists but cannot be read is not "never registered": it is never registered over
    let corrupt = desc.is_none() && desc_file.exists();
    let holder = match desc.as_ref().map(|d| js_text(d.get(defaults::text("mesh_write.field_session_id")))) {
        Some(r) => r.filter(|s| !s.starts_with(defaults::text("mesh_write.synthetic_session_prefix"))).unwrap_or_default(),
        None => String::new(),
    };
    let handover = newest_handover(&wt);
    let stale = stale_resume(home, &wt, session, handover.as_ref())?;
    let mut v = json!({
        "id": id, "worktree": wt, "holder": if holder.is_empty() { Value::Null } else { json!(holder) },
        "handover": handover.clone().unwrap_or(Value::Null), "stale": stale,
    });
    let state = |v: &mut Value, s: &str| set(v, "state", json!(s));
    if corrupt {
        state(&mut v, "unknown");
        set(&mut v, "reason", json!("corrupt-descriptor"));
        set(&mut v, "descriptorPath", json!(desc_file.to_string_lossy()));
        return Ok(v);
    }
    if desc.is_none() {
        state(&mut v, "none");
        return Ok(v);
    }
    if session.is_empty() {
        state(&mut v, "unknown");
        set(&mut v, "reason", json!("no-current-session"));
        return Ok(v);
    }
    if holder.is_empty() || holder == session {
        state(&mut v, if holder.is_empty() { "adopt" } else { "own" });
        return Ok(v);
    }
    let (live, evidence) = holder_liveness(home, &holder, &id, now)?;
    state(
        &mut v,
        match live {
            Some(true) => "conflict",
            Some(false) => "adopt",
            None => "unknown",
        },
    );
    set(&mut v, "evidence", evidence);
    Ok(v)
}

/// `adoptPrimarySeat`: the seat taken over from a closed holder, or registered for the first time under real DevSwarm.
fn adopt_seat(inv: &Inv, session: &str, now: f64, real: bool) -> R<Value> {
    let eligible = |v: &Value| field(v, "state") == "adopt" || (field(v, "state") == "none" && real);
    let v0 = seat_verdict(inv, session, now)?;
    if !eligible(&v0) {
        return Ok(json!({"verdict": v0, "adopted": false}));
    }
    // the check is repeated just before the write: a session that adopted in between is the holder now (register-primary then refuses
    // a live holder under its own lock)
    let v = seat_verdict(inv, session, now)?;
    if !eligible(&v) {
        return Ok(json!({"verdict": v, "adopted": false}));
    }
    let id = field(&v, "id").to_string();
    let wt = field(&v, "worktree").to_string();
    let desc_file =
        idlock::devswarm_root(&inv.home).join(defaults::text("mesh_write.dir_workspaces")).join(format!("{id}{}", defaults::text("mesh_write.json_suffix")));
    let cursor = ident::read_bounded(&desc_file)?
        .and_then(|b| OVal::parse(&String::from_utf8_lossy(&b)))
        .and_then(|d| js_text(d.get(defaults::text("mesh_write.field_cursor_path"))));
    let mut a = Args { positionals: vec![defaults::text("devswarm_cli.verb_register_primary").to_string()], ..Args::default() };
    let mut put = |k: &str, val: String| {
        a.flags.insert(defaults::text(k).to_string(), vec![FlagVal::S(val)]);
    };
    put("devswarm_cli.flag_worktree", wt.clone());
    put("devswarm_cli.flag_session", session.to_string());
    if let Some(c) = cursor {
        put("devswarm_cli.flag_reg_cursor", c);
    }
    let reg_inv = Inv { cwd: wt, ..inv.clone() };
    match lifeverbs::register_primary(&reg_inv, &a) {
        Ok(ans) => {
            let ok = serde_json::from_str::<Value>(ans.stdout.trim()).ok().and_then(|r| r.get("ok").and_then(Value::as_bool)).unwrap_or(false);
            if ok { Ok(json!({"verdict": v, "adopted": true})) } else { Ok(json!({"verdict": seat_verdict(inv, session, now)?, "adopted": false})) }
        }
        // what the registration could not decide is not a write: the seat is not adopted this session (the script counts it)
        Err(d) => Ok(json!({"verdict": v, "adopted": false, "why": d.0})),
    }
}

fn exec_bit(rel: &str) -> bool {
    use std::os::unix::fs::PermissionsExt;
    let parts: Vec<&str> = rel.split('/').collect();
    if parts.len() < 2 || parts.first() != Some(&defaults::text("script.write_root")) || parts.iter().any(|p| p.is_empty() || *p == "." || *p == "..") {
        return false;
    }
    with_settings(|st| {
        let p = Path::new(&st.home).join(rel);
        std::fs::symlink_metadata(&p).is_ok_and(|m| m.is_file()) && std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).is_ok()
    })
    .unwrap_or(false)
}

/// Install the functions on `h`.
pub(super) fn install<'js>(c: &Ctx<'js>, h: &Object<'js>) -> rquickjs::Result<()> {
    h.set(
        "meshSeat",
        Function::new(c.clone(), |cwd: String, session: String, now: f64| -> rquickjs::Result<String> {
            with_settings(|st| match seat_verdict(&inv_of(st, &cwd, &session, now), &session, now) {
                Ok(v) => v.to_string(),
                Err(d) => unsure(&d.0),
            })
        })?,
    )?;
    h.set(
        "meshAdoptSeat",
        Function::new(c.clone(), |cwd: String, session: String, now: f64, real: bool| -> rquickjs::Result<String> {
            with_settings(|st| match adopt_seat(&inv_of(st, &cwd, &session, now), &session, now, real) {
                Ok(v) => v.to_string(),
                Err(d) => unsure(&d.0),
            })
        })?,
    )?;
    h.set("fileExec", Function::new(c.clone(), |rel: String| -> rquickjs::Result<bool> { Ok(exec_bit(&rel)) })?)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The seat holder is `desc.sessionId && !String(...).startsWith(...) ? String(...) : ''`: truthy `true`, arrays and objects have text.
    #[test]
    fn a_session_field_of_any_truthy_shape_has_the_text_javascript_gives_it() {
        assert_eq!(js_text(Some(&OVal::Bool(true))).as_deref(), Some("true"));
        assert_eq!(js_text(Some(&OVal::Arr(vec![OVal::Num(1.0), OVal::Num(2.0)]))).as_deref(), Some("1,2"));
        assert_eq!(js_text(Some(&OVal::Obj(Vec::new()))).as_deref(), Some(defaults::text("devswarm_parent.js_object_text")));
        assert_eq!((js_text(Some(&OVal::Bool(false))), js_text(Some(&OVal::Num(0.0))), js_text(Some(&OVal::Null)), js_text(None)), (None, None, None, None));
    }
}
