//! GH #540 / plan v2 C1, end to end: the Stop channel through the real dispatcher (`ah-engine hook --event Stop`), fed Stop payloads
//! of the shape the host sends (`session_id`, `cwd`, `transcript_path`, `permission_mode`, `stop_hook_active`, `background_tasks`) and
//! transcripts of the shapes the host writes (recorded in the plan v2 pilot lab and in live sessions: a `Stop hook feedback:` user
//! entry for a hard block's continuation, a `hook_additional_context` attachment for a Stop `additionalContext` continuation, a
//! typed prompt with `origin.kind` human and `promptSource` typed, a notification turn with `origin.kind` task-notification).
//!
//! The Stop note is the tasklist-guard's plan-mode note: the recorded golden case `tasklist-guard` "plan mode" (a Stop in plan mode
//! answers exit 0 with that note on stderr and nothing on stdout). The channel keeps NO state: the bounds come from the payload and the
//! transcript, so each test only has to put the right payload and transcript in front of the dispatcher.
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

// ---- transcript lines, in the shapes the host writes ----

/// A prompt the human typed.
fn human() -> String {
    json!({"type": "user", "origin": {"kind": "human"}, "promptSource": "typed", "message": {"role": "user", "content": "plan the change"}}).to_string()
}

/// A prompt with `promptSource` typed and no `origin` (an older host).
fn typed_only() -> String {
    json!({"type": "user", "promptSource": "typed", "message": {"role": "user", "content": "plan the change"}}).to_string()
}

/// A background task's notification turn: a user line the human did not type.
fn notification() -> String {
    json!({"type": "user", "origin": {"kind": "task-notification"}, "promptSource": "system", "turnOrigin": "task_notification",
           "message": {"role": "user", "content": "<task-notification>agent done</task-notification>"}})
    .to_string()
}

/// A hard block's continuation, as recorded by the pilot lab.
fn feedback() -> String {
    json!({"type": "user", "isMeta": true, "message": {"role": "user", "content": "Stop hook feedback:\nsay it"}}).to_string()
}

/// A Stop `additionalContext` continuation, as recorded by the pilot lab.
fn attached() -> String {
    json!({"type": "attachment", "attachment": {"type": "hook_additional_context", "content": ["say it"], "hookName": "Stop", "hookEvent": "Stop"}}).to_string()
}

fn tool_call() -> String {
    json!({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "tool_use", "id": "tu1", "name": "Bash", "input": {"command": "ls"}}]}})
        .to_string()
}

fn tool_result() -> String {
    json!({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "tu1", "content": "ok"}]}}).to_string()
}

fn reply() -> String {
    json!({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "Here is the plan."}], "stop_reason": "end_turn"}})
        .to_string()
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

    fn t(&self) -> PathBuf {
        self.dir.join("t.jsonl")
    }

    fn settings(&self, channel: Option<Value>) {
        let s = channel.map_or_else(|| json!({}), |c| json!({ "context": c }));
        std::fs::write(self.home().join(".anti-hall/settings.json"), s.to_string()).unwrap();
    }

    fn on(&self) {
        self.settings(Some(json!({"stopAdditionalContext": true})));
    }

    /// The transcript: these lines, each ended by a newline.
    fn transcript(&self, lines: &[String]) {
        std::fs::write(self.t(), format!("{}\n", lines.join("\n"))).unwrap();
    }

    /// A transcript the way the host writes one after a typed prompt and a reply.
    fn fresh(&self) {
        self.transcript(&[human(), reply()]);
    }

    /// Append lines to the transcript, as the host does while the session goes on.
    fn append(&self, lines: &[String]) {
        let mut f = std::fs::OpenOptions::new().append(true).open(self.t()).unwrap();
        f.write_all(format!("{}\n", lines.join("\n")).as_bytes()).unwrap();
    }

    /// A Stop payload as the host sends it (plan mode: the recorded case), with the background-tasks array empty.
    fn stop(&self) -> Value {
        json!({"session_id": "sc1", "cwd": self.dir.join("proj"), "hook_event_name": "Stop", "permission_mode": "plan",
               "stop_hook_active": false, "background_tasks": [], "session_crons": [], "transcript_path": self.t()})
    }

    fn run(&self, event: &str, payload: &Value) -> (i32, String, String) {
        self.run_host("claude", event, payload, &[])
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
    /// `outcome/check` words.
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

    /// The advisory layer holds a fixed-text note back for N further calls of a session; a directory in its state file's place
    /// leaves every call to the Stop channel (the layer under test is the Stop channel's, not the advisory layer's).
    fn no_advisory_layer(&self) {
        std::fs::create_dir_all(self.home().join(".anti-hall/advisory-state-sc1.json")).unwrap();
    }

    fn stop_with(&self, payload: &Value) -> String {
        let (code, out, err) = self.run("Stop", payload);
        assert_eq!(code, 0, "{out:?} {err:?}");
        assert!(err.contains(PLAN_NOTE), "stderr keeps the note for the user: {err:?}");
        out
    }

    fn stop_out(&self) -> String {
        self.no_advisory_layer();
        self.stop_with(&self.stop())
    }

    /// The count of one word in the counters.
    fn counted(&self, word: &str) -> usize {
        self.counters().iter().filter(|w| *w == word).count()
    }
}

/// The expected soft-block answer: the dispatcher's JSON for the note on Stop `additionalContext`.
fn soft() -> String {
    format!("{}\n", json!({"hookSpecificOutput": {"hookEventName": "Stop", "additionalContext": PLAN_NOTE}}))
}

const EMITTED: &str = "emitted/tasklist-guard";

// ---- OFF, and the happy path ----

#[test]
fn switch_off_the_stop_answer_is_what_the_check_printed() {
    let r = Rig::new("off");
    r.settings(None);
    r.fresh();
    assert_eq!(r.stop_out(), "", "stdout is empty, the note is on stderr only (today's invisible channel)");
    assert!(r.counters().is_empty(), "off: nothing counted: {:?}", r.counters());
    // the same with the other switch value spelled out, and with a payload that would pass every gate and one that would fail them all
    r.settings(Some(json!({"stopAdditionalContext": false})));
    assert_eq!(r.stop_out(), "");
    let mut bare = r.stop();
    bare.as_object_mut().unwrap().remove("background_tasks");
    assert_eq!(r.stop_with(&bare), "");
    assert!(r.counters().is_empty(), "off: no counter for any payload: {:?}", r.counters());
    assert!(!r.state().join("stop-channel").exists(), "and no state of any kind");
}

#[test]
fn switch_on_the_note_is_stop_additional_context() {
    let r = Rig::new("on");
    r.on();
    r.fresh();
    let out = r.stop_out();
    assert_eq!(out, soft());
    let v: Value = serde_json::from_str(&out).unwrap();
    assert!(v.get("systemMessage").is_none() && v["hookSpecificOutput"]["additionalContext"] == PLAN_NOTE);
    assert_eq!(r.counters(), vec![EMITTED.to_string()]);
    assert!(!r.state().join("stop-channel").exists(), "no state file is created");
}

#[test]
fn codex_stays_on_its_current_channel() {
    // the Codex Stop hook's additionalContext behaviour is unconfirmed (#559): stop_channel.hosts lists claude only
    let r = Rig::new("codex");
    r.on();
    r.fresh();
    r.no_advisory_layer();
    let (code, out, err) = r.run_host("codex", "Stop", &r.stop(), &[]);
    assert_eq!(code, 0, "{out:?} {err:?}");
    assert!(!out.contains("additionalContext"), "{out:?}");
    assert!(r.counters().is_empty(), "{:?}", r.counters());
}

// ---- the pending-work guard: the payload's own field ----

#[test]
fn without_the_background_tasks_array_the_note_stays_where_it_was() {
    let r = Rig::new("nofield");
    r.on();
    r.fresh();
    assert_eq!(r.stop_out(), soft(), "the same payload with the field emits (the test below removes only the field)");
    for (name, mutate) in [("absent", None), ("null", Some(Value::Null)), ("object", Some(json!({}))), ("string", Some(json!("none")))] {
        let mut p = r.stop();
        let o = p.as_object_mut().unwrap();
        match mutate {
            None => {
                o.remove("background_tasks");
            }
            Some(v) => {
                o.insert("background_tasks".into(), v);
            }
        }
        assert_eq!(r.stop_with(&p), "", "{name}: unknown work is not no work");
    }
    assert_eq!(r.counted("no_background_field/tasklist-guard"), 4, "{:?}", r.counters());
}

#[test]
fn running_background_tasks_keep_the_note_where_it_was() {
    let r = Rig::new("pending");
    r.on();
    r.fresh();
    assert_eq!(r.stop_out(), soft());
    let mut p = r.stop();
    p["background_tasks"] = json!([{"id": "bg1", "type": "shell", "status": "running"}]);
    assert_eq!(r.stop_with(&p), "", "a continuation would only make the turn poll");
    assert_eq!(r.counted("background_pending/tasklist-guard"), 1, "{:?}", r.counters());
}

// ---- the stateless chain bound ----

#[test]
fn the_chain_bound_is_k_continuations_counted_in_the_transcript() {
    let r = Rig::new("k");
    r.on();
    r.transcript(&[human(), reply()]);
    assert_eq!(r.stop_out(), soft(), "0 continuations so far");
    r.transcript(&[human(), reply(), attached()]);
    assert_eq!(r.stop_out(), soft(), "1");
    r.transcript(&[human(), reply(), attached(), reply(), feedback()]);
    assert_eq!(r.stop_out(), soft(), "2: a block's feedback entry counts like a Stop additionalContext attachment");
    r.transcript(&[human(), reply(), attached(), reply(), feedback(), reply(), attached()]);
    assert_eq!(r.stop_out(), "", "3 = K: the note stays on its old channel");
    assert_eq!(r.stop_out(), "", "and stays there while the transcript does not change");
    assert_eq!(r.counted(EMITTED), 3, "{:?}", r.counters());
    assert_eq!(r.counted("over_k/tasklist-guard"), 2, "{:?}", r.counters());
    // the limit is a setting
    r.settings(Some(json!({"stopAdditionalContext": true, "stopContinuationLimit": 4})));
    assert_eq!(r.stop_out(), soft(), "limit 4: three continuations leave room for one more");
    r.settings(Some(json!({"stopAdditionalContext": true, "stopContinuationLimit": 0})));
    r.fresh();
    assert_eq!(r.stop_out(), "", "limit 0: never");
}

/// The whole chain the way the host lives it: each continuation the channel causes is recorded in the transcript, so the next Stop
/// sees it, whatever `stop_hook_active` says.
#[test]
fn a_chain_of_stops_ends_after_k_continuations_whatever_stop_hook_active_says() {
    let r = Rig::new("chain");
    r.on();
    r.fresh();
    let mut emitted = 0;
    for i in 0..8 {
        let mut p = r.stop();
        p["stop_hook_active"] = json!(i % 2 == 1); // the flag is not relied on: true, false, true, ...
        r.no_advisory_layer();
        let out = r.stop_with(&p);
        if out.is_empty() {
            break;
        }
        assert_eq!(out, soft());
        emitted += 1;
        r.append(&[attached(), reply()]); // what the host records for the continuation
    }
    assert_eq!(emitted, 3, "K = 3 continuations, then the note stays on its old channel");
}

#[test]
fn a_tool_call_between_continuations_does_not_reset_the_count() {
    let r = Rig::new("tools");
    r.on();
    // after each continuation the model calls a tool, then stops again with stop_hook_active false
    let t = [human(), reply(), attached(), tool_call(), tool_result(), reply(), feedback(), tool_call(), tool_result(), reply()];
    r.transcript(&t);
    assert_eq!(r.stop_out(), soft(), "2 continuations");
    r.transcript(&[t.as_slice(), &[attached(), tool_call(), tool_result(), reply()]].concat());
    assert_eq!(r.stop_out(), "", "3 continuations, and a tool call after each: still K (the host's own cap would have reset)");
    assert_eq!(r.counted("over_k/tasklist-guard"), 1);
}

#[test]
fn a_human_typed_prompt_restarts_the_count() {
    let r = Rig::new("human");
    r.on();
    r.transcript(&[human(), reply(), attached(), attached(), attached(), reply()]);
    assert_eq!(r.stop_out(), "", "three continuations since the prompt");
    r.append(&[human(), reply()]);
    assert_eq!(r.stop_out(), soft(), "a typed prompt: the count starts again");
    r.transcript(&[attached(), attached(), attached(), typed_only(), reply(), attached()]);
    assert_eq!(r.stop_out(), soft(), "promptSource typed alone is a human prompt too (1 continuation after it)");
}

#[test]
fn a_notification_turn_is_not_a_human_prompt() {
    let r = Rig::new("notif");
    r.on();
    // an unattended run: notification turns only, no typed prompt anywhere; the count runs from the start of the transcript
    r.transcript(&[notification(), reply(), attached(), notification(), reply(), feedback(), notification(), reply()]);
    assert_eq!(r.stop_out(), soft(), "2 continuations");
    r.append(&[attached(), notification(), reply()]);
    assert_eq!(r.stop_out(), "", "3: an AFK chain of notification turns cannot go past K either");
    // and a notification after a human prompt does not restart the count
    r.transcript(&[human(), reply(), attached(), attached(), notification(), reply(), attached(), notification(), reply()]);
    assert_eq!(r.stop_out(), "");
    assert_eq!(r.counted("over_k/tasklist-guard"), 2, "{:?}", r.counters());
}

#[test]
fn a_big_transcript_is_read_in_a_growing_window_up_to_the_last_human_prompt() {
    let r = Rig::new("big");
    r.on();
    let filler = json!({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "x".repeat(4000)}]}}).to_string();
    // 3 MB of filler after the typed prompt (past the first window), two continuations in it
    let mut t = vec![human(), attached()];
    t.extend(std::iter::repeat_n(filler.clone(), 400));
    t.push(feedback());
    t.extend(std::iter::repeat_n(filler, 400));
    r.transcript(&t);
    assert!(std::fs::metadata(r.t()).unwrap().len() > 3_000_000);
    assert_eq!(r.stop_out(), soft(), "the human prompt is found beyond the first window: 2 continuations");
    r.append(&[attached()]);
    assert_eq!(r.stop_out(), "", "and 3 are counted");
}

// ---- transcripts that prove nothing ----

#[test]
fn a_transcript_that_cannot_be_read_or_understood_keeps_the_note_where_it_was() {
    let r = Rig::new("unreadable");
    r.on();
    r.fresh();
    assert_eq!(r.stop_out(), soft(), "the control: a readable transcript emits");
    let bad: Vec<(&str, Vec<u8>)> = vec![
        ("empty", vec![]),
        ("not json", b"hello\n".to_vec()),
        ("no type", b"{\"a\":1}\n".to_vec()),
        ("not an object", b"[1,2]\n".to_vec()),
        ("non utf-8", [b"{\"type\":\"user\"}\n".as_slice(), &[0xff, 0xfe, 0xfd, b'\n']].concat()),
        ("bad line after the prompt", [human().as_bytes(), b"\n{\"type\":\"user\"\n", feedback().as_bytes(), b"\n"].concat()),
    ];
    for (name, body) in &bad {
        std::fs::write(r.t(), body).unwrap();
        assert_eq!(r.stop_out(), "", "{name}");
    }
    // a missing file, a directory, a relative path, no path
    std::fs::remove_file(r.t()).unwrap();
    assert_eq!(r.stop_out(), "", "missing");
    std::fs::create_dir_all(r.t()).unwrap();
    assert_eq!(r.stop_out(), "", "a directory");
    for p in [json!("t.jsonl"), Value::Null] {
        let mut s = r.stop();
        s["transcript_path"] = p.clone();
        assert_eq!(r.stop_with(&s), "", "{p}");
    }
    assert_eq!(r.counted("transcript_unreadable/tasklist-guard"), bad.len() + 4, "{:?}", r.counters());
}

#[test]
fn a_last_prompt_beyond_the_read_limit_is_unknown() {
    let r = Rig::new("huge");
    r.on();
    // a typed prompt, then more than stop_channel.tail_max_bytes of notification turns: the chain since the prompt is unknown
    let max = ah_engine::defaults::num("stop_channel.tail_max_bytes") as usize;
    let line =
        json!({"type": "user", "origin": {"kind": "task-notification"}, "promptSource": "system", "message": {"role": "user", "content": "n".repeat(60_000)}})
            .to_string();
    let mut f = std::io::BufWriter::new(std::fs::File::create(r.t()).unwrap());
    writeln!(f, "{}", human()).unwrap();
    for _ in 0..(max / line.len() + 3) {
        writeln!(f, "{line}").unwrap();
    }
    f.flush().unwrap();
    drop(f);
    assert_eq!(r.stop_out(), "");
    assert_eq!(r.counted("transcript_unreadable/tasklist-guard"), 1, "{:?}", r.counters());
}

// ---- a blocker beside advisories ----

/// A Stop that a check blocks (an open task nobody works on). The blocking path must be byte-identical with the channel on. (The
/// block with a note BESIDE it is the unit test `a_note_beside_a_hard_block_stays_and_the_block_is_untouched` in stopchan.rs: no recorded
/// Stop prints both.)
#[test]
fn a_blocker_beside_the_note_still_blocks_and_the_note_stays_put() {
    // two rigs with identical fixtures (the idle-tasks check keeps its own state, so the same rig cannot answer twice alike)
    let run = |name: &str, on: bool| {
        let r = Rig::new(name);
        if on {
            r.on();
        } else {
            r.settings(None);
        }
        let create = json!({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "tool_use", "id": "c1", "name": "TaskCreate", "input": {"subject": "one"}}]}}).to_string();
        let result = json!({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "c1", "content": "Task #1 created successfully: one"}]}}).to_string();
        r.transcript(&[human(), create, result, reply()]);
        r.no_advisory_layer();
        let out = r.run("Stop", &r.stop());
        (out, r.counters())
    };
    let (off, _) = run("blocker-off", false);
    assert!(
        off.0 == 2 || off.1.contains("\"decision\":\"block\""),
        "the control: a blocker (idle-tasks check, open task) blocks with the channel off: {off:?}"
    );
    let (on, counters) = run("blocker-on", true);
    assert_eq!(on, off, "the channel on: the block is untouched, byte for byte (stdout, stderr and exit code)");
    assert!(counters.iter().all(|w| !w.starts_with("emitted/")), "{counters:?}");
}

// ---- no state, no race ----

fn tree(dir: &std::path::Path) -> Vec<(String, u64)> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for e in std::fs::read_dir(&d).into_iter().flatten().flatten() {
            let m = e.metadata().unwrap();
            if m.is_dir() {
                stack.push(e.path());
            } else {
                out.push((e.path().to_string_lossy().to_string(), m.len()));
            }
        }
    }
    out.sort();
    out
}

#[test]
fn concurrent_stops_have_no_state_to_race_on() {
    for round in 0..5 {
        let r = Rig::new(&format!("par-{round}"));
        r.on();
        // two continuations in the transcript: the next one is the last allowed; the Stops all read the same facts
        r.transcript(&[human(), reply(), attached(), reply(), attached(), reply()]);
        r.no_advisory_layer();
        let p = r.stop();
        let before = tree(&r.home());
        let gate = std::sync::Barrier::new(6);
        let outs: Vec<(i32, String, String)> = std::thread::scope(|s| {
            let hs: Vec<_> = (0..6)
                .map(|_| {
                    let (gate, r, p) = (&gate, &r, &p);
                    s.spawn(move || {
                        gate.wait();
                        r.run("Stop", p)
                    })
                })
                .collect();
            hs.into_iter().map(|h| h.join().unwrap()).collect()
        });
        assert!(outs.iter().all(|o| o.0 == 0 && o.1 == soft()), "round {round}: every Stop decides the same from the same facts: {outs:?}");
        // the other checks keep their own files (advisor retry, claim ledger); the Stop channel adds none: the files created are the
        // ones a single Stop creates
        let created = |r: &Rig, before: &[(String, u64)]| -> Vec<String> {
            let known: Vec<&String> = before.iter().map(|(n, _)| n).collect();
            let home = r.home().to_string_lossy().to_string();
            tree(&r.home()).into_iter().filter(|(n, _)| !known.contains(&n)).map(|(n, _)| n.replace(&home, "")).collect()
        };
        let many = created(&r, &before);
        let one = Rig::new(&format!("par-one-{round}"));
        one.on();
        one.transcript(&[human(), reply(), attached(), reply(), attached(), reply()]);
        one.no_advisory_layer();
        let base = tree(&one.home());
        assert_eq!(one.stop_with(&one.stop()), soft());
        assert_eq!(many, created(&one, &base), "round {round}: six Stops create what one Stop creates");
        assert!(many.iter().all(|n| !n.contains("stop-channel")), "round {round}: {many:?}");
        assert!(!r.state().join("stop-channel").exists(), "round {round}: no Stop-channel state exists");
        assert_eq!(r.counted(EMITTED), 6, "{:?}", r.counters());
    }
}

// ---- the health advisory ----

fn health_stop(r: &Rig, payload: &Value, notice: &str) -> Value {
    std::fs::create_dir_all(r.state()).unwrap();
    std::fs::write(r.state().join(ah_engine::defaults::text("fail_open.notice_file")), notice).unwrap();
    let (code, out, err) = r.run("Stop", payload);
    assert_eq!(code, 0, "{out:?} {err:?}");
    serde_json::from_str::<Value>(out.trim()).unwrap_or_else(|_| panic!("{out:?} {err:?}"))
}

fn plain_stop(r: &Rig, session: &str) -> Value {
    let mut p = r.stop();
    p["session_id"] = json!(session);
    p["permission_mode"] = json!("default");
    p
}

#[test]
fn the_health_advisory_merged_into_a_stop_answer_follows_the_switch_and_the_gates() {
    let off = Rig::new("health-off");
    off.settings(None);
    off.fresh();
    assert_eq!(health_stop(&off, &plain_stop(&off, "sc1h"), HEALTH), json!({"systemMessage": HEALTH}), "off: the invisible channel, as before");
    assert!(off.counters().is_empty());

    let on = Rig::new("health-on");
    on.on();
    on.fresh();
    assert_eq!(health_stop(&on, &plain_stop(&on, "sc1h"), HEALTH), json!({"hookSpecificOutput": {"hookEventName": "Stop", "additionalContext": HEALTH}}));
    assert_eq!(on.counters(), vec!["emitted/health-advisory".to_string()]);

    // each gate keeps the advisory on systemMessage
    type Mutate = Box<dyn Fn(&Rig, &mut Value)>;
    let gated: Vec<(&str, Mutate, &str)> = vec![
        ("no field", Box::new(|_, p| drop(p.as_object_mut().unwrap().remove("background_tasks"))), "no_background_field"),
        ("pending", Box::new(|_, p| p["background_tasks"] = json!([{"id": "b"}])), "background_pending"),
        ("K reached", Box::new(|r, _| r.transcript(&[human(), attached(), attached(), attached()])), "over_k"),
        ("unreadable", Box::new(|r, _| std::fs::write(r.t(), "garbage\n").unwrap()), "transcript_unreadable"),
    ];
    for (i, (name, f, word)) in gated.iter().enumerate() {
        let r = Rig::new(&format!("health-gate-{i}"));
        r.on();
        r.fresh();
        let mut p = plain_stop(&r, "sc1h");
        f(&r, &mut p);
        assert_eq!(health_stop(&r, &p, HEALTH), json!({"systemMessage": HEALTH}), "{name}");
        assert_eq!(r.counters(), vec![format!("{word}/health-advisory")], "{name}");
    }
    // a combined context over the cap: the advisory stays on systemMessage
    let long = "H".repeat(ah_engine::defaults::num("stop_channel.context_max_chars") as usize + 1);
    let r = Rig::new("health-long");
    r.on();
    r.fresh();
    assert_eq!(health_stop(&r, &plain_stop(&r, "sc1h"), &long), json!({"systemMessage": long}));
    assert_eq!(r.counters(), vec!["over_length/health-advisory".to_string()]);
}
