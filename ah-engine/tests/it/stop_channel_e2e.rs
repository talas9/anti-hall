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

#[test]
fn the_health_advisory_counts_against_the_cap_of_the_session() {
    let r = Rig::new("health-counts");
    r.settings(Some(json!({"stopAdditionalContext": true, "stopContinuationCap": 1})));
    std::fs::create_dir_all(r.state()).unwrap();
    let stop = |sid: &str| r.run("Stop", &json!({"session_id": sid, "cwd": r.dir.join("proj"), "hook_event_name": "Stop"})).1;
    std::fs::write(r.state().join(ah_engine::defaults::text("fail_open.notice_file")), HEALTH).unwrap();
    assert!(stop("sc1h").contains("additionalContext"), "the first continuation of the session");
    // the advisory is once per session, so a second session shows the chain is per session
    assert!(stop("sc2h").contains("additionalContext"), "another session has its own count");
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

/// Held notes made at the same time as prompts: nothing is lost and nothing is delivered twice (every hold is delivered by exactly one prompt).
#[test]
fn holds_and_prompts_in_parallel_lose_nothing_and_repeat_nothing() {
    for round in 0..ROUNDS {
        let r = Rig::new(&format!("par-mix-{round}"));
        r.settings(Some(json!({"stopAdditionalContext": true, "stopContinuationCap": 50})));
        r.transcript();
        running_agent(&r);
        r.forget_advisories();
        let stop = r.stop(false);
        let prompt = r.prompt();
        let jobs: Vec<(&str, Value)> = vec![("Stop", stop.clone()), ("UserPromptSubmit", prompt.clone()), ("Stop", stop), ("UserPromptSubmit", prompt.clone())];
        let outs = r.par(&jobs);
        let (_, last, _) = r.run("UserPromptSubmit", &prompt);
        let delivered = outs.iter().map(|o| &o.1).chain(std::iter::once(&last)).filter(|o| o.contains(PLAN_NOTE)).count();
        let held = std::fs::read_dir(r.chan_dir())
            .map(|rd| rd.flatten().filter(|e| e.file_name().to_string_lossy().ends_with(ah_engine::defaults::text("stop_channel.note_suffix"))).count())
            .unwrap_or(0);
        // two Stops each hold the same text: a note still held is delivered by the last prompt, so what was held is seen once or twice, never lost
        assert!((1..=2).contains(&delivered) && held == 0, "round {round}: delivered {delivered}, still held {held}: {outs:?}");
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
