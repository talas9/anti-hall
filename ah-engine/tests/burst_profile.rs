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

/// Name of the allocating function. Built at run time, so a stripped test binary does not hold it as a string of its own.
fn allocator_name() -> String {
    format!("{}_allocator", black_box("synthetic_burst"))
}

/// True when this test binary still carries its symbol names (a build that is not stripped); a shipped-style release build does not.
fn binary_carries_names() -> bool {
    let needle = allocator_name().into_bytes();
    std::fs::read(std::env::current_exe().unwrap()).unwrap().windows(needle.len()).any(|w| w == needle.as_slice())
}

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
    if binary_carries_names() {
        assert!(text.contains(&allocator_name()), "the dump names the allocating function: {text}");
    } else {
        // a stripped build (the shipped one): the process has no names to give. The dump holds the image offset of each frame instead,
        // and the names come from the kept symbols: `a_dump_of_a_stripped_binary_is_named_from_its_symbol_file` (macOS, dSYM) and
        // `a_stripped_linux_binary_is_named_from_its_kept_debug_file` (Linux) prove that path.
        let frames: Vec<&serde_json::Value> = doc["sites"].as_array().unwrap().iter().flat_map(|s| s["frames"].as_array().unwrap()).collect();
        assert!(frames.iter().any(|f| f["function"].is_null() && f["offset"].as_str().is_some_and(|o| o.starts_with("0x"))), "frames carry offsets: {text}");
        assert!(!text.contains(&allocator_name()), "a stripped binary names nothing in-process: {text}");
    }

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
    burst::forget_window(); // a fresh process's window: nothing left over from the tests that ran before
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
    burst::forget_window(); // a fresh process's window: start 0, so it is older than the maximum
    burst::configure(&Config { window_ms: 20, window_max_ms: 60, ..cfg() });
    let grown = synthetic_burst_allocator(); // 32 MB arrive while no request runs
    std::thread::sleep(std::time::Duration::from_millis(150));
    burst::begin(); // the window is older than the maximum: it is opened again at the heap as it is now
    black_box(vec![1u8; 1024]);
    assert_eq!(burst::request_end(&Ctx { event: "Stop", busy: 1 }), None, "growth over an idle gap is not a burst");
    drop(black_box(grown));
    std::fs::remove_dir_all(&dir).ok(); // keep: the test's own scratch directory
}

/// A burst in flight on one worker is not thrown away when another worker's `begin()` finds the window older than `window_max_ms`.
/// (`begin()` used to reset the window base at the live heap, so the first worker's growth went into the new base and was never reported.)
#[test]
fn a_begin_does_not_roll_the_window_away_from_a_burst_in_flight() {
    let _one = serial();
    let scenario = |window_max_ms: u64| -> bool {
        let dir = std::env::temp_dir().join(format!("ah-burst-inflight-{}-{window_max_ms}", std::process::id()));
        burst::set_dump_dir(Some(dir.clone()));
        burst::forget_dumps();
        let c = Config { window_ms: 100, window_max_ms, max_per_hour: 5, ..cfg() };
        burst::configure(&Config { on: false, ..c.clone() });
        burst::forget_window();
        burst::configure(&c);
        std::thread::sleep(std::time::Duration::from_millis(250)); // idle: window age 250 ms, under the 300 ms maximum
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        let (tx2, rx2) = std::sync::mpsc::channel::<()>();
        let b = std::thread::spawn(move || {
            burst::begin(); // worker B: the window is not older than the maximum yet, no roll
            let held = synthetic_burst_allocator(); // 32 MB, fast
            tx.send(()).unwrap();
            rx2.recv().unwrap();
            let out = burst::request_end(&Ctx { event: "PreToolUse", busy: 2 });
            drop(black_box(held));
            out
        });
        rx.recv().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(100)); // window age now over 300 ms
        burst::begin(); // worker A begins while B's burst is in flight
        tx2.send(()).unwrap();
        let out_b = b.join().unwrap();
        let out_a = burst::request_end(&Ctx { event: "PreToolUse", busy: 1 });
        std::fs::remove_dir_all(&dir).ok(); // keep: the test's own scratch directory
        matches!(out_b, Some(Outcome::Written(_))) || matches!(out_a, Some(Outcome::Written(_)))
    };
    let control = scenario(10_000); // no roll is possible
    let rolled = scenario(300);
    assert!(control, "the control run (no roll) dumps the burst");
    assert!(rolled, "the burst in flight is dumped although a begin() found the window past its maximum");
}

/// Turn a dump's resolved names back into what a stripped binary gives (`function: null`), then name them from the symbol file.
/// macOS: the dSYM of this test binary (cargo's, or one `dsymutil` makes). Skipped where the tool is missing. Linux has its own test below.
#[cfg(target_os = "macos")]
#[test]
fn a_dump_of_a_stripped_binary_is_named_from_its_symbol_file() {
    let _one = serial();
    let exe = std::env::current_exe().unwrap();
    // the symbol file is made in the test's own scratch directory: cargo's own `<exe>.dSYM` beside the binary is never overwritten
    let dir = std::env::temp_dir().join(format!("ah-burst-sym-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let sym = dir.join("test.dSYM");
    let beside = std::path::PathBuf::from(format!("{}.dSYM", exe.display()));
    let copied = beside.is_dir() && std::process::Command::new("cp").arg("-R").arg(&beside).arg(&sym).status().is_ok_and(|s| s.success());
    if !copied
        && (!std::process::Command::new("dsymutil").arg(&exe).arg("-o").arg(&sym).output().is_ok_and(|o| o.status.success())
            || !std::path::Path::new("/usr/bin/atos").exists())
    {
        eprintln!("skipped: no dsymutil/atos");
        std::fs::remove_dir_all(&dir).ok(); // keep: the test's own scratch directory
        return;
    }
    // the symbol file is kept as the installed layout keeps it, `<symbols dir>/<build id>/` (nothing is written beside the test binary)
    let sidecar = dir.join("sidecar");
    let id = ah_engine::buildid::of_file(&exe).unwrap().id;
    let side = sidecar.join(&id);
    std::fs::create_dir_all(&side).unwrap();
    assert!(std::process::Command::new("cp").arg("-R").arg(&sym).arg(&side).status().unwrap().success());
    burst::set_dump_dir(Some(dir.clone()));
    ah_engine::burstsym::set_symbols_dir(Some(sidecar));
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
    assert!(out["resolved_frames"].as_u64().unwrap_or(0) > 0 && named.contains(&allocator_name()), "frames named from the symbol file: {out}");
    // the binary is gone (a cleaned build tree): the sidecar copy `<symbols dir>/<build id>/` finds the same names
    let mut moved = doc.clone();
    moved["build"]["exe"] = serde_json::json!("/nonexistent/ah-engine");
    let p3 = dir.join("moved.json");
    std::fs::write(&p3, moved.to_string()).unwrap();
    let out3 = ah_engine::burstsym::run(&["--symbolize".to_string(), p3.display().to_string()]);
    assert!(out3["sites"].to_string().contains(&allocator_name()), "named from the sidecar: {out3}");
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

/// The tools the Linux symbolization proof needs. On CI a missing one is a failure (the proof must run there); elsewhere the test is skipped.
#[cfg(target_os = "linux")]
fn linux_tools_present() -> bool {
    let missing: Vec<&str> =
        ["rustc", "addr2line", "strip", "readelf", "nm"].into_iter().filter(|t| std::process::Command::new(t).arg("--version").output().is_err()).collect();
    if missing.is_empty() {
        return true;
    }
    assert!(std::env::var_os("CI").is_none(), "CI must have {missing:?} for the Linux symbolization proof");
    eprintln!("skipped: no {missing:?}");
    false
}

/// A one-function program: prints its image base and an address inside `fixture_burst_site`, the two numbers a burst dump records for a frame.
#[cfg(target_os = "linux")]
const FIXTURE: &str = r#"
use std::hint::black_box;
#[inline(never)]
#[no_mangle]
pub extern "C" fn fixture_burst_site(n: usize) -> usize {
    let mut v = Vec::new();
    for i in 0..n {
        v.push(black_box(i) * 3);
    }
    black_box(v).len()
}
fn main() {
    let f: extern "C" fn(usize) -> usize = fixture_burst_site;
    black_box(f)(black_box(4));
    let exe = std::fs::canonicalize("/proc/self/exe").unwrap();
    let maps = std::fs::read_to_string("/proc/self/maps").unwrap();
    let base = maps
        .lines()
        .filter(|l| l.ends_with(exe.to_str().unwrap()))
        .filter_map(|l| usize::from_str_radix(l.split('-').next()?, 16).ok())
        .min()
        .unwrap();
    println!("{base:#x} {:#x}", f as usize + 12);
}
"#;

/// LINUX PROOF. A binary stripped the way the shipped one is, plus the symbols kept by the real scripts (`split-symbols.sh`, then
/// `keep-symbols.sh`), is named by `diag burst-dump --symbolize`: the dump holds only an address and an offset, the function name comes back.
/// The control run shows why the kept file must be the unstripped build: the stripped binary itself, or a `.dwp`, names nothing.
#[cfg(target_os = "linux")]
#[test]
fn a_stripped_linux_binary_is_named_from_its_kept_debug_file() {
    use std::process::Command;
    if !linux_tools_present() {
        return;
    }
    let _one = serial();
    let scripts = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("scripts");
    let dir = std::env::temp_dir().join(format!("ah-burst-linux-{}", std::process::id()));
    std::fs::remove_dir_all(&dir).ok(); // keep: the test's own scratch directory, from an earlier run with this pid
    std::fs::create_dir_all(&dir).unwrap();
    let (src, fx) = (dir.join("fixture.rs"), dir.join("fx"));
    std::fs::write(&src, FIXTURE).unwrap();
    let built = Command::new("rustc")
        .args(["--edition", "2021", "-C", "opt-level=1", "-C", "debuginfo=1", "-C", "strip=none", "-C", "link-arg=-Wl,--build-id"])
        .arg(&src)
        .arg("-o")
        .arg(&fx)
        .output()
        .unwrap();
    assert!(built.status.success(), "rustc: {}", String::from_utf8_lossy(&built.stderr));

    // the shipped layout: the binary stripped in place, the unstripped build kept beside it as `fx.debug`
    let split = Command::new("bash").arg(scripts.join("split-symbols.sh")).arg(&fx).output().unwrap();
    assert!(split.status.success(), "split-symbols.sh: {}", String::from_utf8_lossy(&split.stderr));
    let kept = dir.join("fx.debug");
    assert!(
        kept.is_file() && std::fs::metadata(&kept).unwrap().len() > std::fs::metadata(&fx).unwrap().len(),
        "the debug file is the larger, unstripped build"
    );
    let names = |p: &std::path::Path| String::from_utf8_lossy(&Command::new("nm").arg(p).output().unwrap().stdout).into_owned();
    assert!(!names(&fx).contains("fixture_burst_site"), "the shipped binary has no symbol names");
    assert!(names(&kept).contains("fixture_burst_site"), "the kept file has them");
    let id = ah_engine::buildid::of_file(&fx).expect("the fixture has a GNU build-id").id;
    assert_eq!(ah_engine::buildid::of_file(&kept).map(|b| b.id), Some(id.clone()), "stripping keeps the build id: the kept file matches the shipped binary");

    // what the stripped process would have written into a dump: the image base, the address, the offset, and no name
    let run = Command::new(&fx).output().unwrap();
    let out = String::from_utf8_lossy(&run.stdout).into_owned();
    let mut it = out.split_whitespace().map(|h| usize::from_str_radix(h.trim_start_matches("0x"), 16).unwrap());
    let (base, ip) = (it.next().unwrap(), it.next().unwrap());
    let dump = serde_json::json!({
        "build": {"build_id": id, "image_base": format!("{base:#x}"), "exe": "/nonexistent/fx", "os": "linux", "arch": std::env::consts::ARCH, "version": "test"},
        "sites": [{"frames": [{"ip": format!("{ip:#x}"), "image_base": format!("{base:#x}"), "offset": format!("{:#x}", ip - base), "function": null}]}],
    });
    let dump_path = dir.join("dump.json");
    std::fs::write(&dump_path, dump.to_string()).unwrap();
    let symbolize = || ah_engine::burstsym::run(&["--symbolize".to_string(), dump_path.display().to_string()]);

    // control: the stripped binary kept as the "symbol file" (what the old test did) names nothing
    let control = dir.join("control");
    std::fs::create_dir_all(control.join(&id)).unwrap();
    std::fs::copy(&fx, control.join(&id).join("fx.debug")).unwrap();
    ah_engine::burstsym::set_symbols_dir(Some(control));
    let bad = symbolize();
    assert!(!bad.to_string().contains("fixture_burst_site"), "a stripped file names nothing: {bad}");

    // the real keep script puts the debug file where the engine looks for it: <state>/<files.symbols_dir>/<build id>/
    let state = dir.join("state");
    let keep = Command::new("bash").arg(scripts.join("keep-symbols.sh")).arg(&fx).env("AH_ENGINE_DIR", &state).output().unwrap();
    assert!(keep.status.success(), "keep-symbols.sh: {}", String::from_utf8_lossy(&keep.stderr));
    let kept_dir = state.join(ah_engine::defaults::text("files.symbols_dir"));
    assert!(kept_dir.join(&id).join("fx.debug").is_file(), "kept under the build id: {}", String::from_utf8_lossy(&keep.stdout));
    ah_engine::burstsym::set_symbols_dir(Some(kept_dir));
    let named = symbolize();
    assert_eq!(named["resolved_frames"], 1, "{named}");
    assert!(
        named["sites"].to_string().contains("fixture_burst_site"),
        "the allocating function is named from the stripped binary plus its kept debug file: {named}"
    );
    ah_engine::burstsym::set_symbols_dir(None);
    std::fs::remove_dir_all(&dir).ok(); // keep: the test's own scratch directory
}

/// The dump writer and the listing read the same `diagnostics.burst_dump_ext`: editing it renames new dumps and `diag burst-dump` still finds them.
#[test]
fn a_dump_is_named_from_the_configured_extension_and_listed_by_it() {
    let _one = serial();
    let dir = std::env::temp_dir().join(format!("ah-burst-ext-{}", std::process::id()));
    burst::set_dump_dir(Some(dir.clone()));
    burst::forget_dumps();
    ah_engine::defaults::set_overlay(&[("diagnostics.burst_dump_ext", serde_json::json!("dmp"))]);
    burst::configure(&Config { on: false, ..cfg() });
    burst::configure(&cfg());
    burst::begin();
    let held = synthetic_burst_allocator();
    let out = burst::request_end(&Ctx { event: "PreToolUse", busy: 1 });
    ah_engine::defaults::set_overlay(&[("diagnostics.burst_dump_ext", serde_json::json!("dmp"))]); // still set while listing
    let listed = ah_engine::burstsym::run(&[]);
    ah_engine::defaults::set_overlay(&[]);
    drop(black_box(held));
    let Some(Outcome::Written(path)) = out else { panic!("expected a dump, got {out:?}") };
    assert_eq!(path.extension().and_then(|e| e.to_str()), Some("dmp"), "{path:?}");
    assert!(path.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("burst-")), "{path:?}");
    let files = listed["dumps"].as_array().expect("dumps");
    assert_eq!(files.len(), 1, "the listing finds the dump written under the edited extension: {listed}");
    std::fs::remove_dir_all(&dir).ok(); // keep: the test's own scratch directory
}
