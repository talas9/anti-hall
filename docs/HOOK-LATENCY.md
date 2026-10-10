# Hook latency

These are the Node hooks. The core `ah-engine` answers most calls without a Node start-up; its pre-release replay figures are in [AH-ENGINE.md](AH-ENGINE.md#measured-results-pre-release) and were measured on a different harness, so do not mix them with the tables here.

How long anti-hall's hooks take, measured with `scripts/hook-latency.js` (`node scripts/hook-latency.js [-n 20] [--json] [--only name,name] [--grouped]`). `--grouped` skips the per-hook passes and, for each event scenario, starts the whole matching hook set in parallel (as Claude Code does) and reports group wall and summed CPU. It starts every command registered in `plugins/anti-hall/hooks/hooks.json` the way Claude Code does (command string through a shell, `${CLAUDE_PLUGIN_ROOT}` expanded, node flags kept, JSON payload on stdin, `CLAUDE_CODE_ENTRYPOINT=cli`, `HOME` set to a temp dir, cwd a small git repo) and feeds it a realistic payload for each scenario.

**Caveat: this was measured while other work ran on the machine** (load average about 20 to 30 on a 16-logical-CPU machine, see below), so absolute numbers are inflated and the p95 column carries scheduler noise. Re-run it on a quiet machine before quoting a figure as a baseline.

## What the numbers mean

- **Wall** is spawn to exit. **p50/p95** are nearest-rank over 19 runs (20 run, first dropped). With 19 samples p95 is effectively the slowest run.
- **CPU** is the hook process's own user+system time from `process.resourceUsage()`, written at exit by a `--require` probe in a second pass (so the probe never inflates the wall numbers). I chose it over `/usr/bin/time` because that tool prints different formats on macOS and GNU, rounds to 10 ms, and is missing on some systems. It does not count grandchildren: a hook that shells out to `git` is charged for itself only.
- **Total per tool call**: Claude Code runs all matching hooks in parallel (hooks docs, code.claude.com/docs/en/hooks: "All matching hooks run in parallel."; `docs/KB-claude-codex.md` does not say), so the wall total is the slowest hook, not the sum. The "parallel, measured" column starts the matching hooks together and times the group. "max" is the derived lower bound and "sum" is what a sequential runner would cost. CPU adds up, so the CPU total is the sum.
- Scenario hook sets follow the matchers of the dispatch table (`hooks/hooks.registry.json` is its per-hook form; `hooks.json` itself is one thin trigger per event) (for example `Bash` matches 9 PreToolUse hooks and 6 PostToolUse hooks; `Agent` matches 5 PreToolUse and 1 PostToolUse; `Edit` matches 4; a prompt runs 8; Stop runs 11; SessionStart runs 16 on 0.201.0. The Codex port runs Bash 7 + 4, prompt 8, Stop 10, SessionStart 15). `edit-guard` exits 2 (blocks) in the Edit/Write scenarios because the fixture is a coordinator session; that is its normal path.
- The benchmark covers SessionStart, UserPromptSubmit, PreToolUse (Bash, Edit, Write, Agent), PostToolUse (Bash, Agent) and Stop. PostToolUse `TaskCreate|TaskUpdate`, PreToolUse `Read`/`SendMessage`/`AskUserQuestion`/`TaskStop` and the other events are not measured.

## Results

Date: 2026-10-03T17:49:25.700Z  
Machine: Apple M4 Max, darwin 25.6.0, Node v24.14.0  
Load average (1/5/15 min) at start: 28.67 / 29.79 / 23.68; at end: 27.75 / 27.26 / 23.36  
N=20 runs per hook, first dropped (19 samples), nearest-rank percentiles. All times in ms.

| Event | Scenario | Hook | Wall p50 | Wall p95 | CPU p50 | CPU p95 | Load (1 min) |
|---|---|---|---:|---:|---:|---:|---:|
| SessionStart | startup | verify-first-full | 23.4 | 26.1 | 22.7 | 25.1 | 26.94 |
| SessionStart | startup | verify-first-orch | 27.2 | 29.3 | 26.7 | 28.4 | 26.94 |
| SessionStart | startup | devswarm-child-role | 48.4 | 53.6 | 51.5 | 53.8 | 26.94 |
| SessionStart | startup | version-alert | 25.2 | 26.8 | 25.0 | 25.9 | 26.94 |
| SessionStart | startup | fable-availability | 22.3 | 26.4 | 19.9 | 21.7 | 25.66 |
| SessionStart | startup | codex-availability | 25.9 | 29.6 | 25.0 | 27.5 | 25.66 |
| SessionStart | startup | devswarm-version | 24.1 | 25.2 | 23.6 | 24.6 | 25.66 |
| SessionStart | startup | claude-cli-version | 23.2 | 24.8 | 22.9 | 24.1 | 25.66 |
| SessionStart | startup | repo-self-drift | 24.6 | 28.8 | 24.0 | 25.3 | 25.66 |
| SessionStart | startup | progress-prune | 27.0 | 28.9 | 26.4 | 27.3 | 24.09 |
| SessionStart | startup | handover-resume | 26.9 | 30.3 | 26.7 | 28.1 | 24.09 |
| SessionStart | startup | jev-weekly-scorecard | 23.4 | 27.0 | 21.9 | 22.7 | 24.09 |
| SessionStart | startup | jev-review-reminder | 23.4 | 24.5 | 23.8 | 24.7 | 24.09 |
| SessionStart | startup | emit-dedupe-reset | 25.5 | 27.9 | 24.9 | 25.8 | 24.09 |
| SessionStart | startup | defect-nudge | 25.1 | 27.6 | 24.5 | 25.6 | 22.8 |
| SessionStart | startup | repair-on-reload | 24.3 | 26.5 | 23.6 | 26.7 | 22.8 |
| UserPromptSubmit | prompt | verify-first | 34.5 | 41.6 | 28.6 | 29.8 | 22.8 |
| UserPromptSubmit | prompt | task-tracker | 39.4 | 43.6 | 37.3 | 38.8 | 21.45 |
| UserPromptSubmit | prompt | limit-conserve-inject | 23.4 | 25.1 | 21.7 | 23.3 | 21.45 |
| UserPromptSubmit | prompt | devswarm-parent-inbox | 55.1 | 59.2 | 52.9 | 56.2 | 21.45 |
| UserPromptSubmit | prompt | devswarm-child-turn | 32.9 | 35.0 | 31.1 | 32.1 | 20.29 |
| UserPromptSubmit | prompt | repair-on-reload | 24.8 | 28.0 | 25.4 | 29.7 | 20.29 |
| UserPromptSubmit | prompt | auto-handover | 30.2 | 34.3 | 26.2 | 27.2 | 20.29 |
| PreToolUse | Bash: git status | compact-declaration-guard | 28.0 | 33.7 | 23.6 | 25.7 | 19.31 |
| PreToolUse | Bash: git status | git-guard | 25.2 | 27.8 | 23.6 | 24.8 | 19.31 |
| PreToolUse | Bash: git status | command-guard | 29.8 | 34.3 | 28.6 | 30.4 | 19.31 |
| PreToolUse | Bash: git status | merge-gate | 23.3 | 27.7 | 22.2 | 24.4 | 19.31 |
| PreToolUse | Bash: git status | scan-throttle | 22.7 | 23.7 | 21.7 | 22.4 | 19.31 |
| PreToolUse | Bash: git commit | compact-declaration-guard | 26.6 | 32.6 | 25.0 | 30.8 | 18.64 |
| PreToolUse | Bash: git commit | git-guard | 57.9 | 65.1 | 34.4 | 36.6 | 18.64 |
| PreToolUse | Bash: git commit | command-guard | 33.6 | 47.4 | 30.9 | 32.2 | 17.47 |
| PreToolUse | Bash: git commit | merge-gate | 33.1 | 109.8 | 29.2 | 41.7 | 17.47 |
| PreToolUse | Bash: git commit | scan-throttle | 26.9 | 30.1 | 27.5 | 34.9 | 17.47 |
| PreToolUse | Edit: src file | compact-declaration-guard | 40.2 | 51.6 | 33.9 | 42.9 | 18.87 |
| PreToolUse | Edit: src file | api-guard | 34.1 | 50.1 | 35.3 | 45.8 | 18.87 |
| PreToolUse | Edit: src file | ship-it-guard | 37.5 | 50.4 | 26.6 | 33.1 | 18 |
| PreToolUse | Edit: src file | edit-guard | 50.0 | 131.8 | 44.7 | 54.7 | 18 |
| PreToolUse | Write: src file | compact-declaration-guard | 41.6 | 51.8 | 33.4 | 40.0 | 18.08 |
| PreToolUse | Write: src file | api-guard | 42.6 | 66.0 | 39.5 | 43.2 | 18.08 |
| PreToolUse | Write: src file | ship-it-guard | 41.8 | 52.0 | 36.3 | 39.2 | 18.08 |
| PreToolUse | Write: src file | edit-guard | 64.8 | 83.1 | 57.8 | 63.2 | 18.08 |
| PreToolUse | Agent: spawn | compact-declaration-guard | 46.8 | 53.3 | 37.2 | 41.7 | 20.47 |
| PreToolUse | Agent: spawn | model-routing-guard | 45.3 | 63.0 | 40.0 | 42.3 | 20.47 |
| PreToolUse | Agent: spawn | swarm-guard | 75.3 | 100.2 | 46.7 | 55.1 | 20.99 |
| PreToolUse | Agent: spawn | phase-tracker | 42.5 | 56.8 | 35.8 | 39.0 | 20.99 |
| PostToolUse | Bash: git status | git-guard --audit | 51.8 | 81.7 | 39.1 | 55.1 | 21.07 |
| PostToolUse | Bash: git status | output-verify-guard | 47.0 | 66.0 | 37.2 | 46.1 | 21.07 |
| PostToolUse | Bash: git status | devswarm-parent-reply-tracker | 43.3 | 57.4 | 40.7 | 47.6 | 21.07 |
| PostToolUse | Bash: git status | devswarm-child-drain | 47.6 | 68.0 | 45.0 | 57.6 | 20.99 |
| PostToolUse | Agent: spawn | codex-quota-detect | 45.3 | 50.1 | 35.0 | 42.5 | 20.75 |
| Stop | short transcript | task-guard | 50.8 | 67.0 | 40.7 | 48.0 | 20.75 |
| Stop | short transcript | tasklist-guard | 59.5 | 74.6 | 46.7 | 56.0 | 20.85 |
| Stop | short transcript | speculation-guard | 57.9 | 91.7 | 45.8 | 52.1 | 20.85 |
| Stop | short transcript | speculation-judge | 47.0 | 55.1 | 47.5 | 53.1 | 20.85 |
| Stop | short transcript | claim-ledger | 45.8 | 54.1 | 40.4 | 44.2 | 20.7 |
| Stop | short transcript | codex-nudge | 53.1 | 69.4 | 43.7 | 46.7 | 20.7 |
| Stop | short transcript | devswarm-parent-gate | 150.4 | 240.5 | 109.5 | 116.0 | 21.51 |
| Stop | short transcript | devswarm-child-gate | 53.9 | 83.3 | 49.7 | 52.1 | 21.51 |
| Stop | short transcript | auto-handover-pause-nag | 52.7 | 60.3 | 45.1 | 48.0 | 21.51 |
| Stop | short transcript | silent-agent-nudge | 50.6 | 85.8 | 39.9 | 44.2 | 24.51 |
| Stop | short transcript | compact-advice-guard | 57.5 | 67.1 | 42.7 | 44.7 | 24.51 |

Per-tool-call totals. Wall (parallel, measured) starts every matching hook together and times the group, which is what Claude Code does. Wall (max) and Wall (sum) are derived from the per-hook numbers: max is the parallel lower bound, sum is what a sequential runner would cost. CPU (sum) is the work all hooks do together.

| Event | Scenario | Hooks | Wall parallel p50 | Wall parallel p95 | Wall max p50 | Wall max p95 | Wall sum p50 | CPU sum p50 |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| SessionStart | startup | 16 | 75.5 | 99.0 | 48.4 | 53.6 | 419.9 | 413.1 |
| UserPromptSubmit | prompt | 7 | 61.0 | 75.2 | 55.1 | 59.2 | 240.3 | 223.3 |
| PreToolUse | Bash: git status | 5 | 31.3 | 35.3 | 29.8 | 34.3 | 128.9 | 119.8 |
| PreToolUse | Bash: git commit | 5 | 107.0 | 182.6 | 57.9 | 109.8 | 178.1 | 147.0 |
| PreToolUse | Edit: src file | 4 | 64.4 | 78.2 | 50.0 | 131.8 | 161.8 | 140.5 |
| PreToolUse | Write: src file | 4 | 75.9 | 100.5 | 64.8 | 83.1 | 190.7 | 167.0 |
| PreToolUse | Agent: spawn | 4 | 78.0 | 94.6 | 75.3 | 100.2 | 209.9 | 159.7 |
| PostToolUse | Bash: git status | 4 | 66.3 | 116.4 | 51.8 | 81.7 | 189.7 | 161.9 |
| PostToolUse | Agent: spawn | 1 | 44.5 | 53.6 | 45.3 | 50.1 | 45.3 | 35.0 |
| Stop | short transcript | 11 | 202.9 | 335.1 | 150.4 | 240.5 | 679.3 | 551.7 |

Parallel vs sequential: Claude Code hooks docs (code.claude.com/docs/en/hooks): "All matching hooks run in parallel." docs/KB-claude-codex.md does not state it.
CPU method: process.resourceUsage() of the hook process via a --require probe (excludes grandchildren).

## Addendum 2026-10-04: coordinator-work-guard and the Node compile cache

The table above predates `coordinator-work-guard` (PreToolUse and PostToolUse `Bash`), so the Bash scenarios there list 5 PreToolUse and 4 PostToolUse hooks. On 0.201.0 they run 9 and 6, after `coordinator-work-guard`, `compact-declaration-guard`, `api-guard` and `ship-it-guard` added `Bash`.

**Conditions: the machine was far more loaded than for the table above.** Load average (1 min) was 220 to 257 at the start of each run below (the table above ran at 17 to 29). CPU time is not load-immune (a bare `node -e 0` costs more CPU when the machine is oversubscribed), so compare only numbers from the same run. These runs interleave the variants hook by hook (base, then changed, then base...) so load drift hits both equally. Same fixture and payloads as `scripts/hook-latency.js`, CPU from the same `--require` probe, 29 samples (30 runs, first dropped), p50 only, ms.

| Event | Scenario | Hook | CPU p50 before | CPU p50 after | Load (1 min) |
|---|---|---|---:|---:|---:|
| PreToolUse | Bash: git status | coordinator-work-guard | 53.4 | 45.0 | 220 |
| PostToolUse | Bash: git status | coordinator-work-guard --post | 44.2 | 45.6 | 220 |

What changed: for a plain read-only command (`git status`, `ls`, `cat | head`, ...) the hook no longer loads `command-guard.js` (237 KB) at all; `lib/coordinator-work.js` `provablyNotWork` recognises a closed vocabulary and answers "not work". Any other command still goes through `classifyBashWork` unchanged, so a state-changing or unknown command (`git commit`) costs what it did before. `--post` is unchanged because it reuses the verdict stored at Pre by `tool_use_id` and does not classify.

Node compile cache (`NODE_COMPILE_CACHE`, Node 22.1+) was measured and **not adopted**: it moved CPU p50 by 0 to 6 percent, below the 15 percent bar. Same method, base vs `NODE_COMPILE_CACHE=<dir>` (warm cache), load 220 to 257:

| Hook | CPU p50 no cache | CPU p50 compile cache |
|---|---:|---:|
| compact-declaration-guard | 40.9 | 41.0 |
| git-guard | 45.0 | 42.3 |
| command-guard | 60.2 | 56.8 |
| coordinator-work-guard | 57.9 | 55.6 |
| merge-gate | 39.2 | 40.3 |
| scan-throttle | 38.5 | 38.4 |
| edit-guard | 61.6 | 61.6 |
| ship-it-guard | 39.3 | 38.1 |
| task-guard | 45.1 | 44.9 |
| speculation-guard | 49.3 | 50.0 |

Most of a hook's CPU is process startup, not compiling its own modules; loading `command-guard.js` alone measured about 8 ms CPU on this machine.

## Addendum 2026-10-04 (second): what was cut, and what the numbers really are

**Two corrections to the figures above.** (1) The table was measured with the benchmark inheriting the developer's own `DEVSWARM_*` variables, so the DevSwarm hooks (`devswarm-parent-gate` 109.5 ms, `devswarm-parent-inbox` 52.9, `devswarm-child-role` 51.5) ran their full DevSwarm logic. A session that is not a DevSwarm Primary or child, the common case, never pays that. (2) On a quiet machine (load 3 to 6, 14 samples, median of 3 runs) the per-hook CPU floor is a bare `node -e 0` at about 16 to 18 ms and most hooks sit at 22 to 35 ms; the 40 to 60 ms rows above are partly load. Do not read the table's absolute figures as a baseline.

**What was cut** (decisions unchanged):

- `devswarm-parent-gate`, `-parent-inbox`, `-child-turn`, `-child-gate`, `-child-drain` loaded 70 to 187 KB of source plus a dozen companion libs before reaching their "not DevSwarm / wrong role" early return. `hooks/lib/devswarm-primary-gate.js` repeats the same payload-independent checks first and exits. Verified by require-cache probe (the heavy lib is absent from a non-DevSwarm run and present for the right role, `tests/hooks/devswarm-primary-gate-fastexit.test.js`) and by measurement.
- `crypto` / `child_process` load on first use (`hooks/lib/lazy-node.js`) in the hooks that rarely hash or spawn.

Paired and interleaved (base and patched alternate per sample), DevSwarm env stripped, 30 samples, CPU p50 ms, load 33 to 40 (so the floor reads about 20 here), bare `node -e 0` about 16.5 on a quiet machine:

| Event | Hook | Before | After | Delta |
|---|---|---:|---:|---:|
| Stop | devswarm-parent-gate | 36.1 | 20.7 | -15.3 |
| UserPromptSubmit | devswarm-parent-inbox | 36.5 | 20.8 | -15.7 |
| UserPromptSubmit | devswarm-child-turn | 29.2 | 20.2 | -9.0 |
| Stop | devswarm-child-gate | 25.8 | 20.4 | -5.4 |
| Stop | task-guard | 24.3 | 21.8 | -2.5 |
| Stop | compact-advice-guard | 23.9 | 21.9 | -2.0 |
| PreToolUse Agent | phase-tracker | 28.1 | 25.3 | -2.7 |

Per call for a non-DevSwarm session: Stop about 20 ms CPU less, UserPromptSubmit about 25 ms less. The other hooks in the lazy-require change moved by -4 to +1.4 ms (noise level at this load) and are not claimed.

**Checked and not changed (no gain, or a decision would change):**

- Node compile cache: command-guard 32.2 to 30.5 ms, within noise (see the earlier addendum); not adopted.
- `command-guard` and `coordinator-work-guard`: profiled, about 3 ms is module compile and the rest is runtime startup; `coordinator-work-guard` already skips `command-guard.js` for read-only commands. `git commit` costs it about 5 ms more because the classifier is genuinely needed.
- `git-guard` on `git commit -a`: wall 58 ms vs CPU 35 ms is two serial `git diff --name-only` spawns (staged, then unstaged) for the handover-commit check. They cannot be merged into one `git diff` without changing which paths are reported, so they stay.
- `tasklist-guard` / `silent-agent-nudge` scale with transcript size: both already read a bounded tail (512 KB, with a 16 MB presence-only fallback; 64 MB for silent-agent-nudge). Shrinking those windows changes what they can see, so they are unchanged.
- `devswarm-parent-gate` in a real DevSwarm Primary still costs about 51 ms CPU (full logic, a `spawnSync`); unchanged.
