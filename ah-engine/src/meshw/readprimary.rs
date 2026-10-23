//! `devswarm.js inbox read-primary <id>`, ported from `scripts/devswarm-lib/inbox-cmd.js` (the dispatch), `inbox-read.js`
//! `cmdInboxMessagesInner` (the read) and `cursors.js` `writeReadReceipt`.
//!
//! The verb is a read that is not read-only: it files a read receipt (a new file under `read-receipts/<id>/`, named by a
//! fresh random id) that `inbox ack-primary --receipt` applies later. It also, in Node, promotes an `unclaimed:` session,
//! merges the mail of sibling partitions of a mesh group (with gap withholding and caps) and runs Jev triage on what it
//! prints.
//!
//! Every case Node answers is answered here, with Node's output and exit code; nothing is handed to Node (there is none). Where
//! Node would fail (a store that cannot be opened or read), the verb prints Node's refusal or its thrown exception, exit 2.
//! Jev triage is advisory and fail-open in Node; the engine has no triage port, so rows carry no `triage` and the unlabelled reads
//! are counted (`mesh_triage_skipped`).
//!
//! The receipt is written like Node writes it (`writeReadReceipt`): old receipts of the id are pruned after the write, a write that
//! fails is reported in the result (`receiptError`), and a promotion of an `unclaimed:` session follows `maybePromoteUnclaimed`
//! (fail-soft in full: whatever it cannot do is no promotion).
// Discard triage (E3): every `.ok()` / `unwrap_or*` in this file is a deliberate keep, for these reasons:
// - an unreadable optional file is the same as an absent one (Node's try/catch around readFileSync / statSync)
// - a value that is not the expected JSON type reads as absent where Node's `!= null` / typeof test does the same
use crate::checks::guardkit::ojson::OVal;
use crate::checks::guardkit::text::js_trim;
use crate::checks::jsport::num::to_js_string;
use crate::defaults;
use crate::meshw::args::Args;
use crate::meshw::common::{self, Inv, Obj, n, s};
use crate::meshw::ident::{self, R};
use crate::meshw::idlock::{devswarm_root, is_safe_id};
use crate::meshw::send::{Answer, Effect, resolve_mesh_target};
use crate::meshw::store::RegistryRow;
use crate::meshw::{cursors, meshgroup, tick, union};
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
    /// Sent by the reader's own identity family: counted out of the unread and left out of the list (the ack still walks it).
    own: bool,
    /// Where the row came from (`own`, `ndjson`, or `sibling:<partition>`) and its position in that source (the cap's bookkeeping).
    src: String,
    src_idx: usize,
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
        own: false,
        src: "own".to_string(),
        src_idx: 0,
    }
}

/// A store row as `listMessages` hands it to a caller (key order included).
pub(crate) fn store_row(r: &Value) -> OVal {
    store_msg(r, false).fields.done()
}

/// `String(v)` of a parsed JSON value (a non-null one: the fields are read after the `!= null` test).
fn js_string_of(v: &OVal) -> R<String> {
    Ok(crate::dssup::ingest::import::js_string(v))
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
    // the line's own resolved sender (pull stamps it), else its branch (a legacy line carries no sender)
    let sender = match field(defaults::text("mesh_write.ndjson_sender_field")).or_else(|| field(defaults::text("mesh_write.ndjson_from_field"))) {
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
    Ok(Msg { sort_ts: ts.unwrap_or(f64::INFINITY), index: None, hash, fields: o, own: false, src: "ndjson".to_string(), src_idx: 0 })
}

/// The per-row additions of the read, in Node's order: the forward marker, the instance digest, `from`/`text`/`kind`,
/// `bodyLength`. Returns the finished row and its body length.
fn finish(m: Msg, legacy_from: &dyn Fn(&str) -> Option<String>) -> R<(OVal, f64)> {
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
        // a legacy forward (no origHash): Node reconstructs the original's hash from the carried fields and the stripped body
        let scalar = |k: &str| match get(&o, k) {
            Some(OVal::Str(t)) => Value::String(t),
            Some(OVal::Num(x)) => serde_json::Number::from_f64(x).map_or(Value::Null, Value::Number),
            Some(OVal::Bool(b)) => Value::Bool(b),
            _ => Value::Null,
        };
        let row = serde_json::json!({"body": scalar("body"), "sender": scalar("sender"), "urgency": scalar("urgency"), "ts": scalar("ts"), "needsReply": scalar("needsReply")});
        if let Some(h) = meshgroup::forwarded_orig_hash_of(&row) {
            o.put("forwarded", OVal::Bool(true)).put("origHash", OVal::Str(h));
        }
    }
    if let Some(nonce) = text_of(get(&o, "instanceNonce")).filter(|t| !t.is_empty()) {
        let short = cursors::short_nonce(&nonce);
        let sender = text_of(get(&o, "sender")).unwrap_or_default();
        o.put("instanceNonceShort", s(&short)).put("fromLine", OVal::Str(format!("{sender}@{short}")));
    }
    // a legacy row with no sender: a `DONE: <branch> ...` notice is attributed from its branch at read time (nothing is rewritten)
    let sender = get(&o, "sender").filter(|v| !matches!(v, OVal::Null)).or_else(|| body.as_deref().and_then(legacy_from).map(OVal::Str)).unwrap_or(OVal::Null);
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

/// The command the `ackCommand` names: the engine shim (`devswarm_role.engine_cli`).
fn launcher_path(home: &Path) -> R<String> {
    Ok(crate::checks::devswarm_role::text::engine_cli(&home.to_string_lossy()))
}

/// `writeReadReceipt`'s housekeeping after a successful write: receipts of the id (`r[a-z0-9]+.json`, not the one just filed) older
/// than the keep window are removed; every failure is ignored, as Node's try/catch ignores it.
fn prune_receipts(dir: &Path, now: i64, own: &Path) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let keep = defaults::num("mesh_write.receipt_keep_ms") as f64;
    let suffix = defaults::text("mesh_write.json_suffix");
    let prefix = defaults::text("mesh_write.receipt_id_prefix");
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let Some(stem) = name.strip_suffix(suffix) else { continue };
        let Some(rest) = stem.strip_prefix(prefix) else { continue };
        if rest.is_empty() || !rest.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()) || e.path() == own {
            continue;
        }
        let Ok(modified) = e.metadata().and_then(|m| m.modified()) else { continue };
        let Ok(age) = modified.duration_since(std::time::UNIX_EPOCH) else { continue };
        if (now as f64) - age.as_secs_f64() * 1000.0 > keep {
            crate::discard::harmless(std::fs::remove_file(e.path()));
        }
    }
}

/// Node's `e.message` for a failed filesystem call: `CODE: description, syscall 'path'`.
fn js_io_error(e: &std::io::Error, syscall: &str, path: &Path) -> String {
    use std::io::ErrorKind as K;
    let name = match e.kind() {
        K::NotFound => "not_found",
        K::PermissionDenied => "permission_denied",
        K::AlreadyExists => "already_exists",
        K::NotADirectory => "not_a_directory",
        K::IsADirectory => "is_a_directory",
        K::ReadOnlyFilesystem => "read_only_filesystem",
        K::StorageFull => "storage_full",
        _ => return fill_once(defaults::text("mesh_write.msg_io_error_other"), &[("error", e.to_string()), ("syscall", syscall.to_string()), ("path", path.display().to_string())]),
    };
    let entry = defaults::raw("mesh_write.io_errors").get(name).and_then(|v| v.as_array()).unwrap_or_default();
    let text = |i: usize| entry.get(i).and_then(|v| v.as_str()).unwrap_or_default().to_string();
    fill_once(defaults::text("mesh_write.msg_io_error"), &[("code", text(0)), ("what", text(1)), ("syscall", syscall.to_string()), ("path", path.display().to_string())])
}

/// The result of a read whose receipt could not be written: Node reports `receiptError` and files no `ackCommand`.
fn without_receipt(result: OVal, error: &str, id: &str) -> OVal {
    let OVal::Obj(fields) = result else { return result };
    let mut out = Obj::default();
    for (k, v) in fields {
        match k.as_str() {
            "readReceiptId" => {
                out.put(&k, OVal::Null).put("receiptError", s(error));
            }
            "ackCommand" => {}
            "ackHint" => {
                out.put(&k, OVal::Str(fill_once(defaults::text("mesh_write.receipt_error_hint"), &[("error", error.to_string()), ("id", id.to_string())])));
            }
            _ => {
                out.put(&k, v);
            }
        }
    }
    out.done()
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

/// Record the project's summary file as it stands now (the witness compares it with Node's).
fn note_summary(inv: &Inv, repo_key: &str) {
    let rel = format!(
        "{}/{}/{}/{repo_key}{}",
        defaults::text("mesh_write.dir_anti_hall"),
        defaults::text("mesh_write.dir_devswarm"),
        defaults::text("mesh_write.dir_summaries"),
        defaults::text("mesh_write.json_suffix")
    );
    crate::meshw::set_written(&rel, &std::fs::read(inv.write_home.join(&rel)).unwrap_or_default());
}

/// A descriptor field as `nOrNull` reads it: nothing for an absent or null field, otherwise `String(x)`.
fn text_or_null(desc: &OVal, key: &str) -> Option<String> {
    match desc.get(key) {
        None | Some(OVal::Null) => None,
        Some(v) => Some(crate::dssup::ingest::import::js_string(v)),
    }
}

/// `writeDescriptorAtomic(home, id, desc)`: `JSON.stringify(desc)` to `<path>.tmp`, then a rename over the descriptor.
/// `false` when the write failed: Node's callers swallow the failure and carry on without promoting.
fn write_descriptor(inv: &Inv, id: &str, desc: &OVal) -> bool {
    let dir = devswarm_root(&inv.write_home).join(defaults::text("mesh_write.dir_workspaces"));
    let file = dir.join(format!("{id}{}", defaults::text("mesh_write.json_suffix")));
    let mut tmp = file.as_os_str().to_os_string();
    tmp.push(defaults::text("mesh_write.tmp_suffix"));
    let tmp = PathBuf::from(tmp);
    let text = desc.stringify();
    if std::fs::create_dir_all(&dir).and_then(|()| std::fs::write(&tmp, &text)).and_then(|()| std::fs::rename(&tmp, &file)).is_err() {
        crate::discard::harmless(std::fs::remove_file(&tmp)); // keep: our own temp
        return false;
    }
    let rel = format!(
        "{}/{}/{}/{id}{}",
        defaults::text("mesh_write.dir_anti_hall"),
        defaults::text("mesh_write.dir_devswarm"),
        defaults::text("mesh_write.dir_workspaces"),
        defaults::text("mesh_write.json_suffix")
    );
    crate::meshw::set_written(&rel, text.as_bytes());
    true
}

/// `String(d[key])` of a descriptor field, or `None` for an absent/null one.
fn str_field(d: &OVal, key: &str) -> Option<String> {
    text_or_null(d, key)
}

/// Whether a descriptor path field is JavaScript-truthy, with its text.
fn truthy_text(d: &OVal, key: &str) -> Option<String> {
    match d.get(key) {
        None | Some(OVal::Null | OVal::Bool(false)) => None,
        Some(OVal::Str(t)) => (!t.is_empty()).then(|| t.clone()),
        Some(OVal::Num(x)) if *x == 0.0 || x.is_nan() => None,
        Some(v) => Some(crate::dssup::ingest::import::js_string(v)),
    }
}

/// `String(d.id)` as `descs.find((d) => d && String(d.id) === target)` reads it (an absent id reads `undefined`).
fn id_text(d: &OVal) -> String {
    match d.get(defaults::text("mesh_write.field_id")) {
        None => defaults::text("mesh_write.js_undefined").to_string(),
        Some(v) => crate::dssup::ingest::import::js_string(v),
    }
}

/// `callerOwnsRow(home, id, ctx)`: the caller may speak for the row `id` when (1) `id` is its canonical identity, (2) its own
/// row and this one are cross-linked (one's session is the other's id), or (3) the row is the sole one registered for the
/// caller's worktree and is itself unclaimed. Node is fail-closed: any error is "not the caller's row", so is every lookup the
/// engine cannot complete.
fn caller_owns_row(inv: &Inv, id: &str) -> bool {
    owns_row(inv, id).unwrap_or(false)
}

fn owns_row(inv: &Inv, id: &str) -> R<bool> {
    let caller = ident::caller_identity_detailed(&inv.env, &inv.cwd)?.identity;
    if caller == id {
        return Ok(true);
    }
    // every descriptor of the home, as readDescriptors reads them (a file that is not a JSON object is skipped)
    let dir = devswarm_root(&inv.home).join(defaults::text("mesh_write.dir_workspaces"));
    let suffix = defaults::text("mesh_write.json_suffix");
    let mut descs: Vec<OVal> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            if !e.file_name().to_string_lossy().ends_with(suffix) {
                continue;
            }
            if let Some(d @ OVal::Obj(_)) = std::fs::read(e.path()).ok().and_then(|b| OVal::parse(&String::from_utf8_lossy(&b))) {
                descs.push(d);
            }
        }
    }
    let sess_key = defaults::text("mesh_write.field_session_id");
    let wt_key = defaults::text("mesh_write.field_worktree_path");
    let Some(target) = descs.iter().find(|d| id_text(d) == id) else { return Ok(false) };
    let caller_row = descs.iter().find(|d| id_text(d) == caller);
    let target_sess = str_field(target, sess_key);
    if let Some(c) = caller_row
        && crate::meshw::summary::cross_linked(&caller, str_field(c, sess_key).as_deref(), id, target_sess.as_deref())
    {
        return Ok(true);
    }
    // (3) the sole row for the caller's own worktree
    let wt = ident::resolve_caller_worktree(&inv.cwd)?.unwrap_or_else(|| inv.cwd.clone());
    let Some(target_wt) = truthy_text(target, wt_key) else { return Ok(false) };
    let Some(wt_mesh) = ident::canonical_mesh_id(&wt)? else { return Ok(false) };
    if ident::canonical_mesh_id(&target_wt)?.as_deref() != Some(wt_mesh.as_str()) {
        return Ok(false);
    }
    let mut same = 0;
    for d in &descs {
        if let Some(w) = truthy_text(d, wt_key)
            && ident::canonical_mesh_id(&w)?.as_deref() == Some(wt_mesh.as_str())
        {
            same += 1;
        }
    }
    if same != 1 {
        return Ok(false);
    }
    Ok(target_sess.as_deref().is_none_or(|t| t.is_empty() || t.starts_with(defaults::text("mesh_write.synthetic_session_prefix"))))
}

/// `deriveCallerSessionIdFromProcessTree(ctx)`: walk this process's parent chain (at most `max_ppid_hops` hops) for the first
/// process with a `~/.claude/sessions/<pid>.json` record whose `cwd` is the caller's own worktree and whose process is not
/// proven dead or reused; its session id. Fails closed: `None` when the chain ends first.
fn session_from_process_tree(inv: &Inv) -> Option<String> {
    use std::os::unix::fs::MetadataExt;
    let js = crate::dssup::ingest::import::js_string;
    let raw_cwd = if inv.cwd.is_empty() { std::env::current_dir().ok()?.to_string_lossy().into_owned() } else { inv.cwd.clone() };
    let caller_wt = ident::canonical_worktree_real_path(&raw_cwd).ok().flatten().unwrap_or(raw_cwd);
    let sessions = inv.home.join(defaults::text("mesh_write.claude_dir")).join(defaults::text("mesh_write.sessions_dir"));
    let mut pid = i64::from(std::process::id());
    let mut seen = std::collections::HashSet::new();
    for _ in 0..=defaults::num("mesh_write.max_ppid_hops") {
        if pid <= 0 || !seen.insert(pid) {
            return None;
        }
        let file = sessions.join(format!("{pid}{}", defaults::text("mesh_write.json_suffix")));
        let rec = ident::read_bounded(&file).ok().flatten().and_then(|b| OVal::parse(&String::from_utf8_lossy(&b)));
        if let Some(rec @ OVal::Obj(_)) = rec
            && let Some(sid) = rec.get("sessionId").filter(|v| !matches!(v, OVal::Null)).map(|v| js_trim(&js(v)).to_string())
            && let Some(cwd) = truthy_text(&rec, "cwd")
            && !sid.is_empty()
            && !sid.starts_with(defaults::text("mesh_write.synthetic_session_prefix"))
        {
            let rec_wt = ident::canonical_worktree_real_path(&cwd).ok().flatten().unwrap_or(cwd);
            if rec_wt == caller_wt {
                let since = std::fs::metadata(&file).ok().map(|m| m.mtime() as f64 * 1000.0 + m.mtime_nsec() as f64 / 1e6);
                let rec_pid = match rec.get("pid") {
                    Some(OVal::Num(x)) if x.fract() == 0.0 && *x > 0.0 => *x,
                    _ => pid as f64,
                };
                if crate::dssup::liveness::pid_is_alive(rec_pid, since) != Some(false) {
                    return Some(sid);
                }
            }
        }
        pid = i64::from(crate::procid::parent(u32::try_from(pid).ok()?)?);
        if pid <= 1 {
            return None;
        }
    }
    None
}

/// What [`promote_full`] did: `state` is [`promote`]'s answer; `registry_error` the message of a registry write that failed after
/// the descriptor was promoted (Node reports it as `promotion.registryWriteError`).
pub(crate) struct Promotion {
    pub state: Option<bool>,
    pub registry_error: Option<String>,
}

/// `maybePromoteUnclaimed` + `promoteUnclaimedSession` for the row being read. `Ok(None)`: nothing to do (the row is
/// claimed on both sides, or carries no session at all). `Ok(Some(promoted))`: the writes were made; `promoted` is the
/// classic promotion (descriptor and registry both carried the marker), which Node reports as `promotion` and logs.
pub(crate) fn promote(inv: &Inv, a: &Args, desc: &OVal, desc_sid: Option<&str>, registry_sid: Option<&str>, marker: &str, repo_key: &str) -> R<Option<bool>> {
    let id = desc.get(defaults::text("mesh_write.field_id")).and_then(|v| if let OVal::Str(i) = v { Some(i.as_str()) } else { None }).unwrap_or_default();
    Ok(promote_full(inv, a, id, desc, desc_sid, registry_sid, marker, repo_key).state)
}

/// [`promote`] with the registry write error. Node's `maybePromoteUnclaimed` is fail-soft in full (every error is "no promotion"),
/// and so is this: it never defers.
#[allow(clippy::too_many_arguments)]
pub(crate) fn promote_full(inv: &Inv, a: &Args, id: &str, desc: &OVal, desc_sid: Option<&str>, registry_sid: Option<&str>, marker: &str, repo_key: &str) -> Promotion {
    let none = || Promotion { state: None, registry_error: None };
    let reg_real = registry_sid.filter(|r| !r.is_empty() && *r != marker);
    let desc_marked = desc_sid == Some(marker);
    let desc_real = desc_sid.filter(|d| !d.is_empty() && *d != marker);
    let case_c = desc_marked && reg_real.is_none();
    let case_b = desc_marked && reg_real.is_some();
    let case_a = desc_real.is_some() && registry_sid == Some(marker);
    if !(case_a || case_b || case_c) {
        return none();
    }
    // a reconcile sweep drain is not the row's session
    if inv.env.get(defaults::text("devswarm_cli.env_reconcile_sweep")).map(String::as_str) == Some(defaults::text("mesh_write.env_on_value")) {
        return none();
    }
    // realSessionIdFrom: `--session` wins over the environment; a blank value falls through to it; with neither, the process tree
    let flag = a.one(defaults::text("mesh_write.flag_session")).filter(|v| !v.is_empty());
    let env = inv.env.get(defaults::text("mesh_write.env_session_id")).map(String::as_str).filter(|v| !v.is_empty());
    let sid = match flag.or(env) {
        Some(raw) => js_trim(raw).to_string(),
        None => session_from_process_tree(inv).unwrap_or_default(),
    };
    if sid.is_empty() || sid == id || sid.starts_with(defaults::text("mesh_write.synthetic_session_prefix")) || !is_safe_id(id) {
        return none();
    }
    if !caller_owns_row(inv, id) {
        return none();
    }
    // Object.assign({}, desc, { sessionId }): an own `__proto__` key is not copied through (it sets the prototype), so the
    // descriptor written back has none
    let mut next = desc.clone();
    if let OVal::Obj(f) = &mut next {
        f.retain(|(k, _)| k != "__proto__");
    }
    let session_key = defaults::text("mesh_write.field_session_id");
    if case_c {
        next.set(session_key, OVal::Str(sid.clone()));
    } else if let Some(r) = reg_real.filter(|_| case_b) {
        next.set(session_key, OVal::Str(r.to_string()));
    }
    if case_b {
        if write_descriptor(inv, id, &next) {
            crate::meshw::mark_committed();
        }
        return none();
    }
    if case_c {
        if !write_descriptor(inv, id, &next) {
            return none();
        }
        crate::meshw::mark_committed();
    }
    // upsertStoreRegistry(home, next, ctx, { allowPathChange: true }) + deriveSummary, under the descriptor's own store key
    let registry = (|| -> Result<(), String> {
        let key = match next.get(defaults::text("mesh_write.field_owner_key")) {
            None | Some(OVal::Null | OVal::Bool(false)) => repo_key.to_string(),
            Some(OVal::Str(k)) if k.is_empty() => repo_key.to_string(),
            Some(OVal::Str(k)) => k.clone(),
            Some(_) => return Err(defaults::text("mesh_write.msg_promote_owner_key").to_string()),
        };
        let nudge = match next.get("nudgeCommand") {
            None | Some(OVal::Null) => None,
            Some(v) => Some(v.stringify()),
        };
        let row = RegistryRow {
            id: id.to_string(),
            worktree_path: text_or_null(&next, defaults::text("mesh_write.field_worktree_path")),
            session_id: text_or_null(&next, session_key),
            inbox_path: text_or_null(&next, defaults::text("mesh_write.field_inbox_path")),
            cursor_path: text_or_null(&next, defaults::text("mesh_write.field_cursor_path")),
            nudge_command: nudge,
        };
        let st = common::open_store(inv, &key).map_err(|d| fill_once(defaults::text("mesh_write.msg_promote_store"), &[("reason", d.0)]))?;
        st.upsert_registry(&row, inv.now, |_, _| true).map_err(|e| e.to_string())?;
        crate::meshw::mark_committed();
        if let Some(why) = crate::meshw::summary::derive_after_write(&st, inv, &key) {
            crate::meshw::log_summary_failure(defaults::text("mesh_write.verb_inbox"), &why);
        }
        let rel = format!(
            "{}/{}/{}/{key}{}",
            defaults::text("mesh_write.dir_anti_hall"),
            defaults::text("mesh_write.dir_devswarm"),
            defaults::text("mesh_write.dir_summaries"),
            defaults::text("mesh_write.json_suffix")
        );
        crate::meshw::set_written(&rel, &std::fs::read(inv.write_home.join(&rel)).unwrap_or_default());
        Ok(())
    })();
    let mut registry_error = None;
    if let Err(msg) = registry {
        if case_c {
            // R22 P2: descriptor promoted, registry retries on the next call; the failure is reported, never fatal
            eprintln!("{}", fill_once(defaults::text("mesh_write.msg_promote_registry_stderr"), &[("id", id.to_string()), ("error", msg.clone())]));
            registry_error = Some(msg);
        }
        // the divergence repair of a promoted descriptor retries silently
    }
    if case_c {
        let msg = fill_once(defaults::text("devswarm_cli.msg_promoted"), &[("id", id.to_string()), ("marker", marker.to_string())]);
        crate::meshw::clog::event(inv, defaults::text("devswarm_cli.op_promoted"), &msg, vec![("id", s(id)), ("to", s(&sid))]);
    }
    Promotion { state: Some(case_c), registry_error }
}

/// Whether `main()` renders the result as text: `--format=text` or `--format text` (the first `--format` word), and no `--json`.
fn text_requested(raw: &[String]) -> bool {
    let flag = defaults::text("mesh_write.flag_format");
    let dashed = format!("--{flag}");
    let text = defaults::text("mesh_write.format_text");
    let is_text = raw.iter().any(|w| *w == format!("{dashed}={text}"))
        || raw.iter().position(|w| *w == dashed).is_some_and(|i| raw.get(i + 1).map(String::as_str) == Some(text));
    is_text && !raw.iter().any(|w| *w == format!("--{}", defaults::text("mesh_write.flag_json")))
}

/// `--since` / `--tail` on `inbox read-primary`: Node refuses them before it opens a store (`inboxWindowRejection`), prints
/// the refusal (exit 2) and logs it to the central log. `None` when neither flag carries a value.
pub(crate) fn window_refusal(inv: &Inv, a: &Args, id: &str, sub: &str) -> R<Option<Answer>> {
    let used: Vec<&str> = defaults::list("devswarm_cli.window_flags").into_iter().filter(|f| a.one(f).is_some()).collect();
    if used.is_empty() {
        return Ok(None);
    }
    // only the verbs the dispatcher wires to `logVerbOutcome` log their refusal
    let logged = defaults::list("devswarm_cli.window_logged_subs").contains(&sub);
    if logged {
        crate::meshw::clog::ready(inv)?;
    }
    let repo_key = if logged { ident::resolve_context(&inv.cwd, true)?.repo_key } else { None };
    let verb_owned = format!("{}{sub}", defaults::text("devswarm_cli.window_verb_prefix"));
    let verb = verb_owned.as_str();
    let use_flags = used.iter().map(|f| fill_once(defaults::text("devswarm_cli.window_use_flag"), &[("flag", (*f).to_string())])).collect::<Vec<_>>().join(" ");
    let msg = fill_once(defaults::text("devswarm_cli.msg_window_refused"), &[("flags", used.join("/--")), ("verb", verb.to_string()), ("use", use_flags)]);
    let reason = defaults::text("devswarm_cli.window_reason");
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(false))
        .put("error", s(&msg))
        .put("reason", s(reason))
        .put("flags", OVal::Arr(used.iter().map(|f| s(f)).collect()))
        .put("verb", s(verb));
    let stdout = if sub == defaults::text("mesh_write.verb_read_primary") && text_requested(&a.raw) { format!("{}{msg}", defaults::text("devswarm_cli.window_text_prefix")) } else { o.done().stringify() };
    if logged {
        crate::meshw::clog::refusal(inv, &format!("{}{sub}", defaults::text("devswarm_cli.window_op_prefix")), repo_key.as_deref(), Some(id), &msg, Some(reason));
    }
    crate::meshw::mark_committed();
    Ok(Some(Answer { code: 2, stdout: format!("{stdout}\n"), effect: Effect::None }))
}

/// `read-primary` of an id that has no descriptor, by a caller that does not own it: Node's `unregistered-workspace` (or the caller-
/// shaped) refusal, exit 2, logged. `None` when this is not that case (the id has a descriptor, a flag or a shape the port does not
/// answer): the read goes on and defers what it cannot do. A case that needs a redirect, a resolved other id or the empty partition of
/// the caller's own id is Node's.
fn unowned_refusal(inv: &Inv, a: &Args, id: &str) -> R<Option<Answer>> {
    if a.is_help() || a.positionals.len() != 3 || ident::read_descriptor(&inv.home, id).is_some() || a.has(defaults::text("mesh_write.flag_ack_as_owner")) {
        return Ok(None);
    }
    if text_requested(&a.raw) {
        return Ok(None);
    }
    // outside any project the refusals below have no store to consult: the read itself settles that case
    let Some(repo_key) = ident::resolve_context(&inv.cwd, true)?.repo_key else { return Ok(None) };
    let reader = tick::open_reader_creating(inv, &repo_key)?;
    let rows = ident::rows_of(&reader.roster().map_err(|e| store_err("registry", e))?);
    if rows.iter().any(|r| r.id == id) {
        return Ok(None); // registered without a descriptor: the read below decides
    }
    let caller = ident::caller_identity_detailed(&inv.env, &inv.cwd)?;
    let own_entry = resolve_mesh_target(inv, Some(&reader), &rows, Some(caller.identity.as_str()))?;
    let owns = caller.identity == id || own_entry.as_ref().is_some_and(|e| e.id == id) || ident::declared_self_id(&inv.env, &inv.cwd, &rows)?.as_deref() == Some(id);
    if owns {
        return Ok(None); // the caller's own id, not registered yet: an empty partition, read by the plan below
    }
    let has_messages = reader.message_count(id).map_err(|e| store_err("store-read", e))? > 0;
    Ok(Some(ownership_refusal(inv, acking_action(a), &repo_key, id, &caller, own_entry.is_some(), !has_messages, has_messages)?))
}

/// Node's ownership refusal of an acking read (`read-primary <id> refused (<cause>)`, exit 2, logged): the cause names the leg that
/// failed, or `unregistered-workspace` when the id has nothing at all behind it (`unbacked`).
fn ownership_refusal(inv: &Inv, action: &str, repo_key: &str, id: &str, caller: &ident::Caller, caller_registered: bool, unbacked: bool, _has_messages: bool) -> R<Answer> {
    let cause = if unbacked {
        defaults::text("devswarm_cli.cause_unregistered_workspace")
    } else if caller.kind == defaults::text("mesh_write.kind_unresolvable") {
        defaults::text("devswarm_cli.cause_unresolvable_caller")
    } else if !caller_registered {
        defaults::text("devswarm_cli.cause_caller_not_registered")
    } else {
        defaults::text("devswarm_cli.cause_ownership_mismatch")
    };
    let verb = action;
    let msg = fill_once(defaults::text("devswarm_cli.msg_read_primary_refused"), &[("verb", verb.to_string()), ("cause", cause.to_string()), ("id", format!("\"{id}\"")), ("rid", id.to_string())]);
    let store_path = union::store_dir(&inv.home, repo_key);
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(false))
        .put("reason", s(cause))
        .put("error", s(&msg))
        .put("id", s(id))
        .put("callerIdentity", s(&caller.identity))
        .put("identity", Obj(vec![("id".into(), s(&caller.identity)), ("kind".into(), s(&caller.kind))]).done())
        .put("repoKey", s(repo_key))
        .put("storePath", OVal::Str(store_path.to_string_lossy().into_owned()))
        .put("cwd", s(&inv.cwd))
        .put("meshPartitionIds", OVal::Arr(vec![s(id)]))
        .put("known", OVal::Bool(false))
        .put("storeUnavailable", OVal::Bool(false))
        .put("storeUnavailableReason", OVal::Null)
        .put("meshGroupUnresolved", OVal::Bool(false))
        .put("meshGroupError", OVal::Null)
        .put("totalsPartial", OVal::Bool(true));
    crate::meshw::clog::ready(inv)?;
    crate::meshw::clog::refusal(inv, defaults::text("devswarm_cli.window_op_read_primary"), Some(repo_key), Some(id), &msg, Some(cause));
    crate::meshw::mark_committed();
    Ok(Answer { code: 2, stdout: format!("{}\n", o.done().stringify()), effect: Effect::None })
}

/// `peek-primary` of an id nothing knows (no descriptor, no registry row, no messages): the existence guard of the non-acking read
/// refuses it, exit 2, logged. (An acking read has no such guard: it opens the caller's own empty partition.) `None` when the id is
/// known in any way or the shape is one the port does not answer.
fn peek_refusal(inv: &Inv, a: &Args, id: &str, peek: bool) -> R<Option<Answer>> {
    if a.is_help() || a.positionals.len() != 3 || ident::read_descriptor(&inv.home, id).is_some() {
        return Ok(None);
    }
    // outside any project the guard has no store to consult: the read itself settles that case
    let Some(repo_key) = ident::resolve_context(&inv.cwd, true)?.repo_key else { return Ok(None) };
    let reader = tick::open_reader_creating(inv, &repo_key)?;
    let rows = ident::rows_of(&reader.roster().map_err(|e| store_err("registry", e))?);
    if rows.iter().any(|r| r.id == id || r.id.starts_with(id)) || reader.message_count(id).map_err(|e| store_err("store-read", e))? > 0 {
        return Ok(None);
    }
    let cause = defaults::text("mesh_write.reason_unregistered");
    let msg = defaults::render("mesh_write.msg_unregistered", &[("id", &OVal::Str(id.to_string()).stringify())]);
    let mut o = Obj::default();
    o.put("repoKey", s(&repo_key))
        .put("storePath", OVal::Null)
        .put("cwd", s(&inv.cwd))
        .put("meshPartitionIds", OVal::Arr(vec![s(id)]))
        .put("known", OVal::Bool(false))
        .put("storeUnavailable", OVal::Bool(false))
        .put("storeUnavailableReason", OVal::Null)
        .put("meshGroupUnresolved", OVal::Bool(false))
        .put("meshGroupError", OVal::Null)
        .put("totalsPartial", OVal::Bool(true))
        .put("reason", s(cause))
        .put("ok", OVal::Bool(false))
        .put("id", s(id))
        .put("error", s(&msg));
    crate::meshw::clog::ready(inv)?;
    let verb = read_sub(a, peek);
    crate::meshw::clog::refusal(inv, &format!("{}{verb}", defaults::text("devswarm_cli.window_op_prefix")), Some(&repo_key), Some(id), &msg, Some(cause));
    crate::meshw::mark_committed();
    Ok(Some(Answer { code: 2, stdout: format!("{}\n", o.done().stringify()), effect: Effect::None }))
}

/// What the sibling partitions of a mesh group added to a read.
#[derive(Default)]
struct Siblings {
    parts: Vec<SiblingPart>,
    /// `messageCount` of every sibling, added to the total.
    added_total: f64,
    /// Rows delivered from siblings.
    added_unread: usize,
    /// Delivered sibling rows the reader's own family sent (dropped from the list, so out of the unread too).
    own_dropped: usize,
    gap_withheld: usize,
    never_read_withheld: usize,
    never_read_ids: Vec<String>,
}

/// One sibling partition as the ack needs it.
struct SiblingPart {
    id: String,
    cursor: f64,
    since: f64,
    delivered_count: usize,
    consumed_through: Vec<f64>,
    consumed_count: f64,
}

/// The row a [`Msg`] prints, as plain JSON (for the duplicate check).
fn msg_value(m: &Msg) -> Value {
    serde_json::from_str(&Obj(m.fields.0.clone()).done().stringify()).unwrap_or(Value::Null)
}

/// The unread rows of the sibling partitions of the group (`cmdInboxMessagesInner`'s mesh widening for an acking read): each from its
/// read position (the further of its base and the watermark the caller left), at most the never-read cap per partition, rows already
/// delivered elsewhere in the group left out, the rest merged into `msgs` by time. A history view (`unread_only` false) reads each
/// partition whole, with no cap; an unread view that does not ack (`prefix_cap` false: a peek) keeps the newest rows of a partition over
/// the cap, since nothing it writes could move the read position past a prefix.
#[allow(clippy::too_many_arguments)]
fn read_siblings(inv: &Inv, o: &tick::Opened, group: &meshgroup::Group, id: &str, store_base: f64, msgs: &mut Vec<Msg>, unread_only: bool, prefix_cap: bool) -> R<Siblings> {
    let floor_pos = |x: f64| if x.is_finite() && x > 0.0 { x.floor() } else { 0.0 };
    let family = tick::family_of(id, &o.rows);
    let cap = defaults::num("mesh_write.never_read_sibling_cap") as usize;
    let mut out = Siblings::default();
    let mut fetched: Vec<(SiblingPart, Vec<Value>)> = Vec::new();
    for pid in group.ids.iter().filter(|p| p.as_str() != id) {
        let cursor = meshgroup::base_cursor(inv, &o.reader, pid)?;
        let since = cursor.max(meshgroup::seen_cursor(inv, id, pid));
        let total = o.reader.message_count(pid).map_err(|e| store_err("store-read", e))?;
        let mut rows: Vec<Value> = Vec::new();
        o.reader
            .for_each_message(pid, if unread_only { floor_pos(since) as u64 } else { 0 }, |m| {
                rows.push(m);
                true
            })
            .map_err(|e| store_err("store-read", e))?;
        if unread_only && rows.len() > cap {
            out.never_read_withheld += rows.len() - cap;
            out.never_read_ids.push(pid.clone());
            if prefix_cap {
                rows.truncate(cap); // a structural prefix: the ack advances exactly this far
            } else {
                rows.drain(..rows.len() - cap); // nothing is acked: the newest rows are the ones a reader needs
            }
        }
        out.added_total += total as f64;
        fetched.push((SiblingPart { id: pid.clone(), cursor, since, delivered_count: 0, consumed_through: Vec::new(), consumed_count: 0.0 }, rows));
    }
    if fetched.is_empty() {
        return Ok(out);
    }
    let mut dedup = meshgroup::Dedup::seed(&o.reader, id, store_base)?;
    for m in msgs.iter() {
        dedup.note_shown(&msg_value(m));
    }
    let mut added: Vec<Msg> = Vec::new();
    for (mut part, rows) in fetched {
        let folded = dedup.fold(inv, rows);
        out.gap_withheld += folded.gap_withheld;
        part.delivered_count = folded.delivered.len();
        part.consumed_through = folded.consumed_through.clone();
        part.consumed_count = folded.consumed_count;
        for (row, pos) in folded.delivered.iter().zip(&folded.delivered_idx) {
            let base = store_msg(row, false);
            let mut fields = Obj::default();
            fields.put("partitionId", s(&part.id));
            for (k, v) in &base.fields.0 {
                fields.put(k, v.clone());
            }
            let mut m = Msg { fields, ..base };
            m.own = row["sender"].as_str().is_some_and(|f| family.contains(f));
            m.src = format!("sibling:{}", part.id);
            m.src_idx = *pos;
            if m.own && unread_only {
                out.own_dropped += 1;
            }
            added.push(m);
        }
        out.parts.push(part);
    }
    out.added_unread = added.len();
    if !added.is_empty() {
        msgs.extend(added);
        // Array#sort is stable and a non-finite `ts` sorts last
        msgs.sort_by(|x, y| if x.sort_ts == y.sort_ts { std::cmp::Ordering::Equal } else { x.sort_ts.partial_cmp(&y.sort_ts).unwrap_or(std::cmp::Ordering::Equal) });
    }
    Ok(out)
}

/// What a read withheld, reported in the result so a caller never mistakes a partial read for a whole one: forwardable sibling rows behind
/// a gap, rows over a sibling's never-read cap, the history window (`window` is `(the window, withheld, undated, index per partition)`),
/// and the rows over the per-source cap.
fn put_withheld(out: &mut Obj, sibs: &Siblings, truncated_count: usize, limit: usize, window: Option<(&Window, usize, usize, bool)>) {
    if sibs.gap_withheld > 0 {
        out.put("meshGapWithheld", OVal::Bool(true)).put("meshGapWithheldCount", n(sibs.gap_withheld as f64));
    }
    if sibs.never_read_withheld > 0 {
        let mut names: Vec<String> = Vec::new();
        for x in &sibs.never_read_ids {
            if !names.contains(x) {
                names.push(x.clone());
            }
        }
        let reads = names.iter().map(|p| fill_once(defaults::text("mesh_write.mesh_never_read_read_cmd"), &[("pid", p.clone())])).collect::<Vec<_>>().join(defaults::text("mesh_write.mesh_never_read_read_sep"));
        let cap = defaults::num("mesh_write.never_read_sibling_cap");
        out.put("meshNeverReadCapped", OVal::Bool(true))
            .put("meshNeverReadWithheldCount", n(sibs.never_read_withheld as f64))
            .put("meshNeverReadCapLimit", n(cap as f64))
            .put(
                "neverReadCapHint",
                OVal::Str(fill_once(
                    defaults::text("mesh_write.mesh_never_read_hint"),
                    &[("withheld", sibs.never_read_withheld.to_string()), ("n", names.len().to_string()), ("cap", cap.to_string()), ("reads", reads)],
                )),
            );
    }
    if let Some((w, withheld, undated, per_partition)) = window.filter(|(w, ..)| w.since.is_some() || w.tail.is_some()) {
        let mut o = Obj::default();
        o.put(
            "since",
            match &w.since {
                Some(Since::Ts(x)) => Obj(vec![("kind".into(), s(defaults::text("mesh_write.since_kind_ts"))), ("value".into(), n(*x))]).done(),
                Some(Since::Index(x)) => Obj(vec![("kind".into(), s(defaults::text("mesh_write.since_kind_index"))), ("value".into(), n(*x))]).done(),
                None => OVal::Null,
            },
        )
        .put("tail", w.tail.map_or(OVal::Null, |t| n(t as f64)))
        .put("withheld", n(withheld as f64));
        if undated > 0 {
            o.put("undatedKept", n(undated as f64));
        }
        if matches!(w.since, Some(Since::Index(_))) && per_partition {
            o.put("indexIsPerPartition", OVal::Bool(true));
        }
        out.put("window", o.done());
    }
    if truncated_count > 0 {
        out.put("truncated", OVal::Bool(true)).put("truncatedCount", n(truncated_count as f64)).put("limit", n(limit as f64)).put(
            "truncatedHint",
            OVal::Str(fill_once(defaults::text("mesh_write.truncated_hint"), &[("count", truncated_count.to_string()), ("limit", limit.to_string())])),
        );
    }
}

/// `--since` of the history view: an index (a per-partition message position) or a time.
enum Since {
    Ts(f64),
    Index(f64),
}

/// `--since` / `--tail` of the history view.
#[derive(Default)]
struct Window {
    since: Option<Since>,
    tail: Option<usize>,
}

/// `parseInboxSince`: digits are an index; anything else is a date (`Date.parse`: the ISO forms the host writes, and a bare date, which
/// JavaScript reads as UTC midnight); text no date reading accepts is `None`.
fn parse_since(raw: &str) -> Option<Since> {
    let t = js_trim(raw);
    if t.is_empty() {
        return None;
    }
    if t.bytes().all(|b| b.is_ascii_digit()) {
        return t.parse::<f64>().ok().filter(|x| x.is_finite()).map(|x| Since::Index(x.floor()));
    }
    let date_only = t.len() == 10 && t.as_bytes().get(4) == Some(&b'-') && t.as_bytes().get(7) == Some(&b'-');
    let text = if date_only { format!("{t}T00:00:00Z") } else { t.to_string() };
    match crate::checks::guardkit::jsval::date_parse(&text) {
        crate::checks::guardkit::jsval::DateParse::Ms(x) => Some(Since::Ts(x)),
        _ => None,
    }
}

/// The window flags of `inbox messages`, or the verb's refusal (`bad-tail`, `bad-since`; exit 2).
fn history_window(a: &Args) -> R<Result<Window, Answer>> {
    let refuse = |reason: &str, error: String| {
        let mut o = Obj::default();
        o.put("ok", OVal::Bool(false)).put("error", OVal::Str(error)).put("reason", s(reason));
        Answer { code: 2, stdout: format!("{}\n", o.done().stringify()), effect: Effect::None }
    };
    let mut w = Window::default();
    if let Some(raw) = a.one(defaults::text("mesh_write.flag_tail")) {
        let x = crate::checks::guardkit::text::js_number_of_str(raw);
        if !x.is_finite() || x < 1.0 {
            return Ok(Err(refuse(defaults::text("mesh_write.reason_bad_tail"), fill_once(defaults::text("mesh_write.msg_bad_tail"), &[("got", OVal::Str(raw.to_string()).stringify())]))));
        }
        w.tail = Some(x.floor().max(1.0) as usize);
    }
    if let Some(raw) = a.one(defaults::text("mesh_write.flag_since")) {
        match parse_since(raw) {
            Some(since) => w.since = Some(since),
            None => {
                return Ok(Err(refuse(defaults::text("mesh_write.reason_bad_since"), fill_once(defaults::text("mesh_write.msg_bad_since"), &[("got", OVal::Str(raw.to_string()).stringify())]))));
            }
        }
    }
    Ok(Ok(w))
}

/// `--tail N` once the per-source cap has withheld rows (exit 2): refused rather than guessed.
fn tail_under_truncation(id: &str, truncated_count: usize, limit: usize, tail: usize) -> Answer {
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(false))
        .put("action", s(defaults::text("mesh_write.verb_messages")))
        .put("id", s(id))
        .put("reason", s(defaults::text("mesh_write.reason_tail_under_truncation")))
        .put("truncated", OVal::Bool(true))
        .put("truncatedCount", n(truncated_count as f64))
        .put("limit", n(limit as f64))
        .put("requestedTail", n(tail as f64))
        .put(
            "error",
            OVal::Str(fill_once(
                defaults::text("mesh_write.msg_tail_under_truncation"),
                &[("tail", tail.to_string()), ("limit", limit.to_string()), ("count", truncated_count.to_string())],
            )),
        )
        .put("hint", OVal::Str(fill_once(defaults::text("mesh_write.msg_tail_under_truncation_hint"), &[("limit", limit.to_string())])));
    Answer { code: 2, stdout: format!("{}\n", o.done().stringify()), effect: Effect::None }
}

/// `resolveWorkspaceStoreForRead` refused the read, or the store cannot be used: Node's refusal of the read verbs (exit 2) with the
/// read-side fields, logged, and the stderr line that names the reason.
fn unavailable_refusal(inv: &Inv, a: &Args, id: &str, peek: bool, why: &tick::Unavail) -> R<Answer> {
    let repo_key = ident::resolve_context(&inv.cwd, true)?.repo_key;
    let mut o = Obj::default();
    let genuine = why.reason == defaults::text("mesh_write.reason_store_unavailable");
    o.put("repoKey", common::s_or_null(repo_key.as_deref()))
        .put("storePath", OVal::Null)
        .put("cwd", s(&inv.cwd))
        .put("meshPartitionIds", OVal::Arr(vec![s(id)]))
        .put("known", OVal::Bool(false))
        .put("storeUnavailable", OVal::Bool(genuine))
        .put("storeUnavailableReason", OVal::Null)
        .put("meshGroupUnresolved", OVal::Bool(false))
        .put("meshGroupError", OVal::Null)
        .put("totalsPartial", OVal::Bool(true))
        .put("reason", s(&why.reason))
        .put("ok", OVal::Bool(false))
        .put("id", s(id));
    if genuine {
        o.put("storeUnavailableReason", common::s_or_null(why.code.as_deref()));
    }
    // the fields the open adds come before its error text, as devswarm.js's refusal object lists them
    if let Some(r) = &why.registered {
        o.put("registeredRepoKey", s(r));
    }
    if why.registered.is_some() || why.caller.is_some() {
        o.put("callerRepoKey", common::s_or_null(why.caller.as_deref()));
    }
    o.put("error", common::s_or_null(why.error.as_deref()));
    let result = o.done();
    let msg = why.error.clone().unwrap_or_default();
    crate::meshw::clog::ready(inv)?;
    crate::meshw::clog::refusal(inv, &format!("{}{}", defaults::text("devswarm_cli.window_op_prefix"), read_sub(a, peek)), repo_key.as_deref(), Some(id), &msg, Some(&why.reason));
    crate::meshw::mark_committed();
    tick::emit_known_warning(read_sub(a, peek), &result);
    Ok(Answer { code: 2, stdout: format!("{}\n", result.stringify()), effect: Effect::None })
}

/// Where a `read-primary <id>` really reads (`cmdInbox`'s id resolution and `cmdInboxMessagesInner`'s retired-redirect hop).
enum Settled {
    /// Read `id`; `redirected_from` is the folded id the caller addressed, `resolved_from` the label or prefix it resolved from.
    Go { id: String, redirected_from: Option<String>, resolved_from: Option<String> },
    /// Node's refusal (ambiguous address).
    Refuse(Answer),
}

/// `retiredTo` of `retired/<id>.json`: the survivor a fold-retired id was merged into.
pub(crate) fn read_retired_redirect(inv: &Inv, id: &str) -> Option<String> {
    if !is_safe_id(id) {
        return None;
    }
    let p = devswarm_root(&inv.home).join(defaults::text("devswarm_cli.rr_dir_retired")).join(format!("{id}{}", defaults::text("mesh_write.json_suffix")));
    let j = OVal::parse(&String::from_utf8_lossy(&std::fs::read(p).ok()?))?;
    match j.get(defaults::text("devswarm_cli.rr_field_retired_to")) {
        Some(OVal::Str(t)) if !t.is_empty() => Some(t.clone()),
        Some(OVal::Num(x)) => Some(to_js_string(*x)),
        _ => None,
    }
}

fn settle_target(inv: &Inv, a: &Args, id: &str) -> R<Settled> {
    let same = || Settled::Go { id: id.to_string(), redirected_from: None, resolved_from: None };
    if a.is_help() || a.positionals.len() != 3 || ident::read_descriptor(&inv.home, id).is_some() {
        return Ok(same());
    }
    let Some(repo_key) = ident::resolve_context(&inv.cwd, true)?.repo_key else { return Ok(same()) };
    let reader = tick::open_reader_creating(inv, &repo_key)?;
    let rows = ident::rows_of(&reader.roster().map_err(|e| store_err("registry", e))?);
    if let Some(to) = read_retired_redirect(inv, id) {
        // a redirect is a hint, never proof the id stayed dead: a live registry row of the id reads as itself
        if to == id || rows.iter().any(|r| r.id == id) {
            return Ok(same());
        }
        if !is_safe_id(&to) {
            return Ok(same()); // a tombstone naming no usable id is no redirect: the id reads as itself
        }
        return Ok(Settled::Go { id: to, redirected_from: Some(id.to_string()), resolved_from: None });
    }
    match crate::meshw::send::resolve_read_arg(inv, &reader, &rows, id)? {
        crate::meshw::send::ReadArg::Same => Ok(same()),
        crate::meshw::send::ReadArg::To(to) => {
            if !is_safe_id(&to) {
                return Ok(same()); // a registry row with no usable id resolves nothing
            }
            Ok(Settled::Go { id: to, redirected_from: None, resolved_from: Some(id.to_string()) })
        }
        crate::meshw::send::ReadArg::Ambiguous(ids) => {
            let list = OVal::Arr(ids.iter().map(|x| s(x)).collect());
            let msg = fill_once(
                defaults::text("devswarm_cli.msg_read_arg_ambiguous"),
                &[("verb", a.positionals.get(1).cloned().unwrap_or_default()), ("id", format!("\"{id}\"")), ("candidates", list.stringify())],
            );
            let reason = defaults::text("devswarm_cli.reason_ambiguous_target");
            let mut o = Obj::default();
            o.put("ok", OVal::Bool(false)).put("id", s(id)).put("reason", s(reason)).put("error", s(&msg)).put("candidates", list);
            crate::meshw::clog::ready(inv)?;
            crate::meshw::clog::refusal(inv, defaults::text("devswarm_cli.window_op_read_primary"), Some(&repo_key), Some(id), &msg, Some(reason));
            crate::meshw::mark_committed();
            Ok(Settled::Refuse(Answer { code: 2, stdout: format!("{}\n", o.done().stringify()), effect: Effect::None }))
        }
    }
}

/// What the first pass found out about a promotion the row needs (made after that pass has settled every deferral).
struct PromoCtx {
    desc: OVal,
    desc_sid: Option<String>,
    registry_sid: Option<String>,
    marker: String,
    repo_key: String,
}

/// Everything the read decided, before its one write.
struct Planned {
    /// The result object Node prints as JSON.
    result: OVal,
    /// What `--format text` prints instead.
    text: Option<String>,
    record: String,
    /// The ack `--ack-after-print` applies right after the receipt is filed (settled here, before any write).
    ack: Option<crate::meshw::inbox::AckStep>,
    repo_key: String,
    dir: PathBuf,
    file: PathBuf,
    rel: String,
    promo: Option<PromoCtx>,
    /// Node's refusal of the read (exit 2): nothing else of the plan is used.
    refusal: Option<Answer>,
    /// Why the receipt cannot be written at all (`writeReadReceipt`'s `{ ok: false, error }`).
    receipt_error: Option<String>,
    /// `--legacy-ack-now`: the ack is made in this call and no receipt is filed.
    legacy: bool,
}

impl Planned {
    fn refused(answer: Answer) -> Planned {
        Planned {
            result: OVal::Null,
            text: None,
            record: String::new(),
            ack: None,
            repo_key: String::new(),
            dir: PathBuf::new(),
            file: PathBuf::new(),
            rel: String::new(),
            promo: None,
            refusal: Some(answer),
            receipt_error: None,
            legacy: false,
        }
    }
}

/// The verb word a read of this file is run as (`inbox <sub>`): `peek-primary`, `messages`, or the acking read's own word.
fn read_sub(a: &Args, peek: bool) -> &str {
    if peek {
        let messages = defaults::text("mesh_write.verb_messages");
        if a.positionals.get(1).map(String::as_str) == Some(messages) { messages } else { defaults::text("mesh_write.verb_peek_primary") }
    } else {
        acking_action(a)
    }
}

/// The verb word an acking read reports itself as: `drain-primary-legacy` is `read-primary --legacy-ack-now` under its own name (Node's
/// `opts.action`); `messages --ack` and `read-primary` both report `read-primary`.
fn acking_action(a: &Args) -> &str {
    let drain = defaults::text("mesh_write.verb_drain_primary_legacy");
    if a.positionals.get(1).map(String::as_str) == Some(drain) { drain } else { defaults::text("mesh_write.action_read_primary") }
}

/// Run `inbox read-primary <id>`: plan the read (every deferral is decided here, nothing is written); when the row carries
/// the `unclaimed:` marker, take it off (the promotion's writes) and plan again over the row as it is now; then file the
/// receipt.
pub fn run(inv: &Inv, a: &Args) -> R<Answer> {
    run_mode(inv, a, false)
}

/// Run `inbox peek-primary <id>`: the read of [`run`] without its receipt (nothing is acked, nothing is filed), from any caller.
pub fn run_peek(inv: &Inv, a: &Args) -> R<Answer> {
    run_mode(inv, a, true)
}

/// Run `inbox messages <id>`: the history read. With `--ack` it is `read-primary` (it returns a read receipt and acks nothing itself, and
/// says so on stderr unless the same-call `--legacy-ack-now` was asked for); without it, the whole partition (and its mesh group) is
/// listed, `--since` / `--tail` / `--limit` / `--unread` / `--with-broadcasts` shape the listing, and nothing is acked.
pub fn run_messages(inv: &Inv, a: &Args) -> R<Answer> {
    let Some(id) = a.positionals.get(2).map(String::as_str).filter(|i| is_safe_id(i)) else {
        return Ok(failure(defaults::text("devswarm_cli.msg_bad_id")));
    };
    if a.has(defaults::text("mesh_write.flag_ack")) {
        if !a.has(defaults::text("mesh_write.flag_legacy_ack_now")) {
            eprintln!("{}", fill_once(defaults::text("mesh_write.msg_messages_ack_warning"), &[("id", id.to_string())]));
        }
        return run(inv, a);
    }
    if a.has(defaults::text("mesh_write.flag_ack_as_owner")) {
        eprintln!(
            "{}",
            fill_once(defaults::text("mesh_write.msg_messages_ack_as_owner_warning"), &[("idq", OVal::Str(id.to_string()).stringify()), ("id", id.to_string())])
        );
    }
    let answer = run_history(inv, a)?;
    if let Some(result) = OVal::parse(answer.stdout.trim_end()) {
        tick::emit_known_warning(defaults::text("mesh_write.verb_messages"), &result);
    }
    Ok(answer)
}

/// A `{ok:false, error}` answer with exit 2: what `run()` prints for an id that is not usable and for an exception a verb throws.
pub(crate) fn failure(error: &str) -> Answer {
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(false)).put("error", s(error));
    Answer { code: 2, stdout: format!("{}\n", o.done().stringify()), effect: Effect::None }
}

/// A failure of the store itself (an unreadable or corrupt database), as the reason the verbs print as an error: see [`is_store_failure`].
pub(crate) fn store_err(kind: &str, e: impl std::fmt::Display) -> ident::Defer {
    ident::Defer::reason(format!("{kind}:{e}"))
}

/// Whether a deferral's reason is a failure of the store itself (an unreadable or corrupt database): Node throws there too, and
/// `run()` reports the exception as `{ok:false, error}` with exit 2.
pub(crate) fn is_store_failure(reason: &str) -> bool {
    defaults::list("mesh_write.store_failure_prefixes").iter().any(|p| reason.starts_with(p))
}

fn run_mode(inv: &Inv, a: &Args, peek: bool) -> R<Answer> {
    run_flavor(inv, a, peek, false)
}

/// Run `inbox messages <id>` (no ack): the history view. The unread-scoped reads of this file, without their scope: every row of the
/// partition (and of its mesh group), the window flags, the newest rows kept when a group's cap bites, and no NDJSON channel.
pub fn run_history(inv: &Inv, a: &Args) -> R<Answer> {
    run_flavor(inv, a, true, true)
}

/// The reads of this file: `peek` acks nothing; `hist` is the history view of `inbox messages` (it implies `peek`).
fn run_flavor(inv: &Inv, a: &Args, peek: bool, hist: bool) -> R<Answer> {
    // `inbox <sub> <id>`: an id that is not a safe one is refused before anything else; words after the id are ignored
    let Some(id) = a.positionals.get(2).map(String::as_str).filter(|i| is_safe_id(i)) else {
        return Ok(failure(defaults::text("devswarm_cli.msg_bad_id")));
    };
    let trimmed;
    let a = if a.positionals.len() > defaults::num("mesh_write.inbox_positionals") as usize {
        let mut b = a.clone();
        b.positionals.truncate(defaults::num("mesh_write.inbox_positionals") as usize);
        trimmed = b;
        &trimmed
    } else {
        a
    };
    let verb = read_sub(a, peek);
    let op = format!("{}{verb}", defaults::text("devswarm_cli.window_op_prefix"));
    match run_inner(inv, a, peek, hist) {
        Err(ident::Defer(reason)) if is_store_failure(&reason) && !crate::meshw::committed() => {
            let eff = a.positionals.get(2).map(String::as_str).unwrap_or(id);
            // a store that cannot be opened is Node's `store-unavailable` refusal (with the read-side meta); any other failure of the
            // store is the exception `run()` prints
            let (answer, msg, cause) = match store_open_error(inv, &reason) {
                Some(open) => {
                    let repo_key = ident::resolve_context(&inv.cwd, true).ok().and_then(|c| c.repo_key);
                    let dir = repo_key.as_deref().map(|k| union::store_dir(&inv.home, k).to_string_lossy().into_owned()).unwrap_or_default();
                    let quoted = OVal::Str(eff.to_string()).stringify();
                    // `DatabaseSync` fails to open (wrapped with the store directory) or opens a file whose first statement fails (raw)
                    let key = if open == defaults::text("mesh_write.store_cantopen_message") { "mesh_write.msg_store_unopened" } else { "mesh_write.msg_store_unreadable" };
                    let msg = defaults::render(key, &[("id", &quoted), ("dir", &dir), ("error", &open)]);
                    let code = defaults::text("mesh_write.store_unavailable_code");
                    let cause = defaults::text("mesh_write.reason_store_unavailable");
                    let mut o = Obj::default();
                    o.put("repoKey", common::s_or_null(repo_key.as_deref()))
                        .put("storePath", OVal::Null)
                        .put("cwd", s(&inv.cwd))
                        .put("meshPartitionIds", OVal::Arr(vec![s(eff)]))
                        .put("known", OVal::Bool(false))
                        .put("storeUnavailable", OVal::Bool(true))
                        .put("storeUnavailableReason", s(code))
                        .put("meshGroupUnresolved", OVal::Bool(false))
                        .put("meshGroupError", OVal::Null)
                        .put("totalsPartial", OVal::Bool(true))
                        .put("reason", s(cause))
                        .put("ok", OVal::Bool(false))
                        .put("id", s(eff))
                        .put("error", s(&msg));
                    (Answer { code: 2, stdout: format!("{}\n", o.done().stringify()), effect: Effect::None }, msg, Some(cause))
                }
                None => {
                    let msg = fill_once(defaults::text("mesh_write.msg_store_failure"), &[("reason", reason)]);
                    (failure(&msg), msg, None)
                }
            };
            crate::meshw::clog::ready(inv)?;
            crate::meshw::clog::refusal(inv, &op, ident::resolve_context(&inv.cwd, true).ok().and_then(|c| c.repo_key).as_deref(), Some(eff), &msg, cause);
            crate::meshw::mark_committed();
            Ok(answer)
        }
        other => other,
    }
}

/// The SQLite message of a store that could not be opened (`store-open:` reasons carry `store read failed: <message>: <path>`).
pub(crate) fn store_open_error(_inv: &Inv, reason: &str) -> Option<String> {
    let rest = reason.strip_prefix("store-open:")?;
    let rest = rest.strip_prefix(defaults::text("mesh_write.store_error_prefix")).unwrap_or(rest);
    Some(rest.rsplit_once(": ").map_or(rest, |(m, _)| m).to_string())
}

fn run_inner(inv: &Inv, a: &Args, peek: bool, hist: bool) -> R<Answer> {
    // `--since` / `--tail` are refused before anything is read
    if a.positionals.len() == 3
        && !hist
        && let Some(id) = a.positionals.get(2).map(String::as_str).filter(|i| is_safe_id(i))
        && let Some(refused) = window_refusal(inv, a, id, read_sub(a, peek))?
    {
        return Ok(refused);
    }
    let mut redirect = Redirect::default();
    let mut shifted: Option<Args> = None;
    if let Some(id) = a.positionals.get(2).map(String::as_str).filter(|i| is_safe_id(i)) {
        match settle_target(inv, a, id)? {
            Settled::Refuse(ans) => return Ok(ans),
            Settled::Go { id: eff, redirected_from, resolved_from } => {
                if eff != id {
                    let mut b = a.clone();
                    b.positionals[2] = eff;
                    shifted = Some(b);
                }
                redirect = Redirect { redirected_from, resolved_from, registry_error: None };
            }
        }
    }
    let a = shifted.as_ref().unwrap_or(a);
    // (a peek acks nothing, so it has no ownership gate; its existence guard refuses an id nothing knows. An acking read has the
    // guard only under `--ack-as-owner`, which skips the ownership check that otherwise stands in for it)
    let ack_as_owner = !peek && a.has(defaults::text("mesh_write.flag_ack_as_owner"));
    if (peek || ack_as_owner)
        && let Some(id) = a.positionals.get(2).map(String::as_str).filter(|i| is_safe_id(i))
        && let Some(refused) = peek_refusal(inv, a, id, peek)?
    {
        return Ok(refused);
    }
    if !peek
        && let Some(id) = a.positionals.get(2).map(String::as_str).filter(|i| is_safe_id(i))
        && let Some(refused) = unowned_refusal(inv, a, id)?
    {
        return Ok(refused);
    }
    let mut first = plan(inv, a, None, &redirect, peek, hist)?;
    if let Some(refused) = first.refusal.take() {
        return Ok(refused);
    }
    let planned = match first.promo.take() {
        None => first,
        Some(pc) => {
            let promotion = promote_full(inv, a, a.positionals.get(2).map(String::as_str).unwrap_or_default(), &pc.desc, pc.desc_sid.as_deref(), pc.registry_sid.as_deref(), &pc.marker, &pc.repo_key);
            // the writes are made: from here a deferral is a committed failure
            redirect.registry_error = promotion.registry_error;
            let mut second = plan(inv, a, promotion.state, &redirect, peek, hist)?;
            if let Some(refused) = second.refusal.take() {
                return Ok(refused);
            }
            second
        }
    };
    if peek {
        // a peek files nothing: its answer is the read itself (the promotion, when it happened, was its only write)
        let stdout = planned.result.stringify();
        return Ok(Answer { code: 0, stdout: format!("{stdout}\n"), effect: Effect::None });
    }
    if planned.legacy {
        let mut result = planned.result;
        match planned.ack {
            Some(crate::meshw::inbox::AckStep::Go(plan)) => {
                let applied = crate::meshw::inbox::apply_ack(inv, *plan);
                let acked = applied.0.iter().find(|(k, _)| k == "acked").map(|(_, v)| v.clone());
                if let Some(v) = &acked {
                    result.set("cursor", v.clone());
                }
                result.set("acked", acked.unwrap_or(OVal::Null));
                for (k, v) in applied.0.iter().filter(|(k, _)| k == "cursorWriteFailures" || k == "cursorPersisted") {
                    result.set(k, v.clone());
                }
                note_summary(inv, &planned.repo_key);
            }
            Some(crate::meshw::inbox::AckStep::Refuse(o)) => return Ok(Answer { code: 2, stdout: format!("{}\n", o.stringify()), effect: Effect::None }),
            None => {}
        }
        let stdout = planned.text.unwrap_or_else(|| result.stringify());
        return Ok(Answer { code: 0, stdout: format!("{stdout}\n"), effect: Effect::None });
    }
    // a receipt that cannot be made at all (`writeReadReceipt`'s own failure): reported in the result, nothing filed, nothing acked
    if let Some(error) = &planned.receipt_error {
        let id = a.positionals.get(2).map(String::as_str).unwrap_or_default();
        let stdout = planned.text.clone().unwrap_or_else(|| without_receipt(planned.result.clone(), error, id).stringify());
        return Ok(Answer { code: 0, stdout: format!("{stdout}\n"), effect: Effect::None });
    }
    // ---- the receipt: the only write of an unpromoted read ----
    let mut tmp = planned.file.as_os_str().to_os_string();
    tmp.push(defaults::text("mesh_write.tmp_suffix"));
    let tmp = PathBuf::from(tmp);
    let wrote = std::fs::create_dir_all(&planned.dir)
        .map_err(|e| js_io_error(&e, "mkdir", &planned.dir))
        .and_then(|()| std::fs::write(&tmp, &planned.record).map_err(|e| js_io_error(&e, "open", &tmp)))
        .and_then(|()| std::fs::rename(&tmp, &planned.file).map_err(|e| js_io_error(&e, "rename", &tmp)));
    if let Err(error) = wrote {
        // Node's `writeReadReceipt` reports the failure in the result (`receiptError`) and still answers 0, with nothing acked
        let id = a.positionals.get(2).map(String::as_str).unwrap_or_default();
        let stdout = planned.text.unwrap_or_else(|| without_receipt(planned.result, &error, id).stringify());
        return Ok(Answer { code: 0, stdout: format!("{stdout}\n"), effect: Effect::None });
    }
    prune_receipts(&planned.dir, inv.now, &planned.file);
    crate::meshw::mark_committed();
    crate::meshw::note_written(&planned.rel, planned.record.as_bytes());
    let mut result = planned.result;
    if let Some(ack) = planned.ack {
        // the ack (cmdInboxAckPrimary on the receipt just filed) is part of the printed result, as `autoAck`
        // an ack Node would refuse is the `autoAck` it prints (`ok: false`)
        match ack {
            crate::meshw::inbox::AckStep::Go(plan) => result.set("autoAck", crate::meshw::inbox::apply_ack(inv, *plan).done()),
            crate::meshw::inbox::AckStep::Refuse(o) => result.set("autoAck", o),
        }
        // the ack stamped the receipt: the witness compares the receipt as it now stands
        crate::meshw::set_written(&planned.rel, &std::fs::read(&planned.file).unwrap_or_default());
        // and re-derived the summary
        note_summary(inv, &planned.repo_key);
    }
    let stdout = planned.text.unwrap_or_else(|| result.stringify());
    Ok(Answer { code: 0, stdout: format!("{stdout}\n"), effect: Effect::None })
}

/// The read itself (see [`run`]). `promoted` is `Some(classic)` on the pass that follows a promotion.
/// The hops a read took to its id, reported on the result.
#[derive(Default)]
struct Redirect {
    redirected_from: Option<String>,
    resolved_from: Option<String>,
    /// The registry write error of the promotion this read made (`promotion.registryWriteError`).
    registry_error: Option<String>,
}

fn plan(inv: &Inv, a: &Args, promoted: Option<bool>, hops: &Redirect, peek: bool, hist: bool) -> R<Planned> {
    // (`help` never reaches here: `verb_of` classifies a help request as `simple`'s first; `run_mode` has settled the id's shape)
    let id = a.positionals.get(2).map(String::as_str).unwrap_or_default();
    // Node's flags: `--format text` (read-primary only: `main()` renders only that verb as text) and `--json` are read from argv
    // itself, every other flag the read does not know is ignored, as Node ignores it
    let json_flag = a.raw.iter().any(|w| *w == format!("--{}", defaults::text("mesh_write.flag_json")));
    // `main()` renders only `inbox read-primary` as text, whatever other verb is an acking read
    let format_text = !peek && text_requested(&a.raw) && a.positionals.get(1).map(String::as_str) == Some(defaults::text("mesh_write.verb_read_primary"));
    let ack_as_owner = !peek && a.has(defaults::text("mesh_write.flag_ack_as_owner"));
    let drain = a.positionals.get(1).map(String::as_str) == Some(defaults::text("mesh_write.verb_drain_primary_legacy"));
    let legacy = !peek && (drain || a.has(defaults::text("mesh_write.flag_legacy_ack_now")));
    // ---- reads: everything that can defer happens before the receipt is written ----
    // an id with no descriptor reads as Node's `desc = null`: no NDJSON inbox, no session, no registered project (a descriptor with none of
    // those is the same read), so the store is the only side
    let desc = ident::read_descriptor(&inv.home, id).unwrap_or_else(|| OVal::Obj(vec![(defaults::text("mesh_write.field_id").to_string(), s(id))]));
    // maybePromoteUnclaimed: the marker on either side is taken off below (or the call is Node's)
    let marker = format!("{}{id}", defaults::text("mesh_write.synthetic_session_prefix"));
    let desc_sid = text_or_null(&desc, defaults::text("mesh_write.field_session_id"));
    let inbox = union::path_field(&desc, defaults::text("mesh_write.field_inbox_path"))?;
    let cursor_file = union::path_field(&desc, defaults::text("mesh_write.field_cursor_path"))?;
    // `--unread` of the history view scopes it to the unread tail; the reads that ack (or preview an ack) always are
    let unread_only = !hist || a.has(defaults::text("mesh_write.flag_unread"));
    let o = match tick::open_partition_ex(inv, id, &desc)? {
        tick::PartitionOpen::Open(o) => o,
        tick::PartitionOpen::Unavailable { why, .. } => return Ok(Planned::refused(unavailable_refusal(inv, a, id, peek, &why)?)),
    };
    let registry_sid = o.rows.iter().find(|r| r.id == id).and_then(|r| r.session_id.clone());
    // the marker on either side: this pass reads the row as it is, and the promotion is made once every deferral is settled
    let promo = desc_sid.as_deref().is_some_and(|d| d == marker || (!d.is_empty() && registry_sid.as_deref() == Some(marker.as_str()))).then(|| PromoCtx {
        desc: desc.clone(),
        desc_sid: desc_sid.clone(),
        registry_sid: registry_sid.clone(),
        marker: marker.clone(),
        repo_key: o.repo_key.clone(),
    });
    let group = meshgroup::resolve(&o.rows, id, meshgroup::worktree_of(&o.rows, id, union::path_field(&desc, defaults::text("mesh_write.field_worktree_path"))?.as_deref()).as_deref())?;
    // the ownership gate of an acking read: the caller is the id, owns it by its registry row, or declared it
    // (a peek acks nothing, so it has no ownership gate: any caller may look; `--ack-as-owner` skips the gate, and turns the
    // existence guard back on)
    if !peek && !ack_as_owner {
        let caller = ident::caller_identity_detailed(&inv.env, &inv.cwd)?;
        let own_entry = resolve_mesh_target(inv, None, &o.rows, Some(caller.identity.as_str()))?;
        let owns = caller.identity == id
            || own_entry.as_ref().is_some_and(|e| e.id == id)
            || ident::declared_self_id(&inv.env, &inv.cwd, &o.rows)?.as_deref() == Some(id);
        if !owns {
            let has_row = o.rows.iter().any(|r| r.id == id);
            let has_messages = o.reader.message_count(id).map_err(|e| store_err("store-read", e))? > 0;
            let unbacked = ident::read_descriptor(&inv.home, id).is_none() && !has_row && !has_messages;
            return Ok(Planned::refused(ownership_refusal(inv, acking_action(a), &o.repo_key, id, &caller, own_entry.is_some(), unbacked, has_messages)?));
        }
    }
    let (store_base, nd_base) = tick::read_bases(inv, &o.reader, id, cursor_file.as_deref())?;
    let total_store = o.reader.message_count(id).map_err(|e| store_err("store-read", e))?;
    // `--limit N`: a finite positive number replaces the default cap (floored, at least 1); anything else is ignored
    let limit = a
        .one(defaults::text("mesh_write.flag_limit"))
        .map(crate::checks::guardkit::text::js_number_of_str)
        .filter(|x| x.is_finite() && *x > 0.0)
        .map_or(defaults::num("mesh_write.inbox_read_limit") as usize, |x| x.floor().max(1.0) as usize);
    let floor_pos = |x: f64| if x.is_finite() && x > 0.0 { x.floor() } else { 0.0 };
    let mut msgs: Vec<Msg> = Vec::new();
    let (mut unread_count, mut total_out);
    let mut union_cursors: Option<(f64, f64)> = None;
    let mut nd_op_target: Option<f64> = None;
    if let Some(inbox) = inbox.as_ref().filter(|_| !hist) {
        // a cursor file that is missing or unreadable (or no cursor path at all) leaves the NDJSON side unknown: its lines are not
        // counted (`known: false` of `readUnread`), the store side is read as ever, and the NDJSON cursor reports the file's own
        // value (`readCursor`: 0 when it gives none)
        let cf_ref = cursor_file.as_deref();
        let nd_known = union::non_empty_lines(inbox)?.is_some() && cf_ref.map(union::cursor_position).transpose()?.flatten().is_some();
        let input = union::UnionIn { inbox: Some(inbox), cursor_file: cf_ref, id, store: Some(&o.reader), store_base, nd_base, now: inv.now };
        let me = crate::meshw::cursors::reader_key(tick::reader_nonce_cached(&inv.home).as_deref());
        let counted = union::unread_for(&o.reader, &inv.home, id, Some(inbox), cf_ref, me.as_deref(), &tick::family_of(id, &o.rows), inv.now)?;
        tick::note_own_excluded(&counted);
        let u = counted.union;
        let merged_total = union::merged_total(&input)?;
        let family = tick::family_of(id, &o.rows);
        for (i, line) in u.nd_unread_lines.iter().enumerate() {
            let mut m = ndjson_msg(line)?;
            m.own = union::line_sender(line).is_some_and(|x| family.contains(&x));
            m.src_idx = i;
            msgs.push(m);
        }
        for (i, r) in u.store_only_unread.iter().enumerate() {
            let mut m = store_msg(r, true);
            m.own = r.get("sender").and_then(Value::as_str).is_some_and(|x| family.contains(x));
            m.src_idx = i;
            msgs.push(m);
        }
        // Array#sort is stable and a non-finite `ts` sorts last (a pair of them compares equal)
        msgs.sort_by(
            |x, y| {
                if x.sort_ts == y.sort_ts { std::cmp::Ordering::Equal } else { x.sort_ts.partial_cmp(&y.sort_ts).unwrap_or(std::cmp::Ordering::Equal) }
            },
        );
        unread_count = counted.unread as f64;
        total_out = merged_total as f64;
        let nd_cursor = if nd_known { floor_pos(nd_base) } else { cf_ref.map(union::cursor_position).transpose()?.flatten().map_or(0.0, f64::floor) };
        union_cursors = Some((nd_cursor, store_base));
        nd_op_target = Some(nd_cursor + u.nd_skipped as f64 + u.nd_unread_lines.len() as f64);
    } else {
        let family = tick::family_of(id, &o.rows);
        o.reader
            .for_each_message(id, if unread_only { floor_pos(store_base) as u64 } else { 0 }, |m| {
                let mut x = store_msg(&m, false);
                x.own = m["sender"].as_str().is_some_and(|f| family.contains(f));
                x.src_idx = msgs.len();
                msgs.push(x);
                true
            })
            .map_err(|e| store_err("store-read", e))?;
        let own_unread = msgs.iter().filter(|m| m.own).count();
        if own_unread > 0 {
            crate::metrics::bump("mesh_own_sends_excluded", &[]);
        }
        unread_count = ((total_store as f64 - store_base).max(0.0) - if unread_only { own_unread as f64 } else { 0.0 }).max(0.0);
        total_out = total_store as f64;
    }
    // ---- the sibling partitions of the mesh group ----
    let mut sibs = Siblings::default();
    if group.active {
        sibs = read_siblings(inv, &o, &group, id, store_base, &mut msgs, unread_only, !peek)?;
        total_out += sibs.added_total;
        unread_count += sibs.added_unread as f64 - sibs.own_dropped as f64;
    }
    // the history view's window (`--since` / `--tail`, only `inbox messages` has them): `--since` narrows the merged set BEFORE the cap, so
    // a recent window is never emptied by a cap that already discarded the rows it asked for
    let window = if hist { history_window(a)? } else { Ok(Window::default()) };
    let window = match window {
        Ok(w) => w,
        Err(refusal) => return Ok(Planned::refused(refusal)),
    };
    let (mut window_withheld, mut window_undated) = (0usize, 0usize);
    if let Some(since) = &window.since {
        let before = msgs.len();
        msgs.retain(|m| {
            // a row with nothing to compare (a legacy row with no time or position) is KEPT and counted: hiding mail for missing
            // metadata is the one failure a "show me recent mail" flag must not have
            let at = match since {
                Since::Ts(_) => Some(m.sort_ts).filter(|x| x.is_finite()),
                Since::Index(_) => m.index.filter(|x| x.is_finite()),
            };
            match (at, since) {
                (None, _) => {
                    window_undated += 1;
                    true
                }
                (Some(x), Since::Ts(from)) => x >= *from,
                (Some(x), Since::Index(from)) => x > *from,
            }
        });
        window_withheld = before - msgs.len();
    }
    // the per-source cap: an acking or previewing read delivers the OLDEST `limit` rows (the first withheld row of a source and everything
    // after it stay unread, so the ack never passes a withheld row); the history view acks nothing and delivers the NEWEST, and only
    // when the partition belongs to a mesh group (a lone partition is read whole)
    let mut truncated_count = 0usize;
    let mut withheld_by_src: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    if hist && group.active && msgs.len() > limit {
        let cut = msgs.len() - limit;
        let mut max_idx: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
        for m in msgs.iter().take(cut) {
            let e = max_idx.entry(m.src.clone()).or_insert(0);
            *e = (*e).max(m.src_idx);
        }
        let before = msgs.len();
        let mut kept = Vec::with_capacity(limit);
        for m in msgs {
            if max_idx.get(&m.src).is_some_and(|&mx| m.src_idx <= mx) {
                *withheld_by_src.entry(m.src.clone()).or_insert(0) += 1;
            } else {
                kept.push(m);
            }
        }
        truncated_count = before - kept.len();
        msgs = kept;
    } else if !hist && msgs.len() > limit {
        let mut min_idx: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
        for m in msgs.iter().skip(limit) {
            let e = min_idx.entry(m.src.clone()).or_insert(usize::MAX);
            *e = (*e).min(m.src_idx);
        }
        let before = msgs.len();
        let mut kept = Vec::with_capacity(limit);
        for m in msgs {
            if min_idx.get(&m.src).is_some_and(|&mi| m.src_idx >= mi) {
                *withheld_by_src.entry(m.src.clone()).or_insert(0) += 1;
            } else {
                kept.push(m);
            }
        }
        truncated_count = before - kept.len();
        msgs = kept;
    }
    // the own-partition ack target: the highest store position actually delivered, never below the read base
    let max_index = msgs.iter().filter(|m| m.src == "own").filter_map(|m| m.index).fold(None, |acc: Option<f64>, i| Some(acc.map_or(i, |a| a.max(i))));
    let own_target = max_index.map_or(store_base, |m| store_base.max(m));
    let delivered = msgs.len();
    // #181: the unread list leaves out the mail the reader's own family sent, as its count does (the targets above already walked it);
    // a history view keeps it
    if unread_only {
        msgs.retain(|m| !m.own);
    }
    if let Some(tail) = window.tail {
        // `--tail N` promises the NEWEST N: once the cap has fired it cannot be honoured, so it is refused rather than guessed
        if truncated_count > 0 {
            return Ok(Planned::refused(tail_under_truncation(id, truncated_count, limit, tail)));
        }
        let before = msgs.len();
        if msgs.len() > tail {
            msgs.drain(..msgs.len() - tail);
        }
        // rows with no time sort last, which is where the tail is taken from: say how many of the delivered rows are such
        window_undated = msgs.iter().filter(|m| !m.sort_ts.is_finite()).count();
        window_withheld += before - msgs.len();
    }
    // the receipt names the rows the reader was shown
    let hashes: Vec<OVal> = msgs.iter().map(|m| common::s_or_null(m.hash.as_deref())).collect();
    let mut rows: Vec<OVal> = Vec::with_capacity(msgs.len());
    let mut body_bytes = 0.0;
    let registry: std::cell::OnceCell<Vec<(String, String)>> = std::cell::OnceCell::new();
    let legacy_from = |body: &str| -> Option<String> {
        let reg = registry.get_or_init(|| crate::dssup::ingest::import::registry_pairs(&o.reader));
        let named = crate::dssup::ingest::import::done_branch(body).and_then(|branch| crate::dssup::ingest::import::branch_sender(reg, &branch));
        // #181: a stored row with no sender in a child's partition is the Primary's outbound (as ingest now stamps it)
        named.or_else(|| {
            let fallback = crate::dssup::ingest::import::fallback_sender(reg, id);
            if fallback.is_some() {
                crate::metrics::bump("mesh_sender_fallback", &[("where", defaults::text("mesh_write.sender_fallback_read"))]);
            }
            fallback
        })
    };
    for m in msgs {
        let (row, len) = finish(m, &legacy_from)?;
        body_bytes += len;
        rows.push(row);
    }
    // `--with-broadcasts` (a peek only: an acking read reports it ignored): the project's newest broadcasts join the rows, ordered by
    // their store sequence, tagged `kind: broadcast`; no cursor moves
    let with_broadcasts = a.has(defaults::text("mesh_write.flag_with_broadcasts"));
    let mut broadcasts_merged: Option<usize> = None;
    if peek && with_broadcasts {
        let aliases = common::read_aliases(&inv.home);
        let mut found: Vec<Value> = Vec::new();
        o.reader
            .for_each_message(defaults::text("mesh_write.broadcast_partition"), 0, |m| {
                if !m["isHeartbeat"].as_bool().unwrap_or(false) && m["storeSeq"].as_f64().is_some_and(f64::is_finite) {
                    found.push(m);
                }
                true
            })
            .map_err(|e| store_err("store-read", e))?;
        let keep = defaults::num("mesh_write.broadcast_merge_cap") as usize;
        if found.len() > keep {
            found.drain(..found.len() - keep);
        }
        broadcasts_merged = Some(found.len());
        for r in &found {
            let sender = r["sender"].as_str();
            let from = sender.and_then(|sv| aliases.iter().find(|(k, _)| k == sv).map(|(_, v)| v.clone())).map_or_else(|| common::s_or_null(sender), |to| s(&to));
            let body = r["body"].as_str().unwrap_or_default();
            let ts = r["ts"].as_f64().map_or(OVal::Null, n);
            let seq = r["storeSeq"].as_f64().map_or(OVal::Null, n);
            let mut b = Obj::default();
            b.put("from", from.clone())
                .put("sender", from)
                .put("text", s(body))
                .put("body", s(body))
                .put("message", s(body))
                .put("kind", s(defaults::text("mesh_write.mtype_broadcast")))
                .put("mtype", s(defaults::text("mesh_write.mtype_broadcast")))
                .put("ts", ts.clone())
                .put("timestamp", ts)
                .put("urgency", common::s_or_null(r["urgency"].as_str()))
                .put("seq", seq.clone())
                .put("storeSeq", seq)
                .put("bodyLength", n(body.len() as f64));
            body_bytes += body.len() as f64;
            rows.push(b.done());
        }
        let seq_key = |v: &OVal| match v.get("seq") {
            Some(OVal::Num(x)) if x.is_finite() => *x,
            _ => 0.0,
        };
        rows.sort_by(|x, y| seq_key(x).partial_cmp(&seq_key(y)).unwrap_or(std::cmp::Ordering::Equal));
    }
    // Jev triage is advisory and fail-open in Node (a row it cannot label simply carries no `triage` key); the engine has no
    // triage port, so it labels nothing, and counts the reads that went out unlabelled while Jev may be on
    if !rows.is_empty() && common::jev_maybe_enabled(inv) {
        crate::metrics::bump("mesh_triage_skipped", &[("where", defaults::text("mesh_write.verb_read_primary"))]);
    }
    let cli = if peek { String::new() } else { launcher_path(&inv.home)? };
    let reader = cursors::reader_key(tick::reader_nonce_cached(&inv.home).as_deref());
    // a mesh group files its receipts under the lowest id of the group, so any alias of it finds them
    let dir_id = if group.active {
        let mut ids = group.ids.clone();
        ids.sort();
        ids.remove(0)
    } else {
        id.to_string()
    };
    let dir = devswarm_root(&inv.home).join(defaults::text("mesh_write.dir_read_receipts")).join(&dir_id);
    // ---- the output (everything but the receipt id is known) ----
    let mut receipt_error: Option<String> = None;
    let rid = if peek || legacy {
        String::new()
    } else {
        match random_hex(6) {
            Some(rand) => format!("{}{}{rand}", defaults::text("mesh_write.receipt_id_prefix"), base36(inv.now.max(0) as u64)),
            None => {
                // `crypto.randomBytes` threw inside `writeReadReceipt`: no receipt, the failure reported in the result
                receipt_error = Some(defaults::text("mesh_write.msg_no_random").to_string());
                String::new()
            }
        }
    };
    let mut ops = vec![{
        let mut op = Obj::default();
        op.put("k", s(defaults::text("mesh_write.op_own"))).put("partition", s(id)).put("target", n(own_target)).put("delivered", n(delivered as f64));
        op.done()
    }];
    let mut live_siblings_skipped: Vec<String> = Vec::new();
    // siblings come before the NDJSON op, as in Node
    for part in &sibs.parts {
        let not_ackable = meshgroup::ack_gate(inv, &o.rows, id, &part.id)?;
        if not_ackable {
            live_siblings_skipped.push(part.id.clone());
        }
        let full = part.delivered_count as f64;
        let delivered_here = full - withheld_by_src.get(&format!("sibling:{}", part.id)).copied().unwrap_or(0) as f64;
        let physical = if delivered_here >= full {
            part.consumed_count
        } else if delivered_here <= 0.0 {
            0.0
        } else {
            part.consumed_through.get(delivered_here as usize - 1).copied().unwrap_or(delivered_here)
        };
        let anchor = part.cursor.max(part.since);
        let mut op = Obj::default();
        op.put("k", s(defaults::text("mesh_write.op_sibling")))
            .put("partition", s(&part.id))
            .put("ackTarget", n(anchor + physical))
            .put("seenTarget", n(part.since + physical))
            .put("notAckable", OVal::Bool(not_ackable))
            .put("delivered", n(full));
        ops.push(op.done());
    }
    if let (Some(target), Some(inbox), Some(cf)) = (nd_op_target, &inbox, &cursor_file) {
        let target = target - withheld_by_src.get("ndjson").copied().unwrap_or(0) as f64;
        let mut op = Obj::default();
        op.put("k", s(defaults::text("mesh_write.op_nd"))).put("partition", s(id)).put("target", n(target)).put("cursorPath", s(cf)).put("inboxPath", s(inbox));
        ops.push(op.done());
    }
    let store_path = union::store_dir(&inv.home, &o.repo_key);
    let mut out = Obj::default();
    out.put("ok", OVal::Bool(true))
        .put("action", s(if hist { defaults::text("mesh_write.verb_messages") } else if peek { defaults::text("mesh_write.action_peek_primary") } else { acking_action(a) }))
        .put("id", s(id))
        .put("repoKey", s(&o.repo_key))
        .put("storePath", OVal::Str(store_path.to_string_lossy().into_owned()))
        .put("cwd", s(&inv.cwd))
        .put("meshPartitionIds", OVal::Arr(group.ids.iter().map(|x| s(x)).collect()))
        .put("unreadOnly", OVal::Bool(unread_only))
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
    if let Some(count) = broadcasts_merged {
        out.put("broadcastCount", n(count as f64));
    } else if with_broadcasts && !peek {
        out.put("withBroadcastsIgnored", s(defaults::text("mesh_write.with_broadcasts_ignored")));
    }
    if let Some(from) = &hops.redirected_from {
        out.put("redirected", OVal::Bool(true)).put("redirectedFrom", s(from));
    }
    if promoted == Some(true) {
        let mut p = Obj::default();
        p.put("promoted", OVal::Bool(true));
        if let Some(e) = &hops.registry_error {
            p.put("registryWriteError", s(e));
        }
        out.put("promotion", p.done());
    }
    if let Some((nd, st)) = union_cursors {
        out.put("cursorNdjson", n(nd)).put("cursorStore", n(st));
    }
    if peek {
        // a peek stops at the cursors: no receipt, no ack command. What it withheld is reported all the same, never silently
        put_withheld(&mut out, &sibs, truncated_count, limit, hist.then_some((&window, window_withheld, window_undated, sibs.added_total > 0.0)));
        if let Some(from) = &hops.resolved_from {
            out.put("resolvedFrom", s(from));
        }
        return Ok(Planned {
            result: out.done(),
            text: None,
            record: String::new(),
            ack: None,
            repo_key: o.repo_key.clone(),
            dir,
            file: PathBuf::new(),
            rel: String::new(),
            promo,
            refusal: None,
            receipt_error: None,
            legacy: false,
        });
    }
    if legacy {
        // `read-primary --legacy-ack-now`: the old same-call read-and-ack. The ops are applied here instead of filed, and the
        // result carries where the cursor was and where the ack put it (`ackedFrom`, `acked`), with no receipt fields
        let record_val = receipt_record("", id, reader.as_deref(), inv.now, ops, hashes);
        let step = crate::meshw::inbox::plan_ack(inv, id, "", ack_as_owner, Some(record_val), false)?;
        out.put("ackedFrom", n(store_base));
        let text = (format_text && !json_flag).then(|| text_lines(&rows));
        return Ok(Planned { result: out.done(), text, record: String::new(), ack: Some(step), repo_key: o.repo_key.clone(), dir, file: PathBuf::new(), rel: String::new(), promo, refusal: None, receipt_error: None, legacy: true });
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
    if !live_siblings_skipped.is_empty() {
        out.put("liveSiblingsSkipped", OVal::Arr(live_siblings_skipped.iter().map(|x| s(x)).collect()));
    }
    put_withheld(&mut out, &sibs, truncated_count, limit, None);
    if let Some(from) = &hops.resolved_from {
        out.put("resolvedFrom", s(from));
    }
    let text = (format_text && !json_flag).then(|| text_lines(&rows));
    let result = out.done();
    let record_val = receipt_record(&rid, id, reader.as_deref(), inv.now, ops, hashes);
    let record = record_val.stringify();
    // `--ack-after-print`: the ack of the receipt this read files, in the same call. Everything it can refuse or cannot apply is
    // settled now, so the receipt is never filed for an ack the engine would then have to hand to Node
    let ack = if a.has(defaults::text("mesh_write.flag_ack_after_print")) && receipt_error.is_none() {
        Some(crate::meshw::inbox::plan_ack(inv, id, &rid, ack_as_owner, Some(record_val), true)?)
    } else {
        None
    };
    let file: PathBuf = dir.join(format!("{rid}{}", defaults::text("mesh_write.json_suffix")));
    let rel = format!(
        "{}/{}/{}/{dir_id}/{rid}{}",
        defaults::text("mesh_write.dir_anti_hall"),
        defaults::text("mesh_write.dir_devswarm"),
        defaults::text("mesh_write.dir_read_receipts"),
        defaults::text("mesh_write.json_suffix")
    );
    Ok(Planned { result, text, record, ack, repo_key: o.repo_key.clone(), dir, file, rel, promo, refusal: None, receipt_error, legacy: false })
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

    fn sender_of(m: &Msg) -> Option<String> {
        m.fields.0.iter().find(|(k, _)| k == "sender").and_then(|(_, v)| if let OVal::Str(t) = v { Some(t.clone()) } else { None })
    }

    #[test]
    fn an_ndjson_line_names_its_own_sender() {
        // #181: pull stamps the resolved sender; `fromBranch` is only a branch ("main" is not an addressable id)
        let m = ndjson_msg(r#"{"_h":"h","fromBranch":"main","message":"poke","createdAt":1,"sender":"P"}"#).unwrap();
        assert_eq!(sender_of(&m).as_deref(), Some("P"));
        let legacy = ndjson_msg(r#"{"_h":"h","fromBranch":"fix/x","message":"m","createdAt":1}"#).unwrap();
        assert_eq!(sender_of(&legacy).as_deref(), Some("fix/x"), "a line with no sender keeps its branch, as before");
        let none = ndjson_msg(r#"{"_h":"h","message":"m","createdAt":1}"#).unwrap();
        assert_eq!(sender_of(&none), None);
    }

    // ---- no deferral to Node in the files that answer the read verbs (prevention) ----

    /// The call that hands a verb to Node is spelled in pieces so this file does not contain it.
    fn handoff() -> String {
        ["def", "er("].concat()
    }

    #[test]
    fn no_node_handoff_in_the_read_and_ack_verbs() {
        let needle = handoff();
        for (file, src) in [
            ("readprimary.rs", include_str!("readprimary.rs")),
            ("read.rs", include_str!("read.rs")),
            ("union.rs", include_str!("union.rs")),
            ("inbox.rs", include_str!("inbox.rs")),
        ] {
            // everything above the test module: the tests quote the call to forbid it
            let code = src.split("#[cfg(test)]").next().unwrap_or(src);
            let hits: Vec<&str> = code.lines().filter(|l| !l.trim_start().starts_with("//") && l.contains(&needle)).collect();
            assert!(hits.is_empty(), "{file} hands a call to Node (exit 69): {hits:?}");
        }
    }

    #[test]
    fn every_store_error_is_one_the_verbs_answer_as_a_failure() {
        // `store_err("<kind>", e)` is the only way these files build a deferral, and a kind is only allowed when it is a store failure,
        // which `run_mode`/`inbox::run`/`read::run` print as `{ok:false, error}` (exit 2); any other prefix would reach the caller as exit 69
        let prefixes = defaults::list("mesh_write.store_failure_prefixes");
        for (file, src) in [
            ("readprimary.rs", include_str!("readprimary.rs")),
            ("read.rs", include_str!("read.rs")),
            ("union.rs", include_str!("union.rs")),
            ("inbox.rs", include_str!("inbox.rs")),
        ] {
            let code = src.split("#[cfg(test)]").next().unwrap_or(src);
            let ctor = ["Def", "er("].concat();
            for line in code.lines().filter(|l| !l.trim_start().starts_with("//")) {
                assert!(!line.contains(&ctor) || line.contains("Err(ident::Defer(reason))") || line.contains("Err(Defer(reason))") || line.contains("pub struct"), "{file}: `{line}` builds a deferral by hand");
                let mut rest = line;
                while let Some(at) = rest.find("store_err(\"") {
                    let after = &rest[at + "store_err(\"".len()..];
                    let kind = after.split('"').next().unwrap_or_default();
                    assert!(prefixes.iter().any(|p| *p == format!("{kind}:")), "{file}: store_err kind `{kind}` is not a store failure");
                    rest = after;
                }
            }
        }
    }

    fn scratch_inv(tag: &str) -> Inv {
        let home = std::env::temp_dir().join(format!("ah-rp-{tag}-{}", std::process::id()));
        crate::discard::harmless(std::fs::remove_dir_all(&home)); // keep: a stale scratch directory of an earlier run
        std::fs::create_dir_all(&home).unwrap();
        Inv { home: home.clone(), write_home: home, env: std::collections::HashMap::new(), cwd: "/".into(), now: 1_800_000_000_000, stdin: None, store_override: None }
    }

    fn argv(words: &[&str]) -> Args {
        crate::meshw::args::parse(&words.iter().map(|w| (*w).to_string()).collect::<Vec<_>>())
    }

    fn json(a: &Answer) -> serde_json::Value {
        serde_json::from_str(a.stdout.trim()).unwrap()
    }

    #[test]
    fn an_old_receipt_is_pruned_after_the_write_and_a_fresh_one_stays() {
        let inv = scratch_inv("prune");
        let dir = inv.home.join("rr");
        std::fs::create_dir_all(&dir).unwrap();
        let old = dir.join("rold1.json");
        let fresh = dir.join("rnew1.json");
        let own = dir.join("rown1.json");
        let other = dir.join("notes.txt");
        for f in [&old, &fresh, &own, &other] {
            std::fs::write(f, "{}").unwrap();
        }
        let keep = defaults::num("mesh_write.receipt_keep_ms") as u64;
        let long_ago = std::time::SystemTime::now() - std::time::Duration::from_millis(keep + 3_600_000);
        for f in [&old, &own, &other] {
            std::fs::File::options().write(true).open(f).unwrap().set_modified(long_ago).unwrap();
        }
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
        prune_receipts(&dir, now, &own);
        assert!(!old.exists(), "a receipt past the keep window goes");
        assert!(fresh.exists() && own.exists() && other.exists(), "a fresh receipt, the one just filed and a file that is no receipt stay");
    }

    #[test]
    fn a_read_whose_receipt_cannot_be_written_reports_the_error_and_no_ack_command() {
        let result = OVal::parse(r#"{"ok":true,"acked":false,"readReceiptId":"r1","ackCommand":"x","ackHint":"h","count":0}"#).unwrap();
        let out = without_receipt(result, "ENOENT: no such file or directory, mkdir '/x'", "w1").stringify();
        assert_eq!(
            out,
            r#"{"ok":true,"acked":false,"readReceiptId":null,"receiptError":"ENOENT: no such file or directory, mkdir '/x'","ackHint":"read-only: nothing was acked, and the read receipt could not be written (ENOENT: no such file or directory, mkdir '/x') — re-run read-primary, or use `inbox drain-primary-legacy w1` to read-and-ack in one call.","count":0}"#
        );
        let e = std::io::Error::from(std::io::ErrorKind::NotFound);
        assert_eq!(js_io_error(&e, "open", Path::new("/a/b")), "ENOENT: no such file or directory, open '/a/b'");
    }

    #[test]
    fn an_id_that_is_not_safe_is_refused_for_read_primary_and_peek_primary() {
        let inv = scratch_inv("badid");
        for peek in [false, true] {
            let a = argv(&["inbox", if peek { "peek-primary" } else { "read-primary" }, "../etc"]);
            let ans = run_mode(&inv, &a, peek).unwrap();
            assert_eq!(ans.code, 2);
            assert_eq!(json(&ans), serde_json::json!({"ok": false, "error": "invalid or missing workspace id"}));
        }
        let none = argv(&["inbox", "read-primary"]);
        assert_eq!(run_mode(&inv, &none, false).unwrap().code, 2);
    }

    #[test]
    fn a_promotion_that_is_not_the_callers_to_make_is_no_promotion() {
        let mut inv = scratch_inv("promote");
        let desc = OVal::parse(r#"{"id":"w1","sessionId":"unclaimed:w1"}"#).unwrap();
        let a = argv(&["inbox", "read-primary", "w1", "--session", "unclaimed:other"]);
        let p = |inv: &Inv, a: &Args| promote_full(inv, a, "w1", &desc, Some("unclaimed:w1"), Some("unclaimed:w1"), "unclaimed:w1", "repo");
        // a session that is not a real one: nothing is promoted (Node's `realSessionIdFrom` answers null)
        assert!(p(&inv, &a).state.is_none());
        // the row's own id as the session
        assert!(p(&inv, &argv(&["inbox", "read-primary", "w1", "--session", "w1"])).state.is_none());
        // a reconcile sweep is not the row's session
        inv.env.insert(defaults::text("devswarm_cli.env_reconcile_sweep").into(), defaults::text("mesh_write.env_on_value").into());
        assert!(p(&inv, &argv(&["inbox", "read-primary", "w1", "--session", "real-1"])).state.is_none());
        // both sides claimed: nothing to do
        let claimed = OVal::parse(r#"{"id":"w1","sessionId":"s1"}"#).unwrap();
        assert!(promote_full(&inv, &a, "w1", &claimed, Some("s1"), Some("s1"), "unclaimed:w1", "repo").state.is_none());
    }

    #[test]
    fn with_no_session_named_the_process_tree_finds_none_in_a_home_without_session_files() {
        let inv = scratch_inv("tree");
        assert_eq!(session_from_process_tree(&inv), None);
    }

    #[test]
    fn a_descriptor_field_reads_as_javascript_stringifies_it() {
        let d = OVal::parse(r#"{"a":5,"b":null,"c":[1,null,"x"],"d":{"k":1},"e":"s","f":true}"#).unwrap();
        assert_eq!(text_or_null(&d, "a").as_deref(), Some("5"));
        assert_eq!(text_or_null(&d, "b"), None);
        assert_eq!(text_or_null(&d, "z"), None);
        assert_eq!(text_or_null(&d, "c").as_deref(), Some("1,,x"));
        assert_eq!(text_or_null(&d, "d").as_deref(), Some("[object Object]"));
        assert_eq!(text_or_null(&d, "e").as_deref(), Some("s"));
        assert_eq!(text_or_null(&d, "f").as_deref(), Some("true"));
    }

    #[test]
    fn ndjson_fields_of_any_json_type_read_as_their_javascript_strings() {
        let m = ndjson_msg(r#"{"_h":12,"message":["a",null,2],"sender":{"x":1},"createdAt":3}"#).unwrap();
        let field = |k: &str| m.fields.0.iter().find(|(x, _)| x == k).map(|(_, v)| v.clone());
        assert_eq!(field("hash"), Some(OVal::Str("12".into())));
        assert_eq!(field("body"), Some(OVal::Str("a,,2".into())));
        assert_eq!(field("sender"), Some(OVal::Str("[object Object]".into())));
    }

    #[test]
    fn a_read_ack_that_is_refused_prints_the_refusal_and_is_logged() {
        let inv = scratch_inv("ackrefuse");
        // no --receipt: Node's `missing-receipt`, exit 2
        let ans = crate::meshw::inbox::run(&inv, &argv(&["inbox", "ack-primary", "w1"])).unwrap();
        assert_eq!(ans.code, 2);
        let j = json(&ans);
        assert_eq!(j["reason"], "missing-receipt");
        assert_eq!(j["action"], "ack-primary");
        assert_eq!(j["id"], "w1");
        // an id that is not safe
        let bad = crate::meshw::inbox::run(&inv, &argv(&["inbox", "ack-primary", "a/b", "--receipt", "r1"])).unwrap();
        assert_eq!(json(&bad), serde_json::json!({"ok": false, "error": "invalid or missing workspace id"}));
    }

    #[test]
    fn a_mesh_read_outside_a_project_is_refused_with_its_reason() {
        let inv = scratch_inv("meshread");
        let ans = crate::meshw::read::run(&inv, &argv(&["mesh", "read"]), false).unwrap();
        assert_eq!(ans.code, 2);
        assert_eq!(json(&ans), serde_json::json!({"ok": false, "reason": "no-project"}));
    }

    #[test]
    fn a_cursor_file_of_any_shape_reads_the_way_node_reads_it() {
        let inv = scratch_inv("cursor");
        let read = |body: &str| {
            let f = inv.home.join("cursor.json");
            std::fs::write(&f, body).unwrap();
            union::cursor_position(f.to_str().unwrap()).unwrap()
        };
        assert_eq!(read("7"), Some(7.0));
        assert_eq!(read(&"9".repeat(30)), Some("9".repeat(30).parse::<f64>().unwrap()), "a long digit string is rounded as parseInt rounds it");
        assert_eq!(read(&"1".repeat(400)), None, "past the largest number a position can be");
        assert_eq!(read(r#"{"line":[]}"#), Some(0.0), "Number([]) is 0");
        assert_eq!(read(r#"{"line":[5]}"#), Some(5.0), "Number([5]) is 5");
        assert_eq!(read(r#"{"line":{"a":1}}"#), None, "Number of an object is NaN");
        assert_eq!(read(r#"{"line":null}"#), Some(0.0));
        assert_eq!(read(r#"{"line":"12"}"#), Some(12.0));
        assert_eq!(read("null"), None);
    }
}
