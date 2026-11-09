use super::*;

const SHORT: Duration = Duration::from_millis(150);

/// The bound is process-wide: the tests that take a turn must not overlap.
static ONE_AT_A_TIME: Mutex<()> = Mutex::new(());

/// Runs `f` on this thread while another thread holds the only turn, with a request deadline short enough that `f`'s own wait for a
/// turn ends in a bypass: what a caller sees under contention.
pub(crate) fn while_turn_is_held<R>(f: impl FnOnce() -> R) -> R {
    let _g = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
    let (held_tx, held_rx) = std::sync::mpsc::channel();
    let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
    let holder = std::thread::spawn(move || {
        let t = permit_for(1, Duration::from_secs(5));
        held_tx.send(t.counted).unwrap();
        done_rx.recv().unwrap_or(());
    });
    assert!(held_rx.recv().unwrap(), "the holder has the only turn");
    TEST_MAX.with(|m| m.set(1));
    crate::deadline::begin(Instant::now());
    crate::deadline::client_deadline(300);
    crate::metrics::reset_this_thread();
    let out = f();
    let bypassed = crate::metrics::bumped_on_this_thread("transcript_scan_turn_bypassed", &[]);
    crate::deadline::end();
    TEST_MAX.with(|m| m.set(0));
    done_tx.send(()).unwrap();
    holder.join().unwrap();
    assert!(bypassed > 0, "the call ended its wait and read anyway ({bypassed} bypasses)");
    out
}

fn file(tag: &str, bytes: &[u8]) -> String {
    let p = std::env::temp_dir().join(format!("ah-scan-{tag}-{}", std::process::id()));
    std::fs::write(&p, bytes).unwrap();
    p.to_string_lossy().into_owned()
}

/// What the old readers did: read the whole window, split on `\n`, drop the first piece when the window was cut.
fn reference(bytes: &[u8], window: usize) -> Vec<Vec<u8>> {
    let cut = bytes.len() > window;
    let w = if cut { &bytes[bytes.len() - window..] } else { bytes };
    let mut pieces: Vec<Vec<u8>> = w.split(|b| *b == b'\n').map(<[u8]>::to_vec).collect();
    if cut {
        pieces.remove(0);
    }
    pieces
}

#[test]
fn lines_are_the_same_whatever_the_block_edge() {
    // block edges fall mid-line, between the CR and the LF, and inside a two- and a three-byte character
    let mut bytes = "a\r\nb\u{e9}c\r\n\u{4e2d}\u{6587}x\n\n\u{1f600}tail\r\nlast".as_bytes().to_vec();
    bytes.extend_from_slice(&body());
    let p = file("edges", &bytes);
    for block in [1usize, 2, 3, 4, 5, 7, 16, 61] {
        TEST_BLOCK.with(|b| b.set(block));
        for window in [3usize, 11, 30, 100, bytes.len() - 1, bytes.len(), bytes.len() + 9] {
            let want = reference(&bytes, window);
            let mut fwd: Vec<(Vec<u8>, bool)> = Vec::new();
            let mut w = Window::open(&p, window as u64).unwrap();
            w.lines_ex(|l, last| {
                fwd.push((l.to_vec(), last));
                Flow::Next
            })
            .unwrap();
            assert_eq!(fwd.iter().map(|(l, _)| l.clone()).collect::<Vec<_>>(), want, "forward, block {block}, window {window}");
            assert_eq!(
                fwd.iter().filter(|(_, last)| *last).count(),
                usize::from(!want.is_empty()),
                "the final element is the one flagged last, block {block}, window {window}"
            );
            let mut rev: Vec<Vec<u8>> = Vec::new();
            let mut w = Window::open(&p, window as u64).unwrap();
            w.lines_rev(|l| {
                rev.push(l.to_vec());
                Flow::Next
            })
            .unwrap();
            rev.reverse();
            assert_eq!(rev, want, "backward, block {block}, window {window}");
        }
    }
    TEST_BLOCK.with(|b| b.set(0));
}

fn body() -> Vec<u8> {
    let mut b = Vec::new();
    for (i, l) in ["alpha", "beta\r", "", "gamma \u{e9}\u{4e2d}", "d".repeat(9000).as_str(), "tail", "x".repeat(70_000).as_str(), "end"].iter().enumerate() {
        b.extend_from_slice(l.as_bytes());
        if i != 7 {
            b.push(b'\n');
        }
    }
    b
}

#[test]
fn forward_and_backward_lines_are_the_split_of_the_window_for_every_window_and_block() {
    for ending in [&b""[..], &b"\n"[..]] {
        let mut bytes = body();
        bytes.extend_from_slice(ending);
        let p = file("lines", &bytes);
        for window in [0usize, 1, 5, 6, 40, 4096, 9001, 80_000, bytes.len() - 1, bytes.len(), bytes.len() + 5] {
            let want = reference(&bytes, window);
            let mut fwd: Vec<Vec<u8>> = Vec::new();
            let mut w = Window::open(&p, window as u64).unwrap();
            w.lines(|l| {
                fwd.push(l.to_vec());
                Flow::Next
            })
            .unwrap();
            assert_eq!(fwd, want, "forward, window {window}");
            let mut rev: Vec<Vec<u8>> = Vec::new();
            let mut w = Window::open(&p, window as u64).unwrap();
            w.lines_rev(|l| {
                rev.push(l.to_vec());
                Flow::Next
            })
            .unwrap();
            rev.reverse();
            assert_eq!(rev, want, "backward, window {window}");
        }
    }
}

#[test]
fn stopping_early_stops_the_read() {
    let p = file("stop", &body());
    let mut seen = 0;
    let mut w = Window::open(&p, 1 << 20).unwrap();
    w.lines_rev(|_| {
        seen += 1;
        Flow::Stop
    })
    .unwrap();
    assert_eq!(seen, 1);
}

#[test]
fn a_thread_that_holds_a_turn_does_not_wait_for_itself() {
    let _g = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
    let a = permit_for(1, SHORT);
    let b = permit_for(1, SHORT);
    assert!(!b.counted, "the same thread gets another turn at once");
    drop(b);
    drop(a);
}

#[test]
fn a_second_thread_waits_for_the_turn_then_reads_anyway_without_one() {
    let _g = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
    let held = permit_for(1, SHORT);
    assert!(held.counted);
    let waiter = std::thread::spawn(|| {
        let t = Instant::now();
        let got = permit_for(1, SHORT);
        (got.counted, t.elapsed())
    });
    let (counted, took) = waiter.join().unwrap();
    assert!(!counted, "no turn while another thread holds the only one: it reads anyway, without one");
    assert!(took >= SHORT / 2, "it waited: {took:?}");
    drop(held);
    assert!(std::thread::spawn(|| permit_for(1, SHORT).counted).join().unwrap(), "the turn comes back when it is released");
}
