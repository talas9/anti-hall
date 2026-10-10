//! Bounded transcript-tail primitive for the task family (L10a). A script that must scan hundreds of kilobytes of transcript
//! cannot do it inside its CPU limit (task-tracker was interrupted on 94 of 119 prompt calls scanning a 4 MB window line by line),
//! so the host reads the window and returns only the facts. The result per (path, window bytes) is cached by file size and
//! modification time, so a repeat call for an unchanged transcript costs nothing.
//!
//! | raw function | what it does |
//! |---|---|
//! | `transcriptDedupeTail(path, bytes)` | the delivered hook-context attachments of the last `bytes` of a transcript: see [`dedupe_tail`] |
//! | `transcriptGrep(path, bytes, needles, re, flags)` | the lines of the last `bytes` that hold every needle (and match the pattern): see [`grep`] |
//! | `agentCountProof(path)` | the running agents with what the scan saw, for an unknown count: see [`count_proof`] |
//! | `jevCachePeek(hash)` | the answer and confidence of the Jev cache entry under `hash`: see [`cache_peek`] |

use crate::checks::emit_dedupe::scan_tail;
use moka::sync::{Cache, CacheBuilder};
use rquickjs::{Ctx, Function, Object};
use serde_json::json;
use std::sync::{Mutex, OnceLock};

type Key = (String, u64);
type Stamp = (u64, std::time::SystemTime);

#[derive(Clone)]
struct Entry {
    stamp: Stamp,
    answer: String,
    weight: u32,
}

fn entry_weight(key: &Key, answer: &str) -> u32 {
    (key.0.len() + std::mem::size_of::<u64>() + answer.len()).min(u32::MAX as usize) as u32
}

/// Last answer per (path, window): valid while the file keeps its size and modification time.
static CACHE: OnceLock<Mutex<TranscriptCache>> = OnceLock::new();

struct TranscriptCache {
    cap: u64,
    cache: Cache<Key, Entry>,
}

fn new_cache(cap: u64) -> Cache<Key, Entry> {
    CacheBuilder::new(cap).weigher(|_k: &Key, v: &Entry| v.weight).build()
}

fn with_cache<R>(f: impl FnOnce(&Cache<Key, Entry>) -> R) -> R {
    let mut g = CACHE
        .get_or_init(|| {
            let cap = crate::defaults::num("script.transcript_cache_max_bytes");
            Mutex::new(TranscriptCache { cap, cache: new_cache(cap) })
        })
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let cap = crate::defaults::num("script.transcript_cache_max_bytes");
    if g.cap != cap {
        *g = TranscriptCache { cap, cache: new_cache(cap) };
    }
    f(&g.cache)
}

/// (entries, bytes of cached answers) of the transcript-tail cache, for the memory snapshot.
pub fn cache_usage() -> (usize, usize) {
    with_cache(|c| {
        c.run_pending_tasks();
        (c.entry_count() as usize, c.weighted_size() as usize)
    })
}

/// Clear the transcript-tail cache (test support and daemon reload hygiene).
pub fn clear_cache() {
    with_cache(|c| c.invalidate_all());
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
    let key = (path.to_string(), n);
    if let Some(st) = stamp
        && let Some(hit) = with_cache(|c| c.get(&key)).filter(|e| e.stamp == st).map(|e| e.answer)
    {
        return hit;
    }
    let out = match scan_tail(path, n) {
        Err(_) => r#"{"unsure":true}"#.to_string(),
        Ok(None) => "null".to_string(),
        Ok(Some(t)) => json!({"size": t.size, "atts": t.atts.iter().map(|a| json!({"ts": a.ts, "els": a.els})).collect::<Vec<_>>()}).to_string(),
    };
    if let (Some(st), false) = (stamp, out.contains("unsure")) {
        let weight = entry_weight(&key, &out);
        with_cache(|c| c.insert(key, Entry { stamp: st, answer: out.clone(), weight }));
    }
    out
}

/// `grep(path, bytes, needles, re, flags)`: JSON text. The lines of the last `bytes` of a transcript (capped by
/// `script.tail_max_bytes`; a window that cuts the file drops its first, partial line; lines split on `\n` alone, as a script's
/// `tail.split('\n')` splits) that contain every string of the JSON array `needles` and, when `re` is not empty, match the
/// pattern. `{"lines":[...]}`; `null` when the file is missing or unreadable; `{"unsure":true}` for a relative path or when the
/// lines are more than `script.grep_max_bytes` (the script then defers: it asked for too little to filter on).
pub fn grep(path: &str, bytes: f64, needles: &str, re: &str, flags: &str) -> rquickjs::Result<String> {
    if !path.starts_with('/') {
        return Ok(r#"{"unsure":true}"#.into());
    }
    let Ok(needles) = serde_json::from_str::<Vec<String>>(needles) else { return Ok(r#"{"unsure":true}"#.into()) };
    let cap = crate::defaults::num("script.tail_max_bytes");
    let n = if bytes.is_finite() && bytes > 0.0 { (bytes as u64).min(cap) } else { cap };
    let Some(tail) = crate::checks::replykit::io::read_window(path, n) else { return Ok("null".into()) };
    let mut lines = tail.data.split('\n');
    if tail.truncated {
        lines.next();
    }
    let max = crate::defaults::num("script.grep_max_bytes") as usize;
    let mut total = 0usize;
    let mut out: Vec<&str> = Vec::new();
    for line in lines {
        if !needles.iter().all(|nd| line.contains(nd.as_str())) {
            continue;
        }
        if !re.is_empty() && !super::host::with_re(re, flags, |r| r.is_match(line))? {
            continue;
        }
        total += line.len();
        if total > max {
            return Ok(r#"{"unsure":true}"#.into());
        }
        out.push(line);
    }
    Ok(json!({"lines": out}).to_string())
}

/// `count_proof(path)`: JSON text. `{"unsure":true}` for a relative path or a line JavaScript might read differently; else
/// `{"rows":[{"id","description"}]|null,"seen":[ids],"windowBytes":n}` as `agentCountProof` of the Node scan returns it (`rows`
/// null: the count cannot be trusted; `seen`: the ids the scanned window shows launched; `windowBytes`: 0 when the default
/// window held the answer, else the window the proof covers).
pub fn count_proof(path: &str) -> String {
    use crate::checks::agent_scan;
    if !path.starts_with('/') {
        return r#"{"unsure":true}"#.into();
    }
    let opts = agent_scan::Opts { now_ms: super::host::now_ms(), ignore_unanswered_stops: false };
    match agent_scan::agent_count_proof(path, &opts) {
        Err(_) => r#"{"unsure":true}"#.into(),
        Ok(p) => json!({
            "rows": p.rows.map(|r| r.iter().map(|x| json!({"id": x.id, "description": x.description})).collect::<Vec<_>>()),
            "seen": p.seen,
            "windowBytes": p.window_bytes,
        })
        .to_string(),
    }
}

/// `cache_peek(hash)`: JSON text. What the dispatch-tier annotator reads of the shared Jev cache entry under `hash`: `null`
/// when there is no truthy entry, `{"unsure":true}` when the file is one only JavaScript reads, else
/// `{"answer": string|null, "confidence": number|null}`.
pub fn cache_peek(hash: &str) -> rquickjs::Result<String> {
    let home = super::host::with_settings(|st| st.home.clone())?;
    Ok(match crate::jev::cache::FileCache::for_home(std::path::Path::new(&home)).peek(hash) {
        None => r#"{"unsure":true}"#.into(),
        Some(None) => "null".into(),
        Some(Some((answer, confidence))) => json!({"answer": answer, "confidence": confidence}).to_string(),
    })
}

/// Add the task-family transcript functions to `ahHost`.
pub fn install<'a>(c: &Ctx<'a>, h: &Object<'a>) -> rquickjs::Result<()> {
    h.set("transcriptDedupeTail", Function::new(c.clone(), |p: String, b: f64| dedupe_tail(&p, b))?)?;
    h.set("transcriptGrep", Function::new(c.clone(), |p: String, b: f64, nd: String, re: String, fl: String| grep(&p, b, &nd, &re, &fl))?)?;
    h.set("agentCountProof", Function::new(c.clone(), |p: String| count_proof(&p))?)?;
    h.set("jevCachePeek", Function::new(c.clone(), |hsh: String| cache_peek(&hsh))?)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn att(ts: &str, content: &str) -> String {
        json!({"type":"attachment","timestamp":ts,"attachment":{"type":"hook_additional_context","hookEvent":"UserPromptSubmit","content":[content]}})
            .to_string()
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

    #[test]
    fn ht_04_cache_stays_under_the_byte_cap() {
        for i in 0..40 {
            let p = scratch(&format!("cap-{i}"));
            let body = "x".repeat(300_000);
            std::fs::write(&p, att("2026-01-01T00:00:00.000Z", &body) + "\n").unwrap();
            let _ = dedupe_tail(&p, 1048576.0);
        }
        let (_, bytes) = cache_usage();
        assert!(bytes as u64 <= crate::defaults::num("script.transcript_cache_max_bytes"), "cache held {bytes} bytes, over configured cap");
    }
}
