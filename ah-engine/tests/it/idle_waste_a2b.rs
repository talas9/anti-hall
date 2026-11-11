//! #709 (PR-A2b): the child Stop gate reads the payload's cron list, the task tracker stays quiet on an unchanged scheduled turn, and the
//! waste warning speaks once per level change. Each test drives the shipped check through `ah-engine check` on a home of its own and shows
//! the smarter rule is silent on an unchanged state and still fires on a state change (the true positive).
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

struct Home {
    dir: PathBuf,
}

impl Home {
    fn new(name: &str) -> Home {
        let dir = std::env::temp_dir().join(format!("aha-iw2b-{name}-{}", std::process::id()));
        ah_engine::discard::harmless(std::fs::remove_dir_all(&dir));
        std::fs::create_dir_all(dir.join("home/.anti-hall/ah-engine")).unwrap();
        Home { dir }
    }

    fn home(&self) -> PathBuf {
        self.dir.join("home")
    }

    fn put(&self, rel: &str, body: &str) {
        let p = self.home().join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, body).unwrap();
    }

    /// The raw stdout of `ah-engine check <check>` for `payload`, with `extra` environment variables on top of a clean one.
    fn raw(&self, check: &str, payload: &serde_json::Value, extra: &[(&str, &str)]) -> String {
        let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
        c.args(["check", check])
            .env_clear()
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .env("HOME", self.home())
            .env("AH_ENGINE_DIR", self.dir.join("state"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        c.envs(extra.iter().copied());
        let mut ch = c.spawn().unwrap();
        ch.stdin.take().unwrap().write_all(payload.to_string().as_bytes()).unwrap();
        String::from_utf8_lossy(&ch.wait_with_output().unwrap().stdout).to_string()
    }

    /// The model-facing text of an answer: the prompt advisory's context, else the whole stdout.
    fn check(&self, check: &str, payload: &serde_json::Value, extra: &[(&str, &str)]) -> String {
        let out = self.raw(check, payload, extra);
        serde_json::from_str::<serde_json::Value>(out.trim_end())
            .ok()
            .and_then(|v| v["hookSpecificOutput"]["additionalContext"].as_str().map(str::to_string))
            .unwrap_or(out)
    }
}

impl Drop for Home {
    fn drop(&mut self) {
        ah_engine::discard::harmless(std::fs::remove_dir_all(&self.dir));
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64
}

const CHILD_ENV: [(&str, &str); 4] = [
    ("DEVSWARM_REPO_ID", "r1"),
    ("DEVSWARM_SOURCE_BRANCH", "feat/x"),
    ("DEVSWARM_BUILDER_ID", "b-1"),
    ("DEVSWARM_AI_AGENT", "claude"),
];

/// A registered child whose last inbox tick is two hours old (the warning threshold is 60 minutes).
fn stale_child(name: &str) -> Home {
    let h = Home::new(name);
    h.put(".anti-hall/devswarm/workspaces/b-1.json", "{}");
    h.put(".anti-hall/devswarm/wake-tick/b-1.json", &format!("{{\"ts\":{},\"unreadTotal\":0,\"known\":true}}", now_ms() - 2 * 3600 * 1000));
    h
}

fn stop(h: &Home, crons: Option<serde_json::Value>) -> serde_json::Value {
    let mut p = serde_json::json!({"hook_event_name": "Stop", "session_id": "s1", "cwd": h.home().to_string_lossy()});
    if let Some(c) = crons {
        p["session_crons"] = c;
    }
    p
}

/// The child gate's answer: its stdout plus the block-details file the frame points to (the cron text lives in the details).
fn gate(h: &Home, crons: Option<serde_json::Value>, extra: &[(&str, &str)]) -> String {
    let out = h.raw("devswarm-child-gate", &stop(h, crons), extra);
    let details = std::fs::read_to_string(h.home().join(".anti-hall/block-details/devswarm-child-gate-s1.md")).unwrap_or_default();
    format!("{out}\n{details}")
}

const TICK_PROMPT: &str = "/home/x/.anti-hall/ah-engine/bin/ah-engine mesh inbox tick b-1 --child --quiet";

/// The age-based check sent a child with an old tick marker to `CronList` even when the cron was armed. With the payload's cron list: a
/// listed tick job ends the warning; a list without it gets a CronCreate order with no CronList step; no list keeps the old text.
#[test]
fn the_child_gate_reads_the_cron_list_from_the_stop_payload() {
    // no list in the payload: the age-based text, which sends the model to CronList (the fallback is unchanged)
    let h = stale_child("cron-nolist");
    let out = gate(&h, None, &CHILD_ENV);
    assert!(out.contains("Mailbox cron missing: no inbox tick for") && out.contains("CronList"), "fallback: {out}");
    // a list that holds the tick job: nothing is missing, so no cron warning and no CronList order
    let h = stale_child("cron-listed");
    let out = gate(&h, Some(serde_json::json!([{"id": "c1", "schedule": "7,37 * * * *", "recurring": true, "prompt": TICK_PROMPT}])), &CHILD_ENV);
    assert!(!out.contains("Mailbox cron missing"), "a listed cron is not missing: {out}");
    // a list without the tick job (an empty one, or another job): the cron is missing, said from the list, with no CronList step
    for (name, list) in [("cron-empty", serde_json::json!([])), ("cron-other", serde_json::json!([{"id": "c2", "schedule": "0 9 * * *", "recurring": true, "prompt": "check the build"}]))] {
        let h = stale_child(name);
        let out = gate(&h, Some(list), &CHILD_ENV);
        assert!(out.contains("has no `inbox tick` cron") && out.contains("CronCreate"), "{name}: {out}");
        assert!(!out.contains("run `CronList`"), "{name}: the list is known, no CronList step: {out}");
    }
    // the switch off: the payload is ignored and the age-based text stands, even for a listed job
    let h = stale_child("cron-off");
    let mut env = CHILD_ENV.to_vec();
    env.push(("ANTIHALL_DEVSWARM_CRON_FROM_PAYLOAD", "0"));
    let out = gate(&h, Some(serde_json::json!([{"id": "c1", "schedule": "7,37 * * * *", "recurring": true, "prompt": TICK_PROMPT}])), &env);
    assert!(out.contains("Mailbox cron missing: no inbox tick for") && out.contains("CronList"), "switch off: {out}");
}

// ---- the task tracker on a scheduled turn, and the waste warning --------------------------------------------------------------------

const CRON_PROMPT: &str = "/home/x/.anti-hall/ah-engine/bin/ah-engine mesh inbox tick prim --quiet";
const PRIMARY_TIP: &str = "workspace-sized work needs a child workspace";

/// A transcript of `tasks` created tasks (all open) that ends in a user turn of `origin` ("human" or "scheduled") holding `prompt`.
fn transcript(h: &Home, tasks: u32, origin: &str, prompt: &str) -> PathBuf {
    let mut t = String::new();
    for n in 1..=tasks {
        t += &format!("{}\n", serde_json::json!({"type": "assistant", "message": {"id": format!("c{n}"), "role": "assistant", "content": [{"type": "tool_use", "id": format!("c{n}"), "name": "TaskCreate", "input": {"subject": format!("t{n}")}}]}}));
        t += &format!("{}\n", serde_json::json!({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": format!("c{n}"), "content": format!("Task #{n} created successfully: t{n}")}]}}));
    }
    t += &format!("{}\n", serde_json::json!({"type": "user", "turnOrigin": origin, "timestamp": "2026-11-10T18:41:09.261Z", "message": {"role": "user", "content": prompt}}));
    let p = h.dir.join("t.jsonl");
    std::fs::write(&p, t).unwrap();
    p
}

/// One prompt of session `s1` through the tracker as a DevSwarm Primary (so the workspace tip is due), the dedupe window off (nothing is
/// held back by the store, so any silence below is the scheduled-turn rule's).
fn track(h: &Home, tp: &PathBuf, prompt: &str, extra: &[(&str, &str)]) -> String {
    std::fs::create_dir_all(h.home().join("proj")).unwrap();
    let payload = serde_json::json!({"hook_event_name": "UserPromptSubmit", "session_id": "s1", "prompt": prompt, "cwd": h.home().join("proj"), "transcript_path": tp});
    let mut env = vec![("ANTIHALL_DEVSWARM_SUPERVISOR", "on"), ("ANTIHALL_DEDUPE_WINDOW_MIN", "0"), ("ANTIHALL_TASK_TRACKER_TERSE", "0"), ("AH_ENGINE_NOSPAWN", "1"), ("ANTIHALL_INGEST_DRY_RUN", "1")];
    env.extend_from_slice(extra);
    h.check("task-tracker", &payload, &env)
}

/// A cron tick with an unchanged task list got the workspace tip and the reminder every time (4 of 59 idle ticks in a measured session).
/// Now: silent. A changed list, a person's prompt and the switch off all still speak.
#[test]
fn the_tracker_is_quiet_on_an_unchanged_scheduled_turn_and_speaks_on_a_change() {
    let h = Home::new("tracker");
    // a person's prompt: the tip and the note are shown, and the list's hash is remembered
    let human = transcript(&h, 1, "human", "please start");
    assert!(track(&h, &human, "please start", &[]).contains(PRIMARY_TIP), "a person's prompt gets the tip");
    // the same list on a cron tick: silent, tick after tick
    let tick = transcript(&h, 1, "scheduled", CRON_PROMPT);
    for n in 0..3 {
        assert_eq!(track(&h, &tick, CRON_PROMPT, &[]), "", "unchanged scheduled tick {n}");
    }
    // the switch off restores the note on every scheduled turn
    assert!(track(&h, &tick, CRON_PROMPT, &[("ANTIHALL_TASK_TRACKER_SKIP_SCHEDULED", "0")]).contains(PRIMARY_TIP), "switch off: the tip returns");
    // a changed list on a tick is a state change: it speaks
    let changed = transcript(&h, 2, "scheduled", CRON_PROMPT);
    assert!(track(&h, &changed, CRON_PROMPT, &[]).contains(PRIMARY_TIP), "a changed list is not skipped");
    // a prompt a person typed after the ticks is never taken for one (its text is not the cron's)
    let back = transcript(&h, 2, "human", "carry on");
    assert!(track(&h, &back, "carry on", &[]).contains(PRIMARY_TIP), "a person's prompt is not skipped");
    // a user turn that is scheduled but holds another text than this prompt is not this turn: not skipped
    let other = transcript(&h, 2, "scheduled", "some other cron");
    assert!(track(&h, &other, CRON_PROMPT, &[]).contains(PRIMARY_TIP), "the newest scheduled turn must be this prompt");
}

fn waste_files(h: &Home) -> Vec<PathBuf> {
    std::fs::read_dir(h.home().join(".anti-hall/waste")).map(|d| d.flatten().map(|e| e.path()).collect()).unwrap_or_default()
}

/// Ten ticks of the same waste warn once, when the first level is reached; a higher level warns again, once.
#[test]
fn a_constant_waste_rate_across_ten_ticks_warns_once_and_a_higher_level_warns_again() {
    let h = Home::new("waste");
    let human = transcript(&h, 1, "human", "please start");
    track(&h, &human, "please start", &[]);
    let tick = transcript(&h, 1, "scheduled", CRON_PROMPT);
    let low = [("ANTIHALL_WASTE_WARN_TOKENS", "500")]; // levels 500, 2000, 8000 estimated tokens in the window
    let mut warnings = Vec::new();
    for n in 0..10 {
        let out = track(&h, &tick, CRON_PROMPT, &low);
        if out.contains("idle waste") {
            warnings.push((n, out));
        }
    }
    assert_eq!(warnings.len(), 1, "ten ticks at one rate warn once: {warnings:?}");
    assert!(warnings[0].1.contains("repeated_advisory") && warnings[0].1.contains("level 1/3"), "{}", warnings[0].1);
    assert!(!waste_files(&h).is_empty(), "the session keeps a waste record");
    // a rising rate (the same record read against a lower first level) reaches level 2 and warns once more
    let lower = [("ANTIHALL_WASTE_WARN_TOKENS", "200")]; // levels 200, 800, 3200
    let out = track(&h, &tick, CRON_PROMPT, &lower);
    assert!(out.contains("idle waste") && out.contains("level 2/3"), "a higher level warns: {out}");
    assert!(!track(&h, &tick, CRON_PROMPT, &lower).contains("idle waste"), "and only once");
    // the switch off: the same ticks never warn
    let h2 = Home::new("waste-off");
    let human = transcript(&h2, 1, "human", "please start");
    track(&h2, &human, "please start", &[]);
    let tick = transcript(&h2, 1, "scheduled", CRON_PROMPT);
    for _ in 0..10 {
        assert!(!track(&h2, &tick, CRON_PROMPT, &[("ANTIHALL_WASTE_WARN_TOKENS", "100"), ("ANTIHALL_WASTE_WARN", "0")]).contains("idle waste"));
    }
}

// ---- review fixes (PR #713 HOLD): P1-a cron shape, P1-b scheduled-turn proof, P1-c fingerprint, P2 waste write failure ---------------

/// P1-a: only a genuine recurring job that RUNS the mailbox tick ends the missing-cron warning. A prompt that merely mentions the words, a
/// one-shot job, a job with no schedule and an expired one are not the tick job; an unrecognised list falls back to the age-based text.
#[test]
fn only_a_genuine_recurring_tick_job_ends_the_cron_warning() {
    let missing = |out: &str, name: &str| assert!(out.contains("has no `inbox tick` cron") && out.contains("CronCreate"), "{name}: should warn from the list: {out}");
    let real = serde_json::json!({"id": "c1", "schedule": "7,37 * * * *", "recurring": true, "prompt": TICK_PROMPT});
    let with = |patch: serde_json::Value| {
        let mut e = real.clone();
        for (k, v) in patch.as_object().unwrap() {
            e[k] = v.clone();
        }
        e
    };
    let past = now_ms() - 3600 * 1000;
    let future = now_ms() + 24 * 3600 * 1000;
    let cases: Vec<(&str, serde_json::Value)> = vec![
        ("mention", serde_json::json!([{"id": "c1", "schedule": "7,37 * * * *", "recurring": true, "prompt": "Do not run inbox tick"}])),
        ("mention-with-cli", serde_json::json!([with(serde_json::json!({"prompt": "never run /x/ah-engine mesh inbox tick b-1 --child"}))])),
        ("one-shot", serde_json::json!([with(serde_json::json!({"recurring": false}))])),
        ("no-schedule", serde_json::json!([with(serde_json::json!({"schedule": ""}))])),
        ("expired", serde_json::json!([with(serde_json::json!({"expiresAt": past}))])),
        ("expiry-unreadable", serde_json::json!([with(serde_json::json!({"expiresAt": "soon"}))])),
    ];
    for (name, list) in cases {
        let h = stale_child(&format!("cron-{name}"));
        missing(&gate(&h, Some(list), &CHILD_ENV), name);
    }
    // the true positives still end the warning: the real job, with or without a (future) expiry
    for (name, e) in [("real", real.clone()), ("future-expiry", with(serde_json::json!({"expiresAt": future})))] {
        let h = stale_child(&format!("cron-ok-{name}"));
        let out = gate(&h, Some(serde_json::json!([e])), &CHILD_ENV);
        assert!(!out.contains("Mailbox cron missing"), "{name}: a genuine tick job is not missing: {out}");
    }
    // a genuine job beside a misleading one still counts
    let h = stale_child("cron-mixed");
    let out = gate(&h, Some(serde_json::json!([{"id": "x", "schedule": "* * * * *", "recurring": true, "prompt": "Do not run inbox tick"}, real.clone()])), &CHILD_ENV);
    assert!(!out.contains("Mailbox cron missing"), "mixed: {out}");
    // a list of an unrecognised shape (old shape, malformed entries) is no evidence either way: the age-based text, which sends to CronList
    for (name, list) in [
        ("old-shape", serde_json::json!([{"cron": "7,37 * * * *", "command": TICK_PROMPT}])),
        ("malformed", serde_json::json!(["inbox tick", 5, null])),
    ] {
        let h = stale_child(&format!("cron-{name}"));
        let out = gate(&h, Some(list), &CHILD_ENV);
        assert!(out.contains("Mailbox cron missing: no inbox tick for") && out.contains("CronList"), "{name}: falls back to the age-based text: {out}");
    }
    // a stale marker, no Monitor and no cron still warns (the lapsed-wake case)
    let h = stale_child("cron-lapsed");
    missing(&gate(&h, Some(serde_json::json!([])), &CHILD_ENV), "lapsed");
}

fn rec(kind: &str, origin: Option<&str>, ts: &str, text: &str) -> String {
    let mut v = serde_json::json!({"type": kind, "timestamp": ts, "message": {"role": kind, "content": text}});
    if let Some(o) = origin {
        v["turnOrigin"] = o.into();
    }
    format!("{v}\n")
}

fn raw_transcript(h: &Home, name: &str, body: &str) -> PathBuf {
    let p = h.dir.join(name);
    std::fs::write(&p, body).unwrap();
    p
}

/// P1-b: a turn is scheduled only when the matching record is provably the current turn's. A stale scheduled record of the same text with
/// the current record absent, or a newer record that names no origin, must not silence the tracker; a true scheduled turn still does.
#[test]
fn a_stale_scheduled_record_never_makes_the_current_turn_scheduled() {
    let human = |h: &Home| {
        let tp = transcript(h, 1, "human", "please start");
        assert!(track(h, &tp, "please start", &[]).contains(PRIMARY_TIP));
    };
    // true scheduled: the newest user record is the tick (nothing after it): skipped
    let h = Home::new("p1b-true");
    human(&h);
    let tp = raw_transcript(&h, "t1.jsonl", &(transcript_body(1) + &rec("user", Some("scheduled"), "2026-11-10T18:41:09.261Z", CRON_PROMPT)));
    assert_eq!(track(&h, &tp, CRON_PROMPT, &[]), "", "a true scheduled turn is skipped");
    // stale: an earlier scheduled tick of the same text, an assistant turn after it, and the current record absent: speaks
    let tp = raw_transcript(
        &h,
        "t2.jsonl",
        &(transcript_body(1) + &rec("user", Some("scheduled"), "2026-11-10T18:41:09.261Z", CRON_PROMPT) + &rec("assistant", None, "2026-11-10T18:41:20.000Z", "ok")),
    );
    assert!(track(&h, &tp, CRON_PROMPT, &[]).contains(PRIMARY_TIP), "a stale scheduled record with the current one absent speaks");
    // the current record names no origin, an earlier scheduled one has the same text: speaks
    let tp = raw_transcript(
        &h,
        "t3.jsonl",
        &(transcript_body(1)
            + &rec("user", Some("scheduled"), "2026-11-10T18:41:09.261Z", CRON_PROMPT)
            + &rec("assistant", None, "2026-11-10T18:41:20.000Z", "ok")
            + &rec("user", None, "2026-11-10T19:41:09.261Z", CRON_PROMPT)),
    );
    assert!(track(&h, &tp, CRON_PROMPT, &[]).contains(PRIMARY_TIP), "an originless current record speaks");
    // a tool result after the scheduled prompt (the same turn still running) does not make it stale
    let h2 = Home::new("p1b-toolresult");
    human(&h2);
    let tr = format!("{}\n", serde_json::json!({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "z", "content": "x"}]}}));
    let tp = raw_transcript(&h2, "t4.jsonl", &(transcript_body(1) + &rec("user", Some("scheduled"), "2026-11-10T18:41:09.261Z", CRON_PROMPT) + &tr));
    assert_eq!(track(&h2, &tp, CRON_PROMPT, &[]), "", "tool results are not a newer turn");
}

/// The creates of `n` tasks (assistant + tool result), the body `transcript()` puts before its final user turn.
fn transcript_body(n: u32) -> String {
    let mut t = String::new();
    for k in 1..=n {
        t += &format!("{}\n", serde_json::json!({"type": "assistant", "message": {"id": format!("c{k}"), "role": "assistant", "content": [{"type": "tool_use", "id": format!("c{k}"), "name": "TaskCreate", "input": {"subject": format!("t{k}")}}]}}));
        t += &format!("{}\n", serde_json::json!({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": format!("c{k}"), "content": format!("Task #{k} created successfully: t{k}")}]}}));
    }
    t
}

fn store_task(h: &Home, id: u32, subject: &str, status: &str, blocked_by: &[&str]) {
    h.put(
        &format!(".claude/tasks/s1/{id}.json"),
        &serde_json::json!({"id": id.to_string(), "subject": subject, "status": status, "blockedBy": blocked_by}).to_string(),
    );
}

/// P1-c: the change fingerprint covers what the actionability test reads (blockedBy) and the subject. Removing a blocker or renaming a task
/// is a state change on a scheduled tick (speaks); an identical list in another order is not (silent).
#[test]
fn the_list_fingerprint_sees_blockers_and_subjects_but_not_order() {
    let h = Home::new("p1c");
    let human = transcript(&h, 2, "human", "please start");
    store_task(&h, 1, "alpha", "pending", &[]);
    store_task(&h, 2, "beta", "pending", &["1"]);
    assert!(track(&h, &human, "please start", &[]).contains(PRIMARY_TIP));
    let tick = transcript(&h, 2, "scheduled", CRON_PROMPT);
    assert_eq!(track(&h, &tick, CRON_PROMPT, &[]), "", "an unchanged list on a tick is skipped (the Jev ask with it)");
    // reorder only: the same blockers listed in another order, and the files rewritten in another order: still silent
    store_task(&h, 2, "beta", "pending", &["1"]);
    store_task(&h, 1, "alpha", "pending", &[]);
    assert_eq!(track(&h, &tick, CRON_PROMPT, &[]), "", "a reorder is not a change");
    // the blocker removed: task 2 is now actionable, a change: speaks (and the ask goes out with it)
    store_task(&h, 2, "beta", "pending", &[]);
    assert!(track(&h, &tick, CRON_PROMPT, &[]).contains(PRIMARY_TIP), "a removed blocker is a change");
    assert_eq!(track(&h, &tick, CRON_PROMPT, &[]), "", "and the new state is then remembered");
    // renamed: a change
    store_task(&h, 1, "alpha renamed", "pending", &[]);
    assert!(track(&h, &tick, CRON_PROMPT, &[]).contains(PRIMARY_TIP), "a new subject is a change");
    assert_eq!(track(&h, &tick, CRON_PROMPT, &[]), "");
    // status change
    store_task(&h, 1, "alpha renamed", "in_progress", &[]);
    assert!(track(&h, &tick, CRON_PROMPT, &[]).contains(PRIMARY_TIP), "a status change is a change");
}

fn seed_waste(h: &Home, tokens: u64, level: u64) {
    let ev = serde_json::json!([[now_ms() - 1000, tokens]]);
    h.put(".anti-hall/waste/s1.json", &serde_json::json!({"cats": {"repeated_advisory": {"ev": ev, "level": level}}}).to_string());
}

fn waste_level(h: &Home) -> Option<u64> {
    let t = std::fs::read_to_string(h.home().join(".anti-hall/waste/s1.json")).ok()?;
    serde_json::from_str::<serde_json::Value>(&t).ok()?["cats"]["repeated_advisory"]["level"].as_u64()
}

fn human_turn(h: &Home) -> String {
    let tp = transcript(h, 1, "human", "go on");
    track(h, &tp, "go on", &[])
}

/// P2: exact boundaries, a state file that cannot be written (no warning, no repeat), flapping around a threshold, a clock that ran back,
/// and a damaged record.
#[test]
fn the_waste_warning_is_exact_quiet_on_write_failure_and_steady_at_a_threshold() {
    // exact boundaries (levels 1000, 4000, 16000): one below is quiet, the level itself warns
    for (tokens, want) in [(999u64, None), (1000, Some("level 1/3")), (3999, Some("level 1/3")), (4000, Some("level 2/3")), (16000, Some("level 3/3"))] {
        let h = Home::new(&format!("w-edge-{tokens}"));
        seed_waste(&h, tokens, 0);
        let out = human_turn(&h);
        match want {
            None => assert!(!out.contains("idle waste"), "{tokens}: {out}"),
            Some(l) => assert!(out.contains("idle waste") && out.contains(l), "{tokens}: {out}"),
        }
    }
    // a state file that cannot be written: no warning, turn after turn; once writable it warns once
    let h = Home::new("w-ro");
    seed_waste(&h, 1000, 0);
    let dir = h.home().join(".anti-hall/waste");
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o555)).unwrap();
    for n in 0..3 {
        assert!(!human_turn(&h).contains("idle waste"), "write failure, turn {n}: no warning");
    }
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(human_turn(&h).contains("idle waste"), "once the record is writable the rise warns");
    assert!(!human_turn(&h).contains("idle waste"), "and only once");
    // flapping around the first threshold: a dip inside the margin keeps the level, so the return does not warn again; a dip below it does
    let h = Home::new("w-flap");
    seed_waste(&h, 950, 1);
    assert!(!human_turn(&h).contains("idle waste") && waste_level(&h) == Some(1), "inside the margin the level stays");
    seed_waste(&h, 1000, waste_level(&h).unwrap());
    assert!(!human_turn(&h).contains("idle waste"), "back at the threshold: no second warning");
    seed_waste(&h, 850, 1);
    assert!(!human_turn(&h).contains("idle waste") && waste_level(&h) == Some(0), "below the margin the level falls");
    seed_waste(&h, 1000, 0);
    assert!(human_turn(&h).contains("idle waste"), "a real relapse warns again");
    // a clock that ran back: events dated after now are not counted
    let h = Home::new("w-clock");
    h.put(".anti-hall/waste/s1.json", &serde_json::json!({"cats": {"repeated_advisory": {"ev": [[now_ms() + 3_600_000, 50000]], "level": 0}}}).to_string());
    assert!(!human_turn(&h).contains("idle waste"), "future events are not counted");
    // a damaged record: no warning, no crash
    let h = Home::new("w-corrupt");
    h.put(".anti-hall/waste/s1.json", "{not json");
    assert!(!human_turn(&h).contains("idle waste"));
}
