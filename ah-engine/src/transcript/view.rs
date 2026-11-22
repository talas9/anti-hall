//! The shared incremental view of a transcript (#953): the lines of the last `window` bytes that satisfy a predicate, kept between
//! calls. Every reader that wants "the lines of this window that hold X" (`ah.fs.tailLines` with needles, `ah.transcript.grep`,
//! the idle-teammate scan) asks here; a call reads only the bytes appended since the last one, drops the lines that left the
//! window at the front and answers with the kept ones, so its cost tracks the new bytes, never the size of the transcript.
//!
//! The answer is exactly the one a read of the whole window gives: the window is `readTail`'s (the last `window` bytes; when it
//! starts inside the file its first piece is dropped, whatever its length), the lines are the pieces of `split('\n')` of the lossily
//! decoded window (the last, unterminated one included, empty or not), with `\r` taken off every piece but the last when `crlf`.
//! A line longer than `line_max` bytes (0 = no bound) is never held: it is counted (`Found::oversize`) so the caller can answer
//! "unknown" as it did before.
//!
//! What is kept is one entry per (transcript, window, predicate key): the matching lines with their start offsets, the file's
//! identity (device, inode), the offset parsed to and a digest of both ends, so a shrink, replacement or in-place rewrite is
//! noticed and rebuilt once. Bounded by `transcript.view_max_paths`, `transcript.view_entry_max_bytes`, the `mem.transcript_view_*`
//! limits and `transcript.view_idle_ms`. Nothing here is the source of truth: the file is. With the cache off (max paths 0) or an
//! entry too big to keep, the same code answers from a fresh read.
use crate::defaults;
use crate::mem::{BoundedCache, Spec};
use std::collections::VecDeque;
use std::os::unix::fs::{FileExt, MetadataExt};
use std::sync::OnceLock;

/// What a reader asks for.
pub struct Query<'a> {
    /// Names the predicate (the same key must always mean the same predicate): part of the cache key.
    pub key: &'a str,
    /// The window: the last this many bytes.
    pub window: u64,
    /// Take a `\r` off every piece but the last (`text.split(/\r?\n/)`).
    pub crlf: bool,
    /// Longest line held, in bytes; a longer one is counted, not held. 0 = no bound.
    pub line_max: u64,
    /// Whether a line is wanted. `None` aborts the call (the predicate failed: the caller holds the reason).
    pub wants: &'a dyn Fn(&str) -> Option<bool>,
}

/// What a reader that keeps a digest of each line (not the line) asks for: `digest` returns the item to keep and its weight in
/// bytes, `Some(None)` for a line it does not want, `None` to abort the call.
pub struct DigestQuery<'a> {
    /// Names the digest function and its configuration (part of the cache key).
    pub key: &'a str,
    /// The window: the last this many bytes.
    pub window: u64,
    /// Take a `\r` off every piece but the last.
    pub crlf: bool,
    /// Longest line held, in bytes (0 = no bound); a longer one is counted, not held.
    pub line_max: u64,
    /// The digest of a line.
    pub digest: &'a dyn Fn(&str) -> Option<Option<(Item, usize)>>,
}

/// The answer of [`digests`]: the kept items oldest first, and what [`Found`] says of the window.
pub struct Digests {
    /// The kept items, oldest first.
    pub items: Vec<Item>,
    /// Where each item's line starts in the file, parallel to `items`.
    pub starts: Vec<u64>,
    /// The window starts inside the file.
    pub truncated: bool,
    /// The window held at least one element.
    pub seen: bool,
    /// Lines of the window longer than `line_max`.
    pub oversize: u64,
    /// The size of the file when the window was cut.
    pub size: u64,
}

/// The answer.
#[derive(Debug, Clone, PartialEq)]
pub struct Found {
    /// The wanted lines, oldest first (the last, unterminated element of the window included when it is wanted).
    pub lines: Vec<String>,
    /// The window starts inside the file.
    pub truncated: bool,
    /// The window held at least one element (false only for a cut window with no newline in it).
    pub seen: bool,
    /// Lines of the window longer than `line_max`.
    pub oversize: u64,
}

/// One kept item: what a reader digested from a line, shared between calls.
pub type Item = std::sync::Arc<dyn std::any::Any + Send + Sync>;

#[derive(Clone)]
struct Line {
    start: u64,
    item: Item,
    weight: usize,
}

#[derive(Clone)]
struct Kept {
    gen_: u64,
    dev: u64,
    ino: u64,
    base: u64,
    parsed_to: u64,
    head: u64,
    back: u64,
    lines: VecDeque<Line>,
    over: VecDeque<u64>,
}

fn cache() -> &'static BoundedCache<String, Kept> {
    static CACHE: OnceLock<BoundedCache<String, Kept>> = OnceLock::new();
    CACHE.get_or_init(|| {
        BoundedCache::new(
            crate::mem::global(),
            Spec::new("transcript_view", "mem.transcript_view_soft_bytes", "mem.transcript_view_hard_bytes", "mem.transcript_view_low_water_pct")
                .with_entries("transcript.view_max_paths"),
        )
    })
}

/// (entries, bytes) of the kept views, for the memory snapshot.
pub fn usage() -> (usize, u64) {
    (cache().len(), cache().bytes() as u64)
}

fn weight(k: &Kept) -> usize {
    k.lines.iter().map(|l| l.weight + std::mem::size_of::<Line>()).sum::<usize>() + k.over.len() * 8 + std::mem::size_of::<Kept>()
}

/// Why a kept entry cannot serve a window whose first line starts at `fls`, or `None` when it can.
fn miss_reason(k: &Kept, f: &std::fs::File, m: &std::fs::Metadata, fls: u64) -> Option<&'static str> {
    if k.gen_ != defaults::generation() {
        return Some("gen");
    }
    if k.dev != m.dev() || k.ino != m.ino() || m.len() < k.parsed_to {
        return Some("file");
    }
    if k.base > fls || fls > k.parsed_to {
        return Some("window");
    }
    let fp = defaults::num("transcript.evidence_fingerprint_bytes").max(1);
    let n = fp.min(k.parsed_to - k.base);
    let d = crate::script::tasks_cache::digest_at;
    if d(f, k.base, n) != Some(k.head) || d(f, k.parsed_to - n, n) != Some(k.back) {
        return Some("digest");
    }
    None
}

/// One piece of the window as text: `\r` taken off when `crlf`, lossily decoded.
fn text_of(bytes: &[u8], crlf: bool) -> String {
    let b = if crlf { bytes.strip_suffix(b"\r").unwrap_or(bytes) } else { bytes };
    crate::checks::guardkit::text::lossy_owned(b.to_vec())
}

/// The lines of the last `q.window` bytes of `path` that `q.wants`, from the kept lines plus what was appended. `Ok(None)`: the
/// file cannot be opened or read. `Err`: `q.wants` gave `None`.
pub fn matching(path: &str, q: &Query) -> Result<Option<Found>, ()> {
    let digest = |line: &str| -> Option<Option<(Item, usize)>> {
        Some((q.wants)(line)?.then(|| (std::sync::Arc::new(line.to_string()) as Item, line.len())))
    };
    let dq = DigestQuery { key: q.key, window: q.window, crlf: q.crlf, line_max: q.line_max, digest: &digest };
    Ok(digests(path, &dq)?.map(|d| Found {
        lines: d.items.iter().filter_map(|i| i.downcast_ref::<String>().cloned()).collect(),
        truncated: d.truncated,
        seen: d.seen,
        oversize: d.oversize,
    }))
}

/// The items [`DigestQuery::digest`] kept for the lines of the last `q.window` bytes of `path`, from the kept items plus what was
/// appended. `Ok(None)`: the file cannot be opened or read. `Err`: the digest function aborted.
pub fn digests(path: &str, q: &DigestQuery) -> Result<Option<Digests>, ()> {
    let Ok(f) = std::fs::File::open(path) else { return Ok(None) };
    let Ok(m) = f.metadata() else { return Ok(None) };
    if !m.is_file() {
        return Ok(None);
    }
    let _turn = crate::transcript::scan::permit();
    let size = m.len();
    let truncated = size > q.window;
    let fls = if truncated {
        match crate::script::tasks_cache::first_line_start(&f, size - q.window, size) {
            None => return Ok(None),
            // the window holds no newline: its one piece is the cut first line, which is dropped
            Some(None) => return Ok(Some(Digests { items: Vec::new(), starts: Vec::new(), truncated: true, seen: false, oversize: 0, size })),
            Some(Some(s)) => s,
        }
    } else {
        0
    };
    let key = format!("{path}\0{}\0{}", q.window, q.key);
    let fresh = || Kept {
        gen_: defaults::generation(),
        dev: m.dev(),
        ino: m.ino(),
        base: fls,
        parsed_to: fls,
        head: 0,
        back: 0,
        lines: VecDeque::new(),
        over: VecDeque::new(),
    };
    let mut k = match cache().remove(&key) {
        Some(k) => match miss_reason(&k, &f, &m, fls) {
            None => {
                crate::load::note_count("transcript_cache", "result", if size == k.parsed_to { "hit" } else { "append" });
                k
            }
            Some(reason) => {
                crate::load::note_count("transcript_cache", "result", "rebuild");
                crate::load::note_count("transcript_cache_rebuild", "reason", reason);
                fresh()
            }
        },
        None => {
            crate::load::note_count("transcript_cache", "result", "rebuild");
            crate::load::note_count("transcript_cache_rebuild", "reason", "none");
            fresh()
        }
    };
    while k.lines.front().is_some_and(|l| l.start < fls) {
        k.lines.pop_front();
    }
    while k.over.front().is_some_and(|s| *s < fls) {
        k.over.pop_front();
    }
    k.base = fls;
    // read what was appended, a block at a time: the complete lines are judged for good, the last one (no newline yet) now and again
    let block = crate::transcript::scan::block_bytes();
    let mut buf = vec![0u8; block];
    let (mut carry, mut carry_len, mut carry_over): (Vec<u8>, u64, bool) = (Vec::new(), 0, false);
    let mut pos = k.parsed_to;
    let line_max = q.line_max;
    while pos < size {
        let n = ((size - pos) as usize).min(block);
        if f.read_exact_at(buf.get_mut(..n).unwrap_or_default(), pos).is_err() {
            return Ok(None);
        }
        crate::load::note_scan(n as u64);
        pos += n as u64;
        let mut rest = buf.get(..n).unwrap_or_default();
        loop {
            let nl = rest.iter().position(|b| *b == b'\n');
            let part = match nl {
                Some(i) => rest.get(..i).unwrap_or_default(),
                None => rest,
            };
            carry_len += part.len() as u64;
            if !carry_over {
                if line_max > 0 && carry_len > line_max {
                    carry_over = true;
                    carry = Vec::new();
                } else {
                    carry.extend_from_slice(part);
                }
            }
            let Some(i) = nl else { break };
            let start = k.parsed_to;
            if carry_over {
                k.over.push_back(start);
            } else {
                let text = text_of(&carry, q.crlf);
                match (q.digest)(&text) {
                    None => return Err(()),
                    Some(Some((item, weight))) => k.lines.push_back(Line { start, item, weight }),
                    Some(None) => {}
                }
            }
            k.parsed_to += carry_len + 1;
            carry.clear();
            (carry_len, carry_over) = (0, false);
            rest = rest.get(i + 1..).unwrap_or_default();
        }
    }
    // the last element: no newline after it, so no `\r` goes with a separator
    let mut oversize = k.over.len() as u64;
    let mut last: Option<(u64, Item)> = None;
    if carry_over {
        oversize += 1;
    } else {
        let text = text_of(&carry, false);
        match (q.digest)(&text) {
            None => return Err(()),
            Some(Some((item, _))) => last = Some((k.parsed_to, item)),
            Some(None) => {}
        }
    }
    let starts: Vec<u64> = k.lines.iter().map(|l| l.start).chain(last.iter().map(|(s, _)| *s)).collect();
    let items: Vec<Item> = k.lines.iter().map(|l| l.item.clone()).chain(last.map(|(_, i)| i)).collect();
    let found = Digests { items, starts, truncated, seen: true, oversize, size };
    // keep it for the next call, with a digest of both ends
    let fp = defaults::num("transcript.evidence_fingerprint_bytes").max(1);
    let n = fp.min(k.parsed_to - k.base);
    let w = weight(&k);
    if defaults::num("transcript.view_max_paths") > 0
        && w as u64 <= defaults::num("transcript.view_entry_max_bytes")
        && let (Some(head), Some(back)) =
            (crate::script::tasks_cache::digest_at(&f, k.base, n), crate::script::tasks_cache::digest_at(&f, k.parsed_to - n, n))
    {
        k.head = head;
        k.back = back;
        let ttl = defaults::num("transcript.view_idle_ms");
        let exp = (ttl > 0).then(|| crate::health::now_ms().saturating_add(ttl));
        cache().insert_with_ttl(key, k, w, exp);
    }
    Ok(Some(found))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transcript::scan::{Flow, Window};
    use std::io::Write;

    fn dir(tag: &str) -> std::path::PathBuf {
        crate::tmpsweep::scratch("ah-view-", tag)
    }

    /// The read of the whole window the view must equal: `Window` lines, the predicate on each, `\r` off every piece but the last.
    fn reference(path: &str, window: u64, crlf: bool, line_max: u64, wants: &dyn Fn(&str) -> bool) -> Option<Found> {
        let mut w = Window::open(path, window)?;
        let (mut lines, mut seen, mut oversize) = (Vec::new(), false, 0u64);
        w.lines_ex(|piece, last| {
            seen = true;
            if line_max > 0 && piece.len() as u64 > line_max {
                oversize += 1;
                return Flow::Next;
            }
            let piece = if crlf && !last { piece.strip_suffix(b"\r").unwrap_or(piece) } else { piece };
            let line = String::from_utf8_lossy(piece).into_owned();
            if wants(&line) {
                lines.push(line);
            }
            Flow::Next
        })
        .ok()?;
        Some(Found { lines, truncated: w.truncated(), seen, oversize })
    }

    fn ask(path: &str, window: u64, crlf: bool, line_max: u64) -> Option<Found> {
        let wants = |l: &str| Some(l.contains("needle"));
        // the key names everything the predicate and the line shape depend on, as a real caller's does
        let key = format!("t{crlf}{line_max}");
        let q = Query { key: &key, window, crlf, line_max, wants: &wants };
        matching(path, &q).unwrap()
    }

    fn parity(path: &str, window: u64, crlf: bool, line_max: u64) {
        let got = ask(path, window, crlf, line_max);
        let want = reference(path, window, crlf, line_max, &|l| l.contains("needle"));
        assert_eq!(got, want, "window {window} crlf {crlf} line_max {line_max}");
    }

    fn append(path: &str, text: &str) {
        let mut f = std::fs::OpenOptions::new().create(true).append(true).open(path).unwrap();
        f.write_all(text.as_bytes()).unwrap();
    }

    #[test]
    fn the_view_answers_as_a_read_of_the_whole_window_across_appends_and_windows() {
        let d = dir("parity");
        let p = d.join("t.jsonl").to_string_lossy().to_string();
        let mut n = 0;
        for round in 0..40 {
            for _ in 0..(round % 4 + 1) {
                n += 1;
                append(&p, &format!("{{\"i\":{n},\"t\":\"{}{}\"}}\r\n", if n % 3 == 0 { "needle " } else { "plain " }, "x".repeat(n % 17)));
            }
            if round % 5 == 0 {
                append(&p, "partial needle without newline"); // an unterminated last element, completed next round
            }
            for w in [1, 7, 64, 200, 1000, 100_000] {
                for crlf in [false, true] {
                    parity(&p, w, crlf, 0);
                    parity(&p, w, crlf, 40);
                }
            }
            if round % 5 == 0 {
                append(&p, "\n");
            }
        }
    }

    #[test]
    fn an_empty_file_and_a_cut_window_without_a_newline_answer_as_the_whole_read_does() {
        let d = dir("edges");
        let p = d.join("e.jsonl").to_string_lossy().to_string();
        std::fs::write(&p, "").unwrap();
        parity(&p, 100, false, 0);
        std::fs::write(&p, "one long line with a needle and no newline at all").unwrap();
        parity(&p, 10, false, 0);
        parity(&p, 1000, false, 0);
        std::fs::write(&p, "a needle\n").unwrap();
        for w in 1..12 {
            parity(&p, w, true, 0);
        }
        assert_eq!(ask(&d.join("missing").to_string_lossy(), 10, false, 0), None);
    }

    #[test]
    fn a_shrunk_replaced_or_rewritten_transcript_is_rebuilt_never_served_stale() {
        let d = dir("rewrite");
        let p = d.join("r.jsonl").to_string_lossy().to_string();
        let big: String = (0..200).map(|i| format!("line {i} needle {}\n", "y".repeat(30))).collect();
        std::fs::write(&p, &big).unwrap();
        parity(&p, 1_000_000, false, 0);
        parity(&p, 1_000_000, false, 0);
        // compaction: the file shrinks to a short one
        std::fs::write(&p, "fresh needle\nother\n").unwrap();
        parity(&p, 1_000_000, false, 0);
        // replaced by another file of the same size (new inode)
        let q = d.join("r2.jsonl");
        std::fs::write(&q, "fresh NEEDLE\nother\n").unwrap();
        std::fs::rename(&q, &p).unwrap();
        parity(&p, 1_000_000, false, 0);
        // rewritten in place at the same length and the same inode
        let same = "fresh needle\nxther\n";
        std::fs::OpenOptions::new().write(true).open(&p).unwrap().write_all_at(same.as_bytes(), 0).unwrap();
        parity(&p, 1_000_000, false, 0);
        std::fs::OpenOptions::new().write(true).open(&p).unwrap().write_all_at(b"zzzzz needle\n", 0).unwrap();
        parity(&p, 1_000_000, false, 0);
    }

    /// The point of the view: after the first call, a call that follows one appended turn reads about the appended bytes, not the window.
    #[test]
    fn a_call_after_one_appended_turn_reads_the_appended_bytes_and_not_the_window() {
        let d = dir("bounded");
        let p = d.join("b.jsonl").to_string_lossy().to_string();
        let big: String = (0..40_000).map(|i| format!("{{\"i\":{i},\"pad\":\"{}\",\"k\":\"{}\"}}\n", "p".repeat(60), if i % 500 == 0 { "needle" } else { "x" })).collect();
        std::fs::write(&p, &big).unwrap();
        let window = 1 << 40;
        crate::load::take_check_scan();
        ask(&p, window, false, 0);
        let cold = crate::load::take_check_scan();
        assert!(cold >= big.len() as u64, "the first call reads the window: {cold}");
        ask(&p, window, false, 0);
        let same = crate::load::take_check_scan();
        let turn = "{\"i\":-1,\"k\":\"needle\"}\n{\"i\":-2,\"k\":\"x\"}\n";
        append(&p, turn);
        let got = ask(&p, window, false, 0).unwrap();
        let appended = crate::load::take_check_scan();
        assert_eq!(Some(got), reference(&p, window, false, 0, &|l| l.contains("needle")));
        let slack = 2 * defaults::num("transcript.evidence_fingerprint_bytes");
        assert!(same <= slack, "an unchanged file reads only the digests: {same}");
        assert!(appended <= turn.len() as u64 + slack + 4096, "one appended turn read {appended} bytes of a {} byte window", big.len());
    }
}
