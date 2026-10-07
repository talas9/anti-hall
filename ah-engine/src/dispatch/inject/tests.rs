use super::*;
use crate::gate::Gate;

fn out(ctx: &str) -> String {
    format!("{}\n", serde_json::json!({"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": ctx}}))
}

fn res(id: &str, ctx: &str) -> HookResult {
    HookResult { id: id.into(), code: Some(0), out: out(ctx), err: String::new() }
}

fn env(extra: &[(&str, &str)]) -> RequestEnv {
    let mut pairs = vec![("HOME", "/nonexistent-ah-home")];
    pairs.extend_from_slice(extra);
    RequestEnv::from_pairs(pairs)
}

/// A session driven turn by turn against its own gate, the way the daemon would.
struct Sim {
    gate: Gate,
    sid: String,
}

impl Sim {
    fn new(sid: &str) -> Sim {
        Sim { gate: Gate::new(), sid: sid.into() }
    }

    fn turn(&self) {
        self.gate.turn(&self.sid);
    }

    fn run(&self, event: &str, agent: &str, env: &RequestEnv, results: &mut [HookResult]) {
        let mut p = serde_json::json!({"session_id": self.sid, "hook_event_name": event});
        if !agent.is_empty() {
            p["agent_id"] = agent.into();
        }
        apply_with(event, &p, env, results, &|sid, agent, reset, qs| {
            if reset {
                self.gate.reset(sid);
            }
            qs.iter().map(|q| self.gate.decide(sid, agent, q)).collect()
        });
    }

    /// One prompt turn of one hook's output: what the model is shown.
    fn ups(&self, env: &RequestEnv, id: &str, ctx: &str) -> String {
        self.turn();
        let mut r = vec![res(id, ctx)];
        self.run("UserPromptSubmit", "", env, &mut r);
        crate::dispatch::combine::context_of(&r[0].out).unwrap_or_default()
    }
}

fn limit_text(reset: &str, reason: &str) -> String {
    format!(
        "⚠️ anti-hall · limit-conserve: limit conservation is active ({reason}).\nWhy: Usage is near a plan limit.\nDo instead: route execution to Codex (codex:codex-rescue, separate limit) and cheap Claude; keep the MAIN agent on Claude and send hard reasoning to subagents; if Codex is unavailable or rate-limited degrade to Sonnet, never retry-loop (backoff). Defer non-urgent heavy work until reset at {reset}. Main-model downshift: if the main agent is on the flagship model, switch it to the cheaper 1M-context variant to preserve the flagship weekly bucket. NEVER downshift to a smaller-context model. Keep the flagship for delegated hard-reasoning subagents and on-demand escalation. The agent cannot self-switch models (/model is a user action), so SURFACE this recommendation to the user."
    )
}

#[test]
fn limit_a_jittering_reset_time_is_the_same_directive_until_the_band_or_window_changes() {
    let (sim, e) = (Sim::new("s1"), env(&[]));
    let first = limit_text("2026-10-07T06:59:59.957Z", "weekly");
    assert_eq!(sim.ups(&e, "limit-conserve-inject", &first), first, "first injection of the session");
    for ms in ["07:00:00.295", "06:59:59.679", "07:00:00.367"] {
        assert_eq!(sim.ups(&e, "limit-conserve-inject", &limit_text(&format!("2026-10-07T{ms}Z"), "weekly")), "", "{ms}: unchanged, suppressed");
    }
    let band = limit_text("2026-10-07T07:00:00.001Z", "five-hour+weekly");
    assert_eq!(sim.ups(&e, "limit-conserve-inject", &band), band, "the usage band changed");
    let next_window = limit_text("2026-10-14T07:00:00.001Z", "five-hour+weekly");
    assert_eq!(sim.ups(&e, "limit-conserve-inject", &next_window), next_window, "a different reset window");
}

#[test]
fn limit_an_unchanged_directive_comes_back_short_every_n_turns() {
    let (sim, e) = (Sim::new("s1"), env(&[("ANTIHALL_INJECT_GATE_LIMIT_EVERY", "3")]));
    let t = limit_text("2026-10-07T07:00:00.000Z", "weekly");
    let seen: Vec<String> = (0..7).map(|_| sim.ups(&e, "limit-conserve-inject", &t)).collect();
    let keep = defaults::text("inject_gate.limit_keepalive");
    assert_eq!(seen[0], t);
    assert_eq!(&seen[1..], ["", "", keep, "", "", keep]);
    assert!(keep.len() < t.len() / 2, "the keepalive is the short form");
}

#[test]
fn after_compaction_and_in_a_new_session_the_block_is_whole_again() {
    let (sim, e) = (Sim::new("s1"), env(&[]));
    let t = limit_text("2026-10-07T07:00:00.000Z", "weekly");
    assert_eq!(sim.ups(&e, "limit-conserve-inject", &t), t);
    assert_eq!(sim.ups(&e, "limit-conserve-inject", &t), "");
    // a SessionStart dispatch (compaction) clears the session
    sim.run("SessionStart", "", &e, &mut []);
    assert_eq!(sim.ups(&e, "limit-conserve-inject", &t), t, "re-injected after compaction");
    // another session has its own memory
    let other = Sim { gate: Gate::new(), sid: "s2".into() };
    assert_eq!(other.ups(&e, "limit-conserve-inject", &t), t, "new session");
}

#[test]
fn a_cut_that_is_off_hands_the_node_bytes_through_untouched() {
    let t = limit_text("2026-10-07T07:00:00.000Z", "weekly");
    for off in [("ANTIHALL_INJECT_GATE_LIMIT", "0"), ("ANTIHALL_INJECT_GATE", "0")] {
        let (sim, e) = (Sim::new("s1"), env(&[off]));
        for _ in 0..3 {
            sim.turn();
            let mut r = vec![res("limit-conserve-inject", &t)];
            let before = r[0].out.clone();
            sim.run("UserPromptSubmit", "", &e, &mut r);
            assert_eq!(r[0].out, before, "{off:?}: byte for byte");
        }
    }
}

#[test]
fn a_hook_that_is_not_gated_or_prints_no_context_is_left_alone() {
    let (sim, e) = (Sim::new("s1"), env(&[]));
    sim.turn();
    let mut r = vec![
        res("verify-first", "some reminder"),
        HookResult { id: "task-tracker".into(), code: Some(0), out: "not json\n".into(), err: String::new() },
        HookResult { id: "limit-conserve-inject".into(), code: Some(2), out: out("x"), err: "blocked\n".into() },
        res("limit-conserve-inject", ""),
    ];
    let before: Vec<String> = r.iter().map(|x| x.out.clone()).collect();
    sim.run("UserPromptSubmit", "", &e, &mut r);
    assert_eq!(r.iter().map(|x| x.out.clone()).collect::<Vec<_>>(), before);
}

#[test]
fn task_the_long_form_always_passes_the_short_one_every_n_turns_the_note_when_it_changes() {
    let (sim, e) = (Sim::new("s1"), env(&[("ANTIHALL_INJECT_GATE_TASK_EVERY", "4")]));
    let long = format!("{} as a task (TaskCreate) before starting work.", defaults::text("inject_gate.task_long_prefix"));
    let short = defaults::text("inject_gate.task_short");
    assert_eq!(sim.ups(&e, "task-tracker", &long), long, "the long form, first turn");
    let seen: Vec<String> = (0..5).map(|_| sim.ups(&e, "task-tracker", short)).collect();
    assert_eq!(seen, ["", "", "", short, ""], "short form every 4 turns after the long one");
    // a freshness note: new text passes with the head's turn; an unchanged note is suppressed on its own count
    let note = "Open tasks: 2.";
    let with_note = format!("{short} {note}");
    assert_eq!(sim.ups(&e, "task-tracker", &with_note), note, "the head is not due, the new note passes");
    assert_eq!(sim.ups(&e, "task-tracker", &with_note), "", "unchanged note");
    let changed = format!("{short} Open tasks: 3.");
    assert_eq!(sim.ups(&e, "task-tracker", &changed), changed, "changed note (and the short reminder is due again by now)");
    // the DevSwarm Primary block after the reminder is never touched
    let primary = "DEVSWARM PRIMARY: top tier is a workspace.";
    assert_eq!(sim.ups(&e, "task-tracker", &format!("{short}\n\n{primary}")), primary);
    // a long form restarts the short reminder's count
    assert_eq!(sim.ups(&e, "task-tracker", &long), long);
    assert_eq!(sim.ups(&e, "task-tracker", short), "");
}

#[test]
fn comms_the_override_line_goes_once_per_session_and_when_changed() {
    let (sim, e) = (Sim::new("s1"), env(&[("ANTIHALL_INJECT_GATE_COMMS_EVERY", "5")]));
    let line = "💡 anti-hall · devswarm-comms: mesh only — native hivecontrol messaging blocked. Check: `roster`.";
    let live = "DEVSWARM WORKSPACES (refreshed every turn):\n| a | b |";
    let ctx = format!("{line}\n\n{live}");
    assert_eq!(sim.ups(&e, "devswarm-parent-inbox", &ctx), ctx, "first turn: everything");
    assert_eq!(sim.ups(&e, "devswarm-parent-inbox", &ctx), live, "the static line is dropped, the live table is not");
    let changed = format!("{line} Direct: `send --to <meshId>`.\n\n{live}");
    assert_eq!(sim.ups(&e, "devswarm-parent-inbox", &changed), changed, "a changed line is re-sent");
    for _ in 0..4 {
        assert_eq!(sim.ups(&e, "devswarm-parent-inbox", &changed), live);
    }
    assert_eq!(sim.ups(&e, "devswarm-parent-inbox", &changed), changed, "keepalive after 5 turns");
    // the child hook gates the same line, and a context with only the line becomes empty
    let child = Sim::new("c1");
    assert_eq!(child.ups(&e, "devswarm-child-turn", line), line);
    assert_eq!(child.ups(&e, "devswarm-child-turn", line), "");
}

#[test]
fn swarm_the_shared_tree_advisory_repeats_only_when_changed_or_due_and_other_advisories_pass() {
    let (sim, e) = (Sim::new("s1"), env(&[("ANTIHALL_INJECT_GATE_SWARM_EVERY", "4")]));
    let adv = "⚠️ anti-hall · shared-tree: another write-capable agent is still running in this working tree.\nWhy: x";
    let run = |sim: &Sim, agent: &str, ctx: &str| {
        sim.turn();
        let mut r = vec![HookResult {
            id: "swarm-guard".into(),
            code: Some(0),
            out: format!("{}\n", serde_json::json!({"hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": ctx}})),
            err: String::new(),
        }];
        sim.run("PreToolUse", agent, &e, &mut r);
        crate::dispatch::combine::context_of(&r[0].out).unwrap_or_default()
    };
    assert_eq!(run(&sim, "", adv), adv);
    assert_eq!(run(&sim, "", adv), "");
    assert_eq!(run(&sim, "agent-7", adv), adv, "a subagent holds its own context");
    assert_eq!(run(&sim, "", adv), "");
    assert_eq!(run(&sim, "", adv), adv, "due again after 4 turns");
    assert_eq!(run(&sim, "", "some other advisory"), "some other advisory");
    assert_eq!(run(&sim, "", "some other advisory"), "some other advisory", "not the shared-tree advisory: never gated");
}

#[test]
fn a_rewritten_output_keeps_the_hooks_key_order_and_its_other_fields() {
    let (sim, e) = (Sim::new("s1"), env(&[]));
    let t = limit_text("2026-10-07T07:00:00.000Z", "weekly");
    let raw = format!(
        "{{\"systemMessage\":\"m\",\"hookSpecificOutput\":{{\"hookEventName\":\"UserPromptSubmit\",\"additionalContext\":{}}}}}\n",
        serde_json::Value::String(t.clone())
    );
    for i in 0..2 {
        sim.turn();
        let mut r = vec![HookResult { id: "limit-conserve-inject".into(), code: Some(0), out: raw.clone(), err: String::new() }];
        sim.run("UserPromptSubmit", "", &e, &mut r);
        if i == 1 {
            assert_eq!(r[0].out, "{\"systemMessage\":\"m\",\"hookSpecificOutput\":{\"hookEventName\":\"UserPromptSubmit\",\"additionalContext\":\"\"}}\n");
        } else {
            assert_eq!(r[0].out, raw, "the first injection is the hook's own bytes");
        }
    }
}

#[test]
fn no_session_id_or_an_unanswering_gate_passes_everything_on() {
    let e = env(&[]);
    let t = limit_text("2026-10-07T07:00:00.000Z", "weekly");
    let mut r = vec![res("limit-conserve-inject", &t)];
    apply_with("UserPromptSubmit", &serde_json::json!({"hook_event_name": "UserPromptSubmit"}), &e, &mut r, &|_, _, _, _| panic!("no session: no question"));
    assert_eq!(crate::dispatch::combine::context_of(&r[0].out).as_deref(), Some(t.as_str()));
    // the daemon is down: `ask` answers Emit for every question
    assert!(parse_reply("not json").is_none());
    assert_eq!(
        parse_reply(&encode_reply(&[Decision::Emit, Decision::Suppress, Decision::Keepalive])),
        Some(vec![Decision::Emit, Decision::Suppress, Decision::Keepalive])
    );
}

#[test]
fn the_wire_form_of_a_question_round_trips() {
    let q = Query { slot: "a".into(), cut: "limit".into(), hash: "0123456789abcdef".into(), len: 10, keep_len: 4, every: 7, force: true };
    assert_eq!(read_query(&wire_query(&q)), Some(q));
    assert_eq!(read_query(&serde_json::json!({"k": "a"})), None);
}
