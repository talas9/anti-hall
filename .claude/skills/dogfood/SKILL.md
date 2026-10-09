---
name: dogfood
description: Use in every anti-hall development session (dev-only, not part of the shipped plugin). The session that builds anti-hall also runs it - observe every anti-hall message, telemetry, engine health and bug signal, collect reports from other projects' running sessions, log every misfire with evidence, and drive fixes.
---

# Dogfood anti-hall while developing it

Dev-only: this skill lives in the repo's `.claude/skills/`, outside `plugins/anti-hall/`, so it is
never installed for users (like a devDependency). Every anti-hall signal in a dev session is test
output. Judge it, record it, fix it. Never silently obey, dismiss or work around one.

## 1. Every anti-hall message, as it arrives

Blocks, advisories, nudges, tracker lines, stop-hook feedback, statusline segments, DevSwarm
notices. Verdict: **true positive** / **false positive** (wrong about facts) / **noise** (right
but useless or repeated) / **wrong wording**. Anything but a true positive gets one line in
`.anti-hall/dogfood/ISSUES.md` (local, gitignored):

`- YYYY-MM-DD HH:MM | <check / event / source> | <verdict> | <message quote + contradicting fact> | open`

A repeat of an open entry gets its own dated line (frequency is data). Keep working.

## 2. Telemetry and health (hourly, at every milestone, and before ending the session)

- `sh ~/.anti-hall/ah-engine-live/status.sh`: errors, panics, restarts, breaker, crash-loop,
  daemon RSS.
- `sh ~/.anti-hall/ah-node-shadow/node-shadow.sh --compare`: any check where the engine is
  weaker than Node is a **P0** entry; defer counts per check are tracked over time.
- `ah-engine devswarm ledger --since 1h` (and `ah-engine telemetry`): per-feature actions,
  success rate, refusals, **mistake rate**. A rising mistake rate or a new refusal reason is an entry.
- The engine event log: whole-event fallbacks, stuck workers, script "interrupted"/CPU-limit
  errors, git timeouts. Record count and check id.
- The repo itself: a stale `.git/index.lock`, temp-dir growth (`ls $TMPDIR | wc -l`), leftover
  `ah-engine serve` processes, disk growth. Each is a bug signal until proven otherwise.

## 3. Other projects' running sessions (every few hours and at milestones)

anti-hall runs in every project on this machine. List live sessions (`ListAgents`, peer
sessions with status busy/idle, not offline) and send each a short message asking for
anti-hall misfires, wrong blocks, slowdowns or confusing messages they have hit since the last
ask, with the exact message text and what they were doing. Ask; never instruct them to change
anything. Record each answer (or "no reply") as entries with source `peer:<session name>`.
Owner-ratified peer channel; keep it to one message per session per round. DevSwarm
workspace sessions are never messaged directly (devswarm-comms-guard blocks it, correctly):
ask that project's Primary to collect from its workspaces and relay.

## 4. Fixing

- Group open entries per check into one lane: confirm the cause from code/data, sibling sweep,
  regression test proving the true-positive case still fires, then the fix (plugin config/JS or
  engine; Node gets bug fixes only and stays in parity).
- Mark entries `fixed <sha>` / `wontfix <reason>`; never delete entries.
- Every progress report to the owner includes: open entries by severity, fixed since last report,
  mistake rates of acting features.

## Rules that still apply

Evidence before verdicts. Never disable a guard to get past it; log it and work within it.
Safety switches change only with the owner's OK.
