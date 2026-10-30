//! Stop-guard parity replay (#465): a frozen corpus of Stop scenarios with the decision the original Node task-guard and
//! tasklist-guard gave each one, replayed through the engine. Needs no Node. A difference must be listed under the scenario's `kept`
//! (hook -> reason, the engine's behaviour is deliberate); an unlisted difference, or a `kept` entry that now agrees, fails the test.
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

fn replay(sc: &Value, hook: &str, base: &Path, n: usize) -> String {
    let h = base.join(format!("s{n}-{hook}"));
    let proj = h.join("proj");
    std::fs::create_dir_all(proj.join(".git/refs/heads")).unwrap();
    std::fs::write(proj.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
    let today = chrono_free_today();
    match sc["progress"].as_str().unwrap_or("none") {
        "none" => {}
        kind => {
            let dir = proj.join(".anti-hall/progress").join(&today);
            std::fs::create_dir_all(&dir).unwrap();
            let f = dir.join("sess1.md");
            std::fs::write(&f, "progress\n").unwrap();
            if kind == "stale" {
                let old = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_790_000_000); // 2026-09-21
                std::fs::File::options().write(true).open(&f).unwrap().set_modified(old).unwrap();
            }
        }
    }
    let body: String = sc["lines"].as_array().unwrap().iter().map(|l| l.to_string().replace("{{PROJ}}", &proj.to_string_lossy()).replace("{{DATE}}", &today) + "\n").collect();
    let tp = h.join("t.jsonl");
    std::fs::write(&tp, body).unwrap();
    let env = RequestEnv::from_pairs(vec![("HOME".to_string(), h.to_string_lossy().into_owned())]);
    let mut payload = json!({"cwd": proj, "hook_event_name": "Stop", "session_id": "sess1", "transcript_path": tp});
    if let Some(m) = sc["permission_mode"].as_str() {
        payload["permission_mode"] = json!(m);
    }
    classify(ah_engine::script::run_forced(hook, &payload, &json!({}), "Stop", &env))
}

/// Today's UTC date as YYYY-MM-DD from the system clock (civil-from-days), so the test needs no date crate.
fn chrono_free_today() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
    let z = secs / 86_400 + 719_468;
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
    let corpus: Value = serde_json::from_str(&std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/stop-parity/corpus.json")).unwrap()).unwrap();
    let base = setup("replay");
    let (mut pairs, mut gap, mut problems) = (0u32, 0u32, Vec::<String>::new());
    let mut rows = Vec::new();
    for (n, sc) in corpus["scenarios"].as_array().unwrap().iter().enumerate() {
        for hook in sc["hooks"].as_array().unwrap() {
            let hook = hook.as_str().unwrap();
            let node = sc["node"][hook].as_str().unwrap();
            let engine = replay(sc, hook, &base, n);
            let id = sc["id"].as_str().unwrap();
            pairs += 1;
            let kept = sc["kept"][hook].as_str();
            rows.push(json!({"scenario": id, "class": sc["class"], "hook": hook, "node": node, "engine": engine, "kept": kept}));
            if engine != node {
                gap += 1;
                if kept.is_none() {
                    problems.push(format!("{id} / {hook}: node {node}, engine {engine} (not listed under kept)"));
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
            println!("  {} / {}: node {} engine {} kept={}", r["scenario"], r["hook"], r["node"], r["engine"], r["kept"]);
        }
    }
    assert!(problems.is_empty(), "stop parity drifted:\n{}", problems.join("\n"));
}
