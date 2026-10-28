# Effectiveness audit, October 2026: Node hooks vs the engine

Tracking issue: [#307](https://github.com/talas9/anti-hall/issues/307).

This page records how we measured whether anti-hall still does its job after the move from the Node hooks to the engine, what we found, and the baseline numbers that later changes are measured against.

## Question

After the migration, the protections seemed to stop firing: agents still made unsupported claims, ignored the task list and neglected workspaces. Two explanations were possible:

- the migration dropped or weakened rules;
- the rules were ported, but their verdicts don't reach the agent or aren't obeyed.

## Method

All four audits were read-only and ran over real long sessions on the maintainer's machine with the plugin active. The transcripts are private and are not part of this repository.

| Audit | What it does |
|---|---|
| Wiring | Maps every Node hook to its engine check, then checks events, mode (on, shadow or off), delivery shape and live logs. |
| Effectiveness | Builds an index of every check, guard and nudge. Hook firings and the agent's reaction to each are extracted mechanically. Every owner correction is then judged on four questions: was it a real failure, which feature should have caught it, did that feature fire, and was it obeyed. About 20 firings per session with no complaint are judged for noise. |
| Era comparison | Runs the same scripts and rubric on Node-only sessions (August and September) and on engine sessions (October). Phases are dated from transcript evidence: the engine decides from 2026-10-08, and the Node shadow is off from 2026-10-24. |
| Parity replay | Rebuilds the real failure moments as hook payloads and runs them through both the old Node hooks and the engine, offline, in a scratch `HOME`. |

## Results

| # | Result |
|---|---|
| 1 | **Same inputs give the same verdicts.** Node and the engine agree on all 48 real failure moments in the offline Stop replay. The cause is not the language. |
| 2 | **Not measurably worse than Node.** Owner-flagged failures per 100 owner turns: 2.66 for Node (August–September) and 2.71 for the engine. Node caught and fixed 0 of its flagged failures. The comparison is inconclusive by design: tasks, projects and feature versions differ between the eras. |
| 3 | **The engine is much quieter.** Anti-hall messages per owner turn: about 37 while Node decided, about 7 with the engine and the Node shadow, and about 3 with Node off. |
| 4 | **Block caps never reset** ([#309](https://github.com/talas9/anti-hall/issues/309)). `speculation_guard.max_blocks = 3` applies per session. After the third block, the guard allows everything for the rest of a long session. 28 of the 29 semantic decisions logged at real failure moments were `loop-safe/allow`. The task and task-list guards have the same shape. |
| 5 | **Most failure classes have no rule** ([#313](https://github.com/talas9/anti-hall/issues/313)). In 46 of 48 failures, no check fired, in either version. The uncovered classes include ignored instructions, unhedged claims, "pushed" taken as done, invented "parked" or "owner decided" statuses, and wrong assumptions about devices or tools. |
| 6 | **Codex had no anti-hall** ([#308](https://github.com/talas9/anti-hall/issues/308)). Its hooks still called the retired shell launcher. |
| 7 | **Rule census.** All 62 Node hooks have engine counterparts. One branch is missing ([#315](https://github.com/talas9/anti-hall/issues/315)). Several are weaker: [#310](https://github.com/talas9/anti-hall/issues/310) covers the speculation gate and the Jev budget, and [#314](https://github.com/talas9/anti-hall/issues/314) covers Codex parity. |
| 8 | **Verdicts can be lost on delivery.** Answers are shed under load or cut at a deadline ([#312](https://github.com/talas9/anti-hall/issues/312)). All checks also share one output with a single 10k inline cap, so part of the output can spill to a file ([#311](https://github.com/talas9/anti-hall/issues/311)). |
| 9 | **Noise.** The busiest advisories have almost no measurable effect ([#225](https://github.com/talas9/anti-hall/issues/225)). |

## Baseline for measuring the fixes

| Metric | Baseline (October 2026) |
|---|---|
| Owner-flagged failures per 100 owner turns, engine sessions | 2.71 |
| Engine-era flagged failures caught and fixed | 1 of 42 |
| Frozen failure set caught live | 1 of 48 |
| Anti-hall messages per owner turn, Node off | about 3 |

The numbers are selected-failure yields from complaint-triggered samples, not population rates. Compare them only with a re-run that uses the same scripts and rubric.

The fixes are measured three ways:

1. A replay of the frozen failure set and the noise samples before and after every rule change ([#316](https://github.com/talas9/anti-hall/issues/316)).
2. Live counts of decided, delivered and complied per check ([#312](https://github.com/talas9/anti-hall/issues/312)).
3. A weekly re-run of the effectiveness audit on fresh sessions.

## Fix order

1. Codex hooks: [#308](https://github.com/talas9/anti-hall/issues/308).
2. Block caps: [#309](https://github.com/talas9/anti-hall/issues/309).
3. The speculation gate and its budget: [#310](https://github.com/talas9/anti-hall/issues/310).
4. Output priority and delivery telemetry: [#311](https://github.com/talas9/anti-hall/issues/311) and [#312](https://github.com/talas9/anti-hall/issues/312).
5. New rules: [#313](https://github.com/talas9/anti-hall/issues/313).
6. Codex parity: [#314](https://github.com/talas9/anti-hall/issues/314).
7. The replay loop: [#316](https://github.com/talas9/anti-hall/issues/316).
8. Noise: [#225](https://github.com/talas9/anti-hall/issues/225).
9. False blocks: [#317](https://github.com/talas9/anti-hall/issues/317).

All rules and values belong in the plugin's TOML. None may be hard-coded in the engine.
