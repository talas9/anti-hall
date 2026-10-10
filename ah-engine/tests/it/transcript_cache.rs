use ah_engine::{defaults, script::host_transcript};
use std::path::PathBuf;

#[test]
fn transcript_tail_large_answers_stay_within_the_configured_memory_band() {
    let transcript = measure_transcript();
    let calls = defaults::num("diagnostics.mem_regression_calls") as usize;
    let band = defaults::num("diagnostics.mem_regression_growth_bytes");
    let max_bytes = defaults::num("script.transcript_cache_max_bytes");
    let tail_max = defaults::num("script.tail_max_bytes");
    let transcript_bytes = std::fs::metadata(&transcript).map(|m| m.len()).unwrap_or(0);
    assert!(
        transcript_bytes + calls as u64 <= tail_max,
        "script.tail_max_bytes={tail_max} must cover transcript_len={transcript_bytes} plus {calls} distinct windows"
    );
    let windows = distinct_windows(transcript_bytes, calls);
    let Some(baseline) = jemalloc_allocated() else {
        return;
    };
    let mut max = baseline;
    let (mut peak_entries, mut peak_cache_bytes) = (0usize, 0usize);

    for (idx, window) in windows.iter().enumerate() {
        let answer = host_transcript::dedupe_tail(transcript.to_str().unwrap(), *window as f64);
        if idx == 0 {
            let payload = answer.len() as u64;
            let retained = payload.saturating_mul(calls.saturating_sub(1) as u64);
            assert!(
                payload > 0 && payload < max_bytes && retained > band,
                "invalid AH_CACHE_MEASURE_TRANSCRIPT fixture: first cached payload={payload}, script.transcript_cache_max_bytes={max_bytes}, retained={retained}, growth_band={band}"
            );
        }
        drop(answer);
        let (entries, bytes) = host_transcript::cache_usage();
        peak_entries = peak_entries.max(entries);
        peak_cache_bytes = peak_cache_bytes.max(bytes);
        if let Some(now) = jemalloc_allocated() {
            max = max.max(now);
        }
    }
    let growth = max.saturating_sub(baseline);
    assert!(
        growth <= band,
        "jemalloc allocated max growth was {growth} bytes from baseline {baseline} to max {max}, above configured band {band}; peak_cache_bytes={peak_cache_bytes}, peak_cache_entries={peak_entries}"
    );
    assert!(
        peak_cache_bytes as u64 <= max_bytes,
        "transcript-tail cache peak {peak_cache_bytes} bytes with {peak_entries} entries exceeded script.transcript_cache_max_bytes={max_bytes}"
    );
}

fn measure_transcript() -> PathBuf {
    let p = std::env::var("AH_CACHE_MEASURE_TRANSCRIPT")
        .map(PathBuf::from)
        .expect("AH_CACHE_MEASURE_TRANSCRIPT must point at the shared read-only large transcript");
    assert!(p.is_absolute(), "AH_CACHE_MEASURE_TRANSCRIPT must be absolute");
    let meta = std::fs::metadata(&p).unwrap_or_else(|e| panic!("AH_CACHE_MEASURE_TRANSCRIPT is not readable: {e}"));
    assert!(meta.is_file(), "AH_CACHE_MEASURE_TRANSCRIPT must be a file");
    assert!(meta.permissions().readonly(), "AH_CACHE_MEASURE_TRANSCRIPT must be read-only");
    p
}

fn distinct_windows(transcript_bytes: u64, count: usize) -> Vec<u64> {
    let start = transcript_bytes;
    (0..count).map(|i| start + i as u64).collect()
}

#[cfg(any(all(target_os = "macos", target_arch = "aarch64"), all(target_os = "linux", target_env = "gnu")))]
fn jemalloc_allocated() -> Option<u64> {
    use tikv_jemalloc_sys::mallctl;

    fn read(name: &str) -> Option<u64> {
        let key = std::ffi::CString::new(name).ok()?;
        let mut v: usize = 0;
        let mut len = std::mem::size_of::<usize>();
        // SAFETY: `key` is NUL-terminated, `v` is a writable `usize`, and no new value is written.
        let rc = unsafe { mallctl(key.as_ptr(), (&mut v as *mut usize).cast(), &mut len, std::ptr::null_mut(), 0) };
        (rc == 0).then_some(v as u64)
    }

    let key = std::ffi::CString::new("epoch").ok()?;
    let mut new: u64 = 1;
    let mut old: u64 = 0;
    let mut len = std::mem::size_of::<u64>();
    // SAFETY: `epoch` is a valid jemalloc mallctl key; `old` and `new` are `u64` values with their exact byte size.
    unsafe { mallctl(key.as_ptr(), (&mut old as *mut u64).cast(), &mut len, (&mut new as *mut u64).cast(), std::mem::size_of::<u64>()) };
    read("stats.allocated")
}

#[cfg(not(any(all(target_os = "macos", target_arch = "aarch64"), all(target_os = "linux", target_env = "gnu"))))]
fn jemalloc_allocated() -> Option<u64> {
    None
}
