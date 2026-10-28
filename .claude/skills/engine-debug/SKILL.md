---
name: engine-debug
description: Dev-only, anti-hall repo (not part of the shipped plugin). Use when the ah-engine daemon or a hook misbehaves - high CPU, memory growth, a frozen or crashing daemon, slow hooks, a wrong decision - to find the cause with evidence before any fix, without touching the live daemon's state.
---

# engine-debug: find the cause of an engine problem

Dev-only: lives in the repo's `.claude/skills/`, outside `plugins/anti-hall/`, so it is never
installed for users. The long form, with commands and a worked example, is the "A debugging
session" section of `docs/DEVELOPMENT.md` (and "CPU and memory profiling" in
`docs/AH-ENGINE.md`). This skill is the checklist for an agent. Every flag, environment variable
and key named here is listed in `ah-engine/REFERENCE.md`.

## Safety rules (they win over speed)

- Never touch the live daemon's state. Read its logs; reproduce in a scratch home
  (`AH_ENGINE_DIR` and `HOME` in a fresh temp directory, which also gives the scratch daemon its
  own socket). Copy databases with `ah-engine backup --to <scratch>`, never with a bare `cp` of
  a live database.
- Kill by PID only (`kill <pid>`). No `pkill`, no `killall`: they stop the daemons of other
  sessions. Track every PID you start and stop exactly those.
- No rollback of the engine during a live test, and no "restart it and see". Roll back only when
  hooks exceed their timeout or the guards stop blocking; otherwise fix forward.
- A debugger or sampler stays attached only as long as its command runs (`--batch`, then
  detach). Never leave one on the live daemon.
- Debug mode is off in normal use. Turn it on for the shortest time that answers the question,
  then back off (`--debug`, `AH_ENGINE_DEBUG`, `diagnostics.debug_mode`).
- Bound everything: a build only when load is under 14, `nice -n 19`, `-j 2`; delete `target/`
  of a scratch clone when done (move to the Trash, no `rm -rf`).

## Steps

1. **State the symptom with a number.** CPU %, RSS, hook latency, exit code. "Slow" is not a symptom.
2. **Health first.** `ah-engine status --json`: `health.degraded`, `health.restarts`,
   `health.last_crash`, breaker, crash-loop. A `cli-crash.json` entry is a command-line or
   hook-client panic and is not a daemon crash.
3. **Logs.** The event log `ah-engine.log` in the state directory, then `last-crash.json` and its
   breadcrumb. Quote the lines you rely on.
4. **Name the busy thread.** `ah-engine status --threads` (CPU % per thread name, work counters
   per second). Do not read code before you know which thread and which counter.
5. **Memory.** `ah-engine status --memory`; then `mem.ndjson` (per request) and
   `mem-snapshot.json` (when the cap tripped). For allocation sites use a scratch daemon with
   `diagnostics.allocator = system` or `AH_ENGINE_ALLOCATOR=system`.
6. **Profile.** `samply record -p <pid>`, or on macOS `sample <pid> 5 -file <out>` symbolised
   with `atos` and the build's `ah-engine.dSYM`. Symbols match only the binary of the same
   build (`dwarfdump --uuid`).
7. **Frozen daemon.** Stacks before restart: `rust-lldb -p <pid> --batch -o 'thread backtrace all'
   -o detach -o quit` (Linux: `eu-stack -p <pid>`). Save them, then stop the daemon by PID.
8. **Reproduce in a scratch home** with the smallest input that shows the number from step 1.
   Write the failing test first (see `engine-lane`), then fix the cause, not the symptom.
9. **Prove the fix** with the same measurement as step 1, on the same kind of data. A lab number
   is not a live number: say which one you have.
10. **Record it.** A line in `.anti-hall/history/` (Cause / Fix / Verified) and, for a defect,
    the GitHub issue (`gh-work`).

## Do not

- Do not guess a cause from a metric or a log line; get the per-item breakdown first.
- Do not add a threshold, interval or text to Rust source while fixing: it goes in the plugin's
  `engine/defaults/*.toml` (`no_hardcoded_tunables`).
- Do not add a flag or environment variable without its entry in `flags.toml` / `engine.toml`:
  the reference drift tests fail otherwise.
