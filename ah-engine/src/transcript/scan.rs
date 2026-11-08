//! `transcript::scan`: the one place that reads a window of a transcript file.
//!
//! Why it exists: a transcript is hundreds of MB, and every reader of its tail used to allocate its own window (12-64 MiB, one
//! `Vec` for the bytes and a `String` for the text), so a few requests in flight on one long session raised the heap by tens of
//! MB for half a second, enough to pass the RSS cap and restart the daemon. Here a window is read in fixed blocks
//! (`transcript.read_block_bytes`): the bytes held at any moment are one block plus the one line being assembled, whatever the
//! window is. A caller folds the lines it is handed into a small state and keeps nothing else.
//!
//! Two bounds hold for every reader behind this module:
//! * [`permit`]: at most `transcript.max_concurrent_scans` windows are being read in the process at once. The turn bounds
//!   concurrency only and never changes an answer: a request that cannot get one before its own deadline (or
//!   `transcript.scan_wait_max_ms`) reads anyway, without a turn, and the bypass is counted in `transcript_scan_turn_bypassed`.
//! * the block size is read from the plugin's TOML, never compiled in.
//!
//! The line semantics are those of `text.split('\n')` over the window as the Node hooks read it: the first, possibly cut, line is
//! dropped when the window starts inside the file; a window that ends on a newline has one more, empty, element. A reader that
//! wants `\r?\n` strips one `\r` itself.
use crate::defaults;
use std::cell::Cell;
use std::io::{Read, Seek, SeekFrom};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

/// What a line callback tells the reader.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Flow {
    /// Hand over the next line.
    Next,
    /// The answer is known: stop reading.
    Stop,
}

// ---- the concurrency bound ----

static TURNS: Mutex<usize> = Mutex::new(0);
static FREED: Condvar = Condvar::new();

thread_local! {
    /// Windows this thread is reading now: a scan that calls another scan on the same thread must not wait for itself.
    static DEPTH: Cell<u32> = const { Cell::new(0) };
    /// The most bytes this thread held for transcript reads since the last [`take_peak`].
    static PEAK: Cell<u64> = const { Cell::new(0) };
}

/// A turn at reading a transcript window; the next one starts when it drops.
#[derive(Debug)]
pub struct Permit {
    counted: bool,
}

impl Drop for Permit {
    fn drop(&mut self) {
        DEPTH.with(|d| d.set(d.get().saturating_sub(1)));
        if self.counted {
            let mut n = TURNS.lock().unwrap_or_else(|e| e.into_inner());
            *n = n.saturating_sub(1);
            FREED.notify_one();
        }
    }
}

/// A turn at reading a transcript window, waiting for one at most until the request's own deadline and `transcript.scan_wait_max_ms`.
/// When none comes in time the caller reads anyway, without a turn (counted in `transcript_scan_turn_bypassed`): the turn bounds
/// concurrency and must never change an answer, so a timeout is not a failed read. A thread that already holds a turn gets another at
/// once. `transcript.max_concurrent_scans` 0 turns the bound off.
pub fn permit() -> Permit {
    permit_for(max_scans(), Duration::from_millis(defaults::num("transcript.scan_wait_max_ms")))
}

/// `transcript.max_concurrent_scans`; the unit tests of the lib run in threads of one process, so there the bound is off unless a test
/// sets it for its own thread.
fn max_scans() -> usize {
    #[cfg(test)]
    {
        TEST_MAX.with(Cell::get)
    }
    #[cfg(not(test))]
    {
        defaults::num("transcript.max_concurrent_scans") as usize
    }
}

#[cfg(test)]
thread_local! {
    static TEST_MAX: Cell<usize> = const { Cell::new(0) };
}

fn permit_for(max: usize, wait: Duration) -> Permit {
    if DEPTH.with(Cell::get) > 0 || max == 0 {
        DEPTH.with(|d| d.set(d.get() + 1));
        return Permit { counted: false };
    }
    let mut wait = wait;
    if let Some(left) = crate::deadline::remaining() {
        wait = wait.min(left);
    }
    let until = Instant::now() + wait;
    let mut n = TURNS.lock().unwrap_or_else(|e| e.into_inner());
    let mut waited = false;
    while *n >= max {
        let now = Instant::now();
        if now >= until {
            drop(n);
            crate::metrics::bump("transcript_scan_turn_bypassed", &[]);
            DEPTH.with(|d| d.set(d.get() + 1));
            return Permit { counted: false };
        }
        if !waited {
            waited = true;
            crate::metrics::bump("transcript_scan_waits", &[]);
        }
        n = FREED.wait_timeout(n, until - now).unwrap_or_else(|e| e.into_inner()).0;
    }
    *n += 1;
    drop(n);
    DEPTH.with(|d| d.set(d.get() + 1));
    Permit { counted: true }
}

/// The most bytes this thread held for transcript reads since the last call, and reset: what the check that just ran peaked at.
pub fn take_peak() -> u64 {
    PEAK.with(Cell::take)
}

fn note_held(bytes: usize) {
    PEAK.with(|p| p.set(p.get().max(bytes as u64)));
}

/// `transcript.read_block_bytes` (a test can set its own thread's block to cut lines at small edges).
pub fn block_bytes() -> usize {
    #[cfg(test)]
    if let Some(b) = TEST_BLOCK.with(Cell::get) {
        return b.max(1);
    }
    (defaults::num("transcript.read_block_bytes") as usize).max(1)
}

#[cfg(test)]
thread_local! {
    static TEST_BLOCK: Cell<Option<usize>> = const { Cell::new(None) };
}

/// The bound is process-wide: the tests that take a turn must not overlap.
#[cfg(test)]
static ONE_AT_A_TIME: Mutex<()> = Mutex::new(());

/// Runs `f` on this thread while another thread holds the only turn, with a request deadline short enough that `f`'s own wait for a
/// turn ends in a bypass: what a caller sees under contention.
#[cfg(test)]
pub(crate) fn while_turn_is_held<R>(f: impl FnOnce() -> R) -> R {
    let _g = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
    let (held_tx, held_rx) = std::sync::mpsc::channel();
    let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
    let holder = std::thread::spawn(move || {
        let t = permit_for(1, Duration::from_secs(5));
        held_tx.send(t.counted).unwrap();
        let _ = done_rx.recv();
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

// ---- the window ----

/// An open window: the last `len` bytes of a file of `size` bytes.
#[derive(Debug)]
pub struct Window {
    file: std::fs::File,
    /// The size of the file when the window was cut.
    pub size: u64,
    /// The first byte of the window.
    pub start: u64,
    _turn: Permit,
}

impl Window {
    /// The last `max` bytes of `path` (all of it when smaller). `None` when the file cannot be opened or read.
    /// An empty file is a window of no bytes.
    pub fn open(path: &str, max: u64) -> Option<Window> {
        let turn = permit();
        let file = std::fs::File::open(path).ok()?;
        let size = file.metadata().ok()?.len();
        let start = size.saturating_sub(max);
        crate::load::note_scan(size - start);
        Some(Window { file, size, start, _turn: turn })
    }

    /// True when the window starts inside the file, so its first line may be cut.
    pub fn truncated(&self) -> bool {
        self.start > 0
    }

    /// Bytes in the window.
    pub fn len(&self) -> u64 {
        self.size - self.start
    }

    /// True for a window of no bytes.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Every line of the window oldest first, as `split('\n')` gives them (see the module doc), one at a time. `Err` when a read fails
    /// part way (the lines already handed over stay handed over: the old whole-window read treated a short read the same way).
    pub fn lines(&mut self, mut each: impl FnMut(&[u8]) -> Flow) -> std::io::Result<()> {
        self.lines_ex(|l, _| each(l))
    }

    /// [`Window::lines`] that also says whether the line is the last element of the window (the one after the final newline): a reader
    /// of `\r?\n` lines strips a `\r` from every element but that one.
    pub fn lines_ex(&mut self, mut each: impl FnMut(&[u8], bool) -> Flow) -> std::io::Result<()> {
        let block = block_bytes();
        self.file.seek(SeekFrom::Start(self.start))?;
        let mut left = self.len();
        let mut buf = vec![0u8; block];
        let mut line: Vec<u8> = Vec::new();
        let mut skip_first = self.truncated();
        while left > 0 {
            let n = (left as usize).min(block);
            self.file.read_exact(buf.get_mut(..n).unwrap_or_default())?;
            left -= n as u64;
            let mut rest = buf.get(..n).unwrap_or_default();
            while let Some(i) = rest.iter().position(|b| *b == b'\n') {
                let (head, tail) = rest.split_at(i);
                rest = tail.get(1..).unwrap_or_default();
                let flow = if line.is_empty() {
                    emit(head, false, &mut skip_first, &mut each)
                } else {
                    line.extend_from_slice(head);
                    note_held(buf.len() + line.capacity());
                    let f = emit(&line, false, &mut skip_first, &mut each);
                    line.clear();
                    f
                };
                if flow == Flow::Stop {
                    return Ok(());
                }
            }
            line.extend_from_slice(rest);
            note_held(buf.len() + line.capacity());
        }
        // the last element: empty when the window ended on a newline (a `split` keeps it)
        emit(&line, true, &mut skip_first, &mut each);
        Ok(())
    }

    /// Every line of the window newest first, the same lines as [`Window::lines`] in the reverse order, reading blocks backward from the
    /// end of the window. A caller that wants only the newest few lines of a kind stops early and has read only what it needed.
    pub fn lines_rev(&mut self, mut each: impl FnMut(&[u8]) -> Flow) -> std::io::Result<()> {
        self.lines_rev_ex(|l, _| each(l))
    }

    /// [`Window::lines_rev`] that also says whether the line is the last element of the window (the first one handed over).
    pub fn lines_rev_ex(&mut self, mut each: impl FnMut(&[u8], bool) -> Flow) -> std::io::Result<()> {
        let mut first = true;
        let mut each = move |l: &[u8]| each(l, std::mem::take(&mut first));
        let block = block_bytes();
        let mut buf = vec![0u8; block];
        // the pieces, newest first, of the line whose start has not been reached yet
        let mut pieces: Vec<Vec<u8>> = Vec::new();
        let mut held = 0usize;
        let mut pos = self.size;
        let mut joined: Vec<u8> = Vec::new();
        while pos > self.start {
            let n = ((pos - self.start) as usize).min(block);
            pos -= n as u64;
            self.file.seek(SeekFrom::Start(pos))?;
            self.file.read_exact(buf.get_mut(..n).unwrap_or_default())?;
            let mut end = n;
            while let Some(i) = buf.get(..end).unwrap_or_default().iter().rposition(|b| *b == b'\n') {
                let after = buf.get(i + 1..end).unwrap_or_default();
                let flow = if pieces.is_empty() {
                    each(after)
                } else {
                    joined.clear();
                    joined.extend_from_slice(after);
                    for p in pieces.iter().rev() {
                        joined.extend_from_slice(p);
                    }
                    pieces.clear();
                    held = 0;
                    note_held(buf.len() + joined.capacity());
                    each(&joined)
                };
                if flow == Flow::Stop {
                    return Ok(());
                }
                end = i;
            }
            let head = buf.get(..end).unwrap_or_default();
            if !head.is_empty() {
                pieces.push(head.to_vec());
                held += head.len();
                note_held(buf.len() + held);
            }
        }
        // the line at the start of the window: whole when the window starts the file, else cut and dropped
        if !self.truncated() {
            joined.clear();
            for p in pieces.iter().rev() {
                joined.extend_from_slice(p);
            }
            each(&joined);
        }
        Ok(())
    }
}

fn emit(line: &[u8], last: bool, skip_first: &mut bool, each: &mut impl FnMut(&[u8], bool) -> Flow) -> Flow {
    if std::mem::take(skip_first) { Flow::Next } else { each(line, last) }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHORT: Duration = Duration::from_millis(150);

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
            TEST_BLOCK.with(|b| b.set(Some(block)));
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
        TEST_BLOCK.with(|b| b.set(None));
    }

    fn body() -> Vec<u8> {
        let mut b = Vec::new();
        for (i, l) in ["alpha", "beta\r", "", "gamma \u{e9}\u{4e2d}", "d".repeat(9000).as_str(), "tail", "x".repeat(70_000).as_str(), "end"].iter().enumerate()
        {
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
}
