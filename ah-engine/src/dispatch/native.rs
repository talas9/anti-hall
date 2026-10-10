//! The built-in checks of one dispatch: run inside the daemon (the `D` request, the default) or inside the hook
//! client (`dispatch.in_process`), each under its own panic isolation (D12). An entry a check does not answer, and
//! every deferral, becomes that entry's Node hook in the client.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - text that does not parse or decode is the absent value (Node Number()/JSON.parse catch parity)
// A failure that must be seen goes through `crate::discard` instead.

use crate::checks::{self, Verdict};
use crate::rules::Subject;
use serde_json::{Value, json};

use super::combine::HookResult;
use super::table::{self, Entry};

/// What the client tells the daemon besides the payload: which table to use, the plugin root for the checks and the
/// environment to evaluate them with.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Meta {
    /// The host whose table applies.
    pub host: String,
    /// The event (the `--event` argument).
    pub event: String,
    /// The `--tool` argument, if given.
    pub tool: Option<String>,
    /// The plugin root, handed to checks as their `plugin_root` option.
    pub root: Option<String>,
    /// The client's environment (D76): every check is evaluated with it, never with the daemon's own.
    #[serde(default = "crate::reqenv::RequestEnv::incomplete")]
    pub env: crate::reqenv::RequestEnv,
    /// The ids of the entries whose built-in check the client asks for (`None` = every matching entry with a check): the
    /// client has already applied the hook configuration and the entries' predicates (D87).
    #[serde(default)]
    pub only: Option<Vec<String>>,
    /// What the client's plan did to each entry, as `(entry id, outcome word)`; the daemon counts them.
    #[serde(default)]
    pub plan: Vec<(String, String)>,
    /// The hash of the non-default hook configuration the plan was made under (empty = the defaults).
    #[serde(default)]
    pub cfg: String,
    /// SHA-1 of the exact payload bytes the host sent (hex), for a check whose Node hook derives something from the raw
    /// stdin (verify-first picks its rotating line from it).
    #[serde(default)]
    pub payload_sha1: Option<String>,
    /// How long the client waits for the reply, in milliseconds (`client.deadline_ms` on its side): the daemon clamps the
    /// budgets that could outlast it ([`crate::deadline`]). Absent from an older client: the daemon's own default applies.
    #[serde(default)]
    pub deadline_ms: Option<u64>,
}

/// One built-in check's answer for one entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Answer {
    /// The check decided; this is what the Node hook would have produced.
    Decided(HookResult, Vec<checks::RouteMeta>),
    /// The Node hook must decide (the check deferred, panicked, or does not apply).
    Defer,
}

/// Run `entry`'s built-in check on the payload. The Node guard blocks with exit 2 and the reason plus a newline on
/// stderr, and prints an advisory as one JSON line; the verdict is turned into exactly those bytes.
pub fn run_entry(entry: &Entry, meta: &Meta, p: &Value) -> Answer {
    let Some(check) = entry.check.as_deref().and_then(checks::get) else { return Answer::Defer };
    let null = Value::Null;
    let subject = Subject {
        event: &meta.event,
        tool: meta.tool.as_deref().or_else(|| p.get("tool_name").and_then(Value::as_str)),
        cwd: p.get("cwd").and_then(Value::as_str),
        tool_input: p.get("tool_input").unwrap_or(&null),
        prompt: p.get("prompt").and_then(Value::as_str),
    };
    let opts = json!({ "plugin_root": meta.root, "payload_sha1": meta.payload_sha1, "host": meta.host });
    let verdict = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| checks::run_env_guarded(check, &subject, p, &opts, &meta.env)));
    match verdict {
        Ok(v) => answer_of(&entry.id, v),
        Err(_) => Answer::Defer,
    }
}

/// The bytes the Node hook `id` would have produced for a check's verdict.
fn answer_of(id: &str, verdict: Option<Verdict>) -> Answer {
    match verdict {
        Some(Verdict::Routed(inner, routes)) => match answer_of(id, Some(*inner)) {
            Answer::Decided(r, _) => Answer::Decided(r, routes),
            Answer::Defer => Answer::Defer,
        },
        Some(Verdict::Allow) => Answer::Decided(HookResult::quiet(id), Vec::new()),
        Some(Verdict::Block(m)) => Answer::Decided(HookResult { id: id.into(), code: Some(2), out: String::new(), err: format!("{m}\n") }, Vec::new()),
        Some(Verdict::Advisory(j)) => Answer::Decided(HookResult { id: id.into(), code: Some(0), out: format!("{j}\n"), err: String::new() }, Vec::new()),
        Some(Verdict::Exact(x)) => Answer::Decided(HookResult { id: id.into(), code: Some(x.code), out: x.out, err: x.err }, Vec::new()),
        Some(Verdict::Defer) | None => Answer::Defer,
    }
}

/// Every matching entry with a built-in check, answered; entries without one are not listed.
pub fn evaluate(meta: &Meta, p: &Value, observe: &dyn Fn(&Entry, &Answer, u64)) -> Vec<(String, Answer)> {
    // one dispatch of the prompt event is one turn of the session, which is what the injection gate counts keepalives in
    if meta.event == crate::defaults::text("inject_gate.ups_event")
        && let Some(sid) = p.get("session_id").and_then(Value::as_str).filter(|s| !s.is_empty())
    {
        crate::gate::global().turn(sid);
    }
    table::select(&meta.host, &meta.event, p, meta.tool.as_deref())
        .into_iter()
        .filter(|e| e.check.is_some() && meta.only.as_ref().is_none_or(|ids| ids.contains(&e.id)))
        .map(|e| {
            let started = std::time::Instant::now();
            crate::deadline::beat();
            let check = e.check.as_deref().unwrap_or("");
            // past the client's deadline nobody reads this reply's answer for the entry: it is not started, and its own Node hook
            // answers it (the entries answered in time still count), so a slow machine costs single checks, never the event
            let a = if !crate::deadline::in_time() && crate::script::cut_at_deadline(check, &meta.event) {
                crate::script::cut(check, &meta.event);
                Answer::Defer
            } else {
                let mark = crate::deadline::staged_mark();
                let a = run_entry(&e, meta, p);
                if matches!(a, Answer::Defer) {
                    // the Node hook decides this entry: what the check staged must not land for a decision nobody received
                    crate::deadline::discard_staged_since(mark);
                }
                a
            };
            crate::deadline::beat();
            observe(&e, &a, started.elapsed().as_micros() as u64);
            (e.id, a)
        })
        .collect()
}

/// The daemon's reply body: `[[id, "defer"], [id, code, stdout, stderr], ...]`.
pub fn encode(answers: &[(String, Answer)]) -> String {
    let rows: Vec<Value> = answers
        .iter()
        .map(|(id, a)| match a {
            Answer::Defer => json!([id, "defer"]),
            Answer::Decided(r, _) => json!([id, r.code, r.out, r.err]),
        })
        .collect();
    Value::Array(rows).to_string()
}

/// Read a reply body written by [`encode`]; `None` when it is not one (the client then defers every check to Node).
pub fn decode(body: &str) -> Option<Vec<(String, Answer)>> {
    let rows: Vec<Value> = serde_json::from_str(body).ok()?;
    rows.into_iter()
        .map(|r| {
            let id = r.get(0)?.as_str()?.to_string();
            if r.as_array()?.len() == 2 {
                return Some((id.clone(), Answer::Defer));
            }
            let code = r.get(1)?.as_i64().map(|c| c as i32);
            let s = |i: usize| r.get(i).and_then(Value::as_str).map(str::to_string);
            Some((id.clone(), Answer::Decided(HookResult { id, code, out: s(2)?, err: s(3)? }, Vec::new())))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta() -> Meta {
        Meta {
            host: "claude".into(),
            event: "PreToolUse".into(),
            tool: None,
            root: Some("/nonexistent-plugin".into()),
            env: Default::default(),
            only: None,
            plan: vec![],
            cfg: String::new(),
            payload_sha1: None,
            deadline_ms: None,
        }
    }

    #[test]
    fn the_git_check_answers_its_entry_with_the_node_guards_bytes() {
        let p = json!({"session_id": "s", "cwd": "/", "hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": "git push --force origin main"}});
        let got = evaluate(&meta(), &p, &|_, _, _| {});
        let ids: Vec<&str> = got.iter().map(|(id, _)| id.as_str()).collect();
        assert_eq!(
            ids,
            [
                "compact-declaration-guard",
                "git-guard",
                "command-guard",
                "coordinator-work-guard",
                "merge-side-pick",
                "merge-gate",
                "scan-throttle",
                "api-guard",
                "ship-it-guard",
                "procwatch-advisory",
                "engine-role-guard",
                "broad-kill-guard"
            ],
            "the Bash entries a built-in check answers, in hooks.json order"
        );
        let (id, a) = got.iter().find(|(id, _)| id == "git-guard").unwrap();
        assert_eq!(id, "git-guard");
        match a {
            Answer::Decided(r, _) => {
                assert_eq!(r.code, Some(2));
                assert!(r.err.ends_with('\n') && r.out.is_empty());
            }
            Answer::Defer => panic!("force push should be decided"),
        }
    }

    /// Load: past the client's deadline no entry is started, each defers to its own Node hook (a loaded machine costs single
    /// entries, never the whole event's reply).
    #[test]
    fn past_the_clients_deadline_every_entry_defers_without_running() {
        let p = json!({"session_id": "s", "cwd": "/", "hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": "git push --force origin main"}});
        crate::deadline::begin(std::time::Instant::now());
        crate::deadline::client_deadline(0);
        let got = evaluate(&meta(), &p, &|_, _, _| {});
        crate::deadline::end();
        assert!(!got.is_empty());
        assert!(got.iter().all(|(_, a)| matches!(a, Answer::Defer)), "{:?}", got.iter().map(|(id, _)| id).collect::<Vec<_>>());
        let again = evaluate(&meta(), &p, &|_, _, _| {});
        assert!(again.iter().any(|(id, a)| id == "git-guard" && matches!(a, Answer::Decided(r, _) if r.code == Some(2))), "in time it decides");
    }

    /// A payload each of the five stateless checks settles as "nothing to say".
    fn quiet_payload(check: &str) -> Value {
        let base = json!({"session_id": "s", "cwd": "/", "hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": "ls"}});
        match check {
            // No transcript path: Node allows whatever the call is.
            "compact-declaration-guard" => base,
            // A subagent call: the coordinator guard leaves it alone.
            "coordinator-work-guard" => {
                let mut p = base;
                p["agent_id"] = json!("a1");
                p
            }
            // A command that neither picks a side, tests nor pushes.
            "merge-side-pick" => base,
            // No scan-throttle patterns in the environment.
            "scan-throttle" => base,
            // A Bash call names no file for the plan guard.
            "ship-it-guard" => base,
            _ => unreachable!(),
        }
    }

    /// Regression: a check that returned `None` ("nothing to say, allow") was answered `Defer` here, so its Node hook
    /// still ran (0% native answers for these five checks in a 1819-payload replay). It must be answered natively with
    /// the quiet bytes, which are what the silent Node hook produces.
    #[test]
    fn a_check_that_decided_allow_is_answered_natively_not_deferred() {
        let mut deferred = Vec::new();
        // the checks that keep their state in the client's home need one (without it they defer, D74): an empty one here
        let home = std::env::temp_dir().join(format!("ah-native-quiet-{}", std::process::id()));
        std::fs::create_dir_all(home.join(".anti-hall")).unwrap();
        let mut m = meta();
        m.env = crate::reqenv::RequestEnv::from_pairs([("HOME", home.to_string_lossy().to_string())]);
        for name in ["compact-declaration-guard", "coordinator-work-guard", "merge-side-pick", "scan-throttle", "ship-it-guard"] {
            let p = quiet_payload(name);
            let got = evaluate(&m, &p, &|_, _, _| {});
            let (_, a) = got.iter().find(|(id, _)| id == name).unwrap_or_else(|| panic!("{name} entry missing"));
            if a != &Answer::Decided(HookResult::quiet(name), Vec::new()) {
                deferred.push(name);
            }
        }
        assert!(deferred.is_empty(), "these checks must answer natively, not defer: {deferred:?}");
    }

    /// The other side of the fix: where a check cannot prove Node is silent it still defers (D74). A relative payload cwd
    /// resolves against the Node hook's own working directory, which the daemon cannot know: git-guard defers.
    #[test]
    fn a_check_that_cannot_prove_silence_still_defers() {
        let p = json!({"session_id": "s", "cwd": "sub", "hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": "git status"}});
        let got = evaluate(&meta(), &p, &|_, _, _| {});
        assert_eq!(got.iter().find(|(id, _)| id == "git-guard").unwrap().1, Answer::Defer);
    }

    /// Review P1: an incomplete request environment (dropped over the cap, absent, no HOME) must not be evaluated: with
    /// it the ship-it gate reads as off and the engine would allow an Edit Node blocks. Every env-reading check defers.
    #[test]
    fn an_incomplete_environment_defers_every_check() {
        let p = json!({"session_id": "s", "cwd": "/", "hook_event_name": "PreToolUse", "tool_name": "Edit", "tool_input": {"file_path": "migrations/a.sql"}});
        let mut m = meta();
        m.env = crate::reqenv::RequestEnv::from_pairs([("ANTIHALL_SHIPIT_GATE", "1"), ("HOME", "/h")]);
        let whole = evaluate(&m, &p, &|_, _, _| {});
        let ship = |got: &[(String, Answer)]| got.iter().find(|(id, _)| id == "ship-it-guard").unwrap().1.clone();
        assert!(matches!(ship(&whole), Answer::Decided(ref r, _) if r.code == Some(2)), "control: the gate is on, so it blocks");
        m.env = crate::reqenv::RequestEnv::incomplete();
        let got = evaluate(&m, &p, &|_, _, _| {});
        assert!(!got.is_empty() && got.iter().all(|(_, a)| *a == Answer::Defer), "every check defers: {got:?}");
        let big = "x".repeat(crate::defaults::num("request_env.max_bytes") as usize);
        m.env = crate::reqenv::RequestEnv::from_pairs([("ANTIHALL_SHIPIT_GATE", "1".to_string()), ("ANTIHALL_X", big)]);
        assert_eq!(ship(&evaluate(&m, &p, &|_, _, _| {})), Answer::Defer, "an environment dropped over the cap defers too");
    }

    /// Replay payload L3 (a force push): Node's command-guard blocks it as a state-changing remote command in the main thread. The
    /// engine's `command` script makes the same decision (exit 2) or defers; it never answers allow for the main thread (D74).
    #[test]
    fn a_force_push_is_never_a_native_allow_for_the_command_guard() {
        let cmd = ["git push", "--force", "origin main"].join(" ");
        let p = json!({"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": cmd}});
        let home = std::env::temp_dir().join(format!("ah-native-fp-{}", std::process::id()));
        std::fs::create_dir_all(home.join(".anti-hall")).unwrap();
        let mut m = meta();
        m.env = crate::reqenv::RequestEnv::from_pairs([("HOME", home.to_string_lossy().to_string()), ("CLAUDE_CODE_ENTRYPOINT", "cli".to_string())]);
        let got = evaluate(&m, &p, &|_, _, _| {});
        // the plugin root of this test does not exist, so the block message cannot name the CLI: the script defers rather than guess
        let cg = &got.iter().find(|(id, _)| id == "command-guard").unwrap().1;
        assert!(matches!(cg, Answer::Defer) || matches!(cg, Answer::Decided(r, _) if r.code == Some(2)), "never an allow: {got:?}");
        assert!(matches!(&got.iter().find(|(id, _)| id == "git-guard").unwrap().1, Answer::Defer | Answer::Decided(..)));
        crate::discard::harmless(std::fs::remove_dir_all(&home)); // keep: cleanup of a scratch directory
    }

    #[test]
    fn the_session_and_subagent_start_entries_are_answered_with_the_node_hooks_bytes() {
        let d = std::env::temp_dir().join(format!("ah-native-vf-{}", std::process::id()));
        crate::discard::harmless(std::fs::remove_dir_all(&d)); // keep: cleanup that raced; an absent file is the goal state
        std::fs::create_dir_all(d.join("plugin/hooks")).unwrap();
        std::fs::write(d.join("plugin/hooks/verify-first-core.js"), "").unwrap();
        std::fs::create_dir_all(d.join("home")).unwrap();
        let root = std::fs::canonicalize(d.join("plugin")).unwrap().to_string_lossy().to_string();
        let env = crate::reqenv::RequestEnv::from_pairs([("HOME", d.join("home").to_string_lossy().to_string())]);
        let p = json!({"session_id": "s", "hook_event_name": "SessionStart"});
        for (host, event, ids) in [
            ("claude", "SessionStart", vec!["verify-first-full", "fable-availability"]),
            ("codex", "SessionStart", vec!["verify-first-full"]),
            ("claude", "SubagentStart", vec!["verify-first-subagent"]),
        ] {
            let meta = Meta {
                host: host.into(),
                event: event.into(),
                tool: None,
                root: Some(root.clone()),
                env: env.clone(),
                only: None,
                plan: Vec::new(),
                cfg: String::new(),
                payload_sha1: None,
                deadline_ms: None,
            };
            // the other batches' checks of the same event answer here too (their own tests pin their bytes): only the verify-first
            // family and fable-availability are looked at
            let got: Vec<_> = evaluate(&meta, &p, &|_, _, _| {}).into_iter().filter(|(id, _)| ids.contains(&id.as_str())).collect();
            assert_eq!(got.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>(), ids, "{host} {event}");
            for (id, a) in &got {
                let Answer::Decided(r, _) = a else { panic!("{id} deferred") };
                assert_eq!(r.code, Some(0), "{id}");
                if id != "fable-availability" {
                    assert!(
                        r.out.starts_with(&format!("{{\"hookSpecificOutput\":{{\"hookEventName\":\"{event}\",\"additionalContext\":\"ANTI-HALL VERIFY-FIRST"))
                            && r.out.ends_with("}}\n"),
                        "{id}: {}",
                        r.out
                    );
                    assert!(r.out.contains(&format!("{root}/PROTOCOL.md")), "{id}");
                } else {
                    assert!(r.out.is_empty(), "no fable in an empty home");
                }
            }
        }
        // the root is a host fact: with none, the compact text cannot be built and the Node hook answers
        let meta = Meta {
            host: "claude".into(),
            event: "SubagentStart".into(),
            tool: None,
            root: None,
            env,
            only: None,
            plan: Vec::new(),
            cfg: String::new(),
            payload_sha1: None,
            deadline_ms: None,
        };
        assert_eq!(
            evaluate(&meta, &p, &|_, _, _| {}).into_iter().filter(|(id, _)| id == "verify-first-subagent").map(|(_, a)| a).collect::<Vec<_>>(),
            vec![Answer::Defer]
        );
    }

    #[test]
    fn an_exact_verdict_becomes_the_entrys_exact_bytes() {
        let x = crate::checks::Exact::json_block("stop");
        let a = answer_of("e", Some(Verdict::Exact(x.clone())));
        assert_eq!(a, Answer::Decided(HookResult { id: "e".into(), code: Some(2), out: x.out.clone(), err: x.err.clone() }, Vec::new()));
        assert_eq!(decode(&encode(&[("e".into(), a.clone())])), Some(vec![("e".to_string(), a)]));
        assert_eq!(x.out, "{\"decision\":\"block\",\"reason\":\"stop\"}\n");
    }

    #[test]
    fn the_reply_round_trips() {
        let a = vec![
            ("x".to_string(), Answer::Defer),
            ("y".to_string(), Answer::Decided(HookResult { id: "y".into(), code: Some(2), out: "o".into(), err: "e\n".into() }, Vec::new())),
        ];
        assert_eq!(decode(&encode(&a)), Some(a));
        assert_eq!(decode("not json"), None);
        assert_eq!(decode("[[1]]"), None);
    }
}
