//! #857 R5/R6: the Stop memo. A Stop dispatch whose every check answered quiet is remembered per session, keyed by the request and
//! the state it reads (the transcript's length and tail, the task and settings stamps of `stopmemo.stamp_paths`, the defaults
//! generation, the host, the entry filter); the same key again inside `stopmemo.ttl_ms` returns that answer without running the
//! checks. A block or an advisory is never remembered: a repeated block escalates, so it must run. Every value is in `defaults/stopmemo.toml`.
use super::native::{Answer, Meta};
use crate::defaults;
use serde_json::Value;
use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::io::{Read, Seek, SeekFrom};
use std::sync::Mutex;
use std::time::Instant;

type Answers = Vec<(String, Answer)>;
type Remembered = (u64, Instant, Answers);
/// session id -> (key, when remembered, answers)
static MEMO: Mutex<Option<HashMap<String, Remembered>>> = Mutex::new(None);

/// Whether the memo applies to this dispatch.
pub fn applies(meta: &Meta, p: &Value) -> bool {
    defaults::num("stopmemo.enabled") == 1 && defaults::list("stopmemo.events").contains(&meta.event.as_str()) && session(p).is_some()
}

fn session(p: &Value) -> Option<&str> {
    p.get("session_id").and_then(Value::as_str).filter(|s| !s.is_empty())
}

fn stamp_path(h: &mut DefaultHasher, path: &std::path::Path) {
    let one = |h: &mut DefaultHasher, m: &std::fs::Metadata| {
        m.len().hash(h);
        m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_nanos()).hash(h);
    };
    match std::fs::metadata(path) {
        Err(_) => 0u8.hash(h),
        Ok(m) if m.is_dir() => {
            1u8.hash(h);
            let mut rows: Vec<(String, u64, Option<u128>)> = std::fs::read_dir(path)
                .into_iter()
                .flatten()
                .flatten()
                .filter_map(|e| {
                    let m = e.metadata().ok()?;
                    let t = m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_nanos());
                    Some((e.file_name().to_string_lossy().into_owned(), m.len(), t))
                })
                .collect();
            rows.sort();
            rows.hash(h);
        }
        Ok(m) => {
            2u8.hash(h);
            one(h, &m);
        }
    }
}

/// The key of this request and the state it reads.
pub(crate) fn key(meta: &Meta, p: &Value) -> u64 {
    let mut h = DefaultHasher::new();
    defaults::generation().hash(&mut h);
    (&meta.host, &meta.event, &meta.only).hash(&mut h);
    for f in ["stop_hook_active", "last_assistant_message", "cwd"] {
        p.get(f).map(Value::to_string).hash(&mut h);
    }
    if let Some(t) = p.get("transcript_path").and_then(Value::as_str).filter(|t| !t.is_empty()) {
        t.hash(&mut h);
        match std::fs::File::open(t) {
            Ok(mut f) => {
                let len = f.metadata().map(|m| m.len()).unwrap_or(0);
                len.hash(&mut h);
                let tail = defaults::num("stopmemo.tail_bytes");
                let mut buf = Vec::new();
                if f.seek(SeekFrom::Start(len.saturating_sub(tail))).is_ok() {
                    crate::discard::harmless(f.take(tail).read_to_end(&mut buf)); // keep: an unreadable tail hashes as what was read
                }
                buf.hash(&mut h);
            }
            Err(_) => u64::MAX.hash(&mut h),
        }
    }
    let home = std::env::var(defaults::text("stopmemo.home_env")).unwrap_or_default();
    let sid = session(p).unwrap_or_default();
    for tpl in defaults::list("stopmemo.stamp_paths") {
        let path = tpl.replace("{home}", &home).replace("{session_id}", sid);
        stamp_path(&mut h, std::path::Path::new(&path));
    }
    h.finish()
}

fn quiet(a: &Answers) -> bool {
    a.iter().all(|(_, a)| matches!(a, Answer::Decided(r, routes) if matches!(r.code, None | Some(0)) && r.out.is_empty() && r.err.is_empty() && routes.is_empty()))
}

fn count(event: &str, outcome_key: &str) {
    crate::metrics::bump("stopmemo", &[("event", event), ("outcome", defaults::text(outcome_key))]);
}

/// The remembered answers for this request, if its key is unchanged and still inside the ttl.
pub fn recall(meta: &Meta, p: &Value, k: u64) -> Option<Answers> {
    let sid = session(p)?;
    let hit = MEMO.lock().ok()?.as_ref()?.get(sid).filter(|(key, at, _)| *key == k && at.elapsed().as_millis() as u64 <= defaults::num("stopmemo.ttl_ms")).map(|(_, _, a)| a.clone());
    count(&meta.event, if hit.is_some() { "stopmemo.outcome_hit" } else { "stopmemo.outcome_miss" });
    hit
}

/// Remember `answers` under `k` when every one was quiet; anything else forgets the session's entry.
pub fn store(meta: &Meta, p: &Value, k: u64, answers: &Answers) {
    let Some(sid) = session(p) else { return };
    let Ok(mut g) = MEMO.lock() else { return };
    let map = g.get_or_insert_with(HashMap::new);
    if !quiet(answers) || answers.is_empty() {
        map.remove(sid);
        return;
    }
    let max = defaults::num("stopmemo.max_sessions") as usize;
    if map.len() >= max && !map.contains_key(sid) && let Some(old) = map.iter().min_by_key(|(_, (_, at, _))| *at).map(|(s, _)| s.clone()) {
        map.remove(&old);
    }
    map.insert(sid.to_string(), (k, Instant::now(), answers.clone()));
    count(&meta.event, "stopmemo.outcome_stored");
}

#[cfg(test)]
mod tests;
