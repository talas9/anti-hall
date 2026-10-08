//! `devswarm.js mesh read` (consuming and `--peek`), `mesh history` and `roster --ack`, ported from
//! `scripts/devswarm-lib/roster-diag.js` `cmdMeshRead`.
//!
//! A consuming read advances the caller's broadcast cursor to the head of the broadcast partition (`advanceBroadcastCursor`,
//! one statement); a peek writes nothing. `--since` (an ISO time or a duration) and every refusal defer to Node, as does
//! a caller whose own registry group has more than one row (Node picks among them by liveness).
//! Not reproduced (Node keeps it, see DECISIONS D45 stage 2): the summary refresh after a consuming read.
use crate::checks::guardkit::ojson::OVal;
use crate::defaults;
use crate::meshw::args::{Args, FlagVal};
use crate::meshw::common::{self, Inv, Obj, n, s, s_or_null};
use crate::meshw::ident::{self, Defer, R, defer};
use crate::meshw::send::{Answer, Effect, resolve_mesh_target};

/// `Number(x)` for a flag value.
fn js_number(x: &str) -> f64 {
    crate::checks::guardkit::text::js_number_of_str(x)
}

/// Run `mesh read`, `mesh history` or `roster --ack`.
pub fn run(inv: &Inv, a: &Args, history: bool) -> R<Answer> {
    if a.is_help() {
        return defer("help");
    }
    let mut a = a.clone();
    if history {
        a.flags.insert(defaults::text("mesh_write.flag_seq").into(), vec![FlagVal::S(defaults::text("mesh_write.history_seq").into())]);
        a.flags.insert(defaults::text("mesh_write.flag_peek").into(), vec![FlagVal::True]);
    }
    let home = &inv.home;
    let cwd = ident::project_cwd_for(home, &inv.env, &inv.cwd)?;
    let Some(repo_key) = ident::repo_key_for_worktree(&cwd)? else { return defer("no-project") };
    let from = ident::caller_identity_detailed(&inv.env, &cwd)?.identity;
    let st = common::open_store(inv, &repo_key)?;
    let rows = ident::rows_of(&st.reader().roster().map_err(|e| Defer(format!("registry:{e}")))?);
    let own = resolve_mesh_target(&rows, Some(&from))?;
    let cursor_key = own.map(|r| r.id).unwrap_or_else(|| from.clone());
    let cursor = st.reader().broadcast_cursor(&cursor_key).map_err(|e| Defer(format!("cursor:{e}")))? as f64;
    let flag_seq = defaults::text("mesh_write.flag_seq");
    let has_seq = a.has(flag_seq);
    let seq_raw = a.one(flag_seq);
    let mut since_seq = cursor;
    let mut explicit = false;
    if has_seq && seq_raw.is_none() {
        return defer("bad-seq");
    }
    if let Some(raw) = seq_raw {
        let v = js_number(raw);
        if !v.is_finite() || v < 0.0 {
            return defer("bad-seq");
        }
        since_seq = v.floor();
        explicit = true;
    }
    let peek = a.has(defaults::text("mesh_write.flag_peek")) || explicit;
    let has_last = a.has(defaults::text("mesh_write.flag_last"));
    if a.has(defaults::text("mesh_write.flag_since")) {
        return defer("since-filter");
    }
    if has_last && !peek {
        return defer("filter-requires-peek");
    }
    let mut last_n: Option<f64> = None;
    if has_last {
        let raw = a.one(defaults::text("mesh_write.flag_last"));
        let v = raw.map_or(f64::NAN, js_number);
        if raw.is_none() || !v.is_finite() || v < 1.0 {
            return defer("bad-last");
        }
        last_n = Some(v.floor());
    }
    if !peek {
        common::seat_check(inv)?;
    }
    let aliases = common::read_aliases(home);
    let mut unseen: Vec<serde_json::Value> = Vec::new();
    st.reader()
        .for_each_message(defaults::text("mesh_write.broadcast_partition"), 0, |m| {
            if !m["isHeartbeat"].as_bool().unwrap_or(false) && m["storeSeq"].as_f64().is_some_and(|q| q > since_seq) {
                unseen.push(m);
            }
            true
        })
        .map_err(|e| Defer(format!("broadcasts:{e}")))?;
    let unseen_count = unseen.len();
    if let Some(k) = last_n {
        let k = k as usize;
        if unseen.len() > k {
            unseen.drain(..unseen.len() - k);
        }
    }
    let broadcasts: Vec<OVal> = unseen
        .iter()
        .map(|r| {
            let sender = r["sender"].as_str();
            let alias = sender.and_then(|sv| aliases.iter().find(|(k, _)| k == sv).map(|(_, v)| v.clone()));
            let mut b = Obj::default();
            b.put(
                "from",
                match &alias {
                    Some(to) => s(to),
                    None => s_or_null(sender),
                },
            )
            .put("message", s(r["body"].as_str().unwrap_or("")))
            .put("text", s(r["body"].as_str().unwrap_or("")))
            .put("kind", s(defaults::text("mesh_write.mtype_broadcast")))
            .put("timestamp", n(r["ts"].as_f64().unwrap_or(f64::NAN)))
            .put("urgency", s_or_null(r["urgency"].as_str()))
            .put("seq", r["storeSeq"].as_f64().map_or(OVal::Null, n));
            if alias.is_some() {
                b.put("fromLabel", s_or_null(sender));
            }
            b.done()
        })
        .collect();
    let new_cursor = if peek { cursor } else { st.advance_broadcast_cursor(&cursor_key, common::now_ms()).map_err(|e| Defer(format!("advance:{e}")))? as f64 };
    let mut out = Obj::default();
    out.put("ok", OVal::Bool(true))
        .put("action", s(defaults::text(if history { "mesh_write.action_mesh_history" } else { "mesh_write.action_mesh_read" })))
        .put("from", s(&from))
        .put("acked", OVal::Bool(!peek))
        .put("newCursor", n(new_cursor))
        .put("count", n(broadcasts.len() as f64))
        .put("broadcasts", OVal::Arr(broadcasts.clone()))
        .put("messages", OVal::Arr(broadcasts.clone()));
    if peek {
        out.put("peek", OVal::Bool(true));
    } else {
        out.put("hint", s(defaults::text("mesh_write.msg_mesh_read_hint")));
    }
    if explicit {
        out.put("since", n(since_seq));
    }
    if let Some(k) = last_n {
        out.put("last", n(k));
    }
    if broadcasts.len() != unseen_count {
        out.put("filteredOut", n((unseen_count - broadcasts.len()) as f64));
    }
    let effect = if peek { Effect::None } else { Effect::BroadcastCursor(cursor_key) };
    Ok(Answer { code: 0, stdout: format!("{}\n", out.done().stringify()), effect })
}
