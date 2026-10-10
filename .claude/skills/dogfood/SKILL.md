---
name: dogfood
description: Dev-only, anti-hall repo (not part of the shipped plugin). Use in every anti-hall development session. The session that builds anti-hall also runs it - observe every anti-hall message, telemetry, engine health and bug signal, collect reports from other projects' running sessions, log every misfire with evidence, and drive fixes.
---

# Dogfood anti-hall while developing it

Dev-only: this skill lives in the repo's `.claude/skills/`, outside `plugins/anti-hall/`, so it is
never installed for users (like a devDependency). Every anti-hall signal in a dev session is test
output. Judge it, record it, fix it. Never silently obey, dismiss or work around one.

## 1. Every anti-hall message, as it arrives

Blocks, advisories, nudges, tracker lines, stop-hook feedback, statusline segments, DevSwarm
notices. Verdict: **true positive** / **false positive** (wrong about facts) / **noise** (right
but useless or repeated) / **wrong wording**. Anything but a true positive gets one line in
`.anti-hall/history/dogfood/ISSUES.md` (local, gitignored):

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

## 5. All work lives on GitHub (issues + the "anti-hall roadmap" board)

Tasks, bugs, features, plans and the roadmap live in the repo's issues and on the user project
board **"anti-hall roadmap"** (project 3, owner `talas9`; views **Now**, **Next**, **Backlog**,
**By milestone**, **Board**). The session task list is built FROM the board, never the other way
round. Exact commands, field ids and option ids: the `gh-work` skill.

**Setup this relies on**

- Issue forms (`.github/ISSUE_TEMPLATE/`): Bug report, False positive, Feature request (blank
  issues off). Their Priority / Estimate / Area / "Estimate in hours" fields feed the automation.
- Labels: `type:feature|bug|docs|chore`, `priority:P0..P3`, `size:S|M|L|XL`, `area:*` (engine,
  devswarm, hooks, statusline, codex, ci, docs, release, plus the guard areas),
  `status:triage|accepted|in-progress|blocked`.
- `triage.yml`: maps form fields to `priority:*`/`size:*`/`area:*`, adds `status:triage` on open,
  labels PRs by path (`labeler.yml`), and adds new issues to the board when its token secret is
  set (else the board's own auto-add). `community.yml`: rules triage + one model
  brief comment. The moderation workflows (when present) add `moderation:review`, `needs-issue`,
  `risk:*` and triage suggestions: a session acts on them (see `gh-work`).
- Milestones: **v0.300.0** (engine decides hooks, Node is the fallback), **v0.301 engine-only**
  (Node removed), **v1.0** (no Node; everything goes through the engine; contract frozen).

**Operating loop (autonomous)**

1. **Session start / resume:** sync the board (`gh project item-list 3 --owner talas9`), read
   the Now view, then Next by priority. Each session task subject starts with `#n`.
2. **Anything new** (an owner request, idea, bug or plan, or something found while working):
   open the issue FIRST, from the form fields, and triage it at once (labels, board fields,
   milestone). Plans go in the issue body or a linked comment; a local plan file links its issue.
3. **Pick the next work yourself:** the highest-priority Now item with no in-flight agent, else
   the top of Next. Move it to In progress (`status:in-progress` + board Status), comment the
   approach, work it, comment the evidence, and close it through a PR with `Closes #n`. Never wait
   for permission on accepted items. Stop only at owner-only gates (billing, secrets, destructive
   actions): comment on the issue, label it `status:blocked`, take the next item.
4. **Every few hours** (with the health round of section 2): re-sync the board, triage anything
   new (bot suggestions included), post a one-line progress comment on each in-progress issue,
   and handle `status:in-progress` issues silent for 24 h and `status:triage` issues older than
   a day.

**Rules**

- Triage = `status:accepted` + priority/size/milestone, or a comment saying why it is deferred.
  Never close or delete an issue automatically.
- One comment per milestone (approach, lane/commit shas, test or replay evidence, blockers), not
  per step.
- Branch `<type>/<n>-slug`, commits reference `#n`, PR body `Closes #n`, so a merge moves the
  item to Done.
- Done: the closing comment states what was verified and how (command and result). Work shipped
  without proof stays open with the missing check named.
- Dogfood entries that need a code fix get an issue (`type:bug`, area of the check), linked from
  the ISSUES.md line (`issue #n`).
- Issue text stays agnostic: no private paths, names or session ids (public repo).

## Rules that still apply

Evidence before verdicts. Never disable a guard to get past it; log it and work within it.
Safety switches change only with the owner's OK.
