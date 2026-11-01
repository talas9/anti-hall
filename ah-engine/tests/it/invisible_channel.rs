//! GH #530 / plan v2 B3: a model-facing advisory must not leave on a channel the model cannot read.
//!
//! Every output path the dispatcher has is replayed and classified:
//! - each check: the recorded answers of the golden corpus (`tests/golden/<check>.jsonl`, the real answers of the shipped check
//!   scripts, replayed against them by the golden pack) are turned into the hook result the dispatcher builds from a verdict and
//!   put through the dispatcher's own combiner (`dispatch::combine`), event by event;
//! - the rule engine (`hookio::respond`): a warn and a context rule on every event;
//! - the health advisory merge (`health::merge_advisory`, used by the client and by the fail-open notice) on every event.
//!
//! Text on an invisible channel is an offender. The ratchet list is in `defaults/channel_ratchet.toml` (both defaults dirs): the
//! test fails on an offender that is not listed, on a listed one that no longer offends, and on a table pair the corpus cannot see
//! that is not listed as unexercised. `AH_CHANNEL_DUMP=1` prints the current lists as TOML rows.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use crate::common::TempDir;
use ah_engine::checks::Verdict;
use ah_engine::defaults;
use ah_engine::dispatch::combine::{Combined, HookResult, combine};
use ah_engine::dispatch::table;
use ah_engine::reqenv::RequestEnv;
use ah_engine::rules::RuleSet;
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::path::Path;

/// What the dispatcher puts on the wire for one hook result: exit code, stdout, stderr.
struct Wire {
    code: i32,
    out: String,
    err: String,
}

/// The hook result the dispatcher builds from a check's verdict (`dispatch::native::answer_of`), from a stored golden answer.
fn result_of(expect: &Value) -> Option<HookResult> {
    let s = |k: &str| expect.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
    let (code, out, err) = match expect.get("v")?.as_str()? {
        "block" => (2, String::new(), format!("{}\n", s("text"))),
        "advisory" => (0, format!("{}\n", s("text")), String::new()),
        "exact" => (expect.get("code").and_then(Value::as_i64).unwrap_or(0) as i32, s("out"), s("err")),
        "routed" => return result_of(expect.get("verdict")?),
        _ => return None,
    };
    Some(HookResult { id: "x".into(), code: Some(code), out, err })
}

/// The hook result the dispatcher builds from a check's verdict (`dispatch::native::answer_of`).
fn result_of_verdict(v: &Verdict) -> Option<HookResult> {
    let (code, out, err) = match v {
        Verdict::Block(m) => (2, String::new(), format!("{m}\n")),
        Verdict::Advisory(j) => (0, format!("{j}\n"), String::new()),
        Verdict::Exact(x) => (x.code, x.out.clone(), x.err.clone()),
        Verdict::Routed(inner, _) => return result_of_verdict(inner),
        Verdict::Allow | Verdict::Defer => return None,
    };
    Some(HookResult { id: "x".into(), code: Some(code), out, err })
}

/// The dispatcher's combiner on this one result: what the host receives.
fn wire(r: HookResult) -> Wire {
    match combine(&[r]) {
        Combined::Answer(o) => Wire { code: o.code, out: o.out, err: o.err },
        Combined::Conflict { .. } => panic!("one result cannot conflict"),
    }
}

/// The channels of `w` on `event` that carry text the model cannot read. Empty when everything said is readable.
fn invisible(event: &str, w: &Wire) -> BTreeSet<&'static str> {
    let has = |k: &str, e: &str| defaults::list(k).contains(&e);
    let (ctx, blockable, plain) =
        (has("channel_ratchet.context_events", event), has("channel_ratchet.block_events", event), has("dispatch.plain_context_events", event));
    let mut lost = BTreeSet::new();
    if !w.err.trim().is_empty() && !(w.code == 2 && blockable) {
        lost.insert("stderr");
    }
    let out = w.out.trim();
    if out.is_empty() {
        return lost;
    }
    let text = |v: Option<&Value>| v.and_then(Value::as_str).is_some_and(|t| !t.trim().is_empty());
    match serde_json::from_str::<Value>(out) {
        Ok(v) if v.is_object() => {
            if text(v.get("systemMessage")) {
                lost.insert("systemMessage");
            }
            let hso = v.get("hookSpecificOutput");
            if text(hso.and_then(|h| h.get("additionalContext"))) && !ctx {
                lost.insert("additionalContext");
            }
            if text(hso.and_then(|h| h.get("permissionDecisionReason"))) && event != "PreToolUse" {
                lost.insert("permissionDecisionReason");
            }
            if v.get("decision").and_then(Value::as_str) == Some("block") && text(v.get("reason")) && !blockable {
                lost.insert("blockReason");
            }
        }
        _ if w.code == 0 && plain => {}
        _ => {
            lost.insert("stdout");
        }
    }
    lost
}

type Key = (String, String, String); // check, event, channel

/// A check the corpus has no speaking case for, driven for real: the shipped script on a scratch home.
struct Scenario {
    check: &'static str,
    event: &'static str,
    /// Files laid under the home, relative path and text.
    files: Vec<(&'static str, &'static str)>,
    env: Vec<(&'static str, &'static str)>,
    /// How many times the check runs on that home (a cap notice comes after the blocks that spend the budget).
    runs: usize,
    /// How many of those runs say something (the two blocks and the cap notice of a gate; the one line of a banner).
    speaks: usize,
}

fn scenarios() -> Vec<Scenario> {
    vec![
        // a DevSwarm child workspace with nothing reported: two blocks (devswarm_gates.cg_max_blocks), then the cap notice
        Scenario {
            check: "devswarm-child-gate",
            event: "Stop",
            files: vec![(".anti-hall/devswarm/workspaces/ws1.json", "{}")],
            env: vec![("DEVSWARM_BUILDER_ID", "ws1"), ("DEVSWARM_SOURCE_BRANCH", "main"), ("DEVSWARM_REPO_ID", "r1")],
            runs: 4,
            speaks: 3,
        },
        Scenario { check: "session-banner", event: "SessionStart", files: vec![], env: vec![], runs: 1, speaks: 1 },
    ]
}

fn golden_dir() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden")
}

/// Every offender and every check/event pair with a recorded advisory.
fn observe() -> (BTreeSet<Key>, BTreeSet<(String, String)>) {
    let (mut offenders, mut seen) = (BTreeSet::new(), BTreeSet::new());
    let mut note = |check: &str, event: &str, w: &Wire, exercised: bool| {
        if exercised {
            seen.insert((check.to_string(), event.to_string()));
        }
        for ch in invisible(event, w) {
            if offenders.insert((check.to_string(), event.to_string(), ch.to_string())) && std::env::var_os("AH_CHANNEL_DUMP").is_some() {
                println!("sample {check} {event} {ch}: code {} out {:?} err {:?}", w.code, w.out, w.err);
            }
        }
    };
    // 1. the checks: golden answers, for the pairs the (claude) dispatch table runs
    let rows: BTreeSet<(String, String)> = table::events("claude")
        .into_iter()
        .flat_map(|e| table::entries("claude", e).into_iter().filter_map(move |x| x.check.map(|c| (c, e.to_string()))))
        .collect();
    for entry in std::fs::read_dir(golden_dir()).unwrap().flatten() {
        let path = entry.path();
        let Some(check) = path.file_stem().and_then(|s| s.to_str()).map(str::to_string) else { continue };
        for line in std::fs::read_to_string(&path).unwrap().lines().filter(|l| !l.trim().is_empty()) {
            let Ok(case) = serde_json::from_str::<Value>(line) else { continue };
            let event = case.get("event").and_then(Value::as_str).unwrap_or("PreToolUse");
            if !rows.contains(&(check.clone(), event.to_string())) {
                continue;
            }
            let Some(r) = case.get("expect").filter(|e| e.is_object()).and_then(result_of) else { continue };
            // the corpus stores a long value cut with an ellipsis: that text is no longer JSON, whatever the check printed
            if r.out.contains('…') && serde_json::from_str::<Value>(r.out.trim()).is_err() {
                continue;
            }
            let w = wire(r);
            let said = !w.out.trim().is_empty() || !w.err.trim().is_empty();
            note(&check, event, &w, said);
        }
    }
    // 2. checks the corpus has no speaking case for: the real script on a laid-out scratch home, run until it has said everything.
    // A script that overruns its time limit under machine load is answered as an allow (`script::failed`), which looks like silence:
    // a scenario is therefore repeated on a fresh home (three attempts) until it has spoken as often as it should.
    for sc in scenarios() {
        let mut spoke = 0;
        for attempt in 0..3 {
            let home = TempDir::at(std::env::temp_dir().join(format!("ah-chan-{}-{}-{attempt}", sc.check, std::process::id())));
            for (rel, body) in &sc.files {
                let p = home.join(rel);
                std::fs::create_dir_all(p.parent().unwrap()).unwrap();
                std::fs::write(p, body).unwrap();
            }
            std::fs::create_dir_all(home.join("proj")).unwrap();
            let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall").canonicalize().unwrap();
            let mut env =
                vec![("HOME".to_string(), home.to_string_lossy().into_owned()), ("CLAUDE_PLUGIN_ROOT".to_string(), root.to_string_lossy().into_owned())];
            env.extend(sc.env.iter().map(|(k, v)| (k.to_string(), v.to_string())));
            let env = RequestEnv::from_pairs(env);
            let payload = json!({"hook_event_name": sc.event, "session_id": "s1", "cwd": home.join("proj")});
            spoke = 0;
            for _ in 0..sc.runs {
                let verdict = ah_engine::script::run_forced(sc.check, &payload, &json!({"plugin_root": root}), sc.event, &env).flatten();
                if let Some(r) = verdict.as_ref().and_then(result_of_verdict) {
                    let w = wire(r);
                    let said = !w.out.trim().is_empty() || !w.err.trim().is_empty();
                    spoke += usize::from(said);
                    note(sc.check, sc.event, &w, said);
                }
            }
            if spoke >= sc.speaks {
                break;
            }
        }
        assert!(
            spoke >= sc.speaks,
            "scenario {} on {} spoke {spoke} times in {} runs, expected {}: the fixture no longer drives the script",
            sc.check,
            sc.event,
            sc.runs,
            sc.speaks
        );
    }
    // 3. the rule engine: a warn and a context rule on every event of the table
    let rules = RuleSet::parse(
        &json!({"version":1,"rules":[
            {"id":"w","pattern":"","action":"warn","message":"warn note"},
            {"id":"c","pattern":"","action":"context","message":"context note"}]})
        .to_string(),
    )
    .unwrap();
    for event in table::events("claude") {
        let out =
            ah_engine::hookio::respond(&json!({"hook_event_name": event, "tool_name":"Bash", "tool_input":{"command":"x"}, "prompt":"x"}).to_string(), &rules);
        note("rule-engine", event, &Wire { code: 0, out, err: String::new() }, true);
    }
    // 4. the health advisory (client.rs, and the fail-open notice in failopen.rs): merged into whatever the event printed
    for event in table::events("claude") {
        let out = ah_engine::health::merge_advisory(event, "", "engine advisory").unwrap_or_default();
        note("health-advisory", event, &Wire { code: 0, out, err: String::new() }, true);
    }
    (offenders, seen)
}

fn rows(key: &str, fields: &[&str]) -> BTreeSet<Vec<String>> {
    defaults::raw(key)
        .as_array()
        .unwrap_or(&[])
        .iter()
        .map(|r| fields.iter().map(|f| r.get(f).and_then(defaults::V::as_str).unwrap_or_default().to_string()).collect())
        .collect()
}

#[test]
fn no_advisory_leaves_on_a_channel_the_model_cannot_read_beyond_the_ratchet() {
    let (offenders, seen) = observe();
    // the table pairs the corpus cannot see (the exercised health and rule rows are not table checks)
    let pairs: BTreeSet<(String, String)> = table::events("claude")
        .into_iter()
        .flat_map(|e| table::entries("claude", e).into_iter().filter_map(move |x| x.check.map(|c| (c, e.to_string()))))
        .collect();
    let unexercised: BTreeSet<Vec<String>> = pairs.iter().filter(|p| !seen.contains(*p)).map(|(c, e)| vec![c.clone(), e.clone()]).collect();
    let found: BTreeSet<Vec<String>> = offenders.iter().map(|(c, e, ch)| vec![c.clone(), e.clone(), ch.clone()]).collect();
    // text that is for the user by design (a banner) is not a model-facing advisory: listed with the reason, and it must still speak
    let user_only = rows("channel_ratchet.user_only", &["check", "event", "channel"]);
    let silent: Vec<_> = user_only.difference(&found).collect();
    assert!(silent.is_empty(), "these channel_ratchet.user_only rows no longer speak on that channel: remove them: {silent:?}");
    assert!(
        defaults::raw("channel_ratchet.user_only")
            .as_array()
            .unwrap_or(&[])
            .iter()
            .all(|r| r.get("why").and_then(defaults::V::as_str).is_some_and(|w| !w.trim().is_empty())),
        "every channel_ratchet.user_only row says why the text is for the user"
    );
    let found: BTreeSet<Vec<String>> = found.difference(&user_only).cloned().collect();
    if std::env::var_os("AH_CHANNEL_DUMP").is_some() {
        println!("offenders:");
        for r in &found {
            println!("  {{ check = \"{}\", event = \"{}\", channel = \"{}\" }},", r[0], r[1], r[2]);
        }
        println!("unexercised:");
        for r in &unexercised {
            println!("  {{ check = \"{}\", event = \"{}\" }},", r[0], r[1]);
        }
    }
    let listed = rows("channel_ratchet.offenders", &["check", "event", "channel"]);
    let new: Vec<_> = found.difference(&listed).collect();
    let fixed: Vec<_> = listed.difference(&found).collect();
    assert!(
        new.is_empty(),
        "text leaves on a channel the model cannot read (check, event, channel): {new:?}. Move the advisory to a channel the model reads for that event (additionalContext on a context event, a block reason on a blocking one); do not add it to channel_ratchet.offenders"
    );
    assert!(fixed.is_empty(), "these channel_ratchet.offenders rows no longer offend: remove them from both defaults dirs: {fixed:?}");
    let listed_un = rows("channel_ratchet.unexercised", &["check", "event"]);
    let hidden: Vec<_> = unexercised.difference(&listed_un).collect();
    let stale: Vec<_> = listed_un.difference(&unexercised).collect();
    assert!(
        hidden.is_empty(),
        "the corpus has no recorded advisory for these table pairs, so the test cannot see them (check, event): {hidden:?}. Add a golden case that makes the check speak, or list them in channel_ratchet.unexercised"
    );
    assert!(stale.is_empty(), "these channel_ratchet.unexercised rows now have a recorded advisory: remove them: {stale:?}");
}

#[test]
fn the_classifier_tells_visible_from_invisible_channels() {
    let w = |code, out: &str, err: &str| Wire { code, out: out.into(), err: err.into() };
    let ctx = |e: &str| json!({"hookSpecificOutput":{"hookEventName":e,"additionalContext":"t"}}).to_string();
    assert!(invisible("Stop", &w(0, &json!({"systemMessage":"t"}).to_string(), "")).contains("systemMessage"), "a Stop note as systemMessage is lost");
    assert!(invisible("Stop", &w(0, &json!({"decision":"block","reason":"t"}).to_string(), "")).is_empty(), "a Stop block reason is read");
    assert!(invisible("Stop", &w(2, "", "t\n")).is_empty(), "exit 2 stderr on a blocking event is read");
    assert!(invisible("Stop", &w(0, "", "t\n")).contains("stderr"), "stderr on exit 0 is lost");
    assert!(invisible("Stop", &w(0, "[task-guard] t\n", "")).contains("stdout"), "plain Stop stdout on exit 0 is lost");
    assert!(invisible("UserPromptSubmit", &w(0, "plain\n", "")).is_empty(), "plain stdout is context on UserPromptSubmit");
    assert!(invisible("PreToolUse", &w(0, &ctx("PreToolUse"), "")).is_empty());
    assert!(invisible("SessionEnd", &w(0, &ctx("SessionEnd"), "")).contains("additionalContext"), "SessionEnd ignores additionalContext");
    assert!(invisible("SessionEnd", &w(2, "", "t\n")).contains("stderr"), "exit 2 on SessionEnd reaches nobody");
    assert!(invisible("Stop", &w(0, "", "")).is_empty(), "silence is not an offender");
}

#[test]
fn both_defaults_dirs_hold_the_same_ratchet_file() {
    let d = Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall/engine");
    let read = |dir: &str| std::fs::read_to_string(d.join(dir).join("channel_ratchet.toml")).unwrap();
    assert_eq!(read("defaults"), read("defaults.pristine"), "defaults/ and defaults.pristine/ must carry the identical channel_ratchet.toml");
}
