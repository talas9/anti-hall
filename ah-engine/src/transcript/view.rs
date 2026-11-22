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

/// A digest of the consumed bytes `[start, start + len)` of the file, sealed when they were read: the proof that they have not been
/// rewritten since.
#[derive(Clone, Copy)]
struct Rec {
    start: u64,
    len: u64,
    digest: u64,
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
    /// Digests of the consumed bytes, in order, contiguous up to `parsed_to` (the bytes before `base` stay in until a record is wholly before it).
    recs: VecDeque<Rec>,
    /// Where the next call's rotating verification of `recs` starts.
    cursor: usize,
    lines: VecDeque<Line>,
    over: VecDeque<u64>,
}

/// A cache key naming `parts`, each prefixed by its length so that no choice of parts (a separator inside one of them included) can
/// give the key of another list.
pub fn key_of(parts: &[&str]) -> String {
    use std::fmt::Write;
    parts.iter().fold(String::new(), |mut k, p| {
        let _ = write!(k, "{}:{p};", p.len());
        k
    })
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

/// What a kept entry costs the cache: every line (its item, the `Arc` that shares it, the slot), every sealed record and every
/// start offset, counted by the capacity the queues hold and not only by what they use.
fn weight(k: &Kept) -> usize {
    let per_line = std::mem::size_of::<Line>() + 2 * std::mem::size_of::<usize>();
    k.lines.iter().map(|l| l.weight + per_line).sum::<usize>()
        + (k.lines.capacity() - k.lines.len()) * std::mem::size_of::<Line>()
        + k.over.capacity() * 8
        + k.recs.capacity() * std::mem::size_of::<Rec>()
        + std::mem::size_of::<Kept>()
}

/// The most the records `seal` would add for `bytes` new bytes, in blocks of `seg`.
fn sealing_cost(bytes: u64, seg: u64) -> usize {
    usize::try_from(bytes.div_ceil(seg.max(1))).unwrap_or(usize::MAX).saturating_mul(std::mem::size_of::<Rec>())
}

/// Why a kept entry cannot serve a window whose first line starts at `fls`, or `None` when it can.
fn miss_reason(k: &mut Kept, f: &std::fs::File, m: &std::fs::Metadata, fls: u64) -> Option<&'static str> {
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
    // the consumed bytes: the record nearest the boundary every call (it counts within the budget), then the next ones round the ring
    // until `view_verify_bytes` have been hashed, and always at least one of them, so the rotation advances whatever the budget: a
    // rewrite anywhere before the boundary (a same-length edit, a truncate and regrowth that kept both ends) is met within
    // `ceil(ring bytes / (budget - last block))` calls at the most, and at once when the consumed part fits in the budget
    let budget = defaults::num("transcript.view_verify_bytes").max(1);
    let count = k.recs.len();
    let mut spent = 0u64;
    let check = |r: &Rec| d(f, r.start, r.len) == Some(r.digest);
    if let Some(last) = k.recs.back() {
        if !check(last) {
            return Some("rewrite");
        }
        spent += last.len;
    }
    let ring = count.saturating_sub(1);
    let mut walked = 0usize;
    while walked < ring {
        let Some(r) = k.recs.get((k.cursor + walked) % ring) else { break };
        if walked > 0 && spent + r.len > budget {
            break;
        }
        if !check(r) {
            return Some("rewrite");
        }
        spent += r.len;
        walked += 1;
    }
    if ring > 0 {
        k.cursor = (k.cursor + walked) % ring;
    }
    None
}

/// Seal the consumed bytes `[from, to)` into `recs`, in pieces of at most `seg` bytes (the last record is grown first while it is
/// shorter, so that many small appends do not make many records). False: the file could not be read there.
fn seal(recs: &mut VecDeque<Rec>, f: &std::fs::File, from: u64, to: u64, seg: u64) -> bool {
    let d = crate::script::tasks_cache::digest_at;
    let mut at = from;
    if let Some(l) = recs.back().copied().filter(|l| l.start + l.len == from && l.len < seg) {
        let len = l.len + (seg - l.len).min(to - from);
        let Some(digest) = d(f, l.start, len) else { return false };
        recs.pop_back();
        recs.push_back(Rec { start: l.start, len, digest });
        at = l.start + len;
    }
    while at < to {
        let len = seg.min(to - at);
        let Some(digest) = d(f, at, len) else { return false };
        recs.push_back(Rec { start: at, len, digest });
        at += len;
    }
    true
}

/// One piece of the window as text: `\r` taken off when `crlf`, lossily decoded.
fn text_of(bytes: &[u8], crlf: bool) -> String {
    let b = if crlf { bytes.strip_suffix(b"\r").unwrap_or(bytes) } else { bytes };
    crate::checks::guardkit::text::lossy_owned(b.to_vec())
}

/// The lines of the last `q.window` bytes of `path` that `q.wants`, from the kept lines plus what was appended. `Ok(None)`: the
/// file cannot be opened or read. `Err`: `q.wants` gave `None`.
pub fn matching(path: &str, q: &Query) -> Result<Option<Found>, ()> {
    let digest = |line: &str| -> Option<Option<(Item, usize)>> { Some((q.wants)(line)?.then(|| (std::sync::Arc::new(line.to_string()) as Item, line.len()))) };
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
        recs: VecDeque::new(),
        cursor: 0,
        lines: VecDeque::new(),
        over: VecDeque::new(),
    };
    let mut k = match cache().remove(&key) {
        Some(mut k) => match miss_reason(&mut k, &f, &m, fls) {
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
    while k.recs.front().is_some_and(|r| r.start + r.len <= fls) {
        k.recs.pop_front();
    }
    let sealed_from = k.parsed_to;
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
    // the entry is counted against the cache before its records are made: one that cannot be kept is neither hashed nor grown
    let (max_paths, entry_max) = (defaults::num("transcript.view_max_paths"), defaults::num("transcript.view_entry_max_bytes"));
    let fits = max_paths > 0 && (weight(&k) + sealing_cost(k.parsed_to.saturating_sub(sealed_from), block as u64)) as u64 <= entry_max;
    let sealed = fits && (k.parsed_to <= sealed_from || seal(&mut k.recs, &f, sealed_from, k.parsed_to, block as u64));
    let w = weight(&k);
    if sealed
        && w as u64 <= entry_max
        && let (Some(head), Some(back)) = (crate::script::tasks_cache::digest_at(&f, k.base, n), crate::script::tasks_cache::digest_at(&f, k.parsed_to - n, n))
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
        let big: String =
            (0..40_000).map(|i| format!("{{\"i\":{i},\"pad\":\"{}\",\"k\":\"{}\"}}\n", "p".repeat(60), if i % 500 == 0 { "needle" } else { "x" })).collect();
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

    /// Measurement (#953): the bytes one warm append-one-turn call reads (parse reads plus verification hashes) and its CPU on a
    /// synthetic 16 MiB window. Prints; `cargo test -- --nocapture` shows it.
    #[test]
    fn measure_a_warm_append_on_a_16_mib_window() {
        let d = dir("measure");
        let p = d.join("w.jsonl").to_string_lossy().to_string();
        let big: String = (0..(16 << 20) / 89 + 1)
            .map(|i| format!("{{\"i\":{i},\"pad\":\"{}\",\"k\":\"{}\"}}\n", "p".repeat(60), if i % 500 == 0 { "needle" } else { "x" }))
            .collect();
        std::fs::write(&p, &big).unwrap();
        let window = 1u64 << 40;
        // 4 MiB is the budget before #953 item 2 (the old default); 1 MiB is the new default
        for budget in [4_194_304u64, 1_048_576] {
            let _budget = Setting::set("transcript.view_verify_bytes", budget);
            let cpu = || {
                let mut u: libc::rusage = unsafe { std::mem::zeroed() };
                unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut u) };
                u.ru_utime.tv_sec as u64 * 1_000_000 + u.ru_utime.tv_usec as u64 + u.ru_stime.tv_sec as u64 * 1_000_000 + u.ru_stime.tv_usec as u64
            };
            let (mut cold, mut warm_same) = ((0, 0, 0), (0, 0, 0));
            let run = |out: &mut (u64, u64, u64)| {
                crate::load::take_check_scan();
                crate::script::tasks_cache::take_digest_read();
                let c0 = cpu();
                ask(&p, window, false, 0);
                *out = (crate::load::take_check_scan(), crate::script::tasks_cache::take_digest_read(), cpu() - c0);
            };
            run(&mut cold);
            run(&mut warm_same);
            let mut rows = Vec::new();
            for i in 0..6 {
                append(&p, &format!("{{\"i\":-{i},\"k\":\"needle\"}}\n{{\"i\":-{i},\"k\":\"x\"}}\n"));
                let mut r = (0, 0, 0);
                run(&mut r);
                rows.push(r);
            }
            eprintln!(
                "MEASURE window={} verify_bytes={} block={}",
                big.len(),
                defaults::num("transcript.view_verify_bytes"),
                crate::transcript::scan::block_bytes()
            );
            eprintln!("MEASURE cold(parse,digest,cpu_us)={cold:?} warm_same={warm_same:?}");
            for (i, r) in rows.iter().enumerate() {
                eprintln!("MEASURE append#{i} parse_bytes={} digest_bytes={} total={} cpu_us={}", r.0, r.1, r.0 + r.1, r.2);
            }
        }
    }

    #[test]
    fn a_needle_holding_the_old_separator_does_not_share_the_key_of_two_needles() {
        assert_ne!(key_of(&["a\u{1f}b"]), key_of(&["a", "b"]));
        assert_ne!(key_of(&["ab", ""]), key_of(&["a", "b"]));
        assert_ne!(key_of(&["1:x;", "y"]), key_of(&["1:x", ";y"]));
        assert_eq!(key_of(&["a", "b"]), key_of(&["a", "b"]));
    }

    #[test]
    fn two_needle_lists_that_joined_alike_read_their_own_lines() {
        let d = dir("keys");
        let p = d.join("k.jsonl").to_string_lossy().to_string();
        std::fs::write(&p, "has x\u{1f}y here\nhas x and y here\nplain\n").unwrap();
        let ask_with = |needles: &[&str]| {
            let wants = |l: &str| Some(needles.iter().any(|n| l.contains(n)));
            let key = key_of(needles);
            matching(&p, &Query { key: &key, window: 1 << 20, crlf: false, line_max: 0, wants: &wants }).unwrap().unwrap().lines
        };
        assert_eq!(ask_with(&["x\u{1f}y"]), vec!["has x\u{1f}y here".to_string()]);
        assert_eq!(ask_with(&["x", "y"]).len(), 2, "not the answer kept for the single needle");
    }

    fn lines_file(n: usize, tag: &str) -> String {
        (0..n).map(|i| format!("line {i:04} {tag} needle {}\n", "y".repeat(40))).collect()
    }

    /// A same-length edit of a middle line, far from both ends of a file over 8 KiB and from the read boundary, with the inode and the
    /// size unchanged: the old fingerprints of the two ends cannot see it, the consumed-byte records must.
    #[test]
    fn a_same_length_rewrite_of_a_middle_line_is_not_served_stale() {
        let d = dir("middle");
        let p = d.join("m.jsonl").to_string_lossy().to_string();
        let big = lines_file(400, "a");
        assert!(big.len() > 8 * 1024 * 2);
        std::fs::write(&p, &big).unwrap();
        parity(&p, 1_000_000, false, 0);
        let at = big.find("line 0200").unwrap() + big[big.find("line 0200").unwrap()..].find("needle").unwrap();
        assert!(at as u64 > 4096 * 2 && (big.len() - at) as u64 > 4096 * 2, "the edit is outside both fingerprints");
        std::fs::OpenOptions::new().write(true).open(&p).unwrap().write_all_at(b"NEEDLE", at as u64).unwrap();
        let got = ask(&p, 1_000_000, false, 0);
        assert_eq!(got, reference(&p, 1_000_000, false, 0, &|l| l.contains("needle")));
        assert_eq!(got.unwrap().lines.len(), 399, "the edited line no longer holds the needle");
    }

    /// A truncate and regrowth that keeps the first and last bytes the old fingerprints look at, at the same size and past it.
    #[test]
    fn a_truncate_and_regrowth_that_keeps_both_ends_is_not_served_stale() {
        for (name, extra) in [("same", 0usize), ("past", 7)] {
            let d = dir(&format!("regrow-{name}"));
            let p = d.join("g.jsonl").to_string_lossy().to_string();
            let big = lines_file(400, "a");
            std::fs::write(&p, &big).unwrap();
            parity(&p, 1_000_000, false, 0);
            let fp = 4096usize;
            let (head, tail) = (&big[..fp + 100], &big[big.len() - fp - 100..]);
            let mid_len = big.len() - head.len() - tail.len();
            let mut mid = lines_file(400, "b").replace("needle", "noodle");
            mid.truncate(mid_len);
            let mut grown = format!("{head}{mid}{tail}");
            grown.push_str(&lines_file(extra, "c"));
            assert!(grown.len() >= big.len());
            std::fs::write(&p, &grown).unwrap(); // truncates the same inode, then regrows it
            let got = ask(&p, 1_000_000, false, 0);
            assert_eq!(got, reference(&p, 1_000_000, false, 0, &|l| l.contains("needle")), "{name}");
        }
    }

    /// A consumed part sealed in many records still meets a rewrite deep inside it.
    #[test]
    fn a_rewrite_deep_in_a_consumed_part_sealed_in_many_records_is_met() {
        let d = dir("rotation");
        let p = d.join("o.jsonl").to_string_lossy().to_string();
        let big = lines_file(3000, "a");
        std::fs::write(&p, &big).unwrap();
        crate::transcript::scan::set_test_block(4096); // many records
        parity(&p, 10_000_000, false, 0);
        assert!(cache().values().iter().any(|k| k.recs.len() > 8), "the consumed part is sealed in many records");
        let at = big.find("line 1500").unwrap() + 14;
        std::fs::OpenOptions::new().write(true).open(&p).unwrap().write_all_at(b"NEEDLE", at as u64).unwrap();
        let want = reference(&p, 10_000_000, false, 0, &|l| l.contains("needle"));
        let got = ask(&p, 10_000_000, false, 0);
        crate::transcript::scan::set_test_block(0);
        assert_eq!(got, want);
    }

    /// Installs one owner setting for a test and removes it on drop (the overlay is process-wide).
    struct Setting;

    impl Setting {
        fn set(key: &str, v: u64) -> Setting {
            defaults::set_overlay(&[(key, serde_json::json!(v))]);
            Setting
        }
    }

    impl Drop for Setting {
        fn drop(&mut self) {
            defaults::set_overlay(&[]);
        }
    }

    fn cursor_of(key_part: &str) -> usize {
        cache().values().iter().map(|k| k.cursor).max().unwrap_or_else(|| panic!("no view kept for {key_part}"))
    }

    /// A budget below two blocks used to leave the rotation where it was for ever; it must advance a record a call, and a deep
    /// same-length rewrite must be met within the documented number of calls: `ceil(consumed / max(block, budget - block))`.
    #[test]
    fn a_small_budget_still_advances_the_rotation_and_meets_a_deep_rewrite_within_the_documented_calls() {
        let d = dir("small-budget");
        let p = d.join("s.jsonl").to_string_lossy().to_string();
        // about 4 MiB (sixteen records of the configured 256 KiB block), one line in 500 matching so that the view is small enough to keep
        let big: String = (0..60_000).map(|i| format!("line {i:05} {} {}\n", if i % 500 == 0 { "needle" } else { "plain" }, "y".repeat(50))).collect();
        std::fs::write(&p, &big).unwrap();
        let block = crate::transcript::scan::block_bytes() as u64;
        // the key's minimum is one block, so the last record alone spends the whole budget (the stuck case of a 4096 budget, clamped)
        let _budget = Setting::set("transcript.view_verify_bytes", 4096);
        let budget = defaults::num("transcript.view_verify_bytes");
        assert_eq!(budget, block, "the setting cannot go below one block");
        parity(&p, 10_000_000, false, 0);
        parity(&p, 10_000_000, false, 0);
        let first = cursor_of("a");
        parity(&p, 10_000_000, false, 0);
        assert_ne!(cursor_of("a"), first, "the rotation advanced although the budget holds only the mandatory last record");
        let at = big.find("line 01000").unwrap() + 11; // far from the read boundary
        assert!(cache().values().iter().any(|k| k.recs.len() > 8), "sealed in many records");
        std::fs::OpenOptions::new().write(true).open(&p).unwrap().write_all_at(b"NEEDLE", at as u64).unwrap();
        let want = reference(&p, 10_000_000, false, 0, &|l| l.contains("needle"));
        let bound = (big.len() as u64).div_ceil(block.max(budget.saturating_sub(block))) + 1;
        let mut calls = 0u64;
        while ask(&p, 10_000_000, false, 0) != want {
            calls += 1;
            assert!(calls <= bound, "still stale after {calls} calls (bound {bound})");
        }
    }

    /// A transcript truncated and regrown in place (same inode) with new content is met on the first call, with the consumed part
    /// sealed in many records: the digest of the bytes just before the read position and the one at the start see it.
    #[test]
    fn a_truncate_and_regrowth_with_new_content_is_met_on_the_first_call_with_many_records() {
        for (name, extra) in [("same", 0usize), ("past", 9)] {
            let d = dir(&format!("regrow-many-{name}"));
            let p = d.join("g.jsonl").to_string_lossy().to_string();
            crate::transcript::scan::set_test_block(4096);
            std::fs::write(&p, lines_file(3000, "a")).unwrap();
            parity(&p, 10_000_000, false, 0);
            parity(&p, 10_000_000, false, 0);
            assert!(cache().values().iter().any(|k| k.recs.len() > 8));
            let mut grown = lines_file(3000, "b").replace("needle", "noodle");
            grown.push_str(&lines_file(extra, "c"));
            std::fs::write(&p, grown).unwrap(); // truncates the same inode, then regrows it
            let got = ask(&p, 10_000_000, false, 0);
            crate::transcript::scan::set_test_block(0);
            assert_eq!(got, reference(&p, 10_000_000, false, 0, &|l| l.contains("needle")), "{name}");
        }
    }

    /// The view's records and lines are counted against the cache before it is admitted: an entry that cannot be kept is not even
    /// sealed (no record is hashed), and one that can is charged for its records.
    #[test]
    fn digest_memory_is_counted_before_admission() {
        let d = dir("admission");
        let window = 1u64 << 40;
        // every line matches: the kept lines alone exceed the entry limit
        let all: String = (0..60_000).map(|i| format!("needle line {i:06} {}\n", "z".repeat(60))).collect();
        assert!(all.len() as u64 > defaults::num("transcript.view_entry_max_bytes"));
        let big = d.join("big.jsonl").to_string_lossy().to_string();
        std::fs::write(&big, &all).unwrap();
        crate::script::tasks_cache::take_digest_read();
        let got = ask(&big, window, false, 0).unwrap();
        assert_eq!(got.lines.len(), 60_000, "the answer is whole whether or not the entry is kept");
        assert_eq!(crate::script::tasks_cache::take_digest_read(), 0, "nothing was hashed for an entry that cannot be kept");
        assert!(cache().values().iter().all(|k| k.lines.len() != 60_000), "and it was not kept");
        // a small one is kept, charged for its lines, its slack and its records
        let small = d.join("small.jsonl").to_string_lossy().to_string();
        std::fs::write(&small, lines_file(300, "a")).unwrap();
        ask(&small, window, false, 0);
        assert!(crate::script::tasks_cache::take_digest_read() > 0, "a keepable entry is sealed");
        let k = cache().values().into_iter().find(|k| k.lines.len() == 300).expect("the small view is kept");
        let floor: usize = k.lines.iter().map(|l| l.weight).sum::<usize>() + k.recs.len() * std::mem::size_of::<Rec>();
        assert!(
            weight(&k) > floor + 300 * std::mem::size_of::<Line>(),
            "the charge covers the shared items and the records, not only the text: {} vs {floor}",
            weight(&k)
        );
    }

    #[test]
    fn the_verify_budget_cannot_be_set_below_one_block() {
        let toml: toml::Table =
            std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall/engine/defaults/transcript.toml"))
                .unwrap()
                .parse()
                .unwrap();
        let get = |k: &str, f: &str| toml["transcript"][k][f].as_integer().unwrap();
        assert!(get("view_verify_bytes", "min") >= get("read_block_bytes", "value"));
        assert!(get("view_verify_bytes", "value") >= get("view_verify_bytes", "min"));
    }

    /// An expired view is dropped and rebuilt, never reused (the read after it covers the whole window again).
    #[test]
    fn an_expired_view_is_rebuilt_not_reused() {
        let d = dir("expiry");
        let p = d.join("x.jsonl").to_string_lossy().to_string();
        let big = lines_file(2000, "a");
        std::fs::write(&p, &big).unwrap();
        let window = 1 << 40;
        ask(&p, window, false, 0);
        crate::load::take_check_scan();
        ask(&p, window, false, 0);
        assert!(crate::load::take_check_scan() < 16 * 1024, "a live view is reused");
        let key = format!("{p}\0{window}\0t{}{}", false, 0);
        let kept = cache().remove(&key).expect("the view is kept");
        assert!(cache().insert_with_ttl(key, kept, 1024, Some(crate::health::now_ms().saturating_sub(1))));
        crate::load::take_check_scan();
        ask(&p, window, false, 0);
        assert!(crate::load::take_check_scan() >= big.len() as u64, "an expired view is read afresh");
    }
}
