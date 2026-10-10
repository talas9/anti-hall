//! Bounded transcript-tail primitive for the task family (L10a). A script that must scan hundreds of kilobytes of transcript
//! cannot do it inside its CPU limit (task-tracker was interrupted on 94 of 119 prompt calls scanning a 4 MB window line by line),
//! so the host reads the window and returns only the facts. The result per (path, window bytes) is cached by file size and
//! modification time, so a repeat call for an unchanged transcript costs nothing.
//!
//! | raw function | what it does |
//! |---|---|
//! | `transcriptDedupeTail(path, bytes)` | the delivered hook-context attachments of the last `bytes` of a transcript: see [`dedupe_tail`] |

use crate::checks::emit_dedupe::scan_tail;
use rquickjs::{Ctx, Function, Object};
use serde_json::json;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

type Key = (String, u64);
type Stamp = (u64, std::time::SystemTime);

/// Last answer per (path, window): valid while the file keeps its size and modification time.
static CACHE: OnceLock<Mutex<HashMap<Key, (Stamp, String)>>> = OnceLock::new();

fn cache() -> std::sync::MutexGuard<'static, HashMap<Key, (Stamp, String)>> {
    CACHE.get_or_init(|| Mutex::new(HashMap::new())).lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn stamp_of(path: &str) -> Option<Stamp> {
    let m = std::fs::metadata(path).ok()?;
    Some((m.len(), m.modified().ok()?))
}

/// `dedupe_tail(path, bytes)`: JSON text. `null` when the transcript is unusable (missing, unreadable, empty, or no timestamp
/// anywhere in the window); `{"unsure":true}` when a line or timestamp only JavaScript reads exactly (the script defers);
/// else `{"size":n,"atts":[{"ts":ms,"els":[...]}]}` for the `hook_additional_context` attachments of the window, in order.
/// The window is capped by `script.tail_max_bytes`; the answer is cached per path and window until the file changes.
pub fn dedupe_tail(path: &str, bytes: f64) -> String {
    if !path.starts_with('/') {
        return r#"{"unsure":true}"#.into();
    }
    let cap = crate::defaults::num("script.tail_max_bytes");
    let n = if bytes.is_finite() && bytes > 0.0 { (bytes as u64).min(cap) } else { cap };
    let stamp = stamp_of(path);
    if let Some(st) = stamp {
        if let Some(hit) = cache().get(&(path.to_string(), n)).filter(|(s, _)| *s == st).map(|(_, r)| r.clone()) {
            return hit;
        }
    }
    let out = match scan_tail(path, n) {
        Err(_) => r#"{"unsure":true}"#.to_string(),
        Ok(None) => "null".to_string(),
        Ok(Some(t)) => json!({"size": t.size, "atts": t.atts.iter().map(|a| json!({"ts": a.ts, "els": a.els})).collect::<Vec<_>>()}).to_string(),
    };
    if let (Some(st), false) = (stamp, out.contains("unsure")) {
        let mut c = cache();
        if c.len() >= crate::defaults::num("script.transcript_cache_entries") as usize {
            c.clear();
        }
        c.insert((path.to_string(), n), (st, out.clone()));
    }
    out
}

/// Add the task-family transcript functions to `ahHost`.
pub fn install<'a>(c: &Ctx<'a>, h: &Object<'a>) -> rquickjs::Result<()> {
    h.set("transcriptDedupeTail", Function::new(c.clone(), |p: String, b: f64| dedupe_tail(&p, b))?)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn att(ts: &str, content: &str) -> String {
        json!({"type":"attachment","timestamp":ts,"attachment":{"type":"hook_additional_context","hookEvent":"UserPromptSubmit","content":[content]}}).to_string()
    }

    fn scratch(tag: &str) -> String {
        let d = std::env::temp_dir().join(format!("ah-ht-{tag}-{}", std::process::id()));
        crate::discard::harmless(std::fs::remove_dir_all(&d));
        std::fs::create_dir_all(&d).unwrap();
        d.join("t.jsonl").to_string_lossy().to_string()
    }

    #[test]
    fn ht_01_returns_the_delivered_attachments_in_order() {
        let p = scratch("a");
        std::fs::write(&p, [att("2026-01-01T00:00:00.000Z", "one"), att("2026-01-01T00:00:01.000Z", "two")].join("\n") + "\n").unwrap();
        let v: serde_json::Value = serde_json::from_str(&dedupe_tail(&p, 1048576.0)).unwrap();
        assert_eq!(v["atts"].as_array().unwrap().len(), 2);
        assert_eq!(v["atts"][0]["els"][0], "one");
        assert_eq!(v["atts"][1]["ts"].as_f64(), Some(1_767_225_601_000.0));
    }

    #[test]
    fn ht_02_unusable_and_unsure_answers() {
        let p = scratch("b");
        assert_eq!(dedupe_tail(&p, 1024.0), "null", "missing file");
        std::fs::write(&p, "{\"type\":\"assistant\"}\n").unwrap();
        assert_eq!(dedupe_tail(&p, 1024.0), "null", "no timestamp anywhere");
        std::fs::write(&p, att("2026-01-01 00:00:00", "x") + "\n").unwrap();
        assert!(dedupe_tail(&p, 1024.0).contains("unsure"), "a timestamp form only V8 reads");
        assert!(dedupe_tail("rel/t.jsonl", 1024.0).contains("unsure"), "relative path");
    }

    #[test]
    fn ht_03_cache_follows_the_file() {
        let p = scratch("c");
        std::fs::write(&p, att("2026-01-01T00:00:00.000Z", "one") + "\n").unwrap();
        let a = dedupe_tail(&p, 1048576.0);
        assert_eq!(a, dedupe_tail(&p, 1048576.0));
        std::fs::write(&p, [att("2026-01-01T00:00:00.000Z", "one"), att("2026-01-01T00:00:02.000Z", "three")].join("\n") + "\n").unwrap();
        let b: serde_json::Value = serde_json::from_str(&dedupe_tail(&p, 1048576.0)).unwrap();
        assert_eq!(b["atts"].as_array().unwrap().len(), 2, "a grown file is rescanned");
    }
}
