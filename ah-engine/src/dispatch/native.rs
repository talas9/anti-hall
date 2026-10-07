//! The built-in checks of one dispatch: run inside the daemon (the `D` request, the default) or inside the hook
//! client (`dispatch.in_process`), each under its own panic isolation (D12). An entry a check does not answer, and
//! every deferral, becomes that entry's Node hook in the client.
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
    #[serde(default)]
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
    let opts = json!({ "plugin_root": meta.root });
    let verdict = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| check.run_env(&subject, p, &opts, &meta.env)));
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
    table::select(&meta.host, &meta.event, p, meta.tool.as_deref())
        .into_iter()
        .filter(|e| e.check.is_some() && meta.only.as_ref().is_none_or(|ids| ids.contains(&e.id)))
        .map(|e| {
            let started = std::time::Instant::now();
            let a = run_entry(&e, meta, p);
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
        }
    }

    #[test]
    fn the_git_check_answers_its_entry_with_the_node_guards_bytes() {
        let p = json!({"session_id": "s", "cwd": "/", "hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": "git push --force origin main"}});
        let got = evaluate(&meta(), &p, &|_, _, _| {});
        let ids: Vec<&str> = got.iter().map(|(id, _)| id.as_str()).collect();
        assert_eq!(
            ids,
            ["compact-declaration-guard", "git-guard", "command-guard", "coordinator-work-guard", "merge-side-pick", "scan-throttle", "ship-it-guard"],
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
        for name in ["compact-declaration-guard", "coordinator-work-guard", "merge-side-pick", "scan-throttle", "ship-it-guard"] {
            let p = quiet_payload(name);
            let got = evaluate(&meta(), &p, &|_, _, _| {});
            let (_, a) = got.iter().find(|(id, _)| id == name).unwrap_or_else(|| panic!("{name} entry missing"));
            if a != &Answer::Decided(HookResult::quiet(name), Vec::new()) {
                deferred.push(name);
            }
        }
        assert!(deferred.is_empty(), "these checks must answer natively, not defer: {deferred:?}");
    }

    /// The other side of the fix: where a check cannot prove Node is silent it still defers (D74).
    #[test]
    fn a_check_that_cannot_prove_silence_still_defers() {
        // coordinator-work-guard: a main-session Bash call needs Node's own state, the check says Defer.
        let p = json!({"session_id": "s", "cwd": "/", "hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": "ls"}});
        let got = evaluate(&meta(), &p, &|_, _, _| {});
        assert_eq!(got.iter().find(|(id, _)| id == "coordinator-work-guard").unwrap().1, Answer::Defer);
        // ship-it-guard with its opt-in gate on: Bash targets need the command-guard parser, so it defers.
        let mut m = meta();
        m.env = crate::reqenv::RequestEnv::from_pairs([("ANTIHALL_SHIPIT_GATE", "1")]);
        let got = evaluate(&m, &p, &|_, _, _| {});
        assert_eq!(got.iter().find(|(id, _)| id == "ship-it-guard").unwrap().1, Answer::Defer);
    }

    /// Replay payload L3 (a force push): Node's command-guard blocks it as a state-changing remote command. The
    /// engine's `command` check cannot prove Node allows it, so it defers (the Node hook still runs and blocks); it must
    /// never answer allow for it (D74). The git check blocks it natively.
    #[test]
    fn a_force_push_is_never_a_native_allow_for_the_command_guard() {
        let cmd = ["git push", "--force", "origin main"].join(" ");
        let p = json!({"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": cmd}});
        let got = evaluate(&meta(), &p, &|_, _, _| {});
        assert_eq!(got.iter().find(|(id, _)| id == "command-guard").unwrap().1, Answer::Defer);
        assert!(matches!(&got.iter().find(|(id, _)| id == "git-guard").unwrap().1, Answer::Decided(r, _) if r.code == Some(2)));
    }

    #[test]
    fn the_session_and_subagent_start_entries_are_answered_with_the_node_hooks_bytes() {
        let d = std::env::temp_dir().join(format!("ah-native-vf-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("plugin/hooks")).unwrap();
        std::fs::write(d.join("plugin/hooks/verify-first-core.js"), "").unwrap();
        std::fs::create_dir_all(d.join("home")).unwrap();
        let root = std::fs::canonicalize(d.join("plugin")).unwrap().to_string_lossy().to_string();
        let env = crate::reqenv::RequestEnv::from_pairs([("HOME", d.join("home").to_string_lossy().to_string())]);
        let p = json!({"session_id": "s", "hook_event_name": "SessionStart"});
        for (host, event, ids) in [("claude", "SessionStart", vec!["verify-first-full", "fable-availability"]), ("codex", "SessionStart", vec!["verify-first-full"]), ("claude", "SubagentStart", vec!["verify-first-subagent"])] {
            let meta = Meta { host: host.into(), event: event.into(), tool: None, root: Some(root.clone()), env: env.clone() };
            let got = evaluate(&meta, &p, &|_, _, _| {});
            assert_eq!(got.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>(), ids, "{host} {event}");
            for (id, a) in &got {
                let Answer::Decided(r, _) = a else { panic!("{id} deferred") };
                assert_eq!(r.code, Some(0), "{id}");
                if id != "fable-availability" {
                    assert!(r.out.starts_with(&format!("{{\"hookSpecificOutput\":{{\"hookEventName\":\"{event}\",\"additionalContext\":\"ANTI-HALL VERIFY-FIRST")) && r.out.ends_with("}}\n"), "{id}: {}", r.out);
                    assert!(r.out.contains(&format!("{root}/PROTOCOL.md")), "{id}");
                } else {
                    assert!(r.out.is_empty(), "no fable in an empty home");
                }
            }
        }
        // the root is a host fact: with none, the compact text cannot be built and the Node hook answers
        let meta = Meta { host: "claude".into(), event: "SubagentStart".into(), tool: None, root: None, env };
        assert_eq!(evaluate(&meta, &p, &|_, _, _| {}).into_iter().map(|(_, a)| a).collect::<Vec<_>>(), vec![Answer::Defer]);
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
