//! Stop-guard parity replay (#465): a frozen corpus of Stop scenarios with the decision the original Node task-guard and
//! tasklist-guard gave each one, replayed through the engine. Needs no Node. A difference must be listed under the scenario's `kept`
//! (hook -> {engine, contains, reason}: the engine's exact class and a substring of its text, the behaviour being deliberate); an
//! unlisted difference, a kept difference whose engine class or text drifted, or a `kept` entry that now agrees, fails the test.
//! Time is pinned: one instant is read at the start, the script clock is set to it, and every progress-file mtime is set from it.
//! The gap (engine decisions that differ from the recorded Node ones, over all compared pairs) is written as JSON to the file named
//! by AH_STOP_PARITY_REPORT when that is set, and always printed.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::unreachable)]

use ah_engine::checks::Verdict;
use ah_engine::reqenv::RequestEnv;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn setup(tag: &str) -> PathBuf {
    let d = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("ah-sp-{tag}-{}", std::process::id()));
    std::fs::remove_dir_all(&d).ok();
    std::fs::create_dir_all(d.join(".anti-hall/logic")).unwrap();
    let d = std::fs::canonicalize(&d).unwrap();
    // SAFETY: the replay is serialized by SERIAL, so no other thread reads the environment while it changes.
    unsafe {
        std::env::remove_var("AH_ENGINE_CONFIG"); // an ambient config overlay would change the defaults the replay reads
        std::env::set_var("AH_ENGINE_DIR", d.join("state"));
        std::env::set_var("AH_ENGINE_PLUGIN_ROOT", concat!(env!("CARGO_MANIFEST_DIR"), "/../plugins/anti-hall"));
    }
    ah_engine::defaults::init().expect("defaults load");
    std::fs::create_dir_all(ah_engine::paths::dir()).unwrap();
    d
}

fn classify(v: Option<Option<Verdict>>) -> String {
    match v {
        Some(Some(Verdict::Exact(x))) if x.code == 2 || x.out.contains("\"decision\":\"block\"") => "block".into(),
        Some(Some(Verdict::Exact(x))) if !x.err.trim().is_empty() || !x.out.trim().is_empty() => "advise".into(),
        Some(Some(Verdict::Block(_))) => "block".into(),
        Some(Some(Verdict::Advisory(_))) => "advise".into(),
        Some(Some(Verdict::Defer)) => "defer".into(),
        Some(Some(Verdict::Routed(b, _))) => classify(Some(Some(*b))),
        Some(Some(_)) | Some(None) => "allow".into(),
        None => "none".into(),
    }
}

fn text_of(v: &Option<Option<Verdict>>) -> String {
    match v {
        Some(Some(Verdict::Exact(x))) => format!("{}{}", x.out, x.err),
        Some(Some(Verdict::Block(s) | Verdict::Advisory(s))) => s.clone(),
        _ => String::new(),
    }
}

fn replay(sc: &Value, clock: &Value, hook: &str, base: &Path, n: usize, now: u64) -> (String, String) {
    let h = base.join(format!("s{n}-{hook}"));
    let proj = h.join("proj");
    std::fs::create_dir_all(proj.join(".git/refs/heads")).unwrap();
    std::fs::write(proj.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
    let today = civil_date(now);
    match sc["progress"].as_str().unwrap_or("none") {
        "none" => {}
        kind => {
            let dir = proj.join(".anti-hall/progress").join(&today);
            std::fs::create_dir_all(&dir).unwrap();
            let f = dir.join("sess1.md");
            std::fs::write(&f, "progress\n").unwrap();
            let age = if kind == "stale" { clock["stale_age_s"].as_u64().unwrap() } else { 0 };
            let at = std::time::UNIX_EPOCH + std::time::Duration::from_secs(now - age);
            std::fs::File::options().write(true).open(&f).unwrap().set_modified(at).unwrap();
        }
    }
    // {"advisories_shown": ["advisory.kind_..."]}: the advisory kinds (named by their config key) the session has already been shown
    if let Some(keys) = sc["advisories_shown"].as_array() {
        let kinds: serde_json::Map<String, Value> =
            keys.iter().map(|k| (ah_engine::defaults::text(k.as_str().unwrap()).to_string(), json!({"n": 1}))).collect();
        let name = format!("{}-sess1{}", ah_engine::defaults::text("advisory.state_prefix"), ah_engine::defaults::text("advisory.state_ext"));
        let dir = h.join(ah_engine::defaults::text("paths.base_dir"));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(name), json!({"kinds": kinds}).to_string()).unwrap();
    }
    let mut body = String::new();
    for l in sc["lines"].as_array().unwrap() {
        // {"_fill": N} stands for N filler assistant text lines that push earlier lines out of the transcript tail window
        for i in 0..l["_fill"].as_u64().unwrap_or(1) {
            let one = if l["_fill"].is_null() {
                l.to_string()
            } else {
                json!({"type":"assistant","timestamp":"2026-10-29T10:00:00.000Z","message":{"role":"assistant","content":[{"type":"text","text":format!("{}{i}", "x".repeat(700))}]}}).to_string()
            };
            body.push_str(&(one.replace("{{PROJ}}", &proj.to_string_lossy()).replace("{{DATE}}", &today) + "\n"));
        }
    }
    let tp = h.join("t.jsonl");
    std::fs::write(&tp, body).unwrap();
    let env = RequestEnv::from_pairs(vec![("HOME".to_string(), h.to_string_lossy().into_owned())]);
    let mut payload = json!({"cwd": proj, "hook_event_name": "Stop", "session_id": "sess1", "transcript_path": tp});
    if let Some(m) = sc["permission_mode"].as_str() {
        payload["permission_mode"] = json!(m);
    }
    ah_engine::script::host::set_clock(Some((now * 1000) as f64));
    let v = ah_engine::script::run_forced(hook, &payload, &json!({}), "Stop", &env);
    ah_engine::script::host::set_clock(None);
    let t = text_of(&v);
    (classify(v), t.chars().take(300).collect())
}

/// The UTC date of `secs` as YYYY-MM-DD (civil-from-days), so the test needs no date crate.
fn civil_date(secs: u64) -> String {
    let z = secs as i64 / 86_400 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

#[test]
fn engine_stop_decisions_match_the_recorded_node_ones() {
    let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let corpus: Value =
        serde_json::from_str(&std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/stop-parity/corpus.json")).unwrap()).unwrap();
    let base = setup("replay");
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs(); // the one clock read
    let (mut pairs, mut gap, mut problems) = (0u32, 0u32, Vec::<String>::new());
    let mut rows = Vec::new();
    for (n, sc) in corpus["scenarios"].as_array().unwrap().iter().enumerate() {
        for hook in sc["hooks"].as_array().unwrap() {
            let hook = hook.as_str().unwrap();
            let node = sc["node"][hook].as_str().unwrap();
            let (engine, text) = replay(sc, &corpus["clock"], hook, &base, n, now);
            let id = sc["id"].as_str().unwrap();
            pairs += 1;
            let kept = sc["kept"].get(hook);
            rows.push(json!({"scenario": id, "class": sc["class"], "hook": hook, "node": node, "engine": engine, "engine_text": text, "kept": kept}));
            if engine != node {
                gap += 1;
                match kept {
                    None => problems.push(format!("{id} / {hook}: node {node}, engine {engine} (not listed under kept)")),
                    Some(k) => {
                        // an allow carries no text, so it pins an empty text; every other class pins a non-empty substring
                        let (want, sub) = (k["engine"].as_str().unwrap(), k["contains"].as_str().unwrap_or(""));
                        assert!(!k["reason"].as_str().unwrap().is_empty() && (want == "allow") == sub.is_empty(), "{id} / {hook}: bad kept entry");
                        let text_ok = if want == "allow" { text.is_empty() } else { text.contains(sub) };
                        if engine != want || !text_ok {
                            problems.push(format!("{id} / {hook}: kept as engine {want} containing {sub:?}, got {engine}: {text}"));
                        }
                    }
                }
            } else if kept.is_some() {
                problems.push(format!("{id} / {hook}: listed under kept but the engine now agrees ({node})"));
            }
        }
    }
    let report = json!({"pairs": pairs, "differing": gap, "agree": pairs - gap, "rows": rows});
    if let Some(p) = std::env::var_os("AH_STOP_PARITY_REPORT") {
        std::fs::write(p, serde_json::to_string_pretty(&report).unwrap()).unwrap();
    }
    println!("stop parity: {pairs} pairs, {gap} differing, {} agree", pairs - gap);
    for r in &rows {
        if r["node"] != r["engine"] {
            println!("  {} / {}: node {} engine {} kept={} text={}", r["scenario"], r["hook"], r["node"], r["engine"], r["kept"], r["engine_text"]);
        }
    }
    assert!(problems.is_empty(), "stop parity drifted:\n{}", problems.join("\n"));
}
