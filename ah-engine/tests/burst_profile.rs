//! Burst allocation-site profile: a synthetic check allocates a burst, exactly one dump is written and it names the allocating function.
//! One test binary of its own: the profiler is process-wide.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report
#![allow(clippy::panic, clippy::unreachable)] // integration tests: a panic is the failure report

mod common;

use ah_engine::burst::{self, Config, Ctx, Outcome};
use ah_engine::memstat::Counting;
use std::hint::black_box;
use std::sync::{Mutex, MutexGuard};

/// The profiler is process-wide and the tests of this binary run on parallel threads: one at a time.
static ONE_AT_A_TIME: Mutex<()> = Mutex::new(());

fn serial() -> MutexGuard<'static, ()> {
    ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner())
}

#[global_allocator]
static ALLOC: Counting = Counting;

#[inline(never)]
fn synthetic_burst_allocator() -> Vec<Vec<u8>> {
    (0..8).map(|i| black_box(vec![i as u8 + 1; 4 * 1024 * 1024])).collect()
}

fn cfg() -> Config {
    Config {
        on: true,
        sample_bytes: 256 * 1024,
        dump_bytes: 16 * 1024 * 1024,
        window_ms: 60_000,
        window_max_ms: 120_000,
        max_per_hour: 1,
        rate_window_ms: 3_600_000,
        keep: 2,
        sites: 128,
        frames: 24,
        dump_sites: 16,
        recent: 4,
    }
}

#[test]
fn a_burst_writes_one_dump_naming_the_allocating_function() {
    let _one = serial();
    let dir = std::env::temp_dir().join(format!("ah-burst-test-{}", std::process::id()));
    burst::set_dump_dir(Some(dir.clone()));
    burst::forget_dumps();
    burst::configure(&Config { on: false, ..cfg() });
    burst::configure(&cfg()); // switching on opens the window: no warm-up request is needed

    burst::begin();
    let held = synthetic_burst_allocator(); // 32 MB inside the window
    burst::note_check("synthetic-check", 32 * 1024 * 1024);
    let out = burst::request_end(&Ctx { event: "PreToolUse", busy: 1 });
    let Some(Outcome::Written(path)) = out else { panic!("expected a dump, got {out:?}") };

    let files: Vec<_> = std::fs::read_dir(&dir).unwrap().collect();
    assert_eq!(files.len(), 1, "exactly one dump file");
    let doc: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(doc["event"], "PreToolUse");
    // the dump names the build it came from, so its symbols can be found later
    assert_eq!(doc["build"]["version"], env!("CARGO_PKG_VERSION"));
    assert!(doc["build"]["image_base"].as_str().is_some_and(|b| b.starts_with("0x") && b != "0x0"), "{}", doc["build"]);
    assert!(doc["build"]["exe"].as_str().is_some());
    if cfg!(target_os = "macos") {
        assert!(doc["build"]["build_id"].as_str().is_some_and(|u| u.len() == 36), "a Mach-O UUID: {}", doc["build"]);
    }
    assert_eq!(doc["checks"][0]["check"], "synthetic-check");
    let text = doc["sites"].to_string();
    assert!(text.contains("synthetic_burst_allocator"), "the dump names the allocating function: {text}");

    // a second burst in the same hour is suppressed, not written
    burst::begin();
    let held2 = synthetic_burst_allocator(); // the first burst is still held, so the window base includes it
    assert_eq!(burst::request_end(&Ctx { event: "PreToolUse", busy: 1 }), Some(Outcome::Suppressed));
    drop(black_box((held, held2)));
    assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1, "still one file");
    std::fs::remove_dir_all(&dir).ok(); // keep: the test's own scratch directory
}

/// Cost of the allocation hook: alloc+free pairs of a QuickJS-sized block with the profile off and on (printed; the bound is loose).
#[test]
fn the_hook_costs_little_per_allocation() {
    let _one = serial();
    use std::time::Instant;
    const N: u64 = 2_000_000;
    let run = || {
        let t = Instant::now();
        for _ in 0..N {
            black_box(vec![0u8; black_box(4096)]);
        }
        t.elapsed().as_nanos() as f64 / N as f64
    };
    burst::configure(&Config { on: false, ..cfg() });
    let off = run();
    burst::configure(&cfg());
    let on = run();
    println!("ns per 4 KiB alloc+free: off {off:.1}, on {on:.1} (sampling every {} KiB)", cfg().sample_bytes / 1024);
    assert!(on < off * 4.0 + 500.0, "off {off} on {on}");
}

/// A heap that is already big when the profile turns on is the baseline, not growth: the first request with no burst writes nothing.
/// (The window used to start at 0, so the first request counted the whole heap as one burst.)
#[test]
fn the_first_request_after_switch_on_does_not_count_the_existing_heap_as_growth() {
    let _one = serial();
    let dir = std::env::temp_dir().join(format!("ah-burst-first-{}", std::process::id()));
    burst::set_dump_dir(Some(dir.clone()));
    burst::configure(&Config { on: false, ..cfg() });
    let existing = synthetic_burst_allocator(); // 32 MB held BEFORE the profile starts, over the 16 MB threshold
    burst::configure(&cfg());
    // no `begin()`: the window set at switch-on alone must hold (begin() also rolls a stale window, which would hide the bug)
    black_box(vec![1u8; 1024]); // an allocation after switch-on, so the window peak is read
    assert_eq!(burst::request_end(&Ctx { event: "UserPromptSubmit", busy: 1 }), None, "the first request, no growth: no dump");
    assert!(!dir.exists() || std::fs::read_dir(&dir).unwrap().count() == 0, "nothing was written");
    drop(black_box(existing));
    std::fs::remove_dir_all(&dir).ok(); // keep: the test's own scratch directory
}

/// Growth spread over a long idle gap (a window older than `window_max_ms` when a request begins) is no burst.
#[test]
fn slow_growth_over_an_idle_gap_is_not_a_burst() {
    let _one = serial();
    let dir = std::env::temp_dir().join(format!("ah-burst-idle-{}", std::process::id()));
    burst::set_dump_dir(Some(dir.clone()));
    burst::configure(&Config { on: false, ..cfg() });
    burst::configure(&Config { window_ms: 20, window_max_ms: 60, ..cfg() });
    let grown = synthetic_burst_allocator(); // 32 MB arrive while no request runs
    std::thread::sleep(std::time::Duration::from_millis(150));
    burst::begin(); // the window is older than the maximum: it is opened again at the heap as it is now
    black_box(vec![1u8; 1024]);
    assert_eq!(burst::request_end(&Ctx { event: "Stop", busy: 1 }), None, "growth over an idle gap is not a burst");
    drop(black_box(grown));
    std::fs::remove_dir_all(&dir).ok(); // keep: the test's own scratch directory
}

/// Turn a dump's resolved names back into what a stripped binary gives (`function: null`), then name them from the symbol file.
/// macOS: `dsymutil` makes the dSYM of this test binary beside it. Skipped where the tool or the build id is missing.
#[test]
fn a_dump_of_a_stripped_binary_is_named_from_its_symbol_file() {
    let _one = serial();
    let exe = std::env::current_exe().unwrap();
    let have = |t: &str| std::process::Command::new(t).arg("--version").output().is_ok();
    let sym = if cfg!(target_os = "macos") {
        std::path::PathBuf::from(format!("{}.dSYM", exe.display()))
    } else {
        std::path::PathBuf::from(format!("{}.debug", exe.display()))
    };
    if cfg!(target_os = "macos") {
        if !std::process::Command::new("dsymutil").arg(&exe).arg("-o").arg(&sym).output().is_ok_and(|o| o.status.success())
            || !have("atos") && !std::path::Path::new("/usr/bin/atos").exists()
        {
            eprintln!("skipped: no dsymutil/atos");
            return;
        }
    } else {
        if !have("addr2line") || ah_engine::buildid::of_file(&exe).is_none() {
            eprintln!("skipped: no addr2line or no build id");
            return;
        }
        std::fs::copy(&exe, &sym).unwrap();
    }
    let dir = std::env::temp_dir().join(format!("ah-burst-sym-{}", std::process::id()));
    let empty_sidecar = dir.join("sidecar");
    std::fs::create_dir_all(&empty_sidecar).unwrap();
    burst::set_dump_dir(Some(dir.clone()));
    ah_engine::burstsym::set_symbols_dir(Some(empty_sidecar));
    burst::forget_dumps();
    burst::configure(&Config { on: false, ..cfg() });
    burst::configure(&cfg());
    burst::begin();
    let held = synthetic_burst_allocator();
    let Some(Outcome::Written(path)) = burst::request_end(&Ctx { event: "PreToolUse", busy: 1 }) else { panic!("expected a dump") };
    drop(black_box(held));
    // what a stripped binary would have written: addresses, no names
    let mut doc: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    for site in doc["sites"].as_array_mut().unwrap() {
        for f in site["frames"].as_array_mut().unwrap() {
            f["function"] = serde_json::Value::Null;
        }
    }
    std::fs::write(&path, doc.to_string()).unwrap();
    let args = vec!["--symbolize".to_string(), path.display().to_string()];
    let out = ah_engine::burstsym::run(&args);
    let named = out["sites"].to_string();
    assert!(out["resolved_frames"].as_u64().unwrap_or(0) > 0 && named.contains("synthetic_burst_allocator"), "frames named from the symbol file: {out}");
    // the binary is gone (a cleaned build tree): the sidecar copy `<symbols dir>/<build id>/` finds the same names
    let id = doc["build"]["build_id"].as_str().map(str::to_string).unwrap_or_else(|| ah_engine::buildid::of_file(&exe).unwrap().id);
    let side = dir.join("sidecar").join(&id);
    std::fs::create_dir_all(&side).unwrap();
    assert!(std::process::Command::new("cp").arg("-R").arg(&sym).arg(&side).status().unwrap().success());
    let mut moved = doc.clone();
    moved["build"]["exe"] = serde_json::json!("/nonexistent/ah-engine");
    let p3 = dir.join("moved.json");
    std::fs::write(&p3, moved.to_string()).unwrap();
    let out3 = ah_engine::burstsym::run(&["--symbolize".to_string(), p3.display().to_string()]);
    assert!(out3["sites"].to_string().contains("synthetic_burst_allocator"), "named from the sidecar: {out3}");
    // a symbol file of another build is refused, not trusted
    let mut other = doc.clone();
    other["build"]["build_id"] = serde_json::json!("00000000-0000-0000-0000-000000000000");
    other["build"]["exe"] = serde_json::json!("/nonexistent/ah-engine");
    let p2 = dir.join("other.json");
    std::fs::write(&p2, other.to_string()).unwrap();
    let out2 = ah_engine::burstsym::run(&["--symbolize".to_string(), p2.display().to_string()]);
    assert!(out2["symbols"].is_null() && out2["hint"].as_str().is_some_and(|h| h.contains("00000000-0000-0000-0000-000000000000")), "{out2}");
    std::fs::remove_dir_all(&dir).ok(); // keep: the test's own scratch directory
    ah_engine::burstsym::set_symbols_dir(None);
}
