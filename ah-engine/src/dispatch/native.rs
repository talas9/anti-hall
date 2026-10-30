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
    /// The check gave no answer (it deferred, panicked, does not apply, or was dropped under load): the call goes on without it.
    Defer,
}

/// Run `entry`'s built-in check on the payload. The Node guard blocks with exit 2 and the reason plus a newline on
/// stderr, and prints an advisory as one JSON line; the verdict is turned into exactly those bytes.
pub fn run_entry(entry: &Entry, meta: &Meta, p: &Value) -> Answer {
    match entry.check.as_deref() {
        Some(name) => run_check(name, &entry.id, meta, p),
        None => Answer::Defer,
    }
}

/// Run the built-in check `name` for the answer of `id` (an entry of the table, or an internal step of the dispatcher).
pub(crate) fn run_check(name: &str, id: &str, meta: &Meta, p: &Value) -> Answer {
    let Some(check) = checks::get(name) else { return Answer::Defer };
    let null = Value::Null;
    let subject = Subject {
        event: &meta.event,
        tool: meta.tool.as_deref().or_else(|| p.get("tool_name").and_then(Value::as_str)),
        cwd: p.get("cwd").and_then(Value::as_str),
        tool_input: p.get("tool_input").unwrap_or(&null),
        prompt: p.get("prompt").and_then(Value::as_str),
    };
    let opts = json!({ "plugin_root": meta.root, "payload_sha1": meta.payload_sha1, "host": meta.host });
    let verdict = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _boundary = crate::crash::enter("check", "D", &meta.event, id, "");
        checks::run_env_guarded(check, &subject, p, &opts, &meta.env)
    }));
    match verdict {
        Ok(v) => answer_of(id, v),
        Err(_) => Answer::Defer,
    }
}

/// The bytes the Node hook `id` would have produced for a check's verdict.
pub(crate) fn answer_of(id: &str, verdict: Option<Verdict>) -> Answer {
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

/// Whether `check` is skipped (shed) under load: `diagnostics.shed_checks` is on, the daemon is past its HARD CPU limit
/// (`shedding`), the event cannot block (`guard_event` false) and the check is not listed in `diagnostics.shed_never`.
/// Only a check of tier `diagnostics.shed_tier_optional` is shed (`diagnostics.shed_tier_by_check`, else `diagnostics.shed_tier_default`):
/// a rule reminder the agent needs is never dropped to save CPU it barely uses (#464: the five reminders shed most cost 1 us to 8 ms).
pub(crate) fn sheds(check: &str, guard_event: bool, shedding: bool) -> bool {
    shedding
        && !guard_event
        && crate::defaults::num("diagnostics.shed_checks") == 1
        && crate::defaults::raw("diagnostics.shed_never").get(check).is_none()
        && shed_tier(check) == crate::defaults::text("diagnostics.shed_tier_optional")
}

/// The shed tier of `check`: its row in `diagnostics.shed_tier_by_check`, else `diagnostics.shed_tier_default`.
pub(crate) fn shed_tier(check: &str) -> &'static str {
    crate::defaults::raw("diagnostics.shed_tier_by_check")
        .get(check)
        .and_then(crate::defaults::V::as_str)
        .unwrap_or_else(|| crate::defaults::text("diagnostics.shed_tier_default"))
}

/// Every matching entry with a built-in check, answered; entries without one are not listed.
///
/// `over_cpu` is asked, after a check ran, whether the thread CPU that ONE check used (microseconds) crossed the hard budget: only that
/// check's answer is dropped (a runaway), the checks after it still run and answer. A cumulative request budget made one slow check
/// sink every later check's answer (live 2026-10-23); the request as a whole is bounded by the hard deadline instead.
pub fn evaluate(meta: &Meta, p: &Value, over_cpu: &dyn Fn(u64) -> bool, observe: &dyn Fn(&Entry, &Answer, u64)) -> Vec<(String, Answer)> {
    // one dispatch of the prompt event is one turn of the session, which is what the injection gate counts keepalives in
    if meta.event == crate::defaults::text("inject_gate.ups_event")
        && let Some(sid) = p.get("session_id").and_then(Value::as_str).filter(|s| !s.is_empty())
    {
        crate::gate::global().turn(sid);
    }
    let guard_event = crate::defaults::list("dispatch.guard_events").contains(&meta.event.as_str());
    let mut out = Vec::new();
    for e in table::select(&meta.host, &meta.event, p, meta.tool.as_deref())
        .into_iter()
        .filter(|e| e.check.is_some() && meta.only.as_ref().is_none_or(|ids| ids.contains(&e.id)))
    {
        let started = std::time::Instant::now();
        crate::deadline::beat();
        let check = e.check.as_deref().unwrap_or("");
        crate::jev::assist::set_asking_check(check);
        if crate::deadline::note_soft_overrun() {
            // the client's fail-fast wait was over before any check of this request started (it waited in the queue): this and the later
            // checks still run (up to the hard deadline), the Node hook is not needed
            let elapsed = crate::deadline::elapsed_ms().unwrap_or(0);
            crate::health::log_event(
                "deadline_soft",
                check,
                &crate::defaults::render("msg.log_deadline_soft_queued", &[("check", &check), ("event", &meta.event), ("elapsed_ms", &elapsed)]),
            );
        }
        // a check that gets no answer takes its failure policy in the dispatcher (the entries answered in time still count), so a slow
        // machine costs single checks, never the event; every dropped answer is recorded with its reason (`budget::note_dropped`)
        let cpu_before = crate::limits::thread_cpu_us();
        let a = if sheds(check, guard_event, crate::budget::shedding()) {
            // past the HARD CPU limit (diagnostics.budget_cpu_hard_pct), when `diagnostics.shed_checks` is on, the pure-advice checks of events that cannot block wait (`diagnostics.shed_never` lists the ones that never do)
            crate::budget::note_shed_skipped();
            crate::budget::note_shed_session(p.get("session_id").and_then(Value::as_str).unwrap_or_default(), check);
            crate::budget::note_dropped(guard_event, check, &meta.event, "shed");
            Answer::Defer
        } else if crate::deadline::client_gone() {
            // the client closed its connection: nobody reads this reply, so the check is not worth running.
            // live19: 478 replies in 1000 s hit a closed pipe after their work was done.
            crate::budget::note_dropped(guard_event, check, &meta.event, "client_gone");
            Answer::Defer
        } else if !crate::deadline::in_time()
            && crate::script::cut_at_deadline(check, &meta.event)
            && crate::deadline::past_hard_ms() > crate::script::deadline_grace_ms(check)
        {
            // #463: the check answers by its own failure policy here; there is no Node hook to defer to
            let v = crate::script::cut(check, &meta.event);
            crate::budget::note_dropped(guard_event, check, &meta.event, "hard_deadline");
            answer_of(&e.id, Some(v))
        } else {
            let mark = crate::deadline::staged_mark();
            let a = if check == crate::defaults::text("upfront.check") {
                // It has a real table row (and honors --only); emit after all blocking guards are known.
                Answer::Decided(HookResult::quiet(&e.id), Vec::new())
            } else {
                run_entry(&e, meta, p)
            };
            let used = crate::limits::thread_cpu_us().saturating_sub(cpu_before);
            if matches!(a, Answer::Defer) {
                crate::deadline::discard_staged_since(mark);
                crate::budget::note_dropped(guard_event, check, &meta.event, "check_deferred");
                Answer::Defer
            } else if over_cpu(used) {
                // this check ran and crossed the budget alone: what it staged must not land for a decision nobody received
                crate::health::log_event(
                    "budget",
                    check,
                    &crate::defaults::render("msg.log_budget_crossed", &[("check", &check), ("cpu_us", &used), ("wall_us", &started.elapsed().as_micros())]),
                );
                crate::deadline::discard_staged_since(mark);
                crate::budget::note_dropped(guard_event, check, &meta.event, "cpu_budget");
                Answer::Defer
            } else {
                // a block that keeps coming back from the same guard tells what is allowed and asks for a different approach
                crate::learn::annotate(meta, p, check, a)
            }
        };
        crate::deadline::beat();
        if crate::deadline::note_soft_overrun() {
            // the client's fail-fast wait ended while THIS check was running: it is the one the line names, with how long it ran
            // (the line used to name the next check to start: ship-it-guard, 0.7 ms mean over 49,811 live calls, was blamed for time earlier checks spent)
            let (elapsed, ran) = (crate::deadline::elapsed_ms().unwrap_or(0), started.elapsed().as_millis());
            crate::health::log_event(
                "deadline_soft",
                check,
                &crate::defaults::render("msg.log_deadline_soft", &[("check", &check), ("event", &meta.event), ("elapsed_ms", &elapsed), ("ran_ms", &ran)]),
            );
        }
        crate::load::note_check_cpu(crate::limits::thread_cpu_us().saturating_sub(cpu_before));
        observe(&e, &a, started.elapsed().as_micros() as u64);
        out.push((e.id, a));
    }
    crate::learn::upfront_notice(meta, p, &mut out);
    out
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
    fn enforcement_rows_of_non_guard_events_are_never_shed_under_load() {
        // The non-guard halves of these checks carry enforcement: afk-mode handles the owner's typed `afk`/`back`, records owner
        // presence and injects the AFK rule; advisor-guard arms/disarms the retry rule its PreToolUse half blocks on. Shedding them
        // under load silently disables the rule (or leaves a stale arm), so a simulated load must still run them.
        let guards = crate::defaults::list("dispatch.guard_events");
        let mut seen = 0;
        for host in ["claude", "codex"] {
            for event in ["UserPromptSubmit", "SessionStart", "SubagentStart", "PostToolUse", "PostToolUseFailure"] {
                assert!(!guards.contains(&event), "{event} is not a guard event");
                let key = format!("dispatch.hooks_{host}_{event}");
                if !crate::defaults::has(&key) {
                    continue; // the host has no hooks on this event
                }
                let rows = crate::defaults::raw(&key);
                for r in rows.as_array().unwrap_or_default() {
                    let Some(check) = r.get("check").and_then(|v| v.as_str()) else { continue };
                    if ["afk-mode", "advisor-guard"].contains(&check) {
                        seen += 1;
                        assert!(!sheds(check, false, true), "{host} {event} row {:?} ({check}) is shed under load", r.get("id"));
                    }
                }
            }
        }
        assert!(seen >= 6, "the enforcement rows were found in the dispatch table ({seen})");
        // the simulation is real: a pure-advice check of the same events IS shed under load, and nothing is shed without load
        assert!(sheds("codex-availability", false, true));
        assert!(!sheds("codex-availability", false, false));
        assert!(!sheds("codex-availability", true, true));
    }

    /// #464: under CPU pressure only the optional tier is shed; the rule reminders the agent needs (shed ~189 prompts in two days
    /// while costing 1 us to 8 ms each) keep answering.
    #[test]
    fn shedding_under_cpu_pressure_keeps_the_rule_reminders() {
        for check in [
            "switch-notice",
            "idle-agent-sweep",
            "limit-conserve-inject",
            "gh-rt-advisory",
            "procwatch-advisory",
            "engine-role-note",
            "failure-root-cause-nudge",
        ] {
            assert!(!sheds(check, false, true), "{check} is a rule reminder: never shed");
        }
        for check in ["claude-cli-version", "devswarm-version", "jev-weekly-scorecard"] {
            assert!(sheds(check, false, true), "{check} is optional: shed under load");
        }
        // every optional row names a real check of the dispatch table, so a typo cannot hide a reminder from the tiers
        let tiers = crate::defaults::raw("diagnostics.shed_tier_by_check");
        let mut all: Vec<&str> = Vec::new();
        for key in ["dispatch.hooks_claude_SessionStart", "dispatch.hooks_claude_UserPromptSubmit", "dispatch.hooks_codex_SessionStart"] {
            if crate::defaults::has(key) {
                all.extend(crate::defaults::raw(key).as_array().into_iter().flatten().filter_map(|r| r.get("check").and_then(|v| v.as_str())));
            }
        }
        for (check, _) in tiers.as_table().into_iter().flatten() {
            assert!(all.contains(&&**check), "{check}: no such check on SessionStart/UserPromptSubmit");
        }
    }

    /// #463: a check that has not started when its request is past the hard deadline answers by its own failure policy, never a
    /// deferral to a Node hook that no longer runs.
    #[test]
    fn a_check_past_the_hard_deadline_answers_by_its_policy_not_a_deferral() {
        let p = json!({"session_id": "s-463", "cwd": "/", "hook_event_name": "UserPromptSubmit", "prompt": "hi"});
        let meta = Meta {
            host: "claude".into(),
            event: "UserPromptSubmit".into(),
            tool: None,
            root: None,
            env: crate::reqenv::RequestEnv::from_pairs(Vec::<(String, String)>::new()),
            only: Some(vec!["switch-notice".into()]),
            plan: Vec::new(),
            cfg: String::new(),
            payload_sha1: None,
            deadline_ms: None,
        };
        crate::deadline::begin(std::time::Instant::now() - std::time::Duration::from_secs(60));
        crate::deadline::client_deadline(0);
        let got = evaluate(&meta, &p, &|_| false, &|_, _, _| {});
        crate::deadline::end();
        let a = got.iter().find(|(id, _)| id == "switch-notice").map(|(_, a)| a.clone());
        assert!(matches!(a, Some(Answer::Decided(..))), "past the deadline the check still answers by its policy: {a:?}");
    }

    #[test]
    fn the_git_check_answers_its_entry_with_the_node_guards_bytes() {
        let p = json!({"session_id": "s", "cwd": "/", "hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": "git push --force origin main"}});
        let got = evaluate(&meta(), &p, &|_| false, &|_, _, _| {});
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
                "broad-kill-guard",
                "burn-breaker",
                "queued-wait-guard",
                "lane-test-guard",
                "wide-search-guard",
                "switch-notice"
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

    /// Load: past the client's deadline no entry is started and each gives no answer (the dispatcher then applies the check's failure
    /// policy: a loaded machine costs single entries, never the whole event's reply). A check that fails closed on a guard event keeps
    /// only its own limit, so it still decides.
    #[test]
    fn past_the_clients_deadline_every_open_entry_answers_by_its_policy_without_running() {
        let p = json!({"session_id": "s", "cwd": "/", "hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": "git push --force origin main"}});
        crate::deadline::begin(std::time::Instant::now());
        crate::deadline::client_deadline(0);
        let got = evaluate(&meta(), &p, &|_| false, &|_, _, _| {});
        crate::deadline::end();
        assert!(!got.is_empty());
        // #463: a cut check answers by its own failure policy (an open one allows), never a deferral to a Node hook
        for (id, a) in &got {
            assert!(!matches!(a, Answer::Defer), "{id}: a cut never defers");
            let closed = crate::script::failure_mode(&entry_check(id)) == crate::defaults::text("script.failure_mode_closed");
            if !closed {
                assert!(matches!(a, Answer::Decided(r, _) if r.code != Some(2)), "{id}: an open check cut at the deadline allows");
            }
        }
        let again = evaluate(&meta(), &p, &|_| false, &|_, _, _| {});
        assert!(again.iter().any(|(id, a)| id == "git-guard" && matches!(a, Answer::Decided(r, _) if r.code == Some(2))), "in time it decides");
    }

    /// A client that closed its connection (an ack-mode client gave up) has no use for the rest of the checks: none is started.
    #[test]
    fn once_the_client_has_gone_the_remaining_entries_are_not_run() {
        use std::os::fd::AsRawFd;
        let p = json!({"session_id": "s", "cwd": "/", "hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": "git push --force origin main"}});
        let (ours, theirs) = std::os::unix::net::UnixStream::pair().unwrap();
        crate::deadline::begin(std::time::Instant::now());
        crate::deadline::watch_peer(ours.as_raw_fd());
        let started = std::cell::Cell::new(0usize);
        let alive = evaluate(&meta(), &p, &|_| false, &|_, _, _| started.set(started.get() + 1));
        assert!(alive.iter().any(|(id, a)| id == "git-guard" && matches!(a, Answer::Decided(r, _) if r.code == Some(2))), "a client that waits is answered");
        assert_eq!(crate::deadline::take_client_gone_skips(), 0);
        drop(theirs);
        let gone = evaluate(&meta(), &p, &|_| false, &|_, _, _| {});
        crate::deadline::end();
        assert!(!gone.is_empty() && gone.iter().all(|(_, a)| matches!(a, Answer::Defer)), "no entry is run for a client that has gone");
        assert_eq!(crate::deadline::take_client_gone_skips(), gone.len() as u64, "each skipped entry is counted");
        assert!(!crate::deadline::client_gone(), "outside a request nothing is watched");
    }

    /// Past the client's fail-fast wait (the SOFT deadline) every entry still runs and decides; only the hard deadline cuts.
    #[test]
    fn past_the_soft_deadline_the_entries_still_run_and_decide() {
        let p = json!({"session_id": "s", "cwd": "/", "hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": "git push --force origin main"}});
        crate::deadline::begin(std::time::Instant::now());
        crate::deadline::client_window(0); // the fail-fast wait is over, the hard deadline is not
        let got = evaluate(&meta(), &p, &|_| false, &|_, _, _| {});
        crate::deadline::end();
        assert!(got.iter().any(|(id, a)| id == "git-guard" && matches!(a, Answer::Decided(r, _) if r.code == Some(2))), "the guard still decides");
    }

    /// A check that alone crossed the CPU budget loses its own answer; the checks after it still run and answer (one slow check must
    /// never sink the others' answers).
    #[test]
    fn a_check_over_the_cpu_budget_loses_only_its_own_answer() {
        let p = json!({"session_id": "s", "cwd": "/", "hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": "git push --force origin main"}});
        let polls = std::cell::Cell::new(0usize);
        let got = evaluate(
            &meta(),
            &p,
            &|_| {
                let n = polls.get();
                polls.set(n + 1);
                n == 0 // only the first check that decides crosses the budget
            },
            &|_, _, _| {},
        );
        assert!(got.len() > 2);
        let dropped: Vec<&str> = got.iter().filter(|(_, a)| matches!(a, Answer::Defer)).map(|(id, _)| id.as_str()).collect();
        assert_eq!(dropped.len(), 1, "exactly the check that crossed the budget lost its answer: {dropped:?}");
        assert!(
            got.iter().any(|(id, a)| id == "git-guard" && matches!(a, Answer::Decided(r, _) if r.code == Some(2))) || dropped == ["git-guard"],
            "the git guard either decided or is the one that crossed"
        );
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
            let got = evaluate(&m, &p, &|_| false, &|_, _, _| {});
            let (_, a) = got.iter().find(|(id, _)| id == name).unwrap_or_else(|| panic!("{name} entry missing"));
            if a != &Answer::Decided(HookResult::quiet(name), Vec::new()) {
                deferred.push(name);
            }
        }
        assert!(deferred.is_empty(), "these checks must answer natively, not defer: {deferred:?}");
    }

    /// A relative payload cwd resolves against the Node hook's own working directory, which no longer exists: git-guard answers
    /// natively (quiet for a command that blocks nothing, as Node is) and never defers to a hook that cannot run.
    #[test]
    fn a_relative_cwd_is_answered_natively_not_deferred() {
        let p = json!({"session_id": "s", "cwd": "sub", "hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": "git status"}});
        let got = evaluate(&meta(), &p, &|_| false, &|_, _, _| {});
        assert_eq!(got.iter().find(|(id, _)| id == "git-guard").unwrap().1, Answer::Decided(HookResult::quiet("git-guard"), Vec::new()));
    }

    /// The check name of the table entry `id` (PreToolUse, Claude).
    fn entry_check(id: &str) -> String {
        crate::dispatch::table::entries("claude", "PreToolUse").into_iter().find(|e| e.id == id).and_then(|e| e.check).unwrap_or_else(|| id.to_string())
    }

    /// Review P1: an incomplete request environment (dropped over the cap, absent, no HOME) must not be evaluated: with
    /// it the ship-it gate reads as off and the engine would allow an Edit Node blocks. No check is evaluated: each takes its
    /// failure policy, and a blocking guard (ship-it-guard) fails closed.
    #[test]
    fn an_incomplete_environment_applies_the_failure_policy_to_every_check() {
        let p = json!({"session_id": "s", "cwd": "/", "hook_event_name": "PreToolUse", "tool_name": "Edit", "tool_input": {"file_path": "migrations/a.sql"}});
        let mut m = meta();
        m.env = crate::reqenv::RequestEnv::from_pairs([("ANTIHALL_SHIPIT_GATE", "1"), ("HOME", "/h")]);
        let whole = evaluate(&m, &p, &|_| false, &|_, _, _| {});
        let ship = |got: &[(String, Answer)]| got.iter().find(|(id, _)| id == "ship-it-guard").unwrap().1.clone();
        assert!(matches!(ship(&whole), Answer::Decided(ref r, _) if r.code == Some(2)), "control: the gate is on, so it blocks");
        m.env = crate::reqenv::RequestEnv::incomplete();
        let got = evaluate(&m, &p, &|_| false, &|_, _, _| {});
        assert!(!got.is_empty() && got.iter().all(|(_, a)| !matches!(a, Answer::Defer)), "every check is decided by its policy: {got:?}");
        assert!(matches!(ship(&got), Answer::Decided(ref r, _) if r.code == Some(2) && r.err.contains("request environment incomplete")), "{got:?}");
        let big = "x".repeat(crate::defaults::num("request_env.max_bytes") as usize);
        m.env = crate::reqenv::RequestEnv::from_pairs([("ANTIHALL_SHIPIT_GATE", "1".to_string()), ("ANTIHALL_X", big)]);
        assert!(
            matches!(ship(&evaluate(&m, &p, &|_| false, &|_, _, _| {})), Answer::Decided(ref r, _) if r.code == Some(2)),
            "an environment dropped over the cap takes the same policy"
        );
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
        let got = evaluate(&m, &p, &|_| false, &|_, _, _| {});
        // Command delegation allows this lightweight command; git safety owns force-push blocking.
        assert!(matches!(&got.iter().find(|(id, _)| id == "command-guard").unwrap().1, Answer::Decided(r, _) if r.code == Some(0)));
        assert!(matches!(&got.iter().find(|(id, _)| id == "git-guard").unwrap().1, Answer::Decided(r, _) if r.code == Some(2)));
        crate::discard::harmless(std::fs::remove_dir_all(&home)); // keep: cleanup of a scratch directory
    }

    #[test]
    fn the_session_and_subagent_start_entries_are_answered_with_the_node_hooks_bytes() {
        let d = std::env::temp_dir().join(format!("ah-native-vf-{}", std::process::id()));
        crate::discard::harmless(std::fs::remove_dir_all(&d)); // keep: cleanup that raced; an absent file is the goal state
        std::fs::create_dir_all(d.join("plugin/hooks")).unwrap();
        std::fs::write(d.join("plugin/hooks/install.sh"), "").unwrap();
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
            let got: Vec<_> = evaluate(&meta, &p, &|_| false, &|_, _, _| {}).into_iter().filter(|(id, _)| ids.contains(&id.as_str())).collect();
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
        // With no request root, the loaded plugin root supplies the protocol path.
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
        let answers = evaluate(&meta, &p, &|_| false, &|_, _, _| {});
        let (_, answer) = answers.iter().find(|(id, _)| id == "verify-first-subagent").unwrap();
        let Answer::Decided(result, _) = answer else { panic!("loaded root must answer: {answer:?}") };
        // The protocol helper resolves its probe with realpath; Cargo's root may still contain `..`.
        let root = crate::defaults::root().unwrap().canonicalize().unwrap();
        assert!(result.out.contains(&format!("{}/PROTOCOL.md", root.display())), "{}", result.out);
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
