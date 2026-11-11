//! #715/#709: stale runtime snapshots and unchanged Stop blocks must not trap a session.
use ah_engine::reqenv::RequestEnv;
use serde_json::{Value, json};
use std::path::PathBuf;

struct World {
    home: PathBuf,
}
impl World {
    fn new(tag: &str) -> Self {
        let home = std::env::temp_dir().join(format!("ah-reblock-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(home.join(".anti-hall/agent-tracker")).unwrap();
        Self { home }
    }
    fn write(&self, rel: &str, v: Value) {
        let p = self.home.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, v.to_string()).unwrap();
    }
    fn runtime(&self, agent: Value) {
        self.write(".anti-hall/agent-tracker/state.json", json!({"agents":{"child":agent}}));
        self.write(
            ".anti-hall/agent-tracker/runtime-escalations.json",
            json!({"rows":[{"session":"parent","child":"child","name":"worker","dur_ms":31620000,"block":true}]}),
        );
    }
    fn stop(&self) -> String {
        self.stop_env(&[])
    }
    fn stop_env(&self, extra: &[(&str, &str)]) -> String {
        let mut pairs = vec![("HOME".to_string(), self.home.to_string_lossy().into_owned())];
        pairs.extend(extra.iter().map(|(k, v)| (k.to_string(), v.to_string())));
        let env = RequestEnv::from_pairs(pairs);
        let p = json!({"hook_event_name":"Stop","session_id":"parent","cwd":self.home});
        format!("{:?}", ah_engine::script::run_forced("silent-agent-nudge", &p, &json!({}), "Stop", &env))
    }
}
#[test]
fn done_runtime_agent_does_not_block_and_repairs_overlay_idempotently() {
    let w = World::new("done");
    w.runtime(json!({"id":"child","kind":"teammate","parent":"parent","running":false,"finished":true}));
    assert!(!w.stop().contains("decision\\\":\\\"block"));
    let p = w.home.join(".anti-hall/agent-tracker/runtime-escalations.json");
    let once = std::fs::read_to_string(&p).unwrap();
    let overlay = w.home.join(".anti-hall/ah-engine/runtime-stop-overlay-parent.json");
    let audit = std::fs::read_to_string(&overlay).expect("logic-owned overlay");
    assert!(audit.contains("retired"));
    w.stop();
    assert_eq!(std::fs::read_to_string(p).unwrap(), once, "publisher file is read-only");
    assert_eq!(std::fs::read_to_string(overlay).unwrap(), audit);
}
#[test]
fn nudge_stop_runtime_agent_does_not_block() {
    let w = World::new("nudge");
    w.runtime(json!({"id":"child","kind":"teammate","parent":"parent","running":true}));
    std::fs::write(w.home.join(".anti-hall/agent-tracker/nudge-answers.ndjson"), "{\"ts\":1,\"child\":\"child\",\"answer\":\"stop\"}\n").unwrap();
    assert!(!w.stop().contains("decision\\\":\\\"block"));
}
#[test]
fn genuinely_running_runtime_agent_still_blocks() {
    let w = World::new("running");
    w.runtime(json!({"id":"child","kind":"teammate","parent":"parent","running":true}));
    assert!(w.stop().contains("block"));
}

#[test]
fn runtime_reblock_breaker_bounds_repeats_and_changed_subject_blocks_again() {
    let w = World::new("repeats");
    w.runtime(json!({"id":"child","kind":"teammate","parent":"parent","running":true}));
    for _ in 0..3 {
        assert!(w.stop().contains("decision\\\":\\\"block"));
    }
    let pass = w.stop();
    assert!(!pass.contains("decision\\\":\\\"block"), "{pass}");
    assert!(pass.contains("Unchanged Stop block released"), "{pass}");
    let mut metrics = ah_engine::metrics::Metrics::default();
    ah_engine::metrics::drain_pending(&mut metrics);
    assert!(metrics.counter("waste_events_total", &[("category", "reblock_loop"), ("source", "silent-agent-nudge")]) >= 1);
    w.write(
        ".anti-hall/agent-tracker/runtime-escalations.json",
        json!({"rows":[{"session":"parent","child":"another","name":"another","dur_ms":31620000,"block":true}]}),
    );
    assert!(w.stop().contains("decision\\\":\\\"block"));
}

impl World {
    // Owner overrides exercise the shared policy without each guard's unrelated one-shot budget hiding a repeat.
    fn policy(&self, guard: &str, reason: &str, state: Value, envs: &[(&str, &str)]) -> (String, String) {
        use std::io::Write;
        use std::process::{Command, Stdio};
        let dir = self.home.join(".anti-hall/logic");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("silent-agent-nudge.js"), "function decide(p) { return stopReblock.finish(p.guard, p, {exact:{code:0,out:JSON.stringify({decision:'block',reason:p.reason})+'\\n',err:''}}, p.state); }").unwrap();
        let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
        c.args(["check", "silent-agent-nudge"])
            .env_clear()
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .env("AH_ENGINE_PLUGIN_ROOT", PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall"))
            .env("AH_ENGINE_SCRIPT_TIME_MS", "500")
            .env("HOME", &self.home)
            .env("AH_ENGINE_DIR", self.home.join(".anti-hall/ah-engine"))
            .envs(envs.iter().copied())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = c.spawn().unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(json!({"hook_event_name":"Stop","session_id":"policy","guard":guard,"reason":reason,"state":state}).to_string().as_bytes())
            .unwrap();
        let out = child.wait_with_output().unwrap();
        assert!(out.status.success());
        (String::from_utf8_lossy(&out.stdout).into(), String::from_utf8_lossy(&out.stderr).into())
    }
}
#[test]
fn each_coordination_guard_is_bounded_state_sensitive_and_announces_once() {
    for guard in ["silent-agent-nudge", "devswarm-child-gate", "task-guard", "auto-handover-pause-nag"] {
        let w = World::new(guard);
        for min in [10, 11, 12] {
            assert!(w.policy(guard, &format!("worker running {min} min"), json!({"pending":["a"]}), &[]).0.contains("block"));
        }
        let pass = w.policy(guard, "worker running 13 min", json!({"pending":["a"]}), &[]);
        assert!(!pass.0.contains("block"), "{guard}: {pass:?}");
        assert!(pass.1.contains("Unchanged Stop block released"));
        assert!(w.policy(guard, "worker running 14 min", json!({"pending":["a"]}), &[]).1.is_empty());
        assert!(w.policy(guard, "worker running 14 min", json!({"pending":["b"]}), &[]).0.contains("block"), "changed state gets its first block");
        assert!(w.policy(guard, "different problem", json!({"pending":["b"]}), &[]).0.contains("block"), "changed reason gets its first block");
    }
}
#[test]
fn breaker_setting_and_repeat_limit_are_respected_and_safety_guards_never_release() {
    let w = World::new("switch");
    for _ in 0..5 {
        assert!(w.policy("silent-agent-nudge", "same", json!(0), &[("ANTIHALL_STOP_REBLOCK", "0")]).0.contains("block"));
    }
    let w = World::new("zero");
    assert!(w.policy("silent-agent-nudge", "same", json!(0), &[("ANTIHALL_STOP_REBLOCK_MAX", "0")]).0.contains("block"));
    assert!(!w.policy("silent-agent-nudge", "same", json!(0), &[("ANTIHALL_STOP_REBLOCK_MAX", "0")]).0.contains("block"));
    for guard in ["git-guard", "edit-guard", "claim-evidence-guard", "command-guard", "unknown-destructive-check"] {
        let w = World::new(guard);
        for _ in 0..5 {
            assert!(w.policy(guard, "same", json!(0), &[]).0.contains("block"), "{guard}");
        }
    }
}
#[test]
fn old_stop_answer_does_not_hide_a_new_running_incarnation() {
    let w = World::new("restart");
    w.runtime(json!({"id":"child","kind":"teammate","parent":"parent","running":true,"first_seen":2}));
    std::fs::write(w.home.join(".anti-hall/agent-tracker/nudge-answers.ndjson"), "{\"ts\":1,\"child\":\"child\",\"answer\":\"stop\"}\n").unwrap();
    assert!(w.stop().contains("decision\\\":\\\"block"));
}
#[test]
fn finished_heartbeat_candidate_does_not_block_without_runtime_snapshot() {
    let w = World::new("heartbeat");
    w.write(".anti-hall/agent-tracker/state.json", json!({"agents":{"child":{"id":"child","kind":"teammate","parent":"parent","running":false}}}));
    w.write(".anti-hall/agents/child.json", json!({"id":"child","session":"parent","status":"running","ts":std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64 - 1800000}));
    assert!(!w.stop().contains("decision\\\":\\\"block"));
}
#[test]
fn normal_heartbeat_reblocks_with_fresh_ack_timestamp_are_bounded() {
    let w = World::new("normal-repeat");
    w.write(".anti-hall/agents/child.json", json!({"id":"child","session":"parent","status":"running","ts":std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64 - 1800000}));
    for _ in 0..3 {
        assert!(w.stop().contains("decision\\\":\\\"block"));
        // Simulate another Stop before the after_reply state was delivered; do not change agent evidence.
        w.write(".anti-hall/silent-agent-nudge-state.json", json!({"nudged":{},"ever":{}}));
        std::thread::sleep(std::time::Duration::from_millis(2));
    }
    let out = w.stop();
    assert!(!out.contains("decision\\\":\\\"block"), "{out}");
}
#[test]
fn retired_snapshot_remains_retired_when_completion_evidence_disappears() {
    let w = World::new("retired");
    w.runtime(json!({"id":"child","kind":"teammate","parent":"parent","finished":true}));
    assert!(!w.stop().contains("decision\\\":\\\"block"));
    w.write(".anti-hall/agent-tracker/state.json", json!({"agents":{}}));
    assert!(!w.stop().contains("decision\\\":\\\"block"));
}
#[test]
fn refreshed_live_tracker_evidence_overrides_stale_persisted_completion() {
    let w = World::new("live-wins");
    w.runtime(json!({"id":"child","kind":"teammate","parent":"parent","finished":true}));
    let lib = w.home.join(".anti-hall/logic/lib");
    std::fs::create_dir_all(&lib).unwrap();
    std::fs::write(lib.join("99-live-fixture.js"), "ah.transcript.trackedAgents = function () { return [{id:'child',state:'running',known:true}]; };").unwrap();
    assert!(w.stop().contains("decision\\\":\\\"block"));
}
#[test]
fn runtime_reconciliation_can_be_disabled() {
    let w = World::new("reconcile-off");
    w.runtime(json!({"id":"child","kind":"teammate","parent":"parent","finished":true}));
    assert!(w.stop_env(&[("ANTIHALL_RUNTIME_STOP_RECONCILE", "0")]).contains("decision\\\":\\\"block"));
}

impl World {
    fn check(&self, check: &str, p: Value, extra: &[(&str, &str)]) -> String {
        let mut pairs = vec![("HOME".to_string(), self.home.to_string_lossy().into_owned())];
        pairs.extend(extra.iter().map(|(k, v)| (k.to_string(), v.to_string())));
        let env = RequestEnv::from_pairs(pairs);
        format!("{:?}", ah_engine::script::run_forced(check, &p, &json!({}), "Stop", &env))
    }
}
#[test]
fn actual_child_workspace_check_bounds_unchanged_bookkeeping_retries_on_both_hosts() {
    for host in ["claude", "codex"] {
        let w = World::new(&format!("child-{host}"));
        w.write(".anti-hall/devswarm/workspaces/b-1.json", json!({}));
        let p = json!({"hook_event_name":"Stop","session_id":"parent","cwd":w.home});
        let env = [("DEVSWARM_REPO_ID", "r1"), ("DEVSWARM_SOURCE_BRANCH", "feat/x"), ("DEVSWARM_BUILDER_ID", "b-1"), ("DEVSWARM_AI_AGENT", host)];
        for _ in 0..3 {
            w.write(".anti-hall/devswarm/child-gate/parent.json", json!({}));
            w.write(".anti-hall/devswarm/stop-policy/parent.json", json!({}));
            let out = w.check("devswarm-child-gate", p.clone(), &env);
            assert!(out.contains("decision\\\":\\\"block"), "{out}");
        }
        w.write(".anti-hall/devswarm/child-gate/parent.json", json!({}));
        w.write(".anti-hall/devswarm/stop-policy/parent.json", json!({}));
        let out = w.check("devswarm-child-gate", p, &env);
        assert!(!out.contains("decision\\\":\\\"block"), "{out}");
        assert!(out.contains("Unchanged Stop block released"), "{out}");
    }
}
#[test]
fn actual_idle_task_check_bounds_unchanged_bookkeeping_retries() {
    let w = World::new("idle-real");
    let tp = w.home.join("task.jsonl");
    let lines = [
        json!({"type":"assistant","timestamp":"2999-01-01T00:00:00.000Z","message":{"id":"m1","role":"assistant","content":[{"type":"tool_use","id":"c1","name":"TaskCreate","input":{"subject":"P1 inspect build logs","description":"Inspect build logs"}}]}}),
        json!({"type":"user","timestamp":"2999-01-01T00:00:00.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"c1","content":"Task #1 created successfully: P1 inspect build logs"}]}}),
    ];
    std::fs::write(&tp, lines.iter().map(|l| format!("{l}\n")).collect::<String>()).unwrap();
    let p = json!({"hook_event_name":"Stop","session_id":"parent","cwd":w.home,"transcript_path":tp});
    for _ in 0..3 {
        w.write(".anti-hall/last-stop-taskset-parent", json!({}));
        let out = w.check("task-guard", p.clone(), &[("ANTIHALL_IDLE_RULE", "1")]);
        assert!(out.contains("decision\\\":\\\"block"), "{out}");
    }
    w.write(".anti-hall/last-stop-taskset-parent", json!({}));
    let out = w.check("task-guard", p, &[("ANTIHALL_IDLE_RULE", "1")]);
    assert!(!out.contains("decision\\\":\\\"block"), "{out}");
    assert!(out.contains("Unchanged Stop block released"), "{out}");
}
#[test]
fn actual_pause_nag_bounds_same_displayed_context_with_small_usage_growth() {
    let w = World::new("pause-real");
    w.write(".anti-hall/settings.json", json!({"autoHandover":{"pct":85}}));
    w.write(".anti-hall/handovers/2026-11-12/parent/HANDOVER.md", json!("before"));
    let tp = w.home.join("usage.jsonl");
    let p = json!({"hook_event_name":"Stop","session_id":"parent","cwd":w.home,"transcript_path":tp});
    for (i, tokens) in [180000, 180010, 180020, 180030].iter().enumerate() {
        std::fs::write(&tp,format!("{}\n",json!({"type":"assistant","message":{"usage":{"input_tokens":10,"cache_creation_input_tokens":tokens-10,"cache_read_input_tokens":0},"content":[{"type":"text","text":"x"}]}}))).unwrap();
        w.write(".anti-hall/auto-handover/parent.json", json!({"fired":true,"firedPct":86,"lastNagPct":89,"lastNagAt":0}));
        let out = w.check("auto-handover-pause-nag", p.clone(), &[("ANTIHALL_CONTEXT_WINDOW_TOKENS", "200000")]);
        if i < 3 {
            assert!(out.contains("decision\\\":\\\"block"), "iteration {i}: {out}");
        } else {
            assert!(!out.contains("decision\\\":\\\"block"), "{out}");
        }
    }
    std::thread::sleep(std::time::Duration::from_millis(2));
    w.write(".anti-hall/handovers/2026-11-12/parent/HANDOVER.md", json!("updated handover"));
    w.write(".anti-hall/auto-handover/parent.json", json!({"fired":true,"firedPct":86,"lastNagPct":89,"lastNagAt":0}));
    let handover_changed = w.check("auto-handover-pause-nag", p.clone(), &[("ANTIHALL_CONTEXT_WINDOW_TOKENS", "200000")]);
    assert!(handover_changed.contains("decision\\\":\\\"block"), "editing the existing handover resets the budget: {handover_changed}");
    std::fs::write(&tp,format!("{}\n",json!({"type":"assistant","message":{"usage":{"input_tokens":190000,"cache_creation_input_tokens":0,"cache_read_input_tokens":0},"content":[{"type":"text","text":"x"}]}}))).unwrap();
    w.write(".anti-hall/auto-handover/parent.json", json!({"fired":true,"firedPct":86,"lastNagPct":89,"lastNagAt":0}));
    let changed = w.check("auto-handover-pause-nag", p, &[("ANTIHALL_CONTEXT_WINDOW_TOKENS", "200000")]);
    assert!(changed.contains("decision\\\":\\\"block"), "context reaching a new displayed level must block: {changed}");
}

#[test]
fn actual_pause_without_cwd_still_blocks_instead_of_throwing() {
    let w = World::new("pause-no-cwd");
    w.write(".anti-hall/settings.json", json!({"autoHandover":{"pct":85}}));
    w.write(".anti-hall/auto-handover/parent.json", json!({"fired":true,"firedPct":86,"lastNagPct":89,"lastNagAt":0}));
    let tp = w.home.join("usage.jsonl");
    std::fs::write(&tp,format!("{}\n",json!({"type":"assistant","message":{"usage":{"input_tokens":180000,"cache_creation_input_tokens":0,"cache_read_input_tokens":0},"content":[{"type":"text","text":"x"}]}}))).unwrap();
    let out = w.check(
        "auto-handover-pause-nag",
        json!({"hook_event_name":"Stop","session_id":"parent","transcript_path":tp}),
        &[("ANTIHALL_CONTEXT_WINDOW_TOKENS", "200000")],
    );
    assert!(out.contains("decision\\\":\\\"block"), "{out}");
}

#[test]
fn child_gate_frozen_golden_corpus_still_matches() {
    let corpus = include_str!("../golden/devswarm-child-gate.jsonl");
    let mut count = 0;
    for line in corpus.lines().filter(|s| !s.trim().is_empty()) {
        let raw: Value = serde_json::from_str(line).unwrap();
        let w = World::new(&format!("child-golden-{}", raw["n"].as_str().unwrap()));
        // This frozen corpus has only HOME substitutions, text files, allow verdicts and no pinned clocks/watched writes.
        let c: Value = serde_json::from_str(&line.replace("{HOME}", &w.home.to_string_lossy())).unwrap();
        assert_eq!(c["expect"], json!({"v":"allow"}), "unexpected corpus shape");
        for (rel, contents) in c["files"].as_object().unwrap() {
            let path = w.home.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, contents.as_str().expect("text fixture")).unwrap();
        }
        let env = RequestEnv::from_pairs(c["env"].as_object().unwrap().iter().map(|(k, v)| (k.clone(), v.as_str().unwrap().to_owned())).collect::<Vec<_>>());
        let got = ah_engine::script::run_forced("devswarm-child-gate", &c["payload"], &json!({}), c["event"].as_str().unwrap(), &env);
        assert!(matches!(got, Some(Some(ah_engine::checks::Verdict::Allow))), "case {}: {got:?}", c["n"]);
        count += 1;
    }
    assert_eq!(count, 411);
}

impl World {
    fn fixture(&self, js: &str) {
        let lib = self.home.join(".anti-hall/logic/lib");
        std::fs::create_dir_all(&lib).unwrap();
        std::fs::write(lib.join("99-runtime-fixture.js"), js).unwrap();
    }
    fn answer(&self, answer: &str, minutes: u64, age: u64) {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
        std::fs::write(
            self.home.join(".anti-hall/agent-tracker/nudge-answers.ndjson"),
            format!("{}\n", json!({"ts":now-age,"child":"child","answer":answer,"min":minutes,"text":"owner reason"})),
        )
        .unwrap();
    }
}
#[test]
fn runtime_owner_answers_hold_for_promised_windows_then_reblock() {
    for (answer, minutes, age, blocked) in [
        ("other", 0, 29 * 60000, false),
        ("other", 0, 31 * 60000, true),
        ("snooze", 45, 44 * 60000, false),
        ("snooze", 45, 46 * 60000, true),
        ("snooze", 999, 239 * 60000, false),
        ("snooze", 999, 241 * 60000, true),
        ("msg", 0, 1000, false),
        ("msg", 0, 16 * 60000, true),
        ("stop", 0, 1000, false),
        ("acted", 0, 1000, false),
        ("wrong", 0, 1000, true),
    ] {
        let w = World::new(&format!("answer-{answer}-{minutes}-{age}"));
        w.runtime(json!({"id":"child","kind":"teammate","parent":"parent","running":true}));
        w.answer(answer, minutes, age);
        let out = w.stop();
        assert_eq!(out.contains("decision\\\":\\\"block"), blocked, "{answer}/{minutes}/{age}: {out}");
    }
}
#[test]
fn concurrent_publication_during_repair_keeps_new_live_row() {
    let w = World::new("publish-race");
    w.runtime(json!({"id":"child","kind":"teammate","parent":"parent","finished":true}));
    w.fixture("var oldRead=ah.fs.readText; ah.fs.readText=function(p){var v=oldRead(p); if(p.slice(-10)==='state.json'){ah.state.writeAtomic('.anti-hall/agent-tracker/runtime-escalations.json',JSON.stringify({rows:[{session:'parent',child:'child',name:'worker',block:true},{session:'parent',child:'new-live',name:'new worker',block:true}]}));} return v;};");
    w.stop();
    let doc: Value = serde_json::from_str(&std::fs::read_to_string(w.home.join(".anti-hall/agent-tracker/runtime-escalations.json")).unwrap()).unwrap();
    assert_eq!(doc["rows"].as_array().unwrap().len(), 2, "concurrent publisher row survives");
    assert!(w.stop().contains("decision\\\":\\\"block"), "new live row still blocks on the next read");
}
#[test]
fn runtime_overlay_is_session_isolated_and_corruption_does_not_release_live_agent() {
    let w = World::new("overlay-isolation");
    w.runtime(json!({"id":"child","kind":"teammate","parent":"parent","finished":true}));
    w.stop();
    let overlay = w.home.join(".anti-hall/ah-engine/runtime-stop-overlay-parent.json");
    assert!(overlay.is_file());
    w.write(".anti-hall/agent-tracker/state.json", json!({"agents":{}}));
    w.write(".anti-hall/agent-tracker/runtime-escalations.json", json!({"rows":[{"session":"other","child":"child","name":"worker","block":true}]}));
    let p = json!({"hook_event_name":"Stop","session_id":"other","cwd":w.home});
    assert!(w.check("silent-agent-nudge", p, &[]).contains("decision\\\":\\\"block"));
    std::fs::write(overlay, "{corrupt").unwrap();
    w.runtime(json!({"id":"child","parent":"parent","kind":"teammate","running":true}));
    assert!(w.stop().contains("decision\\\":\\\"block"));
}
#[test]
fn runtime_overlay_write_failure_keeps_publisher_block() {
    let w = World::new("overlay-write-failure");
    w.runtime(json!({"id":"child","parent":"parent","kind":"teammate","finished":true}));
    w.fixture(
        "var oldWrite=ah.state.writeAtomic; ah.state.writeAtomic=function(p,t){if(p.indexOf('runtime-stop-overlay-')>=0)return false;return oldWrite(p,t);};",
    );
    assert!(w.stop().contains("decision\\\":\\\"block"));
}
#[test]
fn runtime_overlay_expiry_restores_publisher_decision() {
    let w = World::new("overlay-expiry");
    w.runtime(json!({"id":"child","parent":"parent","kind":"teammate","finished":true}));
    w.stop();
    w.write(".anti-hall/agent-tracker/state.json", json!({"agents":{}}));
    // Expire the persisted verdict directly: adding a clock library after the first Stop is
    // hidden until script.fingerprint_ttl_ms elapses, making that fixture order-dependent.
    let path = w.home.join(".anti-hall/ah-engine/runtime-stop-overlay-parent.json");
    let mut overlay: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    for row in overlay["rows"].as_object_mut().unwrap().values_mut() {
        row["until"] = json!(0);
    }
    std::fs::write(path, overlay.to_string()).unwrap();
    let out = w.stop();
    assert!(out.contains("decision\\\":\\\"block"), "{out}");
}

impl World {
    fn cli_stop(&self) -> String {
        use std::io::Write;
        use std::process::{Command, Stdio};
        let mut child = Command::new(env!("CARGO_BIN_EXE_ah-engine"))
            .args(["check", "silent-agent-nudge"])
            .env_clear()
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .env("HOME", &self.home)
            .env("AH_ENGINE_DIR", self.home.join(".anti-hall/ah-engine"))
            .env("AH_ENGINE_CONFIG", self.home.join("config.toml"))
            .env("AH_ENGINE_PLUGIN_ROOT", PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall"))
            .env("AH_ENGINE_NOSPAWN", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(json!({"hook_event_name":"Stop","session_id":"parent","cwd":self.home}).to_string().as_bytes()).unwrap();
        let out = child.wait_with_output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).into_owned()
    }
    fn custom_toml(&self) {
        let mut limits = ah_engine::defaults::raw("agent_nudge.limits").to_json();
        limits["snooze_default_min"] = json!(3);
        limits["snooze_min_min"] = json!(1);
        limits["snooze_max_min"] = json!(5);
        limits["window_ms"] = json!(60000);
        let limits = limits.as_object().unwrap().iter().map(|(k, v)| format!("{k} = {v}")).collect::<Vec<_>>().join(", ");
        std::fs::write(
            self.home.join("config.toml"),
            format!(
                r#"
[agent_nudge]
answers = {{ wrong="wrong", stop="halt", msg="send", snooze="later", other="extend", prose="prose", acted="replaced" }}
limits = {{ {limits} }}
[silent_nudge]
rt_repair = {{ marker="retired", file_prefix="custom-overlay-", file_ext=".json", ttl_ms=1000 }}
"#
            ),
        )
        .unwrap();
    }
}
#[test]
fn runtime_reconciliation_uses_toml_verbs_windows_cap_and_overlay_expiry() {
    for (answer, min, age, blocked) in [
        ("extend", 0, 120000, false),
        ("extend", 0, 240000, true),
        ("later", 999, 240000, false),
        ("later", 999, 360000, true),
        ("send", 0, 30000, false),
        ("send", 0, 90000, true),
        ("halt", 0, 1000, false),
    ] {
        let w = World::new(&format!("toml-{answer}-{age}"));
        w.runtime(json!({"id":"child","parent":"parent","kind":"teammate","running":true}));
        w.custom_toml();
        w.answer(answer, min, age);
        assert_eq!(w.cli_stop().contains("\"decision\":\"block\""), blocked, "{answer}/{age}");
    }
    let w = World::new("toml-expiry");
    w.runtime(json!({"id":"child","parent":"parent","kind":"teammate","finished":true}));
    w.custom_toml();
    assert!(!w.cli_stop().contains("\"decision\":\"block\""));
    assert!(w.home.join(".anti-hall/ah-engine/custom-overlay-parent.json").is_file());
    w.write(".anti-hall/agent-tracker/state.json", json!({"agents":{}}));
    w.fixture("var before=ah.clock.now; ah.clock.now=function(){return before()+2000;};");
    assert!(w.cli_stop().contains("\"decision\":\"block\""));
}

#[test]
fn runtime_owner_answer_aliases_cannot_release_another_session() {
    for alias in ["worker", "ref-a", "child-a"] {
        let w = World::new(&format!("answer-isolation-{alias}"));
        w.write(
            ".anti-hall/agent-tracker/state.json",
            json!({"agents":{
            "child-a":{"id":"child-a","parent":"other","kind":"teammate","running":true},
            "child":{"id":"child","parent":"parent","kind":"teammate","running":true}},"nudges":{
            "child-a":{"parent":"other","child_name":"worker","ref_id":"ref-a"},
            "child":{"parent":"parent","child_name":"worker","ref_id":"ref-b"}}}),
        );
        w.write(".anti-hall/agent-tracker/runtime-escalations.json", json!({"rows":[{"session":"parent","child":"child","name":"worker","block":true}]}));
        std::fs::write(w.home.join(".anti-hall/agent-tracker/nudge-answers.ndjson"), format!("{}\n", json!({"ts":1,"child":alias,"answer":"stop"}))).unwrap();
        assert!(w.stop().contains("decision\\\":\\\"block"), "alias {alias}");
    }
}

#[test]
fn runtime_structurally_corrupt_overlay_entry_does_not_release_live_agent() {
    let w = World::new("bad-overlay-entry");
    w.runtime(json!({"id":"child","parent":"parent","kind":"teammate","running":true}));
    w.write(".anti-hall/ah-engine/runtime-stop-overlay-parent.json", json!({"session":"parent","rows":{"[\"child\",\"worker\"]":1}}));
    assert!(w.stop().contains("decision\\\":\\\"block"));
}
#[test]
fn runtime_overlay_throw_preserves_the_publisher_block() {
    let w = World::new("overlay-throw");
    w.runtime(json!({"id":"child","parent":"parent","kind":"teammate","finished":true}));
    w.fixture("var oldWrite=ah.state.writeAtomic; ah.state.writeAtomic=function(p,t){if(p.indexOf('runtime-stop-overlay-')>=0)throw Error('write failed');return oldWrite(p,t);};");
    assert!(w.stop().contains("decision\\\":\\\"block"));
}
