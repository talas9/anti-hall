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

impl Drop for Rig {
    fn drop(&mut self) {
        ah_engine::discard::harmless(std::fs::remove_dir_all(&self.dir)); // keep: a test directory; an absent one is the goal state
    }
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
        self.run_host("claude", event, payload, env)
    }

    fn run_host(&self, host: &str, event: &str, payload: &Value, env: &[(&str, &str)]) -> (i32, String, String) {
        let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
        c.args(["hook", "--event", event, "--host", host])
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

// ---- fail-closed, atomic state (the review of PR #561: GH #540 first fix lane) ----
//
// Every test runs the real `ah-engine hook --event Stop|UserPromptSubmit`. The race tests start the processes at the same moment, 20
// rounds each.

const ROUNDS: usize = 20;

impl Rig {
    fn chan_dir(&self) -> PathBuf {
        self.state().join(ah_engine::defaults::text("stop_channel.state_dir"))
    }

    fn note_file(&self) -> PathBuf {
        self.chan_dir().join(format!("sc1{}", ah_engine::defaults::text("stop_channel.note_suffix")))
    }

    /// Run `jobs` (event, payload) as processes started together; the answers come back in job order.
    fn par(&self, jobs: &[(&str, Value)]) -> Vec<(i32, String, String)> {
        let gate = std::sync::Barrier::new(jobs.len());
        std::thread::scope(|s| {
            let hs: Vec<_> = jobs
                .iter()
                .map(|(e, p)| {
                    let gate = &gate;
                    s.spawn(move || {
                        gate.wait();
                        self.run(e, p)
                    })
                })
                .collect();
            hs.into_iter().map(|h| h.join().unwrap()).collect()
        })
    }

    /// A held note, made the real way: a Stop while a background agent runs.
    fn hold_a_note(&self) {
        running_agent(self);
        assert_eq!(self.stop_out(false), "", "held");
        assert!(self.note_file().is_file(), "the note is on disk");
    }
}

fn soft_count(outs: &[(i32, String, String)]) -> usize {
    outs.iter().filter(|(_, o, _)| o.contains("additionalContext")).count()
}

/// P1 (stopchan.rs:87): a counter path that is a directory never saved, and every later read said 0: six Stops, six soft blocks.
#[test]
fn a_counter_that_cannot_be_saved_sends_no_soft_block_and_is_counted() {
    let r = Rig::new("dirchain");
    r.settings(Some(json!({"stopAdditionalContext": true})));
    r.transcript();
    std::fs::create_dir_all(r.chan_dir().join("sc1")).unwrap(); // the chain's file name is a directory
    for i in 0..6 {
        assert_eq!(r.stop_out(i > 0), "", "Stop {i}: unprovable state, the answer is what it was before the channel");
    }
    let c = r.counters();
    assert_eq!(c.iter().filter(|w| *w == "state_failed/state_not_a_file").count(), 6, "{c:?}");
    assert!(!c.iter().any(|w| w.starts_with("soft_block/")), "{c:?}");
}

#[test]
fn a_corrupt_or_empty_counter_file_fails_closed() {
    for (name, body) in [("empty", ""), ("garbage", "{\"n\":"), ("fields", "{\"x\":1}")] {
        let r = Rig::new(&format!("corrupt-{name}"));
        r.settings(Some(json!({"stopAdditionalContext": true})));
        r.transcript();
        std::fs::create_dir_all(r.chan_dir()).unwrap();
        std::fs::write(r.chan_dir().join("sc1"), body).unwrap();
        assert_eq!(r.stop_out(false), "", "{name}");
        assert!(r.counters().contains(&"state_failed/state_corrupt".to_string()), "{name}: {:?}", r.counters());
    }
}

/// P2 (stopchan.rs:116): a transcript cut below the saved offset reset the count: soft blocks without end.
#[test]
fn a_shrunk_transcript_does_not_restart_the_count() {
    let r = Rig::new("shrunk");
    r.settings(Some(json!({"stopAdditionalContext": true})));
    let t = r.transcript();
    assert_eq!(r.stop_out(false), soft());
    assert_eq!(r.stop_out(true), soft());
    assert_eq!(r.stop_out(true), "", "capped");
    std::fs::write(&t, "{\"type\":\"user\"}\n").unwrap(); // rewritten, shorter than at the last soft block
    assert_eq!(r.stop_out(true), "", "a rewritten transcript proves no tool call: still capped");
    assert!(r.counters().contains(&"state_failed/transcript_shrunk".to_string()), "{:?}", r.counters());
}

#[test]
fn an_unreadable_transcript_does_not_restart_the_count_and_sends_nothing() {
    let r = Rig::new("notranscript");
    r.settings(Some(json!({"stopAdditionalContext": true})));
    let t = r.transcript();
    assert_eq!(r.stop_out(false), soft());
    std::fs::remove_file(&t).unwrap();
    assert_eq!(r.stop_out(true), "", "the restart cannot be proven");
    assert!(r.counters().contains(&"state_failed/transcript_unreadable".to_string()), "{:?}", r.counters());
}

/// P2 (stopchan.rs:269): the count was read, then written after the emit; parallel Stops all read 0.
#[test]
fn parallel_stops_never_pass_the_cap() {
    for round in 0..ROUNDS {
        let r = Rig::new(&format!("par-cap-{round}"));
        r.settings(Some(json!({"stopAdditionalContext": true})));
        r.transcript();
        // the advisory layer would let only the first of the parallel Stops speak (its once-per-session stamp is written by whoever finishes
        // first); a directory in its state file's place leaves every Stop to the Stop channel's own count
        std::fs::create_dir_all(r.home().join(".anti-hall/advisory-state-sc1.json")).unwrap();
        let stop = r.stop(false);
        let outs = r.par(&vec![("Stop", stop); 6]);
        assert_eq!(soft_count(&outs), 2, "round {round}: cap 2 allows exactly 2 continuations: {outs:?}");
        let c = r.counters();
        assert_eq!(c.iter().filter(|w| w.starts_with("soft_block/")).count(), 2, "round {round}: {c:?}");
    }
}

/// P2 (stopchan.rs:342): the health advisory merged into a Stop answer ignored the cap.
#[test]
fn the_health_advisory_obeys_the_cap() {
    let r = Rig::new("health-cap");
    r.settings(Some(json!({"stopAdditionalContext": true})));
    std::fs::create_dir_all(r.chan_dir()).unwrap();
    std::fs::write(r.chan_dir().join("sc1h"), format!("{{\"n\":2,\"off\":{}}}", u64::MAX)).unwrap(); // the cap is spent
    std::fs::write(r.state().join(ah_engine::defaults::text("fail_open.notice_file")), HEALTH).unwrap();
    let (code, out, err) = r.run("Stop", &json!({"session_id": "sc1h", "cwd": r.dir.join("proj"), "hook_event_name": "Stop"}));
    assert_eq!(code, 0, "{out:?} {err:?}");
    assert_eq!(serde_json::from_str::<Value>(out.trim()).unwrap(), json!({"systemMessage": HEALTH}), "capped: the advisory stays on systemMessage");
    assert!(r.counters().contains(&"cap_hit/all".to_string()), "{:?}", r.counters());
}

#[test]
fn the_health_advisory_obeys_the_pending_work_guard() {
    let r = Rig::new("health-pending");
    r.settings(Some(json!({"stopAdditionalContext": true})));
    running_agent(&r);
    std::fs::create_dir_all(r.state()).unwrap();
    std::fs::write(r.state().join(ah_engine::defaults::text("fail_open.notice_file")), HEALTH).unwrap();
    let (code, out, err) = r.run("Stop", &json!({"session_id": "sc1", "cwd": r.dir.join("proj"), "hook_event_name": "Stop"}));
    assert_eq!(code, 0, "{out:?} {err:?}");
    assert_eq!(serde_json::from_str::<Value>(out.trim()).unwrap(), json!({"systemMessage": HEALTH}), "background work runs: no soft block");
}

/// The advisory spends the session's cap like a check's note does: with a cap of 1, a Stop whose only soft block is the health advisory
/// leaves the next Stop of the same session (a check's note) capped. Before the second fix lane the advisory never touched the count, so
/// the note got a second soft block.
#[test]
fn the_health_advisory_counts_against_the_cap_of_the_session() {
    let r = Rig::new("health-counts");
    r.settings(Some(json!({"stopAdditionalContext": true, "stopContinuationCap": 1})));
    r.transcript();
    std::fs::create_dir_all(r.state()).unwrap();
    std::fs::write(r.state().join(ah_engine::defaults::text("fail_open.notice_file")), HEALTH).unwrap();
    // Stop 1 of session sc1: no check has a note (not plan mode), so the soft block is the advisory's
    let (code, out, err) =
        r.run("Stop", &json!({"session_id": "sc1", "cwd": r.dir.join("proj"), "hook_event_name": "Stop", "transcript_path": r.dir.join("t.jsonl")}));
    assert_eq!(code, 0, "{out:?} {err:?}");
    assert_eq!(serde_json::from_str::<Value>(out.trim()).unwrap(), json!({"hookSpecificOutput": {"hookEventName": "Stop", "additionalContext": HEALTH}}));
    assert!(
        std::fs::read_to_string(r.chan_dir().join("sc1")).unwrap_or_default().replace(' ', "").contains("\"n\":1"),
        "the advisory's soft block is in the session's count"
    );
    // Stop 2 of the same session, now with a note: the cap of 1 is spent
    let (code, out, err) = r.run("Stop", &r.stop(true));
    assert_eq!(code, 0, "{out:?} {err:?}");
    assert_eq!(out, "", "the cap of the session is spent by the advisory: the note stays where it was");
    assert!(err.contains(PLAN_NOTE), "{err:?}");
    let c = r.counters();
    assert!(c.contains(&"soft_block/health-advisory".to_string()) && c.contains(&"cap_hit/all".to_string()), "{c:?}");
    assert!(!c.contains(&"soft_block/tasklist-guard".to_string()), "{c:?}");
}

/// P2 (stopchan.rs:245): a prompt consumed the held note with the switch off, and on the Codex host.
#[test]
fn a_prompt_with_the_switch_off_reads_and_consumes_nothing() {
    let r = Rig::new("prompt-off");
    r.settings(Some(json!({"stopAdditionalContext": true})));
    r.transcript();
    r.hold_a_note();
    let before = std::fs::read(r.note_file()).unwrap();
    r.settings(None);
    let (code, out, err) = r.run("UserPromptSubmit", &r.prompt());
    assert_eq!(code, 0, "{err:?}");
    assert!(!out.contains(PLAN_NOTE), "switch off: nothing delivered: {out:?}");
    assert_eq!(std::fs::read(r.note_file()).unwrap(), before, "switch off: the note is untouched");
    r.settings(Some(json!({"stopAdditionalContext": true})));
    let (_, out, _) = r.run("UserPromptSubmit", &r.prompt());
    assert!(out.contains(PLAN_NOTE), "switched on again: delivered: {out:?}");
}

#[test]
fn a_prompt_on_the_codex_host_reads_and_consumes_nothing() {
    let r = Rig::new("prompt-codex");
    r.settings(Some(json!({"stopAdditionalContext": true})));
    r.transcript();
    r.hold_a_note();
    std::fs::write(r.chan_dir().join("sc1"), format!("{{\"n\":2,\"off\":{}}}", u64::MAX)).unwrap();
    let (_, out, _) = r.run_host("codex", "UserPromptSubmit", &r.prompt(), &[]);
    assert!(!out.contains(PLAN_NOTE), "{out:?}");
    assert!(r.note_file().is_file(), "the note is untouched");
    assert!(r.chan_dir().join("sc1").is_file(), "the count is untouched");
}

/// P2 (stopchan.rs:329): two prompts could both read the note (twice delivered), or a replacement written between read and remove was deleted.
#[test]
fn a_held_note_is_delivered_exactly_once_to_parallel_prompts() {
    for round in 0..ROUNDS {
        let r = Rig::new(&format!("par-note-{round}"));
        r.settings(Some(json!({"stopAdditionalContext": true})));
        r.transcript();
        r.hold_a_note();
        let outs = r.par(&vec![("UserPromptSubmit", r.prompt()); 5]);
        let n = outs.iter().filter(|(_, o, _)| o.contains(PLAN_NOTE)).count();
        assert_eq!(n, 1, "round {round}: exactly one prompt gets the note: {outs:?}");
        assert!(!r.note_file().exists(), "round {round}: consumed");
        let left: Vec<_> = std::fs::read_dir(r.chan_dir()).unwrap().flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect();
        assert!(
            !left.iter().any(
                |n| n.contains(ah_engine::defaults::text("stop_channel.claim_infix")) || n.ends_with(ah_engine::defaults::text("stop_channel.lock_suffix"))
            ),
            "round {round}: no claim or lock left: {left:?}"
        );
    }
}

/// Holds made while prompts run, exactly: parallel Stops that hold the same note hold it ONCE and one prompt delivers it, once (no
/// "one or two"); and when holds and prompts overlap, every note that was really held (counted `deferred_pending_work`) is delivered by
/// exactly one prompt, in full and once inside its answer, and nothing is left over.
#[test]
fn holds_and_prompts_in_parallel_lose_nothing_and_repeat_nothing() {
    for round in 0..ROUNDS {
        let r = Rig::new(&format!("par-mix-{round}"));
        r.settings(Some(json!({"stopAdditionalContext": true, "stopContinuationCap": 50, "stopContinuationCeiling": 50})));
        r.transcript();
        running_agent(&r);
        std::fs::create_dir_all(r.home().join(".anti-hall/advisory-state-sc1.json")).unwrap(); // every Stop speaks: the Stop channel's own state is under test
        let (stop, prompt) = (r.stop(false), r.prompt());
        // phase 1: three Stops at once hold the same note: one hold, two repeats, and exactly one delivery
        let outs = r.par(&vec![("Stop", stop.clone()); 3]);
        assert!(outs.iter().all(|o| !o.1.contains("additionalContext")), "round {round}: held, not sent: {outs:?}");
        let c = r.counters();
        assert_eq!(c.iter().filter(|w| *w == "deferred_pending_work/tasklist-guard").count(), 1, "round {round}: {c:?}");
        assert_eq!(c.iter().filter(|w| *w == "deferred_duplicate/tasklist-guard").count(), 2, "round {round}: {c:?}");
        let outs = r.par(&vec![("UserPromptSubmit", prompt.clone()); 3]);
        let got: Vec<usize> = outs.iter().map(|o| o.1.matches(PLAN_NOTE).count()).collect();
        assert_eq!(got.iter().sum::<usize>(), 1, "round {round}: exactly one delivery, in one answer: {got:?} {outs:?}");
        assert!(!r.note_file().exists(), "round {round}: consumed");
        // phase 2: holds and prompts overlap: every real hold is delivered by exactly one prompt
        let jobs: Vec<(&str, Value)> = vec![("Stop", stop.clone()), ("UserPromptSubmit", prompt.clone()), ("Stop", stop), ("UserPromptSubmit", prompt.clone())];
        let outs = r.par(&jobs);
        let (_, last, _) = r.run("UserPromptSubmit", &prompt);
        let answers: Vec<&String> = outs.iter().map(|o| &o.1).chain(std::iter::once(&last)).collect();
        assert!(answers.iter().all(|o| o.matches(PLAN_NOTE).count() <= 1), "round {round}: a note is in one answer once: {answers:?}");
        let delivered = answers.iter().filter(|o| o.contains(PLAN_NOTE)).count();
        let c = r.counters();
        let holds = c.iter().filter(|w| *w == "deferred_pending_work/tasklist-guard").count() - 1; // phase 1 held one
        assert_eq!(delivered, holds, "round {round}: every hold delivered exactly once: {c:?} {outs:?}");
        assert_eq!(c.iter().filter(|w| *w == "deferred_delivered/all").count(), delivered + 1, "round {round}: {c:?}");
        let left: Vec<_> =
            std::fs::read_dir(r.chan_dir()).unwrap().flatten().map(|e| e.file_name().to_string_lossy().to_string()).filter(|n| n != "sc1").collect();
        assert!(left.iter().all(|n| n.ends_with(".lock")), "round {round}: no note and no claim left: {left:?}");
    }
}

/// Control: a Stop that blocks keeps its block; the health advisory next to it is only text on a turn that already continues.
#[test]
fn a_blocker_beside_the_health_advisory_still_blocks() {
    let r = Rig::new("blocker");
    r.settings(Some(json!({"stopAdditionalContext": true})));
    std::fs::create_dir_all(r.state()).unwrap();
    std::fs::write(r.state().join(ah_engine::defaults::text("fail_open.notice_file")), HEALTH).unwrap();
    let create = json!({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "tool_use", "id": "c1", "name": "TaskCreate", "input": {"subject": "one"}}]}});
    let result = json!({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "c1", "content": "Task #1 created successfully: one"}]}});
    std::fs::write(r.dir.join("t.jsonl"), format!("{create}\n{result}\n")).unwrap();
    let payload = json!({"session_id": "sb1", "cwd": r.home(), "hook_event_name": "Stop", "transcript_path": r.dir.join("t.jsonl")});
    let (code, out, err) = r.run_with("Stop", &payload, &[("ANTIHALL_DISPATCH_DEMAND", "0"), ("ANTIHALL_MAX_PARALLEL_DISPATCH", "4")]);
    let blocked = code == 2 || out.contains("\"decision\":\"block\"");
    assert!(blocked, "the open task still blocks the Stop: {code} {out:?} {err:?}");
}

// ---- the second review of PR #561 (second fix lane): three properties ----
//
// 1. a held note goes out ONCE, IN FULL, or goes out NOW on its old channel; never cut, never lost;
// 2. a HARD CEILING of soft blocks per user prompt that tool calls cannot reset;
// 3. anything unknown gives today's answer and a `state_failed` count.

fn tracker_file(r: &Rig) -> PathBuf {
    let paths = ah_engine::defaults::raw("agent_tracker.paths");
    r.home().join(paths.str_field("base")).join(paths.str_field("dir")).join(paths.str_field("state"))
}

fn tool_call(r: &Rig, id: usize) {
    let line = json!({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "tool_use", "id": format!("tu{id}"), "name": "Bash", "input": {"command": "ls"}}]}});
    std::fs::OpenOptions::new().append(true).open(r.dir.join("t.jsonl")).unwrap().write_all(format!("{line}\n").as_bytes()).unwrap();
}

/// P1 (stopstate.rs `Guard::hold`, `joined.chars().take(max)`): a held note was cut at the limit, so the NEWEST text was lost and nothing was
/// counted. Now a note that does not fit the hold is not held: it goes out now on its old channel (stderr for this check), it is counted
/// `state_failed` (`note_too_large`), and nothing is half-kept.
#[test]
fn a_note_that_does_not_fit_the_hold_goes_out_now_and_is_never_cut() {
    let r = Rig::new("toolarge");
    r.settings(Some(json!({"stopAdditionalContext": true})));
    r.transcript();
    running_agent(&r);
    std::fs::create_dir_all(r.state()).unwrap();
    std::fs::write(r.state().join("config.toml"), "[stop_channel]\nnote_max_chars = 200\n").unwrap(); // the prefix and the note take more than 200
    assert_eq!(r.stop_out(false), "", "no soft block while the agent runs");
    assert!(!r.note_file().exists(), "a note that does not fit is not kept, not even cut: {:?}", std::fs::read_to_string(r.note_file()));
    let c = r.counters();
    assert!(c.contains(&"state_failed/note_too_large".to_string()) && c.contains(&"system_message/tasklist-guard".to_string()), "{c:?}");
    assert!(!c.iter().any(|w| w.starts_with("deferred_") || w.starts_with("soft_block/")), "{c:?}");
    let (_, out, _) = r.run("UserPromptSubmit", &r.prompt());
    assert!(!out.contains("Held from"), "nothing was held, so nothing is delivered late: {out:?}");
}

/// The same advisory at every Stop of an unattended run is held once and delivered once, whatever the size limit says.
#[test]
fn the_same_note_at_every_stop_is_held_once_and_delivered_once_in_full() {
    let r = Rig::new("dedupe");
    r.settings(Some(json!({"stopAdditionalContext": true})));
    r.transcript();
    running_agent(&r);
    for i in 0..12 {
        assert_eq!(r.stop_out(i > 0), "");
    }
    let c = r.counters();
    assert_eq!(c.iter().filter(|w| *w == "deferred_pending_work/tasklist-guard").count(), 1, "{c:?}");
    assert_eq!(c.iter().filter(|w| *w == "deferred_duplicate/tasklist-guard").count(), 11, "{c:?}");
    assert!(!c.iter().any(|w| w.starts_with("state_failed/")), "the repeats did not fill the hold: {c:?}");
    let (_, out, _) = r.run("UserPromptSubmit", &r.prompt());
    let v: Value = serde_json::from_str(out.trim()).unwrap();
    let ctx = v["hookSpecificOutput"]["additionalContext"].as_str().unwrap();
    assert_eq!(ctx.matches(PLAN_NOTE).count(), 1, "once, in full: {ctx:?}");
}

/// P2 (stopchan.rs `next_chain`): any tool call restarted the chain, so a soft block, a tool call, a soft block... went on without end: 10
/// of 10 Stops got a soft block. The ceiling per prompt counts them whatever happens between; only a prompt restarts it.
#[test]
fn a_tool_call_between_soft_blocks_cannot_run_past_the_ceiling_per_prompt() {
    let r = Rig::new("ceiling");
    r.settings(Some(json!({"stopAdditionalContext": true, "stopContinuationCeiling": 3})));
    r.transcript();
    let mut softs = 0;
    for i in 0..10 {
        let out = r.stop_out(i > 0);
        if out.contains("additionalContext") {
            assert_eq!(out, soft(), "Stop {i}");
            softs += 1;
        }
        tool_call(&r, i); // the model made a tool call after every soft block: the consecutive count restarts each time
    }
    assert_eq!(softs, 3, "10 Stops with a tool call between each: the ceiling of 3 holds");
    let c = r.counters();
    assert_eq!(c.iter().filter(|w| *w == "cap_hit/ceiling").count(), 7, "counted as the ceiling, not as the cap: {c:?}");
    assert!(!c.contains(&"cap_hit/all".to_string()), "{c:?}");
    assert_eq!(c.iter().filter(|w| *w == "system_message/tasklist-guard").count(), 7, "{c:?}");
    // a prompt starts the next turn: the ceiling starts again
    r.run("UserPromptSubmit", &r.prompt());
    assert_eq!(r.stop_out(false), soft());
}

/// The shipped ceiling is 6: the same run without the setting.
#[test]
fn the_shipped_ceiling_is_six_per_prompt() {
    let r = Rig::new("ceiling-default");
    r.settings(Some(json!({"stopAdditionalContext": true})));
    r.transcript();
    let mut softs = 0;
    for i in 0..10 {
        softs += usize::from(r.stop_out(i > 0).contains("additionalContext"));
        tool_call(&r, i);
    }
    assert_eq!(softs, 6);
    assert_eq!(ah_engine::defaults::raw("stop_channel.num_ceiling").to_json()["default"], 6, "the shipped default");
}

/// A ceiling of 0 never soft-blocks, and the health advisory is under the same ceiling.
#[test]
fn a_ceiling_of_zero_never_soft_blocks_and_the_advisory_obeys_it() {
    let r = Rig::new("ceiling0");
    r.settings(Some(json!({"stopAdditionalContext": true, "stopContinuationCeiling": 0})));
    r.transcript();
    assert_eq!(r.stop_out(false), "");
    std::fs::create_dir_all(r.state()).unwrap();
    std::fs::write(r.state().join(ah_engine::defaults::text("fail_open.notice_file")), HEALTH).unwrap();
    let (_, out, _) = r.run("Stop", &json!({"session_id": "sc9", "cwd": r.dir.join("proj"), "hook_event_name": "Stop"}));
    assert_eq!(serde_json::from_str::<Value>(out.trim()).unwrap(), json!({"systemMessage": HEALTH}));
    assert!(r.counters().contains(&"cap_hit/ceiling".to_string()), "{:?}", r.counters());
}

/// P3 (stopchan.rs `pending_work`): a corrupt tracker state read as "no pending work", so a note was sent as a soft block while an agent might
/// run. Now the tracker is unknown: nothing is held, nothing is sent as additionalContext, and it is counted `state_failed` (`tracker`).
#[test]
fn an_unreadable_tracker_is_unknown_work_and_sends_nothing() {
    for (name, body) in [("garbage", "{ not json"), ("empty", ""), ("wrongshape", "[1,2]")] {
        let r = Rig::new(&format!("tracker-{name}"));
        r.settings(Some(json!({"stopAdditionalContext": true})));
        r.transcript();
        std::fs::create_dir_all(tracker_file(&r).parent().unwrap()).unwrap();
        std::fs::write(tracker_file(&r), body).unwrap();
        assert_eq!(r.stop_out(false), "", "{name}: no soft block on an unknown tracker");
        assert!(!r.note_file().exists(), "{name}: nothing is held either");
        let c = r.counters();
        assert!(c.contains(&"state_failed/tracker_unreadable".to_string()) && c.contains(&"system_message/tasklist-guard".to_string()), "{name}: {c:?}");
        assert!(!c.iter().any(|w| w.starts_with("soft_block/")), "{name}: {c:?}");
        assert!(!r.chan_dir().join("sc1").exists(), "{name}: no soft block was reserved");
        // the control: the same tracker with the pending guard switched off is not read, and the soft block goes out
        r.settings(Some(json!({"stopAdditionalContext": true, "stopDeferPending": false})));
        assert_eq!(r.stop_out(false), soft(), "{name}: control");
    }
}

/// An absent tracker file is a tracker that tracked nothing (a session that never ran an agent): the soft block goes out.
#[test]
fn an_absent_tracker_is_no_pending_work() {
    let r = Rig::new("tracker-absent");
    r.settings(Some(json!({"stopAdditionalContext": true})));
    r.transcript();
    assert!(!tracker_file(&r).exists());
    assert_eq!(r.stop_out(false), soft());
}

// ---- one randomized test for all three properties ----

/// A small reproducible generator (xorshift64*): the seeds below are fixed, so a failure names a seed and replays.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

#[derive(Clone, Copy, Debug)]
enum Op {
    Stop,
    Tool,
    Prompt,
    AgentStart,
    AgentFinish,
    ParStops,
    ParMix,
    CorruptTracker,
    HealTracker,
    CorruptChain,
}

const SEEDS: [u64; 6] =
    [0x9E37_79B9_7F4A_7C15, 0xD1B5_4A32_D192_ED03, 0x1234_5678_9ABC_DEF1, 0xCAFE_F00D_DEAD_BEEF, 0x0F0F_0F0F_1357_9BDF, 0x8BAD_F00D_0000_0007];
const OPS: usize = 40;
const CAP: u64 = 2;
const CEILING: u64 = 3;

/// What the engine knows about one session, as the test models it, and what it has seen so far.
#[derive(Default)]
struct Model {
    n: u64,
    t: u64,
    held: bool,
    agent: bool,
    tracker_bad: bool,
    chain_bad: bool,
    tools: usize,
    /// answers that carried the held note (the deliveries), the holds counted new, and the counters read so far
    delivered: usize,
    seen: usize,
}

#[derive(Debug, PartialEq, Clone, Copy)]
enum Want {
    Soft,
    Held,
    Ceiling,
    Cap,
    FailTracker,
    FailChain,
}

impl Model {
    /// What a Stop must do in this state, in the order the engine decides: the tracker first (unknown work), then the count.
    fn want(&self) -> Want {
        if self.tracker_bad {
            Want::FailTracker
        } else if self.chain_bad {
            Want::FailChain
        } else if self.t >= CEILING {
            Want::Ceiling
        } else if self.n >= CAP {
            Want::Cap
        } else if self.agent {
            Want::Held
        } else {
            Want::Soft
        }
    }
}

fn chain_file(r: &Rig) -> Option<String> {
    std::fs::read_to_string(r.chan_dir().join("sc1")).ok()
}

fn has_ctx(out: &str) -> bool {
    out.contains("additionalContext")
}

/// Drives mixed sequences through the real `ah-engine hook` and asserts the three properties on every step.
#[test]
fn the_three_properties_hold_over_random_sequences_of_stops_tool_calls_prompts_and_agents() {
    let (mut softs_all, mut ceil_all, mut held_all, mut deliv_all, mut fail_all, mut cap_all, mut par_all) = (0, 0, 0, 0, 0, 0, 0);
    for seed in SEEDS {
        let mut rng = Rng(seed);
        let r = Rig::new(&format!("prop-{seed:x}"));
        r.settings(Some(json!({"stopAdditionalContext": true, "stopContinuationCap": CAP, "stopContinuationCeiling": CEILING})));
        r.transcript();
        // the advisory layer would let only the first Stop of a session speak; a directory in its state file's place leaves every Stop
        // to the Stop channel's own state
        std::fs::create_dir_all(r.home().join(".anti-hall/advisory-state-sc1.json")).unwrap();
        let mut m = Model::default();
        let mut trace: Vec<String> = Vec::new();
        for step in 0..OPS {
            let op = match rng.below(24) {
                0..=7 => Op::Stop,
                8..=12 => Op::Tool,
                13..=14 => Op::Prompt,
                15 => Op::AgentStart,
                16 => Op::AgentFinish,
                17 => Op::ParStops,
                18 => Op::ParMix,
                19 => Op::CorruptTracker,
                20 => Op::HealTracker,
                21 => Op::CorruptChain,
                _ => Op::Stop,
            };
            trace.push(format!("{op:?}"));
            let ctxt = format!("seed {seed:x} step {step} {op:?} (trace {trace:?})");
            let active = rng.below(2) == 0; // stop_hook_active is not the signal: it must not change any outcome
            let chain_before = chain_file(&r);
            let note_before = std::fs::read(r.note_file()).ok();
            // a running agent is `known` only while its transcript is recent
            if m.agent && !m.tracker_bad {
                running_agent(&r);
            }
            match op {
                Op::Tool => {
                    m.tools += 1;
                    tool_call(&r, m.tools);
                    m.n = 0; // restarts only the consecutive count
                }
                Op::AgentStart => {
                    running_agent(&r);
                    m.agent = true;
                    m.tracker_bad = false;
                }
                Op::AgentFinish => {
                    std::fs::remove_file(tracker_file(&r)).ok();
                    m.agent = false;
                    m.tracker_bad = false;
                }
                Op::CorruptTracker => {
                    std::fs::create_dir_all(tracker_file(&r).parent().unwrap()).unwrap();
                    std::fs::write(tracker_file(&r), "{ not a tracker").unwrap();
                    m.tracker_bad = true;
                }
                Op::HealTracker => {
                    if m.agent {
                        running_agent(&r);
                    } else {
                        std::fs::remove_file(tracker_file(&r)).ok();
                    }
                    m.tracker_bad = false;
                }
                Op::CorruptChain => {
                    std::fs::create_dir_all(r.chan_dir()).unwrap();
                    std::fs::write(r.chan_dir().join("sc1"), "{ not a chain").unwrap();
                    m.chain_bad = true;
                }
                Op::Stop => {
                    let want = m.want();
                    let (code, out, err) = r.run("Stop", &r.stop(active));
                    assert_eq!(code, 0, "{ctxt}: {out:?} {err:?}");
                    assert!(err.contains(PLAN_NOTE), "{ctxt}: the user's copy is kept: {err:?}");
                    let c = r.counters();
                    let new: Vec<&String> = c[m.seen..].iter().collect();
                    m.seen = c.len();
                    let has = |w: &str| new.iter().any(|x| x.as_str() == w);
                    match want {
                        Want::Soft => {
                            assert_eq!(out, soft(), "{ctxt}");
                            assert!(has("soft_block/tasklist-guard"), "{ctxt}: {new:?}");
                            m.n += 1;
                            m.t += 1;
                            softs_all += 1;
                        }
                        Want::Held => {
                            assert!(!has_ctx(&out), "{ctxt}: held, not sent: {out:?}");
                            assert!(has(if m.held { "deferred_duplicate/tasklist-guard" } else { "deferred_pending_work/tasklist-guard" }), "{ctxt}: {new:?}");
                            m.held = true;
                            held_all += 1;
                        }
                        Want::Ceiling | Want::Cap => {
                            assert!(!has_ctx(&out), "{ctxt}: {out:?}");
                            assert!(has(if want == Want::Ceiling { "cap_hit/ceiling" } else { "cap_hit/all" }), "{ctxt}: {new:?}");
                            assert_eq!(std::fs::read(r.note_file()).ok(), note_before, "{ctxt}: nothing consumed or held");
                            if want == Want::Ceiling { ceil_all += 1 } else { cap_all += 1 }
                        }
                        Want::FailTracker | Want::FailChain => {
                            assert!(!has_ctx(&out), "{ctxt}: unknown state sends no additionalContext: {out:?}");
                            let reason = if want == Want::FailTracker { "state_failed/tracker_unreadable" } else { "state_failed/state_corrupt" };
                            assert!(has(reason), "{ctxt}: {new:?}");
                            assert_eq!(std::fs::read(r.note_file()).ok(), note_before, "{ctxt}: nothing consumed or held");
                            assert_eq!(chain_file(&r), chain_before, "{ctxt}: no soft block was reserved");
                            fail_all += 1;
                        }
                    }
                }
                Op::Prompt => {
                    let (code, out, err) = r.run("UserPromptSubmit", &r.prompt());
                    assert_eq!(code, 0, "{ctxt}: {err:?}");
                    let got = out.matches(PLAN_NOTE).count();
                    if m.held {
                        assert_eq!(got, 1, "{ctxt}: the held note comes out once, in full: {out:?}");
                        assert!(out.contains(ah_engine::defaults::text("stop_channel.msg_held_prefix")), "{ctxt}: {out:?}");
                        m.delivered += 1;
                        deliv_all += 1;
                    } else {
                        assert_eq!(got, 0, "{ctxt}: nothing was held: {out:?}");
                    }
                    m.held = false;
                    m.n = 0;
                    m.t = 0;
                    m.chain_bad = false;
                    assert!(chain_file(&r).is_none(), "{ctxt}: a prompt starts a new chain");
                }
                Op::ParStops => {
                    let stop = r.stop(active);
                    let outs = r.par(&vec![("Stop", stop); 3]);
                    let soft_n = outs.iter().filter(|o| has_ctx(&o.1)).count() as u64;
                    let want = m.want();
                    let allowed = if want == Want::Soft { CAP.saturating_sub(m.n).min(CEILING.saturating_sub(m.t)) } else { 0 };
                    assert_eq!(soft_n, allowed.min(3), "{ctxt}: parallel Stops never pass the cap or the ceiling: {outs:?}");
                    assert!(outs.iter().all(|o| o.1.matches(PLAN_NOTE).count() <= 1), "{ctxt}");
                    if matches!(want, Want::FailTracker | Want::FailChain) {
                        assert_eq!(chain_file(&r), chain_before, "{ctxt}: unknown state reserved nothing");
                        assert_eq!(std::fs::read(r.note_file()).ok(), note_before, "{ctxt}");
                        fail_all += 3;
                    }
                    m.n += soft_n;
                    m.t += soft_n;
                    softs_all += soft_n as usize;
                    m.seen = r.counters().len();
                    par_all += 1;
                }
                Op::ParMix => {
                    let (stop, prompt) = (r.stop(active), r.prompt());
                    let jobs: Vec<(&str, Value)> = vec![("Stop", stop.clone()), ("UserPromptSubmit", prompt), ("Stop", stop)];
                    let outs = r.par(&jobs);
                    assert!(outs.iter().all(|o| o.1.matches(PLAN_NOTE).count() <= 1), "{ctxt}: {outs:?}");
                    if m.tracker_bad {
                        assert!(!has_ctx(&outs[0].1) && !has_ctx(&outs[2].1), "{ctxt}: unknown tracker: no additionalContext on a Stop: {outs:?}");
                    }
                    deliv_all += outs.iter().filter(|o| o.1.contains(ah_engine::defaults::text("stop_channel.msg_held_prefix"))).count();
                    m.delivered += outs.iter().filter(|o| o.1.contains(ah_engine::defaults::text("stop_channel.msg_held_prefix"))).count();
                    // the order of a race is not known: the state is read back from disk, and the invariants below judge it
                    m.chain_bad = false;
                    let c = chain_file(&r).and_then(|t| serde_json::from_str::<Value>(&t).ok());
                    m.n = c.as_ref().and_then(|v| v["n"].as_u64()).unwrap_or(0);
                    m.t = c.as_ref().and_then(|v| v["t"].as_u64()).unwrap_or(0);
                    m.held = r.note_file().exists();
                    m.seen = r.counters().len();
                    par_all += 1;
                }
            }
            if matches!(op, Op::ParStops) {
                // resync the held flag with the disk (a parallel hold is real only if the file is there)
                m.held = r.note_file().exists();
                if let Some(v) = chain_file(&r).and_then(|t| serde_json::from_str::<Value>(&t).ok()) {
                    assert_eq!((v["n"].as_u64(), v["t"].as_u64()), (Some(m.n), Some(m.t)), "{ctxt}: the saved count is the model's");
                }
            }
            // ---- the invariants of every step ----
            // P2: the saved count never passes the cap or the ceiling
            if let Some(v) = chain_file(&r).and_then(|t| serde_json::from_str::<Value>(&t).ok()) {
                let (n, t) = (v["n"].as_u64().unwrap(), v["t"].as_u64().unwrap());
                assert!(n <= CAP && t <= CEILING && n <= t, "{ctxt}: n {n} t {t}");
            }
            // P1: every note that was held is delivered once or is still held: holds = deliveries + held now; nothing else is on disk
            let c = r.counters();
            let holds = c.iter().filter(|w| *w == "deferred_pending_work/tasklist-guard").count();
            let held_now = usize::from(r.note_file().exists());
            assert_eq!(holds, m.delivered + held_now, "{ctxt}: each held note is delivered exactly once or still held: {c:?}");
            let stray: Vec<_> = std::fs::read_dir(r.chan_dir())
                .map(|rd| {
                    rd.flatten()
                        .map(|e| e.file_name().to_string_lossy().to_string())
                        .filter(|n| n.contains(ah_engine::defaults::text("stop_channel.claim_infix")))
                        .collect()
                })
                .unwrap_or_default();
            assert!(stray.is_empty(), "{ctxt}: a claim was left: {stray:?}");
        }
        // end of the run: one last prompt leaves nothing held
        let (_, out, _) = r.run("UserPromptSubmit", &r.prompt());
        let got = out.matches(PLAN_NOTE).count();
        assert_eq!(got, usize::from(m.held), "seed {seed:x}: the last prompt delivers a still-held note once, in full");
        assert!(!r.note_file().exists(), "seed {seed:x}");
        let c = r.counters();
        let holds = c.iter().filter(|w| *w == "deferred_pending_work/tasklist-guard").count();
        assert_eq!(holds, m.delivered + got, "seed {seed:x}: held {holds}, delivered {} + {got}", m.delivered);
        assert_eq!(c.iter().filter(|w| *w == "deferred_delivered/all").count(), m.delivered + got, "seed {seed:x}");
    }
    // the run exercised every branch, so the properties above were not vacuous
    assert!(
        softs_all > 0 && ceil_all > 0 && held_all > 0 && deliv_all > 0 && fail_all > 0 && cap_all > 0 && par_all > 0,
        "coverage: soft {softs_all} ceiling {ceil_all} held {held_all} delivered {deliv_all} fail {fail_all} cap {cap_all} par {par_all}"
    );
}
