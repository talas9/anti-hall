//! Unit tests of the emit-dedupe store. The full Node comparison is `tests/prompt_emit_parity`.
use super::*;
use std::collections::HashMap;

fn home(tag: &str) -> String {
    let d = std::env::temp_dir().join(format!("ah-ed-{tag}-{}-{}", std::process::id(), now_ms() as u64));
    crate::discard::harmless(std::fs::remove_dir_all(&d));
    std::fs::create_dir_all(&d).unwrap();
    d.to_string_lossy().to_string()
}

fn st(home: &str, env: &[(&str, &str)]) -> Settings {
    Settings { home: home.to_string(), env: env.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect::<HashMap<_, _>>() }
}

fn opts<'a>(session: &'a str, content: &'a str, tp: Option<&'a str>, keepalive: f64) -> Opts<'a> {
    Opts { session_id: session, key: "k", content, transcript_path: tp, keepalive, normalize: &|s| s.to_string() }
}

fn read(home: &str, session: &str) -> String {
    std::fs::read_to_string(state_path(home, session)).unwrap_or_default()
}

fn transcript(dir: &str, lines: &[String]) -> String {
    let p = format!("{dir}/t.jsonl");
    std::fs::write(&p, lines.join("\n") + "\n").unwrap();
    p
}

fn delivered(ts: f64, content: &str) -> String {
    serde_json::json!({"type":"attachment","timestamp":format_iso(ts),"attachment":{"type":"hook_additional_context","hookEvent":"UserPromptSubmit","content":[content]}}).to_string()
}

fn filler(ts: f64) -> String {
    serde_json::json!({"type":"assistant","timestamp":format_iso(ts)}).to_string()
}

fn format_iso(ms: f64) -> String {
    let total = ms as i64;
    let (secs, milli) = (total / 1000, total % 1000);
    let (days, sod) = (secs / 86400, secs % 86400);
    let z = days + 719_468;
    let era = z / 146_097;
    let doe = z % 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{milli:03}Z", sod / 3600, sod % 3600 / 60, sod % 60)
}

#[test]
fn the_state_file_name_is_the_sanitized_session_cut_to_128_utf16_units() {
    let p = |s: &str| state_path("/h", s).file_name().unwrap().to_string_lossy().to_string();
    assert_eq!(p("abc-1.2_3"), "dedupe-abc-1.2_3.json");
    assert_eq!(p("a/b c"), "dedupe-a_b_c.json");
    assert_eq!(p(&"x".repeat(200)), format!("dedupe-{}.json", "x".repeat(128)));
    // an astral character is two units, each written as an underscore, and the cut can fall between them
    assert_eq!(p(&format!("{}😀z", "e".repeat(127))), format!("dedupe-{}_.json", "e".repeat(127)));
    assert_eq!(p("é"), "dedupe-_.json");
}

#[test]
fn a_first_block_is_emitted_and_recorded_without_the_text() {
    let h = home("first");
    let s = st(&h, &[]);
    assert_eq!(should_emit(&s, &opts("s1", "SECRET TEXT", None, 0.0)), Ok(true));
    let f = read(&h, "s1");
    assert!(f.starts_with("{\"k\":{\"hash\":\""), "{f}");
    assert!(!f.contains("SECRET"), "{f}");
    assert!(f.contains(&format!("\"ch\":\"{}\",\"k\":1}}", sha1_hex(b"SECRET TEXT"))), "{f}");
}

#[test]
fn an_undelivered_copy_is_suppressed_until_the_pending_limit() {
    let h = home("pending");
    let s = st(&h, &[]);
    let now = now_ms();
    let tp = transcript(&h, &[filler(now - 5000.0), delivered(now - 4000.0, "someone else's block")]);
    assert_eq!(should_emit(&s, &opts("s", "BLOCK", Some(&tp), 0.0)), Ok(true));
    assert_eq!(should_emit(&s, &opts("s", "BLOCK", Some(&tp), 0.0)), Ok(false), "the transcript shows other deliveries but not this block: pending");
    assert!(read(&h, "s").contains("\"__stats\":{\"suppressed\":1,"));
    // age the record past the limit
    let mut doc = crate::checks::guardkit::jsval::Js::parse(&read(&h, "s")).unwrap();
    let mut e = doc.get("k").cloned().unwrap();
    e.set("lastEmittedAt", crate::checks::guardkit::jsval::Js::Num(now - 700_000.0));
    doc.set("k", e);
    std::fs::write(state_path(&h, "s"), doc.stringify()).unwrap();
    assert_eq!(should_emit(&s, &opts("s", "BLOCK", Some(&tp), 0.0)), Ok(true), "a copy pending for more than ten minutes is emitted again");
}

#[test]
fn a_delivered_unchanged_block_waits_for_its_keepalive_count() {
    let h = home("keep");
    let s = st(&h, &[]);
    let now = now_ms();
    let tp = transcript(&h, &[filler(now - 5000.0)]);
    assert_eq!(should_emit(&s, &opts("s", "BLOCK", Some(&tp), 2.0)), Ok(true));
    let mut results = Vec::new();
    for i in 0..6 {
        std::fs::write(&tp, format!("{}\n{}\n", std::fs::read_to_string(&tp).unwrap().trim_end(), delivered(now_ms() + i as f64, "BLOCK"))).unwrap();
        results.push(should_emit(&s, &opts("s", "BLOCK", Some(&tp), 2.0)).unwrap());
    }
    assert_eq!(results, [false, false, true, false, false, true], "emitted again once the count exceeds the keepalive");
}

#[test]
fn a_changed_block_is_emitted_and_a_reset_makes_an_unchanged_one_new_again() {
    let h = home("reset");
    let s = st(&h, &[]);
    assert_eq!(should_emit(&s, &opts("s", "ONE", None, 0.0)), Ok(true));
    assert_eq!(should_emit(&s, &opts("s", "ONE", None, 0.0)), Ok(false), "no transcript: the window decides");
    assert_eq!(should_emit(&s, &opts("s", "TWO", None, 0.0)), Ok(true));
    std::thread::sleep(std::time::Duration::from_millis(5));
    reset_session(&s, "s").unwrap();
    assert!(read(&h, "s").contains("\"__reset\":{\"resetAt\":"));
    assert_eq!(should_emit(&s, &opts("s", "TWO", None, 0.0)), Ok(true), "a record emitted before the reset counts as absent");
}

#[test]
fn a_record_for_another_transcript_does_not_count() {
    let h = home("tp");
    let s = st(&h, &[]);
    assert_eq!(should_emit(&s, &opts("s", "B", Some("/nonexistent/a.jsonl"), 0.0)), Ok(true));
    assert_eq!(should_emit(&s, &opts("s", "B", Some("/nonexistent/b.jsonl"), 0.0)), Ok(true));
    assert_eq!(should_emit(&s, &opts("s", "B", Some("/nonexistent/b.jsonl"), 0.0)), Ok(false));
}

#[test]
fn the_switches_turn_the_store_off_and_write_nothing() {
    let h = home("off");
    for env in [vec![("ANTIHALL_EMIT_DEDUPE", "0")], vec![("ANTIHALL_DEDUPE_WINDOW_MIN", "0")]] {
        let s = st(&h, &env);
        assert_eq!(should_emit(&s, &opts("s", "B", None, 0.0)), Ok(true));
        assert_eq!(should_emit(&s, &opts("s", "B", None, 0.0)), Ok(true));
        reset_session(&s, "s").unwrap();
        assert!(!state_path(&h, "s").exists());
    }
    assert_eq!(should_emit(&st(&h, &[]), &opts("", "B", None, 0.0)), Ok(true), "no session id: emit, record nothing");
}

#[test]
fn a_state_file_serde_rejects_defers_before_anything_is_written() {
    let h = home("bad");
    let s = st(&h, &[]);
    std::fs::create_dir_all(state_path(&h, "s").parent().unwrap()).unwrap();
    std::fs::write(state_path(&h, "s"), "{not json").unwrap();
    assert_eq!(should_emit(&s, &opts("s", "B", None, 0.0)), Err(Defer));
    assert_eq!(reset_session(&s, "s"), Err(Defer));
    assert_eq!(read(&h, "s"), "{not json", "the file is untouched");
    std::fs::write(state_path(&h, "s"), "[1]").unwrap();
    assert_eq!(should_emit(&s, &opts("s", "B", None, 0.0)), Ok(true), "a valid non-object is an empty state, as in Node");
}

#[test]
fn keys_unseen_for_a_day_are_dropped_and_other_keys_keep_their_order() {
    let h = home("ttl");
    let s = st(&h, &[]);
    let now = now_ms();
    std::fs::create_dir_all(state_path(&h, "s").parent().unwrap()).unwrap();
    let old = format!(
        "{{\"zz\":{{\"lastSeenAt\":{}}},\"kept\":{{\"lastSeenAt\":{}}},\"10\":{{\"lastSeenAt\":{}}},\"2\":{{\"lastSeenAt\":{}}},\"noseen\":{{}}}}",
        now - 90_000_000.0,
        now - 1000.0,
        now - 1000.0,
        now - 1000.0
    );
    std::fs::write(state_path(&h, "s"), old).unwrap();
    assert_eq!(should_emit(&s, &opts("s", "B", None, 0.0)), Ok(true));
    let f = read(&h, "s");
    assert!(!f.contains("\"zz\"") && !f.contains("noseen"), "{f}");
    assert!(f.starts_with("{\"2\":{") && f.contains("\"10\":{") && f.find("\"10\"") < f.find("\"kept\""), "{f}");
}

#[test]
fn the_sweep_removes_idle_session_files_once_per_throttle_and_never_the_callers_own() {
    let h = home("sweep");
    let s = st(&h, &[]);
    let dir = state_path(&h, "x").parent().unwrap().to_path_buf();
    std::fs::create_dir_all(&dir).unwrap();
    let old = std::time::SystemTime::now() - std::time::Duration::from_secs(9 * 86400);
    for n in ["dedupe-old.json", "dedupe-self.json", "other-old.json", "dedupe-note.txt"] {
        let p = dir.join(n);
        std::fs::write(&p, "{}").unwrap();
        std::fs::File::options().write(true).open(&p).unwrap().set_modified(old).unwrap();
    }
    reset_session(&s, "self").unwrap();
    assert!(!dir.join("dedupe-old.json").exists());
    assert!(dir.join("dedupe-self.json").exists() && dir.join("other-old.json").exists() && dir.join("dedupe-note.txt").exists());
    // a second old file survives while the stamp is fresh
    let p = dir.join("dedupe-old2.json");
    std::fs::write(&p, "{}").unwrap();
    std::fs::File::options().write(true).open(&p).unwrap().set_modified(old).unwrap();
    reset_session(&s, "self").unwrap();
    assert!(p.exists(), "throttled");
}

#[test]
fn a_transcript_line_with_the_marker_that_json_parse_rejects_is_skipped() {
    let h = home("marker");
    let s = st(&h, &[]);
    let now = now_ms();
    let tp = transcript(&h, &[filler(now - 1000.0), "{\"attachment\":{\"type\":\"hook_additional_context\" BROKEN".to_string()]);
    assert_eq!(should_emit(&s, &opts("s", "B", Some(&tp), 0.0)), Ok(true));
    assert!(should_emit(&s, &opts("s", "B", Some(&tp), 0.0)).is_ok(), "plain broken JSON is skipped, as JSON.parse in a try/catch skips it");
}

#[test]
fn a_transcript_line_with_the_marker_that_only_javascript_may_read_defers() {
    let h = home("marker2");
    let s = st(&h, &[]);
    let now = now_ms();
    let tp = transcript(&h, &[filler(now - 1000.0), "{\"attachment\":{\"type\":\"hook_additional_context\"},\"n\":1e999}".to_string()]);
    assert_eq!(should_emit(&s, &opts("s", "B", Some(&tp), 0.0)), Ok(true));
    assert_eq!(should_emit(&s, &opts("s", "B", Some(&tp), 0.0)), Err(Defer));
}

#[test]
fn session_ids_are_what_the_hooks_make_of_them() {
    use serde_json::json;
    assert_eq!(session_of(&json!({"session_id": "a"})), Ok(Some("a".into())));
    assert_eq!(session_of(&json!({"session_id": ""})), Ok(None));
    assert_eq!(session_of(&json!({"session_id": 0})), Ok(None));
    assert_eq!(session_of(&json!({"session_id": 12})), Ok(Some("12".into())));
    assert_eq!(session_of(&json!({"session_id": true})), Ok(Some("true".into())));
    assert_eq!(session_of(&json!({})), Ok(None));
    assert_eq!(session_of(&json!({"session_id": [1]})), Err(Defer));
    assert_eq!(transcript_of(&json!({"transcript_path": "/a"})), Ok(Some("/a")));
    assert_eq!(transcript_of(&json!({"transcript_path": "a"})), Err(Defer));
    assert_eq!(transcript_of(&json!({"transcript_path": 5})), Ok(None));
}

// Found by cargo-mutants (scripts/mutants.sh emit_dedupe): no test pinned `window_ms` (five surviving mutants on its
// condition and its minutes-to-milliseconds product) and `disabled`'s negation was only detected by a hang (timeout).
#[test]
fn the_fallback_window_is_the_setting_in_minutes_else_the_default() {
    let h = home("window");
    let ms = |v: &str| window_ms(&st(&h, &[("ANTIHALL_DEDUPE_WINDOW_MIN", v)]));
    assert_eq!(window_ms(&st(&h, &[])), 20.0 * 60_000.0, "no setting: the 20-minute default");
    assert_eq!(ms("3"), 180_000.0);
    assert_eq!(ms("0.5"), 30_000.0, "a fraction of a minute is a product, not a sum");
    assert_eq!(ms("0"), num("emit_dedupe.window_default_ms"), "0 minutes is not a window: the 15 s default applies");
    assert_eq!(ms("-4"), num("emit_dedupe.window_default_ms"), "a negative value is clamped to 0, so the default applies");
}

#[test]
fn the_feature_is_off_only_for_a_zero_window_or_the_switch_off() {
    let h = home("disabled");
    assert!(!disabled(&st(&h, &[])), "on by default");
    assert!(!disabled(&st(&h, &[("ANTIHALL_DEDUPE_WINDOW_MIN", "5")])));
    assert!(disabled(&st(&h, &[("ANTIHALL_DEDUPE_WINDOW_MIN", "0")])), "a zero window turns it off");
    assert!(disabled(&st(&h, &[("ANTIHALL_EMIT_DEDUPE", "false")])), "the switch off turns it off");
    assert!(!disabled(&st(&h, &[("ANTIHALL_EMIT_DEDUPE", "true")])));
}
