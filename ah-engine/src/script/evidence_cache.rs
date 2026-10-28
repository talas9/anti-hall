//! The evidence of a transcript, kept between calls (task 66): `ah.transcript.evidence` turns the last `window` bytes of a transcript
//! into its items, and a Stop asks for it again after every few kilobytes. What one line contributes does not depend on the
//! other lines, so the items of every complete line are kept with the byte offset the line starts at; a call then reads only the
//! bytes appended since the last one, drops the lines that left the window at the front, and joins what is kept. The answer is the
//! very text a fresh read of the window gives ([`super::host_ts::evidence_uncached`]); a test compares them across appends,
//! windows, truncations, replacements and unreadable lines.
//!
//! What is kept is bounded: `transcript.evidence_cache_max_paths` transcripts at most, each at most
//! `transcript.evidence_cache_entry_max_bytes`, all together under the `mem.evidence_cache_*` limits, and an entry unused for
//! `transcript.evidence_cache_idle_ms` goes. Nothing here is the source of truth: the file is. A cache that cannot answer (the
//! feature off, a file that cannot be read) hands the call to the plain reader, so a failure here is slower, never different.
use super::host_ts::{Item, LineEv, answer, items_json, line_items, unsure};
use crate::defaults;
use crate::mem::{BoundedCache, Spec};
use std::collections::VecDeque;
use std::os::unix::fs::{FileExt, MetadataExt};
use std::sync::OnceLock;

/// One complete line of the transcript: where it starts, what it contributes, and whether only JavaScript can read it.
#[derive(Clone)]
pub(super) struct Line {
    start: u64,
    pub(super) items: Vec<Item>,
    chars: usize,
    unsure: bool,
}

/// What is kept of one transcript: the lines from `base` to `parsed_to` (all complete, each ending in a newline), with the file's
/// identity and a digest of its first and last bytes so a rewritten file is noticed.
#[derive(Clone)]
struct Kept {
    dev: u64,
    ino: u64,
    base: u64,
    parsed_to: u64,
    head: u64,
    back: u64,
    lines: VecDeque<Line>,
}

fn cache() -> &'static BoundedCache<String, Kept> {
    static CACHE: OnceLock<BoundedCache<String, Kept>> = OnceLock::new();
    CACHE.get_or_init(|| {
        BoundedCache::new(
            crate::mem::global(),
            Spec::new("evidence_cache", "mem.evidence_cache_soft_bytes", "mem.evidence_cache_hard_bytes", "mem.evidence_cache_low_water_pct")
                .with_entries("transcript.evidence_cache_max_paths"),
        )
    })
}

/// A cheap digest of `len` bytes of the file at `at` (`None` when they cannot be read).
fn digest_at(f: &std::fs::File, at: u64, len: u64) -> Option<u64> {
    use std::hash::Hasher;
    let mut b = vec![0u8; len as usize];
    f.read_exact_at(&mut b, at).ok()?;
    let mut h = std::collections::hash_map::DefaultHasher::new();
    h.write(&b);
    Some(h.finish())
}

/// Where the first line of a window starts: the byte after the first newline at or after `from`, which is how a window cut out of
/// a file loses its first (partial) line. `Ok(None)` when no newline follows (the window holds no whole line).
fn first_line_start(f: &std::fs::File, from: u64, size: u64) -> Option<Option<u64>> {
    // a line is usually short: look in small steps first, then in larger ones up to the configured chunk
    let chunk = defaults::num("transcript.evidence_read_chunk_bytes").max(1);
    let mut step = chunk.min(defaults::num("transcript.tasks_cache_probe_bytes").max(1));
    let mut at = from;
    let mut buf: Vec<u8> = Vec::new();
    while at < size {
        let n = step.min(size - at) as usize;
        buf.resize(n, 0);
        f.read_exact_at(&mut buf, at).ok()?;
        crate::load::note_scan(n as u64);
        if let Some(i) = buf.iter().position(|b| *b == b'\n') {
            return Some(Some(at + i as u64 + 1));
        }
        at += n as u64;
        step = (step * 2).min(chunk);
    }
    Some(None)
}

/// The evidence of one line's bytes, as a [`Line`] starting at `start` (a trailing `\r` goes with the newline).
fn make_line(start: u64, bytes: &[u8]) -> Line {
    let text = crate::checks::guardkit::text::lossy_owned(bytes.to_vec());
    let line = text.strip_suffix('\r').unwrap_or(&text);
    match line_items(line) {
        Err(()) => Line { start, items: Vec::new(), chars: 0, unsure: true },
        Ok(None) => Line { start, items: Vec::new(), chars: 0, unsure: false },
        Ok(Some(LineEv { items, chars })) => Line { start, items, chars, unsure: false },
    }
}

fn weight(k: &Kept) -> usize {
    k.lines.iter().map(|l| l.items.iter().map(Item::weight).sum::<usize>() + std::mem::size_of::<Line>()).sum::<usize>() + std::mem::size_of::<Kept>()
}

/// Why a kept entry cannot serve a window starting at `fls`, or `None` when it can.
fn miss_reason(k: &Kept, f: &std::fs::File, m: &std::fs::Metadata, fls: u64) -> Option<&'static str> {
    if k.dev != m.dev() || k.ino != m.ino() || m.len() < k.parsed_to {
        return Some("file");
    }
    if k.base > fls || fls > k.parsed_to {
        return Some("window");
    }
    let fp = defaults::num("transcript.evidence_fingerprint_bytes").max(1);
    let n = fp.min(k.parsed_to - k.base);
    if digest_at(f, k.base, n) != Some(k.head) || digest_at(f, k.parsed_to - n, n) != Some(k.back) {
        return Some("digest");
    }
    None
}

/// The answer for the last `w` bytes of `path`, from the kept lines plus what was appended; `None` when the call is left to the
/// plain reader (the cache is off, or the file cannot be read here).
pub(super) fn cached(path: &str, w: u64) -> Option<String> {
    with_lines(path, w, |lines, truncated, bad| {
        if bad {
            return unsure();
        }
        let items: Vec<String> = lines.iter().filter(|l| !l.items.is_empty()).map(|l| items_json(&l.items)).collect();
        answer(&items, truncated)
    })
}

/// Hand `f` the lines of the last `w` bytes of `path` (the kept ones plus what was appended, the unfinished last line included),
/// whether the window cut the file, and whether the evidence is `unsure` (a line only JavaScript reads, or more text than
/// `transcript.evidence_max_chars`). `None` when the cache is off or cannot read the file here: the caller reads the window plainly.
pub(super) fn with_lines<R>(path: &str, w: u64, f: impl FnOnce(&[&Line], bool, bool) -> R) -> Option<R> {
    if defaults::num("transcript.evidence_cache_max_paths") == 0 {
        return None;
    }
    let file = std::fs::File::open(path).ok()?;
    let m = file.metadata().ok()?;
    if !m.is_file() {
        return None;
    }
    let size = m.len();
    let truncated = size > w;
    let fls = if truncated {
        match first_line_start(&file, size - w, size)? {
            Some(s) => s,
            // the window holds no newline: its one piece is the cut first line, which is dropped
            None => return Some(f(&[], true, false)),
        }
    } else {
        0
    };
    let key = path.to_string();
    let mut k = match cache().remove(&key) {
        Some(k) => match miss_reason(&k, &file, &m, fls) {
            None => {
                crate::load::note_count("evidence_cache", "result", if size == k.parsed_to { "hit" } else { "extend" });
                k
            }
            Some(reason) => {
                crate::load::note_count("evidence_cache", "result", "rebuild");
                crate::load::note_count("evidence_cache_rebuild", "reason", reason);
                Kept { dev: m.dev(), ino: m.ino(), base: fls, parsed_to: fls, head: 0, back: 0, lines: VecDeque::new() }
            }
        },
        None => {
            crate::load::note_count("evidence_cache", "result", "rebuild");
            crate::load::note_count("evidence_cache_rebuild", "reason", "none");
            Kept { dev: m.dev(), ino: m.ino(), base: fls, parsed_to: fls, head: 0, back: 0, lines: VecDeque::new() }
        }
    };
    while k.lines.front().is_some_and(|l| l.start < fls) {
        k.lines.pop_front();
    }
    k.base = fls;
    // read what was appended: the complete lines are kept, a last line without its newline is read now and again next time
    let mut buf = vec![0u8; (size - k.parsed_to) as usize];
    file.read_exact_at(&mut buf, k.parsed_to).ok()?;
    crate::load::note_scan(buf.len() as u64);
    let mut at = 0usize;
    while let Some(i) = buf.get(at..).and_then(|r| r.iter().position(|b| *b == b'\n')) {
        let line = make_line(k.parsed_to, buf.get(at..at + i).unwrap_or_default());
        k.lines.push_back(line);
        k.parsed_to += (i + 1) as u64;
        at += i + 1;
    }
    let pending = (at < buf.len()).then(|| make_line(k.parsed_to, buf.get(at..).unwrap_or_default()));
    // the window: every line, the unfinished one last
    let max_chars = defaults::num("transcript.evidence_max_chars") as f64;
    let mut chars = 0usize;
    let mut bad = false;
    let mut all: Vec<&Line> = Vec::with_capacity(k.lines.len() + 1);
    for l in k.lines.iter().chain(pending.iter()) {
        bad |= l.unsure;
        chars += l.chars;
        all.push(l);
    }
    let out = f(&all, truncated, bad || chars as f64 > max_chars);
    // keep it for the next call, with a digest of both ends
    let fp = defaults::num("transcript.evidence_fingerprint_bytes").max(1);
    let n = fp.min(k.parsed_to - k.base);
    let w_bytes = weight(&k);
    if w_bytes as u64 <= defaults::num("transcript.evidence_cache_entry_max_bytes")
        && let (Some(head), Some(back)) = (digest_at(&file, k.base, n), digest_at(&file, k.parsed_to - n, n))
    {
        k.head = head;
        k.back = back;
        let ttl = defaults::num("transcript.evidence_cache_idle_ms");
        let exp = (ttl > 0).then(|| crate::health::now_ms().saturating_add(ttl));
        cache().insert_with_ttl(key, k, w_bytes, exp);
    }
    Some(out)
}

/// Like [`with_lines`], but a cache that cannot serve the call reads the window plainly (as [`super::host_ts::evidence_uncached`]
/// does, line by line, nothing kept); `None` only when the transcript cannot be read at all.
pub(super) fn with_window<R>(path: &str, w: u64, f: impl FnOnce(&[&Line], bool, bool) -> R) -> Option<R> {
    // the closure moves into whichever path answers; the cache path hands it back through the Option when it does not
    let mut f = Some(f);
    if let Some(r) = with_lines(path, w, |l, t, b| f.take().map(|f| f(l, t, b))) {
        return r;
    }
    let f = f.take()?;
    let tail = crate::checks::replykit::io::read_window(path, w)?;
    let mut lines: Vec<Line> = Vec::new();
    let mut bad = false;
    let mut chars = 0usize;
    for line in crate::checks::replykit::transcript::tail_lines(&tail) {
        match line_items(line) {
            Err(()) => bad = true,
            Ok(None) => {}
            Ok(Some(LineEv { items, chars: c })) => {
                chars += c;
                lines.push(Line { start: 0, items, chars: c, unsure: false });
            }
        }
    }
    let refs: Vec<&Line> = lines.iter().collect();
    Some(f(&refs, tail.truncated, bad || chars as f64 > defaults::num("transcript.evidence_max_chars") as f64))
}

/// (entries kept, their estimated bytes) for the memory snapshot.
pub fn usage() -> (usize, u64) {
    let c = cache();
    (c.len(), c.bytes() as u64)
}

#[cfg(test)]
mod tests {
    use super::super::host_ts::{evidence, evidence_uncached};
    use super::usage;
    use crate::defaults;
    use serde_json::json;
    use std::io::Write;

    fn path(tag: &str) -> String {
        std::env::temp_dir().join(format!("ah-evcache-{tag}-{}", std::process::id())).to_string_lossy().into_owned()
    }

    /// One transcript line of kind `i % 8`, sized by `i` so the window edges fall in different places.
    fn line(i: usize) -> String {
        let pad = "x".repeat(i % 211);
        let v = match i % 8 {
            0 => json!({"type": "user", "message": {"role": "user", "content": format!("prompt {i} {pad}")}}),
            1 => {
                json!({"type": "assistant", "message": {"id": format!("m{}", i / 3), "role": "assistant", "content": [{"type": "text", "text": format!("answer {i} {pad}")}, {"type": "tool_use", "id": format!("t{i}"), "name": "Bash", "input": {"command": format!("echo {i}"), "n": i}}]}})
            }
            2 => {
                json!({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": format!("t{}", i - 1), "content": format!("out {i} {pad}")}]}, "toolUseResult": {"stdout": pad}})
            }
            3 => json!({"type": "attachment", "attachment": {"type": "hook_success", "content": format!("hook {i} {pad}")}}),
            4 => json!({"type": "system", "content": "nothing to add"}),
            5 => json!([1, 2, {"a": i}]),
            6 => json!(null),
            _ => json!({"role": "assistant", "content": format!("bare {i} \u{e9}\u{4e2d} {pad}")}),
        };
        let text = v.to_string();
        match i % 11 {
            3 => format!("{text}\r\n"),
            7 => format!("not json {i}\n"),
            9 => "\n".to_string(),
            _ => format!("{text}\n"),
        }
    }

    fn same(p: &str, w: u64, ctx: &str) {
        let a = evidence(p, w as f64);
        let b = evidence_uncached(p, w);
        assert_eq!(a, b, "{ctx}: window {w}");
        assert_eq!(a, super::super::host_ts::reference::evidence_v0(p, w as f64), "{ctx}: window {w} (the reader before the kept lines)");
    }

    #[test]
    fn the_kept_answer_is_the_fresh_answer_across_appends_windows_and_a_line_still_being_written() {
        let p = path("grow");
        std::fs::write(&p, "").unwrap();
        let mut f = std::fs::OpenOptions::new().append(true).open(&p).unwrap();
        let windows = [300u64, 2_000, 9_000, 40_000, 1 << 20];
        let mut i = 0;
        for step in 0..60 {
            for _ in 0..(1 + step % 7) {
                f.write_all(line(i).as_bytes()).unwrap();
                i += 1;
            }
            if step % 5 == 0 {
                // a line the writer has not finished: it counts now and again once it is complete
                f.write_all(b"{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":\"half").unwrap();
                for w in windows {
                    same(&p, w, &format!("step {step} partial"));
                }
                f.write_all(b" a line\"}}\n").unwrap();
            }
            for w in windows {
                same(&p, w, &format!("step {step}"));
            }
        }
        // the same window again after nothing was appended is a hit and still the same text
        for w in windows {
            same(&p, w, "idle");
        }
        crate::discard::harmless(std::fs::remove_file(&p)); // keep: cleanup; an absent file is the goal state
    }

    #[test]
    fn a_replaced_truncated_or_rewritten_file_is_read_afresh() {
        let p = path("swap");
        let build = |from: usize, n: usize, tag: &str| -> String {
            (from..from + n).map(|i| format!("{}{}", line(i).trim_end_matches(['\r', '\n']), if tag.is_empty() { "\n" } else { "\r\n" })).collect()
        };
        std::fs::write(&p, build(0, 80, "")).unwrap();
        for w in [4_000u64, 1 << 20] {
            same(&p, w, "first");
        }
        // shorter: the file is smaller than what was kept
        std::fs::write(&p, build(0, 20, "")).unwrap();
        for w in [4_000u64, 1 << 20] {
            same(&p, w, "truncated");
        }
        // same size, other bytes
        let a = build(100, 40, "");
        std::fs::write(&p, &a).unwrap();
        same(&p, 1 << 20, "other file");
        let b: String = a.chars().map(|c| if c == 'x' { 'y' } else { c }).collect();
        std::fs::write(&p, &b).unwrap();
        same(&p, 1 << 20, "rewritten in place");
        // another file at the same path (new inode), longer
        crate::discard::harmless(std::fs::remove_file(&p)); // keep: the next write recreates it
        std::fs::write(&p, build(200, 120, "")).unwrap();
        for w in [4_000u64, 1 << 20] {
            same(&p, w, "recreated");
        }
        // gone: unreadable, as a fresh read says
        crate::discard::harmless(std::fs::remove_file(&p)); // keep: cleanup; an absent file is the goal state
        same(&p, 1 << 20, "missing");
    }

    #[test]
    fn a_line_only_javascript_reads_makes_the_answer_unsure_until_it_leaves_the_window() {
        let p = path("unsure");
        let deep = format!("{}{}\n", "[".repeat(400), "]".repeat(400));
        let mut body = String::new();
        for i in 0..10 {
            body.push_str(&line(i));
        }
        body.push_str(&deep);
        for i in 10..40 {
            body.push_str(&line(i));
        }
        std::fs::write(&p, &body).unwrap();
        for w in [200u64, 3_000, 1 << 20] {
            same(&p, w, "deep line");
        }
        assert_eq!(evidence(&p, (1 << 20) as f64), r#"{"unsure":true}"#);
        let mut f = std::fs::OpenOptions::new().append(true).open(&p).unwrap();
        for i in 40..400 {
            f.write_all(line(i).as_bytes()).unwrap();
        }
        for w in [200u64, 3_000, 1 << 20] {
            same(&p, w, "after more lines");
        }
        assert_ne!(evidence(&p, 3_000.0), r#"{"unsure":true}"#, "the deep line is far outside a 3 KB window now");
        crate::discard::harmless(std::fs::remove_file(&p)); // keep: cleanup; an absent file is the goal state
    }

    #[test]
    fn the_second_call_reads_only_what_was_appended() {
        let p = path("bytes");
        let mut body = String::new();
        for i in 0..2000 {
            body.push_str(&line(i));
        }
        std::fs::write(&p, &body).unwrap();
        let w = 200_000u64;
        crate::load::take_scan();
        let _ = evidence(&p, w as f64);
        let first = crate::load::take_scan();
        assert!(first >= w / 2, "the first call reads its window ({first})");
        let mut f = std::fs::OpenOptions::new().append(true).open(&p).unwrap();
        let more: String = (2000..2012).map(line).collect();
        f.write_all(more.as_bytes()).unwrap();
        let _ = evidence(&p, w as f64);
        let second = crate::load::take_scan();
        // the boundary search and the digests read a little; the window is not read again
        assert!(second < more.len() as u64 + 70_000, "the second call read {second} bytes for {} appended", more.len());
        assert!(second < first / 2, "{second} vs {first}");
        crate::discard::harmless(std::fs::remove_file(&p)); // keep: cleanup; an absent file is the goal state
    }

    #[test]
    fn concurrent_calls_on_one_transcript_agree_and_never_block_each_other() {
        let p = path("conc");
        let body: String = (0..1500).map(line).collect();
        std::fs::write(&p, &body).unwrap();
        let want = evidence_uncached(&p, 120_000);
        let handles: Vec<_> = (0..8)
            .map(|_| {
                let p = p.clone();
                std::thread::spawn(move || (0..20).map(|_| evidence(&p, 120_000.0)).collect::<Vec<_>>())
            })
            .collect();
        for h in handles {
            for got in h.join().unwrap() {
                assert_eq!(got, want);
            }
        }
        crate::discard::harmless(std::fs::remove_file(&p)); // keep: cleanup; an absent file is the goal state
    }

    #[test]
    fn more_transcripts_than_the_cap_keep_answering_exactly() {
        let n = defaults::num("transcript.evidence_cache_max_paths") as usize * 3;
        let paths: Vec<String> = (0..n).map(|i| path(&format!("cap{i}"))).collect();
        for (i, p) in paths.iter().enumerate() {
            let body: String = (i * 7..i * 7 + 90).map(line).collect();
            std::fs::write(p, body).unwrap();
        }
        for round in 0..3 {
            for p in &paths {
                same(p, 50_000, &format!("round {round}"));
            }
        }
        assert!(usage().0 as u64 <= defaults::num("transcript.evidence_cache_max_paths"), "the cache holds at most its path cap");
        for p in &paths {
            crate::discard::harmless(std::fs::remove_file(p)); // keep: cleanup; an absent file is the goal state
        }
    }

    #[test]
    fn edge_files_and_windows_answer_as_the_reader_does() {
        let p = path("edge");
        let long_line = format!("{}\n", json!({"type": "user", "message": {"role": "user", "content": "q".repeat(5000)}}));
        let bodies: Vec<Vec<u8>> = vec![
            b"".to_vec(),
            b"\n".to_vec(),
            b"\n\n\r\n".to_vec(),
            long_line.clone().into_bytes(),
            [long_line.as_bytes(), b"\xff\xfe not utf8\n", long_line.as_bytes()].concat(),
            b"{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"no newline at all\"}}".to_vec(),
        ];
        for (i, body) in bodies.iter().enumerate() {
            std::fs::write(&p, body).unwrap();
            // windows below, at and above a line: a window with no newline in it holds no whole line
            for w in [1u64, 100, 4_999, 5_000, 5_060, 10_000, 1 << 20] {
                same(&p, w, &format!("body {i}"));
            }
        }
        crate::discard::harmless(std::fs::remove_file(&p)); // keep: cleanup; an absent file is the goal state
    }
}
