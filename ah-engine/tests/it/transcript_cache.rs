use ah_engine::{defaults, script::host_transcript};
use std::sync::{Mutex, OnceLock};

fn lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(())).lock().unwrap()
}

fn scratch(name: &str) -> std::path::PathBuf {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis();
    let d = std::env::temp_dir().join(format!("ah-it-transcript-cache-{name}-{}-{now}", std::process::id()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

#[test]
fn transcript_tail_cache_stays_under_the_configured_byte_cap() {
    let _guard = lock();
    host_transcript::clear_cache();
    let cap = defaults::num("script.transcript_cache_max_bytes") as usize;
    let dir = scratch("cap");
    let payload = "x".repeat((cap / 2).max(1024));
    for n in 0..4 {
        let path = dir.join(format!("t{n}.jsonl"));
        let line = serde_json::json!({
            "timestamp": format!("2026-10-06T12:00:0{n}.000Z"),
            "hook_additional_context": [{"type": "text", "text": payload}]
        });
        std::fs::write(&path, format!("{line}\n")).unwrap();
        let _ = host_transcript::dedupe_tail(path.to_str().unwrap(), cap as f64);
    }
    let (_, bytes) = host_transcript::cache_usage();
    assert!(bytes <= cap, "transcript-tail cache held {bytes} bytes, over configured cap {cap}");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn transcript_tail_large_answers_do_not_grow_allocator_after_warmup() {
    let _guard = lock();
    host_transcript::clear_cache();
    let (calls, band) = ah_engine::memdiag::regression_limits();
    let calls = calls as usize;
    let cap = defaults::num("script.transcript_cache_max_bytes") as usize;
    let dir = scratch("alloc");
    let path = dir.join("large-read-only.jsonl");
    let payload = "x".repeat((cap / 2).max(1024 * 1024));
    {
        let mut lines = Vec::new();
        for n in 0..128 {
            lines.push(
                serde_json::json!({
                    "type": "assistant",
                    "timestamp": format!("2026-10-06T11:{:02}:{:02}.000Z", (n / 60) % 60, n % 60),
                    "message": {"role":"assistant","content":[{"type":"text","text":"filler"}]}
                })
                .to_string(),
            );
        }
        let line = serde_json::json!({
            "type": "attachment",
            "timestamp": "2026-10-06T12:00:00.000Z",
            "attachment": {"type":"hook_additional_context","hookEvent":"UserPromptSubmit","content":[payload]}
        });
        lines.push(line.to_string());
        std::fs::write(&path, lines.join("\n") + "\n").unwrap();
        let mut perms = std::fs::metadata(&path).unwrap().permissions();
        perms.set_readonly(true);
        std::fs::set_permissions(&path, perms).unwrap();
    }
    let window = (payload.len() + 4096) as u64;
    for n in 0..calls {
        let _ = host_transcript::dedupe_tail(path.to_str().unwrap(), (window + n as u64) as f64);
    }
    let Some((metric, warm)) = memory_metric() else {
        cleanup(&path, &dir);
        return;
    };
    for n in calls..(calls * 2) {
        let _ = host_transcript::dedupe_tail(path.to_str().unwrap(), (window + n as u64) as f64);
    }
    let end = memory_metric().map(|(_, n)| n).unwrap_or(warm);
    let (_, bytes) = host_transcript::cache_usage();
    cleanup(&path, &dir);
    assert!(bytes <= cap, "transcript-tail cache held {bytes} bytes, over configured cap {cap}");
    assert!(end <= warm + band, "{metric} grew from {warm} to {end}, above configured band {band}");
}

fn memory_metric() -> Option<(&'static str, u64)> {
    ah_engine::memdiag::allocator()
        .map(|a| ("jemalloc allocated", a.allocated))
        .or_else(|| ah_engine::limits::footprint_kb().map(|kb| ("footprint", kb * 1024)))
}

fn cleanup(path: &std::path::Path, dir: &std::path::Path) {
    let _ = path;
    std::fs::remove_dir_all(dir).ok();
}
