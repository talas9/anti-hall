//! `devswarm.js inbox read-primary <id>`, ported from `scripts/devswarm-lib/inbox-cmd.js` (the dispatch), `inbox-read.js`
//! `cmdInboxMessagesInner` (the read) and `cursors.js` `writeReadReceipt`.
//!
//! The verb is a read that is not read-only: it files a read receipt (a new file under `read-receipts/<id>/`, named by a
//! fresh random id) that `inbox ack-primary --receipt` applies later. It also, in Node, promotes an `unclaimed:` session,
//! merges the mail of sibling partitions of a mesh group (with gap withholding and caps) and runs Jev triage on what it
//! prints.
//!
//! The engine answers the common single-partition read and nothing else. Everything else is a [`Defer`] decided BEFORE
//! the receipt is written, so Node then runs the verb and nothing is written twice:
//!
//! * a flag the engine does not read (a window, a limit, an ownership override, an immediate ack, `--with-broadcasts`);
//! * no descriptor, a descriptor whose session is the `unclaimed:` marker (Node would promote it), a registry row that is;
//! * a mesh group (a second registry row of the worktree), a caller that does not own the id (Node refuses), a project
//!   mismatch, a store that does not exist yet or is not the SQLite backend, a partition without its floor rows;
//! * a descriptor with an inbox but no readable inbox or cursor file (Node reports the count unknown), an inbox line
//!   whose fields JavaScript would stringify in its own way;
//! * more unread rows than one call returns (Node truncates per source), a forwarded row whose original hash Node derives;
//! * Jev triage possibly enabled while there is mail to label (Node labels it and records outcome tracking);
//! * no stable launcher on disk (the `ackCommand` names the path Node resolves), or an old receipt Node would prune.
//!
//! After the receipt file exists nothing defers. Its content, name format and the output are Node's: the parity test
//! compares them with the random id normalised, and the background Node check does the same on a scratch copy.
// Discard triage (E3): every `.ok()` / `unwrap_or*` in this file is a deliberate keep, for these reasons:
// - an unreadable optional file is the same as an absent one (Node's try/catch around readFileSync / statSync)
// - a value that is not the expected JSON type reads as absent where Node's `!= null` / typeof test does the same
use crate::checks::guardkit::ojson::OVal;
use crate::checks::jsport::num::to_js_string;
use crate::defaults;
use crate::meshw::args::Args;
use crate::meshw::common::{self, Inv, Obj, n, s};
use crate::meshw::ident::{self, R, defer};
use crate::meshw::idlock::{devswarm_root, is_safe_id};
use crate::meshw::send::{Answer, Effect, resolve_mesh_target};
use crate::meshw::{cursors, tick, union};
use serde_json::Value;
use std::path::{Path, PathBuf};

/// `{name}` placeholders replaced in one pass: a substituted value is never scanned again (a body that contains `{seq}`
/// stays as it is).
fn fill_once(template: &str, args: &[(&str, String)]) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let tail = &rest[open..];
        match args.iter().find(|(k, _)| tail.starts_with(&format!("{{{k}}}"))) {
            Some((k, v)) => {
                out.push_str(v);
                rest = &tail[k.len() + 2..];
            }
            None => {
                out.push('{');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// Base 36, lowercase (`Number.prototype.toString(36)` of a non-negative integer).
fn base36(mut v: u64) -> String {
    if v == 0 {
        return "0".into();
    }
    let mut digits = Vec::new();
    while v > 0 {
        digits.push(char::from_digit((v % 36) as u32, 36).unwrap_or('0'));
        v /= 36;
    }
    digits.iter().rev().collect()
}

/// `crypto.randomBytes(len).toString('hex')`.
fn random_hex(len: usize) -> Option<String> {
    use ring::rand::SecureRandom;
    let mut buf = vec![0u8; len];
    ring::rand::SystemRandom::new().fill(&mut buf).ok()?;
    Some(crate::meshw::store::hex(&buf))
}

/// A JSON value from a store row field.
fn jv(v: &Value) -> OVal {
    match v {
        Value::Null => OVal::Null,
        Value::Bool(b) => OVal::Bool(*b),
        Value::Number(x) => OVal::Num(x.as_f64().unwrap_or(f64::NAN)),
        Value::String(t) => OVal::Str(t.clone()),
        _ => OVal::Null,
    }
}

/// One row as the read prints it, with what the ack and the sort need.
struct Msg {
    fields: Obj,
    /// `Number.isFinite(row.ts) ? row.ts : Infinity` (the merge sort key).
    sort_ts: f64,
    /// The absolute store position when the row is a store row (the own-partition ack target).
    index: Option<f64>,
    hash: Option<String>,
}

/// A row of the store partition, in `listMessages`' key order (`origin` first in a union read).
fn store_msg(r: &Value, origin: bool) -> Msg {
    let mut o = Obj::default();
    if origin {
        o.put("origin", s(defaults::text("mesh_write.origin_store")));
    }
    for (k, src) in [
        ("index", "index"),
        ("seq", "seq"),
        ("ts", "ts"),
        ("hash", "hash"),
        ("body", "body"),
        ("sender", "sender"),
        ("recipient", "recipient"),
        ("mtype", "mtype"),
        ("urgency", "urgency"),
        ("isHeartbeat", "isHeartbeat"),
        ("needsReply", "needsReply"),
        ("origHash", "origHash"),
        ("instanceNonce", "instanceNonce"),
        ("storeSeq", "storeSeq"),
    ] {
        o.put(k, jv(&r[src]));
    }
    Msg {
        sort_ts: r["ts"].as_f64().filter(|t| t.is_finite()).unwrap_or(f64::INFINITY),
        index: r["index"].as_f64(),
        hash: r["hash"].as_str().map(str::to_string),
        fields: o,
    }
}

/// `String(v)` of a parsed JSON value where that is a plain scalar; objects and arrays stringify in JavaScript's own way.
fn js_string_of(v: &OVal) -> R<String> {
    match v {
        OVal::Str(t) => Ok(t.clone()),
        OVal::Num(x) => Ok(to_js_string(*x)),
        OVal::Bool(b) => Ok(b.to_string()),
        _ => defer("ndjson-field-shape"),
    }
}

/// A row of the NDJSON inbox (the union read): `JSON.parse(line)` read for its fields; a line that is not an object
/// reads as `{}`.
fn ndjson_msg(line: &str) -> R<Msg> {
    let parsed = OVal::parse(line);
    let p = match &parsed {
        Some(o @ OVal::Obj(_)) => Some(o),
        _ => None,
    };
    let field = |k: &str| p.and_then(|o| o.get(k)).filter(|v| !matches!(v, OVal::Null));
    let ts = match field(defaults::text("mesh_write.ndjson_created_field")) {
        Some(OVal::Num(x)) if x.is_finite() => Some(*x),
        _ => None,
    };
    let hash = match field(defaults::text("mesh_write.ndjson_hash_field")) {
        Some(v) => Some(js_string_of(v)?),
        None => None,
    };
    let body = match field(defaults::text("mesh_write.ndjson_message_field")) {
        Some(v) => js_string_of(v)?,
        None => String::new(),
    };
    let sender = match field(defaults::text("mesh_write.ndjson_from_field")) {
        Some(v) => Some(js_string_of(v)?),
        None => None,
    };
    let status = field(defaults::text("mesh_write.ndjson_status_field")).cloned().unwrap_or(OVal::Null);
    let mut o = Obj::default();
    o.put("origin", s(defaults::text("mesh_write.origin_ndjson")))
        .put("ts", ts.map_or(OVal::Null, n))
        .put("hash", common::s_or_null(hash.as_deref()))
        .put("body", OVal::Str(body))
        .put("sender", common::s_or_null(sender.as_deref()))
        .put("status", status);
    Ok(Msg { sort_ts: ts.unwrap_or(f64::INFINITY), index: None, hash, fields: o })
}

/// The per-row additions of the read, in Node's order: the forward marker, the instance digest, `from`/`text`/`kind`,
/// `bodyLength`. Returns the finished row and its body length.
fn finish(m: Msg) -> R<(OVal, f64)> {
    let mut o = m.fields;
    let get = |o: &Obj, k: &str| o.0.iter().find(|(x, _)| x == k).map(|(_, v)| v.clone());
    let text_of = |v: Option<OVal>| match v {
        Some(OVal::Str(t)) => Some(t),
        _ => None,
    };
    let orig = text_of(get(&o, "origHash")).filter(|t| !t.is_empty());
    let body = text_of(get(&o, "body"));
    if orig.is_some() {
        o.put("forwarded", OVal::Bool(true));
    } else if body.as_deref().is_some_and(|b| b.starts_with(defaults::text("mesh_write.forward_prefix"))) {
        // a legacy forward: Node derives the original's hash from the stripped body
        return defer("forwarded-row");
    }
    if let Some(nonce) = text_of(get(&o, "instanceNonce")).filter(|t| !t.is_empty()) {
        let short = cursors::short_nonce(&nonce);
        let sender = text_of(get(&o, "sender")).unwrap_or_default();
        o.put("instanceNonceShort", s(&short)).put("fromLine", OVal::Str(format!("{sender}@{short}")));
    }
    let sender = get(&o, "sender").filter(|v| !matches!(v, OVal::Null)).unwrap_or(OVal::Null);
    let broadcast = matches!(get(&o, "mtype"), Some(OVal::Str(t)) if t == defaults::text("mesh_write.mtype_broadcast"));
    let body_text = body.unwrap_or_default();
    let len = body_text.len() as f64;
    o.put("from", sender)
        .put("text", OVal::Str(body_text))
        .put("kind", s(if broadcast { defaults::text("mesh_write.mtype_broadcast") } else { defaults::text("mesh_write.mtype_direct") }))
        .put("bodyLength", n(len));
    Ok((o.done(), len))
}

/// The `--format text` rendering (`inboxReadPrimaryTextLines`) of the finished rows.
fn text_lines(rows: &[OVal]) -> String {
    if rows.is_empty() {
        return defaults::text("mesh_write.text_no_messages").to_string();
    }
    let seq_of = |m: &OVal| match m.get("storeSeq") {
        None => defaults::text("mesh_write.js_undefined").to_string(),
        Some(OVal::Num(x)) => to_js_string(*x),
        Some(OVal::Null) => defaults::text("mesh_write.js_null").to_string(),
        Some(_) => defaults::text("mesh_write.js_null").to_string(),
    };
    let str_of = |m: &OVal, k: &str| match m.get(k) {
        Some(OVal::Str(t)) => t.clone(),
        _ => String::new(),
    };
    rows.iter()
        .map(|m| fill_once(defaults::text("mesh_write.text_row"), &[("from", str_of(m, "sender")), ("seq", seq_of(m)), ("body", str_of(m, "body"))]))
        .collect::<Vec<_>>()
        .join(defaults::text("mesh_write.text_row_sep"))
}

/// `resolveStableCliPath(home, ...)`: the stable launcher when it is a file; else Node's fallback is the path of the
/// running script, which the engine cannot name, so that defers.
fn launcher_path(home: &Path) -> R<String> {
    let p = home
        .join(defaults::text("mesh_write.dir_anti_hall"))
        .join(defaults::text("mesh_write.launcher_dir"))
        .join(defaults::text("mesh_write.launcher_devswarm"));
    if std::fs::metadata(&p).is_ok_and(|m| m.is_file()) {
        return Ok(p.to_string_lossy().into_owned());
    }
    defer("no-launcher")
}

/// `writeReadReceipt` prunes receipts of the id older than the keep window as it writes: a pruning write is Node's.
fn nothing_to_prune(dir: &Path, now: i64) -> R<()> {
    let Ok(rd) = std::fs::read_dir(dir) else { return Ok(()) };
    let keep = defaults::num("mesh_write.receipt_keep_ms") as f64;
    let suffix = defaults::text("mesh_write.json_suffix");
    let prefix = defaults::text("mesh_write.receipt_id_prefix");
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let Some(stem) = name.strip_suffix(suffix) else { continue };
        let Some(rest) = stem.strip_prefix(prefix) else { continue };
        if rest.is_empty() || !rest.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()) {
            continue;
        }
        let Ok(modified) = e.metadata().and_then(|m| m.modified()) else { continue };
        let Ok(age) = modified.duration_since(std::time::UNIX_EPOCH) else { continue };
        if (now as f64) - age.as_secs_f64() * 1000.0 > keep {
            return defer("receipt-prune");
        }
    }
    Ok(())
}

/// The receipt record of `writeReadReceipt`, in Node's key order.
fn receipt_record(rid: &str, id: &str, reader: Option<&str>, now: i64, ops: Vec<OVal>, hashes: Vec<OVal>) -> OVal {
    let mut r = Obj::default();
    r.put("v", n(defaults::num("mesh_write.receipt_version") as f64))
        .put("receiptId", s(rid))
        .put("id", s(id))
        .put("reader", common::s_or_null(reader))
        .put("createdAt", n(now as f64))
        .put("ops", OVal::Arr(ops))
        .put("hashes", OVal::Arr(hashes))
        .put("ackedAt", OVal::Null);
    r.done()
}

/// Run `inbox read-primary <id>`.
pub fn run(inv: &Inv, a: &Args) -> R<Answer> {
    if a.is_help() {
        return defer("help");
    }
    if a.positionals.len() != 3 {
        return defer("argv-shape");
    }
    let Some(id) = a.positionals.get(2).map(String::as_str).filter(|i| is_safe_id(i)) else { return defer("bad-id") };
    let allowed = defaults::list("mesh_write.read_primary_flags");
    if a.flags.keys().any(|k| !allowed.contains(&k.as_str())) {
        return defer("flags");
    }
    let format_text = match a.flags.get(defaults::text("mesh_write.flag_format")) {
        None => false,
        Some(v) if v.len() == 1 && a.one(defaults::text("mesh_write.flag_format")) == Some(defaults::text("mesh_write.format_text")) => true,
        Some(_) => return defer("format"),
    };
    // `argv.includes('--json')` is a bare flag; a valued form (`--json=x`) is not it
    let json_flag = match a.flags.get(defaults::text("mesh_write.flag_json")) {
        None => false,
        Some(v) if v.iter().all(|x| *x == crate::meshw::args::FlagVal::True) => true,
        Some(_) => return defer("json-value"),
    };
    // ---- reads: everything that can defer happens before the receipt is written ----
    let Some(desc) = ident::read_descriptor(&inv.home, id) else { return defer("no-descriptor") };
    if !matches!(desc.get(defaults::text("mesh_write.field_id")), Some(OVal::Str(d)) if d == id) {
        return defer("descriptor-id");
    }
    // maybePromoteUnclaimed: a no-op unless the descriptor (or, once it holds a real session, the registry row) carries the marker
    let marker = format!("{}{id}", defaults::text("mesh_write.synthetic_session_prefix"));
    let desc_sid = match desc.get(defaults::text("mesh_write.field_session_id")) {
        None | Some(OVal::Null) => None,
        Some(OVal::Str(t)) => Some(t.clone()),
        Some(_) => return defer("descriptor-session"),
    };
    if desc_sid.as_deref() == Some(marker.as_str()) {
        return defer("unclaimed");
    }
    let inbox = union::path_field(&desc, defaults::text("mesh_write.field_inbox_path"))?;
    let cursor_file = union::path_field(&desc, defaults::text("mesh_write.field_cursor_path"))?;
    let o = tick::open_partition(inv, id, &desc)?;
    if desc_sid.as_deref().is_some_and(|t| !t.is_empty()) && o.rows.iter().find(|r| r.id == id).and_then(|r| r.session_id.as_deref()) == Some(marker.as_str()) {
        return defer("registry-unclaimed");
    }
    tick::single_partition(&o.rows, &desc, id)?;
    // the ownership gate of an acking read: the caller is the id, owns it by its registry row, or declared it
    let caller = ident::caller_identity_detailed(&inv.env, &inv.cwd)?;
    let own_entry = resolve_mesh_target(&o.rows, Some(caller.identity.as_str()))?;
    let owns =
        caller.identity == id || own_entry.as_ref().is_some_and(|e| e.id == id) || ident::declared_self_id(&inv.env, &inv.cwd, &o.rows)?.as_deref() == Some(id);
    if !owns {
        return defer("not-owner");
    }
    let (store_base, nd_base) = tick::read_bases(inv, &o.reader, id, cursor_file.as_deref())?;
    let total_store = o.reader.message_count(id).map_err(|e| ident::Defer(format!("store-read:{e}")))?;
    // `--limit N`: a finite positive number replaces the default cap (floored, at least 1); anything else is ignored
    let limit = a
        .one(defaults::text("mesh_write.flag_limit"))
        .map(crate::checks::guardkit::text::js_number_of_str)
        .filter(|x| x.is_finite() && *x > 0.0)
        .map_or(defaults::num("mesh_write.inbox_read_limit") as usize, |x| x.floor().max(1.0) as usize);
    let floor_pos = |x: f64| if x.is_finite() && x > 0.0 { x.floor() } else { 0.0 };
    let mut msgs: Vec<Msg> = Vec::new();
    let (unread_count, total_out);
    let mut union_cursors: Option<(f64, f64)> = None;
    let mut nd_op_target: Option<f64> = None;
    if let Some(inbox) = &inbox {
        let Some(cf) = &cursor_file else { return defer("no-cursor-path") };
        if union::non_empty_lines(inbox).is_none() || union::cursor_position(cf)?.is_none() {
            return defer("unknown-count");
        }
        let input = union::UnionIn { inbox: Some(inbox), cursor_file: Some(cf), id, store: Some(&o.reader), store_base, nd_base, now: inv.now };
        let u = union::union_unread(&input)?;
        let merged_total = union::merged_total(&input)?;
        for line in &u.nd_unread_lines {
            msgs.push(ndjson_msg(line)?);
        }
        for r in &u.store_only_unread {
            msgs.push(store_msg(r, true));
        }
        // Array#sort is stable and a non-finite `ts` sorts last (a pair of them compares equal)
        msgs.sort_by(
            |x, y| {
                if x.sort_ts == y.sort_ts { std::cmp::Ordering::Equal } else { x.sort_ts.partial_cmp(&y.sort_ts).unwrap_or(std::cmp::Ordering::Equal) }
            },
        );
        unread_count = u.unread as f64;
        total_out = merged_total as f64;
        let nd_cursor = floor_pos(nd_base);
        union_cursors = Some((nd_cursor, store_base));
        nd_op_target = Some(nd_cursor + u.nd_unread_lines.len() as f64);
    } else {
        o.reader
            .for_each_message(id, floor_pos(store_base) as u64, |m| {
                msgs.push(store_msg(&m, false));
                true
            })
            .map_err(|e| ident::Defer(format!("store-read:{e}")))?;
        unread_count = (total_store as f64 - store_base).max(0.0);
        total_out = total_store as f64;
    }
    if msgs.len() > limit {
        return defer("read-cap");
    }
    // the own-partition ack target: the highest store position actually delivered, never below the read base
    let max_index = msgs.iter().filter_map(|m| m.index).fold(None, |acc: Option<f64>, i| Some(acc.map_or(i, |a| a.max(i))));
    let own_target = max_index.map_or(store_base, |m| store_base.max(m));
    let delivered = msgs.len();
    let hashes: Vec<OVal> = msgs.iter().map(|m| common::s_or_null(m.hash.as_deref())).collect();
    let mut rows: Vec<OVal> = Vec::with_capacity(msgs.len());
    let mut body_bytes = 0.0;
    for m in msgs {
        let (row, len) = finish(m)?;
        body_bytes += len;
        rows.push(row);
    }
    if !rows.is_empty() && common::jev_maybe_enabled(inv) {
        return defer("jev");
    }
    let cli = launcher_path(&inv.home)?;
    let reader = cursors::reader_key(tick::reader_nonce_cached(&inv.home).as_deref());
    let dir = devswarm_root(&inv.home).join(defaults::text("mesh_write.dir_read_receipts")).join(id);
    nothing_to_prune(&dir, inv.now)?;
    // ---- the output (everything but the receipt id is known) ----
    let Some(rand) = random_hex(6) else { return defer("no-random") };
    let rid = format!("{}{}{rand}", defaults::text("mesh_write.receipt_id_prefix"), base36(inv.now.max(0) as u64));
    let mut ops = vec![{
        let mut op = Obj::default();
        op.put("k", s(defaults::text("mesh_write.op_own"))).put("partition", s(id)).put("target", n(own_target)).put("delivered", n(delivered as f64));
        op.done()
    }];
    if let (Some(target), Some(inbox), Some(cf)) = (nd_op_target, &inbox, &cursor_file) {
        let mut op = Obj::default();
        op.put("k", s(defaults::text("mesh_write.op_nd"))).put("partition", s(id)).put("target", n(target)).put("cursorPath", s(cf)).put("inboxPath", s(inbox));
        ops.push(op.done());
    }
    let store_path = union::store_dir(&inv.home, &o.repo_key);
    let mut out = Obj::default();
    out.put("ok", OVal::Bool(true))
        .put("action", s(defaults::text("mesh_write.action_read_primary")))
        .put("id", s(id))
        .put("repoKey", s(&o.repo_key))
        .put("storePath", OVal::Str(store_path.to_string_lossy().into_owned()))
        .put("cwd", s(&inv.cwd))
        .put("meshPartitionIds", OVal::Arr(vec![s(id)]))
        .put("unreadOnly", OVal::Bool(true))
        .put("unreadCount", n(unread_count))
        .put("cursor", n(store_base))
        .put("total", n(total_out))
        .put("count", n(rows.len() as f64))
        .put("messages", OVal::Arr(rows.clone()))
        .put("totalBodyBytes", n(body_bytes))
        .put("truncatedBodyHint", OVal::Str(fill_once(defaults::text("mesh_write.truncated_body_hint"), &[("id", id.to_string())])))
        .put("known", OVal::Bool(true))
        .put("storeUnavailable", OVal::Bool(false))
        .put("storeUnavailableReason", OVal::Null)
        .put("meshGroupUnresolved", OVal::Bool(false))
        .put("meshGroupError", OVal::Null)
        .put("totalsPartial", OVal::Bool(false));
    if let Some((nd, st)) = union_cursors {
        out.put("cursorNdjson", n(nd)).put("cursorStore", n(st));
    }
    out.put("acked", OVal::Bool(false))
        .put("readReceiptId", s(&rid))
        .put(
            "ackCommand",
            OVal::Str(fill_once(
                defaults::text("mesh_write.ack_command"),
                &[("cli", OVal::Str(cli).stringify()), ("id", id.to_string()), ("rid", rid.clone())],
            )),
        )
        .put("ackHint", s(defaults::text("mesh_write.ack_hint")));
    let stdout = if format_text && !json_flag { text_lines(&rows) } else { out.done().stringify() };
    // ---- the receipt: the only write ----
    let record = receipt_record(&rid, id, reader.as_deref(), inv.now, ops, hashes).stringify();
    let file: PathBuf = dir.join(format!("{rid}{}", defaults::text("mesh_write.json_suffix")));
    let mut tmp = file.as_os_str().to_os_string();
    tmp.push(defaults::text("mesh_write.tmp_suffix"));
    let tmp = PathBuf::from(tmp);
    let wrote = std::fs::create_dir_all(&dir).and_then(|()| std::fs::write(&tmp, &record)).and_then(|()| std::fs::rename(&tmp, &file));
    if wrote.is_err() {
        // Node reports the error text itself (`receiptError`): it runs the verb, and it fails the same way
        return defer("receipt-write");
    }
    crate::meshw::mark_committed();
    let rel = format!(
        "{}/{}/{}/{id}/{rid}{}",
        defaults::text("mesh_write.dir_anti_hall"),
        defaults::text("mesh_write.dir_devswarm"),
        defaults::text("mesh_write.dir_read_receipts"),
        defaults::text("mesh_write.json_suffix")
    );
    crate::meshw::note_written(&rel, record.as_bytes());
    Ok(Answer { code: 0, stdout: format!("{stdout}\n"), effect: Effect::None })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_substituted_value_is_not_scanned_again() {
        let out = fill_once("a {from} b {seq} c {body}", &[("from", "{seq}".into()), ("seq", "7".into()), ("body", "{from}".into())]);
        assert_eq!(out, "a {seq} b 7 c {from}");
    }

    #[test]
    fn an_unknown_placeholder_and_a_lone_brace_stay_as_written() {
        assert_eq!(fill_once("x {nope} { y", &[("id", "1".into())]), "x {nope} { y");
    }

    #[test]
    fn base36_matches_number_to_string_36() {
        assert_eq!(base36(0), "0");
        assert_eq!(base36(35), "z");
        assert_eq!(base36(36), "10");
        assert_eq!(base36(1_795_000_000_000), "mwm0nk74");
    }
}
