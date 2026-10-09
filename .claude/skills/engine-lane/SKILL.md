---
name: engine-lane
description: Dev-only, anti-hall repo (not part of the shipped plugin). Use when running or briefing an ah-engine (Rust) lane - isolated clone, queued builds, targeted tests, the per-train full gate and replay, the no-hardcoding gates, Node goldens, and cleanup.
---

# engine-lane: running an ah-engine lane

A lane is one bounded engine change (one issue, see `gh-work`) built in isolation and handed
back as commits for the coordinator to integrate. Every lane brief restates these rules.
A machine may keep its own stricter lane rules (for example `~/.anti-hall/work/LANE-RULES.md`);
read them first, they win over this summary.

## 1. Where to work

- A fresh scratch clone or a `git worktree add` under `~/.anti-hall/work/` (never `/tmp`, never
  the shared checkout other sessions use). One mutating lane per checkout.
- Base it on the branch named in the brief (engine work branches off the engine branch, not
  `main`). To test an older commit use `git worktree add <dir> <sha>`; **never `git stash`**.
- Git identity = the repo's git config; never `--author`, never set `user.email`; no AI-credit
  lines. Lanes never push unless the brief says so; never force push.
- Before starting, check free disk and load; lanes never outnumber build slots.

## 2. Building and testing

- Every cargo call goes through the shared build queue, from `ah-engine/`:
  `AH_CARGO_PRIO=<0-9> ~/.anti-hall/work/bin/cargo-q.sh <cargo args>` (priority FIFO, bounded
  slots, niced, disk-guarded). Never bare `cargo`, never `cargo run`.
- **Lane = targeted tests only:** `cargo-q.sh check`, then only the tests of the modules you
  touched, e.g. `cargo-q.sh nextest run -E 'test(<module>)'`. Not the parity/integration sweeps,
  not the full suite, not a replay.
- **Once per release train** (on the merged train branch, not per lane): the full gate
  (`ah-engine/test.sh`: clippy `-D warnings`, the whole nextest suite, timed tests alone,
  doctests, no surviving daemon), the soak profile, and the frozen replay (the Node goldens
  replayed against the engine; any check weaker than Node is a P0). A train failure is bisected
  over its lane merges. CI fixes are batched: reproduce the failing job locally, push once.
- Tests never touch the real HOME (`~/.claude`, `~/.anti-hall`): scratch HOME, fixture repos.
- No `pkill`/`killall`; kill only PIDs your lane started. No background polling loops.

## 3. No hardcoding, nothing compiled (D88)

- Every threshold, limit, interval, text, phrase list, rule, setting or dispatch row lives in
  the plugin's config (`plugins/anti-hall/engine/defaults/` plus its byte-identical
  `defaults.pristine/` twin), read at start-up, on plugin update and on file change. Decision
  logic belongs in plugin JavaScript (`plugins/anti-hall/engine/logic/<check>.js`, run by the
  embedded interpreter), not in compiled Rust.
- Gates that must pass:
  - `no_hardcoded_tunables` (`cargo-q.sh nextest run --release -E 'test(no_hardcoded_tunables)'`):
    no tunable literal in engine source.
  - `compiled_logic_gate` (`tests/compiled_logic_gate.rs` against `tests/compiled_logic_ceiling.txt`):
    the count of non-scripted checks may only go down; lower the ceiling when you script one.
- True constants (protocol or format versions) only through the narrow, justified allowlist.
- New verbs, features and settings go in the engine registry (so the generated engine skill
  picks them up) and declare which roles may use them.

## 4. Node parity and goldens

- **Zero new Node.** New capability only in the engine; shipped Node gets bug fixes only and
  stays in parity. The engine is never weaker than Node: anything not provably identical defers
  (nothing written).
- `ah-engine/tests/goldens/<lane>/` holds recorded Node answers. A change to a Node file in a
  lane's fingerprint fails with `stale Node golden <lane>: <file> changed`; re-record and commit
  the golden with the Node change:
  `AH_RECORD_NODE=1 cargo-q.sh nextest run --release --profile record -E 'test(<test>)'`, then
  review `git diff tests/goldens/<lane>` (usually only manifest hashes). Recording is refused
  under `CI=true`. Details: `ah-engine/tests/goldens/README.md`.

## 5. Acting features

New features act by default; each action emits a telemetry event (feature, action, target,
inputs, outcome, reason, latency, action id) and later mistake signals, reported by the engine's
telemetry/metrics verbs. Keep idempotency, a live re-check, an in-flight lock and the ledger.
Never delete user data.

## 6. Hand-off and cleanup

- Report: branch, commit SHAs, exact test commands and counts, open issues. Comment the same
  evidence on the lane's issue.
- After the patch is handed over (commits fetched or a patch file written), delete the lane's
  `ah-engine/target/` (multi-GB) and remove the scratch worktree once the coordinator has the
  commits (`git worktree remove <dir>`; see `repo-hygiene`).

Model routing for agents and lanes: see the "Model routing" section in `.claude/skills/README.md`.
