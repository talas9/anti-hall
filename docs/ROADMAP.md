# Roadmap

One ordered plan covers every open issue and feature. Work runs in strict order, release by release, and is mirrored on the GitHub project board (field `Order` = global rank, `Target` = release). Tracking issue: [#164](https://github.com/talas9/anti-hall/issues/164).

Releases are listed in the order they ship: **R1 → v0.301 → v0.302 → v1.0 → Later**. A release's scope is frozen once its work starts; anything new goes into a later release. Quality comes before features: no feature work starts until the hardening release (R1) has met its exit gate.

## Decisions that shape the plan

- Features ship **between v0.301 and v1.0**, not after it.
- Node is removed in **v0.301** (ahead of 1.0). With no Node and a missing or broken engine, the hooks **pass through and print one notice** instead of blocking the session.
- Native Windows support (#28) is **parked in Later**. It is not a promise.
- "Engine-only" means Rust primitives plus the QuickJS logic files in `plugins/anti-hall/engine/logic/` plus TOML values. Nothing tunable is compiled into the engine binary.
- Branches proven merged are deleted at the end of R1. Old GitHub release pages are deleted at 1.0; git tags are always kept.

## Shipped and current state (2026-10-25)

- Engine **0.2.1** and plugin **0.301.1** are released; the R0 milestone (engine back online) is superseded by these releases. Version authority is `plugins/anti-hall/.claude-plugin/plugin.json`.
- Fixes merged into `dev` but **not yet deployed live**: [#308](https://github.com/talas9/anti-hall/issues/308) Codex hook launchers rewritten to `ah-hook` (PR #320), [#309](https://github.com/talas9/anti-hall/issues/309) block caps reset per owner turn (PR #319), [#317](https://github.com/talas9/anti-hall/issues/317) false blocks on read-only remote commands and owner-wait tasks (PR #321).
- The effectiveness investigation ([#307](https://github.com/talas9/anti-hall/issues/307)) is the active plan for guard quality.

### Priority scale

| Level | Meaning |
|---|---|
| P0 | The plugin fails to catch failures, loses or corrupts data, crash-loops or blocks sessions wrongly |
| P1 | Degrades guard or engine reliability, token waste, release or deploy integrity |
| P2 | Quality, CI and test hygiene, polish |
| P3 | Backlog and ideas |

### Current order

1. Deploy the merged fixes, then run the live checks.
2. [#310](https://github.com/talas9/anti-hall/issues/310) → [#312](https://github.com/talas9/anti-hall/issues/312) → [#311](https://github.com/talas9/anti-hall/issues/311) → [#313](https://github.com/talas9/anti-hall/issues/313) → [#314](https://github.com/talas9/anti-hall/issues/314) → [#316](https://github.com/talas9/anti-hall/issues/316) → [#225](https://github.com/talas9/anti-hall/issues/225) → [#315](https://github.com/talas9/anti-hall/issues/315)
3. The issue groups below, highest priority first.

### Issue groups (children are tracked in each parent issue)

| Parent | Group |
|---|---|
| [#307](https://github.com/talas9/anti-hall/issues/307) | Effectiveness gap: Node vs engine |
| [#326](https://github.com/talas9/anti-hall/issues/326) | Node-to-engine migration parity bugs |
| [#327](https://github.com/talas9/anti-hall/issues/327) | DevSwarm and mesh reliability |
| [#328](https://github.com/talas9/anti-hall/issues/328) | CI and test hygiene |
| [#329](https://github.com/talas9/anti-hall/issues/329) | Security alerts and supply chain |
| [#330](https://github.com/talas9/anti-hall/issues/330) | Install, deploy and update integrity |
| [#331](https://github.com/talas9/anti-hall/issues/331) | Backlog: parked features and research |
| [#16](https://github.com/talas9/anti-hall/issues/16) | v1.0 no-Node umbrella |
| [#158](https://github.com/talas9/anti-hall/issues/158), [#266](https://github.com/talas9/anti-hall/issues/266), [#289](https://github.com/talas9/anti-hall/issues/289), [#270](https://github.com/talas9/anti-hall/issues/270) | Engine safety rows, Command Center, rules as data, runaway token burn |

Every open issue carries one `priority:P0`–`P3` label.

## R1 — hardening and bug burn-down (v0.300.x)

**Goal:** a boring, observable engine. No features.
**Exit gate:** 7 consecutive days with the engine live and 0 open P0/P1; CI green for 7 days on `main`, `dev` and `engine-proto`, including the fuzz and scheduled suites; all 14 safety rows of [#158](https://github.com/talas9/anti-hall/issues/158) done; Stop-hook p50 under 50 ms; [#21](https://github.com/talas9/anti-hall/issues/21) closed after a 50 000-call flat-memory soak.

| Lane | Ordered items |
|---|---|
| CI | [#163](https://github.com/talas9/anti-hall/issues/163) fuzz build and scheduled suite green → #158 row 14 (rulesets: `ah-engine` and `no-node` required on `dev` and `engine-proto`, only after the fuzz fix is green) → PR #167 narrowed to the plugin-validate job and docs → board status mapping → [#91](https://github.com/talas9/anti-hall/issues/91) re-verify → [#96](https://github.com/talas9/anti-hall/issues/96) → delete branches proven merged |
| Engine memory and latency | #158 rows 9–11 (disk floor in code) → memory follow-ups and the largest leak findings → [#21](https://github.com/talas9/anti-hall/issues/21) 50 000-call soak and close → [#22](https://github.com/talas9/anti-hall/issues/22) late replies under load, Stop under 50 ms, per-request CPU budget → error-handling audit remainder |
| Guards | false-positive fixes (each with a failing-then-passing test in the layer that answers the guard) → git `index.lock` re-verify → no `.anti-hall/history` created in a submodule → DevSwarm mesh unread/watcher → docs drift |

A short re-triage of the parked items happens after R1.

## v0.301 — engine-only (Node removed)

**Goal:** the Node runtime is gone for both ports (Claude and Codex) and both orchestration layers (OMC and OMX).
**Exit gate:** `compiled_logic_checks_remaining` = 0; the no-Node acceptance harness has 0 expected failures; the no-engine path is pass-through plus one notice, tested for a missing, non-executable, crashing, hanging and killed engine on both hosts.

| Lane | Ordered items |
|---|---|
| A | [#43](https://github.com/talas9/anti-hall/issues/43) migration status report → [#66](https://github.com/talas9/anti-hall/issues/66) doctor → [#61](https://github.com/talas9/anti-hall/issues/61) update |
| B | [#68](https://github.com/talas9/anti-hall/issues/68) Stop nudges → [#23](https://github.com/talas9/anti-hall/issues/23) CI on Linux and Intel macOS → [#17](https://github.com/talas9/anti-hall/issues/17) test-suite speed-up |
| C | [#64](https://github.com/talas9/anti-hall/issues/64) DevSwarm supervisor and ingest → [#14](https://github.com/talas9/anti-hall/issues/14) DevSwarm CLI remainder → [#72](https://github.com/talas9/anti-hall/issues/72) prompt-side hooks → [#73](https://github.com/talas9/anti-hall/issues/73) gates and roles |
| Then, in series | [#77](https://github.com/talas9/anti-hall/issues/77) skills and docs call the engine through the thin client `ah-hook` → pass-through plus notice → [#76](https://github.com/talas9/anti-hall/issues/76) runtime cutover → [#78](https://github.com/talas9/anti-hall/issues/78) delete the Node files and tests → [#16](https://github.com/talas9/anti-hall/issues/16) umbrella closes with evidence |

## v0.302 — features

**Goal:** the planned features, engine-only.
**Exit gate (per feature):** one `<feature>.enabled` setting; all tunables in plugin TOML; Claude and Codex parity test; effectiveness metrics in `ah-engine telemetry report`; no regression (no-Node suite green, replay 0 weaker, bounded added latency and memory); judgement features ship in shadow mode until measured precision is accepted; 0 open P0/P1.

Order: [#53](https://github.com/talas9/anti-hall/issues/53) → [#40](https://github.com/talas9/anti-hall/issues/40) → [#42](https://github.com/talas9/anti-hall/issues/42) → [#20](https://github.com/talas9/anti-hall/issues/20) → [#36](https://github.com/talas9/anti-hall/issues/36) → [#37](https://github.com/talas9/anti-hall/issues/37) → [#34](https://github.com/talas9/anti-hall/issues/34) → [#35](https://github.com/talas9/anti-hall/issues/35) → [#39](https://github.com/talas9/anti-hall/issues/39) → [#18](https://github.com/talas9/anti-hall/issues/18)

Planned, priority P3: [#289](https://github.com/talas9/anti-hall/issues/289) rules as data (action catalogue, TOML routines and CEL conditions, no JavaScript in the plugin).

## v1.0 — release candidate

**Goal:** proven stable, contract frozen.
**Exit gate:** at least 7 patch-free days after the last v0.302 release; 0 new friction bugs in the periodic sweeps; every CI run green on the first attempt on `main`, `dev` and `engine-proto` (fuzz, nightly and no-Node included); `compiled_logic_checks_remaining` = 0; the 1.0 contract rewritten and covered by a drift test; documentation sweep across both ports with no Node references left and every setting documented; classifier keep/remove verdicts reflected; 0 open P0/P1.

Order: [#47](https://github.com/talas9/anti-hall/issues/47) readiness gate → [#44](https://github.com/talas9/anti-hall/issues/44) per-platform checks → [#148](https://github.com/talas9/anti-hall/issues/148) OpenSSF follow-ups → [#48](https://github.com/talas9/anti-hall/issues/48) mutation testing → [#29](https://github.com/talas9/anti-hall/issues/29) dependency auditing → delete old release pages (tags kept).

## Later (parked)

Re-triaged after R1; each has an explicit condition to be un-parked.

| Issue | Condition |
|---|---|
| [#25](https://github.com/talas9/anti-hall/issues/25) rule-adherence supervisor | after R1, with full judgement-gate coverage and a labelled test set |
| [#26](https://github.com/talas9/anti-hall/issues/26) agent seat categories | design decisions made, plus measured mis-tiering |
| [#27](https://github.com/talas9/anti-hall/issues/27) engine caching layer | only on a measured per-hook latency miss |
| [#28](https://github.com/talas9/anti-hall/issues/28) native Windows | only if the Windows decision is reversed; not a promise |
| [#30](https://github.com/talas9/anti-hall/issues/30) memory supervisor | research note first |
| [#31](https://github.com/talas9/anti-hall/issues/31) bounded work queues | on measured queue growth |
| [#32](https://github.com/talas9/anti-hall/issues/32) dependency consolidation | on a measured glob or JSON cost (the byte-bounded cache part is pulled into R1) |
| [#33](https://github.com/talas9/anti-hall/issues/33) opt-in usage report | after an approved privacy policy and external users |
| [#45](https://github.com/talas9/anti-hall/issues/45) judge asks a DevSwarm workspace | after a supervisor-owned mesh channel exists |

## Interrupt policy

Only these pause the roadmap:

1. A P0 in a real session: a prompt blocked for more than 1 s, a crash loop, a wrong block that stops work, or memory/CPU/disk growth in telemetry.
2. Data or work loss (corrupt files, lost transcript or handover state, git damage).
3. A new red on `main`, `dev` or `engine-proto` CI beyond the recorded baseline.
4. A security alert of high severity or above.
5. A bug that blocks the current item's exit gate.

Everything else is filed with `status:triage` and placed in a later release. Each interruption is recorded below and labelled `interrupt`; work resumes at the recorded rank.

### Interruptions

| Date | Criterion | Issue | Paused rank | Resume point | Agent hours |
|---|---|---|---|---|---|
| | | | | | |
