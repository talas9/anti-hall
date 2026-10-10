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
