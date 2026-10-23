//! The supervisor's act / mistake telemetry (#64): every duty outcome of a tick, every recorded action, a witness that
//! disagrees (a mistake) and a refused recover request emit the shared `act` / `mistake` events, read back here from the
//! scratch home's telemetry inbox (a home other than the process's own never writes the real state).
use ah_engine::checks::git::util::Settings;
use ah_engine::db::TempDir;
use ah_engine::dsact::runner::{RunResult, RunSpec, Runner};
use ah_engine::dssup::{Owner, recover, tick};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

fn now() -> i64 {
    ah_engine::health::now_ms() as i64
}

/// Answers every call with the same stdout.
struct Fixed(&'static str);

impl Runner for Fixed {
    fn run(&self, _: &RunSpec) -> RunResult {
        RunResult { ok: true, status: Some(0), stdout: self.0.into(), ..RunResult::default() }
    }
}

struct Fx {
    _t: TempDir,
    home: PathBuf,
    state: PathBuf,
    root: PathBuf,
}

fn fx(tag: &str) -> Fx {
    ah_engine::defaults::init().unwrap();
    let t = TempDir::new(tag);
    let dir = std::fs::canonicalize(&t.0).unwrap();
    let (home, state) = (dir.join("home"), dir.join("state"));
    std::fs::create_dir_all(&state).unwrap();
    let ws = home.join(".anti-hall/devswarm/workspaces");
    std::fs::create_dir_all(&ws).unwrap();
    std::fs::write(
        ws.join("ws-1.json"),
        json!({"id": "ws-1", "worktreePath": dir.join("wt-1"), "sessionId": "11111111-2222-3333-4444-555555555555"}).to_string(),
    )
    .unwrap();
    Fx { _t: t, home, state, root: ah_engine::defaults::root().unwrap() }
}

fn settings(f: &Fx) -> Settings {
    let mut env: HashMap<String, String> = HashMap::new();
    env.insert("HOME".into(), f.home.to_string_lossy().into_owned());
    // the witness has its own test below; everywhere else it stays off
    env.insert("ANTIHALL_DEVSWARM_SUP_WITNESS".into(), "off".into());
    Settings { home: f.home.to_string_lossy().into_owned(), env }
}

/// The telemetry events the scratch home's inbox holds, of kind `kind`.
fn events(home: &Path, kind: &str) -> Vec<Value> {
    let inbox = home
        .join(ah_engine::defaults::text("paths.base_dir"))
        .join(ah_engine::defaults::text("paths.state_dir"))
        .join(ah_engine::defaults::text("files.telemetry_inbox"));
    std::fs::read_to_string(inbox)
        .unwrap_or_default()
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter(|v| v["k"] == kind && v["h"] == ah_engine::defaults::text("devswarm_sup.action_feature"))
        .collect()
}

#[test]
fn a_recorded_action_is_an_act_event_with_its_outcome() {
    let f = fx("tel-action");
    let a = |action: &'static str, outcome: &'static str| tick::Action {
        action,
        target: "ws-1",
        inputs: json!({}),
        outcome,
        reason: "",
        latency_ms: 7,
        now: now(),
    };
    tick::record_action(&f.home, &a("dssup-escalation-notice", "ok"));
    tick::record_action(&f.home, &a("dssup-escalation-notice", "skipped"));
    tick::record_action(&f.home, &a("dssup-escalation-notice", "failed"));
    let acts = events(&f.home, "act");
    let outcomes: Vec<&str> = acts.iter().map(|v| v["o"].as_str().unwrap()).collect();
    assert_eq!(outcomes, ["allow", "skip", "error"], "{acts:?}");
    assert!(acts.iter().all(|v| v["e"] == "dssup-escalation-notice"), "{acts:?}");
}

#[test]
fn every_duty_outcome_of_a_tick_is_an_act_event() {
    let f = fx("tel-duties");
    let st = settings(&f);
    let ctx = tick::Ctx { home: &f.home, root: &f.root, st: &st, now: now(), engine_pokes: true };
    let out = tick::run(&ctx, Owner::Engine, &Fixed("{\"stub\":true}\n"));
    let duties: Vec<String> = out["duties"].as_array().unwrap().iter().map(|d| format!("duty-{}", d["duty"].as_str().unwrap())).collect();
    assert_eq!(duties.len(), 7, "{out}");
    let acts = events(&f.home, "act");
    for d in &duties {
        assert!(acts.iter().any(|v| v["e"] == d.as_str()), "no act event for {d}: {acts:?}");
    }
}

#[test]
fn a_refused_recover_request_is_a_block_act_event_with_its_reason() {
    let f = fx("tel-recover");
    let st = settings(&f);
    let place = recover::Place { home: &f.home, root: &f.root, state_dir: &f.state };
    let (report, _) = recover::run(&place, &st, &Fixed("{}"), "", "req-1", now());
    assert_eq!(report["outcome"], "refused", "{report}");
    let acts = events(&f.home, "act");
    assert_eq!(acts.len(), 1, "{acts:?}");
    assert_eq!((acts[0]["e"].as_str(), acts[0]["o"].as_str()), (Some("recover"), Some("block")), "{acts:?}");
    assert_eq!(acts[0]["reason"], "bad-id", "{acts:?}");
}
