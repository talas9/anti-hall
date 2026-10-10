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

#[test]
fn a_transcript_longer_than_the_window_is_scanned_afresh_each_time() {
    let dir = scratch("slide");
    let path = dir.join("t.jsonl");
    let body = session().join("\n") + "\n";
    std::fs::write(&path, &body).unwrap();
    let small = (body.len() / 3) as u64;
    for ignore in [false, true] {
        let fresh = scan_transcript_uncached(path.to_str().unwrap(), small, &opts(ignore));
        let kept = scan_transcript(path.to_str().unwrap(), small, &opts(ignore));
        assert_eq!(snap(&fresh.ok().flatten()), snap(&kept.ok().flatten()));
    }
    std::fs::remove_dir_all(&dir).ok();
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
