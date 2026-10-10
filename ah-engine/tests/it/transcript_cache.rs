use ah_engine::{defaults, script::host_transcript};

fn scratch(name: &str) -> std::path::PathBuf {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis();
    let d = std::env::temp_dir().join(format!("ah-it-transcript-cache-{name}-{}-{now}", std::process::id()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

#[test]
fn transcript_tail_cache_stays_under_the_configured_byte_cap() {
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
    host_transcript::clear_cache();
    let (calls, band) = ah_engine::memdiag::regression_limits();
    let calls = calls as usize;
    let cap = defaults::num("script.transcript_cache_max_bytes") as usize;
    let dir = scratch("alloc");
    let payload = "x".repeat((cap / 2).max(1024 * 1024));
    let mut paths = Vec::new();
    for n in 0..(calls * 2) {
        let path = dir.join(format!("large-{n}.jsonl"));
        let line = serde_json::json!({
            "type": "attachment",
            "timestamp": format!("2026-10-06T12:{:02}:{:02}.000Z", (n / 60) % 60, n % 60),
            "attachment": {"type":"hook_additional_context","hookEvent":"UserPromptSubmit","content":[payload]}
        });
        std::fs::write(&path, format!("{line}\n")).unwrap();
        paths.push(path);
    }
    for path in paths.iter().take(calls) {
        let _ = host_transcript::dedupe_tail(path.to_str().unwrap(), cap as f64);
    }
    let Some(warm) = ah_engine::memdiag::allocator().map(|a| a.allocated) else {
        std::fs::remove_dir_all(&dir).ok();
        return;
    };
    for path in paths.iter().skip(calls) {
        let _ = host_transcript::dedupe_tail(path.to_str().unwrap(), cap as f64);
    }
    let end = ah_engine::memdiag::allocator().map(|a| a.allocated).unwrap_or(warm);
    let (_, bytes) = host_transcript::cache_usage();
    std::fs::remove_dir_all(&dir).ok();
    assert!(bytes <= cap, "transcript-tail cache held {bytes} bytes, over configured cap {cap}");
    assert!(end <= warm + band, "jemalloc allocated grew from {warm} to {end}, above configured band {band}");
}
