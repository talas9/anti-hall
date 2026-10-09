//! Parity of the `task-guard` fire paths against `hooks/task-guard.js` (Stop): the Stops with an open task. Covered: the
//! generic block (list, tail, unknown subjects, sanitising, Codex wording, honest blockers, owner markers), the idle-neglect
//! block (labels, the per-task cover by running agents, the proven count with stale and pre-task agents, the cap, the legacy
//! heartbeat rule, the priority floor, its metrics counter), the loop state (hash dedupe, block cap, legacy and odd state
//! files, a state file that cannot be written), the OMC and live-agent steps aside, the per-prompt budget, and the unknown-state
//! note on a block. Compared: exit code, stdout, stderr and the whole file tree. The scenarios the engine must answer are listed
//! as `must`; the ones that need the DevSwarm app database must defer.
//!
//! The CPU-based parallel cap is read exactly only on macOS (and on Linux without a CPU quota), so off macOS a scenario that
//! needs it may defer.

use super::fx::*;
use super::fx_tasklines::*;
use super::jsjson::J;
use super::support::*;
use std::cell::RefCell;
use std::collections::BTreeSet;

fn stop(tp: &str, extra: &[(&str, J)]) -> J {
    let mut p = jo! {"hook_event_name": "Stop", "session_id": "sess-1", "cwd": "$PROJ", "transcript_path": tp, "stop_hook_active": false};
    for (k, v) in extra {
        p.set(k, v.clone());
    }
    p
}

/// A running background agent as compaction re-injects it (a `task_status` attachment), launched at `ms`.
fn agent(id: &str, desc: &str, ms: i64) -> String {
    jo! {"type": "attachment", "timestamp": iso_from_ms(ms), "attachment": jo! {"type": "task_status", "taskId": id, "status": "running", "description": desc}}
        .text()
}

/// A real user prompt with a uuid (the budget's prompt key).
fn prompt(uuid: &str, text: &str, ms: i64) -> String {
    jo! {"type": "user", "uuid": uuid, "timestamp": iso_from_ms(ms), "message": jo! {"role": "user", "content": text}}.text()
}

pub(crate) fn corpus() -> (Vec<Scenario>, Scratch, BTreeSet<String>) {
    let tl = Tl::new();
    let shared = Scratch::new("tgf-shared");
    let out: RefCell<Vec<Scenario>> = RefCell::new(Vec::new());
    let must: RefCell<BTreeSet<String>> = RefCell::new(BTreeSet::new());
    let mac = cfg!(target_os = "macos");
    let put = |name: &str, lines: &[String]| -> String {
        let f = shared.path().join(format!("{name}.jsonl"));
        write_file(&f, format!("{}\n", lines.join("\n")).as_bytes());
        f.to_string_lossy().to_string()
    };
    // `cap`: the answer needs the CPU-based cap (exact on macOS only); the engine must answer elsewhere too when false.
    let add = |sc: Scenario, needs_cap: bool| {
        if !needs_cap || mac {
            must.borrow_mut().insert(sc.id.clone());
        }
        out.borrow_mut().push(sc);
    };
    let one = |id: &str, tp: &str, world: &World, env: &[(&str, &str)], needs_cap: bool| {
        let mut st = Step::payload(stop(tp, &[]));
        for (k, v) in env {
            st = st.env(k, v);
        }
        add(Scenario::new(id, world.clone(), vec![st]), needs_cap);
    };
    let w = World::new().git("proj");
    let now = now_ms() as i64;
    let c = |n: i64, s: &str| tl.create(n, jo! {"subject": s});
    let cx = |n: i64, input: J| tl.create(n, input);
    let u = |n: i64, extra: Vec<(&str, J)>| tl.update(n, extra);
    let status = |s: &str| vec![("status", J::from(s))];
    let wip = |n: i64, s: &str| cat(vec![c(n, s), u(n, status("in_progress"))]);

    // ---- generic block (no task can be dispatched now: in progress, owned, low priority)
    let g1 = put("g1", &wip(1, "write the parser"));
    one("generic-one-in-progress", &g1, &w, &[], false);
    let g_many = put("g-many", &(1..=8).flat_map(|i| wip(i, &format!("task {i}"))).collect::<Vec<_>>());
    one("generic-more-than-five", &g_many, &w, &[], false);
    let g_unknown = put("g-unknown", &cat(vec![u(7, status("in_progress")), wip(1, "known")]));
    one("generic-subject-unknown", &g_unknown, &w, &[], false);
    let long = format!("a \"quoted\"\tsubject\u{7}with control and {} end", "x".repeat(80));
    let g_long = put("g-long", &wip(1, &long));
    one("generic-sanitised-subject", &g_long, &w, &[], false);
    let g_status = put("g-status", &cat(vec![c(1, "x"), u(1, status("In-Progress"))]));
    one("generic-status-case", &g_status, &w, &[], false);
    let g_emoji = put("g-emoji", &wip(1, &format!("{}\u{1f600}tail", "y".repeat(59))));
    one("generic-cut-through-emoji", &g_emoji, &w, &[], false);
    // an emoji cut at 60 units: Node keeps a lone surrogate; the engine must defer, never print something else
    must.borrow_mut().remove("generic-cut-through-emoji");
    let g_owned = put("g-owned", &cx(1, jo! {"subject": "owned work", "owner": "agent-7"}));
    one("generic-owned-pending", &g_owned, &w, &[], false);
    let g_low = put("g-low", &cx(1, jo! {"subject": "later", "metadata": jo! {"priority": "P2"}}));
    one("generic-low-priority", &g_low, &w, &[], false);
    one("idle-priority-floor-p3", &g_low, &w, &[("ANTIHALL_IDLE_NEGLECT_MIN_PRIORITY", "p3")], true);
    let g_lowword = put("g-lowword", &cx(1, jo! {"subject": "someday", "priority": "low"}));
    one("generic-low-word", &g_lowword, &w, &[], false);
    let codex = |id: &str, tp: &str, extra: &[(&str, J)]| add(Scenario::new(id, w.clone(), vec![Step::payload(stop(tp, extra))]), false);
    codex("generic-codex-wording", &g1, &[("turn_id", J::from("t-1")), ("model", J::from("gpt-5"))]);
    codex("generic-codex-apply-patch", &g1, &[("tool_name", J::from("apply_patch"))]);
    codex("generic-codex-turn-only", &g1, &[("turn_id", J::from("t-1"))]);
    // honest blockers: 2 waits on 1 (both in progress): only 1 is listed; a blocker that is not open does not count
    let g_chain = put("g-chain", &cat(vec![wip(1, "first"), wip(2, "second"), u(2, vec![("addBlockedBy", ja!["1"])])]));
    one("generic-honest-chain", &g_chain, &w, &[], false);
    let g_cycle = put("g-cycle", &cat(vec![wip(1, "a"), wip(2, "b"), u(1, vec![("addBlockedBy", ja!["2"])]), u(2, vec![("addBlockedBy", ja!["1"])])]));
    one("generic-blocker-cycle", &g_cycle, &w, &[], false);
    let g_ghost = put("g-ghost", &cat(vec![c(1, "waits on a ghost"), u(1, vec![("addBlockedBy", ja!["99"])])]));
    one("generic-unknown-blocker", &g_ghost, &w, &[], false);
    // owner markers: all waiting on the owner -> quiet; the switch off -> they count again
    let g_owner = put("g-owner", &cat(vec![cx(1, jo! {"subject": "buy hardware", "metadata": jo! {"blockedOn": "owner"}}), c(2, "OWNER: decide the name")]));
    one("owner-marked-quiet", &g_owner, &w, &[], false);
    one("owner-marker-off", &g_owner, &w, &[("ANTIHALL_TASK_GUARD_OWNER_BLOCKED_MARKER", "false")], true);
    let g_ws = put("g-ws", &cat(vec![cx(1, jo! {"subject": "in a workspace", "owner": "workspace: feat-x"}), u(1, status("in_progress"))]));
    one("owner-workspace-no-app-db", &g_ws, &w, &[], false);
    // the DevSwarm app database exists: the answer needs node:sqlite, the engine defers
    let db = shared.path().join("devswarm.db");
    write_file(&db, b"not a database");
    let mut sc =
        Scenario::new("owner-workspace-app-db", w.clone(), vec![Step::payload(stop(&g_ws, &[])).env("ANTIHALL_DEVSWARM_APP_DB", &db.to_string_lossy())]);
    sc.expect_defer = true;
    out.borrow_mut().push(sc);
    one("owner-workspace-app-db-off", &g_ws, &w, &[("ANTIHALL_DEVSWARM_APP_DB", "off")], false);
    let g_main = put("g-main", &cx(1, jo! {"subject": "mine", "owner": " Main "}));
    one("owner-main-is-unowned", &g_main, &w, &[], true);

    // ---- idle neglect (dispatchable tasks, no running agent covers them)
    let i1 = put("i1", &c(1, "dispatch me"));
    one("idle-one", &i1, &w, &[], true);
    let i_many = put("i-many", &(1..=14).flat_map(|i| c(i, &format!("P1: job number {i} {}", "z".repeat(if i == 3 { 50 } else { 0 })))).collect::<Vec<_>>());
    one("idle-fourteen-labels", &i_many, &w, &[], true);
    let i_todo = put("i-todo", &tl.todo(ja![jo! {"content": "todo item", "status": "pending"}, jo! {"content": "done item", "status": "completed"}]));
    one("idle-todowrite-label", &i_todo, &w, &[], true);
    let i_mixed = put("i-mixed", &cat(vec![c(1, "pending one"), wip(2, "working")]));
    one("idle-mixed", &i_mixed, &w, &[], true);
    one("idle-max-parallel-env", &i1, &w, &[("ANTIHALL_MAX_PARALLEL_DISPATCH", "3")], false);
    one("idle-max-parallel-file", &i1, &World::new().file("home/.anti-hall/settings.json", "{\"guards\":{\"maxParallelDispatch\":2.7}}"), &[], false);
    // legacy rule (dispatchDemand off): no heartbeat -> sharp block naming the formula; a fresh heartbeat -> the generic block steps aside
    one("idle-legacy", &i1, &w, &[("ANTIHALL_DISPATCH_DEMAND", "off")], false);
    let hb = |body: &str| World::new().git("proj").file("home/.anti-hall/agents/a1.json", body);
    one("legacy-heartbeat-fresh", &i1, &hb(&format!("{{\"ts\":{now}}}")), &[("ANTIHALL_DISPATCH_DEMAND", "0")], false);
    one("legacy-heartbeat-stale", &i1, &hb(&format!("{{\"ts\":{}}}", now - 3_600_000)), &[("ANTIHALL_DISPATCH_DEMAND", "0")], false);
    one("legacy-heartbeat-mtime", &i1, &hb("{}"), &[("ANTIHALL_DISPATCH_DEMAND", "0")], false);
    one("legacy-heartbeat-garbage", &i1, &hb("not json"), &[("ANTIHALL_DISPATCH_DEMAND", "0")], false);
    // live agents with the generic block: the advisory line instead
    one("live-agents-generic", &g1, &hb(&format!("{{\"ts\":{now}}}")), &[], false);
    one("live-agents-other-ext", &g1, &World::new().git("proj").file("home/.anti-hall/agents/a1.txt", "x"), &[], false);

    // ---- running agents of this session (per-task cover, proven count)
    let a_mapped = put("a-mapped", &cat(vec![c(1, "covered"), vec![agent("ag1", "#1 do the covered task", now)]]));
    one("agent-mapped-covers", &a_mapped, &w, &[], true);
    let a_ref_other = put("a-ref-other", &cat(vec![c(1, "uncovered"), vec![agent("ag1", "work on #12a and #77", now)]]));
    one("agent-ref-unknown-task", &a_ref_other, &w, &[], true);
    let a_fresh = put("a-fresh", &cat(vec![c(1, "maybe covered"), vec![agent("ag1", "unmapped helper", now)]]));
    one("agent-unmapped-fresh", &a_fresh, &w, &[], true);
    one("agent-unmapped-fresh-estimate", &a_fresh, &w, &[("ANTIHALL_IDLE_NEGLECT_PROVEN_ONLY", "false")], true);
    one("agent-unmapped-cap-one", &a_fresh, &w, &[("ANTIHALL_MAX_PARALLEL_DISPATCH", "1")], false);
    let a_stale = put("a-stale", &cat(vec![c(1, "stale cover"), vec![agent("ag1", "old helper", now - 7_200_000)]]));
    one("agent-unmapped-stale", &a_stale, &w, &[], true);
    one("agent-unmapped-stale-no-age", &a_stale, &w, &[("ANTIHALL_IDLE_NEGLECT_AGENT_MAX_AGE_MIN", "0")], true);
    let a_before = put("a-before", &cat(vec![vec![agent("ag1", "early helper", 1_791_000_000_000)], c(1, "made after the agent")]));
    one("agent-before-task-no-age", &a_before, &w, &[("ANTIHALL_IDLE_NEGLECT_AGENT_MAX_AGE_MIN", "0")], true);
    let a_two = put("a-two", &cat(vec![c(1, "one"), c(2, "two"), vec![agent("ag1", "helper", now)]]));
    one("agent-unmapped-two-tasks", &a_two, &w, &[], true);
    let a_inprog = put("a-inprog", &cat(vec![c(1, "pending"), wip(2, "busy"), vec![agent("ag1", "helper", now)]]));
    one("agent-unmapped-in-progress", &a_inprog, &w, &[("ANTIHALL_IDLE_NEGLECT_PROVEN_ONLY", "0")], true);

    // ---- loop state: dedupe, cap, legacy and odd files
    let seq = |id: &str, world: &World, steps: Vec<Step>, needs_cap: bool| add(Scenario::new(id, world.clone(), steps), needs_cap);
    seq("repeat-generic", &w, vec![Step::payload(stop(&g1, &[])), Step::payload(stop(&g1, &[])), Step::payload(stop(&g_many, &[]))], false);
    seq("repeat-idle", &w, vec![Step::payload(stop(&i1, &[])), Step::payload(stop(&i1, &[])), Step::payload(stop(&i_mixed, &[]))], true);
    let sets: Vec<String> = (1..=7).map(|k| put(&format!("cap{k}"), &(1..=k).flat_map(|i| wip(i, &format!("t{i}"))).collect::<Vec<_>>())).collect();
    seq("block-cap", &w, sets.iter().map(|t| Step::payload(stop(t, &[]))).collect(), false);
    let st_file = "home/.anti-hall/last-stop-taskset-sess-1";
    for (id, body) in [
        ("state-blocks-4", "{\"hash\":\"x\",\"blocks\":4}"),
        ("state-blocks-5", "{\"hash\":\"x\",\"blocks\":5}"),
        ("state-blocks-frac", "{\"hash\":\"x\",\"blocks\":2.5}"),
        ("state-blocks-string", "{\"hash\":\"x\",\"blocks\":\"4\"}"),
        ("state-hash-number", "{\"hash\":5,\"blocks\":1}"),
        ("state-legacy-bare", "  0123abcd  \n"),
        ("state-array", "[1,2]"),
        ("state-null", "null"),
        ("state-number", "7"),
        ("state-broken", "{\"hash\":"),
        ("state-empty", ""),
        ("state-big-blocks", "{\"blocks\":1e400}"),
    ] {
        one(id, &g1, &World::new().git("proj").file(st_file, body), &[], false);
    }
    // a number past the double range: JavaScript reads Infinity, serde refuses it; the engine hands it over
    must.borrow_mut().remove("state-big-blocks");
    // the stored hash equals this set's hash (a legacy bare hash): quiet
    one("state-legacy-same-hash", &g1, &World::new().git("proj").file(st_file, &sha1_hex("1")), &[], false);
    one("state-file-is-dir", &g1, &World::new().git("proj").dir(st_file), &[], false);
    one("state-dir-read-only", &g1, &World::new().git("proj").file("home/.anti-hall/keep", "x").mode("home/.anti-hall", "555"), &[], false);

    // ---- the unknown-state note rides on a block; the pruning advisory comes first
    let unk = put("unk", &cat(vec![u(20, vec![("description", J::from("x"))]), wip(1, "known")]));
    seq("block-with-unknown-note", &w, vec![Step::payload(stop(&unk, &[])), Step::payload(stop(&unk, &[]))], false);
    let pr =
        put("prune-open", &cat(vec![(1..=11).flat_map(|i| cat(vec![c(i, &format!("d{i}")), u(i, status("completed"))])).collect(), wip(12, "still open")]));
    one("prune-advisory-and-block", &pr, &w, &[], false);
    one(
        "prune-advisory-and-idle",
        &put("prune-idle", &cat(vec![(1..=11).flat_map(|i| cat(vec![c(i, &format!("d{i}")), u(i, status("done"))])).collect(), c(12, "go")])),
        &w,
        &[],
        true,
    );

    // ---- metrics of the idle-neglect block
    let mf = "home/.anti-hall/dispatch-demand-metrics.json";
    for (id, body) in [
        ("metrics-existing", "{\"demandsShown\":3,\"10\":1,\"pending\":{\"s\":{\"ts\":1,\"n\":2}},\"idleNeglectBlocks\":4,\"extra\":[1]}"),
        ("metrics-bad-counters", "{\"demandsShown\":-1,\"demandsFollowed\":\"2\",\"idleNeglectBlocks\":1.5,\"pending\":null}"),
        ("metrics-garbage", "garbage"),
        ("metrics-number", "42"),
    ] {
        one(id, &i1, &World::new().git("proj").file(mf, body), &[], true);
    }
    let mut sc = Scenario::new("metrics-array", World::new().git("proj").file(mf, "[1,2]"), vec![Step::payload(stop(&i1, &[]))]);
    sc.expect_defer = true;
    out.borrow_mut().push(sc);

    // ---- OMC loop: the Stop steps aside
    let omc_on = "{\"enabledPlugins\":{\"oh-my-claudecode@omc\":true}}";
    let fresh = format!("{{\"active\":true,\"updated_at\":{now}}}");
    let omc = |state_rel: &str, state: &str, settings_rel: &str| World::new().git("proj").file(settings_rel, omc_on).file(state_rel, state);
    let hs = "home/.claude/settings.json";
    one("omc-active", &g1, &omc("home/.omc/state/ralph-state.json", &fresh, hs), &[], false);
    one("omc-active-idle", &i1, &omc("home/.omc/state/team-state.json", &fresh, hs), &[], true);
    one("omc-killed", &g1, &omc("home/.omc/state/ralph-state.json", &fresh, hs), &[("DISABLE_OMC", "1")], false);
    one("omc-skip-persistent", &g1, &omc("home/.omc/state/ralph-state.json", &fresh, hs), &[("OMC_SKIP_HOOKS", "a, persistent-mode")], false);
    one("omc-not-enabled", &g1, &World::new().git("proj").file("home/.omc/state/ralph-state.json", &fresh), &[], false);
    one("omc-project-settings", &g1, &omc("proj/.omc/state/autopilot-state.json", &fresh, "proj/.claude/settings.local.json"), &[], false);
    one("omc-project-state-wins", &g1, &omc("home/.omc/state/ralph-state.json", &fresh, hs).dir("proj/.omc/state"), &[], false);
    one("omc-stale", &g1, &omc("home/.omc/state/ralph-state.json", &format!("{{\"active\":true,\"updated_at\":{}}}", now - 3 * 3_600_000), hs), &[], false);
    one(
        "omc-iso-time",
        &g1,
        &omc("home/.omc/state/ralph-state.json", &format!("{{\"active\":true,\"started_at\":\"{}\"}}", iso_from_ms(now - 60_000)), hs),
        &[],
        false,
    );
    one("omc-active-string", &g1, &omc("home/.omc/state/ralph-state.json", &format!("{{\"active\":\"true\",\"updated_at\":{now}}}"), hs), &[], false);
    one(
        "omc-same-session",
        &g1,
        &omc("home/.omc/state/ralph-state.json", &format!("{{\"active\":true,\"updated_at\":{now},\"session_id\":\"sess-1\"}}"), hs),
        &[],
        false,
    );
    one(
        "omc-other-session",
        &g1,
        &omc("home/.omc/state/ralph-state.json", &format!("{{\"active\":true,\"updated_at\":{now},\"session_id\":\"other\"}}"), hs),
        &[],
        false,
    );
    one("omc-broken-state", &g1, &omc("home/.omc/state/ralph-state.json", "{\"active\":", hs), &[], false);
    one(
        "omc-plugin-false",
        &g1,
        &World::new().git("proj").file(hs, "{\"enabledPlugins\":{\"oh-my-claudecode@omc\":\"true\"}}").file("home/.omc/state/ralph-state.json", &fresh),
        &[],
        false,
    );

    // ---- the per-prompt budget (lastAt is a clock value: compared with clock numbers masked)
    let b_lines = |k: i64| cat(vec![vec![prompt("u-1", "do things", now - 1000)], (1..=k).flat_map(|i| wip(i, &format!("b{i}"))).collect()]);
    let (b1, b2, b3) = (put("b1", &b_lines(1)), put("b2", &b_lines(2)), put("b3", &b_lines(3)));
    let bud = |id: &str, steps: Vec<Step>, world: &World| add(Scenario::new(id, world.clone(), steps).async_effects(), false);
    let be = |tp: &str, extra: &[(&str, J)], budget: &str| Step::payload(stop(tp, extra)).env("ANTIHALL_STOP_NAG_BUDGET", budget);
    bud("budget-uuid-key", vec![be(&b1, &[], "1"), be(&b2, &[], "1"), be(&b3, &[], "2")], &w);
    bud(
        "budget-prompt-id",
        vec![be(&b1, &[("prompt_id", J::from("p-9"))], "2"), be(&b2, &[("prompt_id", J::from("p-9"))], "2"), be(&b3, &[("prompt_id", J::from("p-9"))], "2")],
        &w,
    );
    bud("budget-new-prompt", vec![be(&b1, &[("prompt_id", J::from("p-1"))], "1"), be(&b2, &[("prompt_id", J::from("p-2"))], "1")], &w);
    bud("budget-no-key", vec![be(&g1, &[], "1"), be(&g_many, &[], "1")], &w);
    bud(
        "budget-existing-file",
        vec![be(&b1, &[("prompt_id", J::from("p-9"))], "3")],
        &World::new().git("proj").file(
            "home/.anti-hall/devswarm/stop-policy/sess-1.json",
            "{\"other|x|prompt\":{\"count\":1},\"sess-1|task-guard|prompt\":{\"promptKey\":\"p-9\",\"count\":2,\"lastAt\":1}}",
        ),
    );
    bud(
        "budget-file-garbage",
        vec![be(&b1, &[("prompt_id", J::from("p-9"))], "1")],
        &World::new().git("proj").file("home/.anti-hall/devswarm/stop-policy/sess-1.json", "[1]"),
    );
    bud("budget-zero", vec![be(&b1, &[], "0")], &w);

    // ---- payload shapes on a block
    let shapes: Vec<(&str, Vec<(&str, J)>)> = vec![
        ("session-number", vec![("session_id", J::from(7))]),
        ("session-weird", vec![("session_id", J::from("a/b c"))]),
        ("session-empty-array", vec![("session_id", ja![])]),
        ("cwd-relative", vec![("cwd", J::from("proj"))]),
        ("cwd-number", vec![("cwd", J::from(5))]),
    ];
    for (id, extra) in shapes {
        add(Scenario::new(&format!("shape-{id}"), w.clone(), vec![Step::payload(stop(&g1, &extra))]), false);
    }
    // a relative cwd is resolved by Node against its own working directory: the engine may hand it over
    must.borrow_mut().remove("shape-cwd-relative");
    let mut no_session = stop(&g1, &[]);
    no_session.remove("session_id");
    add(Scenario::new("shape-no-session", w.clone(), vec![Step::payload(no_session)]), false);
    let scenarios = out.into_inner();
    (scenarios, shared, must.into_inner())
}

pub(crate) fn opts(must: BTreeSet<String>) -> Opts {
    let mut o = Opts::new("task-guard-fire", "task-guard.js", "task-guard");
    o.may_defer = Some(Box::new(move |sc, _| !must.contains(&sc.id)));
    o
}
