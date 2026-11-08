//! `transcript::scan` and the readers behind it hold a block and a line, never the window (T-3): a reader that is handed a 16-64 MiB
//! window of a big transcript must peak at about `transcript.read_block_bytes` plus its longest line, whatever the window is. One test
//! binary of its own: the counting allocator is the global one, and `mem::measure` reads this thread's peak (the readers are
//! synchronous). The gate is `transcript.reader_peak_budget_bytes` in the plugin's TOML.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report
#![allow(clippy::panic, clippy::unreachable)] // integration tests: a panic is the failure report

use ah_engine::mem::measure;
use ah_engine::transcript::scan::{Flow, Window};
use ah_engine::transcript::{Index, Refresh};
use std::io::Write;
use std::path::{Path, PathBuf};

#[global_allocator]
static ALLOC: ah_engine::memstat::Counting = ah_engine::memstat::Counting;

const MIB: u64 = 1 << 20;
const BUDGET_KEY: &str = "transcript.reader_peak_budget_bytes";

fn budget() -> u64 {
    let t: toml::Table =
        std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall/engine/defaults/transcript.toml")).unwrap().parse().unwrap();
    let (section, key) = BUDGET_KEY.split_once('.').unwrap();
    t[section][key]["value"].as_integer().unwrap() as u64
}

/// About `mb` MB of transcript lines of 1-3 KB, one line in 4000 of 300 KB.
fn transcript(tag: &str, mb: u64) -> PathBuf {
    let p = std::env::temp_dir().join(format!("ah-scan-blocks-{tag}-{}.jsonl", std::process::id()));
    let mut f = std::io::BufWriter::new(std::fs::File::create(&p).unwrap());
    let (mut written, mut i) = (0u64, 0u64);
    let big = "b".repeat(300 * 1024);
    while written < mb * MIB {
        let body = if i % 4000 == 3999 { big.clone() } else { "x".repeat(1000 + (i % 7) as usize * 300) };
        let line = format!(
            r#"{{"type":"assistant","timestamp":"2026-11-08T10:00:00.000Z","message":{{"role":"assistant","content":[{{"type":"text","text":"{body}"}}]}}}}"#
        );
        writeln!(f, "{line}").unwrap();
        written += line.len() as u64 + 1;
        i += 1;
    }
    f.flush().unwrap();
    p
}

/// The first use of the engine's defaults in a process builds them (tens of MB, kept for its life): do it before anything is measured.
fn warm() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let p = transcript("warm", 1);
        Window::open(p.to_str().unwrap(), MIB).unwrap().lines(|_| Flow::Next).unwrap();
        ah_engine::script::host_transcript::grep(p.to_str().unwrap(), MIB as f64, r#"["x"]"#, "", "").unwrap();
        Index::new(&p).refresh().unwrap();
        std::fs::remove_file(&p).ok(); // keep: cleanup; an absent file is the goal state
    });
}

fn peak_of<R>(f: impl FnOnce() -> R) -> (R, u64) {
    warm();
    let (r, d) = measure(f);
    let peak = d.expect("the counting allocator is installed and measuring").peak;
    eprintln!("reader peak: {peak} bytes");
    (r, peak)
}

#[test]
fn a_window_is_read_in_blocks_forward_and_backward_whatever_its_size() {
    let p = transcript("window", 64);
    let path = p.to_str().unwrap();
    let want = budget();
    for window in [4 * MIB, 16 * MIB, 64 * MIB] {
        let (n, peak) = peak_of(|| {
            let mut n = 0u64;
            Window::open(path, window)
                .unwrap()
                .lines(|l| {
                    n += l.len() as u64;
                    Flow::Next
                })
                .unwrap();
            n
        });
        assert!(n > window / 2, "it read the window ({n} of {window})");
        assert!(peak < want, "forward over {window} bytes held {peak} bytes (budget {want})");
        let (m, peak) = peak_of(|| {
            let mut m = 0u64;
            Window::open(path, window)
                .unwrap()
                .lines_rev(|l| {
                    m += l.len() as u64;
                    Flow::Next
                })
                .unwrap();
            m
        });
        assert_eq!(m, n, "both directions see the same lines");
        assert!(peak < want, "backward over {window} bytes held {peak} bytes (budget {want})");
    }
    std::fs::remove_file(&p).ok(); // keep: cleanup; an absent file is the goal state
}

#[test]
fn the_script_grep_over_a_16_mib_window_holds_a_block_not_the_window() {
    let p = transcript("grep", 64);
    let path = p.to_str().unwrap();
    let want = budget();
    let (out, peak) = peak_of(|| ah_engine::script::host_transcript::grep(path, (16 * MIB) as f64, r#"["no-such-text-in-the-file"]"#, "", "").unwrap());
    assert_eq!(out, r#"{"lines":[]}"#);
    assert!(peak < want, "grep over 16 MiB held {peak} bytes (budget {want})");
    std::fs::remove_file(&p).ok(); // keep: cleanup; an absent file is the goal state
}

#[test]
fn the_index_reads_what_was_appended_in_blocks() {
    let p = transcript("index", 24);
    let want = budget();
    let mut ix = Index::new(&p);
    assert!(matches!(ix.refresh().unwrap(), Refresh::Appended { .. }));
    // 7 MiB appended since: below `transcript.max_update_bytes`, so one refresh reads all of it
    let more = transcript("index-more", 7);
    let mut f = std::fs::OpenOptions::new().append(true).open(&p).unwrap();
    f.write_all(&std::fs::read(&more).unwrap()).unwrap();
    f.flush().unwrap();
    let (r, peak) = peak_of(|| ix.refresh().unwrap());
    let Refresh::Appended { bytes, .. } = r else { panic!("not an append: {r:?}") };
    assert!(bytes > 6 * MIB, "it read the appended bytes ({bytes})");
    // the index keeps bounded facts (the last reply, recent tool uses), not the text it folded
    assert!(peak < want * 2, "refreshing 7 MiB held {peak} bytes (budget {want} x 2)");
    std::fs::remove_file(&p).ok(); // keep: cleanup; an absent file is the goal state
    std::fs::remove_file(&more).ok(); // keep: cleanup; an absent file is the goal state
}
