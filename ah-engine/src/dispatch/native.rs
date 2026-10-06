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
}

/// One built-in check's answer for one entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Answer {
    /// The check decided; this is what the Node hook would have produced.
    Decided(HookResult),
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
        Some(Verdict::Allow) => Answer::Decided(HookResult::quiet(id)),
        Some(Verdict::Block(m)) => Answer::Decided(HookResult { id: id.into(), code: Some(2), out: String::new(), err: format!("{m}\n") }),
        Some(Verdict::Advisory(j)) => Answer::Decided(HookResult { id: id.into(), code: Some(0), out: format!("{j}\n"), err: String::new() }),
        Some(Verdict::Exact(x)) => Answer::Decided(HookResult { id: id.into(), code: Some(x.code), out: x.out, err: x.err }),
        Some(Verdict::Defer) | None => Answer::Defer,
    }
}

/// Every matching entry with a built-in check, answered; entries without one are not listed.
pub fn evaluate(meta: &Meta, p: &Value, observe: &dyn Fn(&Entry, &Answer, u64)) -> Vec<(String, Answer)> {
    table::select(&meta.host, &meta.event, p, meta.tool.as_deref())
        .into_iter()
        .filter(|e| e.check.is_some())
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
            Answer::Decided(r) => json!([id, r.code, r.out, r.err]),
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
            Some((id.clone(), Answer::Decided(HookResult { id, code, out: s(2)?, err: s(3)? })))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta() -> Meta {
        Meta { host: "claude".into(), event: "PreToolUse".into(), tool: None, root: Some("/nonexistent-plugin".into()), env: Default::default() }
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
            Answer::Decided(r) => {
                assert_eq!(r.code, Some(2));
                assert!(r.err.ends_with('\n') && r.out.is_empty());
            }
            Answer::Defer => panic!("force push should be decided"),
        }
    }

    #[test]
    fn an_exact_verdict_becomes_the_entrys_exact_bytes() {
        let x = crate::checks::Exact::json_block("stop");
        let a = answer_of("e", Some(Verdict::Exact(x.clone())));
        assert_eq!(a, Answer::Decided(HookResult { id: "e".into(), code: Some(2), out: x.out.clone(), err: x.err.clone() }));
        assert_eq!(decode(&encode(&[("e".into(), a.clone())])), Some(vec![("e".to_string(), a)]));
        assert_eq!(x.out, "{\"decision\":\"block\",\"reason\":\"stop\"}\n");
    }

    #[test]
    fn the_reply_round_trips() {
        let a = vec![
            ("x".to_string(), Answer::Defer),
            ("y".to_string(), Answer::Decided(HookResult { id: "y".into(), code: Some(2), out: "o".into(), err: "e\n".into() })),
        ];
        assert_eq!(decode(&encode(&a)), Some(a));
        assert_eq!(decode("not json"), None);
        assert_eq!(decode("[[1]]"), None);
    }
}
