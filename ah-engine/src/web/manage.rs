//! `manage`: audited setting writes. A registry setting (`settings.json` schema) is validated and written by the settings store
//! exactly as `settings set` does; any other shipped engine setting is validated against its shipped default (type, bounds) and
//! written to the same `settings.json` layer (the engine reads it above the shipped value, `cfgstore`). The shipped defaults,
//! and the pristine copy beside them, are never written. Each write appends an audit row holding the previous and the new
//! file value, which is what `undo` restores.
use super::{flag, j_to_value};
use crate::checks::jsport::json::{self, J};
use crate::defaults::{self, V};
use crate::migrate::settings::{self as store, Outcome};
use crate::ops::settings as registry;
use serde_json::{Value, json};
use std::io::{Read, Seek, SeekFrom, Write};
use std::sync::atomic::{AtomicU64, Ordering};

static SEQ: AtomicU64 = AtomicU64::new(0);

/// What a write came to.
pub struct Written {
    /// The write was made.
    pub ok: bool,
    /// The audit row id (empty when nothing was written).
    pub id: String,
    /// The setting key.
    pub key: String,
    /// `set`, `reset` or `undo`.
    pub op: &'static str,
    /// `registry` or `engine`.
    pub kind: &'static str,
    /// The `settings.json` value before (`None`: the key had no override).
    pub prev: Option<Value>,
    /// The `settings.json` value after (`None`: no override).
    pub value: Option<Value>,
    /// A risky change that needs `--confirmed`: the warning to show.
    pub warning: Option<String>,
    /// A refusal, or a note about when the change takes effect.
    pub note: Option<String>,
}

impl Written {
    /// The result as JSON.
    pub fn to_json(&self) -> Value {
        json!({"ok": self.ok, "id": self.id, "key": self.key, "op": self.op, "kind": self.kind, "prev": self.prev, "value": self.value,
            "needs_confirmation": self.warning.is_some(), "warning": self.warning, "note": self.note})
    }
}

fn split(key: &str) -> Option<(&str, &str)> {
    key.split_once('.').filter(|(s, k)| !s.is_empty() && !k.is_empty())
}

fn now_ms() -> u64 {
    crate::health::now_ms()
}

fn history_path() -> std::path::PathBuf {
    crate::paths::dir().join(defaults::text("webapi.history_file"))
}

fn actor() -> String {
    std::env::var(defaults::text("webapi.history_actor_env")).ok().filter(|a| !a.is_empty()).unwrap_or_else(|| "cli".to_string())
}

/// Append one audit row; the error is the reason it could not be written.
fn append(row: &Value) -> Result<(), String> {
    let path = history_path();
    if let Some(dir) = path.parent() {
        crate::limits::ensure_private_dir(dir).map_err(|e| e.to_string())?;
    }
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&path).map_err(|e| e.to_string())?;
    writeln!(f, "{row}").map_err(|e| e.to_string())
}

/// The audit rows in file order, from the end of the log (at most `webapi.history_read_max_bytes`).
fn read_rows() -> Vec<Value> {
    let Ok(mut f) = std::fs::File::open(history_path()) else { return Vec::new() };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let max = defaults::num("webapi.history_read_max_bytes");
    let start = len.saturating_sub(max);
    if start > 0 && f.seek(SeekFrom::Start(start)).is_err() {
        return Vec::new();
    }
    let mut bytes = Vec::new();
    if f.read_to_end(&mut bytes).is_err() {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&bytes);
    let mut lines = text.lines();
    if start > 0 {
        lines.next(); // the first line of a tail read is cut
    }
    lines.filter_map(|l| serde_json::from_str::<Value>(l).ok()).collect()
}

/// The audit log as a document: newest first, each row marked `undone` when a later undo row restored it.
pub(crate) fn history_doc() -> Value {
    let rows = read_rows();
    let undone: std::collections::BTreeSet<String> =
        rows.iter().filter(|r| r["verb"] == "undo" && r["result"] == "ok").filter_map(|r| r["undoes"].as_str().map(str::to_string)).collect();
    let out: Vec<Value> = rows
        .into_iter()
        .rev()
        .map(|mut r| {
            let was = r["id"].as_str().is_some_and(|id| undone.contains(id));
            r["undone"] = json!(was);
            r
        })
        .collect();
    json!({"rows": out, "file": history_path().to_string_lossy()})
}

/// `history [--limit N] [--key k] [--verb v]`: the newest rows.
pub fn history(rest: &[String]) -> Value {
    let mut doc = history_doc();
    let (key, op) = (flag(rest, "key"), flag(rest, "verb"));
    let limit = flag(rest, "limit").parse::<usize>().unwrap_or(defaults::num("webapi.page_default") as usize).min(defaults::num("webapi.page_max") as usize);
    if let Some(rows) = doc["rows"].as_array_mut() {
        rows.retain(|r| (key.is_empty() || r["key"] == key.as_str()) && (op.is_empty() || r["verb"] == op.as_str()));
        rows.truncate(limit);
    }
    doc
}

fn to_j(v: &Value) -> Option<J> {
    json::parse(&v.to_string(), defaults::num("setup.json_max_depth") as usize).ok()
}

/// Validate a text for the shipped engine setting `entry` and make its `settings.json` value.
fn validate_engine(entry: &defaults::Entry, raw: &str) -> Result<J, String> {
    let key = entry.key;
    match &entry.value {
        V::Int(_) => {
            let n: i64 = raw.trim().parse().map_err(|_| defaults::render("webapi.msg_bad_int", &[("key", &key), ("got", &raw)]))?;
            if let Some(min) = entry.min.filter(|m| n < *m) {
                return Err(defaults::render("webapi.msg_below_min", &[("key", &key), ("got", &n), ("min", &min)]));
            }
            if let Some(max) = entry.max.filter(|m| n > *m) {
                return Err(defaults::render("webapi.msg_above_max", &[("key", &key), ("got", &n), ("max", &max)]));
            }
            Ok(J::Num(n as f64))
        }
        V::Bool(_) => {
            let t = raw.trim().to_lowercase();
            if defaults::list("config.true_tokens").contains(&t.as_str()) {
                Ok(J::Bool(true))
            } else if defaults::list("config.false_tokens").contains(&t.as_str()) {
                Ok(J::Bool(false))
            } else {
                Err(defaults::render("webapi.msg_bad_bool", &[("key", &key), ("got", &raw)]))
            }
        }
        V::Str(_) => Ok(J::Str(raw.to_string())),
        V::List(_) => serde_json::from_str::<Vec<String>>(raw).map(|l| J::Arr(l.into_iter().map(J::Str).collect())).map_err(|_| defaults::render("webapi.msg_bad_list", &[("key", &key)])),
        V::Table(_) => Err(defaults::render("webapi.msg_not_scalar", &[("key", &key)])),
    }
}

/// Which store a key belongs to: a registry setting, or a shipped engine setting.
enum Target {
    Registry(&'static store::Entry, &'static str),
    Engine(&'static defaults::Entry),
}

fn target(key: &str) -> Result<Target, String> {
    if let Some((e, note)) = registry::registry_entry(key) {
        return Ok(Target::Registry(e, note));
    }
    match defaults::get(key) {
        Some(e) if cfgstore_locked(key) => Err(defaults::render("webapi.msg_locked", &[("key", &e.key)])),
        Some(e) => Ok(Target::Engine(e)),
        None => Err(defaults::render("webapi.msg_unknown_key", &[("key", &key)])),
    }
}

fn cfgstore_locked(key: &str) -> bool {
    crate::cfgstore::locked(key)
}

/// Record the write and build the result. An audit row that cannot be written is reported in the note: the write already happened.
fn finish(ctx: &crate::migrate::Ctx, op: &'static str, kind: &'static str, key: &str, prev: Option<Value>, undoes: Option<&str>, error: Option<String>) -> Written {
    let (section, name) = split(key).unwrap_or(("", ""));
    let value = store::file_value(ctx, section, name).as_ref().map(j_to_value);
    let ok = error.is_none();
    let id = format!("{:x}-{:x}", now_ms(), SEQ.fetch_add(1, Ordering::Relaxed));
    let row = json!({"id": id, "ts": now_ms(), "verb": op, "key": key, "kind": kind, "who": actor(), "old": prev, "new": value, "result": if ok { "ok" } else { "error" }, "error": error, "undoes": undoes});
    let mut note = error;
    if let Err(e) = append(&row) {
        note = Some(note.map_or(format!("audit not written: {e}"), |n| format!("{n}; audit not written: {e}")));
    } else if ok && kind == "engine" && crate::cfgstore::restart_only(key) {
        note = Some(defaults::text("webapi.msg_restart_only").to_string());
    }
    Written { ok, id, key: key.to_string(), op, kind, prev, value, warning: None, note }
}

fn refused(op: &'static str, kind: &'static str, key: &str, warning: Option<String>, note: Option<String>) -> Written {
    Written { ok: false, id: String::new(), key: key.to_string(), op, kind, prev: None, value: None, warning, note }
}

/// Set `key` to `raw`, validated, audited.
pub fn set(key: &str, raw: &str, confirmed: bool, check: bool) -> Result<Written, String> {
    let t = target(key)?;
    let ctx = registry::store_ctx();
    let (section, name) = split(key).ok_or_else(|| defaults::render("webapi.msg_unknown_key", &[("key", &key)]))?;
    let prev = store::file_value(&ctx, section, name).as_ref().map(j_to_value);
    if check {
        return Ok(dry_run(&t, key, raw, prev));
    }
    Ok(match t {
        Target::Registry(entry, note) => match store::set_cli(&ctx, entry, note, raw, confirmed) {
            Outcome::Done => finish(&ctx, "set", "registry", key, prev, None, None),
            Outcome::Needs(w) => refused("set", "registry", key, Some(w), None),
            Outcome::Fail(e) => finish(&ctx, "set", "registry", key, prev, None, Some(e)),
        },
        Target::Engine(entry) => match validate_engine(entry, raw) {
            Err(e) => finish(&ctx, "set", "engine", key, prev, None, Some(e)),
            Ok(v) => match store::write_raw(&ctx, section, name, Some(v)) {
                Outcome::Done => finish(&ctx, "set", "engine", key, prev, None, None),
                Outcome::Fail(e) | Outcome::Needs(e) => finish(&ctx, "set", "engine", key, prev, None, Some(e)),
            },
        },
    })
}

/// `set --check`: validate only. Nothing is written or recorded; a refusal is reported in `note`.
fn dry_run(t: &Target, key: &str, raw: &str, prev: Option<Value>) -> Written {
    let (kind, verdict) = match t {
        Target::Registry(entry, _) => ("registry", store::validate_msg(entry, &J::Str(raw.to_string())).map(|v| j_to_value(&v))),
        Target::Engine(entry) => ("engine", validate_engine(entry, raw).map(|v| j_to_value(&v))),
    };
    match verdict {
        Ok(v) => Written { ok: true, id: String::new(), key: key.to_string(), op: "check", kind, prev, value: Some(v), warning: None, note: None },
        Err(e) => Written { ok: false, id: String::new(), key: key.to_string(), op: "check", kind, prev, value: None, warning: None, note: Some(e) },
    }
}

/// Drop the `settings.json` override of `key` (the setting returns to the shipped value), audited.
pub fn reset(key: &str, confirmed: bool) -> Result<Written, String> {
    let t = target(key)?;
    let ctx = registry::store_ctx();
    let (section, name) = split(key).ok_or_else(|| defaults::render("webapi.msg_unknown_key", &[("key", &key)]))?;
    let prev = store::file_value(&ctx, section, name).as_ref().map(j_to_value);
    Ok(match t {
        Target::Registry(entry, note) => match store::reset_cli(&ctx, entry, note, confirmed) {
            Outcome::Done => finish(&ctx, "reset", "registry", key, prev, None, None),
            Outcome::Needs(w) => refused("reset", "registry", key, Some(w), None),
            Outcome::Fail(e) => finish(&ctx, "reset", "registry", key, prev, None, Some(e)),
        },
        Target::Engine(_) => match store::write_raw(&ctx, section, name, None) {
            Outcome::Done => finish(&ctx, "reset", "engine", key, prev, None, None),
            Outcome::Fail(e) | Outcome::Needs(e) => finish(&ctx, "reset", "engine", key, prev, None, Some(e)),
        },
    })
}

/// Restore the value before audit row `id`. Refused when the row failed, is itself an undo, was already undone, or the value
/// changed again since (unless `confirmed`).
pub fn undo(id: &str, confirmed: bool) -> Result<Written, String> {
    let doc = history_doc();
    let rows = doc["rows"].as_array().cloned().unwrap_or_default();
    let row = rows.iter().find(|r| r["id"] == id).ok_or_else(|| defaults::render("webapi.msg_no_history_row", &[("id", &id)]))?;
    if row["result"] != "ok" || row["verb"] == "undo" || row["undone"] == true {
        return Err(defaults::render("webapi.msg_undo_not_undoable", &[("id", &id)]));
    }
    let key = row["key"].as_str().unwrap_or_default().to_string();
    let kind: &'static str = if row["kind"] == "registry" { "registry" } else { "engine" };
    let (section, name) = split(&key).ok_or_else(|| defaults::render("webapi.msg_unknown_key", &[("key", &key)]))?;
    let ctx = registry::store_ctx();
    let current = store::file_value(&ctx, section, name).as_ref().map(j_to_value);
    let expected = if row["new"].is_null() { None } else { Some(row["new"].clone()) };
    if current != expected && !confirmed {
        return Ok(refused("undo", kind, &key, None, Some(defaults::render("webapi.msg_undo_changed", &[("key", &key)]))));
    }
    let restore = if row["old"].is_null() { None } else { to_j(&row["old"]) };
    Ok(match store::write_raw(&ctx, section, name, restore) {
        Outcome::Done => finish(&ctx, "undo", kind, &key, current, Some(id), None),
        Outcome::Fail(e) | Outcome::Needs(e) => finish(&ctx, "undo", kind, &key, current, Some(id), Some(e)),
    })
}
