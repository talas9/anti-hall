//! The kept walk of `checks::agent_scan::scan_transcript` (#22): a transcript that fits the scan window is walked once and later
//! scans read only the appended bytes. Every scan below is compared with a fresh scan of the same file (`scan_transcript_uncached`),
//! step by step as the file grows (including a last line that is still unfinished), so any difference in the answer is a failure.
//! `AH_SCAN_CORPUS=<dir of .jsonl>` adds real transcripts, cut at many points, to the same comparison (skipped when unset).
use ah_engine::checks::agent_scan::{Opts, Scan, scan_transcript, scan_transcript_uncached};
use serde_json::{Value, json};
use std::io::Write;
use std::path::{Path, PathBuf};

const NOW: f64 = 1_791_300_000_000.0;
const WINDOW: u64 = 64 * 1024 * 1024;

fn opts(ignore: bool) -> Opts {
    Opts { now_ms: NOW, ignore_unanswered_stops: ignore }
}

/// Everything a scan answers, in a form that compares (the terminal set sorted).
fn snap(s: &Option<Scan>) -> String {
    match s {
        None => "null".into(),
        Some(s) => {
            let mut term: Vec<&String> = s.terminal.iter().collect();
            term.sort();
            format!("{:?}\n{:?}\n{:?}", s.launched.iter().collect::<Vec<_>>(), term, s.pending)
        }
    }
}

fn scratch(name: &str) -> PathBuf {
    let base = std::env::var_os("AH_TEST_SCRATCH").map_or_else(std::env::temp_dir, PathBuf::from);
    let d = base.join(format!("ah-scan-kept-{}-{name}", std::process::id()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn assistant_use(id: &str, name: &str, input: Value, ts: &str) -> String {
    json!({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "tool_use", "id": id, "name": name, "input": input}]}, "timestamp": ts})
        .to_string()
}

fn result(id: &str, text: &str, ts: &str) -> String {
    json!({"type": "user", "message": {"role": "user", "content": [{"tool_use_id": id, "type": "tool_result", "content": [{"type": "text", "text": text}]}]}, "timestamp": ts}).to_string()
}

fn launch(n: usize) -> Vec<String> {
    let ts = format!("2026-10-06T12:{:02}:00.000Z", n % 60);
    let agent = format!("a{n:015x}");
    let text = format!(
        "Async agent launched successfully. (internal metadata)\nagentId: {agent} (internal ID)\nThe agent is working in the background.\noutput_file: /tmp/x/{agent}.output\nDo NOT Read or tail this file via the shell tool."
    );
    vec![
        assistant_use(&format!("toolu_a{n}"), "Agent", json!({"description": format!("worker {n}"), "prompt": "p", "run_in_background": true}), &ts),
        result(&format!("toolu_a{n}"), &text, &ts),
    ]
}

fn done(n: usize) -> String {
    let agent = format!("a{n:015x}");
    let text = format!("<task-notification>\n<task-id>{agent}</task-id>\n<status>completed</status>\n</task-notification>");
    json!({"type": "user", "message": {"role": "user", "content": text}, "timestamp": format!("2026-10-06T13:{:02}:00.000Z", n % 60)}).to_string()
}

fn filler(n: usize) -> Vec<String> {
    vec![
        json!({"type": "user", "message": {"role": "user", "content": format!("prompt {n}")}, "timestamp": "2026-10-06T12:00:00.000Z"}).to_string(),
        assistant_use(&format!("toolu_b{n}"), "Bash", json!({"command": "ls"}), "2026-10-06T12:00:01.000Z"),
        result(&format!("toolu_b{n}"), "ok", "2026-10-06T12:00:02.000Z"),
        String::new(),
        "not json at all".into(),
        "   ".into(),
    ]
}

/// The lines of a session: launches, fillers, some terminal notices, a stop, a resume.
fn session() -> Vec<String> {
    let mut v = Vec::new();
    for n in 0..14 {
        v.extend(filler(n));
        v.extend(launch(n));
        if n % 3 == 0 {
            v.push(done(n));
        }
    }
    v.push(assistant_use("toolu_stop", "TaskStop", json!({"task_id": format!("a{:015x}", 4)}), "2026-10-06T14:00:00.000Z"));
    v.push(json!({"type": "user", "message": {"role": "user", "content": [{"tool_use_id": "toolu_stop", "type": "tool_result", "content": "stopped"}]}, "timestamp": "2026-10-06T14:00:01.000Z"}).to_string());
    v.push(done(1));
    v.extend(launch(20));
    v
}

fn same(path: &Path, what: &str) {
    for ignore in [false, true] {
        let fresh = scan_transcript_uncached(path.to_str().unwrap(), WINDOW, &opts(ignore));
        let kept = scan_transcript(path.to_str().unwrap(), WINDOW, &opts(ignore));
        assert_eq!(fresh.is_err(), kept.is_err(), "{what}: error status");
        assert_eq!(snap(&fresh.ok().flatten()), snap(&kept.ok().flatten()), "{what} (ignore_unanswered_stops={ignore})");
    }
}

#[test]
fn a_growing_transcript_scans_the_same_as_a_fresh_read_at_every_step() {
    let dir = scratch("grow");
    let path = dir.join("t.jsonl");
    let body = session().join("\n") + "\n";
    let bytes = body.as_bytes();
    std::fs::write(&path, b"").unwrap();
    // an empty file is unreadable for both
    same(&path, "empty");
    let mut f = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
    let mut at = 0;
    // odd step sizes cut lines in the middle (an unfinished last line), and every step is scanned twice (the second is a no-op resume)
    for step in [7usize, 61, 333, 1, 1999, 4096] {
        let end = (at + step * 5).min(bytes.len());
        f.write_all(&bytes[at..end]).unwrap();
        f.flush().unwrap();
        at = end;
        same(&path, &format!("after {at} bytes"));
        same(&path, &format!("again after {at} bytes"));
        if at == bytes.len() {
            break;
        }
    }
    while at < bytes.len() {
        let end = (at + 97).min(bytes.len());
        f.write_all(&bytes[at..end]).unwrap();
        f.flush().unwrap();
        at = end;
        same(&path, &format!("tail step {at}"));
    }
    // the comparison above is not vacuous: the finished session shows running agents
    let last = scan_transcript(path.to_str().unwrap(), WINDOW, &opts(false)).unwrap().unwrap();
    assert!(!last.rows().is_empty() && !last.terminal.is_empty(), "the fixture session must hold running and finished agents");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_rewritten_or_shrunk_transcript_is_walked_afresh() {
    let dir = scratch("rewrite");
    let path = dir.join("t.jsonl");
    let lines = session();
    std::fs::write(&path, lines.join("\n") + "\n").unwrap();
    same(&path, "first");
    // shrunk: the kept offset is past the end
    std::fs::write(&path, lines[..10].join("\n") + "\n").unwrap();
    same(&path, "shrunk");
    // grown again, but with different early content (same names, other bytes)
    let mut other = session();
    other.reverse();
    std::fs::write(&path, other.join("\n") + "\n").unwrap();
    same(&path, "rewritten");
    // replaced by another file at the same path (a new inode)
    std::fs::remove_file(&path).unwrap();
    std::fs::write(&path, lines.join("\n") + "\n").unwrap();
    same(&path, "replaced");
    std::fs::remove_dir_all(&dir).ok();
}

/// A transcript longer than its scan window: 400 plain lines, one agent launch, 200 plain lines. The window holds the launch and
/// 200 plain lines, plus `margin` more: that many appended lines slide before the launch leaves the exact window.
struct Slide {
    path: PathBuf,
    tail: u64,
}

fn plain(n: usize) -> String {
    json!({"type": "user", "message": {"role": "user", "content": format!("plain prompt number {n:05}")}, "timestamp": "2026-10-06T12:00:00.000Z"}).to_string()
        + "\n"
}

fn slide(name: &str, margin: usize) -> Slide {
    let dir = scratch(name);
    let path = dir.join("t.jsonl");
    let launch = launch(0).join("\n") + "\n";
    let mut body: String = (0..400).map(plain).collect();
    body.push_str(&launch);
    body.extend((400..600).map(plain));
    std::fs::write(&path, body).unwrap();
    Slide { path, tail: (launch.len() + 200 * plain(0).len() + margin * plain(0).len()) as u64 }
}

/// Append `lines` plain lines; the bytes appended.
fn append(s: &Slide, lines: usize, from: usize) -> u64 {
    let add: String = (from..from + lines).map(plain).collect();
    let mut f = std::fs::OpenOptions::new().append(true).open(&s.path).unwrap();
    f.write_all(add.as_bytes()).unwrap();
    add.len() as u64
}

/// The kept scan, the fresh scan of the same window, and the transcript bytes the kept scan read.
fn scans(s: &Slide, ignore: bool) -> (Option<Scan>, Option<Scan>, u64) {
    let p = s.path.to_str().unwrap();
    ah_engine::load::take_scan();
    let kept = scan_transcript(p, s.tail, &opts(ignore)).unwrap();
    let read = ah_engine::load::take_scan();
    let fresh = scan_transcript_uncached(p, s.tail, &opts(ignore)).unwrap();
    ah_engine::load::take_scan();
    (kept, fresh, read)
}

/// Scan until the kept walk is in place: the first scans of a process can race the lazy load of the defaults (each load bumps the
/// generation a kept walk is valid for), so a walk built in that window is rebuilt once.
fn settle(s: &Slide, ignore: bool) {
    ah_engine::defaults::init().unwrap();
    for _ in 0..20 {
        let g = ah_engine::defaults::generation();
        scans(s, ignore);
        let (_, _, read) = scans(s, ignore);
        if read == 0 && ah_engine::defaults::generation() == g {
            return;
        }
    }
    panic!("the kept walk never settled");
}

fn running(s: &Option<Scan>) -> usize {
    s.as_ref().unwrap().rows().len()
}

#[test]
fn a_sliding_window_reads_only_what_was_appended_and_answers_as_a_fresh_scan() {
    let s = slide("slide-within", 20);
    for ignore in [false, true] {
        settle(&s, ignore);
        let mut last = ah_engine::defaults::generation();
        let (kept, fresh, again) = scans(&s, ignore);
        assert_eq!(snap(&kept), snap(&fresh), "the kept walk answers as a fresh scan of the same window (ignore={ignore})");
        assert!(last != ah_engine::defaults::generation() || again == 0, "an unchanged transcript reads nothing");
        last = ah_engine::defaults::generation();
        assert_eq!(running(&kept), 1, "the window holds the running agent");
        for i in 0..3 {
            let added = append(&s, 2, 1000 + 10 * i + if ignore { 100 } else { 0 });
            let (kept, fresh, read) = scans(&s, ignore);
            // other tests of this process may reload the defaults, which retires every kept walk: then the bytes say nothing
            let steady = last == ah_engine::defaults::generation();
            last = ah_engine::defaults::generation();
            assert_eq!(snap(&kept), snap(&fresh), "slide step {i} (ignore={ignore})");
            assert!(!steady || read == added, "step {i} reads only the appended bytes ({read} read, {added} appended)");
        }
    }
    std::fs::remove_dir_all(s.path.parent().unwrap()).ok();
}

/// The exact window (no quantum): the tests of the window edge below move it one line at a time.
fn exact_window() {
    quantum(0);
}

fn quantum(pct: u64) {
    ah_engine::defaults::init().unwrap();
    ah_engine::defaults::set_overlay(&[("agent_scan.window_quantum_pct", json!(pct))]);
}

#[test]
fn a_sliding_window_that_loses_a_launch_is_rebuilt_and_answers_as_the_exact_window() {
    exact_window();
    let s = slide("slide-loses", 1);
    settle(&s, false);
    let (kept, fresh, _) = scans(&s, false);
    assert_eq!((running(&kept), running(&fresh)), (1, 1));
    // ten lines on, the launch is out of the exact window: the walk that holds it is not used, so the answer is the exact window's
    let added = append(&s, 10, 2000);
    let (kept, fresh, read) = scans(&s, false);
    assert_eq!(running(&fresh), 0, "the exact window no longer holds the launch");
    assert_eq!(snap(&kept), snap(&fresh));
    assert!(read > added, "so the window is read afresh");
    // and afterwards the rebuilt walk slides again without reading more than what is appended
    let last = ah_engine::defaults::generation();
    let added = append(&s, 3, 3000);
    let (kept, fresh, read) = scans(&s, false);
    assert_eq!(snap(&kept), snap(&fresh));
    assert!(last != ah_engine::defaults::generation() || read == added, "{read} read, {added} appended");
    std::fs::remove_dir_all(s.path.parent().unwrap()).ok();
}

#[test]
fn a_sliding_window_that_loses_the_call_of_an_answer_it_still_holds_answers_as_the_exact_window() {
    exact_window();
    let dir = scratch("slide-straddle");
    let path = dir.join("t.jsonl");
    let call =
        assistant_use("toolu_x", "Agent", json!({"description": "worker x", "prompt": "p", "run_in_background": true}), "2026-10-06T12:00:00.000Z") + "\n";
    let text = "Async agent launched successfully. (internal metadata)\nagentId: abcdef0123456789a (internal ID)\noutput_file: /tmp/x/abcdef0123456789a.output";
    let answer = result("toolu_x", text, "2026-10-06T12:00:01.000Z") + "\n";
    let mut body: String = (0..400).map(plain).collect();
    body.push_str(&call);
    body.extend((400..500).map(plain));
    body.push_str(&answer);
    body.extend((500..600).map(plain));
    std::fs::write(&path, body).unwrap();
    // the window starts 30 lines before the call
    let s = Slide { path, tail: (call.len() + 100 * plain(0).len() + answer.len() + 100 * plain(0).len() + 30 * plain(0).len()) as u64 };
    settle(&s, false);
    let (kept, fresh, _) = scans(&s, false);
    assert_eq!(snap(&kept), snap(&fresh));
    let described = |k: &Option<Scan>| k.as_ref().unwrap().rows().into_iter().map(|r| r.description).collect::<Vec<_>>();
    assert_eq!(described(&kept), ["worker x"], "the call is in the window: the launch carries its description");
    // sixty lines on, the call has left the window but its answer has not: a fresh scan sees the answer of an unseen call
    let _ = append(&s, 60, 2000);
    let (kept, fresh, _) = scans(&s, false);
    assert_eq!(snap(&kept), snap(&fresh));
    assert_eq!(described(&fresh), [""], "the call is out of the exact window");
    std::fs::remove_dir_all(s.path.parent().unwrap()).ok();
}

#[test]
fn a_sliding_window_that_loses_a_pending_call_whose_answer_then_arrives_answers_as_the_exact_window() {
    exact_window();
    let dir = scratch("slide-straddle-new");
    let path = dir.join("t.jsonl");
    let call =
        assistant_use("toolu_x", "Agent", json!({"description": "worker x", "prompt": "p", "run_in_background": true}), "2026-10-06T12:00:00.000Z") + "\n";
    let text = "Async agent launched successfully. (internal metadata)\nagentId: abcdef0123456789a (internal ID)\noutput_file: /tmp/x/abcdef0123456789a.output";
    let answer = result("toolu_x", text, "2026-10-06T12:00:01.000Z") + "\n";
    let mut body: String = (0..400).map(plain).collect();
    body.push_str(&call);
    body.extend((400..550).map(plain));
    std::fs::write(&path, body).unwrap();
    // the window starts 30 lines before the call, which has no answer yet
    let s = Slide { path, tail: (call.len() + 150 * plain(0).len() + 30 * plain(0).len()) as u64 };
    settle(&s, false);
    let (kept, fresh, _) = scans(&s, false);
    assert_eq!(snap(&kept), snap(&fresh));
    // forty lines and the answer arrive at once: the call is now out of the exact window, its answer is in it
    let _ = append(&s, 40, 2000);
    let mut f = std::fs::OpenOptions::new().append(true).open(&s.path).unwrap();
    f.write_all(answer.as_bytes()).unwrap();
    drop(f);
    let (kept, fresh, _) = scans(&s, false);
    assert_eq!(snap(&kept), snap(&fresh), "the newly completed result must not use a call the exact window no longer holds");
    let described = |k: &Option<Scan>| k.as_ref().unwrap().rows().into_iter().map(|r| r.description).collect::<Vec<_>>();
    assert_eq!(described(&fresh), [""]);
    std::fs::remove_dir_all(s.path.parent().unwrap()).ok();
}

#[test]
fn a_quantized_window_slides_past_a_launch_without_a_rebuild_and_answers_as_a_fresh_scan() {
    // the same transcript as the exact-window test, a line at a time: an exact window passes the launch after one line and the walk
    // that holds it is rebuilt at every step after; the quantized start moves once per quantum (about 20 lines here), so over twelve
    // lines it moves at most once and at most one scan reads more than the appended line
    quantum(10);
    let s = slide("slide-quantum", 1);
    settle(&s, false);
    let mut rebuilds = 0;
    for i in 0..12 {
        let last = ah_engine::defaults::generation();
        let added = append(&s, 1, 2000 + i);
        let (kept, fresh, read) = scans(&s, false);
        assert_eq!(snap(&kept), snap(&fresh), "step {i}");
        if last == ah_engine::defaults::generation() && read != added {
            rebuilds += 1;
        }
    }
    assert!(rebuilds <= 1, "{rebuilds} rebuilds in twelve one-line slides");
    // far enough on, the quantized start passes the launch: rebuilt, and gone from both answers
    let _ = append(&s, 60, 3000);
    let (kept, fresh, _) = scans(&s, false);
    assert_eq!(snap(&kept), snap(&fresh));
    assert_eq!(running(&kept), 0, "the window has moved past the launch");
    std::fs::remove_dir_all(s.path.parent().unwrap()).ok();
}

#[test]
fn real_transcripts_cut_at_many_points_scan_the_same() {
    let Some(corpus) = std::env::var_os("AH_SCAN_CORPUS") else { return };
    let dir = scratch("corpus");
    let copy = dir.join("c.jsonl");
    let mut names: Vec<PathBuf> =
        std::fs::read_dir(corpus).unwrap().filter_map(|e| e.ok().map(|e| e.path())).filter(|p| p.extension().is_some_and(|x| x == "jsonl")).collect();
    names.sort();
    for src in names {
        let data = std::fs::read(&src).unwrap();
        if data.is_empty() || data.len() as u64 > WINDOW {
            continue;
        }
        std::fs::write(&copy, b"").unwrap();
        let mut f = std::fs::OpenOptions::new().append(true).open(&copy).unwrap();
        let mut at = 0usize;
        let mut x: u64 = 0x9E37_79B9_7F4A_7C15;
        let cuts = 24usize;
        for i in 0..cuts {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            let end = if i + 1 == cuts { data.len() } else { (at + (x as usize % (data.len() / cuts * 2 + 1))).min(data.len()) };
            f.write_all(&data[at..end]).unwrap();
            f.flush().unwrap();
            at = end;
            same(&copy, &format!("{} cut at {at} of {}", src.display(), data.len()));
        }
        eprintln!("corpus: {} ({} bytes) compared at {cuts} cut points", src.display(), data.len());
    }
    std::fs::remove_dir_all(&dir).ok();
}

/// What a caller acts on: the running agents (launched, not terminal) and the pending teammate messages.
fn verdict(s: &Option<Scan>) -> String {
    match s {
        None => "null".into(),
        Some(s) => format!("{:?}\n{:?}", s.rows(), s.pending),
    }
}

/// `AH_SCAN_SLIDE=<dir of .jsonl>` (window `AH_SCAN_SLIDE_TAIL` bytes, 64 MiB by default): each real transcript is copied into a
/// scratch file in growing steps (the first `AH_SCAN_SLIDE_CAP` bytes, 256 MiB by default), and the kept walk is compared with a
/// fresh scan of the same window at every step: the whole answer must be the same. Skipped when unset.
#[test]
fn real_transcripts_sliding_through_a_window_scan_the_same() {
    let Some(corpus) = std::env::var_os("AH_SCAN_SLIDE") else { return };
    let num = |k: &str, d: u64| std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d);
    let tail = num("AH_SCAN_SLIDE_TAIL", 64 * 1024 * 1024);
    let cap = num("AH_SCAN_SLIDE_CAP", 256 * 1024 * 1024) as usize;
    let dir = scratch("slide-corpus");
    let copy = dir.join("c.jsonl");
    let mut names: Vec<PathBuf> =
        std::fs::read_dir(corpus).unwrap().filter_map(|e| e.ok().map(|e| e.path())).filter(|p| p.extension().is_some_and(|x| x == "jsonl")).collect();
    names.sort();
    let mut diffs = Vec::new();
    for src in names {
        let len = std::fs::metadata(&src).unwrap().len() as usize;
        if len as u64 <= tail {
            continue;
        }
        let total = len.min(cap);
        std::fs::write(&copy, b"").unwrap();
        let mut out = std::fs::OpenOptions::new().append(true).open(&copy).unwrap();
        let mut input = std::fs::File::open(&src).unwrap();
        let (mut at, mut steps, mut whole_equal, mut verdict_equal, mut read_kept, mut read_fresh) = (0usize, 0usize, 0usize, 0usize, 0u64, 0u64);
        let mut x: u64 = 0x2545_F491_4F6C_DD1D;
        while at < total {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            let step = (5_000 + (x as usize % 3_000_000)).min(total - at);
            let mut buf = vec![0u8; step];
            std::io::Read::read_exact(&mut input, &mut buf).unwrap();
            out.write_all(&buf).unwrap();
            out.flush().unwrap();
            at += step;
            if (at as u64) <= tail {
                continue;
            }
            steps += 1;
            let p = copy.to_str().unwrap();
            for ignore in [false, true] {
                ah_engine::load::take_scan();
                let kept = scan_transcript(p, tail, &opts(ignore));
                read_kept += ah_engine::load::take_scan();
                let fresh = scan_transcript_uncached(p, tail, &opts(ignore));
                read_fresh += ah_engine::load::take_scan();
                let (kept, fresh) = (kept.ok().flatten(), fresh.ok().flatten());
                verdict_equal += usize::from(verdict(&kept) == verdict(&fresh));
                if snap(&kept) == snap(&fresh) {
                    whole_equal += 1;
                } else {
                    let ids = |s: &Option<Scan>| {
                        s.as_ref().map_or_else(Vec::new, |s| {
                            s.rows().into_iter().map(|r| format!("{} launched_at={}", r.id, r.rec.launched_at_ms)).collect::<Vec<_>>()
                        })
                    };
                    diffs.push(format!("{} at {at} (ignore={ignore}): kept running {:?}, fresh running {:?}", src.display(), ids(&kept), ids(&fresh)));
                }
            }
        }
        eprintln!(
            "slide corpus: {}: {steps} steps x2: whole answer equal {whole_equal}, running+pending equal {verdict_equal}; bytes read: kept {read_kept}, fresh {read_fresh}",
            src.display()
        );
    }
    std::fs::remove_dir_all(&dir).ok();
    assert!(diffs.is_empty(), "the kept walk answered differently from the exact window: {diffs:#?}");
}
