//! GH #540 / plan v2 C1, end to end: the Stop channel through the real dispatcher (`ah-engine hook --event Stop`), fed Stop payloads of
//! the shape the host sends (`session_id`, `cwd`, `transcript_path`, `permission_mode`, `stop_hook_active`).
//!
//! The Stop note is the tasklist-guard's plan-mode note: the recorded golden case `tasklist-guard` "plan mode" (a Stop in plan mode
//! answers exit 0 with that note on stderr and nothing on stdout; the invisible-channel ratchet lists it as an
//! offender). The tests check the exact stdout:
//! - switch off (the default): the answer is what the check printed, untouched;
//! - switch on: the note is `hookSpecificOutput.additionalContext` (stderr, which the user sees, is left as it is);
//! - the third consecutive soft block is withheld, and a prompt or a tool call restarts the count;
//! - running background work: no soft block, the note comes with the next prompt, once;
//! - the engine-health advisory (a `systemMessage`) merged into a Stop answer follows the same switch.
//!
//! Each test has its own HOME and state directory.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use serde_json::{Value, json};
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

/// The text of the note, as the check prints it on stderr (the golden `tasklist-guard` plan-mode case).
const PLAN_NOTE: &str = "[tasklist-guard] PLAN MODE \u{2014} Stop not blocked (progress-file writes are not possible in plan mode). Track this work as tasks and refresh the progress file once you leave plan mode.";
const HEALTH: &str = "ENGINE-HEALTH: running on built-in checks";

struct Rig {
    dir: PathBuf,
}

impl Rig {
    fn new(name: &str) -> Rig {
        let dir = std::env::temp_dir().join(format!("ahd-stopchan-{name}-{}", std::process::id()));
        ah_engine::discard::harmless(std::fs::remove_dir_all(&dir));
        std::fs::create_dir_all(dir.join("home/.anti-hall")).unwrap();
        std::fs::create_dir_all(dir.join("proj/.git")).unwrap();
        std::fs::write(dir.join("proj/.git/HEAD"), "ref: refs/heads/main\n").unwrap();
        Rig { dir }
    }

    fn home(&self) -> PathBuf {
        self.dir.join("home")
    }

    fn state(&self) -> PathBuf {
        self.dir.join("state")
    }

    fn settings(&self, channel: Option<Value>) {
        let s = channel.map_or_else(|| json!({}), |c| json!({ "context": c }));
        std::fs::write(self.home().join(".anti-hall/settings.json"), s.to_string()).unwrap();
    }

    /// A transcript the way the host writes one (plan mode answers before reading it, so it holds no edits for the other Stop
    /// checks to act on).
    fn transcript(&self) -> PathBuf {
        let t = self.dir.join("t.jsonl");
        let user = json!({"type": "user", "message": {"role": "user", "content": "plan the change"}, "timestamp": ah_engine::checks::agent_scan::iso_utc(now_ms() - 60_000.0)});
        let asst = json!({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "Here is the plan."}], "stop_reason": "end_turn"}, "timestamp": ah_engine::checks::agent_scan::iso_utc(now_ms() - 30_000.0)});
        std::fs::write(&t, format!("{user}\n{asst}\n")).unwrap();
        t
    }

    /// A Stop payload as the host sends it (plan mode: the recorded case).
    fn stop(&self, active: bool) -> Value {
        json!({"session_id": "sc1", "cwd": self.dir.join("proj"), "hook_event_name": "Stop", "permission_mode": "plan",
               "stop_hook_active": active, "transcript_path": self.dir.join("t.jsonl")})
    }

    fn prompt(&self) -> Value {
        json!({"session_id": "sc1", "cwd": self.dir.join("proj"), "hook_event_name": "UserPromptSubmit", "prompt": "any news?", "transcript_path": self.dir.join("t.jsonl")})
    }

    fn run(&self, event: &str, payload: &Value) -> (i32, String, String) {
        self.run_with(event, payload, &[])
    }

    fn run_with(&self, event: &str, payload: &Value, env: &[(&str, &str)]) -> (i32, String, String) {
        let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
        c.args(["hook", "--event", event])
            .env_clear()
            .env("AH_ENGINE_PLUGIN_ROOT", std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall"))
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", self.home())
            .env("AH_ENGINE_DIR", self.state())
            .env("AH_ENGINE_VERSION", "stopchan-e2e")
            .env("AH_ENGINE_DISPATCH_IN_PROCESS", "1")
            .env("CLAUDE_PLUGIN_ROOT", &self.dir)
            .envs(env.iter().copied())
            .current_dir(&self.dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut ch = c.spawn().unwrap();
        ch.stdin.take().unwrap().write_all(payload.to_string().as_bytes()).unwrap();
        let o = ch.wait_with_output().unwrap();
        (o.status.code().unwrap_or(-1), String::from_utf8_lossy(&o.stdout).to_string(), String::from_utf8_lossy(&o.stderr).to_string())
    }

    /// The Stop-channel counters this rig's dispatches queued for the daemon (`stopchan` events in the telemetry inbox), as
    /// `counter/check` words.
    fn counters(&self) -> Vec<String> {
        let inbox = self.state().join(ah_engine::defaults::text("files.telemetry_inbox"));
        std::fs::read_to_string(inbox)
            .unwrap_or_default()
            .lines()
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .filter(|v| v["k"] == "stopchan")
            .map(|v| format!("{}/{}", v["h"].as_str().unwrap(), v["e"].as_str().unwrap()))
            .collect()
    }

    /// The advisory layer holds a fixed-text note back for N further calls of a session; the tests that fire it again forget that
    /// (the cap under test is the Stop channel's, not the advisory layer's).
    fn forget_advisories(&self) {
        let dir = self.home().join(".anti-hall");
        for e in std::fs::read_dir(&dir).unwrap().flatten() {
            if e.file_name().to_string_lossy().starts_with("advisory-state-") {
                std::fs::remove_file(e.path()).unwrap();
            }
        }
    }

    fn stop_out(&self, active: bool) -> String {
        self.forget_advisories();
        let (code, out, err) = self.run("Stop", &self.stop(active));
        assert_eq!(code, 0, "{out:?} {err:?}");
        assert!(err.contains(PLAN_NOTE), "stderr keeps the note for the user: {err:?}");
        out
    }
}

fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as f64
}

/// The expected soft-block answer: the dispatcher's JSON for the note on Stop `additionalContext`.
fn soft() -> String {
    format!("{}\n", json!({"hookSpecificOutput": {"hookEventName": "Stop", "additionalContext": PLAN_NOTE}}))
}

#[test]
fn switch_off_the_stop_answer_is_what_the_check_printed() {
    let r = Rig::new("off");
    r.settings(None);
    r.transcript();
    assert_eq!(r.stop_out(false), "", "stdout is empty, the note is on stderr only (today's invisible channel)");
    assert!(r.counters().is_empty(), "off: nothing counted: {:?}", r.counters());
    assert!(!r.state().join(ah_engine::defaults::text("stop_channel.state_dir")).exists(), "off: no state written");
}

#[test]
fn switch_on_the_note_is_stop_additional_context() {
    let r = Rig::new("on");
    r.settings(Some(json!({"stopAdditionalContext": true})));
    r.transcript();
    let out = r.stop_out(false);
    assert_eq!(out, soft());
    let v: Value = serde_json::from_str(&out).unwrap();
    assert!(v.get("systemMessage").is_none() && v["hookSpecificOutput"]["additionalContext"] == PLAN_NOTE);
    assert_eq!(r.counters(), vec!["soft_block/tasklist-guard".to_string()]);
}

#[test]
fn the_third_consecutive_soft_block_is_withheld_and_a_prompt_or_a_tool_call_restarts_the_count() {
    let r = Rig::new("cap");
    r.settings(Some(json!({"stopAdditionalContext": true})));
    let t = r.transcript();
    assert_eq!(r.stop_out(false), soft(), "soft block 1");
    assert_eq!(r.stop_out(true), soft(), "soft block 2 (a continuation)");
    assert_eq!(r.stop_out(true), "", "the third continuation gets no soft block: the note stays where it was");
    assert_eq!(r.stop_out(true), "", "and stays withheld while nothing changed");
    // a tool call after the last soft block restarts the count
    let line = json!({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "tool_use", "id": "tu1", "name": "Bash", "input": {"command": "ls"}}]}});
    std::fs::OpenOptions::new().append(true).open(&t).unwrap().write_all(format!("{line}\n").as_bytes()).unwrap();
    assert_eq!(r.stop_out(false), soft(), "a tool call since the last soft block: soft again");
    assert_eq!(r.stop_out(true), soft());
    assert_eq!(r.stop_out(true), "", "capped again");
    // a new prompt restarts it too
    let (code, _, err) = r.run("UserPromptSubmit", &r.prompt());
    assert_eq!(code, 0, "{err:?}");
    assert_eq!(r.stop_out(false), soft(), "a new prompt: soft again");
    let c = r.counters();
    assert_eq!(c.iter().filter(|w| w.starts_with("soft_block/")).count(), 5, "{c:?}");
    assert_eq!(c.iter().filter(|w| *w == "cap_hit/all").count(), 3, "{c:?}");
    assert_eq!(c.iter().filter(|w| *w == "system_message/tasklist-guard").count(), 3, "{c:?}");
}

#[test]
fn a_cap_of_zero_never_soft_blocks() {
    let r = Rig::new("cap0");
    r.settings(Some(json!({"stopAdditionalContext": true, "stopContinuationCap": 0})));
    r.transcript();
    assert_eq!(r.stop_out(false), "");
}

/// The tracker's state with a running background agent of the session `sc1`: its transcript's last line is a recent assistant turn
/// that has not ended, so the tracker reads it as running (the same facts the guards use).
fn running_agent(r: &Rig) {
    let sub = r.dir.join("sub.jsonl");
    let ts = ah_engine::checks::agent_scan::iso_utc(now_ms() - 5_000.0);
    let line = json!({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "tool_use", "id": "tu9", "name": "Bash", "input": {"command": "sleep 600"}}]}, "timestamp": ts, "cwd": r.dir});
    std::fs::write(&sub, format!("{line}\n")).unwrap();
    let paths = ah_engine::defaults::raw("agent_tracker.paths");
    let dir = r.home().join(paths.str_field("base")).join(paths.str_field("dir"));
    std::fs::create_dir_all(&dir).unwrap();
    let agent = ah_engine::agents::Agent {
        id: "sub1".into(),
        kind: "subagent".into(),
        parent: "sc1".into(),
        name: "sub1".into(),
        cwd: r.dir.to_string_lossy().into(),
        path: sub.to_string_lossy().into(),
        source: "transcript".into(),
        ..Default::default()
    };
    let state = ah_engine::agents::State { agents: [("sub1".to_string(), agent)].into(), ..Default::default() };
    std::fs::write(dir.join(paths.str_field("state")), serde_json::to_string(&state).unwrap()).unwrap();
}

#[test]
fn running_background_work_holds_the_note_and_the_next_prompt_delivers_it_once() {
    let r = Rig::new("pending");
    r.settings(Some(json!({"stopAdditionalContext": true})));
    r.transcript();
    running_agent(&r);
    assert_eq!(r.stop_out(false), "", "no soft block while the agent runs");
    let (code, out, err) = r.run("UserPromptSubmit", &r.prompt());
    assert_eq!(code, 0, "{err:?}");
    let v: Value = serde_json::from_str(out.trim()).unwrap();
    let ctx = v["hookSpecificOutput"]["additionalContext"].as_str().unwrap();
    assert!(ctx.contains(PLAN_NOTE) && ctx.contains(ah_engine::defaults::text("stop_channel.msg_held_prefix")), "{ctx:?}");
    assert_eq!(v["hookSpecificOutput"]["hookEventName"], "UserPromptSubmit");
    let (_, again, _) = r.run("UserPromptSubmit", &r.prompt());
    assert!(!again.contains(PLAN_NOTE), "delivered once: {again:?}");
    let c = r.counters();
    assert!(c.contains(&"deferred_pending_work/tasklist-guard".to_string()) && c.contains(&"deferred_delivered/all".to_string()), "{c:?}");
    assert!(!c.iter().any(|w| w.starts_with("soft_block/")), "{c:?}");
}

#[test]
fn the_pending_guard_switch_off_soft_blocks_regardless() {
    let r = Rig::new("pending-off");
    r.settings(Some(json!({"stopAdditionalContext": true, "stopDeferPending": false})));
    r.transcript();
    running_agent(&r);
    assert_eq!(r.stop_out(false), soft());
}

/// The recorded `task-guard` case "legacy path with a live heartbeat": open tasks remain but a live agent is active, so the check
/// deferred its own Stop block and said so on stderr. A soft block on that note would undo the deferral, so it is not moved.
#[test]
fn a_check_that_stepped_aside_is_not_turned_into_a_soft_block() {
    let r = Rig::new("taskguard");
    r.settings(Some(json!({"stopAdditionalContext": true})));
    std::fs::create_dir_all(r.home().join(".anti-hall/agents")).unwrap();
    std::fs::write(r.home().join(".anti-hall/agents/a.json"), json!({"ts": now_ms() as u64 - 60_000}).to_string()).unwrap();
    let create = json!({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "tool_use", "id": "c1", "name": "TaskCreate", "input": {"subject": "one"}}]}});
    let result = json!({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "c1", "content": "Task #1 created successfully: one"}]}});
    std::fs::write(r.dir.join("t.jsonl"), format!("{create}\n{result}\n")).unwrap();
    let payload = json!({"session_id": "s1", "cwd": r.home(), "hook_event_name": "Stop", "transcript_path": r.dir.join("t.jsonl")});
    let env = [("ANTIHALL_DISPATCH_DEMAND", "0"), ("ANTIHALL_MAX_PARALLEL_DISPATCH", "4")];
    let (code, out, err) = r.run_with("Stop", &payload, &env);
    assert_eq!(code, 0, "{out:?} {err:?}");
    assert!(err.contains("[task-guard] open tasks remain but live agents are active"), "the recorded note: {err:?}");
    assert_eq!(out, "", "stdout stays empty: the deferral is not turned into a soft block");
    assert!(r.counters().is_empty(), "{:?}", r.counters());
}

#[test]
fn the_health_advisory_merged_into_a_stop_answer_follows_the_switch() {
    // the fail-open notice is the engine's own advisory, merged at the end of every dispatch once per session
    let health_stop = |r: &Rig| {
        std::fs::create_dir_all(r.state()).unwrap();
        std::fs::write(r.state().join(ah_engine::defaults::text("fail_open.notice_file")), HEALTH).unwrap();
        let (code, out, err) = r.run("Stop", &json!({"session_id": "sc1h", "cwd": r.dir.join("proj"), "hook_event_name": "Stop"}));
        assert_eq!(code, 0, "{out:?} {err:?}");
        serde_json::from_str::<Value>(out.trim()).unwrap_or_else(|_| panic!("{out:?} {err:?}"))
    };
    let off = Rig::new("health-off");
    off.settings(None);
    assert_eq!(health_stop(&off), json!({"systemMessage": HEALTH}), "off: the invisible channel, as before");
    let on = Rig::new("health-on");
    on.settings(Some(json!({"stopAdditionalContext": true})));
    assert_eq!(health_stop(&on), json!({"hookSpecificOutput": {"hookEventName": "Stop", "additionalContext": HEALTH}}));
    assert_eq!(on.counters(), vec!["soft_block/health-advisory".to_string()]);
}

#[test]
fn codex_stays_on_its_current_channel() {
    // the Codex Stop hook's additionalContext behaviour is unconfirmed: stop_channel.hosts lists claude only
    assert_eq!(ah_engine::defaults::list("stop_channel.hosts"), vec!["claude"]);
}
