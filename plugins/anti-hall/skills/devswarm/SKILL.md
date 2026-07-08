---
name: devswarm
description: Explain and activate anti-hall's optional DevSwarm integration — the hivecontrol reference KB, the (designed, unbuilt) workspace-tier orchestration, and the shipped liveness supervisor. Use when the user asks "explain the anti-hall DevSwarm integration", "how do I activate the DevSwarm supervisor", "what DevSwarm addons does anti-hall have", "tune the liveness supervisor", or anything about hivecontrol / DevSwarm workspaces from an anti-hall angle.
---

# DevSwarm integration

anti-hall's DevSwarm support is **entirely optional and feature-detected** — the same
model as its OMC/OMX integration. Nothing here changes behavior unless DevSwarm is
actually in use (`DEVSWARM_REPO_ID` set, or a published workspace descriptor exists).
anti-hall ships only generic, project-agnostic pieces; any DevSwarm-consumer-side glue
(an inbox daemon, a done-report contract, `hivecontrol` wiring) belongs to whatever
project is running DevSwarm, not to this plugin.

## The three addons

| Addon | Status | Where |
|---|---|---|
| **hivecontrol reference KB** | Reference doc | `docs/KB-devswarm-hivecontrol.md` — the `hivecontrol` CLI surface, `.devswarm/config.json` schema, `DEVSWARM_*` env vars, and the async message-passing coordination model. Repo-clone-only (like all `docs/`, it does not ship with `/plugin install`). |
| **Workspace-tier orchestration** | **Designed, NOT built** | `docs/superpowers/specs/2026-07-05-devswarm-orchestration-design.md` + `docs/superpowers/plans/2026-07-06-devswarm-orchestration.md`. Would make the `orchestration` skill workspace-topology-aware (a Primary workspace fans out to child workspaces via `hivecontrol`; children never spawn grandchildren). None of its planned files (`hooks/lib/devswarm-role.js`, `hooks/devswarm-guard.js`, `hooks/lib/devswarm-children.js`) exist yet — do not describe this as active. |
| **Liveness supervisor** | **Shipped** | `companion/devswarm-supervisor.js`, `companion/install-devswarm-supervisor.js`, `companion/lib/{liveness,recovery,target-session,doctor-devswarm}.js`, `hooks/lib/devswarm-detect.js`. The rest of this skill covers this addon in detail — it's the one with an activation contract to get right. |

## What the liveness supervisor is for

A workaround for a documented, unresolved Claude Code core-loop bug class
(`anthropics/claude-code#39755`, related: `#28482`, `#33949`): a `claude` session can go
**wedged** — process alive, listener dead — with no crash for pm2/systemd to restart and
no background-task-timeout event to generate a new turn. DevSwarm child workspaces run
headless and unattended, so a wedge there just sits forever. The supervisor sweeps
published workspace descriptors, detects staleness from **outbound** activity (never the
inbound heartbeat — a wedged child stopped consuming inbound too), and recovers with a
precise kill + `claude --resume`.

## Activation checklist (for a consumer/orchestrator)

This is the part a DevSwarm-consuming project needs, in order:

**1. Install the companion (opt-in — never self-installs):**

```bash
node plugins/anti-hall/companion/install-devswarm-supervisor.js
node plugins/anti-hall/companion/install-devswarm-supervisor.js --dry-run   # preview
node plugins/anti-hall/companion/install-devswarm-supervisor.js --uninstall
```

- **macOS** → LaunchAgent (`launchd`, `StartInterval`).
- **Linux** → `systemd --user` timer; cron fallback (coalesced by the supervisor's own
  single-flight sweep lock) if `systemctl` is absent.
- **Windows** → detection-only, documented no-op for recovery. A running process's cwd
  is not obtainable in pure Node on Windows, so the cwd confirm-gate that makes the kill
  safe cannot run there.

**2. Publish a per-workspace descriptor** at
`~/.anti-hall/devswarm/workspaces/<id>.json`:

```json
{
  "id": "<safe id, [A-Za-z0-9._-]+>",
  "worktreePath": "<absolute path to the workspace's git worktree>",
  "sessionId": "<the claude session's current uuid>",
  "inboxPath": "<path to the durable inbound-message log>",
  "cursorPath": "<path to the consumer's read-cursor over that log>"
}
```

- `id`, `worktreePath`, `sessionId` are **required** — a descriptor missing any of these,
  or carrying an unsafe `id` (must match `^[A-Za-z0-9._-]+$`, never `.`/`..`), is skipped
  entirely (fail-open: one bad descriptor never stops the sweep, it just never recovers).
- `inboxPath`/`cursorPath` are **load-bearing, not optional in practice**: without a
  readable inbox+cursor, the supervisor can never establish a pending unread backlog, so
  `pending` is always `false` and the workspace can never be nominated `stale` — it will
  never auto-recover no matter how wedged it is.

**3. Env gate.** `DISABLE_ANTIHALL_DEVSWARM=1` is the hard kill-switch. Note the
supervisor daemon's own gate (`devswarm-supervisor.js`) checks only that switch plus
`ANTIHALL_DEVSWARM_SUPERVISOR=off` — it does **not** require `DEVSWARM_REPO_ID`, because
that variable is per-session and is absent from a `launchd`/`systemd` background job. The
real activation signal for the daemon is simply the presence of descriptor files under
`~/.anti-hall/devswarm/workspaces/`. `DEVSWARM_REPO_ID` (and `ANTIHALL_DEVSWARM_SUPERVISOR=on`)
is what session-side consumers (`hooks/lib/devswarm-detect.js`, `doctor.js`) check instead.

**4. Keep the descriptor fresh:**
- `sessionId` must always be the workspace's **current** session uuid — if the consumer
  resumes into a new session id and doesn't update the descriptor, the confirm-gate finds
  zero candidates and abstains (never recovers, never false-positives either).
- **Delete the descriptor when the workspace closes** — there is no GC. A stale
  descriptor for a closed workspace just sits there abstaining forever (harmless, but
  noisy in `doctor.js`).
- `escalated` is a **terminal** verdict (the sweep stops re-targeting it once written) —
  reset it by deleting `~/.anti-hall/devswarm/liveness/<id>.json` after a human has
  looked at the workspace.

## Config / tuning env

**Wired today** (verified in `install-devswarm-supervisor.js` / `devswarm-supervisor.js` /
`devswarm-detect.js`):

| Var | Default | Effect |
|---|---|---|
| `ANTIHALL_DEVSWARM_INTERVAL` | `90` (clamped 60–120) | Sweep interval in seconds, set at install time. |
| `ANTIHALL_DEVSWARM_SUPERVISOR` | `auto` | `off` disables the daemon gate; `on`/`auto` otherwise don't change daemon behavior (see gate note above) but do drive `devswarm-detect.js`'s session-side `active` signal. |
| `DISABLE_ANTIHALL_DEVSWARM` | unset | `1` = hard kill-switch, overrides everything. |
| `ANTIHALL_DEVSWARM_IDLE_SEC` | `900` (min 60) | Idle threshold (seconds) before a workspace is a stale candidate. |
| `ANTIHALL_DEVSWARM_COOLDOWN_SEC` | `600` (min 0) | Cooldown after a recovery before the same workspace can be re-targeted. |
| `ANTIHALL_DEVSWARM_MAX_RECOVERIES` | `3` (clamped 1–20) | Recoveries allowed before a workspace escalates instead. |
| `ANTIHALL_DEVSWARM_GRACE_SEC` | `5` (clamped 1–60) | SIGTERM→SIGKILL grace window. |
| `ANTIHALL_DEVSWARM_STUCK_SEC` | `1800` | `doctor.js` threshold for escalating a stuck `recovering` verdict to FAIL. Floored to the resolved idle threshold — it can never be a tighter window than idle. |

All five are resolved by `resolveThresholdsFromEnv()` in `companion/devswarm-supervisor.js`
(seconds in, ms out; invalid/absent values fall back to the defaults above) — both the
live sweep (`main()`) and `doctor.js`'s DevSwarm section read through it, so an override
takes effect everywhere.

## Safety model (brief)

- **Precise single-target kill or abstain** — never a broad `pkill`. A survivor must be
  the confirmed `claude` process (identity-bound: argv session id == descriptor
  `sessionId`), cwd-confirmed to `worktreePath`, and **headless-only** (`-p`/`--print`) —
  an interactive human takeover is never touched.
- **Confirm-gate**: exactly one surviving candidate or abstain (0 or >1 candidates both
  abstain — never guess between them).
- **Re-confirmed immediately before every signal** (SIGTERM and again before SIGKILL), so
  a pid recycled mid-grace-window is never wrongly killed.
- **Group-kill** (POSIX negative pid) so orphaned MCP-server children go with it, not
  reparented to PID 1.
- **Single-writer lock per workspace** (atomic `wx` lockfile) — never resumes the same
  session id from two processes concurrently.
- **Detached resume**, no kill-on-timeout — a resumed session that's still starting is
  recorded `recovering`, never falsely `alive`.
- **Fail-open** end to end: any supervisor error is logged and the sweep continues; it
  never kills a healthy workspace.
- **Windows**: detection-only, unconditionally escalate-only, never kills.

## Outputs to watch

- `~/.anti-hall/devswarm/liveness/<id>.json` — per-workspace verdict (`alive` / `stale` /
  `recovering` / `ambiguous` / `escalated`), recovery count, timestamps.
- `~/.anti-hall/devswarm/recovery.log` — append-only NDJSON, one line per recovery
  attempt, abstain, or escalation, with a reason.
- `node hooks/doctor.js` — silent unless DevSwarm is active; otherwise runs a live
  behavioral self-test (fresh workspace → `alive`, a constructed wedged fixture →
  `stale`) plus a PASS/WARN/FAIL readout per real workspace descriptor, escalating a
  `recovering` verdict stuck past the stuck threshold to FAIL.

## When to use this skill

"Explain the anti-hall DevSwarm integration", "how do I activate the DevSwarm
supervisor", "what DevSwarm addons does anti-hall have", "tune the liveness supervisor",
"is my DevSwarm workspace descriptor set up right".

## Relationship to other skills in this plugin

- **orchestration** — today's Workflow-tool + subagent fan-out is unaffected by any of
  this; the workspace-tier design (unbuilt) would eventually add a DevSwarm-aware branch
  there.
- **doctor** — surfaces the liveness supervisor's per-workspace health as one more
  section, silent when DevSwarm isn't in play.
